/**
 * The counting side of a sensitive customer (docs/specs/sensitive-customers.md;
 * the privacy review's ruling of 2026-10-12): the customer's flag and kept
 * list, the stored-path rule as SQL, the daily counter's fold and its read.
 *
 * Three things hold here, each with a test:
 *
 * - A path leaves the event rows of a sensitive customer only as
 *   `storedPath` gives it: `/`, a kept section, its group, or `/:item`. The
 *   SQL below is that rule (`storedPathSql`), the same answers as the shared
 *   function for a stored path.
 * - page_days is folded once a day, in the batch that records the day's
 *   rollup: a group with fewer than three distinct pages that day, or with
 *   fewer than five distinct visits behind it, becomes one row under the
 *   group's path (condition 4, the two floors). A fold only merges rows, so
 *   a folded day never unfolds, also once its markers are gone.
 * - A read of page_days takes closed UTC days only, each only once its fold
 *   has been recorded, and folds again under the list as it is now.
 * - No statement here reads the event rows or names a marker: page_days
 *   meets the rest by customer and day. The visit floor arrives as counts
 *   per day and group (`GroupVisitsRow`), made by the aggregator's
 *   GROUP_VISITS_SQL, the one statement that counts the marker for it. The
 *   export gets no such count: it gives a day as its fold left it.
 *
 * Offline code only, never in the visitor path.
 */

import {
  FOLD_MIN_PATHS,
  FOLD_MIN_VISITS,
  GROUP_SUFFIX,
  type GroupVisits,
  type PageDayCount,
  type PageLoadRow,
  type PageLoads,
  SENSITIVE_CUSTOMER_SQL,
  type SensitiveCustomerRow,
  type SensitiveSettings,
  foldPlan,
  isGroupPath,
  normalizePath,
  pageGroupMatches,
  parseKeptSections,
  sensitiveSettingsFrom,
  storedPath,
  validPageGroupPattern,
} from "@rawuser/shared";
import { GROUP_PAGE_DAYS_SQL } from "./group-page.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC 'YYYY-MM-DD' of a timestamp. */
function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * One customer's flag and list. A read that fails throws: the caller writes
 * nothing for that customer rather than a number under the wrong rule.
 */
export async function sensitiveSettings(
  db: D1Database,
  customerId: string,
): Promise<SensitiveSettings> {
  const row = await db
    .prepare(SENSITIVE_CUSTOMER_SQL)
    .bind(customerId)
    .first<SensitiveCustomerRow>();
  return sensitiveSettingsFrom(row);
}

// ---------------------------------------------------------------------------
// The stored-path rule as SQL
// ---------------------------------------------------------------------------

/**
 * A stored page path as `normalizePath` reads it: lowercase, repeated
 * slashes collapsed, no trailing slash, `/` for nothing. Three passes of
 * replace collapse a run of up to eight slashes; SQLite's lower() is ASCII
 * (a browser sends other letters percent-encoded). Where the two differ the
 * SQL keeps less, never more: such a path matches no kept section and is
 * stored as a group.
 */
export function normPathSql(col: string): string {
  const collapsed = `replace(replace(replace(${col}, '//', '/'), '//', '/'), '//', '/')`;
  return `(CASE WHEN ${col} IS NULL OR rtrim(${col}, '/') = '' THEN '/' ELSE lower(rtrim(${collapsed}, '/')) END)`;
}

/**
 * `kept(p)` as a CTE from a bound JSON array of kept sections (as
 * `validKeptSections` returns them).
 */
export function keptCteSql(param: string): string {
  return `kept(p) AS (SELECT value FROM json_each(${param}))`;
}

/**
 * `storedPath` in SQL, over an expression `n` that is already normalized
 * (`normPathSql`), with `kept(p)` in scope: `/`, a kept section, the longest
 * kept section that is a whole-segment prefix plus `/:item`, else `/:item`.
 */
