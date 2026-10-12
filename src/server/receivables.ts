/**
 * The receivable position, across every invoice.
 *
 * One query path feeding the Payments & Receipts screen, so the totals there and
 * the figures in the register come from the same functions — `balanceFrom`,
 * `receiptMaths`, `paymentStatus` — rather than being added up a second way.
 */
import "server-only";

import { cache } from "react";

import type { AccountsRow } from "@/lib/business/accounts";
import {
  balanceFrom,
  decodeInstalments,
  overdueAmountOf,
  receiptMaths,
  settledAmount,
  totalNotes,
  totalReceipts,
  type NoteInput,
  type ReceiptInput,
} from "@/lib/business/accounts";
import { paymentStatus, type InvoiceStatusKey } from "@/lib/business/rules";
import { prisma } from "@/lib/db";
import { todayIso } from "@/lib/extraction/text";
import { fromJson } from "@/lib/json";

/**
 * Cached for the life of one request. Reports build a report *and* its filter
 * options from the same data, and the dashboard reads it once per section; React's
 * cache keeps that to a single query set instead of repeating it.
 */
export const loadReceivables = cache(readReceivables);

export interface ReceiptLineView extends ReceiptInput {
  /** Difference and forex, worked out against this invoice's rate. */
  difference: number | null;
  forex: number | null;
}

export interface InvoiceReceivable {
  invoiceId: string;
  /** The stored register row, carried along so nothing has to fetch it again. */
  row: AccountsRow;
  invoiceNo: string;
  invoiceDate: string | null;
  customerName: string | null;
  currency: string;
  invoiceValue: number | null;
  invoiceRate: number | null;
  dueDate: string | null;
  receipts: ReceiptLineView[];
  creditNotes: number;
  debitNotes: number;
  received: number;
  balance: number | null;
  status: InvoiceStatusKey;
  forexTotal: number;

  // ---- fields the follow-up section reads, so it never has to query again
  poNo: string | null;
  containerNo: string | null;
  paymentTerms: string | null;
  /** The newest receipt date — the clearest sign of whether a customer pays. */
  lastReceiptDate: string | null;
  /** The part of `balance` whose due date has passed. */
  overdueAmount: number;
  /** True when the payment term splits the invoice into portions. */
  split: boolean;
  /** The portions, from the stored plan: percent, due date, amount. */
  instalmentPlan: { percent: number; dueDate: string | null; amount: number }[];
}

export interface ReceivableTotals {
  invoices: number;
  invoiceValue: number;
  received: number;
  creditNotes: number;
  debitNotes: number;
  outstanding: number;
  forex: number;
  receipts: number;
  /** Invoices with no receipt at all — where collection starts. */
  unpaid: number;
  overdue: number;
}

export interface ReceivablesView {
  rows: InvoiceReceivable[];
  totals: Record<string, ReceivableTotals>;
  today: string;
}

/**
 * @param currency limit to one currency. Amounts in different currencies are
 *                 never added together — the totals are per currency, because a
 *                 sum across USD and EUR would be meaningless.
 */
