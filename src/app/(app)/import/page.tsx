import { ImportForm } from "@/components/ImportForm";
import { Legend, PageHead } from "@/components/ui";

export default function ImportPage() {
  return (
    <>
      <PageHead
        title="Import Commercial Invoice"
        lead="Upload a commercial invoice. The Accounts fields are extracted and added to the register."
      />

      <ImportForm />

      <div className="grid gap-4">
        <section className="card">
          <h2 className="card-title">How each field is marked</h2>
          <Legend />
        </section>
      </div>
    </>
  );
}
