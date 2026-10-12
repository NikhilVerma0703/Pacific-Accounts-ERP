import { MobileNav, Sidebar } from "@/components/Sidebar";

/**
 * The application shell.
 *
 * Nothing here reads the request, which is the point: a layout that reads headers
 * or cookies is dynamic, and a dynamic layout is re-rendered and re-sent on every
 * navigation. This one is static, so the router keeps it mounted and only swaps
 * the content area — the sidebar does not flicker and does not cost a round trip.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="min-w-0 flex-1 px-6 pb-16 pt-6 lg:px-8">
        <MobileNav />
        {children}
      </main>
    </div>
  );
}
