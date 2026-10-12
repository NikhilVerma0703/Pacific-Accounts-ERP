"use client";

/**
 * The receipts recorded against one invoice, and the "+ Add Receipt" that grows
 * the register by another five columns.
 *
 * Difference and Forex Gain/Loss are shown but never editable: they follow from
 * the receipt's rate and amount, and the same function computes them here and in
 * the register, so the two can never disagree.
 */
import { useState } from "react";
import { useFormStatus } from "react-dom";

import { receiptMaths, type ReceiptInput } from "@/lib/business/accounts";
import { removeReceiptAction, saveReceiptAction } from "@/server/actions";

function money(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-sm" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

function ReceiptForm({
  invoiceId,
  seq,
  currency,
  receipt,
  onDone,
}: {
  invoiceId: string;
  seq: number;
  currency: string;
  receipt?: ReceiptInput;
  onDone?: () => void;
}) {
  return (
    <form action={saveReceiptAction} onSubmit={onDone} className="grid gap-2 sm:grid-cols-6">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="seq" value={seq} />
      <div>
        <label className="field-label" htmlFor={`d-${seq}`}>
          Receipt {seq} Date
        </label>
        <input
          id={`d-${seq}`}
          name="receiptDate"
          type="date"
          defaultValue={receipt?.receiptDate ?? ""}
          className="input px-2 py-1 text-xs"
        />
      </div>
      <div>
        <label className="field-label" htmlFor={`a-${seq}`}>
          Receipt {seq} FCY {currency ? `(${currency})` : ""}
        </label>
        <input
          id={`a-${seq}`}
          name="amount"
          inputMode="decimal"
          required
          defaultValue={receipt?.amount ?? ""}
          placeholder="10000.00"
          className="input px-2 py-1 text-xs"
        />
      </div>
      <div>
        <label className="field-label" htmlFor={`r-${seq}`}>
          Exchange Rate {seq}
        </label>
        <input
          id={`r-${seq}`}
          name="exchangeRate"
          inputMode="decimal"
          defaultValue={receipt?.exchangeRate ?? ""}
          placeholder="94.20"
          className="input px-2 py-1 text-xs"
        />
      </div>
      <div>
        <label className="field-label" htmlFor={`b-${seq}`}>
          Bank reference
        </label>
        <input
          id={`b-${seq}`}
          name="bankRef"
          defaultValue={receipt?.bankRef ?? ""}
          className="input px-2 py-1 text-xs"
        />
      </div>
      {/*
        Remarks belongs on this form even though it is rarely typed: the receipt
        importer writes the payment advice's note here, and while the form did
        not show it, saving an edit wrote a blank over it. A field an edit form
        hides is a field an edit destroys.
      */}
      <div>
        <label className="field-label" htmlFor={`m-${seq}`}>
          Remarks
        </label>
        <input
          id={`m-${seq}`}
          name="remarks"
          defaultValue={receipt?.remarks ?? ""}
          placeholder="e.g. part of one remittance"
          className="input px-2 py-1 text-xs"
        />
      </div>
      <div className="flex items-end gap-2">
        <SaveButton label={receipt ? "Save" : "Add"} />
        {onDone && (
          <button type="button" onClick={onDone} className="btn-ghost btn-sm">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function ReceiptsPanel({
  invoiceId,
  currency,
  invoiceRate,
  receipts,
}: {
  invoiceId: string;
  currency: string;
  /** The invoice's own exchange rate — what each receipt's rate is compared with. */
  invoiceRate: number | null;
  receipts: ReceiptInput[];
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const nextSeq = receipts.reduce((max, r) => Math.max(max, r.seq), 0) + 1;

  return (
    <section id="receipts" className="card mb-5">
      <h2 className="card-title">Receipts</h2>

      {receipts.length > 0 && (
        <div className="tablewrap mb-3">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-[#eef2f7] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2 text-right">FCY</th>
                <th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2 text-right">Difference</th>
                <th className="px-3 py-2 text-right">Forex Gain/Loss</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => {
                const { difference, forex } = receiptMaths(r, invoiceRate);
                return (
                  <tr key={r.seq} className="border-t border-[var(--color-line)] align-top">
                    {editing === r.seq ? (
                      <td colSpan={8} className="px-3 py-3">
                        <ReceiptForm
                          invoiceId={invoiceId}
                          seq={r.seq}
                          currency={currency}
                          receipt={r}
                          onDone={() => setEditing(null)}
                        />
                      </td>
                    ) : (
                      <>
                        <td className="px-3 py-2">{r.seq}</td>
                        <td className="whitespace-nowrap px-3 py-2">{r.receiptDate ?? "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(r.amount)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.exchangeRate === null || r.exchangeRate === undefined
                            ? "—"
                            : money(r.exchangeRate, 4)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {difference === null ? "—" : money(difference, 4)}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${
                            forex === null ? "" : forex >= 0 ? "text-[var(--color-ok-fg)]" : "text-[var(--color-bad-fg)]"
                          }`}
                        >
                          {money(forex)}
                        </td>
                        <td className="px-3 py-2 text-xs text-[var(--color-ink-3)]">
                          {r.source ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setEditing(r.seq)}
                              className="btn-ghost btn-sm"
                            >
                              Edit
                            </button>
                            <form action={removeReceiptAction}>
                              <input type="hidden" name="invoiceId" value={invoiceId} />
                              <input type="hidden" name="seq" value={r.seq} />
                              <button
                                type="submit"
                                className="btn-ghost btn-sm text-[var(--color-bad-fg)]"
                              >
                                Remove
                              </button>
                            </form>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding ? (
        <div className="rounded-lg border border-[var(--color-line)] bg-[#fbfdff] p-3">
          <ReceiptForm
            invoiceId={invoiceId}
            seq={nextSeq}
            currency={currency}
            onDone={() => setAdding(false)}
          />
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="btn">
          + Add Receipt {nextSeq}
        </button>
      )}
    </section>
  );
}
