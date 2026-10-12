/**
 * Receipts, credit / debit notes and the three formulas Accounts specified.
 *
 * The worked examples in this file are the ones from the brief, so a change that
 * breaks them is a change to the business rules, not to the code.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  balanceFrom,
  buildAccountsRow,
  buildColumns,
  MIN_RECEIPT_SLOTS,
  receiptColumns,
  receiptMaths,
  settledAmount,
  totalNotes,
  totalReceipts,
  type NoteInput,
  type ReceiptInput,
} from "@/lib/business/accounts";
import { paymentStatus, STATUS_LABELS } from "@/lib/business/rules";
import { extractDocument, readReceipts } from "@/lib/extraction";
import { loadSheetGrids } from "@/lib/extraction/sheetGrid";
import { findInvoiceNoLike } from "@/lib/extraction/text";
import { FieldStatus } from "@/lib/extraction/types";
import { normalize } from "@/lib/normalize/normalizer";
import { assess } from "@/lib/normalize/validators";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures");

async function sample() {
  const buffer = await readFile(path.join(FIXTURES, "sample_invoice.xlsx"));
  const normalized = normalize(await extractDocument(buffer, "invoice_dummy.xlsx"));
  return { normalized, quality: assess(normalized) };
}

const receipt = (over: Partial<ReceiptInput> = {}): ReceiptInput => ({
  seq: 1,
  amount: 10000,
  receiptDate: "2026-10-12",
  exchangeRate: 94.2,
  ...over,
});

describe("the formulas Accounts specified", () => {
  it("difference is the receipt rate less the invoice rate", () => {
    // the brief's example: 94.20 − 93.55 = 0.65
    const { difference } = receiptMaths({ amount: 10000, exchangeRate: 94.2 }, 93.55);
    expect(difference).toBe(0.65);
  });

  it("forex gain/loss is that difference times the amount received", () => {
    // 0.65 × 10,000 = 6,500
    const { forex } = receiptMaths({ amount: 10000, exchangeRate: 94.2 }, 93.55);
    expect(forex).toBe(6500);
  });

  it("reports a loss as a negative number", () => {
    const { difference, forex } = receiptMaths({ amount: 10000, exchangeRate: 92.55 }, 93.55);
    expect(difference).toBe(-1);
    expect(forex).toBe(-10000);
  });

  it("leaves both blank rather than guessing a rate", () => {
    expect(receiptMaths({ amount: 10000, exchangeRate: null }, 93.55)).toEqual({
      difference: null,
      forex: null,
    });
    expect(receiptMaths({ amount: 10000, exchangeRate: 94.2 }, null)).toEqual({
      difference: null,
      forex: null,
    });
  });

  it("balance is invoice value less receipts less CN plus DN", () => {
    const receipts = [receipt({ seq: 1, amount: 10000 }), receipt({ seq: 2, amount: 2000 })];
    const notes: NoteInput[] = [
      { noteType: "CREDIT", amount: 500 },
      { noteType: "DEBIT", amount: 150 },
    ];
    expect(totalReceipts(receipts)).toBe(12000);
    expect(totalNotes(notes, "CREDIT")).toBe(500);
    expect(totalNotes(notes, "DEBIT")).toBe(150);
    // 18,348.49 − 12,000 − 500 + 150
    expect(balanceFrom(18348.49, receipts, notes)).toBe(5998.49);
  });
});

describe("the register's columns", () => {
  it("puts the receipt group between Currency and Credit Note", () => {
    const columns = buildColumns(1).map((c) => c.key);
    const currency = columns.indexOf("currency");
    const firstReceipt = columns.indexOf("receipt1Date");
    const cn = columns.indexOf("creditNote");

    expect(firstReceipt).toBe(currency + 1);
    expect(cn).toBe(columns.indexOf("receipt1Forex") + 1);
  });

  it("gives every receipt the same five columns, in order", () => {
    expect(receiptColumns(3).map((c) => c.key)).toEqual([
      "receipt3Date", "receipt3Fcy", "receipt3Rate", "receipt3Diff", "receipt3Forex",
    ]);
    expect(receiptColumns(3).map((c) => c.label)).toEqual([
      "Receipt 3 Date",
      "Receipt 3 FCY",
      "Exchange Rate for Receipt 3",
      "Difference 3",
      "Forex Gain/Loss 3",
    ]);
  });

  it("keeps the trailing columns in the agreed sequence", () => {
    const keys = buildColumns(2).map((c) => c.key);
    const tail = keys.slice(keys.indexOf("creditNote"));
    expect(tail).toEqual([
      "creditNote", "debitNote", "balanceAsPerBooks", "balanceAsPerCustomer", "status",
      "piNo", "poNo", "shippingBillNo", "shippingBillDate", "blNo", "blDate",
      "containerNo", "eta", "dueDate", "todayDate", "overdueDays",
    ]);
  });

  it("shows Receipt 1 even with no receipts, and grows with the data", () => {
    expect(MIN_RECEIPT_SLOTS).toBe(1);
    expect(buildColumns(0).filter((c) => c.receiptNo).length).toBe(5);
    expect(buildColumns(3).filter((c) => c.receiptNo).length).toBe(15);
    expect(buildColumns(3).length).toBe(buildColumns(1).length + 10);
  });
});

describe("an invoice row with receipts", () => {
  it("fills the receipt columns and works the balance out from them", async () => {
    const { normalized, quality } = await sample();
    const receipts = [
      receipt({ seq: 1, amount: 10000, exchangeRate: 94.2 }),
      receipt({ seq: 2, amount: 5000, exchangeRate: 92.55, receiptDate: "2026-11-02" }),
    ];
    const notes: NoteInput[] = [{ noteType: "CREDIT", amount: 348.49 }];

    const row = buildAccountsRow(normalized, quality, {
      receipts,
      notes,
      today: "2026-11-10",
    });

    // the invoice's own rate is 93.55
    expect(row.receipt1Fcy.value).toBe(10000);
    expect(row.receipt1Rate.value).toBe(94.2);
    expect(row.receipt1Diff.value).toBe(0.65);
    expect(row.receipt1Forex.value).toBe(6500);
    expect(row.receipt1Date.value).toBe("2026-10-12");

    expect(row.receipt2Diff.value).toBe(-1);
    expect(row.receipt2Forex.value).toBe(-5000);

    expect(row.creditNote.value).toBe(348.49);
    expect(row.debitNote.value).toBeNull();

    // 18,348.49 − 15,000 − 348.49 + 0
    expect(row.balanceAsPerCustomer.value).toBe(3000);
    expect(row.balanceAsPerCustomer.status).toBe(FieldStatus.CALCULATED);
    expect(row.balanceAsPerCustomer.note).toContain("18,348.49");
  });

  it("says a receipt is missing rather than showing a blank", async () => {
    const { normalized, quality } = await sample();
    const row = buildAccountsRow(normalized, quality, { receiptSlots: 2, today: "2026-09-17" });

    expect(row.receipt1Fcy.value).toBeNull();
    expect(row.receipt1Fcy.status).toBe(FieldStatus.NOT_PRESENT);
    expect(row.receipt1Fcy.note).toMatch(/no receipt/i);
    expect(row.receipt2Forex.status).toBe(FieldStatus.NOT_PRESENT);
  });

  it("keeps Balance as per Books waiting for Tally", async () => {
    const { normalized, quality } = await sample();
    const row = buildAccountsRow(normalized, quality, {
      receipts: [receipt()],
      today: "2026-09-17",
    });
    expect(row.balanceAsPerBooks.value).toBeNull();
    expect(row.balanceAsPerBooks.note).toMatch(/Tally/);
  });

  it("does not invent a difference when the receipt has no rate", async () => {
    const { normalized, quality } = await sample();
    const row = buildAccountsRow(normalized, quality, {
      receipts: [receipt({ exchangeRate: null })],
      today: "2026-09-17",
    });
    expect(row.receipt1Fcy.value).toBe(10000);
    expect(row.receipt1Rate.value).toBeNull();
    expect(row.receipt1Diff.value).toBeNull();
    expect(row.receipt1Diff.status).toBe(FieldStatus.MISSING);
    // the balance still moves — it does not need a rate
    expect(row.balanceAsPerCustomer.value).toBe(8348.49);
  });
});

describe("reading receipts off a payment sheet", () => {
  async function sheetOf(rows: Array<Array<string | number>>) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Payments");
    rows.forEach((r) => ws.addRow(r));
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return loadSheetGrids(buffer);
  }

  it("finds the table and reads each line", async () => {
    const grids = await sheetOf([
      ["Remittance advice", "", "", "", ""],
      ["Invoice No.", "Value Date", "Amount Received", "Exchange Rate", "UTR"],
      ["PESPL/2889", "12/10/2026", 10000, 94.2, "UTR12345"],
      ["PESPL/2890", "02/11/2026", 5000, 92.55, "UTR12346"],
      ["Total", "", 15000, "", ""],
    ]);
    const { lines } = readReceipts(grids, "advice.xlsx");

    expect(lines).toHaveLength(2);
    expect(lines[0].invoiceNo).toBe("PESPL/2889");
    expect(lines[0].amount).toBe(10000);
    expect(lines[0].exchangeRate).toBe(94.2);
    expect(lines[0].receiptDate).toBe("2026-10-12");
    expect(lines[0].bankRef).toBe("UTR12345");
    expect(lines[0].problem).toBeNull();
    // the Total row ends the table rather than being read as a receipt
    expect(lines.map((l) => l.amount)).not.toContain(15000);
  });

  it("copes with a different bank's wording", async () => {
    const grids = await sheetOf([
      ["Against Invoice", "Credit Date", "Credit Amount", "FX Rate"],
      ["Inv No. PESPL/2889", "2026-10-12", "10,000.00", "94.2000"],
    ]);
    const { lines } = readReceipts(grids, "bank.xlsx");
    expect(lines[0].invoiceNo).toBe("PESPL/2889");
    expect(lines[0].amount).toBe(10000);
    expect(lines[0].exchangeRate).toBe(94.2);
  });

  it("reports a line it cannot place instead of guessing", async () => {
    const grids = await sheetOf([
      ["Invoice No.", "Date", "Amount"],
      ["", "12/10/2026", 10000],
      ["PESPL/2889", "12/10/2026", "not a number"],
    ]);
    const { lines } = readReceipts(grids, "messy.xlsx");
    expect(lines[0].problem).toMatch(/no invoice number/i);
    expect(lines[1].problem).toMatch(/no amount/i);
  });

  it("says so when there is no receipt table at all", async () => {
    const grids = await sheetOf([["Dear customer"], ["Thank you for your business."]]);
    const { lines, warnings } = readReceipts(grids, "letter.xlsx");
    expect(lines).toHaveLength(0);
    expect(warnings[0]).toMatch(/No receipt table/i);
  });

  it("does not mistake a date or an amount for an invoice number", () => {
    expect(findInvoiceNoLike("PESPL/2889")).toBe("PESPL/2889");
    expect(findInvoiceNoLike("Invoice No. PESPL/2889")).toBe("PESPL/2889");
    expect(findInvoiceNoLike("12/10/2026")).toBeNull();
    expect(findInvoiceNoLike("10000.00")).toBeNull();
    expect(findInvoiceNoLike("")).toBeNull();
  });
});

/**
 * The statuses Accounts asked for: Unpaid, Partially Paid, Paid, Due, Overdue.
 *
 * The order the tests are applied in is the business decision, so each case here
 * pins one of those decisions rather than just the happy path.
 */
