/**
 * Entry-path → intent/context mapping (L1 signal). See ADR 0023.
 *
 * The page a visitor chose to land on is an ambient intent proxy: a naked
 * direct arrival at /pricing has disclosed pricing intent even with no UTM,
 * referrer, or AI source. This is the cheap t=0 layer that shrinks the
 * "no_signal → original" cohort without any behavior tracking.
 *
 * Design constraints (deliberate):
 * - Weights are BELOW the UTM intent rules (0.65–0.75) so explicit tagging
 *   always dominates or ties in the visitor's favor. Path is a weaker prior
 *   than a hand-tagged campaign link.
 * - Some path families raise ONLY a context dim (demo/trial → urgency). Those
 *   do NOT qualify a naked visit for personalization — see pathCarriesIntent.
 *   This preserves the ADR 0006 invariant (demo/trial = urgency, not a
 *   category-research intent) and matches ADR 0017: an urgency-only visit
 *   would snap to the generic brand variant, i.e. no gain over the original,
 *   so it correctly stays original.
 * - Matched against the NORMALIZED path (normalizePath): lowercased, no query
 *   or fragment, no trailing slash except root.
 *
 * Single source of truth: both the classifier rules and hasMeaningfulSignal
 * read this table via the helpers below, so the gate and the scoring can
 * never drift.
 */

import {
  type KindDims,
  SITE_KIND_DIMS,
  type SiteKind,
  type SitePathEntry,
  kindCarriesIntent,
} from "../site-map/kinds.ts";
import type { ContextDim, IntentDim } from "../vector/dimensions.ts";

/** One entry-path pattern and the dims it raises. */
interface PathIntentEntry {
  /** Matched against the normalized path. */
  test: RegExp;
  /**
   * The site-map kind this entry stands for (docs/specs/site-shaped-intents.md
   * §4.4): a match here counts as the path naming that kind.
   */
  kind: SiteKind;
  /** Intent dims raised (with weight). Presence here ⇒ gate-qualifying. */
  intent?: Partial<Record<IntentDim, number>>;
  /** Context dims raised (with weight). Context-only entries do NOT qualify the gate. */
  context?: Partial<Record<ContextDim, number>>;
}

/**
 * Ordered path table. First-segment / prefix oriented; a visit is scored by
 * EVERY entry whose `test` matches, so /docs can raise both feature and
 * technical_depth. Order is not significant to scoring (dims accumulate),
 * only to readability.
 */
export const PATH_INTENT_TABLE: readonly PathIntentEntry[] = [
  // pricing / plans / cost
  {
    test: /^\/(pricing|plans?|price|cost)(\/|$)/,
    kind: "price",
    intent: { pricing: 0.6 },
    context: { price_sensitivity: 0.5 },
  },
  // vs a specific named rival — "/vs-competitor", "/vs/foo"
  {
    test: /^\/vs[-/]/,
    kind: "vs",
    intent: { competitor: 0.65 },
  },
  // category comparison / alternatives (plural / listicle)
  {
    test: /^\/(compare|comparison|alternatives?)(\/|$)/,
    kind: "compare",
    intent: { evaluation: 0.6 },
  },
  // feature / product surface
  {
    test: /^\/(features?|integrations?|product)(\/|$)/,
    kind: "features",
    intent: { feature: 0.55 },
  },
  // developer / docs surface → feature + technical depth
  {
    test: /^\/(docs?|api|developers?|reference|sdk)(\/|$)/,
    kind: "docs",
    intent: { feature: 0.55 },
    context: { technical_depth: 0.6 },
  },
  // problem-first explainer
  {
    test: /^\/(how-it-works|how|why|use-cases?|solutions?)(\/|$)/,
    kind: "how",
    intent: { problem: 0.5 },
  },
  // conversion-intent paths → CONTEXT ONLY (urgency), NOT a gate-qualifying intent.
  {
    test: /^\/(demo|trial|start|get-started|sign-?up|register|book|contact)(\/|$)/,
    kind: "start",
    context: { urgency: 0.6 },
  },
];

/**
 * Returns the entry-path table rows that match the given normalized path.
 * Empty array when path is null/"/" or matches nothing.
 */
function matchingEntries(path: string | null | undefined): PathIntentEntry[] {
  if (!path || path === "/") return [];
  return PATH_INTENT_TABLE.filter((e) => e.test.test(path));
}

