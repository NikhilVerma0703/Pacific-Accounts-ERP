/**
 * The label dictionary — the one place that knows what invoices *call* things.
 *
 * Supporting a new invoice layout (or another vendor's template) should normally
 * mean adding synonyms here, not touching extractor code. Nothing in this file
 * is specific to any single document.
 */
import { normLabel } from "./text";

export type LabelDataType = "string" | "date" | "number" | "multiline" | "rowtext";
export type Direction = "inline" | "right" | "below";

export interface LabelSpec {
  key: string;
  synonyms: string[];
  type?: LabelDataType;
  directions?: Direction[];
  maxRight?: number;
  maxBelow?: number;
  exact?: boolean;
  /** Lower wins when two specs match the same cell. */
  priority?: number;
}

const DEFAULT_DIRECTIONS: Direction[] = ["inline", "right", "below"];

export const LABEL_SPECS: LabelSpec[] = [
  { key: "invoiceNo", priority: 10,
    synonyms: ["Invoice No", "Invoice Number", "Inv No", "Tax Invoice No", "Commercial Invoice No",
               "Document No", "Invoice No & Date"] },
  { key: "invoiceDate", type: "date", priority: 10,
    synonyms: ["Invoice Date", "Dated", "Date of Invoice", "Inv Date", "Dt"] },
  { key: "financialYear", exact: true, priority: 60, synonyms: ["FY", "Financial Year"] },

  { key: "exporterBlock", type: "multiline", directions: ["below"], maxBelow: 1, priority: 20,
    synonyms: ["Exporter", "Seller", "Shipper", "Exporter Name & Address", "Supplier", "From"] },
  { key: "consigneeBlock", type: "multiline", directions: ["below"], maxBelow: 1, priority: 20,
    synonyms: ["Consignee", "Consignee Name & Address", "Ship To"] },
  { key: "notifyBlock", type: "multiline", directions: ["below"], maxBelow: 1, priority: 20,
    synonyms: ["Notify Party", "Notify", "Notify Party Name & Address", "Second Notify Party"] },
  { key: "buyerBlock", type: "multiline", directions: ["below"], maxBelow: 1, priority: 25,
    synonyms: ["Buyer if Not Consignee", "Buyer Other Than Consignee", "Buyer", "Bill To",
               "Customer", "Buyer Name & Address"] },

  { key: "poRefRaw", priority: 15,
    synonyms: ["Buyers PO Ref", "Buyer's PO Ref", "Buyers Order No", "Buyer's Order No", "PO No",
               "Purchase Order No", "PO Ref", "Order No", "Buyers Ref"] },
  { key: "piRefRaw", priority: 15,
    synonyms: ["PI No", "Proforma Invoice No", "PI Ref", "Proforma No", "Sales Order No", "SO No"] },
  { key: "paymentTerms", priority: 10,
    synonyms: ["Payment Terms", "Terms of Payment", "Payment Term"] },
  { key: "deliveryTerms", priority: 10,
    synonyms: ["Delivery Terms", "Terms of Delivery", "Incoterms", "Incoterm", "Shipment Terms",
               "Trade Terms"] },
  { key: "termsConditions", type: "multiline", directions: ["below"], maxBelow: 3, priority: 70,
    synonyms: ["Terms & Conditions", "Terms and Conditions"] },

  { key: "countryOfOrigin", directions: ["below", "right"], priority: 20,
    synonyms: ["Country of Origin of Goods", "Country of Origin", "Origin"] },
  { key: "countryOfDestination", directions: ["below", "right"], priority: 20,
    synonyms: ["Country of Final Destination", "Country of Destination", "Final Destination Country"] },
  { key: "preCarriageBy", directions: ["below", "right"], priority: 20,
    synonyms: ["Pre-Carriage By", "Pre Carriage By"] },
  { key: "placeOfReceipt", directions: ["below", "right"], priority: 20,
    synonyms: ["Place of Receipt By Pre-Carrier", "Place of Receipt", "Place of Receipt by Pre Carrier"] },
  { key: "vesselFlightNo", directions: ["below", "right"], priority: 20,
    synonyms: ["Vessel/Flight No", "Vessel / Flight No", "Vessel No", "Flight No",
               "Vessel & Voyage No", "Vessel Voy No"] },
  { key: "portOfLoading", directions: ["below", "right"], priority: 20,
    synonyms: ["Port of Loading", "POL", "Loading Port"] },
  { key: "portOfDischarge", directions: ["below", "right"], priority: 20,
    synonyms: ["Port of Discharge", "POD", "Discharge Port"] },
  { key: "finalDestination", directions: ["below", "right"], priority: 25,
    synonyms: ["Final Destination", "Place of Delivery", "Destination"] },

  { key: "iecCode", priority: 15, synonyms: ["IEC Code No", "IEC Code", "IEC No", "IE Code"] },
  { key: "rbiCode", priority: 60, synonyms: ["RBI Code No", "RBI Code"] },
  { key: "bankBlock", type: "multiline", directions: ["below"], maxBelow: 1, priority: 20,
    synonyms: ["Our Bank Details", "Bank Details", "Bankers Name & Address",
               "Beneficiary Bank Details", "Bank Particulars"] },

  { key: "amountInWords", type: "rowtext", directions: ["below", "right"], maxBelow: 2, priority: 30,
    synonyms: ["Amount Chargeable In Words", "Amount in Words", "Total Amount in Words",
               "Amount Chargeable"] },
  { key: "grossWeightRaw", directions: ["right", "below"], maxRight: 3, priority: 20,
    synonyms: ["Gross Wt", "Gross Weight", "G.W."] },
  { key: "netWeightRaw", directions: ["right", "below"], maxRight: 3, priority: 20,
    synonyms: ["Net Wt", "Net Weight", "N.W."] },
  { key: "weightBlock", directions: ["below"], maxBelow: 1, priority: 75,
    synonyms: ["Weight in MT", "Weight in Kgs", "Weight"] },
];

