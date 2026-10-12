/**
 * Raw extraction -> normalized Accounts data.
 *
 * This layer is where document shape stops mattering. It:
 *  - fills every catalogue key, with an honest status for the ones not found;
 *  - applies safe derivations (INR value, invoice type) and labels them CALCULATED;
 *  - records why anything is missing, so the UI can ask for exactly what is needed.
 *
 * It deliberately does NOT invent business rules — see lib/business/rules.ts.
 */
import {
  BUYER_WHEN_NOT_NAMED,
  PARTY_BLOCKS,
  type PartyBlockKey,
} from "../business/rules";
import { HOME_COUNTRY, HOME_CURRENCY } from "../config";
import { BY_KEY, CATALOG, ORIGIN_TEXT, type FieldDef } from "../extraction/catalog";
import { findCountry, isContactLine, round2, todayIso } from "../extraction/text";
import {
  FieldStatus,
  type ExtractedField,
  type ExtractionResult,
  type FieldValue,
  type LineItem,
  type SourceFormat,
} from "../extraction/types";

export interface NormalizedInvoice {
  fields: Record<string, ExtractedField>;
  lineItems: LineItem[];
  warnings: string[];
  sourceFormat: SourceFormat | "";
  sourceName: string;
}

export function fieldValue(n: NormalizedInvoice, key: string): FieldValue {
  const f = n.fields[key];
  return f && f.value !== null && f.value !== undefined ? f.value : null;
}

export function fieldStatus(n: NormalizedInvoice, key: string): FieldStatus {
  return n.fields[key]?.status ?? FieldStatus.MISSING;
}

export function fieldNumber(n: NormalizedInvoice, key: string): number | null {
  const v = fieldValue(n, key);
  return typeof v === "number" ? v : null;
}

export function fieldString(n: NormalizedInvoice, key: string): string | null {
  const v = fieldValue(n, key);
  return v === null ? null : String(v);
}

/** Where a value came from — the cell, the file, or the person who typed it. */
export function fieldSource(n: NormalizedInvoice, key: string): string | null {
  return n.fields[key]?.source ?? null;
}

function setField(
  n: NormalizedInvoice,
  key: string,
  value: FieldValue,
  status: FieldStatus,
  opts: { source?: string | null; note?: string | null; confidence?: number } = {},
): void {
  n.fields[key] = {
    key,
    value,
    status,
    source: opts.source ?? null,
    note: opts.note ?? null,
    confidence: opts.confidence ?? 1,
  };
}

function notPresentNote(fd: FieldDef): string {
  const origin = fd.origin ?? "invoice";
  if (origin !== "invoice") {
    return `Not on the commercial invoice — ${ORIGIN_TEXT[origin]}.`;
  }
  return "Not printed on this invoice.";
}

export function normalize(result: ExtractionResult): NormalizedInvoice {
  const n: NormalizedInvoice = {
    fields: {},
    lineItems: [...result.lineItems],
    warnings: [...result.warnings],
    sourceFormat: result.sourceFormat,
    sourceName: result.sourceName ?? "",
  };

  for (const fd of CATALOG) {
    const f = result.get(fd.key);
    n.fields[fd.key] = f ?? {
      key: fd.key,
      value: null,
      status: FieldStatus.NOT_PRESENT,
      source: null,
      confidence: 0,
      note: notPresentNote(fd),
    };
  }

  fillPartyFallbacks(n);
  deriveInvoiceType(n);
  deriveHomeValue(n);
  deriveTaxPosition(n);
  propagateItemHsn(n);
  sanityChecks(n);
  return n;
}

/**
 * True when this field holds a value the document itself printed, or one an
 * Accounts employee typed in — as opposed to one a derivation filled in, which
 * may be recomputed whenever the rule behind it changes.
 */
function ownsItsValue(n: NormalizedInvoice, key: string): boolean {
  const f = n.fields[key];
  return !!f && f.value !== null && f.status === FieldStatus.EXTRACTED;
}

/**
 * Pull the country and the phone / email out of a one-line address.
 *
 * Only needed for invoices read before the notify block had its own country and
 * contact fields: their stored address still holds both, and re-reading the file
 * should not be the price of a rule change. Freshly read invoices arrive with
 * these already separated, and then nothing here applies.
 */
function partsOfAddress(address: string | null): {
  country: string | null;
  contact: string | null;
} {
  if (!address) return { country: null, contact: null };
  const pieces = address.split(",").map((p) => p.trim()).filter(Boolean);
  let country: string | null = null;
  const contacts: string[] = [];
  for (let i = pieces.length - 1; i >= 0; i -= 1) {
    if (!country) country = findCountry(pieces[i]);
    if (isContactLine(pieces[i])) contacts.unshift(pieces[i]);
  }
  return { country, contact: contacts.length ? contacts.join("; ") : null };
}

