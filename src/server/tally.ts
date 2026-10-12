/**
 * The boundary with Tally and the e-Invoice portal.
 *
 * Nothing here connects to either of them — that is not built. What is built is
 * the shape it will arrive in, so the future work is one adapter that produces a
 * `BooksUpdate`, and nothing in the register changes.
 *
 * The rule that matters: **these values are Tally's, never the invoice's.** Until
 * a real figure arrives, the books columns say "Pending Tally / e-Invoice data"
 * rather than showing a copy of the invoice total. A books figure that merely
 * mirrors the invoice would make the books-versus-invoice comparison — the whole
 * reason those columns exist — always read zero.
 *
 * Someone can type these in today (invoice screen → Tally & e-Invoice), which is
 * recorded as entered by a person and is never overwritten by a later sync.
 */
import "server-only";

import { prisma } from "@/lib/db";
import { BY_KEY } from "@/lib/extraction/catalog";
import { toIsoDate, toNumber } from "@/lib/extraction/text";
import { FieldStatus, type ExtractedField } from "@/lib/extraction/types";
import { fromJson, toJson } from "@/lib/json";
import { rebuildInvoice } from "@/server/invoiceData";

/** What Tally is the authority on. */
export const TALLY_OWNED = [
  "booksValue", "booksValueHome", "tallyVoucherNo", "tallyVoucherDate", "tallyLedger",
] as const;

/** What the e-Invoice / IRP is the authority on. */
export const EINVOICE_OWNED = ["irn", "ackNo", "ackDate", "eInvoiceStatus", "ewayBillNo"] as const;

/** Everything the books panel shows, in the order it shows it. */
export const BOOKS_FIELDS = [...EINVOICE_OWNED, ...TALLY_OWNED] as const;

export type BooksField = (typeof BOOKS_FIELDS)[number];

export interface BooksUpdate {
  /** The invoice number as printed — the key this is matched on. */
  invoiceNo: string;
  /** "Tally", "IRP", or whatever sent it. Recorded on every field it fills. */
  sourceSystem: string;
  values: Partial<Record<BooksField, string | number | null>>;
}

export type BooksOutcome = "updated" | "unchanged" | "not-found";

export interface BooksResult {
  invoiceNo: string;
  outcome: BooksOutcome;
  applied: BooksField[];
  skipped: Array<{ field: BooksField; reason: string }>;
}

/**
 * Write books / e-Invoice values against one invoice.
 *
 * `by` is what gets recorded as the source: a person's name for a typed value, a
 * system name for a sync. A value entered by a person is never replaced by a
 * sync — same precedence as everywhere else in the module.
 */
export async function applyBooksUpdate(
  update: BooksUpdate,
  opts: { authoritative?: boolean; matchById?: string } = {},
): Promise<BooksResult> {
  const invoice = opts.matchById
    ? await prisma.invoice.findUnique({ where: { id: opts.matchById } })
    : await prisma.invoice.findUnique({ where: { invoiceNo: update.invoiceNo } });

  if (!invoice) {
    return { invoiceNo: update.invoiceNo, outcome: "not-found", applied: [], skipped: [] };
  }

  const fields = fromJson<Record<string, ExtractedField>>(invoice.fields, {});
  const applied: BooksField[] = [];
  const skipped: BooksResult["skipped"] = [];
  const bySomeone = update.sourceSystem.startsWith("entered by");

  for (const [key, raw] of Object.entries(update.values) as Array<
    [BooksField, string | number | null]
  >) {
    if (!BOOKS_FIELDS.includes(key)) {
      skipped.push({ field: key, reason: "not a books or e-Invoice field" });
      continue;
    }

    const existing = fields[key];
    const text = raw === null || raw === undefined ? "" : String(raw).trim();

    // an empty box clears a value that was typed in, but a sync sending nothing
    // must not wipe what is already there
    if (!text) {
      if (bySomeone && existing?.value !== null && existing?.value !== undefined) {
        fields[key] = {
          key,
          value: null,
          raw: "",
          status: FieldStatus.NOT_PRESENT,
          source: update.sourceSystem,
          confidence: 0,
          note: "Cleared — pending Tally / e-Invoice data.",
        };
        applied.push(key);
      }
      continue;
    }

    if (
      !bySomeone &&
      existing?.source?.startsWith("entered by") &&
      !opts.authoritative
    ) {
      skipped.push({ field: key, reason: "entered by hand — a sync never overwrites a person" });
      continue;
    }

    const def = BY_KEY[key];
    let value: string | number | null = text;
    if (def?.type === "date") value = toIsoDate(text);
    else if (def?.type === "number" || def?.type === "currency") value = toNumber(text);
    if (value === null) {
      skipped.push({ field: key, reason: `'${raw}' could not be read as a ${def?.type ?? "value"}` });
      continue;
    }
    if (existing?.value === value) continue;

    fields[key] = {
      key,
      value,
      raw: text,
      status: FieldStatus.EXTRACTED,
      source: update.sourceSystem,
      confidence: 1,
      note: bySomeone ? "Entered manually." : `Received from ${update.sourceSystem}.`,
    };
    applied.push(key);
  }

  if (!applied.length) {
    return { invoiceNo: invoice.invoiceNo, outcome: "unchanged", applied, skipped };
  }

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { fields: toJson(fields) },
  });

  for (const field of applied) {
    await prisma.fieldEdit.create({
      data: {
        invoiceId: invoice.id,
        fieldKey: field,
        oldValue: null,
        newValue: fields[field].value === null ? null : String(fields[field].value),
        editedBy: update.sourceSystem,
      },
    });
  }

  // the books balance and the invoice-versus-books difference both follow from
  // these values, so the row is rebuilt rather than patched
  await rebuildInvoice(invoice.id);
  return { invoiceNo: invoice.invoiceNo, outcome: "updated", applied, skipped };
}

export async function applyBooksUpdates(
  updates: BooksUpdate[],
  opts: { authoritative?: boolean } = {},
): Promise<BooksResult[]> {
  const out: BooksResult[] = [];
  for (const update of updates) out.push(await applyBooksUpdate(update, opts));
  return out;
}
