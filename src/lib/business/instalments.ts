/**
 * Split payment terms — an invoice that falls due in more than one piece.
 *
 * Blue Planet's term reads "70% Cash Against Documents (CAD), Balance 30% at 90
 * Days". That is not one due date. 70% of the value is due when the documents
 * are presented and the remaining 30% ninety days later, so for most of its life
 * the invoice is *partly* due and partly not. A single due date cannot say that:
 * it either calls the whole invoice overdue on day one, overstating what the
 * customer actually owes us today, or calls none of it overdue until day ninety,
 * understating it. Both are wrong, and both end up in a conversation with a
 * customer who has the correct figure in front of them.
 *
 * So a payment term is a list of parts, each with its own percentage, credit
 * days and basis date. One part is the ordinary case and behaves exactly as it
 * did before this file existed.
 *
 * Three rules this module keeps to:
 *
 *   1. The parts always add up to the invoice value, to the paisa. The rounding
 *      remainder lands on the last part, so 100.00 split 70/30 is 70.00 + 30.00
 *      and 100.01 is 70.01 + 30.00 — never 70.007 + 30.003.
 *   2. Money settles against the earliest part first. That is the universal
 *      convention and the only one that makes "what is overdue" answerable.
 *   3. A part whose basis date is not known yet gets no due date and says why.
 *      It is never assumed to be due, and never assumed not to be.
 */
import type { DueBasisKey } from "./rules";
import { DUE_BASIS_LABELS } from "./rules";
import { addDays, round2, todayIso } from "../extraction/text";

/** How much of an invoice falls due, and when, as configured in Settings. */
export interface TermPart {
  /** 1-based, and the order money settles in. */
  seq: number;
  /** Percentage of the invoice value, 0 < percent <= 100. */
  percent: number;
  creditDays: number;
  basis: DueBasisKey;
}

/** One part of one invoice: the part's share, its due date, and its position. */
export interface Instalment {
  seq: number;
  percent: number;
  /** The part's share of the invoice value. The parts sum to the value exactly. */
  amount: number;
  dueDate: string | null;
  basis: DueBasisKey;
  creditDays: number;
  /** Why `dueDate` is null. Null when the due date is known. */
  pending: string | null;
  /** Settled against this part, earliest part first. */
  settled: number;
  /** amount − settled, never negative. */
  outstanding: number;
  /** Known due date, and that date has passed. */
  overdue: boolean;
}

export interface Schedule {
  instalments: Instalment[];
  /**
   * The invoice's single due date, for the register column and every existing
   * caller: the earliest part that still owes money. Once everything is settled
   * it is the last part's date, so a paid invoice still shows what it was due by.
   */
  dueDate: string | null;
  /**
   * The instalment `dueDate` came from — the next one still owing, or the last
   * one once everything is settled. Null only when there are no instalments.
   * The wording shown to the reader is built from this in `rules.ts`, which is
   * where the company's phrasing lives.
   */
  anchor: Instalment | null;
  /** The part of the outstanding balance whose due date has passed. */
  overdueAmount: number;
  /** Outstanding across every part, due or not. */
  outstanding: number;
  /** Received beyond the invoice value, if any — never silently dropped. */
  unallocated: number;
  /** True when this invoice falls due in more than one piece. */
  split: boolean;
  /** Set when the configured parts are unusable, e.g. they do not total 100%. */
  configProblem: string | null;
}

/** A single part covering the whole invoice — the ordinary, non-split term. */
export function singlePart(creditDays: number, basis: DueBasisKey): TermPart[] {
  return [{ seq: 1, percent: 100, creditDays, basis }];
}

/**
 * Whether a set of parts can be used, and if not, why.
 *
 * Checked here as well as in Settings because a rule can also arrive from a
 * seed, a fixture or a future import, and a term that does not total 100% must
 * never quietly bill a customer for 97% of an invoice.
 */
export function partsProblem(parts: TermPart[]): string | null {
  if (!parts.length) return "No parts are configured for this payment term.";
  for (const p of parts) {
    if (!(p.percent > 0)) return `Part ${p.seq} has no percentage.`;
    if (p.percent > 100) return `Part ${p.seq} is more than 100% of the invoice.`;
    if (p.creditDays < 0) return `Part ${p.seq} has negative credit days.`;
  }
  const total = round2(parts.reduce((sum, p) => sum + p.percent, 0));
  if (Math.abs(total - 100) > 0.01) {
    return `The parts add up to ${total}% of the invoice, not 100%.`;
  }
  return null;
}

/**
 * Split a value by percentage so the pieces sum to it exactly.
 *
 * Every piece is rounded to two decimals and the last one absorbs whatever the
 * rounding left over, which is the only way `Σ parts === invoice value` can be
 * guaranteed. An invoice that does not add up to itself is worse than a rounding
 * error of one paisa on the final instalment.
 */
