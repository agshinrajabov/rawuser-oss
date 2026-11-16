/**
 * Daily exposure outcomes (docs/specs/proof-engine.md, section E).
 *
 * Each visit counted once, in the row of its first exposure on the UTC day
 * it started; its conversions follow its arm, on any page of the visit
 * (intent-to-treat, faults 4 and 5). Rebuilt whole days at a time (delete
 * and insert in one batch), so a rerun gives the same rows and a cell that
 * vanished does not linger. Lets a pilot longer than 30 days be read after
 * the 31-day marker purge (gone since ADR 0037, 2026-11-02; days before it
 * lost their markers).
 *
 * The marker join (privacy review condition 3): the visit marker joins a visit's
 * conversion rows to its exposure rows only here and in the aggregator,
 * inside one customer (`customer_id = ?` on every events subquery, static
 * test), and only counts leave. Never joined to another table.
 *
 * Mixed: a visit carrying both arms (the percent changed mid-visit) is left
 * out of every row and counted in exposure_rollup_days.mixed_visits. A visit
 * with one arm and some pages without one keeps its arm: dropping it would
 * filter on what happened after the coin.
 *
 * Source days (N1, N3; docs/specs/results-data.md §7): the same batch
 * rebuilds source_days, the day's visits per source and platform name with
 * the visits on the customer's own tagged links. Until ADR 0037
 * (2026-11-02) events.source_name and events.tagged were NULLed with the
 * marker after 31 days; for those days these counts are what remains. A name with fewer than 5 visits that day folds into ''.
 * A visit across midnight counts on each day it was seen.
 *
 * The bit lp (docs/specs/late-tag.md; privacy review Q2, condition 4):
 * each row also counts the visits whose first exposure carried `lp` (the
 * page had been painted when our script started, so it stayed as built) and
 * how many of those converted. "First exposure" is the one that decides the
 * row: the visit's first exposure with an arm, else its first. One exposure
 * decides the cell and the bit together, so a group by `lp` is a group by a
 * fact that was fixed before the arm could matter (lib/proof-report.ts,
 * "the two groups"). Until ADR 0037 the bit left the event row
 * after 31 days; for those days these counts are what remains.
 *
 * A sensitive customer (docs/specs/sensitive-customers.md): a row's page is
 * the stored path (`/`, a kept section, its group, or `/:item`), applied
 * again here so a day rebuilt from rows stored before the customer was
 * marked never names a product page beside an arm. And the same batch folds
 * the day's page_days rows (condition 4): a group with fewer than three
 * distinct pages that day, or with fewer than five distinct visits behind
 * it, becomes one row under the group's path. A day too old to rebuild (its
 * markers gone) is not touched: it was folded while they were there, and a
 * fold never unfolds. The day's
 * exposure_rollup_days row, written in that batch, is the record that the
 * fold has run; no read of page_days takes a day without it. The fold runs
 * for a sensitive customer whatever its status. For any other customer no
 * statement and no row differs.
 *
 * Offline cron only, never in the visitor path.
 */

import { maskPath, storedPath } from "@rawuser/shared";
import { lpOf } from "../lib/lp.ts";
import { foldSmallNames } from "../lib/results.ts";
import { foldDayStatements, sensitiveSettings } from "../lib/sensitive-pages.ts";
import { groupVisits, sourceVisits } from "./analytics-aggregator.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** How long the marker lives on event rows (the 6-hour cron's ceiling). */
export const MARKER_KEEP_MS = 31 * DAY_MS;
/** Each hourly run rebuilds this many closed days. */
export const ROLLUP_DAYS = 3;
/** A visit may run past midnight; its conversions are looked for this long after the day. */
const CONVERSION_TAIL_MS = 2 * HOUR_MS;

export const EXPOSURE_TYPES = "('variant_shown','personalization_skipped','no_signal_passthrough')";

export interface RollupEnv {
  DB: D1Database;
}

/** UTC 'YYYY-MM-DD' of a timestamp. */
export function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Epoch ms of a UTC day's midnight. */
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export interface OutcomeRow {
  customer_id: string;
  day: string;
  arm: "treat" | "holdout" | "none";
  page_path: string;
  intent_dim: string;
  source_dim: string;
  body_id: string;
  visits: number;
  converting_visits: number;
  applied_visits: number;
  skipped_visits: number;
  applied_converting_visits: number;
  /** Of `visits`: the first exposure carried `lp` (the page was painted first). */
  lp_visits: number;
  /** Of `converting_visits`: the first exposure carried `lp`. */
  lp_converting_visits: number;
  conversions_by_label: Record<string, number>;
}

