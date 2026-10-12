/**
 * Export the master table exactly as it is on screen.
 *
 * The screen and this route call the same `loadTracking` and `filterInvoices`,
 * so the download is the view that was being looked at — same filters, same
 * sort, same figures. It also carries its own provenance: the date it was
 * generated, the filters applied, how many invoices had a due date that could
 * be established, and what each calculated column means.
 */
import { type NextRequest, NextResponse } from "next/server";

import { buildTrackingExport } from "@/server/payments/export";
import { buildReportCsv, buildReportWorkbook, safeFileName } from "@/server/exporter";
import { filterInvoices, loadTracking, type TrackingFilters } from "@/server/payments/query";

const KEYS = [
  "q", "customer", "currency", "status", "ageing", "po", "term",
  "from", "to", "dateField", "attention", "nilReceived", "verify", "open",
  "sort", "dir", "group",
] as const;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const filters: TrackingFilters = {};
  for (const k of KEYS) {
    const v = sp.get(k);
    if (v) filters[k] = v;
  }

  const { invoices, today, params } = await loadTracking();
  const visible = filterInvoices(invoices, filters);
  const report = buildTrackingExport(visible, { today, filters, params });

  const stamp = today.replace(/-/g, "");
  const scope = filters.customer ? `_${safeFileName(filters.customer)}` : "";
  const name = `Payment_Tracking${scope}_${stamp}`;

  if ((sp.get("format") ?? "xlsx") === "csv") {
    return new NextResponse(buildReportCsv(report.columns, report.rows, report.totals), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}.csv"`,
      },
    });
  }

  const buffer = await buildReportWorkbook(
    report.label,
    report.columns,
    report.rows,
    report.totals,
    report.note,
  );
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}.xlsx"`,
    },
  });
}
