/**
 * Turn a text-based PDF into the same grid shape as a worksheet.
 *
 * A printed invoice *is* a grid — the PDF just lost the cell boundaries.
 * Re-deriving rows (by y) and columns (by clustered x) lets the whole invoice
 * reading algorithm run unchanged on PDFs, instead of a second, divergent set
 * of rules.
 */
import { clean } from "./text";
import type { CellRef, Grid, Region } from "./types";
import { regionContains } from "./types";

const ROW_TOLERANCE = 3.0; // points: items within this y-distance are one line
const CELL_GAP = 6.0; // points: a bigger horizontal gap starts a new cell
const MAX_COLS = 40;

const key = (r: number, c: number) => `${r},${c}`;

export interface PdfCell {
  x0: number;
  x1: number;
  text: string;
}

export interface PdfLine {
  page: number;
  line: number;
  cells: PdfCell[];
}

export class TextGrid implements Grid {
  readonly title = "PDF";
  readonly body: Region;
  readonly formulas = new Map<string, string>();

  private values = new Map<string, unknown>();
  private anchorMap = new Map<string, [number, number]>();
  private spanMap = new Map<string, [number, number, number, number]>();
  private rowInfo = new Map<number, [number, number]>();
  private columns: Array<[number, number]> = [];
  private wideLimit = Number.POSITIVE_INFINITY;

  constructor(lines: PdfLine[]) {
    this.columns = this.buildBands(lines);

    const placed: Array<[number, number, string]> = [];
    lines.forEach((line, index) => {
      const r = index + 1;
      this.rowInfo.set(r, [line.page, line.line]);
      const cells = [...line.cells].sort((a, b) => a.x0 - b.x0);
      const cols = this.assignColumns(cells);
      cells.forEach((cell, i) => placed.push([r, cols[i], cell.text]));
    });

    const { placed: merged, columnCount } = this.mergeExclusiveColumns(placed);

    const byRow = new Map<number, Array<[number, string]>>();
    for (const [r, c, text] of merged) {
      if (!byRow.has(r)) byRow.set(r, []);
      byRow.get(r)!.push([c, text]);
    }
    for (const [r, items] of byRow) {
      items.sort((a, b) => a[0] - b[0]);
      items.forEach(([c, text], i) => {
        this.values.set(key(r, c), text);
        const endC = Math.max(i + 1 < items.length ? items[i + 1][0] - 1 : columnCount, c);
        if (endC > c) {
          this.spanMap.set(key(r, c), [r, c, r, endC]);
          for (let cc = c; cc <= endC; cc += 1) this.anchorMap.set(key(r, cc), [r, c]);
        }
      });
    }

    const maxRow = lines.length;
    const maxCol = Math.max(
      columnCount,
      ...[...this.values.keys()].map((k) => Number(k.split(",")[1])),
      1,
    );
    this.body = { minRow: 1, maxRow, minCol: 1, maxCol };
  }

  // ---------------- column model ----------------
  /**
   * Columns = connected runs of the horizontal projection of the *narrow* cells.
   * Wide cells (addresses, declarations, terms) are excluded because they bridge
   * every gap and would collapse the page into one column; they are snapped onto
   * a band afterwards by their left edge. The width limit is chosen adaptively.
   */
  private buildBands(lines: PdfLine[]): Array<[number, number]> {
    const all: Array<[number, number]> = [];
    for (const line of lines) for (const cell of line.cells) all.push([cell.x0, cell.x1]);
    if (!all.length) {
      this.wideLimit = Number.POSITIVE_INFINITY;
      return [[0, 1]];
    }
    const pageWidth = Math.max(...all.map(([, x1]) => x1)) || 1;

    let chosen: Array<[number, number]> | null = null;
    let chosenLimit = pageWidth * 0.07;
    for (const factor of [0.07, 0.055, 0.045, 0.035, 0.025]) {
      const limit = pageWidth * factor;
      const bands = TextGrid.project(all.filter(([x0, x1]) => x1 - x0 <= limit));
      if (bands.length >= 6) {
        chosen = bands;
        chosenLimit = limit;
        break;
      }
      if (!chosen || bands.length > chosen.length) {
        chosen = bands;
        chosenLimit = limit;
      }
    }
    let bands = chosen && chosen.length ? chosen : TextGrid.project(all);
    while (bands.length > MAX_COLS) {
      let smallest = Number.POSITIVE_INFINITY;
      let at = 0;
      for (let i = 0; i < bands.length - 1; i += 1) {
        const gap = bands[i + 1][0] - bands[i][1];
        if (gap < smallest) {
          smallest = gap;
          at = i;
        }
      }
      bands[at] = [bands[at][0], bands[at + 1][1]];
      bands = bands.filter((_, i) => i !== at + 1);
    }
    this.wideLimit = chosenLimit;
    return bands;
  }

  private static project(intervals: Array<[number, number]>): Array<[number, number]> {
    const bands: Array<[number, number]> = [];
    for (const [x0, x1] of [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      const last = bands[bands.length - 1];
      if (last && x0 <= last[1] - 1) last[1] = Math.max(last[1], x1);
      else bands.push([x0, x1]);
    }
    return bands;
  }

  private colOf(x0: number, x1: number): number {
    if (x1 - x0 > this.wideLimit) {
      // wide text: place it by its left edge, not by overlap
      let best = 1;
      let bestD = Number.POSITIVE_INFINITY;
      this.columns.forEach(([b0], i) => {
        const d = Math.abs(x0 - b0);
        if (d < bestD) {
          bestD = d;
          best = i + 1;
        }
      });
      return best;
    }
    let best = 1;
    let bestOverlap = Number.NEGATIVE_INFINITY;
    this.columns.forEach(([b0, b1], i) => {
      const overlap = Math.min(x1, b1) - Math.max(x0, b0);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = i + 1;
      }
    });
    return best;
  }

