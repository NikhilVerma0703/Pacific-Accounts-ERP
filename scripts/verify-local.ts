/**
 * End-to-end local check — run after `npm run db:push`:
 *
 *     npm run verify
 *
 * It exercises the one path the unit tests cannot: the database.
 *
 * Sections 1–11 are the Accounts Register: it imports the sample invoice, prints
 * the Accounts row that came out, checks duplicate prevention, a manual
 * correction, a payment-term rule, receipts / notes / the balance, a
 * hand-entered record, the reports and the Excel export, and deletion (row,
 * file and corrections together, then a clean re-import).
 *
 * Sections 12–17 are Payment Tracking, which is a separate system: they import
 * all four real customer payment sheets into the `pt_*` tables, check the
 * figures against the ones verified by hand, enter a record with every single
 * field left blank, work out a 120-days-from-BL due date, add more receipts than
 * any form has room for, search, group and export. Section 18 then confirms the
 * register was untouched throughout — the independence requirement, checked
 * against the database rather than taken on trust.
 *
 * Both halves clean up after themselves, so your data is left exactly as it was.
 */
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import type { AccountsRow } from "../src/lib/business/accounts";
import { ACCOUNTS_VIEW } from "../src/lib/business/accounts";
import { fromJson } from "../src/lib/json";
import { buildReportWorkbook } from "../src/server/exporter";
import { createManualInvoice, suggestInvoiceNo } from "../src/server/manualInvoice";
import { loadReceivables } from "../src/server/receivables";
import { buildReport } from "../src/server/reports";
import { removeReceipt, saveNote, saveReceipt } from "../src/server/receipts";
import {
  deleteInvoice,
  ingestFile,
  rebuildAllInvoices,
  rebuildInvoice,
} from "../src/server/ingest";
import { emptyLineItem } from "../src/lib/extraction/types";
import { saveLineItems } from "../src/server/lineItems";
import { invoiceHistory, recordEdits } from "../src/server/payments/audit";
import { importPaymentSheet } from "../src/server/payments/import";
import { buildTrackingExport } from "../src/server/payments/export";
import {
  filterInvoices,
  groupInvoices,
  kpisFrom,
  loadCustomer,
  loadInvoice,
  loadTracking,
  summarise,
} from "../src/server/payments/query";

const prisma = new PrismaClient();
const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "sample_invoice.xlsx");
const FIXTURES = path.join(process.cwd(), "tests", "fixtures");

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log("-".repeat(text.length));
}

