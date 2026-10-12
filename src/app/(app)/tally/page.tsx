import Link from "next/link";

import { Banner, CELL_TINT, Empty, PageHead } from "@/components/ui";
import { BY_KEY } from "@/lib/extraction/catalog";
import { formatDate } from "@/lib/extraction/text";
import { loadOverview } from "@/server/overview";
import { BOOKS_FIELDS, EINVOICE_OWNED, TALLY_OWNED } from "@/server/tally";

export const dynamic = "force-dynamic";

export default async function TallyPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; only?: "missing" | "complete" }>;
}) {
  const search = await searchParams;
  const { rows, complete, partial } = await loadOverview(BOOKS_FIELDS, search);

  const disagreeing = rows.filter((r) => {
    const d = r.row.booksDifference?.value;
    return typeof d === "number" && Math.abs(d) > 0.01;
  });

  return (
    <>
      <PageHead
        title="Tally & e-Invoice"
        lead="Where the invoice, the e-Invoice and the books are compared."
        actions={
          <Link href="/invoices" className="btn-ghost">
            Accounts Register
          </Link>
        }
      />

      <div className="mb-4 space-y-3">
        <Banner tone={complete === 0 ? "warn" : "info"}>
          <strong>Pending Tally / e-Invoice data.</strong> {complete} invoice(s) have the full books
          and e-Invoice set, {partial} are still waiting. Neither Tally nor the IRP is connected yet —
          these values are typed in on the invoice today, and the same fields will be filled by a
          Tally export or an e-Invoice PDF when that is built.
        </Banner>
        {disagreeing.length > 0 && (
          <Banner tone="bad">
            <strong>{disagreeing.length} invoice(s) disagree with the books.</strong>{" "}
            {disagreeing.map((r) => r.invoiceNo).join(", ")} — worth settling before reconciliation.
          </Banner>
        )}
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
              <option value="missing">Pending Tally / e-Invoice</option>
              <option value="complete">Complete</option>
            </select>
          </div>
          <button type="submit" className="btn">
            Apply
          </button>
          <Link href="/tally" className="btn-ghost">
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
              <tr className="bg-[#e3e9f1] text-left text-[10px] uppercase tracking-wide text-[var(--color-ink-3)]">
                <th className="px-3 py-1" colSpan={3} />
                <th
                  className="border-l border-r border-[var(--color-line)] px-3 py-1 text-center font-semibold"
                  colSpan={3}
                >
                  Invoice vs books
                </th>
                <th
                  className="border-r border-[var(--color-line)] px-3 py-1 text-center font-semibold"
                  colSpan={EINVOICE_OWNED.length}
                >
                  e-Invoice / IRP
                </th>
                <th className="px-3 py-1 text-center font-semibold" colSpan={TALLY_OWNED.length - 1}>
                  Tally
                </th>
                <th className="px-3 py-1" />
              </tr>
              <tr className="bg-[#eef2f7] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">Customer</th>
                <th className="px-3 py-2">Cur</th>
                <th className="px-3 py-2 text-right">Invoice value</th>
                <th className="px-3 py-2 text-right">Books value</th>
                <th className="px-3 py-2 text-right">Difference</th>
                {EINVOICE_OWNED.map((key) => (
                  <th key={key} className="whitespace-nowrap px-3 py-2">
                    {(BY_KEY[key]?.label ?? key).replace("e-Invoice ", "")}
                  </th>
                ))}
                {TALLY_OWNED.filter((k) => k !== "booksValue").map((key) => (
                  <th key={key} className="whitespace-nowrap px-3 py-2">
                    {(BY_KEY[key]?.label ?? key).replace("Tally ", "").replace(" (Tally)", "")}
                  </th>
                ))}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const diff = inv.row.booksDifference;
                const off = typeof diff?.value === "number" && Math.abs(diff.value) > 0.01;
                return (
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
                    <td className="px-3 py-2">{inv.currency}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {inv.row.customerInvoiceValue?.display || "—"}
                    </td>
                    <td
                      title={inv.row.customsInvoiceValue?.note ?? ""}
                      className={`px-3 py-2 text-right tabular-nums ${
                        CELL_TINT[inv.row.customsInvoiceValue?.status ?? ""] ?? ""
                      }`}
                    >
                      {inv.row.customsInvoiceValue?.display || "—"}
                    </td>
                    <td
                      title={diff?.note ?? ""}
                      className={`px-3 py-2 text-right font-semibold tabular-nums ${
                        off ? "text-[var(--color-bad-fg)]" : ""
                      }`}
                    >
                      {diff?.display || "—"}
                    </td>
                    {[...EINVOICE_OWNED, ...TALLY_OWNED.filter((k) => k !== "booksValue")].map(
                      (key) => {
                        const cell = inv.row[key];
                        return (
                          <td key={key} className="whitespace-nowrap px-3 py-2 text-xs">
                            {cell?.display || (
                              <span className="text-[var(--color-ink-3)]">pending</span>
                            )}
                          </td>
                        );
                      },
                    )}
                    <td className="px-3 py-2 text-right">
                      <Link href={`/invoices/${inv.id}`} className="btn-ghost btn-sm">
                        Fill in
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

    </>
  );
}
