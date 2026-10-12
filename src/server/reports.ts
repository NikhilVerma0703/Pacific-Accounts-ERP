/**
 * Reports & MIS.
 *
 * Seven views over one filter set, and — the part that matters — over one source
 * of numbers. Every figure here comes from the stored register row or from
 * `loadReceivables`, which uses the same `balanceFrom` / `receiptMaths` /
 * `paymentStatus` the register and the invoice screen use. A report can be wrong
 * about what it shows, but it cannot disagree with the register about a number.
 *
 * Each report returns plain columns and rows, so the same definition drives the
 * screen and the Excel / CSV export.
 */
import "server-only";

import {
  buildColumns,
  type AccountsColumn,
  type AccountsRow,
} from "@/lib/business/accounts";
import { STATUS_LABELS, type InvoiceStatusKey } from "@/lib/business/rules";
import { HOME_CURRENCY } from "@/lib/config";
import { prisma } from "@/lib/db";
import { BY_KEY } from "@/lib/extraction/catalog";
import { loadReceivables, type InvoiceReceivable } from "@/server/receivables";

export const REPORTS = [
  {
    key: "register",
    label: "Invoice Register",
    blurb: "Every register column, exactly as the register shows it.",
  },
  {
    key: "customer",
    label: "Customer-wise Outstanding",
    blurb:
      "One row per customer: invoiced, received, CN/DN, outstanding, and how much is overdue.",
  },
  {
    key: "receipts",
    label: "Payment / Receipt Report",
    blurb:
      "One row per receipt, with its rate, difference and forex gain or loss.",
  },
  {
    key: "overdue",
    label: "Outstanding & Ageing",
    blurb: "Past the due date, oldest first, with ageing buckets.",
  },
  {
    key: "notes",
    label: "CN / DN Report",
    blurb:
      "Every credit and debit note, with its effect on the invoice balance.",
  },
  {
    key: "shipping",
    label: "Shipping / ETA Report",
    blurb: "Shipping bill, BL, container and ETA against each invoice.",
  },
  {
    key: "currency",
    label: "Currency-wise Summary",
    blurb: "Totals per currency. Currencies are never added together.",
  },
] as const;

export type ReportKey = (typeof REPORTS)[number]["key"];

export const DEFAULT_REPORT: ReportKey = "register";

/**
 * A report's one-line description, by key.
 *
 * Looked up by key rather than by position: these used to be `blurbOf("overdue")`
 * and friends, which meant removing one report silently shifted the description
 * on three others — and broke the build on the last one, which is the only
 * reason it was noticed.
 */
function blurbOf(key: ReportKey): string {
  return REPORTS.find((r) => r.key === key)?.blurb ?? "";
}

export function isReportKey(value: string | undefined): value is ReportKey {
  return !!value && REPORTS.some((r) => r.key === value);
}

export interface ReportFilters {
  report?: string;
  from?: string;
  to?: string;
  customer?: string;
  currency?: string;
  status?: string;
  /** paid | partial | unpaid — the payment state, regardless of due date. */
  paid?: string;
  /** "1" to keep only invoices past their due date. */
  overdue?: string;
  q?: string;
}

export type ReportCellKind = "text" | "num" | "money" | "date" | "status";

export interface ReportColumn {
  key: string;
  label: string;
  kind: ReportCellKind;
}

export type ReportRow = Record<string, string | number | null>;

export interface Report {
  key: ReportKey;
  label: string;
  blurb: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Totals row, where adding up makes sense. */
  totals: ReportRow | null;
  /** Said plainly on screen when a report is showing a subset. */
  note: string;
}

