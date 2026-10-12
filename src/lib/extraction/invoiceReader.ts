/**
 * Format-independent commercial-invoice reader.
 *
 * Design rules:
 *  - nothing about any particular company or invoice is hardcoded; the reader
 *    works from the label dictionary, the geometry of the document and value types;
 *  - when a value is inferred rather than read, it is returned as
 *    NEEDS_VERIFICATION with a note explaining the inference;
 *  - when a label exists on the form but the cell is blank, the field is MISSING,
 *    never guessed.
 *
 * It only needs a Grid, so the same logic serves Excel invoices, text-based PDF
 * invoices and any future grid-shaped source.
 */
import {
  INLINE_SPECS,
  INLINE_TARGET,
  STOP_LABELS,
  classifyAdjustment,
  classifyItemHeader,
  isInlineCell,
  isTotalRow,
  matchLabel,
  specDirections,
  specMaxBelow,
  specMaxRight,
  type LabelSpec,
} from "./labels";
import {
  clean,
  columnLetter,
  dateIsAmbiguous,
  escapeRegExp,
  findContainer,
  findCountry,
  findGstin,
  findIncoterm,
  isContactLine,
  looksNumeric,
  normLabel,
  round2,
  toCurrencyCode,
  toIsoDate,
  toNumber,
  weightWithUnit,
} from "./text";
import {
  emptyLineItem,
  ExtractionResult,
  FieldStatus,
  type CellRef,
  type Grid,
  type LineItem,
  type SourceFormat,
} from "./types";

const CELL_REF_RE = /\$?([A-Z]{1,3})\$?(\d+)/g;
const SHEET_HINTS = ["invoice", "commercial", "inv", "bill"];

/** 'Payment Terms' -> matches 'Payment Terms : 100% CAD' and captures the value. */
function flexPattern(synonym: string): RegExp {
  const chunks = (synonym.match(/[A-Za-z0-9]+/g) ?? []).map(escapeRegExp);
  if (!chunks.length) return /(?!x)x/;
  const body = chunks.join("[^A-Za-z0-9]{0,4}");
  return new RegExp(
    `^\\s*${body}\\s*(?:(?:nos?|number|code)\\b\\.?\\s*)?[:\\-–]\\s*(?<v>\\S[\\s\\S]*)$`,
    "i",
  );
}

interface Cursor {
  g: Grid;
  res: ExtractionResult;
  labelCells: Map<string, LabelSpec>;
  itemCols: Map<number, string>;
  headerRows: number[];
  itemRows: number[];
  totalRows: number[];
}

const BLOCK_MAP: Record<string, [string, string, string | null, string | null]> = {
  exporterBlock: ["exporterName", "exporterAddress", null, null],
  consigneeBlock: ["consigneeName", "consigneeAddress", "consigneeCountry", "consigneeContact"],
  notifyBlock: [
    "notifyPartyName",
    "notifyPartyAddress",
    "notifyPartyCountry",
    "notifyPartyContact",
  ],
  buyerBlock: ["customerName", "customerAddress", "customerCountry", "customerContact"],
};

export function sheetScore(g: Grid): number {
  const found = new Set<string>();
  for (const cell of g.occupiedAnchors(g.body)) {
    const spec = matchLabel(clean(cell.value));
    if (spec) found.add(spec.key);
  }
  const core = [
    "invoiceNo", "invoiceDate", "consigneeBlock", "exporterBlock",
    "portOfLoading", "paymentTerms", "buyerBlock", "notifyBlock",
  ];
  const hits = core.filter((k) => found.has(k)).length;
  let score = Math.min(1, 0.18 * hits);
  if (SHEET_HINTS.some((h) => g.title.toLowerCase().includes(h))) score = Math.min(1, score + 0.1);
  return score;
}

export function readInvoice(grids: Grid[], sourceFormat: SourceFormat): ExtractionResult {
  const res = new ExtractionResult(sourceFormat);
  if (!grids.length) throw new Error("Document contains no readable content");

  let grid = grids[0];
  let best = -1;
  for (const g of grids) {
    const s = sheetScore(g);
    if (s > best) {
      best = s;
      grid = g;
    }
  }
  res.debug.sheet = grid.title;
  res.debug.bodyRegion = `${columnLetter(grid.body.minCol)}${grid.body.minRow}:${columnLetter(grid.body.maxCol)}${grid.body.maxRow}`;
  res.debug.otherSheets = grids.filter((g) => g !== grid).map((g) => g.title);
  if (grids.length > 1) {
    res.warnings.push(
      `Document has ${grids.length} sections; '${grid.title}' was read as the invoice.`,
    );
  }

  const cur: Cursor = {
    g: grid,
    res,
    labelCells: new Map(),
    itemCols: new Map(),
    headerRows: [],
    itemRows: [],
    totalRows: [],
  };

  scanLabels(cur);
  resolveLabelValues(cur);
  parsePartyBlocks(cur);
  scanInline(cur);
  parseItems(cur);
  parseCurrencyAndRate(cur);
  parseIdentifiers(cur);
  parseBank(cur);
  parseDeclarations(cur);
  parseWeights(cur);
  postProcess(cur);
  return res;
}

// --------------------------------------------------------------------------
// 1. find every label cell on the form
// --------------------------------------------------------------------------
function scanLabels(cur: Cursor): void {
  for (const cell of cur.g.occupiedAnchors(cur.g.body)) {
    const spec = matchLabel(clean(cell.value));
    if (spec) cur.labelCells.set(`${cell.row},${cell.col}`, spec);
  }
}

