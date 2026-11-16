"use client";

import { Brand } from "@/components/shell/Brand";
import { Separator } from "@/components/ui/Separator";
import { withCustomer } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { CustomerListItem } from "@/types/api";
import {
  BarChart2,
  ClipboardList,
  Compass,
  FileText,
  FlaskConical,
  HelpCircle,
  Home,
  Inbox,
  Layers,
  LayoutGrid,
  Link2,
  Plug,
  SlidersHorizontal,
  Target,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useCurrentUser } from "./CurrentUserContext";
import { useCustomerList } from "./CustomerListContext";
import { useWaitingCount } from "./useWaitingCount";

interface SidebarProps {
  onClose?: () => void;
}

/**
 * Dashboard v2 (design/mock/dashboard-v2, section 00): four screens a
 * customer reads without us in the room (Overview, Visitors, Versions,
 * Test), Settings and Help at the foot. The superadmin's own screens sit in
 * an Admin block a customer never sees; the old screens stay there as admin
 * tools (lib/routes.ts sends a customer from them to the new home).
 */
type NavLink = {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  superadminOnly?: boolean;
  /** Only for a customer whose account is a free audit (docs/specs/ai-traffic-audit.md). */
  auditOnly?: boolean;
  /** A quiet word at the right of the item ("free"). */
  tag?: string;
  /** The Versions count: versions waiting for an OK (absent until the API has the state). */
  waiting?: boolean;
};

type NavSection = {
  heading?: string;
  superadminOnly?: boolean;
  items: NavLink[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { href: "/", label: "Overview", icon: Home },
      { href: "/visitors", label: "Visitors", icon: Users },
      { href: "/versions", label: "Versions", icon: Layers, waiting: true },
      { href: "/test", label: "Test", icon: FlaskConical },
      { href: "/audit", label: "Audit", icon: FileText, auditOnly: true, tag: "free" },
    ],
  },
  {
    heading: "Admin",
    superadminOnly: true,
    items: [
      { href: "/customers", label: "Customers", icon: Users },
      { href: "/pilots", label: "Pilot requests", icon: Inbox },
      { href: "/applications", label: "Applications", icon: ClipboardList },
    ],
  },
  {
    heading: "Admin tools",
    superadminOnly: true,
    items: [
      { href: "/analytics", label: "Results, full", icon: BarChart2 },
      { href: "/variants", label: "Page versions", icon: LayoutGrid },
      { href: "/conversions", label: "Goals", icon: Target },
      { href: "/onboard", label: "Connect page", icon: Plug },
      { href: "/intents", label: "Visitor intents", icon: Compass },
      { href: "/links", label: "Campaign links, full", icon: Link2 },
    ],
  },
];

const NAV_BOTTOM: NavLink[] = [
  { href: "/settings", label: "Settings", icon: SlidersHorizontal },
  { href: "/help", label: "Help", icon: HelpCircle },
];

/**
 * The sections a role sees: a customer gets no Admin block, the audit item
 * only on an audit. `isLive` is kept for callers; the four screens show for
 * every customer (a customer who is not live is on /start, the first run).
 */
export function visibleNav({
  isCustomer,
  isAudit,
}: {
  isCustomer: boolean;
  isAudit: boolean;
  isLive?: boolean;
}): NavSection[] {
  return NAV_SECTIONS.map((section) => {
    if (section.superadminOnly && isCustomer) return null;
    const items = section.items.filter(
      (item) => !(item.superadminOnly && isCustomer) && !(item.auditOnly && !isAudit),
    );
    if (items.length === 0) return null;
    return { ...section, items };
  }).filter((s): s is NavSection => s !== null);
}

/** The foot: Settings and Help, for everyone. Help is an email, never a repository. */
export function bottomNav(): NavLink[] {
  return NAV_BOTTOM;
}

export function isItemActive(pathname: string, href: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (href === "/") return p === "/";
  return p === href || p.startsWith(`${href}/`);
}

