import type { CustomerListItem, VariantListItem } from "@/types/api";
import { siteOrigin } from "@rawuser/shared";

/**
 * The first-run flow (docs/specs/first-run.md): one road, three steps.
 * Which step a customer is on is derived from the customers row, never
 * stored, so a refresh always lands on the right screen.
 */
export type FirstRunStep = "connect" | "look" | "live";

export function firstRunStep(c: CustomerListItem): FirstRunStep {
  if (c.live_at) return "live";
  // A confirmed page without go-live (URL-first path) still needs the
  // guided go-live, which the Look screen provides once a result exists.
  if (c.preview_seen_at && !c.has_confirmed_manifest) return "look";
  return "connect";
}

// The full generation surface: 6 intents × 6 source modifiers = 36 tuples.
// Source-major so the six defaults (what the gallery shows) come first.
export const ALL_INTENT_DIMS = [
  "competitor",
  "evaluation",
  "feature",
  "problem",
  "brand",
  "pricing",
];
export const ALL_GENERATION_SOURCE_DIMS = [
  "default",
  "ai",
  "social",
  "community",
  "organic",
  "paid",
];
export const TOTAL_TUPLES = ALL_INTENT_DIMS.length * ALL_GENERATION_SOURCE_DIMS.length;

/**
 * The tuples a page gets, source-major, for the served intents only
 * (site-shaped intents §7.3): a folded intent is never asked for. `null`
 * (the site map not read yet, or an older worker) means all six.
 */
export function allTuples(
  served: readonly string[] | null = null,
): { intent_dim: string; source_dim: string }[] {
  const intents = served ? ALL_INTENT_DIMS.filter((d) => served.includes(d)) : ALL_INTENT_DIMS;
  const out: { intent_dim: string; source_dim: string }[] = [];
  for (const source_dim of ALL_GENERATION_SOURCE_DIMS) {
    for (const intent_dim of intents) out.push({ intent_dim, source_dim });
  }
  return out;
}

/** Versions per page: 36, 30 or 24 (the site map's `versions_per_page`). */
export function tuplesPerPage(served: readonly string[] | null = null): number {
  return allTuples(served).length;
}

/** Ready versions of the served intents on one page; old folded ones do not count. */
export function readyOnPage(
  items: VariantListItem[],
  pagePath: string,
  served: readonly string[] | null = null,
): number {
  return items.filter(
    (i) =>
      i.page_path === pagePath &&
      i.status === "ready" &&
      (served === null || served.includes(i.intent_dim)),
  ).length;
}

/** Tuples not yet ready for the path, in writing order. Reload-safe: done ones are skipped. */
export function missingTuples(
  items: VariantListItem[],
  pagePath: string,
  served: readonly string[] | null = null,
): { intent_dim: string; source_dim: string }[] {
  const ready = new Set(
    items
      // A written body that waits for the OK, or one the customer discarded,
      // is not missing: the loop's call would only answer `waiting`.
      .filter(
        (i) =>
          i.page_path === pagePath &&
          (i.status === "ready" || i.status === "pending" || i.status === "discarded"),
      )
      .map((i) => `${i.intent_dim}:${i.source_dim}`),
  );
  return allTuples(served).filter((t) => !ready.has(`${t.intent_dim}:${t.source_dim}`));
}

/**
 * How the write loop counts an answer of /admin/variant/regenerate:
 * `not_served` (an intent the site folds, nothing spent) is skipped, never a
 * failure, so the Live screen never asks for it again; `waiting` (the queue
 * is leaving the row alone after a failed try, nothing spent) is the row
 * still not written, never the writing service failing.
 */
export function writeOutcome(
  res: { ok?: boolean; error?: string; reason?: string } | null | undefined,
): { kind: "ok" } | { kind: "skipped" } | { kind: "waiting" } | { kind: "failed"; reason: string } {
  if (!res || res.ok !== false) return { kind: "ok" };
  if (res.error === "not_served") return { kind: "skipped" };
  if (res.error === "waiting") return { kind: "waiting" };
  return { kind: "failed", reason: res.error ?? res.reason ?? "not written" };
}

/** The link a customer opens to see a version with their own eyes. */
export function seeItLink(domain: string): string {
  return `${siteOrigin(domain)}/?utm_source=linkedin&utm_medium=social`;
}
