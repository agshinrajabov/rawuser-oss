/**
 * The bit `lp` on the measuring side (docs/specs/late-tag.md, "The bit lp"
 * and "What is counted and shown"; privacy review Q2 in
 * docs/specs/pilot-gaps.md, conditions 3 to 6). Real SQL on
 * node:sqlite with every migration.
 *
 * `lp: 1` in events.properties says the page had been painted when our
 * script started, so it stayed as built for that load. The edge writes it on
 * two shapes only: a personalization_skipped of kind `late` and the holdout
 * arm's variant_shown.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAnalyticsBreakdown, handleAnalyticsOverview } from "../../src/admin/analytics.ts";
import type { AdminEnv } from "../../src/admin/handlers.ts";
import { handlePortfolioAttention, skipsToLookAt } from "../../src/admin/portfolio.ts";
import {
  LATE_TAG_DAYS,
  LATE_TAG_MIN_EXPOSURES,
  aggregateWindow,
  aggregateWindowAt,
  lateTagShare,
} from "../../src/cron/analytics-aggregator.ts";
import { computeDay, dayOf, dayStart, rebuildDay } from "../../src/cron/exposure-rollup.ts";
import { computeGatedLift } from "../../src/lib/lift.ts";
import {
  LATE_TAG_SHOW_SHARE,
  type OutcomeLite,
  type ReportInput,
  type TestRow,
  buildLiftReport,
  loadLiftReport,
} from "../../src/lib/proof-report.ts";
import { DAY, type EventFixture, HOUR, type Harness, harness, vid } from "../proof-harness.ts";

let h: Harness;
// Wednesday 2026-10-14 12:00 UTC.
const NOW = Date.parse("2026-10-14T12:00:00Z");
const D1 = "2026-10-13"; // yesterday, closed
const T = dayStart(D1) + 10 * HOUR; // 10:00 on D1

beforeEach(() => {
  h = harness();
  h.customer("acme");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The treat arm's exposure of a page painted first, as the edge stores it. */
const lateSkip = (visit: string | null, ts: number, over: Partial<EventFixture> = {}) =>
  h.ev({
    ts,
    type: "personalization_skipped",
    visit,
    arm: "treat",
    cohort: "skipped",
    props: { kind: "late", lp: 1 },
    ...over,
  });
/** The holdout arm's exposure of a page painted first. */
const lateHoldout = (visit: string | null, ts: number, over: Partial<EventFixture> = {}) =>
  h.ev({
    ts,
    type: "variant_shown",
    visit,
    arm: "holdout",
    cohort: "holdout",
    props: { lp: 1 },
    ...over,
  });

type Rows = Awaited<ReturnType<typeof computeDay>>["rows"];
const sumOf = (rows: Rows, arm: string, f: (r: Rows[number]) => number) =>
  rows.filter((r) => r.arm === arm).reduce((s, r) => s + f(r), 0);

