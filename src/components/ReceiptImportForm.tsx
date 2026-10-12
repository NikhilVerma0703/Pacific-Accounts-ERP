"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Banner } from "@/components/ui";
import { importReceiptsAction, type ReceiptImportState } from "@/server/importActions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? "Reading…" : "Read & import receipts"}
    </button>
  );
}

function money(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ReceiptImportForm() {
  const [state, action] = useActionState<ReceiptImportState, FormData>(importReceiptsAction, {
    results: [],
    ran: false,
  });

  return (
    <>
      <form action={action} className="card mb-5">
        <div className="rounded-xl border-2 border-dashed border-[#c3d1e0] bg-[#fbfdff] p-8 text-center">
          <div className="text-[15px] font-semibold">Choose a payment sheet or advice</div>
          <div className="text-xs text-[var(--color-ink-3)]">
            Excel (.xlsx, .xlsm) or a text-based PDF, with a row per receipt. Several files at once
            is fine.
          </div>
          <input
            type="file"
            name="files"
            multiple
            required
            accept=".xlsx,.xlsm,.xltx,.pdf"
            className="mt-4 text-sm"
          />
        </div>
        <div className="mt-4">
          <SubmitButton />
        </div>
      </form>

      {state.ran &&
        state.results.map((r, i) => (
          <div key={`${r.fileName}-${i}`} className="card mb-5">
            <div className="mb-2 text-sm font-semibold">{r.fileName}</div>
            <Banner tone={r.ok ? (r.skipped ? "warn" : "ok") : "bad"}>{r.message}</Banner>

            {r.warnings.map((w) => (
              <p key={w} className="mt-2 text-xs text-[var(--color-ink-3)]">
                {w}
              </p>
            ))}

            {r.lines.length > 0 && (
              <div className="tablewrap mt-4">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="bg-[#eef2f7] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                      <th className="px-3 py-2">From</th>
                      <th className="px-3 py-2">Invoice</th>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2 text-right">FCY</th>
                      <th className="px-3 py-2 text-right">Rate</th>
                      <th className="px-3 py-2">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.lines.map((l, j) => (
                      <tr
                        key={`${l.source}-${j}`}
                        className={`border-t border-[var(--color-line)] ${
                          l.outcome === "imported" ? "" : "bg-[var(--color-warn-bg)]"
                        }`}
                      >
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-[var(--color-ink-3)]">
                          {l.source}
                        </td>
                        <td className="px-3 py-2">
                          {l.invoiceId ? (
                            <Link
                              href={`/invoices/${l.invoiceId}`}
                              className="text-[var(--color-brand-2)] hover:underline"
                            >
                              {l.invoiceNo}
                            </Link>
                          ) : (
                            (l.invoiceNo ?? "—")
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{l.receiptDate ?? "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(l.amount)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {l.exchangeRate === null ? "—" : l.exchangeRate}
                        </td>
                        <td className="px-3 py-2 text-xs">{l.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
    </>
  );
}
