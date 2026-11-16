/**
 * Rules-based intent classifier (V1) — signals → IntentVector.
 *
 * This is the permanent foundation of the Rawuser intent model. Pure
 * function: same input always produces the same vector (no Date.now()
 * inside, no global state).
 *
 * Design:
 * - Each signal contributes to ONE OR MORE dims via a static weights table.
 *   That is the whole point of the vector: a visitor can simultaneously
 *   have high competitor-intent AND be arriving from an AI source.
 * - Multiple dims CAN and SHOULD be high simultaneously.
 * - Source NEVER overrides intent. The intent axis is independent.
 *
 * Crucial invariant (user spec):
 *   utm_campaign matching /demo|trial/ → context.urgency, NOT intent.evaluation.
 *   Those are ready-to-buy visitors, not category researchers.
 *
 * Signal → dimension mapping (from plan):
 *   utm_campaign /vs|alternative|alternatives-to/  → intent.competitor
 *   utm_campaign /comparison|review|alternatives|best/ → intent.evaluation
 *   Comparison referrer hosts (g2, capterra, …)    → intent.evaluation
 *   utm_campaign /enterprise|security|api|…/       → intent.feature
 *   utm_campaign /how|why|problem|tutorial|guide/  → intent.problem
 *   Community/social/AI source arrivals            → intent.problem (bumps)
 *   No UTM, no referrer, no AI                     → intent.brand
 *   utm_campaign /pricing|free|plan|cost|cheap|indie/ → intent.pricing
 *   AI source detected                             → source.ai
 *   Social medium/referrer/utm_source              → source.social
 *   Social in-app webview UA or social click id    → source.social (L2)
 *   android-app://<package> referrer               → its channel, exact table (Layer G)
 *   Reddit app UA / Google app UA (GSA)            → source.community / source.organic (Layer G)
 *   gclid / msclkid click id                       → source.paid (L2)
 *   Community referrer hosts                       → source.community
 *   utm_medium cpc/paid or utm_source ads          → source.paid
 *   Organic search referrer (non-AI)               → source.organic
 *   No channel signal                              → source.direct
 *   utm_campaign /free|cheap|indie|bootstrap|startup/ → context.price_sensitivity
 *   Community/technical referrer                   → context.technical_depth
 *   utm_campaign /demo|trial|now|today|launch|asap|deadline/ → context.urgency
 *     (CRITICAL: demo/trial → urgency, NOT intent.evaluation)
 *   utm_campaign /security|compliance|enterprise|gdpr|soc2/ → context.trust_need
 *   Comparison referrer                            → context.trust_need (bump)
 *   device === "mobile"                            → context.mobile_context
 *   Outside 09:00–18:00 local (cf.timezone)        → context.offhours_context
 *
 * Lead probability folds into meta.lead_probability here (replacing the
 * standalone lead-probability.ts module). Additive heuristic:
 *   base 0.20
 *   +0.15 if _isCitationClick
 *   +0.10 if any aiSource
 *   +0.10 if pricing dim > 0.3
 *   +0.10 if urgency dim > 0.3
 *   +0.05 if comparison-site referrer
 *   clamp [0.05, 0.95]; exactly 0 for bots.
 *
 * meta.confidence = top_intent / (top_intent + second_intent + 1e-6),
 * floored at 0.5.
 */

import { KEYWORD_INTENTS } from "../keyword-lexicon.ts";
import { isPaidClickId, isSocialClickId } from "../signals/click-id.ts";
import { matchReferrerHost, matchUtmMedium, matchUtmSource } from "../signals/source-vocabulary.ts";
import { COMPARISON_REFERRER_HOSTS } from "../signals/tables.ts";
import type { IntentVector, Signals } from "../types.ts";
import { CONTEXT_DIMENSIONS, INTENT_DIMENSIONS, SOURCE_DIMENSIONS } from "../vector/dimensions.ts";
import type { ContextDim, IntentDim, SourceDim } from "../vector/dimensions.ts";
import {
  CAMPAIGN_COMPETITOR_RE,
  CAMPAIGN_EVALUATION_RE,
  CAMPAIGN_FEATURE_RE,
  CAMPAIGN_PRICE_SENSITIVE_RE,
  CAMPAIGN_PRICING_RE,
  CAMPAIGN_PROBLEM_RE,
  CAMPAIGN_TECHNICAL_RE,
  CAMPAIGN_TRUST_RE,
  CAMPAIGN_URGENCY_RE,
  withScreenedCampaign,
} from "./campaign.ts";
import { pathCarriesIntent, pathDims } from "./path-intent.ts";

