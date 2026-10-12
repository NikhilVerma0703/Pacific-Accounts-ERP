import { FieldStatus } from "@/lib/extraction/types";
import { STATUS_TONE, type InvoiceStatusKey } from "@/lib/business/rules";

const TONE_CLASS: Record<string, string> = {
  ok: "bg-[var(--color-ok-bg)] text-[var(--color-ok-fg)]",
  warn: "bg-[var(--color-warn-bg)] text-[var(--color-warn-fg)]",
  bad: "bg-[var(--color-bad-bg)] text-[var(--color-bad-fg)]",
  info: "bg-[var(--color-info-bg)] text-[var(--color-info-fg)]",
  mute: "bg-[var(--color-mute-bg)] text-[var(--color-mute-fg)]",
};

const FIELD_TONE: Record<string, string> = {
  [FieldStatus.EXTRACTED]: "ok",
  [FieldStatus.CALCULATED]: "info",
  [FieldStatus.NEEDS_VERIFICATION]: "warn",
  [FieldStatus.MISSING]: "bad",
  [FieldStatus.NOT_PRESENT]: "mute",
  [FieldStatus.CONFLICT]: "bad",
};

/** Import-log outcomes, shared by the dashboard and the settings screen. */
export const OUTCOME_TONE: Record<string, string> = {
  IMPORTED: TONE_CLASS.ok,
  UPDATED: TONE_CLASS.ok,
  DUPLICATE: TONE_CLASS.warn,
  DELETED: TONE_CLASS.mute,
  FAILED: TONE_CLASS.bad,
};

export const CELL_TINT: Record<string, string> = {
  [FieldStatus.CALCULATED]: "bg-[var(--color-info-bg)]",
  [FieldStatus.NEEDS_VERIFICATION]: "bg-[var(--color-warn-bg)]",
  [FieldStatus.MISSING]: "bg-[var(--color-bad-bg)]",
  [FieldStatus.NOT_PRESENT]: "text-[var(--color-ink-3)]",
};

export function StatusChip({ status }: { status: InvoiceStatusKey | string }) {
  const tone = STATUS_TONE[status as InvoiceStatusKey] ?? "mute";
  const label = status.replace(/_/g, " ").toLowerCase().replace(/^./, (s) => s.toUpperCase());
  return <span className={`chip ${TONE_CLASS[tone]}`}>{label}</span>;
}

export function FieldChip({ status }: { status: string }) {
  return (
    <span className={`chip ${TONE_CLASS[FIELD_TONE[status] ?? "mute"]}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function Banner({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "info";
  children: React.ReactNode;
}) {
  const border: Record<string, string> = {
    ok: "border-[#bfe3cc]",
    warn: "border-[#efd9a1]",
    bad: "border-[#f0c9c9]",
    info: "border-[#c6dcf3]",
  };
  return <div className={`banner ${TONE_CLASS[tone]} ${border[tone]}`}>{children}</div>;
}

export function PageHead({
  title,
  lead,
  actions,
}: {
  title: string;
  lead?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {lead && <p className="mt-1 max-w-[72ch] text-[13px] text-[var(--color-ink-3)]">{lead}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Legend() {
  return (
    <div className="mt-3 flex flex-wrap gap-4 text-xs text-[var(--color-ink-2)]">
      {[
        ["Extracted", "border border-[var(--color-line)] bg-white"],
        ["Calculated", "bg-[var(--color-info-bg)]"],
        ["Needs verification", "bg-[var(--color-warn-bg)]"],
        ["Missing", "bg-[var(--color-bad-bg)]"],
        ["From another source", "bg-[var(--color-mute-bg)]"],
      ].map(([label, cls]) => (
        <span key={label} className="flex items-center gap-1.5">
          <i className={`inline-block h-3 w-3 rounded ${cls}`} />
          {label}
        </span>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="p-10 text-center text-[var(--color-ink-3)]">{children}</div>;
}
