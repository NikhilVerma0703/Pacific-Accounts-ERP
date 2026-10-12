/**
 * Background jobs — optional.
 *
 * Locally (`USE_INNGEST=false`, the default) the same work runs inline in the
 * request and nothing here needs to be running. Set `USE_INNGEST=true` and start
 * `npm run inngest:dev` to move it off the request, which is what production
 * should do once the register is large.
 *
 * Uploading an invoice always extracts synchronously — it takes a fraction of a
 * second and the Accounts employee wants to review the result immediately.
 */
import { prisma } from "@/lib/db";
import { ingestFile, rebuildAllInvoices, reextractAllInvoices } from "@/server/ingest";

import { EVENTS, inngest, type ReextractInvoiceData } from "./client";

export const recalculateAfterRuleChange = inngest.createFunction(
  {
    id: "recalculate-after-rule-change",
    name: "Recalculate register after a rule change",
    triggers: [{ event: EVENTS.rulesChanged }],
  },
  async ({ step }) => {
    const rebuilt = await step.run("rebuild-all", () => rebuildAllInvoices());
    return { rebuilt };
  },
);

export const reextractInvoice = inngest.createFunction(
  {
    id: "reextract-invoice",
    name: "Re-extract one stored invoice",
    triggers: [{ event: EVENTS.reextractInvoice }],
  },
  async ({ event, step }) => {
    const { invoiceId } = event.data as ReextractInvoiceData;
    return step.run("reextract", async () => {
      const doc = await prisma.invoiceDocument.findUnique({ where: { invoiceId } });
      if (!doc) return { skipped: true, reason: "no stored document" };
      const outcome = await ingestFile(Buffer.from(doc.content), doc.fileName, {
        replaceExisting: true,
      });
      return { skipped: false, outcome: outcome.outcome, message: outcome.message };
    });
  },
);

export const reextractAll = inngest.createFunction(
  {
    id: "reextract-all-invoices",
    name: "Re-extract every stored invoice",
    triggers: [{ event: EVENTS.reextractAll }],
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    const reextracted = await step.run("reextract-all", () => reextractAllInvoices());
    return { reextracted };
  },
);

/**
 * Overnight refresh: due dates, overdue days and status drift with the calendar
 * even when nothing is edited, so the register is recomputed once a day.
 */
export const dailyStatusRefresh = inngest.createFunction(
  {
    id: "daily-status-refresh",
    name: "Daily due / overdue refresh",
    triggers: [{ cron: "TZ=Asia/Kolkata 30 1 * * *" }],
  },
  async ({ step }) => {
    const refreshed = await step.run("rebuild-all", () => rebuildAllInvoices());
    return { refreshed };
  },
);

export const functions = [
  recalculateAfterRuleChange,
  reextractInvoice,
  reextractAll,
  dailyStatusRefresh,
];