const money = (key: string, label: string): ReportColumn => ({
  key,
  label,
  kind: "money",
});
const text = (key: string, label: string): ReportColumn => ({
  key,
  label,
  kind: "text",
});
const date = (key: string, label: string): ReportColumn => ({
  key,
  label,
  kind: "date",
});
const num = (key: string, label: string): ReportColumn => ({
  key,
  label,
  kind: "num",
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Ageing bucket for an overdue invoice, on the days it is past due. */
export function ageingBucket(days: number): string {
  if (days <= 0) return "Not due";
  if (days <= 30) return "1–30 days";
  if (days <= 60) return "31–60 days";
  if (days <= 90) return "61–90 days";
  return "Over 90 days";
}

/** The payment state, independent of the due date. */
function paidState(r: InvoiceReceivable): "paid" | "partial" | "unpaid" {
  if (r.invoiceValue === null) return "unpaid";
  const settled = round2(r.received + r.creditNotes - r.debitNotes);
  if (round2(r.invoiceValue - settled) <= 0.01) return "paid";
  return settled > 0 ? "partial" : "unpaid";
}

function overdueDaysOf(r: InvoiceReceivable, today: string): number {
  if (!r.dueDate || r.dueDate >= today) return 0;
  return Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.dueDate}T00:00:00Z`)) /
      86400000,
  );
}

/** Apply the filters that cannot be pushed into the database query. */
function applyFilters(
  rows: InvoiceReceivable[],
  filters: ReportFilters,
  today: string,
): InvoiceReceivable[] {
  return rows.filter((r) => {
    if (filters.from && (!r.invoiceDate || r.invoiceDate < filters.from))
      return false;
    if (filters.to && (!r.invoiceDate || r.invoiceDate > filters.to))
      return false;
    if (filters.customer && (r.customerName ?? "") !== filters.customer)
      return false;
    if (filters.paid && paidState(r) !== filters.paid) return false;
    if (filters.overdue === "1" && overdueDaysOf(r, today) <= 0) return false;
    return true;
  });
}

function registerReport(rows: InvoiceReceivable[]): Report {
  // the register row already came with each receivable — no second query
  const byId = new Map(rows.map((r) => [r.invoiceId, r.row]));

  // however many receipt groups the widest invoice needs
  const slots = rows.reduce((max, r) => Math.max(max, r.receipts.length), 1);
  const columns: AccountsColumn[] = buildColumns(slots);

  const out: ReportRow[] = rows.map((r, index) => {
    const row = byId.get(r.invoiceId) ?? ({} as AccountsRow);
    const line: ReportRow = {};
    for (const c of columns) {
      const cell = row[c.key];
      // the exported value, so a party column carries its whole block
      line[c.key] = cell?.full ?? cell?.value ?? null;
      if (c.kind === "status" && cell?.value)
        line[c.key] = String(cell.display ?? cell.value);
    }
    line.slNo = index + 1;
    return line;
  });

  return {
    key: "register",
    label: "Invoice Register",
    blurb: blurbOf("register"),
    columns: columns.map((c) => ({ key: c.key, label: c.label, kind: c.kind })),
    rows: out,
    totals: null,
    note: `${rows.length} invoice(s), ${columns.length} columns, ${slots} receipt group(s). Values in different currencies are not added up here — use the currency summary for totals.`,
  };
}

/**
 * One row per customer per currency.
 *
 * Per currency, not per customer alone: a customer invoiced in two currencies
 * appears twice, because the amounts cannot be added together.
 */
function customerReport(rows: InvoiceReceivable[], today: string): Report {
  const groups = new Map<string, ReportRow>();

  for (const r of rows) {
    const key = `${r.customerName ?? "—"}::${r.currency}`;
    const g =
      groups.get(key) ??
      {
        customer: r.customerName ?? "—",
        currency: r.currency,
        invoices: 0,
        invoiceValue: 0,
        received: 0,
        creditNotes: 0,
        debitNotes: 0,
        outstanding: 0,
        overdueInvoices: 0,
        overdueAmount: 0,
        oldestDue: null,
      };

    g.invoices = Number(g.invoices) + 1;
    g.invoiceValue = round2(Number(g.invoiceValue) + (r.invoiceValue ?? 0));
    g.received = round2(Number(g.received) + r.received);
    g.creditNotes = round2(Number(g.creditNotes) + r.creditNotes);
    g.debitNotes = round2(Number(g.debitNotes) + r.debitNotes);
    g.outstanding = round2(Number(g.outstanding) + (r.balance ?? 0));

    const late = r.dueDate !== null && r.dueDate < today && (r.balance ?? 0) > 0.01;
    if (late) {
      g.overdueInvoices = Number(g.overdueInvoices) + 1;
      g.overdueAmount = round2(Number(g.overdueAmount) + (r.balance ?? 0));
      if (!g.oldestDue || String(r.dueDate) < String(g.oldestDue)) g.oldestDue = r.dueDate;
    }
    groups.set(key, g);
  }

  const list = [...groups.values()].sort(
    (a, b) => Number(b.outstanding) - Number(a.outstanding),
  );

  return {
    key: "customer",
    label: "Customer-wise Outstanding",
    blurb: blurbOf("customer"),
    columns: [
      text("customer", "Customer"),
      text("currency", "Currency"),
      num("invoices", "Invoices"),
      money("invoiceValue", "Invoiced"),
      money("received", "Received"),
      money("creditNotes", "CN"),
      money("debitNotes", "DN"),
      money("outstanding", "Outstanding"),
      num("overdueInvoices", "Overdue invoices"),
      money("overdueAmount", "Overdue amount"),
      date("oldestDue", "Oldest due date"),
    ],
    rows: list,
    totals: null,
    note:
      "One row per customer per currency — a customer invoiced in two currencies appears twice, " +
      "because the amounts cannot be added together.",
  };
}

function receiptsReport(rows: InvoiceReceivable[]): Report {
  const out: ReportRow[] = [];
  let received = 0;
  let forex = 0;

  for (const r of rows) {
    for (const rc of r.receipts) {
      out.push({
        invoiceNo: r.invoiceNo,
        customer: r.customerName ?? "",
        currency: r.currency,
        seq: rc.seq,
        receiptDate: rc.receiptDate ?? null,
        amount: rc.amount,
        invoiceRate: r.invoiceRate,
        receiptRate: rc.exchangeRate ?? null,
        difference: rc.difference,
        forex: rc.forex,
        bankRef: rc.bankRef ?? "",
        source: rc.source ?? "",
      });
      received = round2(received + rc.amount);
      forex = round2(forex + (rc.forex ?? 0));
    }
  }

  out.sort((a, b) =>
    String(b.receiptDate ?? "").localeCompare(String(a.receiptDate ?? "")),
  );

  return {
    key: "receipts",
    label: "Payment / Receipt Report",
    blurb: blurbOf("receipts"),
    columns: [
      text("invoiceNo", "Invoice No."),
      text("customer", "Customer"),
      text("currency", "Currency"),
      num("seq", "Receipt #"),
      date("receiptDate", "Receipt Date"),
      money("amount", "Receipt FCY"),
      num("invoiceRate", "Invoice Rate"),
      num("receiptRate", "Receipt Rate"),
      num("difference", "Difference"),
      money("forex", `Forex Gain/Loss (${HOME_CURRENCY})`),
      text("bankRef", "Bank Reference"),
      text("source", "Entered / read from"),
    ],
    rows: out,
    totals: out.length
      ? { receiptDate: "Total", amount: received, forex }
      : null,
    note: `${out.length} receipt(s). Forex gain/loss is each receipt's difference times its amount, so the total is a ${HOME_CURRENCY} figure even though the receipts are not.`,
  };
}

