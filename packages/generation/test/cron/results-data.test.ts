/**
 * The Results page's reads, on real SQL (node:sqlite, every migration):
 * the exact period, the period before like-for-like, the 30-day window
 * without a comparison, per_source, per_page and the visit counts of the
 * no-signal flags (docs/specs/results-data.md). Then the endpoints read what
 * the aggregator wrote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAnalyticsBreakdown, handleAnalyticsOverview } from "../../src/admin/analytics.ts";
import type { AdminEnv } from "../../src/admin/handlers.ts";
import { aggregateWindow, aggregateWindowAt } from "../../src/cron/analytics-aggregator.ts";
import { dayOf, dayStart, rebuildDay } from "../../src/cron/exposure-rollup.ts";
import { DAY, HOUR, type Harness, harness, vid } from "../proof-harness.ts";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const W7 = 7 * DAY;
const W30 = 30 * DAY;

let h: Harness;
let n = 0;
beforeEach(() => {
  h = harness();
  h.customer("acme");
  h.customer("other");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  n = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A visit: one or more page views, optionally a conversion. */
function visit(
  ts: number,
  o: {
    cohort?: "personalized" | "holdout" | "skipped" | "no_signal";
    source?: string | null;
    pages?: string[];
    converts?: boolean;
    marker?: boolean;
    customer?: string;
  } = {},
): void {
  const id = ++n;
  const cohort = o.cohort ?? "personalized";
  const type =
    cohort === "no_signal"
      ? "no_signal_passthrough"
      : cohort === "skipped"
        ? "personalization_skipped"
        : "variant_shown";
  const source = cohort === "no_signal" ? null : (o.source ?? "ai");
  const marker = o.marker === false ? null : vid(id);
  for (const [i, page] of (o.pages ?? ["/"]).entries()) {
    h.ev({ ts: ts + i * 1000, type, visit: marker, cohort, source, page, customer: o.customer });
  }
  if (o.converts) {
    h.ev({
      ts: ts + 30_000,
      type: "conversion",
      visit: marker,
      cohort,
      source,
      customer: o.customer,
    });
  }
}

function row(window: string): Record<string, unknown> {
  return h.db
    .prepare(
      "SELECT * FROM analytics_aggregates WHERE customer_id = 'acme' AND window = ? ORDER BY computed_at DESC LIMIT 1",
    )
    .get(window) as Record<string, unknown>;
}

function confirm(page: string, confirmed = true): void {
  h.db
    .prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at) VALUES ('acme', ?, '{}', 'https://acme.test', 1, ?)",
    )
    .run(page, confirmed ? 1 : null);
}

