"use client";

/**
 * One customer's payment register — the screen that replaces the Excel sheet.
 *
 * It is laid out the way the sheet was, because that is the layout the work
 * already fits: a row per invoice, and the receipts spread across the row in
 * column groups of five — date, amount, rate, the rate difference, the forex
 * gain or loss — followed by the totals and the balance. Reading across a row
 * tells the whole story of one invoice's collection.
 *
 * What it adds over the sheet is that the derived columns are not typed. The
 * difference, the forex, the total received, the outstanding balance and the
 * status are computed from the cells to their left, so they cannot be stale and
 * cannot disagree with the invoice screen — the same functions produce both.
 * Those cells are shaded and have no input.
 *
 * **Every row always offers one more receipt column than it has receipts**, so
 * a payment that arrives today is entered where it belongs without opening
 * anything. The invoice screen has no limit at all; this grid shows as many
 * groups as the widest invoice needs plus one.
 */
import Link from "next/link";
import { Fragment, useActionState } from "react";
import { useFormStatus } from "react-dom";

import { formatMoney, formatRate, toHome } from "@/lib/money";
import type { TrackedInvoice } from "@/lib/payments/record";
import {
  saveCustomerRegisterAction,
  type RegisterSaveState,
} from "@/server/payments/registerActions";
import { Banner } from "@/components/ui";
import { StatusChip } from "./bits";

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? "Saving…" : "Save changes"}
    </button>
  );
}

/** A derived cell: shaded, right-aligned, never an input. */
function Calc({
  children,
  tone = "",
  title,
}: {
  children: React.ReactNode;
  tone?: string;
  title?: string;
}) {
  return (
    <td
      className={`whitespace-nowrap bg-[#f7f9fc] px-2 py-1 text-right tabular-nums ${tone}`}
      title={title}
    >
      {children}
    </td>
  );
}

function Cell({
  name,
  value,
  kind = "text",
  width = "w-28",
  align = "",
  label,
}: {
  name: string;
  value?: string | number | null;
  kind?: "text" | "date" | "number";
  width?: string;
  align?: string;
  label: string;
}) {
  return (
    <td className="px-1 py-1">
      <input
        name={name}
        type={kind === "date" ? "date" : "text"}
        inputMode={kind === "number" ? "decimal" : undefined}
        defaultValue={value ?? ""}
        aria-label={label}
        className={`input px-2 py-1 text-[11px] ${width} ${
          kind === "number" ? "text-right tabular-nums" : align
        }`}
      />
    </td>
  );
}

