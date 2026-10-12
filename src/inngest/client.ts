import { Inngest } from "inngest";

/** Event names this sub-ERP publishes. Kept in one place so jobs and senders agree. */
export const EVENTS = {
  rulesChanged: "accounts/rules.changed",
  reextractInvoice: "accounts/invoice.reextract",
  reextractAll: "accounts/invoices.reextract-all",
} as const;

export interface RulesChangedData {
  ruleId?: string;
  by?: string;
}

export interface ReextractInvoiceData {
  invoiceId: string;
}

export interface ReextractAllData {
  by?: string;
}

export const inngest = new Inngest({ id: "pacific-accounts-erp" });
