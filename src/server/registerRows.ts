/**
 * Turning stored invoices into register rows.
 *
 * The register renders the `accountsRow` JSON saved at import time, which is
 * fast but goes stale the moment the column set changes — or the moment a
 * receipt is added, since that adds five columns. Rather than leaving an
 * Accounts employee staring at blank columns, or asking them to re-import
 * everything, a row that no longer matches is rebuilt here from the extraction
 * already stored with the invoice, and written back so it only happens once.
 */
import "server-only";

import type { Invoice } from "@prisma/client";

import {
  buildAccountsRow,
  applyVolatileCells,
  isRowCurrent,
  MIN_RECEIPT_SLOTS,
  type AccountsRow,
  type NoteInput,
  type ReceiptInput,
} from "@/lib/business/accounts";
import type { PaymentTermRule } from "@/lib/business/rules";
import { prisma } from "@/lib/db";
import { todayIso } from "@/lib/extraction/text";
import type { ExtractedField, LineItem } from "@/lib/extraction/types";
import { fromJson, toJson } from "@/lib/json";
import { fieldString, normalizedFromJson } from "@/lib/normalize/normalizer";
import { assess } from "@/lib/normalize/validators";
import { loadRules } from "@/server/invoiceData";

export interface MaterialisedRow {
  id: string;
  invoiceNo: string;
  row: AccountsRow;
  rebuilt: boolean;
}

export interface MaterialisedRows {
  rows: MaterialisedRow[];
  /** How many receipt column groups this register needs. */
  receiptSlots: number;
}

/**
 * How many receipt groups the table must show: the most receipts any of these
 * invoices has, and never fewer than one — Receipt 1 is always visible, even
 * before a receipt exists.
 */
export async function receiptSlotsFor(invoiceIds: string[]): Promise<number> {
  if (!invoiceIds.length) return MIN_RECEIPT_SLOTS;
  const grouped = await prisma.receipt.groupBy({
    by: ["invoiceId"],
    where: { invoiceId: { in: invoiceIds } },
    _max: { seq: true },
  });
  const most = grouped.reduce((max, g) => Math.max(max, g._max.seq ?? 0), 0);
  return Math.max(MIN_RECEIPT_SLOTS, most);
}

/**
 * Every receipt and note for a page of invoices, in two queries.
 *
 * This replaces asking per invoice. Rendering a register of fifty rows used to
 * mean a hundred round trips, each waiting for the last — the single biggest
 * reason a page took seconds to appear rather than milliseconds.
 */
