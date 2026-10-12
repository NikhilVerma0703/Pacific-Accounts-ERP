/**
 * The whole flow, both ways in.
 *
 *   manual invoice   ─┐
 *                     ├─→ register row → receipt → CN/DN → balance → due/overdue
 *   imported invoice ─┘                → status → report figures → export
 *
 * The point of this file is not that each step works — the other files cover that
 * — but that the *same numbers* survive every hop. A report that quietly totals
 * something differently from the register is the failure this is here to catch.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  balanceFrom,
  buildAccountsRow,
  buildColumns,
  receiptMaths,
  settledAmount,
  totalNotes,
  totalReceipts,
  type NoteInput,
  type ReceiptInput,
} from "@/lib/business/accounts";
import { paymentStatus, type PaymentTermRule } from "@/lib/business/rules";
import { extractDocument } from "@/lib/extraction";
import { ExtractionResult, FieldStatus, type ExtractedField } from "@/lib/extraction/types";
import { normalize } from "@/lib/normalize/normalizer";
import { assess } from "@/lib/normalize/validators";
import { buildRegisterCsv, buildReportCsv, buildReportWorkbook } from "@/server/exporter";
import { applyManualValue } from "@/server/ingest";
import { MANUAL_FIELDS } from "@/server/manualInvoice";
import { ageingBucket } from "@/server/reports";

const TODAY = "2026-11-01";
const RULE: PaymentTermRule = {
  label: "CAD 30",
  pattern: "Cash Against Documents",
  creditDays: 30,
  basis: "INVOICE_DATE",
};

/** Receipt 1: 10,000 at 94.20 against an invoice rate of 93.55. */
const RECEIPTS: ReceiptInput[] = [
  { seq: 1, amount: 10000, exchangeRate: 94.2, receiptDate: "2026-10-12" },
];
const NOTES: NoteInput[] = [
  { noteType: "CREDIT", amount: 500, noteNo: "CN-1" },
  { noteType: "DEBIT", amount: 150, noteNo: "DN-1" },
];

async function importedInvoice() {
  const buffer = await readFile(
    path.join(process.cwd(), "tests", "fixtures", "sample_invoice.xlsx"),
  );
  const normalized = normalize(await extractDocument(buffer, "invoice_dummy.xlsx"));
  return { normalized, quality: assess(normalized) };
}

function manualInvoice() {
  const values: Record<string, string> = {
    invoiceNo: "DUMMY/900",
    invoiceDate: "2026-09-12",
    currency: "USD",
    exchangeRate: "93.55",
    invoiceValue: "18348.49",
    paymentTerms: "100% Cash Against Documents (CAD)",
    consigneeName: "Test Consignee Ltd",
    notifyPartyName: "Test Notify Party Inc",
  };
  const fields: Record<string, ExtractedField> = {};
  for (const key of MANUAL_FIELDS) {
    if (values[key]) applyManualValue(fields, key, values[key], "Accounts");
  }
  const extraction = new ExtractionResult("xlsx");
  for (const [key, field] of Object.entries(fields)) extraction.fields.set(key, field);
  const normalized = normalize(extraction);
  return { normalized, quality: assess(normalized) };
}

describe.each([
  ["imported invoice", importedInvoice],
  ["manual invoice", async () => manualInvoice()],
])("%s → register → receipt → CN/DN → balance → due/overdue", (_label, load) => {
  it("carries one set of numbers all the way through", async () => {
    const { normalized, quality } = await load();

    // ---- register row, with a receipt and two notes
    const row = buildAccountsRow(normalized, quality, {
      receipts: RECEIPTS,
      notes: NOTES,
      rules: [RULE],
      today: TODAY,
    });

    // the invoice value came through whichever door was used
    expect(row.customerInvoiceValue.value).toBe(18348.49);
    expect(row.exchangeRate.value).toBe(93.55);

    // ---- the receipt columns
    expect(row.receipt1Fcy.value).toBe(10000);
    expect(row.receipt1Diff.value).toBe(0.65);
    expect(row.receipt1Forex.value).toBe(6500);

    // ---- CN / DN
    expect(row.creditNote.value).toBe(500);
    expect(row.debitNote.value).toBe(150);

    // ---- the balance: 18,348.49 − 10,000 − 500 + 150
    const expectedBalance = 7998.49;
    expect(row.balanceAsPerCustomer.value).toBe(expectedBalance);
    expect(balanceFrom(18348.49, RECEIPTS, NOTES)).toBe(expectedBalance);

    // ---- due date from the rule, and overdue days from today
    expect(row.dueDate.value).toBe("2026-10-12");
    expect(row.todayDate.value).toBe(TODAY);
    expect(row.overdueDays.value).toBe(20);
    expect(ageingBucket(20)).toBe("1–30 days");

    // ---- status: past due with money still owed
    expect(row.status.value).toBe("OVERDUE");
    expect(paymentStatus(18348.49, settledAmount(RECEIPTS, NOTES), "2026-10-12", TODAY)).toBe(
      "OVERDUE",
    );

    // ---- books stay Tally's, untouched by any of the above
    expect(row.customsInvoiceValue.value).toBeNull();
    expect(row.balanceAsPerBooks.display).toBe("Pending Tally");

    // ---- the register export carries the same figures
    const columns = buildColumns(1);
    const csv = buildRegisterCsv([row], columns);
    expect(csv).toContain("7998.49");
    expect(csv).toContain("6500");
    expect(csv).toContain("12-Oct-2026");
  });

  it("agrees with what the reports would total", async () => {
    const { normalized, quality } = await load();
    const row = buildAccountsRow(normalized, quality, {
      receipts: RECEIPTS,
      notes: NOTES,
      rules: [RULE],
      today: TODAY,
    });

    // the receipt report's totals come from the same two helpers the row uses
    expect(totalReceipts(RECEIPTS)).toBe(10000);
    expect(totalNotes(NOTES, "CREDIT")).toBe(500);
    expect(totalNotes(NOTES, "DEBIT")).toBe(150);
    expect(receiptMaths(RECEIPTS[0], 93.55).forex).toBe(row.receipt1Forex.value);

    // a customer-outstanding row over this one invoice must equal its balance
    const outstanding = [row].reduce((sum, r) => sum + Number(r.balanceAsPerCustomer.value ?? 0), 0);
    expect(outstanding).toBe(7998.49);
  });
});

