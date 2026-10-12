/**
 * The sidebar got smaller. Nothing behind it did.
 *
 * Grouping eleven flat entries into five areas plus Settings is only safe if every
 * screen is still reachable, so this file checks the navigation against the routes
 * that actually exist on disk — in both directions. A new page with no nav entry
 * fails here, and so does a nav entry pointing at a page that is not there.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { activeNav, ALL_NAV_ITEMS, NAV } from "@/lib/modules";

const root = process.cwd();

/** The file that renders a given path, if it exists. */
function pageFileFor(href: string): string {
  const route = href.split("?")[0];
  const rel = route === "/" ? "" : route;
  return path.join(root, "src/app/(app)", rel, "page.tsx");
}

describe("the sidebar is short", () => {
  it("has six top-level areas, not eleven", () => {
    expect(NAV).toHaveLength(6);
    expect(NAV.map((g) => g.label)).toEqual([
      "Dashboard",
      "Invoices",
      "Payments",
      "Payment Tracking",
      "Reports & MIS",
      "Settings",
    ]);
  });

  it("shows at most seven rows before anything is opened", () => {
    // one row per area; children appear only for the area you are in
    const atRest = NAV.length;
    expect(atRest).toBeLessThanOrEqual(7);
  });
});

describe("every screen is still reachable", () => {
  it.each(ALL_NAV_ITEMS.map((i) => [i.label, i.href] as const))(
    "%s points at a page that exists (%s)",
    (_label, href) => {
      // the seven reports are one page differing by query string
      if (href.startsWith("/reports")) {
        expect(existsSync(pageFileFor("/reports"))).toBe(true);
        return;
      }
      expect(existsSync(pageFileFor(href)), `${href} has no page.tsx`).toBe(true);
    },
  );

  it("leaves no page out of the navigation", () => {
    const reachable = new Set(ALL_NAV_ITEMS.map((i) => i.href.split("?")[0]));
    // every route that exists, other than the invoice detail page which is
    // reached by opening a row rather than from the sidebar
    const routes = [
      "/", "/invoices", "/invoices/new", "/import",
      "/receipts", "/receipts/import",
      "/payment-tracking", "/payment-tracking/import", "/payment-tracking/new",
      "/reports", "/shipping", "/tally", "/settings",
    ];
    for (const route of routes) {
      expect(reachable.has(route), `${route} is not reachable from the sidebar`).toBe(true);
    }
  });

  it("keeps the two areas Accounts asked to fold into Reports", () => {
    const reports = NAV.find((g) => g.key === "reports");
    const labels = reports?.children?.map((c) => c.label) ?? [];
    expect(labels).toContain("Outstanding & Ageing");
    expect(labels).toContain("Credit / Debit Notes");

    // and only there — neither is a top-level area any more
    const top = NAV.map((g) => g.label);
    expect(top).not.toContain("Outstanding & Ageing");
    expect(top).not.toContain("Credit / Debit Notes");
  });
});

describe("the highlight follows the page you are on", () => {
  it.each([
    ["/", "dashboard", "dashboard"],
    ["/invoices", "invoices", "register"],
    ["/invoices/new", "invoices", "manual"],
    ["/invoices/abc123", "invoices", "register"],
    ["/import", "invoices", "import"],
    ["/shipping", "invoices", "shipping"],
    ["/tally", "invoices", "tally"],
    ["/receipts", "payments", "receipts"],
    ["/receipts/import", "payments", "receiptsImport"],
    ["/payment-tracking", "tracking", "trackingMain"],
    ["/payment-tracking/import", "tracking", "trackingImport"],
    ["/payment-tracking/new", "tracking", "trackingNew"],
    ["/payment-tracking/customer/abc", "tracking", "trackingMain"],
    ["/payment-tracking/invoice/abc", "tracking", "trackingMain"],
    ["/reports", "reports", "reports"],
    ["/settings", "settings", "settings"],
  ])("%s highlights %s / %s", (pathname, group, item) => {
    expect(activeNav(pathname)).toEqual({ group, item });
  });

  it("prefers the longest match, so a sub-page is not mistaken for its parent", () => {
    // /invoices/new must not resolve to the register just because it starts with it
    expect(activeNav("/invoices/new").item).toBe("manual");
    expect(activeNav("/receipts/import").item).toBe("receiptsImport");
    expect(activeNav("/payment-tracking/new").item).toBe("trackingNew");

  });

});

describe("the highlight follows the page you are on", () => {
  it.each([
    ["/", "dashboard", "dashboard"],
    ["/invoices", "invoices", "register"],
    ["/invoices/new", "invoices", "manual"],
    ["/invoices/abc123", "invoices", "register"],
    ["/import", "invoices", "import"],
    ["/shipping", "invoices", "shipping"],
    ["/tally", "invoices", "tally"],
    ["/receipts", "payments", "receipts"],
    ["/receipts/import", "payments", "receiptsImport"],
    ["/payment-tracking", "tracking", "trackingMain"],
    ["/payment-tracking/import", "tracking", "trackingImport"],
    ["/payment-tracking/new", "tracking", "trackingNew"],
    ["/payment-tracking/customer/abc", "tracking", "trackingMain"],
    ["/payment-tracking/invoice/abc", "tracking", "trackingMain"],
    ["/reports", "reports", "reports"],
    ["/settings", "settings", "settings"],
  ])("%s highlights %s / %s", (pathname, group, item) => {
    expect(activeNav(pathname)).toEqual({ group, item });
  });

  it("prefers the longest match, so a sub-page is not mistaken for its parent", () => {
    // /invoices/new must not resolve to the register just because it starts with it
    expect(activeNav("/invoices/new").item).toBe("manual");
    expect(activeNav("/receipts/import").item).toBe("receiptsImport");
    expect(activeNav("/payment-tracking/new").item).toBe("trackingNew");

  });


  it("does not read the query string", () => {
    // reading it would mean useSearchParams in the shell, which opts every page
    // out of static rendering — the reports page shows the active report itself
    expect(activeNav("/reports")).toEqual(activeNav("/reports?report=overdue"));
  });
});
