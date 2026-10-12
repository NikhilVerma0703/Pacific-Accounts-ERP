/**
 * The endpoint the Commercial ERP will post to.
 *
 * It is deliberately thin: validate the payload, hand it to
 * applyCommercialUpdate, report what was written and what was left alone. The
 * integration itself — how the Commercial ERP is reached, how it authenticates,
 * how often it runs — is not built, and none of it needs to change this file.
 *
 * Before switching this on, add authentication: it writes to the register.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { COMMERCIAL_ERP_SYNC_ENABLED } from "@/lib/config";
import { applyCommercialUpdates, COMMERCIAL_OWNED } from "@/server/commercial";

const updateSchema = z.object({
  invoiceNo: z.string().min(1),
  externalId: z.string().nullable().optional(),
  sourceSystem: z.string().min(1).default("Commercial ERP"),
  updatedAt: z.string().nullable().optional(),
  values: z.record(z.enum(COMMERCIAL_OWNED), z.union([z.string(), z.number(), z.null()])),
});

const bodySchema = z.object({
  authoritative: z.boolean().optional(),
  updates: z.array(updateSchema).min(1).max(500),
});

export async function POST(request: NextRequest) {
  if (!COMMERCIAL_ERP_SYNC_ENABLED) {
    return NextResponse.json(
      {
        error:
          "Commercial ERP sync is not switched on. Set COMMERCIAL_ERP_SYNC=\"true\" once the " +
          "integration and its authentication exist.",
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

  const results = await applyCommercialUpdates(parsed.data.updates, {
    authoritative: parsed.data.authoritative,
  });

  return NextResponse.json({
    updated: results.filter((r) => r.outcome === "updated").length,
    unchanged: results.filter((r) => r.outcome === "unchanged").length,
    notFound: results.filter((r) => r.outcome === "not-found").map((r) => r.invoiceNo),
    results,
  });
}
