/**
 * The filter bar.
 *
 * A plain GET form, so every view is a URL — bookmarkable, pasteable into an
 * email, and handed to the export route unchanged, which is how a download is
 * guaranteed to be what was on screen. No client JavaScript runs here.
 *
 * The search box covers customer name *and* invoice number, plus PO, container,
 * BL and remarks, because "search by customer or invoice" is how people
 * actually look for a payment and making them choose a field first is friction
 * with no purpose.
 */
import Link from "next/link";

import { ageingLabels } from "@/lib/payments/money";
import { STATUS_LABELS, STATUS_ORDER } from "@/lib/payments/record";
import { DATE_FIELDS, GROUPINGS, type TrackingFilters } from "@/server/payments/query";

function Select({
  name,
  label,
  value,
  options,
  width = "w-40",
  hint,
}: {
  name: string;
  label: string;
  value: string | undefined;
  options: Array<[string, string]>;
  width?: string;
  hint?: string;
}) {
  return (
    <div className={width}>
      <label className="field-label" htmlFor={`fl-${name}`} title={hint}>
        {label}
      </label>
      <select id={`fl-${name}`} name={name} defaultValue={value ?? ""} className="input">
        <option value="">All</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Filters({
  filters,
  options,
  buckets,
  active,
}: {
  filters: TrackingFilters;
  options: { customers: string[]; currencies: string[]; pos: string[]; terms: string[] };
  buckets: number[];
  active: Array<[string, string]>;
}) {
  const field = filters.dateField && filters.dateField in DATE_FIELDS ? filters.dateField : "invoice";

  return (
    <section className="card mb-4">
      <form method="get" className="flex flex-wrap items-end gap-3">
        {filters.sort && <input type="hidden" name="sort" value={filters.sort} />}
        {filters.dir && <input type="hidden" name="dir" value={filters.dir} />}

        <div className="min-w-[220px] flex-1">
          <label className="field-label" htmlFor="fl-q">
            Search
          </label>
          <input
            id="fl-q"
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="Customer name or invoice number — also PO, container, BL, remarks"
            className="input"
          />
        </div>

        <Select
          name="customer"
          label="Customer"
          value={filters.customer}
          width="w-44"
          options={options.customers.map((c) => [c, c])}
        />
        <Select
          name="currency"
          label="Currency"
          value={filters.currency}
          width="w-28"
          options={options.currencies.map((c) => [c, c])}
        />
        <Select
          name="status"
          label="Status"
          value={filters.status}
          width="w-44"
          options={STATUS_ORDER.map((s) => [s, STATUS_LABELS[s]])}
        />
        <Select
          name="ageing"
          label="Ageing"
          value={filters.ageing}
          width="w-36"
          options={[...ageingLabels(buckets), "No due date"].map((b) => [b, b])}
        />
        {options.pos.length > 0 && (
          <Select
            name="po"
            label="PO No."
            value={filters.po}
            width="w-36"
            options={options.pos.map((p) => [p, p])}
          />
        )}
        {options.terms.length > 1 && (
          <Select
            name="term"
            label="Payment terms"
            value={filters.term}
            width="w-52"
            options={options.terms.map((t) => [t, t])}
          />
        )}

        <div className="w-40">
          <label className="field-label" htmlFor="fl-dateField">
            Date range on
          </label>
          <select id="fl-dateField" name="dateField" defaultValue={field} className="input">
            {Object.entries(DATE_FIELDS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="w-36">
          <label className="field-label" htmlFor="fl-from">
            From
          </label>
          <input id="fl-from" name="from" type="date" defaultValue={filters.from ?? ""} className="input" />
        </div>
        <div className="w-36">
          <label className="field-label" htmlFor="fl-to">
            To
          </label>
          <input id="fl-to" name="to" type="date" defaultValue={filters.to ?? ""} className="input" />
        </div>

        <div className="w-40">
          <label className="field-label" htmlFor="fl-group">
            Group by
          </label>
          <select id="fl-group" name="group" defaultValue={filters.group ?? "customer"} className="input">
            {Object.entries(GROUPINGS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-[12px]">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" name="open" value="1" defaultChecked={filters.open === "1"} />
            Outstanding only
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" name="attention" value="1" defaultChecked={filters.attention === "1"} />
            Needs attention
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              name="nilReceived"
              value="1"
              defaultChecked={filters.nilReceived === "1"}
            />
            Nothing received
          </label>
          <label
            className="flex items-center gap-1.5"
            title="Invoices whose due date could not be established from what is recorded."
          >
            <input type="checkbox" name="verify" value="1" defaultChecked={filters.verify === "1"} />
            Requires verification
          </label>
        </div>

        <button type="submit" className="btn">
          Apply
        </button>
        {active.length > 0 && (
          <Link href="/payment-tracking" className="btn-ghost">
            Clear
          </Link>
        )}
      </form>

      {active.length > 0 && (
        <p className="mt-2 text-[11px] text-[var(--color-ink-3)]">
          Filtered: {active.map(([k, v]) => `${k} = ${v}`).join(", ")}
        </p>
      )}
    </section>
  );
}
