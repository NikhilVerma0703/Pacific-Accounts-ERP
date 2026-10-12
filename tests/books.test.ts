/**
 * The books columns and the due-date wording.
 *
 * The rule these tests protect: **a books figure is Tally's, never the
 * invoice's.** If "as per books" were ever filled from the invoice total, the
 * invoice-versus-books comparison would always read zero, and the column would be
 * worse than useless — it would look reconciled when nothing had been checked.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildAccountsRow, buildColumns, type NoteInput, type ReceiptInput } from "@/lib/business/accounts";
import type { PaymentTermRule } from "@/lib/business/rules";
import { extractDocument } from "@/lib/extraction";
import { BY_KEY } from "@/lib/extraction/catalog";
import { FieldStatus, type ExtractedField } from "@/lib/extraction/types";
import { normalize, normalizedFromJson } from "@/lib/normalize/normalizer";
import { assess } from "@/lib/normalize/validators";
import { SHIPPING_FIELDS } from "@/server/fieldGroups";
import { BOOKS_FIELDS, EINVOICE_OWNED, TALLY_OWNED } from "@/server/tally";

async function sample() {
  const buffer = await readFile(
    path.join(process.cwd(), "tests", "fixtures", "sample_invoice.xlsx"),
  );
  const normalized = normalize(await extractDocument(buffer, "invoice_dummy.xlsx"));
  return { normalized, quality: assess(normalized) };
}

/** The same invoice, with books values as if Tally had sent them. */
async function withBooks(booksValue: number | null) {
  const { normalized } = await sample();
  const stored = JSON.parse(JSON.stringify(normalized.fields)) as Record<string, ExtractedField>;
  if (booksValue !== null) {
    stored.booksValue = {
      key: "booksValue",
      value: booksValue,
      raw: String(booksValue),
      status: FieldStatus.EXTRACTED,
      source: "Tally",
      confidence: 1,
      note: "Received from Tally.",
    };
  }
  const reloaded = normalizedFromJson(stored, normalized.lineItems, normalized.warnings);
  return { normalized: reloaded, quality: assess(reloaded) };
}

describe("the books columns", () => {
  it("say Pending Tally rather than copying the invoice", async () => {
    const { normalized, quality } = await sample();
    const row = buildAccountsRow(normalized, quality, { today: "2026-09-28" });

    // the invoice total is known…
    expect(row.customerInvoiceValue.value).toBe(18348.49);
    // …and the books figure is still not, which is the point
    expect(row.customsInvoiceValue.value).toBeNull();
    expect(row.customsInvoiceValue.display).toBe("Pending Tally");
    expect(row.balanceAsPerBooks.value).toBeNull();
    expect(row.balanceAsPerBooks.display).toBe("Pending Tally");
    expect(row.balanceAsPerBooks.note).toMatch(/Pending Tally/);
    expect(row.booksDifference.value).toBeNull();
  });

  it("run the same balance formula on Tally's figure once it exists", async () => {
    const { normalized, quality } = await withBooks(18000);
    const receipts: ReceiptInput[] = [{ seq: 1, amount: 10000, exchangeRate: 94.2 }];
    const notes: NoteInput[] = [{ noteType: "CREDIT", amount: 500 }];
    const row = buildAccountsRow(normalized, quality, { receipts, notes, today: "2026-09-28" });

    expect(row.customsInvoiceValue.value).toBe(18000);
    // 18,000 − 10,000 − 500 + 0
    expect(row.balanceAsPerBooks.value).toBe(7500);
    expect(row.balanceAsPerBooks.status).toBe(FieldStatus.CALCULATED);
    // and the customer side is unchanged: 18,348.49 − 10,000 − 500
    expect(row.balanceAsPerCustomer.value).toBe(7848.49);
  });

  it("show the invoice-versus-books difference, and flag a disagreement", async () => {
    const agreeing = await withBooks(18348.49);
    const agreeRow = buildAccountsRow(agreeing.normalized, agreeing.quality, { today: "2026-09-28" });
    expect(agreeRow.booksDifference.value).toBe(0);
    expect(agreeRow.booksDifference.note).toMatch(/agree/);

    const off = await withBooks(18000);
    const offRow = buildAccountsRow(off.normalized, off.quality, { today: "2026-09-28" });
    expect(offRow.booksDifference.value).toBe(348.49);
    expect(offRow.booksDifference.note).toMatch(/disagree/);
  });

  it("keeps the difference out of the fixed register sequence", async () => {
    // the 16 trailing columns are fixed, so the difference lives on the invoice
    // screen and the Tally view instead of widening the table
    expect(buildColumns(1).map((c) => c.key)).not.toContain("booksDifference");
  });
});

