/**
 * Site-shaped intents (docs/specs/site-shaped-intents.md §4.4): the kinds a
 * customer's own page can have, and the intent and context weights each
 * kind gives a visit that lands on it. The weights are ADR 0023's; `proof`
 * and `learn` are new. Pure data, no I/O: the edge reads it on every
 * /select through `pathDims` (classify/path-intent.ts).
 *
 * A kind names a page, never a person or a topic: a clinic's
 * `/hiv-testing` is at most `learn` or `features`, and the intents change
 * wording only (privacy review ruling, condition 6).
 */

import type { ContextDim, IntentDim } from "../vector/dimensions.ts";

/** Every kind a mapped path can have, in the spec's table order. */
export const SITE_KINDS = [
  "price",
  "vs",
  "compare",
  "proof",
  "features",
  "docs",
  "how",
  "learn",
  "start",
  "about",
] as const;

export type SiteKind = (typeof SITE_KINDS)[number];
/** `none` is a kind only an operator sets ("Not a page to use"). */
export type SiteKindOrNone = SiteKind | "none";

export function isSiteKind(v: unknown): v is SiteKind {
  return typeof v === "string" && (SITE_KINDS as readonly string[]).includes(v);
}

export function isSiteKindOrNone(v: unknown): v is SiteKindOrNone {
  return v === "none" || isSiteKind(v);
}

export interface KindDims {
  intent?: Partial<Record<IntentDim, number>>;
  context?: Partial<Record<ContextDim, number>>;
}

/** The spec's table: what landing on a page of each kind adds to the vector. */
export const SITE_KIND_DIMS: Readonly<Record<SiteKindOrNone, KindDims>> = {
  price: { intent: { pricing: 0.6 }, context: { price_sensitivity: 0.5 } },
  vs: { intent: { competitor: 0.65 } },
  compare: { intent: { evaluation: 0.6 } },
  proof: { intent: { evaluation: 0.5 } },
  features: { intent: { feature: 0.55 } },
  docs: { intent: { feature: 0.55 }, context: { technical_depth: 0.6 } },
  how: { intent: { problem: 0.5 } },
  learn: { intent: { problem: 0.45 } },
  // Context only, like /demo in ADR 0023: never opens the gate.
  start: { context: { urgency: 0.6 } },
  // Brand by absence: nothing added, nothing opened.
  about: {},
  none: {},
};

/** How sure a row is: the rules (both or one side named it), the model, or the operator. */
export const SITE_CONFIDENCES = ["high", "medium", "model", "operator"] as const;
export type SiteConfidence = (typeof SITE_CONFIDENCES)[number];

/**
 * The kind's weight times its confidence (spec §4.6). All stay below the
 * UTM rules (0.65 to 0.75), so a tagged link still wins.
 */
export const CONFIDENCE_WEIGHT: Readonly<Record<SiteConfidence, number>> = {
  high: 1,
  medium: 0.85,
  model: 0.75,
  operator: 1,
};

/** One entry of the customer's map as the edge reads it: a kind and its weight. */
export interface SitePathEntry {
  kind: SiteKindOrNone;
  /** The confidence multiplier, 0 to 1. */
  w: number;
}

/** True when a kind raises an intent dim, i.e. it opens the gate on its own page. */
export function kindCarriesIntent(kind: SiteKindOrNone): boolean {
  const i = SITE_KIND_DIMS[kind]?.intent;
  return i !== undefined && Object.values(i).some((w) => (w ?? 0) > 0);
}
