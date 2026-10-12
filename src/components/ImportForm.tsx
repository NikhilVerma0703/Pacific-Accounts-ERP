"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { DeleteInvoiceButton } from "@/components/DeleteInvoiceButton";
import { Banner } from "@/components/ui";
import { importInvoicesAction, type ImportState } from "@/server/importActions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? "Reading…" : "Read & import"}
    </button>
  );
}

export function ImportForm() {
  const [state, action] = useActionState<ImportState, FormData>(importInvoicesAction, {
    results: [],
    ran: false,
  });

  return (
    <>
      <form action={action} className="card mb-5">
        <div className="rounded-xl border-2 border-dashed border-[#c3d1e0] bg-[#fbfdff] p-8 text-center">
          <div className="text-[15px] font-semibold">Choose one or more invoices</div>
          <div className="text-xs text-[var(--color-ink-3)]">
            Excel (.xlsx, .xlsm) or a text-based PDF. Several files at once is fine.
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
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <SubmitButton />
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" name="replace" value="1" />
            Replace if this invoice number already exists
          </label>
        </div>
      </form>

      {state.ran && (
        <div className="mb-5 space-y-4">
          {state.results.map((r, i) => (
            <div key={`${r.fileName}-${i}`} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 text-sm font-semibold">{r.fileName}</div>
                  <Banner tone={r.ok ? "ok" : r.outcome === "duplicate" ? "warn" : "bad"}>
                    {r.message}
                  </Banner>
                </div>
                {r.invoiceId && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/invoices/${r.invoiceId}`} className="btn">
                      Review &amp; verify
                    </Link>
                    {r.ok && (
                      // uploaded the wrong file? undo it here, before anything
                      // is built on top of it
                      <DeleteInvoiceButton
                        invoiceId={r.invoiceId}
                        invoiceNo={r.invoiceNo ?? r.fileName}
                        fileName={r.fileName}
                        redirectTo="/invoices"
                        label="Undo this import"
                      />
                    )}
                  </div>
                )}
              </div>

              {r.quality && (
                <>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    <div className="kpi">
                      <div className="kpi-n">{r.quality.accountsPct}%</div>
                      <div className="kpi-l">of the Accounts fields captured</div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-mute-bg)]">
                        <span
                          className="block h-full bg-[var(--color-accent)]"
                          style={{ width: `${r.quality.accountsPct}%` }}
                        />
                      </div>
                    </div>
                    <div className="kpi">
                      <div className="kpi-n">{r.quality.counts.extracted ?? 0}</div>
                      <div className="kpi-l">Extracted</div>
                    </div>
                    <div className="kpi">
                      <div className="kpi-n">{r.quality.counts.calculated ?? 0}</div>
                      <div className="kpi-l">Calculated</div>
                    </div>
                    <div className="kpi">
                      <div className="kpi-n">{r.quality.counts.needs_verification ?? 0}</div>
                      <div className="kpi-l">Need verification</div>
                    </div>
                    <div className="kpi">
                      <div className="kpi-n">{r.quality.counts.missing ?? 0}</div>
                      <div className="kpi-l">Missing on the invoice</div>
                    </div>
                  </div>

                  {r.quality.issues.some((i) => i.severity === "blocker") && (
                    <div className="mt-4">
                      <p className="text-xs font-semibold">Must be filled in:</p>
                      <ul className="mt-1 list-disc pl-5 text-xs text-[var(--color-ink-2)]">
                        {r.quality.issues
                          .filter((i) => i.severity === "blocker")
                          .map((i) => (
                            <li key={i.key}>
                              <strong>{i.label}</strong> — {i.message}
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}
                  {r.quality.issues.some((i) => i.severity === "verify") && (
                    <div className="mt-3">
                      <p className="text-xs font-semibold">Please confirm:</p>
                      <ul className="mt-1 list-disc pl-5 text-xs text-[var(--color-ink-2)]">
                        {r.quality.issues
                          .filter((i) => i.severity === "verify")
                          .map((i) => (
                            <li key={i.key}>
                              <strong>{i.label}</strong> — {i.message}
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}
                </>
              )}

              {r.warnings.length > 0 && (
                <p className="mt-3 text-xs text-[var(--color-ink-3)]">{r.warnings.join(" ")}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