async function receiptsAndNotesFor(invoiceIds: string[]): Promise<{
  receipts: Map<string, ReceiptInput[]>;
  notes: Map<string, NoteInput[]>;
}> {
  const receipts = new Map<string, ReceiptInput[]>();
  const notes = new Map<string, NoteInput[]>();
  if (!invoiceIds.length) return { receipts, notes };

  const [receiptRows, noteRows] = await Promise.all([
    prisma.receipt.findMany({
      where: { invoiceId: { in: invoiceIds } },
      orderBy: { seq: "asc" },
    }),
    prisma.creditDebitNote.findMany({
      where: { invoiceId: { in: invoiceIds } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  for (const r of receiptRows) {
    const list = receipts.get(r.invoiceId) ?? [];
    list.push({
      seq: r.seq,
      amount: Number(r.amount),
      receiptDate: r.receiptDate ? r.receiptDate.toISOString().slice(0, 10) : null,
      exchangeRate: r.exchangeRate === null ? null : Number(r.exchangeRate),
      bankRef: r.bankRef,
      remarks: r.remarks,
      source: r.source,
    });
    receipts.set(r.invoiceId, list);
  }
  for (const n of noteRows) {
    const list = notes.get(n.invoiceId) ?? [];
    list.push({
      noteType: n.noteType === "CREDIT" ? "CREDIT" : "DEBIT",
      amount: Number(n.amount),
      noteNo: n.noteNo,
      noteDate: n.noteDate ? n.noteDate.toISOString().slice(0, 10) : null,
    });
    notes.set(n.invoiceId, list);
  }
  return { receipts, notes };
}

function rebuildFromStoredExtraction(
  invoice: Invoice,
  rules: PaymentTermRule[],
  slNo: number,
  today: string,
  receiptSlots: number,
  receipts: ReceiptInput[],
  notes: NoteInput[],
): { row: AccountsRow; customerName: string | null } {
  const normalized = normalizedFromJson(
    fromJson<Record<string, ExtractedField>>(invoice.fields, {}),
    fromJson<LineItem[]>(invoice.lineItems, []),
    fromJson<string[]>(invoice.warnings, []),
  );
  return {
    row: buildAccountsRow(normalized, assess(normalized), {
      slNo,
      rules,
      today,
      receipts,
      notes,
      receiptSlots,
    }),
    // normalizedFromJson re-applies the party rule, so the column the dashboard
    // and the search box read is brought up to date at the same time
    customerName: fieldString(normalized, "customerName"),
  };
}

/**
 * @param persist write a rebuilt row back so the next render is cheap. Safe to
 *                leave on: the rebuild is deterministic from data already stored.
 */
export async function materialiseRows(
  invoices: Invoice[],
  opts: { today?: string; persist?: boolean; receiptSlots?: number } = {},
): Promise<MaterialisedRows> {
  const today = opts.today ?? todayIso();
  const persist = opts.persist ?? true;
  const receiptSlots =
    opts.receiptSlots ?? (await receiptSlotsFor(invoices.map((i) => i.id)));

  const stored = invoices.map((inv) => ({
    inv,
    row: fromJson<AccountsRow>(inv.accountsRow, {} as AccountsRow),
  }));
  const stale = stored.filter(({ row }) => !isRowCurrent(row, receiptSlots));

  // the two costs of a rebuild — the rules and every receipt / note — are paid
  // once for the page, not once per row, and only when something is actually
  // stale. A register whose rows are all current issues no extra query at all.
  const [rules, related] = stale.length
    ? await Promise.all([
        loadRules(),
        receiptsAndNotesFor(stale.map(({ inv }) => inv.id)),
      ])
    : [[] as PaymentTermRule[], { receipts: new Map(), notes: new Map() }];

  const rows: MaterialisedRow[] = [];
  const writes: Array<Promise<unknown>> = [];

  for (const [index, { inv, row }] of stored.entries()) {
    const slNo = index + 1;
    let finalRow = row;
    let rebuilt = false;

    if (!isRowCurrent(row, receiptSlots)) {
      const fresh = rebuildFromStoredExtraction(
        inv,
        rules,
        slNo,
        today,
        receiptSlots,
        related.receipts.get(inv.id) ?? [],
        related.notes.get(inv.id) ?? [],
      );
      finalRow = fresh.row;
      rebuilt = true;
      if (persist) {
        // not awaited in the loop: the page does not need the write to finish
        // before rendering the row it already holds
        writes.push(
          prisma.invoice.update({
            where: { id: inv.id },
            data: { accountsRow: toJson(finalRow), customerName: fresh.customerName },
          }),
        );
      }
    } else {
      finalRow.slNo = {
        value: slNo,
        display: String(slNo),
        status: "calculated",
        note: "Register row number.",
        source: null,
      };
      applyVolatileCells(finalRow, today);
    }

    rows.push({ id: inv.id, invoiceNo: inv.invoiceNo, row: finalRow, rebuilt });
  }

  if (writes.length) await Promise.all(writes);
  return { rows, receiptSlots };
}

/** Single-invoice version, for the detail screen. */
export async function materialiseRow(
  invoice: Invoice,
  opts: { today?: string; persist?: boolean } = {},
): Promise<{ row: AccountsRow; receiptSlots: number }> {
  const { rows, receiptSlots } = await materialiseRows([invoice], opts);
  return { row: rows[0].row, receiptSlots };
}