/** One visit as the per-visit query returns it. */
interface VisitRow {
  arms: number;
  arm: string | null;
  applied: number;
  skipped: number;
  page_path: string | null;
  intent_dim: string | null;
  source_dim: string | null;
  body_id: string | null;
  /** 1 when the exposure that decides the row carried `lp`. */
  lp: number;
  labels: string | null;
}

/**
 * Per visit that started in [?2, ?3): how many distinct arms it carried,
 * the arm, whether a version was written or skipped anywhere in it, the
 * cell of its first armed exposure (its first exposure when it has no arm),
 * whether that same exposure carried `lp`, and the labels of its conversions
 * on any page.
 */
const VISITS_SQL = `
WITH exp AS (
  SELECT id, visit, arm, page_path, intent_dim, source_dim, body_id, event_type, ts,
         ${lpOf()} AS lp
  FROM events
  WHERE customer_id = ?1 AND visit IS NOT NULL
    AND event_type IN ${EXPOSURE_TYPES}
    AND ts >= ?2 - ${HOUR_MS} AND ts < ?3 + ${CONVERSION_TAIL_MS}
),
ranked AS (
  SELECT exp.*,
         ROW_NUMBER() OVER (PARTITION BY visit ORDER BY (arm IS NULL), ts, id) AS rn
  FROM exp
),
v AS (
  SELECT visit,
         COUNT(DISTINCT arm) AS arms,
         MAX(arm) AS arm,
         MIN(ts) AS first_ts,
         MAX(event_type = 'variant_shown') AS applied,
         MAX(event_type = 'personalization_skipped') AS skipped
  FROM exp GROUP BY visit
),
conv AS (
  SELECT visit, group_concat(conversion_label) AS labels FROM (
    SELECT DISTINCT visit, conversion_label FROM events
    WHERE customer_id = ?1 AND event_type = 'conversion' AND visit IS NOT NULL
      AND ts >= ?2 AND ts < ?3 + ${CONVERSION_TAIL_MS}
  ) GROUP BY visit
)
SELECT v.arms, v.arm, v.applied, v.skipped,
       r.page_path, r.intent_dim, r.source_dim, r.body_id, r.lp,
       conv.labels
FROM v
JOIN ranked r ON r.visit = v.visit AND r.rn = 1
LEFT JOIN conv ON conv.visit = v.visit
WHERE v.first_ts >= ?2 AND v.first_ts < ?3`;

/** Exposures without a marker: one visit each, counted by row, arm none. */
const MARKERLESS_SQL = `
SELECT page_path,
       COALESCE(intent_dim, 'none') AS intent_dim,
       COALESCE(source_dim, 'none') AS source_dim,
       COALESCE(body_id, '') AS body_id,
       COUNT(*) AS visits,
       SUM(event_type = 'variant_shown') AS applied,
       SUM(event_type = 'personalization_skipped') AS skipped,
       SUM(${lpOf()}) AS lp
FROM events
WHERE customer_id = ?1 AND visit IS NULL
  AND event_type IN ${EXPOSURE_TYPES}
  AND ts >= ?2 AND ts < ?3
GROUP BY page_path, COALESCE(intent_dim, 'none'), COALESCE(source_dim, 'none'), COALESCE(body_id, '')`;

/** Every statement that reads events in this module, for the static test. */
export const ROLLUP_EVENT_QUERIES = [VISITS_SQL, MARKERLESS_SQL];

/**
 * The rows of one customer's day, not written. `kept`: the kept sections of
 * a sensitive customer (an empty list too); null for any other customer.
 */
