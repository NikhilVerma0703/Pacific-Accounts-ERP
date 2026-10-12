"use client";

/**
 * Delete an imported invoice.
 *
 * Deliberately two clicks, and deliberately *not* a browser confirm box: the
 * first click turns the button into a short question naming the invoice and the
 * file, so an Accounts employee always sees what is about to go before it goes.
 * Nothing is removed until "Yes, delete" is pressed, and Cancel puts it back.
 */
import { useState } from "react";
import { useFormStatus } from "react-dom";

import { deleteInvoiceAction } from "@/server/actions";

function ConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-danger btn-sm" disabled={pending}>
      {pending ? "Removing…" : "Yes, delete"}
    </button>
  );
}

export function DeleteInvoiceButton({
  invoiceId,
  invoiceNo,
  fileName,
  redirectTo,
  label = "Delete",
  block = false,
}: {
  invoiceId: string;
  invoiceNo: string;
  /** The uploaded file this row came from, when it is known. */
  fileName?: string | null;
  /** Where to go once it is gone. Omit to stay on the current screen. */
  redirectTo?: string;
  label?: string;
  /** Lay the question out on its own line, for the wider screens. */
  block?: boolean;
}) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        className={`btn-ghost btn-sm text-[var(--color-bad-fg)] ${block ? "" : "whitespace-nowrap"}`}
        aria-label={`Delete invoice ${invoiceNo}`}
      >
        {label}
      </button>
    );
  }

  return (
    <form
      action={deleteInvoiceAction}
      className={`flex items-center gap-2 ${block ? "flex-wrap" : "whitespace-nowrap"}`}
    >
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {redirectTo && <input type="hidden" name="redirectTo" value={redirectTo} />}
      <span className="text-xs text-[var(--color-ink-2)]">
        Remove {invoiceNo}
        {fileName ? ` and ${fileName}` : ""}?
      </span>
      <ConfirmButton />
      <button type="button" onClick={() => setAsking(false)} className="btn-ghost btn-sm">
        Cancel
      </button>
    </form>
  );
}
