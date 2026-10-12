/**
 * A record typed in by hand must be the same kind of thing as an imported one.
 *
 * Not "similar" — the same column set, the same statuses, the same formulas. The
 * only differences allowed are the ones that are true: a typed value has no cell
 * reference on a document, and it is marked as entered by a person.
 *
 * These tests build the record the way the server does, up to the database call,
 * which is the part `npm run verify` covers.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildAccountsRow,
  buildColumns,
  type NoteInput,
  type ReceiptInput,
} from "@/lib/business/accounts";
import { extractDocument } from "@/lib/extraction";
import { ExtractionResult, FieldStatus, type ExtractedField } from "@/lib/extraction/types";
import { fieldValue, normalize } from "@/lib/normalize/normalizer";
import { assess } from "@/lib/normalize/validators";
import { applyManualValue } from "@/server/ingest";
import { MANUAL_FIELDS, MANUAL_GROUPS } from "@/server/manualInvoice";

/** What createManualInvoice does before it touches the database. */
function manualRecord(
  values: Record<string, string>,
  opts: { receipts?: ReceiptInput[]; notes?: NoteInput[]; today?: string } = {},
) {
  const fields: Record<string, ExtractedField> = {};
  for (const key of MANUAL_FIELDS) {
    const raw = (values[key] ?? "").trim();
    if (raw) applyManualValue(fields, key, raw, "Accounts");
  }

  const extraction = new ExtractionResult("xlsx");
  extraction.sourceName = "entered by Accounts";
  for (const [key, field] of Object.entries(fields)) extraction.fields.set(key, field);

  const normalized = normalize(extraction);
  const quality = assess(normalized);
  return {
    normalized,
    quality,
    row: buildAccountsRow(normalized, quality, {
      slNo: 1,
      receipts: opts.receipts ?? [],
      notes: opts.notes ?? [],
      today: opts.today ?? "2026-09-28",
    }),
  };
}

async function importedRecord(today = "2026-09-28") {
  const buffer = await readFile(
    path.join(process.cwd(), "tests", "fixtures", "sample_invoice.xlsx"),
  );
  const normalized = normalize(await extractDocument(buffer, "invoice_dummy.xlsx"));
  const quality = assess(normalized);
  return { normalized, quality, row: buildAccountsRow(normalized, quality, { slNo: 1, today }) };
}

const DUMMY = {
  invoiceNo: "DUMMY/001",
  invoiceDate: "2026-09-12",
  currency: "USD",
  exchangeRate: "93.55",
  invoiceValue: "18348.49",
  paymentTerms: "100% Cash Against Documents (CAD)",
  consigneeName: "Test Consignee Ltd",
  notifyPartyName: "Test Notify Party Inc",
  countryOfDestination: "CANADA",
  containerNo: "TEST1234567",
  blNo: "TESTBL0001",
  blDate: "2026-09-20",
  shippingBillNo: "SB-0000001",
  shippingBillDate: "2026-09-15",
  piNo: "PI-DUMMY-001",
  poNo: "PO-DUMMY-001",
  eta: "2026-10-20",
};

