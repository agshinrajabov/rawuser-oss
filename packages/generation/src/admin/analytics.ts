/**
 * Admin analytics endpoints — P6 Batch C.
 *
 * Three handlers for reading pre-computed analytics_aggregates rows:
 *   GET /admin/analytics/overview   — hero metrics + cohort breakdown + lift CI
 *   GET /admin/analytics/breakdown  — per_variant + per_intent JSON
 *   GET /admin/analytics/timeseries — 30d daily series
 *
 * All three endpoints:
 *   - Require a valid session (enforced in routes.ts before dispatch).
 *   - Call requireCustomerScope so customer-role users see only their own data.
 *   - Return {empty: true} with HTTP 404 when no aggregator row exists yet.
 *
 * Privacy invariant: these handlers read only analytics_aggregates (pre-computed
 * aggregate counters). No visitor identifiers or raw events are touched.
 */

import type {
  AnalyticsComparison,
  AnalyticsPeriod,
  PagesBreakdown,
  PreviousTotals,
  ResultsBreakdownFields,
  ResultsOverviewFields,
  UnknownRow,
} from "@rawuser/shared";
import { WINDOW_MS } from "../cron/analytics-aggregator.ts";
import { MIN_CONVERSIONS } from "../lib/lift.ts";
import { acceptedGroupPatterns, breakdownGroups } from "../lib/page-group-counts.ts";
import {
  type StoredSource,
  type StoredTagged,
  changeOf,
  pickLead,
  previousComparable,
  rateOf,
  sourceRow,
  taggedRow,
} from "../lib/results.ts";
import { waitingCount } from "../lib/version-approval.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { requireCustomerScope } from "./scope.ts";

// ---------------------------------------------------------------------------
// D1 row shape returned by analytics_aggregates
// ---------------------------------------------------------------------------

