/**
 * The Accounts register.
 *
 * The column set is not fixed: invoice columns through Currency, then one
 * five-column group per receipt recorded against the invoice, then the agreed
 * trailing columns. Adding a receipt widens the table by five columns without
 * anything here changing.
 *
 * Columns that cannot come from the commercial invoice are present and clearly
 * marked as awaiting their source, so the sheet already has the shape the team
 * needs and later phases only fill in numbers.
 */
import { HOME_CURRENCY } from "../config";
import { daysBetween, formatDate, round2, todayIso } from "../extraction/text";
import { FieldStatus } from "../extraction/types";
import {
  fieldNumber,
  fieldString,
  fieldValue,
  type NormalizedInvoice,
} from "../normalize/normalizer";
import { blockers, type Quality } from "../normalize/validators";
import type { Instalment } from "./instalments";
import {
  computeDueSchedule,
  overdueDays,
  paymentStatus,
  STATUS_LABELS,
  type DueBasisKey,
  type InvoiceStatusKey,
  type PaymentTermRule,
} from "./rules";

// ---------------------------------------------------------------------------
// TEMPORARY ASSUMPTION — until Tally is connected
//
//   Customer Invoice Value = the invoice total read off the commercial invoice
//
// "Customs / Books Value" and "Balance as per Books" are deliberately NOT
// assumed — they come from Tally and are reported as awaiting that source.
//
// Balance as per Customer is no longer an assumption: it follows the company's
// formula, Invoice Value − Receipts − CN + DN, from the receipts and notes
// actually recorded. With none recorded it equals the invoice value, which is
// the correct answer rather than a guess.
//
// To change this, edit this one block. Every cell it produces carries a note
// saying so, visible on hover in the register and on the invoice screen.
// ---------------------------------------------------------------------------
export const ASSUMPTIONS = {
  customerInvoiceValueEqualsInvoiceTotal: true,
  note: "Temporary Phase-1 assumption: the customer invoice value is taken from the invoice total. It will come from its own source once Tally and the customer statement are connected.",
} as const;

/**
 * Bumped whenever the register's column set or the meaning of a stored cell
 * changes. A row saved under an older version is rebuilt from the stored
 * extraction rather than rendered with gaps — see server/registerRows.ts.
 */
export const ROW_VERSION = 8;

export type CellKind = "text" | "num" | "money" | "date" | "status";

export interface AccountsColumn {
  key: string;
  label: string;
  kind: CellKind;
  /** Where this column's value comes from — shown in the register legend. */
  origin: "invoice" | "assumed" | "tally" | "shipping" | "receipt" | "calculated" | "system";
  /** Set on the five columns that belong to one receipt, so they can be grouped. */
  receiptNo?: number;
}

/** Everything up to and including Currency. */
const LEADING_COLUMNS: AccountsColumn[] = [
  { key: "slNo", label: "Sl. No.", kind: "num", origin: "system" },
  { key: "invoiceDate", label: "Invoice Date", kind: "date", origin: "invoice" },
  { key: "invoiceNo", label: "Invoice No.", kind: "text", origin: "invoice" },
  { key: "customerInvoiceValue", label: "Customer Invoice Value", kind: "money", origin: "assumed" },
  { key: "customsInvoiceValue", label: "Customs Value / As per Books", kind: "money", origin: "tally" },
  { key: "exchangeRate", label: "Exchange Rate", kind: "num", origin: "invoice" },
  { key: "consigneeName", label: "Consignee", kind: "text", origin: "invoice" },
  { key: "notifyPartyName", label: "Notify Party", kind: "text", origin: "invoice" },
  { key: "paymentTerms", label: "Payment Terms", kind: "text", origin: "invoice" },
  { key: "currency", label: "Currency", kind: "text", origin: "invoice" },
];