describe("due date and overdue days", () => {
  const rule: PaymentTermRule = {
    label: "CAD 30",
    pattern: "Cash Against Documents",
    creditDays: 30,
    basis: "INVOICE_DATE",
  };

  it("is only ever calculated from a configured rule", async () => {
    const { normalized, quality } = await sample();

    const without = buildAccountsRow(normalized, quality, { rules: [], today: "2026-09-28" });
    expect(without.dueDate.value).toBeNull();
    expect(without.dueDate.display).toBe("Pending / requires verification");
    expect(without.dueDate.status).toBe(FieldStatus.NEEDS_VERIFICATION);
    expect(without.overdueDays.display).toBe("Pending");

    const with30 = buildAccountsRow(normalized, quality, { rules: [rule], today: "2026-09-28" });
    expect(with30.dueDate.value).toBe("2026-10-12");
    expect(with30.dueDate.status).toBe(FieldStatus.CALCULATED);
  });

  it("counts overdue days from today, and says 'not due' before then", async () => {
    const { normalized, quality } = await sample();

    const early = buildAccountsRow(normalized, quality, { rules: [rule], today: "2026-10-01" });
    expect(early.overdueDays.value).toBe(0);
    expect(early.overdueDays.display).toBe("Not due (11d)");

    const late = buildAccountsRow(normalized, quality, { rules: [rule], today: "2026-11-01" });
    expect(late.overdueDays.value).toBe(20);
    expect(late.overdueDays.note).toMatch(/past the due date/);
    expect(late.todayDate.value).toBe("2026-11-01");
  });
});

describe("the field vocabulary the future feeds will write", () => {
  it("names every books and e-Invoice field in the catalogue", () => {
    for (const key of BOOKS_FIELDS) {
      expect(BY_KEY[key], `${key} must be a catalogue field`).toBeTruthy();
      expect(["tally", "eInvoice"]).toContain(BY_KEY[key].origin);
    }
    expect(EINVOICE_OWNED).toContain("irn");
    expect(EINVOICE_OWNED).toContain("ackNo");
    expect(EINVOICE_OWNED).toContain("eInvoiceStatus");
    expect(TALLY_OWNED).toContain("booksValue");
    expect(TALLY_OWNED).toContain("tallyVoucherNo");
  });

  it("names every shipping field in the catalogue, with a shipping origin", () => {
    for (const key of SHIPPING_FIELDS) {
      expect(BY_KEY[key], `${key} must be a catalogue field`).toBeTruthy();
    }
    for (const key of ["shippingBillNo", "shippingBillDate", "blNo", "blDate", "eta"]) {
      expect(BY_KEY[key].origin).toBe("shipping");
    }
  });

  it("reports a books field as awaiting its own source, never as invoice data", async () => {
    const { normalized } = await sample();
    for (const key of BOOKS_FIELDS) {
      const f = normalized.fields[key];
      expect(f.value, `${key} must not be filled from the invoice`).toBeNull();
      expect(f.status, key).toBe(FieldStatus.NOT_PRESENT);
      expect(f.note, key).toMatch(/Tally|e-Invoice/i);
    }
  });
});