describe("the period is the period it says", () => {
  it("the 7-day row counts (now - 7d, now], not from the aligned bucket", async () => {
    visit(NOW - W7 + HOUR); // inside
    visit(NOW - W7 - HOUR); // outside: the old bucket start counted it
    await aggregateWindow("acme", "7d", W7, h.env);
    const r = row("7d");
    expect(r.total_visits).toBe(1);
    // the key is still the aligned bucket (one row per bucket on re-runs)
    expect(r.window_start).toBe(Math.floor((NOW - W7) / W7) * W7);
    // and the one outside is in the period before
    expect(r.prev_total_visits).toBe(1);
  });

  it("the period before counts the skipped cohort, like total_visits", async () => {
    visit(NOW - HOUR, { cohort: "personalized" });
    visit(NOW - HOUR, { cohort: "skipped" });
    visit(NOW - W7 - DAY, { cohort: "personalized", converts: true });
    visit(NOW - W7 - DAY, { cohort: "skipped", converts: true });
    visit(NOW - W7 - DAY, { cohort: "no_signal" });
    await aggregateWindow("acme", "7d", W7, h.env);
    const r = row("7d");
    expect(r.total_visits).toBe(2);
    expect(r.prev_total_visits).toBe(3);
    expect(r.prev_conversions).toBe(2);
    const cohorts = JSON.parse(String(r.per_cohort)) as Array<Record<string, unknown>>;
    expect(cohorts.find((c) => c.cohort === "skipped")).toMatchObject({
      visits: 1,
      prev_visits: 1,
      prev_conversions: 1,
    });
    expect(cohorts.find((c) => c.cohort === "no_signal")).toMatchObject({ prev_visits: 1 });
  });

  it("the 30-day window stores no period before: its rows have lost the marker", async () => {
    visit(NOW - DAY);
    visit(NOW - W30 - 10 * DAY, { marker: false });
    visit(NOW - W30 - 10 * DAY, { marker: false });
    await aggregateWindow("acme", "30d", W30, h.env);
    const r = row("30d");
    expect(r.total_visits).toBe(1);
    expect(r.prev_total_visits).toBe(0);
    const cohorts = JSON.parse(String(r.per_cohort)) as Array<Record<string, unknown>>;
    expect(cohorts.find((c) => c.cohort === "personalized")?.prev_visits).toBeNull();
    expect(JSON.parse(String(r.per_source))).toEqual([
      {
        source_dim: "ai",
        visits: 1,
        conversions: 0,
        prev_visits: null,
        prev_conversions: null,
        names: [],
      },
    ]);
  });

  it("the 30-day series counts every cohort, so the days add up to the total", async () => {
    visit(NOW - 2 * DAY, { cohort: "personalized" });
    visit(NOW - 2 * DAY, { cohort: "skipped" });
    visit(NOW - DAY, { cohort: "no_signal" });
    await aggregateWindow("acme", "30d", W30, h.env);
    const r = row("30d");
    const series = JSON.parse(String(r.time_series)) as Array<{ visits: number }>;
    expect(series.reduce((s, d) => s + d.visits, 0)).toBe(r.total_visits);
    expect(r.total_visits).toBe(3);
  });
});

describe("per_source (N2)", () => {
  it("visits with a signal per source, skipped and holdout in, Unknown out, pages of a visit collapsed", async () => {
    visit(NOW - HOUR, { source: "ai", pages: ["/", "/pricing"], converts: true });
    visit(NOW - HOUR, { source: "ai", cohort: "holdout" });
    visit(NOW - HOUR, { source: "ai", cohort: "skipped" });
    visit(NOW - HOUR, { source: "organic" });
    visit(NOW - HOUR, { cohort: "no_signal", converts: true });
    // the period before
    visit(NOW - W7 - HOUR, { source: "ai" });
    visit(NOW - W7 - HOUR, { source: "community", converts: true });
    // another customer never counts
    visit(NOW - HOUR, { source: "ai", customer: "other" });
    await aggregateWindow("acme", "7d", W7, h.env);
    expect(JSON.parse(String(row("7d").per_source))).toEqual([
      {
        source_dim: "ai",
        visits: 3,
        conversions: 1,
        prev_visits: 1,
        prev_conversions: 0,
        names: [],
      },
      {
        source_dim: "organic",
        visits: 1,
        conversions: 0,
        prev_visits: 0,
        prev_conversions: 0,
        names: [],
      },
      {
        source_dim: "community",
        visits: 0,
        conversions: 0,
        prev_visits: 1,
        prev_conversions: 1,
        names: [],
      },
    ]);
  });
});

