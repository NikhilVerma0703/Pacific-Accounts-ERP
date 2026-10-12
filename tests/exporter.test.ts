/**
 * The Accounts register and the extraction sheet are the two files that leave
 * this system, so they are built from the real invoice and read back.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { buildAccountsRow, visibleColumns } from "@/lib/business/accounts";
import { extractDocument } from "@/lib/extraction";
import { normalize } from "@/lib/normalize/normalizer";
import { assess } from "@/lib/normalize/validators";
import {
  buildExtractionWorkbook,
  buildRegisterCsv,
  buildRegisterWorkbook,
} from "@/server/exporter";

async function sample() {
  const buffer = await readFile(path.join(process.cwd(), "tests", "fixtures", "sample_invoice.xlsx"));
  const normalized = normalize(await extractDocument(buffer, "invoice_dummy.xlsx"));
  const quality = assess(normalized);
  return { normalized, quality };
}

describe("exports", () => {
  it("writes a readable Accounts register workbook", async () => {
    const { normalized, quality } = await sample();
    const row = buildAccountsRow(normalized, quality, { slNo: 1 });
    const columns = visibleColumns();
    const buffer = await buildRegisterWorkbook([row], columns);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    );
    const ws = wb.getWorksheet("Accounts Register")!;
    expect(ws).toBeTruthy();

    const headers = columns.map((c) => c.label);
    const firstRow = ws.getRow(1).values as unknown[];
    expect(firstRow.slice(1)).toEqual(headers);
    expect(headers).toHaveLength(columns.length);
    expect(headers).toContain("Receipt 1 FCY");
    expect(headers).toContain("Forex Gain/Loss 1");

    const invoiceNoCol = columns.findIndex((c) => c.key === "invoiceNo") + 1;
    const valueCol = columns.findIndex((c) => c.key === "customerInvoiceValue") + 1;
    expect(ws.getCell(2, invoiceNoCol).value).toBe("PESPL/2889");
    expect(ws.getCell(2, valueCol).value).toBe(18348.49);

    // the legend sheet explains the colour coding
    expect(wb.getWorksheet("Legend")).toBeTruthy();
  });

  it("makes every column wide enough for what it prints", async () => {
    const { normalized, quality } = await sample();
    const row = buildAccountsRow(normalized, quality, { slNo: 1 });
    const columns = visibleColumns();
    const buffer = await buildRegisterWorkbook([row], columns);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    );
    const ws = wb.getWorksheet("Accounts Register")!;

    columns.forEach((col, i) => {
      const column = ws.getColumn(i + 1);
      const width = column.width ?? 0;
      const cellRef = ws.getCell(2, i + 1);
      const wrapped = cellRef.alignment?.wrapText === true;

      // a date prints as DD-MMM-YYYY (11) whatever it is stored as, and a
      // column narrower than its content shows ##### or hides the tail
      const printed =
        cellRef.value instanceof Date
          ? 11
          : typeof cellRef.value === "number"
            ? cellRef.value.toLocaleString("en-US", { minimumFractionDigits: 2 }).length
            : String(cellRef.value ?? "").length;

      expect(width, `${col.label} must fit its header`).toBeGreaterThanOrEqual(col.label.length);
      if (!wrapped) {
        expect(width, `${col.label} must fit '${String(cellRef.value)}'`).toBeGreaterThanOrEqual(
          printed,
        );
      }
      // nothing absurd: a date column measured from the stored Date used to
      // come out at 46 characters wide
      expect(width, `${col.label} is unreasonably wide`).toBeLessThanOrEqual(52);
    });

    const dateCol = columns.findIndex((c) => c.key === "invoiceDate") + 1;
    expect(ws.getColumn(dateCol).width).toBeLessThan(20);
  });

  it("writes the whole consignee and notify-party block, not just the name", async () => {
    const { normalized, quality } = await sample();
    const row = buildAccountsRow(normalized, quality, { slNo: 1 });
    const columns = visibleColumns();

    // on screen the register shows the short name…
    expect(row.consigneeName.display).toBe("Ciot Inc");
    // …and the file carries everything printed under it on the invoice
    const full = String(row.consigneeName.full);
    expect(full.startsWith("Ciot Inc, ")).toBe(true);
    expect(full).toContain("Montreal");
    expect(full).toContain("Canada");

    const buffer = await buildRegisterWorkbook([row], columns);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    );
    const ws = wb.getWorksheet("Accounts Register")!;
    const consigneeCol = columns.findIndex((c) => c.key === "consigneeName") + 1;
    expect(ws.getCell(2, consigneeCol).value).toBe(full);
    expect(ws.getCell(2, consigneeCol).alignment?.wrapText).toBe(true);

    const csv = buildRegisterCsv([row], columns);
    expect(csv).toContain(`"${full}"`);
  });

  it("writes a CSV whose columns line up with the register", async () => {
    const { normalized, quality } = await sample();
    const row = buildAccountsRow(normalized, quality, { slNo: 1 });
    const columns = visibleColumns();
    const csv = buildRegisterCsv([row], columns);
    const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines[0].split(",").length).toBe(columns.length);
    expect(lines[1]).toContain("PESPL/2889");

    // money is a plain number, so a SUM over the column works
    expect(lines[1]).toContain(",18348.49,");
    expect(lines[1]).not.toContain("18,348.49");
    // and dates stay unambiguous
    expect(lines[1]).toContain("12-Sep-2026");
  });

  it("writes the per-invoice extraction sheet with sources and statuses", async () => {
    const { normalized } = await sample();
    const buffer = await buildExtractionWorkbook(
      "PESPL/2889",
      normalized.fields,
      normalized.lineItems,
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    );
    const ws = wb.getWorksheet("Extraction")!;
    expect(ws.getCell(1, 1).value).toBe("Group");

    const rows: Array<[string, unknown, unknown]> = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      rows.push([String(r.getCell(2).value ?? ""), r.getCell(3).value, r.getCell(5).value]);
    });
    const invoiceNo = rows.find(([label]) => label === "Invoice No.");
    expect(invoiceNo?.[1]).toBe("PESPL/2889");
    expect(String(invoiceNo?.[2])).toContain("Invoice!");

    const items = wb.getWorksheet("Line Items")!;
    expect(items).toBeTruthy();
    expect(items.rowCount).toBe(3); // header + 2 items
  });
});
