/**
 * Saving a group of fields on one invoice in one go.
 *
 * The shipping block and the books block are both "several related fields, typed
 * in together", so they share this: each value goes through `applyManualValue`
 * (the same helper the single-field edit and re-extraction use), each change is
 * recorded in the audit trail, and the row is rebuilt once at the end rather
 * than after every field.
 */
import "server-only";

import { prisma } from "@/lib/db";
import { BY_KEY } from "@/lib/extraction/catalog";
import type { ExtractedField } from "@/lib/extraction/types";
import { fromJson, toJson } from "@/lib/json";
import { LOCAL_USER } from "@/lib/session";
import { applyManualValue, rebuildInvoice } from "@/server/invoiceData";

/** Commercial / shipping fields, in the order the panel shows them. */
export const SHIPPING_FIELDS = [
  "piNo", "poNo", "poDate",
  "shippingBillNo", "shippingBillDate",
  "blNo", "blDate",
  "containerNo", "vesselFlightNo", "eta",
] as const;

export type ShippingField = (typeof SHIPPING_FIELDS)[number];

export interface GroupSaveResult {
  changed: string[];
  cleared: string[];
}

/**
 * @param allowed the only keys this call may touch, so a crafted form cannot
 *                reach into the rest of the invoice
 */
export async function saveFieldGroup(
  invoiceId: string,
  values: Record<string, string>,
  allowed: readonly string[],
): Promise<GroupSaveResult> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return { changed: [], cleared: [] };

  const fields = fromJson<Record<string, ExtractedField>>(invoice.fields, {});
  const changed: string[] = [];
  const cleared: string[] = [];
  const edits: Array<{ key: string; from: string | null; to: string | null }> = [];

  for (const key of allowed) {
    if (!(key in values)) continue;
    if (!BY_KEY[key]) continue;

    const raw = String(values[key] ?? "").trim();
    const before = fields[key]?.value ?? null;

    // an empty box clears the value rather than being ignored, so a mistyped
    // shipping bill can be taken back out
    const after = applyManualValue(fields, key, raw, LOCAL_USER.name);
    if (String(before ?? "") === String(after ?? "")) continue;

    if (after === null) cleared.push(key);
    else changed.push(key);
    edits.push({
      key,
      from: before === null ? null : String(before),
      to: after === null ? null : String(after),
    });
  }

  if (!edits.length) return { changed, cleared };

  await prisma.invoice.update({ where: { id: invoiceId }, data: { fields: toJson(fields) } });
  for (const e of edits) {
    await prisma.fieldEdit.create({
      data: {
        invoiceId,
        fieldKey: e.key,
        oldValue: e.from,
        newValue: e.to,
        editedBy: LOCAL_USER.name,
      },
    });
  }
  await rebuildInvoice(invoiceId);

  return { changed, cleared };
}