interface AggregatesRow {
  customer_id: string;
  window: string;
  window_start: number;
  computed_at: number;
  total_visits: number;
  personalized_visits: number;
  holdout_visits: number;
  skipped_visits: number;
  passthrough_visits: number;
  conversions: number;
  personalized_conversions: number;
  holdout_conversions: number;
  skipped_conversions: number;
  passthrough_conversions: number;
  prev_total_visits: number;
  prev_conversions: number;
  per_variant: string;
  per_intent: string;
  per_cohort: string | null;
  time_series: string | null;
  holdout_lift: number | null;
  holdout_lift_ci_lower: number | null;
  holdout_lift_ci_upper: number | null;
  holdout_significance: string | null;
  natural_lift: number | null;
  natural_lift_ci_lower: number | null;
  natural_lift_ci_upper: number | null;
  natural_significance: string | null;
  /** Migration 0034; null on rows written before it. */
  per_source?: string | null;
  per_page?: string | null;
  /** Migration 0035 (N3); null on rows written before it. */
  tagged?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cr(conversions: number, visits: number): number {
  return visits > 0 ? conversions / visits : 0;
}

/** One cohort entry of the per_cohort blob; prev_* since 2026-10-04 (results-data §2). */
export interface CohortEntry {
  cohort: string;
  visits?: number;
  conversions?: number;
  prev_visits?: number | null;
  prev_conversions?: number | null;
  dark_social_probable?: number;
  language_mismatch?: number;
  /** The skipped entry, rows written since 2026-10-12 (docs/specs/late-tag.md). */
  lp_visits?: number;
  other_visits?: number;
}

export function parseCohorts(raw: string | null): CohortEntry[] {
  if (!raw) return [];
  try {
    const rows = JSON.parse(raw) as unknown;
    return Array.isArray(rows) ? (rows as CohortEntry[]) : [];
  } catch {
    return [];
  }
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * The period a rolling row counts, (computed_at - W, computed_at], and the
 * one before (docs/specs/results-data.md §1, §2). A row from before the
 * 2026-10-04 aggregator counted from its key and is replaced within the hour.
 */
function periodOf(row: Pick<AggregatesRow, "window" | "computed_at">): {
  period: AnalyticsPeriod;
  comparison: AnalyticsComparison;
} | null {
  const ms = WINDOW_MS[row.window];
  if (!ms) return null;
  const end = row.computed_at;
  const start = end - ms;
  return {
    period: { start, end },
    comparison: {
      previous: { start: start - ms, end: start },
      comparable: previousComparable(start - ms, end),
    },
  };
}

/**
 * The period before, like-for-like, from the per_cohort entries; null when
 * not comparable or when the row predates the prev_* fields. Since
 * 2026-10-06 the total and the signal visits are distinct visits (the
 * row's prev_total_visits and prev_conversions, the "signal" entry), not
 * the sum of the cohorts; a row written before has no "signal" entry and
 * keeps the sum until the next hourly run replaces it.
 */
function previousTotals(
  cohorts: CohortEntry[],
  comparable: boolean,
  row: Pick<AggregatesRow, "prev_total_visits" | "prev_conversions">,
): PreviousTotals | null {
  if (!comparable) return null;
  const by = (c: string) => cohorts.find((e) => e.cohort === c);
  const four = ["personalized", "holdout", "skipped", "no_signal"].map(by);
  if (four.some((e) => !e || typeof e.prev_visits !== "number")) return null;
  const v = (c: string) => by(c)?.prev_visits ?? 0;
  const k = (c: string) => by(c)?.prev_conversions ?? 0;
  const signal = by("signal");
  const distinct = signal && typeof signal.prev_visits === "number";
  const signalVisits = distinct ? v("signal") : v("personalized") + v("holdout") + v("skipped");
  const signalConversions = distinct
    ? k("signal")
    : k("personalized") + k("holdout") + k("skipped");
  return {
    total_visits: distinct ? Number(row.prev_total_visits) || 0 : signalVisits + v("no_signal"),
    total_conversions: distinct
      ? Number(row.prev_conversions) || 0
      : signalConversions + k("no_signal"),
    signal_visits: signalVisits,
    signal_conversions: signalConversions,
    no_signal_visits: v("no_signal"),
    no_signal_conversions: k("no_signal"),
  };
}

/** The skipped cohort's two kinds from its per_cohort entry; null before the split was stored. */
export function skippedSplit(cohorts: CohortEntry[]): {
  lp_visits: number | null;
  other_visits: number | null;
} {
  const e = cohorts.find((c) => c.cohort === "skipped");
  const split = typeof e?.lp_visits === "number" && typeof e.other_visits === "number";
  return {
    lp_visits: split ? (e.lp_visits as number) : null,
    other_visits: split ? (e.other_visits as number) : null,
  };
}

type Significance = "not_yet" | "sig_90" | "sig_95" | "sig_99";

function parseSignificance(raw: string | null): Significance {
  if (raw === "sig_90" || raw === "sig_95" || raw === "sig_99") {
    return raw;
  }
  return "not_yet";
}

// ---------------------------------------------------------------------------
// GET /admin/analytics/overview
// ---------------------------------------------------------------------------

export async function handleAnalyticsOverview(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  const window = url.searchParams.get("window") ?? "24h";

  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) {
    return jsonWithCors({ error: scope.reason }, env, 403);
  }

  if (!customerId) {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }

  const row = await env.DB.prepare(
    `SELECT * FROM analytics_aggregates
     WHERE customer_id = ? AND window = ?
     ORDER BY window_start DESC
     LIMIT 1`,
  )
    .bind(customerId, window)
    .first<AggregatesRow>();

  // Versions waiting for the customer's OK (docs/specs/versions-approval.md):
  // on every answer, the empty one too, so the Overview can ask for the OK
  // before the first visit is counted.
  const pendingVersions = await waitingCount(env.DB, customerId);

  if (!row) {
    return jsonWithCors({ empty: true, pending_versions: pendingVersions }, env, 404);
  }

  const timing = periodOf(row);
  const cohortEntries = parseCohorts(row.per_cohort);
  const previous = timing ? previousTotals(cohortEntries, timing.comparison.comparable, row) : null;
  const results: Partial<ResultsOverviewFields> = timing
    ? { period: timing.period, comparison: timing.comparison, previous }
    : {};

  const overview = {
    customer_id: customerId,
    window: row.window,
    computed_at: row.computed_at,
    cohorts: {
      personalized: {
        visits: row.personalized_visits,
        conversions: row.personalized_conversions,
        cr: cr(row.personalized_conversions, row.personalized_visits),
      },
      holdout: {
        visits: row.holdout_visits,
        conversions: row.holdout_conversions,
        cr: cr(row.holdout_conversions, row.holdout_visits),
      },
      no_signal: {
        visits: row.passthrough_visits,
        conversions: row.passthrough_conversions,
        cr: cr(row.passthrough_conversions, row.passthrough_visits),
        // L2 Layer D: untagged visits the edge flagged as probable dark social.
        dark_social_probable: readNoSignalField(row.per_cohort, "dark_social_probable"),
        // Language gate: untagged because the page is in another language.
        language_mismatch: readNoSignalField(row.per_cohort, "language_mismatch"),
      },
      // Skipped: visits with a signal whose page was kept as built. Two
      // kinds since the late tag rule (docs/specs/late-tag.md): the page was
      // painted before our script ran (`lp_visits`), or anything else, a part
      // not found or an answer after the reveal cap (`other_visits`). Each
      // distinct; a visit with both is in both. Null on a row written before
      // the split. A cohort metric: in the lift a skipped visit the coin
      // assigned to treat counts in the treat arm (intent-to-treat).
      skipped: {
        visits: row.skipped_visits ?? 0,
        conversions: row.skipped_conversions ?? 0,
        cr: cr(row.skipped_conversions ?? 0, row.skipped_visits ?? 0),
        ...skippedSplit(cohortEntries),
      },
    },
    hero: {
      holdout_lift: {
        value: row.holdout_lift,
        ci_lower: row.holdout_lift_ci_lower,
        ci_upper: row.holdout_lift_ci_upper,
        significance: parseSignificance(row.holdout_significance),
      },
      natural_lift: {
        value: row.natural_lift,
        ci_lower: row.natural_lift_ci_lower,
        ci_upper: row.natural_lift_ci_upper,
        significance: parseSignificance(row.natural_significance),
      },
      total_visits: row.total_visits,
      total_conversions: row.conversions,
    },
    // A change only against a comparable period before with 30 visits (10
    // converting visits for conversions), docs/specs/results-data.md §2.
    delta: {
      vs_previous_period_visits_pct: previous
        ? changeOf(row.total_visits, previous.total_visits)
        : null,
      vs_previous_period_conversions_pct: previous
        ? changeOf(row.conversions, previous.total_conversions, MIN_CONVERSIONS)
        : null,
    },
    ...results,
    pending_versions: pendingVersions,
  };

  return jsonWithCors(overview, env, 200);
}

// ---------------------------------------------------------------------------
// GET /admin/analytics/breakdown
// ---------------------------------------------------------------------------

export async function handleAnalyticsBreakdown(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  const window = url.searchParams.get("window") ?? "7d";

  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) {
    return jsonWithCors({ error: scope.reason }, env, 403);
  }

