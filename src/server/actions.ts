"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { EVENTS, inngest } from "@/inngest/client";
import { USE_INNGEST } from "@/lib/config";
import { prisma } from "@/lib/db";
import type { ExtractedField } from "@/lib/extraction/types";
import { fromJson, toJson } from "@/lib/json";
import { LOCAL_USER } from "@/lib/session";
// Only the light, database-side helpers. `ingestFile` and the re-extractors read
// documents, which pulls the Excel and PDF readers into the module graph of every
// route that imports this file — so they live in importActions.ts, which only the
// two import screens use. See the note at the top of server/invoiceData.ts.
import {
  applyManualValue,
  deleteInvoice,
  rebuildAllInvoices,
  rebuildInvoice,
} from "@/server/invoiceData";
import {
  createManualInvoice,
  MANUAL_FIELDS,
  suggestInvoiceNo,
  type ManualField,
  type ManualNote,
  type ManualReceipt,
} from "@/server/manualInvoice";
import { LINE_ITEM_FIELDS } from "@/lib/lineItemFields";
import { saveFieldGroup, SHIPPING_FIELDS } from "@/server/fieldGroups";
import { saveLineItems } from "@/server/lineItems";
import { applyBooksUpdate, BOOKS_FIELDS, type BooksField } from "@/server/tally";
import {
  parseAmount,
  parseDate,
  removeNote,
  removeReceipt,
  saveNote,
  saveReceipt,
} from "@/server/receipts";

/**
 * Register-wide work. Locally it runs inline so nothing else has to be started;
 * set USE_INNGEST=true and run `npm run inngest:dev` to hand it to the jobs engine.
 */
async function runRegisterJob(
  event: (typeof EVENTS)[keyof typeof EVENTS],
  data: Record<string, unknown>,
  inline: () => Promise<number>,
): Promise<void> {
  if (USE_INNGEST) {
    await inngest.send({ name: event, data });
    return;
  }
  await inline();
}

// ---------------------------------------------------------------- invoice edits
const editSchema = z.object({
  invoiceId: z.string().min(1),
  key: z.string().min(1),
  value: z.string(),
});

export async function updateFieldAction(formData: FormData): Promise<void> {
  const parsed = editSchema.safeParse({
    invoiceId: formData.get("invoiceId"),
    key: formData.get("key"),
    value: formData.get("value") ?? "",
  });
  if (!parsed.success) return;
  const { invoiceId, key, value } = parsed.data;

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return;

  const fields = fromJson<Record<string, ExtractedField>>(invoice.fields, {});
  const previous = fields[key]?.value ?? null;
  // the same helper re-extraction uses, so a correction is written identically
  // however it gets applied
  const parsedValue = applyManualValue(fields, key, value, LOCAL_USER.name);

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { fields: toJson(fields) },
  });
  await prisma.fieldEdit.create({
    data: {
      invoiceId,
      fieldKey: key,
      oldValue: previous === null ? null : String(previous),
      newValue: parsedValue === null ? null : String(parsedValue),
      editedBy: LOCAL_USER.name,
    },
  });
  await rebuildInvoice(invoiceId);

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
}

export async function toggleVerifiedAction(formData: FormData): Promise<void> {
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return;
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { verified: !invoice.verified },
  });
  revalidatePath(`/invoices/${invoiceId}`);
}

/**
 * Remove an imported invoice — the uploaded file, the register row and the
 * corrections attached to it, together.
 *
 * `redirectTo` is what the caller wants to see afterwards: the invoice detail
 * screen and the import screen send the user back to the register, while the
 * register itself stays where it is and simply loses the row. Only in-app paths
 * are honoured, so a crafted form cannot bounce anyone off-site.
 */
export async function deleteInvoiceAction(formData: FormData): Promise<void> {
  const invoiceId = String(formData.get("invoiceId") ?? "");
  if (!invoiceId) return;

  const requested = String(formData.get("redirectTo") ?? "");
  const target = /^\/(?!\/)/.test(requested) ? requested : "";

  await deleteInvoice(invoiceId);

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/");
  if (target) redirect(target);
}

