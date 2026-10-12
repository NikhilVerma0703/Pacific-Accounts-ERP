import type { Prisma } from "@prisma/client";

export interface RegisterFilters {
  q?: string;
  status?: string;
  type?: string;
  currency?: string;
  group?: string;
}

/**
 * One place that knows how the register is filtered — page and export share it.
 * SQLite's LIKE is already case-insensitive for ASCII, so no `mode` is needed.
 */
export function registerWhere(filters: RegisterFilters): Prisma.InvoiceWhereInput {
  const where: Prisma.InvoiceWhereInput = {};
  const q = filters.q?.trim();
  if (q) {
    where.OR = [
      { invoiceNo: { contains: q } },
      { customerName: { contains: q } },
      { consigneeName: { contains: q } },
      { poNo: { contains: q } },
      { containerNo: { contains: q } },
      { blNo: { contains: q } },
      { shippingBillNo: { contains: q } },
    ];
  }
  if (filters.status) where.status = filters.status;
  if (filters.type) where.invoiceType = filters.type;
  if (filters.currency) where.currency = filters.currency;
  return where;
}
