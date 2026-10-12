/** Styled Excel / CSV export of the Accounts register and of one extraction. */
import "server-only";

import ExcelJS from "exceljs";

import type { AccountsColumn, AccountsRow, Cell } from "@/lib/business/accounts";
import { CATALOG, GROUPS } from "@/lib/extraction/catalog";
import { FieldStatus, type ExtractedField, type LineItem } from "@/lib/extraction/types";

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
const HEADER_FONT: Partial<ExcelJS.Font> = { color: { argb: "FFFFFFFF" }, bold: true, size: 10 };
const THIN: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FFD5DCE4" } };
const BORDER: Partial<ExcelJS.Borders> = { left: THIN, right: THIN, top: THIN, bottom: THIN };

const STATUS_FILL: Partial<Record<FieldStatus, string>> = {
  [FieldStatus.CALCULATED]: "FFEAF2FB",
  [FieldStatus.NEEDS_VERIFICATION]: "FFFFF4D6",
  [FieldStatus.MISSING]: "FFFDE7E7",
  [FieldStatus.NOT_PRESENT]: "FFF3F4F6",
  [FieldStatus.CONFLICT]: "FFFDE7E7",
};

const NUMBER_FORMATS: Record<string, string> = {
  money: "#,##0.00",
  num: "#,##0.###",
  date: "DD-MMM-YYYY",
};

function fillFor(status?: string): ExcelJS.Fill | null {
  const argb = STATUS_FILL[status as FieldStatus];
  return argb ? { type: "pattern", pattern: "solid", fgColor: { argb } } : null;
}

// ---------------------------------------------------------------------------
// Column widths.
//
// Excel does not shrink text to fit: a column narrower than what the cell
// prints shows ##### for a number or date, and hides the tail of a long name
// behind the next column. So width is measured from the text as it will be
// *printed*, never from the value as it is stored — a date held as a Date
// stringifies to sixty-odd characters, while a number held as 18348.49 prints
// as 18,348.49.
//
// Past WRAP_ABOVE a column would push everything else off the screen, so the
// text wraps onto more lines instead. Either way nothing is cut off.
// ---------------------------------------------------------------------------
const PADDING = 2; // Excel's own left/right cell padding, in characters
const BOLD_HEADER_ALLOWANCE = 1; // a bold header is a shade wider per character
const MIN_WIDTH = 10; // exceljs drops a width of exactly 9 as "default" (8.43 in Excel)
const WRAP_ABOVE = 52;

/** How many characters this value takes once Excel has formatted it. */
function printedLength(value: ExcelJS.CellValue, numFmt?: string): number {
  if (value === null || value === undefined) return 0;
  if (value instanceof Date) return "DD-MMM-YYYY".length;
  if (typeof value === "number") {
    const digits = numFmt === NUMBER_FORMATS.money ? 2 : 0;
    return value.toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: Math.max(digits, 3),
    }).length;
  }
  if (typeof value === "object" && "richText" in value) {
    return value.richText.map((t) => t.text).join("").length;
  }
  if (typeof value === "object" && "text" in value) return String(value.text).length;
  return String(value).length;
}

/** Widen each column to its longest printed line; wrap what is longer still. */
function fitColumns(ws: ExcelJS.Worksheet, wrapAbove = WRAP_ABOVE): void {
  ws.columns.forEach((column) => {
    let longest = 0;
    column.eachCell?.({ includeEmpty: false }, (cellRef, rowNumber) => {
      // a multi-line value only needs to be as wide as its widest line
      const lines = String(cellRef.value ?? "").includes("\n")
        ? String(cellRef.value).split("\n").map((l) => l.length)
        : [printedLength(cellRef.value, cellRef.numFmt)];
      const extra = rowNumber === 1 ? BOLD_HEADER_ALLOWANCE : 0;
      for (const len of lines) if (len + extra > longest) longest = len + extra;
    });

    const wanted = longest + PADDING;
    column.width = Math.max(MIN_WIDTH, Math.min(wanted, wrapAbove));
    if (wanted > wrapAbove) {
      column.eachCell?.({ includeEmpty: false }, (cellRef) => {
        cellRef.alignment = { ...cellRef.alignment, wrapText: true, vertical: "top" };
      });
    }
  });
}

/**
 * What a register cell should say in a file. `full` is set where the screen
 * deliberately shows a short form — the consignee and notify-party blocks — so
 * an export carries the whole address, not just the first line.
 */
function exportValue(data: Cell | undefined): string | null {
  if (!data) return null;
  if (data.full) return data.full;
  return data.value === null || data.value === undefined ? null : String(data.value);
}

