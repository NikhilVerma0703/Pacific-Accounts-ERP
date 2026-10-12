import Link from "next/link";

import { DeleteInvoiceButton } from "@/components/DeleteInvoiceButton";
import { HealStaleInvoices } from "@/components/HealStaleInvoices";
import { Banner, CELL_TINT, Empty, Legend, PageHead, StatusChip } from "@/components/ui";
import { buildColumns, ORIGIN_LABEL } from "@/lib/business/accounts";
import { prisma } from "@/lib/db";
import { todayIso } from "@/lib/extraction/text";
import { countStaleInvoices } from "@/server/invoiceData";
import { registerWhere, type RegisterFilters } from "@/server/invoiceQuery";
import { materialiseRows } from "@/server/registerRows";

export const dynamic = "force-dynamic";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<RegisterFilters>;
}) {
  const search = await searchParams;
  const where = registerWhere(search);
  const today = todayIso();

  // Two queries, in parallel, and neither of them opens a document. Invoices an
  // older reader produced are still re-read — HealStaleInvoices does it once the
  // page is on screen, so nothing between a click and a page waits for a file to
  // be parsed.
  const [invoices, options, pendingReread] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }],
      take: 500,
      // the file name is shown when confirming a deletion, so it is always
      // clear which upload is being removed
      include: { document: { select: { fileName: true } } },
    }),
    // one grouped query for both filter dropdowns, instead of two scans
    prisma.invoice.groupBy({ by: ["status", "currency"], _count: { _all: true } }),
    countStaleInvoices(),
  ]);

  const statuses = [...new Set(options.map((o) => o.status))].sort();
  const currencies = [...new Set(options.map((o) => o.currency).filter(Boolean))].sort();

  // rows saved before a column change — or before a receipt was added — are
  // rebuilt from the stored extraction, so the register never shows a blank
  // column for data it already holds
  const { rows, receiptSlots } = await materialiseRows(invoices, { today });
  const columns = buildColumns(receiptSlots);
  const rebuiltCount = rows.filter((r) => r.rebuilt).length;
  const fileNames = new Map(invoices.map((i) => [i.id, i.document?.fileName ?? null]));

  // the header's top row spans each receipt's five columns
  const groups: Array<{ label: string; span: number; receipt: boolean }> = [];
  for (const c of columns) {
    const label = c.receiptNo ? `Receipt ${c.receiptNo}` : "";
    const last = groups[groups.length - 1];
    if (last && last.label === label && (c.receiptNo ? true : false) === last.receipt) {
      last.span += 1;
    } else {
      groups.push({ label, span: 1, receipt: !!c.receiptNo });
    }
  }

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) if (v) params.set(k, String(v));
  const exportQs = params.toString();

  return (
    <>
      <PageHead
        title="Accounts Register"
        lead={`${rows.length} invoice(s) · ${columns.length} columns · ${receiptSlots} receipt${
          receiptSlots === 1 ? "" : "s"
        }`}
        actions={
          <>
            <Link href="/invoices/new" className="btn-ghost">
              Create New Record
            </Link>
            <Link href={`/api/export/register?${exportQs}&format=csv`} className="btn-ghost">
              Export CSV
            </Link>
            <Link href={`/api/export/register?${exportQs}`} className="btn">
              Export Excel
            </Link>
          </>
        }
      />

      <HealStaleInvoices pending={pendingReread} />

      {rebuiltCount > 0 && (
        <div className="mb-3">
          <Banner tone="info">
            {rebuiltCount} row(s) were rebuilt for the current columns, from invoices already stored.
            Nothing needed re-uploading.
          </Banner>
        </div>
      )}

      <div className="mb-4">
        <Banner tone="warn">
          <strong>Temporary assumption in force.</strong> Customer Invoice Value is taken from the
          invoice total, and Balance as per Customer is worked out from it —{" "}
          <code>Invoice Value − Receipts − CN + DN</code>. Customs / Books Value and Balance as per
          Books stay blank because they belong to Tally. Change this in{" "}
          <code>src/lib/business/accounts.ts → ASSUMPTIONS</code>.
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
              placeholder="Invoice no., consignee, PO, container, BL…"
              className="input"
            />
          </div>
          <div>
            <label className="field-label" htmlFor="status">
              Status
            </label>
            <select id="status" name="status" defaultValue={search.status ?? ""} className="input">
              <option value="">All</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ").toLowerCase()}
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
                <option key={c} value={c ?? ""}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn">
            Apply
          </button>
          <Link href="/invoices" className="btn-ghost">
            Reset
          </Link>
        </div>
      </form>

      {rows.length ? (
        <>
          <div className="tablewrap">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[#e3e9f1] text-left text-[10px] uppercase tracking-wide text-[var(--color-ink-3)]">
                  {groups.map((g, i) => (
                    <th
                      key={`${g.label}-${i}`}
                      colSpan={g.span}
                      className={`whitespace-nowrap px-3 py-1 text-center font-semibold ${
                        g.receipt ? "border-l border-r border-[var(--color-line)]" : ""
                      }`}
                    >
                      {g.label}
                    </th>
                  ))}
                  <th className="px-3 py-1" />
                </tr>
                <tr className="bg-[#eef2f7] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      title={ORIGIN_LABEL[c.origin]}
                      className={`whitespace-nowrap px-3 py-2 ${
                        c.kind === "num" || c.kind === "money" ? "text-right" : ""
                      }`}
                    >
                      {c.receiptNo ? c.label.replace(` ${c.receiptNo}`, "").replace(` for Receipt`, "") : c.label}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right">Row</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ id, invoiceNo, row }) => (
                  <tr key={id} className="border-t border-[var(--color-line)] hover:bg-[#f8fafc]">
                    {columns.map((c) => {
                      const cell = row[c.key];
                      const align =
                        c.kind === "num" || c.kind === "money" ? "text-right tabular-nums" : "";
                      return (
                        <td
                          key={c.key}
                          // the party columns show the name; hovering reveals the
                          // whole block, which is what the exports carry
                          title={[cell?.full, cell?.note].filter(Boolean).join(" — ")}
                          className={`whitespace-nowrap px-3 py-2 ${align} ${CELL_TINT[cell?.status ?? ""] ?? ""}`}
                        >
                          {c.key === "invoiceNo" ? (
                            <Link
                              href={`/invoices/${id}`}
                              className="text-[var(--color-brand-2)] hover:underline"
                            >
                              {cell?.display}
                            </Link>
                          ) : c.kind === "status" && cell?.value ? (
                            <StatusChip status={String(cell.value)} />
                          ) : (
                            (cell?.display ?? "")
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <Link href={`/invoices/${id}#receipts`} className="btn-ghost btn-sm">
                          + Receipt
                        </Link>
                        <Link href={`/invoices/${id}`} className="btn-ghost btn-sm">
                          Open
                        </Link>
                        <DeleteInvoiceButton
                          invoiceId={id}
                          invoiceNo={invoiceNo}
                          fileName={fileNames.get(id)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Legend />
        </>
      ) : (
        <div className="card">
          <Empty>
            No invoices match.{" "}
            <Link href="/import" className="text-[var(--color-brand-2)] hover:underline">
              Import a commercial invoice
            </Link>{" "}
            to start the register.
          </Empty>
        </div>
      )}
    </>
  );
}
