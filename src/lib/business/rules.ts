/**
 * Business rules the *company* owns, kept separate from extraction.
 *
 * Nothing here is invented. A due date is produced only when someone has
 * configured a rule for that payment term — "100% CAD" on its own does not imply
 * any number of credit days, so by default no due date is calculated and the
 * field is reported as awaiting a rule.
 *
 * Rules live in the database (PaymentTermRule) and are edited from Settings.
 */
import { DUE_SOON_DAYS } from "../config";
import { addDays, daysBetween, todayIso } from "../extraction/text";
import {
  buildSchedule,
  describeParts,
  singlePart,
  type Schedule,
  type TermPart,
} from "./instalments";

/**
 * Who the customer is when the invoice prints no separate "Buyer" block.
 *
 * Pacific Surfaces' rule, confirmed by Accounts: the **notify party is the
 * actual end buyer** — the goods are consigned to one party and bought by
 * another, so the consignee is not the customer.
 *
 * This is the only place that decision is written down. Change this one value to
 * change it everywhere; where the invoice does name a buyer, that is used and
 * this never comes into play.
 */
export const BUYER_WHEN_NOT_NAMED: "notifyParty" | "consignee" = "notifyParty";

/** The catalogue keys each party block fills, for the rule above. */
export const PARTY_BLOCKS = {
  notifyParty: {
    label: "notify party",
    name: "notifyPartyName",
    address: "notifyPartyAddress",
    country: "notifyPartyCountry",
    contact: "notifyPartyContact",
  },
  consignee: {
    label: "consignee",
    name: "consigneeName",
    address: "consigneeAddress",
    country: "consigneeCountry",
    contact: "consigneeContact",
  },
} as const;

export type PartyBlockKey = keyof typeof PARTY_BLOCKS;

export const DUE_BASIS_LABELS = {
  INVOICE_DATE: "Invoice Date",
  BL_DATE: "BL Date",
  SHIPPING_BILL_DATE: "Shipping Bill Date",
  ETA: "ETA / Arrival Date",
} as const;

export type DueBasisKey = keyof typeof DUE_BASIS_LABELS;

export const DUE_BASIS_FIELD: Record<DueBasisKey, string> = {
  INVOICE_DATE: "invoiceDate",
  BL_DATE: "blDate",
  SHIPPING_BILL_DATE: "shippingBillDate",
  ETA: "eta",
};

export interface PaymentTermRule {
  id?: string;
  label: string;
  pattern: string;
  creditDays: number;
  basis: DueBasisKey;
  isActive?: boolean;
  /**
   * A split term — "70% CAD, balance 30% at 90 days" — as one entry per portion.
   *
   * Absent or empty means the ordinary case: the whole invoice falls due once,
   * on `creditDays` from `basis`. Those two fields remain the single-part form,
   * so every rule configured before split terms existed keeps working untouched.
   */
  parts?: TermPart[];
}

/**
 * The parts of a rule, with the single-part case filled in.
 *
 * Everything downstream works in parts, so there is exactly one code path for
 * both shapes and the ordinary term is not a special case of itself.
 */
export function rulePartsOf(rule: PaymentTermRule): TermPart[] {
  return rule.parts?.length ? rule.parts : singlePart(rule.creditDays, rule.basis);
}

/** "70% 0d from BL Date + 30% 90d from BL Date", or "" for a single part. */
export function describeRule(rule: PaymentTermRule): string {
  const parts = rulePartsOf(rule);
  return parts.length > 1 ? describeParts(parts) : "";
}

function matches(rule: PaymentTermRule, paymentTerms: string): boolean {
  if (!paymentTerms || !rule.pattern) return false;
  try {
    return new RegExp(rule.pattern, "i").test(paymentTerms);
  } catch {
    return paymentTerms.toLowerCase().includes(rule.pattern.toLowerCase());
  }
}

export function findRule(
  paymentTerms: string | null,
  rules: PaymentTermRule[],
): PaymentTermRule | null {
  if (!paymentTerms) return null;
  return rules.find((r) => r.isActive !== false && matches(r, paymentTerms)) ?? null;
}

export interface DueDateResult {
  dueDate: string | null;
  explanation: string;
}

/** Why no rule applies — the same two sentences wherever that is reported. */
function noRuleReason(paymentTerms: string | null): string {
  if (!paymentTerms) {
    return "No payment terms on the invoice, so no due date can be worked out.";
  }
  return (
    `No due-date rule is configured for the payment term '${paymentTerms}'. ` +
    "Add one in Settings and the due date, overdue days and ageing will fill in automatically."
  );
}

