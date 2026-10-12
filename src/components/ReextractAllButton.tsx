"use client";

/**
 * Re-read every stored invoice with the current reader.
 *
 * Posts to the maintenance endpoint rather than calling a server action, so that
 * Settings — a page someone opens to read a list of rules — does not carry the
 * Excel and PDF readers in its server bundle. Same work, same guarantees:
 * corrections are replayed on top, nothing anyone typed is lost.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ReextractAllButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "working" | number>("idle");

  async function run() {
    setState("working");
    try {
      const response = await fetch("/api/maintenance/reextract?scope=all", { method: "POST" });
      const { reread } = (await response.json()) as { reread: number };
      setState(reread);
      router.refresh();
    } catch {
      setState("idle");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={run} disabled={state === "working"} className="btn-ghost">
        {state === "working" ? "Re-reading…" : "Re-extract every stored invoice"}
      </button>
      {typeof state === "number" && (
        <span className="text-xs text-[var(--color-ink-3)]">
          {state} invoice(s) re-read from their original file. Corrections were kept.
        </span>
      )}
    </div>
  );
}
