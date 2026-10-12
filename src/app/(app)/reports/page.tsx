import Link from "next/link";

import { Banner, Empty, PageHead } from "@/components/ui";
import { STATUS_LABELS, type InvoiceStatusKey } from "@/lib/business/rules";
import { formatDate } from "@/lib/extraction/text";
import { buildReport, DEFAULT_REPORT, isReportKey, REPORTS, type ReportFilters } from "@/server/reports";

export const dynamic = "force-dynamic";

function show(value: string | number | null, kind: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (kind === "date") return formatDate(String(value));
  if (kind === "money") {
    const n = Number(value);
    return Number.isFinite(n)
      ? n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : String(value);
  }
  if (kind === "num") {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return n % 1 === 0 ? n.toLocaleString("en-IN") : n.toLocaleString("en-IN", { maximumFractionDigits: 4 });
  }
  return String(value);
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<ReportFilters>;
}) {
  const search = await searchParams;

  const { report, customers, currencies, statuses } = await buildReport(search);

  const active = isReportKey(search.report) ? search.report : DEFAULT_REPORT;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) if (v) qs.set(k, String(v));
  qs.set("report", active);
  const exportQs = qs.toString();

  const filtered = Object.entries(search).filter(
    ([k, v]) => v && k !== "report",
  ) as Array<[string, string]>;

  return (
    <>
      <PageHead
        title="Reports & MIS"
        lead="Seven views over the same figures. What is on screen is what exports."
        actions={
          <>
            <Link href={`/api/export/report?${exportQs}&format=csv`} className="btn-ghost">
              Export CSV
            </Link>
            <Link href={`/api/export/report?${exportQs}`} className="btn">
              Export Excel
            </Link>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {REPORTS.map((r) => {
          const params = new URLSearchParams(exportQs);
          params.set("report", r.key);
          return (
            <Link
              key={r.key}
              href={`/reports?${params.toString()}`}
              className={r.key === active ? "btn" : "btn-ghost"}
              title={r.blurb}
            >
              {r.label}
            </Link>
          );
        })}
      </div>

      <form className="card mb-4" method="get">
        <input type="hidden" name="report" value={active} />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div>
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
            <label className="field-label" htmlFor="from">
              Invoice date from
            </label>
            <input id="from" name="from" type="date" defaultValue={search.from ?? ""} className="input" />
          </div>
          <div>
            <label className="field-label" htmlFor="to">
              Invoice date to
            </label>
            <input id="to" name="to" type="date" defaultValue={search.to ?? ""} className="input" />
          </div>
          <div>
            <label className="field-label" htmlFor="customer">
              Customer
            </label>
            <select id="customer" name="customer" defaultValue={search.customer ?? ""} className="input">
              <option value="">All</option>
              {customers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="currency">
              Currency
            </label>
            <select id="currency" name="currency" defaultValue={search.currency ?? ""} className="input">
              <option value="">All</option>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="status">
              Status
            </label>
            <select id="status" name="status" defaultValue={search.status ?? ""} className="input">
              <option value="">All</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s as InvoiceStatusKey] ?? s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="paid">
              Payment state
            </label>
            <select id="paid" name="paid" defaultValue={search.paid ?? ""} className="input">
              <option value="">All</option>
              <option value="paid">Paid</option>
              <option value="partial">Partly paid</option>
              <option value="unpaid">Unpaid</option>
            </select>
          </div>
          <div className="flex items-end gap-3">
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" name="overdue" value="1" defaultChecked={search.overdue === "1"} />
              Overdue only
            </label>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button type="submit" className="btn">
            Apply
          </button>
          <Link href={`/reports?report=${active}`} className="btn-ghost">
            Clear filters
          </Link>
          {filtered.length > 0 && (
            <span className="text-xs text-[var(--color-ink-3)]">
              {filtered.length} filter(s) applied — the export uses them too.
            </span>
          )}
        </div>
      </form>

      <div className="mb-4">
        <Banner tone="info">
          <strong>{report.label}.</strong> {report.note}
        </Banner>
      </div>

      {report.rows.length === 0 ? (
        <div className="card">
          <Empty>
            Nothing to show with these filters.{" "}
            <Link href={`/reports?report=${active}`} className="text-[var(--color-brand-2)] hover:underline">
              Clear them
            </Link>
            .
          </Empty>
        </div>
      ) : (
        <div className="tablewrap">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-[#eef2f7] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                {report.columns.map((c) => (
                  <th
                    key={c.key}
                    className={`whitespace-nowrap px-3 py-2 ${
                      c.kind === "num" || c.kind === "money" ? "text-right" : ""
                    }`}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row, i) => (
                <tr key={i} className="border-t border-[var(--color-line)] hover:bg-[#f8fafc]">
                  {report.columns.map((c) => (
                    <td
                      key={c.key}
                      className={`whitespace-nowrap px-3 py-2 ${
                        c.kind === "num" || c.kind === "money" ? "text-right tabular-nums" : ""
                      }`}
                    >
                      {show(row[c.key], c.kind)}
                    </td>
                  ))}
                </tr>
              ))}
              {report.totals && (
                <tr className="border-t-2 border-[var(--color-line)] bg-[var(--color-info-bg)] font-semibold">
                  {report.columns.map((c) => (
                    <td
                      key={c.key}
                      className={`whitespace-nowrap px-3 py-2 ${
                        c.kind === "num" || c.kind === "money" ? "text-right tabular-nums" : ""
                      }`}
                    >
                      {report.totals?.[c.key] === undefined ? "" : show(report.totals[c.key], c.kind)}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-[var(--color-ink-3)]">{report.rows.length} row(s)</p>
    </>
  );
}