/** The kinds of the global table entries a path matches (the path "naming" them, §4.4). */
export function globalPathKinds(path: string | null | undefined): SiteKind[] {
  return matchingEntries(path).map((e) => e.kind);
}

export interface PathDims {
  intent: Partial<Record<IntentDim, number>>;
  context: Partial<Record<ContextDim, number>>;
}

function scaled(d: KindDims, w: number): PathDims {
  const out: PathDims = { intent: {}, context: {} };
  for (const [dim, v] of Object.entries(d.intent ?? {}) as [IntentDim, number][]) {
    out.intent[dim] = Math.round(v * w * 10_000) / 10_000;
  }
  for (const [dim, v] of Object.entries(d.context ?? {}) as [ContextDim, number][]) {
    out.context[dim] = Math.round(v * w * 10_000) / 10_000;
  }
  return out;
}

/**
 * The one path helper (docs/specs/site-shaped-intents.md §6.1): the intent
 * and context weights a landing path adds. The customer's map entry first
 * (resolved by the edge from the visitor bundle, `siteEntryFor`), an
 * operator's `none` included, which replaces the global table for that
 * path; without an entry, the global table as ADR 0023 wrote it. Both
 * `classify` and `hasMeaningfulSignal` read it, so the gate and the scoring
 * cannot drift.
 */
export function pathDims(path: string | null | undefined, site?: SitePathEntry | null): PathDims {
  if (site) return scaled(SITE_KIND_DIMS[site.kind] ?? {}, site.w);
  const out: PathDims = { intent: {}, context: {} };
  for (const e of matchingEntries(path)) {
    for (const [dim, w] of Object.entries(e.intent ?? {}) as [IntentDim, number][]) {
      out.intent[dim] = (out.intent[dim] ?? 0) + w;
    }
    for (const [dim, w] of Object.entries(e.context ?? {}) as [ContextDim, number][]) {
      out.context[dim] = (out.context[dim] ?? 0) + w;
    }
  }
  return out;
}

/**
 * True when the entry path raises at least one INTENT dim — i.e. it discloses
 * WHY the visitor came, strongly enough to personalize on its own. Context-only
 * paths (demo/trial → urgency) return false: they inform the vector but do not
 * qualify a naked visit for personalization.
 *
 * Used by both hasMeaningfulSignal (the gate) and the classifier's brand
 * rule, so the two can never disagree. With a site-map entry the entry
 * decides (site-shaped intents §6.1).
 */
export function pathCarriesIntent(
  path: string | null | undefined,
  site?: SitePathEntry | null,
): boolean {
  if (site) return site.w > 0 && kindCarriesIntent(site.kind);
  return Object.values(pathDims(path).intent).some((w) => (w ?? 0) > 0);
}

/** Sum of intent-dim contributions for a path (used by the classifier). */
export function pathIntentDims(
  path: string | null | undefined,
  site?: SitePathEntry | null,
): Partial<Record<IntentDim, number>> {
  return pathDims(path, site).intent;
}

/** Sum of context-dim contributions for a path (used by the classifier). */
export function pathContextDims(
  path: string | null | undefined,
  site?: SitePathEntry | null,
): Partial<Record<ContextDim, number>> {
  return pathDims(path, site).context;
}

/**
 * The customer's map entry for a page path: the longest entry that is the
 * path or one of its parents (`/work` covers `/work/portal`), the way the
 * global regexes match a prefix. Null when no entry covers it (the global
 * table then applies). The root is never an entry.
 */
export function siteEntryFor(
  pm: Readonly<Record<string, readonly [string, number]>> | null | undefined,
  path: string | null | undefined,
): SitePathEntry | null {
  if (!pm || !path || path === "/") return null;
  let p = path;
  while (p.length > 1) {
    const hit = Object.prototype.hasOwnProperty.call(pm, p) ? pm[p] : undefined;
    if (hit && isEntryKind(hit[0]) && typeof hit[1] === "number" && Number.isFinite(hit[1])) {
      return { kind: hit[0], w: Math.min(1, Math.max(0, hit[1])) };
    }
    const cut = p.lastIndexOf("/");
    if (cut <= 0) break;
    p = p.slice(0, cut);
  }
  return null;
}

function isEntryKind(v: string): v is SitePathEntry["kind"] {
  return v === "none" || Object.prototype.hasOwnProperty.call(SITE_KIND_DIMS, v);
}
