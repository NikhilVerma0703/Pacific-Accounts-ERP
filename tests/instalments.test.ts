/**
 * Split payment terms.
 *
 * The case that forced this to exist is real and comes from a customer
 * statement: "70% Cash Against Documents (CAD), Balance 30% at 90 Days". Under a
 * single due date that invoice is either wholly overdue three months early or
 * wholly on time three months late, and both answers would be defended to a
 * customer holding the correct figure.
 *
 * The three properties worth protecting, in order of how much damage getting
 * them wrong would do:
 *
 *   1. the portions add up to the invoice value, exactly
 *   2. money settles against the earliest portion first
 *   3. an ordinary one-portion term behaves precisely as it did before
 */
import { describe, expect, it } from "vitest";

import {
  allocate,
  buildSchedule,
  describeParts,
  partsProblem,
  singlePart,
  splitAmount,
  type TermPart,
} from "@/lib/business/instalments";
import {
  computeDueDate,
  computeDueSchedule,
  paymentStatus,
  rulePartsOf,
  type PaymentTermRule,
} from "@/lib/business/rules";

/** The Blue Planet term, as a rule. */
const SPLIT: TermPart[] = [
  { seq: 1, percent: 70, creditDays: 0, basis: "BL_DATE" },
  { seq: 2, percent: 30, creditDays: 90, basis: "BL_DATE" },
];

const BASIS = { INVOICE_DATE: "2026-01-05", BL_DATE: "2026-01-10" };

describe("the portions add up to the invoice value", () => {
  it("splits a round value exactly", () => {
    expect(splitAmount(100000, SPLIT)).toEqual([70000, 30000]);
  });

  it("puts the rounding remainder on the last portion, never loses it", () => {
    // 70% of 100.01 is 70.007, which cannot be a money amount
    const pieces = splitAmount(100.01, SPLIT);
    expect(pieces).toEqual([70.01, 30]);
    expect(pieces[0] + pieces[1]).toBe(100.01);
  });

  it("never loses a paisa, across a range of awkward values", () => {
    for (const value of [1, 7.77, 0.03, 195741.04, 127137.02, 659461.36]) {
      const pieces = splitAmount(value, SPLIT);
      const total = Math.round(pieces.reduce((a, b) => a + b, 0) * 100) / 100;
      expect(total, `value ${value}`).toBe(value);
    }
  });

  it("handles a three-way split", () => {
    const thirds: TermPart[] = [
      { seq: 1, percent: 33.34, creditDays: 0, basis: "BL_DATE" },
      { seq: 2, percent: 33.33, creditDays: 30, basis: "BL_DATE" },
      { seq: 3, percent: 33.33, creditDays: 60, basis: "BL_DATE" },
    ];
    const pieces = splitAmount(100, thirds);
    expect(Math.round(pieces.reduce((a, b) => a + b, 0) * 100) / 100).toBe(100);
  });
});

describe("portions that do not total 100% are refused, not quietly used", () => {
  it("rejects 70 + 20", () => {
    const bad: TermPart[] = [
      { seq: 1, percent: 70, creditDays: 0, basis: "BL_DATE" },
      { seq: 2, percent: 20, creditDays: 90, basis: "BL_DATE" },
    ];
    expect(partsProblem(bad)).toMatch(/90% of the invoice, not 100%/);
  });

  it("accepts 70 + 30", () => {
    expect(partsProblem(SPLIT)).toBeNull();
  });

  it("builds no schedule from an unusable term, and says why", () => {
    const schedule = buildSchedule({
      invoiceValue: 100000,
      parts: [{ seq: 1, percent: 50, creditDays: 0, basis: "BL_DATE" }],
      basisDates: BASIS,
      today: "2026-02-01",
    });
    expect(schedule.instalments).toHaveLength(0);
    expect(schedule.configProblem).toMatch(/50% of the invoice/);
    // and the balance is still reported, because the customer still owes it
    expect(schedule.outstanding).toBe(100000);
  });
});

describe("money settles against the earliest portion first", () => {
  const planned = [
    { seq: 1, percent: 70, amount: 70000, dueDate: "2026-01-10", basis: "BL_DATE" as const, creditDays: 0, pending: null },
    { seq: 2, percent: 30, amount: 30000, dueDate: "2026-04-10", basis: "BL_DATE" as const, creditDays: 90, pending: null },
  ];

  it("fills the first portion before touching the second", () => {
    const { instalments } = allocate(planned, 50000, "2026-02-01");
    expect(instalments[0].settled).toBe(50000);
    expect(instalments[0].outstanding).toBe(20000);
    expect(instalments[1].settled).toBe(0);
    expect(instalments[1].outstanding).toBe(30000);
  });

  it("spills into the second portion once the first is covered", () => {
    const { instalments } = allocate(planned, 80000, "2026-02-01");
    expect(instalments[0].outstanding).toBe(0);
    expect(instalments[1].settled).toBe(10000);
  });

  it("reports an over-payment rather than hiding it", () => {
    const { instalments, unallocated } = allocate(planned, 120000, "2026-02-01");
    expect(instalments.every((i) => i.outstanding === 0)).toBe(true);
    expect(unallocated).toBe(20000);
  });

  it("treats a negative settled figure as nothing settled", () => {
    // a debit note bigger than the receipts means the customer owes more, not
    // that a portion has been un-paid
    const { instalments } = allocate(planned, -5000, "2026-02-01");
    expect(instalments[0].outstanding).toBe(70000);
  });
});

