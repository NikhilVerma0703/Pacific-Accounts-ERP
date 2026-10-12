/**
 * The boundary with the Commercial ERP.
 *
 * Nothing here talks to the Commercial ERP — that integration is not built. What
 * is built is the *shape* of it, so that when the time comes the work is writing
 * one adapter that produces a `CommercialUpdate`, and nothing in the Accounts
 * module has to change.
 *
 * The intended flow:
 *
 *   Commercial ERP → invoice / sheet / PDF / shipping data
 *                  → Accounts ERP  (Inspect / Import / Sync)
 *                  → applyCommercialUpdate()
 *                  → the Accounts record is created or updated
 *
 * Three decisions are already made here, because they are the ones that are
 * expensive to change later:
 *
 * 1. **Invoice number is the key.** The Commercial ERP's own id is kept beside
 *    it, so a later rename can be followed, but matching is on the number that
 *    is printed on the document.
 *
 * 2. **A sync never overwrites a person.** Field precedence is
 *    `manual > document > synced > derived`, so a value an Accounts employee
 *    typed in survives every sync, and a value read off the invoice survives a
 *    sync that disagrees with it unless the sync is marked authoritative.
 *
 * 3. **A sync carries only what it owns.** The Commercial ERP is the authority
 *    on PI/PO, shipping bill, BL, container and ETA — not on money. Amounts are
 *    accepted only to fill a gap, never to change a figure already read off the
 *    invoice.
 */
import "server-only";

import { prisma } from "@/lib/db";
import { BY_KEY } from "@/lib/extraction/catalog";
import { toIsoDate, toNumber } from "@/lib/extraction/text";
import { FieldStatus, type ExtractedField } from "@/lib/extraction/types";
import { fromJson, toJson } from "@/lib/json";
import { rebuildInvoice } from "@/server/invoiceData";

/** What the Commercial ERP is the authority on. */
export const COMMERCIAL_OWNED = [
  "piNo", "poNo", "poDate",
  "shippingBillNo", "shippingBillDate",
  "blNo", "blDate",
  "containerNo", "vesselFlightNo", "esealNo", "vehicleNo",
  "portOfLoading", "portOfDischarge", "finalDestination", "eta",
] as const;

export type CommercialField = (typeof COMMERCIAL_OWNED)[number];

/** One invoice's worth of commercial / shipping information. */
export interface CommercialUpdate {
  /** The invoice number as printed. The key this is matched on. */
  invoiceNo: string;
  /** The Commercial ERP's own identifier, kept so a rename can be followed. */
  externalId?: string | null;
  /** Which system sent this, for the audit trail. */
  sourceSystem: string;
  /** When the Commercial ERP last changed this record. */
  updatedAt?: string | null;
  values: Partial<Record<CommercialField, string | number | null>>;
}

export type SyncOutcome = "updated" | "unchanged" | "not-found";

export interface SyncResult {
  invoiceNo: string;
  outcome: SyncOutcome;
  /** Fields this sync actually wrote. */
  applied: CommercialField[];
  /** Fields it left alone, and why. */
  skipped: Array<{ field: CommercialField; reason: string }>;
}

/**
 * Whether a synced value may replace what is already stored.
 *
 * The rule in one place: a person's entry always wins; a value read off the
 * document wins unless the sync is explicitly authoritative; anything else — a
 * blank, a derived value, a previous sync — gives way.
 */
function mayOverwrite(existing: ExtractedField | undefined, authoritative: boolean): {
  allowed: boolean;
  reason: string;
} {
  if (!existing || existing.value === null || existing.value === undefined) {
    return { allowed: true, reason: "" };
  }
  if (existing.source?.startsWith("entered by")) {
    return { allowed: false, reason: "entered by hand — a sync never overwrites a person" };
  }
  if (existing.status === FieldStatus.EXTRACTED && !authoritative) {
    return { allowed: false, reason: "already read from the invoice" };
  }
  return { allowed: true, reason: "" };
}

/**
 * Merge one commercial update into the Accounts record.
 *
 * This is the single entry point a future integration calls — whether the
 * trigger is a button, a webhook or a scheduled job. Everything it needs is in
 * the argument, so the transport can be anything.
 *
 * @param authoritative let the Commercial ERP correct values already read off
 *                      the invoice. Off by default: a sync fills gaps.
 */
export async function applyCommercialUpdate(
  update: CommercialUpdate,
  opts: { authoritative?: boolean } = {},
): Promise<SyncResult> {
  const authoritative = opts.authoritative ?? false;
  const invoice = await prisma.invoice.findUnique({ where: { invoiceNo: update.invoiceNo } });
  if (!invoice) {
    return { invoiceNo: update.invoiceNo, outcome: "not-found", applied: [], skipped: [] };
  }

  const fields = fromJson<Record<string, ExtractedField>>(invoice.fields, {});
  const applied: CommercialField[] = [];
  const skipped: SyncResult["skipped"] = [];

  for (const [key, raw] of Object.entries(update.values) as Array<
    [CommercialField, string | number | null]
  >) {
    if (!COMMERCIAL_OWNED.includes(key)) {
      skipped.push({ field: key, reason: "not a field the Commercial ERP owns" });
      continue;
    }
    if (raw === null || raw === undefined || String(raw).trim() === "") continue;

    const check = mayOverwrite(fields[key], authoritative);
    if (!check.allowed) {
      skipped.push({ field: key, reason: check.reason });
      continue;
    }

    const def = BY_KEY[key];
    let value: string | number | null = String(raw).trim();
    if (def?.type === "date") value = toIsoDate(value);
    else if (def?.type === "number" || def?.type === "currency") value = toNumber(value);
    if (value === null) {
      skipped.push({ field: key, reason: `'${raw}' could not be read as a ${def?.type ?? "value"}` });
      continue;
    }

    if (fields[key]?.value === value) continue;

    fields[key] = {
      key,
      value,
      raw: String(raw),
      status: FieldStatus.EXTRACTED,
      source: `synced from ${update.sourceSystem}`,
      confidence: 1,
      note: `Received from ${update.sourceSystem}${
        update.updatedAt ? ` (updated ${update.updatedAt})` : ""
      }.`,
    };
    applied.push(key);
  }

  if (!applied.length) {
    return { invoiceNo: update.invoiceNo, outcome: "unchanged", applied, skipped };
  }

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { fields: toJson(fields) },
  });

  // synced values are recorded in the same audit trail as manual corrections,
  // so "who changed this" has one answer, not two
  for (const field of applied) {
    await prisma.fieldEdit.create({
      data: {
        invoiceId: invoice.id,
        fieldKey: field,
        oldValue: null,
        newValue: String(fields[field].value),
        editedBy: update.sourceSystem,
      },
    });
  }

  await rebuildInvoice(invoice.id);
  await prisma.importLog.create({
    data: {
      fileName: `${update.invoiceNo} (${update.sourceSystem})`,
      outcome: "UPDATED",
      invoiceId: invoice.id,
      message: `Commercial sync filled ${applied.join(", ")}.`,
    },
  });

  return { invoiceNo: update.invoiceNo, outcome: "updated", applied, skipped };
}

/** Several invoices in one call — what a batch sync or a nightly job would use. */
export async function applyCommercialUpdates(
  updates: CommercialUpdate[],
  opts: { authoritative?: boolean } = {},
): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  for (const update of updates) out.push(await applyCommercialUpdate(update, opts));
  return out;
}
