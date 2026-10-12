/**
 * The Payment Tracking dashboard.
 *
 * Five KPIs, per currency and never across it, because adding a USD balance to
 * a EUR one produces the only kind of number a receivables figure must not be.
 *
 * One of the five is unusual and deliberate. **Overdue prints its own
 * denominator.** It can only be computed for invoices whose due date could
 * actually be established, and in the reference data more than a quarter of the
 * book has no payment terms and no due date at all. A percentage with a hidden
 * denominator is how a correct number produces a wrong decision, so the tile
 * says how much of the book it covers and how much it cannot speak for.
 */
import Link from "next/link";

import { STATUS_LABELS, STATUS_TONE, type TrackingStatus } from "@/lib/payments/record";
import type { CustomerSummary, TrackingKpis } from "@/server/payments/query";
import { HOME_CURRENCY } from "@/lib/money";
import { homeMoney, money, Tile, TONE_CLASS, day } from "./bits";

export function Dashboard({
  kpis,
  customers,
  today,
}: {
  kpis: TrackingKpis[];
  customers: CustomerSummary[];
  today: string;
}) {
  if (!kpis.length) return null;

  // The one figure that can legitimately be added across currencies: each
  // invoice converted at its own exchange rate. It is shown only when more
  // than one currency is in play — with a single currency the tiles above
  // already say it — and it always carries how many invoices it covers,
  // because an INR total built from 13 of 41 rates is not the book.
  const home = kpis.reduce(
    (t, k) => ({
      invoiced: t.invoiced + k.homeInvoiceValue,
      received: t.received + k.homeReceived,
      outstanding: t.outstanding + k.homeOutstanding,
      known: t.known + k.homeRatesKnown,
      invoices: t.invoices + k.invoices,
    }),
    { invoiced: 0, received: 0, outstanding: 0, known: 0, invoices: 0 },
  );

  return (
    <div className="mb-5 space-y-6">
      {kpis.length > 1 && home.known > 0 && (
        <section className="rounded-xl border border-[#c6dcf3] bg-[var(--color-info-bg)] p-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[13px] font-semibold">
              All currencies, in {HOME_CURRENCY}
              <span className="ml-2 font-normal text-[var(--color-ink-3)]">
                each invoice at its own rate · {home.known} of {home.invoices} invoice(s) carry one
              </span>
            </h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Tile label={`Invoiced (${HOME_CURRENCY})`} value={homeMoney(home.invoiced)} />
            <Tile label={`Received (${HOME_CURRENCY})`} value={homeMoney(home.received)} tone="ok" />
            <Tile
              label={`Outstanding (${HOME_CURRENCY})`}
              value={homeMoney(home.outstanding)}
              tone="info"
            />
          </div>
        </section>
      )}

      {kpis.map((k) => {
        const coverage =
          k.totalOutstanding > 0.01
            ? Math.round((k.assessable / k.totalOutstanding) * 100)
            : 100;

        return (
          <section key={k.currency}>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[13px] font-semibold">
                {k.currency}
                <span className="ml-2 font-normal text-[var(--color-ink-3)]">
                  {k.invoices} invoice(s) · {k.customers} customer(s) · as at {today}
                </span>
              </h2>
              {k.forexGainLoss !== null && (
                <span className="text-[11px] text-[var(--color-ink-3)]">
                  forex{" "}
                  <strong
                    className={
                      k.forexGainLoss >= 0
                        ? "text-[var(--color-ok-fg)]"
                        : "text-[var(--color-bad-fg)]"
                    }
                  >
                    {k.forexGainLoss >= 0 ? "gain" : "loss"} {homeMoney(Math.abs(k.forexGainLoss))}
                  </strong>
                </span>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <Tile
                label="Total invoice value"
                value={money(k.totalInvoiceValue, k.currency)}
                tone="plain"
              />
              <Tile
                label="Total received"
                value={money(k.totalReceived, k.currency)}
                sub={`${k.collectionRate}% collected`}
                tone={k.collectionRate >= 75 ? "ok" : k.collectionRate >= 40 ? "warn" : "bad"}
              />
              <Tile label="Total outstanding" value={money(k.totalOutstanding, k.currency)} tone="info" />
              <Tile
                label="Overdue outstanding"
                value={money(k.overdueOutstanding, k.currency)}
                sub={
                  <>
                    {k.overdueInvoices} invoice(s) · {money(k.assessable, k.currency)} assessable ({coverage}%)
                    {k.requiresVerification > 0.01 && (
                      <>
                        {" · "}
                        <strong className="text-[var(--color-warn-fg)]">
                          {money(k.requiresVerification, k.currency)}
                        </strong>{" "}
                        no due date
                      </>
                    )}
                  </>
                }
                tone={k.overdueOutstanding > 0.01 ? "bad" : "plain"}
              />
              <Tile
                label="Needs attention"
                value={String(k.needsAttention)}
                sub={`${money(k.needsAttentionAmount, k.currency)} outstanding`}
                tone={k.needsAttention ? "warn" : "ok"}
              />
            </div>

            {k.homeRatesKnown > 0 && (
              <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-lg border border-[var(--color-line)] bg-[#fbfdff] px-3 py-2 text-[11px]">
                <span className="font-semibold text-[var(--color-ink-2)]">In {HOME_CURRENCY}</span>
                <span>
                  invoiced{" "}
                  <strong className="tabular-nums">{homeMoney(k.homeInvoiceValue)}</strong>
                </span>
                <span>
                  received <strong className="tabular-nums">{homeMoney(k.homeReceived)}</strong>
                </span>
                <span>
                  outstanding{" "}
                  <strong className="tabular-nums">{homeMoney(k.homeOutstanding)}</strong>
                </span>
                <span className="text-[var(--color-ink-3)]">
                  at each invoice&apos;s own rate · {k.homeRatesKnown} of {k.invoices} invoice(s)
                  carry one
                </span>
              </div>
            )}

            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-[var(--color-ink-3)]">
              {k.dueSoon > 0 && (
                <span>
                  {k.dueSoon} due soon ({money(k.dueSoonAmount, k.currency)})
                </span>
              )}
              {k.nilReceived > 0 && (
                <span>
                  {k.nilReceived} with nothing received ({money(k.nilReceivedAmount, k.currency)})
                </span>
              )}
              {Object.entries(k.ageing)
                .filter(([, v]) => v > 0.01)
                .map(([label, v]) => (
                  <span key={label}>
                    {label}: {money(v, k.currency)}
                  </span>
                ))}
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              {(Object.entries(k.statuses) as Array<[TrackingStatus, number]>)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => (
                  <Link
                    key={status}
                    href={`/payment-tracking?status=${status}`}
                    className={`chip ${TONE_CLASS[STATUS_TONE[status]]} hover:opacity-80`}
                  >
                    {STATUS_LABELS[status]} {count}
                  </Link>
                ))}
            </div>
          </section>
        );
      })}

      {customers.length > 0 && (
        <section className="card">
          <h2 className="card-title">Customer-wise summary</h2>
          <div className="tablewrap">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-[#eef2f7] text-left text-[10px] uppercase tracking-wide text-[var(--color-ink-2)]">
                  <th className="px-2 py-2">Customer</th>
                  <th className="px-2 py-2">Currency</th>
                  <th className="px-2 py-2 text-right">Invoices</th>
                  <th className="px-2 py-2 text-right">Invoiced</th>
                  <th className="px-2 py-2 text-right">Received</th>
                  <th className="px-2 py-2 text-right">Collected</th>
                  <th className="px-2 py-2 text-right">Outstanding</th>
                  <th className="px-2 py-2 text-right">Overdue</th>
                  <th className="px-2 py-2">Oldest due</th>
                  <th className="px-2 py-2" title="Invoices with a due date that could be established">
                    Due dates
                  </th>
                  <th className="px-2 py-2 text-right">Attention</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={`${c.id ?? "none"}-${c.currency}`} className="border-t border-[var(--color-line)]">
                    <td className="px-2 py-2 font-medium">
                      {c.id ? (
                        <Link href={`/payment-tracking/customer/${c.id}`} className="link">
                          {c.name}
                        </Link>
                      ) : (
                        <span className="text-[var(--color-ink-3)]">{c.name}</span>
                      )}
                    </td>
                    <td className="px-2 py-2">{c.currency}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{c.invoices}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(c.invoiceValue, c.currency)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(c.received, c.currency)}</td>
                    <td
                      className={`px-2 py-2 text-right tabular-nums ${c.collectedPct === 0 ? "font-semibold text-[var(--color-bad-fg)]" : ""}`}
                    >
                      {c.collectedPct}%
                    </td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums">
                      {money(c.outstanding, c.currency)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-[var(--color-bad-fg)]">
                      {c.overdue > 0.01 ? money(c.overdue, c.currency) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">{day(c.oldestDue)}</td>
                    <td
                      className={`whitespace-nowrap px-2 py-2 ${c.dueDatesKnown < c.invoices ? "text-[var(--color-warn-fg)]" : "text-[var(--color-ink-3)]"}`}
                    >
                      {c.dueDatesKnown} of {c.invoices}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {c.needsAttention || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
