/**
 * Frozen dimension tuples for the intent vector.
 *
 * These three tuples are the permanent foundation of the Rawuser intent
 * model (V1/V2/V3). Do not reorder — tuple order determines tie-breaking
 * in selectVariantKey. Adding a new dim is a breaking change; discuss in
 * an ADR before touching this file.
 *
 * Definitions:
 *   intent.competitor  = "vs a specific named rival" (e.g. "Salesforce alternative")
 *   intent.evaluation  = "comparing the category, no rival yet" (G2/Capterra/best-X)
 *   intent.feature     = deep capability interest, not category shopping
 *   intent.problem     = pain-first arrival; "how do I…" / "why…" / AI-answer-click
 *   intent.brand       = direct / no-signal arrival; already knows the product
 *   intent.pricing     = cost / plan / free-tier primary concern
 *
 *   source.ai          = arrived from an AI tool (ChatGPT, Claude, Perplexity…)
 *   source.social      = arrived from social media (LinkedIn, Twitter/X, Instagram…)
 *   source.community   = arrived from a developer community (Reddit, HN, Discord…)
 *   source.paid        = arrived via a paid campaign (CPC/PPC/Google Ads…)
 *   source.organic     = arrived via organic search (Google, Bing, DuckDuckGo…)
 *   source.direct      = no UTM, no referrer; bookmarked / typed-in
 *
 *   context.price_sensitivity  = signals of cost concern (free/cheap/indie UTM…)
 *   context.technical_depth    = signals of technical evaluation (community, GitHub…)
 *   context.urgency            = signals of ready-to-buy pressure (demo/trial/now UTM…)
 *                                NOTE: demo/trial UTM → urgency, NOT intent.evaluation.
 *                                Those are ready-to-buy visitors, not category researchers.
 *   context.trust_need         = signals of risk aversion (security/compliance/enterprise…)
 *   context.mobile_context     = device is mobile
 *   context.offhours_context   = visit outside business hours (09:00–18:00 local tz)
 */

export const INTENT_DIMENSIONS = [
  "competitor",
  "evaluation",
  "feature",
  "problem",
  "brand",
  "pricing",
] as const;

export const SOURCE_DIMENSIONS = [
  "ai",
  "social",
  "community",
  "paid",
  "organic",
  "direct",
] as const;

export const CONTEXT_DIMENSIONS = [
  "price_sensitivity",
  "technical_depth",
  "urgency",
  "trust_need",
  "mobile_context",
  "offhours_context",
] as const;

/** Union of valid intent dimension names. */
export type IntentDim = (typeof INTENT_DIMENSIONS)[number];

/** Union of valid source dimension names. */
export type SourceDim = (typeof SOURCE_DIMENSIONS)[number];

/** Union of valid context dimension names. */
export type ContextDim = (typeof CONTEXT_DIMENSIONS)[number];
