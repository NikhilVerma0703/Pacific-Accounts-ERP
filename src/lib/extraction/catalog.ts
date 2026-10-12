/**
 * The canonical field catalogue.
 *
 * This is the single vocabulary the whole sub-ERP speaks. Extractors produce
 * these keys; the normalizer, the Accounts register and every future source
 * (e-Invoice, Tally, bank, CN/DN, shipping) map into the same keys.
 */

export type FieldGroup =
  | "invoice"
  | "parties"
  | "commercial"
  | "product"
  | "shipping"
  | "tax"
  | "financial"
  | "banking"
  | "derived";

/** Where a value is expected to come from — this is what lets the UI explain a blank. */
export type FieldOrigin =
  | "invoice"
  | "tally"
  | "eInvoice"
  | "bank"
  | "shipping"
  | "master"
  | "calculated";

export type FieldType = "string" | "number" | "date" | "currency";

export interface FieldDef {
  key: string;
  label: string;
  group: FieldGroup;
  type?: FieldType;
  /** Counted in the data-completeness score and blocks completion when missing. */
  critical?: boolean;
  /** Shown in the Accounts register by default. */
  accountsColumn?: boolean;
  origin?: FieldOrigin;
  note?: string;
}

export const GROUPS: Array<{ key: FieldGroup; label: string }> = [
  { key: "invoice", label: "Invoice" },
  { key: "parties", label: "Customer / Consignee / Notify" },
  { key: "commercial", label: "Commercial Terms" },
  { key: "product", label: "Product & Quantity" },
  { key: "shipping", label: "Export / Shipping" },
  { key: "tax", label: "Tax & Compliance" },
  { key: "financial", label: "Financial" },
  { key: "banking", label: "Banking" },
  { key: "derived", label: "Derived / Calculated" },
];

