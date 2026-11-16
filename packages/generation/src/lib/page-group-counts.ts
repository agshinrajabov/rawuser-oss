/**
 * The counting side of page groups (docs/specs/page-groups.md, phase 1;
 * privacy review conditions 6 and 8 fall here): what the hourly
 * aggregator proposes and the counts of the accepted patterns, stored as
 * `per_page.groups` and read by the breakdown and the group endpoints.
 *
 * A proposal is a pattern, never an example path: the fixed part (one or
 * two segments) under which at least GROUP_PROPOSAL_MIN_PAGES distinct
 * masked paths exactly one segment deeper had visits in the window and are
 * not confirmed pages. Every fixed segment passes the kept-section rule and
 * `segmentHoldsIdentifier` through the shared `validPageGroupPattern`, so a
 * fixed part holding `:id`, `:item`, an all-digit or a token segment is
 * never proposed, for every customer. An accepted pattern is counted
 * whatever its page count, so the card can show it at 0.
 *
 * Counts only, per customer and window: distinct pages and distinct visits.
 * The fixed part is the site's own structure. A sensitive customer's
 * proposals are computed in code from the counter's rows over folded days
 * (lib/sensitive-pages.ts `sensitiveGroupPages`, no statement of their own)
 * and name a kept section's group only; `/:item` is never a pattern.
 */

import {
  GROUP_SUFFIX,
  type PageGroupRow,
  groupFixedPart,
  isGroupPath,
  validPageGroupPattern,
} from "@rawuser/shared";
import type { GroupVisitsRow } from "./sensitive-pages.ts";

/** A fixed part is proposed with this many distinct pages under it. */
export const GROUP_PROPOSAL_MIN_PAGES = 5;

/** One group as stored in `per_page.groups`. */
export interface GroupCount {
  pattern: string;
  /** Distinct masked paths one segment under the fixed part with a visit in the window. */
  pages: number;
  /** Distinct visits across those pages (for a sensitive customer, see `sensitiveGroupCounts`). */
  visits: number;
}

/** One row of the aggregator's proposals statement: a fixed part and its counts. */
export interface FixedPartRow {
  fixed: string;
  pages: number;
  visits: number;
}

/** Plain code-unit order: the same on every runtime, whatever its locale. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortCounts(groups: GroupCount[]): GroupCount[] {
  return groups.sort(
    (a, b) => b.visits - a.visits || b.pages - a.pages || byText(a.pattern, b.pattern),
  );
}

/** The accepted patterns with no count yet, at 0. */
function withAccepted(groups: Map<string, GroupCount>, accepted: readonly string[]): GroupCount[] {
  for (const a of accepted) {
    const pattern = validPageGroupPattern(a);
    if (pattern !== null && !groups.has(pattern)) {
      groups.set(pattern, { pattern, pages: 0, visits: 0 });
    }
  }
  return sortCounts([...groups.values()]);
}

/**
 * `per_page.groups` for a customer that is not sensitive, from the rows of
 * the proposals statement (every fixed part with the floor) and, when the
 * customer has accepted patterns, the rows of the accepted statement (those
 * fixed parts, no floor). A fixed part that is not a valid pattern is
 * dropped here whatever its count (condition 6). Under the floor only an
 * accepted pattern stays. Two rows that normalize to one pattern add their
 * pages; their visits may overlap, so the larger count is kept, never the
 * sum.
 */
export function groupCountsFrom(
  rows: readonly FixedPartRow[],
  accepted: readonly string[] = [],
): GroupCount[] {
  const out = new Map<string, GroupCount>();
  const acceptedSet = new Set(
    accepted.map((a) => validPageGroupPattern(a)).filter((p): p is string => p !== null),
  );
  for (const r of rows) {
    const pattern = validPageGroupPattern(`${r.fixed}/*`);
    if (pattern === null) continue;
    const pages = Number(r.pages) || 0;
    const visits = Number(r.visits) || 0;
    if (pages < GROUP_PROPOSAL_MIN_PAGES && !acceptedSet.has(pattern)) continue;
    const e = out.get(pattern);
    if (e) {
      e.pages += pages;
      e.visits = Math.max(e.visits, visits);
    } else {
      out.set(pattern, { pattern, pages, visits });
    }
  }
  return withAccepted(out, accepted);
}

