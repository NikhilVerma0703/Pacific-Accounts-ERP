/**
 * The master table as an exportable workbook.
 *
 * Built from the rows already on screen, so the download is the view that was
 * being looked at. It states its own provenance — the date, the filters, how
 * many invoices had a due date that could be established, and what each
 * calculated column means — because a spreadsheet that leaves the building
 * needs to be able to explain itself without the person who made it.
 */
import "server-only";

import { round2 } from "@/lib/extraction/text";
import { STATUS_LABELS, type TrackedInvoice, type TrackingParams } from "@/lib/payments/record";
import type { TrackingFilters } from "@/server/payments/query";

/**
 * The export's own column and row types.
 *
 * Declared here rather than imported from the register's reporting module, so
 * this section depends on nothing of the register's. They are structurally
 * identical to what the generic workbook writer expects, which is all it needs.
 */
export type ExportCellKind = "text" | "num" | "money" | "date" | "status";

export interface ReportColumn {
  key: string;
  label: string;
  kind: ExportCellKind;
}

export type ReportRow = Record<string, string | number | null>;

/** Every column, in the order the master table shows them. */
const COLUMNS: ReportColumn[] = [
  { key: "slNo", label: "Sl. No.", kind: "num" },
  { key: "customer", label: "Customer Name", kind: "text" },
  { key: "invoiceNo", label: "Invoice No.", kind: "text" },
  { key: "invoiceDate", label: "Invoice Date", kind: "date" },
  { key: "currency", label: "Currency", kind: "text" },
  { key: "customerInvoiceValue", label: "Customer Invoice Value", kind: "money" },
  { key: "customsInvoiceValue", label: "Customs Value / As per Books", kind: "money" },
  { key: "exchangeRate", label: "Invoice Exchange Rate", kind: "num" },
  { key: "homeInvoiceValue", label: "Home Currency Value", kind: "money" },
  { key: "consignee", label: "Consignee", kind: "text" },
  { key: "notifyParty", label: "Notify Party", kind: "text" },
  { key: "country", label: "Country", kind: "text" },

  { key: "paymentTerms", label: "Payment Terms", kind: "text" },
  { key: "dueDate", label: "Due Date", kind: "date" },
  { key: "currentDate", label: "Current Date", kind: "date" },
  { key: "overdueDays", label: "Overdue Days", kind: "num" },
  { key: "invoiceAge", label: "Invoice Age (days)", kind: "num" },
  { key: "ageing", label: "Ageing", kind: "text" },

  { key: "receiptCount", label: "Receipts", kind: "num" },
  { key: "firstReceiptDate", label: "First Receipt Date", kind: "date" },
  { key: "lastReceiptDate", label: "Last Receipt Date", kind: "date" },
  { key: "totalReceived", label: "Total Received (FCY)", kind: "money" },
  { key: "homeReceived", label: "Total Received (Home)", kind: "money" },
  { key: "forexGainLoss", label: "Forex Gain / Loss", kind: "money" },

  { key: "creditNotes", label: "Credit Note (CN)", kind: "money" },
  { key: "debitNotes", label: "Debit Note (DN)", kind: "money" },
  { key: "outstanding", label: "Balance as per Customer", kind: "money" },
  { key: "homeOutstanding", label: "Balance (Home Currency)", kind: "money" },
  { key: "booksBalance", label: "Balance as per Books", kind: "money" },
  { key: "booksDifference", label: "Difference", kind: "money" },
  { key: "overdueAmount", label: "Of Which Past Due", kind: "money" },
  { key: "status", label: "Payment Status", kind: "status" },

  { key: "piNo", label: "PI No.", kind: "text" },
  { key: "poNo", label: "PO No.", kind: "text" },
  { key: "shippingBillNo", label: "Shipping Bill No.", kind: "text" },
  { key: "shippingBillDate", label: "Shipping Bill Date", kind: "date" },
  { key: "blNo", label: "BL No.", kind: "text" },
  { key: "blDate", label: "BL Date", kind: "date" },
  { key: "containerNo", label: "Container No.", kind: "text" },
  { key: "eta", label: "ETA / Arrival Date", kind: "date" },
  { key: "docsPresentedDate", label: "Documents Presented", kind: "date" },

  { key: "remarks", label: "Remarks", kind: "text" },
  { key: "followUpNotes", label: "Follow-up Notes", kind: "text" },
  { key: "attention", label: "Needs Attention", kind: "text" },
  { key: "attentionWhy", label: "Why", kind: "text" },
];

