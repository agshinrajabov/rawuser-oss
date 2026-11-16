/**
 * Unit tests for packages/generation/src/cron/analytics-aggregator.ts
 *
 * Coverage:
 *   - runAggregator produces 4 rows per customer (one per window)
 *   - NULL cohort treated as personalized (backward compat)
 *   - skipped cohort excluded from per_variant and per_intent
 *   - per_cohort JSON includes all 4 cohorts (including skipped)
 *   - holdout_lift populated when sample ≥ MIN_SAMPLE
 *   - natural_lift populated when sample ≥ MIN_SAMPLE
 *   - Idempotency: calling runAggregator twice writes the same row, not a new one
 *   - Zero events → all counters = 0, lift = null
 *   - runAggregatorForCustomer runs only the given customer
 *
 * D1 is mocked to avoid real SQLite dependency in unit tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAggregator, runAggregatorForCustomer } from "../../src/cron/analytics-aggregator.ts";

// ---------------------------------------------------------------------------
// D1 mock infrastructure
// ---------------------------------------------------------------------------

interface UpsertedRow {
  sql: string;
  binds: unknown[];
}

/** Tracks all INSERT OR REPLACE calls so tests can inspect what was written. */
let upsertedRows: UpsertedRow[] = [];
/** Controls what the aggregate query returns. */
let mockEventRows: unknown[] = [];
/** Controls what the grouped query returns for the period before (results-data §2). */
let mockPrevEventRows: unknown[] = [];
/** Controls what the per-page query returns (N4). */
let mockPageRows: unknown[] = [];
/** Pages with a confirmed manifest. */
let mockVersioned: { page_path: string }[] = [];
/** Controls what the customer list returns. */
let mockCustomers: { id: string }[] = [{ id: "customer-a" }];
/** Controls what the intent-to-treat arm query returns (proof engine). */
let mockArmRows: { arm: string; visits: number; conversions: number }[] = [];

interface Cell {
  cohort: string;
  intent_dim: string | null;
  source_dim: string | null;
  visits: number;
  conversions: number;
}

/**
 * The grouped query's levels from (cohort, intent, source) cells, in a world
 * where no visit crosses two cells (each cell holds its own visits), so a
 * group is the sum of its cells. The crossing visit is tested on real SQL in
 * results-data.test.ts.
 */
function groupsOf(cells: readonly Cell[]) {
  const SIGNAL = ["personalized", "holdout", "skipped"];
  const out = new Map<string, Record<string, unknown>>();
  const add = (
    level: string,
    key: { cohort?: string | null; intent_dim?: string | null; source_dim?: string | null },
    c: Cell,
  ) => {
    const row = { level, cohort: null, intent_dim: null, source_dim: null, ...key };
    const k = JSON.stringify(row);
    const e = out.get(k) ?? { ...row, visits: 0, conversions: 0 };
    e.visits = (e.visits as number) + c.visits;
    e.conversions = (e.conversions as number) + c.conversions;
    out.set(k, e);
  };
  for (const c of cells) {
    add("all", {}, c);
    add("cohort", { cohort: c.cohort }, c);
    if (SIGNAL.includes(c.cohort)) {
      add("signal", {}, c);
      if (c.source_dim) add("source", { source_dim: c.source_dim }, c);
    }
    if (c.cohort !== "skipped") {
      add("cell", { intent_dim: c.intent_dim, source_dim: c.source_dim }, c);
      add("intent", { intent_dim: c.intent_dim }, c);
    }
  }
  return [...out.values()];
}

