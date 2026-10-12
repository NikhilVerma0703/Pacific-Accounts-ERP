import Link from "next/link";

import { ManualInvoiceForm, type GroupSpec } from "@/components/ManualInvoiceForm";
import { PageHead } from "@/components/ui";
import { BY_KEY } from "@/lib/extraction/catalog";
import { todayIso } from "@/lib/extraction/text";
import { MANUAL_GROUPS, suggestInvoiceNo } from "@/server/manualInvoice";

export const dynamic = "force-dynamic";

/** Shown in the empty box, so the expected shape of each value is obvious. */
const PLACEHOLDER: Record<string, string> = {
  invoiceNo: "PESPL/2889",
  currency: "USD",
  exchangeRate: "93.55",
  invoiceValue: "18348.49",
  paymentTerms: "100% Cash Against Documents (CAD)",
  containerNo: "MSNU1968136",
  countryOfDestination: "CANADA",
  piNo: "PI-SAL-ORD/25-26/01653",
  poNo: "PO-4069880",
  shippingBillNo: "1234567",
  blNo: "MEDUXY00123",
};

export default async function NewInvoicePage() {
  const groups: GroupSpec[] = MANUAL_GROUPS.map((g) => ({
    title: g.title,
    hint: g.hint,
    fields: g.fields.map((key) => ({
      key,
      label: BY_KEY[key]?.label ?? key,
      type: BY_KEY[key]?.type === "date" ? ("date" as const) : ("text" as const),
      placeholder: PLACEHOLDER[key] ?? "",
    })),
  }));

  return (
    <>
      <PageHead
        title="Create New Record"
        lead="Enter an invoice by hand. It produces the same register row as an upload."
        actions={
          <Link href="/import" className="btn-ghost">
            Import a file instead
          </Link>
        }
      />

      <ManualInvoiceForm
        groups={groups}
        suggestedInvoiceNo={await suggestInvoiceNo()}
        today={todayIso()}
      />
    </>
  );
}
