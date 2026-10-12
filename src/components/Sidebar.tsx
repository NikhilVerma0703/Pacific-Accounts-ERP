"use client";

/**
 * The navigation, and the one piece of state it needs: where you are.
 *
 * Two levels rather than eleven flat entries. A group heading is itself a link to
 * that area's main screen, and its children appear only while you are inside it —
 * so the sidebar is five rows at rest, and nothing is more than one click away.
 *
 * Deliberately a client component reading `usePathname()`. It used to take the
 * active section as a prop, which meant the layout had to call `headers()` to
 * learn the path — and a layout that reads the request is dynamic, so the whole
 * shell was re-rendered and re-sent for every click. Now the shell renders once
 * and stays put; only the content area changes, and the highlight moves instantly
 * because the browser already knows where it is going.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

import { APP_NAME, APP_OWNER, APP_PHASE } from "@/lib/config";
import { activeNav, NAV } from "@/lib/modules";

function useActive() {
  return activeNav(usePathname());
}

export function Sidebar() {
  const active = useActive();

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col bg-[var(--color-brand)] text-[#dbe6f2] lg:flex">
      <div className="px-5 pb-3 pt-5">
        <div className="text-[15px] font-semibold text-white">{APP_NAME}</div>
        <div className="text-[11px] text-[#9db6d4]">{APP_OWNER}</div>
      </div>
      <div className="border-b border-[#2c4c74] px-5 pb-3 text-[11px] text-[#9db6d4]">
        {APP_PHASE}
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        {NAV.map((group) => {
          const open = active.group === group.key;
          const isLeaf = !group.children;
          const headingOn = open && (isLeaf || active.item === group.key);

          return (
            <div key={group.key} className="mb-0.5">
              <Link
                href={group.href}
                title={group.hint}
                aria-current={headingOn ? "page" : undefined}
                className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-[13px] ${
                  headingOn
                    ? "bg-white font-semibold text-[var(--color-brand)]"
                    : open
                      ? "font-semibold text-white"
                      : "text-[#cfdcec] hover:bg-[#28496f] hover:text-white"
                }`}
              >
                <span>{group.label}</span>
                {group.children && (
                  <span className="text-[10px] text-[#9db6d4]">{open ? "▾" : "▸"}</span>
                )}
              </Link>

              {/* children appear only for the area you are in, so the list stays short */}
              {open && group.children && (
                <div className="mb-1 ml-3 border-l border-[#2c4c74] pl-2">
                  {group.children.map((item) => {
                    const on = active.item === item.key;
                    return (
                      <Link
                        key={item.key}
                        href={item.href}
                        title={item.hint}
                        aria-current={on ? "page" : undefined}
                        className={`mt-0.5 block rounded-lg px-3 py-1.5 text-[12px] ${
                          on
                            ? "bg-white font-semibold text-[var(--color-brand)]"
                            : "text-[#b9cbe2] hover:bg-[#28496f] hover:text-white"
                        }`}
                      >
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-[#2c4c74] p-4 text-[11px] text-[#8fa9c8]">
        Works alongside Tally and the e-Invoice process.
        <br />
        Enter once, reuse everywhere.
      </div>
    </aside>
  );
}

/**
 * The same navigation on a narrow screen: the five areas as chips, then the
 * current area's screens underneath — the same "only what you need" rule.
 */
export function MobileNav() {
  const active = useActive();
  const group = NAV.find((g) => g.key === active.group);

  return (
    <div className="mb-4 lg:hidden">
      <div className="flex flex-wrap gap-1.5">
        {NAV.map((g) => (
          <Link
            key={g.key}
            href={g.href}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
              active.group === g.key
                ? "bg-[var(--color-brand)] text-white"
                : "border border-[var(--color-line)] bg-white text-[var(--color-brand)]"
            }`}
          >
            {g.label}
          </Link>
        ))}
      </div>

      {group?.children && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {group.children.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className={`rounded-lg px-2.5 py-1 text-[11px] ${
                active.item === item.key
                  ? "bg-[var(--color-mute-bg)] font-semibold text-[var(--color-brand)]"
                  : "text-[var(--color-ink-2)] hover:text-[var(--color-brand)]"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
