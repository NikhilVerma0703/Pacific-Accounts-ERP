/**
 * Guards on what makes navigation fast.
 *
 * Every rule here was a real cause of section changes taking seconds, and each is
 * the kind of thing that comes back by accident: someone needs `loadRules`, imports
 * it from `server/ingest` because that is where it used to live, and quietly puts
 * 23 MB of Excel reader back into the register's server graph. These checks are
 * cheap and they fail loudly.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

/** Static `import ... from "x"` specifiers only — a dynamic import is fine. */
function staticImports(source: string): string[] {
  const out: string[] = [];
  const re = /^\s*import\s+(?:[\s\S]*?from\s+)?["']([^"']+)["'];?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

/**
 * Modules that pull in the Excel / PDF readers.
 *
 * Note which extraction modules are *not* here: `text`, `types`, `catalog` and
 * `version` are leaves with no dependencies, so anything may import them. It is
 * the index — and the readers it wires together — that costs.
 */
const READER_CHAIN = [
  "@/server/ingest",
  "@/server/receiptImport",
  "@/lib/extraction",
  "@/lib/extraction/index",
  "@/lib/extraction/sheetGrid",
  "@/lib/extraction/textGrid",
  "@/lib/extraction/invoiceReader",
  "@/lib/extraction/receiptReader",
  "exceljs",
  "pdfjs-dist",
];

/**
 * Files a page render touches. None of them may reach the readers: reading a
 * document is import's job, and nothing else should pay for it.
 */
const RENDER_PATH = [
  "src/server/invoiceData.ts",
  "src/server/registerRows.ts",
  "src/server/receipts.ts",
  "src/server/receivables.ts",
  "src/server/reports.ts",
  "src/server/fieldGroups.ts",
  "src/server/overview.ts",
  "src/server/commercial.ts",
  "src/server/tally.ts",
  "src/server/manualInvoice.ts",
  "src/server/actions.ts",
  "src/app/(app)/layout.tsx",
  "src/app/(app)/page.tsx",
  "src/app/(app)/invoices/page.tsx",
  "src/app/(app)/invoices/[id]/page.tsx",
  "src/app/(app)/invoices/new/page.tsx",
  "src/app/(app)/receipts/page.tsx",
  "src/app/(app)/reports/page.tsx",
  "src/app/(app)/shipping/page.tsx",
  "src/app/(app)/tally/page.tsx",
  "src/app/(app)/settings/page.tsx",
];

describe("the readers stay out of the render path", () => {
  it.each(RENDER_PATH)("%s does not statically import a document reader", (file) => {
    const imports = staticImports(read(file));
    for (const heavy of READER_CHAIN) {
      const offender = imports.find((i) => i === heavy);
      expect(
        offender,
        `${file} imports ${offender} — that puts the Excel/PDF readers in this route's server graph. ` +
          "Use @/server/invoiceData for database helpers, or a dynamic import / the " +
          "/api/maintenance/reextract endpoint for work that really needs a reader.",
      ).toBeUndefined();
    }
  });

  it("keeps the readers where they belong", () => {
    // the two screens that genuinely read a document, and the engine itself
    expect(staticImports(read("src/server/importActions.ts"))).toContain("@/server/ingest");
    expect(staticImports(read("src/server/ingest.ts"))).toContain("@/lib/extraction");
  });

});

describe("the shell is not rebuilt on every click", () => {
  it("has a streaming boundary, so a click paints immediately", () => {
    expect(existsSync(path.join(root, "src/app/(app)/loading.tsx"))).toBe(true);
  });

  it("has a layout that does not read the request", () => {
    const layout = read("src/app/(app)/layout.tsx");
    // headers() or cookies() in a layout makes the whole shell dynamic: it is then
    // re-rendered and re-sent for every navigation
    expect(layout).not.toMatch(/\bheaders\(\)/);
    expect(layout).not.toMatch(/\bcookies\(\)/);
  });

  it("highlights the section in the browser, not on the server", () => {
    const sidebar = read("src/components/Sidebar.tsx");
    expect(sidebar).toContain('"use client"');
    expect(sidebar).toContain("usePathname");
  });

  it("has no middleware running on every request", () => {
    expect(existsSync(path.join(root, "src/middleware.ts"))).toBe(false);
    expect(existsSync(path.join(root, "middleware.ts"))).toBe(false);
  });
});

describe("Payment Tracking is a separate system", () => {
  /** Everything belonging to the new section. */
  const TRACKING = [
    "src/lib/payments/terms.ts",
    "src/lib/payments/money.ts",
    "src/lib/payments/record.ts",
    "src/lib/payments/sheetReader.ts",
    "src/server/payments/query.ts",
    "src/server/payments/actions.ts",
    "src/server/payments/registerActions.ts",
    "src/server/payments/audit.ts",
    "src/server/payments/import.ts",
    "src/server/payments/export.ts",
    "src/app/(app)/payment-tracking/page.tsx",
    "src/app/(app)/payment-tracking/import/page.tsx",
    "src/app/(app)/payment-tracking/new/page.tsx",
    "src/app/(app)/payment-tracking/invoice/[id]/page.tsx",
    "src/app/(app)/payment-tracking/customer/[id]/page.tsx",
  ];

  /** The register's own modules. The new section must reach none of them. */
  const REGISTER_MODULES = [
    "@/server/receivables",
    "@/server/registerRows",
    "@/server/reports",
    "@/server/invoiceData",
    "@/server/ingest",
    "@/server/receipts",
    "@/server/manualInvoice",
    "@/server/tally",
    "@/server/commercial",
    "@/server/overview",
    "@/server/actions",
    "@/lib/business/accounts",
    "@/lib/business/rules",
  ];

  it.each(TRACKING)("%s does not import a register module", (file) => {
    const imports = staticImports(read(file));
    for (const m of REGISTER_MODULES) {
      // the export route is allowed the generic workbook writer, nothing else
      expect(imports, `${file} imports ${m}`).not.toContain(m);
    }
  });

  it("queries only its own pt_ tables", () => {
    for (const file of [
      "src/server/payments/query.ts",
      "src/server/payments/actions.ts",
      "src/server/payments/registerActions.ts",
      "src/server/payments/audit.ts",
      "src/server/payments/import.ts",
    ]) {
      const source = read(file);
      const models = [...source.matchAll(/prisma\.(\w+)\./g)].map((m) => m[1]);
      for (const model of new Set(models)) {
        expect(
          model.startsWith("pt"),
          `${file} uses prisma.${model} — Payment Tracking must only touch its own pt_ tables`,
        ).toBe(true);
      }
    }
  });

  it("is not reachable from the register's own modules", () => {
    // the separation has to hold in both directions, or deleting one would
    // break the other
    for (const file of [
      "src/server/receivables.ts",
      "src/server/registerRows.ts",
      "src/server/reports.ts",
      "src/server/invoiceData.ts",
      "src/lib/business/accounts.ts",
      "src/lib/business/rules.ts",
      "src/app/(app)/invoices/page.tsx",
      "src/app/(app)/reports/page.tsx",
      "src/app/(app)/settings/page.tsx",
    ]) {
      const imports = staticImports(read(file));
      for (const m of imports) {
        expect(m.startsWith("@/lib/payments"), `${file} imports ${m}`).toBe(false);
        expect(m.startsWith("@/server/payments"), `${file} imports ${m}`).toBe(false);
      }
    }
  });

  it("keeps the workbook reader out of every screen but the upload one", () => {
    // a route carries the whole module graph of what it imports, so one shared
    // action file reaching the reader would put exceljs into every screen
    const heavy = ["exceljs", "@/lib/payments/sheetReader", "@/server/payments/import"];
    for (const file of [
      "src/app/(app)/payment-tracking/page.tsx",
      "src/app/(app)/payment-tracking/new/page.tsx",
      "src/app/(app)/payment-tracking/invoice/[id]/page.tsx",
      "src/app/(app)/payment-tracking/customer/[id]/page.tsx",
      "src/server/payments/query.ts",
    ]) {
      const imports = staticImports(read(file));
      for (const m of heavy) {
        expect(imports, `${file} imports ${m}`).not.toContain(m);
      }
    }
  });

  it("has no required field on any of its forms", () => {
    // The brief is explicit: a record must always save, however incomplete. So
    // this looks at the input tags themselves rather than the file, because the
    // files talk *about* nothing being required and prose would match.
    const tags = /<(input|select|textarea)\b[^>]*>/gs;
    for (const file of [
      "src/app/(app)/payment-tracking/new/page.tsx",
      "src/app/(app)/payment-tracking/invoice/[id]/page.tsx",
      "src/app/(app)/payment-tracking/customer/[id]/page.tsx",
      "src/components/tracking/bits.tsx",
    ]) {
      for (const [tag] of read(file).matchAll(tags)) {
        expect(/\brequired\b/.test(tag), `${file} marks a field required: ${tag.slice(0, 80)}`).toBe(
          false,
        );
      }
    }
  });

  it("calculates nothing it cannot support, and says so instead", () => {
    const record = read("src/lib/payments/record.ts");
    expect(record).toContain("REQUIRES_VERIFICATION");
    // Requires verification must be tested before Overdue, or an invoice with
    // no establishable due date would be reported as late
    expect(record.indexOf('return "REQUIRES_VERIFICATION"')).toBeLessThan(
      record.indexOf('return "OVERDUE"'),
    );
  });
});

describe("a register render does not fan out into per-row queries", () => {
  it("loads receipts and notes for the whole page at once", () => {
    const source = read("src/server/registerRows.ts");
    expect(source).toContain("receiptsAndNotesFor");
    // the per-invoice helper must not be called from inside the row loop
    expect(source).not.toMatch(/for \([\s\S]*?receiptsAndNotes\(/);
  });

  it("does not wait for each row's write-back before rendering the next", () => {
    const source = read("src/server/registerRows.ts");
    expect(source).toContain("writes.push(");
    expect(source).toContain("await Promise.all(writes)");
  });
});
