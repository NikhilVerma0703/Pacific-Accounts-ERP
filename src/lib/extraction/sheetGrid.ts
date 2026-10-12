/**
 * A merged-cell-aware view over an Excel worksheet, plus detection of the
 * printable invoice body.
 *
 * Real invoice templates carry side matter next to the printed form: address
 * look-up blocks, helper columns, working notes. Reading those as invoice data
 * is the classic source of wrong extractions, so the grid first works out where
 * the form actually ends.
 */
import ExcelJS from "exceljs";

import { clean, columnIndex, columnLetter } from "./text";
import type { CellRef, Grid, Region } from "./types";
import { regionContains } from "./types";

const key = (r: number, c: number) => `${r},${c}`;

/** Formula cells carry {formula, result}; we want the cached result. */
function cellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if ("result" in obj) return obj.result ?? null;
    if ("richText" in obj && Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("");
    }
    if ("text" in obj && "hyperlink" in obj) return obj.text;
    if ("error" in obj) return null;
    if (v instanceof Date) return v;
  }
  return v;
}

function parseRange(ref: string): [number, number, number, number] | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/i.exec(
    ref.replace(/^.*!/, "").replace(/\$/g, "").trim(),
  );
  if (!m) return null;
  const c1 = columnIndex(m[1]);
  const r1 = Number(m[2]);
  const c2 = m[3] ? columnIndex(m[3]) : c1;
  const r2 = m[4] ? Number(m[4]) : r1;
  return [Math.min(r1, r2), Math.min(c1, c2), Math.max(r1, r2), Math.max(c1, c2)];
}

export class SheetGrid implements Grid {
  readonly title: string;
  readonly body: Region;
  readonly formulas = new Map<string, string>();

  private values = new Map<string, unknown>();
  private anchorMap = new Map<string, [number, number]>();
  private spanMap = new Map<string, [number, number, number, number]>();
  private maxRow = 0;
  private maxCol = 0;
  private printArea: string | null = null;

