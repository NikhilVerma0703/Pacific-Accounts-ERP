import { ReceiptImportForm } from "@/components/ReceiptImportForm";
import { PageHead } from "@/components/ui";

export default function ReceiptImportPage() {
  return (
    <>
      <PageHead
        title="Import Receipts"
        lead="Upload a payment sheet or remittance advice. Each line is matched to its invoice by invoice number."
      />

      <ReceiptImportForm />

      <div className="grid gap-4">
        <section className="card">
          <h2 className="card-title">Columns the reader looks for</h2>
          <ul className="list-disc space-y-1 pl-5 text-[13px] text-[var(--color-ink-2)]">
            <li>A header row naming an amount column — Receipt FCY, Amount Received, Credit Amount…</li>
            <li>An invoice column: Invoice No., Against Invoice, Bill No., Reference</li>
            <li>A date column: Receipt Date, Value Date, Credit Date</li>
            <li>An exchange rate, if the document carries one</li>
            <li>A bank reference or UTR, kept with the receipt</li>
          </ul>
        </section>
      </div>
    </>
  );
}
