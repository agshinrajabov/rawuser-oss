/**
 * Dashboard v2 (design/mock/dashboard-v2, approved 2026-11-02): the words
 * Visitors and Versions share. A version is named by where its visitors
 * came from (decision D5), so a row on Visitors and a kind on Versions read
 * the same. Why they came is the second choice, inside a kind.
 *
 * Source words are the edge's source dimension (`ai`, `social`, ...). No
 * intent, cohort, holdout, manifest or variant ever reaches the screen.
 */

export interface VisitorKind {
  /** The source dimension word. */
  source: string;
  /** "From AI chats": the kind on Versions. */
  label: string;
  /** "AI chat": the version's short name (Visitors' version panel, the matrix). */
  short: string;
  /** Who they are, one line. */
  who: string;
}

/** In the screen's order: the AI story first. */
export const KINDS: readonly VisitorKind[] = [
  {
    source: "ai",
    label: "From AI chats",
    short: "AI chat",
    who: "ChatGPT, Perplexity, Claude and other AI chats",
  },
  {
    source: "social",
    label: "From social",
    short: "Social",
    who: "LinkedIn, X and other social apps",
  },
  {
    source: "organic",
    label: "From search",
    short: "Search",
    who: "Google, Bing and other search engines",
  },
  { source: "paid", label: "From ads", short: "Ads", who: "Clicks on your ads" },
  {
    source: "community",
    label: "From communities",
    short: "Communities",
    who: "Reddit, Hacker News and forums",
  },
  {
    source: "default",
    label: "From other sites",
    short: "General",
    who: "Tagged links, articles and partner sites",
  },
];

let regionNames: Intl.DisplayNames | null = null;
/** "GB" -> "United Kingdom"; the code itself when the browser has no name. */
export function regionName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

const MARKET = /^mk-([a-z]{2})$/;

/**
 * A market version (ADR 0038 part 5, source `mk-{cc}`): written for visits
 * with nothing to go on from one of the site's biggest countries.
 */
export function marketKind(source: string | null | undefined): VisitorKind | null {
  const m = MARKET.exec(source ?? "");
  if (!m?.[1]) return null;
  const name = regionName(m[1].toUpperCase());
  return {
    source: source as string,
    label: `Visitors in ${name}`,
    short: name,
    who: `Came straight to the page from ${name}, with nothing else to go on`,
  };
}

/**
 * The kind for a source word. `direct` (a visit whose only signal is the
 * customer's own tags) gets the general version, so it reads "General".
 */
export function kindOf(source: string | null | undefined): VisitorKind | null {
  const s = source === "direct" ? "default" : source;
  return KINDS.find((k) => k.source === s) ?? marketKind(source);
}

/** "AI chat version", "Your page, kept for the test", "Your page, no version". */
export function versionName(kind: "version" | "original" | "as_built", source?: string | null) {
  if (kind === "original") return "Your page, kept for the test";
  if (kind === "as_built") return "Your page, no version";
  const k = kindOf(source ?? null);
  if (k && marketKind(source)) return k.label;
  return k ? `${k.short} version` : "Other version";
}

/** The matrix's column word. */
export function versionShort(kind: "version" | "original" | "as_built", source?: string | null) {
  if (kind === "original") return "Test";
  if (kind === "as_built") return "No version";
  return kindOf(source ?? null)?.short ?? "Other";
}

/** Why they came, in buyer words (the second choice on Versions). */
export const REASON_LABEL: Record<string, string> = {
  evaluation: "Choosing",
  competitor: "Comparing",
  pricing: "Asking about price",
  problem: "Has a problem",
  feature: "Wants details",
  brand: "Knows you",
};

export function reasonLabel(intent: string): string {
  return REASON_LABEL[intent] ?? intent.charAt(0).toUpperCase() + intent.slice(1);
}

/** Where a visit came from, as a Visitors row names it. `none`: nothing to go on. */
export const SOURCE_ROW: Record<string, { label: string; sub?: string }> = {
  none: {
    label: "Direct or unknown",
    sub: "Typed the address, a bookmark, or an app that hides it",
  },
  ai: { label: "AI chats" },
  social: { label: "Social" },
  organic: { label: "Search" },
  paid: { label: "Ads" },
  community: { label: "Communities" },
  direct: { label: "Your tagged links", sub: "Newsletters and links you tagged" },
  default: { label: "Other sites", sub: "Links from articles, partners and directories" },
};

export function sourceRow(source: string): { label: string; sub?: string } {
  return SOURCE_ROW[source] ?? { label: source.charAt(0).toUpperCase() + source.slice(1) };
}

/** "/" -> "Home", "/pricing" -> "/pricing". */
export function pageName(path: string): string {
  return path === "/" ? "Home" : path;
}
