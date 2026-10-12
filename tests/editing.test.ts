/**
 * Every field is editable — checked, not claimed.
 *
 * "You can edit any field" is the kind of promise that is true the day it is
 * written and quietly false three columns later. So it is not left to prose:
 *
 * 1. every editable column of every Payment Tracking table appears in a form
 *    group, or is named below as a deliberate exception with a reason;
 * 2. every field in the register's catalogue sits in a group the detail screen
 *    renders, so it gets an Edit box;
 * 3. every line-item field is on the line-item form;
 * 4. **every inline edit form posts every field its action writes.** This is the
 *    one that caught a real bug: the receipt row showed four fields of five and
 *    the save wrote `null` over the fifth, because "absent from the form" and
 *    "cleared by the user" are indistinguishable in a FormData unless somebody
 *    distinguishes them.
 *
 * These read the source files as text. That is deliberate: a test that imported
 * the components could only check the types, and what matters here is which
 * input names a form actually renders.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CATALOG, GROUPS } from "@/lib/extraction/catalog";
import {
  CUSTOMER_FIELDS,
  INVOICE_FIELD_GROUPS,
  NOTE_FIELDS,
  RECEIPT_FIELDS,
} from "@/lib/payments/form";
import { LINE_ITEM_FIELDS } from "@/lib/lineItemFields";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const SCHEMA = read("prisma/schema.prisma");

/** The columns of one Prisma model, excluding relations and ids. */
function columnsOf(model: string): string[] {
  const block = SCHEMA.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`));
  if (!block) throw new Error(`model ${model} not found`);

  const out: string[] = [];
  for (const line of block[1].split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("//") || text.startsWith("///") || text.startsWith("@@")) continue;
    const m = text.match(/^(\w+)\s+(\w+)(\[\])?(\?)?/);
    if (!m) continue;
    const [, name, type, list] = m;
    // relations and arrays are not fields on a form
    if (list) continue;
    if (/^Pt[A-Z]/.test(type) || /^(Invoice|PtCustomer|PtInvoice)$/.test(type)) continue;
    out.push(name);
  }
  return out;
}

const INVOICE_FORM_FIELDS = INVOICE_FIELD_GROUPS.flatMap((g) => g.fields.map(([k]) => k as string));

// --------------------------------------------------------------------------
describe("Payment Tracking: every column has a box on a form", () => {
  /**
   * The exceptions, each with the reason it is one. Anything not editable and
   * not listed here fails, which is the point: a new column is editable or it is
   * argued for.
   */
  const EXCEPT: Record<string, string> = {
    id: "the key",
    customerId: "set by the customer picker, not a text box",
    invoiceId: "the parent key",
    seq: "the receipt's number, assigned in order",
    createdAt: "when the row was made",
    updatedAt: "when the row last changed",
    source: "provenance: whether this came from an upload or was typed",
    sourceFile: "provenance: which file it came from",
    sourceRow: "provenance: which row of that file",
    sourceAsOn: "provenance: the position date of that sheet",
  };

  it("PtInvoice", () => {
    const missing = columnsOf("PtInvoice").filter(
      (c) => !INVOICE_FORM_FIELDS.includes(c) && !(c in EXCEPT),
    );
    expect(missing, `not editable and not excused: ${missing.join(", ")}`).toEqual([]);
  });

  it("PtReceipt", () => {
    const missing = columnsOf("PtReceipt").filter(
      (c) => !(RECEIPT_FIELDS as readonly string[]).includes(c) && !(c in EXCEPT),
    );
    expect(missing, `not editable and not excused: ${missing.join(", ")}`).toEqual([]);
  });

  it("PtNote", () => {
    const missing = columnsOf("PtNote").filter(
      (c) => !(NOTE_FIELDS as readonly string[]).includes(c) && !(c in EXCEPT),
    );
    expect(missing, `not editable and not excused: ${missing.join(", ")}`).toEqual([]);
  });

  it("PtCustomer", () => {
    const missing = columnsOf("PtCustomer").filter(
      (c) => !(CUSTOMER_FIELDS as readonly string[]).includes(c) && !(c in EXCEPT),
    );
    expect(missing, `not editable and not excused: ${missing.join(", ")}`).toEqual([]);
  });

  it("the invoice form covers both halves of the brief's example", () => {
    // "25 fields, a sheet fills 13, fill the other 12 in later" — the point is
    // that the form offers all of them, not that a particular 13 arrived
    expect(INVOICE_FORM_FIELDS.length).toBeGreaterThanOrEqual(23);
    for (const key of ["invoiceNo", "blDate", "docsPresentedDate", "booksBalance", "poNo"]) {
      expect(INVOICE_FORM_FIELDS, key).toContain(key);
    }
  });
});

// --------------------------------------------------------------------------
describe("Payment Tracking: a form can only change what it showed", () => {
  const invoiceScreen = read("src/app/(app)/payment-tracking/invoice/[id]/page.tsx");
  const customerScreen = read("src/app/(app)/payment-tracking/customer/[id]/page.tsx");
  const actions = read("src/server/payments/actions.ts");

  /** The input names one form element contains. */
  function inputsIn(source: string, formStart: number): Set<string> {
    // from the opening <form to its matching close, which is enough for these
    // forms: none of them nests another
    const end = source.indexOf("</form>", formStart);
    const block = source.slice(formStart, end === -1 ? source.length : end);
    return new Set([...block.matchAll(/name="([\w.]+)"/g)].map((m) => m[1]));
  }

  function formsCalling(source: string, action: string): Array<Set<string>> {
    const out: Array<Set<string>> = [];
    const needle = `action={${action}}`;
    let at = source.indexOf(needle);
    while (at !== -1) {
      const open = source.lastIndexOf("<form", at);
      out.push(inputsIn(source, open));
      at = source.indexOf(needle, at + 1);
    }
    return out;
  }

  it("every receipt form offers all five receipt fields", () => {
    const forms = formsCalling(invoiceScreen, "saveReceiptAction");
    expect(forms.length).toBeGreaterThanOrEqual(2); // the inline row and Add receipt
    for (const [i, inputs] of forms.entries()) {
      for (const field of RECEIPT_FIELDS) {
        expect(inputs, `receipt form ${i} is missing ${field}`).toContain(field);
      }
    }
  });

  it("every note form offers all five note fields", () => {
    const forms = formsCalling(invoiceScreen, "saveNoteAction");
    expect(forms.length).toBeGreaterThanOrEqual(2); // the inline row and Add note
    for (const [i, inputs] of forms.entries()) {
      for (const field of NOTE_FIELDS) {
        expect(inputs, `note form ${i} is missing ${field}`).toContain(field);
      }
    }
  });

  it("the customer form offers every customer field", () => {
    const [inputs] = formsCalling(customerScreen, "saveCustomerAction");
    for (const field of CUSTOMER_FIELDS) {
      expect(inputs, `customer form is missing ${field}`).toContain(field);
    }
  });

  it("the save path reads only the fields the form carried", () => {
    // the mechanism that makes the above safe rather than merely tidy
    expect(actions).toContain("offeredIn");
    expect(actions).toContain("onlyOffered");
    expect(actions).toMatch(/function fieldsFrom/);
  });

  it("no input anywhere in the section is marked required", () => {
    for (const file of [
      "src/app/(app)/payment-tracking/invoice/[id]/page.tsx",
      "src/app/(app)/payment-tracking/customer/[id]/page.tsx",
      "src/app/(app)/payment-tracking/new/page.tsx",
      "src/components/tracking/bits.tsx",
      "src/components/tracking/Filters.tsx",
      "src/components/tracking/UploadForm.tsx",
    ]) {
      const tags = read(file).match(/<(input|select|textarea)\b[^>]*>/g) ?? [];
      const required = tags.filter((t) => /\brequired\b/.test(t));
      expect(required, `${file}: ${required.join(" ")}`).toEqual([]);
    }
  });
});

// --------------------------------------------------------------------------
describe("Payment Tracking: edits are recorded", () => {
  const actions = read("src/server/payments/actions.ts");

  it("every write records what it changed", () => {
    // each save and delete funnels through the audit helpers
    for (const fn of [
      "saveCustomerAction",
      "saveInvoiceAction",
      "saveReceiptAction",
      "deleteReceiptAction",
      "saveNoteAction",
      "deleteNoteAction",
    ]) {
      const at = actions.indexOf(`export async function ${fn}`);
      expect(at, fn).toBeGreaterThan(-1);
      const body = actions.slice(at, actions.indexOf("\n}", at));
      expect(body, `${fn} does not record its change`).toMatch(/recordEdits|recordCreation/);
    }
  });

  it("the history is read by both detail screens", () => {
    expect(read("src/app/(app)/payment-tracking/invoice/[id]/page.tsx")).toContain(
      "invoiceHistory",
    );
    expect(read("src/app/(app)/payment-tracking/customer/[id]/page.tsx")).toContain(
      "customerHistory",
    );
  });

  it("the correction history itself is not editable", () => {
    const panel = read("src/components/tracking/History.tsx");
    expect(panel).not.toMatch(/<input|<select|<textarea|action=\{/);
  });
});

// --------------------------------------------------------------------------
describe("the register: every catalogue field gets an Edit box", () => {
  const screen = read("src/app/(app)/invoices/[id]/page.tsx");

  it("every field's group is one the detail screen renders", () => {
    const rendered = new Set(GROUPS.map((g) => g.key));
    const orphans = CATALOG.filter((f) => !rendered.has(f.group)).map((f) => f.key);
    expect(orphans, `no group renders these: ${orphans.join(", ")}`).toEqual([]);
  });

  it("the screen renders a per-field edit form", () => {
    expect(screen).toContain("updateFieldAction");
    expect(screen).toMatch(/GROUPS\.map/);
    expect(screen).toMatch(/CATALOG\.filter/);
  });

  it("every catalogue field is reachable: 90-odd of them, in nine groups", () => {
    expect(CATALOG.length).toBeGreaterThan(80);
    expect(GROUPS.length).toBe(9);
  });
});

// --------------------------------------------------------------------------
describe("the register: receipts, notes and line items are editable", () => {
  const receipts = read("src/components/ReceiptsPanel.tsx");
  const notes = read("src/components/NotesPanel.tsx");
  const lines = read("src/components/LineItemsPanel.tsx");
  const receiptServer = read("src/server/receipts.ts");
  const actions = read("src/server/actions.ts");

  it("the receipt form carries remarks, so saving cannot wipe it", () => {
    expect(receipts).toContain('name="remarks"');
    for (const field of ["receiptDate", "amount", "exchangeRate", "bankRef", "remarks"]) {
      expect(receipts, field).toContain(`name="${field}"`);
    }
  });

  it("a receipt field the caller did not mention keeps its value", () => {
    expect(receiptServer).toMatch(/draft\.remarks === undefined/);
    expect(receiptServer).toMatch(/draft\.bankRef === undefined/);
    expect(receiptServer).toMatch(/draft\.exchangeRate === undefined/);
    expect(receiptServer).toMatch(/draft\.receiptDate === undefined/);
    // and the action only passes through what the form held
    expect(actions).toMatch(/formData\.has\("remarks"\)/);
  });

  it("a note can be changed in place, not only added and removed", () => {
    expect(notes).toContain('name="noteId"');
    expect(notes).toMatch(/setEditing/);
    expect(receiptServer).toMatch(/draft\.id\s*\?/);
  });

  it("the note form carries every note field", () => {
    for (const field of ["noteType", "noteNo", "noteDate", "amount", "reason"]) {
      expect(notes, field).toContain(`name="${field}"`);
    }
  });

  it("every line-item field is on the line-item form", () => {
    // the form renders one input per entry of LINE_ITEM_FIELDS and the action
    // reads the same list back, so the two cannot drift: a field added to the
    // list appears on the form and is saved, without either being edited
    expect(lines).toMatch(/LINE_ITEM_FIELDS\.map/);
    expect(lines).toContain("name={`li.${i}.${key}`}");
    expect(actions).toMatch(/for \(const \[key\] of LINE_ITEM_FIELDS\)/);
    expect(actions).toContain("`li.${i}.${key}`");
    // and the list really does hold all thirteen of a line item's fields
    expect(LINE_ITEM_FIELDS.map(([k]) => k)).toEqual([
      "description",
      "designColour",
      "thickness",
      "hsn",
      "quantity",
      "unit",
      "rate",
      "amount",
      "slabsPcs",
      "netWeight",
      "netWeightUnit",
      "marksNos",
      "packages",
    ]);
  });

  it("the line-item total is recalculated from the rows, not left as extracted", () => {
    const server = read("src/server/lineItems.ts");
    expect(server).toContain("lineItemsTotal");
    expect(server).toMatch(/FieldStatus\.CALCULATED/);
    expect(server).toContain("added up from the line items");
  });

  it("the line items are no longer a read-only table", () => {
    const screen = read("src/app/(app)/invoices/[id]/page.tsx");
    expect(screen).toContain("LineItemsPanel");
    expect(screen).not.toMatch(/\{lineItems\.map\(/);
  });
});

// --------------------------------------------------------------------------
describe("the customer register posts what its action reads", () => {
  const grid = read("src/components/tracking/CustomerRegister.tsx");
  const action = read("src/server/payments/registerActions.ts");

  it("addresses every cell by invoice, and receipts by number", () => {
    expect(grid).toContain("name={`inv.${i.id}.");
    expect(grid).toContain("name={`rcpt.${i.id}.${seq}.");
    expect(grid).toContain("name={`note.${i.id}.CREDIT.amount`}");
    expect(grid).toContain("name={`note.${i.id}.DEBIT.amount`}");
    expect(action).toMatch(/inv\.\$\{invoice\.id\}\.\$\{field\}|`inv\.\$\{invoice\.id\}/);
    expect(action).toMatch(/\^rcpt\\\./);
  });

  it("every invoice field the grid renders is one the action accepts", () => {
    const rendered = [...grid.matchAll(/name=\{`inv\.\$\{i\.id\}\.(\w+)`\}/g)].map((m) => m[1]);
    expect(rendered.length).toBeGreaterThan(4);
    const accepted = action.slice(
      action.indexOf("REGISTER_INVOICE_FIELDS = ["),
      action.indexOf("] as const", action.indexOf("REGISTER_INVOICE_FIELDS = [")),
    );
    for (const field of new Set(rendered)) {
      expect(accepted, `the action ignores inv.*.${field}`).toContain(`"${field}"`);
    }
  });

  it("every receipt field the grid renders is one the action accepts", () => {
    const rendered = [
      ...grid.matchAll(/name=\{`rcpt\.\$\{i\.id\}\.\$\{seq\}\.(\w+)`\}/g),
    ].map((m) => m[1]);
    expect(rendered.length).toBeGreaterThan(2);
    const accepted = action.slice(
      action.indexOf("REGISTER_RECEIPT_FIELDS = ["),
      action.indexOf("] as const", action.indexOf("REGISTER_RECEIPT_FIELDS = [")),
    );
    for (const field of new Set(rendered)) {
      expect(accepted, `the action ignores rcpt.*.${field}`).toContain(`"${field}"`);
    }
  });

  it("only writes an id that belongs to the customer on the form", () => {
    expect(action).toMatch(/byId\.has\(invoiceId\)/);
    expect(action).toMatch(/where: \{ customerId \}/);
  });

  it("does not save an empty new receipt as a receipt of nothing", () => {
    expect(action).toMatch(/Object\.values\(data\)\.every\(\(v\) => v === null\)/);
  });

  it("leaves a cell the grid did not render alone", () => {
    expect(action).toMatch(/if \(!form\.has\(key\)\) continue/);
  });

  it("the derived columns have no input at all", () => {
    // Calc cells are shaded, read-only and carry no name — a typed total is a
    // total that can disagree with the figures it came from
    const calc = grid.slice(grid.indexOf("function Calc("), grid.indexOf("function Cell("));
    expect(calc).not.toContain("<input");
    expect(calc).not.toContain("name=");
  });

  it("marks no field required", () => {
    const tags = grid.match(/<(input|select|textarea)\b[^>]*>/g) ?? [];
    expect(tags.filter((t) => /\brequired\b/.test(t))).toEqual([]);
  });
});

// --------------------------------------------------------------------------
describe("currency formatting follows the currency", () => {
  it("no screen formats money with a hardcoded locale any more", () => {
    for (const file of [
      "src/components/tracking/bits.tsx",
      "src/components/tracking/Dashboard.tsx",
      "src/components/tracking/MasterTable.tsx",
      "src/components/tracking/CustomerRegister.tsx",
    ]) {
      expect(read(file), `${file} still hardcodes a locale`).not.toMatch(
        /toLocaleString\("en-IN"/,
      );
    }
  });

  it("every dashboard figure is given its currency", () => {
    const dash = read("src/components/tracking/Dashboard.tsx");
    const bare = [...dash.matchAll(/\bmoney\(([^),]*)\)/g)].map((m) => m[1].trim());
    expect(bare, `money() called without a currency: ${bare.join(", ")}`).toEqual([]);
  });

  it("home-currency figures use the home formatter, not the invoice's", () => {
    // forex gain/loss and every "home value" are rupee figures whatever the
    // invoice is denominated in, because the rate is rupees per unit
    const dash = read("src/components/tracking/Dashboard.tsx");
    expect(dash).toContain("homeMoney(Math.abs(k.forexGainLoss))");
    const table = read("src/components/tracking/MasterTable.tsx");
    expect(table).toContain("homeMoney(m.homeInvoiceValue)");
    expect(table).toContain("homeMoney(r.forexGainLoss)");
  });
});
