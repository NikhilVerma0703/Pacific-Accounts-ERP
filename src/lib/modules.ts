/**
 * Navigation for the Accounts sub-ERP.
 *
 * Five working areas plus Settings, instead of a flat list. The screens
 * themselves are unchanged and every URL still works — this is only about what an
 * Accounts employee sees down the left-hand side.
 *
 * The grouping follows the job, not the code:
 *
 *   Invoices  — the record itself: the register, the two ways to create one, and
 *               the two screens that complete it from other sources
 *   Payments  — money in: receipts typed or imported
 *   Follow-up — customer-wise outstanding and the chasing queue. A section of
 *               its own rather than a report, because it is the one screen in
 *               the application that is *worked on* daily rather than read:
 *               Accounts records conversations here. It still owns no figures —
 *               it reads them from the register.
 *   Reports   — reading the same data back. Outstanding & Ageing and the CN/DN
 *               report are report views, so they live here and only here.
 *
 * A group shows its children when you are inside it, so the sidebar is six rows
 * at rest and nothing is more than one click away.
 */
export interface NavItem {
  href: string;
  label: string;
  key: string;
  /** One line explaining the item, shown on hover. */
  hint?: string;
}

export interface NavGroup extends NavItem {
  /** The screens inside this area. The heading itself goes to `href`. */
  children?: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    href: "/",
    label: "Dashboard",
    key: "dashboard",
    hint: "Invoiced, received, outstanding and what needs attention",
  },
  {
    href: "/invoices",
    label: "Invoices",
    key: "invoices",
    hint: "The Accounts Register and everything that fills it",
    children: [
      {
        href: "/invoices",
        label: "Accounts Register",
        key: "register",
        hint: "Every invoice, every column, with export",
      },
      {
        href: "/import",
        label: "Import Invoice",
        key: "import",
        hint: "Read a commercial invoice from Excel or PDF",
      },
      {
        href: "/invoices/new",
        label: "Manual Entry",
        key: "manual",
        hint: "Create a record by hand, with receipts and notes",
      },
      {
        href: "/shipping",
        label: "Shipping & Export",
        key: "shipping",
        hint: "PI/PO, shipping bill, BL, container and ETA",
      },
      {
        href: "/tally",
        label: "Tally & e-Invoice",
        key: "tally",
        hint: "IRN, e-Invoice status, voucher and the books value",
      },
    ],
  },
  {
    href: "/receipts",
    label: "Payments",
    key: "payments",
    hint: "Receipts, and what is still owed",
    children: [
      {
        href: "/receipts",
        label: "Payments & Receipts",
        key: "receipts",
        hint: "Every receipt, with forex gain/loss and the balance",
      },
      {
        href: "/receipts/import",
        label: "Import Receipts",
        key: "receiptsImport",
        hint: "Read receipts from a payment sheet or remittance advice",
      },
    ],
  },
  {
    href: "/payment-tracking",
    label: "Payment Tracking",
    key: "tracking",
    hint: "Customer payment tracking, with its own records — independent of the register",
    children: [
      {
        href: "/payment-tracking",
        label: "Dashboard & Master Table",
        key: "trackingMain",
        hint: "KPIs, the customer-wise summary and every tracked invoice",
      },
      {
        href: "/payment-tracking/import",
        label: "Upload Sheet",
        key: "trackingImport",
        hint: "Read a customer outstanding sheet in whatever layout it arrives",
      },
      {
        href: "/payment-tracking/new",
        label: "New Record",
        key: "trackingNew",
        hint: "Enter a customer, invoice and receipts by hand — no field is required",
      },
    ],
  },
  {
    href: "/reports",
    label: "Reports & MIS",
    key: "reports",
    hint: "Seven views over the same numbers, each exporting to Excel or CSV",
    children: [
      { href: "/reports?report=register", label: "Invoice Register", key: "r-register" },
      { href: "/reports?report=customer", label: "Customer Outstanding", key: "r-customer" },
      { href: "/reports?report=receipts", label: "Payment / Receipt", key: "r-receipts" },
      {
        href: "/reports?report=overdue",
        label: "Outstanding & Ageing",
        key: "r-overdue",
        hint: "Past due, oldest first, with ageing buckets",
      },
      {
        href: "/reports?report=notes",
        label: "Credit / Debit Notes",
        key: "r-notes",
        hint: "Every CN and DN and its effect on the balance",
      },
      { href: "/reports?report=shipping", label: "Shipping / ETA", key: "r-shipping" },
      { href: "/reports?report=currency", label: "Currency Summary", key: "r-currency" },
    ],
  },
  {
    href: "/settings",
    label: "Settings",
    key: "settings",
    hint: "Payment-term rules, re-extraction and the import log",
  },
];

/**
 * Which group a path belongs to, and which item within it.
 *
 * Longest matching path wins, so /invoices/new resolves to Manual Entry rather
 * than the register it sits under.
 *
 * Deliberately pathname-only. The seven reports share one route and differ by
 * query string, and reading the query in the sidebar would mean `useSearchParams`
 * in the shell — which opts every page out of static rendering and undoes the
 * navigation-speed work. So inside Reports the heading is the marker, and which
 * report is open is shown by that page's own tab strip, where it is already
 * unmissable.
 */
export function activeNav(pathname: string): { group: string; item: string } {
  if (pathname === "/") return { group: "dashboard", item: "dashboard" };
  if (pathname.startsWith("/reports")) return { group: "reports", item: "reports" };

  let best = { group: "dashboard", item: "dashboard", length: -1 };
  for (const group of NAV) {
    for (const item of group.children ?? [group]) {
      const base = item.href.split("?")[0];
      if (base === "/") continue;
      const hit = pathname === base || pathname.startsWith(`${base}/`);
      if (hit && base.length > best.length) {
        best = { group: group.key, item: item.key, length: base.length };
      }
    }
  }
  return { group: best.group, item: best.item };
}

/** Every screen the sidebar can reach — the inventory the tests check against. */
export const ALL_NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.children ?? [g]);