// --------------------------------------------------------------------------
/**
 * Export invoices often print no separate "Buyer" block, and the party that
 * bought the goods is not the one they are consigned to. Which block holds the
 * customer is a company decision, not something this layer may guess, so it
 * comes from BUYER_WHEN_NOT_NAMED in lib/business/rules.ts.
 *
 * Following that rule is reported as CALCULATED — the company has said this is
 * what its invoices mean. Falling back to the other block because the preferred
 * one is absent is a reading, and stays flagged for confirmation.
 */
function fillPartyFallbacks(n: NormalizedInvoice): void {
  // Only a customer the document actually names — or one typed in by hand, which
  // is stored the same way — is left alone. Anything this function produced
  // earlier is recomputed, so changing the rule reaches invoices that are
  // already in the register without re-reading their files.
  if (ownsItsValue(n, "customerName")) return;

  const order: PartyBlockKey[] =
    BUYER_WHEN_NOT_NAMED === "notifyParty"
      ? ["notifyParty", "consignee"]
      : ["consignee", "notifyParty"];
  const chosen = order.find((key) => fieldValue(n, PARTY_BLOCKS[key].name) !== null);
  if (!chosen) return;

  const block = PARTY_BLOCKS[chosen];
  const byRule = chosen === BUYER_WHEN_NOT_NAMED;
  const status = byRule ? FieldStatus.CALCULATED : FieldStatus.NEEDS_VERIFICATION;
  const confidence = byRule ? 0.9 : 0.6;

  setField(n, "customerName", fieldValue(n, block.name), status, {
    source: n.fields[block.name]?.source,
    confidence,
    note: byRule
      ? `The invoice names no separate buyer. Company rule: the ${block.label} is the actual end buyer / customer.`
      : `The invoice names no separate buyer and no ${PARTY_BLOCKS[BUYER_WHEN_NOT_NAMED].label}, ` +
        `so the ${block.label} was used as the customer. Please confirm.`,
  });

  // an invoice stored before the notify block had its own country and contact
  // fields keeps both inside its address; read them back out rather than asking
  // for a re-import
  const salvaged = partsOfAddress(fieldString(n, block.address));

  const carry: Array<[string, string | null, string | null]> = [
    ["customerAddress", block.address, null],
    ["customerCountry", block.country, salvaged.country],
    ["customerContact", block.contact, salvaged.contact],
  ];

  for (const [target, from, fallback] of carry) {
    if (ownsItsValue(n, target)) continue;

    const value = (from ? fieldValue(n, from) : null) ?? fallback;
    if (value !== null) {
      setField(n, target, value, status, {
        source: n.fields[from ?? block.address]?.source,
        confidence,
        note: `Taken from the ${block.label} block.`,
      });
      continue;
    }

    // Nothing to carry. The field must not keep what a previous rule put there —
    // a contact belonging to the consignee is worse than an honest blank.
    setField(n, target, null, FieldStatus.MISSING, {
      source: n.fields[block.name]?.source,
      confidence: 0,
      note: `The ${block.label} block on this invoice does not give it.`,
    });
  }
}

function deriveInvoiceType(n: NormalizedInvoice): void {
  const dest =
    fieldString(n, "countryOfDestination") ??
    fieldString(n, "customerCountry") ??
    fieldString(n, "consigneeCountry");
  const exportMarkers = [
    "portOfLoading", "portOfDischarge", "shippingBillNo", "blNo", "containerNo", "lutNo", "iecCode",
  ].some((k) => fieldValue(n, k) !== null);

  if (dest) {
    const isHome = dest.trim().toUpperCase() === HOME_COUNTRY;
    setField(n, "invoiceType", isHome ? "Domestic" : "Export", FieldStatus.CALCULATED, {
      source: "derived",
      note: `Final destination is ${dest}.`,
    });
    return;
  }
  if (exportMarkers) {
    setField(n, "invoiceType", "Export", FieldStatus.NEEDS_VERIFICATION, {
      source: "derived",
      confidence: 0.6,
      note: "No destination country found, but the invoice carries export details (port / LUT / container). Please confirm.",
    });
    return;
  }
  setField(n, "invoiceType", null, FieldStatus.MISSING, {
    note: "Could not tell Export from Domestic — no destination country and no export documents on the invoice.",
  });
}