/** Everything after the last receipt, in the order Accounts asked for. */
const TRAILING_COLUMNS: AccountsColumn[] = [
  { key: "creditNote", label: "Credit Note (CN)", kind: "money", origin: "receipt" },
  { key: "debitNote", label: "Debit Note (DN)", kind: "money", origin: "receipt" },
  { key: "balanceAsPerBooks", label: "Balance as per Books", kind: "money", origin: "tally" },
  { key: "balanceAsPerCustomer", label: "Balance as per Customer", kind: "money", origin: "calculated" },
  { key: "status", label: "Status", kind: "status", origin: "calculated" },
  { key: "piNo", label: "PI / PO No.", kind: "text", origin: "invoice" },
  { key: "poNo", label: "PO No.", kind: "text", origin: "invoice" },
  { key: "shippingBillNo", label: "Shipping Bill No.", kind: "text", origin: "shipping" },
  { key: "shippingBillDate", label: "Shipping Bill Date", kind: "date", origin: "shipping" },
  { key: "blNo", label: "BL No.", kind: "text", origin: "shipping" },
  { key: "blDate", label: "BL Date", kind: "date", origin: "shipping" },
  { key: "containerNo", label: "Container No.", kind: "text", origin: "invoice" },
  { key: "eta", label: "ETA / Arrival Date", kind: "date", origin: "shipping" },
  { key: "dueDate", label: "Due Date", kind: "date", origin: "calculated" },
  { key: "todayDate", label: "TODAY", kind: "date", origin: "system" },
  { key: "overdueDays", label: "Overdue Days", kind: "num", origin: "calculated" },
];

/** The five columns that make up one receipt. */
export function receiptColumns(no: number): AccountsColumn[] {
  return [
    { key: `receipt${no}Date`, label: `Receipt ${no} Date`, kind: "date", origin: "receipt", receiptNo: no },
    { key: `receipt${no}Fcy`, label: `Receipt ${no} FCY`, kind: "money", origin: "receipt", receiptNo: no },
    { key: `receipt${no}Rate`, label: `Exchange Rate for Receipt ${no}`, kind: "num", origin: "receipt", receiptNo: no },
    { key: `receipt${no}Diff`, label: `Difference ${no}`, kind: "num", origin: "calculated", receiptNo: no },
    { key: `receipt${no}Forex`, label: `Forex Gain/Loss ${no}`, kind: "money", origin: "calculated", receiptNo: no },
  ];
}

/** Receipt 1 is always shown, even before any receipt exists. */
export const MIN_RECEIPT_SLOTS = 1;

/**
 * The register's columns for a given number of receipt slots.
 *
 * Invoice columns through Currency, then one five-column group per receipt, then
 * the agreed trailing columns. Slots follow the data: an invoice with three
 * receipts makes the table show three groups, and adding a receipt adds a group
 * without anything here changing.
 */
export function buildColumns(receiptSlots: number = MIN_RECEIPT_SLOTS): AccountsColumn[] {
  const slots = Math.max(MIN_RECEIPT_SLOTS, Math.floor(receiptSlots) || MIN_RECEIPT_SLOTS);
  const receipts: AccountsColumn[] = [];
  for (let i = 1; i <= slots; i += 1) receipts.push(...receiptColumns(i));
  return [...LEADING_COLUMNS, ...receipts, ...TRAILING_COLUMNS];
}

/** The columns for a single receipt slot — what the detail screen and tests use. */
export const ACCOUNTS_VIEW: AccountsColumn[] = buildColumns(MIN_RECEIPT_SLOTS);

export const ORIGIN_LABEL: Record<AccountsColumn["origin"], string> = {
  invoice: "Read from the commercial invoice",
  assumed: "Temporary assumption — invoice total",
  tally: "Awaiting Tally",
  shipping: "Awaiting the shipping team",
  receipt: "Entered or imported with the receipt",
  calculated: "Calculated",
  system: "Generated by the system",
};

/** Columns whose value is read straight out of the catalogue by the same key. */
const DIRECT_KEYS = new Set([
  "invoiceDate", "invoiceNo", "exchangeRate", "consigneeName", "notifyPartyName",
  "paymentTerms", "currency", "blNo", "blDate", "containerNo", "eta",
  "piNo", "poNo", "shippingBillNo", "shippingBillDate",
]);

/** Recomputed on every render because they move with the calendar. */
const VOLATILE_KEYS = ["todayDate", "overdueDays", "status"] as const;

export interface Cell {
  value: string | number | null;
  display: string;
  status: FieldStatus;
  note: string | null;
  source: string | null;
  /**
   * The complete text, where `display` is deliberately the short form. The
   * register table shows the short form so the columns stay readable; the Excel
   * and CSV exports write this, so nothing leaves the system half-said.
   */
  full?: string | null;
}

/**
 * Columns whose register cell shows one line but whose invoice block runs to
 * several — the consignee and notify-party addresses. The keys are joined, in
 * order, into the exported value.
 */
const FULL_TEXT_PARTS: Record<string, string[]> = {
  consigneeName: ["consigneeName", "consigneeAddress", "consigneeContact"],
  notifyPartyName: ["notifyPartyName", "notifyPartyAddress", "notifyPartyContact"],
};

