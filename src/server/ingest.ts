/**
 * Reading an uploaded document into the register: upload → extract → normalize →
 * validate → Accounts row → store.
 *
 * Everything in this file touches a *document*, which is why it is the only place
 * that imports the Excel and PDF readers. Anything that merely reads or writes the
 * database lives in invoiceData.ts — see the note there — so that rendering a
 * screen never loads a reader.
 */
import "server-only";

import { createHash } from "node:crypto";

import { buildAccountsRow } from "@/lib/business/accounts";
import { prisma } from "@/lib/db";
import {
  detectFormat,
  extractDocument,
  EXTRACTION_VERSION,
  UnsupportedDocumentError,
} from "@/lib/extraction";
import { fieldString, normalize, type NormalizedInvoice } from "@/lib/normalize/normalizer";
import { assess, type Quality } from "@/lib/normalize/validators";
import {
  applyManualValue as applyManual,
  invoiceScalarsFor as scalarsFor,
  loadRules as loadPaymentRules,
  receiptsAndNotes as receiptsFor,
} from "@/server/invoiceData";

export {
  applyManualValue,
  deleteInvoice,
  invoiceScalarsFor,
  loadRules,
  rebuildAllInvoices,
  rebuildInvoice,
  receiptsAndNotes,
} from "@/server/invoiceData";

export type IngestOutcome = "imported" | "updated" | "duplicate" | "failed";

export interface IngestResult {
  outcome: IngestOutcome;
  message: string;
  invoiceId: string | null;
  invoiceNo: string | null;
  fileName: string;
  quality: Quality | null;
  warnings: string[];
  ok: boolean;
}

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}





export interface IngestOptions {
  replaceExisting?: boolean;
}

export async function ingestFile(
  buffer: Buffer,
  fileName: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const { replaceExisting = false } = options;
  const base = {
    fileName,
    invoiceId: null,
    invoiceNo: null,
    quality: null,
    warnings: [] as string[],
  };

  const format = detectFormat(fileName);
  if (!format) {
    const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : "unknown";
    const message = `'${fileName}' is a ${ext} file. Phase 1 reads Excel (.xlsx/.xlsm) and text-based PDF commercial invoices.`;
    await prisma.importLog.create({ data: { fileName, outcome: "FAILED", message } });
    return { ...base, outcome: "failed", message, ok: false };
  }

  const digest = sha256(buffer);
  const existingDoc = await prisma.invoiceDocument.findUnique({
    where: { sha256: digest },
    include: { invoice: { select: { id: true, invoiceNo: true, createdAt: true } } },
  });
  if (existingDoc && !replaceExisting) {
    const message = `This exact file was already imported on ${existingDoc.invoice.createdAt
      .toISOString()
      .slice(0, 10)} as invoice ${existingDoc.invoice.invoiceNo}.`;
    await prisma.importLog.create({
      data: {
        fileName,
        fileHash: digest,
        outcome: "DUPLICATE",
        invoiceId: existingDoc.invoiceId,
        message,
      },
    });
    return {
      ...base,
      outcome: "duplicate",
      message,
      invoiceId: existingDoc.invoiceId,
      invoiceNo: existingDoc.invoice.invoiceNo,
      ok: false,
    };
  }

  let normalized: NormalizedInvoice;
  let quality: Quality;
  try {
    const extraction = await extractDocument(buffer, fileName);
    normalized = normalize(extraction);
    quality = assess(normalized);
  } catch (error) {
    const message =
      error instanceof UnsupportedDocumentError
        ? error.message
        : `Could not read '${fileName}': ${(error as Error).message}`;
    await prisma.importLog.create({
      data: { fileName, fileHash: digest, outcome: "FAILED", message },
    });
    return { ...base, outcome: "failed", message, ok: false };
  }

  const invoiceNo = fieldString(normalized, "invoiceNo");
  if (!invoiceNo) {
    const message =
      `No invoice number could be read from '${fileName}'. The record was not saved, ` +
      "because the invoice number is what prevents duplicates.";
    await prisma.importLog.create({
      data: { fileName, fileHash: digest, outcome: "FAILED", message },
    });
    return {
      ...base,
      outcome: "failed",
      message,
      quality,
      warnings: normalized.warnings,
      ok: false,
    };
  }

  const existing = await prisma.invoice.findUnique({ where: { invoiceNo } });
  if (existing && !replaceExisting) {
    const message =
      `Invoice ${invoiceNo} is already in the register (imported ` +
      `${existing.createdAt.toISOString().slice(0, 10)}).`;
    await prisma.importLog.create({
      data: {
        fileName,
        fileHash: digest,
        outcome: "DUPLICATE",
        invoiceId: existing.id,
        message,
      },
    });
    return {
      ...base,
      outcome: "duplicate",
      message,
      invoiceId: existing.id,
      invoiceNo,
      quality,
      warnings: normalized.warnings,
      ok: false,
    };
  }

  const rules = await loadPaymentRules();
  // re-importing an invoice must not lose the receipts or notes recorded against it
  const { receipts, notes } = existing
    ? await receiptsFor(existing.id)
    : { receipts: [], notes: [] };
  const row = buildAccountsRow(normalized, quality, { slNo: 1, receipts, notes, rules });
  const scalars = { ...scalarsFor(normalized, row, quality), extractionVersion: EXTRACTION_VERSION };

  const invoice = existing
    ? await prisma.invoice.update({ where: { id: existing.id }, data: scalars })
    : await prisma.invoice.create({ data: scalars });

  const documentData = {
    fileName,
    format: format.toUpperCase(),
    sha256: digest,
    sizeBytes: buffer.byteLength,
    content: new Uint8Array(buffer),
  };
  await prisma.invoiceDocument.upsert({
    where: { invoiceId: invoice.id },
    create: { invoiceId: invoice.id, ...documentData },
    update: documentData,
  });

  const outcome: IngestOutcome = existing ? "updated" : "imported";
  await prisma.importLog.create({
    data: {
      fileName,
      fileHash: digest,
      outcome: outcome.toUpperCase(),
      invoiceId: invoice.id,
      message: `${quality.accountsPct}% of invoice fields captured`,
    },
  });

  return {
    outcome,
    message: `Invoice ${invoiceNo} ${existing ? "updated" : "imported"}.`,
    invoiceId: invoice.id,
    invoiceNo,
    fileName,
    quality,
    warnings: normalized.warnings,
    ok: true,
  };
}