describe("per_page (N4)", () => {
  it("pages normalized, versions from the confirmed manifests, the floor, distinct visits across pages without versions", async () => {
    confirm("/");
    confirm("/pricing", false); // detected, never confirmed: no versions
    for (let i = 0; i < 6; i++) visit(NOW - HOUR, { pages: ["/"] });
    // /docs: 5 visits with a signal (mixed spelling), kept as built; one also on /pricing
    for (let i = 0; i < 4; i++) visit(NOW - HOUR, { cohort: "skipped", pages: ["/Docs/"] });
    visit(NOW - HOUR, { cohort: "skipped", pages: ["/docs", "/pricing"] });
    // /pricing: 5 visits in all
    for (let i = 0; i < 4; i++) visit(NOW - HOUR, { cohort: "no_signal", pages: ["/pricing"] });
    // /blog/one-off: 2 visits, under the floor
    for (let i = 0; i < 2; i++) visit(NOW - HOUR, { pages: ["/blog/one-off"] });
    await aggregateWindow("acme", "7d", W7, h.env);
    const perPage = JSON.parse(String(row("7d").per_page));
    expect(perPage.pages).toEqual([
      {
        page_path: "/",
        visits: 6,
        signal_visits: 6,
        written_visits: 6,
        skipped_visits: 0,
        lp_visits: 0,
        has_versions: true,
      },
      {
        page_path: "/docs",
        visits: 5,
        signal_visits: 5,
        written_visits: 0,
        skipped_visits: 5,
        lp_visits: 0,
        has_versions: false,
      },
      {
        page_path: "/pricing",
        visits: 5,
        signal_visits: 1,
        written_visits: 0,
        skipped_visits: 1,
        lp_visits: 0,
        has_versions: false,
      },
    ]);
    // /docs, /pricing, /blog/one-off; the visit on /docs and /pricing once
    expect(perPage.without_versions).toEqual({ pages: 3, visits: 11, signal_visits: 7 });
  });
});

describe("per_page never stores an identifier (docs/specs/event-paths.md)", () => {
  it("a row stored before the edge masked is folded into :id", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    for (let i = 0; i < 5; i++) {
      visit(NOW - HOUR, { cohort: "no_signal", pages: [`/admin/students/${uuid}`] });
    }
    await aggregateWindow("acme", "7d", W7, h.env);
    const raw = String(row("7d").per_page);
    expect(raw).not.toContain("550e8400");
    expect(JSON.parse(raw).pages.map((p: { page_path: string }) => p.page_path)).toEqual([
      "/admin/students/:id",
    ]);
  });
});

describe("the no-signal flags count visits, not rows", () => {
  it("a dark-social visit of two pages is one", async () => {
    const marker = vid(9000);
    for (const page of ["/", "/about"]) {
      h.db
        .prepare(
          `INSERT INTO events (id, customer_id, ts, event_type, page_path, cohort, visit, dark_social)
           VALUES (?, 'acme', ?, 'no_signal_passthrough', ?, 'no_signal', ?, 1)`,
        )
        .run(`dark_${page}`, NOW - HOUR, page, marker);
    }
    await aggregateWindow("acme", "7d", W7, h.env);
    const cohorts = JSON.parse(String(row("7d").per_cohort)) as Array<Record<string, unknown>>;
    expect(cohorts.find((c) => c.cohort === "no_signal")).toMatchObject({
      visits: 1,
      dark_social_probable: 1,
    });
  });
});

