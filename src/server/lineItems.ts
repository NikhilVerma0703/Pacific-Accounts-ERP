/**
 * Editing the line items of an invoice.
 *
 * The line items are the one block that used to be read-only: they came out of
 * the invoice sheet and were shown exactly as extracted. That is defensible
 * right up to the moment a reader misreads a thickness or merges two rows, and
 * then there is nothing to be done about it.
 *
 * Two things make this more than a form:
 *
 * **The rows live in a JSON column, not a table.** They are extraction output,
 * read and written whole, so a save rewrites the array rather than updating a
 * row. That means the form has to post every row every time — which it does,
 * one indexed group of inputs per row.
 *
 * **"Sum of Line Items" is a cross-check, not a copy.** The extractor compares
 * it against the invoice total and warns when they differ, which is how a
 * misread amount gets noticed. If editing a row left that total as the
 * extractor first computed it, the check would go on comparing the invoice
 * against figures that are no longer there — so it is recomputed here from the
 * rows as saved, and it says it was.
 */
import "server-only";

import { prisma } from "@/lib/db";
import { toNumber } from "@/lib/extraction/text";
import { FieldStatus, type ExtractedField, type LineItem } from "@/lib/extraction/types";
import { fromJson, toJson } from "@/lib/json";
import { LINE_ITEM_FIELDS, LINE_ITEM_NUMERIC } from "@/lib/lineItemFields";
import { LOCAL_USER } from "@/lib/session";
import { rebuildInvoice } from "@/server/invoiceData";

function blank(): LineItem {
  return {
    description: null,
    designColour: null,
    thickness: null,
    hsn: null,
    quantity: null,
    unit: null,
    rate: null,
    amount: null,
    slabsPcs: null,
    netWeight: null,
    netWeightUnit: null,
    marksNos: null,
    packages: null,
    source: null,
  };
}

/** Is there anything in this row at all? An entirely empty row is dropped. */
function empty(item: LineItem): boolean {
  return LINE_ITEM_FIELDS.every(([key]) => {
    const v = item[key as keyof LineItem];
    return v === null || v === undefined || v === "";
  });
}

export interface LineItemSaveResult {
  ok: boolean;
  message: string;
  rows: number;
  /** The recomputed sum, and the invoice total it was compared against. */
  total: number | null;
  invoiceValue: number | null;
}

/**
 * Replace an invoice's line items with the rows as submitted.
 *
 * @param rows one entry per row, each holding only the fields the form carried.
 *             A row with nothing in it is dropped, which is how the "remove this
 *             row" button works without a separate action: it clears the row's
 *             inputs and submits.
 */
export async function saveLineItems(
  invoiceId: string,
  rows: Array<Record<string, string>>,
): Promise<LineItemSaveResult> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) {
    return { ok: false, message: "That invoice no longer exists.", rows: 0, total: null, invoiceValue: null };
  }

  const before = fromJson<LineItem[]>(invoice.lineItems, []);
  const items: LineItem[] = [];

  for (const [index, raw] of rows.entries()) {
    const item = blank();
    // the row's origin is kept: a row read off the invoice stays attributed to
    // the invoice even after a cell in it is corrected
    item.source = before[index]?.source ?? `entered by ${LOCAL_USER.name}`;

    for (const [key] of LINE_ITEM_FIELDS) {
      if (!(key in raw)) {
        // a field the form did not carry keeps what the row had
        (item[key as keyof LineItem] as unknown) = before[index]?.[key as keyof LineItem] ?? null;
        continue;
      }
      const text = String(raw[key] ?? "").trim();
      if (text === "") {
        (item[key as keyof LineItem] as unknown) = null;
      } else if (LINE_ITEM_NUMERIC.has(key)) {
        (item[key as keyof LineItem] as unknown) = toNumber(text);
      } else {
        (item[key as keyof LineItem] as unknown) = text;
      }
    }

    if (!empty(item)) items.push(item);
  }

  const sum = items.reduce((acc, li) => acc + (li.amount ?? 0), 0);
  const total = items.length ? Math.round(sum * 100) / 100 : null;

  const fields = fromJson<Record<string, ExtractedField>>(invoice.fields, {});
  const previousTotal = fields.lineItemsTotal?.value ?? null;

  // recomputed, and labelled as recomputed — never "entered", because nobody
  // typed it
  if (total === null) delete fields.lineItemsTotal;
  else {
    fields.lineItemsTotal = {
      key: "lineItemsTotal",
      value: total,
      raw: String(total),
      status: FieldStatus.CALCULATED,
      source: "added up from the line items",
      confidence: 1,
      note: `Sum of ${items.length} line item(s), recalculated after they were edited.`,
    };
  }

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { lineItems: toJson(items), fields: toJson(fields) },
  });

  // one audit entry for the block, plus one for the total if it moved: a row of
  // thirteen cells does not deserve thirteen history lines
  await prisma.fieldEdit.create({
    data: {
      invoiceId,
      fieldKey: "lineItems",
      oldValue: `${before.length} row(s)`,
      newValue: `${items.length} row(s)`,
      editedBy: LOCAL_USER.name,
    },
  });
  if (String(previousTotal ?? "") !== String(total ?? "")) {
    await prisma.fieldEdit.create({
      data: {
        invoiceId,
        fieldKey: "lineItemsTotal",
        oldValue: previousTotal === null ? null : String(previousTotal),
        newValue: total === null ? null : String(total),
        editedBy: LOCAL_USER.name,
      },
    });
  }

  await rebuildInvoice(invoiceId);

  const invoiceValue =
    fields.invoiceValue?.value === null || fields.invoiceValue?.value === undefined
      ? null
      : Number(fields.invoiceValue.value);

  const agrees =
    total === null || invoiceValue === null || Math.abs(total - invoiceValue) <= 0.05;

  return {
    ok: true,
    rows: items.length,
    total,
    invoiceValue,
    message: agrees
      ? `${items.length} line item(s) saved.${total === null ? "" : ` They add up to ${total.toFixed(2)}.`}`
      : `${items.length} line item(s) saved. They add up to ${total!.toFixed(2)}, ` +
        `which differs from the invoice value of ${invoiceValue!.toFixed(2)} by ` +
        `${Math.abs(total! - invoiceValue!).toFixed(2)} — worth checking before this invoice is relied on.`,
  };
}
