/**
 * Visitors with no signal of their own (ADR 0038; docs/specs/direct-visitors.md
 * sections 3 to 6): what the edge and generation share for page one choosing
 * page two (part 4), market versions (part 5) and the learned best default
 * (part 3).
 *
 * Pure data and pure functions, no I/O. Nothing here reads or keeps anything
 * about a visitor: a word for a page, a word for a button's section, a
 * country code read from the connection at the moment of the request, and
 * aggregate counts. The visit marker is never an input.
 */

import { type ChoiceConfig, parseChoiceSet } from "./choice.ts";
import { pathIntentDims } from "./classify/path-intent.ts";
import { isIsoCountry } from "./country.ts";
import { COUNT_TARGET_PREFIX } from "./pick.ts";
import type { SitePathEntry } from "./site-map/kinds.ts";
import { foldIntentDim } from "./site-map/served.ts";
import { INTENT_DIMENSIONS, type IntentDim } from "./vector/dimensions.ts";

/** The source word of every decision made for a visit that brought none. */
export const DIRECT_SOURCE = "direct";

// ---------------------------------------------------------------------------
// Part 4: page one chooses page two
// ---------------------------------------------------------------------------

/**
 * The intent word a page names: the intent its path raises most (the
 * customer's map entry first, then the global table, through the same
 * helper the classifier reads), folded into the intents the site serves.
 * Null for a page that names none (the root, `about`, a `start` page whose
 * path raises only urgency, an operator's `none`).
 */
export function pageWord(
  path: string,
  site: SitePathEntry | null | undefined,
  served: readonly IntentDim[] | null | undefined,
): IntentDim | null {
  const dims = pathIntentDims(path, site ?? null);
  let best: IntentDim | null = null;
  let top = 0;
  for (const d of INTENT_DIMENSIONS) {
    const w = dims[d] ?? 0;
    if (w > top) {
      top = w;
      best = d;
    }
  }
  return best ? foldIntentDim(best, served) : null;
}

/**
 * A counted button's section, as the manifest names it, to an intent word.
 * Sections that say nothing about why a visitor came (hero, cta, faq) and
 * count-only picks (`count:{page}`) name none.
 */
const SECTION_WORDS: Readonly<Record<string, IntentDim>> = {
  pricing: "pricing",
  features: "feature",
  comparison: "evaluation",
  social_proof: "evaluation",
};

/** The word a click on a counted button of this section gives, folded; else null. */
export function sectionWord(
  sectionPath: string,
  served: readonly IntentDim[] | null | undefined,
): IntentDim | null {
  if (typeof sectionPath !== "string" || sectionPath.startsWith(COUNT_TARGET_PREFIX)) return null;
  const head = sectionPath.split(".")[0] ?? "";
  const word = Object.prototype.hasOwnProperty.call(SECTION_WORDS, head)
    ? SECTION_WORDS[head]
    : undefined;
  return word ? foldIntentDim(word, served) : null;
}

/** The carry the tab keeps for a word: the word and the source `direct`. */
export function wordCarry(word: IntentDim): string {
  return `${word}:${DIRECT_SOURCE}`;
}

// ---------------------------------------------------------------------------
// Part 5: market versions
// ---------------------------------------------------------------------------

/** A market version's source segment: `mk-` and the lower-case country code (`mk-gb`). */
export const MARKET_PREFIX = "mk-";
/** The type of that segment. */
export type MarketSource = `mk-${string}`;
/** At most this many markets per customer, so per page. */
export const MAX_MARKETS = 3;
/** A market needs this many visits over the window... */
export const MARKET_MIN_VISITS = 30;
/** ...and at least this share of the customer's visits... */
export const MARKET_MIN_SHARE = 0.05;
/** ...and at most this share: above it, it is the market the page was written for. */
export const MARKET_MAX_SHARE = 0.5;

/** The source segment of a market's cell. */
export function marketSource(country: string): MarketSource {
  return `${MARKET_PREFIX}${country.toLowerCase()}`;
}

