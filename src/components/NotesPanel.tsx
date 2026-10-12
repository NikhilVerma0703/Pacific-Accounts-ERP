"use client";

/**
 * Credit and debit notes against one invoice.
 *
 * Their totals are the CN and DN columns in the register, and they move the
 * balance through the company's formula — Invoice Value − Receipts − CN + DN —
 * rather than anyone adjusting a figure by hand.
 *
 * Every field of every note is editable in place. It used to be add-or-remove
 * only, which sounds like a small thing until a note has the wrong amount: the
 * only way to fix it was to remove the note and retype it, and that threw away
 * the note number and the reason along with the mistake.
 */
import { useState } from "react";
import { useFormStatus } from "react-dom";

import { removeNoteAction, saveNoteAction } from "@/server/actions";

export interface NoteRow {
  id: string;
  noteType: "CREDIT" | "DEBIT";
  amount: number;
  noteNo: string | null;
  noteDate: string | null;
  reason: string | null;
}

function money(value: number): string {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function SaveButton({ label = "Add" }: { label?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-sm" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

/**
 * The note form, for adding one or changing one.
 *
 * The same inputs either way, because they are the same fields — and because a
 * form that offers fewer fields than it saves is how a value gets quietly
 * blanked. Passing `note` fills it in and adds the hidden id that makes the save
 * an update.
 */
function NoteForm({
  invoiceId,
  currency,
  note,
  onDone,
}: {
  invoiceId: string;
  currency: string;
  note?: NoteRow;
  onDone?: () => void;
}) {
  const key = note?.id ?? "new";
  return (
    <form
      action={saveNoteAction}
      className="grid gap-2 rounded-lg border border-[var(--color-line)] bg-[#fbfdff] p-3 sm:grid-cols-6"
    >
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {note && <input type="hidden" name="noteId" value={note.id} />}
      <div>
        <label className="field-label" htmlFor={`type-${key}`}>
          Type
        </label>
        <select
          id={`type-${key}`}
          name="noteType"
          defaultValue={note?.noteType ?? "CREDIT"}
          className="input px-2 py-1 text-xs"
        >
          <option value="CREDIT">Credit note</option>
          <option value="DEBIT">Debit note</option>
        </select>
      </div>
      <div>
        <label className="field-label" htmlFor={`no-${key}`}>
          Note no.
        </label>
        <input
          id={`no-${key}`}
          name="noteNo"
          defaultValue={note?.noteNo ?? ""}
          className="input px-2 py-1 text-xs"
        />
      </div>
      <div>
        <label className="field-label" htmlFor={`date-${key}`}>
          Date
        </label>
        <input
          id={`date-${key}`}
          name="noteDate"
          type="date"
          defaultValue={note?.noteDate ?? ""}
          className="input px-2 py-1 text-xs"
        />
      </div>
      <div>
        <label className="field-label" htmlFor={`amt-${key}`}>
          Amount {currency ? `(${currency})` : ""}
        </label>
        <input
          id={`amt-${key}`}
          name="amount"
          inputMode="decimal"
          defaultValue={note?.amount ?? ""}
          required
          className="input px-2 py-1 text-xs"
        />
      </div>
      <div>
        <label className="field-label" htmlFor={`why-${key}`}>
          Reason
        </label>
        <input
          id={`why-${key}`}
          name="reason"
          defaultValue={note?.reason ?? ""}
          className="input px-2 py-1 text-xs"
        />
      </div>
      <div className="flex items-end gap-2">
        <SaveButton label={note ? "Save" : "Add"} />
        {onDone && (
          <button type="button" onClick={onDone} className="btn-ghost btn-sm">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function NotesPanel({
  invoiceId,
  currency,
  notes,
}: {
  invoiceId: string;
  currency: string;
  notes: NoteRow[];
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const total = (type: NoteRow["noteType"]) =>
    notes.filter((n) => n.noteType === type).reduce((sum, n) => sum + n.amount, 0);

  return (
    <section className="card mb-5">
      <h2 className="card-title">Credit / Debit notes</h2>
      <p className="mb-3 max-w-[80ch] text-[13px] text-[var(--color-ink-2)]">
        CN {money(total("CREDIT"))} · DN {money(total("DEBIT"))} {currency}
      </p>

      {notes.length > 0 && (
        <div className="tablewrap mb-3">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-[#eef2f7] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Note no.</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {notes.map((n) =>
                editing === n.id ? (
                  <tr key={n.id} className="border-t border-[var(--color-line)]">
                    <td colSpan={6} className="px-1 py-2">
                      <NoteForm
                        invoiceId={invoiceId}
                        currency={currency}
                        note={n}
                        onDone={() => setEditing(null)}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={n.id} className="border-t border-[var(--color-line)]">
                    <td className="px-3 py-2">{n.noteType === "CREDIT" ? "Credit" : "Debit"}</td>
                    <td className="px-3 py-2">{n.noteNo ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2">{n.noteDate ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(n.amount)}</td>
                    <td className="px-3 py-2 text-xs text-[var(--color-ink-3)]">
                      {n.reason ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setEditing(n.id)}
                          className="btn-ghost btn-sm"
                        >
                          Edit
                        </button>
                        <form action={removeNoteAction}>
                          <input type="hidden" name="invoiceId" value={invoiceId} />
                          <input type="hidden" name="noteId" value={n.id} />
                          <button
                            type="submit"
                            className="btn-ghost btn-sm text-[var(--color-bad-fg)]"
                          >
                            Remove
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      {adding ? (
        <NoteForm invoiceId={invoiceId} currency={currency} onDone={() => setAdding(false)} />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="btn-ghost">
          + Add credit / debit note
        </button>
      )}
    </section>
  );
}