export type AccountsRow = Record<string, Cell>;

/**
 * One receipt against an invoice, however it arrived.
 *
 * Manual entry and document import produce the same shape on purpose: only
 * `source` differs, so nothing downstream has to know which it was.
 */
export interface ReceiptInput {
  seq: number;
  /** Amount in the invoice's own currency — the FCY figure. */
  amount: number;
  receiptDate?: string | null;
  /** The rate on the day the money was received, not the invoice's rate. */
  exchangeRate?: number | null;
  bankRef?: string | null;
  /**
   * What the payment advice said about this receipt — which invoices one
   * remittance was split across, most often. Carried here so the edit form can
   * show it: a field an edit form does not show is a field an edit can destroy.
   */
  remarks?: string | null;
  source?: string | null;
}

/** A credit or debit note against an invoice. */
export interface NoteInput {
  noteType: "CREDIT" | "DEBIT";
  amount: number;
  noteNo?: string | null;
  noteDate?: string | null;
}

export interface ReceiptMaths {
  /** Receipt rate − invoice rate. Null until both rates are known. */
  difference: number | null;
  /** Difference × FCY amount. Positive is a gain, negative a loss. */
  forex: number | null;
}

/**
 * The two per-receipt figures, in one place so the register, the invoice screen
 * and the exports can never disagree about them.
 *
 *   Difference      = Receipt Exchange Rate − Invoice Exchange Rate
 *   Forex Gain/Loss = Difference × Receipt FCY
 */
export function receiptMaths(
  receipt: Pick<ReceiptInput, "amount" | "exchangeRate">,
  invoiceRate: number | null,
): ReceiptMaths {
  const rate = receipt.exchangeRate ?? null;
  if (rate === null || invoiceRate === null) return { difference: null, forex: null };
  const difference = round2(rate - invoiceRate);
  const amount = receipt.amount ?? null;
  return {
    difference,
    forex: amount === null ? null : round2(difference * amount),
  };
}

export function totalReceipts(receipts: ReceiptInput[]): number {
  return round2(receipts.reduce((sum, r) => sum + (r.amount ?? 0), 0));
}

export function totalNotes(notes: NoteInput[], type: NoteInput["noteType"]): number {
  return round2(
    notes.filter((n) => n.noteType === type).reduce((sum, n) => sum + (n.amount ?? 0), 0),
  );
}

/**
 * The company's balance formula:
 *
 *   Balance = Invoice Value − Total Receipts − CN + DN
 *
 * Never typed in. It follows from the receipts and notes recorded against the
 * invoice, so adding a receipt or a note moves it on its own.
 */
export function balanceFrom(
  invoiceValue: number,
  receipts: ReceiptInput[],
  notes: NoteInput[],
): number {
  return round2(
    invoiceValue - totalReceipts(receipts) - totalNotes(notes, "CREDIT") + totalNotes(notes, "DEBIT"),
  );
}

function money(value: number): string {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatCell(value: unknown, kind: CellKind): string {
  if (value === null || value === undefined || value === "") return "";
  if (kind === "date") return formatDate(String(value));
  if (kind === "money") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? money(n) : String(value);
  }
  if (kind === "num") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return String(value);
    return n % 1 === 0
      ? n.toLocaleString("en-IN")
      : n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
  }
  return String(value);
}

function cell(
  value: string | number | null,
  kind: CellKind,
  status: FieldStatus,
  note: string | null = null,
  source: string | null = null,
): Cell {
  return { value, display: formatCell(value, kind), status, note, source };
}

function kindOf(key: string): CellKind {
  return ACCOUNTS_VIEW.find((c) => c.key === key)?.kind ?? "text";
}

