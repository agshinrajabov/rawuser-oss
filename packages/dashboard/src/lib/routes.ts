/**
 * Dashboard v2 (design/mock/dashboard-v2, section 00): eleven items became
 * four plus Settings. The old routes stay as addresses: a customer is sent
 * to the new home, a superadmin keeps the old screen as an admin tool.
 * The static export cannot redirect on the server, so each old page sends
 * the browser on (components/shell/OldRoute.tsx). /onboard is not here:
 * the Pages card sends a customer there to fix a part, and Settings links to
 * it. /dna stays too (Settings opens it to edit the brief). Pure, tested.
 */

export interface OldRoute {
  /** Where a customer goes. */
  to: string;
  /** The superadmin keeps the old screen (an admin tool). */
  adminKeeps: boolean;
}

export const OLD_ROUTES: Record<string, OldRoute> = {
  "/analytics": { to: "/visitors", adminKeeps: true },
  "/variants": { to: "/versions", adminKeeps: true },
  "/conversions": { to: "/test", adminKeeps: true },
  "/intents": { to: "/versions", adminKeeps: true },
  "/links": { to: "/settings?tab=links", adminKeeps: true },
  "/account": { to: "/settings?tab=account", adminKeeps: false },
};

/**
 * Where the browser goes from an old route, with the query kept (the new
 * address's own query first), or null to stay.
 */
export function redirectFor(path: string, query: string, superadmin: boolean): string | null {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const r = OLD_ROUTES[p];
  if (!r) return null;
  if (superadmin && r.adminKeeps) return null;
  const [base, own] = r.to.split("?");
  const params = new URLSearchParams(own ?? "");
  for (const [k, v] of new URLSearchParams(query)) if (!params.has(k)) params.set(k, v);
  // A customer's own id is forced by the shell; keep it anyway for a superadmin.
  const qs = params.toString();
  return qs ? `${base}?${qs}` : (base as string);
}

/** The Settings tabs, in the mock's order. */
export const SETTINGS_TABS = ["install", "brief", "links", "account"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const SETTINGS_TAB_LABEL: Record<SettingsTab, string> = {
  install: "Install",
  brief: "Product brief",
  links: "Campaign links",
  account: "Account",
};

export function parseSettingsTab(raw: string | null): SettingsTab {
  return SETTINGS_TABS.includes(raw as SettingsTab) ? (raw as SettingsTab) : "install";
}

/** The address with the customer kept, for links inside the app. */
export function withCustomer(href: string, customerId: string | null | undefined): string {
  if (!customerId) return href;
  const [base, qs] = href.split("?");
  const params = new URLSearchParams(qs ?? "");
  params.set("customer_id", customerId);
  return `${base}?${params.toString()}`;
}