// ---------------------------------------------------------------------------
// Host and utm vocabulary lives in signals/source-vocabulary.ts (Layer F):
// exact tables plus patterns for free-form values, one place for every
// channel, learned from traffic through the weekly proposals.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Signal classifiers (pure predicates, used across rules)
// ---------------------------------------------------------------------------

/** The referrer's channel. A package id (android-app://) is matched exactly, never as a host. */
function referrerChannel(s: Signals): string | null {
  return matchReferrerHost(s.referrerHost, s.referrerIsApp === true)?.channel ?? null;
}

function isCommunityReferrer(s: Signals): boolean {
  return referrerChannel(s) === "community";
}

function isSocialReferrer(s: Signals): boolean {
  return referrerChannel(s) === "social";
}

function isComparisonReferrer(host: string | null): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return COMPARISON_REFERRER_HOSTS.some((c) => h === c || h.endsWith(`.${c}`));
}

function isOrganicReferrer(s: Signals): boolean {
  return referrerChannel(s) === "organic";
}

/** Organic search: a search referrer, or the page opened inside the Google app (Layer G). */
function hasOrganicSignal(s: Signals): boolean {
  return isOrganicReferrer(s) || s.appSource?.channel === "organic";
}

function hasSocialSignal(s: Signals): boolean {
  if (matchUtmMedium(s.utm.medium)?.channel === "social") return true;
  if (matchUtmSource(s.utm.source)?.channel === "social") return true;
  if (isSocialReferrer(s)) return true;
  // L2: the page opened inside a social app's webview, or the link carries a
  // social platform's click id. Both survive a stripped referrer.
  if (s.appSource?.channel === "social") return true;
  if (isSocialClickId(s.linkFamily)) return true;
  return false;
}

/** L2, Layer B: inside some webview, app unknown. Weight by confidence. */
function unknownAppWeight(s: Signals): number {
  if (!s.appSource || s.appSource.channel !== "app") return 0;
  return s.appSource.confidence === "low" ? 0.35 : 0.6;
}

function hasCommunitySignal(s: Signals): boolean {
  // Layer G: the Reddit app's webview marker counts like a reddit.com referrer.
  return isCommunityReferrer(s) || s.appSource?.channel === "community";
}

/** "No channel indicator" — missing medium, source, referrer, and AI source.
 *  UTM campaign alone doesn't identify the channel, so it doesn't disqualify direct. */
function hasNoChannelSignal(s: Signals): boolean {
  return (
    !s.utm.medium &&
    !s.utm.source &&
    s.referrerHost === null &&
    s.aiSource === null &&
    !s.appSource &&
    !s.clickId
  );
}

// ---------------------------------------------------------------------------
// Internal rule types
// ---------------------------------------------------------------------------

interface IntentRule {
  match(signals: Signals): number;
  dims: Partial<Record<IntentDim, number>>;
}

interface SourceRule {
  match(signals: Signals): number;
  dims: Partial<Record<SourceDim, number>>;
}

interface ContextRule {
  match(signals: Signals): number;
  dims: Partial<Record<ContextDim, number>>;
}

// ---------------------------------------------------------------------------
// Intent rules
// ---------------------------------------------------------------------------