function deriveHomeValue(n: NormalizedInvoice): void {
  const value = fieldNumber(n, "invoiceValue");
  const currency = fieldString(n, "currency");
  const rate = fieldNumber(n, "exchangeRate");

  if (value === null) {
    setField(n, "homeValue", null, FieldStatus.MISSING, {
      note: `Invoice value could not be read, so the ${HOME_CURRENCY} value cannot be worked out.`,
    });
    return;
  }
  if (currency && currency.toUpperCase() === HOME_CURRENCY) {
    setField(n, "homeValue", round2(value), FieldStatus.CALCULATED, {
      source: "calculated",
      note: `Invoice is already in ${HOME_CURRENCY}.`,
    });
    return;
  }
  if (rate) {
    const home = round2(value * rate);
    const rateNeedsCheck = fieldStatus(n, "exchangeRate") === FieldStatus.NEEDS_VERIFICATION;
    const status = rateNeedsCheck ? FieldStatus.NEEDS_VERIFICATION : FieldStatus.CALCULATED;
    let note = `${value.toLocaleString("en-IN", { minimumFractionDigits: 2 })} ${currency ?? ""} x ${rate} = ${home.toLocaleString("en-IN", { minimumFractionDigits: 2 })} ${HOME_CURRENCY}`.trim();
    if (rateNeedsCheck) note += " — the exchange rate itself needs confirming.";
    setField(n, "homeValue", home, status, {
      source: "calculated",
      note,
      confidence: rateNeedsCheck ? 0.7 : 1,
    });
    return;
  }
  setField(n, "homeValue", null, FieldStatus.MISSING, {
    note: `No exchange rate available. Enter the rate (or import it from Tally) and the ${HOME_CURRENCY} value will be calculated.`,
  });
}

function deriveTaxPosition(n: NormalizedInvoice): void {
  const treatment = fieldString(n, "exportTaxTreatment");
  if (fieldValue(n, "taxAmount") === null) {
    const lut = treatment?.toLowerCase().includes("without payment of igst");
    setField(n, "taxAmount", null, FieldStatus.NOT_PRESENT, {
      note: lut
        ? "Export under LUT without payment of IGST — no tax is charged on the invoice."
        : "No tax line printed on this invoice.",
    });
  }
  if (fieldValue(n, "taxableValue") === null && fieldValue(n, "invoiceValue") !== null) {
    setField(n, "taxableValue", null, FieldStatus.NOT_PRESENT, {
      note: "No separate taxable value printed; the invoice shows a single total.",
    });
  }
  if (fieldValue(n, "customerGstin") === null && fieldString(n, "invoiceType") === "Export") {
    setField(n, "customerGstin", null, FieldStatus.NOT_PRESENT, {
      note: "Export invoice — the overseas buyer has no GSTIN.",
    });
  }
}

function propagateItemHsn(n: NormalizedInvoice): void {
  const docHsn = fieldString(n, "hsnCode");
  if (!docHsn) return;
  for (const li of n.lineItems) if (!li.hsn) li.hsn = docHsn;
}

function sanityChecks(n: NormalizedInvoice): void {
  const invoiceDate = fieldString(n, "invoiceDate");
  if (invoiceDate) {
    const today = todayIso();
    const twoDays = new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    if (invoiceDate > twoDays) {
      const f = n.fields.invoiceDate;
      f.status = FieldStatus.NEEDS_VERIFICATION;
      f.note = `Invoice date ${invoiceDate} is in the future.`;
    }
    const poDate = fieldString(n, "poDate");
    if (poDate && poDate > invoiceDate) {
      const f = n.fields.poDate;
      f.status = FieldStatus.NEEDS_VERIFICATION;
      f.note = `PO date ${poDate} is after the invoice date ${invoiceDate}.`;
    }
  }

  const value = fieldNumber(n, "invoiceValue");
  if (value !== null && value <= 0) {
    const f = n.fields.invoiceValue;
    f.status = FieldStatus.NEEDS_VERIFICATION;
    f.note = "Invoice value is zero or negative.";
  }

  const rate = fieldNumber(n, "exchangeRate");
  if (rate !== null && (rate <= 0 || rate > 1000)) {
    const f = n.fields.exchangeRate;
    f.status = FieldStatus.NEEDS_VERIFICATION;
    f.note = `Exchange rate ${rate} looks unusual — please confirm.`;
  }
}

// --------------------------------------------------------------------------
/**
 * Rebuild a NormalizedInvoice from what was stored in the database.
 *
 * The party rule is re-applied here, not just at import. It is a company
 * decision that can change, and it is decided purely from fields that are
 * already stored — so an invoice read months ago follows today's rule the next
 * time it is opened, instead of keeping whatever was true on the day it was
 * imported. The other derivations are left alone: their inputs are stored with
 * the invoice and their results were saved beside them.
 */
export function normalizedFromJson(
  fields: Record<string, ExtractedField>,
  lineItems: LineItem[],
  warnings: string[] = [],
): NormalizedInvoice {
  const out: NormalizedInvoice = {
    fields: {},
    lineItems,
    warnings,
    sourceFormat: "",
    sourceName: "",
  };
  for (const fd of CATALOG) {
    out.fields[fd.key] = fields[fd.key] ?? {
      key: fd.key,
      value: null,
      status: FieldStatus.NOT_PRESENT,
      source: null,
      confidence: 0,
      note: notPresentNote(BY_KEY[fd.key]),
    };
  }
  fillPartyFallbacks(out);
  return out;
}
