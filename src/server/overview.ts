/**
 * The two cross-invoice views: what shipping still needs, and how the books
 * compare with the invoices.
 *
 * Both read the stored register row rather than recomputing anything, so a figure
 * on these screens is the same figure the register and the exports show.
 */
import "server-only";

import type { AccountsRow } from "@/lib/business/accounts";
import { prisma } from "@/lib/db";
import { fromJson } from "@/lib/json";

export interface OverviewRow {
  id: string;
  invoiceNo: string;
  invoiceDate: string | null;
  customerName: string | null;
  currency: string;
  row: AccountsRow;
  /** Which of the asked-for keys have no value yet. */
  missing: string[];
}

export async function loadOverview(
  keys: readonly string[],
  opts: { q?: string; only?: "missing" | "complete" } = {},
): Promise<{ rows: OverviewRow[]; complete: number; partial: number }> {
  const invoices = await prisma.invoice.findMany({
    where: opts.q
      ? {
          OR: [
            { invoiceNo: { contains: opts.q } },
            { customerName: { contains: opts.q } },
            { consigneeName: { contains: opts.q } },
          ],
        }
      : undefined,
    orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      invoiceNo: true,
      invoiceDate: true,
      customerName: true,
      currency: true,
      accountsRow: true,
      fields: true,
    },
  });

  const rows: OverviewRow[] = [];
  for (const inv of invoices) {
    const row = fromJson<AccountsRow>(inv.accountsRow, {} as AccountsRow);
    const stored = fromJson<Record<string, { value: unknown }>>(inv.fields, {});
    const missing = keys.filter((k) => {
      const v = stored[k]?.value ?? row[k]?.value ?? null;
      return v === null || v === undefined || v === "";
    });

    if (opts.only === "missing" && missing.length === 0) continue;
    if (opts.only === "complete" && missing.length > 0) continue;

    rows.push({
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      invoiceDate: inv.invoiceDate ? inv.invoiceDate.toISOString().slice(0, 10) : null,
      customerName: inv.customerName,
      currency: inv.currency ?? "—",
      row,
      missing,
    });
  }

  return {
    rows,
    complete: rows.filter((r) => r.missing.length === 0).length,
    partial: rows.filter((r) => r.missing.length > 0).length,
  };
}

/** The value of one field as stored, for a table cell. */
export function storedValue(inv: OverviewRow, key: string): string {
  const cell = inv.row[key];
  if (cell?.display) return cell.display;
  return "—";
}
