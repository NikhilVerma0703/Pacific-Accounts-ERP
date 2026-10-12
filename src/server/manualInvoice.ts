/**
 * Creating an invoice record by hand.
 *
 * Import is still the main road — it fills sixty-odd fields from one upload —
 * but not every invoice arrives as a file. This is the other road, and it lands
 * in exactly the same place: the same catalogue keys, the same normalizer, the
 * same Accounts row. The only difference is that each value is marked as having
 * been entered by a person, which is the highest-precedence source in the
 * system: nothing derived, synced or re-read ever overwrites it.
 */
import "server-only";

import { buildAccountsRow } from "@/lib/business/accounts";
import { prisma } from "@/lib/db";
import { EXTRACTION_VERSION } from "@/lib/extraction/version";
import { ExtractionResult, type ExtractedField } from "@/lib/extraction/types";
import { LOCAL_USER } from "@/lib/session";
import { normalize } from "@/lib/normalize/normalizer";
import { assess } from "@/lib/normalize/validators";
import {
  applyManualValue,
  invoiceScalarsFor,
  loadRules,
  rebuildInvoice,
} from "@/server/invoiceData";
import { saveNote, saveReceipt } from "@/server/receipts";

/**
 * The fields the manual form offers, grouped the way the form shows them.
 *
 * Every register column that can come from an invoice is reachable from here, so
 * a hand-made record can fill the same table as an imported one. The Tally
 * columns are deliberately absent: they are not on an invoice either.
 */
export const MANUAL_GROUPS = [
  {
    title: "Invoice",
    hint: "The invoice number is all that is strictly needed — it is what prevents duplicates.",
    fields: ["invoiceNo", "invoiceDate", "currency", "exchangeRate", "invoiceValue", "paymentTerms"],
  },
  {
    title: "Parties",
    hint: "Leave the customer blank and the notify party becomes the customer, exactly as on an imported invoice.",
    fields: ["customerName", "consigneeName", "notifyPartyName", "countryOfDestination"],
  },
  {
    title: "Commercial & shipping",
    hint: "What the Commercial ERP will eventually fill in on its own.",
    fields: [
      "piNo", "poNo", "shippingBillNo", "shippingBillDate",
      "blNo", "blDate", "containerNo", "eta",
    ],
  },
] as const;

export type ManualField = (typeof MANUAL_GROUPS)[number]["fields"][number];

/** Flat list, in form order. */
export const MANUAL_FIELDS: readonly ManualField[] = MANUAL_GROUPS.flatMap(
  (g) => g.fields as readonly ManualField[],
);

/** A receipt typed in on the create form, before it has an invoice to belong to. */
export interface ManualReceipt {
  receiptDate?: string | null;
  amount: number;
  exchangeRate?: number | null;
  bankRef?: string | null;
}

export interface ManualNote {
  noteType: "CREDIT" | "DEBIT";
  amount: number;
  noteNo?: string | null;
  noteDate?: string | null;
  reason?: string | null;
}

export interface ManualInput {
  values: Partial<Record<ManualField, string>>;
  receipts?: ManualReceipt[];
  notes?: ManualNote[];
}

export type ManualResult =
  | {
      ok: true;
      invoiceId: string;
      invoiceNo: string;
      receipts: number;
      notes: number;
    }
  | { ok: false; message: string };

/**
 * Build a normalized invoice out of typed-in values only.
 *
 * `normalize` fills every other catalogue key with an honest "not present", so a
 * hand-made record is as explicit about what it does not know as an imported one.
 */
export async function createManualInvoice(input: ManualInput): Promise<ManualResult> {
  const { values, receipts = [], notes = [] } = input;
  const invoiceNo = (values.invoiceNo ?? "").trim();
  if (!invoiceNo) {
    return { ok: false, message: "An invoice number is needed — it is what prevents duplicates." };
  }

  const existing = await prisma.invoice.findUnique({ where: { invoiceNo } });
  if (existing) {
    return {
      ok: false,
      message: `Invoice ${invoiceNo} is already in the register. Open it to edit, or delete it first.`,
    };
  }

  const fields: Record<string, ExtractedField> = {};
  for (const key of MANUAL_FIELDS) {
    const raw = (values[key] ?? "").trim();
    if (raw) applyManualValue(fields, key, raw, LOCAL_USER.name);
  }

  const extraction = new ExtractionResult("xlsx");
  extraction.sourceName = `entered by ${LOCAL_USER.name}`;
  for (const [key, field] of Object.entries(fields)) extraction.fields.set(key, field);
  extraction.warnings.push(
    "Entered by hand rather than read from a document, so these values carry no source cell " +
      "on the invoice.",
  );

  const normalized = normalize(extraction);

  const quality = assess(normalized);
  const rules = await loadRules();
  const row = buildAccountsRow(normalized, quality, { slNo: 1, receipts: [], notes: [], rules });

  const invoice = await prisma.invoice.create({
    data: {
      ...invoiceScalarsFor(normalized, row, quality),
      // a hand-made record has no file behind it, so re-extraction must skip it
      extractionVersion: EXTRACTION_VERSION,
    },
  });

  // Receipts and notes go through the same functions the invoice screen uses, so
  // a record created here is indistinguishable from one built up over time — and
  // the last saveReceipt / saveNote recalculates the row, which is why the
  // register row is complete the moment this returns.
  for (const [index, r] of receipts.entries()) {
    await saveReceipt(invoice.id, {
      seq: index + 1,
      amount: r.amount,
      receiptDate: r.receiptDate ?? null,
      exchangeRate: r.exchangeRate ?? null,
      bankRef: r.bankRef ?? null,
      source: `entered by ${LOCAL_USER.name}`,
    });
  }
  for (const n of notes) {
    await saveNote(invoice.id, {
      noteType: n.noteType,
      amount: n.amount,
      noteNo: n.noteNo ?? null,
      noteDate: n.noteDate ?? null,
      reason: n.reason ?? null,
    });
  }
  // nothing was added, so nothing recalculated it — do that now
  if (!receipts.length && !notes.length) await rebuildInvoice(invoice.id);

  const parts = [`Record created manually by ${LOCAL_USER.name}`];
  if (receipts.length) parts.push(`${receipts.length} receipt(s)`);
  if (notes.length) parts.push(`${notes.length} credit / debit note(s)`);

  await prisma.importLog.create({
    data: {
      fileName: `${invoiceNo} (entered by hand)`,
      outcome: "IMPORTED",
      invoiceId: invoice.id,
      message: `${parts.join(", ")}.`,
    },
  });

  return {
    ok: true,
    invoiceId: invoice.id,
    invoiceNo,
    receipts: receipts.length,
    notes: notes.length,
  };
}

/**
 * The next obvious invoice number for a dummy record, so testing the register
 * does not mean inventing a unique number every time. Only used to pre-fill the
 * form — what gets saved is whatever is in the box.
 */
export async function suggestInvoiceNo(prefix = "DUMMY"): Promise<string> {
  const existing = await prisma.invoice.findMany({
    where: { invoiceNo: { startsWith: `${prefix}/` } },
    select: { invoiceNo: true },
  });
  const highest = existing.reduce((max, { invoiceNo }) => {
    const n = Number(invoiceNo.slice(prefix.length + 1));
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `${prefix}/${String(highest + 1).padStart(3, "0")}`;
}
