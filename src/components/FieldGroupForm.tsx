"use client";

/**
 * A block of related fields, typed in together.
 *
 * Used for both the shipping block and the Tally / e-Invoice block: the same
 * shape of thing, so the same component. Each box shows where its value came
 * from, and an empty box clears the value rather than being ignored — so a
 * mistyped shipping bill can be taken back out.
 */
import { useFormStatus } from "react-dom";

export interface GroupField {
  key: string;
  label: string;
  type: "text" | "date";
  value: string;
  /** "Invoice!H4", "entered by Accounts", "Tally" — blank when nothing is set. */
  source: string;
  placeholder?: string;
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </button>
  );
}

export function FieldGroupForm({
  action,
  invoiceId,
  fields,
  pendingMessage,
  children,
}: {
  action: (formData: FormData) => Promise<void>;
  invoiceId: string;
  fields: GroupField[];
  /** Shown when nothing in the block has a value yet. */
  pendingMessage?: string;
  children?: React.ReactNode;
}) {
  const anyFilled = fields.some((f) => f.value !== "");

  return (
    <form action={action}>
      <input type="hidden" name="invoiceId" value={invoiceId} />

      {!anyFilled && pendingMessage && (
        <div className="mb-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-mute-bg)] px-3 py-2 text-[13px] text-[var(--color-mute-fg)]">
          {pendingMessage}
        </div>
      )}

      {children}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {fields.map((f) => (
          <div key={f.key}>
            <label className="field-label" htmlFor={`g-${f.key}`}>
              {f.label}
            </label>
            <input
              id={`g-${f.key}`}
              name={f.key}
              type={f.type}
              defaultValue={f.value}
              placeholder={f.placeholder ?? ""}
              className="input"
            />
            <div className="mt-1 text-[10px] text-[var(--color-ink-3)]">
              {f.source ? f.source : "not set"}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <SaveButton />
      </div>
    </form>
  );
}