export function splitAmount(invoiceValue: number, parts: TermPart[]): number[] {
  if (!parts.length) return [];
  const out: number[] = [];
  let used = 0;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const piece = round2((invoiceValue * parts[i].percent) / 100);
    out.push(piece);
    used = round2(used + piece);
  }
  out.push(round2(invoiceValue - used));
  return out;
}

/**
 * The due date of one part, or the reason it cannot be worked out.
 *
 * The basis date is the thing the sheets were missing: a "120 days from the date
 * of BL" term cannot produce a due date from an invoice date, and guessing one
 * is how a customer gets chased three weeks early.
 */
function datePart(
  part: TermPart,
  basisDates: Partial<Record<DueBasisKey, string | null>>,
  label: string,
): { dueDate: string | null; pending: string | null } {
  const base = basisDates[part.basis];
  if (!base) {
    return {
      dueDate: null,
      pending:
        `${label} counts ${part.creditDays} day(s) from ` +
        `${DUE_BASIS_LABELS[part.basis]}, which is not available yet.`,
    };
  }
  return { dueDate: addDays(base, part.creditDays), pending: null };
}

/**
 * Settle money against instalments, earliest first.
 *
 * `settled` is the same figure the balance uses — receipts plus credit notes
 * less debit notes — so the instalments can never disagree with the balance on
 * the same row. A debit note large enough to make it negative means the customer
 * owes more than the invoice, not that an instalment has been un-paid, so it is
 * floored at zero and the balance column carries the excess.
 */
export function allocate(
  instalments: Omit<Instalment, "settled" | "outstanding" | "overdue">[],
  settled: number,
  today: string = todayIso(),
): { instalments: Instalment[]; unallocated: number } {
  let left = Math.max(0, round2(settled));
  const out: Instalment[] = [];

  for (const inst of instalments) {
    const applied = Math.min(left, inst.amount);
    left = round2(left - applied);
    const outstanding = round2(inst.amount - applied);
    out.push({
      ...inst,
      settled: round2(applied),
      outstanding,
      overdue: inst.dueDate !== null && inst.dueDate < today && outstanding > 0.01,
    });
  }

  return { instalments: out, unallocated: left };
}

/**
 * The whole picture for one invoice: its parts, its due date, and how much of
 * what it still owes is actually past due.
 *
 * @param settled receipts + credit notes − debit notes, i.e. what the customer
 *                no longer owes. Passing 0 gives the position before any money.
 */
export function buildSchedule(args: {
  invoiceValue: number | null;
  parts: TermPart[];
  basisDates: Partial<Record<DueBasisKey, string | null>>;
  settled?: number;
  /** The rule's name, used in the per-part "waiting for X" reasons. */
  ruleLabel?: string;
  today?: string;
}): Schedule {
  const today = args.today ?? todayIso();
  const label = args.ruleLabel ? `Rule '${args.ruleLabel}'` : "The payment term";

  const empty: Schedule = {
    instalments: [],
    dueDate: null,
    anchor: null,
    overdueAmount: 0,
    outstanding: 0,
    unallocated: 0,
    split: false,
    configProblem: null,
  };

  if (args.invoiceValue === null) return empty;

  const problem = partsProblem(args.parts);
  if (problem) {
    return {
      ...empty,
      outstanding: round2(Math.max(0, args.invoiceValue - Math.max(0, args.settled ?? 0))),
      configProblem: problem,
    };
  }

  const parts = [...args.parts].sort((a, b) => a.seq - b.seq);
  const amounts = splitAmount(args.invoiceValue, parts);

  const planned = parts.map((part, i) => {
    const partLabel =
      parts.length > 1 ? `${label} part ${part.seq} (${part.percent}%)` : label;
    const { dueDate, pending } = datePart(part, args.basisDates, partLabel);
    return {
      seq: part.seq,
      percent: part.percent,
      amount: amounts[i],
      dueDate,
      basis: part.basis,
      creditDays: part.creditDays,
      pending,
    };
  });

  const { instalments, unallocated } = allocate(planned, args.settled ?? 0, today);

  const outstanding = round2(instalments.reduce((sum, i) => sum + i.outstanding, 0));
  const overdueAmount = round2(
    instalments.filter((i) => i.overdue).reduce((sum, i) => sum + i.outstanding, 0),
  );

  // the register's single due date: the next piece that still owes money. For a
  // one-part term that is simply the one due date, so nothing about the existing
  // register changes.
  const nextOwing = instalments.find((i) => i.outstanding > 0.01);
  const anchor = nextOwing ?? instalments[instalments.length - 1];
  const dueDate = anchor?.dueDate ?? null;

  return {
    instalments,
    dueDate,
    anchor: anchor ?? null,
    overdueAmount,
    outstanding,
    unallocated,
    split: parts.length > 1,
    configProblem: null,
  };
}

/** "70% 0d from BL Date + 30% 90d from BL Date" — the shape of a split term. */
export function describeParts(parts: Pick<TermPart, "percent" | "creditDays" | "basis">[]): string {
  return parts
    .map((p) => `${p.percent}% ${p.creditDays}d from ${DUE_BASIS_LABELS[p.basis]}`)
    .join(" + ");
}
