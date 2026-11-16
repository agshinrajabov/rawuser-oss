"use client";

import { AuditEndedGate } from "@/components/audit/AuditEndedGate";
import { AuthGuard } from "@/components/auth/AuthGuard";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { CurrentUserProvider } from "./CurrentUserContext";
import { CustomerListProvider } from "./CustomerListContext";
import { RecoveryLine } from "./RecoveryLine";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { TopbarSlotProvider } from "./TopbarSlotContext";

interface AppShellProps {
  children: React.ReactNode;
}

/**
 * Banner shown when an operator clicks "View as customer" on the portfolio
 * grid. The link adds `?as_customer=<slug>` to the analytics URL; this
 * banner reminds the operator they're inspecting a tenant's view and
 * provides the Exit affordance.
 *
 * Wrapped in Suspense because useSearchParams() forces dynamic rendering
 * during the Next.js static-pre-render pass.
 */
function ViewAsBanner() {
  const params = useSearchParams();
  const pathname = usePathname();
  const asCustomer = params.get("as_customer");
  if (!asCustomer) return null;
  return (
    <output className="border-b border-border bg-surface-muted px-content-px py-2 flex items-center justify-between text-xs">
      <span className="text-fg">
        Viewing as: <span className="font-medium">{asCustomer}</span>
      </span>
      <Link
        href="/admin/portfolio"
        className="text-fg-muted hover:text-fg underline underline-offset-2 hover:no-underline transition-colors duration-fast ease-smooth"
        data-pathname={pathname}
      >
        Exit view-as mode
      </Link>
    </output>
  );
}

export function AppShell({ children }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close mobile sidebar when resizing to lg
  useEffect(() => {
    function handleResize() {
      if (window.innerWidth >= 1024) {
        setSidebarOpen(false);
      }
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <AuthGuard>
      <CurrentUserProvider>
        <CustomerListProvider>
          <TopbarSlotProvider>
            <AuditEndedGate>
              <div className="flex h-dvh overflow-hidden bg-bg">
                {/* Persistent sidebar — lg+ only */}
                <div className="hidden lg:flex shrink-0">
                  <Sidebar />
                </div>

                {/* Mobile sidebar overlay + drawer */}
                {sidebarOpen && (
                  <>
                    {/* Scrim: the ink at 12%, no blur (--scrim) */}
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label="Close menu"
                      className="fixed inset-0 z-40 bg-scrim lg:hidden cursor-default"
                      onClick={() => setSidebarOpen(false)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" || e.key === "Enter") setSidebarOpen(false);
                      }}
                    />
                    {/* Drawer */}
                    <div className="fixed inset-y-0 left-0 z-50 lg:hidden border-r border-border bg-bg">
                      <Sidebar onClose={() => setSidebarOpen(false)} />
                    </div>
                  </>
                )}

                {/* Main area */}
                <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
                  <Topbar onMenuToggle={() => setSidebarOpen((prev) => !prev)} />
                  <Suspense fallback={null}>
                    <ViewAsBanner />
                  </Suspense>
                  <main className="flex-1 overflow-y-auto px-content-px py-content-py animate-fade-in">
                    <RecoveryLine />
                    {children}
                  </main>
                </div>
              </div>
            </AuditEndedGate>
          </TopbarSlotProvider>
        </CustomerListProvider>
      </CurrentUserProvider>
    </AuthGuard>
  );
}