function makeMockDb(): D1Database {
  return {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        _binds: [] as unknown[],
        bind(...args: unknown[]) {
          this._binds = [...args];
          return this;
        },
        async all<T>() {
          // Customer list query
          if (sql.includes("FROM customers")) {
            return { results: mockCustomers as T[], success: true };
          }
          // The arms, intent-to-treat (docs/specs/proof-engine.md, D)
          if (sql.includes("arm_totals")) {
            return { results: mockArmRows as T[], success: true };
          }
          // Per-day time_series query (30d only)
          if (sql.includes("date(datetime(ts")) {
            return { results: [] as T[], success: true };
          }
          if (sql.includes("/* per_page */")) {
            return { results: mockPageRows as T[], success: true };
          }
          if (sql.includes("/* versioned_pages */")) {
            return { results: mockVersioned as T[], success: true };
          }
          // The grouped query: the period ends now, the period before ends
          // one window earlier (at least an hour).
          if (sql.includes("/* visit_groups */")) {
            const end = this._binds[2] as number;
            const prev = end < Date.now() - 60_000;
            return {
              results: groupsOf((prev ? mockPrevEventRows : mockEventRows) as Cell[]) as T[],
              success: true,
            };
          }
          return { results: [] as T[], success: true };
        },
        async first<T>() {
          if (sql.includes("/* no_signal_flags */")) return { dark: 0, lang: 0 } as T;
          if (sql.includes("/* pages_without_versions */")) {
            return { pages: 0, visits: 0, signal_visits: 0 } as T;
          }
          return null as T;
        },
        async run() {
          if (sql.includes("INSERT OR REPLACE")) {
            upsertedRows.push({ sql, binds: [...this._binds] });
          }
          return { success: true, meta: {} };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    }),
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv() {
  return { DB: makeMockDb() };
}

beforeEach(() => {
  upsertedRows = [];
  mockEventRows = [];
  mockPrevEventRows = [];
  mockPageRows = [];
  mockVersioned = [];
  mockCustomers = [{ id: "customer-a" }];
  mockArmRows = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAggregator — basic structure", () => {
  it("writes 4 rows per customer (one per window)", async () => {
    await runAggregator(makeEnv());
    // 1 customer × 4 windows
    expect(upsertedRows).toHaveLength(4);
  });

  it("writes all 4 windows: 1h, 24h, 7d, 30d", async () => {
    await runAggregator(makeEnv());
    const windows = upsertedRows.map((r) => {
      // window is the 2nd bind parameter (index 1)
      return r.binds[1];
    });
    expect(windows).toContain("1h");
    expect(windows).toContain("24h");
    expect(windows).toContain("7d");
    expect(windows).toContain("30d");
  });

  it("returns aggregated=4 errors=0 for one customer", async () => {
    const result = await runAggregator(makeEnv());
    expect(result.aggregated).toBe(4);
    expect(result.errors).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("runAggregator — NULL cohort treated as personalized", () => {
  it("rows with cohort=null are counted as personalized", async () => {
    mockEventRows = [
      // Simulates COALESCE(cohort, 'personalized') returning 'personalized'
      // for a pre-Batch-C row
      {
        cohort: "personalized",
        intent_dim: "brand",
        source_dim: "direct",
        visits: 50,
        conversions: 5,
      },
    ];

    await runAggregator(makeEnv());

    // Find the 24h row (index 1 in 4 windows)
    const row24h = upsertedRows.find((r) => r.binds[1] === "24h");
    expect(row24h).toBeDefined();
    // personalized_visits is bind index 5 (0-indexed) per INSERT column order
    // total_visits=50, personalized_visits=50
    const binds = row24h?.binds;
    // binds: [customerId, window, windowStart, computedAt, totalVisits, personalizedVisits, ...]
    expect(binds[4]).toBe(50); // total_visits
    expect(binds[5]).toBe(50); // personalized_visits
  });
});

describe("runAggregator — skipped cohort exclusion", () => {
  it("skipped visits are counted but excluded from per_variant JSON", async () => {
    mockEventRows = [
      {
        cohort: "personalized",
        intent_dim: "brand",
        source_dim: "direct",
        visits: 80,
        conversions: 8,
      },
      {
        cohort: "skipped",
        intent_dim: "brand",
        source_dim: "direct",
        visits: 20,
        conversions: 2,
      },
    ];

    await runAggregator(makeEnv());
    // biome-ignore lint/style/noNonNullAssertion: row exists — find asserted by test context
    const row24h = upsertedRows.find((r) => r.binds[1] === "24h")!;
    const binds = row24h.binds;

    // skipped_visits = binds[7]
    expect(binds[7]).toBe(20);

    // per_variant = binds[16] — JSON string
    const perVariant = JSON.parse(binds[16] as string) as Array<{
      intent_dim: string;
      source_dim: string;
      visits: number;
    }>;
    // Only personalized row should be in per_variant, not skipped
    const total = perVariant.reduce((s, r) => s + r.visits, 0);
    expect(total).toBe(80);
  });

  it("per_cohort JSON includes all 4 cohorts including skipped", async () => {
    mockEventRows = [
      {
        cohort: "personalized",
        intent_dim: null,
        source_dim: null,
        visits: 50,
        conversions: 5,
      },
      {
        cohort: "skipped",
        intent_dim: null,
        source_dim: null,
        visits: 10,
        conversions: 1,
      },
    ];

    await runAggregator(makeEnv());
    // biome-ignore lint/style/noNonNullAssertion: row exists — find asserted by test context
    const row24h = upsertedRows.find((r) => r.binds[1] === "24h")!;
    const perCohort = JSON.parse(row24h.binds[18] as string) as Array<{
      cohort: string;
      visits: number;
    }>;

    const cohortNames = perCohort.map((c) => c.cohort);
    expect(cohortNames).toContain("personalized");
    expect(cohortNames).toContain("holdout");
    expect(cohortNames).toContain("skipped");
    expect(cohortNames).toContain("no_signal");
  });
});

describe("runAggregator — lift fields", () => {
  it("lift is null when cohorts below MIN_SAMPLE", async () => {
    mockEventRows = [
      {
        cohort: "personalized",
        intent_dim: null,
        source_dim: null,
        visits: 10,
        conversions: 1,
      },
      {
        cohort: "holdout",
        intent_dim: null,
        source_dim: null,
        visits: 5,
        conversions: 0,
      },
    ];

    await runAggregator(makeEnv());
    // biome-ignore lint/style/noNonNullAssertion: row exists — find asserted by test context
    const row24h = upsertedRows.find((r) => r.binds[1] === "24h")!;
    const binds = row24h.binds;

    // holdout_lift = binds[20]
    expect(binds[20]).toBeNull();
    // holdout_significance = binds[23]
    expect(binds[23]).toBe("not_yet");
  });

  it("holdout_lift is the treat arm against the holdout arm once each has 30 visits and 10 converting", async () => {
    // Cohort rows say one thing; the arms (intent-to-treat) decide the lift.
    mockEventRows = [
      { cohort: "personalized", intent_dim: null, source_dim: null, visits: 250, conversions: 55 },
      { cohort: "holdout", intent_dim: null, source_dim: null, visits: 100, conversions: 10 },
    ];
    mockArmRows = [
      { arm: "treat", visits: 300, conversions: 60 }, // 20%, skipped visits included
      { arm: "holdout", visits: 100, conversions: 10 }, // 10%
    ];

    await runAggregator(makeEnv());
    // biome-ignore lint/style/noNonNullAssertion: row exists — find asserted by test context
    const row24h = upsertedRows.find((r) => r.binds[1] === "24h")!;
    const binds = row24h.binds;

    // lift = (20% / 10%) - 1 = 1.0
    expect(binds[20] as number).toBeCloseTo(1.0, 5);
    // holdout_visits and holdout_conversions are the holdout arm
    expect(binds[6]).toBe(100);
    expect(binds[11]).toBe(10);
    // the treat arm rides in per_cohort
    const perCohort = JSON.parse(binds[18] as string) as Array<{ cohort: string; visits: number }>;
    expect(perCohort.find((c) => c.cohort === "treat_arm")?.visits).toBe(300);
  });

  it("holdout_lift stays null with 9 converting visits in an arm (MIN_CONVERSIONS)", async () => {
    mockArmRows = [
      { arm: "treat", visits: 300, conversions: 60 },
      { arm: "holdout", visits: 100, conversions: 9 },
    ];
    await runAggregator(makeEnv());
    // biome-ignore lint/style/noNonNullAssertion: the row exists, found above
    const row24h = upsertedRows.find((r) => r.binds[1] === "24h")!;
    expect(row24h.binds[20]).toBeNull();
    expect(row24h.binds[23]).toBe("not_yet");
  });

  it("natural_lift populated when no_signal has ≥ MIN_SAMPLE", async () => {
    mockEventRows = [
      {
        cohort: "personalized",
        intent_dim: null,
        source_dim: null,
        visits: 200,
        conversions: 40, // 20%
      },
      {
        cohort: "no_signal",
        intent_dim: null,
        source_dim: null,
        visits: 100,
        conversions: 10, // 10%
      },
    ];

    await runAggregator(makeEnv());
    // biome-ignore lint/style/noNonNullAssertion: row exists — find asserted by test context
    const row24h = upsertedRows.find((r) => r.binds[1] === "24h")!;
    const naturalLift = row24h.binds[24] as number;
    expect(naturalLift).not.toBeNull();
    // lift = (20% / 10%) - 1 = 1.0
    expect(naturalLift).toBeCloseTo(1.0, 1);
  });
});

describe("runAggregator — idempotency", () => {
  it("calling twice produces 8 rows total (INSERT OR REPLACE — same semantics per run)", async () => {
    // Each run writes 4 rows (1 per window). The DB would deduplicate via
    // UNIQUE INDEX in real SQLite. In mock, we just verify the mock sees
    // 8 INSERT calls (both runs each write 4). The real idempotency is
    // guaranteed by INSERT OR REPLACE in the SQL — not the mock layer.
    await runAggregator(makeEnv());
    await runAggregator(makeEnv());
    // 2 runs × 4 windows × 1 customer = 8 INSERT calls
    expect(upsertedRows).toHaveLength(8);
    // All rows use INSERT OR REPLACE (not INSERT INTO)
    for (const row of upsertedRows) {
      expect(row.sql).toContain("INSERT OR REPLACE");
    }
  });

  it("window_start is consistent across re-runs for the same window", async () => {
    await runAggregator(makeEnv());
    const first = upsertedRows.find((r) => r.binds[1] === "24h")?.binds[2] as number;

    upsertedRows = [];
    await runAggregator(makeEnv());
    const second = upsertedRows.find((r) => r.binds[1] === "24h")?.binds[2] as number;

    // Both runs happened within a few ms, so window_start should be the same
    // (floor(now / 24h) * 24h — only changes every 24h).
    expect(first).toBe(second);
  });
});

describe("runAggregator — zero events", () => {
  it("all counters = 0 when no events", async () => {
    mockEventRows = [];
    await runAggregator(makeEnv());
    // biome-ignore lint/style/noNonNullAssertion: row exists — find asserted by test context
    const row24h = upsertedRows.find((r) => r.binds[1] === "24h")!;
    const binds = row24h.binds;
    expect(binds[4]).toBe(0); // total_visits
    expect(binds[5]).toBe(0); // personalized_visits
    expect(binds[9]).toBe(0); // conversions
  });

  it("lift is null when no events", async () => {
    mockEventRows = [];
    await runAggregator(makeEnv());
    // biome-ignore lint/style/noNonNullAssertion: row exists — find asserted by test context
    const row24h = upsertedRows.find((r) => r.binds[1] === "24h")!;
    expect(row24h.binds[20]).toBeNull(); // holdout_lift
    expect(row24h.binds[24]).toBeNull(); // natural_lift
  });
});

describe("runAggregatorForCustomer", () => {
  it("only runs for the specified customer (4 windows)", async () => {
    mockCustomers = [{ id: "customer-a" }, { id: "customer-b" }];
    await runAggregatorForCustomer("customer-a", makeEnv());
    // Only 4 rows (not 8 for both customers)
    expect(upsertedRows).toHaveLength(4);
    // All rows are for customer-a
    for (const row of upsertedRows) {
      expect(row.binds[0]).toBe("customer-a");
    }
  });

  it("returns aggregated=4 for a single customer", async () => {
    const result = await runAggregatorForCustomer("customer-x", makeEnv());
    expect(result.aggregated).toBe(4);
    expect(result.errors).toBe(0);
  });
});

describe("runAggregator — visits, not rows (docs/specs/visit-marker.md)", () => {
  it("every visit and conversion count is DISTINCT over the visit marker, falling back to the row id", async () => {
    const env = makeEnv();
    await runAggregator(env);
    const sqls = (env.DB.prepare as unknown as { mock: { calls: string[][] } }).mock.calls.map(
      (c) => c[0] ?? "",
    );
    const counting = sqls.filter((s) => s.includes("FROM events") && s.includes("FILTER"));
    expect(counting.length).toBeGreaterThan(0);
    for (const s of counting) {
      expect(s).not.toMatch(/COUNT\(\*\) FILTER/);
      expect(s).toContain("COUNT(DISTINCT COALESCE(visit, id))");
    }
  });
});

describe("runAggregator — the Results page's columns (docs/specs/results-data.md)", () => {
  const cur = [
    { cohort: "personalized", intent_dim: "problem", source_dim: "ai", visits: 80, conversions: 8 },
    { cohort: "skipped", intent_dim: "problem", source_dim: "ai", visits: 20, conversions: 1 },
    {
      cohort: "personalized",
      intent_dim: "brand",
      source_dim: "organic",
      visits: 40,
      conversions: 2,
    },
    { cohort: "no_signal", intent_dim: null, source_dim: null, visits: 60, conversions: 3 },
  ];
  const prev = [
    { cohort: "personalized", intent_dim: "problem", source_dim: "ai", visits: 50, conversions: 4 },
    { cohort: "skipped", intent_dim: "problem", source_dim: "ai", visits: 10, conversions: 0 },
    { cohort: "no_signal", intent_dim: null, source_dim: null, visits: 70, conversions: 2 },
  ];

  it("per_source (bind 28) counts skipped visits in their source, with the period before", async () => {
    mockEventRows = cur;
    mockPrevEventRows = prev;
    await runAggregator(makeEnv());
    // biome-ignore lint/style/noNonNullAssertion: the row exists, found above
    const row7d = upsertedRows.find((r) => r.binds[1] === "7d")!;
    expect(JSON.parse(row7d.binds[28] as string)).toEqual([
      {
        source_dim: "ai",
        visits: 100,
        conversions: 9,
        prev_visits: 60,
        prev_conversions: 4,
        names: [],
      },
      {
        source_dim: "organic",
        visits: 40,
        conversions: 2,
        prev_visits: 0,
        prev_conversions: 0,
        names: [],
      },
    ]);
    // prev_total_visits (bind 14) counts every cohort, the skipped one too
    expect(row7d.binds[14]).toBe(130);
    expect(row7d.binds[15]).toBe(6);
  });

  it("the 30-day row has no period before: one grouped query, prev 0, prev_* null", async () => {
    mockEventRows = cur;
    mockPrevEventRows = prev;
    const env = makeEnv();
    await runAggregator(env);
    // biome-ignore lint/style/noNonNullAssertion: the row exists, found above
    const row30d = upsertedRows.find((r) => r.binds[1] === "30d")!;
    expect(row30d.binds[14]).toBe(0);
    expect(JSON.parse(row30d.binds[28] as string)[0].prev_visits).toBeNull();
    const grouped = (
      env.DB.prepare as unknown as { mock: { calls: string[][] } }
    ).mock.calls.filter((c) => (c[0] ?? "").includes("/* visit_groups */"));
    // 1h, 24h, 7d: two each; 30d: one
    expect(grouped).toHaveLength(7);
  });

  it("per_page (bind 29) marks pages with a confirmed manifest", async () => {
    mockPageRows = [
      { page_path: "/docs", visits: 30, signal_visits: 20, written_visits: 0, skipped_visits: 20 },
      { page_path: "/", visits: 90, signal_visits: 10, written_visits: 10, skipped_visits: 0 },
    ];
    mockVersioned = [{ page_path: "/" }];
    await runAggregator(makeEnv());
    // biome-ignore lint/style/noNonNullAssertion: the row exists, found above
    const row24h = upsertedRows.find((r) => r.binds[1] === "24h")!;
    const perPage = JSON.parse(row24h.binds[29] as string);
    expect(
      perPage.pages.map((p: { page_path: string; has_versions: boolean }) => [
        p.page_path,
        p.has_versions,
      ]),
    ).toEqual([
      ["/docs", false],
      ["/", true],
    ]);
    expect(perPage.without_versions).toEqual({ pages: 0, visits: 0, signal_visits: 0 });
  });
});