const INTENT_RULES: readonly IntentRule[] = [
  // The ad keyword's intent (docs/specs/keyword-intent.md): matched by the
  // edge against the customer's own lexicon, the keyword already dropped.
  // 0.7, a step above a campaign word (0.65): a keyword is chosen for one
  // search, a campaign name covers many.
  ...KEYWORD_INTENTS.map(
    (dim): IntentRule => ({
      match: (s) => (s.keywordIntent === dim ? 0.7 : 0),
      dims: { [dim]: 1.0 },
    }),
  ),
  // competitor: "vs a specific named rival" ("Salesforce alternative")
  {
    match(s) {
      const c = s.utm.campaign;
      return c && CAMPAIGN_COMPETITOR_RE.test(c) ? 0.75 : 0;
    },
    dims: { competitor: 1.0 },
  },
  // evaluation: "comparing the category, no rival yet" (G2, Capterra, best-X)
  // comparison/review/alternatives(plural)/best = category, NOT vs a specific rival
  {
    match(s) {
      const c = s.utm.campaign;
      return c && CAMPAIGN_EVALUATION_RE.test(c) ? 0.65 : 0;
    },
    dims: { evaluation: 1.0 },
  },
  {
    // Comparison-site referrer → evaluation intent (category comparison)
    match(s) {
      return isComparisonReferrer(s.referrerHost) ? 0.6 : 0;
    },
    dims: { evaluation: 1.0 },
  },
  // feature: deep capability interest
  {
    match(s) {
      const c = s.utm.campaign;
      return c && CAMPAIGN_FEATURE_RE.test(c) ? 0.65 : 0;
    },
    dims: { feature: 1.0 },
  },
  // problem: pain-first arrival; "how/why/problem/tutorial/guide"
  {
    match(s) {
      const c = s.utm.campaign;
      return c && CAMPAIGN_PROBLEM_RE.test(c) ? 0.6 : 0;
    },
    dims: { problem: 1.0 },
  },
  {
    // AI source also bumps intent.problem — "I had a question, AI answered, I clicked"
    match(s) {
      return s.aiSource !== null ? 0.4 : 0;
    },
    dims: { problem: 1.0 },
  },
  {
    // Community/social arrivals bump intent.problem (from plan mapping)
    match(s) {
      return hasCommunitySignal(s) || hasSocialSignal(s) ? 0.35 : 0;
    },
    dims: { problem: 1.0 },
  },
  {
    // Organic search arrivals bump intent.problem (problem-first search)
    match(s) {
      return hasOrganicSignal(s) ? 0.35 : 0;
    },
    dims: { problem: 1.0 },
  },
  // brand: no intent-keyword in campaign AND no intent-contributing referrer AND no AI source.
  // Fires even when utm_medium/utm_source are present — channel signals don't indicate intent.
  // "demo/trial" campaign keywords do NOT produce brand = 0 here; they land here
  // because they don't match any of the competitor/evaluation/feature/problem/pricing
  // patterns below. This ensures that demo/trial → brand intent (+ urgency context).
  {
    match(s) {
      const c = s.utm.campaign;
      // Suppress brand if any intent-specific campaign keyword matched.
      if (c && CAMPAIGN_COMPETITOR_RE.test(c)) return 0;
      if (c && CAMPAIGN_EVALUATION_RE.test(c)) return 0;
      if (c && CAMPAIGN_FEATURE_RE.test(c)) return 0;
      if (c && CAMPAIGN_PROBLEM_RE.test(c)) return 0;
      if (c && CAMPAIGN_PRICING_RE.test(c)) return 0;
      // An ad keyword that chose an intent is a disclosed intent (keyword-intent.md).
      if (s.keywordIntent) return 0;
      // Suppress brand for any referrer or AI source that contributes intent.
      if (s.referrerHost !== null) return 0;
      if (s.aiSource !== null) return 0;
      // L2: a recovered social or affiliate channel is a referrer in all but
      // name. Paid clicks, email and an unknown webview keep brand: an ad
      // click with no campaign keyword is a brand-shaped arrival, the same
      // as a utm_medium=cpc visit without an intent word.
      if (s.appSource?.channel === "social") return 0;
      // Layer G: a community app (Reddit) or the Google app stands in for
      // its referrer the same way.
      if (s.appSource?.channel === "community") return 0;
      if (s.appSource?.channel === "organic") return 0;
      if (isSocialClickId(s.linkFamily)) return 0;
      if (s.linkFamily === "affiliate") return 0;
      // Suppress brand when the entry path itself discloses intent (L1, ADR 0023).
      // A naked direct arrival at /pricing is pricing intent, not brand — without
      // this the brand rule (0.8) would beat the path prior (≤0.65) in argmax.
      if (pathCarriesIntent(s.entryPath, s.sitePath)) return 0;
      return 0.8;
    },
    dims: { brand: 1.0 },
  },
  // pricing: cost / plan / free-tier / indie concern
  // Note: "trial" and "demo" → context.urgency (NOT pricing, NOT evaluation)
  {
    match(s) {
      const c = s.utm.campaign;
      return c && CAMPAIGN_PRICING_RE.test(c) ? 0.65 : 0;
    },
    dims: { pricing: 1.0 },
  },
];