/**
 * The due date of the first portion, from nothing but the invoice's own dates.
 *
 * This is the "before any money arrives" answer, and for an ordinary one-part
 * term it is the whole answer. Where receipts matter — because a split term's
 * due date moves to the next unpaid portion — use `computeDueSchedule`.
 */
export function computeDueDate(
  paymentTerms: string | null,
  basisDates: Partial<Record<DueBasisKey, string | null>>,
  rules: PaymentTermRule[],
): DueDateResult {
  const rule = findRule(paymentTerms, rules);
  if (!rule) return { dueDate: null, explanation: noRuleReason(paymentTerms) };

  const first = rulePartsOf(rule)[0];
  const name = rule.label || rule.pattern;
  const base = basisDates[first.basis];

  if (!base) {
    return {
      dueDate: null,
      explanation:
        `Rule '${name}' counts ${first.creditDays} days from ` +
        `${DUE_BASIS_LABELS[first.basis]}, which is not available yet.`,
    };
  }
  return {
    dueDate: addDays(base, first.creditDays),
    explanation:
      `${DUE_BASIS_LABELS[first.basis]} ${base} + ${first.creditDays} days ` +
      `(rule '${name}').`,
  };
}

export interface DueScheduleResult extends DueDateResult {
  /** Every portion of the invoice, dated and settled. Empty when no rule applies. */
  schedule: Schedule;
  rule: PaymentTermRule | null;
}

/**
 * The full due-date position for one invoice: which portions exist, when each
 * falls due, and how much of what is still owed is actually past due.
 *
 * The due date it reports is the next portion that still owes money, so an
 * invoice on "70% CAD + 30% at 90 days" shows the CAD date until that 70% is
 * paid and then moves to the 90-day date on its own. For a one-part term the
 * result is identical to `computeDueDate`, down to the wording, because the
 * register has shown that sentence since day one and there is no reason for it
 * to change.
 */
export function computeDueSchedule(args: {
  paymentTerms: string | null;
  basisDates: Partial<Record<DueBasisKey, string | null>>;
  rules: PaymentTermRule[];
  invoiceValue: number | null;
  /** Receipts + CN − DN: what the customer no longer owes. */
  settled?: number;
  today?: string;
}): DueScheduleResult {
  const blank: Schedule = {
    instalments: [],
    dueDate: null,
    anchor: null,
    overdueAmount: 0,
    outstanding: 0,
    unallocated: 0,
    split: false,
    configProblem: null,
  };

  const rule = findRule(args.paymentTerms, args.rules);
  if (!rule) {
    return {
      dueDate: null,
      explanation: noRuleReason(args.paymentTerms),
      schedule: blank,
      rule: null,
    };
  }

  const name = rule.label || rule.pattern;
  const parts = rulePartsOf(rule);
  const schedule = buildSchedule({
    invoiceValue: args.invoiceValue,
    parts,
    basisDates: args.basisDates,
    settled: args.settled ?? 0,
    ruleLabel: name,
    today: args.today,
  });

  // one portion: say exactly what the register has always said
  if (!schedule.split) {
    const single = computeDueDate(args.paymentTerms, args.basisDates, args.rules);
    return { ...single, schedule, rule };
  }

  return {
    dueDate: schedule.dueDate,
    explanation: splitExplanation(schedule, parts, name, args.basisDates),
    schedule,
    rule,
  };
}

/** The hover text for a split term's due date — which portion, and why that one. */
function splitExplanation(
  schedule: Schedule,
  parts: TermPart[],
  name: string,
  basisDates: Partial<Record<DueBasisKey, string | null>>,
): string {
  const shape = `Split term '${name}' — ${describeParts(parts)}.`;

  if (schedule.configProblem) {
    return `${shape} It cannot be used: ${schedule.configProblem} Fix it in Settings; nothing is assumed in the meantime.`;
  }
  const anchor = schedule.anchor;
  if (!anchor) return shape;

  if (anchor.dueDate === null) {
    return `${shape} ${anchor.pending ?? ""}`.trim();
  }
  const base = basisDates[anchor.basis];
  const owing = anchor.outstanding > 0.01;
  return (
    `${shape} Showing ${DUE_BASIS_LABELS[anchor.basis]} ${base} + ${anchor.creditDays} days ` +
    (owing
      ? `— the next portion still owing is ${anchor.percent}% of the invoice.`
      : `— everything is settled, so this is the last portion's date.`)
  );
}