/** One row of `sensitiveGroupPages`: a kept section's group and its named pages one segment deeper. */
export interface SensitiveGroupRow {
  grp: string;
  pages: number;
}

/**
 * `per_page.groups` for a sensitive customer: a kept section's group
 * (`/products/:item`) becomes the pattern `/products/*` when the folded
 * days of the period name at least the floor of distinct pages exactly one
 * segment under the section (or the pattern is accepted); a day folded
 * under a floor names none, so `pages` is at least. `/:item` is never
 * a pattern, and a section too deep for a pattern (three segments) is not
 * proposed. Visits are the distinct visits per day behind the section's
 * group (`GroupVisitsRow`, the count the counter's floor already uses),
 * added over the days: a visit across midnight counts on each day, and a
 * deeper page of the section is behind the group too.
 */
export function sensitiveGroupCounts(
  rows: readonly SensitiveGroupRow[],
  behind: readonly GroupVisitsRow[],
  accepted: readonly string[] = [],
): GroupCount[] {
  const out = new Map<string, GroupCount>();
  const acceptedSet = new Set(
    accepted.map((a) => validPageGroupPattern(a)).filter((p): p is string => p !== null),
  );
  for (const r of rows) {
    const grp = String(r.grp);
    if (!isGroupPath(grp) || grp === GROUP_SUFFIX) continue;
    const pattern = validPageGroupPattern(`${grp.slice(0, -GROUP_SUFFIX.length)}/*`);
    if (pattern === null) continue;
    const pages = Number(r.pages) || 0;
    if (pages < GROUP_PROPOSAL_MIN_PAGES && !acceptedSet.has(pattern)) continue;
    let visits = 0;
    for (const b of behind) if (b.grp === grp) visits += Number(b.visits) || 0;
    out.set(pattern, { pattern, pages, visits });
  }
  return withAccepted(out, accepted);
}

/**
 * The accepted patterns of a customer, sorted; the empty list when the
 * table is missing (migration 0043 not yet applied) or the read fails: a
 * count never fails for want of groups.
 */
export async function acceptedGroupPatterns(db: D1Database, customerId: string): Promise<string[]> {
  try {
    const r = await db
      .prepare("SELECT pattern FROM page_groups WHERE customer_id = ? ORDER BY pattern")
      .bind(customerId)
      .all<{ pattern: string }>();
    return (r.results ?? [])
      .map((x) => validPageGroupPattern(x.pattern))
      .filter((p): p is string => p !== null);
  } catch {
    return [];
  }
}

/** The fixed parts of the accepted patterns, as the accepted statement is bound. */
export function acceptedFixedParts(accepted: readonly string[]): string[] {
  return accepted.map(groupFixedPart);
}

/**
 * The breakdown's `pages.groups` (N4.1): the stored counts with each
 * accepted pattern marked, an accepted pattern the row has no count for at
 * 0, the accepted first and then the proposals by visits. Empty when there
 * is nothing to show, and then the field is left out.
 */
export function breakdownGroups(
  stored: readonly GroupCount[] | undefined,
  accepted: readonly string[],
): PageGroupRow[] {
  const acceptedSet = new Set(accepted);
  const rows: PageGroupRow[] = [];
  for (const g of Array.isArray(stored) ? stored : []) {
    const pattern = validPageGroupPattern(g?.pattern);
    if (pattern === null || rows.some((r) => r.pattern === pattern)) continue;
    rows.push({
      pattern,
      pages: Number(g.pages) || 0,
      visits: Number(g.visits) || 0,
      accepted: acceptedSet.has(pattern),
    });
  }
  for (const a of acceptedSet) {
    if (!rows.some((r) => r.pattern === a))
      rows.push({ pattern: a, pages: 0, visits: 0, accepted: true });
  }
  return rows.sort(
    (a, b) =>
      Number(b.accepted) - Number(a.accepted) ||
      b.visits - a.visits ||
      b.pages - a.pages ||
      byText(a.pattern, b.pattern),
  );
}
