/**
 * Analytics aggregator — offline cron job.
 *
 * Runs hourly (cron "0 * * * *"). Never in the visitor request path.
 *
 * For each active customer × each time window [1h, 24h, 7d, 30d]:
 *   1. Counts distinct visits per group (all, signal, cohort, cell, intent,
 *      source) over the window and over the period before it.
 *   2. Computes counters, per_variant, per_intent, per_cohort, per_source and
 *      per_page JSON blobs.
 *   3. Computes Wilson-score lift for personalized vs holdout and vs no_signal.
 *   4. Upserts one row per (customer_id, window, window_start) — idempotent.
 *
 * The period (docs/specs/results-data.md §1, 2026-10-04): the rolling row
 * counts (now - W, now] and the period before (now - 2W, now - W]. The key,
 * window_start, stays the aligned bucket floor((now - W) / W) * W so re-runs
 * inside one bucket replace one row; it is a key, not the period's start
 * (before 2026-10-04 it was both, and the "30d" row counted 30 to 60 days).
 * aggregateWindow and aggregateWindowAt are one computeWindow with a
 * different range and key, so they cannot drift.
 *
 * Idempotency invariant (ADR 0022):
 *   Uses INSERT OR REPLACE keyed on the UNIQUE INDEX
 *   idx_analytics_aggregates_unique (customer_id, window, window_start).
 *   Re-running for the same (customer, window, window_start) replaces the
 *   row cleanly; no duplicate rows accumulate. Backfill runs are also safe
 *   because backfill uses the exact window boundary as window_start.
 *
 * NULL cohort handling:
 *   Pre-Batch-C rows have cohort IS NULL. The aggregator treats them as
 *   'personalized' via COALESCE(cohort, 'personalized') for backward compat
 *   (those visits shipped before holdout existed, so they are all personalized
 *   by assumption).
 *
 * Visits, not rows (docs/specs/visit-marker.md, 2026-09-13): every count is
 * COUNT(DISTINCT COALESCE(visit, id)), so the pages of one visit collapse
 * into one visit and a conversion counts once per visit; rows without a
 * marker (older rows, storage blocked) still count one each. Each group is
 * counted distinct inside itself, never added up from smaller groups
 * (2026-10-06): a visit across two (intent, source) cells is one visit in
 * its cohort and its source, and a visit across cohorts is one visit in the
 * total (VISIT_GROUPS_SQL). The period
 * before is compared only where its rows carry the marker (rows from before
 * ADR 0037, 2026-11-02, lost it at 31 days; lib/results.ts MARKER_LIFE_MS);
 * the 30-day window's period before does not, so it stores no comparison.
 *
 * Intent-to-treat holdout (docs/specs/proof-engine.md, D and E; ADR 0022
 * amendment 2026-10-04): holdout_visits and holdout_conversions are the
 * holdout ARM, and holdout_lift is the treat arm (every visit the coin
 * assigned treat: written, skipped, late or partial) against the holdout
 * arm. A visit converts when any conversion row with its marker exists, on
 * any page of the visit. A visit carrying both arms is left out. Both the
 * rolling window and aggregateWindowAt call armTotals, so they cannot
 * drift. personalized_* stays cohort-based and feeds the directional
 * natural lift. Both lifts need MIN_CONVERSIONS (10) converting visits per
 * arm (computeGatedLift).
 *
 * The skipped cohort has two kinds of visit since the late tag rule
 * (docs/specs/late-tag.md, 2026-10-12): a page that was painted before our
 * script ran stays as built and reports a skip of kind `late` with the bit
 * `lp`; every other skip (a part not found, an answer after the reveal cap)
 * has no bit. The cohort's count keeps its meaning (a visit with a signal
 * whose page was kept as built) and grows with every late-tag load, so the
 * `skipped` entry of per_cohort and each page of per_page also say how many
 * of them were painted first (`lp_visits`), and the cohort entry how many
 * had a skip for another reason (`other_visits`). A reader that means "the
 * parts were not found" reads `other_visits`, never the cohort's total.
 * Intent-to-treat is untouched: a late-tag visit the coin assigned to treat
 * is in the treat arm.
 *
 * A sensitive customer (docs/specs/sensitive-customers.md, the privacy review's
 * ruling of 2026-10-12): per_page counts by the stored path (`/`, a kept
 * section, its group, or `/:item`), grouped inside the query, so a product
 * page never leaves the event rows whatever they hold; a group's row says
 * `group` and carries no `lp_visits`. Per-page loads, and how many pages
 * without versions were opened, come from the daily counter (page_days:
 * closed, folded days only, no marker), in the `counter` block. The two
 * queries are the ones every customer runs with the path expression
 * swapped, so they cannot drift. For any other customer no statement and no
 * stored value differs.
 *
 * Privacy invariants (ADR 0019, ADR 0022):
 *   - The marker join (a visit's conversions to its arm) runs only here and
 *     in exposure-rollup.ts, inside one customer, counts only (privacy review
 *     condition 3).
 *   - Reads only aggregate counts from events (no persistent visitor identifiers).
 *   - Writes only derived metrics to analytics_aggregates (no PII). per_page
 *     lists a path only with PAGE_MIN_VISITS visits.
 *   - No new visitor data enters the system; computed lift metrics are
 *     strictly derived from already-stored aggregate counts.
 */

import {
  PAGE_DAY_EVENT_TYPES,
  type PageLoads,
  type SensitiveSettings,
  isGroupPath,
  maskPath,
  normalizePath,
  storedPath,
} from "@rawuser/shared";
import { computeGatedLift } from "../lib/lift.ts";
import { lpOf } from "../lib/lp.ts";
import {
  type FixedPartRow,
  GROUP_PROPOSAL_MIN_PAGES,
  type GroupCount,
  acceptedFixedParts,
  acceptedGroupPatterns,
  groupCountsFrom,
  sensitiveGroupCounts,
} from "../lib/page-group-counts.ts";
import {
  type CountedPage,
  PAGE_MIN_VISITS,
  SIGNAL_COHORTS,
  type StoredSource,
  type StoredTagged,
  buildPerSource,
  previousComparable,
  selectPages,
  taggedTotals,
  withNames,
} from "../lib/results.ts";
import {
  type GroupVisitsRow,
  counterDays,
  isGroupSql,
  keptCteSql,
  normPathSql,
  pageLoadsFrom,
  readPageLoads,
  sensitiveGroupPages,
  sensitiveSettings,
  storedPathSql,
} from "../lib/sensitive-pages.ts";