export function buildAccountsRow(
  n: NormalizedInvoice,
  quality: Quality,
  opts: {
    slNo?: number;
    receipts?: ReceiptInput[];
    notes?: NoteInput[];
    /** How many receipt column groups to fill. Defaults to what the data needs. */
    receiptSlots?: number;
    rules?: PaymentTermRule[];
    today?: string;
    /** Settings: how early "Due" starts. Defaults to the built-in window. */
    dueSoonDays?: number;
  } = {},
): AccountsRow {
  const slNo = opts.slNo ?? 1;
  const receipts = [...(opts.receipts ?? [])].sort((a, b) => a.seq - b.seq);
  const notes = opts.notes ?? [];
  const rules = opts.rules ?? [];
  const today = opts.today ?? todayIso();
  const slots = Math.max(MIN_RECEIPT_SLOTS, opts.receiptSlots ?? receipts.length);
  const row: AccountsRow = {};

  // ---- 1. straight from the invoice
  for (const key of DIRECT_KEYS) {
    const f = n.fields[key];
    row[key] = f
      ? cell(f.value, kindOf(key), f.status, f.note ?? null, f.source ?? null)
      : cell(null, kindOf(key), FieldStatus.NOT_PRESENT, "Not part of this document.");
  }

  // the party columns print the name on screen and the whole block on export
  for (const [key, parts] of Object.entries(FULL_TEXT_PARTS)) {
    const target = row[key];
    if (!target || target.value === null) continue;
    const text = parts
      .map((p) => fieldString(n, p))
      .filter((v): v is string => !!v && v.trim() !== "")
      .join(", ");
    if (text && text !== target.display) target.full = text;
  }

  row.slNo = cell(slNo, "num", FieldStatus.CALCULATED, "Register row number.");

  // ---- 2. the money columns
  const invoiceTotal = fieldNumber(n, "invoiceValue");
  const invoiceValueField = n.fields.invoiceValue;
  const currency = fieldString(n, "currency") ?? "";

  if (invoiceTotal !== null && ASSUMPTIONS.customerInvoiceValueEqualsInvoiceTotal) {
    row.customerInvoiceValue = cell(
      invoiceTotal,
      "money",
      FieldStatus.CALCULATED,
      `${money(invoiceTotal)} ${currency}`.trim() + ` — ${ASSUMPTIONS.note}`,
      invoiceValueField?.source ?? null,
    );
  } else {
    row.customerInvoiceValue = cell(
      invoiceTotal,
      "money",
      invoiceValueField?.status ?? FieldStatus.MISSING,
      invoiceValueField?.note ?? "Invoice total could not be read.",
      invoiceValueField?.source ?? null,
    );
  }

  // ---- 2a. the books figure, and the difference against the invoice
  //
  // This is Tally's number, never the invoice's. Until Tally is connected — or
  // someone types the voucher value in — it says so rather than showing a copy
  // of the invoice total, because the whole point of the column is to disagree
  // with the invoice when the books disagree.
  const booksValue = fieldNumber(n, "booksValue");
  const booksField = n.fields.booksValue;
  const PENDING_TALLY = "Pending Tally / e-Invoice data — not on the commercial invoice.";

  if (booksValue === null) {
    row.customsInvoiceValue = cell(null, "money", FieldStatus.NOT_PRESENT, PENDING_TALLY);
    row.customsInvoiceValue.display = "Pending Tally";
  } else {
    row.customsInvoiceValue = cell(
      booksValue,
      "money",
      booksField?.status ?? FieldStatus.EXTRACTED,
      `Tally sales voucher value${
        invoiceTotal === null
          ? ""
          : `. Invoice ${money(invoiceTotal)} − books ${money(booksValue)} = ${money(
              round2(invoiceTotal - booksValue),
            )}`
      }`,
      booksField?.source ?? null,
    );
  }

  /** Invoice value less books value — blank until Tally gives the books figure. */
  const booksDifference =
    invoiceTotal === null || booksValue === null ? null : round2(invoiceTotal - booksValue);

  // ---- 2b. receipts, one five-column group each
  const invoiceRate = fieldNumber(n, "exchangeRate");
  for (let i = 1; i <= slots; i += 1) {
    const r = receipts.find((x) => x.seq === i) ?? null;
    const keys = {
      date: `receipt${i}Date`,
      fcy: `receipt${i}Fcy`,
      rate: `receipt${i}Rate`,
      diff: `receipt${i}Diff`,
      forex: `receipt${i}Forex`,
    };

    if (!r) {
      const waiting = i === 1 ? "No receipt recorded against this invoice yet." : `No receipt ${i} yet.`;
      for (const key of Object.values(keys)) {
        row[key] = cell(null, kindOf(key), FieldStatus.NOT_PRESENT, waiting);
      }
      continue;
    }

    const src = r.source ?? null;
    row[keys.date] = r.receiptDate
      ? cell(r.receiptDate, "date", FieldStatus.EXTRACTED, null, src)
      : cell(null, "date", FieldStatus.MISSING, "Receipt date not recorded.", src);
    row[keys.fcy] = cell(
      r.amount,
      "money",
      FieldStatus.EXTRACTED,
      `${money(r.amount)} ${currency}`.trim(),
      src,
    );

    const { difference, forex } = receiptMaths(r, invoiceRate);
    if (r.exchangeRate === null || r.exchangeRate === undefined) {
      row[keys.rate] = cell(null, "num", FieldStatus.MISSING, "Receipt exchange rate not recorded.", src);
    } else {
      row[keys.rate] = cell(r.exchangeRate, "num", FieldStatus.EXTRACTED, null, src);
    }

    if (difference === null) {
      const why =
        invoiceRate === null
          ? "The invoice has no exchange rate, so the difference cannot be worked out."
          : "Enter the receipt's exchange rate to get the difference.";
      row[keys.diff] = cell(null, "num", FieldStatus.MISSING, why);
      row[keys.forex] = cell(null, "money", FieldStatus.MISSING, why);
      continue;
    }

    row[keys.diff] = cell(
      difference,
      "num",
      FieldStatus.CALCULATED,
      `Receipt rate ${r.exchangeRate} − invoice rate ${invoiceRate} = ${difference}.`,
    );
    row[keys.forex] = cell(
      forex,
      "money",
      FieldStatus.CALCULATED,
      forex === null
        ? null
        : `${difference} × ${money(r.amount)} = ${money(forex)} — ${forex >= 0 ? "gain" : "loss"}.`,
    );
  }

  // ---- 2c. credit and debit notes
  const cn = totalNotes(notes, "CREDIT");
  const dn = totalNotes(notes, "DEBIT");
  const noteCell = (total: number, type: NoteInput["noteType"], label: string) => {
    const count = notes.filter((x) => x.noteType === type).length;
    return count === 0
      ? cell(null, "money", FieldStatus.NOT_PRESENT, `No ${label} recorded against this invoice.`)
      : cell(total, "money", FieldStatus.EXTRACTED, `${count} ${label}(s) totalling ${money(total)}.`);
  };
  row.creditNote = noteCell(cn, "CREDIT", "credit note");
  row.debitNote = noteCell(dn, "DEBIT", "debit note");

  // ---- 2d. the balance, from the company's formula — never typed in
  // the same formula as the customer balance, on Tally's figure — the moment
  // that figure exists, and not a moment before
  if (booksValue === null) {
    row.balanceAsPerBooks = cell(
      null,
      "money",
      FieldStatus.NOT_PRESENT,
      "Pending Tally / e-Invoice data. Once the books value exists, the same formula runs on it: Books Value − Receipts − CN + DN.",
    );
    row.balanceAsPerBooks.display = "Pending Tally";
  } else {
    const booksBalance = balanceFrom(booksValue, receipts, notes);
    row.balanceAsPerBooks = cell(
      booksBalance,
      "money",
      FieldStatus.CALCULATED,
      `${money(booksValue)} books − ${money(totalReceipts(receipts))} receipts − ${money(
        totalNotes(notes, "CREDIT"),
      )} CN + ${money(totalNotes(notes, "DEBIT"))} DN = ${money(booksBalance)}.`,
      booksField?.source ?? null,
    );
  }

  if (invoiceTotal !== null) {
    const received = totalReceipts(receipts);
    const balance = balanceFrom(invoiceTotal, receipts, notes);
    const worked = `${money(invoiceTotal)} − ${money(received)} receipts − ${money(cn)} CN + ${money(dn)} DN = ${money(balance)}.`;
    row.balanceAsPerCustomer = cell(
      balance,
      "money",
      FieldStatus.CALCULATED,
      receipts.length || notes.length
        ? worked
        : `${worked} ${ASSUMPTIONS.note}`,
      invoiceValueField?.source ?? null,
    );
  } else {
    row.balanceAsPerCustomer = cell(
      null,
      "money",
      FieldStatus.MISSING,
      "The invoice value could not be read, so the balance cannot be worked out.",
    );
  }

  // ---- 3. due date (only when a configured rule allows it)
  const basisDates: Partial<Record<DueBasisKey, string | null>> = {
    INVOICE_DATE: fieldString(n, "invoiceDate"),
    BL_DATE: fieldString(n, "blDate"),
    SHIPPING_BILL_DATE: fieldString(n, "shippingBillDate"),
    ETA: fieldString(n, "eta"),
  };
  // a split term ("70% CAD, balance 30% at 90 days") falls due in pieces, so the
  // due date is the next piece that still owes money and moves on its own as
  // receipts arrive. A one-part term produces exactly the same date and wording
  // it always has.
  const { dueDate, explanation, schedule } = computeDueSchedule({
    paymentTerms: fieldString(n, "paymentTerms"),
    basisDates,
    rules,
    invoiceValue: invoiceTotal,
    settled: settledAmount(receipts, notes),
    today,
  });
  if (dueDate) {
    row.dueDate = cell(dueDate, "date", FieldStatus.CALCULATED, explanation);
  } else {
    // never guessed from a payment term. The cell says what it is waiting for
    // rather than sitting blank, so nobody reads a blank as "no credit period".
    row.dueDate = cell(null, "date", FieldStatus.NEEDS_VERIFICATION, explanation);
    row.dueDate.display = "Pending / requires verification";
  }

  // ---- 4. calendar-dependent columns
  applyVolatileCells(row, today);

  // ---- 5. status: a register column, and what the filters and dashboard use
  const status = resolveStatus(invoiceTotal, receipts, notes, dueDate, quality, today, {
    overdueAmount: schedule.split ? schedule.overdueAmount : null,
    dueSoonDays: opts.dueSoonDays,
  });
  row.status = {
    value: status,
    display: STATUS_LABELS[status],
    status: FieldStatus.CALCULATED,
    note: statusNote(status, invoiceTotal, receipts, notes, dueDate, today),
    source: null,
  };
  row.dataQuality = cell(
    quality.accountsPct,
    "text",
    FieldStatus.CALCULATED,
    `${quality.criticalFound}/${quality.criticalTotal} critical fields captured.`,
  );
  row.dataQuality.display = `${quality.accountsPct}% of invoice fields`;
  // kept off the register (its 16 trailing columns are fixed) but stored, so the
  // invoice screen and the Tally reconciliation can show it
  row.booksDifference =
    booksDifference === null
      ? cell(null, "money", FieldStatus.NOT_PRESENT, PENDING_TALLY)
      : cell(
          booksDifference,
          "money",
          FieldStatus.CALCULATED,
          `Invoice ${money(invoiceTotal ?? 0)} − books ${money(booksValue ?? 0)}. ${
            Math.abs(booksDifference) <= 0.01
              ? "The invoice and the books agree."
              : "The invoice and the books disagree — worth checking before reconciliation."
          }`,
        );

  // the instalment plan, kept on the row (not as a register column) so a stored
  // row can work out for itself what is past due as the calendar moves — see
  // applyVolatileCells. A one-part term stores one portion; the cell is the only
  // thing that makes a split term legible after a page reload.
  row.instalmentPlan = cell(
    encodeInstalments(schedule.instalments),
    "text",
    FieldStatus.CALCULATED,
    schedule.instalments.length > 1
      ? `This invoice falls due in ${schedule.instalments.length} portions.`
      : "This invoice falls due in one portion.",
  );
  row.instalmentPlan.display = schedule.split
    ? schedule.instalments
        .map((i) => `${i.percent}% ${i.dueDate ?? "pending"}`)
        .join(", ")
    : "Single portion";

  row.rowVersion = cell(ROW_VERSION, "num", FieldStatus.CALCULATED, "Register row format version.");

  return row;
}