function overdueReport(rows: InvoiceReceivable[], today: string): Report {
  const out: ReportRow[] = rows
    .map((r) => ({ r, days: overdueDaysOf(r, today) }))
    .filter(({ r, days }) => days > 0 && (r.balance ?? 0) > 0.01)
    .sort((a, b) => b.days - a.days)
    .map(({ r, days }) => ({
      invoiceNo: r.invoiceNo,
      customer: r.customerName ?? "",
      currency: r.currency,
      invoiceDate: r.invoiceDate,
      invoiceValue: r.invoiceValue,
      received: r.received,
      outstanding: r.balance,
      dueDate: r.dueDate,
      overdueDays: days,
      bucket: ageingBucket(days),
      status: STATUS_LABELS[r.status],
    }));

  return {
    key: "overdue",
    label: "Outstanding & Ageing",
    blurb: REPORTS[3].blurb,
    columns: [
      text("invoiceNo", "Invoice No."),
      text("customer", "Customer"),
      text("currency", "Currency"),
      date("invoiceDate", "Invoice Date"),
      money("invoiceValue", "Invoice Value"),
      money("received", "Received"),
      money("outstanding", "Outstanding"),
      date("dueDate", "Due Date"),
      num("overdueDays", "Overdue Days"),
      text("bucket", "Ageing"),
      text("status", "Status"),
    ],
    rows: out,
    totals: null,
    note: out.length
      ? "Oldest first. Only invoices with a due date and something still outstanding appear — an invoice with no due-date rule cannot be overdue, it is pending."
      : "Nothing is overdue. An invoice without a configured payment-term rule has no due date, so it cannot appear here — check Settings if you expected something.",
  };
}

