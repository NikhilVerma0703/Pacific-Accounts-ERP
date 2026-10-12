/**
 * The Accounts register must produce the agreed columns, in order, with each
 * value either read from the invoice, calculated, or honestly marked as waiting
 * for Tally / the shipping team. Receipt columns are covered in receipts.test.ts.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACCOUNTS_VIEW,
  applyVolatileCells,
  ASSUMPTIONS,
  buildAccountsRow,
  isRowCurrent,
  ROW_VERSION,
  visibleColumns,
  type AccountsRow,
} from "@/lib/business/accounts";
import type { PaymentTermRule } from "@/lib/business/rules";
import { extractDocument } from "@/lib/extraction";
import { FieldStatus, type ExtractedField, type LineItem } from "@/lib/extraction/types";
import { normalize, normalizedFromJson } from "@/lib/normalize/normalizer";
import { assess } from "@/lib/normalize/validators";

const EXPECTED_COLUMNS = [
  // everything up to Currency
  ["slNo", "Sl. No."],
  ["invoiceDate", "Invoice Date"],
  ["invoiceNo", "Invoice No."],
  ["customerInvoiceValue", "Customer Invoice Value"],
  ["customsInvoiceValue", "Customs Value / As per Books"],
  ["exchangeRate", "Exchange Rate"],
  ["consigneeName", "Consignee"],
  ["notifyPartyName", "Notify Party"],
  ["paymentTerms", "Payment Terms"],
  ["currency", "Currency"],
  // then one group per receipt — five columns each
  ["receipt1Date", "Receipt 1 Date"],
  ["receipt1Fcy", "Receipt 1 FCY"],
  ["receipt1Rate", "Exchange Rate for Receipt 1"],
  ["receipt1Diff", "Difference 1"],
  ["receipt1Forex", "Forex Gain/Loss 1"],
  // then the agreed trailing sequence
  ["creditNote", "Credit Note (CN)"],
  ["debitNote", "Debit Note (DN)"],
  ["balanceAsPerBooks", "Balance as per Books"],
  ["balanceAsPerCustomer", "Balance as per Customer"],
  ["status", "Status"],
  ["piNo", "PI / PO No."],
  ["poNo", "PO No."],
  ["shippingBillNo", "Shipping Bill No."],
  ["shippingBillDate", "Shipping Bill Date"],
  ["blNo", "BL No."],
  ["blDate", "BL Date"],
  ["containerNo", "Container No."],
  ["eta", "ETA / Arrival Date"],
  ["dueDate", "Due Date"],
  ["todayDate", "TODAY"],
  ["overdueDays", "Overdue Days"],
];

async function sampleInvoice() {
  const buffer = await readFile(
    path.join(process.cwd(), "tests", "fixtures", "sample_invoice.xlsx"),
  );
  return normalize(await extractDocument(buffer, "invoice_dummy.xlsx"));
}

async function sampleRow(opts: { rules?: PaymentTermRule[]; today?: string } = {}) {
  const normalized = await sampleInvoice();
  const quality = assess(normalized);
  return buildAccountsRow(normalized, quality, { slNo: 1, ...opts });
}

describe("the Accounts register", () => {
  it("has the agreed columns, in order, with one receipt group", () => {
    expect(ACCOUNTS_VIEW).toHaveLength(EXPECTED_COLUMNS.length);
    expect(ACCOUNTS_VIEW.map((c) => [c.key, c.label])).toEqual(EXPECTED_COLUMNS);
    expect(visibleColumns()).toHaveLength(EXPECTED_COLUMNS.length);
  });

  it("fills the invoice-sourced columns from the uploaded invoice", async () => {
    const row = await sampleRow({ today: "2026-09-17" });

    expect(row.slNo.value).toBe(1);
    expect(row.invoiceDate.value).toBe("2026-09-12");
    expect(row.invoiceDate.display).toBe("12-Sep-2026");
    expect(row.invoiceNo.value).toBe("PESPL/2889");
    expect(row.exchangeRate.value).toBe(93.55);
    expect(row.consigneeName.value).toBe("Ciot Inc");
    expect(row.notifyPartyName.value).toBe("Naturoc Division DE Ciot");
    expect(row.paymentTerms.value).toBe("100% Cash Against Documents (CAD)");
    expect(row.currency.value).toBe("USD");
    expect(row.containerNo.value).toBe("MSNU1968136");

    for (const key of [
      "invoiceDate", "invoiceNo", "exchangeRate", "consigneeName",
      "notifyPartyName", "paymentTerms", "currency", "containerNo",
    ]) {
      expect(row[key].status, key).toBe(FieldStatus.EXTRACTED);
      expect(row[key].source, `${key} must record where it came from`).toBeTruthy();
    }
  });

  it("keeps the party columns short on screen but complete underneath", async () => {
    const row = await sampleRow({ today: "2026-09-17" });

    // the table stays readable…
    expect(row.consigneeName.display).toBe("Ciot Inc");
    expect(row.notifyPartyName.display).toBe("Naturoc Division DE Ciot");

    // …while the exports get every line printed under the label on the invoice
    expect(row.consigneeName.full).toContain("9225 Boul Saint");
    expect(row.consigneeName.full).toContain("Canada");
    expect(row.notifyPartyName.full).toContain("Montreal");

    // a column with nothing more to say carries no second copy of itself
    expect(row.currency.full).toBeUndefined();
    expect(row.invoiceNo.full).toBeUndefined();
  });

  it("applies the temporary assumption, and says so on the cell", async () => {
    const row = await sampleRow({ today: "2026-09-17" });

    expect(ASSUMPTIONS.customerInvoiceValueEqualsInvoiceTotal).toBe(true);

    expect(row.customerInvoiceValue.value).toBe(18348.49);
    expect(row.customerInvoiceValue.display).toBe("18,348.49");
    expect(row.customerInvoiceValue.status).toBe(FieldStatus.CALCULATED);
    expect(row.customerInvoiceValue.note).toContain("Temporary Phase-1 assumption");

    // with no receipts and no notes the formula returns the invoice value
    expect(row.balanceAsPerCustomer.value).toBe(18348.49);
    expect(row.balanceAsPerCustomer.note).toContain("Temporary Phase-1 assumption");
  });

  it("leaves the Tally and shipping columns empty, with the reason", async () => {
    const row = await sampleRow({ today: "2026-09-17" });

    for (const key of ["customsInvoiceValue", "balanceAsPerBooks"]) {
      expect(row[key].value, key).toBeNull();
      expect(row[key].status, key).toBe(FieldStatus.NOT_PRESENT);
      expect(row[key].note, key).toMatch(/Tally/);
    }
    for (const key of ["blDate", "eta"]) {
      expect(row[key].value, key).toBeNull();
      expect(row[key].note, key).toBeTruthy();
    }
  });

  it("does not invent a due date, and says what it is waiting for", async () => {
    const row = await sampleRow({ today: "2026-09-17" });

    expect(row.dueDate.value).toBeNull();
    expect(row.dueDate.note?.toLowerCase()).toContain("no due-date rule");
    // the cell must not read as a blank, which could be taken for "no credit period"
    expect(row.dueDate.display).toBe("Pending / requires verification");
    expect(row.dueDate.status).toBe(FieldStatus.NEEDS_VERIFICATION);

    expect(row.overdueDays.value).toBeNull();
    expect(row.overdueDays.display).toBe("Pending");
    expect(row.todayDate.value).toBe("2026-09-17");
  });

  it("says 'not due' rather than zero when the due date is still ahead", async () => {
    const rule: PaymentTermRule = {
      label: "CAD 30",
      pattern: "Cash Against Documents",
      creditDays: 30,
      basis: "INVOICE_DATE",
    };
    const row = await sampleRow({ rules: [rule], today: "2026-09-17" });
    expect(row.dueDate.value).toBe("2026-10-12");
    expect(row.overdueDays.value).toBe(0);
    expect(row.overdueDays.display).toBe("Not due (25d)");
  });

  it("keeps the books columns pending until Tally provides them", async () => {
    const row = await sampleRow({ today: "2026-09-17" });
    for (const key of ["customsInvoiceValue", "balanceAsPerBooks"]) {
      expect(row[key].value, key).toBeNull();
      expect(row[key].display, key).toBe("Pending Tally");
      expect(row[key].note, key).toMatch(/Pending Tally/);
    }
    expect(row.booksDifference.value).toBeNull();
  });

  it("fills due date and overdue days once a rule exists", async () => {
    const rule: PaymentTermRule = {
      label: "CAD 30",
      pattern: "Cash Against Documents",
      creditDays: 30,
      basis: "INVOICE_DATE",
    };

    const notYetDue = await sampleRow({ rules: [rule], today: "2026-09-17" });
    expect(notYetDue.dueDate.value).toBe("2026-10-12");
    expect(notYetDue.dueDate.display).toBe("12-Oct-2026");
    expect(notYetDue.overdueDays.value).toBe(0);

    const overdue = await sampleRow({ rules: [rule], today: "2026-11-01" });
    expect(overdue.overdueDays.value).toBe(20);
    expect(overdue.todayDate.value).toBe("2026-11-01");
  });

  it("recomputes Today's Date and Overdue Days from a stored row", async () => {
    const rule: PaymentTermRule = {
      label: "CAD 30",
      pattern: "Cash Against Documents",
      creditDays: 30,
      basis: "INVOICE_DATE",
    };
    const stored = await sampleRow({ rules: [rule], today: "2026-09-17" });

    // what the register does when it renders a row saved weeks earlier
    const refreshed = applyVolatileCells(
      JSON.parse(JSON.stringify(stored)) as typeof stored,
      "2026-12-01",
    );
    expect(refreshed.todayDate.value).toBe("2026-12-01");
    expect(refreshed.overdueDays.value).toBe(50);
  });
});

/**
 * Rows are saved at import time. When the column set changes, the rows already
 * in the database were built by the old code and would render with blank
 * columns — which is exactly what an Accounts employee reported. They must be
 * rebuilt from the extraction stored alongside them, not re-uploaded.
 */
