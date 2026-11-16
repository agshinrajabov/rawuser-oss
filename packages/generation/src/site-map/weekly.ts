/**
 * The six-hourly site-map sweep (docs/specs/site-shaped-intents.md §9, the
 * mock's call 6, privacy review condition 4):
 *
 * 1. A growth of the served set unanswered for 7 days is written by itself.
 * 2. Rows missing for 30 days are removed; the served set follows.
 * 3. A live customer with the map on and no read in 7 days gets one fetch
 *    of its public homepage: `publicOnly`, the recorded domain only, a
 *    redirect off that host ends it, no Browser Run, no credentials, our
 *    `FETCH_UA`; the HTML is read in memory and never kept. Trust pack:
 *    "Once a week, for a live site, our server fetches the site's public
 *    homepage once, without cookies, to notice pages added to or removed
 *    from its menus. It may count as one bot visit in the site's analytics."
 *
 * No alert: a change is the customer's site working, not an incident.
 * Logs are counts only.
 */

import type { Manifest } from "@rawuser/shared";
import { fetchPageHtml } from "../detect-elements.ts";
import { fetcherUserAgent } from "../install-config.ts";
import type { SiteResolver } from "../lib/public-url.ts";
import { type SiteEnv, type SitePage, loadProductLine, runSiteRead, siteReadKey } from "./run.ts";
import {
  PENDING_AUTO_MS,
  applyPending,
  loadSiteState,
  purgeMissing,
  recomputeServed,
  writeSiteBundle,
} from "./store.ts";

/** At most this many homepages are fetched in one sweep. */
export const WEEKLY_FETCHES_PER_SWEEP = 10;
/** The weekly read's HTML cap: large enough to reach the footer. */
const WEEKLY_MAX_BYTES = 400 * 1024;

export type HomepageFetch = (url: string, host: string) => Promise<string>;

/** The bounded fetch of condition 4, under the install's user agent. */
export function homepageFetcher(userAgent: string, resolver?: SiteResolver): HomepageFetch {
  return (url, host) =>
    fetchPageHtml(url, {
      publicOnly: true,
      resolver,
      sameHostAs: host,
      maxBytes: WEEKLY_MAX_BYTES,
      userAgent,
    });
}

export interface SweepResult {
  auto_written: number;
  purged: number;
  fetched: number;
  failed: number;
}

function bareDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

export async function runSiteMapSweep(
  env: SiteEnv,
  now: number = Date.now(),
  fetchHtml: HomepageFetch = homepageFetcher(fetcherUserAgent(env), env.SITE_RESOLVER),
): Promise<SweepResult> {
  const out: SweepResult = { auto_written: 0, purged: 0, fetched: 0, failed: 0 };
  const customers = await env.DB.prepare(
    `SELECT id, domain, live_at, served_reasons FROM customers
     WHERE site_map_off = 0 AND status != 'ended'
       AND (live_at IS NOT NULL OR served_reasons IS NOT NULL)`,
  ).all<{ id: string; domain: string; live_at: number | null; served_reasons: string | null }>();
  let fetches = 0;
  for (const c of customers.results ?? []) {
    try {
      // 1 and 2: the waiting growth, the old rows.
      const state = await loadSiteState(env.DB, c.id);
      let touched = false;
      const pending = state.reasons?.pending;
      if (pending && now - pending.since >= PENDING_AUTO_MS) {
        const r = await applyPending(env.DB, c.id, now);
        if (r.applied.length > 0) out.auto_written++;
        touched = true;
      }
      const purged = await purgeMissing(env.DB, c.id, now);
      if (purged > 0) {
        out.purged += purged;
        await recomputeServed(env.DB, c.id, { now, mode: "auto" });
        touched = true;
      }
      if (touched) await writeSiteBundle(env, c.id);

      // 3: the weekly read of a live homepage.
      if (c.live_at == null || fetches >= WEEKLY_FETCHES_PER_SWEEP) continue;
      if ((await env.VARIANTS.get(siteReadKey(c.id))) !== null) continue;
      const host = bareDomain(c.domain);
      if (!host.includes(".")) continue;
      fetches++;
      const url = `https://${host}/`;
      let html: string;
      try {
        html = await fetchHtml(url, host);
      } catch {
        out.failed++;
        // Try again next week, not every six hours.
        await env.VARIANTS.put(siteReadKey(c.id), String(now), {
          expirationTtl: 7 * 24 * 60 * 60,
        });
        continue;
      }
      const page: SitePage = {
        pagePath: "/",
        pageUrl: url,
        html,
        manifest: await homepageManifest(env.DB, c.id),
        lang: htmlLangOf(html),
        source: "fetch",
      };
      await runSiteRead(env, c.id, [page], {
        product: await loadProductLine(env.DB, c.id),
        now,
      });
      out.fetched++;
    } catch {
      out.failed++;
    }
  }
  return out;
}

function htmlLangOf(html: string): string | null {
  const m = /<html\b[^>]*\blang\s*=\s*["']?\s*([A-Za-z]{2,3})/i.exec(html);
  return m?.[1]?.toLowerCase() ?? null;
}

async function homepageManifest(db: D1Database, customerId: string): Promise<Manifest | null> {
  const row = await db
    .prepare(
      "SELECT manifest FROM element_manifests WHERE customer_id = ? AND page_path = '/' AND confirmed_at IS NOT NULL",
    )
    .bind(customerId)
    .first<{ manifest: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.manifest) as Manifest;
  } catch {
    return null;
  }
}