export function specDirections(spec: LabelSpec): Direction[] {
  return spec.directions ?? DEFAULT_DIRECTIONS;
}

export function specMaxRight(spec: LabelSpec): number {
  return spec.maxRight ?? 6;
}

export function specMaxBelow(spec: LabelSpec): number {
  return spec.maxBelow ?? 2;
}

// --------------------------------------------------------------------------
// inline specs — label and value share one cell / one line
// --------------------------------------------------------------------------
export interface InlineSpec {
  key: string;
  pattern: RegExp;
}

/**
 * The cell must *start* with the label, and the label must be followed by a
 * marker ("No", ":", "-"). Without that, prose like "Account Manager: Ravi" or
 * "Container despatched under Self Sealing…" would match.
 */
function inline(alternatives: string): RegExp {
  return new RegExp(
    `^\\s*(?:${alternatives})\\s*(?:(?:nos?|number|#)\\b\\.?|[:\\-–])\\s*(?:[:\\-–]\\s*)?(?<v>.*)$`,
    "i",
  );
}

export const INLINE_SPECS: InlineSpec[] = [
  { key: "containerNo", pattern: inline(String.raw`container(?:\s*/\s*seal)?`) },
  { key: "vehicleNo", pattern: inline(String.raw`vehicle|truck|lorry`) },
  { key: "esealNo", pattern: inline(String.raw`e\s*-?\s*seal|seal`) },
  { key: "linerOtlNo", pattern: inline(String.raw`liner'?s?\s*otl|otl`) },
  { key: "blNo", pattern: inline(String.raw`b\s*/?\s*l|bill of lading|mbl|hbl|awb`) },
  { key: "shippingBillNo", pattern: inline(String.raw`s\.?\s*b\.?|shipping bill|shpg bill`) },
  { key: "hsnCode", pattern: inline(String.raw`hsn(?:\s*code)?|hs\s*code|hsn/sac`) },
  { key: "adCode", pattern: inline(String.raw`ad\s*code`) },
  { key: "bankAccountNo", pattern: inline(String.raw`a\s*/?\s*c|account|acct`) },
  { key: "bankSwift", pattern: inline(String.raw`swift(?:\s*code)?|bic`) },
  { key: "stateCode", pattern: inline(String.raw`state\s*code`) },
  { key: "districtCode", pattern: inline(String.raw`dis\w{0,3}trict\s*code`) },
  { key: "routingBank", pattern: inline(String.raw`routing bank|correspondent bank|intermediary bank`) },
  { key: "gstinInline", pattern: inline(String.raw`gstin|gst\s*no|gstin\s*/\s*uin`) },
];

/** Inline keys that are not catalogue fields, or that map elsewhere. */
export const INLINE_TARGET: Record<string, string | null> = {
  gstinInline: "exporterGstin",
  districtCode: null,
};