// ---------------------------------------------------------------- manual entry
export type ManualState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "created";
      invoiceId: string;
      invoiceNo: string;
      receipts: number;
      notes: number;
      /** The next free DUMMY/nnn, so the form can offer it straight away. */
      nextInvoiceNo: string;
    };

/**
 * Create one register record by hand — invoice fields, receipts and notes in a
 * single save, producing exactly the row an import would.
 *
 * It returns state rather than redirecting, so a rejection does not throw away
 * what was typed and "Create & add another" can stay on the page.
 */
export async function createManualInvoiceAction(
  _prev: ManualState,
  formData: FormData,
): Promise<ManualState> {
  const values: Partial<Record<ManualField, string>> = {};
  for (const key of MANUAL_FIELDS) values[key] = String(formData.get(key) ?? "");

  // the receipt and note rows arrive as parallel lists, one entry per row
  const receiptAmounts = formData.getAll("receiptAmount");
  const receiptDates = formData.getAll("receiptDate");
  const receiptRates = formData.getAll("receiptRate");
  const receiptRefs = formData.getAll("receiptBankRef");

  const receipts: ManualReceipt[] = [];
  for (const [i, rawAmount] of receiptAmounts.entries()) {
    const amount = parseAmount(rawAmount);
    // a row left blank is simply not a receipt
    if (amount === null || amount <= 0) continue;
    receipts.push({
      amount,
      receiptDate: parseDate(receiptDates[i] ?? null),
      exchangeRate: parseAmount(receiptRates[i] ?? null),
      bankRef: String(receiptRefs[i] ?? "").trim() || null,
    });
  }

  const noteTypes = formData.getAll("noteType");
  const noteAmounts = formData.getAll("noteAmount");
  const noteNos = formData.getAll("noteNo");
  const noteDates = formData.getAll("noteDate");

  const notes: ManualNote[] = [];
  for (const [i, rawAmount] of noteAmounts.entries()) {
    const amount = parseAmount(rawAmount);
    if (amount === null || amount <= 0) continue;
    const type = String(noteTypes[i] ?? "CREDIT") === "DEBIT" ? "DEBIT" : "CREDIT";
    notes.push({
      noteType: type,
      amount,
      noteNo: String(noteNos[i] ?? "").trim() || null,
      noteDate: parseDate(noteDates[i] ?? null),
    });
  }

  const result = await createManualInvoice({ values, receipts, notes });
  if (!result.ok) return { status: "error", message: result.message };

  revalidatePath("/invoices");
  revalidatePath("/");

  return {
    status: "created",
    invoiceId: result.invoiceId,
    invoiceNo: result.invoiceNo,
    receipts: result.receipts,
    notes: result.notes,
    nextInvoiceNo: await suggestInvoiceNo(),
  };
}

// ---------------------------------------------------------------- receipts
function receiptRevalidate(invoiceId: string): void {
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
  revalidatePath("/");
}

/**
 * Add or update one receipt. The same fields the receipt importer fills, so a
 * value typed here and a value read off a payment advice are stored identically.
 */
export async function saveReceiptAction(formData: FormData): Promise<void> {
  const invoiceId = String(formData.get("invoiceId") ?? "");
  if (!invoiceId) return;

  const seqRaw = String(formData.get("seq") ?? "");
  const amount = parseAmount(formData.get("amount"));
  if (amount === null) return;

  // only what the form actually carried: a field whose input was not on the
  // form must keep its value, not be blanked. See saveReceipt.
  await saveReceipt(invoiceId, {
    seq: seqRaw ? Number(seqRaw) : undefined,
    amount,
    ...(formData.has("receiptDate") ? { receiptDate: parseDate(formData.get("receiptDate")) } : {}),
    ...(formData.has("exchangeRate")
      ? { exchangeRate: parseAmount(formData.get("exchangeRate")) }
      : {}),
    ...(formData.has("bankRef")
      ? { bankRef: String(formData.get("bankRef") ?? "").trim() || null }
      : {}),
    ...(formData.has("remarks")
      ? { remarks: String(formData.get("remarks") ?? "").trim() || null }
      : {}),
  });
  receiptRevalidate(invoiceId);
}

