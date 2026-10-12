"use client";

/**
 * Re-reads invoices that an older version of the reader produced — after the page
 * is on screen, not before it.
 *
 * The healing itself is unchanged and still automatic. What changed is when: it
 * used to run inside the register's server render, so every visit to the section
 * waited for up to 25 documents to be parsed. Now the page arrives immediately
 * and this asks for the work once, in the background.
 */
import { useEffect, useRef, useState } from "react";

import { Banner } from "@/components/ui";


export function HealStaleInvoices({ pending }: { pending: number }) {
  const [done, setDone] = useState<number | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (pending <= 0 || started.current) return;
    started.current = true;
    // a plain fetch to the maintenance endpoint, not a server action: that keeps
    // the document readers out of this page's server bundle entirely
    fetch("/api/maintenance/reextract?scope=stale", { method: "POST" })
      .then((r) => r.json())
      .then((r: { reread?: number }) => setDone(r.reread ?? 0))
      // a failure here is not the user's problem: the register is already correct,
      // the values an older reader missed simply stay missing until next time
      .catch(() => setDone(0));
  }, [pending]);

  if (pending <= 0) return null;

  return (
    <div className="mb-3">
      <Banner tone="info">
        {done === null
          ? `Re-reading ${Math.min(pending, 25)} invoice(s) with the improved reader in the background — the register is usable now, and any value it can newly capture will appear on the next refresh.`
          : done > 0
            ? `${done} invoice(s) were re-read from their original file. Your corrections were kept. Refresh to see anything newly captured.`
            : "Nothing needed re-reading."}
      </Banner>
    </div>
  );
}