export async function buildRegisterWorkbook(
  rows: AccountsRow[],
  columns: AccountsColumn[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Pacific Surfaces — Accounts Automation";
  const ws = wb.addWorksheet("Accounts Register", { views: [{ state: "frozen", xSplit: 3, ySplit: 1 }] });

  columns.forEach((col, i) => {
    const cellRef = ws.getCell(1, i + 1);
    cellRef.value = col.label;
    cellRef.fill = HEADER_FILL;
    cellRef.font = HEADER_FONT;
    cellRef.border = BORDER;
    cellRef.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });

  rows.forEach((row, rowIndex) => {
    columns.forEach((col, colIndex) => {
      const data: Cell | undefined = row[col.key];
      const cellRef = ws.getCell(rowIndex + 2, colIndex + 1);
      let value: ExcelJS.CellValue = (data?.value ?? null) as ExcelJS.CellValue;
      if (col.kind === "date" && typeof value === "string" && value) {
        value = new Date(`${value}T00:00:00Z`);
      }
      if (col.kind === "status") value = data?.display ?? "";
      // numbers and dates stay typed so they can be summed, sorted and filtered;
      // text columns take the complete form
      if (col.kind === "text") value = exportValue(data);
      cellRef.value = value;
      cellRef.border = BORDER;
      const fill = fillFor(data?.status);
      if (fill) cellRef.fill = fill;
      if (NUMBER_FORMATS[col.kind] && typeof value !== "string") {
        cellRef.numFmt = NUMBER_FORMATS[col.kind];
      }
      if (data?.note) cellRef.note = data.note;
    });
  });

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(rows.length + 1, 1), column: columns.length } };
  fitColumns(ws);
  // printing a wide register should not slice columns off the right-hand edge
  ws.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: "1:1",
    margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };

  const legend = wb.addWorksheet("Legend");
  legend.getCell("A1").value = "Cell colour";
  legend.getCell("B1").value = "Meaning";
  legend.getCell("A1").font = { bold: true };
  legend.getCell("B1").font = { bold: true };
  const meanings: Array<[string, string, FieldStatus]> = [
    ["Extracted", "Read directly from the commercial invoice", FieldStatus.EXTRACTED],
    ["Calculated", "Derived from other reliable fields", FieldStatus.CALCULATED],
    ["Needs verification", "Inferred — Accounts should confirm", FieldStatus.NEEDS_VERIFICATION],
    ["Missing", "The field exists on the invoice but was blank", FieldStatus.MISSING],
    ["Not present", "Not on this document — comes from another source", FieldStatus.NOT_PRESENT],
  ];
  meanings.forEach(([name, meaning, status], i) => {
    const r = i + 2;
    legend.getCell(r, 1).value = name;
    const fill = fillFor(status);
    if (fill) legend.getCell(r, 1).fill = fill;
    legend.getCell(r, 2).value = meaning;
  });
  fitColumns(legend, 80);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * The CSV is the machine-readable twin of the workbook: every value complete,
 * money and counts as plain numbers so another system (or a SUM in Excel) can
 * use them, dates as unambiguous DD-MMM-YYYY, and the party columns carrying the
 * whole address block.
 *
 * A CSV file cannot carry column widths — that is the format, not this export.
 * Opened in Excel its columns arrive at the default width, so for something to
 * read or print, use the Excel export, where every column is sized to fit.
 */
export function buildRegisterCsv(rows: AccountsRow[], columns: AccountsColumn[]): string {
  const escape = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

  const text = (row: AccountsRow, col: AccountsColumn): string => {
    const data = row[col.key];
    if (!data) return "";
    if (data.full) return data.full;
    // grouping separators make a number unusable as a number
    if ((col.kind === "money" || col.kind === "num") && typeof data.value === "number") {
      return String(data.value);
    }
    return data.display ?? "";
  };

  const lines = [columns.map((c) => escape(c.label)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => escape(text(row, c))).join(","));
  }
  // CRLF + BOM: what Excel expects from a CSV, on every Windows locale
  return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * A report workbook: the same styling, widths and full-value rules as the
 * register export, driven by whatever columns the report defines.
 */