describe("rows saved before a column change", () => {
  it("recognises a row built by the current column set", async () => {
    const row = await sampleRow({ today: "2026-09-17" });
    expect(isRowCurrent(row)).toBe(true);
    expect(row.rowVersion.value).toBe(ROW_VERSION);
  });

  it("treats a row saved under the old column names as stale", async () => {
    const current = await sampleRow({ today: "2026-09-17" });

    // what the database actually held: the pre-18-column shape, where the
    // invoice total was stored as `invoiceValue` and there was no version stamp
    const old = JSON.parse(JSON.stringify(current)) as AccountsRow;
    old.invoiceValue = old.customerInvoiceValue;
    delete old.customerInvoiceValue;
    delete old.customsInvoiceValue;
    delete old.balanceAsPerBooks;
    delete old.balanceAsPerCustomer;
    delete old.rowVersion;

    expect(isRowCurrent(old)).toBe(false);
    expect(old.customerInvoiceValue).toBeUndefined();
  });

  it("treats a row stamped with an older version as stale, even if complete", async () => {
    const row = await sampleRow({ today: "2026-09-17" });
    const previous = JSON.parse(JSON.stringify(row)) as AccountsRow;
    previous.rowVersion = { ...previous.rowVersion, value: ROW_VERSION - 1 };
    expect(isRowCurrent(previous)).toBe(false);
  });

  it("rebuilds a stale row from the stored extraction, filling the new columns", async () => {
    const normalized = await sampleInvoice();

    // round-trip through JSON exactly as the database stores it
    const storedFields = JSON.parse(JSON.stringify(normalized.fields)) as Record<
      string,
      ExtractedField
    >;
    const storedItems = JSON.parse(JSON.stringify(normalized.lineItems)) as LineItem[];
    const reloaded = normalizedFromJson(storedFields, storedItems, normalized.warnings);

    const rebuilt = buildAccountsRow(reloaded, assess(reloaded), {
      slNo: 7,
      today: "2026-09-17",
    });

    expect(isRowCurrent(rebuilt)).toBe(true);
    expect(rebuilt.slNo.value).toBe(7);
    expect(rebuilt.customerInvoiceValue.value).toBe(18348.49);
    expect(rebuilt.customerInvoiceValue.display).toBe("18,348.49");
    expect(rebuilt.balanceAsPerCustomer.value).toBe(18348.49);
    for (const [key] of EXPECTED_COLUMNS) {
      expect(key in rebuilt, `${key} must exist on a rebuilt row`).toBe(true);
    }
  });
});