/** "acme.com" from a stored domain that may carry a scheme or a path. */
export function siteHost(domain: string | null | undefined): string {
  return (domain ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function NavItem({
  item,
  href,
  isActive,
  onClose,
  count,
}: {
  item: NavLink;
  href: string;
  isActive: boolean;
  onClose?: () => void;
  count?: number;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={href}
      onClick={onClose}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "relative -ml-px flex h-8 select-none items-center gap-2.5 border-l-2 pl-[calc(0.75rem+1px)] pr-3 text-[13px]",
        "transition-colors duration-fast ease-smooth",
        isActive
          ? "border-fg bg-surface-muted text-fg"
          : "border-transparent text-fg-muted hover:bg-surface-muted hover:text-fg",
      )}
    >
      <Icon size={16} strokeWidth={1.75} className={isActive ? "text-fg" : "text-fg-muted"} />
      <span>{item.label}</span>
      {item.tag && <span className="ml-auto text-[10.5px] text-fg-faint">{item.tag}</span>}
      {count !== undefined && count > 0 && (
        <span
          className="ml-auto rounded-pill border border-border-strong bg-surface px-1.5 font-mono text-[10.5px] leading-4 text-fg"
          title={`${count} waiting for your OK`}
        >
          {count}
        </span>
      )}
    </Link>
  );
}

/** The site card under the wordmark: the customer's site and whether it is live. */
export function SiteCard({ customer }: { customer: CustomerListItem | undefined }) {
  if (!customer) return null;
  const host = siteHost(customer.domain) || customer.slug;
  const live = Boolean(customer.live_at);
  return (
    <div className="mx-3 mb-1 mt-3 flex items-center gap-2.5 rounded-md border border-border bg-surface px-2.5 py-2">
      <span
        aria-hidden
        className="h-[22px] w-[22px] flex-none rounded-[5px] bg-fg text-center text-[11px] font-semibold leading-[22px] text-cta-fg"
      >
        {(host.charAt(0) || "?").toUpperCase()}
      </span>
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-medium leading-tight text-fg">{host}</div>
        <div className="flex items-center gap-[5px] text-[11px] text-fg-muted">
          <i
            aria-hidden
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              live ? "bg-state-success" : "bg-fg-faint",
            )}
          />
          {live ? "Live" : "Not live yet"}
        </div>
      </div>
    </div>
  );
}

function SidebarInner({ onClose }: SidebarProps) {
  const pathname = usePathname();
  const params = useSearchParams();
  const { user } = useCurrentUser();
  const isCustomer = user?.role === "customer";
  const { customers } = useCustomerList();
  const currentId = isCustomer ? (user?.customer_id ?? "") : (params.get("customer_id") ?? "");
  const mine = customers.find((c) => c.id === currentId);
  const isAudit = isCustomer && mine?.plan === "audit";
  const sections = visibleNav({ isCustomer, isAudit });
  const waiting = useWaitingCount(currentId);
  // A superadmin moves between screens on the customer picked in the top bar.
  const link = (href: string) => (isCustomer ? href : withCustomer(href, currentId || null));

  return (
    <aside className="flex h-full w-sidebar-w flex-col border-r border-border bg-bg">
      <div className="flex h-topbar-h shrink-0 items-center justify-between px-4">
        <Link
          href={link("/")}
          className="text-[13px] font-semibold leading-none tracking-tight text-fg"
        >
          <Brand />
        </Link>
        {onClose && (
          <button
            onClick={onClose}
            type="button"
            aria-label="Close menu"
            className="rounded-sm p-1 text-fg-muted transition-colors duration-fast ease-smooth hover:bg-surface-muted hover:text-fg lg:hidden"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <Separator />
      <SiteCard customer={mine} />

      <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2">
        {sections.map((section, i) => (
          <div key={section.heading ?? `top-${i}`} className={cn(i > 0 && "mt-4")}>
            {section.heading && (
              <div className="select-none px-3 pb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-faint">
                {section.heading}
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <NavItem
                  key={item.href}
                  item={item}
                  href={section.heading === "Admin" ? item.href : link(item.href)}
                  isActive={isItemActive(pathname, item.href)}
                  onClose={onClose}
                  count={item.waiting ? waiting : undefined}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <Separator />
      <div className="flex flex-col gap-0.5 px-3 py-2">
        {NAV_BOTTOM.map((item) => (
          <NavItem
            key={item.href}
            item={item}
            href={item.href === "/help" ? item.href : link(item.href)}
            isActive={isItemActive(pathname, item.href)}
            onClose={onClose}
          />
        ))}
      </div>
    </aside>
  );
}

export function Sidebar(props: SidebarProps) {
  // useSearchParams needs a Suspense boundary in the static export.
  return (
    <Suspense fallback={<aside className="h-full w-sidebar-w border-r border-border bg-bg" />}>
      <SidebarInner {...props} />
    </Suspense>
  );
}
