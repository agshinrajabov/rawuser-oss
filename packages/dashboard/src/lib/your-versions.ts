/**
 * Versions for every customer (docs/specs/versions-for-every-customer.md):
 * the words of the screen and the pure reads behind it. Every version a
 * visitor can get, by where the visitor came from and why, with the page's
 * own words beside it. No cost, model, rule or key ever reaches it.
 */

import type { ManifestResponse, VariantListItem, VariantSummary } from "@/types/api";
import { PICK_SLOTS, type VariantBody } from "@rawuser/shared";

/** The visitor kinds, in the order the screen shows them (the AI story first). */
export const VISITOR_KINDS: ReadonlyArray<{ source: string; label: string }> = [
  { source: "ai", label: "AI assistants" },
  { source: "organic", label: "Search" },
  { source: "social", label: "Social apps" },
  { source: "community", label: "Communities" },
  { source: "paid", label: "Ads" },
  { source: "default", label: "Everyone else" },
];

/** Why they came, in the screen's order. */
export const REASONS = ["problem", "evaluation", "competitor", "feature", "pricing", "brand"];

/** A part as the compare grid names it. */
export const PART_NAME: Record<string, string> = {
  "hero.headline": "Headline",
  "hero.body": "Opening paragraph",
  "hero.cta.label": "Main button",
  "cta.cta.label": "Call-to-action button",
  "features.headline": "Section headline",
  "features.body": "Section paragraph",
  "pricing.cta.label": "Pricing button",
  "forms.submit_label": "Form button",
};

export const LINES = {
  title: "Versions",
  lead: "What each visitor reads on your page.",
  who: "Who is reading",
  yourPage: "Your page",
  thisVersion: "This version",
  asBuilt: "Stays as on your page",
  noOriginal: "Not on record",
  notWritten: "Not written yet",
  queued: "Being rewritten",
  rewrite: "Have this one rewritten",
  rewriting: "Rewriting…",
  rewritten: "Rewritten.",
  failed: "Could not rewrite it just now. Try again later.",
  refused: "The new words did not pass our checks. This version stays as it was.",
  down: "The writing service is not answering. Try again later.",
  foot: "Each rewrite writes the version again from your brief.",
  noPages: "No page is live yet. Versions show here once one is.",
} as const;

/** The intents shown: the site's served ones in the screen's order, or all six. */
export function reasonsFor(served: readonly string[] | null): string[] {
  return served ? REASONS.filter((r) => served.includes(r)) : REASONS;
}

/** Confirmed pages, the homepage first. */
export function livePages(manifests: readonly ManifestResponse[] | null): string[] {
  const paths = [
    ...new Set((manifests ?? []).filter((m) => m.status === "confirmed").map((m) => m.page_path)),
  ];
  return paths.sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
}

/**
 * The page's own words for one part, from the confirmed manifest's text
 * signature. The picker keeps 40 characters, so a longer part ends in an
 * ellipsis (its stored length says so).
 */
export function originalText(m: ManifestResponse | undefined, path: string): string | null {
  const el = m?.manifest[path];
  const text = el?.text?.[0]?.trim();
  if (!text) return null;
  const full = el?.original_char_length ?? 0;
  return full > text.length + 1 ? `${text.replace(/[\s.,;:]+$/, "")}…` : text;
}

/** One leaf of a version body by its manifest path ("hero.cta.label"). */
export function versionText(body: VariantBody | null, path: string): string | null {
  if (!body) return null;
  const [section, ...rest] = path.split(".");
  let node: unknown = section ? (body.sections as Record<string, unknown>)[section] : undefined;
  for (const key of rest) {
    node = node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
  }
  return typeof node === "string" && node.trim() ? node : null;
}

export interface PartRow {
  path: string;
  name: string;
  original: string | null;
  /** The version's words; null when the version leaves the part as built. */
  version: string | null;
}

/** The parts of a page the screen compares, in the picker's order. */
export function partRows(m: ManifestResponse | undefined, body: VariantBody | null): PartRow[] {
  if (!m) return [];
  return PICK_SLOTS.filter((s) => m.manifest[s.path] && PART_NAME[s.path]).map((s) => ({
    path: s.path,
    name: PART_NAME[s.path] as string,
    original: originalText(m, s.path),
    version: versionText(body, s.path),
  }));
}

/** The row's one line: the version's headline, else its first written part. */
export function rowHeadline(body: VariantBody | null, parts: readonly PartRow[]): string | null {
  return versionText(body, "hero.headline") ?? parts.find((p) => p.version)?.version ?? null;
}

/** "30 versions on 2 pages." from the list, served intents only. */
export function countLine(
  items: readonly VariantListItem[],
  pages: readonly string[],
  served: readonly string[] | null,
): string | null {
  const n = items.filter(
    (i) =>
      pages.includes(i.page_path) &&
      (served === null || served.includes(i.intent_dim)) &&
      (i.status === "ready" || i.status === "stale"),
  ).length;
  if (n === 0 || pages.length === 0) return null;
  const v = n === 1 ? "1 version" : `${n} versions`;
  const p = pages.length === 1 ? "1 page" : `${pages.length} pages`;
  return `${v} on ${p}`;
}

/** "9 of 10 rewrites left today." */
export function leftLine(left: number | null, perDay: number | null): string | null {
  if (left === null || perDay === null) return null;
  return left <= 0 ? "No rewrites left today." : `${left} of ${perDay} rewrites left today.`;
}

/** What a rewrite's answer says to the customer, from its closed word. */
export function rewriteLine(answer: { ok?: boolean; error?: string } | null): string {
  if (!answer) return LINES.failed;
  if (answer.ok) return LINES.rewritten;
  if (answer.error === "service_down") return LINES.down;
  if (answer.error === "waiting") return LINES.failed;
  return LINES.refused;
}

/** GET /admin/variants/list?summary=1 as a customer reads it. */
export interface CustomerVersionList {
  items: VariantListItem[];
  summary?: VariantSummary | null;
  /** Present for a customer's own session only. */
  rewrites?: { left: number; per_day: number };
}
