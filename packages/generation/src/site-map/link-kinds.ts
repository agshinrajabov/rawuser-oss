/**
 * What a button's link does, read from the customer's own site map when the
 * link's own words say nothing (the first outside pilot, 2026-10-12,
 * docs/specs/pilot-gaps.md A1.3): the hero button goes to `/products`,
 * a word the button tables do not hold, while the site map already holds
 * `/products` as `features`.
 *
 * Offline only, inside one customer (site-shaped intents, privacy review condition
 * 6): the path is matched in memory and only the kind leaves this module,
 * as a button kind for the lint and the prompt. No path and no link text
 * goes to a model, a flag, a log or a visitor.
 *
 * Rows the rules or the operator named only. A row the model guessed is not
 * used: a wrong guess would become a hard flag on a counted button and
 * steer every version to the wrong kind of label; without a row the button
 * is `unread` and is held to its own label instead.
 */

import { type SitePathRow, normalizePath, siteEntryFor, sitePathMap } from "@rawuser/shared";
import { sameSite, siteHost } from "../lib/public-url.ts";
import { type CtaKind, ctaKindsOfSiteKind } from "../lint/cta-action.ts";

/** The button kinds the site map allows for a link; empty when it says nothing. */
export type LinkKinds = (href: string | undefined) => readonly CtaKind[];

export const NO_LINK_KINDS: LinkKinds = () => [];

/** One read per run; the customer's switch is checked in the same statement. */
export const LINK_KINDS_SQL =
  "SELECT p.path, p.kind, p.confidence FROM site_paths p JOIN customers c ON c.id = p.customer_id WHERE p.customer_id = ? AND c.site_map_off = 0";

/**
 * The lookup over a customer's rows. Only a link to the customer's own host
 * is read (`www.` folded); without a recorded domain, only a relative link.
 * A deeper page takes its parent's kind, as the edge reads the map.
 */
export function linkKindsFrom(rows: readonly SitePathRow[], domain: string | null): LinkKinds {
  const pm = sitePathMap(rows.filter((r) => r.confidence !== "model"));
  if (Object.keys(pm).length === 0) return NO_LINK_KINDS;
  const host = domain ? siteHost(domain) : "";
  const base = `https://${host || "page.invalid"}/`;
  return (href) => {
    const h = href?.trim();
    if (!h || h.startsWith("#")) return [];
    let url: URL;
    try {
      url = new URL(h, base);
    } catch {
      return [];
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    if (host ? !sameSite(url.hostname, host) : url.hostname !== "page.invalid") return [];
    const entry = siteEntryFor(pm, normalizePath(url.pathname));
    return entry ? ctaKindsOfSiteKind(entry.kind) : [];
  };
}

/** The customer's lookup; says nothing when the map is off, empty or not there. */
export async function loadLinkKinds(
  customerId: string,
  domain: string | null,
  db: D1Database,
): Promise<LinkKinds> {
  try {
    const rows = await db.prepare(LINK_KINDS_SQL).bind(customerId).all<SitePathRow>();
    return linkKindsFrom(
      (rows.results ?? []).filter((r) => typeof r?.path === "string"),
      domain,
    );
  } catch {
    // No table in a test double or before migration 0037: the map says nothing.
    return NO_LINK_KINDS;
  }
}
