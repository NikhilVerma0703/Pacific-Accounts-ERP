/**
 * Invoice data access — everything the screens need that does NOT involve
 * reading a document.
 *
 * This split is a performance boundary, not just tidiness. `server/ingest.ts`
 * imports the extraction chain, and `exceljs` alone is 23 MB of module graph; in
 * Next, every route that imports a module inherits its whole server graph, so
 * when the register imported `ingest` just to call `loadRules`, the register's
 * route paid for the Excel reader. Compiling and initialising that on the way to
 * a page the user only wants to look at is what made section changes feel slow.
 *
 * Rule of thumb: if it reads or writes the database, it belongs here. If it reads
 * a *file*, it belongs in `ingest.ts` and only the import screens should touch it.
 */
import "server-only";

import { buildAccountsRow, type AccountsRow, type NoteInput, type ReceiptInput } from "@/lib/business/accounts";
import type { DueBasisKey, PaymentTermRule } from "@/lib/business/rules";
import { prisma } from "@/lib/db";
import { BY_KEY } from "@/lib/extraction/catalog";
import { toIsoDate, toNumber } from "@/lib/extraction/text";
import { FieldStatus, type ExtractedField, type LineItem } from "@/lib/extraction/types";
import { fromJson, toJson } from "@/lib/json";
import {
  fieldNumber,
  fieldString,
  normalizedFromJson,
  type NormalizedInvoice,
} from "@/lib/normalize/normalizer";
import { assess, type Quality } from "@/lib/normalize/validators";
import { EXTRACTION_VERSION } from "@/lib/extraction/version";
import { LOCAL_USER } from "@/lib/session";

function toDate(iso: string | null): Date | null {
  return iso ? new Date(`${iso}T00:00:00.000Z`) : null;
}

function invoiceTypeValue(value: string | null): string {
  if (value === "Export") return "EXPORT";
  if (value === "Domestic") return "DOMESTIC";
  return "UNKNOWN";
}

export async function loadRules(): Promise<PaymentTermRule[]> {
  const rows = await prisma.paymentTermRule.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
    // a split term ("70% CAD, balance 30% at 90 days") keeps its portions in a
    // child table. No portions means the ordinary single-portion term, and
    // `creditDays` + `basis` below still describe it.
    include: { parts: { orderBy: { seq: "asc" } } },
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    pattern: r.pattern,
    creditDays: r.creditDays,
    basis: r.basis as DueBasisKey,
    isActive: r.isActive,
    parts: r.parts.length
      ? r.parts.map((p) => ({
          seq: p.seq,
          percent: Number(p.percent),
          creditDays: p.creditDays,
          basis: p.basis as DueBasisKey,
        }))
      : undefined,
  }));
}

/**
 * The queryable columns mirrored out of the extraction, so the register can
 * filter and sort without unpacking JSON. Exported because a hand-made record
 * fills exactly the same columns.
 */
export function invoiceScalarsFor(n: NormalizedInvoice, row: AccountsRow, quality: Quality) {
  const dueDate = typeof row.dueDate?.value === "string" ? row.dueDate.value : null;
  return {
    invoiceNo: String(fieldString(n, "invoiceNo")),
    invoiceDate: toDate(fieldString(n, "invoiceDate")),
    invoiceType: invoiceTypeValue(fieldString(n, "invoiceType")),
    customerName: fieldString(n, "customerName"),
    consigneeName: fieldString(n, "consigneeName"),
    countryOfDestination: fieldString(n, "countryOfDestination"),
    currency: fieldString(n, "currency"),
    invoiceValue: fieldNumber(n, "invoiceValue"),
    exchangeRate: fieldNumber(n, "exchangeRate"),
    homeValue: fieldNumber(n, "homeValue"),
    paymentTerms: fieldString(n, "paymentTerms"),
    poNo: fieldString(n, "poNo"),
    containerNo: fieldString(n, "containerNo"),
    shippingBillNo: fieldString(n, "shippingBillNo"),
    blNo: fieldString(n, "blNo"),
    dueDate: toDate(dueDate),
    status: String(row.status?.value ?? "AWAITING_PAYMENT_DATA"),
    dataQualityPct: quality.accountsPct,
    fields: toJson(n.fields),
    lineItems: toJson(n.lineItems),
    quality: toJson(quality),
    accountsRow: toJson(row),
    warnings: toJson(n.warnings),
  };
}

/**
 * The receipts and notes recorded against an invoice, in the shape the register
 * maths expects. One place, so a receipt entered by hand and one read off a
 * payment advice are indistinguishable from here on.
 */
