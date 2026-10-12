/**
 * End-to-end checks against the real company invoice.
 *
 * These assertions are the port of the reference implementation's test suite:
 * every value is compared with the actual cell on the document. Scenario 2 runs
 * a *modified copy* with a different party, ports, terms, HSN, amounts and rate,
 * which proves the reader reads the document rather than remembering this one.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { buildAccountsRow } from "@/lib/business/accounts";
import { BUYER_WHEN_NOT_NAMED, type PaymentTermRule } from "@/lib/business/rules";
import { EXTRACTION_VERSION, extractDocument } from "@/lib/extraction";
import { FieldStatus, type ExtractedField } from "@/lib/extraction/types";
import {
  fieldValue,
  normalize,
  normalizedFromJson,
  type NormalizedInvoice,
} from "@/lib/normalize/normalizer";
import { assess, blockers } from "@/lib/normalize/validators";
import { applyManualValue } from "@/server/ingest";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures");

async function run(file: string, name = file) {
  const buffer = await readFile(path.join(FIXTURES, file));
  const extraction = await extractDocument(buffer, name);
  const normalized = normalize(extraction);
  const quality = assess(normalized);
  return { extraction, normalized, quality };
}

function expectFields(n: NormalizedInvoice, expected: Record<string, string | number>) {
  for (const [key, want] of Object.entries(expected)) {
    expect(fieldValue(n, key), `field ${key}`).toBe(want);
  }
}

const ORIGINAL_EXPECTED: Record<string, string | number> = {
  invoiceNo: "PESPL/2889",
  invoiceDate: "2026-09-12",
  financialYear: "2026-27",
  exporterName: "Pacific Engineered Surfaces Private Limited",
  consigneeName: "Ciot Inc",
  consigneeCountry: "CANADA",
  notifyPartyName: "Naturoc Division DE Ciot",
  countryOfOrigin: "INDIA",
  countryOfDestination: "CANADA",
  paymentTerms: "100% Cash Against Documents (CAD)",
  deliveryTerms: "FREE ON BOARD-KATTUPALLI PORT",
  incoterm: "FOB",
  currency: "USD",
  exchangeRate: 93.55,
  invoiceValue: 18348.49,
  poNo: "PO-4069880",
  poDate: "2026-08-20",
  piNo: "PI-SAL-ORD/25-26/01653",
  preCarriageBy: "By Road",
  placeOfReceipt: "KATTUPALLI PORT, INDIA",
  portOfLoading: "KATTUPALLI PORT, INDIA",
  portOfDischarge: "MONTREAL, QC, CANADA",
  finalDestination: "MONTREAL, QC, CANADA",
  containerNo: "MSNU1968136",
  vehicleNo: "TN 03 AM 7699",
  esealNo: "ESST 0112 6369",
  hsnCode: "68101990",
  productDescription: "Artificial Quartz Slabs",
  quantityUnit: "SQMT",
  totalSlabsPcs: 247,
  netWeight: 23.5,
  grossWeight: 24,
  exporterGstin: "33AALCP2750N1Z3",
  iecCode: "AALCP2750N",
  lutNo: "AD330326017058D/2026-27",
  adCode: "0180038-8400009",
  bankName: "Kotak Mahindra Bank Limited",
  bankSwift: "KKBKINBBXXX",
  routingSwift: "IRVTUS3NXXX",
  bankAccountNo: "3214292773",
  invoiceType: "Export",
};

describe("commercial invoice extraction — Excel", () => {
  it("reads every value off the real invoice", async () => {
    const { normalized, quality } = await run("sample_invoice.xlsx", "invoice_dummy.xlsx");
    expectFields(normalized, ORIGINAL_EXPECTED);

    // blank-on-the-invoice fields must be MISSING, never invented
    for (const key of ["blNo", "shippingBillNo", "vesselFlightNo"]) {
      expect(fieldValue(normalized, key), key).toBeNull();
      expect(normalized.fields[key].status, key).toBe(FieldStatus.MISSING);
    }

    // totals are internally consistent
    expect(normalized.lineItems).toHaveLength(2);
    const itemsSum = Math.round(
      normalized.lineItems.reduce((a, li) => a + (li.amount ?? 0), 0) * 100,
    ) / 100;
    expect(itemsSum).toBe(18352.75);
    expect(Math.round((fieldValue(normalized, "discount") as number) * 100) / 100).toBe(-4.26);
    expect(Math.round((itemsSum + (fieldValue(normalized, "discount") as number)) * 100) / 100)
      .toBe(fieldValue(normalized, "invoiceValue"));

    // INR conversion is calculated, not read
    expect(fieldValue(normalized, "homeValue")).toBe(Math.round(18348.49 * 93.55 * 100) / 100);
    expect(normalized.fields.homeValue.status).toBe(FieldStatus.CALCULATED);

    // nothing is fabricated: any value must carry a source
    for (const [key, f] of Object.entries(normalized.fields)) {
      if (f.value !== null) expect(f.source, `${key} has a value but no source`).toBeTruthy();
    }

    expect(blockers(quality)).toHaveLength(0);
    expect(quality.criticalFound).toBe(quality.criticalTotal);
  });

  it("treats the notify party as the end buyer when no buyer is named", async () => {
    const { normalized } = await run("sample_invoice.xlsx");

    // the invoice's "Buyer if Not Consignee" block is empty…
    expect(BUYER_WHEN_NOT_NAMED).toBe("notifyParty");
    expect(fieldValue(normalized, "notifyPartyName")).toBe("Naturoc Division DE Ciot");
    expect(fieldValue(normalized, "consigneeName")).toBe("Ciot Inc");

    // …so the customer is the notify party, not the consignee
    expect(fieldValue(normalized, "customerName")).toBe("Naturoc Division DE Ciot");
    expect(normalized.fields.customerName.status).toBe(FieldStatus.CALCULATED);
    expect(normalized.fields.customerName.note).toContain("notify party");
    expect(normalized.fields.customerName.note).toContain("end buyer");
    // the company has stated this, so it is not queued for confirmation
    expect(normalized.fields.customerName.note).not.toMatch(/please confirm/i);

    // address, country and contact all travel with that same party — nothing is
    // borrowed from the consignee, and none of it is flagged
    for (const [target, from] of [
      ["customerAddress", "notifyPartyAddress"],
      ["customerCountry", "notifyPartyCountry"],
      ["customerContact", "notifyPartyContact"],
    ]) {
      expect(fieldValue(normalized, target), target).toBe(fieldValue(normalized, from));
      expect(normalized.fields[target].status, target).toBe(FieldStatus.CALCULATED);
      expect(normalized.fields[target].note, target).toContain("notify party");
    }
    expect(fieldValue(normalized, "customerCountry")).toBe("CANADA");
    expect(fieldValue(normalized, "customerContact")).toContain("514 389 6540");
    // the phone is its own field now, so it is not left sitting in the address
    expect(fieldValue(normalized, "notifyPartyAddress")).not.toContain("Tel:");
  });

  it("recovers the contact from an address stored before it had its own field", async () => {
    const { normalized } = await run("sample_invoice.xlsx");
    const stored = JSON.parse(JSON.stringify(normalized.fields)) as Record<string, ExtractedField>;

    // the old shape: phone and country folded into the notify address, no
    // notifyPartyContact at all, and a customer contact left over from the
    // consignee with the old "please confirm" flag
    stored.notifyPartyAddress = {
      ...stored.notifyPartyAddress,
      value: "9225 Boul Saint- Laurent, Montreal, QC H2N 1N2, Canada, Tel: 514 389 6540",
    };
    stored.notifyPartyContact = { ...stored.notifyPartyContact, value: null };
    stored.notifyPartyCountry = { ...stored.notifyPartyCountry, value: null };
    stored.customerContact = {
      key: "customerContact",
      value: "Tel: 000 000 0000",
      status: FieldStatus.NEEDS_VERIFICATION,
      source: "Invoice!A12+",
      confidence: 0.6,
      note: "Taken from the consignee block.",
    };

    const reloaded = normalizedFromJson(stored, normalized.lineItems, normalized.warnings);

    expect(fieldValue(reloaded, "customerContact")).toBe("Tel: 514 389 6540");
    expect(reloaded.fields.customerContact.status).toBe(FieldStatus.CALCULATED);
    expect(fieldValue(reloaded, "customerCountry")).toBe("CANADA");
  });

  it("blanks a carried-over field rather than keeping another party's value", async () => {
    const { normalized } = await run("sample_invoice.xlsx");
    const stored = JSON.parse(JSON.stringify(normalized.fields)) as Record<string, ExtractedField>;

    // a notify party with no contact anywhere, and a stale consignee contact
    stored.notifyPartyAddress = { ...stored.notifyPartyAddress, value: "Some Street, Montreal" };
    stored.notifyPartyContact = { ...stored.notifyPartyContact, value: null };
    stored.customerContact = {
      key: "customerContact",
      value: "Tel: 514 389 6540",
      status: FieldStatus.NEEDS_VERIFICATION,
      source: "Invoice!A12+",
      confidence: 0.6,
      note: "Taken from the consignee block.",
    };

    const reloaded = normalizedFromJson(stored, normalized.lineItems, normalized.warnings);

    expect(fieldValue(reloaded, "customerContact")).toBeNull();
    expect(reloaded.fields.customerContact.status).toBe(FieldStatus.MISSING);
    expect(reloaded.fields.customerContact.note).toContain("notify party");
  });

  it("corrects an invoice stored under the old rule, without re-reading the file", async () => {
    const { normalized } = await run("sample_invoice.xlsx");

    // exactly what the database held before the rule changed
    const stored = JSON.parse(JSON.stringify(normalized.fields)) as Record<string, ExtractedField>;
    stored.customerName = {
      key: "customerName",
      value: "Ciot Inc",
      status: FieldStatus.NEEDS_VERIFICATION,
      source: "Invoice!A12+",
      confidence: 0.6,
      note: "The invoice does not name a separate buyer, so the consignee was used as the customer. Please confirm.",
    };
    stored.customerAddress = { ...stored.customerAddress, value: "9225 Boul Saint- Laurent" };

    const reloaded = normalizedFromJson(stored, normalized.lineItems, normalized.warnings);

    expect(fieldValue(reloaded, "customerName")).toBe("Naturoc Division DE Ciot");
    expect(reloaded.fields.customerName.status).toBe(FieldStatus.CALCULATED);
    expect(reloaded.fields.customerName.note).not.toMatch(/please confirm/i);
    expect(reloaded.fields.customerName.note).not.toMatch(/consignee was used/i);
    expect(assess(reloaded).issues.some((i) => i.key === "customerName")).toBe(false);
  });

  it("never overwrites a customer that was entered by hand", async () => {
    const { normalized } = await run("sample_invoice.xlsx");
    const stored = JSON.parse(JSON.stringify(normalized.fields)) as Record<string, ExtractedField>;
    stored.customerName = {
      key: "customerName",
      value: "Someone Accounts typed in",
      status: FieldStatus.EXTRACTED,
      source: "entered by Accounts",
      confidence: 1,
      note: "Entered manually.",
    };

    const reloaded = normalizedFromJson(stored, normalized.lineItems, normalized.warnings);
    expect(fieldValue(reloaded, "customerName")).toBe("Someone Accounts typed in");
  });

  it("does not calculate a due date without a configured rule", async () => {
    const { normalized, quality } = await run("sample_invoice.xlsx");
    const row = buildAccountsRow(normalized, quality, { rules: [] });
    expect(row.dueDate.value).toBeNull();
    expect(row.dueDate.note?.toLowerCase()).toContain("no due-date rule");
    expect(row.customerInvoiceValue.value).toBe(18348.49);
    expect(row.customsInvoiceValue.status).toBe(FieldStatus.NOT_PRESENT);
  });

  it("calculates the due date once a rule exists", async () => {
    const { normalized, quality } = await run("sample_invoice.xlsx");
    const rule: PaymentTermRule = {
      label: "CAD 30",
      pattern: "Cash Against Documents",
      creditDays: 30,
      basis: "INVOICE_DATE",
    };
    const row = buildAccountsRow(normalized, quality, { rules: [rule], today: "2026-09-15" });
    expect(row.dueDate.value).toBe("2026-10-12");
    expect(row.overdueDays.value).toBe(0);

    const later = buildAccountsRow(normalized, quality, { rules: [rule], today: "2026-11-01" });
    expect(later.overdueDays.value).toBe(20);
    expect(["OVERDUE", "MISSING_INFORMATION"]).toContain(later.status.value);
  });
});

describe("re-reading an invoice the reader has since improved on", () => {
  it("recovers a value the older reader discarded", async () => {
    // version 1 read the notify block but had nowhere to put a phone or a
    // country, so both were thrown away. Version 2 keeps them — and because the
    // uploaded file is stored, the invoice can simply be read again.
    const { normalized } = await run("sample_invoice.xlsx");

    expect(EXTRACTION_VERSION).toBeGreaterThan(1);
    expect(fieldValue(normalized, "notifyPartyContact")).toBe("Tel: 514 389 6540");
    expect(fieldValue(normalized, "notifyPartyCountry")).toBe("CANADA");
    expect(normalized.fields.notifyPartyContact.status).toBe(FieldStatus.EXTRACTED);
    expect(normalized.fields.notifyPartyContact.source).toBeTruthy();
  });

  it("puts manual corrections back on top of the fresh read", async () => {
    const { normalized } = await run("sample_invoice.xlsx");
    const fields = JSON.parse(JSON.stringify(normalized.fields)) as Record<string, ExtractedField>;

    // what reextractInvoice does after re-reading the file
    applyManualValue(fields, "blNo", "MEDUX1234567", "Accounts");
    applyManualValue(fields, "invoiceValue", "18,400.00", "Accounts");

    expect(fields.blNo.value).toBe("MEDUX1234567");
    expect(fields.blNo.status).toBe(FieldStatus.EXTRACTED);
    expect(fields.blNo.source).toBe("entered by Accounts");
    expect(fields.invoiceValue.value).toBe(18400);

    // and a corrected field is never re-derived away
    const reloaded = normalizedFromJson(fields, normalized.lineItems, normalized.warnings);
    expect(fieldValue(reloaded, "blNo")).toBe("MEDUX1234567");
  });
});

describe("the reader is not hardcoded to this invoice", () => {
  it("follows a modified copy of the same template", async () => {
    const source = await readFile(path.join(FIXTURES, "sample_invoice.xlsx"));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer,
    );
    const ws = wb.getWorksheet("Invoice")!;

    // flatten every formula to its cached value, so the exchange rate can no
    // longer be taken from the workbook's own conversion formula
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cellRef) => {
        const v = cellRef.value as { formula?: string; result?: unknown } | null;
        if (v && typeof v === "object" && "formula" in v) {
          cellRef.value = (v.result ?? null) as ExcelJS.CellValue;
        }
      });
    });

    const set = (ref: string, value: ExcelJS.CellValue) => {
      ws.getCell(ref).value = value;
    };
    set("H4", "ABC/0007");
    set("J4", new Date(Date.UTC(2026, 0, 5)));
    set("A12", "Nordic Stone AB");
    set("A15", "Sweden");
    set("A19", "Baltic Surfaces OY");
    set("H25", "30 Days from BL Date");
    set("C31", "MUNDRA PORT, INDIA");
    set("A33", "GOTHENBURG, SWEDEN");
    set("I19", "SWEDEN");
    set("H5", "PO-88991 Dt: 02/01/2026");
    set("A51", "Container No. TGHU7654321");
    set("A36", "HSN NO: 68022390");
    set("F57", 85.25);
    set("J38", 10000);
    set("J43", 0);
    set("J45", 10000);
    set("J48", 0);
    set("J58", 10000);
    set("A55", "BL No. MEDUXY00123");

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const extraction = await extractDocument(buffer, "variant.xlsx");
    const normalized = normalize(extraction);

    expectFields(normalized, {
      invoiceNo: "ABC/0007",
      invoiceDate: "2026-01-05",
      consigneeName: "Nordic Stone AB",
      notifyPartyName: "Baltic Surfaces OY",
      paymentTerms: "30 Days from BL Date",
      portOfLoading: "MUNDRA PORT, INDIA",
      portOfDischarge: "GOTHENBURG, SWEDEN",
      countryOfDestination: "SWEDEN",
      containerNo: "TGHU7654321",
      hsnCode: "68022390",
      poNo: "PO-88991",
      invoiceValue: 10000,
      exchangeRate: 85.25,
      blNo: "MEDUXY00123",
      invoiceType: "Export",
    });

    // with the formula gone the rate is inferred from the layout — and must say so
    expect(normalized.fields.exchangeRate.status).toBe(FieldStatus.NEEDS_VERIFICATION);
    expect(fieldValue(normalized, "homeValue")).toBe(Math.round(10000 * 85.25 * 100) / 100);
  });
});

describe("commercial invoice extraction — PDF", () => {
  it("produces the same figures from the PDF of the same invoice", async () => {
    const { normalized } = await run("sample_invoice.pdf", "invoice_dummy.pdf");
    expectFields(normalized, {
      invoiceNo: "PESPL/2889",
      invoiceDate: "2026-09-12",
      consigneeName: "Ciot Inc",
      paymentTerms: "100% Cash Against Documents (CAD)",
      portOfLoading: "KATTUPALLI PORT, INDIA",
      containerNo: "MSNU1968136",
      hsnCode: "68101990",
      poNo: "PO-4069880",
      currency: "USD",
      invoiceValue: 18348.49,
      exchangeRate: 93.55,
      totalSlabsPcs: 247,
      netWeight: 23.5,
      grossWeight: 24,
    });
    expect(normalized.lineItems).toHaveLength(2);
    const itemsSum = Math.round(
      normalized.lineItems.reduce((a, li) => a + (li.amount ?? 0), 0) * 100,
    ) / 100;
    expect(itemsSum).toBe(18352.75);
  });
});

describe("unsupported input", () => {
  it("refuses a file it cannot read instead of guessing", async () => {
    await expect(extractDocument(Buffer.from("hello"), "notes.txt")).rejects.toThrow(
      /Phase 1 reads Excel/,
    );
  });
});