describe("only the portion that has fallen due is overdue", () => {
  const schedule = (settled: number, today: string) =>
    buildSchedule({ invoiceValue: 100000, parts: SPLIT, basisDates: BASIS, settled, today });

  it("counts 70%, not the whole invoice, on the day after the first portion falls due", () => {
    const s = schedule(0, "2026-01-11");
    expect(s.overdueAmount).toBe(70000);
    expect(s.outstanding).toBe(100000);
  });

  it("counts the whole invoice once the second portion has also passed", () => {
    expect(schedule(0, "2026-05-01").overdueAmount).toBe(100000);
  });

  it("counts nothing before the first portion falls due", () => {
    expect(schedule(0, "2026-01-05").overdueAmount).toBe(0);
  });

  it("stops counting the first portion once it has been paid", () => {
    const s = schedule(70000, "2026-02-01");
    expect(s.overdueAmount).toBe(0);
    expect(s.outstanding).toBe(30000);
  });
});

describe("the invoice's single due date is the next portion still owing", () => {
  const schedule = (settled: number) =>
    buildSchedule({ invoiceValue: 100000, parts: SPLIT, basisDates: BASIS, settled, today: "2026-02-01" });

  it("shows the first portion's date while it is unpaid", () => {
    expect(schedule(0).dueDate).toBe("2026-01-10");
  });

  it("moves on by itself once the first portion is paid", () => {
    expect(schedule(70000).dueDate).toBe("2026-04-10");
  });

  it("shows the last portion's date once everything is settled", () => {
    expect(schedule(100000).dueDate).toBe("2026-04-10");
  });

  it("gives no due date when the portion that is owing cannot be dated", () => {
    // 70% on BL (known), 30% on ETA (not known yet) — once the 70% is paid there
    // is genuinely no answer, and saying so is better than borrowing the old one
    const mixed: TermPart[] = [
      { seq: 1, percent: 70, creditDays: 0, basis: "BL_DATE" },
      { seq: 2, percent: 30, creditDays: 0, basis: "ETA" },
    ];
    const s = buildSchedule({
      invoiceValue: 100000,
      parts: mixed,
      basisDates: BASIS,
      settled: 70000,
      today: "2026-02-01",
    });
    expect(s.dueDate).toBeNull();
    expect(s.anchor?.pending).toMatch(/ETA \/ Arrival Date, which is not available yet/);
  });
});

describe("an ordinary one-portion term is untouched", () => {
  const RULE: PaymentTermRule = {
    label: "CAD — 120 days from BL",
    pattern: "Cash Against Documents",
    creditDays: 120,
    basis: "BL_DATE",
  };

  it("fills in a single 100% portion when none is configured", () => {
    expect(rulePartsOf(RULE)).toEqual(singlePart(120, "BL_DATE"));
  });

  it("gives the same date and the same sentence as before split terms existed", () => {
    const plain = computeDueDate("100% Cash Against Documents", BASIS, [RULE]);
    const full = computeDueSchedule({
      paymentTerms: "100% Cash Against Documents",
      basisDates: BASIS,
      rules: [RULE],
      invoiceValue: 18348.49,
      settled: 0,
      today: "2026-02-01",
    });
    expect(full.dueDate).toBe(plain.dueDate);
    expect(full.explanation).toBe(plain.explanation);
    expect(plain.dueDate).toBe("2026-05-10");
    expect(plain.explanation).toBe("BL Date 2026-01-10 + 120 days (rule 'CAD — 120 days from BL').");
  });

  it("does not report itself as split", () => {
    const full = computeDueSchedule({
      paymentTerms: "100% Cash Against Documents",
      basisDates: BASIS,
      rules: [RULE],
      invoiceValue: 18348.49,
      today: "2026-02-01",
    });
    expect(full.schedule.split).toBe(false);
  });

  it("still refuses to guess when no rule matches", () => {
    const none = computeDueSchedule({
      paymentTerms: "100% Cash Against Document (CAD)",
      basisDates: BASIS,
      rules: [],
      invoiceValue: 1000,
    });
    expect(none.dueDate).toBeNull();
    expect(none.explanation).toMatch(/No due-date rule is configured/);
  });
});

describe("the status reflects a partly-due invoice", () => {
  it("is not Overdue while only the unpaid 30% is still to come", () => {
    // 70% paid, second portion not yet due: nothing is late
    const s = buildSchedule({
      invoiceValue: 100000,
      parts: SPLIT,
      basisDates: BASIS,
      settled: 70000,
      today: "2026-02-01",
    });
    expect(paymentStatus(100000, 70000, s.dueDate, "2026-02-01", { overdueAmount: s.overdueAmount }))
      .toBe("PARTIALLY_PAID");
  });

  it("is Overdue the moment any portion is late", () => {
    const s = buildSchedule({
      invoiceValue: 100000,
      parts: SPLIT,
      basisDates: BASIS,
      settled: 0,
      today: "2026-01-11",
    });
    expect(paymentStatus(100000, 0, s.dueDate, "2026-01-11", { overdueAmount: s.overdueAmount }))
      .toBe("OVERDUE");
  });

  it("would have called the same invoice overdue under the old single-date rule", () => {
    // the regression this fixes: on 2026-02-01 the 70% is late and the 30% is
    // not, yet the single date says the whole thing is overdue
    expect(paymentStatus(100000, 70000, "2026-01-10", "2026-02-01")).toBe("OVERDUE");
  });

  it("respects the due-soon window from Settings", () => {
    expect(paymentStatus(1000, 0, "2026-02-20", "2026-02-01", { dueSoonDays: 7 })).toBe("NOT_DUE");
    expect(paymentStatus(1000, 0, "2026-02-20", "2026-02-01", { dueSoonDays: 30 })).toBe("DUE_SOON");
  });
});

describe("a split term describes itself", () => {
  it("reads the way the invoice reads", () => {
    expect(describeParts(SPLIT)).toBe("70% 0d from BL Date + 30% 90d from BL Date");
  });
});
