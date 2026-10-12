/** Parsing helpers shared by every extractor. Pure functions, no business rules. */

// ---------------------------------------------------------------- text
const WS_RE = /\s+/g;
const PUNCT_RE = /[\s.:\-_/\\,*#()[\]]+/g;

export function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isNaN(value)) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    // ExcelJS rich text / formula cells
    const obj = value as Record<string, unknown>;
    if ("result" in obj) return clean(obj.result);
    if ("richText" in obj && Array.isArray(obj.richText)) {
      return clean((obj.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join(""));
    }
    if ("text" in obj) return clean(obj.text);
    if ("error" in obj) return "";
  }
  return String(value).replace(/ /g, " ").replace(/​/g, "").replace(WS_RE, " ").trim();
}

export function normLabel(value: unknown): string {
  return clean(value).toLowerCase().replace(PUNCT_RE, "");
}

export function isBlank(value: unknown): boolean {
  return clean(value) === "";
}

// ---------------------------------------------------------------- numbers
const CURRENCY_PREFIX_RE = /^(?:[A-Z]{3}|US\$|RS\.?|[$€£₹])\s*/i;
const NUM_SCAN_RE = /[-+]?\(?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?|[-+]?\(?\d+(?:\.\d+)?\)?/;

/**
 * Parse a spreadsheet / PDF numeric value. Strict on purpose: text such as
 * "Container No. MSNU 1968136" must NOT come back as 0.1968136.
 */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return null;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("result" in obj) return toNumber(obj.result);
  }
  let s = clean(value).replace(/−/g, "-");
  if (!s) return null;
  s = s.replace(CURRENCY_PREFIX_RE, "").trim();
  s = s.replace(/\s*%$/, "");
  const negative = s.startsWith("(") && s.endsWith(")");
  if (negative) s = s.slice(1, -1).trim();
  s = s.replace(/,/g, "").replace(/\s/g, "");
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function firstNumber(value: unknown): number | null {
  const s = clean(value);
  const m = NUM_SCAN_RE.exec(s);
  return m ? toNumber(m[0]) : null;
}

export function looksNumeric(value: unknown): boolean {
  if (typeof value === "number") return true;
  const s = clean(value);
  if (!s) return false;
  return /^[-+]?\(?[\d,\s]*\.?\d+\)?%?$/.test(s);
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------- dates
const MONTHS: Record<string, number> = {};
[
  ["jan", "january"],
  ["feb", "february"],
  ["mar", "march"],
  ["apr", "april"],
  ["may", "may"],
  ["jun", "june"],
  ["jul", "july"],
  ["aug", "august"],
  ["sep", "september"],
  ["oct", "october"],
  ["nov", "november"],
  ["dec", "december"],
].forEach((names, i) => names.forEach((n) => (MONTHS[n] = i + 1)));

const DMY_RE = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/;
const YMD_RE = /\b(\d{4})[./-](\d{1,2})[./-](\d{1,2})\b/;
const D_MON_Y_RE = /\b(\d{1,2})[\s-]([A-Za-z]{3,9})[\s\-,]+(\d{2,4})\b/;
const MON_D_Y_RE = /\b([A-Za-z]{3,9})[\s-](\d{1,2})[\s\-,]+(\d{2,4})\b/;

function fullYear(y: number): number {
  if (y < 100) return y < 70 ? 2000 + y : 1900 + y;
  return y;
}

function makeIso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Parse a date to an ISO yyyy-mm-dd string. Ambiguous d/m vs m/d is resolved by
 * `dayFirst`, unless one component is > 12, which settles it unambiguously.
 */
export function toIsoDate(value: unknown, dayFirst = true): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("result" in obj) return toIsoDate(obj.result, dayFirst);
  }
  const s = clean(value);
  if (!s) return null;

  let m = YMD_RE.exec(s);
  if (m) return makeIso(Number(m[1]), Number(m[2]), Number(m[3]));

  m = DMY_RE.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(Number(m[3]));
    let d: number;
    let mo: number;
    if (a > 12 && b <= 12) [d, mo] = [a, b];
    else if (b > 12 && a <= 12) [d, mo] = [b, a];
    else [d, mo] = dayFirst ? [a, b] : [b, a];
    return makeIso(y, mo, d);
  }

  m = D_MON_Y_RE.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) {
    return makeIso(fullYear(Number(m[3])), MONTHS[m[2].toLowerCase()], Number(m[1]));
  }

  m = MON_D_Y_RE.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return makeIso(fullYear(Number(m[3])), MONTHS[m[1].toLowerCase()], Number(m[2]));
  }
  return null;
}

