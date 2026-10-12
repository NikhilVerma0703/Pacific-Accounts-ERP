/**
 * Reading receipts off a payment sheet, bank advice or remittance PDF.
 *
 * This is the second document type the extraction layer handles, and it is
 * deliberately built on the same `Grid` the invoice reader uses — so one reader
 * serves both Excel and text PDFs, and a new payment-advice layout is usually a
 * matter of adding words to the header dictionary below.
 *
 * What it looks for is a table: a header row naming an invoice column and an
 * amount column, then one row per receipt underneath. Anything it cannot place
 * is reported rather than guessed at, because a receipt posted against the wrong
 * invoice is worse than one not posted at all.
 */
import { findInvoiceNoLike, toIsoDate, toNumber } from "./text";
import type { Grid } from "./types";

export interface ReceiptLine {
  /** The invoice this receipt belongs to, exactly as printed. */
  invoiceNo: string | null;
  receiptDate: string | null;
  /** The FCY amount received. */
  amount: number | null;
  exchangeRate: number | null;
  bankRef: string | null;
  /** Where on the document this line came from, e.g. "Sheet1!A7". */
  source: string;
  /** Anything that stopped this line being usable. */
  problem: string | null;
}

export interface ReceiptExtraction {
  lines: ReceiptLine[];
  warnings: string[];
  sourceName: string;
}

type ColumnKind = "invoiceNo" | "date" | "amount" | "rate" | "bankRef";

/**
 * The words each column can be called. Adding a bank's own wording is a one-line
 * change here — no other code needs to know about it.
 */
const HEADERS: Record<ColumnKind, string[]> = {
  invoiceNo: [
    "invoice no", "invoice number", "invoice", "inv no", "inv. no", "bill no",
    "document no", "reference invoice", "against invoice", "invoice ref",
  ],
  date: [
    "receipt date", "payment date", "value date", "date of receipt", "credit date",
    "transaction date", "date",
  ],
  amount: [
    "receipt fcy", "fcy", "receipt amount", "amount received", "amount credited",
    "credit amount", "remittance amount", "payment amount", "amount", "received",
  ],
  rate: [
    "exchange rate for receipt", "receipt exchange rate", "exchange rate", "conversion rate",
    "rate", "fx rate", "inr rate",
  ],
  bankRef: [
    "bank ref", "bank reference", "utr", "utr no", "reference no", "transaction ref",
    "swift ref", "advice no", "remittance ref",
  ],
};

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function classify(text: string): ColumnKind | null {
  const s = norm(text);
  if (!s) return null;
  // longest match first, so "receipt exchange rate" beats "rate" and
  // "receipt amount" is not mistaken for a plain "date"
  let best: { kind: ColumnKind; len: number } | null = null;
  for (const [kind, words] of Object.entries(HEADERS) as Array<[ColumnKind, string[]]>) {
    for (const w of words) {
      if (s === w || s.startsWith(`${w} `) || s.endsWith(` ${w}`) || s.includes(` ${w} `)) {
        if (!best || w.length > best.len) best = { kind, len: w.length };
      }
    }
  }
  return best?.kind ?? null;
}

/** The first row that names at least an amount column and one other column. */
function findHeaderRow(g: Grid): { row: number; columns: Map<ColumnKind, number> } | null {
  for (let r = g.body.minRow; r <= Math.min(g.body.maxRow, g.body.minRow + 40); r += 1) {
    const found = new Map<ColumnKind, number>();
    for (const [c, text] of g.rowTexts(r)) {
      const kind = classify(text);
      if (kind && !found.has(kind)) found.set(kind, c);
    }
    if (found.has("amount") && found.size >= 2) return { row: r, columns: found };
  }
  return null;
}

function readLine(
  g: Grid,
  row: number,
  columns: Map<ColumnKind, number>,
): ReceiptLine | null {
  const at = (kind: ColumnKind): string => {
    const c = columns.get(kind);
    return c === undefined ? "" : g.text(row, c);
  };

  const amountText = at("amount");
  const amount = toNumber(amountText);
  const invoiceCell = at("invoiceNo");
  const dateText = at("date");

  // a row with nothing in any of the three columns that matter is a spacer,
  // a total line, or the end of the table
  if (!amountText && !invoiceCell && !dateText) return null;

  const anchorCol = columns.get("invoiceNo") ?? columns.get("amount") ?? g.body.minCol;
  const source = g.coord(row, anchorCol);

  const invoiceNo = invoiceCell ? findInvoiceNoLike(invoiceCell) : null;
  const rateText = at("rate");
  const problems: string[] = [];
  if (!invoiceNo) problems.push("no invoice number on this line");
  if (amount === null) problems.push("no amount that reads as a number");

  return {
    invoiceNo,
    receiptDate: toIsoDate(dateText),
    amount,
    exchangeRate: rateText ? toNumber(rateText) : null,
    bankRef: at("bankRef") || null,
    source,
    problem: problems.length ? problems.join("; ") : null,
  };
}

/** Rows that end the table rather than belonging to it. */
function isClosingRow(line: string): boolean {
  const s = norm(line);
  return /^(total|grand total|sub total|subtotal|closing balance)\b/.test(s);
}

export function readReceipts(grids: Grid[], sourceName = ""): ReceiptExtraction {
  const warnings: string[] = [];

  for (const g of grids) {
    const header = findHeaderRow(g);
    if (!header) continue;

    const lines: ReceiptLine[] = [];
    for (let r = header.row + 1; r <= g.body.maxRow; r += 1) {
      if (isClosingRow(g.rowLine(r))) break;
      const line = readLine(g, r, header.columns);
      if (line) lines.push(line);
    }

    if (!lines.length) continue;

    if (!header.columns.has("invoiceNo")) {
      warnings.push(
        `No invoice-number column was found on '${g.title}', so each receipt has to be ` +
          "pointed at its invoice by hand.",
      );
    }
    if (!header.columns.has("rate")) {
      warnings.push(
        `No exchange-rate column was found on '${g.title}'. The receipts can still be ` +
          "imported; the difference and forex gain/loss stay blank until a rate is entered.",
      );
    }
    return { lines, warnings, sourceName };
  }

  return {
    lines: [],
    warnings: [
      "No receipt table was found in this file. The reader looks for a header row naming " +
        "an amount column (Receipt FCY, Amount Received, Credit Amount…) alongside an " +
        "invoice or date column.",
    ],
    sourceName,
  };
}