describe("exposure_outcomes counts the visits whose first exposure had lp", () => {
  it("in both arms, next to the visits whose page was hidden in time", async () => {
    lateSkip(vid(1), T);
    lateSkip(vid(2), T + 1);
    h.ev({ ts: T + 2, type: "variant_shown", visit: vid(3), arm: "treat", cohort: "personalized" });
    lateHoldout(vid(4), T + 3);
    h.ev({ ts: T + 4, type: "variant_shown", visit: vid(5), arm: "holdout", cohort: "holdout" });
    const { rows } = await computeDay(h.d1, "acme", D1);
    expect(sumOf(rows, "treat", (r) => r.visits)).toBe(3);
    expect(sumOf(rows, "treat", (r) => r.lp_visits)).toBe(2);
    expect(sumOf(rows, "holdout", (r) => r.visits)).toBe(2);
    expect(sumOf(rows, "holdout", (r) => r.lp_visits)).toBe(1);
  });

  it("the first exposure decides: a later page painted first does not move the visit", async () => {
    // In time on the landing, painted first on page two: not an lp visit.
    h.ev({ ts: T, type: "variant_shown", visit: vid(1), arm: "treat", cohort: "personalized" });
    lateSkip(vid(1), T + 60_000, { page: "/pricing" });
    // Painted first on the landing, written from the tab on page two: an lp
    // visit, and a visit where a version was written (intent-to-treat keeps it
    // in treat either way).
    lateSkip(vid(2), T);
    h.ev({
      ts: T + 60_000,
      type: "variant_shown",
      visit: vid(2),
      arm: "treat",
      cohort: "personalized",
      page: "/pricing",
      props: { body_carry: 1 },
    });
    const { rows } = await computeDay(h.d1, "acme", D1);
    expect(sumOf(rows, "treat", (r) => r.visits)).toBe(2);
    expect(sumOf(rows, "treat", (r) => r.lp_visits)).toBe(1);
    expect(sumOf(rows, "treat", (r) => r.applied_visits)).toBe(2);
    // The lp visit sits in the row of its landing, the page that carried the bit.
    const lpRow = rows.find((r) => r.lp_visits === 1);
    expect(lpRow?.page_path).toBe("/");
  });

  it("the exposure that decides the row is the first with an arm, and its bit is the visit's", async () => {
    // A page with no version first (no arm, and a passthrough never carries
    // lp), then the first page with a version, painted first.
    h.ev({ ts: T, type: "no_signal_passthrough", visit: vid(1), page: "/blog" });
    lateHoldout(vid(1), T + 60_000, { page: "/" });
    const { rows } = await computeDay(h.d1, "acme", D1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ arm: "holdout", page_path: "/", visits: 1, lp_visits: 1 });
  });

  it("the converting ones are counted apart, and a conversion row's own properties are never read", async () => {
    lateSkip(vid(1), T);
    h.ev({ ts: T + 5_000, type: "conversion", visit: vid(1), cohort: "skipped" });
    lateSkip(vid(2), T + 1);
    // In time, converting; its conversion row holds a stray lp the edge would never store.
    h.ev({ ts: T + 2, type: "variant_shown", visit: vid(3), arm: "treat", cohort: "personalized" });
    h.ev({ ts: T + 6_000, type: "conversion", visit: vid(3), props: { lp: 1 } });
    lateHoldout(vid(4), T + 3);
    h.ev({ ts: T + 7_000, type: "conversion", visit: vid(4), cohort: "holdout" });
    const { rows } = await computeDay(h.d1, "acme", D1);
    expect(sumOf(rows, "treat", (r) => r.converting_visits)).toBe(2);
    expect(sumOf(rows, "treat", (r) => r.lp_visits)).toBe(2);
    expect(sumOf(rows, "treat", (r) => r.lp_converting_visits)).toBe(1);
    expect(sumOf(rows, "holdout", (r) => r.lp_converting_visits)).toBe(1);
  });

  it("outside a test and without a marker the bit is counted too, in none", async () => {
    // No test: the skip has no arm.
    lateSkip(vid(1), T, { arm: null });
    // Storage blocked: no marker, one row is one visit.
    lateSkip(null, T + 1, { arm: null });
    h.ev({
      ts: T + 2,
      type: "personalization_skipped",
      visit: null,
      cohort: "skipped",
      props: { kind: "gap" },
    });
    const { rows } = await computeDay(h.d1, "acme", D1);
    expect(sumOf(rows, "none", (r) => r.visits)).toBe(3);
    expect(sumOf(rows, "none", (r) => r.lp_visits)).toBe(2);
  });

  it("a late answer is `late` without the bit: not an lp visit", async () => {
    h.ev({
      ts: T,
      type: "personalization_skipped",
      visit: vid(1),
      arm: "treat",
      cohort: "skipped",
      props: { kind: "late" },
    });
    const { rows } = await computeDay(h.d1, "acme", D1);
    expect(sumOf(rows, "treat", (r) => r.skipped_visits)).toBe(1);
    expect(sumOf(rows, "treat", (r) => r.lp_visits)).toBe(0);
  });

  it("only the number 1 is the bit; anything else, and a row that is not JSON, reads as none", async () => {
    const odd = [{ lp: 2 }, { lp: true }, { lp: "1" }, { lp: 0 }, { lp: 1200 }, "not json lp", ""];
    odd.forEach((props, i) =>
      h.ev({
        ts: T + i,
        type: "personalization_skipped",
        visit: vid(i + 1),
        arm: "treat",
        cohort: "skipped",
        props,
      }),
    );
    const { rows } = await computeDay(h.d1, "acme", D1);
    expect(sumOf(rows, "treat", (r) => r.visits)).toBe(odd.length);
    expect(sumOf(rows, "treat", (r) => r.lp_visits)).toBe(0);
  });

  it("the rebuilt day stores both counts, and a rerun gives the same rows", async () => {
    lateSkip(vid(1), T);
    h.ev({ ts: T + 5_000, type: "conversion", visit: vid(1) });
    lateHoldout(vid(2), T + 1);
    h.ev({ ts: T + 2, type: "variant_shown", visit: vid(3), arm: "treat", cohort: "personalized" });
    const read = () =>
      h.db
        .prepare(
          `SELECT arm, SUM(visits) AS visits, SUM(lp_visits) AS lp_visits,
                  SUM(lp_converting_visits) AS lp_converting_visits
           FROM exposure_outcomes WHERE customer_id = 'acme' AND day = ? GROUP BY arm ORDER BY arm`,
        )
        .all(D1)
        .map((r) => ({ ...r }));
    await rebuildDay(h.d1, "acme", D1, NOW);
    const first = read();
    expect(first).toEqual([
      { arm: "holdout", visits: 1, lp_visits: 1, lp_converting_visits: 0 },
      { arm: "treat", visits: 2, lp_visits: 1, lp_converting_visits: 1 },
    ]);
    await rebuildDay(h.d1, "acme", D1, NOW + HOUR);
    expect(read()).toEqual(first);
  });

  it("another customer's rows never count", async () => {
    h.customer("other");
    lateSkip(vid(1), T, { customer: "other" });
    expect((await computeDay(h.d1, "acme", D1)).rows).toEqual([]);
  });
});

describe("the bit stays with the row (ADR 0037)", () => {
  const props = (id: string) =>
    (h.db.prepare("SELECT properties FROM events WHERE id = ?").get(id) as { properties: unknown })
      .properties;
  /** Insert one row with a known id. */
  function row(id: string, ts: number, properties: string | null, visit: string | null = vid(9)) {
    h.db
      .prepare(
        `INSERT INTO events (id, customer_id, ts, event_type, page_path, cohort, visit, properties)
         VALUES (?, 'acme', ?, 'personalization_skipped', '/', 'skipped', ?, ?)`,
      )
      .run(id, ts, visit, properties);
  }

  // ADR 0037 (2026-11-02): nothing on an event row is NULLed at 31 days, the
  // bit lp included. The 6-hour cron no longer strips it.
  it("an old row keeps its bit and its marker after the rollup", async () => {
    const old = Date.now() - 32 * DAY;
    row("skip", old, '{"kind":"late","lp":1}', vid(1));
    await rebuildDay(h.d1, "acme", dayOf(Date.now() - 2 * DAY), Date.now());
    expect(props("skip")).toBe('{"kind":"late","lp":1}');
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM events WHERE visit IS NOT NULL").get() as {
        n: number;
      },
    ).toEqual({ n: 1 });
  });
});