/** The country code of a market cell's source, upper case, or null for any other source. */
export function marketOfSource(source: string | null | undefined): string | null {
  if (typeof source !== "string" || !source.startsWith(MARKET_PREFIX)) return null;
  const cc = source.slice(MARKET_PREFIX.length).toUpperCase();
  return isIsoCountry(cc) ? cc : null;
}

/** A stored market list (`customers.markets`): listed codes only, each once, at most three. */
export function parseMarkets(raw: unknown): string[] {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const c of v) {
    if (isIsoCountry(c) && !out.includes(c)) out.push(c);
    if (out.length === MAX_MARKETS) break;
  }
  return out;
}

/**
 * The customer's markets from its visits by country over the window (§5):
 * at least MARKET_MIN_VISITS visits and a share between MARKET_MIN_SHARE and
 * MARKET_MAX_SHARE, `other` never, the biggest first, at most three.
 */
export function chooseMarkets(rows: ReadonlyArray<{ country: string; visits: number }>): string[] {
  const total = rows.reduce((n, r) => n + (Number(r.visits) || 0), 0);
  if (total <= 0) return [];
  return rows
    .filter((r) => isIsoCountry(r.country))
    .map((r) => ({ c: r.country, v: Number(r.visits) || 0 }))
    .filter(
      (r) =>
        r.v >= MARKET_MIN_VISITS &&
        r.v / total >= MARKET_MIN_SHARE &&
        r.v / total <= MARKET_MAX_SHARE,
    )
    .sort((a, b) => b.v - a.v || a.c.localeCompare(b.c))
    .slice(0, MAX_MARKETS)
    .map((r) => r.c);
}

/**
 * The visitor's market at `/select` (§5): the connection's country when it
 * is one of the customer's markets, else the region of the browser's
 * language tag (`en-GB`), else null. Read in memory, never kept.
 */
export function pickMarket(
  markets: readonly string[] | null | undefined,
  country: string | null | undefined,
  lang: string | null | undefined,
): string | null {
  if (!markets || markets.length === 0) return null;
  const cc = typeof country === "string" ? country.trim().toUpperCase() : "";
  if (markets.includes(cc)) return cc;
  const region =
    typeof lang === "string" ? /^[a-z]{2,3}-([a-z]{2})(?:-|$)/i.exec(lang.trim()) : null;
  const r = region?.[1]?.toUpperCase() ?? "";
  return markets.includes(r) ? r : null;
}

// ---------------------------------------------------------------------------
// Part 3: the learned best default
// ---------------------------------------------------------------------------

/** The arm that shows the page as built. */
export const ORIGINAL_ARM = "none";
/** The carry of a visit the learned default kept on the page as built. */
export const HELD_ORIGINAL = "none:direct";
/** Weights are integers in thousandths that sum to this. */
export const WEIGHT_TOTAL = 1000;
/** Every arm keeps at least this many thousandths (exploration, a propensity far from 0). */
export const WEIGHT_FLOOR = 30;
/** Draws of the joint posterior per page. */
export const THOMPSON_DRAWS = 4000;
/** The prior's strength in pseudo-exposures. */
export const PRIOR_STRENGTH = 20;

/** One page's weights: [arm, thousandths], the arm an intent or `none`. */
export type ArmWeights = Array<[string, number]>;

/** The bundle's `dl`: the set's id and each page's weights. */
export interface LearnedBundle {
  s: string;
  w: Record<string, ArmWeights>;
}

/** An arm's aggregate counts: exposures and clicks. */
export interface ArmCount {
  arm: string;
  n: number;
  k: number;
}

/** A random number in [0, 1). */
export type Rng = () => number;

/** True for weights a visitor may be drawn from: known arms, integers, summing to 1000. */
export function validWeights(w: unknown): w is ArmWeights {
  if (!Array.isArray(w) || w.length < 2) return false;
  let sum = 0;
  for (const e of w) {
    if (!Array.isArray(e) || e.length !== 2) return false;
    const [arm, n] = e as [unknown, unknown];
    if (arm !== ORIGINAL_ARM && !(INTENT_DIMENSIONS as readonly unknown[]).includes(arm))
      return false;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return false;
    sum += n;
  }
  return sum === WEIGHT_TOTAL;
}

