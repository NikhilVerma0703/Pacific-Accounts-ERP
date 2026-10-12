import Link from "next/link";
import { notFound } from "next/navigation";

import { DeleteInvoiceButton } from "@/components/DeleteInvoiceButton";
import { NotesPanel } from "@/components/NotesPanel";
import { FieldGroupForm } from "@/components/FieldGroupForm";
import { LineItemsPanel } from "@/components/LineItemsPanel";
import { ReceiptsPanel } from "@/components/ReceiptsPanel";
import { Banner, CELL_TINT, FieldChip, PageHead, StatusChip } from "@/components/ui";
import {
  balanceFrom,
  buildColumns,
  ORIGIN_LABEL,
  receiptMaths,
  totalNotes,
  totalReceipts,
} from "@/lib/business/accounts";
import { prisma } from "@/lib/db";
import { fromJson } from "@/lib/json";
import { EXTRACTION_VERSION } from "@/lib/extraction/version";
import { BY_KEY, CATALOG, GROUPS } from "@/lib/extraction/catalog";
import { formatDate, todayIso } from "@/lib/extraction/text";
import { FieldStatus, type ExtractedField, type LineItem } from "@/lib/extraction/types";
import { normalizedFromJson } from "@/lib/normalize/normalizer";
import { assess, blockers, verifications } from "@/lib/normalize/validators";
import {
  saveBooksAction,
  saveShippingAction,
  toggleVerifiedAction,
  updateFieldAction,
} from "@/server/actions";
import { SHIPPING_FIELDS } from "@/server/fieldGroups";
import { receiptsAndNotes } from "@/server/invoiceData";
import { BOOKS_FIELDS } from "@/server/tally";
import { materialiseRow } from "@/server/registerRows";

