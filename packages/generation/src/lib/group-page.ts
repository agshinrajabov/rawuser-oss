/**
 * The page a group's count link opens when the dashboard sends none
 * (docs/specs/page-groups.md, "As built: generation"). A sensitive
 * customer's breakdown lists only groups, so the dashboard knows no page
 * of one; the server then picks the page with the most loads among the
 * pages the link can open: exactly one segment under the fixed part, no
 * masked (`:id`) or folded (`:item`) segment, not a confirmed page.
 *
 * Where the loads come from follows the customer's rule:
 * - a sensitive customer: `page_days`, its own daily counter, the last 30
 *   days, only days whose fold is recorded (the one way page_days meets
 *   another table, by customer and day); a folded group row names no page
 *   and is skipped. No marker is read. The statement is on
 *   PAGE_DAYS_QUERIES, so the static guard holds it to the same rule;
 * - any other customer: `events`, the exposure types of the last 30 days,
 *   `COUNT(*)` per page, never a marker.
 *
 * The operator's own page paths; nothing about a visitor. Offline only.
 */

import {
  GROUP_SUFFIX,
  ITEM_SEGMENT,
  MASKED_SEGMENT,
  groupFixedPart,
  normalizePath,
  pageGroupMatches,
} from "@rawuser/shared";
import { loadSensitive } from "./sensitive-guard.ts";

/**
 * The event types that mark one page load (cron/exposure-rollup.ts
 * EXPOSURE_TYPES), written here so sensitive-pages.ts can list this file's
 * page_days statement without an import cycle through snippet-issues.ts.
 */
const EXPOSURE_TYPES = "('variant_shown', 'personalization_skipped', 'no_signal_passthrough')";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
/** Rows read per source: the most loaded pages, filtered here. */
const CANDIDATES = 50;

/** The 409 of a group link with no page to open. */
export const GROUP_PAGE_NEEDED_CODE = "group_page_needed";
export const GROUP_PAGE_NEEDED_LINE = "Paste the address of one of these pages.";

/**
 * Loads per named page under ?4 (the group's fixed part) over the folded
 * days ?2 to ?3 of customer ?1: a folded group row is left out, and so is a
 * day whose fold is not yet recorded. Counts only, no marker.
 */
export const GROUP_PAGE_DAYS_SQL = `/* group_page_days */
SELECT pd.page_path AS page_path, SUM(pd.loads) AS loads
FROM page_days pd
WHERE pd.customer_id = ?1 AND pd.day >= ?2 AND pd.day <= ?3
  AND substr(pd.page_path, -${GROUP_SUFFIX.length}) <> '${GROUP_SUFFIX}'
  AND substr(pd.page_path, 1, length(?4) + 1) = ?4 || '/'
  AND EXISTS (SELECT 1 FROM exposure_rollup_days r
              WHERE r.customer_id = pd.customer_id AND r.day = pd.day)
GROUP BY pd.page_path
ORDER BY loads DESC, pd.page_path ASC
LIMIT ${CANDIDATES}`;

/**
 * Loads per page under ?3 from the exposure rows of customer ?1 since ?2:
 * COUNT(*) only. The page path is stored masked (event-paths.md), so an
 * identifier page arrives as `:id` and is dropped below.
 */
export const GROUP_PAGE_EVENTS_SQL = `/* group_page_events */
SELECT page_path, COUNT(*) AS loads
FROM events
WHERE customer_id = ?1 AND ts >= ?2
  AND event_type IN ${EXPOSURE_TYPES}
  AND page_path IS NOT NULL
  AND substr(page_path, 1, length(?3) + 1) = ?3 || '/'
GROUP BY page_path
ORDER BY loads DESC, page_path ASC
LIMIT ${CANDIDATES}`;

const CONFIRMED_PAGES_SQL =
  "SELECT page_path FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL";

interface LoadRow {
  page_path: string;
  loads: number;
}

/** UTC 'YYYY-MM-DD' of a timestamp. */
function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** A page the link can open: one of the group's, no masked or folded segment. */
export function openableGroupPage(pattern: string, path: string): boolean {
  if (!pageGroupMatches(pattern, path)) return false;
  const last = normalizePath(path).split("/").pop() ?? "";
  return last !== MASKED_SEGMENT && last !== ITEM_SEGMENT;
}

/**
 * The most loaded openable page of the group, by the customer's rule, or
 * null when the counts name none. `now` for the tests.
 */
export async function chooseGroupPage(
  db: D1Database,
  customerId: string,
  pattern: string,
  now = Date.now(),
): Promise<string | null> {
  const fixed = groupFixedPart(pattern);
  const settings = await loadSensitive(db, customerId);
  const rows = settings.sensitive
    ? await db
        .prepare(GROUP_PAGE_DAYS_SQL)
        .bind(customerId, dayOf(now - WINDOW_DAYS * DAY_MS), dayOf(now), fixed)
        .all<LoadRow>()
    : await db
        .prepare(GROUP_PAGE_EVENTS_SQL)
        .bind(customerId, now - WINDOW_DAYS * DAY_MS, fixed)
        .all<LoadRow>();
  const confirmed = await db
    .prepare(CONFIRMED_PAGES_SQL)
    .bind(customerId)
    .all<{ page_path: string }>();
  const taken = new Set((confirmed.results ?? []).map((r) => normalizePath(String(r.page_path))));
  for (const r of rows.results ?? []) {
    const page = normalizePath(String(r.page_path));
    if (taken.has(page)) continue;
    if (!openableGroupPage(pattern, page)) continue;
    return page;
  }
  return null;
}
