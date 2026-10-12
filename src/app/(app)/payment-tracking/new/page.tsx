/**
 * Entering a record by hand.
 *
 * No field on this form is required — no `required` attribute anywhere, and no
 * validation that refuses a save. The record can be completed later, because
 * that is how this information arrives: a number today, a BL date next week.
 */
import Link from "next/link";

import { Field } from "@/components/tracking/bits";
import { PageHead } from "@/components/ui";
import { prisma } from "@/lib/db";
import { SUPPORTED_TERMS } from "@/lib/payments/terms";
import { INVOICE_FIELD_GROUPS } from "@/lib/payments/form";
import { saveInvoiceAction } from "@/server/payments/actions";

export const dynamic = "force-dynamic";

/** Format hints, only where the expected input is not obvious. */
const HINTS: Record<string, string> = {
  exchangeRate: "Home currency per unit of foreign currency, e.g. 83.25",
  paymentTerms: "e.g. 120 Days From BL Date",
  enteredDueDate: "Overrides the calculated due date",
};

export default async function NewRecordPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const { customerId } = await searchParams;
  const customers = await prisma.ptCustomer.findMany({ orderBy: { name: "asc" } });
  const preset = customerId ? customers.find((c) => c.id === customerId) : undefined;

  return (
    <>
      <PageHead
        title="New payment record"
        lead="Enter what you know. No field is required."
        actions={
          <>
            <Link href="/payment-tracking/import" className="btn-ghost">
              Upload a sheet instead
            </Link>
            <Link href="/payment-tracking" className="btn-ghost">
              Back to tracking
            </Link>
          </>
        }
      />


      <form action={saveInvoiceAction} className="mt-4 space-y-4">
        <section className="card">
          <h2 className="card-title">Customer</h2>
          <p className="mb-3 text-[12px] text-[var(--color-ink-2)]">
            Pick an existing customer, or type a new name to create one. Leave both blank to assign
            one later.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-64">
              <label className="field-label" htmlFor="customerId">
                Existing customer
              </label>
              <select
                id="customerId"
                name="customerId"
                defaultValue={preset?.id ?? ""}
                className="input"
              >
                <option value="">— none / new below —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name ?? "(unnamed)"}
                  </option>
                ))}
              </select>
            </div>
            <Field
              name="customerName"
              label="…or a new customer name"
              width="min-w-[220px] flex-1"
              />
          </div>
        </section>

        {INVOICE_FIELD_GROUPS.map((group) => (
          <section key={group.title} className="card">
            <h2 className="card-title">{group.title}</h2>
            {group.hint && (
              <p className="mb-3 text-[12px] text-[var(--color-ink-2)]">{group.hint}</p>
            )}
            <div className="flex flex-wrap gap-3">
              {group.fields.map(([name, label, type]) => (
                <Field
                  key={name}
                  name={name}
                  label={label}
                  type={type as "text" | "date" | "number"}
                  hint={HINTS[name]}
                  list={name === "paymentTerms" ? "pt-terms" : undefined}
                  placeholder={name === "paymentTerms" ? "e.g. 120 Days From BL Date" : undefined}
                  width={
                    name === "remarks" || name === "followUpNotes"
                      ? "min-w-[280px] flex-[2]"
                      : "min-w-[180px] flex-1"
                  }
                />
              ))}
            </div>
          </section>
        ))}

        <datalist id="pt-terms">
          {SUPPORTED_TERMS.map((t) => (
            <option key={t.example} value={t.example} />
          ))}
        </datalist>

        <section className="card">
          <h2 className="card-title">Receipts</h2>
          <p className="mb-3 text-[12px] text-[var(--color-ink-2)]">
            Three to start with. More can be added on the record once it is saved.
          </p>
          <input type="hidden" name="receiptCount" value="3" />
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-line)] p-3">
                <div className="w-20 pt-5 text-[12px] font-semibold text-[var(--color-ink-3)]">
                  Receipt {i}
                </div>
                <Field name={`receipt${i}Date`} label="Date" type="date" width="w-40" />
                <Field name={`receipt${i}Amount`} label="Amount (FCY)" type="number" width="w-40" />
                <Field
                  name={`receipt${i}Rate`}
                  label="Exchange rate"
                  type="number"
                  width="w-40"
                    />
                <Field name={`receipt${i}Ref`} label="Bank reference" width="min-w-[180px] flex-1" />
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn">
            Save record
          </button>
          <Link href="/payment-tracking" className="btn-ghost">
            Cancel
          </Link>

        </div>
      </form>
    </>
  );
}