async function main() {
  heading("1. Import the sample commercial invoice");
  const buffer = await readFile(FIXTURE);
  const first = await ingestFile(buffer, "verify_sample_invoice.xlsx", { replaceExisting: true });
  check("import succeeded", first.ok, first.message);
  if (!first.invoiceId) throw new Error(first.message);
  console.log(`        ${first.message}`);
  console.log(`        ${first.quality?.accountsPct}% of the Accounts fields captured`);

  heading("2. The Accounts row that was stored");
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: first.invoiceId } });
  const row = fromJson<AccountsRow>(invoice.accountsRow, {} as AccountsRow);
  for (const column of ACCOUNTS_VIEW) {
    const cell = row[column.key];
    if (!cell?.display) continue;
    console.log(`  ${column.label.padEnd(22)} ${cell.display}`);
  }

  check("invoice number", invoice.invoiceNo === "PESPL/2889", invoice.invoiceNo);
  check("invoice value", Number(invoice.invoiceValue) === 18348.49, String(invoice.invoiceValue));
  check("exchange rate", Number(invoice.exchangeRate) === 93.55, String(invoice.exchangeRate));
  check(
    "INR value calculated",
    Number(invoice.homeValue) === Math.round(18348.49 * 93.55 * 100) / 100,
    String(invoice.homeValue),
  );
  check("classified as export", invoice.invoiceType === "EXPORT", invoice.invoiceType);
  check("due date not invented", invoice.dueDate === null, String(invoice.dueDate));
  check("original file stored", !!(await prisma.invoiceDocument.findUnique({
    where: { invoiceId: invoice.id },
  })));

  heading("3. Duplicate prevention");
  const again = await ingestFile(buffer, "verify_sample_invoice.xlsx");
  check("same file refused", again.outcome === "duplicate", again.message);
  console.log(`        ${again.message}`);

  heading("4. A manual correction is recorded and recalculated");
  const fields = fromJson<Record<string, { value: unknown }>>(invoice.fields, {});
  fields.blNo = {
    ...(fields.blNo ?? {}),
    value: "MEDUX1234567",
    status: "extracted",
    source: "entered by verify script",
    note: "Entered manually.",
    confidence: 1,
    key: "blNo",
  } as never;
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { fields: JSON.stringify(fields) },
  });
  await prisma.fieldEdit.create({
    data: { invoiceId: invoice.id, fieldKey: "blNo", oldValue: null, newValue: "MEDUX1234567" },
  });
  await rebuildInvoice(invoice.id);
  const edited = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  check("BL number saved", edited.blNo === "MEDUX1234567", String(edited.blNo));
  check("edit recorded in the audit trail",
    (await prisma.fieldEdit.count({ where: { invoiceId: invoice.id } })) > 0);

  heading("5. A payment-term rule produces a due date");
  const rule = await prisma.paymentTermRule.create({
    data: {
      label: "verify — CAD 30 days",
      pattern: "Cash Against Documents",
      creditDays: 30,
      basis: "INVOICE_DATE",
    },
  });
  await rebuildAllInvoices();
  const withRule = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  const due = withRule.dueDate?.toISOString().slice(0, 10);
  check("due date calculated from the rule", due === "2026-10-12", String(due));

  await prisma.paymentTermRule.delete({ where: { id: rule.id } });
  await rebuildAllInvoices();
  const withoutRule = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  check("due date removed again with the rule", withoutRule.dueDate === null);

  heading("6. Receipts, notes and the balance");
  const r1 = await saveReceipt(invoice.id, {
    amount: 10000,
    receiptDate: "2026-10-12",
    exchangeRate: 94.2,
    bankRef: "UTR-VERIFY-1",
  });
  check("receipt 1 saved", r1.ok && r1.seq === 1, JSON.stringify(r1));
  const r2 = await saveReceipt(invoice.id, { amount: 5000, exchangeRate: 92.55 });
  check("receipt 2 saved", r2.ok && r2.seq === 2, JSON.stringify(r2));
  await saveNote(invoice.id, { noteType: "CREDIT", amount: 348.49, noteNo: "CN-VERIFY" });

  const withReceipts = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  const receiptRow = fromJson<AccountsRow>(withReceipts.accountsRow, {} as AccountsRow);
  check("difference 1 = 94.20 - 93.55", receiptRow.receipt1Diff?.value === 0.65, String(receiptRow.receipt1Diff?.value));
  check("forex 1 = 0.65 x 10,000", receiptRow.receipt1Forex?.value === 6500, String(receiptRow.receipt1Forex?.value));
  check("difference 2 is a loss", receiptRow.receipt2Diff?.value === -1, String(receiptRow.receipt2Diff?.value));
  check("CN total", receiptRow.creditNote?.value === 348.49, String(receiptRow.creditNote?.value));
  check(
    "balance = 18,348.49 - 15,000 - 348.49",
    receiptRow.balanceAsPerCustomer?.value === 3000,
    String(receiptRow.balanceAsPerCustomer?.value),
  );

  await removeReceipt(invoice.id, 1);
  const renumbered = await prisma.receipt.findMany({
    where: { invoiceId: invoice.id },
    orderBy: { seq: "asc" },
  });
  check("removing receipt 1 renumbers the rest", renumbered.length === 1 && renumbered[0].seq === 1,
    JSON.stringify(renumbered.map((r) => r.seq)));

  heading("7. A record entered by hand is the same kind of record");
  const manual = await createManualInvoice({
    values: {
      invoiceNo: "VERIFY/DUMMY-1",
      invoiceDate: "2026-09-12",
      currency: "USD",
      exchangeRate: "93.55",
      invoiceValue: "18348.49",
      paymentTerms: "100% Cash Against Documents (CAD)",
      notifyPartyName: "Verify Notify Party Inc",
      consigneeName: "Verify Consignee Ltd",
    },
    receipts: [{ amount: 10000, exchangeRate: 94.2, receiptDate: "2026-10-12" }],
    notes: [{ noteType: "CREDIT", amount: 348.49 }],
  });
  check("manual record created", manual.ok, manual.ok ? "" : manual.message);

  if (manual.ok) {
    const manualInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: manual.invoiceId } });
    const manualRow = fromJson<AccountsRow>(manualInvoice.accountsRow, {} as AccountsRow);

    check("every register column is present", ACCOUNTS_VIEW.every((c) => c.key in manualRow),
      ACCOUNTS_VIEW.filter((c) => !(c.key in manualRow)).map((c) => c.key).join(", "));
    check("receipt saved with it", manualRow.receipt1Fcy?.value === 10000, String(manualRow.receipt1Fcy?.value));
    check("difference calculated", manualRow.receipt1Diff?.value === 0.65, String(manualRow.receipt1Diff?.value));
    check("forex calculated", manualRow.receipt1Forex?.value === 6500, String(manualRow.receipt1Forex?.value));
    check("note saved with it", manualRow.creditNote?.value === 348.49, String(manualRow.creditNote?.value));
    check("balance = 18,348.49 - 10,000 - 348.49", manualRow.balanceAsPerCustomer?.value === 8000,
      String(manualRow.balanceAsPerCustomer?.value));
    check("notify party became the customer", manualInvoice.customerName === "Verify Notify Party Inc",
      String(manualInvoice.customerName));
    check("it is filterable like any other row", manualInvoice.currency === "USD" && manualInvoice.status.length > 0,
      `${manualInvoice.currency} / ${manualInvoice.status}`);

    const suggestion = await suggestInvoiceNo("VERIFY-SEQ");
    check("dummy numbering suggests the next one", suggestion === "VERIFY-SEQ/001", suggestion);

    await deleteInvoice(manual.invoiceId);
    await prisma.importLog.deleteMany({ where: { fileName: { contains: "VERIFY/DUMMY-1" } } });
  }

  heading("8. The management view agrees with the register");
  const flow = await createManualInvoice({
    values: {
      invoiceNo: "VERIFY/FLOW-1",
      invoiceDate: "2026-09-12",
      currency: "USD",
      exchangeRate: "93.55",
      invoiceValue: "18348.49",
      paymentTerms: "100% Cash Against Documents (CAD)",
      notifyPartyName: "Verify Flow Customer Inc",
    },
    receipts: [{ amount: 10000, exchangeRate: 94.2, receiptDate: "2026-10-12" }],
    notes: [
      { noteType: "CREDIT", amount: 500 },
      { noteType: "DEBIT", amount: 150 },
    ],
  });
  check("flow invoice created", flow.ok, flow.ok ? "" : flow.message);

  if (flow.ok) {
    const flowRow = fromJson<AccountsRow>(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: flow.invoiceId } })).accountsRow,
      {} as AccountsRow,
    );
    // 18,348.49 - 10,000 - 500 + 150
    check("register balance", flowRow.balanceAsPerCustomer?.value === 7998.49,
      String(flowRow.balanceAsPerCustomer?.value));

    const { rows: receivable } = await loadReceivables({ q: "VERIFY/FLOW-1" });
    const mine = receivable.find((r) => r.invoiceNo === "VERIFY/FLOW-1");
    check("Payments & Receipts agrees", mine?.balance === 7998.49, String(mine?.balance));
    check("receipt forex carried through", mine?.forexTotal === 6500, String(mine?.forexTotal));

    for (const key of ["register", "customer", "receipts", "notes", "shipping", "currency"] as const) {
      const { report } = await buildReport({ report: key, q: "VERIFY/FLOW-1" });
      check(`${key} report builds`, report.rows.length > 0, `${report.rows.length} row(s)`);
    }

    const { report: customerReport } = await buildReport({ report: "customer", q: "VERIFY/FLOW-1" });
    const outstanding = customerReport.rows.reduce((sum, r) => sum + Number(r.outstanding ?? 0), 0);
    check("customer report totals match the register", Math.round(outstanding * 100) / 100 === 7998.49,
      String(outstanding));

    const { report: receiptReport } = await buildReport({ report: "receipts", q: "VERIFY/FLOW-1" });
    check("receipt report forex total", Number(receiptReport.totals?.forex) === 6500,
      String(receiptReport.totals?.forex));

    const workbook = await buildReportWorkbook(
      receiptReport.label, receiptReport.columns, receiptReport.rows, receiptReport.totals,
      receiptReport.note,
    );
    check("report exports to Excel", workbook.byteLength > 5000, `${workbook.byteLength} bytes`);

    await deleteInvoice(flow.invoiceId);
    await prisma.importLog.deleteMany({ where: { fileName: { contains: "VERIFY/FLOW-1" } } });
  }

  heading("9. Deleting an import removes the row, the file and the corrections");
  const removed = await deleteInvoice(invoice.id);
  check("deletion reported what it removed", removed?.invoiceNo === "PESPL/2889", String(removed?.invoiceNo));
  check("register row gone", (await prisma.invoice.count({ where: { id: invoice.id } })) === 0);
  check(
    "uploaded file gone",
    (await prisma.invoiceDocument.count({ where: { invoiceId: invoice.id } })) === 0,
  );
  check(
    "corrections gone with it",
    (await prisma.fieldEdit.count({ where: { invoiceId: invoice.id } })) === 0,
  );
  check(
    "removal recorded in the import log",
    (await prisma.importLog.count({
      where: { fileName: "verify_sample_invoice.xlsx", outcome: "DELETED" },
    })) === 1,
  );

  heading("10. The same file can be imported again afterwards");
  const reimported = await ingestFile(buffer, "verify_sample_invoice.xlsx");
  check("re-import accepted", reimported.ok, reimported.message);

  heading("11. Clean up (Accounts Register)");
  if (reimported.invoiceId) await deleteInvoice(reimported.invoiceId);
  await prisma.importLog.deleteMany({ where: { fileName: "verify_sample_invoice.xlsx" } });
  check("nothing left behind", (await prisma.invoice.count({ where: { invoiceNo: "PESPL/2889" } })) === 0);

  await verifyPaymentTracking();
  await verifyEditing();

  console.log(
    failures === 0
      ? "\nAll local checks passed — the full stack works end to end.\n"
      : `\n${failures} check(s) failed.\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

// ===========================================================================
// Payment Tracking — a separate system, checked separately
// ===========================================================================

/** The four real customer sheets, with the totals verified by hand. */
const SHEETS = [
  { file: "statement_fair_deal.xlsx", customer: "Fair Deal Marble", rows: 9, value: 348688.54, received: 59651.63 },
  { file: "statement_kaminea.xlsx", customer: "Partner Kamienia", rows: 4, value: 127137.02, received: 0 },
  { file: "statement_blue_planet.xlsx", customer: "Blue Planet Inc", rows: 5, value: 195741.04, received: 73964.1 },
  { file: "statement_terry_stone.xlsx", customer: "Terry Stone", rows: 23, value: 659461.36, received: 447976.52 },
] as const;

const close = (a: number | null | undefined, b: number) => a !== null && a !== undefined && Math.abs(a - b) < 0.015;
const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const daysBetween = (from: string, to: string) =>
  Math.round((utc(to).getTime() - utc(from).getTime()) / 86_400_000);

/** Everything this half of the script created, so it can take it all away again. */
const made = { customers: [] as string[], invoices: [] as string[], files: [] as string[] };

async function verifyPaymentTracking(): Promise<void> {
  heading("12. Payment Tracking — importing all four customer payment sheets");

  // Counts to compare at the end: the register must be untouched by all of this.
  const before = await registerCounts();

  const names: string[] = SHEETS.map((s) => s.customer);
  const existing = await prisma.ptCustomer.findMany({ where: { name: { in: names } } });
  if (existing.length > 0) {
    console.log(
      `  skipped — ${existing.map((c) => c.name).join(", ")} already exist in Payment Tracking.\n` +
      "          These checks import the four reference sheets, which would write into those\n" +
      "          real records. Nothing was changed. Remove or rename them to run this part.",
    );
    return;
  }

  for (const s of SHEETS) {
    const buffer = readFileSync(path.join(FIXTURES, s.file));
    const result = await importPaymentSheet(buffer, `verify_${s.file}`, { replace: true });
    made.files.push(`verify_${s.file}`);

    check(`${s.file} imported`, result.ok, result.message);
    check(`  customer read as ${s.customer}`, result.customer === s.customer,
      `${result.customer} (from ${result.customerSource})`);
    check(`  ${s.rows} invoice rows`, result.rowsRead === s.rows, String(result.rowsRead));
    check(`  ${s.rows} records created`, result.created.length === s.rows,
      `${result.created.length} created, ${result.updated.length} updated, ${result.skipped.length} skipped`);
    check("  currency established, not assumed", result.currency === "USD",
      `${result.currency} (from ${result.currencySource})`);
    check("  position date reported with its source", result.asOnSource.length > 0, result.asOnSource);
    if (result.totals) {
      check("  invoice total matches the verified figure", close(result.totals.value, s.value),
        String(result.totals.value));
      check("  received total matches the verified figure", close(result.totals.received, s.received),
        String(result.totals.received));
    }
    for (const t of result.terms) {
      console.log(`        term "${t.raw}" ×${t.count} → ${t.understood}`);
    }
    for (const w of result.warnings) console.log(`        note: ${w}`);
  }

  const view = await loadTracking();
  const ours = view.invoices.filter((i) => names.includes(i.customerName ?? ""));
  for (const i of ours) made.invoices.push(i.id);
  const createdCustomers = await prisma.ptCustomer.findMany({ where: { name: { in: names } } });
  made.customers.push(...createdCustomers.map((c) => c.id));

  heading("13. The figures those sheets produced");
  const summaries = summarise(ours);
  for (const s of SHEETS) {
    const row = summaries.find((x) => x.name === s.customer);
    check(`${s.customer}: ${s.rows} invoices`, row?.invoices === s.rows, String(row?.invoices));
    check(`  invoice value ${s.value.toLocaleString()}`, close(row?.invoiceValue, s.value),
      String(row?.invoiceValue));
    check(`  received ${s.received.toLocaleString()}`, close(row?.received, s.received),
      String(row?.received));
    check("  outstanding = value − received", close(row?.outstanding, s.value - s.received),
      String(row?.outstanding));
    console.log(`        ${row?.dueDatesKnown ?? 0} of ${s.rows} have a due date that could be established`);
  }

  const [usd] = kpisFrom(ours, view.params);
  const totalValue = SHEETS.reduce((t, s) => t + s.value, 0);
  const totalReceived = SHEETS.reduce((t, s) => t + s.received, 0);
  check("41 invoices across 4 customers",
    usd?.invoices === 41 && usd?.customers === 4, `${usd?.invoices} / ${usd?.customers}`);
  check("one currency, USD", usd?.currency === "USD", String(usd?.currency));
  check(`total invoice value ${totalValue.toFixed(2)}`, close(usd?.totalInvoiceValue, totalValue),
    String(usd?.totalInvoiceValue));
  check(`total received ${totalReceived.toFixed(2)}`, close(usd?.totalReceived, totalReceived),
    String(usd?.totalReceived));
  check(`total outstanding ${(totalValue - totalReceived).toFixed(2)}`,
    close(usd?.totalOutstanding, totalValue - totalReceived), String(usd?.totalOutstanding));

  const open = ours.filter((i) => (i.money.calculatedOutstanding ?? 0) > 0.01);
  const openTotal = open.reduce((t, i) => t + (i.money.calculatedOutstanding ?? 0), 0);
  check("the overdue figure declares its own denominator",
    close((usd?.assessable ?? 0) + (usd?.requiresVerification ?? 0), Math.round(openTotal * 100) / 100),
    `${usd?.assessable} assessable + ${usd?.requiresVerification} unverifiable vs ${openTotal.toFixed(2)} open`);
  check("nothing is called overdue without a due date",
    ours.every((i) => i.status !== "OVERDUE" || !!i.schedule.dueDate));
  check("nothing claims a due date that was not worked out or typed in",
    ours.every((i) => i.schedule.dueDate === null || i.schedule.dueDateSource !== "none"));
  console.log(
    `        ${usd?.requiresVerificationInvoices} invoice(s), ${usd?.requiresVerification} USD, have no` +
    " due date and are reported as requiring verification rather than guessed",
  );

  heading("14. Uploading the same sheet again, and a dry run");
  const fairDealFile = readFileSync(path.join(FIXTURES, SHEETS[0].file));
  const dup = await importPaymentSheet(fairDealFile, `verify_${SHEETS[0].file}`);
  check("the identical file is refused", !dup.ok && /already imported/i.test(dup.message), dup.message);

  const again = await importPaymentSheet(fairDealFile, `verify_${SHEETS[0].file}`, { replace: true });
  check("a refreshed sheet updates instead of duplicating",
    again.created.length === 0 && again.updated.length + again.unchanged.length === SHEETS[0].rows,
    `${again.created.length} created, ${again.updated.length} updated, ${again.unchanged.length} unchanged`);
  check("still 41 invoices, not 50",
    (await prisma.ptInvoice.count({ where: { id: { in: made.invoices } } })) === 41);

  const imports = await prisma.ptImport.count();
  const dry = await importPaymentSheet(fairDealFile, "verify_dry_run.xlsx", {
    replace: true,
    dryRun: true,
  });
  check("a dry run reports what would change", dry.ok && dry.rowsRead === SHEETS[0].rows, dry.message);
  check("and writes nothing at all", (await prisma.ptImport.count()) === imports);

  heading("15. A record with every single field left blank");
  const nothing = await prisma.ptInvoice.create({ data: {} });
  made.invoices.push(nothing.id);
  check("saved with no invoice number, no value, no date", !!nothing.id);

  const withBlank = await loadInvoice(nothing.id);
  check("it is not reported as overdue", withBlank.invoice?.status !== "OVERDUE",
    String(withBlank.invoice?.status));
  check("it says there is no value to measure against", withBlank.invoice?.status === "NO_VALUE",
    String(withBlank.invoice?.status));
  check("it lists what it is still missing", (withBlank.invoice?.missingFields.length ?? 0) > 0,
    (withBlank.invoice?.missingFields ?? []).join(", "));
  check("no due date was invented for it", withBlank.invoice?.schedule.dueDate === null,
    String(withBlank.invoice?.schedule.dueDate));

  heading("16. 120 Days From BL Date — the worked example, in the database");
  const example = await prisma.ptInvoice.create({
    data: {
      invoiceNo: "VERIFY/PT-120BL",
      invoiceDate: utc("2026-05-20"),
      customerInvoiceValue: 100000,
      exchangeRate: 83.1,
      currency: "USD",
      paymentTerms: "120 Days From BL Date",
      blNo: "VERIFY-BL-1",
      blDate: utc("2026-05-30"),
      source: "MANUAL",
    },
  });
  made.invoices.push(example.id);

  // six receipts — three more than the create form has room for
  for (let i = 1; i <= 6; i += 1) {
    await prisma.ptReceipt.create({
      data: {
        invoiceId: example.id,
        seq: i,
        receiptDate: utc("2026-10-01"),
        amountFcy: 15000,
        exchangeRate: i === 6 ? 82.1 : 84.1,
        bankRef: `UTR-VERIFY-PT-${i}`,
      },
    });
  }
  await prisma.ptNote.create({
    data: { invoiceId: example.id, noteType: "CREDIT", amount: 5000, noteNo: "CN-VERIFY-PT" },
  });
  await prisma.ptNote.create({
    data: { invoiceId: example.id, noteType: "DEBIT", amount: 1000, noteNo: "DN-VERIFY-PT" },
  });

  const loaded = await loadInvoice(example.id);
  const tracked = loaded.invoice;
  check("due date = BL 30-May-2026 + 120 days = 27-Sep-2026",
    tracked?.schedule.dueDate === "2026-09-27", String(tracked?.schedule.dueDate));
  check("and it says it calculated it", tracked?.schedule.dueDateSource === "calculated",
    String(tracked?.schedule.dueDateSource));

  const expectedOverdue = daysBetween("2026-09-27", loaded.today);
  check(`overdue days as at ${loaded.today} = ${expectedOverdue}`,
    tracked?.overdueDays === expectedOverdue, String(tracked?.overdueDays));

  check("six receipts, numbered 1 to 6", tracked?.receipts.length === 6,
    (tracked?.receipts ?? []).map((r) => r.seq).join(", "));
  check("total received 90,000", close(tracked?.money.totalReceived, 90000),
    String(tracked?.money.totalReceived));
  // 100,000 − 90,000 − 5,000 CN + 1,000 DN
  check("outstanding = 100,000 − 90,000 − 5,000 + 1,000 = 6,000",
    close(tracked?.money.calculatedOutstanding, 6000), String(tracked?.money.calculatedOutstanding));
  // five receipts a rupee above the invoice rate, one a rupee below
  check("forex = 5 × +1.00 × 15,000 then 1 × −1.00 × 15,000 = 60,000",
    close(tracked?.money.totalForexGainLoss, 60000), String(tracked?.money.totalForexGainLoss));
  check("the loss-making receipt is reported as a loss",
    (tracked?.money.receipts.find((r) => r.seq === 6)?.forexGainLoss ?? 0) < 0,
    String(tracked?.money.receipts.find((r) => r.seq === 6)?.forexGainLoss));
  if (expectedOverdue > 0) {
    check("status is overdue, now the due date has passed", tracked?.status === "OVERDUE",
      String(tracked?.status));
  }

  heading("17. Searching, grouping, the customer screen and the export");
  const view2 = await loadTracking();
  const mine = view2.invoices.filter((i) => made.invoices.includes(i.id));

  const bySearch = filterInvoices(mine, { q: "fair deal" });
  check("search by customer name finds all 9 of that customer's invoices",
    bySearch.filter((i) => i.customerName === "Fair Deal Marble").length === 9,
    `${bySearch.length} row(s) matched`);
  check("search by invoice number finds the one invoice",
    filterInvoices(mine, { q: "PESPL/1918" }).length === 1,
    String(filterInvoices(mine, { q: "PESPL/1918" }).length));
  check("filtering to open items drops the settled ones",
    filterInvoices(mine, { open: "1" }).every((i) => (i.money.calculatedOutstanding ?? 0) > 0.01));
  check("grouping by customer gives 5 groups — the four plus 'no customer recorded'",
    groupInvoices(mine, "customer").length === 5,
    groupInvoices(mine, "customer").map((g) => `${g.label} (${g.totals.invoices})`).join("; "));

  const fairDeal = createdCustomers.find((c) => c.name === "Fair Deal Marble");
  if (fairDeal) {
    const screen = await loadCustomer(fairDeal.id);
    check("the customer screen shows that customer's 9 invoices", screen.invoices.length === 9,
      String(screen.invoices.length));
    check("with one summary line and its own KPIs",
      screen.summary.length === 1 && screen.kpis.length === 1);
  }

  // The blank record has no currency, so it is left out of a totalled export:
  // amounts in different currencies cannot be added, and the export says so.
  const usdRows = mine.filter((i) => i.currency === "USD");
  const report = buildTrackingExport(usdRows, {
    today: view2.today,
    filters: {},
    params: view2.params,
  });
  check("the export has every master-table column", report.columns.length === 45,
    `${report.columns.length} columns`);
  check("one export row per invoice", report.rows.length === usdRows.length,
    `${report.rows.length} of ${usdRows.length}`);
  check("and a receipt-by-receipt sheet beside it", report.receipts.rows.length >= 6,
    `${report.receipts.rows.length} receipt row(s)`);
  check("its totals row agrees with the dashboard",
    close(Number(report.totals?.customerInvoiceValue), totalValue + 100000),
    String(report.totals?.customerInvoiceValue));
  check("it carries its own provenance note", report.note.length > 40);

  const mixed = buildTrackingExport(mine, { today: view2.today, filters: {}, params: view2.params });
  check("no totals row is written across two currencies", mixed.totals === null);
  check("and the export says why", /more than one currency/i.test(mixed.note));

  const workbook = await buildReportWorkbook(
    report.label, report.columns, report.rows, report.totals, report.note,
  );
  check("it writes to Excel", workbook.byteLength > 5000, `${workbook.byteLength} bytes`);

  heading("18. The Accounts Register was never touched");
  const after = await registerCounts();
  for (const [table, n] of Object.entries(before)) {
    check(`${table} unchanged (${n})`, after[table] === n, `${n} → ${after[table]}`);
  }

  heading("19. Clean up (Payment Tracking)");
  await prisma.ptInvoice.deleteMany({ where: { id: { in: made.invoices } } });
  await prisma.ptCustomer.deleteMany({ where: { id: { in: made.customers } } });
  await prisma.ptImport.deleteMany({ where: { fileName: { in: made.files } } });
  check("every record created here is gone",
    (await prisma.ptInvoice.count({ where: { id: { in: made.invoices } } })) === 0);
  check("the receipts and notes went with them",
    (await prisma.ptReceipt.count({ where: { invoiceId: { in: made.invoices } } })) === 0 &&
      (await prisma.ptNote.count({ where: { invoiceId: { in: made.invoices } } })) === 0);
  check("the import records are gone too",
    (await prisma.ptImport.count({ where: { fileName: { in: made.files } } })) === 0);
}

// ===========================================================================
// Editing — every field, imported or typed
// ===========================================================================

/**
 * The checks that matter most here are the negative ones.
 *
 * It is easy to show that saving a field changes it. What had to be proved is
 * that saving a field does **not** change the ones the form did not show — the
 * defect this section was written for destroyed a receipt's remarks every time
 * somebody corrected its amount, silently, on a field nobody was looking at.
 */
async function verifyEditing(): Promise<void> {
  heading("20. Editing a register record: every field, and nothing else");

  const made = await createManualInvoice({
    values: {
      invoiceNo: "VERIFY/EDIT-1",
      invoiceDate: "2026-09-12",
      currency: "USD",
      exchangeRate: "93.55",
      invoiceValue: "18348.49",
      paymentTerms: "100% Cash Against Documents (CAD)",
      notifyPartyName: "Verify Edit Customer Inc",
    },
    receipts: [{ amount: 10000, exchangeRate: 94.2, receiptDate: "2026-10-12" }],
  });
  check("a record to edit was created", made.ok, made.ok ? "" : made.message);
  if (!made.ok) return;

  // a receipt with a remark, as the receipt importer would store it
  await saveReceipt(made.invoiceId, {
    seq: 1,
    amount: 10000,
    exchangeRate: 94.2,
    receiptDate: "2026-10-12",
    bankRef: "UTR-EDIT-1",
    remarks: "part of one remittance of 79,054.68",
    source: "read from a payment advice",
  });

  // now correct the amount the way the inline edit row does — four fields, no
  // remarks among them
  await saveReceipt(made.invoiceId, {
    seq: 1,
    amount: 11000,
    exchangeRate: 94.2,
    receiptDate: "2026-10-12",
    bankRef: "UTR-EDIT-1",
  });

  const edited = await prisma.receipt.findFirstOrThrow({
    where: { invoiceId: made.invoiceId, seq: 1 },
  });
  check("the amount was changed", Number(edited.amount) === 11000, String(edited.amount));
  check(
    "and the remark the form never showed survived it",
    edited.remarks === "part of one remittance of 79,054.68",
    String(edited.remarks),
  );
  check(
    "as did where the receipt came from",
    edited.source === "read from a payment advice",
    String(edited.source),
  );
  check(
    "the home-currency figure followed the new amount",
    Number(edited.homeAmount) === Math.round(11000 * 94.2 * 100) / 100,
    String(edited.homeAmount),
  );

  // an explicit null still clears, which is what deleting a wrong note means
  await saveReceipt(made.invoiceId, {
    seq: 1,
    amount: 11000,
    exchangeRate: 94.2,
    receiptDate: "2026-10-12",
    bankRef: "UTR-EDIT-1",
    remarks: null,
  });
  const cleared = await prisma.receipt.findFirstOrThrow({
    where: { invoiceId: made.invoiceId, seq: 1 },
  });
  check("an explicit blank does clear it", cleared.remarks === null, String(cleared.remarks));

  heading("21. A credit note can be corrected in place");
  const note = await saveNote(made.invoiceId, {
    noteType: "CREDIT",
    amount: 500,
    noteNo: "CN-EDIT-1",
    noteDate: "2026-10-01",
    reason: "short shipment",
  });
  check("note created", note.ok, note.ok ? "" : note.message);
  if (note.ok) {
    const corrected = await saveNote(made.invoiceId, {
      id: note.receiptId,
      noteType: "CREDIT",
      amount: 650,
    });
    check("the same note was updated, not duplicated",
      corrected.ok && (await prisma.creditDebitNote.count({ where: { invoiceId: made.invoiceId } })) === 1);

    const after = await prisma.creditDebitNote.findFirstOrThrow({
      where: { invoiceId: made.invoiceId },
    });
    check("the amount changed", Number(after.amount) === 650, String(after.amount));
    check("the note number was kept", after.noteNo === "CN-EDIT-1", String(after.noteNo));
    check("the reason was kept", after.reason === "short shipment", String(after.reason));
    check("the date was kept", after.noteDate?.toISOString().slice(0, 10) === "2026-10-01",
      String(after.noteDate));
  }

  heading("22. Editing line items recalculates their total");
  await prisma.invoice.update({
    where: { id: made.invoiceId },
    data: {
      lineItems: JSON.stringify([
        { ...emptyLineItem(), description: "Slabs A", amount: 10000, quantity: 100, rate: 100 },
        { ...emptyLineItem(), description: "Slabs B", amount: 8348.49, quantity: 83, rate: 100.58 },
      ]),
    },
  });

  const saved = await saveLineItems(made.invoiceId, [
    { description: "Slabs A", amount: "12000", quantity: "120", rate: "100" },
    { description: "Slabs B", amount: "8348.49", quantity: "83", rate: "100.58" },
    // a third row, typed in where the invoice had only two
    { description: "Slabs C", amount: "1500", quantity: "15", rate: "100" },
    // and an entirely empty one, which is how a row is removed
    { description: "", amount: "", quantity: "", rate: "" },
  ]);
  check("three rows saved, the empty one dropped", saved.ok && saved.rows === 3,
    `${saved.rows} row(s): ${saved.message}`);
  check("the total was recalculated from the rows as typed",
    saved.total !== null && Math.abs(saved.total - 21848.49) < 0.005, String(saved.total));

  const withLines = await prisma.invoice.findUniqueOrThrow({ where: { id: made.invoiceId } });
  const lineFields = fromJson<Record<string, { value: unknown; source?: string | null }>>(
    withLines.fields,
    {},
  );
  check("and it is labelled as added up, not as typed",
    (lineFields.lineItemsTotal?.source ?? "").includes("added up from the line items"),
    String(lineFields.lineItemsTotal?.source));
  check("a cell kept its untouched neighbour",
    fromJson<Array<{ description: string | null; rate: number | null }>>(withLines.lineItems, [])[1]
      ?.rate === 100.58);
  check("the change is in the correction history",
    (await prisma.fieldEdit.count({
      where: { invoiceId: made.invoiceId, fieldKey: { in: ["lineItems", "lineItemsTotal"] } },
    })) >= 2);

  await deleteInvoice(made.invoiceId);
  await prisma.importLog.deleteMany({ where: { fileName: { contains: "VERIFY/EDIT-1" } } });
  check("the register record was cleaned up",
    (await prisma.invoice.count({ where: { invoiceNo: "VERIFY/EDIT-1" } })) === 0);

  heading("23. Payment Tracking: correcting an imported figure is visible as a correction");
  const customer = await prisma.ptCustomer.create({ data: { name: "Verify Edit Co", currency: "USD" } });
  const imported = await prisma.ptInvoice.create({
    data: {
      customerId: customer.id,
      invoiceNo: "VERIFY/PT-EDIT-1",
      invoiceDate: utc("2026-05-20"),
      customerInvoiceValue: 26756.27,
      currency: "USD",
      source: "EXCEL",
      sourceFile: "verify_edit.xlsx",
    },
  });

  // the 12 fields the sheet did not fill, typed in afterwards
  const later = {
    paymentTerms: "120 Days From BL Date",
    blNo: "VERIFY-BL-EDIT",
    blDate: utc("2026-05-30"),
    poNo: "B6001",
    piNo: "PI-9",
    containerNo: "MSNU1968136",
    eta: utc("2026-07-02"),
    shippingBillNo: "SB-7788",
    shippingBillDate: utc("2026-05-22"),
    exchangeRate: 83.1,
    booksBalance: 26756.27,
    remarks: "entered after the upload",
  };
  await prisma.ptInvoice.update({ where: { id: imported.id }, data: later });
  await recordEdits({
    entity: "INVOICE",
    entityId: imported.id,
    invoiceId: imported.id,
    recordSource: "EXCEL",
    changes: [
      { fieldKey: "customerInvoiceValue", label: "Customer invoice value", from: "26756.27", to: "26351.56" },
      ...Object.keys(later).map((k) => ({ fieldKey: k, label: k, from: null, to: "filled in" })),
    ],
  });
  await prisma.ptInvoice.update({
    where: { id: imported.id },
    data: { customerInvoiceValue: 26351.56 },
  });

  const story = await invoiceHistory(imported.id);
  check("every change was recorded", story.entries.length === 13, String(story.entries.length));
  check("the value the sheet supplied is still recoverable",
    story.imported.customerInvoiceValue === "26756.27",
    String(story.imported.customerInvoiceValue));
  check("a field the sheet never filled is not reported as overwritten",
    !("blNo" in story.imported) || story.imported.blNo === null,
    String(story.imported.blNo));
  check("the history knows the record came from an upload",
    story.entries.every((e) => e.recordSource === "EXCEL"));

  const reread = await loadInvoice(imported.id);
  check("and the typed-in BL date now drives the due date",
    reread.invoice?.schedule.dueDate === "2026-09-27",
    String(reread.invoice?.schedule.dueDate));

  await prisma.ptInvoice.delete({ where: { id: imported.id } });
  await prisma.ptCustomer.delete({ where: { id: customer.id } });
  check("the history went with the record",
    (await prisma.ptFieldEdit.count({ where: { invoiceId: imported.id } })) === 0);
}

/** Row counts for every Accounts Register table, for the independence check. */
async function registerCounts(): Promise<Record<string, number>> {
  const [invoices, documents, receipts, notes, edits, rules, parts, settings, logs] =
    await Promise.all([
      prisma.invoice.count(),
      prisma.invoiceDocument.count(),
      prisma.receipt.count(),
      prisma.creditDebitNote.count(),
      prisma.fieldEdit.count(),
      prisma.paymentTermRule.count(),
      prisma.paymentTermPart.count(),
      prisma.appSetting.count(),
      prisma.importLog.count(),
    ]);
  return {
    "register invoices": invoices,
    "stored files": documents,
    "register receipts": receipts,
    "credit / debit notes": notes,
    "field corrections": edits,
    "payment-term rules": rules,
    "payment-term parts": parts,
    "settings": settings,
    "import log": logs,
  };
}

main()
  .catch((error) => {
    console.error("\nVerification failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
