/**
 * Tests for /admin/analytics/* endpoints.
 *
 * Coverage:
 *   - Scope enforcement: customer-role blocked from another customer's data (403)
 *   - Scope enforcement: customer-role can read own data (200)
 *   - Superadmin can read any customer's data
 *   - 404 {empty: true} when no aggregate rows exist yet
 *   - Overview response shape: cohorts, hero, delta
 *   - Breakdown response shape: by_intent, by_tuple
 *   - Timeseries response shape: series array
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "../model-env.ts";

// ---------------------------------------------------------------------------
// Auth mock: customizable per test
// ---------------------------------------------------------------------------

const mockSuperadmin = {
  id: "u-admin",
  email: "admin@rawuser.example",
  role: "superadmin" as const,
  customer_id: null as string | null,
};

const mockCustomerA = {
  id: "u-cust-a",
  email: "a@customer.example",
  role: "customer" as const,
  customer_id: "customer-a",
};

let activeUser: typeof mockSuperadmin | typeof mockCustomerA = mockSuperadmin;

vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => activeUser),
}));

vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(async () => ({ customer_id: "x", generated: 0, errors: 0 })),
  regenerateOne: vi.fn(async () => ({ ok: true })),
}));

const { default: worker } = await import("../../src/index.ts");

// ---------------------------------------------------------------------------
// D1 mock factory
// ---------------------------------------------------------------------------

/** Controls what analytics_aggregates queries return. */
let aggRow: Record<string, unknown> | null = null;

function makeMockDb(): D1Database {
  return {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        _binds: [] as unknown[],
        bind(...args: unknown[]) {
          this._binds = [...args];
          return this;
        },
        async first<T>() {
          if (sql.includes("analytics_aggregates")) {
            return aggRow as T;
          }
          // Session lookup
          if (sql.includes("superadmin_sessions")) {
            return {
              id: activeUser.id,
              email: activeUser.email,
              role: activeUser.role,
              customer_id: activeUser.customer_id ?? null,
            } as T;
          }
          return null as T;
        },
        async all<T>() {
          return { results: [] as T[], success: true };
        },
        async run() {
          return { success: true, meta: {} };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    }),
  } as unknown as D1Database;
}

function makeEnv() {
  return {
    ...MODEL_ENV,
    VARIANTS: {} as KVNamespace,
    DB: makeMockDb(),
    ENVIRONMENT: "test",
    DASHBOARD_ORIGIN: "*",
  };
}

function req(path: string, token = "tok"): Request {
  return new Request(`https://generation.rawuser.test${path}`, {
    method: "GET",
    headers: { "X-Rawuser-Admin": token },
  });
}

// ---------------------------------------------------------------------------
// Shared aggregate fixture
// ---------------------------------------------------------------------------

const FIXTURE_AGG_ROW = {
  customer_id: "customer-a",
  window: "24h",
  window_start: 1_700_000_000_000,
  computed_at: 1_700_086_400_000,
  total_visits: 1000,
  personalized_visits: 800,
  holdout_visits: 100,
  skipped_visits: 50,
  passthrough_visits: 50,
  conversions: 60,
  personalized_conversions: 50,
  holdout_conversions: 5,
  skipped_conversions: 2,
  passthrough_conversions: 3,
  prev_total_visits: 900,
  prev_conversions: 50,
  per_variant: JSON.stringify([
    { intent_dim: "brand", source_dim: "direct", visits: 400, conversions: 30 },
  ]),
  per_intent: JSON.stringify([{ intent_dim: "brand", visits: 400, conversions: 30 }]),
  // prev_* since 2026-10-04 (docs/specs/results-data.md §2): 900 visits and
  // 50 converting visits in the period before, like-for-like.
  per_cohort: JSON.stringify([
    {
      cohort: "personalized",
      visits: 800,
      conversions: 50,
      conversion_rate: 0.0625,
      prev_visits: 700,
      prev_conversions: 40,
    },
    {
      cohort: "holdout",
      visits: 100,
      conversions: 5,
      conversion_rate: 0.05,
      prev_visits: 100,
      prev_conversions: 5,
    },
    {
      cohort: "skipped",
      visits: 50,
      conversions: 2,
      conversion_rate: 0.04,
      prev_visits: 50,
      prev_conversions: 2,
    },
    {
      cohort: "no_signal",
      visits: 50,
      conversions: 3,
      conversion_rate: 0.06,
      prev_visits: 50,
      prev_conversions: 3,
      dark_social_probable: 12,
    },
  ]),
  time_series: JSON.stringify([
    { date: "2026-05-30", visits: 500, conversions: 30 },
    { date: "2026-05-31", visits: 500, conversions: 30 },
  ]),
  holdout_lift: 0.25,
  holdout_lift_ci_lower: 0.05,
  holdout_lift_ci_upper: 0.48,
  holdout_significance: "sig_95",
  natural_lift: 0.5,
  natural_lift_ci_lower: 0.1,
  natural_lift_ci_upper: 0.9,
  natural_significance: "sig_90",
};

