import { type NextRequest, NextResponse } from "next/server";

import { buildColumns, type AccountsRow } from "@/lib/business/accounts";
import { prisma } from "@/lib/db";
import { todayIso } from "@/lib/extraction/text";
import { buildRegisterCsv, buildRegisterWorkbook } from "@/server/exporter";
import { registerWhere } from "@/server/invoiceQuery";
import { materialiseRows } from "@/server/registerRows";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const q = sp.get("q") ?? "";
  const status = sp.get("status") ?? "";
  const type = sp.get("type") ?? "";
  const currency = sp.get("currency") ?? "";
  const format = sp.get("format") ?? "xlsx";

  const where = registerWhere({ q, status, type, currency });

  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }],
  });
  const today = todayIso();
  const materialised = await materialiseRows(invoices, { today });
  // the export carries exactly the columns the register shows, receipts included
  const columns = buildColumns(materialised.receiptSlots);
  const rows: AccountsRow[] = materialised.rows.map((r) => r.row);

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  if (format === "csv") {
    return new NextResponse(buildRegisterCsv(rows, columns), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="accounts_register_${stamp}.csv"`,
      },
    });
  }

  const buffer = await buildRegisterWorkbook(rows, columns);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="accounts_register_${stamp}.xlsx"`,
    },
  });
}
