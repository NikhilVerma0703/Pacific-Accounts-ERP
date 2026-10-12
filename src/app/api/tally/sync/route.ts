/**
 * The endpoint a Tally export or e-Invoice feed will post to.
 *
 * Thin on purpose: validate, hand to applyBooksUpdate, report what was written
 * and what was left alone. Neither Tally nor the IRP is connected; this exists so
 * that when one is, the work is an adapter rather than a redesign.
 *
 * Refused until COMMERCIAL_ERP_SYNC is on, because it writes to the register and
 * has no authentication of its own yet.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { COMMERCIAL_ERP_SYNC_ENABLED } from "@/lib/config";
import { applyBooksUpdates, BOOKS_FIELDS } from "@/server/tally";

const bodySchema = z.object({
  authoritative: z.boolean().optional(),
  updates: z
    .array(
      z.object({
        invoiceNo: z.string().min(1),
        sourceSystem: z.string().min(1).default("Tally"),
        values: z.record(z.enum(BOOKS_FIELDS), z.union([z.string(), z.number(), z.null()])),
      }),
    )
    .min(1)
    .max(500),
});

export async function POST(request: NextRequest) {
  if (!COMMERCIAL_ERP_SYNC_ENABLED) {
    return NextResponse.json(
      {
        error:
          "Tally / e-Invoice sync is not switched on. Set COMMERCIAL_ERP_SYNC=\"true\" once the " +
          "integration and its authentication exist.",
        acceptedFields: BOOKS_FIELDS,
      },
      { status: 501 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Unrecognised payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const results = await applyBooksUpdates(parsed.data.updates, {
    authoritative: parsed.data.authoritative,
  });

  return NextResponse.json({
    updated: results.filter((r) => r.outcome === "updated").length,
    unchanged: results.filter((r) => r.outcome === "unchanged").length,
    notFound: results.filter((r) => r.outcome === "not-found").map((r) => r.invoiceNo),
    results,
  });
}
