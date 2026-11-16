/**
 * The daily exposure outcomes, the marker's hard 31-day ceiling, the
 * aggregator's intent-to-treat mirror, the hourly checks and their alerts,
 * and the retention cascade (docs/specs/proof-engine.md, D and E; privacy review
 * conditions 1, 3, 7 and 8). Real SQL on node:sqlite.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARM_TOTALS_SQL,
  aggregateWindow,
  aggregateWindowAt,
  armTotals,
} from "../../src/cron/analytics-aggregator.ts";
import {
  ROLLUP_EVENT_QUERIES,
  closedDays,
  computeDay,
  dayOf,
  dayStart,
  rebuildDay,
  runExposureRollup,
} from "../../src/cron/exposure-rollup.ts";
import { runProofChecks, runWeeklyDraftNotices } from "../../src/cron/proof-checks.ts";
import { proofAlertText } from "../../src/lib/proof-alerts.ts";
import { DAY, HOUR, type Harness, digitsBesideIdAndLink, harness, vid } from "../proof-harness.ts";

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

type Rows = Awaited<ReturnType<typeof computeDay>>["rows"];
const arm = (rows: Rows, a: string) => rows.filter((r) => r.arm === a);
const total = (rows: Rows, f: (r: Rows[number]) => number) => rows.reduce((s, r) => s + f(r), 0);

describe("exposure_outcomes: intent-to-treat", () => {
  it("a skipped and a late treat visit count in treat (skipped_visits), next to a written one", async () => {
    h.ev({ ts: T, type: "variant_shown", visit: vid(1), arm: "treat", cohort: "personalized" });
    h.ev({
      ts: T,
      type: "personalization_skipped",
      visit: vid(2),
      arm: "treat",
      cohort: "skipped",
    });
    h.ev({
      ts: T + 1,
      type: "personalization_skipped",
      visit: vid(3),
      arm: "treat",
      cohort: "skipped",
    });
    const { rows } = await computeDay(h.d1, "acme", D1);
    const treat = arm(rows, "treat");
    expect(total(treat, (r) => r.visits)).toBe(3);
    expect(total(treat, (r) => r.applied_visits)).toBe(1);
    expect(total(treat, (r) => r.skipped_visits)).toBe(2);
  });

  it("a conversion on a no-signal page of a treat visit counts for treat", async () => {
    h.ev({ ts: T, type: "variant_shown", visit: vid(1), arm: "treat", page: "/" });
    h.ev({ ts: T + 60_000, type: "no_signal_passthrough", visit: vid(1), page: "/about" });
    h.ev({
      ts: T + 90_000,
      type: "conversion",
      visit: vid(1),
      page: "/about",
      cohort: "no_signal",
    });
    const { rows } = await computeDay(h.d1, "acme", D1);
    expect(arm(rows, "none")).toEqual([]);
    const [t] = arm(rows, "treat");
    expect(t).toMatchObject({
      page_path: "/",
      visits: 1,
      converting_visits: 1,
      applied_converting_visits: 1,
    });
    expect(t?.conversions_by_label).toEqual({ trial_start: 1 });
  });

  it("a holdout visit's conversion counts for holdout and names the would-be body", async () => {
    h.ev({
      ts: T,
      type: "variant_shown",
      visit: vid(4),
      arm: "holdout",
      cohort: "holdout",
      body: "fedcba9876543210",
    });
    h.ev({ ts: T + 5000, type: "conversion", visit: vid(4), arm: "holdout" });
    const { rows } = await computeDay(h.d1, "acme", D1);
    expect(arm(rows, "holdout")).toEqual([
      expect.objectContaining({ visits: 1, converting_visits: 1, body_id: "fedcba9876543210" }),
    ]);
  });

  it("a visit in two arms is left out and counted as mixed", async () => {
    h.ev({ ts: T, type: "variant_shown", visit: vid(5), arm: "treat" });
    h.ev({ ts: T + 1000, type: "variant_shown", visit: vid(5), arm: "holdout" });
    h.ev({ ts: T + 2000, type: "conversion", visit: vid(5) });
    const { rows, mixed } = await computeDay(h.d1, "acme", D1);
    expect(rows).toEqual([]);
    expect(mixed).toBe(1);
  });

  it("an arm and an unarmed page keep the arm (no filter on what came after the coin)", async () => {
    h.ev({ ts: T, type: "variant_shown", visit: vid(6), arm: "holdout" });
    h.ev({ ts: T + 1000, type: "no_signal_passthrough", visit: vid(6), page: "/en" });
    const { rows, mixed } = await computeDay(h.d1, "acme", D1);
    expect(mixed).toBe(0);
    expect(arm(rows, "holdout")[0]?.visits).toBe(1);
  });

  it("pages of one visit collapse; a conversion counts once per visit", async () => {
    for (let i = 0; i < 4; i++)
      h.ev({
        ts: T + i * 60_000,
        type: "variant_shown",
        visit: vid(7),
        arm: "treat",
        page: i ? `/p${i}` : "/",
      });
    h.ev({ ts: T + 5 * 60_000, type: "conversion", visit: vid(7) });
    h.ev({ ts: T + 6 * 60_000, type: "conversion", visit: vid(7) });
    h.ev({ ts: T + 7 * 60_000, type: "conversion", visit: vid(7), label: "demo_request" });
    const { rows } = await computeDay(h.d1, "acme", D1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ page_path: "/", visits: 1, converting_visits: 1 });
    expect(rows[0]?.conversions_by_label).toEqual({ trial_start: 1, demo_request: 1 });
  });

  it("markerless rows count one each in none", async () => {
    h.ev({ ts: T, type: "variant_shown", visit: null, arm: null });
    h.ev({ ts: T + 1, type: "variant_shown", visit: null, arm: null });
    h.ev({ ts: T + 2, type: "no_signal_passthrough", visit: null });
    const { rows } = await computeDay(h.d1, "acme", D1);
    expect(arm(rows, "treat")).toEqual([]);
    const none = arm(rows, "none");
    expect(total(none, (r) => r.visits)).toBe(3);
    expect(total(none, (r) => r.applied_visits)).toBe(2);
  });

  it("a visit across midnight counts on the day it started, its late conversion included", async () => {
    const late = dayStart(D1) - 10 * 60_000; // 23:50 the day before
    h.ev({ ts: late, type: "variant_shown", visit: vid(8), arm: "treat" });
    h.ev({
      ts: dayStart(D1) + 10 * 60_000,
      type: "variant_shown",
      visit: vid(8),
      arm: "treat",
      page: "/b",
    });
    h.ev({ ts: dayStart(D1) + 20 * 60_000, type: "conversion", visit: vid(8) });
    const today = await computeDay(h.d1, "acme", D1);
    expect(today.rows).toEqual([]);
    const before = await computeDay(h.d1, "acme", dayOf(dayStart(D1) - DAY));
    expect(before.rows[0]).toMatchObject({ arm: "treat", visits: 1, converting_visits: 1 });
  });

  it("another customer's rows never count", async () => {
    h.customer("other");
    h.ev({ customer: "other", ts: T, type: "variant_shown", visit: vid(9), arm: "treat" });
    h.ev({ customer: "other", ts: T + 1, type: "conversion", visit: vid(9) });
    expect((await computeDay(h.d1, "acme", D1)).rows).toEqual([]);
  });
});

describe("exposure_outcomes never copy an identifier (docs/specs/event-paths.md)", () => {
  it("a day rebuilt from rows stored before the edge masked holds :id", async () => {
    h.ev({
      ts: T,
      type: "variant_shown",
      visit: vid(1),
      arm: "treat",
      page: "/admin/students/550e8400-e29b-41d4-a716-446655440000",
    });
    h.ev({ ts: T, type: "variant_shown", arm: "treat", visit: null, page: "/account/48213377" });
    const { rows } = await computeDay(h.d1, "acme", D1);
    expect(rows.map((r) => r.page_path).sort()).toEqual(["/account/:id", "/admin/students/:id"]);
  });
});

describe("exposure_outcomes: idempotent whole-day rebuilds", () => {
  function fixture() {
    for (let i = 0; i < 20; i++) {
      const a = i % 5 === 0 ? "holdout" : "treat";
      h.ev({
        ts: T + i * 1000,
        type: i % 7 === 0 ? "personalization_skipped" : "variant_shown",
        visit: vid(100 + i),
        arm: a,
        source: i % 2 ? "ai" : "social",
      });
      if (i % 3 === 0) h.ev({ ts: T + i * 1000 + 500, type: "conversion", visit: vid(100 + i) });
    }
    h.ev({ ts: T, type: "no_signal_passthrough", visit: vid(999) });
  }
  const rowsOf = () =>
    h.db
      .prepare(
        "SELECT arm, page_path, intent_dim, source_dim, body_id, visits, converting_visits, applied_visits, skipped_visits, applied_converting_visits, conversions_by_label FROM exposure_outcomes WHERE customer_id = 'acme' ORDER BY arm, source_dim, intent_dim",
      )
      .all();

  it("a rerun of a day gives identical rows", async () => {
    fixture();
    await rebuildDay(h.d1, "acme", D1, NOW);
    const first = rowsOf();
    await rebuildDay(h.d1, "acme", D1, NOW);
    expect(rowsOf()).toEqual(first);
    expect(first.length).toBeGreaterThan(2);
  });

  it("rows sum to the arm totals", async () => {
    fixture();
    await rebuildDay(h.d1, "acme", D1, NOW);
    const sums = h.db
      .prepare(
        "SELECT arm, SUM(visits) AS v, SUM(converting_visits) AS c FROM exposure_outcomes GROUP BY arm ORDER BY arm",
      )
      .all() as Array<{ arm: string; v: number; c: number }>;
    const arms = await armTotals(h.d1, "acme", dayStart(D1) - 1, dayStart(D1) + DAY);
    expect(sums.find((s) => s.arm === "treat")).toMatchObject({
      v: arms.treat.visits,
      c: arms.treat.conversions,
    });
    expect(sums.find((s) => s.arm === "holdout")).toMatchObject({
      v: arms.holdout.visits,
      c: arms.holdout.conversions,
    });
    expect(sums.find((s) => s.arm === "none")?.v).toBe(1);
  });

  it("a cell that vanished on recompute is deleted", async () => {
    h.ev({ ts: T, type: "variant_shown", visit: vid(1), arm: "treat", source: "paid" });
    await rebuildDay(h.d1, "acme", D1, NOW);
    expect(rowsOf()).toHaveLength(1);
    h.db.prepare("DELETE FROM events").run();
    await rebuildDay(h.d1, "acme", D1, NOW);
    expect(rowsOf()).toEqual([]);
    const day = h.db
      .prepare(
        "SELECT computed_at FROM exposure_rollup_days WHERE customer_id = 'acme' AND day = ?",
      )
      .get(D1);
    expect(day).toEqual({ computed_at: NOW });
  });

  it("the hourly run rebuilds the last three closed days, and never an open or too old one", async () => {
    expect(closedDays(NOW, 3)).toEqual(["2026-10-13", "2026-10-12", "2026-10-11"]);
    const r = await runExposureRollup(h.env, NOW);
    expect(r).toEqual({ rebuilt: 3, errors: 0 });
    const days = (
      h.db.prepare("SELECT day FROM exposure_rollup_days ORDER BY day").all() as Array<{
        day: string;
      }>
    ).map((d) => d.day);
    expect(days).toEqual(["2026-10-11", "2026-10-12", "2026-10-13"]);
    expect(await rebuildDay(h.d1, "acme", dayOf(NOW), NOW)).toEqual({
      rebuilt: false,
      reason: "open",
    });
    expect(await rebuildDay(h.d1, "acme", dayOf(NOW - 31 * DAY), NOW)).toEqual({
      rebuilt: false,
      reason: "too_old",
    });
  });
});

describe("old days and the hourly check (ADR 0037: nothing is NULLed)", () => {
  function testRan(from: number, to: number | null): void {
    h.db
      .prepare(
        "INSERT INTO holdout_tests (id, customer_id, percent, started_at, ended_at, created_at) VALUES (?, 'acme', 20, ?, ?, ?)",
      )
      .run(`ht_${from}`, from, to, from);
  }

  it("a 32-day-old row keeps its marker: the 31-day purge is gone", async () => {
    const old = Date.now() - 32 * DAY;
    testRan(old - DAY, null);
    h.ev({ ts: old, type: "variant_shown", visit: vid(1), arm: "treat" });
    await runExposureRollup(h.env);
    expect(h.db.prepare("SELECT visit FROM events").get()).toEqual({ visit: vid(1) });
    expect(h.alerts).toEqual([]);
  });

  it("the hourly check stays quiet for an unrolled day with no test", async () => {
    h.ev({ ts: NOW - 5 * DAY, type: "variant_shown", visit: vid(1), arm: "treat" });
    expect((await runProofChecks(h.env, NOW)).alerts).toEqual([]);
  });

  it("the hourly check: a closed day with markers and no rollup three days on raises rollup-missing", async () => {
    testRan(NOW - 10 * DAY, null);
    h.ev({ ts: NOW - 5 * DAY, type: "variant_shown", visit: vid(1), arm: "treat" });
    h.ev({ ts: NOW - 1 * DAY, type: "variant_shown", visit: vid(2), arm: "treat" });
    const r = await runProofChecks(h.env, NOW);
    expect(r.alerts).toEqual(["rollup-missing:acme"]);
    expect(digitsBesideIdAndLink(h.alerts[0] ?? "", "acme")).toEqual([]);
    // Rolled up: quiet (a new hour, the dedupe key cleared to prove it).
    await rebuildDay(h.d1, "acme", dayOf(NOW - 5 * DAY), NOW);
    h.kv.clear();
    h.alerts.length = 0;
    expect((await runProofChecks(h.env, NOW)).alerts).toEqual([]);
  });
});

describe("the marker join is confined (privacy review condition 3)", () => {
  const SRC = resolve(__dirname, "../../src");
  const rollupFiles = ["cron/exposure-rollup.ts", "cron/analytics-aggregator.ts"];

  function sqlStrings(file: string): string[] {
    const src = readFileSync(join(SRC, file), "utf8");
    return [...src.matchAll(/`([\s\S]*?)`/g)]
      .map((m) => m[1] ?? "")
      .filter((s) => /FROM events/.test(s));
  }

  it("every events subquery in the rollup and the aggregator filters customer_id", () => {
    const all = [...rollupFiles.flatMap(sqlStrings), ...ROLLUP_EVENT_QUERIES, ARM_TOTALS_SQL];
    expect(all.length).toBeGreaterThan(8);
    for (const sql of all) {
      const parts = sql.split(/FROM events\b/).slice(1);
      for (const after of parts) {
        expect(after, sql.slice(0, 120)).toMatch(/^\s*(?:AS \w+\s+)?WHERE\s+customer_id = \?/);
      }
    }
  });

  it("the rollup's joins are its own CTEs over events, never another table", () => {
    for (const sql of [...ROLLUP_EVENT_QUERIES, ARM_TOTALS_SQL]) {
      const ctes = new Set([...sql.matchAll(/(\w+) AS \(/g)].map((m) => m[1]));
      for (const m of sql.matchAll(/JOIN (\w+)/g)) expect(ctes.has(m[1]), m[1]).toBe(true);
    }
  });

  it("no other source file reads events by visit", () => {
    const allowed = new Set([
      ...rollupFiles,
      "cron/proof-checks.ts", // which days still hold markers, per customer
      // The visitor-choice card (direct-visitors.md §2): visits shown the
      // question, answering, clicking, counted by marker inside one customer.
      "lib/choice.ts",
      // New and returning visitors on Visitors (ADR 0039): the memory's rows
      // joined to the period's clicks by marker, inside one customer.
      "lib/visitors.ts",
      "index.ts",
    ]);
    function files(dir: string): string[] {
      return readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
      });
    }
    const offenders = files(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => !allowed.has(f))
      .filter((f) => /FROM events[\s\S]{0,600}?\bvisit\b/.test(readFileSync(join(SRC, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("analytics_aggregates: the rolling query and aggregateWindowAt are mirrors", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("give the same numbers on one fixture, the period before included", async () => {
    // The rolling row counts (now - W, now] since 2026-10-04
    // (docs/specs/results-data.md §1); aggregateWindowAt at now - W counts
    // the same range. Both are one computeWindow.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const windowMs = 7 * DAY;
    const start = NOW - windowMs;
    const t0 = start + HOUR;
    for (let i = 0; i < 60; i++) {
      const a = i % 4 === 0 ? "holdout" : "treat";
      h.ev({
        ts: t0 + i * 1000,
        type: i % 9 === 0 ? "personalization_skipped" : "variant_shown",
        visit: vid(i + 1),
        arm: a,
        cohort: a === "holdout" ? "holdout" : i % 9 === 0 ? "skipped" : "personalized",
        source: i % 3 === 0 ? "organic" : "ai",
        page: i % 5 === 0 ? "/docs/" : "/",
      });
      if (i % 2 === 0)
        h.ev({
          ts: t0 + i * 1000 + 100,
          type: "conversion",
          visit: vid(i + 1),
          cohort: a === "holdout" ? "holdout" : "personalized",
          source: i % 3 === 0 ? "organic" : "ai",
        });
    }
    // The period before: 7 visits, one skipped.
    for (let i = 0; i < 7; i++)
      h.ev({
        ts: start - DAY + i,
        type: i === 0 ? "personalization_skipped" : "variant_shown",
        visit: vid(500 + i),
        cohort: i === 0 ? "skipped" : "personalized",
      });
    const read = () =>
      h.db
        .prepare(
          "SELECT total_visits, personalized_visits, holdout_visits, skipped_visits, passthrough_visits, conversions, personalized_conversions, holdout_conversions, skipped_conversions, prev_total_visits, prev_conversions, per_cohort, per_source, per_page, holdout_lift, holdout_lift_ci_lower, holdout_lift_ci_upper, natural_lift FROM analytics_aggregates WHERE window = '7d' ORDER BY computed_at DESC LIMIT 1",
        )
        .get();
    await aggregateWindow("acme", "7d", windowMs, h.env);
    const rolling = read();
    h.db.prepare("DELETE FROM analytics_aggregates").run();
    await aggregateWindowAt("acme", "7d", windowMs, start, h.env);
    const at = read();
    expect(at).toEqual(rolling);
    const r = rolling as {
      holdout_visits: number;
      holdout_conversions: number;
      prev_total_visits: number;
      per_page: string;
    };
    expect(r.holdout_visits).toBe(15);
    expect(r.holdout_conversions).toBe(15); // every holdout visit (i % 4 == 0) is even, so converts
    expect(r.prev_total_visits).toBe(7); // the skipped one included, like total_visits
    expect(JSON.parse(r.per_page).pages.map((p: { page_path: string }) => p.page_path)).toEqual([
      "/",
      "/docs",
    ]);
  });
});

describe("alerts carry no numbers (privacy review condition 7)", () => {
  it("each proof alert code is the code, the customer id and a link", () => {
    for (const code of [
      "lift-negative",
      "holdout-split",
      "rollup-missing",
      "weekly-draft",
    ] as const) {
      const line = proofAlertText(code, "brisk", "https://app.example.com");
      expect(line).toBe(
        `[rawuser ops] ${code} · brisk · https://app.example.com/analytics?customer_id=brisk`,
      );
      expect(digitsBesideIdAndLink(line, "brisk")).toEqual([]);
    }
  });

  it("a broken split raises holdout-split, a negative read raises lift-negative, both without numbers", async () => {
    // A 20% test that started 40 days ago with a fixed read date of 10 days ago.
    const started = dayStart(dayOf(NOW - 40 * DAY));
    h.db
      .prepare(
        "INSERT INTO holdout_tests (id, customer_id, percent, started_at, read_date, read_fixed_at, created_at) VALUES ('ht1', 'acme', 20, ?, ?, 1, 1)",
      )
      .run(started, dayOf(NOW - 10 * DAY));
    // Rollup rows straight into the table: a 50/50 split at a set 20%, versions worse.
    const ins = h.db.prepare(
      "INSERT INTO exposure_outcomes (customer_id, day, arm, page_path, intent_dim, source_dim, body_id, visits, converting_visits, computed_at) VALUES ('acme', ?, ?, '/', 'problem', 'ai', '', ?, ?, 1)",
    );
    for (let d = 40; d > 10; d--) {
      const day = dayOf(NOW - d * DAY);
      ins.run(day, "treat", 100, 4);
      ins.run(day, "holdout", 100, 10);
      h.db
        .prepare(
          "INSERT INTO exposure_rollup_days (customer_id, day, computed_at) VALUES ('acme', ?, 1)",
        )
        .run(day);
    }
    const r = await runProofChecks(h.env, NOW);
    expect(r.alerts).toContain("holdout-split:acme");
    expect(h.alerts.length).toBeGreaterThan(0);
    for (const line of h.alerts) expect(digitsBesideIdAndLink(line, "acme")).toEqual([]);

    // Split fixed (20%): the negative result alone.
    h.db.prepare("DELETE FROM exposure_outcomes").run();
    for (let d = 40; d > 10; d--) {
      const day = dayOf(NOW - d * DAY);
      ins.run(day, "treat", 400, 16);
      ins.run(day, "holdout", 100, 10);
    }
    h.kv.clear();
    h.alerts.length = 0;
    const again = await runProofChecks(h.env, NOW);
    expect(again.alerts).toEqual(["lift-negative:acme"]);
    expect(h.alerts[0]).toContain("lift-negative · acme");
    expect(digitsBesideIdAndLink(h.alerts[0] ?? "", "acme")).toEqual([]);
    // Once per test.
    h.alerts.length = 0;
    expect((await runProofChecks(h.env, NOW)).alerts).toEqual([]);
  });

  it("test customers raise no proof alert", async () => {
    h.customer("lab", { plan: "test" });
    h.ev({
      customer: "lab",
      ts: NOW - 5 * DAY,
      type: "variant_shown",
      visit: vid(1),
      arm: "treat",
    });
    const r = await runProofChecks(h.env, NOW);
    expect(r.alerts.filter((a) => a.endsWith(":lab"))).toEqual([]);
  });

  it("the Monday notice names the customer and links the draft, nothing else", async () => {
    h.db
      .prepare(
        "INSERT INTO holdout_tests (id, customer_id, percent, started_at, created_at) VALUES ('ht1', 'acme', 20, ?, 1)",
      )
      .run(NOW - 20 * DAY);
    expect(await runWeeklyDraftNotices(h.env, NOW)).toEqual(["acme"]);
    expect(h.alerts[0]).toContain("weekly-draft · acme");
    expect(digitsBesideIdAndLink(h.alerts[0] ?? "", "acme")).toEqual([]);
  });

  it("the read date is fixed once 14 whole days have closed, and stays", async () => {
    const started = dayStart(dayOf(NOW - 15 * DAY));
    h.db
      .prepare(
        "INSERT INTO holdout_tests (id, customer_id, percent, started_at, created_at) VALUES ('ht1', 'acme', 20, ?, 1)",
      )
      .run(started);
    const ins = h.db.prepare(
      "INSERT INTO exposure_outcomes (customer_id, day, arm, page_path, intent_dim, source_dim, body_id, visits, converting_visits, computed_at) VALUES ('acme', ?, ?, '/', 'problem', 'ai', '', ?, ?, 1)",
    );
    for (let d = 15; d >= 1; d--) {
      const day = dayOf(NOW - d * DAY);
      ins.run(day, "treat", 400, 32);
      ins.run(day, "holdout", 100, 8);
      h.db
        .prepare(
          "INSERT INTO exposure_rollup_days (customer_id, day, computed_at) VALUES ('acme', ?, 1)",
        )
        .run(day);
    }
    const r = await runProofChecks(h.env, NOW);
    expect(r.fixed).toEqual(["acme"]);
    const t = h.db.prepare("SELECT read_date, read_fixed_at FROM holdout_tests").get() as {
      read_date: string;
      read_fixed_at: number;
    };
    expect(t.read_fixed_at).toBe(NOW);
    expect(t.read_date > dayOf(NOW)).toBe(true);
    await runProofChecks(h.env, NOW + 3 * DAY);
    const t2 = h.db.prepare("SELECT read_date, read_fixed_at FROM holdout_tests").get();
    expect(t2).toEqual(t);
  });
});

describe("retention (privacy review condition 8)", () => {
  it("version bodies, outcomes, rollup days and test periods are deleted with the customer", async () => {
    h.db
      .prepare(
        "INSERT INTO version_bodies (body_id, customer_id, page_path, intent_dim, source_dim, model, prompt_hash, body_json, live_from) VALUES ('0123456789abcdef', 'acme', '/', 'problem', 'ai', 'm', 'p', '{}', 1)",
      )
      .run();
    h.db
      .prepare(
        "INSERT INTO exposure_outcomes (customer_id, day, arm, page_path, visits, converting_visits, computed_at) VALUES ('acme', '2026-10-01', 'none', '/', 1, 0, 1)",
      )
      .run();
    h.db
      .prepare(
        "INSERT INTO exposure_rollup_days (customer_id, day, computed_at) VALUES ('acme', '2026-10-01', 1)",
      )
      .run();
    h.db
      .prepare(
        "INSERT INTO holdout_tests (id, customer_id, percent, started_at, created_at) VALUES ('ht1', 'acme', 20, 1, 1)",
      )
      .run();
    h.db.prepare("DELETE FROM customers WHERE id = 'acme'").run();
    for (const table of [
      "version_bodies",
      "exposure_outcomes",
      "exposure_rollup_days",
      "holdout_tests",
    ]) {
      expect(
        (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        table,
      ).toBe(0);
    }
  });
});
