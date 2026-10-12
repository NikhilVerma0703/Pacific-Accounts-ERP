"use client";

/**
 * Creating a register record by hand.
 *
 * Built for the job it is actually used for: entering several records in a row
 * to exercise the register, its filters and its calculations. So it keeps what
 * was typed when something is rejected, offers "Create & add another", and can
 * fill itself with clearly-marked example values that are then edited rather
 * than a form to fill from scratch each time.
 *
 * Receipts and notes are entered here too, so one save produces a complete row —
 * every column and every formula — instead of needing a second trip.
 */
import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Banner } from "@/components/ui";
import { receiptMaths } from "@/lib/business/accounts";
import { createManualInvoiceAction, type ManualState } from "@/server/actions";

export interface FieldSpec {
  key: string;
  label: string;
  type: "text" | "date";
  placeholder: string;
}

export interface GroupSpec {
  title: string;
  hint: string;
  fields: FieldSpec[];
}

interface ReceiptDraftRow {
  id: number;
  date: string;
  amount: string;
  rate: string;
  bankRef: string;
}

interface NoteDraftRow {
  id: number;
  type: "CREDIT" | "DEBIT";
  amount: string;
  noteNo: string;
  date: string;
}

/** Obviously-fake values, so a test record can never be mistaken for a real one. */
function exampleValues(invoiceNo: string, today: string): Record<string, string> {
  return {
    invoiceNo,
    invoiceDate: today,
    currency: "USD",
    exchangeRate: "93.55",
    invoiceValue: "18348.49",
    paymentTerms: "100% Cash Against Documents (CAD)",
    customerName: "",
    consigneeName: "Test Consignee Ltd",
    notifyPartyName: "Test Notify Party Inc",
    countryOfDestination: "CANADA",
    piNo: `PI-${invoiceNo.replace(/\W+/g, "-")}`,
    poNo: `PO-${invoiceNo.replace(/\W+/g, "-")}`,
    shippingBillNo: "SB-0000001",
    shippingBillDate: today,
    blNo: "TESTBL0001",
    blDate: today,
    containerNo: "TEST1234567",
    eta: today,
  };
}

