/**
 * Customer Payment Tracking — the main screen.
 *
 * A self-contained system: its data is its own, its calculations are its own,
 * and it needs no commercial invoice, no Tally and no Accounts Register entry
 * to work. Two ways in — upload a customer sheet, or type a record — and
 * everything else on this page is derived from what those two produced.
 */
import Link from "next/link";

import { Dashboard } from "@/components/tracking/Dashboard";
import { Filters } from "@/components/tracking/Filters";
import { MasterTable } from "@/components/tracking/MasterTable";
import { Banner, Empty, PageHead } from "@/components/ui";
import { day } from "@/components/tracking/bits";
import {
  filterInvoices,
  groupInvoices,
  isGrouping,
  loadTracking,
  type TrackingFilters,
} from "@/server/payments/query";

export const dynamic = "force-dynamic";

export default async function PaymentTrackingPage({
  searchParams,
}: {
  searchParams: Promise<TrackingFilters>;
}) {
  const filters = await searchParams;
  const { invoices, customers, kpis, params, today, options, counts, imports } =
    await loadTracking();

  const grouping = isGrouping(filters.group) ? filters.group : "customer";
  const visible = filterInvoices(invoices, filters);
  const groups = groupInvoices(visible, grouping);

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, String(v));
  const query = qs.toString();

  const active = Object.entries(filters).filter(
    ([k, v]) => v && k !== "sort" && k !== "dir" && k !== "group",
  ) as Array<[string, string]>;

  return (
    <>
      <PageHead
        title="Customer Payment Tracking"
        lead="Customer-wise and invoice-wise payment tracking."
        actions={
          <>
            <Link href="/payment-tracking/import" className="btn-ghost">
              Upload sheet
            </Link>
            <Link href="/payment-tracking/new" className="btn-ghost">
              New record
            </Link>
            <Link href={`/api/payment-tracking/export?${query}&format=csv`} className="btn-ghost">
              Export CSV
            </Link>
            <Link href={`/api/payment-tracking/export?${query}`} className="btn">
              Export Excel
            </Link>
          </>
        }
      />

      {counts.total === 0 ? (
        <>
          <Banner tone="info">
            No records yet.{" "}
            <Link href="/payment-tracking/import" className="link">
              Upload a customer outstanding sheet
            </Link>{" "}
            or{" "}
            <Link href="/payment-tracking/new" className="link">
              enter a record by hand
            </Link>
            .
          </Banner>
        </>
      ) : (
        <>
          <Dashboard kpis={kpis} customers={customers} today={today} />

          {counts.withoutDueDate > 0 && (
            <Banner tone="warn">
              <strong>{counts.withoutDueDate}</strong> of {counts.total} invoice(s) have no due date
              and are shown as <em>Requires verification</em>. Add the payment terms and the BL date
              to date them.
            </Banner>
          )}

          <Filters
            filters={filters}
            options={options}
            buckets={params.ageingBuckets}
            active={active}
          />

          <p className="mb-3 text-[11px] text-[var(--color-ink-3)]">
            Showing {visible.length} of {counts.total} invoice(s) · {counts.customers} customer(s) ·{" "}
            {counts.receipts} receipt(s) · {counts.fromExcel} imported, {counts.manual} entered
          </p>

          {groups.length === 0 ? (
            <section className="card">
              <Empty>No invoices match these filters.</Empty>
            </section>
          ) : (
            <MasterTable
              groups={groups}
              query={query}
              sort={filters.sort}
              dir={filters.dir}
              showHeadings={grouping !== "none"}
            />
          )}

          {imports.length > 0 && (
            <section className="card mt-5">
              <h2 className="card-title">Sheets uploaded</h2>
              <div className="tablewrap">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="bg-[#eef2f7] text-left text-[10px] uppercase tracking-wide text-[var(--color-ink-2)]">
                      <th className="px-3 py-2">Customer</th>
                      <th className="px-3 py-2">File</th>
                      <th className="px-3 py-2">As on</th>
                      <th className="px-3 py-2">Date source</th>
                      <th className="px-3 py-2 text-right">Rows</th>
                      <th className="px-3 py-2 text-right">Added</th>
                      <th className="px-3 py-2 text-right">Updated</th>
                      <th className="px-3 py-2">Uploaded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {imports.map((i) => (
                      <tr key={i.id} className="border-t border-[var(--color-line)]">
                        <td className="px-3 py-2">{i.customerName ?? "—"}</td>
                        <td className="px-3 py-2">{i.fileName}</td>
                        <td className="whitespace-nowrap px-3 py-2">{day(i.asOn)}</td>
                        <td className="px-3 py-2 text-[var(--color-ink-3)]">
                          {i.asOnSource}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.rowsRead}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.created}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.updated}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {i.createdAt.toISOString().slice(0, 10)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

        </>
      )}
    </>
  );
}
