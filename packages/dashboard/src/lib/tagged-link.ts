/**
 * Tagged links, shared by Campaign links (/links) and the "Make a tagged
 * link" dialog on Results. The link is built by the Campaign links
 * generator (`buildLink`) and read back by the same classifier the edge
 * runs, so what the dialog says a visit will see is what it sees.
 */

import { classify, extractSignals } from "@rawuser/shared";
import type { IntentDim, SourceDim } from "@rawuser/shared";
import { siteOrigin } from "@rawuser/shared";

// ---------------------------------------------------------------------------
// The Campaign links generator
// ---------------------------------------------------------------------------

export const INTENT_UTM_CAMPAIGN: Record<IntentDim, string> = {
  competitor: "vs-competitor",
  evaluation: "comparison",
  feature: "features",
  problem: "how-it-works",
  brand: "brand",
  pricing: "pricing",
};

export const SOURCE_UTM_SOURCE: Record<SourceDim, string | null> = {
  ai: "chatgpt",
  social: "linkedin",
  community: "reddit",
  paid: "google-ads",
  organic: "google",
  direct: null,
};

export const SOURCE_UTM_MEDIUM: Record<SourceDim, string | null> = {
  ai: null,
  social: "social",
  community: null,
  paid: "cpc",
  organic: null,
  direct: null,
};

export interface LinkConfig {
  baseUrl: string;
  intentTarget: IntentDim;
  sourceTarget: SourceDim;
  campaignOverride: string;
  sourceOverride: string;
}

export interface BuiltLink {
  url: string;
  utmCampaign: string;
  utmSource: string | null;
  utmMedium: string | null;
}

export function buildLink(cfg: LinkConfig): BuiltLink | null {
  let parsed: URL;
  try {
    parsed = new URL(cfg.baseUrl.trim());
  } catch {
    return null;
  }

  const utmCampaign = cfg.campaignOverride.trim() || INTENT_UTM_CAMPAIGN[cfg.intentTarget];
  const utmSource = cfg.sourceOverride.trim() || SOURCE_UTM_SOURCE[cfg.sourceTarget];
  const utmMedium = SOURCE_UTM_MEDIUM[cfg.sourceTarget];

  parsed.searchParams.set("utm_campaign", utmCampaign);
  if (utmSource) {
    parsed.searchParams.set("utm_source", utmSource);
  }
  if (utmMedium) {
    parsed.searchParams.set("utm_medium", utmMedium);
  }

  return { url: parsed.toString(), utmCampaign, utmSource, utmMedium };
}

// ---------------------------------------------------------------------------
// The classifier, as the edge runs it
// ---------------------------------------------------------------------------

/** The dominant intent and source the edge will read from a link. */
export function classifyLink(url: string): { intent: IntentDim; source: SourceDim } {
  try {
    const parsed = new URL(url);
    // entryPath as the edge reads it (entry-path L1, ADR 0023): a link to
    // /pricing reads as pricing whatever its campaign says.
    const signals = extractSignals({
      url: parsed,
      headers: new Headers(),
      entryPath: parsed.pathname,
    });
    const vector = classify(signals, Date.now(), null);
    const top = <K extends string>(o: Record<K, number>, fallback: K): K =>
      ((Object.entries(o) as [K, number][]).sort(([, a], [, b]) => b - a)[0]?.[0] ?? fallback) as K;
    return { intent: top(vector.intent, "brand"), source: top(vector.source, "direct") };
  } catch {
    return { intent: "brand", source: "direct" };
  }
}

/** Where a customer shares a link, and the tag it gets. */
export interface SharePlace {
  id: string;
  label: string;
  source: SourceDim;
  utmSource: string;
}

/** Each checked against the classifier in test/analytics/tagged-link.test.ts. */
export const SHARE_PLACES: SharePlace[] = [
  { id: "linkedin", label: "LinkedIn", source: "social", utmSource: "linkedin" },
  { id: "x", label: "X", source: "social", utmSource: "x" },
  { id: "facebook", label: "Facebook", source: "social", utmSource: "facebook" },
  { id: "instagram", label: "Instagram", source: "social", utmSource: "instagram" },
  { id: "reddit", label: "Reddit", source: "social", utmSource: "reddit" },
  { id: "newsletter", label: "Newsletter", source: "direct", utmSource: "newsletter" },
  { id: "google-ads", label: "Google Ads", source: "paid", utmSource: "google-ads" },
];

/** What the post or ad is about: the version its visits get. */
export const ABOUT: { intent: IntentDim; label: string }[] = [
  { intent: "problem", label: "The problem" },
  { intent: "feature", label: "Features" },
  { intent: "pricing", label: "Pricing" },
  { intent: "competitor", label: "A comparison" },
  { intent: "evaluation", label: "Choosing a tool" },
  { intent: "brand", label: "Your product" },
];

/** "https://brisk.test/" from a stored domain that may carry a scheme or a path. */
export function homeUrl(domain: string): string {
  const host = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // https, or http for a site on this machine or one typed with http.
  return host ? `${siteOrigin(domain)}/` : "";
}

/** The tagged link for a page, a place and a topic; null when the page is not a URL. */
export function taggedLink(
  pageUrl: string,
  place: SharePlace,
  about: IntentDim,
): { url: string; intent: IntentDim; source: SourceDim } | null {
  const built = buildLink({
    baseUrl: pageUrl,
    intentTarget: about,
    sourceTarget: place.source,
    campaignOverride: "",
    sourceOverride: place.utmSource,
  });
  if (!built) return null;
  return { url: built.url, ...classifyLink(built.url) };
}