// ---------------------------------------------------------------------------
// Source rules
// ---------------------------------------------------------------------------

const SOURCE_RULES: readonly SourceRule[] = [
  {
    // AI source: UA or referrer host identifies an AI tool
    match(s) {
      return s.aiSource !== null ? 1.0 : 0;
    },
    dims: { ai: 1.0 },
  },
  {
    // Social: utm_medium contains "social", social referrer hosts, or social utm_source
    match(s) {
      return hasSocialSignal(s) ? 0.85 : 0;
    },
    dims: { social: 1.0 },
  },
  {
    // L2 Layer B: some webview, app unknown. Most webview traffic is social or
    // messaging, so a weaker social prior; never as strong as a named app.
    match(s) {
      return unknownAppWeight(s);
    },
    dims: { social: 1.0 },
  },
  {
    // L2 Layer C: an ad clicked inside ChatGPT (oppref) is paid AND ai; the
    // ai rule above already fires through aiSource. Email links are warm,
    // "already knows us" visits: direct with an urgency bump (context rule).
    match(s) {
      if (s.linkFamily === "email") return 0.9;
      if (matchUtmMedium(s.utm.medium)?.channel === "email") return 0.9;
      if (matchUtmSource(s.utm.source)?.channel === "email") return 0.8;
      return 0;
    },
    dims: { direct: 1.0 },
  },
  {
    // L2 Layer C: affiliate and referral programmes (Product Hunt ?ref=,
    // newsletters, Impact, Awin) are discovery through a third party, the
    // same shape as a comparison-site referrer.
    match(s) {
      return s.linkFamily === "affiliate" ? 0.6 : 0;
    },
    dims: { organic: 1.0 },
  },
  {
    // Community: developer community referrer hosts
    match(s) {
      return hasCommunitySignal(s) ? 0.85 : 0;
    },
    dims: { community: 1.0 },
  },
  {
    // Paid: utm_medium cpc/paid/ppc/ad or utm_source for ad platforms
    match(s) {
      if (matchUtmMedium(s.utm.medium)?.channel === "paid") return 0.9;
      if (matchUtmSource(s.utm.source)?.channel === "paid") return 0.9;
      // L2: paid-search and paid-social ids exist only on ad clicks; an ad in
      // ChatGPT (oppref) counts here too.
      if (isPaidClickId(s.linkFamily)) return s.linkFamily === "paid-social" ? 0.8 : 0.9;
      return 0;
    },
    dims: { paid: 1.0 },
  },
  {
    // Organic: non-AI search engine referrers AND comparison sites.
    // Comparison sites (g2, capterra, producthunt) are discovery sources
    // semantically equivalent to search engines — users browse them to find
    // solutions, not from a paid ad. Treat them as organic source.
    match(s) {
      if (s.aiSource !== null) return 0; // AI source takes precedence
      if (hasOrganicSignal(s)) return 0.8;
      if (isComparisonReferrer(s.referrerHost)) return 0.7;
      return 0;
    },
    dims: { organic: 1.0 },
  },
  {
    // Direct: no channel indicator (no medium, no source, no referrer, no AI)
    // UTM campaign alone doesn't indicate the channel.
    match(s) {
      return hasNoChannelSignal(s) ? 0.9 : 0;
    },
    dims: { direct: 1.0 },
  },
];

// ---------------------------------------------------------------------------
// Context rules
// ---------------------------------------------------------------------------

