/** Data-quality scoring and the "what do I still need?" list. */
import { BY_KEY, CATALOG, accountsColumnKeys, criticalKeys } from "../extraction/catalog";
import { FieldStatus, isUsable } from "../extraction/types";
import { fieldStatus, fieldValue, type NormalizedInvoice } from "./normalizer";

export type Severity = "blocker" | "verify" | "later";

const SEVERITY_ORDER: Record<Severity, number> = { blocker: 0, verify: 1, later: 2 };

export interface Issue {
  key: string;
  label: string;
  severity: Severity;
  message: string;
}

export interface Quality {
  counts: Record<string, number>;
  criticalFound: number;
  criticalTotal: number;
  accountsFound: number;
  accountsTotal: number;
  criticalPct: number;
  accountsPct: number;
  issues: Issue[];
}

export function blockers(q: Quality): Issue[] {
  return q.issues.filter((i) => i.severity === "blocker");
}

export function verifications(q: Quality): Issue[] {
  return q.issues.filter((i) => i.severity === "verify");
}

export function laterItems(q: Quality): Issue[] {
  return q.issues.filter((i) => i.severity === "later");
}

export function assess(n: NormalizedInvoice): Quality {
  const counts: Record<string, number> = {};
  for (const status of Object.values(FieldStatus)) counts[status] = 0;
  for (const f of Object.values(n.fields)) counts[f.status] = (counts[f.status] ?? 0) + 1;

  const critical = criticalKeys();
  const criticalFound = critical.filter(
    (k) => isUsable(fieldStatus(n, k)) && fieldValue(n, k) !== null,
  ).length;

  const accounts = accountsColumnKeys().filter((k) => (BY_KEY[k]?.origin ?? "invoice") === "invoice");
  const accountsFound = accounts.filter(
    (k) => isUsable(fieldStatus(n, k)) && fieldValue(n, k) !== null,
  ).length;

  const issues: Issue[] = [];
  for (const fd of CATALOG) {
    const f = n.fields[fd.key];
    if (!f) continue;
    const origin = fd.origin ?? "invoice";
    if (f.status === FieldStatus.NEEDS_VERIFICATION) {
      issues.push({
        key: fd.key,
        label: fd.label,
        severity: "verify",
        message: f.note ?? "Value was inferred — please confirm.",
      });
    } else if (f.value === null && f.status === FieldStatus.MISSING) {
      const severity: Severity = fd.critical ? "blocker" : origin !== "invoice" ? "later" : "verify";
      issues.push({
        key: fd.key,
        label: fd.label,
        severity,
        message: f.note ?? "Not found on the document.",
      });
    } else if (f.value === null && f.status === FieldStatus.NOT_PRESENT && origin !== "invoice") {
      issues.push({
        key: fd.key,
        label: fd.label,
        severity: "later",
        message: f.note ?? "Will come from another source.",
      });
    }
  }
  issues.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.label.localeCompare(b.label),
  );

  return {
    counts,
    criticalFound,
    criticalTotal: critical.length,
    accountsFound,
    accountsTotal: accounts.length,
    criticalPct: critical.length ? Math.round((100 * criticalFound) / critical.length) : 0,
    accountsPct: accounts.length ? Math.round((100 * accountsFound) / accounts.length) : 0,
    issues,
  };
}