export function CustomerRegister({
  customerId,
  customerName,
  invoices,
}: {
  customerId: string;
  customerName: string;
  invoices: TrackedInvoice[];
}) {
  const [state, action] = useActionState<RegisterSaveState | null, FormData>(
    saveCustomerRegisterAction,
    null,
  );

  // as many receipt groups as the busiest invoice needs, plus one empty one to
  // enter the next payment into; capped so the grid stays usable
  const widest = invoices.reduce((n, i) => Math.max(n, i.money.receipts.length), 0);
  const slots = Math.min(Math.max(widest + 1, 3), 10);

  const totals = invoices.reduce(
    (t, i) => ({
      value: t.value + (i.customerInvoiceValue ?? 0),
      received: t.received + i.money.totalReceived,
      cn: t.cn + i.money.creditNotes,
      dn: t.dn + i.money.debitNotes,
      outstanding: t.outstanding + (i.money.calculatedOutstanding ?? 0),
      forex: t.forex + (i.money.totalForexGainLoss ?? 0),
      home: t.home + (toHome(i.customerInvoiceValue, i.exchangeRate) ?? 0),
    }),
    { value: 0, received: 0, cn: 0, dn: 0, outstanding: 0, forex: 0, home: 0 },
  );

  const currencies = new Set(invoices.map((i) => i.currency ?? "—"));
  const one = currencies.size === 1 ? [...currencies][0] : null;
  const ratesKnown = invoices.filter((i) => i.exchangeRate != null).length;

  return (
    <section className="card mb-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="card-title mb-0">Payment register</h2>
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-ink-3)]">
          {invoices.length} invoice(s) · {slots} receipt column(s)
        </div>
      </div>

      {state && <Banner tone={state.ok ? "ok" : "bad"}>{state.message}</Banner>}

      <form action={action}>
        <input type="hidden" name="customerId" value={customerId} />

        <div className="tablewrap">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-[#e7edf5] text-left text-[9px] uppercase tracking-wide text-[var(--color-ink-2)]">
                <th className="px-2 py-1" colSpan={6}>
                  Invoice
                </th>
                {Array.from({ length: slots }, (_, n) => (
                  <th
                    key={n}
                    className="border-l-2 border-[var(--color-line)] px-2 py-1 text-center"
                    colSpan={5}
                  >
                    Receipt {n + 1}
                  </th>
                ))}
                <th className="border-l-2 border-[var(--color-line)] px-2 py-1" colSpan={7}>
                  Balance
                </th>
              </tr>
              <tr className="bg-[#eef2f7] text-left text-[9px] uppercase tracking-wide text-[var(--color-ink-2)]">
                <th className="px-2 py-1">Invoice No.</th>
                <th className="px-2 py-1">Date</th>
                <th className="px-2 py-1">Terms</th>
                <th className="px-2 py-1 text-right">Value (FCY)</th>
                <th className="px-2 py-1 text-right">Inv. rate</th>
                <th className="px-2 py-1 text-right" title="Value × invoice rate">
                  Value (INR)
                </th>
                {Array.from({ length: slots }, (_, n) => (
                  <Fragment key={n}>
                    <th className="border-l-2 border-[var(--color-line)] px-2 py-1">Date</th>
                    <th className="px-2 py-1 text-right">FCY</th>
                    <th className="px-2 py-1 text-right">Rate</th>
                    <th className="px-2 py-1 text-right" title="Receipt rate − invoice rate">
                      Diff.
                    </th>
                    <th
                      className="px-2 py-1 text-right"
                      title="Difference × receipt amount, in INR"
                    >
                      Forex G/L
                    </th>
                  </Fragment>
                ))}
                <th className="border-l-2 border-[var(--color-line)] px-2 py-1 text-right">
                  Total received
                </th>
                <th className="px-2 py-1 text-right">CN</th>
                <th className="px-2 py-1 text-right">DN</th>
                <th className="px-2 py-1 text-right">Outstanding</th>
                <th className="px-2 py-1 text-right" title="Entered from the books">
                  As per books
                </th>
                <th className="px-2 py-1">Due</th>
                <th className="px-2 py-1">Status</th>
              </tr>
            </thead>

            <tbody>
              {invoices.map((i) => {
                const m = i.money;
                const cur = i.currency;
                const cn = i.notes.filter((n) => n.noteType === "CREDIT");
                const dn = i.notes.filter((n) => n.noteType === "DEBIT");
                const late = (i.overdueDays ?? 0) > 0;

                return (
                  <tr key={i.id} className="border-t border-[var(--color-line)] align-middle">
                    <td className="whitespace-nowrap px-1 py-1">
                      <input
                        name={`inv.${i.id}.invoiceNo`}
                        defaultValue={i.invoiceNo ?? ""}
                        aria-label="Invoice number"
                        className="input w-28 px-2 py-1 text-[11px] font-medium"
                      />
                      <Link
                        href={`/payment-tracking/invoice/${i.id}`}
                        className="ml-1 text-[10px] text-[var(--color-brand-2)] hover:underline"
                        title="Open the full invoice"
                      >
                        open
                      </Link>
                    </td>
                    <Cell
                      name={`inv.${i.id}.invoiceDate`}
                      value={i.invoiceDate}
                      kind="date"
                      width="w-32"
                      label="Invoice date"
                    />
                    <Cell
                      name={`inv.${i.id}.paymentTerms`}
                      value={i.paymentTerms}
                      width="w-40"
                      label="Payment terms"
                    />
                    <Cell
                      name={`inv.${i.id}.customerInvoiceValue`}
                      value={i.customerInvoiceValue}
                      kind="number"
                      label="Invoice value"
                    />
                    <Cell
                      name={`inv.${i.id}.exchangeRate`}
                      value={i.exchangeRate}
                      kind="number"
                      width="w-20"
                      label="Invoice exchange rate"
                    />
                    <Calc title="Invoice value × invoice rate">
                      {formatMoney(toHome(i.customerInvoiceValue, i.exchangeRate), "INR", {
                        symbol: false,
                      })}
                    </Calc>

                    {Array.from({ length: slots }, (_, n) => {
                      const seq = n + 1;
                      const r = m.receipts.find((x) => x.seq === seq);
                      return (
                        <Fragment key={seq}>
                          <td className="border-l-2 border-[var(--color-line)] px-1 py-1">
                            <input
                              name={`rcpt.${i.id}.${seq}.receiptDate`}
                              type="date"
                              defaultValue={r?.receiptDate ?? ""}
                              aria-label={`Receipt ${seq} date`}
                              className="input w-32 px-2 py-1 text-[11px]"
                            />
                          </td>
                          <Cell
                            name={`rcpt.${i.id}.${seq}.amountFcy`}
                            value={r?.amountFcy}
                            kind="number"
                            width="w-24"
                            label={`Receipt ${seq} amount`}
                          />
                          <Cell
                            name={`rcpt.${i.id}.${seq}.exchangeRate`}
                            value={r?.exchangeRate}
                            kind="number"
                            width="w-20"
                            label={`Receipt ${seq} exchange rate`}
                          />
                          <Calc
                            tone={
                              (r?.rateDifference ?? 0) < 0
                                ? "text-[var(--color-bad-fg)]"
                                : (r?.rateDifference ?? 0) > 0
                                  ? "text-[var(--color-ok-fg)]"
                                  : "text-[var(--color-ink-3)]"
                            }
                            title={r?.note ?? undefined}
                          >
                            {formatRate(r?.rateDifference, "")}
                          </Calc>
                          <Calc
                            tone={
                              (r?.forexGainLoss ?? 0) < 0
                                ? "text-[var(--color-bad-fg)]"
                                : (r?.forexGainLoss ?? 0) > 0
                                  ? "text-[var(--color-ok-fg)]"
                                  : "text-[var(--color-ink-3)]"
                            }
                            title={r?.note ?? undefined}
                          >
                            {formatMoney(r?.forexGainLoss, "INR", { symbol: false, blank: "" })}
                          </Calc>
                        </Fragment>
                      );
                    })}

                    <Calc tone="border-l-2 border-[var(--color-line)] font-semibold">
                      {formatMoney(m.totalReceived || null, cur, { symbol: false, blank: "" })}
                    </Calc>

                    {/* one CN cell covers the ordinary case; two or more notes
                        are edited on the invoice screen, and the cell says so */}
                    {cn.length > 1 ? (
                      <Calc title={`${cn.length} credit notes — edit them on the invoice`}>
                        <Link href={`/payment-tracking/invoice/${i.id}`} className="link">
                          {formatMoney(m.creditNotes, cur, { symbol: false })}
                        </Link>
                      </Calc>
                    ) : (
                      <Cell
                        name={`note.${i.id}.CREDIT.amount`}
                        value={cn[0]?.amount}
                        kind="number"
                        width="w-20"
                        label="Credit note"
                      />
                    )}
                    {dn.length > 1 ? (
                      <Calc title={`${dn.length} debit notes — edit them on the invoice`}>
                        <Link href={`/payment-tracking/invoice/${i.id}`} className="link">
                          {formatMoney(m.debitNotes, cur, { symbol: false })}
                        </Link>
                      </Calc>
                    ) : (
                      <Cell
                        name={`note.${i.id}.DEBIT.amount`}
                        value={dn[0]?.amount}
                        kind="number"
                        width="w-20"
                        label="Debit note"
                      />
                    )}

                    <Calc
                      tone="font-semibold"
                      title="Invoice value − receipts − CN + DN"
                    >
                      {formatMoney(m.calculatedOutstanding, cur, { symbol: false })}
                    </Calc>
                    <Cell
                      name={`inv.${i.id}.booksBalance`}
                      value={i.booksBalance}
                      kind="number"
                      width="w-24"
                      label="Balance as per books"
                    />
                    <td className="whitespace-nowrap px-2 py-1">
                      {i.schedule.dueDate ? (
                        <span className={late ? "font-semibold text-[var(--color-bad-fg)]" : ""}>
                          {i.schedule.dueDate}
                          {late && ` (+${i.overdueDays}d)`}
                        </span>
                      ) : (
                        <span className="text-[var(--color-warn-fg)]">verify</span>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      <StatusChip status={i.status} note={i.statusNote} />
                    </td>
                  </tr>
                );
              })}
            </tbody>

            <tfoot>
              <tr className="border-t-2 border-[var(--color-line)] bg-[#f2f6fb] font-semibold">
                <td className="px-2 py-2" colSpan={3}>
                  {invoices.length} invoice(s)
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {one ? formatMoney(totals.value, one, { symbol: false }) : "mixed"}
                </td>
                <td className="px-2 py-2" />
                <td className="px-2 py-2 text-right tabular-nums" title="At each invoice's own rate">
                  {ratesKnown ? formatMoney(totals.home, "INR", { symbol: false }) : "—"}
                </td>
                {Array.from({ length: slots }, (_, n) => (
                  <td key={n} className="px-2 py-2" colSpan={5} />
                ))}
                <td className="border-l-2 border-[var(--color-line)] px-2 py-2 text-right tabular-nums">
                  {one ? formatMoney(totals.received, one, { symbol: false }) : "mixed"}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {one ? formatMoney(totals.cn, one, { symbol: false }) : ""}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {one ? formatMoney(totals.dn, one, { symbol: false }) : ""}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {one ? formatMoney(totals.outstanding, one, { symbol: false }) : "mixed"}
                </td>
                <td className="px-2 py-2" colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <SaveButton />
          <span className="text-[11px] text-[var(--color-ink-3)]">
            Shaded columns are calculated and recomputed on save. The last receipt column is empty
            on every row, ready for the next payment.
            {!one && " Currencies differ, so no column is totalled."}
            {one && ratesKnown < invoices.length && (
              <>
                {" "}
                The INR total covers the {ratesKnown} invoice(s) that carry a rate.
              </>
            )}
          </span>
        </div>
      </form>

      <p className="mt-2 text-[10px] text-[var(--color-ink-3)]">
        Totals in {one ?? "mixed currencies"} · forex and INR figures in INR, from each invoice&apos;s
        own rate · {customerName}
      </p>
    </section>
  );
}
