import Link from "next/link";

import { Banner, CELL_TINT, Empty, PageHead } from "@/components/ui";
import { BY_KEY } from "@/lib/extraction/catalog";
import { formatDate } from "@/lib/extraction/text";
import { loadOverview } from "@/server/overview";

export const dynamic = "force-dynamic";

/** The columns this screen shows, in the register's own order. */
const SHOWN = [
  "piNo", "poNo", "shippingBillNo", "shippingBillDate",
  "blNo", "blDate", "containerNo", "eta",
] as const;

export default async function ShippingPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; only?: "missing" | "complete" }>;
}) {
  const search = await searchParams;
  const { rows, complete, partial } = await loadOverview(SHOWN, search);

  return (
    <>
      <PageHead
        title="Shipping & Export"
        lead="The commercial and shipping details behind every invoice, and what is still outstanding."
        actions={
          <Link href="/invoices" className="btn-ghost">
            Accounts Register
          </Link>
        }
      />

      <div className="mb-4">
        <Banner tone="info">
          <strong>{complete}</strong> invoice(s) have every shipping field, <strong>{partial}</strong>{" "}
          are still waiting on something. Nothing here is ever guessed — a blank means the shipping
          team has not given it yet. Open an invoice to fill any of it in.
        </Banner>
      </div>

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
            <label className="field-label" htmlFor="only">
              Show
            </label>
            <select id="only" name="only" defaultValue={search.only ?? ""} className="input">
              <option value="">All invoices</option>
              <option value="missing">Waiting on something</option>
              <option value="complete">Complete</option>
            </select>
          </div>
          <button type="submit" className="btn">
            Apply
          </button>
          <Link href="/shipping" className="btn-ghost">
            Reset
          </Link>
        </div>
      </form>

      {rows.length === 0 ? (
        <div className="card">
          <Empty>No invoices match.</Empty>
        </div>
      ) : (
        <div className="tablewrap">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-[#eef2f7] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">Customer</th>
                {SHOWN.map((key) => (
                  <th key={key} className="whitespace-nowrap px-3 py-2">
                    {BY_KEY[key]?.label ?? key}
                  </th>
                ))}
                <th className="px-3 py-2 text-right">Waiting</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => (
                <tr key={inv.id} className="border-t border-[var(--color-line)] hover:bg-[#f8fafc]">
                  <td className="whitespace-nowrap px-3 py-2">
                    <Link
                      href={`/invoices/${inv.id}`}
                      className="text-[var(--color-brand-2)] hover:underline"
                    >
                      {inv.invoiceNo}
                    </Link>
                    <div className="text-[11px] text-[var(--color-ink-3)]">
                      {inv.invoiceDate ? formatDate(inv.invoiceDate) : "—"}
                    </div>
                  </td>
                  <td className="px-3 py-2">{inv.customerName ?? "—"}</td>
                  {SHOWN.map((key) => {
                    const cell = inv.row[key];
                    return (
                      <td
                        key={key}
                        title={cell?.note ?? ""}
                        className={`whitespace-nowrap px-3 py-2 ${CELL_TINT[cell?.status ?? ""] ?? ""}`}
                      >
                        {cell?.display || "—"}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right tabular-nums">
                    {inv.missing.length === 0 ? (
                      <span className="chip bg-[var(--color-ok-bg)] text-[var(--color-ok-fg)]">
                        complete
                      </span>
                    ) : (
                      <span title={inv.missing.map((k) => BY_KEY[k]?.label ?? k).join(", ")}>
                        {inv.missing.length} of {SHOWN.length}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link href={`/invoices/${inv.id}`} className="btn-ghost btn-sm">
                      Fill in
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </>
  );
}