export async function buildReportWorkbook(
  title: string,
  columns: Array<{ key: string; label: string; kind: string }>,
  rows: Array<Record<string, string | number | null>>,
  totals: Record<string, string | number | null> | null,
  note: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Pacific Surfaces — Accounts Automation";
  // Excel forbids / \ ? * [ ] in a sheet name, and caps it at 31 characters
  const sheetName = title.replace(/[\\/?*[\]]/g, "-").slice(0, 31);
  const ws = wb.addWorksheet(sheetName, { views: [{ state: "frozen", ySplit: 1 }] });

  columns.forEach((col, i) => {
    const cellRef = ws.getCell(1, i + 1);
    cellRef.value = col.label;
    cellRef.fill = HEADER_FILL;
    cellRef.font = HEADER_FONT;
    cellRef.border = BORDER;
    cellRef.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });

  const write = (rowIndex: number, source: Record<string, string | number | null>, bold = false) => {
    columns.forEach((col, colIndex) => {
      const cellRef = ws.getCell(rowIndex, colIndex + 1);
      let value: ExcelJS.CellValue = (source[col.key] ?? null) as ExcelJS.CellValue;
      if (col.kind === "date" && typeof value === "string" && value) {
        value = new Date(`${value}T00:00:00Z`);
      }
      cellRef.value = value;
      cellRef.border = BORDER;
      if (bold) cellRef.font = { bold: true };
      if (NUMBER_FORMATS[col.kind] && typeof value !== "string") {
        cellRef.numFmt = NUMBER_FORMATS[col.kind];
      }
    });
  };

  rows.forEach((row, i) => write(i + 2, row));
  if (totals) {
    const r = rows.length + 2;
    write(r, totals, true);
    for (let c = 1; c <= columns.length; c += 1) {
      ws.getCell(r, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF2FB" } };
    }
  }

  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(rows.length + 1, 1), column: columns.length },
  };
  fitColumns(ws);
  ws.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: "1:1",
    margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };

  // what the reader needs to know about the figures, kept with the figures
  const about = wb.addWorksheet("About this report");
  about.getCell("A1").value = title;
  about.getCell("A1").font = { bold: true, size: 13 };
  about.getCell("A3").value = note;
  about.getCell("A5").value = `Generated ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;
  about.getCell("A6").value =
    "Figures come from the same functions as the Accounts Register — a report cannot disagree with it.";
  about.getColumn(1).width = 110;
  about.getColumn(1).alignment = { wrapText: true, vertical: "top" };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The CSV twin of a report: complete values, plain numbers, CRLF and a BOM. */
export function buildReportCsv(
  columns: Array<{ key: string; label: string; kind: string }>,
  rows: Array<Record<string, string | number | null>>,
  totals: Record<string, string | number | null> | null,
): string {
  const escape = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const line = (source: Record<string, string | number | null>) =>
    columns
      .map((c) => {
        const v = source[c.key];
        if (v === null || v === undefined) return "";
        return escape(String(v));
      })
      .join(",");

  const out = [columns.map((c) => escape(c.label)).join(",")];
  for (const row of rows) out.push(line(row));
  if (totals) out.push(line(totals));
  return `\ufeff${out.join("\r\n")}\r\n`;
}

export async function buildExtractionWorkbook(
  invoiceNo: string,
  fields: Record<string, ExtractedField>,
  lineItems: LineItem[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Extraction", { views: [{ state: "frozen", ySplit: 1 }] });
  ["Group", "Field", "Value", "Status", "Source", "Note"].forEach((h, i) => {
    const cellRef = ws.getCell(1, i + 1);
    cellRef.value = h;
    cellRef.fill = HEADER_FILL;
    cellRef.font = HEADER_FONT;
    cellRef.border = BORDER;
  });

  let r = 2;
  for (const group of GROUPS) {
    for (const fd of CATALOG.filter((f) => f.group === group.key)) {
      const f = fields[fd.key];
      ws.getCell(r, 1).value = group.label;
      ws.getCell(r, 2).value = fd.label;
      ws.getCell(r, 3).value = (f?.value ?? null) as ExcelJS.CellValue;
      ws.getCell(r, 4).value = (f?.status ?? "").replace(/_/g, " ");
      ws.getCell(r, 5).value = f?.source ?? "";
      ws.getCell(r, 6).value = f?.note ?? "";
      const fill = fillFor(f?.status);
      for (let c = 1; c <= 6; c += 1) ws.getCell(r, c).border = BORDER;
      if (fill) ws.getCell(r, 3).fill = fill;
      r += 1;
    }
  }
  fitColumns(ws, 64);

  if (lineItems.length) {
    const li = wb.addWorksheet("Line Items");
    const cols: Array<keyof LineItem> = [
      "description", "designColour", "thickness", "hsn", "quantity", "unit", "rate", "amount",
      "slabsPcs", "netWeight", "packages", "marksNos",
    ];
    cols.forEach((key, i) => {
      const cellRef = li.getCell(1, i + 1);
      cellRef.value = String(key).replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
      cellRef.fill = HEADER_FILL;
      cellRef.font = HEADER_FONT;
      cellRef.border = BORDER;
    });
    lineItems.forEach((item, rowIndex) => {
      cols.forEach((key, colIndex) => {
        li.getCell(rowIndex + 2, colIndex + 1).value = (item[key] ?? null) as ExcelJS.CellValue;
      });
    });
    fitColumns(li, 48);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_");
}
