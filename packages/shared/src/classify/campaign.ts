/**
 * The campaign words the classifier reads, and their screen
 * (docs/specs/ads-platforms.md §5; privacy review condition 2,
 * 2026-10-22).
 *
 * A campaign name is the advertiser's own label, read in memory at
 * `/select` to choose an intent or a context. Some names say who an ad was
 * for ("diabetes-pricing"): once a campaign rule matches, the name is read
 * by the special-category screen (Art. 9 and Art. 10, en, az, ru, tr), and
 * a refused name chooses nothing, as if it were absent. The screen returns
 * a yes or no, never the words; nothing here is stored or logged.
 */

import { refusesSpecialCategory } from "../special-category/terms.ts";
import type { Signals } from "../types.ts";

/** "vs a specific named rival" ("salesforce-alternative"). */
export const CAMPAIGN_COMPETITOR_RE = /\bvs\b|alternative$|alternatives-to/;
/** Comparing the category, no rival yet. */
export const CAMPAIGN_EVALUATION_RE = /\b(comparison|review|alternatives|best)\b/;
export const CAMPAIGN_FEATURE_RE = /\b(enterprise|security|api|integration|features)\b/;
export const CAMPAIGN_PROBLEM_RE = /\b(how|why|problem|tutorial|guide)\b/;
export const CAMPAIGN_PRICING_RE = /\b(pricing|free|plan|cost|cheap|indie)\b/;
export const CAMPAIGN_PRICE_SENSITIVE_RE = /\b(free|cheap|indie|bootstrap|startup)\b/;
export const CAMPAIGN_TECHNICAL_RE = /\b(api|integration|sdk|developer|technical|engineering)\b/;
/** demo and trial are urgency, never evaluation. */
export const CAMPAIGN_URGENCY_RE = /\b(demo|trial|now|today|launch|asap|deadline)\b/;
export const CAMPAIGN_TRUST_RE = /\b(security|compliance|enterprise|gdpr|soc2)\b/;

const CAMPAIGN_RULES: readonly RegExp[] = [
  CAMPAIGN_COMPETITOR_RE,
  CAMPAIGN_EVALUATION_RE,
  CAMPAIGN_FEATURE_RE,
  CAMPAIGN_PROBLEM_RE,
  CAMPAIGN_PRICING_RE,
  CAMPAIGN_PRICE_SENSITIVE_RE,
  CAMPAIGN_TECHNICAL_RE,
  CAMPAIGN_URGENCY_RE,
  CAMPAIGN_TRUST_RE,
];

/**
 * True when a campaign rule matches the name and the special-category
 * screen refuses it. A name no rule reads chooses nothing anyway and is
 * not screened (the screen costs a table walk).
 */
export function campaignRefused(campaign: string | null | undefined): boolean {
  if (!campaign) return false;
  if (!CAMPAIGN_RULES.some((re) => re.test(campaign))) return false;
  return refusesSpecialCategory(campaign);
}

/** The signals with a refused campaign taken out, as if it never came; else the same object. */
export function withScreenedCampaign(signals: Signals): Signals {
  if (!campaignRefused(signals.utm.campaign)) return signals;
  const { campaign: _refused, ...utm } = signals.utm;
  return { ...signals, utm };
}
