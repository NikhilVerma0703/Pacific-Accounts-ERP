import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { fromJson } from "@/lib/json";
import type { ExtractedField, LineItem } from "@/lib/extraction/types";
import { buildExtractionWorkbook, safeFileName } from "@/server/exporter";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const buffer = await buildExtractionWorkbook(
    invoice.invoiceNo,
    fromJson<Record<string, ExtractedField>>(invoice.fields, {}),
    fromJson<LineItem[]>(invoice.lineItems, []),
  );

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="invoice_${safeFileName(invoice.invoiceNo)}_extraction.xlsx"`,
    },
  });
}