/**
 * True when a stored row was built by the current column set — including enough
 * receipt groups for what this register is showing. A row from an earlier
 * version, or one built when the invoice had fewer receipts, would render with
 * blank columns, so callers rebuild it.
 */
export function isRowCurrent(
  row: AccountsRow | null | undefined,
  receiptSlots: number = MIN_RECEIPT_SLOTS,
): boolean {
  if (!row) return false;
  if (Number(row.rowVersion?.value) !== ROW_VERSION) return false;
  return buildColumns(receiptSlots).every((c) => c.key in row);
}

/** What the customer no longer owes: money in, plus credit notes, less debit notes. */
export function settledAmount(receipts: ReceiptInput[], notes: NoteInput[]): number {
  return round2(totalReceipts(receipts) + totalNotes(notes, "CREDIT") - totalNotes(notes, "DEBIT"));
}

function resolveStatus(
  invoiceTotal: number | null,
  receipts: ReceiptInput[],
  notes: NoteInput[],
  dueDate: string | null,
  quality: Quality,
  today: string,
  opts: { overdueAmount?: number | null; dueSoonDays?: number } = {},
): InvoiceStatusKey {
  const status = paymentStatus(invoiceTotal, settledAmount(receipts, notes), dueDate, today, opts);
  // a figure the invoice itself is missing makes the whole status untrustworthy;
  // a field that merely needs confirming does not, and is reported on its own
  return blockers(quality).length ? "MISSING_INFORMATION" : status;
}