describe("a record entered by hand", () => {
  it("produces the same columns as an imported one", async () => {
    const manual = manualRecord(DUMMY);
    const imported = await importedRecord();

    const expected = buildColumns(1).map((c) => c.key);
    expect(Object.keys(manual.row).filter((k) => expected.includes(k)).sort()).toEqual(
      [...expected].sort(),
    );
    // and no column the imported row has is missing here
    for (const key of expected) {
      expect(key in manual.row, `${key} must exist on a hand-made row`).toBe(true);
      expect(imported.row[key]).toBeTruthy();
    }
  });

  it("runs the same calculations, from typed-in numbers", () => {
    const receipts: ReceiptInput[] = [
      { seq: 1, amount: 10000, exchangeRate: 94.2, receiptDate: "2026-10-12" },
    ];
    const notes: NoteInput[] = [{ noteType: "CREDIT", amount: 348.49 }];
    const { row } = manualRecord(DUMMY, { receipts, notes });

    // the same three formulas as an imported invoice
    expect(row.receipt1Diff.value).toBe(0.65);
    expect(row.receipt1Forex.value).toBe(6500);
    expect(row.creditNote.value).toBe(348.49);
    // 18,348.49 − 10,000 − 348.49
    expect(row.balanceAsPerCustomer.value).toBe(8000);
    expect(row.balanceAsPerCustomer.status).toBe(FieldStatus.CALCULATED);

    // INR value is derived here too
    expect(fieldValue(manualRecord(DUMMY).normalized, "homeValue")).toBe(
      Math.round(18348.49 * 93.55 * 100) / 100,
    );
  });

  it("marks typed values as entered by a person, not read off a document", () => {
    const { normalized, row } = manualRecord(DUMMY);
    expect(normalized.fields.invoiceNo.source).toBe("entered by Accounts");
    expect(normalized.fields.invoiceNo.status).toBe(FieldStatus.EXTRACTED);
    expect(row.invoiceNo.value).toBe("DUMMY/001");
    // no cell reference is claimed, because there is no document
    expect(normalized.fields.invoiceNo.source).not.toMatch(/!/);
  });

  it("is as honest about blanks as an imported invoice", () => {
    const { normalized, row } = manualRecord({ invoiceNo: "DUMMY/002" });

    // nothing invented from an empty form
    expect(row.customerInvoiceValue.value).toBeNull();
    expect(row.dueDate.value).toBeNull();
    expect(row.receipt1Fcy.status).toBe(FieldStatus.NOT_PRESENT);
    expect(row.balanceAsPerCustomer.status).toBe(FieldStatus.MISSING);
    expect(normalized.fields.hsnCode.status).toBe(FieldStatus.NOT_PRESENT);
  });

  it("applies the company party rule the same way", () => {
    // no customer typed in, so the notify party is the end buyer
    const { normalized } = manualRecord(DUMMY);
    expect(fieldValue(normalized, "customerName")).toBe("Test Notify Party Inc");
    expect(normalized.fields.customerName.status).toBe(FieldStatus.CALCULATED);

    // and a customer typed in is never overwritten by it
    const withBuyer = manualRecord({ ...DUMMY, customerName: "Typed Buyer Ltd" });
    expect(fieldValue(withBuyer.normalized, "customerName")).toBe("Typed Buyer Ltd");
  });

  it("parses dates and numbers as the field expects", () => {
    const { normalized } = manualRecord({
      ...DUMMY,
      invoiceDate: "12/09/2026",
      invoiceValue: "18,348.49",
      exchangeRate: "93.55",
    });
    expect(fieldValue(normalized, "invoiceDate")).toBe("2026-09-12");
    expect(fieldValue(normalized, "invoiceValue")).toBe(18348.49);
    expect(fieldValue(normalized, "exchangeRate")).toBe(93.55);
  });

  it("offers every register column that an invoice could fill", () => {
    const offered = new Set<string>(MANUAL_FIELDS);
    // the columns the form cannot fill are exactly the ones no invoice carries:
    // system-generated, calculated, receipt-derived, or Tally's
    const notOffered = buildColumns(1)
      .map((c) => c.key)
      .filter((k) => !offered.has(k));

    expect(notOffered.sort()).toEqual(
      [
        // Tally's, and the customer value that is assumed from the invoice total
        "customsInvoiceValue", "balanceAsPerBooks", "customerInvoiceValue",
        // calculated from other columns
        "balanceAsPerCustomer", "dueDate", "overdueDays", "status",
        // the receipt group and the note totals: entered as receipts and notes
        "creditNote", "debitNote",
        "receipt1Date", "receipt1Diff", "receipt1Fcy", "receipt1Forex", "receipt1Rate",
        // generated by the system
        "slNo", "todayDate",
      ].sort(),
    );
    // the parties, the shipping fields and the money the invoice carries are all
    // typeable, so a hand-made record can fill the same table
    for (const key of ["consigneeName", "notifyPartyName", "invoiceValue", "blNo", "eta"]) {
      expect(offered.has(key), `${key} should be on the form`).toBe(true);
    }
  });

  it("groups the form without losing or repeating a field", () => {
    const flat = MANUAL_GROUPS.flatMap((g) => g.fields);
    expect(flat).toEqual([...MANUAL_FIELDS]);
    expect(new Set(flat).size).toBe(flat.length);
  });
});
