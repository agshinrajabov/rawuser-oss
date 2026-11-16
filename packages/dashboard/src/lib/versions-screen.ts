/**
 * Versions (dashboard v2 mock, section 03): one page at a time; the kinds of
 * visitor on the left, by where they came from; their words beside the
 * page's own on the right, why they came as a second choice, and what the
 * version did. Pure reads, tested in test/v2/versions.test.ts.
 *
 * Numbers come from GET /admin/analytics/breakdown (30 days, `by_tuple`):
 * counts per version across all pages, never per page (the breakdown has no
 * page split), and the screen says "on all pages".
 */

import type { VariantBreakdownItem, VariantListItem } from "@/types/api";
import type { ManifestResponse } from "@/types/api";
import { type PendingItem, isWaiting } from "./approval";
import { PART_NAME, type PartRow, REASONS, originalText } from "./your-versions";

/** After a rewrite that waits for the OK. */
export const WAITS_LINE = "Rewritten. It waits for your OK.";

/**
 * A waiting version's parts for the compare: the live words on the left
 * (the page's own where the cell has no live body), the new ones on the
 * right, in the API's order. A part the screen has no name for is left out.
 */
export function waitingParts(w: PendingItem, m: ManifestResponse | undefined): PartRow[] {
  return w.parts
    .filter((p) => PART_NAME[p.path])
    .map((p) => ({
      path: p.path,
      name: PART_NAME[p.path] as string,
      original: w.has_live ? p.live : originalText(m, p.path),
      version: p.next,
    }));
}

export interface Counts {
  visits: number;
  conversions: number;
}

/** A kind's visits and clicks over every reason, 30 days, all pages. */
export function kindCounts(byTuple: readonly VariantBreakdownItem[], source: string): Counts {
  return byTuple
    .filter((r) => r.source_dim === source && r.intent_dim)
    .reduce(
      (t, r) => ({ visits: t.visits + r.visits, conversions: t.conversions + r.conversions }),
      {
        visits: 0,
        conversions: 0,
      },
    );
}

/** One version's numbers: a kind and a reason. */
export function versionCounts(
  byTuple: readonly VariantBreakdownItem[],
  source: string,
  intent: string,
): Counts {
  const r = byTuple.find((t) => t.source_dim === source && t.intent_dim === intent);
  return { visits: r?.visits ?? 0, conversions: r?.conversions ?? 0 };
}

/** The reasons to offer: served ones in the screen's order. */
export function reasonsServed(served: readonly string[] | null): string[] {
  return served ? REASONS.filter((r) => served.includes(r)) : [...REASONS];
}

/** The reason picked first: the one with most visits, else the first offered. */
export function firstReason(
  byTuple: readonly VariantBreakdownItem[],
  source: string,
  reasons: readonly string[],
): string {
  let best = reasons[0] ?? "evaluation";
  let most = -1;
  for (const r of reasons) {
    const v = versionCounts(byTuple, source, r).visits;
    if (v > most) {
      most = v;
      best = r;
    }
  }
  return best;
}

export type KindState = "live" | "waiting" | "rewriting" | "none";

/** One kind on one page: waiting for an OK, being rewritten, live, or not written. */
export function kindState(
  items: readonly VariantListItem[],
  page: string,
  source: string,
  reasons: readonly string[],
): KindState {
  const mine = items.filter(
    (i) => i.page_path === page && i.source_dim === source && reasons.includes(i.intent_dim),
  );
  if (mine.some((i) => isWaiting(i) || i.status === "pending")) return "waiting";
  if (mine.some((i) => i.status === "ready")) return "live";
  if (mine.some((i) => i.status === "stale")) return "rewriting";
  return "none";
}

/** The state of one version (a kind and a reason) on a page. */
export function versionState(
  items: readonly VariantListItem[],
  page: string,
  source: string,
  intent: string,
): KindState {
  const it = items.find(
    (i) => i.page_path === page && i.source_dim === source && i.intent_dim === intent,
  );
  if (!it) return "none";
  if (isWaiting(it) || it.status === "pending") return "waiting";
  if (it.status === "stale") return "rewriting";
  return it.status === "ready" ? "live" : "none";
}

export const KIND_LINE: Record<KindState, string> = {
  live: "Live",
  waiting: "New, waiting for your OK",
  rewriting: "Being rewritten",
  none: "Not written yet",
};

export function pct(c: number, v: number): string {
  return v > 0 ? `${((c / v) * 100).toFixed(1)}%` : "0%";
}