// --------------------------------------------------------------------------
// line-item table vocabulary
// --------------------------------------------------------------------------
export const ITEM_HEADER_TOKENS: Record<string, string[]> = {
  description: ["description of goods", "description", "particulars", "goods description",
                "item description", "product", "commodity"],
  designColour: ["colour", "color", "design", "design/colour", "shade", "pattern"],
  thickness: ["thick", "thickness", "thk", "size/thickness"],
  netWeight: ["net weight", "net wt", "weight", "nt weight"],
  slabsPcs: ["no.of slabs/pcs", "no of slabs", "slabs", "pcs", "pieces", "no of pcs",
             "qty in pcs", "nos"],
  quantity: ["quantity", "qty", "total quantity", "area", "qnty"],
  unit: ["unit", "uom", "units"],
  rate: ["rate", "unit price", "price", "rate in", "rate per unit"],
  amount: ["amount", "total amount", "value", "total amount in", "amount in", "taxable value",
           "total value"],
  hsn: ["hsn", "hsn code", "hsn no", "hs code", "hsn/sac"],
  marksNos: ["marks & nos", "marks and nos", "marks", "marks & numbers"],
  packages: ["no. of w/crt / bdl / box", "no. of w/crt", "no of w crt", "w/crt", "no of packages",
             "packages", "no of pkgs", "kind of packages", "nos of pkgs", "no. of pkgs", "crates",
             "no. of crates"],
};

export const TOTAL_ROW_TOKENS = ["total", "grand total", "total amount", "sub total", "subtotal",
                                 "total - slabs / pcs", "net total", "invoice total"];

export const ADJUSTMENT_ROW_TOKENS: Record<string, string[]> = {
  packingCharges: ["packing", "add packing charges", "packing charges", "packing & forwarding"],
  insuranceCharges: ["insurance", "add insurance", "insurance charges"],
  freightCharges: ["freight", "add freight", "ocean freight", "air freight"],
  discount: ["discount", "less discount", "trade discount", "rebate"],
  otherCharges: ["other charges", "misc charges", "handling charges"],
};

// --------------------------------------------------------------------------
const NORM_SYNONYMS = new Map<LabelSpec, string[]>();
for (const spec of LABEL_SPECS) {
  NORM_SYNONYMS.set(spec, spec.synonyms.map(normLabel).filter(Boolean));
}

/** Every recognised label word — a value scan must never swallow the next label. */
export const STOP_LABELS: Set<string> = (() => {
  const out = new Set<string>();
  for (const list of NORM_SYNONYMS.values()) list.forEach((s) => out.add(s));
  for (const tokens of Object.values(ITEM_HEADER_TOKENS)) {
    tokens.forEach((t) => { const n = normLabel(t); if (n) out.add(n); });
  }
  TOTAL_ROW_TOKENS.forEach((t) => { const n = normLabel(t); if (n) out.add(n); });
  for (const tokens of Object.values(ADJUSTMENT_ROW_TOKENS)) {
    tokens.forEach((t) => { const n = normLabel(t); if (n) out.add(n); });
  }
  return out;
})();

/** Return the best LabelSpec whose synonym matches this cell's text. */
export function matchLabel(text: string): LabelSpec | null {
  const n = normLabel(text);
  if (!n || n.length > 80) return null;
  let best: LabelSpec | null = null;
  let bestLen = -1;
  for (const spec of LABEL_SPECS) {
    for (const syn of NORM_SYNONYMS.get(spec) ?? []) {
      const hit = spec.exact ? n === syn : n === syn || n.startsWith(syn);
      if (hit && syn.length > bestLen) {
        best = spec;
        bestLen = syn.length;
      } else if (!spec.exact && n.includes(syn) && n.length <= syn.length + 6 && syn.length > bestLen) {
        best = spec;
        bestLen = syn.length;
      }
    }
  }
  return best;
}

/**
 * Classify a product-table column header. Exact or prefix match only — a reverse
 * match ("Unit" -> "unit price") mis-classifies sub-headers.
 */
export function classifyItemHeader(text: string): string | null {
  const n = normLabel(text);
  if (!n) return null;
  let best: string | null = null;
  let bestLen = -1;
  for (const [key, tokens] of Object.entries(ITEM_HEADER_TOKENS)) {
    for (const token of tokens) {
      const tn = normLabel(token);
      if (!tn) continue;
      if ((n === tn || n.startsWith(tn)) && tn.length > bestLen) {
        best = key;
        bestLen = tn.length;
      }
    }
  }
  return best;
}

export function classifyAdjustment(text: string): string | null {
  const n = normLabel(text);
  if (!n) return null;
  for (const [key, tokens] of Object.entries(ADJUSTMENT_ROW_TOKENS)) {
    for (const token of tokens) {
      const tn = normLabel(token);
      if (tn && n.includes(tn)) return key;
    }
  }
  return null;
}

export function isTotalRow(text: string): boolean {
  const n = normLabel(text);
  if (!n) return false;
  return TOTAL_ROW_TOKENS.some((t) => n.startsWith(normLabel(t)));
}

export function isInlineCell(text: string): boolean {
  return INLINE_SPECS.some((spec) => spec.pattern.test(text));
}