  if (!customerId) {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }

  const row = await env.DB.prepare(
    `SELECT window, computed_at, total_visits, per_variant, per_intent, per_cohort,
            per_source, per_page, tagged
     FROM analytics_aggregates
     WHERE customer_id = ? AND window = ?
     ORDER BY window_start DESC
     LIMIT 1`,
  )
    .bind(customerId, window)
    .first<
      Pick<
        AggregatesRow,
        | "window"
        | "computed_at"
        | "total_visits"
        | "per_variant"
        | "per_intent"
        | "per_cohort"
        | "per_source"
        | "per_page"
        | "tagged"
      >
    >();

  if (!row) {
    return jsonWithCors({ empty: true }, env, 404);
  }

  // Drop the no-signal orphan row (intent_dim/source_dim both null) from the
  // variant performance breakdown. No-signal visitors saw the original page,
  // not a variant — they don't belong in the per-variant CR comparison.
  // They remain counted in: hero Visits card, Cohort breakdown table,
  // Intent breakdown chart (relabeled "Direct / Untagged" — see D3).
  const byTuple = (
    JSON.parse(row.per_variant) as Array<{
      intent_dim: string | null;
      source_dim: string | null;
    }>
  ).filter((r) => r.intent_dim !== null && r.source_dim !== null);
  const byIntent = JSON.parse(row.per_intent) as unknown[];

  const results = resultsBreakdown(row);
  // N4.1 (docs/specs/page-groups.md): the accepted groups and the proposals
  // on the pages block. The accepted list is read now, not at the hourly
  // run; a missing page_groups table is no groups and never fails the read.
  if (results.pages) {
    const groups = breakdownGroups(
      results.pages.groups,
      await acceptedGroupPatterns(env.DB, customerId),
    );
    const { groups: _stored, ...rest } = results.pages;
    results.pages = groups.length > 0 ? { ...rest, groups } : rest;
  }