export const CATALOG: FieldDef[] = [
  // ---------------- invoice ----------------
  { key: "invoiceNo", label: "Invoice No.", group: "invoice", critical: true, accountsColumn: true },
  { key: "invoiceDate", label: "Invoice Date", group: "invoice", type: "date", critical: true, accountsColumn: true },
  { key: "invoiceType", label: "Invoice Type", group: "invoice", accountsColumn: true,
    note: "Export / Domestic — derived from destination and export documents" },
  { key: "financialYear", label: "Financial Year", group: "invoice" },
  { key: "invoiceTitle", label: "Document Title", group: "invoice" },

  // ---------------- parties ----------------
  { key: "exporterName", label: "Exporter / Seller", group: "parties" },
  { key: "exporterAddress", label: "Exporter Address", group: "parties" },
  { key: "customerName", label: "Customer / Buyer", group: "parties", critical: true, accountsColumn: true },
  { key: "customerAddress", label: "Customer Address", group: "parties" },
  { key: "customerCountry", label: "Customer Country", group: "parties", accountsColumn: true },
  { key: "customerContact", label: "Customer Contact", group: "parties" },
  { key: "consigneeName", label: "Consignee", group: "parties", accountsColumn: true },
  { key: "consigneeAddress", label: "Consignee Address", group: "parties" },
  { key: "consigneeCountry", label: "Consignee Country", group: "parties" },
  { key: "consigneeContact", label: "Consignee Contact", group: "parties" },
  { key: "notifyPartyName", label: "Notify Party", group: "parties", accountsColumn: true },
  { key: "notifyPartyAddress", label: "Notify Party Address", group: "parties" },
  { key: "notifyPartyCountry", label: "Notify Party Country", group: "parties" },
  { key: "notifyPartyContact", label: "Notify Party Contact", group: "parties" },
  { key: "customerCode", label: "Customer Code", group: "parties", accountsColumn: true, origin: "master",
    note: "Maintained in Tally / the customer master, not printed on the invoice" },
  { key: "salesPerson", label: "Sales Person", group: "parties", origin: "master",
    note: "Comes from the commercial team / customer master" },

  // ---------------- commercial ----------------
  { key: "poNo", label: "PO No.", group: "commercial", accountsColumn: true },
  { key: "poDate", label: "PO Date", group: "commercial", type: "date", accountsColumn: true },
  { key: "piNo", label: "PI / Sales Order Ref.", group: "commercial", accountsColumn: true },
  { key: "paymentTerms", label: "Payment Terms", group: "commercial", critical: true, accountsColumn: true },
  { key: "deliveryTerms", label: "Delivery Terms", group: "commercial" },
  { key: "incoterm", label: "Incoterm", group: "commercial", accountsColumn: true },
  { key: "incotermPlace", label: "Incoterm Place", group: "commercial" },
  { key: "currency", label: "Currency", group: "commercial", critical: true, accountsColumn: true },
  { key: "exchangeRate", label: "Exchange Rate", group: "commercial", type: "number", critical: true, accountsColumn: true },

  // ---------------- product ----------------
  { key: "productDescription", label: "Product", group: "product", accountsColumn: true },
  { key: "hsnCode", label: "HSN Code", group: "product", accountsColumn: true },
  { key: "totalQuantity", label: "Total Quantity", group: "product", type: "number", accountsColumn: true },
  { key: "quantityUnit", label: "Quantity Unit", group: "product", accountsColumn: true },
  { key: "totalSlabsPcs", label: "Total Slabs / Pcs", group: "product", type: "number", accountsColumn: true },
  { key: "netWeight", label: "Net Weight", group: "product", type: "number", accountsColumn: true },
  { key: "netWeightUnit", label: "Net Weight Unit", group: "product" },
  { key: "grossWeight", label: "Gross Weight", group: "product", type: "number", accountsColumn: true },
  { key: "grossWeightUnit", label: "Gross Weight Unit", group: "product" },
  { key: "packages", label: "No. of Packages", group: "product" },
  { key: "marksNos", label: "Marks & Nos", group: "product" },

  // ---------------- shipping ----------------
  { key: "countryOfOrigin", label: "Country of Origin", group: "shipping" },
  { key: "countryOfDestination", label: "Country of Final Destination", group: "shipping", accountsColumn: true },
  { key: "preCarriageBy", label: "Pre-Carriage By", group: "shipping" },
  { key: "placeOfReceipt", label: "Place of Receipt by Pre-Carrier", group: "shipping" },
  { key: "vesselFlightNo", label: "Vessel / Flight No.", group: "shipping", origin: "shipping",
    note: "Often blank at invoicing; confirmed by the shipping team" },
  { key: "portOfLoading", label: "Port of Loading", group: "shipping", accountsColumn: true },
  { key: "portOfDischarge", label: "Port of Discharge", group: "shipping", accountsColumn: true },
  { key: "finalDestination", label: "Final Destination", group: "shipping", accountsColumn: true },
  { key: "containerNo", label: "Container No.", group: "shipping", accountsColumn: true },
  { key: "vehicleNo", label: "Vehicle No.", group: "shipping" },
  { key: "esealNo", label: "E-Seal No.", group: "shipping" },
  { key: "linerOtlNo", label: "Liner's OTL No.", group: "shipping" },
  { key: "blNo", label: "BL No.", group: "shipping", accountsColumn: true, origin: "shipping",
    note: "Printed on the invoice but usually filled after shipment" },
  { key: "blDate", label: "BL Date", group: "shipping", type: "date", accountsColumn: true, origin: "shipping",
    note: "Comes with the Bill of Lading from the liner" },
  { key: "shippingBillNo", label: "Shipping Bill No.", group: "shipping", accountsColumn: true, origin: "shipping",
    note: "Printed on the invoice but filled after customs filing" },
  { key: "shippingBillDate", label: "Shipping Bill Date", group: "shipping", type: "date", accountsColumn: true,
    origin: "shipping", note: "Comes from the customs shipping bill" },
  { key: "eta", label: "ETA / Arrival Date", group: "shipping", type: "date", accountsColumn: true,
    origin: "shipping", note: "Comes from the shipping team / liner" },

  // ---------------- tax / compliance ----------------
  { key: "exporterGstin", label: "Exporter GSTIN", group: "tax" },
  { key: "customerGstin", label: "Customer GSTIN", group: "tax" },
  { key: "iecCode", label: "IEC Code", group: "tax" },
  { key: "lutNo", label: "LUT / ARN No.", group: "tax" },
  { key: "lutDate", label: "LUT Date", group: "tax", type: "date" },
  { key: "exportTaxTreatment", label: "Export Tax Treatment", group: "tax", accountsColumn: true,
    note: "Under LUT without IGST / With payment of IGST" },
  { key: "stateCode", label: "State Code", group: "tax" },
  { key: "irn", label: "IRN", group: "tax", origin: "eInvoice", note: "From the e-Invoice / IRP" },
  { key: "ackNo", label: "e-Invoice Ack No.", group: "tax", origin: "eInvoice", note: "From the e-Invoice / IRP" },
  { key: "ackDate", label: "e-Invoice Ack Date", group: "tax", type: "date", origin: "eInvoice",
    note: "From the e-Invoice / IRP" },
  { key: "eInvoiceStatus", label: "e-Invoice Status", group: "tax", origin: "eInvoice",
    note: "Generated / Cancelled / Not applicable — from the IRP" },
  { key: "ewayBillNo", label: "E-Way Bill No.", group: "tax", origin: "eInvoice", note: "From the e-Way Bill portal" },

  // ---------------- books (Tally) ----------------
  // Nothing here is ever filled from the commercial invoice. Until Tally is
  // connected these stay empty and say so, which is what keeps "as per books"
  // an independent figure rather than a copy of the invoice.
  { key: "booksValue", label: "Books Value (Tally)", group: "tax", type: "currency", origin: "tally",
    note: "The sales voucher value in Tally — the customs / books figure" },
  { key: "booksValueHome", label: "Books Value in Home Currency", group: "tax", type: "currency",
    origin: "tally", note: "The INR amount posted in Tally" },
  { key: "tallyVoucherNo", label: "Tally Voucher No.", group: "tax", origin: "tally",
    note: "The sales voucher this invoice was posted as" },
  { key: "tallyVoucherDate", label: "Tally Voucher Date", group: "tax", type: "date", origin: "tally",
    note: "The date the voucher was posted" },
  { key: "tallyLedger", label: "Tally Ledger", group: "tax", origin: "tally",
    note: "The customer ledger the voucher was posted against" },

  // ---------------- financial ----------------
  { key: "lineItemsTotal", label: "Sum of Line Items", group: "financial", type: "currency" },
  { key: "packingCharges", label: "Packing Charges", group: "financial", type: "currency" },
  { key: "insuranceCharges", label: "Insurance", group: "financial", type: "currency" },
  { key: "freightCharges", label: "Freight", group: "financial", type: "currency" },
  { key: "discount", label: "Discount", group: "financial", type: "currency" },
  { key: "taxableValue", label: "Taxable Value", group: "financial", type: "currency" },
  { key: "taxAmount", label: "Tax Amount", group: "financial", type: "currency" },
  { key: "invoiceValue", label: "Invoice Value", group: "financial", type: "currency", critical: true, accountsColumn: true },
  { key: "amountInWords", label: "Amount in Words", group: "financial" },

  // ---------------- banking ----------------
  { key: "bankName", label: "Bank", group: "banking", accountsColumn: true },
  { key: "bankAccountNo", label: "Bank A/c No.", group: "banking" },
  { key: "bankSwift", label: "SWIFT Code", group: "banking" },
  { key: "routingBank", label: "Routing / Correspondent Bank", group: "banking" },
  { key: "routingSwift", label: "Routing SWIFT", group: "banking" },
  { key: "adCode", label: "AD Code", group: "banking", accountsColumn: true },

  // ---------------- derived ----------------
  { key: "homeValue", label: "INR Value", group: "derived", type: "currency", accountsColumn: true,
    origin: "calculated", note: "Invoice Value x Exchange Rate" },
  { key: "dueDate", label: "Due Date", group: "derived", type: "date", accountsColumn: true,
    origin: "calculated", note: "Only calculated when a payment-term rule has been configured" },
];

export const BY_KEY: Record<string, FieldDef> = Object.fromEntries(
  CATALOG.map((f) => [f.key, f]),
);

export function labelOf(key: string): string {
  return BY_KEY[key]?.label ?? key;
}

export function originOf(key: string): FieldOrigin {
  return BY_KEY[key]?.origin ?? "invoice";
}

export function criticalKeys(): string[] {
  return CATALOG.filter((f) => f.critical).map((f) => f.key);
}

export function accountsColumnKeys(): string[] {
  return CATALOG.filter((f) => f.accountsColumn).map((f) => f.key);
}

export function fieldsInGroup(group: FieldGroup): FieldDef[] {
  return CATALOG.filter((f) => f.group === group);
}

export const ORIGIN_TEXT: Record<FieldOrigin, string> = {
  invoice: "is read from the commercial invoice",
  master: "will come from the customer master / Tally",
  tally: "will come from Tally",
  eInvoice: "will come from the e-Invoice / IRN",
  bank: "will come from the bank / payment data",
  shipping: "will come from the shipping team",
  calculated: "is calculated once its inputs are available",
};