// ---------------------------------------------------------------------------
// Scope enforcement
// ---------------------------------------------------------------------------

describe("/admin/analytics/overview: scope enforcement", () => {
  beforeEach(() => {
    aggRow = FIXTURE_AGG_ROW;
  });

  it("customer-role blocked from another customer's data (403)", async () => {
    activeUser = mockCustomerA;
    const resp = await worker.fetch(
      req("/admin/analytics/overview?customer_id=customer-b"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(403);
  });

  it("customer-role can read own data (200)", async () => {
    activeUser = mockCustomerA;
    const resp = await worker.fetch(
      req("/admin/analytics/overview?customer_id=customer-a"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
  });

  it("superadmin can read any customer (200)", async () => {
    activeUser = mockSuperadmin;
    const resp = await worker.fetch(
      req("/admin/analytics/overview?customer_id=customer-a"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
  });
});

describe("/admin/analytics/overview: 404 when no rows", () => {
  it("returns {empty: true} with 404 when aggregator hasn't run", async () => {
    activeUser = mockSuperadmin;
    aggRow = null;
    const resp = await worker.fetch(
      req("/admin/analytics/overview?customer_id=customer-a"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { empty: boolean };
    expect(body.empty).toBe(true);
  });
});

describe("/admin/analytics/overview: response shape", () => {
  beforeEach(() => {
    activeUser = mockSuperadmin;
    aggRow = FIXTURE_AGG_ROW;
  });

  it("returns cohorts object with personalized, holdout, no_signal", async () => {
    const resp = await worker.fetch(
      req("/admin/analytics/overview?customer_id=customer-a&window=24h"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      cohorts: { personalized: unknown; holdout: unknown; no_signal: unknown };
    };
    expect(body.cohorts).toHaveProperty("personalized");
    expect(body.cohorts).toHaveProperty("holdout");
    expect(body.cohorts).toHaveProperty("no_signal");
  });

  it("hero has holdout_lift with value and significance", async () => {
    const resp = await worker.fetch(
      req("/admin/analytics/overview?customer_id=customer-a&window=24h"),
      makeEnv(),
      {} as ExecutionContext,
    );
    const body = (await resp.json()) as {
      hero: {
        holdout_lift: { value: number; significance: string };
        total_visits: number;
      };
    };
    expect(body.hero.holdout_lift.value).toBe(0.25);
    expect(body.hero.holdout_lift.significance).toBe("sig_95");
    expect(body.hero.total_visits).toBe(1000);
  });

  it("delta includes vs_previous_period_visits_pct", async () => {
    const resp = await worker.fetch(
      req("/admin/analytics/overview?customer_id=customer-a&window=24h"),
      makeEnv(),
      {} as ExecutionContext,
    );
    const body = (await resp.json()) as {
      delta: { vs_previous_period_visits_pct: number };
    };
    // (1000 - 900) / 900 ≈ 0.111
    expect(body.delta.vs_previous_period_visits_pct).toBeCloseTo(0.111, 2);
  });
});

describe("/admin/analytics/breakdown: response shape", () => {
  beforeEach(() => {
    activeUser = mockSuperadmin;
    aggRow = FIXTURE_AGG_ROW;
  });

  it("returns by_intent and by_tuple arrays", async () => {
    const resp = await worker.fetch(
      req("/admin/analytics/breakdown?customer_id=customer-a&window=7d"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { by_intent: unknown[]; by_tuple: unknown[] };
    expect(Array.isArray(body.by_intent)).toBe(true);
    expect(Array.isArray(body.by_tuple)).toBe(true);
  });

  it("404 when no aggregate row", async () => {
    aggRow = null;
    const resp = await worker.fetch(
      req("/admin/analytics/breakdown?customer_id=customer-a"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(404);
  });
});

describe("/admin/analytics/timeseries: response shape", () => {
  beforeEach(() => {
    activeUser = mockSuperadmin;
    aggRow = FIXTURE_AGG_ROW;
  });

  it("returns series array", async () => {
    const resp = await worker.fetch(
      req("/admin/analytics/timeseries?customer_id=customer-a"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { series: unknown[] };
    expect(Array.isArray(body.series)).toBe(true);
  });

  it("404 when no 30d row", async () => {
    aggRow = null;
    const resp = await worker.fetch(
      req("/admin/analytics/timeseries?customer_id=customer-a"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The Results page's reads (docs/specs/results-data.md)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

const RESULTS_ROW = {
  ...FIXTURE_AGG_ROW,
  per_source: JSON.stringify([
    { source_dim: "organic", visits: 400, conversions: 30, prev_visits: 360, prev_conversions: 25 },
    { source_dim: "ai", visits: 150, conversions: 20, prev_visits: 100, prev_conversions: 8 },
    { source_dim: "social", visits: 400, conversions: 7, prev_visits: 20, prev_conversions: 1 },
  ]),
  per_page: JSON.stringify({
    pages: [
      {
        page_path: "/docs",
        visits: 120,
        signal_visits: 90,
        written_visits: 10,
        skipped_visits: 80,
        has_versions: false,
      },
      {
        page_path: "/",
        visits: 700,
        signal_visits: 600,
        written_visits: 560,
        skipped_visits: 5,
        has_versions: true,
      },
    ],
    without_versions: { pages: 3, visits: 140, signal_visits: 100 },
  }),
};

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const resp = await worker.fetch(req(path), makeEnv(), {} as ExecutionContext);
  return { status: resp.status, body: (await resp.json()) as T };
}

describe("/admin/analytics/overview: the period and the period before", () => {
  beforeEach(() => {
    activeUser = mockSuperadmin;
    aggRow = RESULTS_ROW;
  });

  it("says which period it counts and compares it like-for-like", async () => {
    const { body } = await getJson<{
      period: { start: number; end: number };
      comparison: { previous: { start: number; end: number }; comparable: boolean };
      previous: Record<string, number> | null;
      delta: { vs_previous_period_conversions_pct: number | null };
    }>("/admin/analytics/overview?customer_id=customer-a&window=24h");
    const end = FIXTURE_AGG_ROW.computed_at;
    expect(body.period).toEqual({ start: end - DAY_MS, end });
    expect(body.comparison).toEqual({
      previous: { start: end - 2 * DAY_MS, end: end - DAY_MS },
      comparable: true,
    });
    expect(body.previous).toEqual({
      total_visits: 900,
      total_conversions: 50,
      signal_visits: 850,
      signal_conversions: 47,
      no_signal_visits: 50,
      no_signal_conversions: 3,
    });
    // (60 - 50) / 50
    expect(body.delta.vs_previous_period_conversions_pct).toBeCloseTo(0.2, 5);
  });

  it("the 30-day window has no comparison: its period before has lost the visit marker", async () => {
    aggRow = { ...RESULTS_ROW, window: "30d" };
    const { body } = await getJson<{
      comparison: { comparable: boolean };
      previous: unknown;
      delta: { vs_previous_period_visits_pct: number | null };
    }>("/admin/analytics/overview?customer_id=customer-a&window=30d");
    expect(body.comparison.comparable).toBe(false);
    expect(body.previous).toBeNull();
    expect(body.delta.vs_previous_period_visits_pct).toBeNull();
  });

  it("a row from before the change (no prev per cohort) shows no change rather than a skewed one", async () => {
    aggRow = {
      ...RESULTS_ROW,
      per_cohort: JSON.stringify([{ cohort: "personalized", visits: 800, conversions: 50 }]),
    };
    const { body } = await getJson<{ previous: unknown; delta: Record<string, unknown> }>(
      "/admin/analytics/overview?customer_id=customer-a&window=24h",
    );
    expect(body.previous).toBeNull();
    expect(body.delta).toEqual({
      vs_previous_period_visits_pct: null,
      vs_previous_period_conversions_pct: null,
    });
  });

  it("a change needs 30 visits before", async () => {
    aggRow = {
      ...RESULTS_ROW,
      total_visits: 60,
      per_cohort: JSON.stringify(
        ["personalized", "holdout", "skipped", "no_signal"].map((cohort) => ({
          cohort,
          visits: 15,
          conversions: 1,
          prev_visits: cohort === "personalized" ? 29 : 0,
          prev_conversions: 0,
        })),
      ),
    };
    const { body } = await getJson<{ delta: { vs_previous_period_visits_pct: number | null } }>(
      "/admin/analytics/overview?customer_id=customer-a&window=24h",
    );
    expect(body.delta.vs_previous_period_visits_pct).toBeNull();
  });
});

describe("/admin/analytics/breakdown: sources, Unknown, lead and pages", () => {
  beforeEach(() => {
    activeUser = mockSuperadmin;
    aggRow = RESULTS_ROW;
  });

  it("by_source carries the rate and a gated change per row", async () => {
    const { body } = await getJson<{
      by_source: Array<Record<string, unknown>>;
    }>("/admin/analytics/breakdown?customer_id=customer-a&window=24h");
    expect(body.by_source).toEqual([
      {
        source_dim: "organic",
        visits: 400,
        conversions: 30,
        rate: 0.075,
        prev_visits: 360,
        prev_conversions: 25,
        visits_change: (400 - 360) / 360,
      },
      {
        source_dim: "ai",
        visits: 150,
        conversions: 20,
        rate: 20 / 150,
        prev_visits: 100,
        prev_conversions: 8,
        visits_change: 0.5,
      },
      // 20 visits before: no change, never "+1900%"
      {
        source_dim: "social",
        visits: 400,
        conversions: 7,
        rate: 7 / 400,
        prev_visits: 20,
        prev_conversions: 1,
        visits_change: null,
      },
    ]);
    // N1 is not built: no names on any row
    for (const r of body.by_source) expect(r).not.toHaveProperty("names");
  });

  it("the Unknown row, the lead and the pages; N3 absent", async () => {
    const { body } = await getJson<Record<string, unknown>>(
      "/admin/analytics/breakdown?customer_id=customer-a&window=24h",
    );
    expect(body.unknown).toEqual({
      visits: 50,
      conversions: 3,
      rate: 0.06,
      prev_visits: 50,
      prev_conversions: 3,
      visits_change: 0,
      dark_social_probable: 12,
    });
    expect(body.lead).toMatchObject({
      signal_visits: 950,
      total_visits: 1000,
      grower: { source_dim: "ai", visits_change: 0.5 },
    });
    // ai 13.3% (Wilson low about 8.8%) is above organic's 7.5%
    expect(
      (body.lead as { top_rate: { group: string; next_group: string } }).top_rate,
    ).toMatchObject({ group: "ai", next_group: "organic" });
    expect((body.pages as { without_versions: unknown }).without_versions).toEqual({
      pages: 3,
      visits: 140,
      signal_visits: 100,
    });
    expect(body).not.toHaveProperty("tagged");
  });

  it("on the 30-day window the rows carry no period before", async () => {
    aggRow = { ...RESULTS_ROW, window: "30d" };
    const { body } = await getJson<{
      by_source: Array<{ prev_visits: number | null; visits_change: number | null }>;
      unknown: { prev_visits: number | null; visits_change: number | null };
      lead: { grower: unknown };
    }>("/admin/analytics/breakdown?customer_id=customer-a&window=30d");
    for (const r of [...body.by_source, body.unknown]) {
      expect(r.prev_visits).toBeNull();
      expect(r.visits_change).toBeNull();
    }
    expect(body.lead.grower).toBeNull();
  });

  it("a row from before migration 0034: empty sources, no pages", async () => {
    aggRow = { ...FIXTURE_AGG_ROW, per_source: null, per_page: null };
    const { body } = await getJson<{ by_source: unknown[]; pages: unknown; by_tuple: unknown[] }>(
      "/admin/analytics/breakdown?customer_id=customer-a&window=24h",
    );
    expect(body.by_source).toEqual([]);
    expect(body.pages).toBeNull();
    expect(body.by_tuple).toHaveLength(1);
  });
});