function sortedLabelCells(cur: Cursor): Array<[number, number, LabelSpec]> {
  return [...cur.labelCells.entries()]
    .map(([k, spec]) => {
      const [r, c] = k.split(",").map(Number);
      return [r, c, spec] as [number, number, LabelSpec];
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function isLabelCell(cur: Cursor, r: number, c: number): boolean {
  const [ar, ac] = cur.g.anchor(r, c);
  if (cur.labelCells.has(`${ar},${ac}`)) return true;
  return STOP_LABELS.has(normLabel(cur.g.text(ar, ac)));
}

// --------------------------------------------------------------------------
// 2. label -> value (inline, right, below)
// --------------------------------------------------------------------------
function inlineOf(text: string, spec: LabelSpec): string | null {
  for (const syn of [...spec.synonyms].sort((a, b) => b.length - a.length)) {
    const m = flexPattern(syn).exec(text);
    const v = m?.groups?.v ? clean(m.groups.v) : "";
    if (v) return v;
  }
  return null;
}

function pick(
  cur: Cursor,
  candidates: CellRef[],
  spec: LabelSpec,
): { value: unknown; row: number; col: number } | null {
  for (const cand of candidates) {
    if (isLabelCell(cur, cand.row, cand.col)) return null; // ran into the next label
    const txt = clean(cand.value);
    if (!txt) continue;
    if (spec.type === "date" && toIsoDate(cand.value) === null) continue;
    if (spec.type === "number" && toNumber(cand.value) === null) continue;
    return { value: cand.value, row: cand.row, col: cand.col };
  }
  return null;
}

function resolveLabelValues(cur: Cursor): void {
  const { g, res } = cur;
  const seenPriority = new Map<string, number>();

  for (const [r, c, spec] of sortedLabelCells(cur)) {
    if (spec.type === "multiline") continue; // handled by parsePartyBlocks
    const priority = spec.priority ?? 50;
    const existing = res.get(spec.key);
    if (existing && existing.value !== null && (seenPriority.get(spec.key) ?? 99) <= priority) {
      continue;
    }

    let value: unknown = null;
    let src: string | null = null;
    let vr: number | null = null;
    let vc: number | null = null;

    for (const direction of specDirections(spec)) {
      if (direction === "inline") {
        const v = inlineOf(g.text(r, c), spec);
        if (v) {
          value = v;
          src = g.coord(r, c);
          vr = r;
          vc = c;
        }
      } else if (direction === "right") {
        const cand = pick(cur, g.cellsRight(r, c, specMaxRight(spec)), spec);
        if (cand) {
          value = cand.value;
          vr = cand.row;
          vc = cand.col;
          src = g.coord(cand.row, cand.col);
        }
      } else {
        const cand = pick(cur, g.cellsBelow(r, c, specMaxBelow(spec)), spec);
        if (cand) {
          value = cand.value;
          vr = cand.row;
          vc = cand.col;
          src = g.coord(cand.row, cand.col);
        }
      }
      if (value !== null) break;
    }

    if (value !== null && spec.type === "rowtext" && vr !== null && vc !== null) {
      const joined = g.rowTexts(vr).map(([, t]) => t).join(" ");
      if (joined.length > clean(value).length) {
        value = joined;
        src = `${g.coord(vr, vc)}+`;
      }
    }

    if (value === null) {
      res.markMissing(spec.key, {
        source: g.coord(r, c),
        note: `'${g.text(r, c)}' is on the invoice but the value cell is blank.`,
      });
      seenPriority.set(spec.key, priority);
      continue;
    }

    if (spec.type === "date") {
      const raw = clean(value);
      const iso = toIsoDate(value);
      if (iso === null) {
        res.set(spec.key, raw, {
          status: FieldStatus.NEEDS_VERIFICATION,
          source: src,
          confidence: 0.3,
          note: `Could not read '${raw}' as a date.`,
        });
      } else {
        const ambiguous = typeof value === "string" && dateIsAmbiguous(value);
        res.set(spec.key, iso, {
          status: ambiguous ? FieldStatus.NEEDS_VERIFICATION : FieldStatus.EXTRACTED,
          source: src,
          raw,
          confidence: ambiguous ? 0.7 : 1,
          note: ambiguous
            ? `'${raw}' is ambiguous (day/month vs month/day); read as ${iso}.`
            : null,
        });
      }
    } else if (spec.type === "number") {
      res.set(spec.key, toNumber(value), { source: src, raw: clean(value) });
    } else {
      res.set(spec.key, clean(value), { source: src, raw: clean(value) });
    }
    seenPriority.set(spec.key, priority);
  }
}

// --------------------------------------------------------------------------
// 3. party address blocks
// --------------------------------------------------------------------------
function blockLines(cur: Cursor, r: number, c: number): Array<[number, number, string]> {
  const { g } = cur;
  const out: Array<[number, number, string]> = [];
  const [, , endR] = g.span(r, c);
  let rr = endR + 1;
  let blanks = 0;
  while (rr <= g.body.maxRow && out.length < 14) {
    const txt = g.text(rr, c);
    if (txt) {
      if (isLabelCell(cur, rr, c)) break;
      out.push([rr, c, txt]);
      blanks = 0;
    } else {
      blanks += 1;
      if (out.length || blanks >= 2) break;
    }
    rr += 1;
  }
  return out;
}

function parsePartyBlocks(cur: Cursor): void {
  const { g, res } = cur;
  for (const [r, c, spec] of sortedLabelCells(cur)) {
    const mapping = BLOCK_MAP[spec.key];
    if (!mapping) continue;
    const [nameKey, addrKey, countryKey, contactKey] = mapping;
    if (res.has(nameKey)) continue;

    const lines = blockLines(cur, r, c);
    const inline = inlineOf(g.text(r, c), spec);
    if (inline) lines.unshift([r, c, inline]);

    if (!lines.length) {
      res.markMissing(nameKey, {
        source: g.coord(r, c),
        note: `'${g.text(r, c)}' block is empty on the invoice.`,
      });
      res.markMissing(addrKey, { source: g.coord(r, c) });
      continue;
    }

    const name = lines[0][2];
    const rest = lines.slice(1).map(([, , t]) => t);
    // Phone / email lines are split off only when this block has somewhere to
    // put them. A block without a contact field (the notify party) keeps them in
    // the address, so a line printed on the invoice is never silently dropped.
    const contacts = contactKey ? rest.filter(isContactLine) : [];
    const address = (contactKey ? rest.filter((t) => !isContactLine(t)) : rest).map((t) =>
      t.replace(/[\s,;]+$/, ""),
    );
    let country: string | null = null;
    for (let i = address.length - 1; i >= 0; i -= 1) {
      country = findCountry(address[i]);
      if (country) break;
    }

    const src = `${g.coord(...g.anchor(lines[0][0], lines[0][1]))}+`;
    res.set(nameKey, name, { source: src });
    res.set(addrKey, address.length ? address.join(", ") : null, { source: src });
    if (countryKey) {
      if (country) res.set(countryKey, country, { source: src });
      else {
        res.markMissing(countryKey, {
          source: src,
          note: "No recognisable country in the address block.",
        });
      }
    }
    if (contactKey) {
      res.set(contactKey, contacts.length ? contacts.join("; ") : null, { source: src });
    }
  }
}

// --------------------------------------------------------------------------
// 4. inline "Label No. value" cells (footer identifiers)
// --------------------------------------------------------------------------
function scanInline(cur: Cursor): void {
  const { g, res } = cur;
  for (const cell of g.occupiedAnchors(g.body)) {
    const text = clean(cell.value);
    if (!text || text.length > 160) continue;
    for (const spec of INLINE_SPECS) {
      const m = spec.pattern.exec(text);
      if (!m) continue;
      const target = spec.key in INLINE_TARGET ? INLINE_TARGET[spec.key] : spec.key;
      if (target === null) break;
      const value = clean(m.groups?.v ?? "").replace(/^[\s.:-]+|[\s.:-]+$/g, "");
      const existing = res.get(target);
      if (existing && existing.value !== null) break;
      if (!value) {
        res.markMissing(target, {
          source: g.coord(cell.row, cell.col),
          note: `'${text}' appears on the invoice with no value filled in.`,
        });
      } else if (value.length > 80) {
        res.set(target, value.slice(0, 80), {
          status: FieldStatus.NEEDS_VERIFICATION,
          source: g.coord(cell.row, cell.col),
          confidence: 0.3,
          note: "Value looks unusually long — please confirm.",
        });
      } else {
        res.set(target, value, { source: g.coord(cell.row, cell.col), raw: text });
      }
      break;
    }
  }
}

// --------------------------------------------------------------------------
// 5. line items, totals, adjustments
// --------------------------------------------------------------------------
function headerMapOfRow(cur: Cursor, r: number): Map<number, string> {
  const mapping = new Map<number, string>();
  for (const [c, txt] of cur.g.rowTexts(r)) {
    if (isInlineCell(txt)) continue; // 'HSN NO: 68101990' is a value, not a header
    const key = classifyItemHeader(txt);
    if (key && !mapping.has(c)) mapping.set(c, key);
  }
  return mapping;
}

/** Locate the product-table header, which may wrap over several rows. */
function findItemHeader(cur: Cursor): {
  headerRow: number | null;
  headerEnd: number;
  colmap: Map<number, string>;
} {
  const { g } = cur;
  let headerRow: number | null = null;
  let bestMap = new Map<number, string>();
  let bestScore = 0;
  for (let r = g.body.minRow; r <= g.body.maxRow; r += 1) {
    const mapping = headerMapOfRow(cur, r);
    const score = new Set(mapping.values()).size;
    if (score > bestScore && score >= 3) {
      headerRow = r;
      bestMap = mapping;
      bestScore = score;
    }
  }
  if (headerRow === null) return { headerRow: null, headerEnd: 0, colmap: new Map() };

  const subMaps: Array<Map<number, string>> = [];
  let headerEnd = headerRow;
  for (let r = headerRow + 1; r <= Math.min(headerRow + 5, g.body.maxRow); r += 1) {
    const texts = g.rowTexts(r);
    if (texts.some(([, t]) => looksNumeric(t))) break; // first data row reached
    const m = headerMapOfRow(cur, r);
    if (m.size) {
      subMaps.push(m);
      headerEnd = r;
    }
  }

  const refined = new Map(bestMap);
  // a header cell merged/stretched over several columns is refined by the
  // sub-headers printed underneath it
  for (const [c] of g.rowTexts(headerRow)) {
    const [, c1, , c2] = g.span(headerRow, c);
    if (c2 <= c1) continue;
    const sub = new Map<number, string>();
    for (const m of subMaps) {
      for (const [cc, key] of m) {
        if (cc >= c1 && cc <= c2 && !sub.has(cc)) sub.set(cc, key);
      }
    }
    if (sub.size) {
      for (let cc = c1; cc <= c2; cc += 1) refined.delete(cc);
      for (const [cc, key] of sub) refined.set(cc, key);
    }
  }
  // columns the main header row never covered
  for (const m of subMaps) {
    for (const [cc, key] of m) if (!refined.has(cc)) refined.set(cc, key);
  }
  return { headerRow, headerEnd, colmap: refined };
}

/**
 * Header text and its data can sit in slightly different columns when the cell
 * boundaries were lost (PDF). If a mapped column holds no data at all while an
 * unmapped neighbour does, the mapping belongs to the neighbour.
 */
function realignColumns(
  cur: Cursor,
  colmap: Map<number, string>,
  headerEnd: number,
): Map<number, string> {
  const { g } = cur;
  const dataRows: number[] = [];
  for (let r = headerEnd + 1; r <= Math.min(headerEnd + 16, g.body.maxRow); r += 1) {
    const texts = g.rowTexts(r).map(([, t]) => t);
    if (texts.some(isTotalRow)) break;
    if (texts.length) dataRows.push(r);
  }
  if (!dataRows.length) return colmap;

  const filled = (col: number) =>
    dataRows.filter((r) => g.isAnchor(r, col) && g.text(r, col)).length;

  const out = new Map(colmap);
  for (const [col, key] of [...colmap.entries()].sort((a, b) => a[0] - b[0])) {
    if (filled(col)) continue;
    for (const cand of [col - 1, col + 1]) {
      if (cand < g.body.minCol || cand > g.body.maxCol || out.has(cand)) continue;
      if (filled(cand)) {
        out.delete(col);
        out.set(cand, key);
        break;
      }
    }
  }
  return out;
}

function colFor(colmap: Map<number, string>, key: string): number | null {
  for (const [c, k] of colmap) if (k === key) return c;
  return null;
}

function looksLikeItem(rowVals: Record<string, unknown>): boolean {
  const hasAmount = toNumber(rowVals.amount) !== null;
  const hasQty = toNumber(rowVals.quantity) !== null;
  const descText = clean(rowVals.description) || clean(rowVals.designColour);
  // a description cell that is itself a number is a stray value, not a product
  const hasDesc = !!descText && toNumber(descText) === null;
  return hasAmount || (hasQty && hasDesc);
}

function buildItem(
  cur: Cursor,
  r: number,
  rowVals: Record<string, unknown>,
): LineItem {
  const { amount: nw, unit: nwUnit } = weightWithUnit(rowVals.netWeight);
  const item = emptyLineItem();
  item.description = clean(rowVals.description) || clean(rowVals.designColour) || null;
  item.designColour = clean(rowVals.designColour) || null;
  item.thickness = clean(rowVals.thickness) || null;
  item.hsn = clean(rowVals.hsn) || null;
  item.quantity = toNumber(rowVals.quantity);
  item.unit = clean(rowVals.unit) || null;
  item.rate = toNumber(rowVals.rate);
  item.amount = toNumber(rowVals.amount);
  item.slabsPcs = toNumber(rowVals.slabsPcs);
  item.netWeight = nw;
  item.netWeightUnit = nwUnit;
  item.marksNos = clean(rowVals.marksNos) || null;
  item.packages = clean(rowVals.packages) || null;
  item.source = cur.g.coord(r, cur.g.body.minCol);
  return item;
}

function parseItems(cur: Cursor): void {
  const { g, res } = cur;
  const found = findItemHeader(cur);
  if (found.headerRow === null) {
    res.warnings.push("No product table header was recognised; line items not extracted.");
    return;
  }
  const colmap = realignColumns(cur, found.colmap, found.headerEnd);
  cur.itemCols = colmap;
  cur.headerRows = [found.headerRow, found.headerEnd];
  res.debug.itemHeaderRow = found.headerRow;
  res.debug.itemColumns = Object.fromEntries(
    [...colmap.entries()].map(([c, k]) => [columnLetter(c), k]),
  );

  const amountCol = colFor(colmap, "amount");
  const qtyCol = colFor(colmap, "quantity");
  const descCols = [...colmap.entries()]
    .filter(([, k]) => k === "description" || k === "designColour")
    .map(([c]) => c);

  const adjustments = new Map<string, [number, string]>();
  const totals: Array<[number, Record<string, unknown>]> = [];
  let sectionDesc: [string, string] | null = null;

  for (let r = found.headerEnd + 1; r <= g.body.maxRow; r += 1) {
    // only a cell that *starts* in a column belongs to it; a wide cell must not
    // be copied into every column it happens to stretch over
    const rowVals: Record<string, unknown> = {};
    for (const [c, k] of colmap) rowVals[k] = g.isAnchor(r, c) ? g.raw(r, c) : null;

    const texts = g.rowTexts(r).map(([, t]) => clean(t));
    const joined = texts.join(" ");
    const amount = amountCol !== null ? toNumber(rowVals.amount) : null;
    const qty = qtyCol !== null ? toNumber(rowVals.quantity) : null;

    const totalHit = texts.some(isTotalRow);
    let adjKey: string | null = null;
    for (const t of texts) {
      adjKey = classifyAdjustment(t);
      if (adjKey) break;
    }

    if (totalHit) {
      totals.push([r, rowVals]);
      cur.totalRows.push(r);
    } else if (adjKey) {
      if (amount !== null && amountCol !== null) {
        adjustments.set(adjKey, [amount, g.coord(r, amountCol)]);
      }
    } else if (amount !== null || qty !== null) {
      // footer identifier lines ("Container No. …") can drift into product
      // columns on a PDF — they are never items
      if (texts.some(isInlineCell)) continue;
      if (totals.length) {
        // below the total line the product table is finished; stray numbers
        // there (exchange rate, weights, bank data) are not items
        if (looksLikeItem(rowVals)) {
          res.warnings.push(
            `Row ${r} carries an amount below the table total and was ignored: '${g.rowLine(r).slice(0, 70)}'.`,
          );
        }
      } else if (looksLikeItem(rowVals)) {
        cur.itemRows.push(r);
        res.lineItems.push(buildItem(cur, r, rowVals));
      }
    } else if (!cur.itemRows.length && joined && joined.length > 3 && !looksNumeric(joined)) {
      // a section caption above the item rows = the product description
      const cands = descCols
        .map((c) => [c, clean(g.text(r, c))] as [number, string])
        .filter(([, t]) => t);
      if (cands.length && sectionDesc === null) {
        const [c0, t0] = cands.reduce((a, b) => (b[1].length > a[1].length ? b : a));
        sectionDesc = [t0, g.coord(r, c0)];
      }
    }
  }

  if (sectionDesc) {
    res.set("productDescription", sectionDesc[0], { source: sectionDesc[1] });
  } else if (res.lineItems.length) {
    const descs = [...new Set(res.lineItems.map((li) => li.description).filter(Boolean))];
    if (descs.length) {
      res.set("productDescription", descs.join("; ").slice(0, 200), {
        status: FieldStatus.NEEDS_VERIFICATION,
        source: "line items",
        confidence: 0.6,
        note: "Built from the line-item descriptions — no product caption row found.",
      });
    } else {
      res.markMissing("productDescription");
    }
  } else {
    res.markMissing("productDescription");
  }

  for (const [key, [value, src]] of adjustments) {
    if (["packingCharges", "insuranceCharges", "freightCharges", "discount", "otherCharges"].includes(key)) {
      res.set(key, value, { source: src });
    }
  }

  finaliseTotals(cur, totals, colmap, adjustments);
}

function finaliseTotals(
  cur: Cursor,
  totals: Array<[number, Record<string, unknown>]>,
  colmap: Map<number, string>,
  adjustments: Map<string, [number, string]>,
): void {
  const { g, res } = cur;
  const amountCol = colFor(colmap, "amount");
  const itemsSum = res.lineItems.reduce((acc, li) => acc + (li.amount ?? 0), 0);
  if (res.lineItems.length) {
    res.set("lineItemsTotal", round2(itemsSum), {
      status: FieldStatus.CALCULATED,
      source: "sum of line items",
    });
  }

  const totalAmounts: Array<[number, number]> = [];
  for (const [r, vals] of totals) {
    let amt = toNumber(vals.amount);
    if (amt === null && amountCol !== null) amt = toNumber(g.raw(r, amountCol));
    if (amt !== null) totalAmounts.push([r, amt]);
  }

  if (totalAmounts.length) {
    const [r, amt] = totalAmounts[totalAmounts.length - 1];
    const adjTotal = [...adjustments.values()].reduce((a, [v]) => a + v, 0);
    const expected = itemsSum + adjTotal;
    let status: FieldStatus = FieldStatus.EXTRACTED;
    let note: string | null = null;
    let confidence = 1;
    if (res.lineItems.length && Math.abs(expected - amt) > Math.max(0.05, Math.abs(amt) * 0.00001)) {
      status = FieldStatus.NEEDS_VERIFICATION;
      confidence = 0.6;
      note =
        `Invoice total ${amt.toFixed(2)} does not match line items ${itemsSum.toFixed(2)} ` +
        `plus adjustments ${adjTotal.toFixed(2)} = ${expected.toFixed(2)}.`;
    }
    res.set("invoiceValue", round2(amt), {
      status,
      source: g.coord(r, amountCol ?? g.body.maxCol),
      confidence,
      note,
    });
  } else {
    res.markMissing("invoiceValue", { note: "No total row found in the product table." });
  }

  // the first total row usually carries quantity / weight / piece totals
  if (totals.length) {
    const [r, vals] = totals[0];
    const qty = toNumber(vals.quantity);
    if (qty !== null) {
      res.set("totalQuantity", qty, { source: g.coord(r, colFor(colmap, "quantity") ?? 1) });
      const unit = clean(vals.unit);
      if (unit) res.set("quantityUnit", unit, { source: g.coord(r, colFor(colmap, "unit") ?? 1) });
    }
    const pcs = toNumber(vals.slabsPcs);
    if (pcs !== null) {
      res.set("totalSlabsPcs", pcs, { source: g.coord(r, colFor(colmap, "slabsPcs") ?? 1) });
    }
    const { amount: nw, unit: nwUnit } = weightWithUnit(vals.netWeight);
    if (nw !== null && !res.has("netWeight")) {
      res.set("netWeight", nw, {
        source: g.coord(r, colFor(colmap, "netWeight") ?? 1),
        note: "Total of the line-item net weights.",
      });
      if (nwUnit) res.set("netWeightUnit", nwUnit, { source: "line item total" });
    }
  }

  if (res.lineItems.length) {
    const packages = [...new Set(res.lineItems.map((li) => li.packages).filter(Boolean))];
    const marks = [...new Set(res.lineItems.map((li) => li.marksNos).filter(Boolean))];
    if (packages.length) res.set("packages", packages.join("; "), { source: "line items" });
    if (marks.length) res.set("marksNos", marks.join("; "), { source: "line items" });
  }
}

// --------------------------------------------------------------------------
// 6. currency + exchange rate
// --------------------------------------------------------------------------
function parseCurrencyAndRate(cur: Cursor): void {
  const { g, res } = cur;
  const colmap = cur.itemCols;

  let code: string | null = null;
  let src: string | null = null;
  for (const key of ["amount", "rate"]) {
    const col = colFor(colmap, key);
    if (col === null || !cur.headerRows.length) continue;
    const hr0 = cur.headerRows[0];
    const hr1 = cur.headerRows.length > 1 ? Math.max(...cur.headerRows) : hr0;
    for (let rr = hr0; rr <= hr1 + 1; rr += 1) {
      const found = toCurrencyCode(g.text(rr, col));
      if (found) {
        code = found;
        src = g.coord(rr, col);
        break;
      }
    }
    if (code) break;
  }
  if (!code) {
    const words = res.value("amountInWords");
    const found = words ? toCurrencyCode(String(words).split(":")[0]) : null;
    if (found) {
      code = found;
      src = "amount in words";
    }
  }
  if (code) res.set("currency", code, { source: src });
  else res.markMissing("currency", { note: "No currency code or name found near the amounts." });

  parseExchangeRate(cur);
}

function rateFromFormula(g: Grid, totalRef: string): [string, number] | null {
  const target = totalRef.replace(/\$/g, "").toUpperCase();
  for (const formula of g.formulas.values()) {
    const body = formula.replace(/^[=+\s]+/, "");
    if (!body.includes("*") || body.includes("!")) continue;
    const refs = [...body.matchAll(CELL_REF_RE)].map((m) => m[0].replace(/\$/g, "").toUpperCase());
    if (refs.length !== 2 || !refs.includes(target)) continue;
    const other = refs[1] === target ? refs[0] : refs[1];
    const value = toNumber(g.valueAtRef(other));
    if (value !== null && value > 0 && value < 100_000) return [other, value];
  }
  return null;
}

function parseExchangeRate(cur: Cursor): void {
  const { g, res } = cur;

  // (a) an explicit label anywhere on the form
  for (const cell of g.occupiedAnchors(g.body)) {
    const n = normLabel(cell.value);
    if (!n) continue;
    const isRateLabel = ["exchangerate", "exrate", "rateofexchange", "conversionrate", "forexrate"]
      .some((t) => n.startsWith(t));
    if (!isRateLabel) continue;
    const candidates = [
      ...g.cellsRight(cell.row, cell.col, 4),
      ...g.cellsBelow(cell.row, cell.col, 2),
    ];
    for (const cand of candidates) {
      const num = toNumber(cand.value);
      if (num !== null && num > 0 && num < 100_000) {
        res.set("exchangeRate", num, { source: g.coord(cand.row, cand.col) });
        return;
      }
    }
  }

  // (b) the workbook's own conversion formula: <total cell> * <rate cell>
  const invField = res.get("invoiceValue");
  if (invField?.source && invField.source.includes("!")) {
    const ref = invField.source.split("!").pop() as string;
    const found = rateFromFormula(g, ref);
    if (found) {
      const [addr, value] = found;
      res.set("exchangeRate", value, {
        status: FieldStatus.EXTRACTED,
        source: `${g.title}!${addr}`,
        confidence: 0.9,
        note: `Taken from the workbook's own conversion formula (total x ${addr}).`,
      });
      return;
    }
  }

  // (c) a stand-alone "<CURRENCY>  <number>" line below the product table
  const lastItem = cur.itemRows.length ? Math.max(...cur.itemRows) : g.body.minRow;
  const skipRows = new Set(cur.totalRows);
  const amountCol = colFor(cur.itemCols, "amount");
  const rateCol = colFor(cur.itemCols, "rate");
  for (let r = lastItem + 1; r <= g.body.maxRow; r += 1) {
    if (skipRows.has(r)) continue;
    const texts = g.rowTexts(r);
    const codeCell = texts.find(([, t]) => t.length <= 25 && toCurrencyCode(t));
    if (!codeCell) continue;
    for (const [c] of texts) {
      if (c === amountCol || c === rateCol || c === codeCell[0]) continue;
      const num = toNumber(g.raw(r, c));
      if (num !== null && num >= 1 && num < 100_000) {
        res.set("exchangeRate", num, {
          status: FieldStatus.NEEDS_VERIFICATION,
          source: g.coord(r, c),
          confidence: 0.55,
          note:
            `Inferred from the line '${g.rowLine(r)}' — the invoice has no ` +
            "'Exchange Rate' label. Please confirm.",
        });
        return;
      }
    }
  }
  res.markMissing("exchangeRate", {
    note: "No exchange rate found on the invoice (often taken from Tally / customs).",
  });
}

// --------------------------------------------------------------------------
// 7. identifiers scattered over the form
// --------------------------------------------------------------------------
function parseIdentifiers(cur: Cursor): void {
  const { g, res } = cur;
  const gstins: Array<[string, string]> = [];
  const swifts: Array<[string, string]> = [];

  for (const cell of g.occupiedAnchors(g.body)) {
    const t = clean(cell.value);
    const gi = findGstin(t);
    if (gi && !gstins.some(([v]) => v === gi)) gstins.push([gi, g.coord(cell.row, cell.col)]);
    const m = /SWIFT(?:\s*CODE)?(?:\s*(?:NO|BIC))?[^A-Z0-9]{0,12}([A-Z0-9]{8,11})/.exec(t.toUpperCase());
    if (m && !swifts.some(([v]) => v === m[1])) swifts.push([m[1], g.coord(cell.row, cell.col)]);
  }

  if (gstins.length) {
    res.set("exporterGstin", gstins[0][0], { source: gstins[0][1] });
    if (gstins.length > 1) {
      res.set("customerGstin", gstins[1][0], {
        status: FieldStatus.NEEDS_VERIFICATION,
        source: gstins[1][1],
        confidence: 0.5,
        note: "Second GSTIN on the document — confirm it belongs to the customer.",
      });
    }
  } else {
    res.markMissing("exporterGstin");
  }

  if (swifts.length) {
    if (!res.has("bankSwift")) res.set("bankSwift", swifts[0][0], { source: swifts[0][1] });
    const current = res.value("bankSwift");
    const remaining = swifts.filter(([v]) => v !== current);
    if (remaining.length) res.set("routingSwift", remaining[0][0], { source: remaining[0][1] });
  }

  // IEC often comes back as "IEC ABCDE1234F"
  const iec = res.get("iecCode");
  if (iec && typeof iec.value === "string") {
    const cleaned = iec.value.replace(/^\s*IEC\s*(?:CODE)?\s*(?:NO\.?)?\s*[:-]?\s*/i, "").trim();
    if (cleaned && cleaned !== iec.value) {
      res.set("iecCode", cleaned, { source: iec.source, raw: iec.value });
    }
  }

  // container number sanity check
  const cont = res.get("containerNo");
  if (cont && typeof cont.value === "string") {
    const canon = findContainer(cont.value);
    if (canon && canon !== cont.value) {
      res.set("containerNo", canon, { source: cont.source, raw: cont.value });
    } else if (!canon) {
      res.set("containerNo", cont.value, {
        status: FieldStatus.NEEDS_VERIFICATION,
        source: cont.source,
        confidence: 0.5,
        note: "Does not match the standard 4 letters + 7 digits container format.",
      });
    }
  }
}

// --------------------------------------------------------------------------
function parseBank(cur: Cursor): void {
  const { g, res } = cur;
  for (const [r, c, spec] of sortedLabelCells(cur)) {
    if (spec.key !== "bankBlock") continue;
    const lines = blockLines(cur, r, c);
    if (!lines.length) {
      res.markMissing("bankName", { source: g.coord(r, c) });
      return;
    }
    const name = lines.map(([, , t]) => t).find((t) => !isInlineCell(t));
    if (name) res.set("bankName", name, { source: g.coord(lines[0][0], lines[0][1]) });
    return;
  }
  if (!res.get("bankName")) {
    res.markMissing("bankName", { note: "No bank block found on the invoice." });
  }
}

// --------------------------------------------------------------------------
function parseDeclarations(cur: Cursor): void {
  const { g, res } = cur;
  const parts: Array<[string, string]> = [];
  for (const cell of g.occupiedAnchors(g.body)) {
    const t = clean(cell.value);
    if (t.length > 40) parts.push([t, g.coord(cell.row, cell.col)]);
  }
  const blob = parts.map(([t]) => t).join(" ");
  const low = blob.toLowerCase();

  if (low.includes("without payment of igst") || (low.includes("lut") && low.includes("without payment"))) {
    res.set("exportTaxTreatment", "Export under LUT — without payment of IGST", {
      source: "declaration text",
    });
  } else if (low.includes("with payment of igst") || low.includes("under payment of igst")) {
    res.set("exportTaxTreatment", "Export with payment of IGST", { source: "declaration text" });
  } else {
    res.markMissing("exportTaxTreatment");
  }

  const m = /\b(?:LUT|ARN)\b[^A-Za-z0-9]{0,18}(?:no\.?)?[^A-Za-z0-9]{0,6}([A-Z0-9][A-Z0-9/-]{6,})/i.exec(blob);
  if (m) {
    const src = parts.find(([t]) => t.includes(m[1]))?.[1] ?? "declaration text";
    res.set("lutNo", m[1].replace(/[\s.]+$/, ""), { source: src });
    const tail = blob.slice(m.index + m[0].length, m.index + m[0].length + 60);
    const iso = toIsoDate(tail);
    if (iso) {
      const ambiguous = dateIsAmbiguous(tail);
      res.set("lutDate", iso, {
        source: src,
        status: ambiguous ? FieldStatus.NEEDS_VERIFICATION : FieldStatus.EXTRACTED,
        confidence: ambiguous ? 0.7 : 1,
        note: ambiguous
          ? `'${clean(tail).slice(0, 24)}' is ambiguous (day/month vs month/day).`
          : null,
      });
    }
  } else {
    res.markMissing("lutNo");
  }
}

// --------------------------------------------------------------------------
function parseWeights(cur: Cursor): void {
  const { res } = cur;
  const pairs: Array<[string, string, string]> = [
    ["grossWeightRaw", "grossWeight", "grossWeightUnit"],
    ["netWeightRaw", "netWeight", "netWeightUnit"],
  ];
  for (const [rawKey, valueKey, unitKey] of pairs) {
    const f = res.get(rawKey);
    if (!f || f.value === null) continue;
    const { amount, unit } = weightWithUnit(f.value);
    if (amount === null) continue;
    res.set(valueKey, amount, { source: f.source, raw: String(f.value) });
    if (unit) res.set(unitKey, unit, { source: f.source });
  }
  res.fields.delete("grossWeightRaw");
  res.fields.delete("netWeightRaw");
  for (const k of ["grossWeight", "netWeight"]) {
    if (!res.get(k)) res.markMissing(k);
  }
}

// --------------------------------------------------------------------------
function postProcess(cur: Cursor): void {
  const { g, res } = cur;

  // financial year, if printed anywhere
  if (!res.has("financialYear")) {
    for (const cell of g.occupiedAnchors(g.body)) {
      const m = /\bF\.?\s?Y\.?\s*[:-]?\s*(\d{4}\s*-\s*\d{2,4}|\d{2}\s*-\s*\d{2})/i.exec(clean(cell.value));
      if (m) {
        res.set("financialYear", clean(m[1]), { source: g.coord(cell.row, cell.col) });
        break;
      }
    }
  }

  splitPoRef(cur);

  // incoterm from the delivery terms
  const deliveryTerms = res.value("deliveryTerms");
  let { code, place } = findIncoterm(deliveryTerms ?? "");
  if (!code) {
    for (const cell of g.occupiedAnchors(g.body)) {
      const t = clean(cell.value);
      if (t.length < 200 && (t.toLowerCase().includes("delivery") || t.toLowerCase().includes("incoterm"))) {
        const found = findIncoterm(t);
        if (found.code) {
          code = found.code;
          place = found.place;
          break;
        }
      }
    }
  }
  if (code) {
    res.set("incoterm", code, {
      status: FieldStatus.CALCULATED,
      source: res.get("deliveryTerms")?.source ?? "delivery terms",
      note: "Read from the delivery terms text.",
    });
    if (place) {
      res.set("incotermPlace", place, { status: FieldStatus.CALCULATED, source: "delivery terms" });
    }
  } else {
    res.markMissing("incoterm");
  }

  // document title from the banner rows
  for (let r = g.body.minRow; r <= Math.min(g.body.minRow + 4, g.body.maxRow); r += 1) {
    let done = false;
    for (const [c, t] of g.rowTexts(r)) {
      if (t.length >= 3 && t.length <= 40 && t.toLowerCase().includes("invoice") && !matchLabel(t)) {
        res.set("invoiceTitle", t, { source: g.coord(r, c) });
        done = true;
        break;
      }
    }
    if (done) break;
  }
}

function splitPoRef(cur: Cursor): void {
  const { res } = cur;
  const f = res.get("poRefRaw");
  if (!f || !f.value) {
    res.markMissing("poNo");
    res.markMissing("poDate");
    if (!res.get("piRefRaw")) res.markMissing("piNo");
    return;
  }
  const text = String(f.value);

  let piValue: string | null = null;
  for (const m of text.matchAll(/\(([^)]+)\)/g)) {
    const inner = clean(m[1]);
    if (/\b(PI|SO|PROFORMA|SAL[-\s]?ORD|ORD)\b/i.test(inner)) piValue = inner;
  }
  const body = text.replace(/\([^)]*\)/g, " ");

  const split = body.split(/\b(?:dt|dtd|date|dated)\b\.?\s*:?\s*/i);
  const poPart = clean(split[0]);
  const dateRaw = split.length > 1 ? clean(split[1]) : null;
  const dateIso = dateRaw ? toIsoDate(dateRaw) : null;

  // strip only a real "PO No:" prefix — "PO-4069880" *is* the reference
  const poNo =
    clean(poPart.replace(/^\s*(?:p\.?\s*o\.?|purchase\s+order|order)\s*(?:no\.?|number|ref\.?)\s*[:\-–]?\s*/i, "")) ||
    poPart;
  if (poNo) res.set("poNo", poNo, { source: f.source, raw: text });
  else res.markMissing("poNo", { source: f.source });

  if (dateIso) {
    const ambiguous = dateRaw ? dateIsAmbiguous(dateRaw) : false;
    res.set("poDate", dateIso, {
      source: f.source,
      raw: dateRaw,
      status: ambiguous ? FieldStatus.NEEDS_VERIFICATION : FieldStatus.EXTRACTED,
      confidence: ambiguous ? 0.7 : 1,
      note: ambiguous
        ? `'${dateRaw}' is ambiguous (day/month vs month/day); read as ${dateIso}.`
        : null,
    });
  } else {
    res.markMissing("poDate", {
      source: f.source,
      note: "No date printed alongside the PO reference.",
    });
  }

  const piExisting = res.get("piRefRaw");
  if (piExisting?.value) {
    res.set("piNo", clean(piExisting.value), { source: piExisting.source });
  } else if (piValue) {
    res.set("piNo", piValue, {
      source: f.source,
      raw: text,
      note: "Taken from the bracketed reference in the PO line.",
    });
  } else {
    res.markMissing("piNo");
  }
  res.fields.delete("poRefRaw");
  res.fields.delete("piRefRaw");
}
