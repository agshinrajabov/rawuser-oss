/**
 * Page groups, the reads the endpoints share (docs/specs/page-groups.md,
 * phase 1): the accepted patterns of a customer, the counts the analytics
 * aggregator wrote for them (`per_page.groups`, the proposals too) and the
 * mark on a group's counted button in a target list. Offline code; the
 * customer's own site structure and counts, nothing about a visitor.
 */

import { countPageIsGroup, countTargetPage, isPageGroupPattern } from "@rawuser/shared";

/** One group as the aggregator counts it: distinct pages with visits and visits. */
export interface GroupCount {
  pattern: string;
  pages: number;
  visits: number;
}

/** What the newest aggregate row says about groups and pages. */
export interface GroupAggregate {
  /** `per_page.groups`, patterns the aggregator proposed or counted; empty when the field is absent. */
  groups: GroupCount[];
  /** The masked paths with visits the row lists (`per_page.pages[].page_path`). */
  pagesWithVisits: string[];
}

const NONE: GroupAggregate = { groups: [], pagesWithVisits: [] };

/**
 * The newest 30-day aggregate row's `per_page.groups` and its listed pages.
 * Empty when there is no row, no field, or the field is not a list; a bad
 * entry is skipped. The aggregator (the analytics engineer's side) writes
 * `[{ pattern, pages, visits }]`; nothing is computed here.
 */
export async function groupAggregate(db: D1Database, customerId: string): Promise<GroupAggregate> {
  const row = await db
    .prepare(
      `SELECT per_page FROM analytics_aggregates
       WHERE customer_id = ? AND window = '30d'
       ORDER BY window_start DESC LIMIT 1`,
    )
    .bind(customerId)
    .first<{ per_page: string | null }>();
  if (!row || typeof row.per_page !== "string") return NONE;
  let parsed: { groups?: unknown; pages?: unknown };
  try {
    parsed = JSON.parse(row.per_page) as typeof parsed;
  } catch {
    return NONE;
  }
  const groups: GroupCount[] = [];
  for (const g of Array.isArray(parsed?.groups) ? parsed.groups : []) {
    const e = (g ?? {}) as { pattern?: unknown; pages?: unknown; visits?: unknown };
    if (!isPageGroupPattern(e.pattern)) continue;
    groups.push({
      pattern: e.pattern,
      pages: Number(e.pages) || 0,
      visits: Number(e.visits) || 0,
    });
  }
  const pagesWithVisits: string[] = [];
  for (const p of Array.isArray(parsed?.pages) ? parsed.pages : []) {
    const path = (p as { page_path?: unknown })?.page_path;
    if (typeof path === "string") pagesWithVisits.push(path);
  }
  return { groups, pagesWithVisits };
}

/** The accepted patterns of a customer, sorted. */
export async function acceptedGroups(db: D1Database, customerId: string): Promise<string[]> {
  const rows = await db
    .prepare("SELECT pattern FROM page_groups WHERE customer_id = ? ORDER BY pattern")
    .bind(customerId)
    .all<{ pattern: string }>();
  return (rows.results ?? []).map((r) => String(r.pattern));
}

/** What a group's counted button carries in a target list, so the dashboard can say "on N pages". */
export interface GroupTargetMark {
  /** The pattern, as the target's page part. */
  page: string;
  group: true;
  /** Pages with visits the aggregator counted for the pattern; null when it has not. */
  pages: number | null;
}

/**
 * A target list with every group's button marked (`page`, `group: true`,
 * `pages`); a single page's button and a manifest slot are returned as they
 * are, so the list's shape for a customer without groups is unchanged.
 */
export function markGroupTargets<T extends { section_path: string }>(
  items: readonly T[],
  counts: readonly GroupCount[] = [],
): Array<T | (T & GroupTargetMark)> {
  return items.map((t) => {
    const page = countTargetPage(t.section_path);
    if (page === null || !countPageIsGroup(page)) return t;
    const count = counts.find((c) => c.pattern === page);
    return { ...t, page, group: true as const, pages: count ? count.pages : null };
  });
}
