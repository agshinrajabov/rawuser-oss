"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { type SessionUser, clearSession } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Menu } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import { AccountMenu } from "./AccountMenu";
import { useCurrentUser } from "./CurrentUserContext";
import { useCustomerList } from "./CustomerListContext";
import { TopbarSlotContext } from "./TopbarSlotContext";

/**
 * Account-button label shown in the topbar right cluster.
 *
 * superadmin → "admin · <email>"
 * customer   → "<customer_slug> · <email>"
 * (Falls back to "—" while the user is still loading.)
 *
 * If the combined string exceeds 32 chars, drops the email's @-domain;
 * if still too long, falls back to the left side alone. Keeps the topbar
 * from wrapping on long emails like multi-word.tenant+qa@some-long-domain.
 */
const ACCOUNT_LABEL_MAX = 32;

function buildAccountLabel(user: SessionUser | null): string {
  if (!user) return "-";
  const left = user.role === "superadmin" ? "admin" : (user.customer_id ?? "customer");
  const combined = `${left} · ${user.email}`;
  if (combined.length <= ACCOUNT_LABEL_MAX) return combined;
  const localPart = user.email.split("@")[0] ?? user.email;
  const shortened = `${left} · ${localPart}`;
  if (shortened.length <= ACCOUNT_LABEL_MAX) return shortened;
  return left;
}

interface TopbarProps {
  onMenuToggle?: () => void;
}

// User-language labels (ADR 0024). Kept in sync with the sidebar renames.
const BREADCRUMB_MAP: Record<string, string> = {
  "/": "Overview",
  "/visitors": "Visitors",
  "/versions": "Versions",
  "/test": "Test",
  "/settings": "Settings",
  "/help": "Help",
  "/admin/portfolio": "Portfolio",
  "/analytics": "Results, full",
  "/dna": "Product brief",
  "/variants": "Page versions",
  "/intents": "Visitor intents",
  "/links": "Campaign links",
  "/onboard": "Connect page",
  "/start": "Guided setup",
  "/conversions": "Goals",
  "/customers": "Customers",
  "/pilots": "Pilot requests",
  "/applications": "Applications",
  "/audit": "Audit",
};

function getBreadcrumb(raw: string): string {
  const pathname = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
  if (BREADCRUMB_MAP[pathname]) return BREADCRUMB_MAP[pathname];
  const match = Object.keys(BREADCRUMB_MAP).find((k) => pathname.startsWith(`${k}/`));
  return match !== undefined ? (BREADCRUMB_MAP[match] ?? "") : "";
}

// These paths don't use the per-customer dropdown — either they're global views
// or they have their own customer-scope mechanism (e.g. /admin/portfolio).
const HIDE_SELECT_PATHS = [
  "/customers",
  "/pilots",
  "/applications",
  "/links",
  "/admin/portfolio",
  "/account",
  "/help",
];

/** The static export serves "/account/": compare without the trailing slash. */
function hidesSelect(pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return HIDE_SELECT_PATHS.includes(p);
}

function CustomerSelect() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { customers, loading } = useCustomerList();
  const { user } = useCurrentUser();

  const currentId = searchParams.get("customer_id") ?? "";
  const isCustomerRole = user?.role === "customer";

  React.useEffect(() => {
    if (hidesSelect(pathname)) return;
    // For customer-role users the customer_id is forced to their own.
    // This also auto-corrects if the URL was hand-edited to another id.
    if (isCustomerRole && user?.customer_id) {
      if (currentId !== user.customer_id) {
        const params = new URLSearchParams(searchParams.toString());
        params.set("customer_id", user.customer_id);
        router.replace(`${pathname}?${params.toString()}`);
      }
      return;
    }
    // Home defaults to the operator fleet snapshot (no customer selected). Don't
    // auto-jump into a single customer's context — let them choose from the top bar.
    if (pathname === "/") return;
    if (loading) return;
    if (customers.length === 0) return;
    if (currentId) return;
    const first = customers[0];
    if (!first) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("customer_id", first.id);
    router.replace(`${pathname}?${params.toString()}`);
  }, [loading, customers, currentId, pathname, router, searchParams, isCustomerRole, user]);

  if (hidesSelect(pathname)) return null;
  // Customer role: switcher is hidden (one tenant, no choice to make).
  if (isCustomerRole) return null;

  function handleChange(value: string) {
    if (value === "__all__") {
      router.push("/customers");
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("customer_id", value);
    router.push(`${pathname}?${params.toString()}`);
  }

  const selectValue = currentId || "";

  return (
    <Select
      value={selectValue}
      onValueChange={handleChange}
      disabled={loading && customers.length === 0}
    >
      <SelectTrigger className="h-input-sm w-[160px] text-sm">
        <SelectValue placeholder={loading ? "Loading…" : "Select customer"} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">All customers</SelectItem>
        {loading && customers.length === 0 ? (
          <SelectItem value="__loading__" disabled>
            Loading…
          </SelectItem>
        ) : customers.length === 0 ? (
          <SelectItem value="__none__" disabled>
            No customers
          </SelectItem>
        ) : (
          customers.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.slug}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}

export function Topbar({ onMenuToggle }: TopbarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { rightSlot } = React.useContext(TopbarSlotContext);
  const { user } = useCurrentUser();
  const breadcrumb = getBreadcrumb(pathname);
  const isCustomer = user?.role === "customer";
  const accountLabel = buildAccountLabel(user);

  function handleLogout() {
    // Ends the session on the server too, and tells the other tabs.
    clearSession();
    router.push("/login");
  }

  return (
    <TooltipProvider>
      <header
        className={cn(
          "flex items-center justify-between",
          "h-topbar-h px-4 shrink-0",
          "border-b border-border bg-bg",
        )}
      >
        {/* Left cluster */}
        <div className="flex items-center gap-2 min-w-0">
          {/* Mobile hamburger */}
          {onMenuToggle && (
            <button
              type="button"
              onClick={onMenuToggle}
              aria-label="Toggle menu"
              className="lg:hidden p-1.5 -ml-1 rounded-sm text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors duration-fast ease-smooth"
            >
              <Menu size={16} />
            </button>
          )}

          {/* Customer switcher */}
          <React.Suspense fallback={null}>
            <CustomerSelect />
          </React.Suspense>

          {/* Vertical separator and breadcrumb: from sm up; on a phone the
              page's own heading names the screen and the picker keeps its room. */}
          {!isCustomer && (
            <div className="mx-1 hidden h-4 w-px shrink-0 bg-border sm:block" aria-hidden />
          )}

          {breadcrumb && (
            <span
              className={cn(
                "truncate text-[13px] font-medium text-fg",
                !isCustomer && "hidden sm:inline",
              )}
            >
              {breadcrumb}
            </span>
          )}
        </div>

        {/* Right cluster */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Screen-level right slot (screens register actions here) */}
          {rightSlot && (
            <>
              <div data-topbar-slot="right" className="flex items-center gap-2">
                {rightSlot}
              </div>
              <div className="h-4 w-px bg-border mx-1 shrink-0" aria-hidden />
            </>
          )}

          {/* Account menu: Account and Sign out (two-step mock §03) */}
          <AccountMenu label={accountLabel} email={user?.email ?? null} onSignOut={handleLogout} />
        </div>
      </header>
    </TooltipProvider>
  );
}
