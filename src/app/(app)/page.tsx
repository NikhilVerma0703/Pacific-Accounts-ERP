import Link from "next/link";

import { Banner, Empty, OUTCOME_TONE, PageHead, StatusChip } from "@/components/ui";
import { STATUS_LABELS, type InvoiceStatusKey } from "@/lib/business/rules";
import { HOME_CURRENCY } from "@/lib/config";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/extraction/text";
import { ageingBucket } from "@/server/reports";
import { loadReceivables } from "@/server/receivables";

export const dynamic = "force-dynamic";

function money(value: number, digits = 0): string {
  return value.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function daysPast(due: string | null, today: string): number {
  if (!due || due >= today) return 0;
  return Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000,
  );
}

export default async function DashboardPage() {
  const [{ rows, totals, today }, imports, receiptCount, noteCount] = await Promise.all([
    loadReceivables(),
    prisma.importLog.findMany({ orderBy: { createdAt: "desc" }, take: 6 }),
    prisma.receipt.count(),
    prisma.creditDebitNote.count(),
  ]);

  const currencies = Object.keys(totals).sort();

  // one pass for everything the tiles need, so nothing is counted twice
  const counts: Record<string, number> = {};
  let attentionAmount = 0;
  let attentionCount = 0;
  let overdueAmount = 0;
  let noDueDate = 0;
  let pendingBooks = 0;
  const buckets: Record<string, number> = {};

  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;

    const late = daysPast(r.dueDate, today);
    if (late > 0) {
      overdueAmount += r.balance ?? 0;
      buckets[ageingBucket(late)] = (buckets[ageingBucket(late)] ?? 0) + 1;
    }
    if (!r.dueDate) noDueDate += 1;
    if (r.invoiceValue === null) pendingBooks += 1;

    // "needs attention": overdue money, or an invoice whose figures cannot be trusted
    if (late > 0 || r.status === "MISSING_INFORMATION") {
      attentionAmount += r.balance ?? 0;
      attentionCount += 1;
    }
  }

  const grand = currencies.reduce(
    (acc, c) => {
      acc.invoiced += totals[c].invoiceValue;
      acc.received += totals[c].received;
      acc.outstanding += totals[c].outstanding;
      acc.forex += totals[c].forex;
      return acc;
    },
    { invoiced: 0, received: 0, outstanding: 0, forex: 0 },
  );
  const singleCurrency = currencies.length === 1 ? currencies[0] : null;

  const attention = rows
    .filter((r) => daysPast(r.dueDate, today) > 0 || r.status === "MISSING_INFORMATION")
    .sort((a, b) => daysPast(b.dueDate, today) - daysPast(a.dueDate, today))
    .slice(0, 8);

  const byCustomer = [...rows.reduce((map, r) => {
    const key = `${r.customerName ?? "(not named)"}|${r.currency}`;
    const at = map.get(key) ?? {
      customer: r.customerName ?? "(not named)",
      currency: r.currency,
      invoices: 0,
      outstanding: 0,
    };
    at.invoices += 1;
    at.outstanding += r.balance ?? 0;
    map.set(key, at);
    return map;
  }, new Map<string, { customer: string; currency: string; invoices: number; outstanding: number }>()).values()]
    .sort((a, b) => b.outstanding - a.outstanding)
    .slice(0, 6);

  const STATES: InvoiceStatusKey[] = [
    "PAID",
    "PARTIALLY_PAID",
    "UNPAID",
    "DUE_SOON",
    "OVERDUE",
    "MISSING_INFORMATION",
  ];

  return (
    <>
      <PageHead
        title="Dashboard"
        lead={`${rows.length} invoice(s) · ${receiptCount} receipt(s) · ${noteCount} credit / debit note(s)`}
        actions={
          <>
            <Link href="/import" className="btn-ghost">
              Import
            </Link>
            <Link href="/invoices/new" className="btn-ghost">
              Manual Entry
            </Link>
            <Link href="/invoices" className="btn">
              Accounts Register
            </Link>
          </>
        }
      />

      {rows.length === 0 ? (
        <div className="card">
          <Empty>
            Nothing in the register yet.{" "}
            <Link href="/import" className="text-[var(--color-brand-2)] hover:underline">
              Import an invoice
            </Link>{" "}
            or{" "}
            <Link href="/invoices/new" className="text-[var(--color-brand-2)] hover:underline">
              create a record by hand
            </Link>{" "}
            to begin.
          </Empty>
        </div>
      ) : (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div className="kpi">
              <div className="kpi-n">{rows.length}</div>
              <div className="kpi-l">Invoices in register</div>
            </div>
            <div className="kpi">
              <div className="kpi-n">{money(grand.invoiced)}</div>
              <div className="kpi-l">
                Invoiced {singleCurrency ? singleCurrency : "(mixed currencies)"}
              </div>
            </div>
            <div className="kpi">
              <div className="kpi-n">{money(grand.received)}</div>
              <div className="kpi-l">Received</div>
            </div>
            <div className="kpi">
              <div className="kpi-n">{money(grand.outstanding)}</div>
              <div className="kpi-l">Outstanding</div>
            </div>
            <div className="kpi">
              <div
                className={`kpi-n ${attentionAmount > 0 ? "text-[var(--color-bad-fg)]" : ""}`}
              >
                {money(attentionAmount)}
              </div>
              <div className="kpi-l">Needs attention ({attentionCount})</div>
            </div>
          </div>

          {currencies.length > 1 && (
            <div className="mb-5">
              <Banner tone="warn">
                Invoices exist in {currencies.length} currencies ({currencies.join(", ")}). The totals
                above add them together for a rough sense of scale only — use{" "}
                <Link href="/reports?report=currency" className="underline">
                  the currency summary
                </Link>{" "}
                for figures you can rely on.
              </Banner>
            </div>
          )}

          <div className="mb-5 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {STATES.map((key) => (
              <Link
                key={key}
                href={`/invoices?status=${key}`}
                className="kpi transition hover:border-[var(--color-brand-2)]"
              >
                <div className="kpi-n">{counts[key] ?? 0}</div>
                <div className="kpi-l">{STATUS_LABELS[key]}</div>
              </Link>
            ))}
          </div>

          <div className="mb-5 grid gap-4 lg:grid-cols-2">
            <section className="card">
              <h2 className="card-title">Needs attention</h2>
              {attention.length === 0 ? (
                <Empty>Nothing needs attention.</Empty>
              ) : (
                <div className="tablewrap">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="bg-[#eef2f7] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                        <th className="px-3 py-2">Invoice</th>
                        <th className="px-3 py-2">Customer</th>
                        <th className="px-3 py-2 text-right">Outstanding</th>
                        <th className="px-3 py-2 text-right">Days</th>
                        <th className="px-3 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attention.map((r) => (
                        <tr key={r.invoiceId} className="border-t border-[var(--color-line)]">
                          <td className="whitespace-nowrap px-3 py-2">
                            <Link
                              href={`/invoices/${r.invoiceId}`}
                              className="text-[var(--color-brand-2)] hover:underline"
                            >
                              {r.invoiceNo}
                            </Link>
                          </td>
                          <td className="px-3 py-2">{r.customerName ?? "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {r.balance === null ? "—" : `${money(r.balance, 2)} ${r.currency}`}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {daysPast(r.dueDate, today) || "—"}
                          </td>
                          <td className="px-3 py-2">
                            <StatusChip status={r.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-3 text-xs">
                <Link href="/reports?report=overdue" className="text-[var(--color-brand-2)] hover:underline">
                  Full overdue report
                </Link>
              </p>
            </section>

            <section className="card">
              <h2 className="card-title">Outstanding by customer</h2>
              <div className="tablewrap">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="bg-[#eef2f7] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                      <th className="px-3 py-2">Customer</th>
                      <th className="px-3 py-2">Cur</th>
                      <th className="px-3 py-2 text-right">Invoices</th>
                      <th className="px-3 py-2 text-right">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byCustomer.map((c) => (
                      <tr key={`${c.customer}-${c.currency}`} className="border-t border-[var(--color-line)]">
                        <td className="px-3 py-2">{c.customer}</td>
                        <td className="px-3 py-2">{c.currency}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.invoices}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(c.outstanding, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs">
                <Link href="/reports?report=customer" className="text-[var(--color-brand-2)] hover:underline">
                  Full customer report
                </Link>
              </p>
            </section>
          </div>

          <div className="mb-5 grid gap-4 lg:grid-cols-3">
            <section className="card">
              <h2 className="card-title">Per currency</h2>
              <div className="tablewrap">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="bg-[#eef2f7] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                      <th className="px-3 py-2">Cur</th>
                      <th className="px-3 py-2 text-right">Invoiced</th>
                      <th className="px-3 py-2 text-right">Received</th>
                      <th className="px-3 py-2 text-right">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currencies.map((c) => (
                      <tr key={c} className="border-t border-[var(--color-line)]">
                        <td className="px-3 py-2">{c}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(totals[c].invoiceValue)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(totals[c].received)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(totals[c].outstanding)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="card">
              <h2 className="card-title">Ageing &amp; gaps</h2>
              <dl className="space-y-1.5 text-[13px]">
                {["1–30 days", "31–60 days", "61–90 days", "Over 90 days"].map((b) => (
                  <div key={b} className="flex justify-between">
                    <dt className="text-[var(--color-ink-2)]">{b} overdue</dt>
                    <dd className="tabular-nums font-semibold">{buckets[b] ?? 0}</dd>
                  </div>
                ))}
                <div className="flex justify-between border-t border-[var(--color-line)] pt-1.5">
                  <dt className="text-[var(--color-ink-2)]">Overdue amount</dt>
                  <dd className="tabular-nums font-semibold">{money(overdueAmount)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--color-ink-2)]">No due date yet</dt>
                  <dd className="tabular-nums font-semibold">{noDueDate}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--color-ink-2)]">Forex gain / loss ({HOME_CURRENCY})</dt>
                  <dd
                    className={`tabular-nums font-semibold ${
                      grand.forex === 0
                        ? ""
                        : grand.forex > 0
                          ? "text-[var(--color-ok-fg)]"
                          : "text-[var(--color-bad-fg)]"
                    }`}
                  >
                    {money(grand.forex)}
                  </dd>
                </div>
              </dl>
              {noDueDate > 0 && (
                <p className="mt-3 text-xs text-[var(--color-ink-3)]">
                  {noDueDate} invoice(s) have no due date — no payment-term rule matches their
                  terms.{" "}
                  <Link href="/settings" className="text-[var(--color-brand-2)] hover:underline">
                    Add a rule
                  </Link>
                </p>
              )}
              {pendingBooks > 0 && (
                <p className="mt-2 text-xs text-[var(--color-ink-3)]">
                  {pendingBooks} invoice(s) have no readable invoice value.
                </p>
              )}
            </section>

            <section className="card">
              <h2 className="card-title">Recent activity</h2>
              {imports.length === 0 ? (
                <Empty>Nothing yet.</Empty>
              ) : (
                <ul className="space-y-2 text-[13px]">
                  {imports.map((log) => (
                    <li key={log.id} className="border-b border-[var(--color-line)] pb-2 last:border-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`chip ${OUTCOME_TONE[log.outcome] ?? ""}`}>
                          {log.outcome.toLowerCase()}
                        </span>
                        <span className="text-[11px] text-[var(--color-ink-3)]">
                          {formatDate(log.createdAt.toISOString().slice(0, 10))}
                        </span>
                      </div>
                      <div className="mt-1 break-words text-[var(--color-ink-2)]">
                        {log.invoiceId ? (
                          <Link
                            href={`/invoices/${log.invoiceId}`}
                            className="text-[var(--color-brand-2)] hover:underline"
                          >
                            {log.fileName}
                          </Link>
                        ) : (
                          log.fileName
                        )}
                      </div>
                      <div className="text-[11px] text-[var(--color-ink-3)]">{log.message}</div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}