describe("lp is read for counting only (privacy review Q2, condition 3)", () => {
  const SRC = resolve(__dirname, "../../src");
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
    });
  }
  /** A source file reads the bit when it names the JSON path or calls the helpers. */
  const READS_LP = /\$\.lp\b|\blpOf\(|\bhasLp\(/;

  it("only the counting code names it: the aggregator, the rollup and their helper", () => {
    const readers = files(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => READS_LP.test(readFileSync(join(SRC, f), "utf8")))
      .sort();
    expect(readers).toEqual([
      "cron/analytics-aggregator.ts",
      "cron/exposure-rollup.ts",
      "lib/lp.ts",
    ]);
  });

  it("no file that reads it writes KV or builds a prompt", () => {
    for (const f of files(SRC)) {
      const src = readFileSync(f, "utf8");
      if (!READS_LP.test(src)) continue;
      expect(src, relative(SRC, f)).not.toMatch(/VARIANTS\.put|\.put\(|generateVariant|callModel/);
    }
  });
});

describe("the skipped cohort knows its two kinds (every reader of `late`)", () => {
  const W7 = 7 * DAY;
  const superadmin = { id: "u", email: "a@rawuser.example", role: "superadmin", customer_id: null };
  const env = () => ({ ...h.env, DASHBOARD_ORIGIN: "*" }) as unknown as AdminEnv;
  const get = (q = "customer_id=acme&window=7d") => new Request(`https://api.test/x?${q}`);
  const stored = (window = "7d") =>
    h.db
      .prepare(
        "SELECT * FROM analytics_aggregates WHERE customer_id = 'acme' AND window = ? ORDER BY computed_at DESC LIMIT 1",
      )
      .get(window) as Record<string, unknown>;
  const skippedEntry = (row: Record<string, unknown>) =>
    (JSON.parse(row.per_cohort as string) as Array<Record<string, unknown>>).find(
      (c) => c.cohort === "skipped",
    );
  /** A skip that is not the tag's: a part not found, or an answer after the cap. */
  const otherSkip = (visit: string | null, ts: number, kind = "gap", page = "/") =>
    h.ev({
      ts,
      type: "personalization_skipped",
      visit,
      cohort: "skipped",
      page,
      props: { kind },
    });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Five late-tag visits, two gap visits, one late answer, one visit with both kinds, three written. */
  function fixture(): void {
    const t = NOW - 2 * DAY;
    for (let i = 1; i <= 5; i++) lateSkip(vid(i), t + i, { arm: null });
    otherSkip(vid(6), t + 6, "gap", "/docs");
    otherSkip(vid(7), t + 7, "gap", "/docs");
    otherSkip(vid(8), t + 8, "late"); // the answer came after the cap: `late` without the bit
    lateSkip(vid(9), t + 9, { arm: null });
    otherSkip(vid(9), t + 60_000, "gap", "/docs");
    for (let i = 10; i <= 12; i++)
      h.ev({ ts: t + i, type: "variant_shown", visit: vid(i), cohort: "personalized" });
  }

  it("per_cohort: the skipped entry says how many were painted first and how many were not", async () => {
    fixture();
    await aggregateWindow("acme", "7d", W7, h.env);
    const row = stored();
    // The cohort's own count is unchanged in meaning: every visit kept as built, once.
    expect(row.skipped_visits).toBe(9);
    // 5 + the visit with both; 2 gaps + the late answer + the visit with both.
    expect(skippedEntry(row)).toMatchObject({ visits: 9, lp_visits: 6, other_visits: 4 });
  });

  it("the rolling row and aggregateWindowAt give the same split", async () => {
    fixture();
    await aggregateWindow("acme", "7d", W7, h.env);
    const rolling = skippedEntry(stored());
    h.db.prepare("DELETE FROM analytics_aggregates").run();
    await aggregateWindowAt("acme", "7d", W7, NOW - W7, h.env);
    const at = skippedEntry(stored());
    expect(at).toEqual(rolling);
    expect(at).toMatchObject({ lp_visits: 6, other_visits: 4 });
  });

  it("per_page: each page says how many of its skipped visits were painted first", async () => {
    fixture();
    // Two more on /docs, so the page reaches the listing floor of 5 visits.
    otherSkip(vid(30), NOW - DAY, "gap", "/docs");
    otherSkip(vid(31), NOW - DAY + 1, "gap", "/docs");
    await aggregateWindow("acme", "7d", W7, h.env);
    const pages = (
      JSON.parse(stored().per_page as string) as {
        pages: Array<{ page_path: string; skipped_visits: number; lp_visits: number }>;
      }
    ).pages;
    const by = (p: string) => pages.find((x) => x.page_path === p);
    expect(by("/")).toMatchObject({ skipped_visits: 7, lp_visits: 6 });
    expect(by("/docs")).toMatchObject({ skipped_visits: 5, lp_visits: 0 });
  });

  it("the overview and the breakdown carry the split; a row from before has null, never a guess", async () => {
    fixture();
    await aggregateWindow("acme", "7d", W7, h.env);
    const ov = (await (await handleAnalyticsOverview(get(), env(), superadmin)).json()) as {
      cohorts: { skipped: Record<string, unknown> };
    };
    expect(ov.cohorts.skipped).toMatchObject({ visits: 9, lp_visits: 6, other_visits: 4 });
    const bd = (await (await handleAnalyticsBreakdown(get(), env(), superadmin)).json()) as {
      pages: { pages: Array<Record<string, unknown>> };
    };
    expect(bd.pages.pages.find((p) => p.page_path === "/")).toMatchObject({ lp_visits: 6 });

    // A row written before the split: the entry has no such fields.
    const old = (JSON.parse(stored().per_cohort as string) as Array<Record<string, unknown>>).map(
      ({ lp_visits: _l, other_visits: _o, ...rest }) => rest,
    );
    h.db.prepare("UPDATE analytics_aggregates SET per_cohort = ?").run(JSON.stringify(old));
    const before = (await (await handleAnalyticsOverview(get(), env(), superadmin)).json()) as {
      cohorts: { skipped: Record<string, unknown> };
    };
    expect(before.cohorts.skipped).toMatchObject({
      visits: 9,
      lp_visits: null,
      other_visits: null,
    });
  });

  it("the portfolio's skip rate leaves the late tag out: no 'look at the parts' for a tag at the bottom", async () => {
    // 6 late-tag visits and 3 written: 67% of visits skipped, none for a part.
    const t = NOW - 2 * DAY;
    for (let i = 1; i <= 6; i++) lateSkip(vid(i), t + i, { arm: null });
    for (let i = 7; i <= 9; i++)
      h.ev({ ts: t + i, type: "variant_shown", visit: vid(i), cohort: "personalized" });
    await aggregateWindow("acme", "7d", W7, h.env);
    const quiet = (await (await handlePortfolioAttention(get(""), env())).json()) as Array<{
      type: string;
    }>;
    expect(quiet.filter((s) => s.type === "skipped-rate-high")).toEqual([]);

    // The same share of skips for a part not found still raises it.
    for (let i = 21; i <= 26; i++) otherSkip(vid(i), t + i);
    await aggregateWindow("acme", "7d", W7, h.env);
    const loud = (await (await handlePortfolioAttention(get(""), env())).json()) as Array<{
      type: string;
      value: number;
      label: string;
    }>;
    const signal = loud.find((s) => s.type === "skipped-rate-high");
    // 6 of (3 written + 6), the late tag's 6 in neither side.
    expect(signal?.value).toBeCloseTo(6 / 9, 5);
    expect(signal?.label).not.toMatch(/[\u2013\u2014]/);
  });

  it("skipsToLookAt: the split when the row has it, the cohort's total when it does not", () => {
    const withSplit = JSON.stringify([
      { cohort: "skipped", visits: 9, lp_visits: 6, other_visits: 4 },
    ]);
    expect(skipsToLookAt({ skipped_visits: 9, per_cohort: withSplit })).toBe(4);
    expect(
      skipsToLookAt({ skipped_visits: 9, per_cohort: '[{"cohort":"skipped","visits":9}]' }),
    ).toBe(9);
    expect(skipsToLookAt({ skipped_visits: 9, per_cohort: null })).toBe(9);
    expect(skipsToLookAt({ skipped_visits: 9, per_cohort: "not json" })).toBe(9);
  });
});

describe("the lift report shows the two groups (late-tag.md; privacy review Q2, condition 6)", () => {
  const RNOW = Date.parse("2026-11-20T12:00:00Z");
  const day = (n: number) => dayOf(RNOW - n * DAY); // n days ago
  const NO_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

  function test(over: Partial<TestRow> = {}): TestRow {
    return {
      id: "ht1",
      customer_id: "acme",
      percent: 20,
      started_at: dayStart(day(70)),
      ended_at: null,
      read_date: null,
      read_fixed_at: null,
      ...over,
    };
  }
  /** A 20% test started 70 days ago whose read date is today. */
  const READ_TEST = test({ read_date: day(0), read_fixed_at: 1 });
  /** The same test, 25 days in, its read date still 40 days off. */
  const RUNNING_TEST = test({
    started_at: dayStart(day(25)),
    read_date: day(-40),
    read_fixed_at: 1,
  });

  interface PerDay {
    tv: number;
    tc: number;
    hv: number;
    hc: number;
    /** Of the above, the visits whose first exposure had lp. */
    ltv?: number;
    ltc?: number;
    lhv?: number;
    lhc?: number;
  }
  function days(fromAgo: number, toAgo: number, d: PerDay): OutcomeLite[] {
    const out: OutcomeLite[] = [];
    for (let n = fromAgo; n >= toAgo; n--) {
      const base = { day: day(n), source_dim: "ai", signal: 1 };
      out.push({
        ...base,
        arm: "treat",
        visits: d.tv,
        converting_visits: d.tc,
        applied_visits: d.tv - (d.ltv ?? 0),
        applied_converting_visits: d.tc - (d.ltc ?? 0),
        lp_visits: d.ltv ?? 0,
        lp_converting_visits: d.ltc ?? 0,
      });
      out.push({
        ...base,
        arm: "holdout",
        visits: d.hv,
        converting_visits: d.hc,
        applied_visits: 0,
        applied_converting_visits: 0,
        lp_visits: d.lhv ?? 0,
        lp_converting_visits: d.lhc ?? 0,
      });
    }
    return out;
  }
  function input(over: Partial<ReportInput> = {}): ReportInput {
    return {
      customerId: "acme",
      now: RNOW,
      superadmin: false,
      tests: [READ_TEST],
      outcomes: [],
      mixedByDay: {},
      labels: ["Start free"],
      ...over,
    };
  }
  /** Per day: 160 treat and 40 holdout visits, half of each painted first. Both groups pass the gate in 70 days. */
  const HALF: PerDay = { tv: 160, tc: 16, hv: 40, hc: 3, ltv: 80, ltc: 6, lhv: 20, lhc: 1 };

  it("with no test there is nothing to group", () => {
    expect(buildLiftReport(input({ tests: [] })).late_tag).toBeNull();
    expect(
      buildLiftReport(input({ tests: [test({ started_at: RNOW - 60_000 })] })).late_tag,
    ).toBeNull();
  });

  it("at 5% or under the groups are not given, only the share", () => {
    expect(LATE_TAG_SHOW_SHARE).toBe(0.05);
    // 10 of 200 a day: exactly 5%, which is not over 5%.
    const r = buildLiftReport(
      input({ outcomes: days(70, 1, { tv: 160, tc: 16, hv: 40, hc: 3, ltv: 8, lhv: 2 }) }),
    );
    expect(r.late_tag).toMatchObject({
      visits: 14_000,
      late_visits: 700,
      share: 0.05,
      shown: false,
      groups: null,
      sentence: null,
    });
    // One more a day takes it over.
    const over = buildLiftReport(
      input({ outcomes: days(70, 1, { tv: 160, tc: 16, hv: 40, hc: 3, ltv: 9, lhv: 2 }) }),
    );
    expect(over.late_tag?.shown).toBe(true);
    expect(over.late_tag?.groups).not.toBeNull();
  });

  it("outcomes from before migration 0041 read as no visit painted first", () => {
    const old = days(70, 1, HALF).map(
      ({ lp_visits: _a, lp_converting_visits: _b, ...rest }) => rest,
    );
    const r = buildLiftReport(input({ outcomes: old }));
    expect(r.late_tag).toMatchObject({ late_visits: 0, share: 0, shown: false, groups: null });
  });

  it("the headline does not move: the same arms, lift and verdict with or without the bit", () => {
    const withBit = buildLiftReport(input({ outcomes: days(70, 1, HALF) }));
    const without = buildLiftReport(
      input({ outcomes: days(70, 1, { tv: 160, tc: 16, hv: 40, hc: 3 }) }),
    );
    expect(withBit.state).toBe("result");
    expect(withBit.arms).toEqual(without.arms);
    expect(withBit.lift).toEqual(without.lift);
    expect(withBit.verdict).toBe(without.verdict);
    expect(withBit.sentence).toBe(without.sentence);
    expect(withBit.extra_clicks).toEqual(without.extra_clicks);
  });

  it("on the read date each group gets its own arms and its own lift, and the two add up to the headline", () => {
    const r = buildLiftReport(input({ outcomes: days(70, 1, HALF) }));
    const lt = r.late_tag;
    expect(lt).toMatchObject({ visits: 14_000, late_visits: 7_000, share: 0.5, shown: true });
    const late = lt?.groups?.late;
    const inTime = lt?.groups?.in_time;
    expect(late?.treat).toEqual({ visits: 5_600, converting_visits: 420, rate: 0.075 });
    expect(late?.holdout).toEqual({ visits: 1_400, converting_visits: 70, rate: 0.05 });
    expect(inTime?.treat).toEqual({ visits: 5_600, converting_visits: 700, rate: 0.125 });
    expect(inTime?.holdout).toEqual({ visits: 1_400, converting_visits: 140, rate: 0.1 });
    // Each lift is the gated lift of that group's own four counts.
    const lateLift = computeGatedLift(5_600, 420, 1_400, 70);
    const inTimeLift = computeGatedLift(5_600, 700, 1_400, 140);
    expect(late?.lift).toEqual({
      value: lateLift.lift,
      low: lateLift.ci_lower,
      high: lateLift.ci_upper,
    });
    expect(inTime?.lift).toEqual({
      value: inTimeLift.lift,
      low: inTimeLift.ci_lower,
      high: inTimeLift.ci_upper,
    });
    expect(late?.waits_for).toBeNull();
    expect(inTime?.waits_for).toBeNull();
    // The groups partition the arms.
    for (const arm of ["treat", "holdout"] as const) {
      expect((late?.[arm].visits ?? 0) + (inTime?.[arm].visits ?? 0)).toBe(r.arms?.[arm].visits);
      expect((late?.[arm].converting_visits ?? 0) + (inTime?.[arm].converting_visits ?? 0)).toBe(
        r.arms?.[arm].converting_visits,
      );
    }
    // No verdict and no significance mark on a group.
    expect(Object.keys(late ?? {}).sort()).toEqual([
      "holdout",
      "lift",
      "needs",
      "sentence",
      "treat",
      "waits_for",
    ]);
    expect(lt?.sentence).toContain("On 50% of these visits your page appeared before");
    expect(late?.sentence).toMatch(/^Where your page appeared first: \+\d+% \(range /);
    expect(late?.sentence).toContain("on the pages after it");
    expect(inTime?.sentence).toMatch(/^Where the versions were ready in time: \+\d+% \(range /);
  });

  it("a group under 10 converting visits in one arm gets counts only: no lift, no rate", () => {
    // 70 days, the late group's holdout arm converts 9 times in all.
    const outcomes = [
      ...days(70, 62, { tv: 160, tc: 16, hv: 40, hc: 4, ltv: 80, ltc: 8, lhv: 20, lhc: 1 }),
      ...days(61, 1, { tv: 160, tc: 16, hv: 40, hc: 4, ltv: 80, ltc: 8, lhv: 20, lhc: 0 }),
    ];
    const r = buildLiftReport(input({ outcomes }));
    expect(r.state).toBe("result");
    expect(r.lift).not.toBeNull();
    const late = r.late_tag?.groups?.late;
    expect(late?.holdout).toEqual({ visits: 1_400, converting_visits: 9, rate: null });
    expect(late?.treat.rate).toBeNull();
    expect(late?.lift).toBeNull();
    expect(late?.waits_for).toBe("clicks");
    expect(late?.needs).toEqual({ treat: 0, holdout: 1 });
    expect(late?.sentence).toContain("9 of the 1,400 in the original group");
    expect(late?.sentence).toContain("A range needs 10 clicks in each group.");
    expect(late?.sentence).not.toMatch(/%/);
    // The other group is past its gate and is shown.
    expect(r.late_tag?.groups?.in_time.lift).not.toBeNull();
  });

  it("exactly 10 converting visits per arm in a group is enough; 9 is not", () => {
    // One day, 10% of each arm painted first; the late group's holdout arm converts `lhc` times.
    const at = (lhc: number) =>
      buildLiftReport(
        input({
          outcomes: days(70, 70, {
            tv: 8_000,
            tc: 800,
            hv: 2_000,
            hc: 200,
            ltv: 800,
            ltc: 80,
            lhv: 200,
            lhc,
          }),
        }),
      ).late_tag?.groups?.late;
    expect(at(10)?.lift).toMatchObject({ value: expect.any(Number), low: expect.any(Number) });
    expect(at(10)?.waits_for).toBeNull();
    expect(at(9)).toMatchObject({ lift: null, waits_for: "clicks" });
  });

  it("before the read date a group never gets a lift, however clear its numbers", () => {
    // 25 days in: both groups are far past 10 converting visits per arm and
    // the headline shows an interim range. The groups show counts and wait.
    const r = buildLiftReport(
      input({ tests: [RUNNING_TEST], outcomes: days(25, 1, { ...HALF, ltc: 2, lhc: 2 }) }),
    );
    expect(r.state).toBe("interim");
    expect(r.lift?.interim).toBe(true);
    for (const g of [r.late_tag?.groups?.late, r.late_tag?.groups?.in_time]) {
      expect(g?.lift).toBeNull();
      expect(g?.treat.rate).toBeNull();
      expect(g?.holdout.rate).toBeNull();
      expect(g?.waits_for).toBe("read_date");
      expect(g?.sentence).toContain("Compared on the read date.");
      expect(g?.sentence).not.toMatch(/%/);
      expect(g?.treat.visits).toBeGreaterThan(30);
    }
    // Not "interim", not "directional": no such field exists on a group.
    expect(JSON.stringify(r.late_tag)).not.toMatch(/interim|directional/);
  });

  it("a test stopped before its read date: counts per group, no lift", () => {
    const r = buildLiftReport(
      input({
        tests: [{ ...RUNNING_TEST, ended_at: dayStart(day(1)) + HOUR }],
        outcomes: days(25, 1, HALF),
      }),
    );
    expect(r.state).toBe("ended_early");
    expect(r.late_tag?.groups?.late.lift).toBeNull();
    expect(r.late_tag?.groups?.late.waits_for).toBe("ended_early");
    expect(r.late_tag?.groups?.in_time.lift).toBeNull();
  });

  it("a result held back holds the groups back too", () => {
    // 30/70 at a set 20%: the split check fails.
    const r = buildLiftReport(
      input({
        tests: [test({ started_at: dayStart(day(20)) })],
        outcomes: days(20, 1, { tv: 70, tc: 7, hv: 30, hc: 3, ltv: 35, ltc: 3, lhv: 15, lhc: 1 }),
      }),
    );
    expect(r.state).toBe("held_back");
    expect(r.late_tag?.groups?.late).toMatchObject({ lift: null, waits_for: "held_back" });
    expect(r.late_tag?.groups?.late.treat.rate).toBeNull();
  });

  it("the bit recorded unevenly between the arms: neither group is compared", () => {
    // The headline split is right (20%), but nearly every painted-first visit
    // sits in the holdout arm: the bit is not being recorded in treat.
    const outcomes = days(70, 1, {
      tv: 160,
      tc: 16,
      hv: 40,
      hc: 4,
      ltv: 10,
      ltc: 1,
      lhv: 30,
      lhc: 3,
    });
    const customer = buildLiftReport(input({ outcomes }));
    expect(customer.state).toBe("result");
    expect(customer.lift).not.toBeNull();
    for (const g of [customer.late_tag?.groups?.late, customer.late_tag?.groups?.in_time]) {
      expect(g?.lift).toBeNull();
      expect(g?.waits_for).toBe("split");
      expect(g?.treat.rate).toBeNull();
    }
    expect(customer.late_tag?.checks).toBeUndefined();
    const admin = buildLiftReport(input({ outcomes, superadmin: true }));
    expect(admin.late_tag?.checks?.split_ok).toBe(false);
    expect(admin.late_tag?.checks?.late_split_seen).toBeCloseTo(0.75, 5);
    expect(admin.late_tag?.checks?.late_split_p ?? 1).toBeLessThan(0.001);
  });

  it("an even share of the bit in both arms passes the group check", () => {
    const admin = buildLiftReport(input({ outcomes: days(70, 1, HALF), superadmin: true }));
    expect(admin.late_tag?.checks).toMatchObject({ split_ok: true, late_split_seen: 0.2 });
  });

  it("no sentence of the block carries an em or en dash, in any state", () => {
    const reports = [
      buildLiftReport(input({ outcomes: days(70, 1, HALF) })),
      buildLiftReport(input({ tests: [RUNNING_TEST], outcomes: days(25, 1, HALF) })),
      buildLiftReport(
        input({
          tests: [{ ...RUNNING_TEST, ended_at: dayStart(day(1)) + HOUR }],
          outcomes: days(25, 1, HALF),
        }),
      ),
      buildLiftReport(
        input({ outcomes: days(70, 1, { tv: 160, tc: 16, hv: 40, hc: 4, ltv: 10, lhv: 30 }) }),
      ),
    ];
    for (const r of reports) {
      const lines = [
        r.late_tag?.sentence,
        r.late_tag?.groups?.late.sentence,
        r.late_tag?.groups?.in_time.sentence,
      ];
      for (const line of lines) {
        expect(line).toBeTruthy();
        expect(line).not.toMatch(NO_DASHES);
      }
    }
  });

  it("from event rows to the report: the bit of both arms reaches the groups", async () => {
    // A test that started three days ago; yesterday 10 treat and 4 holdout
    // visits, 6 and 2 of them painted first.
    const now = NOW;
    h.db
      .prepare(
        "INSERT INTO holdout_tests (id, customer_id, percent, started_at, ended_at, created_at) VALUES ('ht', 'acme', 20, ?, NULL, ?)",
      )
      .run(now - 3 * DAY, now - 3 * DAY);
    for (let i = 1; i <= 10; i++) {
      if (i <= 6) lateSkip(vid(i), T + i);
      else
        h.ev({
          ts: T + i,
          type: "variant_shown",
          visit: vid(i),
          arm: "treat",
          cohort: "personalized",
        });
    }
    for (let i = 11; i <= 14; i++) {
      if (i <= 12) lateHoldout(vid(i), T + i);
      else
        h.ev({
          ts: T + i,
          type: "variant_shown",
          visit: vid(i),
          arm: "holdout",
          cohort: "holdout",
        });
    }
    h.ev({ ts: T + 60_000, type: "conversion", visit: vid(1) });
    h.ev({ ts: T + 60_001, type: "conversion", visit: vid(11) });
    await rebuildDay(h.d1, "acme", D1, now);
    const r = await loadLiftReport(h.d1, "acme", now, false);
    expect(r.arms).toMatchObject({ treat: { visits: 10 }, holdout: { visits: 4 } });
    expect(r.late_tag).toMatchObject({ visits: 14, late_visits: 8, shown: true });
    expect(r.late_tag?.groups?.late).toMatchObject({
      treat: { visits: 6, converting_visits: 1, rate: null },
      holdout: { visits: 2, converting_visits: 1, rate: null },
      lift: null,
      waits_for: "read_date",
    });
    expect(r.late_tag?.groups?.in_time).toMatchObject({
      treat: { visits: 4, converting_visits: 0 },
      holdout: { visits: 2, converting_visits: 0 },
    });
  });
});

describe("the Pages card's late share (late-tag.md, 'Contract for the dashboard')", () => {
  const shown = (visit: string | null, ts: number, over: Partial<EventFixture> = {}) =>
    h.ev({ ts, type: "variant_shown", visit, cohort: "personalized", ...over });
  const confirm = (page: string, customer = "acme") =>
    h.db
      .prepare(
        "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at) VALUES (?, ?, '{}', 'https://acme.test', 1, 1)",
      )
      .run(customer, page);

  // The pages of these tests have versions of their own.
  beforeEach(() => {
    for (const page of ["/", "/a", "/b"]) confirm(page);
  });

  it("only a confirmed page counts: a page with no versions of its own is in neither number", async () => {
    const t = NOW - DAY;
    // 30 visits on the home page, 6 of them painted first.
    for (let i = 1; i <= 24; i++) shown(vid(i), t + i);
    for (let i = 25; i <= 30; i++) lateSkip(vid(i), t + i, { arm: null });
    // 90 visits that opened only product pages: a `missing` skip in treat,
    // the exposure in holdout, and rows from before the rule with the bit.
    for (let i = 31; i <= 90; i++) {
      h.ev({
        ts: t + i,
        type: "personalization_skipped",
        visit: vid(i),
        cohort: "skipped",
        arm: "treat",
        page: "/products/chair",
        props: { kind: "missing" },
      });
    }
    for (let i = 91; i <= 105; i++) {
      h.ev({
        ts: t + i,
        type: "variant_shown",
        visit: vid(i),
        cohort: "holdout",
        arm: "holdout",
        page: "/Products/Desk/",
      });
    }
    for (let i = 106; i <= 120; i++) lateSkip(vid(i), t + i, { page: "/products/desk" });
    expect(await lateTagShare(h.d1, "acme", NOW)).toEqual({
      exposures: 30,
      late_exposures: 6,
      share: 0.2,
      enough: true,
    });
  });

  it("a visit across both kinds of page is one visit, late only by its confirmed pages", async () => {
    const t = NOW - DAY;
    // In time on the home page, then a product page with a bit from before the rule.
    shown(vid(1), t);
    lateSkip(vid(1), t + 1000, { arm: null, page: "/products/chair" });
    // Only a product page: no exposure at all.
    lateSkip(vid(2), t, { arm: null, page: "/products/chair" });
    // A product page, then the home page painted first.
    h.ev({
      ts: t,
      type: "personalization_skipped",
      visit: vid(3),
      cohort: "skipped",
      page: "/products/chair",
      props: { kind: "missing" },
    });
    lateSkip(vid(3), t + 1000, { arm: null });
    expect(await lateTagShare(h.d1, "acme", NOW)).toMatchObject({
      exposures: 2,
      late_exposures: 1,
      share: 0.5,
    });
  });

  it("the path is read as the manifests key it, and an unconfirmed manifest is not a page with versions", async () => {
    const t = NOW - DAY;
    lateSkip(vid(1), t, { arm: null, page: "/A/" });
    h.db
      .prepare(
        "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at) VALUES ('acme', '/draft', '{}', 'https://acme.test', 1, NULL)",
      )
      .run();
    lateSkip(vid(2), t, { arm: null, page: "/draft" });
    // Another customer's confirmed page is not this customer's.
    h.customer("other");
    confirm("/products/chair", "other");
    lateSkip(vid(3), t, { arm: null, page: "/products/chair" });
    expect(await lateTagShare(h.d1, "acme", NOW)).toMatchObject({
      exposures: 1,
      late_exposures: 1,
    });
  });

  it("counts visits that met a version, and of them the ones painted first", async () => {
    const t = NOW - DAY;
    for (let i = 1; i <= 20; i++) shown(vid(i), t + i);
    for (let i = 21; i <= 28; i++) lateSkip(vid(i), t + i, { arm: null });
    lateHoldout(vid(29), t + 29);
    lateHoldout(vid(30), t + 30);
    expect(await lateTagShare(h.d1, "acme", NOW)).toEqual({
      exposures: 30,
      late_exposures: 10,
      share: 0.3333,
      enough: true,
    });
  });

  it("visits, not rows: three late pages of one visit are one, and one late page makes the visit late", async () => {
    const t = NOW - DAY;
    lateSkip(vid(1), t, { arm: null });
    lateSkip(vid(1), t + 1000, { arm: null, page: "/a" });
    lateSkip(vid(1), t + 2000, { arm: null, page: "/b" });
    // In time on the landing, painted first on page two.
    shown(vid(2), t);
    lateSkip(vid(2), t + 1000, { arm: null, page: "/a" });
    shown(vid(3), t);
    shown(vid(3), t + 1000, { page: "/a" });
    // No marker: one row is one visit.
    lateSkip(null, t, { arm: null });
    lateSkip(null, t + 1, { arm: null });
    expect(await lateTagShare(h.d1, "acme", NOW)).toMatchObject({
      exposures: 5,
      late_exposures: 4,
      share: 0.8,
    });
  });

  it("a page with no version, a click and a late answer are not late and the first two are not exposures", async () => {
    const t = NOW - DAY;
    shown(vid(1), t);
    // No version was ready here: in neither count.
    h.ev({ ts: t, type: "no_signal_passthrough", visit: vid(2), cohort: "no_signal" });
    // A click never carries the bit; one stored by mistake is not read.
    h.ev({ ts: t + 5, type: "conversion", visit: vid(1), props: { lp: 1 } });
    // The answer came after the cap: `late` without the bit.
    h.ev({
      ts: t,
      type: "personalization_skipped",
      visit: vid(3),
      cohort: "skipped",
      props: { kind: "late" },
    });
    expect(await lateTagShare(h.d1, "acme", NOW)).toMatchObject({
      exposures: 2,
      late_exposures: 0,
      share: 0,
    });
  });

  it("the last 7 days only, this customer only", async () => {
    expect(LATE_TAG_DAYS).toBe(7);
    lateSkip(vid(1), NOW - 7 * DAY - HOUR, { arm: null }); // too old
    lateSkip(vid(2), NOW - 7 * DAY + HOUR, { arm: null });
    h.customer("other");
    confirm("/", "other");
    lateSkip(vid(3), NOW - DAY, { arm: null, customer: "other" });
    expect(await lateTagShare(h.d1, "acme", NOW)).toMatchObject({
      exposures: 1,
      late_exposures: 1,
    });
  });

  it("enough from 30 visits, not from 29; no share with no visit", async () => {
    expect(LATE_TAG_MIN_EXPOSURES).toBe(30);
    expect(await lateTagShare(h.d1, "acme", NOW)).toEqual({
      exposures: 0,
      late_exposures: 0,
      share: null,
      enough: false,
    });
    for (let i = 1; i <= 29; i++) shown(vid(i), NOW - DAY + i);
    expect((await lateTagShare(h.d1, "acme", NOW)).enough).toBe(false);
    lateSkip(vid(30), NOW - DAY, { arm: null });
    expect(await lateTagShare(h.d1, "acme", NOW)).toMatchObject({ exposures: 30, enough: true });
  });

  it("a 32-day-old late skip stays on its row, and the 7-day read never looks that far", async () => {
    lateSkip(vid(1), NOW - 32 * DAY, { arm: null });
    expect(await lateTagShare(h.d1, "acme", NOW)).toMatchObject({ exposures: 0 });
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM events WHERE properties LIKE '%lp%'").get(),
    ).toEqual({ n: 1 });
  });
});
