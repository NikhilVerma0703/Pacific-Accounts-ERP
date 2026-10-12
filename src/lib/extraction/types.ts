/**
 * The contract every extractor speaks.
 *
 * A field is never a bare value: it always carries where it came from and how
 * much we trust it, so the UI can honestly say "extracted" / "needs verification"
 * / "missing" instead of silently showing a guess.
 */

export const FieldStatus = {
  EXTRACTED: "extracted",
  CALCULATED: "calculated",
  NEEDS_VERIFICATION: "needs_verification",
  MISSING: "missing",
  NOT_PRESENT: "not_present",
  CONFLICT: "conflict",
} as const;

export type FieldStatus = (typeof FieldStatus)[keyof typeof FieldStatus];

export const USABLE_STATUSES: FieldStatus[] = [
  FieldStatus.EXTRACTED,
  FieldStatus.CALCULATED,
  FieldStatus.NEEDS_VERIFICATION,
];

export function isUsable(status: FieldStatus): boolean {
  return USABLE_STATUSES.includes(status);
}

/** A value is a string, a number, or an ISO date string (yyyy-mm-dd). */
export type FieldValue = string | number | null;

export interface ExtractedField {
  key: string;
  value: FieldValue;
  raw?: string | null;
  status: FieldStatus;
  source?: string | null;
  confidence: number;
  note?: string | null;
}

export interface LineItem {
  description: string | null;
  designColour: string | null;
  thickness: string | null;
  hsn: string | null;
  quantity: number | null;
  unit: string | null;
  rate: number | null;
  amount: number | null;
  slabsPcs: number | null;
  netWeight: number | null;
  netWeightUnit: string | null;
  marksNos: string | null;
  packages: string | null;
  source: string | null;
}

export function emptyLineItem(): LineItem {
  return {
    description: null,
    designColour: null,
    thickness: null,
    hsn: null,
    quantity: null,
    unit: null,
    rate: null,
    amount: null,
    slabsPcs: null,
    netWeight: null,
    netWeightUnit: null,
    marksNos: null,
    packages: null,
    source: null,
  };
}

export type SourceFormat = "xlsx" | "pdf";

export interface ExtractionDebug {
  sheet?: string;
  bodyRegion?: string;
  otherSheets?: string[];
  itemHeaderRow?: number;
  itemColumns?: Record<string, string>;
}

/** Raw, document-shaped output of an extractor. Not yet business data. */
export class ExtractionResult {
  documentType = "commercial_invoice";
  sourceFormat: SourceFormat;
  sourceName: string | null = null;
  fields = new Map<string, ExtractedField>();
  lineItems: LineItem[] = [];
  warnings: string[] = [];
  debug: ExtractionDebug = {};

  constructor(sourceFormat: SourceFormat) {
    this.sourceFormat = sourceFormat;
  }

  set(
    key: string,
    value: FieldValue,
    opts: {
      status?: FieldStatus;
      source?: string | null;
      confidence?: number;
      raw?: string | null;
      note?: string | null;
    } = {},
  ): void {
    if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
      this.markMissing(key, { note: opts.note, source: opts.source });
      return;
    }
    this.fields.set(key, {
      key,
      value,
      raw: opts.raw ?? null,
      status: opts.status ?? FieldStatus.EXTRACTED,
      source: opts.source ?? null,
      confidence: opts.confidence ?? 1,
      note: opts.note ?? null,
    });
  }

  markMissing(
    key: string,
    opts: { note?: string | null; source?: string | null; status?: FieldStatus } = {},
  ): void {
    const existing = this.fields.get(key);
    if (existing && existing.value !== null) return;
    this.fields.set(key, {
      key,
      value: null,
      raw: null,
      status: opts.status ?? FieldStatus.MISSING,
      source: opts.source ?? null,
      confidence: 0,
      note: opts.note ?? null,
    });
  }

  get(key: string): ExtractedField | undefined {
    return this.fields.get(key);
  }

  value<T extends FieldValue>(key: string, fallback: T | null = null): FieldValue {
    const f = this.fields.get(key);
    return f && f.value !== null ? f.value : fallback;
  }

  has(key: string): boolean {
    const f = this.fields.get(key);
    return !!f && f.value !== null;
  }
}

// ---------------------------------------------------------------- grid
export interface Region {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

export function regionContains(region: Region, r: number, c: number): boolean {
  return r >= region.minRow && r <= region.maxRow && c >= region.minCol && c <= region.maxCol;
}

export interface CellRef {
  row: number;
  col: number;
  value: unknown;
}

/**
 * A worksheet-like view. Both the Excel reader and the PDF reader implement it,
 * so one invoice-reading algorithm serves both formats.
 */
export interface Grid {
  readonly title: string;
  readonly body: Region;
  /** "row,col" -> formula string, empty for PDFs. */
  readonly formulas: Map<string, string>;

  anchor(r: number, c: number): [number, number];
  /** [r1, c1, r2, c2] of the merged/stretched block this cell belongs to. */
  span(r: number, c: number): [number, number, number, number];
  raw(r: number, c: number): unknown;
  text(r: number, c: number): string;
  isAnchor(r: number, c: number): boolean;
  coord(r: number, c: number): string;
  occupiedAnchors(region?: Region): CellRef[];
  cellsRight(r: number, c: number, limit: number): CellRef[];
  cellsBelow(r: number, c: number, limit: number): CellRef[];
  rowTexts(r: number): Array<[number, string]>;
  rowLine(r: number): string;
  /** Value at an A1-style reference, used for the workbook's own formulas. */
  valueAtRef(ref: string): unknown;
}
