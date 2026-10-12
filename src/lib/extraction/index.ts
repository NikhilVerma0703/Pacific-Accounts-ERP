/**
 * Document extraction entry point.
 *
 * Phase 2/3 sources (e-Invoice PDF, Tally export, bank statement, CN/DN) plug in
 * here by adding another reader. Nothing downstream changes: everything consumes
 * an ExtractionResult keyed by the canonical catalogue.
 */
import { readInvoice } from "./invoiceReader";
import { readReceipts, type ReceiptExtraction } from "./receiptReader";
import { loadSheetGrids } from "./sheetGrid";
import { pdfHasText, pdfToGrid } from "./textGrid";
import type { ExtractionResult, SourceFormat } from "./types";

export * from "./types";
export * from "./catalog";
export { readInvoice, sheetScore } from "./invoiceReader";
export { readReceipts } from "./receiptReader";
export type { ReceiptExtraction, ReceiptLine } from "./receiptReader";

export class UnsupportedDocumentError extends Error {}

export { EXTRACTION_VERSION } from "./version";

export const SUPPORTED_EXTENSIONS = [".xlsx", ".xlsm", ".xltx", ".pdf"] as const;

export function detectFormat(fileName: string): SourceFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xltx")) return "xlsx";
  return null;
}

export async function extractDocument(
  buffer: Buffer,
  fileName: string,
): Promise<ExtractionResult> {
  const format = detectFormat(fileName);
  if (!format) {
    const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : "unknown";
    throw new UnsupportedDocumentError(
      `'${fileName}' is a ${ext} file. Phase 1 reads Excel (.xlsx/.xlsm) and text-based PDF commercial invoices.`,
    );
  }

  if (format === "pdf") {
    if (!(await pdfHasText(buffer))) {
      throw new UnsupportedDocumentError(
        "This PDF has no text layer (it looks like a scan or an image). Phase 1 reads " +
          "text-based PDFs and Excel files; please upload the Excel invoice or a digitally " +
          "generated PDF.",
      );
    }
    const grid = await pdfToGrid(buffer);
    const result = readInvoice([grid], "pdf");
    result.sourceName = fileName;
    result.warnings.push(
      "Read from a PDF: column positions are inferred from the page layout, so please " +
        "spot-check the amounts and the product table.",
    );
    return result;
  }

  const grids = await loadSheetGrids(buffer);
  if (!grids.length) throw new UnsupportedDocumentError("Workbook has no worksheets");
  const result = readInvoice(grids, "xlsx");
  result.sourceName = fileName;
  return result;
}

/**
 * Read receipts off a payment sheet or remittance PDF.
 *
 * The second document type, and the proof that the layering holds: it reuses the
 * same grids, so nothing about Excel or PDF handling is written twice.
 */
export async function extractReceipts(
  buffer: Buffer,
  fileName: string,
): Promise<ReceiptExtraction> {
  const format = detectFormat(fileName);
  if (!format) {
    const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : "unknown";
    throw new UnsupportedDocumentError(
      `'${fileName}' is a ${ext} file. Receipts can be read from Excel (.xlsx/.xlsm) and ` +
        "text-based PDF payment advices.",
    );
  }

  if (format === "pdf") {
    if (!(await pdfHasText(buffer))) {
      throw new UnsupportedDocumentError(
        "This PDF has no text layer (it looks like a scan). Please upload the Excel version " +
          "or a digitally generated PDF.",
      );
    }
    return readReceipts([await pdfToGrid(buffer)], fileName);
  }

  const grids = await loadSheetGrids(buffer);
  if (!grids.length) throw new UnsupportedDocumentError("Workbook has no worksheets");
  return readReceipts(grids, fileName);
}