function notesReport(rows: InvoiceReceivable[], notes: NoteRecord[]): Report {
  const byInvoice = new Map(rows.map((r) => [r.invoiceId, r]));
  const out: ReportRow[] = [];
  let cn = 0;
  let dn = 0;

  for (const n of notes) {
    const inv = byInvoice.get(n.invoiceId);
    if (!inv) continue;
    out.push({
      noteType: n.noteType === "CREDIT" ? "Credit Note" : "Debit Note",
      noteNo: n.noteNo ?? "",
      noteDate: n.noteDate,
      invoiceNo: inv.invoiceNo,
      customer: inv.customerName ?? "",
      currency: inv.currency,
      amount: n.amount,
      effect: n.noteType === "CREDIT" ? -n.amount : n.amount,
      reason: n.reason ?? "",
      balanceNow: inv.balance,
    });
    if (n.noteType === "CREDIT") cn = round2(cn + n.amount);
    else dn = round2(dn + n.amount);
  }

  out.sort((a, b) =>
    String(b.noteDate ?? "").localeCompare(String(a.noteDate ?? "")),
  );

  return {
    key: "notes",
    label: "CN / DN Report",
    blurb: blurbOf("notes"),
    columns: [
      text("noteType", "Type"),
      text("noteNo", "Note No."),
      date("noteDate", "Date"),
      text("invoiceNo", "Invoice No."),
      text("customer", "Customer"),
      text("currency", "Currency"),
      money("amount", "Amount"),
      money("effect", "Effect on balance"),
      text("reason", "Reason"),
      money("balanceNow", "Invoice balance now"),
    ],
    rows: out,
    totals: out.length
      ? { noteType: "Total", amount: round2(cn + dn), effect: round2(dn - cn) }
      : null,
    note: "A credit note reduces what is owed and a debit note increases it — the balance is Invoice Value − Receipts − CN + DN.",
  };
}

function shippingReport(rows: InvoiceReceivable[]): Report {
  const keys = [
    "piNo",
    "poNo",
    "shippingBillNo",
    "shippingBillDate",
    "blNo",
    "blDate",
    "containerNo",
    "eta",
  ] as const;

  // the register row already came with each receivable — no second query
  const byId = new Map(rows.map((r) => [r.invoiceId, r.row]));

  const out: ReportRow[] = rows.map((r) => {
    const row = byId.get(r.invoiceId) ?? ({} as AccountsRow);
    const line: ReportRow = {
      invoiceNo: r.invoiceNo,
      customer: r.customerName ?? "",
      invoiceDate: r.invoiceDate,
    };
    let waiting = 0;
    for (const k of keys) {
      const v = row[k]?.value ?? null;
      line[k] = v;
      if (v === null || v === "") waiting += 1;
    }
    line.waiting = waiting;
    return line;
  });

  return {
    key: "shipping",
    label: "Shipping / ETA Report",
    blurb: blurbOf("shipping"),
    columns: [
      text("invoiceNo", "Invoice No."),
      text("customer", "Customer"),
      date("invoiceDate", "Invoice Date"),
      ...keys.map((k) => ({
        key: k,
        label: BY_KEY[k]?.label ?? k,
        kind: (BY_KEY[k]?.type === "date" ? "date" : "text") as ReportCellKind,
      })),
      num("waiting", "Fields still waiting"),
    ],
    rows: out,
    totals: null,
    note: "A blank means the shipping team has not supplied it — nothing on this report is ever guessed.",
  };
}

