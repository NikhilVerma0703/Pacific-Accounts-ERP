/**
 * The shape of every form in Payment Tracking.
 *
 * In its own module because a `"use server"` file may only export async
 * functions, and the form that renders a field and the action that saves it need
 * the same list — one definition, so a field cannot be added to a form and
 * silently dropped on save, or be writable by an action no form ever shows.
 *
 * These lists are also what `tests/payment-editing.test.ts` checks the database
 * schema against: every column of `PtInvoice`, `PtReceipt`, `PtNote` and
 * `PtCustomer` must appear in one of them, or be named in that test's short list
 * of deliberate exceptions. That is how "every field is editable" stays true as
 * the schema grows, rather than being true on the day it was written.
 */

/** The fields the invoice form offers, grouped the way the form shows them. */
export const INVOICE_FIELD_GROUPS = [
  {
    title: "Invoice",
    hint: "",
    fields: [
      ["invoiceNo", "Invoice number", "text"],
      ["invoiceDate", "Invoice date", "date"],
      ["currency", "Currency", "text"],
      ["customerInvoiceValue", "Customer invoice value", "number"],
      ["customsInvoiceValue", "Customs value / as per books", "number"],
      ["exchangeRate", "Invoice exchange rate", "number"],
    ],
  },
  {
    title: "Parties",
    hint: "Left blank, these fall back to the customer record.",
    fields: [
      ["consignee", "Consignee", "text"],
      ["notifyParty", "Notify party", "text"],
      ["country", "Country", "text"],
    ],
  },
  {
    title: "Payment terms",
    hint: "An entered due date overrides the one calculated from the terms.",
    fields: [
      ["paymentTerms", "Payment terms", "text"],
      ["enteredDueDate", "Due date (if known)", "date"],
      ["docsPresentedDate", "Documents presented on", "date"],
    ],
  },
  {
    title: "Commercial & shipping",
    hint: "",
    fields: [
      ["piNo", "PI number", "text"],
      ["poNo", "PO number", "text"],
      ["shippingBillNo", "Shipping bill number", "text"],
      ["shippingBillDate", "Shipping bill date", "date"],
      ["blNo", "BL number", "text"],
      ["blDate", "BL date", "date"],
      ["containerNo", "Container number", "text"],
      ["eta", "ETA / arrival date", "date"],
    ],
  },
  {
    title: "Books & notes",
    hint: "",
    fields: [
      ["booksBalance", "Balance as per books", "number"],
      ["remarks", "Remarks", "text"],
      ["followUpNotes", "Follow-up notes", "text"],
    ],
  },
] as const;

/** One receipt's editable fields, in the order the inline row shows them. */
export const RECEIPT_FIELDS = [
  "receiptDate",
  "amountFcy",
  "exchangeRate",
  "bankRef",
  "remarks",
] as const;

/** One credit or debit note's editable fields. */
export const NOTE_FIELDS = ["noteType", "noteNo", "noteDate", "amount", "reason"] as const;

/** The customer record's editable fields. */
export const CUSTOMER_FIELDS = [
  "name",
  "country",
  "currency",
  "defaultPaymentTerms",
  "consignee",
  "notifyParty",
  "contact",
  "notes",
] as const;

export const NUMBER_FIELDS = new Set([
  "customerInvoiceValue",
  "customsInvoiceValue",
  "exchangeRate",
  "booksBalance",
  "amountFcy",
  "amount",
]);

export const DATE_FIELDS = new Set([
  "invoiceDate",
  "enteredDueDate",
  "docsPresentedDate",
  "shippingBillDate",
  "blDate",
  "eta",
  "receiptDate",
  "noteDate",
]);

/**
 * Every field's name as a person reads it.
 *
 * Used for the correction history, which stores the label alongside the change
 * so the history stays readable even after a label is reworded. Built from the
 * invoice groups so the two can never drift, with the receipt, note and customer
 * fields added on.
 */
export const INVOICE_LABELS: Record<string, string> = {
  ...Object.fromEntries(
    INVOICE_FIELD_GROUPS.flatMap((g) => g.fields.map(([key, label]) => [key, label])),
  ),
  customerId: "Customer",
  seq: "Receipt number",
  receiptDate: "Receipt date",
  amountFcy: "Receipt amount (FCY)",
  bankRef: "Bank reference",
  noteType: "Note type",
  noteNo: "Note number",
  noteDate: "Note date",
  amount: "Note amount",
  reason: "Reason",
  name: "Customer name",
  defaultPaymentTerms: "Default payment terms",
  contact: "Contact",
  notes: "Notes",
};