describe("the endpoints read what the aggregator wrote", () => {
  const superadmin = { id: "u", email: "a@rawuser.example", role: "superadmin", customer_id: null };
  const env = () => ({ ...h.env, DASHBOARD_ORIGIN: "*" }) as unknown as AdminEnv;
  const get = (path: string) =>
    new Request(`https://generation.rawuser.test${path}`, { method: "GET" });

  it("overview and breakdown on one real row", async () => {
    confirm("/");
    for (let i = 0; i < 40; i++) visit(NOW - HOUR, { source: "ai", converts: i < 12 });
    for (let i = 0; i < 40; i++) visit(NOW - W7 - HOUR, { source: "ai" });
    for (let i = 0; i < 30; i++) visit(NOW - HOUR, { cohort: "no_signal", pages: ["/docs"] });
    await aggregateWindow("acme", "7d", W7, h.env);

    const ov = (await (
      await handleAnalyticsOverview(get("/x?customer_id=acme&window=7d"), env(), superadmin)
    ).json()) as Record<string, unknown>;
    expect(ov.period).toEqual({ start: NOW - W7, end: NOW });
    expect(ov.delta).toEqual({
      vs_previous_period_visits_pct: (70 - 40) / 40,
      vs_previous_period_conversions_pct: null, // 0 converting visits before
    });

    const bd = (await (
      await handleAnalyticsBreakdown(get("/x?customer_id=acme&window=7d"), env(), superadmin)
    ).json()) as Record<string, unknown>;
    expect(bd.by_source).toEqual([
      {
        source_dim: "ai",
        visits: 40,
        conversions: 12,
        rate: 0.3,
        prev_visits: 40,
        prev_conversions: 0,
        visits_change: 0,
        names: [],
      },
    ]);
    expect(bd.unknown).toMatchObject({ visits: 30, prev_visits: 0, visits_change: null });
    // ai 30% (Wilson low about 18%) above Unknown's 0%
    expect(bd.lead).toMatchObject({
      signal_visits: 40,
      total_visits: 70,
      grower: null,
      top_rate: { group: "ai", next_group: "unknown" },
    });
    expect(
      (bd.pages as { pages: Array<{ page_path: string }> }).pages.map((p) => p.page_path),
    ).toEqual(["/", "/docs"]);
  });
});

// ---------------------------------------------------------------------------
// One visit across two cells counts once (2026-10-06)
// ---------------------------------------------------------------------------

/**
 * A ChatGPT visit to `/` (problem:ai), then `/pricing` (pricing:ai, the
 * carried source since edge f3152325); the conversion on /pricing.
 */
function crossing(ts: number, i: number, o: { converts?: boolean; second?: string } = {}): void {
  const marker = vid(50_000 + i);
  h.ev({ ts, type: "variant_shown", visit: marker, cohort: "personalized", intent: "problem" });
  h.ev({
    ts: ts + 1000,
    type: o.second === "skipped" ? "personalization_skipped" : "variant_shown",
    visit: marker,
    cohort: o.second ?? "personalized",
    intent: "pricing",
    page: "/pricing",
  });
  if (o.converts) {
    h.ev({
      ts: ts + 2000,
      type: "conversion",
      visit: marker,
      cohort: "personalized",
      intent: "pricing",
      page: "/pricing",
    });
  }
}