export async function computeDay(
  db: D1Database,
  customerId: string,
  day: string,
  kept: readonly string[] | null = null,
): Promise<{ rows: OutcomeRow[]; mixed: number }> {
  const start = dayStart(day);
  const end = start + DAY_MS;
  const [visits, markerless] = await Promise.all([
    db.prepare(VISITS_SQL).bind(customerId, start, end).all<VisitRow>(),
    db.prepare(MARKERLESS_SQL).bind(customerId, start, end).all<{
      page_path: string | null;
      intent_dim: string;
      source_dim: string;
      body_id: string;
      visits: number;
      applied: number;
      skipped: number;
      lp: number;
    }>(),
  ]);

  const cells = new Map<string, OutcomeRow>();
  const cell = (
    arm: OutcomeRow["arm"],
    r: {
      page_path: string | null;
      intent_dim: string | null;
      source_dim: string | null;
      body_id: string | null;
    },
  ) => {
    // Masked again here (docs/specs/event-paths.md): a day rebuilt from rows
    // stored before the edge masked never copies an identifier into a row.
    // A sensitive customer's row names the stored path, never a product page
    // beside an arm, an intent and a source (sensitive-customers.md).
    const masked = maskPath(r.page_path || "/");
    const page_path = kept ? storedPath(masked, kept) : masked;
    const intent_dim = r.intent_dim || "none";
    const source_dim = r.source_dim || "none";
    const body_id = r.body_id || "";
    const key = JSON.stringify([arm, page_path, intent_dim, source_dim, body_id]);
    let row = cells.get(key);
    if (!row) {
      row = {
        customer_id: customerId,
        day,
        arm,
        page_path,
        intent_dim,
        source_dim,
        body_id,
        visits: 0,
        converting_visits: 0,
        applied_visits: 0,
        skipped_visits: 0,
        applied_converting_visits: 0,
        lp_visits: 0,
        lp_converting_visits: 0,
        conversions_by_label: {},
      };
      cells.set(key, row);
    }
    return row;
  };

  let mixed = 0;
  for (const v of visits.results ?? []) {
    if (Number(v.arms) > 1) {
      mixed++;
      continue;
    }
    const arm = v.arm === "treat" || v.arm === "holdout" ? v.arm : "none";
    const row = cell(arm, v);
    const labels = [...new Set((v.labels ?? "").split(",").filter(Boolean))];
    const applied = Number(v.applied) === 1;
    const lp = Number(v.lp) === 1;
    row.visits++;
    if (applied) row.applied_visits++;
    else if (Number(v.skipped) === 1) row.skipped_visits++;
    if (lp) row.lp_visits++;
    if (labels.length > 0) {
      row.converting_visits++;
      if (applied) row.applied_converting_visits++;
      if (lp) row.lp_converting_visits++;
      for (const l of labels) row.conversions_by_label[l] = (row.conversions_by_label[l] ?? 0) + 1;
    }
  }
  for (const m of markerless.results ?? []) {
    const row = cell("none", m);
    row.visits += Number(m.visits);
    row.applied_visits += Number(m.applied);
    row.skipped_visits += Number(m.skipped);
    // One row is one visit here, so the row's own bit is its first exposure's.
    row.lp_visits += Number(m.lp) || 0;
  }
  return { rows: [...cells.values()], mixed };
}

export type RebuildOutcome =
  | { rebuilt: true; rows: number; mixed: number }
  | { rebuilt: false; reason: "open" | "too_old" };

/**
 * Rebuild one closed UTC day of one customer in one batch: delete its rows,
 * insert the new ones, record the rebuild. Refuses a day that has not
 * closed, and a day older than 31 days: before ADR 0037 the purge took
 * those markers (its visits would turn into markerless ones), and a sensitive
 * customer's folded day never unfolds.
 */