export function storedPathSql(n: string): string {
  return `(CASE
    WHEN ${n} = '/' THEN '/'
    WHEN ${n} IN (SELECT p FROM kept) THEN ${n}
    ELSE COALESCE((SELECT k.p FROM kept k
                   WHERE substr(${n}, 1, length(k.p) + 1) = k.p || '/'
                   ORDER BY length(k.p) DESC LIMIT 1), '') || '${GROUP_SUFFIX}'
  END)`;
}

/** True in SQL when `expr` is a group's path (`/products/:item`). */
export function isGroupSql(expr: string): string {
  return `(substr(${expr}, -${GROUP_SUFFIX.length}) = '${GROUP_SUFFIX}')`;
}

// ---------------------------------------------------------------------------
// The daily fold (condition 4)
// ---------------------------------------------------------------------------

const DAY_ROWS_SQL = "SELECT page_path, loads FROM page_days WHERE customer_id = ? AND day = ?";

/**
 * Moves the loads of the named pages into the group's row: one statement
 * adds what the rows hold when it runs, the next deletes them, both in the
 * caller's batch. Nothing is read into memory in between, so a load that
 * landed after the plan was made is moved with the rest, never lost.
 */
const FOLD_INTO_GROUP_SQL = `INSERT INTO page_days (customer_id, day, page_path, loads)
SELECT customer_id, day, ?3, SUM(loads) FROM page_days
WHERE customer_id = ?1 AND day = ?2 AND page_path IN (SELECT value FROM json_each(?4))
GROUP BY customer_id, day
ON CONFLICT(customer_id, day, page_path) DO UPDATE SET loads = loads + excluded.loads`;

const FOLD_DELETE_NAMED_SQL = `DELETE FROM page_days
WHERE customer_id = ?1 AND day = ?2 AND page_path IN (SELECT value FROM json_each(?3))`;

/**
 * The statements that fold one closed day of one sensitive customer, for the
 * rollup's batch. Through the shared `foldPlan`: every group with fewer than
 * FOLD_MIN_PATHS distinct pages that day or fewer than FOLD_MIN_VISITS
 * distinct visits behind it (`visits`: the day's count per group). An
 * already folded day gives none.
 */