describe("one visit across two cells counts once (2026-10-06)", () => {
  type Entry = Record<string, unknown>;
  const cohortOf = (r: Record<string, unknown>, c: string) =>
    (JSON.parse(String(r.per_cohort)) as Entry[]).find((e) => e.cohort === c);

  it("is one personalized visit, one ai visit and one in the total; each cell keeps it", async () => {
    crossing(NOW - HOUR, 1, { converts: true });
    crossing(NOW - W7 - HOUR, 2);
    await aggregateWindow("acme", "7d", W7, h.env);
    const r = row("7d");
    expect(r.total_visits).toBe(1);
    expect(r.personalized_visits).toBe(1);
    expect(r.conversions).toBe(1);
    expect(r.personalized_conversions).toBe(1);
    expect(r.prev_total_visits).toBe(1);
    expect(cohortOf(r, "personalized")).toMatchObject({ visits: 1, prev_visits: 1 });
    expect(cohortOf(r, "signal")).toMatchObject({ visits: 1, conversions: 1, prev_visits: 1 });
    expect(JSON.parse(String(r.per_source))).toEqual([
      {
        source_dim: "ai",
        visits: 1,
        conversions: 1,
        prev_visits: 1,
        prev_conversions: 0,
        names: [],
      },
    ]);
    // the per-cell views keep the visit in each cell it touched
    const cells = JSON.parse(String(r.per_variant)) as Entry[];
    expect(cells).toEqual(
      expect.arrayContaining([
        { intent_dim: "problem", source_dim: "ai", visits: 1, conversions: 0 },
        { intent_dim: "pricing", source_dim: "ai", visits: 1, conversions: 1 },
      ]),
    );
    expect(cells).toHaveLength(2);
    const intents = JSON.parse(String(r.per_intent)) as Entry[];
    expect(intents).toEqual(
      expect.arrayContaining([
        { intent_dim: "problem", visits: 1, conversions: 0 },
        { intent_dim: "pricing", visits: 1, conversions: 1 },
      ]),
    );
  });

  it("the natural lift compares visits: 30 crossing visits are 30, not 60", async () => {
    for (let i = 0; i < 30; i++) crossing(NOW - HOUR, i, { converts: i < 10 });
    for (let i = 0; i < 30; i++) visit(NOW - HOUR, { cohort: "no_signal", converts: i < 10 });
    await aggregateWindow("acme", "7d", W7, h.env);
    const r = row("7d");
    expect(r.personalized_visits).toBe(30);
    expect(r.total_visits).toBe(60);
    // 10 of 30 against 10 of 30; summing cells gave 10 of 60, a lift of -50%
    expect(r.natural_lift).toBeCloseTo(0, 10);
  });

  it("a visit across two cohorts is one visit in the total and in the signal visits, one in each cohort", async () => {
    confirm("/");
    crossing(NOW - HOUR, 1, { second: "skipped" });
    for (let i = 0; i < 40; i++) crossing(NOW - W7 - HOUR, 100 + i, { second: "skipped" });
    await aggregateWindow("acme", "7d", W7, h.env);
    const r = row("7d");
    expect(r.total_visits).toBe(1);
    expect(r.personalized_visits).toBe(1);
    expect(r.skipped_visits).toBe(1);
    expect(r.prev_total_visits).toBe(40);
    expect(JSON.parse(String(r.per_source))[0]).toMatchObject({ visits: 1, prev_visits: 40 });

    const superadmin = {
      id: "u",
      email: "a@rawuser.example",
      role: "superadmin",
      customer_id: null,
    };
    const env = { ...h.env, DASHBOARD_ORIGIN: "*" } as unknown as AdminEnv;
    const get = () =>
      new Request("https://generation.rawuser.test/x?customer_id=acme&window=7d", {
        method: "GET",
      });
    const ov = (await (await handleAnalyticsOverview(get(), env, superadmin)).json()) as Record<
      string,
      unknown
    >;
    expect(ov.previous).toMatchObject({ total_visits: 40, signal_visits: 40 });
    const bd = (await (await handleAnalyticsBreakdown(get(), env, superadmin)).json()) as Record<
      string,
      unknown
    >;
    expect(bd.lead).toMatchObject({ signal_visits: 1, total_visits: 1 });
  });

  it("the backfill counts the same way (aggregateWindowAt mirrors the rolling row)", async () => {
    const start = Math.floor((NOW - W7) / W7) * W7;
    crossing(start + HOUR, 1, { converts: true });
    await aggregateWindowAt("acme", "7d", W7, start, h.env);
    const r = h.db
      .prepare(
        "SELECT * FROM analytics_aggregates WHERE customer_id = 'acme' AND window = '7d' AND window_start = ?",
      )
      .get(start) as Record<string, unknown>;
    expect(r.total_visits).toBe(1);
    expect(r.personalized_visits).toBe(1);
    expect(JSON.parse(String(r.per_source))[0]).toMatchObject({ source_dim: "ai", visits: 1 });
  });
});

// ---------------------------------------------------------------------------
// N1 and N3 (docs/specs/results-data.md §7; privacy review conditions 3, 4)
// ---------------------------------------------------------------------------