export async function removeReceiptAction(formData: FormData): Promise<void> {
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const seq = Number(formData.get("seq") ?? 0);
  if (!invoiceId || !seq) return;
  await removeReceipt(invoiceId, seq);
  receiptRevalidate(invoiceId);
}

export async function saveNoteAction(formData: FormData): Promise<void> {
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const noteType = String(formData.get("noteType") ?? "");
  const amount = parseAmount(formData.get("amount"));
  if (!invoiceId || amount === null) return;
  if (noteType !== "CREDIT" && noteType !== "DEBIT") return;

  // an id means change that note in place rather than adding another
  const noteId = String(formData.get("noteId") ?? "").trim();
  await saveNote(invoiceId, {
    ...(noteId ? { id: noteId } : {}),
    noteType,
    amount,
    ...(formData.has("noteNo")
      ? { noteNo: String(formData.get("noteNo") ?? "").trim() || null }
      : {}),
    ...(formData.has("noteDate") ? { noteDate: parseDate(formData.get("noteDate")) } : {}),
    ...(formData.has("reason")
      ? { reason: String(formData.get("reason") ?? "").trim() || null }
      : {}),
  });
  receiptRevalidate(invoiceId);
}

export async function removeNoteAction(formData: FormData): Promise<void> {
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const noteId = String(formData.get("noteId") ?? "");
  if (!invoiceId || !noteId) return;
  await removeNote(invoiceId, noteId);
  receiptRevalidate(invoiceId);
}

// ------------------------------------------------- shipping & books (manual)
/**
 * Save the commercial / shipping block. Manual for now; when the Commercial ERP
 * is connected it writes the same fields through applyCommercialUpdate, and a
 * value typed here wins over a later sync.
 */
export async function saveShippingAction(formData: FormData): Promise<void> {
  const invoiceId = String(formData.get("invoiceId") ?? "");
  if (!invoiceId) return;

  const values: Record<string, string> = {};
  for (const key of SHIPPING_FIELDS) values[key] = String(formData.get(key) ?? "");

  await saveFieldGroup(invoiceId, values, SHIPPING_FIELDS);
  receiptRevalidate(invoiceId);
  revalidatePath("/shipping");
}

/**
 * Save the line items as submitted.
 *
 * The form posts one indexed group per row — `li.0.description`, `li.0.amount`,
 * `li.1.description` and so on — and `rowCount` says how many to read. Rows
 * arrive whole because they are stored whole, in a JSON column, and a row left
 * entirely empty is dropped, which is what the "clear row" button does.
 */
export async function saveLineItemsAction(formData: FormData): Promise<void> {
  const invoiceId = String(formData.get("invoiceId") ?? "");
  if (!invoiceId) return;

  const count = Number(formData.get("rowCount") ?? 0);
  const rows: Array<Record<string, string>> = [];
  for (let i = 0; i < count; i += 1) {
    const row: Record<string, string> = {};
    for (const [key] of LINE_ITEM_FIELDS) {
      const name = `li.${i}.${key}`;
      if (formData.has(name)) row[key] = String(formData.get(name) ?? "");
    }
    rows.push(row);
  }

  await saveLineItems(invoiceId, rows);
  receiptRevalidate(invoiceId);
}

/**
 * Save the Tally / e-Invoice block by hand. Recorded as entered by a person, so
 * a future Tally or IRP sync will not overwrite it.
 */