/**
 * The arm for a draw `r` in [0, 1) and its probability in thousandths. The
 * draw comes from the edge's random source, never from the visit marker.
 */
export function drawArm(weights: ArmWeights, r: number): { arm: string; p: number } {
  let at = Math.floor(Math.min(Math.max(r, 0), 0.999999) * WEIGHT_TOTAL);
  for (const [arm, p] of weights) {
    if (at < p) return { arm, p };
    at -= p;
  }
  const last = weights[weights.length - 1] as [string, number];
  return { arm: last[0], p: last[1] };
}

/** A standard normal draw (Box-Muller). */
function normal(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** A Gamma(shape, 1) draw (Marsaglia and Tsang; shape under 1 by the boost). */
function gamma(shape: number, rng: Rng): number {
  if (shape < 1) return gamma(shape + 1, rng) * Math.max(rng(), 1e-12) ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

/** A Beta(a, b) draw. */
export function sampleBeta(a: number, b: number, rng: Rng): number {
  const x = gamma(a, rng);
  const y = gamma(b, rng);
  return x + y > 0 ? x / (x + y) : 0.5;
}

/** A Laplace(0, scale) draw, the noise on a cross-customer total. */
export function laplace(scale: number, rng: Rng): number {
  const u = rng() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

/**
 * The prior from a total pooled across customers (counts only): each total
 * plus Laplace noise (scale 1, epsilon 1 per total), clamped, then a Beta of
 * PRIOR_STRENGTH pseudo-exposures at the noised mean (one click and one miss
 * added so an empty pool reads 50%... at strength 20, quickly overruled).
 */
export function pooledPrior(total: { n: number; k: number }, rng: Rng): { a: number; b: number } {
  const n = Math.max(0, total.n + laplace(1, rng));
  const k = Math.min(n, Math.max(0, total.k + laplace(1, rng)));
  const mean = (k + 1) / (n + 2);
  return { a: PRIOR_STRENGTH * mean, b: PRIOR_STRENGTH * (1 - mean) };
}

/**
 * Thompson sampling, offline (the shape of GrowthBook's stats-ts
 * banditWeights, MIT, written here): each arm's posterior Beta(prior a +
 * clicks, prior b + misses), THOMPSON_DRAWS joint draws, an arm's weight the
 * share of draws it wins; then every arm at least WEIGHT_FLOOR, as integers
 * in thousandths summing to 1000, the arms in the order given.
 */
export function thompsonWeights(
  arms: readonly ArmCount[],
  prior: (arm: string) => { a: number; b: number },
  rng: Rng,
  draws = THOMPSON_DRAWS,
): ArmWeights {
  if (arms.length === 0) return [];
  const post = arms.map((c) => {
    const p = prior(c.arm);
    const n = Math.max(0, c.n);
    const k = Math.min(n, Math.max(0, c.k));
    return { a: p.a + k, b: p.b + n - k };
  });
  const wins = arms.map(() => 0);
  for (let d = 0; d < draws; d++) {
    let best = 0;
    let top = -1;
    post.forEach((q, i) => {
      const x = sampleBeta(q.a, q.b, rng);
      if (x > top) {
        top = x;
        best = i;
      }
    });
    wins[best] = (wins[best] ?? 0) + 1;
  }
  const floor = Math.min(WEIGHT_FLOOR, Math.floor(WEIGHT_TOTAL / arms.length));
  const spare = WEIGHT_TOTAL - floor * arms.length;
  const raw = wins.map((w) => floor + (spare * w) / draws);
  const out = raw.map((x) => Math.floor(x));
  let left = WEIGHT_TOTAL - out.reduce((a, b) => a + b, 0);
  // The thousandths left by the rounding go to the largest remainders.
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    left--;
  }
  return arms.map((c, i) => [c.arm, out[i] ?? 0]);
}

/** True when two weight sets differ by an arm or by `step` thousandths anywhere (above the draws' own noise). */
export function weightsMoved(a: ArmWeights | undefined, b: ArmWeights, step = 25): boolean {
  if (!a || a.length !== b.length) return true;
  return b.some(([arm, w], i) => a[i]?.[0] !== arm || Math.abs((a[i]?.[1] ?? 0) - w) >= step);
}

// ---------------------------------------------------------------------------
// On the event rows (`/event`, docs/specs/direct-visitors.md §6)
// ---------------------------------------------------------------------------

/**
 * `nd`, why a visit with no signal got its answer: `l:{set}` or
 * `l:{set}:{p}` (the learned default, the chosen arm's probability in
 * thousandths), `m` (a market version), `c:{slot}` (the visitor's own
 * choice, slot a to d), `r:{slot}` (that choice, remembered by the
 * visitor's browser from an earlier visit). A fixed shape; never a country,
 * a word typed, a time or anything read from the device.
 */
export const ND_SHAPE = /^(?:l:[0-9a-z]{1,10}(?::[0-9]{1,4})?|m|[cr]:[a-d])$/;

export function isDirectNd(v: unknown): v is string {
  return typeof v === "string" && ND_SHAPE.test(v);
}

/**
 * What the visitor-choice bar says (§2): the question was shown, the visitor
 * closed it, or why it was not shown, one fixed word; since 2026-11-04 also
 * `answered` and `returned`, which carry the visitor's own code (`pid`, ADR
 * 0039) and the answer's slot (`qa`); since 2026-11-05 `first` (a code
 * drawn on this visit) and, on `returned`, the remembered reason (`rc`).
 * Never a width, a height
 * or anything measured. `covered` is from the hero row before the bar (rows
 * up to 2026-11-04); the bar never sends it.
 */
export const CHOICE_WORDS = [
  "shown",
  "closed",
  "fit",
  "anchor",
  "covered",
  "answered",
  "returned",
  "first",
] as const;
export type ChoiceWord = (typeof CHOICE_WORDS)[number];

export function isChoiceWord(v: unknown): v is ChoiceWord {
  return typeof v === "string" && (CHOICE_WORDS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// The bundle's part (both writers)
// ---------------------------------------------------------------------------

/** The bundle fields of ADR 0038 parts 3 to 5. Never sent to a browser. */
export interface DirectBundleFields {
  /** `1` when page one may choose page two (part 4). */
  dp?: 1;
  /** The customer's markets, upper-case ISO codes, at most three (part 5). */
  mk?: string[];
  /** The learned default's current set (part 3). */
  dl?: LearnedBundle;
  /** The visitor's own choice, on and not killed (part 2): the question of `/`. */
  qc?: ChoiceConfig;
  /** The questions of the other language homes (`/az`), by path. */
  ql?: Record<string, ChoiceConfig>;
  /** `1` while "Remember returning visitors" is on (ADR 0039): the script carries the memory. */
  rm?: 1;
}

/** The read both bundle writers make for the direct fields (migration 0051). */
export const BUNDLE_DIRECT_SQL =
  "SELECT page_one_off, learned_default_off, market_versions_off, markets, sensitive, special_category, plan, choice_on, choice_killed, choice, remember_off FROM customers WHERE id = ?";

/** The row BUNDLE_DIRECT_SQL returns. */
export interface BundleDirectRow {
  page_one_off?: number | null;
  learned_default_off?: number | null;
  market_versions_off?: number | null;
  markets?: string | null;
  sensitive?: number | null;
  special_category?: number | null;
  plan?: string | null;
  choice_on?: number | null;
  choice_killed?: number | null;
  choice?: string | null;
  /** 1: "Remember returning visitors" is off (migration 0053). */
  remember_off?: number | null;
}

/**
 * True when a customer may have any of the three: answered "no" to the
 * special-category question (an unanswered or a yes customer has none, as
 * for the keyword lexicon), not marked sensitive, not a free audit.
 */
export function directAllowed(row: BundleDirectRow | null | undefined): boolean {
  if (!row) return false;
  return (
    Number(row.special_category) === 0 &&
    row.special_category !== null &&
    row.special_category !== undefined &&
    Number(row.sensitive) !== 1 &&
    row.plan !== "audit"
  );
}

/**
 * The question alone (§2) may also run on a site marked sensitive: the
 * founder's call on 2026-11-04 for the pilot, without a privacy review ruling. A
 * marked site already has the claims lock on its versions and every answer
 * points to one of them; the question's words are screened for special
 * categories as everywhere. Still never for an unmarked "yes", an unanswered
 * customer or a free audit, and parts 1, 3, 4 and 5 keep `directAllowed`.
 */
export function choiceAllowed(row: BundleDirectRow | null | undefined): boolean {
  if (!row || row.plan === "audit") return false;
  return directAllowed(row) || Number(row.sensitive) === 1;
}

/** What an install allows beyond the row (the workers' vars). */
export interface RememberOptions {
  /**
   * The returning-visitor memory may run on a site marked sensitive
   * (`REMEMBER_ON_SENSITIVE` = "on"). Absent or false: it may not. A
   * 13-month code on a health site is the install's own decision, never a
   * default.
   */
  onSensitive?: boolean;
}

/** `REMEMBER_ON_SENSITIVE` as both workers read it: only the word "on" allows. */
export function rememberOnSensitive(value: string | null | undefined): boolean {
  return value === "on";
}

/**
 * The returning-visitor memory (ADR 0039) may run where the question may
 * (`choiceAllowed`), and on a site marked sensitive only when the install
 * says so. The question itself is not narrowed: on a sensitive site it
 * still runs and keeps its answer for the tab.
 */
export function rememberAllowed(
  row: BundleDirectRow | null | undefined,
  options: RememberOptions = {},
): boolean {
  if (!choiceAllowed(row)) return false;
  return Number(row?.sensitive) !== 1 || options.onSensitive === true;
}

/**
 * The bundle's direct fields for both writers. Empty for a customer that
 * may have none, so its bundle is byte for byte what it was. No row (a
 * failed read) reads as none: the closed side, the page as built.
 */
export function bundleDirectFields(
  row: BundleDirectRow | null | undefined,
  learned: readonly LearnedRow[] = [],
  options: RememberOptions = {},
): DirectBundleFields {
  // The question: off by default, on only by the customer or a superadmin,
  // never when a superadmin killed it (§2).
  const set =
    choiceAllowed(row) && Number(row?.choice_on) === 1 && Number(row?.choice_killed) !== 1
      ? parseChoiceSet(row?.choice ?? null)
      : {};
  const { "/": qc, ...others } = set;
  const q = {
    ...(qc ? { qc } : {}),
    ...(Object.keys(others).length > 0 ? { ql: others } : {}),
    // The visitor memory: where it may run (`rememberAllowed`), while the
    // column says on (0); a row without the column has no memory.
    ...(rememberAllowed(row, options) && row?.remember_off != null && Number(row.remember_off) === 0
      ? { rm: 1 as const }
      : {}),
  };
  if (!directAllowed(row)) return q;
  const mk = Number(row?.market_versions_off) === 1 ? [] : parseMarkets(row?.markets);
  const dl = Number(row?.learned_default_off) === 1 ? null : learnedBundle(learned);
  return {
    ...(Number(row?.page_one_off) === 1 ? {} : { dp: 1 as const }),
    ...(mk.length > 0 ? { mk } : {}),
    ...(dl ? { dl } : {}),
    ...q,
  };
}

/** The current set's rows (`learned_weights`), as both writers read them. */
export const BUNDLE_LEARNED_SQL = `SELECT set_id, page_path, weights FROM learned_weights
  WHERE customer_id = ?1 AND set_id = (
    SELECT set_id FROM learned_weights WHERE customer_id = ?1
    ORDER BY computed_at DESC, set_id DESC LIMIT 1)
  ORDER BY page_path`;

/** A row BUNDLE_LEARNED_SQL returns. */
export interface LearnedRow {
  set_id: string;
  page_path: string;
  weights: string;
}

/** `dl` from the current set's rows: valid weights only; null when none. */
export function learnedBundle(rows: readonly LearnedRow[]): LearnedBundle | null {
  const w: Record<string, ArmWeights> = {};
  let s = "";
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.weights);
    } catch {
      continue;
    }
    if (!validWeights(parsed)) continue;
    w[r.page_path] = parsed;
    s = r.set_id;
  }
  return s && Object.keys(w).length > 0 ? { s, w } : null;
}
