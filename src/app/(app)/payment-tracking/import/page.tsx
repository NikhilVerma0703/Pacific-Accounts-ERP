/**
 * Uploading a customer payment sheet.
 *
 * The page says as much about what it will *not* do as what it will, because an
 * importer that quietly fills gaps is one whose output nobody can defend to a
 * customer.
 */
import Link from "next/link";

import { UploadForm } from "@/components/tracking/UploadForm";
import { Empty, PageHead } from "@/components/ui";
import { day } from "@/components/tracking/bits";
import { prisma } from "@/lib/db";
import { fromJson } from "@/lib/json";
import { SUPPORTED_TERMS } from "@/lib/payments/terms";
import { deleteImportAction } from "@/server/payments/uploadAction";

export const dynamic = "force-dynamic";

interface Report {
  mapping?: Record<string, string>;
  created?: string[];
  updated?: string[];
  skipped?: Array<{ invoiceNo: string; why: string }>;
  duplicates?: Array<{ invoiceNo: string; where: string }>;
  comparison?: Array<{ invoiceNo: string; what: string; ours: string | null; theirs: string | null }>;
  terms?: Array<{ raw: string; understood: string; count: number }>;
  totals?: { value: number; received: number; balance: number };
  statedTotals?: { value: number | null; received: number | null; balance: number | null } | null;
}

export default async function ImportPage() {
  const imports = await prisma.ptImport.findMany({ orderBy: { createdAt: "desc" }, take: 12 });

  return (
    <>
      <PageHead
        title="Upload a payment sheet"
        lead="Upload a customer outstanding sheet. Columns are detected from their headings."
        actions={
          <>
            <Link href="/payment-tracking/new" className="btn-ghost">
              Enter by hand instead
            </Link>
            <Link href="/payment-tracking" className="btn-ghost">
              Back to tracking
            </Link>
          </>
        }
      />

      <UploadForm />

      <section className="card mb-5">
        <h2 className="card-title">Payment terms recognised</h2>
        <div className="tablewrap">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-[#eef2f7] text-left text-[10px] uppercase tracking-wide text-[var(--color-ink-2)]">
                <th className="px-3 py-2">Written as</th>
                <th className="px-3 py-2">Taken to mean</th>
              </tr>
            </thead>
            <tbody>
              {SUPPORTED_TERMS.map((t) => (
                <tr key={t.example} className="border-t border-[var(--color-line)]">
                  <td className="whitespace-nowrap px-3 py-2 font-medium">{t.example}</td>
                  <td className="px-3 py-2 text-[var(--color-ink-2)]">{t.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-[var(--color-ink-3)]">
          An unrecognised wording produces no due date and is marked <em>requires verification</em>.
        </p>
      </section>

      <section className="card">
        <h2 className="card-title">Previous uploads</h2>
        {imports.length === 0 ? (
          <Empty>Nothing uploaded yet.</Empty>
        ) : (
          <div className="space-y-3">
            {imports.map((imp) => {
              const report = fromJson<Report>(imp.report, {});
              const warnings = fromJson<string[]>(imp.warnings, []);
              return (
                <details key={imp.id} className="rounded-lg border border-[var(--color-line)] p-3">
                  <summary className="cursor-pointer text-[13px]">
                    <strong>{imp.customerName ?? "No customer named"}</strong>{" "}
                    <span className="text-[var(--color-ink-3)]">
                      — {imp.fileName} · as on{" "}
                      {imp.asOn ? day(imp.asOn.toISOString().slice(0, 10)) : "not stated"} (
                      {imp.asOnSource}) · {imp.rowsRead} row(s) · {imp.created} added, {imp.updated}{" "}
                      updated{imp.skipped ? `, ${imp.skipped} skipped` : ""} ·{" "}
                      {imp.createdAt.toISOString().slice(0, 10)}
                    </span>
                  </summary>

                  <div className="mt-3 space-y-3 text-[12px]">
                    {report.totals && (
                      <p className="tabular-nums">
                        Invoiced {report.totals.value.toFixed(2)} · received{" "}
                        {report.totals.received.toFixed(2)} · outstanding{" "}
                        {report.totals.balance.toFixed(2)} {imp.currency ?? ""}
                        {report.statedTotals?.value != null &&
                          Math.abs(report.statedTotals.value - report.totals.value) > 0.01 && (
                            <span className="text-[var(--color-bad-fg)]">
                              {" "}
                              — the sheet printed {report.statedTotals.value.toFixed(2)}
                            </span>
                          )}
                      </p>
                    )}

                    {report.mapping && Object.keys(report.mapping).length > 0 && (
                      <p className="text-[var(--color-ink-3)]">
                        Columns:{" "}
                        {Object.entries(report.mapping)
                          .map(([f, c]) => `${c}→${f}`)
                          .join(", ")}
                      </p>
                    )}

                    {report.duplicates && report.duplicates.length > 0 && (
                      <div>
                        <h3 className="font-semibold">Duplicate invoice numbers in the sheet</h3>
                        <ul className="mt-1 space-y-0.5">
                          {report.duplicates.map((d, i) => (
                            <li key={i}>
                              {d.invoiceNo} — {d.where}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {report.comparison && report.comparison.length > 0 && (
                      <div>
                        <h3 className="font-semibold">
                          Where the customer&apos;s own block differs from ours
                        </h3>
                        <ul className="mt-1 space-y-0.5 text-[var(--color-ink-2)]">
                          {report.comparison.map((c, i) => (
                            <li key={i}>
                              <strong>{c.invoiceNo}</strong> {c.what}: ours {c.ours ?? "—"}, theirs{" "}
                              {c.theirs ?? "—"}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {report.terms && report.terms.length > 0 && (
                      <div>
                        <h3 className="font-semibold">Payment terms read</h3>
                        <ul className="mt-1 space-y-0.5 text-[var(--color-ink-2)]">
                          {report.terms.map((t) => (
                            <li key={t.raw}>
                              &ldquo;{t.raw}&rdquo; ×{t.count} → {t.understood}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {report.skipped && report.skipped.length > 0 && (
                      <div>
                        <h3 className="font-semibold">Skipped</h3>
                        <ul className="mt-1 space-y-0.5">
                          {report.skipped.map((s, i) => (
                            <li key={i}>
                              <strong>{s.invoiceNo}</strong> — {s.why}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {warnings.length > 0 && (
                      <div>
                        <h3 className="font-semibold">Worth knowing</h3>
                        <ul className="mt-1 list-disc space-y-1 pl-5 text-[var(--color-warn-fg)]">
                          {warnings.map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <form action={deleteImportAction}>
                      <input type="hidden" name="importId" value={imp.id} />
                      <button type="submit" className="btn-danger">
                        Remove this upload record
                      </button>
                      <span className="ml-2 text-[11px] text-[var(--color-ink-3)]">
                        Removes the record of the upload. The invoices it created stay.
                      </span>
                    </form>
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
