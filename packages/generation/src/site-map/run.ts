/**
 * One site-map read (docs/specs/site-shaped-intents.md §4, §9): the links of
 * one or more pages already in hand, the rules in four languages, one model
 * call for what the rules leave, stored, the served set computed again and
 * the visitor bundle written. Offline only; never in the visitor path.
 *
 * Who calls it:
 * - the quickstart (the operator's capture, the other languages' pages it
 *   fetches, "Add this page", "Read the page again");
 * - a generation run's live read of a confirmed page (the moment
 *   `manifest_health` is written), at most once a day per page;
 * - the weekly fetch of a live customer's homepage (weekly.ts).
 *
 * Nothing runs when the customer turned the map off (condition 5). A page
 * whose own path holds an identifier gives nothing (condition 1). Logs are
 * counts only (condition 6).
 */

import {
  type Manifest,
  type SiteKindOrNone,
  labelToKeep,
  langPrefix,
  normalizePath,
  pathHoldsIdentifier,
  ruleKind,
  stripNonContent,
  textHasPrice,
} from "@rawuser/shared";
import type { CallEnv } from "../call-model.ts";
import type { InstallEnv } from "../install-config.ts";
import { type SiteModelCall, mapLinksWithModel } from "./model.ts";
import { type ReadLink, readSiteLinks } from "./read-links.ts";
import {
  type MappedLink,
  type ServedChange,
  loadSiteState,
  purgeMissing,
  recomputeServed,
  storeRead,
  writeSiteBundle,
} from "./store.ts";

/** Set on every read; the weekly fetch skips a customer that has one. */
export function siteReadKey(customerId: string): string {
  return `v1:sitemap:read:${customerId}`;
}
const READ_MARK_TTL_S = 7 * 24 * 60 * 60;

/** With BOT_INFO_URL: the weekly read goes out under the install's user agent. */
export type SiteEnv = CallEnv & { DB: D1Database; VARIANTS: KVNamespace } & Pick<
    InstallEnv,
    "BOT_INFO_URL" | "SITE_RESOLVER"
  >;

export interface SitePage {
  /** The page path the links were read on (found_on). */
  pagePath: string;
  /** The URL the page was read at; its host is the only host kept. */
  pageUrl: string;
  html: string;
  manifest: Manifest | null;
  lang: string | null;
  /** The operator's capture (maybe signed in) or our cookie-less server read. */
  source: "capture" | "fetch";
}

export interface SiteReadResult {
  skipped?: "off" | "no_pages";
  links: number;
  mapped: number;
  model_asked: number;
  cost_usd: number;
  served: ServedChange | null;
}

/**
 * Reads, maps and stores the links of the given pages, then the served set
 * and the bundle. Never throws: a failure leaves the map as it was and the
 * global table applies, as before.
 */