function CreateButton({ label, name }: { label: string; name?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name={name} value={name ? "1" : undefined} className="btn" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

export function ManualInvoiceForm({
  groups,
  suggestedInvoiceNo,
  today,
}: {
  groups: GroupSpec[];
  /** The next free DUMMY/nnn, for the example-values button. */
  suggestedInvoiceNo: string;
  today: string;
}) {
  const [state, action] = useActionState<ManualState, FormData>(createManualInvoiceAction, {
    status: "idle",
  });

  // `key` remounts the inputs, which is how the form clears itself after
  // "Create & add another" without losing anything on a rejection
  const [formKey, setFormKey] = useState(0);
  const [prefill, setPrefill] = useState<Record<string, string>>({});
  const [receipts, setReceipts] = useState<ReceiptDraftRow[]>([]);
  const [notes, setNotes] = useState<NoteDraftRow[]>([]);
  const [nextId, setNextId] = useState(1);

  const created = state.status === "created" ? state : null;
  const invoiceNoForExample = created?.nextInvoiceNo ?? suggestedInvoiceNo;

  function reset() {
    setPrefill({});
    setReceipts([]);
    setNotes([]);
    setFormKey((k) => k + 1);
  }

  function fillExample() {
    setPrefill(exampleValues(invoiceNoForExample, today));
    setReceipts([
      { id: nextId, date: today, amount: "10000", rate: "94.20", bankRef: "UTR-TEST-1" },
    ]);
    setNextId((n) => n + 1);
    setFormKey((k) => k + 1);
  }

  const invoiceRate = Number(prefill.exchangeRate ?? "");

  return (
    <>
      {state.status === "error" && (
        <div className="mb-4">
          <Banner tone="bad">{state.message}</Banner>
        </div>
      )}

      {created && (
        <div className="mb-4">
          <Banner tone="ok">
            <strong>{created.invoiceNo}</strong> created with the full register row
            {created.receipts ? `, ${created.receipts} receipt(s)` : ""}
            {created.notes ? ` and ${created.notes} note(s)` : ""}.{" "}
            <Link href={`/invoices/${created.invoiceId}`} className="underline">
              Open it
            </Link>{" "}
            or{" "}
            <Link href="/invoices" className="underline">
              see it in the register
            </Link>
            .
          </Banner>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={fillExample} className="btn-ghost">
          Fill with example values
        </button>
        <button type="button" onClick={reset} className="btn-ghost">
          Clear the form
        </button>
        <span className="text-xs text-[var(--color-ink-3)]">
          Example values are deliberately obvious — {invoiceNoForExample}, Test Consignee Ltd — so a
          practice record is never mistaken for a real invoice. Edit anything before saving.
        </span>
      </div>

      <form key={formKey} action={action}>
        {groups.map((group) => (
          <section key={group.title} className="card mb-4">
            <h2 className="card-title">{group.title}</h2>
            <p className="mb-3 text-[13px] text-[var(--color-ink-3)]">{group.hint}</p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {group.fields.map((f) => (
                <div key={f.key}>
                  <label className="field-label" htmlFor={f.key}>
                    {f.label}
                    {f.key === "invoiceNo" && " *"}
                  </label>
                  <input
                    id={f.key}
                    name={f.key}
                    type={f.type}
                    required={f.key === "invoiceNo"}
                    defaultValue={prefill[f.key] ?? ""}
                    placeholder={f.placeholder}
                    className="input"
                  />
                </div>
              ))}
            </div>
          </section>
        ))}

        <section className="card mb-4">
          <h2 className="card-title">Receipts (optional)</h2>

          {receipts.map((r, index) => {
            const preview = receiptMaths(
              { amount: Number(r.amount) || 0, exchangeRate: Number(r.rate) || null },
              Number.isFinite(invoiceRate) && invoiceRate > 0 ? invoiceRate : null,
            );
            return (
              <div key={r.id} className="mb-2 grid gap-2 sm:grid-cols-6">
                <div>
                  <label className="field-label">Receipt {index + 1} date</label>
                  <input
                    name="receiptDate"
                    type="date"
                    defaultValue={r.date}
                    className="input px-2 py-1 text-xs"
                  />
                </div>
                <div>
                  <label className="field-label">FCY amount</label>
                  <input
                    name="receiptAmount"
                    inputMode="decimal"
                    defaultValue={r.amount}
                    placeholder="10000"
                    className="input px-2 py-1 text-xs"
                  />
                </div>
                <div>
                  <label className="field-label">Exchange rate</label>
                  <input
                    name="receiptRate"
                    inputMode="decimal"
                    defaultValue={r.rate}
                    placeholder="94.20"
                    className="input px-2 py-1 text-xs"
                  />
                </div>
                <div>
                  <label className="field-label">Bank reference</label>
                  <input
                    name="receiptBankRef"
                    defaultValue={r.bankRef}
                    className="input px-2 py-1 text-xs"
                  />
                </div>
                <div className="text-xs">
                  <span className="field-label">Will calculate</span>
                  <span className="tabular-nums text-[var(--color-ink-2)]">
                    {preview.difference === null
                      ? "needs both rates"
                      : `diff ${preview.difference} · forex ${preview.forex}`}
                  </span>
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => setReceipts((rows) => rows.filter((x) => x.id !== r.id))}
                    className="btn-ghost btn-sm text-[var(--color-bad-fg)]"
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => {
              setReceipts((rows) => [
                ...rows,
                { id: nextId, date: "", amount: "", rate: "", bankRef: "" },
              ]);
              setNextId((n) => n + 1);
            }}
            className="btn-ghost btn-sm"
          >
            + Add receipt {receipts.length + 1}
          </button>
        </section>

        <section className="card mb-4">
          <h2 className="card-title">Credit / debit notes (optional)</h2>

          {notes.map((n) => (
            <div key={n.id} className="mb-2 grid gap-2 sm:grid-cols-5">
              <div>
                <label className="field-label">Type</label>
                <select name="noteType" defaultValue={n.type} className="input px-2 py-1 text-xs">
                  <option value="CREDIT">Credit note</option>
                  <option value="DEBIT">Debit note</option>
                </select>
              </div>
              <div>
                <label className="field-label">Amount</label>
                <input
                  name="noteAmount"
                  inputMode="decimal"
                  defaultValue={n.amount}
                  className="input px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="field-label">Note no.</label>
                <input name="noteNo" defaultValue={n.noteNo} className="input px-2 py-1 text-xs" />
              </div>
              <div>
                <label className="field-label">Date</label>
                <input
                  name="noteDate"
                  type="date"
                  defaultValue={n.date}
                  className="input px-2 py-1 text-xs"
                />
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => setNotes((rows) => rows.filter((x) => x.id !== n.id))}
                  className="btn-ghost btn-sm text-[var(--color-bad-fg)]"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={() => {
              setNotes((rows) => [
                ...rows,
                { id: nextId, type: "CREDIT", amount: "", noteNo: "", date: "" },
              ]);
              setNextId((n) => n + 1);
            }}
            className="btn-ghost btn-sm"
          >
            + Add credit / debit note
          </button>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <CreateButton label="Create record" />
          <CreateButton label="Create & add another" name="again" />
          <Link href="/invoices" className="btn-ghost">
            Done
          </Link>
        </div>
      </form>
    </>
  );
}