/** True when a textual date could be read as either d/m/y or m/d/y. */
export function dateIsAmbiguous(value: unknown): boolean {
  const s = clean(value);
  const m = DMY_RE.exec(s);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a <= 12 && b <= 12 && a !== b;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getUTCDate()).padStart(2, "0")}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- currency
export const CURRENCY_ALIASES: Record<string, string> = {
  usd: "USD",
  usdollar: "USD",
  usdollars: "USD",
  unitedstatesdollar: "USD",
  $: "USD",
  us$: "USD",
  eur: "EUR",
  euro: "EUR",
  euros: "EUR",
  "€": "EUR",
  gbp: "GBP",
  poundsterling: "GBP",
  "£": "GBP",
  inr: "INR",
  rs: "INR",
  rupees: "INR",
  indianrupee: "INR",
  indianrupees: "INR",
  "₹": "INR",
  aed: "AED",
  dirham: "AED",
  aud: "AUD",
  cad: "CAD",
  canadiandollar: "CAD",
  sgd: "SGD",
  jpy: "JPY",
  chf: "CHF",
  nzd: "NZD",
  zar: "ZAR",
  sar: "SAR",
  qar: "QAR",
  kwd: "KWD",
};

const CURRENCY_CODE_RE =
  /\b(USD|EUR|GBP|INR|AED|AUD|CAD|SGD|JPY|CHF|NZD|ZAR|SAR|QAR|KWD|HKD|CNY|SEK|NOK|DKK)\b/;

export function toCurrencyCode(value: unknown): string | null {
  const s = clean(value);
  if (!s) return null;
  const m = CURRENCY_CODE_RE.exec(s.toUpperCase());
  if (m) return m[1];
  const key = s.toLowerCase().replace(/[^a-z$€£₹]/g, "");
  return CURRENCY_ALIASES[key] ?? null;
}

// ---------------------------------------------------------------- incoterms
const INCOTERM_RE = /\b(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP|DAT)\b/;
const INCOTERM_WORDS: Array<[string, string]> = [
  ["cost insurance and freight", "CIF"],
  ["carriage and insurance paid to", "CIP"],
  ["delivered at place unloaded", "DPU"],
  ["free alongside ship", "FAS"],
  ["delivered duty paid", "DDP"],
  ["delivered at place", "DAP"],
  ["carriage paid to", "CPT"],
  ["cost and freight", "CFR"],
  ["free on board", "FOB"],
  ["free carrier", "FCA"],
  ["ex works", "EXW"],
];

export function findIncoterm(value: unknown): { code: string | null; place: string | null } {
  const s = clean(value);
  if (!s) return { code: null, place: null };
  let code: string | null = null;
  const m = INCOTERM_RE.exec(s.toUpperCase());
  if (m) code = m[1];
  else {
    const low = s.toLowerCase();
    for (const [phrase, c] of INCOTERM_WORDS) {
      if (low.includes(phrase)) {
        code = c;
        break;
      }
    }
  }
  if (!code) return { code: null, place: null };
  let place: string | null = null;
  const idx = s.search(/[-–:,]/);
  if (idx >= 0) {
    const tail = clean(s.slice(idx + 1)).replace(/^\(|\)$/g, "").trim();
    if (tail) place = tail;
  }
  return { code, place: place || null };
}

