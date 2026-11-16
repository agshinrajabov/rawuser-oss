/**
 * Site-shaped intents (docs/specs/site-shaped-intents.md): the customer's
 * own page names decide which path means which intent, and which intents
 * the site serves. This module holds what both workers share: the kinds,
 * the word tables, the screens and rules, the served set and the fold, and
 * the two visitor-bundle fields `pm` (path → kind and weight) and `sd`
 * (the served intents).
 *
 * Privacy (privacy review condition 6): a path and its link text never leave the
 * customer's scope. `pm` holds paths and kinds only, never a label; the
 * bundle never reaches a browser; nothing here logs.
 */

import { siteEntryFor } from "../classify/path-intent.ts";
import type { Signals } from "../types.ts";
import type { IntentDim } from "../vector/dimensions.ts";
import { CONFIDENCE_WEIGHT, type SiteConfidence, type SiteKindOrNone } from "./kinds.ts";

export * from "./kinds.ts";
export * from "./words.ts";
export * from "./rules.ts";
export * from "./served.ts";

/** The `pm` field: normalized path → [kind, weight]. */
export type SitePathMap = Record<string, [SiteKindOrNone, number]>;

/** A site_paths row as the bundle writers read it. */
export interface SitePathRow {
  path: string;
  kind: SiteKindOrNone;
  confidence: SiteConfidence;
}

/**
 * `pm` from the stored rows (spec §5): every row, an operator's `none`
 * included (it overrides the global table); a rules or model `none` is
 * never stored (privacy review condition 2), so it cannot reach here. Paths and
 * kinds only.
 */
export function sitePathMap(rows: readonly SitePathRow[]): SitePathMap {
  const out: SitePathMap = {};
  for (const r of rows) {
    if (r.kind === "none" && r.confidence !== "operator") continue;
    const w = CONFIDENCE_WEIGHT[r.confidence];
    if (w === undefined) continue;
    out[r.path] = [r.kind, w];
  }
  return out;
}

/** The part of a visitor bundle the site map reads. */
export interface SiteMapBundle {
  v: 1;
  pages: Record<string, unknown>;
  pm?: Record<string, readonly [string, number]>;
  sd?: IntentDim[];
}

/**
 * The visit's signals with the customer's map applied (spec §6.1, §6.2):
 * the map entry that covers the page and whether the page has its own
 * confirmed versions. Without a bundle, the signals as they were.
 */
export function withSiteMap(
  signals: Signals,
  bundle: SiteMapBundle | null | undefined,
  pagePath: string,
): Signals {
  if (bundle?.v !== 1) return signals;
  return {
    ...signals,
    sitePath: siteEntryFor(bundle.pm, pagePath),
    pageHasVersions: Object.prototype.hasOwnProperty.call(bundle.pages ?? {}, pagePath),
  };
}