const CONTEXT_RULES: readonly ContextRule[] = [
  {
    // price_sensitivity: free/cheap/indie/bootstrap/startup in campaign
    match(s) {
      const c = s.utm.campaign;
      return c && CAMPAIGN_PRICE_SENSITIVE_RE.test(c) ? 0.7 : 0;
    },
    dims: { price_sensitivity: 1.0 },
  },
  {
    // technical_depth: community referrers, tech referrers, technical UTM terms
    match(s) {
      if (hasCommunitySignal(s)) return 0.65;
      if (s.referrerHost && !s.referrerIsApp) {
        const techHosts = ["github.com", "stackoverflow.com", "gitlab.com", "dev.to"];
        const h = s.referrerHost.toLowerCase();
        if (techHosts.some((th) => h === th || h.endsWith(`.${th}`))) return 0.65;
      }
      const c = s.utm.campaign;
      if (c && CAMPAIGN_TECHNICAL_RE.test(c)) return 0.65;
      return 0;
    },
    dims: { technical_depth: 1.0 },
  },
  {
    // urgency: demo/trial/now/today/launch/asap/deadline UTM
    // CRITICAL: "demo" and "trial" → urgency, NOT intent.evaluation.
    // These are ready-to-buy visitors, not category researchers.
    match(s) {
      const c = s.utm.campaign;
      return c && CAMPAIGN_URGENCY_RE.test(c) ? 0.75 : 0;
    },
    dims: { urgency: 1.0 },
  },
  {
    // L2 Layer C: a click from an email campaign is a warm visit from someone
    // who already opted in; treat as mild urgency, never as identity.
    match(s) {
      return s.linkFamily === "email" ? 0.4 : 0;
    },
    dims: { urgency: 1.0 },
  },
  {
    // trust_need: security/compliance/enterprise/gdpr/soc2 UTM or comparison referrer
    match(s) {
      const c = s.utm.campaign;
      if (c && CAMPAIGN_TRUST_RE.test(c)) return 0.7;
      if (isComparisonReferrer(s.referrerHost)) return 0.5;
      return 0;
    },
    dims: { trust_need: 1.0 },
  },
  {
    // mobile_context: device === "mobile"
    match(s) {
      return s.device === "mobile" ? 1.0 : 0;
    },
    dims: { mobile_context: 1.0 },
  },
  // offhours_context is computed separately from a clock value
];

// ---------------------------------------------------------------------------
// Zero-vector helpers
// ---------------------------------------------------------------------------

function zeroIntent(): Record<IntentDim, number> {
  const r = {} as Record<IntentDim, number>;
  for (const d of INTENT_DIMENSIONS) r[d] = 0;
  return r;
}

function zeroSource(): Record<SourceDim, number> {
  const r = {} as Record<SourceDim, number>;
  for (const d of SOURCE_DIMENSIONS) r[d] = 0;
  return r;
}

function zeroContext(): Record<ContextDim, number> {
  const r = {} as Record<ContextDim, number>;
  for (const d of CONTEXT_DIMENSIONS) r[d] = 0;
  return r;
}

// ---------------------------------------------------------------------------
// Offhours detection
// ---------------------------------------------------------------------------

/**
 * Determines whether the visit falls outside 09:00–18:00 local time.
 * Falls back to UTC when timezone is missing or invalid.
 * Pure (takes a fixed timestamp) so callers can pass Date.now() in production
 * and a fixed timestamp in tests.
 */
export function isOffhours(timezone: string | null | undefined, nowMs: number): boolean {
  const tz = timezone || "UTC";
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    const hourStr = formatter.format(new Date(nowMs));
    const hour = Number.parseInt(hourStr, 10);
    return hour < 9 || hour >= 18;
  } catch {
    // Invalid timezone — fall back to UTC.
    const hour = new Date(nowMs).getUTCHours();
    return hour < 9 || hour >= 18;
  }
}

// ---------------------------------------------------------------------------
// Lead probability
// ---------------------------------------------------------------------------

/**
 * Computes lead probability from the intent vector.
 *
 * Returns exactly 0 for bots (bypasses the clamp intentionally).
 */