// ---------------------------------------------------------------- identifiers
export const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z0-9]Z[A-Z0-9])\b/;
export const CONTAINER_RE = /\b([A-Z]{4}\s?\d{7})\b/;
const PHONE_HINT_RE = /^(tel|telephone|phone|ph|t|p|m|mob|mobile|fax|f|e|email|e-?mail|a\.?e)\b\s*[:.-]?/i;

export function findGstin(value: unknown): string | null {
  const m = GSTIN_RE.exec(clean(value).toUpperCase().replace(/\s/g, ""));
  return m ? m[1] : null;
}

/**
 * An invoice number as it appears inside a cell that may also carry a label.
 *
 * Deliberately permissive about shape — invoice numbers differ per company — but
 * strict about noise: a bare number, a date or a plain word is not accepted, so
 * a receipt is never posted against something that merely looked like a
 * reference. Used when reading payment advices, where the invoice is named in a
 * column of free text.
 */
export function findInvoiceNoLike(value: unknown): string | null {
  const s = clean(value);
  if (!s) return null;

  // strip a leading label: "Invoice No. PESPL/2889" -> "PESPL/2889"
  const withoutLabel = s.replace(
    /^\s*(?:against\s+)?(?:inv(?:oice)?|bill|doc(?:ument)?)\s*(?:no\.?|number|#|ref\.?)?\s*[:\-–]?\s*/i,
    "",
  );

  for (const token of withoutLabel.split(/[\s,;]+/)) {
    const t = token.replace(/^[([{]+|[)\]}.,;:]+$/g, "");
    if (!t || t.length < 3 || t.length > 40) continue;
    if (toIsoDate(t)) continue; // a date is not an invoice number
    if (/^\d+(?:\.\d+)?$/.test(t)) continue; // a bare amount is not one either
    // needs a letter, or a separator holding digits together (2026/1183)
    if (/[A-Za-z]/.test(t) && /[A-Za-z0-9]/.test(t)) return t;
    if (/^\d+[/\-]\d+/.test(t)) return t;
  }
  return null;
}

export function findContainer(value: unknown): string | null {
  const m = CONTAINER_RE.exec(clean(value).toUpperCase());
  return m ? m[1].replace(/\s/g, "") : null;
}

export function isContactLine(value: unknown): boolean {
  const s = clean(value);
  if (!s) return false;
  if (PHONE_HINT_RE.test(s)) return true;
  if (s.includes("@")) return true;
  const digits = (s.match(/\d/g) ?? []).length;
  return digits >= 7 && digits / Math.max(s.length, 1) > 0.4;
}

// ---------------------------------------------------------------- countries
const COUNTRY_LIST = [
  "AFGHANISTAN","ALBANIA","ALGERIA","ANDORRA","ANGOLA","ARGENTINA","ARMENIA","ARUBA","AUSTRALIA",
  "AUSTRIA","AZERBAIJAN","BAHAMAS","BAHRAIN","BANGLADESH","BARBADOS","BELARUS","BELGIUM","BELIZE",
  "BENIN","BERMUDA","BHUTAN","BOLIVIA","BOSNIA AND HERZEGOVINA","BOTSWANA","BRAZIL","BRUNEI",
  "BULGARIA","BURKINA FASO","BURUNDI","CAMBODIA","CAMEROON","CANADA","CAPE VERDE","CHAD","CHILE",
  "CHINA","COLOMBIA","CONGO","COSTA RICA","CROATIA","CUBA","CYPRUS","CZECH REPUBLIC","CZECHIA",
  "DENMARK","DJIBOUTI","DOMINICAN REPUBLIC","ECUADOR","EGYPT","EL SALVADOR","ESTONIA","ESWATINI",
  "ETHIOPIA","FIJI","FINLAND","FRANCE","GABON","GAMBIA","GEORGIA","GERMANY","GHANA","GREECE",
  "GUATEMALA","GUINEA","GUYANA","HAITI","HONDURAS","HONG KONG","HUNGARY","ICELAND","INDIA",
  "INDONESIA","IRAN","IRAQ","IRELAND","ISRAEL","ITALY","IVORY COAST","JAMAICA","JAPAN","JORDAN",
  "KAZAKHSTAN","KENYA","KUWAIT","KYRGYZSTAN","LAOS","LATVIA","LEBANON","LESOTHO","LIBERIA","LIBYA",
  "LIECHTENSTEIN","LITHUANIA","LUXEMBOURG","MACAU","MADAGASCAR","MALAWI","MALAYSIA","MALDIVES",
  "MALI","MALTA","MAURITANIA","MAURITIUS","MEXICO","MOLDOVA","MONACO","MONGOLIA","MONTENEGRO",
  "MOROCCO","MOZAMBIQUE","MYANMAR","NAMIBIA","NEPAL","NETHERLANDS","NEW ZEALAND","NICARAGUA",
  "NIGER","NIGERIA","NORTH MACEDONIA","NORWAY","OMAN","PAKISTAN","PALESTINE","PANAMA",
  "PAPUA NEW GUINEA","PARAGUAY","PERU","PHILIPPINES","POLAND","PORTUGAL","PUERTO RICO","QATAR",
  "ROMANIA","RUSSIA","RUSSIAN FEDERATION","RWANDA","SAUDI ARABIA","SENEGAL","SERBIA","SEYCHELLES",
  "SIERRA LEONE","SINGAPORE","SLOVAKIA","SLOVENIA","SOMALIA","SOUTH AFRICA","SOUTH KOREA","KOREA",
  "SPAIN","SRI LANKA","SUDAN","SURINAME","SWEDEN","SWITZERLAND","SYRIA","TAIWAN","TAJIKISTAN",
  "TANZANIA","THAILAND","TOGO","TRINIDAD AND TOBAGO","TUNISIA","TURKEY","TURKIYE","TURKMENISTAN",
  "UGANDA","UKRAINE","UNITED ARAB EMIRATES","UAE","UNITED KINGDOM","UK","GREAT BRITAIN",
  "UNITED STATES","UNITED STATES OF AMERICA","USA","U.S.A","US","URUGUAY","UZBEKISTAN","VENEZUELA",
  "VIETNAM","VIET NAM","YEMEN","ZAMBIA","ZIMBABWE",
];
const COUNTRIES = new Set(COUNTRY_LIST);
const COUNTRY_CANON: Record<string, string> = {
  UAE: "UNITED ARAB EMIRATES",
  UK: "UNITED KINGDOM",
  "GREAT BRITAIN": "UNITED KINGDOM",
  USA: "UNITED STATES OF AMERICA",
  US: "UNITED STATES OF AMERICA",
  "U.S.A": "UNITED STATES OF AMERICA",
  "UNITED STATES": "UNITED STATES OF AMERICA",
  KOREA: "SOUTH KOREA",
  "RUSSIAN FEDERATION": "RUSSIA",
  "VIET NAM": "VIETNAM",
  CZECHIA: "CZECH REPUBLIC",
  TURKIYE: "TURKEY",
};

/** Return a canonical country name if the text *is* (or ends with) a country. */
export function findCountry(value: unknown): string | null {
  const s = clean(value).toUpperCase().replace(/^[\s.,]+|[\s.,]+$/g, "");
  if (!s) return null;
  if (COUNTRIES.has(s)) return COUNTRY_CANON[s] ?? s;
  const parts = s.split(",");
  const tail = clean(parts[parts.length - 1]).replace(/^[\s.]+|[\s.]+$/g, "");
  if (COUNTRIES.has(tail)) return COUNTRY_CANON[tail] ?? tail;
  return null;
}

// ---------------------------------------------------------------- weights
export function weightWithUnit(value: unknown): { amount: number | null; unit: string | null } {
  const s = clean(value);
  if (!s) return { amount: null, unit: null };
  const n = firstNumber(s);
  if (n === null) return { amount: null, unit: null };
  const m = /(?:\d|\s)\s*(MT|KGS?|KILOGRAMS?|TONS?|TONNES?|LBS?|CBM)\b/.exec(s.toUpperCase());
  return { amount: n, unit: m ? m[1] : null };
}

// ---------------------------------------------------------------- columns
export function columnLetter(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || "A";
}

export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