/**
 * Read a stored invoice's own file again with the current reader, then put back
 * every manual correction on top.
 *
 * This is how an improvement to extraction reaches invoices that are already in
 * the register. Nothing is asked of the user: the file they uploaded is kept
 * with the invoice for exactly this.
 */
export async function reextractInvoice(invoiceId: string): Promise<boolean> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { document: true, receipts: true, edits: { orderBy: { createdAt: "asc" } } },
  });
  if (!invoice?.document) return false;

  let normalized: NormalizedInvoice;
  try {
    normalized = normalize(
      await extractDocument(Buffer.from(invoice.document.content), invoice.document.fileName),
    );
  } catch {
    // an unreadable stored file must not block the register
    return false;
  }

  // corrections are replayed oldest to newest, so the latest one wins
  for (const edit of invoice.edits) {
    if (edit.newValue === null) continue;
    applyManual(normalized.fields, edit.fieldKey, edit.newValue, edit.editedBy);
  }

  const quality = assess(normalized);
  const rules = await loadPaymentRules();
  const { receipts, notes } = await receiptsFor(invoice.id);
  const row = buildAccountsRow(normalized, quality, { slNo: 1, receipts, notes, rules });

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { ...scalarsFor(normalized, row, quality), extractionVersion: EXTRACTION_VERSION },
  });
  return true;
}

/**
 * Re-read the invoices that an older version of the reader produced.
 *
 * Capped per call: re-reading a file costs real time, and a register of several
 * hundred invoices must not turn one page load into a minute. The rest follow on
 * the next views, and the count is reported so the screen can say so.
 */
export async function reextractStale(limit = 25): Promise<number> {
  const stale = await prisma.invoice.findMany({
    where: { extractionVersion: { lt: EXTRACTION_VERSION }, document: { isNot: null } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let done = 0;
  for (const { id } of stale) {
    if (await reextractInvoice(id)) done += 1;
    else {
      // no usable file: stamp it so it is not retried on every page load
      await prisma.invoice.update({
        where: { id },
        data: { extractionVersion: EXTRACTION_VERSION },
      });
    }
  }
  return done;
}



export async function reextractAllInvoices(): Promise<number> {
  const docs = await prisma.invoiceDocument.findMany({ select: { invoiceId: true } });
  let done = 0;
  for (const { invoiceId } of docs) {
    if (await reextractInvoice(invoiceId)) done += 1;
  }
  return done;
}
