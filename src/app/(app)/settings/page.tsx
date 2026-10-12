import { Banner, Empty, OUTCOME_TONE, PageHead } from "@/components/ui";
import { describeParts } from "@/lib/business/instalments";
import { DUE_BASIS_LABELS, rulePartsOf, type DueBasisKey } from "@/lib/business/rules";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/extraction/text";
import { addRuleAction, deleteRuleAction, saveRulePartsAction } from "@/server/actions";
import { loadRules } from "@/server/invoiceData";
import { ReextractAllButton } from "@/components/ReextractAllButton";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [rules, imports] = await Promise.all([
    loadRules(),
    prisma.importLog.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
  ]);

  return (
    <>
      <PageHead
        title="Settings"
        lead="Due dates are calculated only from the rules defined here."
      />

      {/* ------------------------------------------------- payment-term rules */}
      <section className="card mb-5">
        <h2 className="card-title">Payment-term rules</h2>
        <p className="mb-3 text-[13px] text-[var(--color-ink-2)]">
          The first rule whose pattern matches wins, in the order they were added. Without a
          matching rule the invoice shows <em>Pending / requires verification</em>.
        </p>

        {rules.length ? (
          <div className="tablewrap">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[#eef2f7] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                  <th className="px-3 py-2">Rule</th>
                  <th className="px-3 py-2">Matches payment terms containing</th>
                  <th className="px-3 py-2">Falls due</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => {
                  const parts = rulePartsOf(r);
                  const split = parts.length > 1;
                  return (
                    <tr key={r.id} className="border-t border-[var(--color-line)] align-top">
                      <td className="px-3 py-2">
                        {r.label}
                        {split && (
                          <div className="text-[11px] text-[var(--color-ink-3)]">split term</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <code className="rounded bg-[var(--color-mute-bg)] px-1.5 py-0.5 text-xs">
                          {r.pattern}
                        </code>
                      </td>
                      <td className="px-3 py-2">
                        {split ? (
                          describeParts(parts)
                        ) : (
                          <>
                            {r.creditDays} day(s) from {DUE_BASIS_LABELS[r.basis as DueBasisKey]}
                          </>
                        )}

                        <details className="mt-1">
                          <summary className="cursor-pointer text-[11px] text-[var(--color-brand)]">
                            {split ? "Edit the portions" : "Split this term into portions"}
                          </summary>
                          <form
                            action={saveRulePartsAction}
                            className="mt-2 space-y-2 rounded-lg bg-[#fbfcfe] p-2"
                          >
                            <input type="hidden" name="ruleId" value={r.id ?? ""} />
                            <p className="text-[11px] text-[var(--color-ink-3)]">
                              The percentages must total 100. Leave every row blank for a single
                              due date.
                            </p>
                            {[1, 2, 3, 4].map((i) => {
                              const existing = split ? parts[i - 1] : undefined;
                              return (
                                <div key={i} className="flex flex-wrap items-end gap-2">
                                  <div className="w-24">
                                    <label className="field-label" htmlFor={`percent${i}-${r.id}`}>
                                      Portion {i} %
                                    </label>
                                    <input
                                      id={`percent${i}-${r.id}`}
                                      name={`percent${i}`}
                                      type="number"
                                      step="0.01"
                                      min={0}
                                      max={100}
                                      defaultValue={existing?.percent ?? ""}
                                      className="input"
                                    />
                                  </div>
                                  <div className="w-24">
                                    <label className="field-label" htmlFor={`days${i}-${r.id}`}>
                                      Days
                                    </label>
                                    <input
                                      id={`days${i}-${r.id}`}
                                      name={`days${i}`}
                                      type="number"
                                      min={0}
                                      max={720}
                                      defaultValue={existing?.creditDays ?? 0}
                                      className="input"
                                    />
                                  </div>
                                  <div className="w-44">
                                    <label className="field-label" htmlFor={`basis${i}-${r.id}`}>
                                      Counted from
                                    </label>
                                    <select
                                      id={`basis${i}-${r.id}`}
                                      name={`basis${i}`}
                                      defaultValue={existing?.basis ?? r.basis}
                                      className="input"
                                    >
                                      {Object.entries(DUE_BASIS_LABELS).map(([key, label]) => (
                                        <option key={key} value={key}>
                                          {label}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                              );
                            })}
                            <button type="submit" className="btn">
                              Save portions
                            </button>
                          </form>
                        </details>
                      </td>
                      <td className="px-3 py-2">
                        <form action={deleteRuleAction}>
                          <input type="hidden" name="ruleId" value={r.id ?? ""} />
                          <button type="submit" className="btn-danger">
                            Delete
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Banner tone="info">
            No rules yet. Until a rule exists, the register shows <em>Due Date — not calculated</em>{" "}
            and explains why, rather than inventing one.
          </Banner>
        )}

        <form action={addRuleAction} className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <label className="field-label" htmlFor="label">
              Rule name
            </label>
            <input id="label" name="label" required placeholder="e.g. CAD — 30 days from BL" className="input" />
          </div>
          <div className="min-w-[200px] flex-1">
            <label className="field-label" htmlFor="pattern">
              Match text / pattern
            </label>
            <input id="pattern" name="pattern" required placeholder="e.g. Cash Against Documents" className="input" />
          </div>
          <div className="w-28">
            <label className="field-label" htmlFor="creditDays">
              Credit days
            </label>
            <input id="creditDays" name="creditDays" type="number" min={0} max={720} defaultValue={0} className="input" />
          </div>
          <div>
            <label className="field-label" htmlFor="basis">
              Counted from
            </label>
            <select id="basis" name="basis" className="input">
              {Object.entries(DUE_BASIS_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn">
            Add rule
          </button>
        </form>
        <p className="mt-2 text-xs text-[var(--color-ink-3)]">
          Changing a rule recalculates every invoice in the register.
        </p>
      </section>

      <section className="card mb-5">
        <h2 className="card-title">Maintenance</h2>
        <ReextractAllButton />
      </section>

      <section className="card mb-5">
        <h2 className="card-title">Import history</h2>
        {imports.length ? (
          <div className="tablewrap">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[#eef2f7] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">File</th>
                  <th className="px-3 py-2">Outcome</th>
                  <th className="px-3 py-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {imports.map((log) => (
                  <tr key={log.id} className="border-t border-[var(--color-line)]">
                    <td className="whitespace-nowrap px-3 py-2">
                      {formatDate(log.createdAt.toISOString().slice(0, 10))}
                    </td>
                    <td className="px-3 py-2">{log.fileName}</td>
                    <td className="px-3 py-2">
                      <span className={`chip ${OUTCOME_TONE[log.outcome] ?? ""}`}>{log.outcome.toLowerCase()}</span>
                    </td>
                    <td className="px-3 py-2">{log.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No imports yet.</Empty>
        )}
      </section>

    </>
  );
}