/** Why the status says what it says — shown on hover in the register. */
function statusNote(
  status: InvoiceStatusKey,
  invoiceTotal: number | null,
  receipts: ReceiptInput[],
  notes: NoteInput[],
  dueDate: string | null,
  today: string,
): string {
  if (status === "MISSING_INFORMATION") {
    return "Something the invoice should carry could not be read, so the payment position cannot be trusted yet.";
  }
  if (invoiceTotal === null) return "No invoice value, so there is nothing to measure against.";

  const settled = settledAmount(receipts, notes);
  const outstanding = round2(invoiceTotal - settled);
  const parts: string[] = [];

  parts.push(
    receipts.length
      ? `${money(settled)} of ${money(invoiceTotal)} settled across ${receipts.length} receipt(s)`
      : `Nothing received against ${money(invoiceTotal)}`,
  );
  if (notes.length) {
    parts.push(
      `including ${money(totalNotes(notes, "CREDIT"))} CN and ${money(totalNotes(notes, "DEBIT"))} DN`,
    );
  }
  if (outstanding > 0.01) parts.push(`${money(outstanding)} outstanding`);

  if (!dueDate) {
    parts.push("no due date yet — add a payment-term rule in Settings");
  } else {
    const late = overdueDays(dueDate, today) ?? 0;
    parts.push(late > 0 ? `${late} day(s) past the due date ${dueDate}` : `due ${dueDate}`);
  }
  return `${parts.join(", ")}.`;
}