export const dynamic = "force-dynamic";

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const load = () =>
    prisma.invoice.findUnique({
      where: { id },
      include: {
        document: { select: { fileName: true, format: true, sizeBytes: true } },
        edits: { orderBy: { createdAt: "desc" } },
      },
    });

  const invoice = await load();
  if (!invoice) notFound();

  // An invoice an older reader produced is re-read by HealStaleInvoices on the
  // register, in the background. It is deliberately not done here: parsing a
  // document before this screen can be sent is what made opening an invoice feel
  // slow, and the values already stored are correct either way.
  const staleReader = invoice.extractionVersion < EXTRACTION_VERSION;

  const stored = fromJson<Record<string, ExtractedField>>(invoice.fields, {});
  const lineItems = fromJson<LineItem[]>(invoice.lineItems, []);
  const { row, receiptSlots } = await materialiseRow(invoice, { today: todayIso() });
  const { receipts, notes } = await receiptsAndNotes(invoice.id);
  const invoiceValue = invoice.invoiceValue === null ? null : Number(invoice.invoiceValue);
  const invoiceRate = invoice.exchangeRate === null ? null : Number(invoice.exchangeRate);
  const receivedTotal = totalReceipts(receipts);
  const cnTotal = totalNotes(notes, "CREDIT");
  const dnTotal = totalNotes(notes, "DEBIT");
  const balanceValue = invoiceValue === null ? null : balanceFrom(invoiceValue, receipts, notes);
  /** The boxes for one block, with what each value's source is. */
  const groupFields = (keys: readonly string[]) =>
    keys.map((key) => ({
      key,
      label: BY_KEY[key]?.label ?? key,
      type: BY_KEY[key]?.type === "date" ? ("date" as const) : ("text" as const),
      value: fields[key]?.value === null || fields[key]?.value === undefined
        ? ""
        : String(fields[key].value),
      source: fields[key]?.source ?? "",
    }));

  const forexAmounts: Array<number | null> = receipts.map((r) => receiptMaths(r, invoiceRate).forex);
  const forexTotal: number | null = forexAmounts.some((f) => f !== null)
    ? Math.round(forexAmounts.reduce((sum: number, f) => sum + (f ?? 0), 0) * 100) / 100
    : null;
  const noteRows = await prisma.creditDebitNote.findMany({
    where: { invoiceId: invoice.id },
    orderBy: { createdAt: "asc" },
  });
  const warnings = fromJson<string[]>(invoice.warnings, []);
  const normalized = normalizedFromJson(stored, lineItems, warnings);
  const quality = assess(normalized);
  // the normalized copy, not the raw stored one: a company rule that changed
  // since this invoice was imported is applied on the way through
  const fields = normalized.fields;

  return (
    <>
      <PageHead
        title={invoice.invoiceNo}
        lead={`Read from ${invoice.document?.fileName ?? "an upload"} (${invoice.document?.format ?? "—"}) on ${formatDate(
          invoice.createdAt.toISOString().slice(0, 10),
        )}. Every value shows where it came from. Correct anything you need to — corrections are kept in the history below.`}
        actions={
          <>
            {invoice.verified && (
              <span className="chip bg-[var(--color-ok-bg)] text-[var(--color-ok-fg)]">Verified</span>
            )}
            <Link href={`/api/export/invoice/${invoice.id}`} className="btn-ghost">
              Export extraction
            </Link>
            <form action={toggleVerifiedAction}>
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <button type="submit" className="btn">
                {invoice.verified ? "Un-verify" : "Mark verified"}
              </button>
            </form>
          </>
        }
      />

      {staleReader && (
        <div className="mb-3">
          <Banner tone="info">
            This invoice was read by an earlier version of the reader. Open the{" "}
            <Link href="/invoices" className="underline">
              Accounts Register
            </Link>{" "}
            and it will be re-read from its original file in the background, or use{" "}
            <Link href="/settings" className="underline">
              Settings → Re-extract
            </Link>{" "}
            to do it now.
          </Banner>
        </div>
      )}

      {warnings.map((w) => (
        <div key={w} className="mb-3">
          <Banner tone="info">{w}</Banner>
        </div>
      ))}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="kpi">
          <div className="kpi-n">{quality.accountsPct}%</div>
          <div className="kpi-l">Accounts fields captured</div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-mute-bg)]">
            <span className="block h-full bg-[var(--color-accent)]" style={{ width: `${quality.accountsPct}%` }} />
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-n">{quality.counts.extracted ?? 0}</div>
          <div className="kpi-l">Extracted</div>
        </div>
        <div className="kpi">
          <div className="kpi-n">{quality.counts.calculated ?? 0}</div>
          <div className="kpi-l">Calculated</div>
        </div>
        <div className="kpi">
          <div className="kpi-n">{verifications(quality).length}</div>
          <div className="kpi-l">To verify</div>
        </div>
        <div className="kpi">
          <div className="kpi-n">{blockers(quality).length}</div>
          <div className="kpi-l">Blocking gaps</div>
        </div>
      </div>

      <section className="card mb-5">
        <h2 className="card-title">Accounts row</h2>
        <div className="tablewrap">
          <table className="w-full text-[13px]">
            <tbody>
              {buildColumns(receiptSlots).map((c) => {
                const cell = row[c.key];
                return (
                  <tr key={c.key} className="border-t border-[var(--color-line)]">
                    <th className="w-48 bg-[#f7f9fc] px-3 py-2 text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                      {c.label}
                    </th>
                    <td className={`px-3 py-2 ${CELL_TINT[cell?.status ?? ""] ?? ""}`}>
                      {cell?.display || "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--color-ink-3)]">
                      {cell?.note ?? ORIGIN_LABEL[c.origin]}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card mb-5">
        <h2 className="card-title">Receivable position</h2>
        <div className="tablewrap">
          <table className="w-full text-[13px]">
            <tbody>
              {[
                ["Invoice value", money(invoiceValue), "As read from the invoice"],
                [
                  "Less receipts",
                  receipts.length ? `− ${money(receivedTotal)}` : "—",
                  `${receipts.length} receipt(s) recorded`,
                ],
                ["Less credit notes", cnTotal ? `− ${money(cnTotal)}` : "—", "Reduces what is owed"],
                ["Plus debit notes", dnTotal ? `+ ${money(dnTotal)}` : "—", "Increases what is owed"],
                [
                  "Balance as per Customer",
                  money(balanceValue),
                  "Invoice Value − Receipts − CN + DN",
                ],
                [
                  "Balance as per Books",
                  "—",
                  "Awaiting Tally — not assumed from the invoice",
                ],
                [
                  "Forex gain / loss",
                  forexTotal === null ? "—" : money(forexTotal),
                  "Sum of each receipt's difference × amount",
                ],
              ].map(([label, value, why], i) => (
                <tr
                  key={label}
                  className={`border-t border-[var(--color-line)] ${
                    i === 4 ? "bg-[var(--color-info-bg)] font-semibold" : ""
                  }`}
                >
                  <th className="w-56 px-3 py-2 text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                    {label}
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums">{value}</td>
                  <td className="px-3 py-2 text-xs text-[var(--color-ink-3)]">{why}</td>
                </tr>
              ))}
              <tr className="border-t border-[var(--color-line)]">
                <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                  Status
                </th>
                <td className="px-3 py-2 text-right">
                  <StatusChip status={String(row.status?.value ?? "")} />
                </td>
                <td className="px-3 py-2 text-xs text-[var(--color-ink-3)]">{row.status?.note}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <ReceiptsPanel
        invoiceId={invoice.id}
        currency={invoice.currency ?? ""}
        invoiceRate={invoiceRate}
        receipts={receipts}
      />

      <NotesPanel
        invoiceId={invoice.id}
        currency={invoice.currency ?? ""}
        notes={noteRows.map((n) => ({
          id: n.id,
          noteType: n.noteType === "CREDIT" ? "CREDIT" : "DEBIT",
          amount: Number(n.amount),
          noteNo: n.noteNo,
          noteDate: n.noteDate ? n.noteDate.toISOString().slice(0, 10) : null,
          reason: n.reason,
        }))}
      />

      <section className="card mb-5">
        <h2 className="card-title">Commercial &amp; shipping</h2>
        <FieldGroupForm
          action={saveShippingAction}
          invoiceId={invoice.id}
          fields={groupFields(SHIPPING_FIELDS)}
        />
      </section>

      <section className="card mb-5">
        <h2 className="card-title">Tally &amp; e-Invoice</h2>
        <p className="mb-3 max-w-[80ch] text-[13px] text-[var(--color-ink-2)]">
          The books figure comes from Tally, not from the invoice. Type it in if you have it.
        </p>
        <FieldGroupForm
          action={saveBooksAction}
          invoiceId={invoice.id}
          fields={groupFields(BOOKS_FIELDS)}
          pendingMessage="Pending Tally / e-Invoice data — nothing has been received or entered for this invoice yet."
        >
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <div className="kpi">
              <div className="kpi-n">{money(invoiceValue)}</div>
              <div className="kpi-l">Invoice value</div>
            </div>
            <div className="kpi">
              <div className="kpi-n">{row.customsInvoiceValue?.display || "—"}</div>
              <div className="kpi-l">Books value (Tally)</div>
            </div>
            <div className="kpi">
              <div className="kpi-n">{row.booksDifference?.display || "—"}</div>
              <div className="kpi-l">Invoice − Books</div>
            </div>
          </div>
          {row.booksDifference?.note && (
            <p className="mb-4 text-xs text-[var(--color-ink-3)]">{row.booksDifference.note}</p>
          )}
        </FieldGroupForm>
      </section>

      {(blockers(quality).length > 0 || verifications(quality).length > 0) && (
        <section className="card mb-5 space-y-3">
          <h2 className="card-title">Action required</h2>
          {blockers(quality).length > 0 && (
            <Banner tone="bad">
              <strong>Must be filled in before this invoice is complete:</strong>
              <ul className="mt-1 list-disc pl-5">
                {blockers(quality).map((i) => (
                  <li key={i.key}>
                    {i.label} — {i.message}
                  </li>
                ))}
              </ul>
            </Banner>
          )}
          {verifications(quality).length > 0 && (
            <Banner tone="warn">
              <strong>Please confirm these:</strong>
              <ul className="mt-1 list-disc pl-5">
                {verifications(quality).map((i) => (
                  <li key={i.key}>
                    {i.label} — {i.message}
                  </li>
                ))}
              </ul>
            </Banner>
          )}
        </section>
      )}

      <LineItemsPanel invoiceId={invoice.id} items={lineItems} invoiceValue={invoiceValue} />

      {GROUPS.map((group) => {
        const defs = CATALOG.filter((f) => f.group === group.key);
        if (!defs.length) return null;
        return (
          <section key={group.key} className="card mb-5">
            <h2 className="card-title">{group.label}</h2>
            <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {defs.map((fd) => {
                const f = fields[fd.key];
                const status = f?.status ?? FieldStatus.NOT_PRESENT;
                const border =
                  status === FieldStatus.NEEDS_VERIFICATION
                    ? "border-[#f0d9a0] bg-[#fffdf6]"
                    : status === FieldStatus.MISSING
                      ? "border-[#f0c9c9] bg-[#fffafa]"
                      : status === FieldStatus.NOT_PRESENT
                        ? "border-[var(--color-line)] bg-[#fafbfc]"
                        : "border-[var(--color-line)] bg-white";
                return (
                  <div key={fd.key} id={`field-${fd.key}`} className={`rounded-lg border p-3 ${border}`}>
                    <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-ink-3)]">
                      {fd.label}
                    </div>
                    <div className={`my-1 break-words text-sm font-semibold ${f?.value == null ? "font-normal italic text-[var(--color-ink-3)]" : ""}`}>
                      {f?.value == null
                        ? status === FieldStatus.NOT_PRESENT
                          ? "Not present"
                          : "Missing"
                        : fd.type === "date"
                          ? formatDate(String(f.value))
                          : String(f.value)}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <FieldChip status={status} />
                      {f?.source && (
                        <span className="rounded bg-[var(--color-mute-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-ink-3)]">
                          {f.source}
                        </span>
                      )}
                    </div>
                    {f?.note && <div className="mt-1.5 text-[11px] text-[var(--color-ink-3)]">{f.note}</div>}
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-[11px] text-[var(--color-brand-2)]">Edit</summary>
                      <form action={updateFieldAction} className="mt-1.5 flex gap-1.5">
                        <input type="hidden" name="invoiceId" value={invoice.id} />
                        <input type="hidden" name="key" value={fd.key} />
                        <input
                          type="text"
                          name="value"
                          defaultValue={f?.value == null ? "" : String(f.value)}
                          placeholder={fd.type ?? "string"}
                          className="input px-2 py-1 text-xs"
                        />
                        <button type="submit" className="btn btn-sm">
                          Save
                        </button>
                      </form>
                    </details>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {invoice.edits.length > 0 && (
        <section className="card mb-5">
          <h2 className="card-title">Correction history</h2>
          <div className="tablewrap">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[#eef2f7] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-2)]">
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Field</th>
                  <th className="px-3 py-2">From</th>
                  <th className="px-3 py-2">To</th>
                  <th className="px-3 py-2">By</th>
                </tr>
              </thead>
              <tbody>
                {invoice.edits.map((e) => (
                  <tr key={e.id} className="border-t border-[var(--color-line)]">
                    <td className="whitespace-nowrap px-3 py-2">
                      {formatDate(e.createdAt.toISOString().slice(0, 10))}
                    </td>
                    <td className="px-3 py-2">{e.fieldKey}</td>
                    <td className="px-3 py-2">{e.oldValue ?? "—"}</td>
                    <td className="px-3 py-2">{e.newValue ?? "—"}</td>
                    <td className="px-3 py-2">{e.editedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h2 className="card-title">Remove this import</h2>
        <p className="mb-3 max-w-[72ch] text-[13px] text-[var(--color-ink-2)]">
          Deletes the uploaded file{invoice.document?.fileName ? ` (${invoice.document.fileName})` : ""}, the
          register row and its corrections. This cannot be undone.
        </p>
        <DeleteInvoiceButton
          invoiceId={invoice.id}
          invoiceNo={invoice.invoiceNo}
          fileName={invoice.document?.fileName}
          redirectTo="/invoices"
          label="Delete this invoice and its file"
          block
        />
      </section>
    </>
  );
}
