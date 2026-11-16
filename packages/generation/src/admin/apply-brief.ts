/**
 * Pure pieces of the pilot apply flow (docs/specs/pilot-apply.md,
 * 2026-10-01): the slug a domain gets, the source chips, the trimmed
 * suggestions the apply page sees, and the answers-to-brief mapping.
 * No I/O here, so the tests read them directly.
 */

import type { BusinessDNA, DnaSuggestions } from "@rawuser/shared";
import { CUSTOMER_SLUG_MAX } from "./handlers.ts";

// ---------------------------------------------------------------------------
// Slug from a domain
// ---------------------------------------------------------------------------

/** Second-level labels that are part of a public suffix (foo.co.uk → foo). */
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu"]);

/** Room left for a "-NN" suffix on a clash. */
const SLUG_BASE_MAX = CUSTOMER_SLUG_MAX - 4;

/**
 * "northwind-app.test" → "northwind-app", "www.foo.co.uk" → "foo",
 * "app.bar.io" → "app-bar". The top-level label (and a short second level
 * under a country code) is dropped, the rest joined with hyphens.
 */
export function slugFromDomain(hostname: string): string {
  const labels = hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .split(".")
    .filter((l) => l !== "");
  if (labels[0] === "www" && labels.length > 2) labels.shift();
  if (labels.length > 1) labels.pop();
  const last = labels[labels.length - 1];
  if (labels.length > 1 && last && SECOND_LEVEL.has(last)) labels.pop();
  const slug = labels
    .join("-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, SLUG_BASE_MAX)
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "site" : slug;
}

/** The n-th candidate for a slug: the base, then base-2, base-3, … */
export function slugCandidate(base: string, n: number): string {
  return n <= 1 ? base : `${base}-${n}`;
}

// ---------------------------------------------------------------------------
// Sources (answer 6)
// ---------------------------------------------------------------------------

/**
 * The chip values the dashboard stores (packages/dashboard/src/lib/apply.ts,
 * APPLY_SOURCES), keyed also by their labels so either form is accepted.
 */
const SOURCE_ALIASES: Record<string, string> = {
  hacker_news: "hacker_news",
  "hacker news": "hacker_news",
  hackernews: "hacker_news",
  google: "google",
  ai: "ai",
  "chatgpt and ai tools": "ai",
  linkedin: "linkedin",
  x: "x",
  reddit: "reddit",
  newsletter: "newsletter",
  ads: "ads",
  other: "other",
};

export const MAX_SOURCES = 10;

/** Canonical source values, or null when any entry is not on the list. */
export function normalizeSources(input: unknown): string[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > MAX_SOURCES) return null;
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") return null;
    const value = SOURCE_ALIASES[raw.trim().toLowerCase()];
    if (!value) return null;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Suggestions as the apply page sees them
// ---------------------------------------------------------------------------

export interface ApplySuggestions {
  product: string | null;
  icp: string | null;
  differentiators: string[];
  proof_points: string[];
  value_props: string[];
  language: string | null;
}

/** The read answer: texts only, no evidence quotes, no URL, no timestamps. */
export function trimSuggestions(s: DnaSuggestions): ApplySuggestions {
  return {
    product: s.product,
    icp: s.icp,
    differentiators: s.differentiators.map((d) => d.text),
    proof_points: s.proof_points.map((d) => d.text),
    value_props: s.value_props.map((d) => d.text),
    language: s.language,
  };
}

// ---------------------------------------------------------------------------
// Answers → brief
// ---------------------------------------------------------------------------

export interface ApplyAnswers {
  product: string;
  icp: string;
  differentiator: string;
  numbers: string;
  sources: string[];
}

/** Case- and space-insensitive de-duplication, first occurrence kept. */
function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const t = item.trim();
    const key = t.toLowerCase().replace(/\s+/g, " ");
    if (t === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * The spec's mapping table: the customer's answers first, the suggestions
 * read from the site after them; value_props falls back to the product
 * line so the brief always has one.
 */
export function briefFromAnswers(
  customerId: string,
  answers: ApplyAnswers,
  suggestions: DnaSuggestions | null,
  now: number,
): BusinessDNA {
  const suggested = (list: DnaSuggestions["value_props"] | undefined): string[] =>
    (list ?? []).map((d) => d.text);
  const numberLines = answers.numbers.split(/\r?\n/);
  const valueProps = dedupe(suggested(suggestions?.value_props));
  return {
    customer_id: customerId,
    product: answers.product,
    icp: answers.icp,
    differentiators: dedupe([answers.differentiator, ...suggested(suggestions?.differentiators)]),
    proof_points: dedupe([...numberLines, ...suggested(suggestions?.proof_points)]),
    value_props: valueProps.length > 0 ? valueProps : [answers.product],
    target_market: suggestions?.target_market ?? "",
    brand_voice: suggestions?.brand_voice ?? "",
    target_language: suggestions?.language?.trim() || "en",
    per_intent_hints: {},
    updated_at: now,
  };
}