/**
 * The instalment plan as one short string, for storage on the register row.
 *
 *   "70:2024-01-10:70000|30:2024-04-09:30000"
 *
 * A portion with no due date yet writes an empty middle field. Kept this plain
 * on purpose: it is read back by `applyVolatileCells` on every render, and a
 * format that cannot be eyeballed in a database browser is a format nobody can
 * debug at five o'clock on a Friday.
 */
export function encodeInstalments(
  instalments: Pick<Instalment, "percent" | "dueDate" | "amount">[],
): string {
  return instalments
    .map((i) => `${i.percent}:${i.dueDate ?? ""}:${i.amount}`)
    .join("|");
}

export function decodeInstalments(
  raw: unknown,
): { percent: number; dueDate: string | null; amount: number }[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const out: { percent: number; dueDate: string | null; amount: number }[] = [];
  for (const piece of raw.split("|")) {
    const [percent, dueDate, amount] = piece.split(":");
    const p = Number(percent);
    const a = Number(amount);
    if (!Number.isFinite(p) || !Number.isFinite(a)) continue;
    out.push({ percent: p, dueDate: dueDate || null, amount: a });
  }
  return out;
}

/**
 * How much of what is still owed is past due, from the stored plan.
 *
 * Money settles against the earliest portion first — the same rule the schedule
 * uses — so this walks the portions in order, spends the settled amount, and
 * counts what is left against portions whose date has gone.
 */
function overdueFromPlan(
  plan: { percent: number; dueDate: string | null; amount: number }[],
  settled: number,
  today: string,
): number {
  let left = Math.max(0, settled);
  let late = 0;
  for (const part of plan) {
    const applied = Math.min(left, part.amount);
    left = round2(left - applied);
    const owing = round2(part.amount - applied);
    if (owing > 0.01 && part.dueDate && part.dueDate < today) late = round2(late + owing);
  }
  return late;
}

/**
 * How much of an invoice's balance is past due, from its stored row.
 *
 * The one place that question is answered outside the schedule itself, so the
 * register, the reports and the follow-up section cannot drift apart on it. A
 * row stored before split terms existed has no plan, and then the answer is the
 * straightforward one: all of it, if the single due date has gone.
 */
export function overdueAmountOf(
  row: AccountsRow,
  args: { settled: number; outstanding: number; dueDate: string | null; today: string },
): { amount: number; split: boolean } {
  const plan = decodeInstalments(row.instalmentPlan?.value);
  if (plan.length > 1) {
    return { amount: overdueFromPlan(plan, args.settled, args.today), split: true };
  }
  const late = Boolean(args.dueDate && args.dueDate < args.today);
  return {
    amount: late && args.outstanding > 0.01 ? round2(args.outstanding) : 0,
    split: false,
  };
}

