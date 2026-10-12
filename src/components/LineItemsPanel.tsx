"use client";

/**
 * The invoice's line items, editable.
 *
 * One form over the whole block rather than one per row, because the rows are
 * stored as a single JSON array and are therefore written whole. That has a
 * pleasant consequence: adding a row is a client-side `useState` bump with no
 * round trip, and nothing is saved until Save is pressed — so a half-typed new
 * row cannot leave a stray record behind if somebody navigates away.
 *
 * Clearing a row is how a row is deleted. An entirely empty row is dropped on
 * save, so "Clear" empties the inputs and the save does the rest; there is no
 * separate delete action, and no way to lose a row by a single misplaced click.
 */
import { useState } from "react";
import { useFormStatus } from "react-dom";

import type { LineItem } from "@/lib/extraction/types";
import { LINE_ITEM_FIELDS } from "@/lib/lineItemFields";
import { saveLineItemsAction } from "@/server/actions";

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? "Saving…" : "Save line items"}
    </button>
  );
}

function cell(item: LineItem | undefined, key: string): string {
  const v = item?.[key as keyof LineItem];
  return v === null || v === undefined ? "" : String(v);
}

const WIDTH: Record<string, string> = {
  description: "min-w-[220px]",
  designColour: "min-w-[130px]",
  thickness: "w-24",
  hsn: "w-24",
  quantity: "w-24",
  unit: "w-20",
  rate: "w-24",
  amount: "w-28",
  slabsPcs: "w-20",
  netWeight: "w-24",
  netWeightUnit: "w-20",
  marksNos: "min-w-[120px]",
  packages: "min-w-[120px]",
};

export function LineItemsPanel({
  invoiceId,
  items,
  invoiceValue,
}: {
  invoiceId: string;
  items: LineItem[];
  invoiceValue: number | null;
}) {
  const [rows, setRows] = useState(Math.max(items.length, 1));
  const [cleared, setCleared] = useState<Set<number>>(new Set());

  const stored = items.reduce((sum, li) => sum + (li.amount ?? 0), 0);
  const total = items.length ? Math.round(stored * 100) / 100 : null;
  const differs =
    total !== null && invoiceValue !== null && Math.abs(total - invoiceValue) > 0.05;

  function clearRow(index: number) {
    setCleared((prev) => new Set(prev).add(index));
  }

  return (
    <section className="card mb-5">
      <h2 className="card-title">Line items</h2>
      {total !== null && (
        <p className="mb-3 text-[13px] text-[var(--color-ink-2)]">
          Line items total <strong className="tabular-nums">{total.toFixed(2)}</strong>
          {invoiceValue !== null && (
            <>
              {" · invoice value "}
              <strong className="tabular-nums">{invoiceValue.toFixed(2)}</strong>
              {differs && (
                <strong className="text-[var(--color-bad-fg)]">
                  {" · difference "}
                  {Math.abs(total - invoiceValue).toFixed(2)}
                </strong>
              )}
            </>
          )}
        </p>
      )}

      <form action={saveLineItemsAction}>
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <input type="hidden" name="rowCount" value={rows} />

        <div className="tablewrap">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-[#eef2f7] text-left text-[10px] uppercase tracking-wide text-[var(--color-ink-2)]">
                <th className="px-2 py-2">#</th>
                {LINE_ITEM_FIELDS.map(([key, label]) => (
                  <th key={key} className="px-2 py-2">
                    {label}
                  </th>
                ))}
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, i) => {
                const item = cleared.has(i) ? undefined : items[i];
                return (
                  <tr key={i} className="border-t border-[var(--color-line)]">
                    <td className="px-2 py-2 text-[var(--color-ink-3)]">{i + 1}</td>
                    {LINE_ITEM_FIELDS.map(([key, label, kind]) => (
                      <td key={key} className="px-1 py-1">
                        <input
                          name={`li.${i}.${key}`}
                          defaultValue={cell(item, key)}
                          // the key forces a fresh input when a row is cleared,
                          // so the box empties on screen rather than keeping a
                          // value the save will drop
                          key={`${i}-${key}-${cleared.has(i) ? "cleared" : "kept"}`}
                          inputMode={kind === "number" ? "decimal" : undefined}
                          className={`input px-2 py-1 text-xs ${WIDTH[key] ?? ""} ${
                            kind === "number" ? "text-right" : ""
                          }`}
                          aria-label={`Row ${i + 1} ${label}`}
                        />
                      </td>
                    ))}
                    <td className="px-2 py-1">
                      <button
                        type="button"
                        onClick={() => clearRow(i)}
                        className="btn-ghost btn-sm"
                        title="Empty this row. It is dropped when you save."
                      >
                        Clear
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <SaveButton />
          <button type="button" onClick={() => setRows((n) => n + 1)} className="btn-ghost">
            + Add a row
          </button>
          <span className="text-[11px] text-[var(--color-ink-3)]">
            An empty row is dropped on save.
          </span>
        </div>
      </form>
    </section>
  );
}
