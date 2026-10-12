/**
 * Export the report currently on screen, with its filters applied.
 *
 * The screen and this route call the same `buildReport`, so what downloads is
 * exactly what was being looked at — the same rows, the same totals, the same
 * calculated values.
 */
import { type NextRequest, NextResponse } from "next/server";

import { buildReportCsv, buildReportWorkbook, safeFileName } from "@/server/exporter";
import { buildReport, type ReportFilters } from "@/server/reports";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const filters: ReportFilters = {
    report: sp.get("report") ?? undefined,
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    customer: sp.get("customer") ?? undefined,
    currency: sp.get("currency") ?? undefined,
    status: sp.get("status") ?? undefined,
    paid: sp.get("paid") ?? undefined,
    overdue: sp.get("overdue") ?? undefined,
    q: sp.get("q") ?? undefined,
  };

  const { report } = await buildReport(filters);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const name = `${safeFileName(report.label)}_${stamp}`;

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