  private assignColumns(cells: PdfCell[]): number[] {
    const cols: number[] = [];
    for (const cell of cells) {
      let c = this.colOf(cell.x0, cell.x1);
      while (cols.length && c <= cols[cols.length - 1]) c = cols[cols.length - 1] + 1;
      cols.push(c);
    }
    return cols;
  }

  /**
   * Right-aligned money columns often sit just right of their header text,
   * landing in a separate band. Two adjacent columns that never occur on the
   * same line, separated by a small gap, are really one column.
   */
  private mergeExclusiveColumns(placed: Array<[number, number, string]>) {
    const n = this.columns.length;
    if (!n) return { placed, columnCount: 1 };
    const rowsByCol = new Map<number, Set<number>>();
    for (const [r, c] of placed) {
      if (!rowsByCol.has(c)) rowsByCol.set(c, new Set());
      rowsByCol.get(c)!.add(r);
    }
    const maxGap = Math.max(28, (this.columns[n - 1][1] - this.columns[0][0]) * 0.06);
    const mergedInto = new Map<number, number>();
    for (let i = n; i > 1; i -= 1) {
      const left = i - 1;
      const right = i;
      const gap = this.columns[right - 1][0] - this.columns[left - 1][1];
      const leftRows = rowsByCol.get(left) ?? new Set<number>();
      const rightRows = rowsByCol.get(right) ?? new Set<number>();
      if (!rightRows.size) continue;
      const shares = [...rightRows].some((r) => leftRows.has(r));
      if (!shares && gap <= maxGap) mergedInto.set(right, left);
    }
    if (!mergedInto.size) return { placed, columnCount: n };

    const root = (c: number): number => {
      let cur = c;
      while (mergedInto.has(cur)) cur = mergedInto.get(cur)!;
      return cur;
    };
    const survivors = [...new Set(Array.from({ length: n }, (_, i) => root(i + 1)))].sort(
      (a, b) => a - b,
    );
    const renum = new Map(survivors.map((old, i) => [old, i + 1]));
    this.columns = survivors.map((old) => this.columns[old - 1]);
    return {
      placed: placed.map(([r, c, t]) => [r, renum.get(root(c))!, t] as [number, number, string]),
      columnCount: survivors.length,
    };
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
    const [page, line] = this.rowInfo.get(r) ?? [1, r];
    return `p${page} L${line} C${c}`;
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
    let rr = r + 1;
    let steps = 0;
    while (rr <= this.body.maxRow && steps < limit) {
      const [ar, ac] = this.anchor(rr, c);
      const value = this.values.get(key(ar, ac));
      if (value !== undefined && clean(value) !== "") out.push({ row: ar, col: ac, value });
      rr += 1;
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

  valueAtRef(): unknown {
    return null; // a PDF has no formulas
  }
}

// --------------------------------------------------------------------------
interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

async function loadPdfDocument(data: Uint8Array) {
  // pdfjs ships an ESM legacy build that runs in Node without a DOM.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
  });
  return loadingTask.promise;
}

/** Build one TextGrid for the whole PDF (pages stacked in reading order). */
export async function pdfToGrid(buffer: Buffer | Uint8Array, maxPages = 12): Promise<TextGrid> {
  const data = buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer);
  const doc = await loadPdfDocument(data);
  const lines: PdfLine[] = [];

  const pageCount = Math.min(doc.numPages, maxPages);
  for (let p = 1; p <= pageCount; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = (content.items as unknown as PdfTextItem[]).filter(
      (it) => typeof it.str === "string" && it.str.trim() !== "",
    );

    // group items into lines by their baseline y
    const rows: Array<{ y: number; items: PdfTextItem[] }> = [];
    for (const item of items) {
      const y = item.transform[5];
      const row = rows.find((r) => Math.abs(r.y - y) <= ROW_TOLERANCE);
      if (row) row.items.push(item);
      else rows.push({ y, items: [item] });
    }
    rows.sort((a, b) => b.y - a.y); // PDF y grows upwards

    rows.forEach((row, index) => {
      row.items.sort((a, b) => a.transform[4] - b.transform[4]);
      const cells: PdfCell[] = [];
      let current: PdfTextItem[] = [];
      const flush = () => {
        if (!current.length) return;
        const x0 = current[0].transform[4];
        const last = current[current.length - 1];
        const x1 = last.transform[4] + (last.width ?? 0);
        const text = clean(current.map((i) => i.str).join(" "));
        if (text) cells.push({ x0, x1, text });
        current = [];
      };
      for (const item of row.items) {
        if (current.length) {
          const prev = current[current.length - 1];
          const prevEnd = prev.transform[4] + (prev.width ?? 0);
          if (item.transform[4] - prevEnd > CELL_GAP) flush();
        }
        current.push(item);
      }
      flush();
      if (cells.length) lines.push({ page: p, line: index + 1, cells });
    });
  }
  await doc.destroy?.();
  return new TextGrid(lines);
}

export async function pdfHasText(buffer: Buffer | Uint8Array): Promise<boolean> {
  try {
    const data = buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer);
    const doc = await loadPdfDocument(data);
    const pages = Math.min(doc.numPages, 3);
    for (let p = 1; p <= pages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const text = (content.items as unknown as PdfTextItem[])
        .map((i) => i.str ?? "")
        .join("")
        .trim();
      if (text) {
        await doc.destroy?.();
        return true;
      }
    }
    await doc.destroy?.();
    return false;
  } catch {
    return false;
  }
}