export async function rebuildDay(
  db: D1Database,
  customerId: string,
  day: string,
  now = Date.now(),
): Promise<RebuildOutcome> {
  const start = dayStart(day);
  if (start + DAY_MS > now) return { rebuilt: false, reason: "open" };
  if (start - HOUR_MS < now - MARKER_KEEP_MS) return { rebuilt: false, reason: "too_old" };
  // The flag and the list, read per day: a failed read throws and the day is
  // tried again next hour, never rebuilt under the wrong rule.
  const sensitive = await sensitiveSettings(db, customerId);
  const { rows, mixed } = await computeDay(
    db,
    customerId,
    day,
    sensitive.sensitive ? sensitive.kept : null,
  );
  // (start - 1, start + DAY - 1] is [start, start + DAY) on integer ms.
  // The name floor where the daily aggregate is written: under 5 visits
  // that day, the name folds into '' (privacy review condition 4).
  const sources = foldSmallNames(await sourceVisits(db, customerId, start - 1, start + DAY_MS - 1));
  const stmts: D1PreparedStatement[] = [
    db
      .prepare("DELETE FROM exposure_outcomes WHERE customer_id = ? AND day = ?")
      .bind(customerId, day),
  ];
  for (const r of rows) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO exposure_outcomes
             (customer_id, day, arm, page_path, intent_dim, source_dim, body_id, visits,
              converting_visits, applied_visits, skipped_visits, applied_converting_visits,
              lp_visits, lp_converting_visits, conversions_by_label, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          customerId,
          day,
          r.arm,
          r.page_path,
          r.intent_dim,
          r.source_dim,
          r.body_id,
          r.visits,
          r.converting_visits,
          r.applied_visits,
          r.skipped_visits,
          r.applied_converting_visits,
          r.lp_visits,
          r.lp_converting_visits,
          Object.keys(r.conversions_by_label).length > 0
            ? JSON.stringify(r.conversions_by_label)
            : null,
          now,
        ),
    );
  }
  stmts.push(
    db.prepare("DELETE FROM source_days WHERE customer_id = ? AND day = ?").bind(customerId, day),
  );
  for (const r of sources) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO source_days
             (customer_id, day, source_dim, source_name, visits, conversions, tagged_visits,
              tagged_conversions, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          customerId,
          day,
          r.source_dim,
          r.source_name,
          r.visits,
          r.conversions,
          r.tagged_visits,
          r.tagged_conversions,
          now,
        ),
    );
  }
  // The daily counter's fold (condition 4), in the batch that records the
  // day: the record below exists only where the fold has run.
  // Two floors: a group with fewer than three pages that day, or with fewer
  // than five distinct visits behind it, keeps only the group's row. The
  // visits are a count per group; no marker reaches page_days.
  if (sensitive.sensitive) {
    const behind = new Map(
      (await groupVisits(db, customerId, start, start + DAY_MS, sensitive.kept)).map(
        (r) => [r.grp, r.visits] as const,
      ),
    );
    stmts.push(...(await foldDayStatements(db, customerId, day, sensitive.kept, behind)));
  }
  stmts.push(
    db
      .prepare(
        "INSERT OR REPLACE INTO exposure_rollup_days (customer_id, day, computed_at, mixed_visits) VALUES (?, ?, ?, ?)",
      )
      .bind(customerId, day, now, mixed),
  );
  await db.batch(stmts);
  return { rebuilt: true, rows: rows.length, mixed };
}

/** The `count` closed UTC days before `now`, newest first. */
export function closedDays(now: number, count: number): string[] {
  const today = dayStart(dayOf(now));
  const out: string[] = [];
  for (let i = 1; i <= count; i++) out.push(dayOf(today - i * DAY_MS));
  return out;
}

export interface RollupResult {
  rebuilt: number;
  errors: number;
}

/**
 * A sensitive customer that is not active: its counter is folded all the
 * same, so a day of page_days never stays unfolded because an account was
 * paused. Its own statement, so the list of active customers is read as it
 * always was.
 */
const SENSITIVE_INACTIVE_SQL =
  "SELECT id FROM customers WHERE sensitive = 1 AND status <> 'active'";

/**
 * Hourly: the last three closed days for every active customer, and for a
 * sensitive customer whatever its status.
 */
export async function runExposureRollup(env: RollupEnv, now = Date.now()): Promise<RollupResult> {
  const customers = await env.DB.prepare("SELECT id FROM customers WHERE status = 'active'").all<{
    id: string;
  }>();
  const out: RollupResult = { rebuilt: 0, errors: 0 };
  const ids = (customers.results ?? []).map((c) => c.id);
  try {
    const paused = await env.DB.prepare(SENSITIVE_INACTIVE_SQL).all<{ id: string }>();
    for (const { id } of paused.results ?? []) ids.push(id);
  } catch (e) {
    out.errors++;
    console.error(
      "[exposure-rollup] reading the sensitive customers failed",
      e instanceof Error ? e.message : String(e),
    );
  }
  for (const id of ids) {
    for (const day of closedDays(now, ROLLUP_DAYS)) {
      try {
        const r = await rebuildDay(env.DB, id, day, now);
        if (r.rebuilt) out.rebuilt++;
      } catch (e) {
        out.errors++;
        console.error(
          `[exposure-rollup] failed: customer=${id} day=${day}`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }
  return out;
}

/**
 * Once, at deploy (spec E, Backfill): every closed day still holding its
 * markers for one customer. Idempotent like every rebuild.
 */
export async function backfillExposureOutcomes(
  env: RollupEnv,
  customerId: string,
  now = Date.now(),
): Promise<{ days: number; rebuilt: number }> {
  let rebuilt = 0;
  const days = closedDays(now, 31);
  for (const day of days) {
    const r = await rebuildDay(env.DB, customerId, day, now);
    if (r.rebuilt) rebuilt++;
  }
  return { days: days.length, rebuilt };
}
