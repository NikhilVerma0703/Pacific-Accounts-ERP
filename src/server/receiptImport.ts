/**
 * Importing receipts from a payment sheet or remittance advice.
 *
 * Every line the reader finds is matched to an invoice by its invoice number and
 * then written through `saveReceipt` — the same function the manual form uses.
 * A line that cannot be matched is reported with the reason and the cell it came
 * from, never guessed at: posting a receipt against the wrong invoice is the one
 * mistake this module must not make.
 */
import "server-only";

import { prisma } from "@/lib/db";
import { extractReceipts, UnsupportedDocumentError } from "@/lib/extraction";
import type { ReceiptLine } from "@/lib/extraction";
import { nextSeq, saveReceipt } from "@/server/receipts";

export type LineOutcome = "imported" | "skipped";

export interface ReceiptImportLine {
  outcome: LineOutcome;
  invoiceNo: string | null;
  invoiceId: string | null;
  amount: number | null;
  receiptDate: string | null;
  exchangeRate: number | null;
  seq: number | null;
  source: string;
  message: string;
}

export interface ReceiptImportResult {
  fileName: string;
  ok: boolean;
  imported: number;
  skipped: number;
  lines: ReceiptImportLine[];
  warnings: string[];
  message: string;
}

/**
 * Invoice numbers are printed inconsistently — spacing, case, a stray hyphen —
 * so matching ignores everything that is not a letter or a digit. It still has
 * to be an exact match after that: no fuzzy or partial matching, because a
 * near-miss would post money against someone else's invoice.
 */
function matchKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function invoiceIndex(): Promise<Map<string, { id: string; invoiceNo: string }>> {
  const invoices = await prisma.invoice.findMany({ select: { id: true, invoiceNo: true } });
  const index = new Map<string, { id: string; invoiceNo: string }>();
  for (const inv of invoices) index.set(matchKey(inv.invoiceNo), inv);
  return index;
}

function skip(line: ReceiptLine, message: string): ReceiptImportLine {
  return {
    outcome: "skipped",
    invoiceNo: line.invoiceNo,
    invoiceId: null,
    amount: line.amount,
    receiptDate: line.receiptDate,
    exchangeRate: line.exchangeRate,
    seq: null,
    source: line.source,
    message,
  };
}

export async function importReceiptFile(
  buffer: Buffer,
  fileName: string,
): Promise<ReceiptImportResult> {
  const base = { fileName, imported: 0, skipped: 0, lines: [] as ReceiptImportLine[] };

  let extraction;
  try {
    extraction = await extractReceipts(buffer, fileName);
  } catch (error) {
    const message =
      error instanceof UnsupportedDocumentError
        ? error.message
        : `Could not read '${fileName}': ${(error as Error).message}`;
    await prisma.importLog.create({ data: { fileName, outcome: "FAILED", message } });
    return { ...base, ok: false, warnings: [], message };
  }

  if (!extraction.lines.length) {
    const message = extraction.warnings[0] ?? `No receipts were found in '${fileName}'.`;
    await prisma.importLog.create({ data: { fileName, outcome: "FAILED", message } });
    return { ...base, ok: false, warnings: extraction.warnings, message };
  }

  const index = await invoiceIndex();
  const lines: ReceiptImportLine[] = [];

  for (const line of extraction.lines) {
    if (line.amount === null) {
      lines.push(skip(line, "No amount could be read on this line."));
      continue;
    }
    if (line.amount <= 0) {
      lines.push(skip(line, "The amount is zero or negative, so it was left out."));
      continue;
    }
    if (!line.invoiceNo) {
      lines.push(skip(line, "No invoice number on this line, so there is nothing to post it to."));
      continue;
    }

    const invoice = index.get(matchKey(line.invoiceNo));
    if (!invoice) {
      lines.push(
        skip(line, `Invoice ${line.invoiceNo} is not in the register — import that invoice first.`),
      );
      continue;
    }

    const seq = await nextSeq(invoice.id);
    const saved = await saveReceipt(invoice.id, {
      seq,
      amount: line.amount,
      receiptDate: line.receiptDate,
      exchangeRate: line.exchangeRate,
      bankRef: line.bankRef,
      source: `read from ${fileName} ${line.source}`,
    });

    if (!saved.ok) {
      lines.push(skip(line, saved.message));
      continue;
    }

    lines.push({
      outcome: "imported",
      invoiceNo: invoice.invoiceNo,
      invoiceId: invoice.id,
      amount: line.amount,
      receiptDate: line.receiptDate,
      exchangeRate: line.exchangeRate,
      seq,
      source: line.source,
      message:
        line.exchangeRate === null
          ? `Added as Receipt ${seq}. No exchange rate on the document — enter it to get the forex gain/loss.`
          : `Added as Receipt ${seq}.`,
    });
  }

  const imported = lines.filter((l) => l.outcome === "imported").length;
  const skipped = lines.length - imported;
  const message = `${imported} receipt(s) imported from '${fileName}'${
    skipped ? `, ${skipped} line(s) left out` : ""
  }.`;

  await prisma.importLog.create({
    data: {
      fileName,
      outcome: imported ? "IMPORTED" : "FAILED",
      message: `Receipts: ${message}`,
    },
  });

  return {
    fileName,
    ok: imported > 0,
    imported,
    skipped,
    lines,
    warnings: extraction.warnings,
    message,
  };
}