async function readReceivables(
  opts: { currency?: string; status?: string; q?: string } = {},
): Promise<ReceivablesView> {
  const today = todayIso();

  const invoices = await prisma.invoice.findMany({
    where: {
      ...(opts.currency ? { currency: opts.currency } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.q
        ? {
            OR: [
              { invoiceNo: { contains: opts.q } },
              { customerName: { contains: opts.q } },
              { consigneeName: { contains: opts.q } },
            ],
          }
        : {}),
    },
    orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }],
    include: {
      receipts: { orderBy: { seq: "asc" } },
      notes: { orderBy: { createdAt: "asc" } },
    },
  });

  const rows: InvoiceReceivable[] = [];
  const totals: Record<string, ReceivableTotals> = {};

  for (const inv of invoices) {
    const invoiceValue = inv.invoiceValue === null ? null : Number(inv.invoiceValue);
    const invoiceRate = inv.exchangeRate === null ? null : Number(inv.exchangeRate);

    const receipts: ReceiptInput[] = inv.receipts.map((r) => ({
      seq: r.seq,
      amount: Number(r.amount),
      receiptDate: r.receiptDate ? r.receiptDate.toISOString().slice(0, 10) : null,
      exchangeRate: r.exchangeRate === null ? null : Number(r.exchangeRate),
      bankRef: r.bankRef,
      source: r.source,
    }));
    const notes: NoteInput[] = inv.notes.map((n) => ({
      noteType: n.noteType === "CREDIT" ? ("CREDIT" as const) : ("DEBIT" as const),
      amount: Number(n.amount),
      noteNo: n.noteNo,
      noteDate: n.noteDate ? n.noteDate.toISOString().slice(0, 10) : null,
    }));

    const lines: ReceiptLineView[] = receipts.map((r) => ({
      ...r,
      ...receiptMaths(r, invoiceRate),
    }));

    const dueDate = inv.dueDate ? inv.dueDate.toISOString().slice(0, 10) : null;
    const received = totalReceipts(receipts);
    const cn = totalNotes(notes, "CREDIT");
    const dn = totalNotes(notes, "DEBIT");
    const balance = invoiceValue === null ? null : balanceFrom(invoiceValue, receipts, notes);
    const forexTotal =
      Math.round(lines.reduce((sum, l) => sum + (l.forex ?? 0), 0) * 100) / 100;

    const settled = settledAmount(receipts, notes);
    const row = fromJson<AccountsRow>(inv.accountsRow, {} as AccountsRow);
    // a split term is only partly overdue, so the status asks "is any portion
    // late" rather than "has the one date passed" — same answer for an
    // ordinary term, the right answer for "70% CAD, balance 30% at 90 days"
    const overdue = overdueAmountOf(row, {
      settled,
      outstanding: balance ?? 0,
      dueDate,
      today,
    });
    const status = paymentStatus(invoiceValue, settled, dueDate, today, {
      overdueAmount: overdue.split ? overdue.amount : null,
    });
    const currency = inv.currency ?? "—";
    const lastReceiptDate =
      receipts.reduce<string | null>(
        (latest, r) => (r.receiptDate && (!latest || r.receiptDate > latest) ? r.receiptDate : latest),
        null,
      );

    rows.push({
      invoiceId: inv.id,
      row,
      invoiceNo: inv.invoiceNo,
      invoiceDate: inv.invoiceDate ? inv.invoiceDate.toISOString().slice(0, 10) : null,
      customerName: inv.customerName,
      currency,
      invoiceValue,
      invoiceRate,
      dueDate,
      receipts: lines,
      creditNotes: cn,
      debitNotes: dn,
      received,
      balance,
      status,
      forexTotal,
      poNo: inv.poNo,
      containerNo: inv.containerNo,
      paymentTerms: inv.paymentTerms,
      lastReceiptDate,
      overdueAmount: overdue.amount,
      split: overdue.split,
      instalmentPlan: decodeInstalments(row.instalmentPlan?.value),
    });

    const bucket = (totals[currency] ??= {
      invoices: 0,
      invoiceValue: 0,
      received: 0,
      creditNotes: 0,
      debitNotes: 0,
      outstanding: 0,
      forex: 0,
      receipts: 0,
      unpaid: 0,
      overdue: 0,
    });
    bucket.invoices += 1;
    bucket.invoiceValue += invoiceValue ?? 0;
    bucket.received += received;
    bucket.creditNotes += cn;
    bucket.debitNotes += dn;
    bucket.outstanding += balance ?? 0;
    bucket.forex += forexTotal;
    bucket.receipts += receipts.length;
    if (!receipts.length) bucket.unpaid += 1;
    if (status === "OVERDUE") bucket.overdue += 1;
  }

  for (const bucket of Object.values(totals)) {
    bucket.invoiceValue = Math.round(bucket.invoiceValue * 100) / 100;
    bucket.received = Math.round(bucket.received * 100) / 100;
    bucket.outstanding = Math.round(bucket.outstanding * 100) / 100;
    bucket.forex = Math.round(bucket.forex * 100) / 100;
  }

  return { rows, totals, today };
}