/** One extra sheet's worth of detail: every receipt, for the same rows. */
const RECEIPT_COLUMNS: ReportColumn[] = [
  { key: "customer", label: "Customer", kind: "text" },
  { key: "invoiceNo", label: "Invoice No.", kind: "text" },
  { key: "seq", label: "Receipt No.", kind: "num" },
  { key: "receiptDate", label: "Receipt Date", kind: "date" },
  { key: "amountFcy", label: "Receipt Amount (FCY)", kind: "money" },
  { key: "exchangeRate", label: "Receipt Exchange Rate", kind: "num" },
  { key: "invoiceRate", label: "Invoice Exchange Rate", kind: "num" },
  { key: "rateDifference", label: "Exchange Rate Difference", kind: "num" },
  { key: "forexGainLoss", label: "Forex Gain / Loss", kind: "money" },
  { key: "homeValue", label: "Home Currency Value", kind: "money" },
  { key: "bankRef", label: "Bank Reference", kind: "text" },
  { key: "remarks", label: "Remarks", kind: "text" },
];

export function buildTrackingExport(
  rows: TrackedInvoice[],
  args: { today: string; filters: TrackingFilters; params: TrackingParams },
): {
  label: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: ReportRow | null;
  note: string;
  receipts: { columns: ReportColumn[]; rows: ReportRow[] };
} {
  const out: ReportRow[] = rows.map((i, index) => {
    const m = i.money;
    const s = i.schedule;
    const firstReceipt = i.receipts.reduce<string | null>(
      (first, r) => (r.receiptDate && (!first || r.receiptDate < first) ? r.receiptDate : first),
      null,
    );

    return {
      slNo: index + 1,
      customer: i.customerName,
      invoiceNo: i.invoiceNo,
      invoiceDate: i.invoiceDate,
      currency: i.currency,
      customerInvoiceValue: i.customerInvoiceValue,
      customsInvoiceValue: i.customsInvoiceValue,
      exchangeRate: i.exchangeRate,
      homeInvoiceValue: m.homeInvoiceValue,
      consignee: i.consignee,
      notifyParty: i.notifyParty,
      country: i.country,

      paymentTerms: i.paymentTerms,
      dueDate: s.dueDate,
      currentDate: args.today,
      overdueDays: i.overdueDays,
      invoiceAge: i.invoiceAge,
      ageing: i.ageing,

      receiptCount: m.receiptCount || null,
      firstReceiptDate: firstReceipt,
      lastReceiptDate: i.lastReceiptDate,
      totalReceived: m.totalReceived || null,
      homeReceived: m.homeReceived,
      forexGainLoss: m.totalForexGainLoss,

      creditNotes: m.creditNotes || null,
      debitNotes: m.debitNotes || null,
      outstanding: m.calculatedOutstanding,
      // at this invoice's own rate; blank, not zero, when no rate is recorded
      homeOutstanding:
        m.calculatedOutstanding !== null && i.exchangeRate
          ? round2(m.calculatedOutstanding * i.exchangeRate)
          : null,
      booksBalance: m.booksBalance,
      booksDifference: m.booksDifference,
      overdueAmount: s.overdueAmount || null,
      status: STATUS_LABELS[i.status],

      piNo: i.piNo,
      poNo: i.poNo,
      shippingBillNo: i.shippingBillNo,
      shippingBillDate: i.shippingBillDate,
      blNo: i.blNo,
      blDate: i.blDate,
      containerNo: i.containerNo,
      eta: i.eta,
      docsPresentedDate: i.docsPresentedDate,

      remarks: i.remarks,
      followUpNotes: i.followUpNotes,
      attention: i.needsAttention ? "Yes" : "No",
      attentionWhy: i.attentionReasons.join("; ") || null,
    };
  });

  const receiptRows: ReportRow[] = rows.flatMap((i) =>
    i.money.receipts.map((r) => ({
      customer: i.customerName,
      invoiceNo: i.invoiceNo,
      seq: r.seq,
      receiptDate: r.receiptDate,
      amountFcy: r.amountFcy,
      exchangeRate: r.exchangeRate,
      invoiceRate: i.exchangeRate,
      rateDifference: r.rateDifference,
      forexGainLoss: r.forexGainLoss,
      homeValue: r.homeValue,
      bankRef: r.bankRef,
      remarks: r.remarks ?? r.note,
    })),
  );

  // totals only in one currency: a column summing USD and EUR would be the one
  // wrong number in the file
  const currencies = new Set(rows.map((r) => r.currency ?? "—"));
  const dueKnown = rows.filter((r) => r.schedule.dueDate).length;
  const totals: ReportRow | null =
    currencies.size === 1
      ? {
          customer: `${rows.length} invoice(s)`,
          currency: [...currencies][0],
          customerInvoiceValue: round2(rows.reduce((s, r) => s + (r.customerInvoiceValue ?? 0), 0)),
          totalReceived: round2(rows.reduce((s, r) => s + r.money.totalReceived, 0)),
          creditNotes: round2(rows.reduce((s, r) => s + r.money.creditNotes, 0)),
          debitNotes: round2(rows.reduce((s, r) => s + r.money.debitNotes, 0)),
          outstanding: round2(rows.reduce((s, r) => s + (r.money.calculatedOutstanding ?? 0), 0)),
          overdueAmount: round2(rows.reduce((s, r) => s + r.schedule.overdueAmount, 0)),
          forexGainLoss: round2(
            rows.reduce((s, r) => s + (r.money.totalForexGainLoss ?? 0), 0),
          ),
          attention: `${rows.filter((r) => r.needsAttention).length} needing attention`,
        }
      : null;

  const applied = Object.entries(args.filters)
    .filter(([k, v]) => v && k !== "sort" && k !== "dir" && k !== "group")
    .map(([k, v]) => `${k}=${v}`);

  const noteParts = [
    `Customer Payment Tracking, generated ${args.today}. ${rows.length} invoice(s).`,
    applied.length ? `Filters: ${applied.join(", ")}.` : "No filters applied.",
    "Balance as per Customer = Invoice Value − Receipts − CN + DN.",
    "Balance as per Books is entered from the books and is never part of that sum; Difference is the calculated balance minus it.",
    "Exchange rates are home currency per one unit of foreign currency. Per receipt: Exchange Rate Difference = Receipt Rate − Invoice Rate; Forex Gain/Loss = Difference × Receipt Amount. A positive figure is a gain.",
    `Due dates could be established for ${dueKnown} of ${rows.length} invoice(s).` +
      (dueKnown < rows.length
        ? " The rest have no payment terms or no basis date to count from, are reported as Requires Verification, and are left out of the overdue figure rather than assumed late."
        : ""),
    "Overdue Days are measured against the generation date above, not against any date stored in a source sheet.",
  ];
  if (currencies.size > 1) {
    noteParts.push(
      "More than one currency is present, so no totals row is written — amounts in different currencies cannot be added.",
    );
  }

  return {
    label: "Payment Tracking",
    columns: COLUMNS,
    rows: out,
    totals,
    note: noteParts.join(" "),
    receipts: { columns: RECEIPT_COLUMNS, rows: receiptRows },
  };
}