export async function saveBooksAction(formData: FormData): Promise<void> {
  const invoiceId = String(formData.get("invoiceId") ?? "");
  if (!invoiceId) return;

  const values: Partial<Record<BooksField, string>> = {};
  for (const key of BOOKS_FIELDS) values[key] = String(formData.get(key) ?? "");

  await applyBooksUpdate(
    { invoiceNo: "", sourceSystem: `entered by ${LOCAL_USER.name}`, values },
    { matchById: invoiceId },
  );
  receiptRevalidate(invoiceId);
  revalidatePath("/tally");
}

// ---------------------------------------------------------------- rules
const rulePartSchema = z.object({
  percent: z.coerce.number().min(0.01).max(100),
  creditDays: z.coerce.number().int().min(0).max(720),
  basis: z.enum(["INVOICE_DATE", "BL_DATE", "SHIPPING_BILL_DATE", "ETA"]),
});

const ruleSchema = z.object({
  label: z.string().min(1),
  pattern: z.string().min(1),
  creditDays: z.coerce.number().int().min(0).max(720),
  basis: z.enum(["INVOICE_DATE", "BL_DATE", "SHIPPING_BILL_DATE", "ETA"]),
});

export async function addRuleAction(formData: FormData): Promise<void> {
  const parsed = ruleSchema.safeParse({
    label: formData.get("label"),
    pattern: formData.get("pattern"),
    creditDays: formData.get("creditDays"),
    basis: formData.get("basis"),
  });
  if (!parsed.success) return;

  const rule = await prisma.paymentTermRule.create({ data: parsed.data });
  await runRegisterJob(EVENTS.rulesChanged, { ruleId: rule.id }, rebuildAllInvoices);
  revalidatePath("/settings");
  revalidatePath("/invoices");
  revalidatePath("/");
}

export async function deleteRuleAction(formData: FormData): Promise<void> {
  const id = String(formData.get("ruleId") ?? "");
  await prisma.paymentTermRule.delete({ where: { id } });
  await runRegisterJob(EVENTS.rulesChanged, { ruleId: id }, rebuildAllInvoices);
  revalidatePath("/settings");
  revalidatePath("/invoices");
  revalidatePath("/");
}

/**
 * Turn a rule into a split term, or change the portions of one.
 *
 * "70% Cash Against Documents, balance 30% at 90 days" is one payment term with
 * two due dates, and an invoice on it is only partly overdue for ninety days.
 * The portions are stored as rows; the percentages must total 100, because a
 * term that totals 97% would quietly under-bill every invoice it touches.
 *
 * Submitting no portions clears them, which turns the rule back into the
 * ordinary single-due-date kind.
 */
export async function saveRulePartsAction(formData: FormData): Promise<void> {
  const ruleId = String(formData.get("ruleId") ?? "");
  if (!ruleId) return;

  const parts: { seq: number; percent: number; creditDays: number; basis: string }[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const percent = Number(formData.get(`percent${i}`) ?? "");
    if (!Number.isFinite(percent) || percent <= 0) continue;
    const parsed = rulePartSchema.safeParse({
      percent,
      creditDays: formData.get(`days${i}`),
      basis: formData.get(`basis${i}`),
    });
    if (!parsed.success) return;
    parts.push({ seq: parts.length + 1, ...parsed.data });
  }

  // one portion is not a split term, it is the plain kind — stored as no
  // portions at all so there is exactly one representation of that case
  if (parts.length < 2) {
    await prisma.paymentTermPart.deleteMany({ where: { ruleId } });
  } else {
    const total = Math.round(parts.reduce((sum, p) => sum + p.percent, 0) * 100) / 100;
    if (Math.abs(total - 100) > 0.01) return;

    await prisma.$transaction([
      prisma.paymentTermPart.deleteMany({ where: { ruleId } }),
      prisma.paymentTermPart.createMany({
        data: parts.map((p) => ({ ruleId, ...p })),
      }),
    ]);
  }

  await runRegisterJob(EVENTS.rulesChanged, { ruleId }, rebuildAllInvoices);
  revalidatePath("/settings");
  revalidatePath("/invoices");
  revalidatePath("/follow-up");
  revalidatePath("/");
}