function currencyReport(rows: InvoiceReceivable[], today: string): Report {
  const groups = new Map<string, ReportRow>();

  for (const r of rows) {
    let g = groups.get(r.currency);
    if (!g) {
      g = {
        currency: r.currency,
        invoices: 0,
        invoiceValue: 0,
        received: 0,
        creditNotes: 0,
        debitNotes: 0,
        outstanding: 0,
        forex: 0,
        paid: 0,
        partial: 0,
        unpaid: 0,
        overdue: 0,
      };
      groups.set(r.currency, g);
    }
    g.invoices = Number(g.invoices) + 1;
    g.invoiceValue = round2(Number(g.invoiceValue) + (r.invoiceValue ?? 0));
    g.received = round2(Number(g.received) + r.received);
    g.creditNotes = round2(Number(g.creditNotes) + r.creditNotes);
    g.debitNotes = round2(Number(g.debitNotes) + r.debitNotes);
    g.outstanding = round2(Number(g.outstanding) + (r.balance ?? 0));
    g.forex = round2(Number(g.forex) + r.forexTotal);
    g[paidState(r)] = Number(g[paidState(r)]) + 1;
    if (overdueDaysOf(r, today) > 0) g.overdue = Number(g.overdue) + 1;
  }

  return {
    key: "currency",
    label: "Currency-wise Summary",
    blurb: blurbOf("currency"),
    columns: [
      text("currency", "Currency"),
      num("invoices", "Invoices"),
      money("invoiceValue", "Invoiced"),
      money("received", "Received"),
      money("creditNotes", "CN"),
      money("debitNotes", "DN"),
      money("outstanding", "Outstanding"),
      money("forex", `Forex Gain/Loss (${HOME_CURRENCY})`),
      num("paid", "Paid"),
      num("partial", "Partly paid"),
      num("unpaid", "Unpaid"),
      num("overdue", "Overdue"),
    ],
    rows: [...groups.values()].sort((a, b) =>
      String(a.currency).localeCompare(String(b.currency)),
    ),
    totals: null,
    note: `Only the forex column is a ${HOME_CURRENCY} figure and therefore comparable across rows. The others are in each row's own currency.`,
  };
}

interface NoteRecord {
  invoiceId: string;
  noteType: string;
  noteNo: string | null;
  noteDate: string | null;
  amount: number;
  reason: string | null;
}

export interface ReportResult {
  report: Report;
  /** For the filter dropdowns. */
  customers: string[];
  currencies: string[];
  statuses: InvoiceStatusKey[];
  today: string;
}

export async function buildReport(
  filters: ReportFilters,
): Promise<ReportResult> {
  const key: ReportKey = isReportKey(filters.report)
    ? filters.report
    : DEFAULT_REPORT;

  const { rows: all, today } = await loadReceivables({
    currency: filters.currency,
    status: filters.status,
    q: filters.q,
  });
  const rows = applyFilters(all, filters, today);

  let report: Report;
  switch (key) {
    case "customer":
      report = customerReport(rows, today);
      break;
    case "receipts":
      report = receiptsReport(rows);
      break;
    case "overdue":
      report = overdueReport(rows, today);
      break;
    case "notes": {
      const notes = await prisma.creditDebitNote.findMany({
        where: { invoiceId: { in: rows.map((r) => r.invoiceId) } },
        orderBy: { createdAt: "asc" },
      });
      report = notesReport(
        rows,
        notes.map((n) => ({
          invoiceId: n.invoiceId,
          noteType: n.noteType,
          noteNo: n.noteNo,
          noteDate: n.noteDate ? n.noteDate.toISOString().slice(0, 10) : null,
          amount: Number(n.amount),
          reason: n.reason,
        })),
      );
      break;
    }
    case "shipping":
      report = shippingReport(rows);
      break;
    case "currency":
      report = currencyReport(rows, today);
      break;
    default:
      report = registerReport(rows);
  }

  // dropdown options come from every invoice, not the filtered set, so a filter
  // can always be widened again
  const customers = [
    ...new Set(all.map((r) => r.customerName).filter((c): c is string => !!c)),
  ].sort();
  const currencies = [...new Set(all.map((r) => r.currency))].sort();
  const statuses = [...new Set(all.map((r) => r.status))].sort();

  return { report, customers, currencies, statuses, today };
}