describe("payment status", () => {
  const TODAY = "2026-10-20";

  it("is Unpaid when nothing has been received and no due date is known", () => {
    expect(paymentStatus(18348.49, 0, null, TODAY)).toBe("UNPAID");
    expect(STATUS_LABELS.UNPAID).toBe("Unpaid");
  });

  it("is Partially Paid once some money is in", () => {
    expect(paymentStatus(18348.49, 10000, "2026-11-30", TODAY)).toBe("PARTIALLY_PAID");
  });

  it("is Paid when nothing is outstanding, whatever the due date says", () => {
    expect(paymentStatus(18348.49, 18348.49, "2026-01-01", TODAY)).toBe("PAID");
    // a rounding remainder of a paisa is not an unpaid invoice
    expect(paymentStatus(18348.49, 18348.48, "2026-11-30", TODAY)).toBe("PAID");
  });

  it("is Overdue past the due date, even when part paid", () => {
    expect(paymentStatus(18348.49, 0, "2026-10-19", TODAY)).toBe("OVERDUE");
    expect(paymentStatus(18348.49, 10000, "2026-10-19", TODAY)).toBe("OVERDUE");
  });

  it("is Due in the week before, and Not Due before that", () => {
    expect(paymentStatus(18348.49, 0, "2026-10-25", TODAY)).toBe("DUE_SOON");
    expect(STATUS_LABELS.DUE_SOON).toBe("Due");
    expect(paymentStatus(18348.49, 0, "2026-12-25", TODAY)).toBe("NOT_DUE");
  });

  it("counts a credit note as settled and a debit note as owed", () => {
    const notes: NoteInput[] = [{ noteType: "CREDIT", amount: 18348.49 }];
    expect(settledAmount([], notes)).toBe(18348.49);
    expect(paymentStatus(18348.49, settledAmount([], notes), "2026-11-30", TODAY)).toBe("PAID");

    const withDebit: NoteInput[] = [
      { noteType: "CREDIT", amount: 18348.49 },
      { noteType: "DEBIT", amount: 1000 },
    ];
    expect(settledAmount([], withDebit)).toBe(17348.49);
    expect(paymentStatus(18348.49, settledAmount([], withDebit), "2026-11-30", TODAY)).toBe(
      "PARTIALLY_PAID",
    );
  });

  it("refuses to guess when the invoice value could not be read", () => {
    expect(paymentStatus(null, 0, "2026-10-19", TODAY)).toBe("MISSING_INFORMATION");
  });

  it("explains itself on the register row", async () => {
    const { normalized, quality } = await sample();
    const unpaid = buildAccountsRow(normalized, quality, { today: TODAY });
    expect(unpaid.status.value).toBe("UNPAID");
    expect(unpaid.status.note).toMatch(/Nothing received/);
    expect(unpaid.status.note).toMatch(/no due date yet/);

    const part = buildAccountsRow(normalized, quality, {
      receipts: [receipt({ amount: 10000 })],
      today: TODAY,
    });
    expect(part.status.value).toBe("PARTIALLY_PAID");
    expect(part.status.note).toMatch(/8,348.49 outstanding/);

    const paid = buildAccountsRow(normalized, quality, {
      receipts: [receipt({ amount: 18348.49 })],
      today: TODAY,
    });
    expect(paid.status.value).toBe("PAID");
    expect(paid.status.display).toBe("Paid");
  });
});