describe("a report exports what is on screen", () => {
  const columns = [
    { key: "invoiceNo", label: "Invoice No.", kind: "text" },
    { key: "receiptDate", label: "Receipt Date", kind: "date" },
    { key: "amount", label: "Receipt FCY", kind: "money" },
    { key: "forex", label: "Forex Gain/Loss", kind: "money" },
  ];
  const rows = [
    { invoiceNo: "PESPL/2889", receiptDate: "2026-10-12", amount: 10000, forex: 6500 },
    { invoiceNo: "DUMMY/900", receiptDate: "2026-10-20", amount: 5000, forex: -5000 },
  ];
  const totals = { receiptDate: "Total", amount: 15000, forex: 1500 };

  it("writes the rows, the totals and a sheet explaining itself", async () => {
    const buffer = await buildReportWorkbook(
      "Payment / Receipt Report",
      columns,
      rows,
      totals,
      "Forex is each receipt's difference times its amount.",
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    );
    // "/" is not allowed in a sheet name, so the title is sanitised
    const ws = wb.worksheets[0];
    expect(ws.name).not.toContain("/");

    expect(ws.getRow(1).values).toContain("Receipt FCY");
    expect(ws.getCell(2, 1).value).toBe("PESPL/2889");
    expect(ws.getCell(2, 3).value).toBe(10000);
    // dates are written as dates, so they sort and filter
    expect(ws.getCell(2, 2).value).toBeInstanceOf(Date);
    // the totals row is last and bold
    expect(ws.getCell(4, 3).value).toBe(15000);
    expect(ws.getCell(4, 3).font?.bold).toBe(true);

    expect(wb.getWorksheet("About this report")).toBeTruthy();

    // every column wide enough for what it prints
    columns.forEach((c, i) => {
      expect(ws.getColumn(i + 1).width ?? 0).toBeGreaterThanOrEqual(c.label.length);
    });
  });

  it("writes a CSV with complete values and plain numbers", () => {
    const csv = buildReportCsv(columns, rows, totals);
    const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines[0]).toBe("Invoice No.,Receipt Date,Receipt FCY,Forex Gain/Loss");
    expect(lines[1]).toBe("PESPL/2889,2026-10-12,10000,6500");
    expect(lines[3]).toBe(",Total,15000,1500");
  });
});

describe("the status tiles on the dashboard", () => {
  it("count each invoice once, in the state the register shows", async () => {
    const { normalized, quality } = await importedInvoice();

    const states = [
      { receipts: [], notes: [], rules: [], expect: "UNPAID" },
      { receipts: RECEIPTS, notes: [], rules: [RULE], expect: "OVERDUE" },
      {
        receipts: [{ seq: 1, amount: 18348.49, exchangeRate: 94.2 }] as ReceiptInput[],
        notes: [],
        rules: [RULE],
        expect: "PAID",
      },
      {
        receipts: RECEIPTS,
        notes: [],
        rules: [{ ...RULE, creditDays: 120 }],
        expect: "PARTIALLY_PAID",
      },
    ];

    for (const s of states) {
      const row = buildAccountsRow(normalized, quality, {
        receipts: s.receipts,
        notes: s.notes,
        rules: s.rules,
        today: TODAY,
      });
      expect(row.status.value, `${s.expect} case`).toBe(s.expect);
      expect(row.status.status).toBe(FieldStatus.CALCULATED);
      expect(row.status.note, `${s.expect} needs a reason`).toBeTruthy();
    }
  });
});