let m = 0;
/** One page row with a source name and the tag bit, as /event stores them. */
function row2(
  ts: number,
  o: {
    marker: string | null;
    type?: string;
    source?: string;
    name?: string | null;
    tagged?: number | null;
    cohort?: string;
  },
): void {
  h.db
    .prepare(
      `INSERT INTO events (id, customer_id, ts, event_type, page_path, intent_dim, source_dim,
         conversion_label, cohort, visit, source_name, tagged)
       VALUES (?, 'acme', ?, ?, '/', 'problem', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `n_${++m}`,
      ts,
      o.type ?? "variant_shown",
      o.source ?? "social",
      o.type === "conversion" ? "trial_start" : null,
      o.cohort ?? "personalized",
      o.marker,
      o.name === undefined ? null : o.name,
      o.tagged === undefined ? 0 : o.tagged,
    );
}
const mk = (i: number) => vid(70_000 + i);
function sourceDays(day: string) {
  return h.db
    .prepare(
      "SELECT source_dim, source_name, visits, conversions, tagged_visits, tagged_conversions FROM source_days WHERE customer_id = 'acme' AND day = ? ORDER BY source_name",
    )
    .all(day)
    .map((r) => ({ ...r }));
}

describe("N1: names inside a source, 5 visits or more", () => {
  it("names fold into the row under the floor; a later page without a name keeps the visit's name", async () => {
    for (let i = 0; i < 6; i++) {
      row2(NOW - HOUR, { marker: mk(i), name: "linkedin" });
      // page two of the visit: the carry gave the dims, not the name
      row2(NOW - HOUR + 1000, { marker: mk(i), name: null });
      if (i < 2) row2(NOW - HOUR + 2000, { marker: mk(i), type: "conversion", name: "linkedin" });
    }
    for (let i = 10; i < 14; i++) row2(NOW - HOUR, { marker: mk(i), name: "twitter" });
    for (let i = 20; i < 22; i++) row2(NOW - HOUR, { marker: mk(i), name: null });
    await aggregateWindow("acme", "7d", W7, h.env);
    const social = (JSON.parse(String(row("7d").per_source)) as Array<Record<string, unknown>>)[0];
    expect(social).toMatchObject({ source_dim: "social", visits: 12 });
    expect(social?.names).toEqual([{ name: "linkedin", visits: 6, conversions: 2 }]);
  });

  it("a word off the list never reaches the aggregate, whatever is in the column", async () => {
    for (let i = 0; i < 6; i++) row2(NOW - HOUR, { marker: mk(100 + i), name: "evil.example" });
    await aggregateWindow("acme", "7d", W7, h.env);
    const social = (JSON.parse(String(row("7d").per_source)) as Array<Record<string, unknown>>)[0];
    expect(social?.names).toEqual([]);
  });
});

describe("N3: visits on the customer's own tagged links", () => {
  it("counts tagged visits and their conversions, with the period before", async () => {
    for (let i = 0; i < 3; i++) row2(NOW - HOUR, { marker: mk(200 + i), tagged: 1 });
    row2(NOW - HOUR + 5, { marker: mk(200), type: "conversion", tagged: 1 });
    row2(NOW - HOUR, { marker: mk(210), tagged: 0 });
    for (let i = 0; i < 2; i++) row2(NOW - W7 - HOUR, { marker: mk(220 + i), tagged: 1 });
    // a no-signal row never counts, even with a stray bit
    row2(NOW - HOUR, {
      marker: mk(230),
      type: "no_signal_passthrough",
      cohort: "no_signal",
      tagged: 1,
    });
    await aggregateWindow("acme", "7d", W7, h.env);
    expect(JSON.parse(String(row("7d").tagged))).toEqual({
      visits: 3,
      conversions: 1,
      prev_visits: 2,
      prev_conversions: 0,
    });
  });

  it("the breakdown names the sources and the tagged row", async () => {
    for (let i = 0; i < 40; i++) {
      row2(NOW - HOUR, {
        marker: mk(300 + i),
        source: "ai",
        name: "chatgpt",
        tagged: i < 8 ? 1 : 0,
      });
    }
    await aggregateWindow("acme", "7d", W7, h.env);
    const superadmin = {
      id: "u",
      email: "a@rawuser.example",
      role: "superadmin",
      customer_id: null,
    };
    const env = { ...h.env, DASHBOARD_ORIGIN: "*" } as unknown as AdminEnv;
    const bd = (await (
      await handleAnalyticsBreakdown(
        new Request("https://g.test/x?customer_id=acme&window=7d"),
        env,
        superadmin,
      )
    ).json()) as {
      by_source: Array<{ names?: unknown }>;
      tagged?: unknown;
    };
    expect(bd.by_source[0]?.names).toEqual([
      { name: "chatgpt", label: "ChatGPT", visits: 40, conversions: 0 },
    ]);
    expect(bd.tagged).toEqual({
      visits: 8,
      conversions: 0,
      rate: 0,
      prev_visits: 0,
      prev_conversions: 0,
      visits_change: null,
    });
  });
});

describe("retention (condition 3): 31 days on the rows, then daily counts", () => {
  it("the daily rollup keeps (source, name) counts and the tagged ones; reruns replace", async () => {
    const day = dayOf(NOW - 2 * DAY);
    const t = dayStart(day) + 10 * HOUR;
    for (let i = 0; i < 5; i++) {
      row2(t, { marker: mk(400 + i), name: "reddit", source: "community", tagged: i < 3 ? 1 : 0 });
    }
    row2(t + 5, {
      marker: mk(400),
      type: "conversion",
      name: "reddit",
      source: "community",
      tagged: 1,
    });
    row2(t, { marker: mk(410), source: "community", name: null });
    row2(t + DAY, { marker: mk(420), name: "reddit", source: "community" }); // next day
    await rebuildDay(h.d1, "acme", day, NOW);
    await rebuildDay(h.d1, "acme", day, NOW);
    expect(sourceDays(day)).toEqual([
      {
        source_dim: "community",
        source_name: "",
        visits: 1,
        conversions: 0,
        tagged_visits: 0,
        tagged_conversions: 0,
      },
      {
        source_dim: "community",
        source_name: "reddit",
        visits: 5,
        conversions: 1,
        tagged_visits: 3,
        tagged_conversions: 1,
      },
    ]);
  });

  it("a name under 5 visits that day folds into no name (condition 4, at the write)", async () => {
    const day = dayOf(NOW - 2 * DAY);
    const t = dayStart(day) + 9 * HOUR;
    // the lab's chatgpt case: 2 visits, one converting and tagged
    row2(t, { marker: mk(600), source: "ai", name: "chatgpt", tagged: 1 });
    row2(t + 5, { marker: mk(600), type: "conversion", source: "ai", name: "chatgpt", tagged: 1 });
    row2(t, { marker: mk(601), source: "ai", name: "chatgpt" });
    row2(t, { marker: mk(602), source: "ai", name: "perplexity" });
    row2(t, { marker: mk(603), source: "ai", name: null });
    for (let i = 0; i < 5; i++) row2(t, { marker: mk(610 + i), source: "ai", name: "claude" });
    await rebuildDay(h.d1, "acme", day, NOW);
    expect(sourceDays(day)).toEqual([
      {
        source_dim: "ai",
        source_name: "",
        visits: 4,
        conversions: 1,
        tagged_visits: 1,
        tagged_conversions: 1,
      },
      {
        source_dim: "ai",
        source_name: "claude",
        visits: 5,
        conversions: 0,
        tagged_visits: 0,
        tagged_conversions: 0,
      },
    ]);
  });

  it("source_days is deleted with the customer", async () => {
    h.db
      .prepare(
        "INSERT INTO source_days (customer_id, day, source_dim, source_name, visits, conversions, computed_at) VALUES ('acme', '2026-10-01', 'ai', 'chatgpt', 1, 0, 1)",
      )
      .run();
    h.db.prepare("DELETE FROM customers WHERE id = 'acme'").run();
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM source_days").get() as { n: number }).n).toBe(
      0,
    );
  });
});