  return jsonWithCors({ by_intent: byIntent, by_tuple: byTuple, ...results }, env, 200);
}

/**
 * The Results page's fields of the breakdown (docs/specs/results-data.md):
 * the period, visits per source with the period before, the Unknown row,
 * the lead sentence's gated claims and the pages; the names inside each
 * source (N1, 5 visits or more) and the visits on the customer's own tagged
 * links (N3), on rows written since migration 0035.
 */
function resultsBreakdown(
  row: Pick<
    AggregatesRow,
    "window" | "computed_at" | "total_visits" | "per_cohort" | "per_source" | "per_page" | "tagged"
  >,
): Partial<ResultsBreakdownFields> {
  const timing = periodOf(row);
  if (!timing) return {};
  const comparable = timing.comparison.comparable;
  const stored = parseJson<StoredSource[]>(row.per_source) ?? [];
  const bySource = (Array.isArray(stored) ? stored : []).map((s) =>
    sourceRow(comparable ? s : { ...s, prev_visits: null, prev_conversions: null }),
  );
  const cohorts = parseCohorts(row.per_cohort);
  const ns = cohorts.find((e) => e.cohort === "no_signal");
  // Distinct visits with a signal (since 2026-10-06); older rows sum the sources.
  const signal = cohorts.find((e) => e.cohort === "signal");
  const nsVisits = Number(ns?.visits) || 0;
  const nsConversions = Number(ns?.conversions) || 0;
  const nsPrev = comparable && typeof ns?.prev_visits === "number" ? ns.prev_visits : null;
  const nsPrevConv =
    comparable && typeof ns?.prev_conversions === "number" ? ns.prev_conversions : null;
  const unknown: UnknownRow = {
    visits: nsVisits,
    conversions: nsConversions,
    rate: rateOf(nsConversions, nsVisits),
    prev_visits: nsPrev,
    prev_conversions: nsPrevConv,
    visits_change: changeOf(nsVisits, nsPrev),
    dark_social_probable: Number(ns?.dark_social_probable) || 0,
  };
  const pages = parseJson<PagesBreakdown>(row.per_page);
  const tagged = taggedRow(parseJson<StoredTagged>(row.tagged), comparable);
  return {
    period: timing.period,
    comparison: timing.comparison,
    by_source: bySource,
    unknown,
    lead:
      typeof signal?.visits === "number"
        ? pickLead(bySource, unknown, row.total_visits, signal.visits)
        : pickLead(bySource, unknown, row.total_visits),
    pages: pages && Array.isArray(pages.pages) ? pages : null,
    ...(tagged ? { tagged } : {}),
  };
}

// ---------------------------------------------------------------------------
// GET /admin/analytics/timeseries
// ---------------------------------------------------------------------------

export async function handleAnalyticsTimeseries(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");

  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) {
    return jsonWithCors({ error: scope.reason }, env, 403);
  }

  if (!customerId) {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }

  const row = await env.DB.prepare(
    `SELECT time_series, computed_at FROM analytics_aggregates
     WHERE customer_id = ? AND window = '30d'
     ORDER BY window_start DESC
     LIMIT 1`,
  )
    .bind(customerId)
    .first<{ time_series: string | null; computed_at: number }>();

  if (!row) {
    return jsonWithCors({ empty: true }, env, 404);
  }

  const series = row.time_series ? (JSON.parse(row.time_series) as unknown[]) : [];

  return jsonWithCors({ customer_id: customerId, computed_at: row.computed_at, series }, env, 200);
}

/**
 * Pull a numeric field of the no_signal entry out of the per_cohort JSON blob
 * (written by the aggregator). 0 for aggregates computed before the field.
 */
function readNoSignalField(perCohort: string | null, field: string): number {
  if (!perCohort) return 0;
  try {
    const rows = JSON.parse(perCohort) as Array<Record<string, unknown> & { cohort: string }>;
    const ns = rows.find((r) => r.cohort === "no_signal");
    const v = ns?.[field];
    return typeof v === "number" ? v : 0;
  } catch {
    return 0;
  }
}