export async function receiptsAndNotes(
  invoiceId: string,
): Promise<{ receipts: ReceiptInput[]; notes: NoteInput[] }> {
  const [receipts, notes] = await Promise.all([
    prisma.receipt.findMany({ where: { invoiceId }, orderBy: { seq: "asc" } }),
    prisma.creditDebitNote.findMany({ where: { invoiceId }, orderBy: { createdAt: "asc" } }),
  ]);
  return {
    receipts: receipts.map((r) => ({
      seq: r.seq,
      amount: Number(r.amount),
      receiptDate: r.receiptDate ? r.receiptDate.toISOString().slice(0, 10) : null,
      exchangeRate: r.exchangeRate === null ? null : Number(r.exchangeRate),
      bankRef: r.bankRef,
      remarks: r.remarks,
      source: r.source,
    })),
    notes: notes.map((n) => ({
      noteType: n.noteType === "CREDIT" ? ("CREDIT" as const) : ("DEBIT" as const),
      amount: Number(n.amount),
      noteNo: n.noteNo,
      noteDate: n.noteDate ? n.noteDate.toISOString().slice(0, 10) : null,
    })),
  };
}

/**
 * Write a value an Accounts employee typed in, parsed for the field's own type.
 *
 * Shared by the edit action and by re-extraction, so a correction survives the
 * document being read again — re-reading the file must never quietly undo
 * someone's work.
 */
export function applyManualValue(
  fields: Record<string, ExtractedField>,
  key: string,
  raw: string,
  by: string = LOCAL_USER.name,
): string | number | null {
  const def = BY_KEY[key];
  let value: string | number | null = raw.trim();
  if (def?.type === "date") value = toIsoDate(raw);
  else if (def?.type === "number" || def?.type === "currency") value = toNumber(raw);
  if (value === "" || value === undefined) value = null;

  fields[key] = {
    key,
    value,
    raw,
    status: value !== null ? FieldStatus.EXTRACTED : FieldStatus.MISSING,
    source: `entered by ${by}`,
    confidence: 1,
    note: value !== null ? "Entered manually." : "Cleared manually.",
  };
  return value;
}

/** Re-run validation and the Accounts logic after an edit, a receipt or a rule change. */
export async function rebuildInvoice(invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { receipts: true },
  });
  if (!invoice) return;

  const normalized = normalizedFromJson(
    fromJson<Record<string, ExtractedField>>(invoice.fields, {}),
    fromJson<LineItem[]>(invoice.lineItems, []),
    fromJson<string[]>(invoice.warnings, []),
  );
  const quality = assess(normalized);
  const rules = await loadRules();
  const { receipts, notes } = await receiptsAndNotes(invoice.id);
  const row = buildAccountsRow(normalized, quality, { slNo: 1, receipts, notes, rules });

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: invoiceScalarsFor(normalized, row, quality),
  });
}

export async function rebuildAllInvoices(): Promise<number> {
  const ids = await prisma.invoice.findMany({ select: { id: true } });
  for (const { id } of ids) await rebuildInvoice(id);
  return ids.length;
}

export interface DeletionSummary {
  invoiceNo: string;
  fileName: string | null;
  removedEdits: number;
}

/**
 * The exact inverse of an import: the register row, the stored original file and
 * everything attached to that invoice go together. An Accounts employee deletes
 * "the upload"; there is no state where the file is gone but the row remains, or
 * the other way round.
 *
 * Two consequences worth knowing:
 *  - the invoice number and the file checksum are released, so the very same
 *    document can be imported again straight afterwards;
 *  - the import log keeps a line recording the removal, so the register can
 *    still account for a row that is no longer there.
 */
export async function deleteInvoice(invoiceId: string): Promise<DeletionSummary | null> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      document: { select: { fileName: true, sha256: true } },
      _count: { select: { edits: true } },
    },
  });
  if (!invoice) return null;

  // the document, corrections, receipts and CN/DN rows cascade with the invoice
  await prisma.invoice.delete({ where: { id: invoiceId } });

  await prisma.importLog.create({
    data: {
      fileName: invoice.document?.fileName ?? `${invoice.invoiceNo} (no stored file)`,
      fileHash: invoice.document?.sha256 ?? null,
      outcome: "DELETED",
      // deliberately no invoiceId: that row no longer exists
      message:
        `Invoice ${invoice.invoiceNo} and its uploaded file were removed from the register ` +
        `by ${LOCAL_USER.name}. The same file can be imported again.`,
    },
  });

  return {
    invoiceNo: invoice.invoiceNo,
    fileName: invoice.document?.fileName ?? null,
    removedEdits: invoice._count.edits,
  };
}


/**
 * How many stored invoices an older reader produced.
 *
 * One indexed count, and deliberately nothing more: the register used to call
 * `reextractStale()` while rendering, which opened and parsed up to 25 Excel or
 * PDF files before the page could be sent. Healing is still automatic — see
 * HealStaleInvoices — it just happens after the page is on screen instead of
 * holding it up.
 */
export async function countStaleInvoices(): Promise<number> {
  return prisma.invoice.count({
    where: { extractionVersion: { lt: EXTRACTION_VERSION }, document: { isNot: null } },
  });
}
