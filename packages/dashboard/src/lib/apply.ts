/**
 * Shared bits of the pilot apply flow (docs/specs/pilot-apply.md): the
 * source chips, URL and email checks, and the admin status derivation.
 * Pure functions, no React, so the tests can read them directly.
 */

/** "Where do your visitors come from?" chips. The value is what the API stores. */
export const APPLY_SOURCES = [
  { value: "hacker_news", label: "Hacker News" },
  { value: "google", label: "Google" },
  { value: "ai", label: "ChatGPT and AI tools" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "x", label: "X" },
  { value: "reddit", label: "Reddit" },
  { value: "newsletter", label: "Newsletter" },
  { value: "ads", label: "Ads" },
  { value: "other", label: "Other" },
] as const;

const SOURCE_LABEL = new Map<string, string>(APPLY_SOURCES.map((s) => [s.value, s.label]));

/** A stored source value back to its chip label; unknown values pass through. */
export function sourceLabel(value: string): string {
  return SOURCE_LABEL.get(value) ?? value;
}

/**
 * Turns what a person types ("acme.com", "https://acme.com/pricing") into an
 * absolute http(s) URL, or null when it cannot be one. A bare word without a
 * dot is not a site.
 */
export function normalizeSiteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** The host of a site for display ("www.acme.com/x" -> "acme.com"). */
export function siteHost(raw: string | null | undefined): string {
  if (!raw) return "";
  const url = normalizeSiteUrl(raw);
  if (!url) return raw;
  return new URL(url).hostname.replace(/^www\./, "");
}

export function isEmailShape(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

/** Epoch ms, tolerating epoch seconds. */
export function toMs(ts: number | null | undefined): number | null {
  if (ts == null) return null;
  return ts < 1e12 ? ts * 1000 : ts;
}

export type ApplicationStage = "invited" | "applied" | "tag_seen" | "live" | "archived";

export const STAGE_ORDER: Exclude<ApplicationStage, "archived">[] = [
  "invited",
  "applied",
  "tag_seen",
  "live",
];

export const STAGE_LABEL: Record<ApplicationStage, string> = {
  invited: "Invited",
  applied: "Applied",
  tag_seen: "Tag seen",
  live: "Live",
  archived: "Archived",
};

/** Furthest stage reached: Live beats Tag seen beats Applied beats Invited. */
export function applicationStage(row: {
  status: "invited" | "applied" | "archived";
  tag_seen_at: number | null;
  live_at: number | null;
}): ApplicationStage {
  if (row.status === "archived") return "archived";
  if (row.live_at) return "live";
  if (row.tag_seen_at) return "tag_seen";
  if (row.status === "applied") return "applied";
  return "invited";
}

/** The step index reached, for the status line (archived keeps what it reached). */
export function stageIndex(row: {
  status: "invited" | "applied" | "archived";
  submitted_at: number | null;
  tag_seen_at: number | null;
  live_at: number | null;
}): number {
  if (row.live_at) return 3;
  if (row.tag_seen_at) return 2;
  if (row.status === "applied" || row.submitted_at) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// The site read's lines (docs/specs/install-friction.md, dashboard pass 5)
// ---------------------------------------------------------------------------

/** After this long the read line says sites built in the browser take longer. */
export const READ_SLOW_MS = 8_000;
/** After this long the read line says it can take up to a minute. */
export const READ_STILL_MS = 30_000;

/** The grey line while the read runs: 0 to 8 s, then up to 30 s, then after. */
export function readingLine(phase: 0 | 1 | 2): string {
  if (phase === 0) return "Reading your page…";
  if (phase === 1) return "Reading your site. Sites built in the browser take up to half a minute.";
  return "Still reading. This can take up to a minute.";
}

/**
 * The line for a read the server refused with 422. None of them used one of
 * the three reads (generation admin/apply.ts gives the read back).
 * client_rendered shows only while the render is off.
 */
export function readRefusal(code: string | undefined): string {
  const back = "This read did not count.";
  switch (code) {
    case "bot_protection":
      return `Your site's bot protection turned our reader away. Fill in the answers yourself. ${back}`;
    case "client_rendered":
      return `Your site builds its page in the browser, which we can't read yet. Fill in the answers yourself. ${back}`;
    case "off_host":
      return `That address redirects to another site. Type the address your visitors land on. ${back}`;
    default:
      return `We couldn't read that page just now. Fill in the rest by hand. ${back}`;
  }
}
