import Link from "next/link";

import { Empty, PageHead, StatusChip } from "@/components/ui";
import { STATUS_LABELS, type InvoiceStatusKey } from "@/lib/business/rules";
import { formatDate } from "@/lib/extraction/text";
import { loadReceivables } from "@/server/receivables";

export const dynamic = "force-dynamic";

function money(value: number | null, digits = 2): string {
  if (value === null) return "—";
  return value.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; currency?: string }>;
}) {
  const search = await searchParams;
  const { rows, totals } = await loadReceivables(search);
  const currencies = Object.keys(totals).sort();

  return (
    <>
      <PageHead
        title="Payments & Receipts"
        lead="Every receipt recorded against every invoice, with what is still outstanding."
        actions={
          <>
            <Link href="/receipts/import" className="btn">
              Import receipts
            </Link>
            <Link href="/invoices" className="btn-ghost">
              Accounts Register
            </Link>
          </>
        }
      />

      {currencies.length === 0 ? (
        <div className="card">
          <Empty>
            No invoices yet.{" "}
            <Link href="/import" className="text-[var(--color-brand-2)] hover:underline">
              Import one
            </Link>{" "}
            or{" "}
            <Link href="/invoices/new" className="text-[var(--color-brand-2)] hover:underline">
              enter one by hand
            </Link>{" "}
            to start recording receipts.
          </Empty>
        </div>
      ) : (
        <>
          {currencies.map((currency) => {
            const t = totals[currency];
            return (
              <section key={currency} className="card mb-4">
                <h2 className="card-title">{currency} position</h2>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                  <div className="kpi">
                    <div className="kpi-n">{money(t.invoiceValue, 0)}</div>
                    <div className="kpi-l">Invoiced ({t.invoices})</div>
                  </div>
                  <div className="kpi">
                    <div className="kpi-n">{money(t.received, 0)}</div>
                    <div className="kpi-l">Received ({t.receipts} receipts)</div>
                  </div>
                  <div className="kpi">
                    <div className="kpi-n">{money(t.creditNotes, 0)}</div>
                    <div className="kpi-l">Credit notes</div>
                  </div>
                  <div className="kpi">
                    <div className="kpi-n">{money(t.debitNotes, 0)}</div>
                    <div className="kpi-l">Debit notes</div>
                  </div>
                  <div className="kpi">
                    <div className="kpi-n">{money(t.outstanding, 0)}</div>
                    <div className="kpi-l">Outstanding</div>
                  </div>
                  <div className="kpi">
                    <div
                      className={`kpi-n ${
                        t.forex === 0
                          ? ""
                          : t.forex > 0
                            ? "text-[var(--color-ok-fg)]"
                            : "text-[var(--color-bad-fg)]"
                      }`}
                    >
                      {money(t.forex, 0)}
                    </div>
                    <div className="kpi-l">Forex gain / loss (INR)</div>
                  </div>
                </div>
                <p className="mt-3 text-xs text-[var(--color-ink-3)]">
                  {t.invoices} invoice(s) · {t.unpaid} with no receipt · {t.overdue} overdue
                </p>
              </section>
            );
          })}

          <form className="card mb-5" method="get">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[220px] flex-1">
                <label className="field-label" htmlFor="q">
                  Search
                </label>
                <input
                  id="q"
                  name="q"
                  type="search"
                  defaultValue={search.q ?? ""}
                  placeholder="Invoice no. or customer…"
                  className="input"
                />
              </div>
              <div>
                <label className="field-label" htmlFor="status">
                  Status
                </label>
                <select id="status" name="status" defaultValue={search.status ?? ""} className="input">
                  <option value="">All</option>
                  {(Object.keys(STATUS_LABELS) as InvoiceStatusKey[]).map((key) => (
                    <option key={key} value={key}>
                      {STATUS_LABELS[key]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="currency">
                  Currency
                </label>
                <select
                  id="currency"
                  name="currency"
                  defaultValue={search.currency ?? ""}
                  className="input"
                >
                  <option value="">All</option>
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className="btn">
                Apply
              </button>
              <Link href="/receipts" className="btn-ghost">
                Reset
              </Link>
            </div>
          </form>

          <div className="tablewrap">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[#eef2f7] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                  <th className="px-3 py-2">Invoice</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Cur</th>
                  <th className="px-3 py-2 text-right">Invoice value</th>
                  <th className="px-3 py-2 text-right">Rate</th>
                  <th className="px-3 py-2">Receipts</th>
                  <th className="px-3 py-2 text-right">Received</th>
                  <th className="px-3 py-2 text-right">CN</th>
                  <th className="px-3 py-2 text-right">DN</th>
                  <th className="px-3 py-2 text-right">Balance</th>
                  <th className="px-3 py-2 text-right">Forex</th>
                  <th className="px-3 py-2">Due</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.invoiceId} className="border-t border-[var(--color-line)] align-top">
                    <td className="whitespace-nowrap px-3 py-2">
                      <Link
                        href={`/invoices/${r.invoiceId}`}
                        className="text-[var(--color-brand-2)] hover:underline"
                      >
                        {r.invoiceNo}
                      </Link>
                      <div className="text-[11px] text-[var(--color-ink-3)]">
                        {r.invoiceDate ? formatDate(r.invoiceDate) : "—"}
                      </div>
                    </td>
                    <td className="px-3 py-2">{r.customerName ?? "—"}</td>
                    <td className="px-3 py-2">{r.currency}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.invoiceValue)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.invoiceRate === null ? "—" : money(r.invoiceRate, 4)}
                    </td>
                    <td className="px-3 py-2">
                      {r.receipts.length === 0 ? (
                        <span className="text-[var(--color-ink-3)]">none yet</span>
                      ) : (
                        <ul className="space-y-0.5 text-[11px]">
                          {r.receipts.map((rc) => (
                            <li key={rc.seq} className="whitespace-nowrap tabular-nums">
                              #{rc.seq} {rc.receiptDate ? formatDate(rc.receiptDate) : "no date"} ·{" "}
                              {money(rc.amount)}
                              {rc.exchangeRate === null ? " · no rate" : ` @ ${rc.exchangeRate}`}
                              {rc.difference === null ? (
                                ""
                              ) : (
                                <span
                                  className={
                                    (rc.forex ?? 0) >= 0
                                      ? "text-[var(--color-ok-fg)]"
                                      : "text-[var(--color-bad-fg)]"
                                  }
                                >
                                  {" "}
                                  · diff {rc.difference} · {money(rc.forex)}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.received)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.creditNotes ? money(r.creditNotes) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.debitNotes ? money(r.debitNotes) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {money(r.balance)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        r.forexTotal === 0
                          ? ""
                          : r.forexTotal > 0
                            ? "text-[var(--color-ok-fg)]"
                            : "text-[var(--color-bad-fg)]"
                      }`}
                    >
                      {r.forexTotal === 0 ? "—" : money(r.forexTotal)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {r.dueDate ? formatDate(r.dueDate) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <StatusChip status={r.status} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link href={`/invoices/${r.invoiceId}#receipts`} className="btn-ghost btn-sm">
                        + Receipt
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rows.length === 0 && (
            <div className="card">
              <Empty>No invoices match those filters.</Empty>
            </div>
          )}
        </>
      )}
    </>
  );
}