/**
 * The cells that move with the calendar, recomputed on every render.
 *
 * "Today's Date" and "Overdue Days" obviously change by themselves. So does the
 * **status**: an invoice that was Not Due last night is Overdue this morning
 * without anybody touching it. It used to be written once when the row was built
 * and then left alone, which meant the register could say Not Due while the
 * reports — which recompute live — said Overdue about the same invoice. One of
 * them had to be wrong, and a register that disagrees with its own reports is
 * worse than either answer.
 *
 * So the status is worked out here too, from figures already on the row: the
 * invoice value, the balance, the due date and the stored instalment plan. A
 * status of Missing Information is left alone, because that comes from a field
 * the invoice never carried and no amount of waiting will change it.
 */
export function applyVolatileCells(
  row: AccountsRow,
  today: string = todayIso(),
  opts: { dueSoonDays?: number } = {},
): AccountsRow {
  row.todayDate = cell(today, "date", FieldStatus.CALCULATED, "System date.");

  const due = typeof row.dueDate?.value === "string" ? row.dueDate.value : null;
  if (!due) {
    row.overdueDays = cell(
      null,
      "num",
      FieldStatus.NEEDS_VERIFICATION,
      row.dueDate?.note ?? "No due date yet, so overdue days cannot be worked out.",
    );
    row.overdueDays.display = "Pending";
    refreshStatus(row, today, null, opts);
    return row;
  }

  const days = overdueDays(due, today) ?? 0;
  const toGo = Math.abs(daysBetween(today, due));
  row.overdueDays = cell(
    days,
    "num",
    FieldStatus.CALCULATED,
    days > 0
      ? `${today} is ${days} day(s) past the due date ${due}.`
      : `Not yet due — ${toGo} day(s) to go.`,
  );
  // zero is the right number to sum and sort on, but "0" reads like a problem
  // that has just started; say plainly that nothing is overdue yet
  if (days === 0) row.overdueDays.display = `Not due (${toGo}d)`;

  refreshStatus(row, today, due, opts);
  return row;
}

/** Re-run the status engine on a stored row. Silent when the row cannot say. */
function refreshStatus(
  row: AccountsRow,
  today: string,
  due: string | null,
  opts: { dueSoonDays?: number },
): void {
  if (!row.status) return;
  // a missing figure on the invoice is not something tomorrow will fix
  if (row.status.value === "MISSING_INFORMATION") return;

  const invoiceValue = numberOf(row.customerInvoiceValue?.value);
  const outstanding = numberOf(row.balanceAsPerCustomer?.value);
  if (invoiceValue === null || outstanding === null) return;

  const settled = round2(invoiceValue - outstanding);
  const plan = decodeInstalments(row.instalmentPlan?.value);
  const overdueAmount =
    plan.length > 1 ? overdueFromPlan(plan, settled, today) : null;

  const status = paymentStatus(invoiceValue, settled, due, today, {
    overdueAmount,
    dueSoonDays: opts.dueSoonDays,
  });
  if (status === row.status.value) return;

  // the stored note described the position on the day the row was built, so it
  // would now contradict the status it is attached to. Replaced, not kept.
  const late = due && due < today ? daysBetween(due, today) : 0;
  const when = !due
    ? "no due date yet"
    : late > 0
      ? `${late} day(s) past the due date ${due}`
      : `due ${due}`;
  const portion =
    overdueAmount !== null && overdueAmount > 0.01
      ? `${money(overdueAmount)} of it is past due`
      : `${money(outstanding)} outstanding`;

  row.status = {
    ...row.status,
    value: status,
    display: STATUS_LABELS[status],
    note: `${money(settled)} of ${money(invoiceValue)} settled, ${portion}, ${when} (as at ${today}).`,
  };
}

function numberOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export { VOLATILE_KEYS };

/** @deprecated pass the receipt slots the data needs — see buildColumns. */
export function visibleColumns(receiptSlots: number = MIN_RECEIPT_SLOTS): AccountsColumn[] {
  return buildColumns(receiptSlots);
}

export function statusValue(row: AccountsRow): InvoiceStatusKey {
  return (row.status?.value as InvoiceStatusKey) ?? "AWAITING_PAYMENT_DATA";
}

export function dueDateValue(row: AccountsRow): string | null {
  const v = row.dueDate?.value;
  return typeof v === "string" ? v : null;
}

export { fieldValue, HOME_CURRENCY };
