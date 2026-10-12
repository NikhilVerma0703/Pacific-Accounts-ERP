/**
 * Receipts and credit / debit notes against an invoice.
 *
 * Everything here works the same whether a value was typed in or read off a
 * payment document: `saveReceipt` is the single way a receipt reaches the
 * database, and `source` is the only thing that records which route it took.
 * That is what lets the import screen and the manual form share one set of
 * fields, one set of formulas and one audit trail.
 */
import "server-only";

import { prisma } from "@/lib/db";
import { toIsoDate, toNumber } from "@/lib/extraction/text";
import { LOCAL_USER } from "@/lib/session";
import { rebuildInvoice } from "@/server/invoiceData";

export interface ReceiptDraft {
  /** Omit to append as the next receipt. */
  seq?: number;
  receiptDate?: string | null;
  /** The FCY amount, in the invoice's currency. */
  amount: number;
  exchangeRate?: number | null;
  bankRef?: string | null;
  remarks?: string | null;
  /** "entered by Accounts", or the file this was read from. */
  source?: string | null;
}

export type SaveOutcome =
  | { ok: true; receiptId: string; seq: number }
  | { ok: false; message: string };

/** The next free receipt number for an invoice: Receipt 1, then 2, then 3… */
export async function nextSeq(invoiceId: string): Promise<number> {
  const last = await prisma.receipt.findFirst({
    where: { invoiceId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return (last?.seq ?? 0) + 1;
}

/**
 * Create or update one receipt, then recalculate the invoice.
 *
 * The balance, the difference and the forex gain/loss are never written here —
 * they are worked out from the receipts every time the row is built, so they
 * cannot drift away from the numbers they come from.
 *
 * **A field the caller did not mention keeps the value it already had.** That
 * distinction — `undefined` means *not given*, `null` means *clear it* — is not
 * pedantry. The inline edit row shows four of a receipt's fields; a payment
 * advice read by the importer fills five. While both went through a single
 * `?? null`, saving an edit silently wrote a blank over the remittance note
 * nobody had been shown, and nothing said so. Now only what was given is
 * written.
 */
export async function saveReceipt(
  invoiceId: string,
  draft: ReceiptDraft,
): Promise<SaveOutcome> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, currency: true },
  });
  if (!invoice) return { ok: false, message: "That invoice no longer exists." };

  if (!Number.isFinite(draft.amount)) {
    return { ok: false, message: "A receipt needs an amount." };
  }
  if (draft.amount <= 0) {
    return { ok: false, message: "A receipt amount must be greater than zero." };
  }

  const seq = draft.seq ?? (await nextSeq(invoiceId));
  const had = await prisma.receipt.findUnique({
    where: { invoiceId_seq: { invoiceId, seq } },
  });

  const receiptDate =
    draft.receiptDate === undefined
      ? (had?.receiptDate ?? null)
      : draft.receiptDate
        ? new Date(`${draft.receiptDate}T00:00:00.000Z`)
        : null;
  const exchangeRate =
    draft.exchangeRate === undefined ? (had?.exchangeRate ?? null) : (draft.exchangeRate ?? null);
  const bankRef = draft.bankRef === undefined ? (had?.bankRef ?? null) : draft.bankRef;
  const remarks = draft.remarks === undefined ? (had?.remarks ?? null) : draft.remarks;

  const data = {
    receiptDate,
    amount: draft.amount,
    currency: invoice.currency,
    exchangeRate,
    // the home-currency figure is stored for reporting; the register works from
    // the FCY amount and the rate, so this is never the source of truth
    homeAmount:
      exchangeRate === null ? null : Math.round(draft.amount * exchangeRate * 100) / 100,
    bankRef,
    remarks,
    // the origin of the row is not retyped by an edit: a receipt read off a
    // payment advice stays attributed to that advice even after a correction
    source: draft.source ?? had?.source ?? `entered by ${LOCAL_USER.name}`,
  };

  const receipt = await prisma.receipt.upsert({
    where: { invoiceId_seq: { invoiceId, seq } },
    create: { invoiceId, seq, ...data },
    update: data,
  });

  await rebuildInvoice(invoiceId);
  return { ok: true, receiptId: receipt.id, seq };
}

