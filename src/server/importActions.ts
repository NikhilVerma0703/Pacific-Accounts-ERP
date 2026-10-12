"use server";

/**
 * The two actions that read an uploaded document.
 *
 * Kept apart from the rest of the actions because they import the extraction
 * chain — the Excel and PDF readers, tens of megabytes of module graph — and in
 * Next a route inherits the whole server graph of everything it imports. When
 * these lived alongside the receipt and shipping actions, opening any screen with
 * a form paid for the readers. Only /import and /receipts/import import this.
 */
import { revalidatePath } from "next/cache";

import { MAX_UPLOAD_BYTES } from "@/lib/config";
import { ingestFile, type IngestResult } from "@/server/ingest";
import { importReceiptFile, type ReceiptImportResult } from "@/server/receiptImport";

// ---------------------------------------------------------------- import
export interface ImportState {
  results: IngestResult[];
  ran: boolean;
}

export async function importInvoicesAction(
  _prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const replace = formData.get("replace") === "1";
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

  const results: IngestResult[] = [];
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      results.push({
        outcome: "failed",
        message: `'${file.name}' is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
        invoiceId: null,
        invoiceNo: null,
        fileName: file.name,
        quality: null,
        warnings: [],
        ok: false,
      });
      continue;
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    results.push(await ingestFile(buffer, file.name, { replaceExisting: replace }));
  }

  revalidatePath("/invoices");
  revalidatePath("/");
  return { results, ran: true };
}


// ---------------------------------------------------------------- receipt import
export interface ReceiptImportState {
  results: ReceiptImportResult[];
  ran: boolean;
}

/**
 * Read receipts off one or more payment documents. Every line lands through the
 * same `saveReceipt` the manual form uses, so an imported receipt and a typed
 * one are the same record.
 */
export async function importReceiptsAction(
  _prev: ReceiptImportState,
  formData: FormData,
): Promise<ReceiptImportState> {
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

  const results: ReceiptImportResult[] = [];
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      results.push({
        fileName: file.name,
        ok: false,
        imported: 0,
        skipped: 0,
        lines: [],
        warnings: [],
        message: `'${file.name}' is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
      });
      continue;
    }
    results.push(await importReceiptFile(Buffer.from(await file.arrayBuffer()), file.name));
  }

  revalidatePath("/invoices");
  revalidatePath("/");
  return { results, ran: true };
}

