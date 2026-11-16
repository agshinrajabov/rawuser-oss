/**
 * Which intents a site serves, and where an unserved intent's weight goes
 * (docs/specs/site-shaped-intents.md §7). `brand`, `problem`, `feature` and
 * `evaluation` are always served. `pricing` needs a price page, a price in
 * the brief, a price on a page we read, or a pricing hint; `competitor` a
 * vs or compare page or a competitor hint (the founder's decision 1). An
 * unserved intent folds into `evaluation` before the argmax (decision 3):
 * someone asking about cost or a rival is weighing whether it is worth it.
 */

import type { IntentVector } from "../types.ts";
import { INTENT_DIMENSIONS, type IntentDim } from "../vector/dimensions.ts";
import type { SiteKindOrNone } from "./kinds.ts";

/** Intents every site can speak to. */
export const ALWAYS_SERVED: readonly IntentDim[] = ["evaluation", "feature", "problem", "brand"];

/** An unserved intent's nearest served neighbour (§7.2, decision 3). */
export const FOLD_TO: Readonly<Partial<Record<IntentDim, IntentDim>>> = {
  pricing: "evaluation",
  competitor: "evaluation",
};

/** The two intents that can fold; every other one is always served. */
export const FOLDABLE: readonly IntentDim[] = ["competitor", "pricing"];

const CURRENCY = "[$€£₼₽₺¥₹]";
/** Codes read before a number ("USD 12"); "try" is left out ("try 14 days"). */
const CODES_BEFORE = "usd|eur|gbp|azn|rub|manat";
/** Codes read after a number ("12 AZN", "500 руб"); "man" is left out ("a 5 man team"). */
const CODES_AFTER = "usd|eur|gbp|azn|rub|try|tl|manat|руб|рублей|лира|lira";
const PRICE_PATTERNS: readonly RegExp[] = [
  new RegExp(`${CURRENCY}\\s?\\d`, "u"),
  new RegExp(`\\d[\\d.,]*\\s?${CURRENCY}`, "u"),
  new RegExp(`(?<![\\p{L}])(${CODES_BEFORE})\\.?\\s?\\d`, "iu"),
  new RegExp(`\\d[\\d.,]*\\s?(${CODES_AFTER})(?![\\p{L}])`, "iu"),
  // A number right before "per month" in any of the four languages: "12 per
  // month", "9/mo". Not "40 hours per month" (a pilot site's /approach, a count
  // of hours, not a price).
  /\d[\d.,]*\s?(per month|a month|\/\s?mo(nth)?\b|\/\s?ay\b|в месяц|\/\s?мес)/iu,
];

/** True when a text shows a price: a currency next to a number, or a number per month. */
export function textHasPrice(text: string | null | undefined): boolean {
  if (!text) return false;
  return PRICE_PATTERNS.some((re) => re.test(text));
}

export interface ServedBrief {
  value_props?: readonly string[] | null;
  differentiators?: readonly string[] | null;
  proof_points?: readonly string[] | null;
  per_intent_hints?: Partial<Record<IntentDim, string>> | null;
}

/** A price in the brief: `proof_points`, `value_props` or `differentiators` (§7.1). */
export function briefHasPrice(brief: ServedBrief | null | undefined): boolean {
  if (!brief) return false;
  return [
    ...(brief.proof_points ?? []),
    ...(brief.value_props ?? []),
    ...(brief.differentiators ?? []),
  ].some((t) => textHasPrice(t));
}

function hint(brief: ServedBrief | null | undefined, dim: IntentDim): boolean {
  const h = brief?.per_intent_hints?.[dim];
  return typeof h === "string" && h.trim() !== "";
}

export interface ServedFacts {
  /** The customer's map rows, an operator's `none` included (it counts for nothing). */
  paths: ReadonlyArray<{ path: string; kind: SiteKindOrNone }>;
  /** The primary brief (and, when present, the other languages' briefs). */
  briefs: ReadonlyArray<ServedBrief | null>;
  /** Pages on which the last read saw a price. */
  pricePages: readonly string[];
}

/** Why pricing and competitor are in or out, in a few words for the dashboard. */
export interface ServedReasons {
  pricing: string;
  competitor: string;
}

/** The served set, in INTENT_DIMENSIONS order, and why (§5 `served_reasons`). */
export function servedIntents(f: ServedFacts): { served: IntentDim[]; reasons: ServedReasons } {
  const sorted = [...f.paths].sort((a, b) => a.path.localeCompare(b.path));
  const pricePage = sorted.find((p) => p.kind === "price");
  const rivalPage = sorted.find((p) => p.kind === "vs" || p.kind === "compare");
  const pricing = pricePage
    ? `page ${pricePage.path}`
    : f.briefs.some(briefHasPrice)
      ? "price in brief"
      : f.pricePages.length > 0
        ? `price on page ${[...f.pricePages].sort()[0]}`
        : f.briefs.some((b) => hint(b, "pricing"))
          ? "pricing hint"
          : "none";
  const competitor = rivalPage
    ? `page ${rivalPage.path}`
    : f.briefs.some((b) => hint(b, "competitor"))
      ? "competitor hint"
      : "none";
  const served = INTENT_DIMENSIONS.filter(
    (d) =>
      ALWAYS_SERVED.includes(d) ||
      (d === "pricing" && pricing !== "none") ||
      (d === "competitor" && competitor !== "none"),
  );
  return { served, reasons: { pricing, competitor } };
}

/** A served list read back from storage: known dims only, in order; null = all six. */
export function parseServed(raw: unknown): IntentDim[] | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(v)) return null;
  const set = new Set(v.filter((d): d is string => typeof d === "string"));
  const out = INTENT_DIMENSIONS.filter((d) => set.has(d) || ALWAYS_SERVED.includes(d));
  return out.length === INTENT_DIMENSIONS.length ? null : out;
}

/** Where an intent goes on this site: itself when served (or no set), else its fold. */
export function foldIntentDim(
  dim: IntentDim,
  served: readonly IntentDim[] | null | undefined,
): IntentDim {
  if (!served || served.includes(dim)) return dim;
  return FOLD_TO[dim] ?? dim;
}

/**
 * The vector with every unserved intent's weight moved to its nearest
 * served neighbour, before the argmax (§7.2). The visitor's evidence is not
 * thrown away: a pricing campaign's direct visit on a site with no price
 * page scores evaluation, not zero everywhere and the generic brand
 * version. Clamped at 1 like every rule; the confidence is read again.
 * No set, or every intent served: the vector as it was.
 */
export function foldVector(
  vector: IntentVector,
  served: readonly IntentDim[] | null | undefined,
): IntentVector {
  if (!served) return vector;
  const moving = FOLDABLE.filter((d) => !served.includes(d));
  if (moving.length === 0) return vector;
  const intent = { ...vector.intent };
  for (const d of moving) {
    const to = FOLD_TO[d];
    if (!to) continue;
    intent[to] = Math.min(1, intent[to] + intent[d]);
    intent[d] = 0;
  }
  const sorted = Object.values(intent).sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  const second = sorted[1] ?? 0;
  const confidence = top === 0 ? 0.5 : Math.max(0.5, top / (top + second + 1e-6));
  return { ...vector, intent, meta: { ...vector.meta, confidence } };
}