export async function runSiteRead(
  env: SiteEnv,
  customerId: string,
  pages: readonly SitePage[],
  opts: { product: string; now?: number; call?: SiteModelCall },
): Promise<SiteReadResult> {
  const now = opts.now ?? Date.now();
  const empty: SiteReadResult = { links: 0, mapped: 0, model_asked: 0, cost_usd: 0, served: null };
  try {
    const state = await loadSiteState(env.DB, customerId);
    if (state.off) return { ...empty, skipped: "off" };
    // A page whose own path names one record keeps nothing (condition 1).
    const usable = pages.filter((p) => !pathHoldsIdentifier(p.pagePath));
    if (usable.length === 0) return { ...empty, skipped: "no_pages" };

    const byPath = new Map(state.rows.map((r) => [r.path, r]));
    const reads = usable.map((p) => {
      const foundOn = normalizePath(p.pagePath);
      const read = readSiteLinks(p.html, p.pageUrl, p.manifest, p.lang);
      return {
        page: p,
        foundOn,
        read,
        rules: read.links.map((l) => ruleKind(l)),
        priceOnPage: textHasPrice(visibleText(p.html)),
      };
    });

    // What the rules leave, once per path across the pages; a path the
    // model mapped before keeps its kind and is not asked again. Never from
    // a capture (privacy review re-review, §13.2 point 2): the operator's browser
    // may be signed in and nobody chose the link, so a link the rules do
    // not name is neither sent nor stored; a cookie-less read maps it later.
    const forModel: ReadLink[] = [];
    const asked = new Set<string>();
    for (const r of reads) {
      if (r.page.source === "capture") continue;
      r.read.links.forEach((l, i) => {
        if (r.rules[i]?.kind) return;
        if (asked.has(l.path)) return;
        const prior = byPath.get(l.path);
        if (prior && (prior.confidence === "model" || prior.confidence === "operator")) return;
        asked.add(l.path);
        forModel.push(l);
      });
    }
    const model =
      forModel.length > 0
        ? await mapLinksWithModel(forModel, opts.product, env, opts.call)
        : { kinds: new Map<string, SiteKindOrNone>(), costUsd: 0 };

    let links = 0;
    let mapped = 0;
    let unmapped = 0;
    let captureSkipped = 0;
    const pricePages = new Map<string, boolean>();
    for (const r of reads) {
      const capture = r.page.source === "capture";
      const out: MappedLink[] = r.read.links.map((l, i) => {
        const rule = r.rules[i];
        const textKinds = rule?.textKinds ?? [];
        const skip = { path: l.path, lang: l.lang, kind: null, confidence: null, label: null };
        // A capture keeps only what its own words name. A kind from the path
        // alone on a deeper path (/customers/jane-doe, /projects/acme) can
        // name one person's record in a signed-in header: dropped.
        if (capture && (!rule?.kind || (textKinds.length === 0 && pathDepth(l.path) > 1))) {
          captureSkipped++;
          return skip;
        }
        if (rule?.kind && rule.confidence) {
          return {
            path: l.path,
            lang: l.lang,
            kind: rule.kind,
            confidence: rule.confidence,
            label: labelToKeep(r.page.source, l.text, rule.kind, textKinds),
          };
        }
        const prior = byPath.get(l.path);
        if (prior && prior.confidence === "model" && !model.kinds.has(l.path)) {
          return {
            path: l.path,
            lang: prior.lang,
            kind: prior.kind,
            confidence: "model",
            label: prior.label,
          };
        }
        const k = model.kinds.get(l.path);
        if (k === undefined) {
          return { path: l.path, lang: l.lang, kind: null, confidence: null, label: null };
        }
        if (k === "none") {
          return { path: l.path, lang: l.lang, kind: "none", confidence: "model", label: null };
        }
        return {
          path: l.path,
          lang: l.lang,
          kind: k,
          confidence: "model",
          label: labelToKeep(r.page.source, l.text, k, textKinds),
        };
      });
      links += out.length;
      mapped += out.filter((m) => m.kind !== null && m.kind !== "none").length;
      unmapped += out.filter((m) => m.kind === null).length;
      // Before go live a capture's own words may fold an intent (the Look
      // screen shows it and Change undoes it); on a live site only a
      // cookie-less read that saw every link may shrink the served set.
      if (!state.live) unmapped -= captureSkipped;
      captureSkipped = 0;
      const fresh = await loadSiteState(env.DB, customerId);
      await storeRead(
        env.DB,
        customerId,
        fresh,
        {
          foundOn: r.foundOn,
          complete: r.read.complete,
          links: out,
          priceOnPage: r.priceOnPage,
        },
        now,
      );
      pricePages.set(r.foundOn, r.priceOnPage);
    }
    await purgeMissing(env.DB, customerId, now);
    const served = await recomputeServed(env.DB, customerId, {
      now,
      mode: "auto",
      pricePages,
      noShrink: unmapped > 0,
    });
    await writeSiteBundle(env, customerId);
    try {
      await env.VARIANTS.put(siteReadKey(customerId), String(now), {
        expirationTtl: READ_MARK_TTL_S,
      });
    } catch {
      // The weekly fetch reads once more; nothing else depends on the mark.
    }
    console.log(
      `[site-map] read: pages=${reads.length} links=${links} mapped=${mapped} asked=${forModel.length}`,
    );
    return {
      links,
      mapped,
      model_asked: forModel.length,
      cost_usd: model.costUsd,
      served,
    };
  } catch (e) {
    console.error(
      "[site-map] read failed (non-critical):",
      e instanceof Error ? e.name : "unknown",
    );
    return empty;
  }
}

/** Once a day per page for the generation run's live reads. */
export function rereadKey(customerId: string, pagePath: string): string {
  return `v1:sitemap:reread:${customerId}:${pagePath}`;
}
const REREAD_TTL_S = 24 * 60 * 60;

/**
 * The hook a generation run's live read calls with the page it just read
 * (inline-shape-backfill.ts, where `manifest_health` is written): the links
 * are read again at most once a day per page, as a cookie-less server read.
 */
export function siteRereadHook(env: SiteEnv, customerId: string) {
  return async (
    pagePath: string,
    pageUrl: string,
    html: string,
    manifest: Manifest,
    lang: string | null,
  ): Promise<void> => {
    try {
      const key = rereadKey(customerId, pagePath);
      if ((await env.VARIANTS.get(key)) !== null) return;
      await env.VARIANTS.put(key, "1", { expirationTtl: REREAD_TTL_S });
    } catch {
      return;
    }
    const product = await loadProductLine(env.DB, customerId);
    await runSiteRead(
      env,
      customerId,
      [{ pagePath, pageUrl, html, manifest, lang, source: "fetch" }],
      { product },
    );
  };
}

/** The brief's one-line product description, the only brief text the model sees. */
export async function loadProductLine(db: D1Database, customerId: string): Promise<string> {
  try {
    const row = await db
      .prepare("SELECT product FROM business_dna WHERE customer_id = ?")
      .bind(customerId)
      .first<{ product: string | null }>();
    return row?.product ?? "";
  } catch {
    return "";
  }
}

/** The page's visible words, enough to see a price: scripts, styles and markup removed. */
function visibleText(html: string): string {
  return stripNonContent(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** Segments after a language prefix: `/az/work/portal` → 2, `/pricing` → 1. */
function pathDepth(path: string): number {
  const segs = path.split("/").filter((x) => x.length > 0);
  const prefix = langPrefix(path);
  return prefix && segs[0] === prefix ? segs.length - 1 : segs.length;
}