export async function foldDayStatements(
  db: D1Database,
  customerId: string,
  day: string,
  kept: readonly string[],
  visits: GroupVisits,
): Promise<D1PreparedStatement[]> {
  const rows = await db.prepare(DAY_ROWS_SQL).bind(customerId, day).all<PageDayCount>();
  const out: D1PreparedStatement[] = [];
  for (const g of foldPlan(rows.results ?? [], kept, visits)) {
    const paths = JSON.stringify(g.paths);
    out.push(
      db.prepare(FOLD_INTO_GROUP_SQL).bind(customerId, day, g.group, paths),
      db.prepare(FOLD_DELETE_NAMED_SQL).bind(customerId, day, paths),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * A day of page_days may be read once its fold has run: the rollup records
 * the day (exposure_rollup_days) in the same batch that folds it. By
 * customer and day, the only way page_days meets another table.
 */
const FOLDED_DAY = `EXISTS (SELECT 1 FROM exposure_rollup_days r
                WHERE r.customer_id = pd.customer_id AND r.day = pd.day)`;

/**
 * `d`: the rows of customer ?1's folded days (`range` narrows the days) with
 * the group each belongs to under the list in `kept`. `n`: the named pages
 * per day and group.
 */
function foldedDayCtes(range: string): string {
  return `d AS (
  SELECT pd.day AS day, pd.page_path AS page_path, pd.loads AS loads,
         ${storedPathSql(normPathSql("pd.page_path"))} AS grp
  FROM page_days pd
  WHERE pd.customer_id = ?1${range}
    AND ${FOLDED_DAY}
),
n AS (
  SELECT day, grp, COUNT(*) AS paths FROM d
  WHERE grp <> page_path AND ${isGroupSql("grp")}
  GROUP BY day, grp
)`;
}

/** A row of `d` that names one page of a group. */
const NAMED = `d.grp <> d.page_path AND ${isGroupSql("d.grp")}`;

/** One day and group with the distinct visits behind it: a count, never a marker. */
export interface GroupVisitsRow {
  day: string;
  grp: string;
  visits: number;
}

/**
 * Loads per page over the folded days ?2 to ?3 of customer ?1, with the
 * list ?4 and the visits per day and group ?5 (a JSON array of
 * GroupVisitsRow). Each day is folded again here, under the list as it is
 * now and both floors: a section taken off the list after a day was folded,
 * or a row that landed after its fold, is never shown as a group under a
 * floor. A group with no count in ?5 has none and folds. Only named rows
 * can fold: what the stored fold merged stays merged.
 */
const REFOLDED_DAYS_CTES = `WITH ${keptCteSql("?4")},
gv(day, grp, visits) AS (
  SELECT json_extract(value, '$.day'), json_extract(value, '$.grp'),
         json_extract(value, '$.visits')
  FROM json_each(?5)
),
${foldedDayCtes(" AND pd.day >= ?2 AND pd.day <= ?3")},
f AS (
  SELECT CASE WHEN ${NAMED}
               AND (n.paths < ${FOLD_MIN_PATHS} OR COALESCE(gv.visits, 0) < ${FOLD_MIN_VISITS})
              THEN d.grp ELSE d.page_path END AS page_path,
         d.loads AS loads
  FROM d
  LEFT JOIN n ON n.day = d.day AND n.grp = d.grp
  LEFT JOIN gv ON gv.day = d.day AND gv.grp = d.grp
)`;

export const PAGE_LOADS_SQL = `/* page_loads */
${REFOLDED_DAYS_CTES}
SELECT page_path, SUM(loads) AS loads FROM f
GROUP BY page_path
ORDER BY loads DESC, page_path ASC`;

/**
 * What D1 takes (measured on production, 2026-10-13). The hourly run lost
 * the pilot's 24h, 7d and 30d windows to `out of memory: SQLITE_NOMEM` on a
 * statement that applied the stored-path CASE a second time, over a derived
 * table whose column was itself that CASE: SQLite's subquery flattener
 * copies the inner expression, with its correlated `kept` subquery, into
 * every reference the outer makes (about twenty per CASE, and the WHERE,
 * GROUP BY and ORDER BY each reference it again), thousands of copies, and
 * the planner runs out of memory. node:sqlite has no such limit, so the
 * tests passed. The same statement ran with the derived table
 * `MATERIALIZED`; the proposals are computed in code instead
 * (`sensitiveGroupPages`).
 *
 * The rule, held by a static test over every statement of these modules:
 * the stored-path CASE at most once per statement, over a base table's
 * column; and no statement longer than this. The longest that runs on D1
 * with the pilot's parameters is PAGE_LOADS_SQL at 2,063 characters; the one
 * that failed was 3,207.
 */
export const D1_STATEMENT_CHARS_MAX = 2500;

/** One kept section's group and the distinct named pages one segment under it. */
export interface SensitiveGroupPagesRow {
  grp: string;
  pages: number;
}

/**
 * Page groups for a sensitive customer (docs/specs/page-groups.md, "Where
 * groups come from"), from the counter's rows already in hand (`rows`: the
 * rows of PAGE_LOADS_SQL, the re-folded days of the period summed per
 * path): per kept section's group, how many distinct pages exactly one
 * segment under the section the counter names. A day on which the group
 * was under a floor left only the group's row, which names no page, so
 * `pages` is a floor: at least that many. `/:item` is never a group here,
 * a deeper page of the section is behind the group but not one of its
 * pages, and only a section that can be a pattern is counted. Pure code,
 * no statement; by group, ascending.
 */
export function sensitiveGroupPages(
  rows: readonly PageDayCount[],
  kept: readonly string[],
): SensitiveGroupPagesRow[] {
  const named = new Map<string, Set<string>>();
  for (const r of rows) {
    const path = normalizePath(String(r.page_path));
    const grp = storedPath(path, kept);
    if (grp === path || !isGroupPath(grp) || grp === GROUP_SUFFIX) continue;
    const pattern = validPageGroupPattern(`${grp.slice(0, -GROUP_SUFFIX.length)}/*`);
    if (pattern === null || !pageGroupMatches(pattern, path)) continue;
    const set = named.get(grp) ?? new Set<string>();
    set.add(path);
    named.set(grp, set);
  }
  return [...named.entries()]
    .map(([grp, paths]) => ({ grp, pages: paths.size }))
    .sort((a, b) => (a.grp < b.grp ? -1 : a.grp > b.grp ? 1 : 0));
}

/**
 * The export's page_days (privacy review on the build, condition 2):
 * customer ?1's rows per day, only days that have their rollup row, folded
 * under the list ?2 as it is now. No marker is counted for it: the visit
 * floor is the one the day's fold applied, and a day not yet folded is left
 * out, never folded on the fly. ?3 rows from offset ?4, by day and path.
 */
export const PAGE_DAYS_EXPORT_SQL = `/* page_days_export */
WITH ${keptCteSql("?2")},
${foldedDayCtes("")},
f AS (
  SELECT d.day AS day,
         CASE WHEN ${NAMED} AND n.paths < ${FOLD_MIN_PATHS}
              THEN d.grp ELSE d.page_path END AS page_path,
         d.loads AS loads
  FROM d
  LEFT JOIN n ON n.day = d.day AND n.grp = d.grp
)
SELECT ?1 AS customer_id, day, page_path, SUM(loads) AS loads FROM f
GROUP BY day, page_path
ORDER BY day ASC, page_path ASC
LIMIT ?3 OFFSET ?4`;

/** One exported row: the table's four columns. */
export interface ExportedPageDay {
  customer_id: string;
  day: string;
  page_path: string;
  loads: number;
}

/**
 * A page of the export's page_days rows. The list is the one on the
 * customers row whatever the flag says now (a customer no longer marked
 * keeps its counter until deleted, and it is given under its last list).
 */
export async function exportPageDays(
  db: D1Database,
  customerId: string,
  offset: number,
  limit: number,
): Promise<ExportedPageDay[]> {
  const row = await db
    .prepare(SENSITIVE_CUSTOMER_SQL)
    .bind(customerId)
    .first<SensitiveCustomerRow>();
  const kept = parseKeptSections(row?.kept_sections);
  const r = await db
    .prepare(PAGE_DAYS_EXPORT_SQL)
    .bind(customerId, JSON.stringify(kept), limit, offset)
    .all<ExportedPageDay>();
  return (r.results ?? []).map((x) => ({
    customer_id: String(x.customer_id),
    day: String(x.day),
    page_path: String(x.page_path),
    loads: Number(x.loads) || 0,
  }));
}

/** How many of the folded days ?2 to ?3 hold a load. */
export const PAGE_LOAD_DAYS_SQL = `/* page_load_days */
SELECT COUNT(DISTINCT pd.day) AS days FROM page_days pd
WHERE pd.customer_id = ?1 AND pd.day >= ?2 AND pd.day <= ?3
  AND ${FOLDED_DAY}`;

/** Every statement that reads page_days (here and in group-page.ts), for the static test. */
export const PAGE_DAYS_QUERIES = [
  DAY_ROWS_SQL,
  FOLD_INTO_GROUP_SQL,
  FOLD_DELETE_NAMED_SQL,
  PAGE_LOADS_SQL,
  PAGE_LOAD_DAYS_SQL,
  PAGE_DAYS_EXPORT_SQL,
  GROUP_PAGE_DAYS_SQL,
];

/** Rows listed in the counter block. */
export const PAGE_LOADS_LISTED = 20;

/**
 * The UTC days the counter answers for a period (start, end]: the closed
 * days that end inside it, and never a day still open by the real clock.
 * Null for a period shorter than a day (the 1-hour window) and when no day
 * has closed inside the period yet.
 */
export function counterDays(
  windowMs: number,
  start: number,
  end: number,
  now: number,
): { from: string; to: string } | null {
  if (windowMs < DAY_MS) return null;
  const from = dayOf(start);
  const to = dayOf(Math.min(end, now) - DAY_MS);
  return from <= to ? { from, to } : null;
}

const NO_LOADS = { pages: 0, loads: 0, grouped_loads: 0 };

/** The counter's rows of a period, every one (the block lists twenty), and its days with a load. */
export interface PageLoadsRead {
  rows: PageDayCount[];
  days: number;
}

/**
 * The two reads behind the counter block: loads per page over the folded
 * days of the period (PAGE_LOADS_SQL) and how many of those days hold a
 * load. Nothing when the period has no counter days. `groupVisits`: the
 * distinct visits per day and group over the same days, for the visit
 * floor. The rows feed the block and, for a sensitive customer, the page
 * group proposals (`sensitiveGroupPages`), so the proposals cost no
 * statement of their own.
 */
export async function readPageLoads(
  db: D1Database,
  customerId: string,
  days: { from: string; to: string } | null,
  kept: readonly string[],
  groupVisits: readonly GroupVisitsRow[],
): Promise<PageLoadsRead> {
  if (!days) return { rows: [], days: 0 };
  const [rows, counted] = await Promise.all([
    db
      .prepare(PAGE_LOADS_SQL)
      .bind(customerId, days.from, days.to, JSON.stringify(kept), JSON.stringify(groupVisits))
      .all<PageDayCount>(),
    db.prepare(PAGE_LOAD_DAYS_SQL).bind(customerId, days.from, days.to).first<{ days: number }>(),
  ]);
  return {
    rows: (rows.results ?? []).map((r) => ({
      page_path: String(r.page_path),
      loads: Number(r.loads) || 0,
    })),
    days: Number(counted?.days) || 0,
  };
}

/**
 * The counter block of per_page for a sensitive customer: loads per page on
 * the folded days of the period. `versioned`: the customer's confirmed
 * pages, normalized. `groupVisits`: the distinct visits per day and group
 * over the same days, for the visit floor.
 */
export async function pageLoads(
  db: D1Database,
  customerId: string,
  days: { from: string; to: string } | null,
  kept: readonly string[],
  versioned: ReadonlySet<string>,
  groupVisits: readonly GroupVisitsRow[],
): Promise<PageLoads> {
  return pageLoadsFrom(
    days,
    await readPageLoads(db, customerId, days, kept, groupVisits),
    versioned,
  );
}

/** The counter block from its rows (`readPageLoads`). */
export function pageLoadsFrom(
  days: { from: string; to: string } | null,
  read: PageLoadsRead,
  versioned: ReadonlySet<string>,
): PageLoads {
  if (!days) {
    return {
      from: null,
      to: null,
      days: 0,
      pages: [],
      total: { ...NO_LOADS },
      without_versions: { ...NO_LOADS },
    };
  }
  const total = { ...NO_LOADS };
  const without = { ...NO_LOADS };
  const pages: PageLoadRow[] = [];
  for (const r of read.rows) {
    const path = r.page_path;
    const loads = r.loads;
    const group = isGroupPath(path);
    // A group holds pages that may have no versions at all (condition 2).
    const hasVersions = !group && versioned.has(normalizePath(path));
    for (const t of hasVersions ? [total] : [total, without]) {
      t.loads += loads;
      if (group) t.grouped_loads += loads;
      else t.pages++;
    }
    pages.push({
      page_path: path,
      loads,
      has_versions: hasVersions,
      ...(group ? { group: true as const } : {}),
    });
  }
  return {
    from: days.from,
    to: days.to,
    days: read.days,
    pages: pages.slice(0, PAGE_LOADS_LISTED),
    total,
    without_versions: without,
  };
}
