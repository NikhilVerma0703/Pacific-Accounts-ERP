/**
 * Re-reading stored invoices with the current reader.
 *
 * Deliberately a route handler rather than a server action. Re-extraction needs
 * the Excel and PDF readers, and in Next a route inherits the whole server module
 * graph of everything it imports — so when this lived among the ordinary actions,
 * every screen that imported those actions carried the readers too. Behind its own
 * endpoint, only this route does.
 *
 * `scope=stale` heals what an older reader produced (what the register asks for in
 * the background). `scope=all` re-reads everything, which is the Settings button.
 * Both replay manual corrections on top, so nothing anyone typed is ever undone.
 */
import { type NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

export async function POST(request: NextRequest) {
  const scope = request.nextUrl.searchParams.get("scope") === "all" ? "all" : "stale";

  const { reextractAllInvoices, reextractStale } = await import("@/server/ingest");
  const done = scope === "all" ? await reextractAllInvoices() : await reextractStale();

  if (done > 0) {
    revalidatePath("/invoices");
    revalidatePath("/");
    revalidatePath("/settings");
  }
  return NextResponse.json({ scope, reread: done });
}