// --------------------------------------------------------------------------
// Status engine
// --------------------------------------------------------------------------
export const INVOICE_STATUS = {
  PAID: "PAID",
  PARTIALLY_PAID: "PARTIALLY_PAID",
  UNPAID: "UNPAID",
  NOT_DUE: "NOT_DUE",
  DUE_SOON: "DUE_SOON",
  OVERDUE: "OVERDUE",
  MISSING_INFORMATION: "MISSING_INFORMATION",

  // Kept so rows stored before receipts existed still render, and so the
  // register's status filter can still show them. Nothing produces them now:
  // an invoice with no receipts is UNPAID, and a field that needs confirming is
  // reported on the invoice screen rather than hidden behind the payment status.
  AWAITING_PAYMENT_DATA: "AWAITING_PAYMENT_DATA",
  PENDING_VERIFICATION: "PENDING_VERIFICATION",
} as const;

export type InvoiceStatusKey = (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];

export const STATUS_LABELS: Record<InvoiceStatusKey, string> = {
  PAID: "Paid",
  PARTIALLY_PAID: "Partially Paid",
  UNPAID: "Unpaid",
  NOT_DUE: "Not Due",
  DUE_SOON: "Due",
  OVERDUE: "Overdue",
  MISSING_INFORMATION: "Missing Information",
  AWAITING_PAYMENT_DATA: "Awaiting Payment Data",
  PENDING_VERIFICATION: "Pending Verification",
};

export const STATUS_TONE: Record<InvoiceStatusKey, "ok" | "warn" | "bad" | "info" | "mute"> = {
  PAID: "ok",
  PARTIALLY_PAID: "warn",
  UNPAID: "mute",
  NOT_DUE: "info",
  DUE_SOON: "warn",
  OVERDUE: "bad",
  MISSING_INFORMATION: "bad",
  AWAITING_PAYMENT_DATA: "info",
  PENDING_VERIFICATION: "warn",
};

/**
 * What an invoice's payment status is, from what has actually been recorded.
 *
 * `settled` is what the customer no longer owes — receipts received, plus credit
 * notes, less debit notes — so it is the same number the balance comes from. The
 * order of the tests is the business decision:
 *
 *   1. no invoice value      → the status cannot be trusted at all
 *   2. nothing outstanding   → Paid, whatever the due date says
 *   3. past the due date     → Overdue, because that is what needs action
 *   4. something received    → Partially Paid
 *   5. no due date yet       → Unpaid (a due-date rule would refine this)
 *   6. due within a week     → Due
 *   7. otherwise             → Not Due
 *
 * A paid invoice is never overdue, and an overdue invoice says so even when it is
 * part paid — the outstanding figure is on the same row, so nothing is lost.
 *
 * @param opts.overdueAmount how much of the outstanding balance is actually past
 *        due, from a split term's schedule. Pass it and step 3 asks "is any
 *        portion late" instead of "has the invoice's one date passed" — which is
 *        what stops a 70/30 invoice being called fully overdue on the day the
 *        first 70% falls due. Omit it and the single-date behaviour applies,
 *        which for a one-part term is the same answer either way.
 * @param opts.dueSoonDays the Settings value for how early "Due" starts.
 */
export function paymentStatus(
  invoiceValue: number | null,
  settled: number | null,
  dueDate: string | null,
  today: string = todayIso(),
  opts: { overdueAmount?: number | null; dueSoonDays?: number } = {},
): InvoiceStatusKey {
  if (invoiceValue === null) return INVOICE_STATUS.MISSING_INFORMATION;

  const received = settled ?? 0;
  const outstanding = Math.round((invoiceValue - received) * 100) / 100;

  if (outstanding <= 0.01) return INVOICE_STATUS.PAID;

  const overdueAmount = opts.overdueAmount ?? null;
  const anyPortionLate =
    overdueAmount === null ? Boolean(dueDate && dueDate < today) : overdueAmount > 0.01;
  if (anyPortionLate) return INVOICE_STATUS.OVERDUE;
  if (received > 0) return INVOICE_STATUS.PARTIALLY_PAID;
  if (!dueDate) return INVOICE_STATUS.UNPAID;
  if (daysBetween(today, dueDate) <= (opts.dueSoonDays ?? DUE_SOON_DAYS)) {
    return INVOICE_STATUS.DUE_SOON;
  }
  return INVOICE_STATUS.NOT_DUE;
}

export function overdueDays(dueDate: string | null, today: string = todayIso()): number | null {
  if (!dueDate) return null;
  const delta = daysBetween(dueDate, today);
  return delta > 0 ? delta : 0;
}