function computeLeadProbability(
  signals: Signals,
  intentVec: Record<IntentDim, number>,
  contextVec: Record<ContextDim, number>,
): number {
  if (signals.device === "bot") return 0;

  let prob = 0.2; // baseline for any human visitor

  // Citation-click: real person who clicked from an AI answer
  if (signals._isCitationClick === true) {
    prob += 0.15;
  }

  // Generic AI source bonus
  if (signals.aiSource !== null) {
    prob += 0.1;
  }

  // Pricing intent → purchase-focused visitor
  if ((intentVec.pricing ?? 0) > 0.3) {
    prob += 0.1;
  }

  // Urgency context → ready-to-buy visitor (demo/trial UTM)
  if ((contextVec.urgency ?? 0) > 0.3) {
    prob += 0.1;
  }

  // Comparison-site referrer bonus
  if (isComparisonReferrer(signals.referrerHost)) {
    prob += 0.05;
  }

  return Math.min(0.95, Math.max(0.05, prob));
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

/**
 * Classifies a visit from ambient signals into an IntentVector.
 *
 * Pure function — identical input + identical nowMs always produces identical output.
 *
 * @param signals  - Output of extractSignals.
 * @param nowMs    - Current timestamp ms. Pass Date.now() in production;
 *                   a fixed value in tests (offhours_context is time-sensitive).
 * @param timezone - IANA timezone string for offhours detection. In the edge
 *                   worker, pass request.cf?.timezone. Optional.
 */
export function classify(
  input: Signals,
  nowMs: number = Date.now(),
  timezone?: string | null,
): IntentVector {
  // A campaign name the special-category screen refuses chooses nothing,
  // as if absent (docs/specs/ads-platforms.md §5, privacy review condition 2).
  const signals = withScreenedCampaign(input);
  const intent = zeroIntent();
  const source = zeroSource();
  const context = zeroContext();

  // --- Intent dims ---
  for (const rule of INTENT_RULES) {
    const w = rule.match(signals);
    if (w <= 0) continue;
    for (const [dim, dimWeight] of Object.entries(rule.dims) as [IntentDim, number][]) {
      intent[dim] = Math.min(1.0, intent[dim] + w * (dimWeight ?? 1.0));
    }
  }

  // --- Source dims ---
  for (const rule of SOURCE_RULES) {
    const w = rule.match(signals);
    if (w <= 0) continue;
    for (const [dim, dimWeight] of Object.entries(rule.dims) as [SourceDim, number][]) {
      source[dim] = Math.min(1.0, source[dim] + w * (dimWeight ?? 1.0));
    }
  }

  // --- Context dims ---
  for (const rule of CONTEXT_RULES) {
    const w = rule.match(signals);
    if (w <= 0) continue;
    for (const [dim, dimWeight] of Object.entries(rule.dims) as [ContextDim, number][]) {
      context[dim] = Math.min(1.0, context[dim] + w * (dimWeight ?? 1.0));
    }
  }

  // --- Entry-path prior (L1, ADR 0023) ---
  // The landing path is an ambient intent proxy. Fold its per-dim weights in
  // with the same clamped addition as the rule loops. The table (path-intent.ts)
  // is the single source of truth; hasMeaningfulSignal reads the same helper so
  // the gate and the scoring can never disagree.
  // The customer's site-map entry, when the edge resolved one, replaces the
  // global table for this path (docs/specs/site-shaped-intents.md §6.1).
  const fromPath = pathDims(signals.entryPath, signals.sitePath);
  for (const [dim, w] of Object.entries(fromPath.intent) as [IntentDim, number][]) {
    intent[dim] = Math.min(1.0, intent[dim] + w);
  }
  for (const [dim, w] of Object.entries(fromPath.context) as [ContextDim, number][]) {
    context[dim] = Math.min(1.0, context[dim] + w);
  }

  // Offhours: computed from the clock, not a signal pattern.
  if (isOffhours(timezone, nowMs)) {
    context.offhours_context = 1.0;
  }

  // --- Meta ---
  // confidence = top_intent / (top + second + 1e-6), floored at 0.5
  const intentValues = Object.values(intent) as number[];
  const sortedIntent = [...intentValues].sort((a, b) => b - a);
  const top = sortedIntent[0] ?? 0;
  const second = sortedIntent[1] ?? 0;
  const confidence = top === 0 ? 0.5 : Math.max(0.5, top / (top + second + 1e-6));

  const leadProbability = computeLeadProbability(signals, intent, context);

  return {
    intent,
    source,
    context,
    meta: {
      confidence,
      lead_probability: leadProbability,
    },
  };
}