/**
 * Logged, once, when the page group proposals of a window cannot be
 * computed: the window is written without `groups` (a proposal never costs
 * a window; the pilot's 24h, 7d and 30d rows were lost to one on 2026-10-13).
 */
export const GROUPS_FAILED_LINE =
  "[analytics-aggregator] page group proposals failed, window written without groups";

export interface AggregatorEnv {
  DB: D1Database;
}

export interface AggregatorResult {
  aggregated: number;
  errors: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Window definitions
// ---------------------------------------------------------------------------

const WINDOWS = [
  { key: "1h", ms: 60 * 60 * 1000 },
  { key: "24h", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

/** Window key → length in ms, for readers that turn a row back into its period. */
export const WINDOW_MS: Readonly<Record<string, number>> = Object.fromEntries(
  WINDOWS.map((w) => [w.key, w.ms]),
);

// ---------------------------------------------------------------------------
// D1 row types
// ---------------------------------------------------------------------------

/** One row of VISIT_GROUPS_SQL: a group and its distinct visits. */
interface GroupRow {
  level: "all" | "signal" | "cohort" | "cell" | "intent" | "source";
  cohort: string | null;
  intent_dim: string | null;
  source_dim: string | null;
  visits: number;
  conversions: number;
}

interface DailyBucket {
  date: string;
  visits: number;
  conversions: number;
}

// ---------------------------------------------------------------------------
// The queries. Every events subquery filters customer_id first (the guard in
// exposure-rollup.test.ts reads these strings).
// ---------------------------------------------------------------------------

/** The four event types that mean "a page of a visit was seen". */
export const VISIT_EVENTS = `'variant_shown', 'select', 'no_signal_passthrough', 'personalization_skipped'`;

/** The signal cohorts as SQL (personalized, holdout, skipped). */
const SIGNAL_SQL = SIGNAL_COHORTS.map((c) => `'${c}'`).join(", ");

/**
 * Visits per group over (start, end], each group counted distinct inside
 * itself (docs/specs/results-data.md, "What a number means here"; fixed
 * 2026-10-06). A visit counts once in every group it touched, never once
 * per (intent, source) cell inside a group: a ChatGPT visit to `/`
 * (problem:ai) and then `/pricing` (pricing:ai) is one personalized visit
 * and one ai visit, not two. Levels:
 *   all     every cohort: the total (a visit across cohorts counts once)
 *   signal  the signal cohorts (personalized, holdout, skipped)
 *   cohort  per cohort (per_cohort and the cohort columns)
 *   cell    per (intent, source), skipped left out (per_variant)
 *   intent  per intent, skipped left out (per_intent)
 *   source  per source, the signal cohorts (per_source)
 * One SELECT over a joined level table, not a UNION: D1 refuses a compound
 * SELECT of six terms ("too many terms in compound SELECT", 2026-10-06).
 * All four visit event types count toward their cohort's visits:
 *   personalized → variant_shown
 *   holdout      → variant_shown (snippet reveals original)
 *   skipped      → personalization_skipped (pre-flight aborted)
 *   no_signal    → no_signal_passthrough (no signal at all)
 * COALESCE(cohort, 'personalized') treats pre-Batch-C NULL rows as
 * personalized (ADR 0022). The period before runs the same query.
 */
export const VISIT_GROUPS_SQL = `/* visit_groups */
WITH e AS MATERIALIZED (
  SELECT visit, id, event_type, intent_dim, source_dim,
         COALESCE(cohort, 'personalized') AS cohort
  FROM events
  WHERE customer_id = ?1 AND ts > ?2 AND ts <= ?3
    AND event_type IN (${VISIT_EVENTS}, 'conversion')
),
levels(level) AS (VALUES ('all'), ('signal'), ('cohort'), ('cell'), ('intent'), ('source'))
SELECT
  levels.level AS level,
  CASE WHEN levels.level = 'cohort' THEN e.cohort END AS cohort,
  CASE WHEN levels.level IN ('cell', 'intent') THEN e.intent_dim END AS intent_dim,
  CASE WHEN levels.level IN ('cell', 'source') THEN e.source_dim END AS source_dim,
  COUNT(DISTINCT COALESCE(visit, id)) FILTER (WHERE event_type IN (${VISIT_EVENTS})) AS visits,
  COUNT(DISTINCT COALESCE(visit, id)) FILTER (WHERE event_type = 'conversion') AS conversions
FROM e JOIN levels ON
  levels.level IN ('all', 'cohort')
  OR (levels.level = 'signal' AND e.cohort IN (${SIGNAL_SQL}))
  OR (levels.level = 'source' AND e.cohort IN (${SIGNAL_SQL}) AND e.source_dim IS NOT NULL)
  OR (levels.level IN ('cell', 'intent') AND e.cohort <> 'skipped')
GROUP BY 1, 2, 3, 4`;

/**
 * L2 Layer D and the language gate, in visits: untagged visits that look
 * like an app that hid the referrer, and untagged visits kept original
 * because the page is in another language than the versions.
 */
export const NO_SIGNAL_FLAGS_SQL = `/* no_signal_flags */
SELECT
  COUNT(DISTINCT COALESCE(visit, id)) FILTER (WHERE dark_social = 1) AS dark,
  COUNT(DISTINCT COALESCE(visit, id)) FILTER (WHERE language_mismatch = 1) AS lang
FROM events
WHERE customer_id = ?1 AND ts > ?2 AND ts <= ?3
  AND event_type = 'no_signal_passthrough'`;

/** Visits and converting visits per UTC day (30d only), every cohort, so the days add up to the totals. */
export const DAILY_SQL = `/* daily */
SELECT
  date(datetime(ts / 1000, 'unixepoch'), 'utc') AS date,
  COUNT(DISTINCT COALESCE(visit, id)) FILTER (WHERE event_type IN (${VISIT_EVENTS})) AS visits,
  COUNT(DISTINCT COALESCE(visit, id)) FILTER (WHERE event_type = 'conversion') AS conversions
FROM events
WHERE customer_id = ?1 AND ts > ?2 AND ts <= ?3
GROUP BY date
ORDER BY date ASC`;

/**
 * The skipped cohort's two kinds over (start, end]: visits with a skip on a
 * page painted before our script ran (`lp`), and visits with a skip for any
 * other reason. Each distinct inside itself; a visit with both is in both,
 * so the two can add up to more than the cohort.
 */
export const SKIPPED_SPLIT_SQL = `/* skipped_split */
SELECT
  COUNT(DISTINCT COALESCE(visit, id)) FILTER (WHERE lp = 1) AS lp_visits,
  COUNT(DISTINCT COALESCE(visit, id)) FILTER (WHERE lp = 0) AS other_visits
FROM (
  SELECT visit, id, ${lpOf()} AS lp
  FROM events
  WHERE customer_id = ?1 AND ts > ?2 AND ts <= ?3
    AND event_type = 'personalization_skipped'
)`;

/** A stored page_path as the manifests key it: lowercase, no trailing slash except "/". */
const NORM_PATH = `CASE WHEN page_path IS NULL OR rtrim(page_path, '/') = '' THEN '/' ELSE lower(rtrim(page_path, '/')) END`;

/**
 * The Pages card's share (docs/specs/late-tag.md, "Contract for the
 * dashboard"): of the visits that met one of the customer's confirmed pages
 * with a version ready (written, skipped or held out, the three shapes a
 * version leaves), how many met one that had been painted before our script
 * ran. Visits, not rows: a visit with three such pages is one, and it is
 * late when at least one of them was. A passthrough is in neither count: no
 * version was ready there and it never carries the bit. Read from event
 * rows, where the bit is kept (ADR 0037). Here, with the other marker counts,
 * because it counts by visit.
 *
 * Confirmed pages only, both counts (2026-10-12, privacy review on
 * `71238e8`): a page with no versions of its own is left as built whatever
 * the tag does, its skip is `missing` and its holdout exposure carries no
 * bit, so it can never be late and does not belong under "the visits that
 * would get a version". With it in the denominator the share read low on a
 * site where most visits open such pages. The pages are the confirmed
 * manifests, the source of the bundle's `pages`, as they are now, not as
 * they were on the day of the visit. A sensitive customer's confirmed pages
 * are `/` or a kept section, stored as they are, so the filter holds there.
 */
export const LATE_TAG_SHARE_SQL = `/* late_tag_share */
SELECT
  COUNT(DISTINCT COALESCE(visit, id)) AS exposures,
  COUNT(DISTINCT COALESCE(visit, id)) FILTER (WHERE lp = 1) AS late_exposures
FROM (
  SELECT visit, id, ${lpOf()} AS lp
  FROM events
  WHERE customer_id = ?1 AND ts > ?2 AND ts <= ?3
    AND event_type IN ('variant_shown', 'personalization_skipped')
    AND ${NORM_PATH} IN (
      SELECT page_path FROM element_manifests
      WHERE customer_id = ?1 AND confirmed_at IS NOT NULL
    )
)`;

/** The Pages card looks at this many days. */
export const LATE_TAG_DAYS = 7;
/** Under this many visits the share is not shown (`enough` is false). */
export const LATE_TAG_MIN_EXPOSURES = 30;

export interface LateTagShare {
  /** Visits in the last 7 days that met one of the customer's confirmed pages with a version ready. */
  exposures: number;
  /** Of them, visits where such a page had been painted before our script ran. */
  late_exposures: number;
  /** late_exposures / exposures, four decimals; null at no exposures. */
  share: number | null;
  /** exposures is 30 or more: the share may be shown. */
  enough: boolean;
}

/** One customer's late-tag share over the 7 days before `now`. Counts only. */
export async function lateTagShare(
  db: D1Database,
  customerId: string,
  now: number,
): Promise<LateTagShare> {
  const r = await db
    .prepare(LATE_TAG_SHARE_SQL)
    .bind(customerId, now - LATE_TAG_DAYS * 24 * 60 * 60 * 1000, now)
    .first<{ exposures: number; late_exposures: number }>();
  const exposures = Number(r?.exposures) || 0;
  const late = Number(r?.late_exposures) || 0;
  return {
    exposures,
    late_exposures: late,
    share: exposures > 0 ? Math.round((late / exposures) * 10_000) / 10_000 : null,
    enough: exposures >= LATE_TAG_MIN_EXPOSURES,
  };
}

/** Visits per page (N4). ?4 is the listing floor; the busiest first. */
export const PAGE_ROWS_SQL = `/* per_page */
SELECT
  ${NORM_PATH} AS page_path,
  COUNT(DISTINCT COALESCE(visit, id)) AS visits,
  COUNT(DISTINCT COALESCE(visit, id)) FILTER (WHERE COALESCE(cohort, 'personalized') IN (${SIGNAL_SQL})) AS signal_visits,
  COUNT(DISTINCT COALESCE(visit, id)) FILTER (WHERE event_type = 'variant_shown' AND COALESCE(cohort, 'personalized') = 'personalized') AS written_visits,
  COUNT(DISTINCT COALESCE(visit, id)) FILTER (WHERE event_type = 'personalization_skipped') AS skipped_visits,
  COUNT(DISTINCT COALESCE(visit, id)) FILTER (WHERE event_type = 'personalization_skipped' AND ${lpOf()} = 1) AS lp_visits
FROM events
WHERE customer_id = ?1 AND ts > ?2 AND ts <= ?3
  AND event_type IN (${VISIT_EVENTS})
GROUP BY 1
HAVING COUNT(DISTINCT COALESCE(visit, id)) >= ?4
ORDER BY signal_visits DESC, visits DESC, page_path ASC
LIMIT 100`;

/** Every page without its own confirmed manifest: how many, and distinct visits across them. */
export const PAGES_WITHOUT_VERSIONS_SQL = `/* pages_without_versions */
SELECT
  COUNT(DISTINCT page_path) AS pages,
  COUNT(DISTINCT COALESCE(visit, id)) AS visits,
  COUNT(DISTINCT COALESCE(visit, id)) FILTER (WHERE signal = 1) AS signal_visits
FROM (
  SELECT ${NORM_PATH} AS page_path, visit, id,
    CASE WHEN COALESCE(cohort, 'personalized') IN (${SIGNAL_SQL}) THEN 1 ELSE 0 END AS signal
  FROM events
  WHERE customer_id = ?1 AND ts > ?2 AND ts <= ?3
    AND event_type IN (${VISIT_EVENTS})
)
WHERE page_path NOT IN (
  SELECT page_path FROM element_manifests WHERE customer_id = ?1 AND confirmed_at IS NOT NULL
)`;

/**
 * The page queries of a sensitive customer: the same statement with the
 * path read as `storedPath` gives it, the kept list bound as a JSON array
 * (`param`). Built from the statement every customer runs, so the counted
 * columns, the floor and the order are one text.
 */
function withStoredPath(sql: string, tag: string, param: string): string {
  const stored = storedPathSql(normPathSql("page_path"));
  const out = sql
    .replace(`/* ${tag} */`, `/* ${tag}_sensitive */`)
    .replace("SELECT", `WITH ${keptCteSql(param)}\nSELECT`)
    .replace(NORM_PATH, stored);
  if (out === sql || !out.includes(stored)) throw new Error(`no path to swap in ${tag}`);
  return out;
}

/** PAGE_ROWS_SQL for a sensitive customer; ?5 is the kept list. */
export const SENSITIVE_PAGE_ROWS_SQL = withStoredPath(PAGE_ROWS_SQL, "per_page", "?5");

/** PAGES_WITHOUT_VERSIONS_SQL for a sensitive customer; ?4 is the kept list. */
export const SENSITIVE_PAGES_WITHOUT_VERSIONS_SQL = withStoredPath(
  PAGES_WITHOUT_VERSIONS_SQL,
  "pages_without_versions",
  "?4",
);

/**
 * The visit floor of a sensitive customer's daily counter
 * (docs/specs/sensitive-customers.md, condition 4, corrected on the build's
 * review): per UTC day and stored group, how many distinct visits loaded a
 * page of the group. Three pages do not hide one visit, so a group with
 * fewer than FOLD_MIN_VISITS behind it that day keeps no page's name in
 * page_days.
 *
 * The one statement that counts the marker for the counter, and a count is
 * all it gives: the marker is in no result column and is bound into no
 * statement over page_days. Exposure rows only, the three types that are a
 * load: a snippet issue has no marker and would count as a visit of its own
 * on every load of a site with its tag at the end of the page. A row whose
 * marker is gone counts by itself, as everywhere; by then its day is
 * folded, and a fold never unfolds. `kept(p)` must be in scope; the
 * customer is ?1.
 */
export const GROUP_VISITS_SELECT = `SELECT
  date(ts / 1000, 'unixepoch') AS day,
  ${storedPathSql(normPathSql("page_path"))} AS grp,
  COUNT(DISTINCT COALESCE(visit, id)) AS visits
FROM events
WHERE customer_id = ?1
  AND event_type IN (${PAGE_DAY_EVENT_TYPES.map((t) => `'${t}'`).join(", ")})`;

/** GROUP_VISITS_SELECT over ?2 <= ts < ?3 with the list ?4: the groups only. */
export const GROUP_VISITS_SQL = `/* group_visits */
WITH ${keptCteSql("?4")}
${GROUP_VISITS_SELECT}
  AND ts >= ?2 AND ts < ?3
GROUP BY 1, 2
HAVING ${isGroupSql("grp")}`;

/** The distinct visits per UTC day and group of one customer over [start, end). */
export async function groupVisits(
  db: D1Database,
  customerId: string,
  start: number,
  end: number,
  kept: readonly string[],
): Promise<GroupVisitsRow[]> {
  const r = await db
    .prepare(GROUP_VISITS_SQL)
    .bind(customerId, start, end, JSON.stringify(kept))
    .all<GroupVisitsRow>();
  return (r.results ?? []).map((x) => ({
    day: String(x.day),
    grp: String(x.grp),
    visits: Number(x.visits) || 0,
  }));
}

/**
 * N1 and N3 (docs/specs/results-data.md §7): per visit and source, its
 * platform name and whether it came on the customer's own tagged link; then
 * visits and converting visits per (source, name), and the tagged ones.
 * A visit's name is the one its rows carry (a later page of the visit has
 * none); the signal cohorts only. Shared with the daily rollup (source_days).
 */
export const SOURCE_VISITS_SQL = `/* source_visits */
WITH v AS (
  SELECT
    COALESCE(visit, id) AS vid,
    source_dim,
    MAX(source_name) AS source_name,
    MAX(COALESCE(tagged, 0)) AS tagged,
    MAX(CASE WHEN event_type IN (${VISIT_EVENTS}) THEN 1 ELSE 0 END) AS seen,
    MAX(CASE WHEN event_type = 'conversion' THEN 1 ELSE 0 END) AS converted
  FROM events
  WHERE customer_id = ?1 AND ts > ?2 AND ts <= ?3
    AND source_dim IS NOT NULL
    AND COALESCE(cohort, 'personalized') IN (${SIGNAL_SQL})
  GROUP BY COALESCE(visit, id), source_dim
)
SELECT
  source_dim,
  COALESCE(source_name, '') AS source_name,
  SUM(seen) AS visits,
  SUM(converted) AS conversions,
  SUM(seen * tagged) AS tagged_visits,
  SUM(converted * tagged) AS tagged_conversions
FROM v
GROUP BY source_dim, COALESCE(source_name, '')`;

export interface SourceVisitRow {
  source_dim: string;
  /** '' when the visit had no name. */
  source_name: string;
  visits: number;
  conversions: number;
  tagged_visits: number;
  tagged_conversions: number;
}

/** The (source, name) counts over (start, end]. */
export async function sourceVisits(
  db: D1Database,
  customerId: string,
  start: number,
  end: number,
): Promise<SourceVisitRow[]> {
  const r = await db.prepare(SOURCE_VISITS_SQL).bind(customerId, start, end).all<SourceVisitRow>();
  return (r.results ?? []).map((x) => ({
    source_dim: String(x.source_dim),
    source_name: String(x.source_name ?? ""),
    visits: Number(x.visits) || 0,
    conversions: Number(x.conversions) || 0,
    tagged_visits: Number(x.tagged_visits) || 0,
    tagged_conversions: Number(x.tagged_conversions) || 0,
  }));
}

/** Pages with their own confirmed manifest (normalized when written, migration 0014). */
export const VERSIONED_PAGES_SQL = `/* versioned_pages */
SELECT page_path FROM element_manifests WHERE customer_id = ?1 AND confirmed_at IS NOT NULL`;

/**
 * The fixed part of a stored path: everything before its last segment.
 * `rtrim(p, replace(p, '/', ''))` strips the last segment's characters from
 * the end (the set never holds `/`, so it stops at the last slash), then the
 * slash goes. `/products/ginseng` gives `/products`.
 */
const FIXED_PART = "rtrim(rtrim(page_path, replace(page_path, '/', '')), '/')";
/** How many segments a stored path has: its slashes. */
const DEPTH = "length(page_path) - length(replace(page_path, '/', ''))";

/**
 * Page groups (docs/specs/page-groups.md, "Where groups come from"): per
 * fixed part of one or two segments, the distinct masked paths exactly one
 * segment deeper that had a visit in (start, end] and are not confirmed
 * pages, and the distinct visits across them. `filter` narrows the fixed
 * parts. The fixed part leaves the query, nothing else; its segments are
 * screened again in lib/page-group-counts.ts before anything is stored.
 */
function groupCountsSql(tag: string, filter: string): string {
  return `/* ${tag} */
WITH p AS (
  SELECT ${NORM_PATH} AS page_path, visit, id
  FROM events
  WHERE customer_id = ?1 AND ts > ?2 AND ts <= ?3
    AND event_type IN (${VISIT_EVENTS})
),
q AS (
  SELECT page_path, visit, id, ${FIXED_PART} AS fixed
  FROM p
  WHERE ${DEPTH} IN (2, 3)
    AND page_path NOT IN (
      SELECT page_path FROM element_manifests WHERE customer_id = ?1 AND confirmed_at IS NOT NULL
    )
)
SELECT fixed, COUNT(DISTINCT page_path) AS pages, COUNT(DISTINCT COALESCE(visit, id)) AS visits
FROM q
GROUP BY fixed
${filter}
ORDER BY visits DESC, fixed ASC
LIMIT 50`;
}

/** The proposals: fixed parts with at least ?4 distinct pages under them. */
export const GROUP_PROPOSALS_SQL = groupCountsSql(
  "group_proposals",
  "HAVING COUNT(DISTINCT page_path) >= ?4",
);

/** The accepted patterns' counts: the fixed parts in the JSON list ?4, no floor. Runs only with accepted groups. */
export const ACCEPTED_GROUP_COUNTS_SQL = groupCountsSql(
  "accepted_group_counts",
  "HAVING fixed IN (SELECT value FROM json_each(?4))",
);

// ---------------------------------------------------------------------------
// The arms, intent-to-treat (docs/specs/proof-engine.md, D)
// ---------------------------------------------------------------------------

/**
 * Per arm: visits the coin assigned it in (start, end], and how many of them
 * converted on any page. `customer_id = ?1` on every events subquery; the
 * marker join stays inside this customer and only counts leave.
 */
export const ARM_TOTALS_SQL = `/* arm_totals */
WITH armed AS (
  SELECT visit, MAX(arm) AS arm, COUNT(DISTINCT arm) AS arms
  FROM events
  WHERE customer_id = ?1 AND ts > ?2 AND ts <= ?3
    AND visit IS NOT NULL AND arm IS NOT NULL
    AND event_type IN ('variant_shown', 'personalization_skipped')
  GROUP BY visit
),
conv AS (
  SELECT DISTINCT visit FROM events
  WHERE customer_id = ?1 AND ts > ?2 AND ts <= ?3
    AND visit IS NOT NULL AND event_type = 'conversion'
)
SELECT armed.arm AS arm, COUNT(*) AS visits, COUNT(conv.visit) AS conversions
FROM armed LEFT JOIN conv ON conv.visit = armed.visit
WHERE armed.arms = 1
GROUP BY armed.arm`;

export interface ArmTotals {
  treat: { visits: number; conversions: number };
  holdout: { visits: number; conversions: number };
}

/** The two arms over (start, end]. */
export async function armTotals(
  db: D1Database,
  customerId: string,
  start: number,
  end: number = Number.MAX_SAFE_INTEGER,
): Promise<ArmTotals> {
  const out: ArmTotals = {
    treat: { visits: 0, conversions: 0 },
    holdout: { visits: 0, conversions: 0 },
  };
  const rows = await db
    .prepare(ARM_TOTALS_SQL)
    .bind(customerId, start, end)
    .all<{ arm: string; visits: number; conversions: number }>();
  for (const r of rows.results ?? []) {
    if (r.arm === "treat" || r.arm === "holdout") {
      out[r.arm] = { visits: Number(r.visits) || 0, conversions: Number(r.conversions) || 0 };
    }
  }
  return out;
}

/** The treat arm's entry in per_cohort (analytics_aggregates keeps its shape). */
function treatArmEntry(arms: ArmTotals) {
  return {
    cohort: "treat_arm",
    visits: arms.treat.visits,
    conversions: arms.treat.conversions,
    conversion_rate: arms.treat.visits > 0 ? arms.treat.conversions / arms.treat.visits : 0,
  };
}

// ---------------------------------------------------------------------------
// Core: compute one (customer, window) over an explicit range
// ---------------------------------------------------------------------------

type Totals = { visits: number; conversions: number };

/** A window's groups, each counted distinct inside itself. */
interface Groups {
  all: Totals;
  signal: Totals;
  cohort: (cohort: string) => Totals;
  cells: GroupRow[];
  intents: GroupRow[];
  sources: GroupRow[];
}

const ZERO: Totals = { visits: 0, conversions: 0 };

function totalsOf(row: GroupRow | undefined): Totals {
  return row
    ? { visits: Number(row.visits) || 0, conversions: Number(row.conversions) || 0 }
    : { ...ZERO };
}

/**
 * Reads one level per group straight off the query. Never adds the rows of
 * one level into another: a visit that touched two cells is one visit in
 * its cohort, and the cohort row already says so.
 */
function groupsOf(rows: readonly GroupRow[]): Groups {
  const at = (level: GroupRow["level"]) => rows.filter((r) => r.level === level);
  const cohorts = new Map(at("cohort").map((r) => [String(r.cohort), totalsOf(r)]));
  return {
    all: totalsOf(at("all")[0]),
    signal: totalsOf(at("signal")[0]),
    cohort: (c) => cohorts.get(c) ?? { ...ZERO },
    cells: at("cell"),
    intents: at("intent"),
    sources: at("source"),
  };
}

const ALL_COHORTS = ["personalized", "holdout", "skipped", "no_signal"] as const;

async function visitGroups(
  db: D1Database,
  customerId: string,
  start: number,
  end: number,
): Promise<Groups> {
  const r = await db.prepare(VISIT_GROUPS_SQL).bind(customerId, start, end).all<GroupRow>();
  return groupsOf(r.results ?? []);
}

/** Every value of one analytics_aggregates row except its key and computed_at. */
interface WindowValues {
  totalVisits: number;
  personalized: Totals;
  holdoutArm: Totals;
  skipped: Totals;
  noSignal: Totals;
  totalConversions: number;
  prevTotalVisits: number;
  prevConversions: number;
  perVariant: unknown[];
  perIntent: unknown[];
  perCohort: Array<Record<string, unknown>>;
  timeSeries: DailyBucket[] | null;
  holdoutLift: ReturnType<typeof computeGatedLift>;
  naturalLift: ReturnType<typeof computeGatedLift>;
  perSource: StoredSource[];
  perPage: {
    pages: unknown[];
    without_versions: unknown;
    counter?: PageLoads;
    groups?: GroupCount[];
  };
  tagged: StoredTagged;
}

/**
 * Everything one row holds, for the events in (start, end] and the period
 * before (start - windowMs, start]. The rolling row and the backfill call
 * this one function with different ranges.
 */
export async function computeWindow(
  db: D1Database,
  customerId: string,
  window: string,
  windowMs: number,
  start: number,
  end: number,
  now: number = Date.now(),
): Promise<WindowValues> {
  const g = await visitGroups(db, customerId, start, end);
  const personalized = g.cohort("personalized");
  const noSignal = g.cohort("no_signal");
  const skipped = g.cohort("skipped");

  // The total is every visit once, whatever cohorts it crossed; a cohort
  // counts each visit once however many cells it touched (2026-10-06).
  const totalVisits = g.all.visits;
  const totalConversions = g.all.conversions;

  // The period before, counted the same way, only while its rows carry the
  // marker (docs/specs/results-data.md §2).
  const prevStart = start - windowMs;
  const comparable = previousComparable(prevStart, now);
  const prev = comparable ? await visitGroups(db, customerId, prevStart, start) : null;

  // per_variant: [{intent_dim, source_dim, visits, conversions}], no skipped
  // (only what shipped to visitors), each cell distinct.
  const perVariant = g.cells.map((r) => ({
    intent_dim: r.intent_dim,
    source_dim: r.source_dim,
    ...totalsOf(r),
  }));

  // per_intent: [{intent_dim, visits, conversions}], same exclusion.
  const perIntent = g.intents.map((r) => ({
    intent_dim: r.intent_dim ?? "unknown",
    ...totalsOf(r),
  }));

  const flags = await db
    .prepare(NO_SIGNAL_FLAGS_SQL)
    .bind(customerId, start, end)
    .first<{ dark: number; lang: number }>();
  // The skipped cohort's two kinds (late-tag.md): painted first, or not.
  const split = await db
    .prepare(SKIPPED_SPLIT_SQL)
    .bind(customerId, start, end)
    .first<{ lp_visits: number; other_visits: number }>();

  // per_cohort: all 4 cohorts (skipped included, for operator visibility),
  // each with the period before (null when not comparable).
  const perCohort: Array<Record<string, unknown>> = ALL_COHORTS.map((cohort) => {
    const c = g.cohort(cohort);
    const p = prev ? prev.cohort(cohort) : null;
    return {
      cohort,
      visits: c.visits,
      conversions: c.conversions,
      conversion_rate: c.visits > 0 ? c.conversions / c.visits : 0,
      prev_visits: p ? p.visits : null,
      prev_conversions: p ? p.conversions : null,
      ...(cohort === "no_signal"
        ? {
            dark_social_probable: Number(flags?.dark) || 0,
            language_mismatch: Number(flags?.lang) || 0,
          }
        : {}),
      ...(cohort === "skipped"
        ? {
            lp_visits: Number(split?.lp_visits) || 0,
            other_visits: Number(split?.other_visits) || 0,
          }
        : {}),
    };
  });

  // The signal cohorts together, each visit once (2026-10-06): the lead's
  // "told us where they came from" and the period before's signal_visits.
  perCohort.push({
    cohort: "signal",
    visits: g.signal.visits,
    conversions: g.signal.conversions,
    conversion_rate: g.signal.visits > 0 ? g.signal.conversions / g.signal.visits : 0,
    prev_visits: prev ? prev.signal.visits : null,
    prev_conversions: prev ? prev.signal.conversions : null,
  });

  let timeSeries: DailyBucket[] | null = null;
  if (window === "30d") {
    const ts = await db.prepare(DAILY_SQL).bind(customerId, start, end).all<DailyBucket>();
    timeSeries = ts.results ?? [];
  }

  // holdoutLift: treat arm vs holdout arm, intent-to-treat (causal).
  // naturalLift: personalized vs no_signal cohorts (directional).
  const arms = await armTotals(db, customerId, start, end);
  perCohort.push(treatArmEntry(arms));
  const holdoutLift = computeGatedLift(
    arms.treat.visits,
    arms.treat.conversions,
    arms.holdout.visits,
    arms.holdout.conversions,
  );
  const naturalLift = computeGatedLift(
    personalized.visits,
    personalized.conversions,
    noSignal.visits,
    noSignal.conversions,
  );

  // N4: pages, with versions or without (docs/specs/results-data.md §4). A
  // sensitive customer's pages are counted by the stored path, inside the
  // query (docs/specs/sensitive-customers.md).
  const sensitive: SensitiveSettings = await sensitiveSettings(db, customerId);
  const keptJson = JSON.stringify(sensitive.kept);
  const [counted, versionedRows, without] = await Promise.all([
    sensitive.sensitive
      ? db
          .prepare(SENSITIVE_PAGE_ROWS_SQL)
          .bind(customerId, start, end, PAGE_MIN_VISITS, keptJson)
          .all<CountedPage>()
      : db.prepare(PAGE_ROWS_SQL).bind(customerId, start, end, PAGE_MIN_VISITS).all<CountedPage>(),
    db.prepare(VERSIONED_PAGES_SQL).bind(customerId).all<{ page_path: string }>(),
    (sensitive.sensitive
      ? db.prepare(SENSITIVE_PAGES_WITHOUT_VERSIONS_SQL).bind(customerId, start, end, keptJson)
      : db.prepare(PAGES_WITHOUT_VERSIONS_SQL).bind(customerId, start, end)
    ).first<{ pages: number; visits: number; signal_visits: number }>(),
  ]);
  const versioned = new Set((versionedRows.results ?? []).map((r) => normalizePath(r.page_path)));
  const listed = selectPages(
    (counted.results ?? []).map((r) => ({
      page_path: String(r.page_path),
      visits: Number(r.visits) || 0,
      signal_visits: Number(r.signal_visits) || 0,
      written_visits: Number(r.written_visits) || 0,
      skipped_visits: Number(r.skipped_visits) || 0,
      lp_visits: Number(r.lp_visits) || 0,
    })),
    versioned,
    // A row stored before the edge masked identifiers folds into `:id` here
    // (docs/specs/event-paths.md), so per_page never stores one. The query
    // already grouped a sensitive customer's paths; this is the same rule.
    sensitive.sensitive
      ? (p) => storedPath(maskPath(p), sensitive.kept)
      : (p) => normalizePath(maskPath(p)),
  );
  // A group is never one page: it says so, has no versions of its own, and
  // carries no late-tag count (no late-tag share per grouped page).
  const pages = sensitive.sensitive
    ? listed.map((p) => {
        if (!isGroupPath(p.page_path)) return p;
        const { lp_visits: _lp, ...rest } = p as typeof p & { lp_visits?: number };
        return { ...rest, has_versions: false, group: true as const };
      })
    : listed;
  // Per-page loads, and the pages without versions, from the daily counter:
  // closed and folded days only, no marker.
  const days = sensitive.sensitive ? counterDays(windowMs, start, end, now) : null;
  // The visit floor: distinct visits per day and group over the same days.
  const dayMs = 24 * 60 * 60 * 1000;
  const behind = days
    ? await groupVisits(
        db,
        customerId,
        Date.parse(`${days.from}T00:00:00.000Z`),
        Date.parse(`${days.to}T00:00:00.000Z`) + dayMs,
        sensitive.kept,
      )
    : [];
  const loadsRead = sensitive.sensitive
    ? await readPageLoads(db, customerId, days, sensitive.kept, behind)
    : null;
  const counter = loadsRead ? pageLoadsFrom(days, loadsRead, versioned) : null;

  // Page groups (docs/specs/page-groups.md; N4.1): the proposals and the
  // accepted patterns' counts. From the event rows' masked paths, or for a
  // sensitive customer in code from the counter's rows already read, a kept
  // section's group only. A missing page_groups table is no groups, and a
  // proposal read that fails is no groups: the window is written without
  // them, never lost.
  let groups: GroupCount[] = [];
  try {
    const accepted = await acceptedGroupPatterns(db, customerId);
    if (sensitive.sensitive) {
      const named = sensitiveGroupPages(loadsRead?.rows ?? [], sensitive.kept);
      groups = sensitiveGroupCounts(named, behind, accepted);
    } else {
      const [proposed, countedAccepted] = await Promise.all([
        db
          .prepare(GROUP_PROPOSALS_SQL)
          .bind(customerId, start, end, GROUP_PROPOSAL_MIN_PAGES)
          .all<FixedPartRow>(),
        accepted.length > 0
          ? db
              .prepare(ACCEPTED_GROUP_COUNTS_SQL)
              .bind(customerId, start, end, JSON.stringify(acceptedFixedParts(accepted)))
              .all<FixedPartRow>()
          : Promise.resolve({ results: [] as FixedPartRow[] }),
      ]);
      groups = groupCountsFrom(
        [...(proposed.results ?? []), ...(countedAccepted.results ?? [])],
        accepted,
      );
    }
  } catch (e) {
    groups = [];
    console.error(GROUPS_FAILED_LINE, {
      customer: customerId,
      window,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // N1 and N3: names inside each source (5 visits or more) and the visits
  // on the customer's own tagged links, with the period before.
  const named = await sourceVisits(db, customerId, start, end);
  const prevNamed = comparable ? await sourceVisits(db, customerId, prevStart, start) : null;
  const perSource = withNames(buildPerSource(g.sources, prev ? prev.sources : null), named);

  return {
    totalVisits,
    personalized,
    holdoutArm: arms.holdout,
    skipped,
    noSignal,
    totalConversions,
    prevTotalVisits: prev ? prev.all.visits : 0,
    prevConversions: prev ? prev.all.conversions : 0,
    perVariant,
    perIntent,
    perCohort,
    timeSeries,
    holdoutLift,
    naturalLift,
    perSource,
    tagged: taggedTotals(named, prevNamed),
    perPage: {
      pages,
      without_versions: {
        // The stored paths cannot say how many pages a group holds; the
        // counter can (named pages on its counted days).
        pages: counter ? counter.without_versions.pages : Number(without?.pages) || 0,
        visits: Number(without?.visits) || 0,
        signal_visits: Number(without?.signal_visits) || 0,
      },
      ...(counter ? { counter } : {}),
      // Only with something to show: a customer without groups stores the
      // blob it always stored.
      ...(groups.length > 0 ? { groups } : {}),
    },
  };
}

/**
 * Upsert, idempotent via INSERT OR REPLACE, keyed by UNIQUE INDEX
 * idx_analytics_aggregates_unique on (customer_id, window, window_start).
 * Re-running for the same key replaces the row cleanly.
 */
async function writeWindow(
  db: D1Database,
  customerId: string,
  window: string,
  windowStart: number,
  computedAt: number,
  v: WindowValues,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO analytics_aggregates (
       customer_id,
       window,
       window_start,
       computed_at,
       total_visits,
       personalized_visits,
       holdout_visits,
       skipped_visits,
       passthrough_visits,
       conversions,
       personalized_conversions,
       holdout_conversions,
       skipped_conversions,
       passthrough_conversions,
       prev_total_visits,
       prev_conversions,
       per_variant,
       per_intent,
       per_cohort,
       time_series,
       holdout_lift,
       holdout_lift_ci_lower,
       holdout_lift_ci_upper,
       holdout_significance,
       natural_lift,
       natural_lift_ci_lower,
       natural_lift_ci_upper,
       natural_significance,
       per_source,
       per_page,
       tagged
     ) VALUES (
       ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?
     )`,
    )
    .bind(
      customerId,
      window,
      windowStart,
      computedAt,
      // visit counters
      v.totalVisits,
      v.personalized.visits,
      v.holdoutArm.visits, // the holdout arm, intent-to-treat
      v.skipped.visits,
      v.noSignal.visits, // passthrough = no_signal
      // conversion counters
      v.totalConversions,
      v.personalized.conversions,
      v.holdoutArm.conversions,
      v.skipped.conversions,
      v.noSignal.conversions,
      // previous period (0 when not comparable; per_cohort says null)
      v.prevTotalVisits,
      v.prevConversions,
      // JSON blobs
      JSON.stringify(v.perVariant),
      JSON.stringify(v.perIntent),
      JSON.stringify(v.perCohort),
      v.timeSeries !== null ? JSON.stringify(v.timeSeries) : null,
      // holdout lift
      v.holdoutLift.lift,
      v.holdoutLift.ci_lower,
      v.holdoutLift.ci_upper,
      v.holdoutLift.significance,
      // natural lift
      v.naturalLift.lift,
      v.naturalLift.ci_lower,
      v.naturalLift.ci_upper,
      v.naturalLift.significance,
      // Results page (migration 0034)
      JSON.stringify(v.perSource),
      JSON.stringify(v.perPage),
      // N3 (migration 0035)
      JSON.stringify(v.tagged),
    )
    .run();
}

/**
 * The rolling row: (now - W, now], keyed by the aligned bucket so re-runs
 * for the same hour/day replace one row.
 */
export async function aggregateWindow(
  customerId: string,
  window: string,
  windowMs: number,
  env: AggregatorEnv,
): Promise<void> {
  const now = Date.now();
  const windowStart = Math.floor((now - windowMs) / windowMs) * windowMs;
  const values = await computeWindow(
    env.DB,
    customerId,
    window,
    windowMs,
    now - windowMs,
    now,
    now,
  );
  await writeWindow(env.DB, customerId, window, windowStart, now, values);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the aggregator for all active customers and all windows.
 *
 * @returns aggregate counters for logging.
 */
export async function runAggregator(env: AggregatorEnv): Promise<AggregatorResult> {
  const start = Date.now();

  const result = await env.DB.prepare("SELECT id FROM customers WHERE status = 'active'").all<{
    id: string;
  }>();

  const customers = result.results ?? [];

  let aggregated = 0;
  let errors = 0;

  for (const customer of customers) {
    for (const win of WINDOWS) {
      try {
        await aggregateWindow(customer.id, win.key, win.ms, env);
        aggregated++;
      } catch (e) {
        errors++;
        console.error(
          `[aggregator] failed: customer=${customer.id} window=${win.key}`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }

  return { aggregated, errors, durationMs: Date.now() - start };
}

/**
 * Run the aggregator for a single customer + all windows.
 */
export async function runAggregatorForCustomer(
  customerId: string,
  env: AggregatorEnv,
): Promise<AggregatorResult> {
  const start = Date.now();
  let aggregated = 0;
  let errors = 0;

  for (const win of WINDOWS) {
    try {
      await aggregateWindow(customerId, win.key, win.ms, env);
      aggregated++;
    } catch (e) {
      errors++;
      console.error(
        `[aggregator] failed: customer=${customerId} window=${win.key}`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return { aggregated, errors, durationMs: Date.now() - start };
}

/**
 * Backfill historical windows for a single customer from a given timestamp.
 *
 * Iterates backward in time from now to `fromTs`, computing window_start
 * aligned to each window's boundary. INSERT OR REPLACE makes each run
 * idempotent (safe to repeat after formula changes). Its newest bucket has
 * the rolling row's key and replaces it until the next hourly run.
 */
export async function backfillCustomer(
  customerId: string,
  fromTs: number,
  env: AggregatorEnv,
): Promise<AggregatorResult> {
  const start = Date.now();
  let aggregated = 0;
  let errors = 0;

  const now = Date.now();

  for (const win of WINDOWS) {
    // Walk backward from the current window boundary to fromTs.
    let cursor = Math.floor(now / win.ms) * win.ms;
    while (cursor > fromTs) {
      const windowStart = cursor - win.ms;
      try {
        await aggregateWindowAt(customerId, win.key, win.ms, windowStart, env);
        aggregated++;
      } catch (e) {
        errors++;
        console.error(
          `[aggregator/backfill] failed: customer=${customerId} window=${win.key} start=${windowStart}`,
          e instanceof Error ? e.message : String(e),
        );
      }
      cursor = windowStart;
    }
  }

  return { aggregated, errors, durationMs: Date.now() - start };
}

/**
 * A window with an explicit boundary: (windowStart, windowStart + W], keyed
 * by windowStart. The rolling row's mirror: the same computeWindow.
 */
export async function aggregateWindowAt(
  customerId: string,
  window: string,
  windowMs: number,
  windowStart: number,
  env: AggregatorEnv,
): Promise<void> {
  const now = Date.now();
  const values = await computeWindow(
    env.DB,
    customerId,
    window,
    windowMs,
    windowStart,
    windowStart + windowMs,
    now,
  );
  await writeWindow(env.DB, customerId, window, windowStart, now, values);
}