  constructor(ws: ExcelJS.Worksheet) {
    this.title = ws.name;
    this.maxRow = ws.rowCount ?? 0;
    this.maxCol = ws.columnCount ?? 0;

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const value = cellValue(cell);
        if (value !== null && clean(value) !== "") {
          this.values.set(key(rowNumber, colNumber), value);
        }
        const formula = (cell as { formula?: string }).formula;
        if (formula) this.formulas.set(key(rowNumber, colNumber), formula);
        if (rowNumber > this.maxRow) this.maxRow = rowNumber;
        if (colNumber > this.maxCol) this.maxCol = colNumber;
      });
    });

    for (const range of this.readMerges(ws)) {
      const [r1, c1, r2, c2] = range;
      for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) this.anchorMap.set(key(r, c), [r1, c1]);
      }
      this.spanMap.set(key(r1, c1), [r1, c1, r2, c2]);
      // a merged block keeps its value on the top-left cell only
      for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
          if (r !== r1 || c !== c1) this.values.delete(key(r, c));
        }
      }
    }

    const setup = ws.pageSetup as { printArea?: string } | undefined;
    this.printArea = setup?.printArea ?? null;
    this.body = this.detectBody();
  }

  private readMerges(ws: ExcelJS.Worksheet): Array<[number, number, number, number]> {
    const out: Array<[number, number, number, number]> = [];
    const fromModel = (ws as unknown as { model?: { merges?: string[] } }).model?.merges;
    const raw: string[] = Array.isArray(fromModel)
      ? fromModel
      : Object.values(
          (ws as unknown as { _merges?: Record<string, { range?: string } | string> })._merges ?? {},
        ).map((m) => (typeof m === "string" ? m : (m?.range ?? "")));
    for (const ref of raw) {
      if (!ref) continue;
      const parsed = parseRange(ref);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  // ---------------- body detection ----------------
  private detectBody(): Region {
    // 1) an explicit print area is the template author's own answer
    if (this.printArea) {
      const parsed = parseRange(this.printArea);
      if (parsed) {
        const [r1, c1, r2, c2] = parsed;
        if (c2 >= 3 && r2 >= 5) {
          return {
            minRow: Math.max(1, r1),
            maxRow: Math.min(r2, this.maxRow),
            minCol: Math.max(1, c1),
            maxCol: Math.min(c2, this.maxCol),
          };
        }
      }
    }

    // 2) the widest merged banner in the top rows usually spans the form width
    let bannerCol = 0;
    let wideCol = 0;
    for (const [r1, c1, , c2] of this.spanMap.values()) {
      if (r1 <= 6 && c1 <= 2 && c2 - c1 >= 3) bannerCol = Math.max(bannerCol, c2);
      if (c1 <= 2 && c2 - c1 >= 5) wideCol = Math.max(wideCol, c2);
    }
    const candidate = bannerCol || wideCol;
    if (candidate && candidate < this.maxCol) {
      return { minRow: 1, maxRow: this.maxRow, minCol: 1, maxCol: candidate };
    }

    // 3) a fully empty column often separates the form from side matter
    const usedCols = [...new Set([...this.values.keys()].map((k) => Number(k.split(",")[1])))].sort(
      (a, b) => a - b,
    );
    if (usedCols.length) {
      let prev = usedCols[0];
      for (const c of usedCols.slice(1)) {
        if (c - prev > 1 && prev >= 5) {
          return { minRow: 1, maxRow: this.maxRow, minCol: 1, maxCol: prev };
        }
        prev = c;
      }
    }
    return { minRow: 1, maxRow: this.maxRow, minCol: 1, maxCol: Math.max(this.maxCol, 1) };
  }

  // ---------------- Grid API ----------------
  anchor(r: number, c: number): [number, number] {
    return this.anchorMap.get(key(r, c)) ?? [r, c];
  }

  span(r: number, c: number): [number, number, number, number] {
    const [ar, ac] = this.anchor(r, c);
    return this.spanMap.get(key(ar, ac)) ?? [ar, ac, ar, ac];
  }

  raw(r: number, c: number): unknown {
    const [ar, ac] = this.anchor(r, c);
    return this.values.get(key(ar, ac)) ?? null;
  }

  text(r: number, c: number): string {
    return clean(this.raw(r, c));
  }

  isAnchor(r: number, c: number): boolean {
    const [ar, ac] = this.anchor(r, c);
    return ar === r && ac === c;
  }

  coord(r: number, c: number): string {
    return `${this.title}!${columnLetter(c)}${r}`;
  }

  occupiedAnchors(region?: Region): CellRef[] {
    const out: CellRef[] = [];
    for (const [k, value] of this.values) {
      const [r, c] = k.split(",").map(Number);
      if (region && !regionContains(region, r, c)) continue;
      out.push({ row: r, col: c, value });
    }
    out.sort((a, b) => a.row - b.row || a.col - b.col);
    return out;
  }

  cellsRight(r: number, c: number, limit: number): CellRef[] {
    const out: CellRef[] = [];
    const [, , , endC] = this.span(r, c);
    let cc = endC + 1;
    let steps = 0;
    while (cc <= this.body.maxCol && steps < limit) {
      const [ar, ac] = this.anchor(r, cc);
      const value = this.values.get(key(ar, ac));
      if (value !== undefined && clean(value) !== "") {
        out.push({ row: ar, col: ac, value });
        cc = this.span(r, cc)[3] + 1;
      } else {
        cc += 1;
      }
      steps += 1;
    }
    return out;
  }

  cellsBelow(r: number, c: number, limit: number): CellRef[] {
    const out: CellRef[] = [];
    const [, , endR] = this.span(r, c);
    let rr = endR + 1;
    let steps = 0;
    while (rr <= this.body.maxRow && steps < limit) {
      const [ar, ac] = this.anchor(rr, c);
      const value = this.values.get(key(ar, ac));
      if (value !== undefined && clean(value) !== "") out.push({ row: ar, col: ac, value });
      rr = Math.max(this.span(rr, c)[2], rr) + 1;
      steps += 1;
    }
    return out;
  }

  rowTexts(r: number): Array<[number, string]> {
    const out: Array<[number, string]> = [];
    for (let c = this.body.minCol; c <= this.body.maxCol; c += 1) {
      if (!this.isAnchor(r, c)) continue;
      const t = this.text(r, c);
      if (t) out.push([c, t]);
    }
    return out;
  }

  rowLine(r: number): string {
    return this.rowTexts(r)
      .map(([, t]) => t)
      .join(" | ");
  }

  valueAtRef(ref: string): unknown {
    const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref.replace(/\$/g, "").trim());
    if (!m) return null;
    return this.raw(Number(m[2]), columnIndex(m[1]));
  }
}

export async function loadSheetGrids(buffer: Buffer | Uint8Array): Promise<SheetGrid[]> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS bundles its own Buffer typing, which drifts from @types/node
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb.worksheets.map((ws) => new SheetGrid(ws));
}