/**
 * Remove a receipt and close the gap in the numbering, so the register never
 * shows an empty Receipt 2 between a filled 1 and 3.
 */
export async function removeReceipt(invoiceId: string, seq: number): Promise<void> {
  await prisma.receipt.deleteMany({ where: { invoiceId, seq } });

  const remaining = await prisma.receipt.findMany({
    where: { invoiceId },
    orderBy: { seq: "asc" },
    select: { id: true, seq: true },
  });
  // renumber in two passes: seq is unique per invoice, so move them out of the
  // way first rather than colliding with a number still in use
  for (const [index, r] of remaining.entries()) {
    const target = index + 1;
    if (r.seq !== target) {
      await prisma.receipt.update({ where: { id: r.id }, data: { seq: -(index + 1) } });
    }
  }
  for (const [index, r] of remaining.entries()) {
    const target = index + 1;
    const current = await prisma.receipt.findUnique({ where: { id: r.id }, select: { seq: true } });
    if (current && current.seq !== target) {
      await prisma.receipt.update({ where: { id: r.id }, data: { seq: target } });
    }
  }

  await rebuildInvoice(invoiceId);
}

export interface NoteDraft {
  /** The row to change. Omit to add a new note. */
  id?: string;
  noteType: "CREDIT" | "DEBIT";
  amount: number;
  noteNo?: string | null;
  noteDate?: string | null;
  reason?: string | null;
}

/**
 * Add or change one credit / debit note.
 *
 * A note used to be add-or-delete only, which meant a mistyped amount had to be
 * deleted and retyped — and the deletion took the note number and the reason
 * with it. Passing `id` changes the row in place instead. Same rule as a
 * receipt: a field the caller did not mention keeps what it had.
 */
export async function saveNote(invoiceId: string, draft: NoteDraft): Promise<SaveOutcome> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, currency: true },
  });
  if (!invoice) return { ok: false, message: "That invoice no longer exists." };
  if (!Number.isFinite(draft.amount) || draft.amount <= 0) {
    return { ok: false, message: "A note needs an amount greater than zero." };
  }

  const had = draft.id
    ? await prisma.creditDebitNote.findFirst({ where: { id: draft.id, invoiceId } })
    : null;
  if (draft.id && !had) return { ok: false, message: "That note no longer exists." };

  const data = {
    noteType: draft.noteType,
    amount: draft.amount,
    currency: invoice.currency,
    noteNo: draft.noteNo === undefined ? (had?.noteNo ?? null) : draft.noteNo,
    noteDate:
      draft.noteDate === undefined
        ? (had?.noteDate ?? null)
        : draft.noteDate
          ? new Date(`${draft.noteDate}T00:00:00.000Z`)
          : null,
    reason: draft.reason === undefined ? (had?.reason ?? null) : draft.reason,
  };

  const note = had
    ? await prisma.creditDebitNote.update({ where: { id: had.id }, data })
    : await prisma.creditDebitNote.create({ data: { invoiceId, ...data } });

  await rebuildInvoice(invoiceId);
  return { ok: true, receiptId: note.id, seq: 0 };
}

export async function removeNote(invoiceId: string, noteId: string): Promise<void> {
  await prisma.creditDebitNote.deleteMany({ where: { id: noteId, invoiceId } });
  await rebuildInvoice(invoiceId);
}

/** Parse a form field the same way whoever typed it would expect. */
export function parseAmount(value: FormDataEntryValue | null): number | null {
  return toNumber(String(value ?? ""));
}

export function parseDate(value: FormDataEntryValue | null): string | null {
  return toIsoDate(String(value ?? ""));
}
