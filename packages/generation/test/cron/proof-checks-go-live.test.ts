/**
 * The automatic ends of a go-live test (docs/specs/measure-at-go-live.md
 * §5, §7, §12; privacy review condition 4), on real SQL: on its read date
 * (`read_date`), on day 14 when the fixed read date is past 52 weeks or no
 * date can be fixed (`low_traffic`, one notice line with no number), after
 * 365 days in any case (`limit`). A test someone started by hand is never
 * ended. Nothing restarts a test. The read date is provisional from day 7.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAY_MS, dayOf, dayStart } from "../../src/cron/exposure-rollup.ts";
import { goLiveEnd, runProofChecks } from "../../src/cron/proof-checks.ts";
import {
  type OutcomeLite,
  type TestRow,
  buildLiftReport,
  loadReportInput,
  periodOf,
  readDateOf,
} from "../../src/lib/proof-report.ts";
import { type Harness, digitsBesideIdAndLink, harness } from "../proof-harness.ts";

let h: Harness;
const NOW = Date.now();
const ago = (n: number) => dayOf(NOW - n * DAY_MS);

beforeEach(() => {
  h = harness();
  h.customer("acme", { holdout_percent: 20 });
});
afterEach(() => {
  h.db.close();
});

function testRow(over: {
  startedDaysAgo: number;
  by: string | null;
  readDate?: string | null;
}) {
  const started = dayStart(ago(over.startedDaysAgo)) + 60_000;
  h.db
    .prepare(
      `INSERT INTO holdout_tests (id, customer_id, percent, started_at, read_date, read_fixed_at,
         created_at, started_by, started_actor)
       VALUES ('ht1', 'acme', 20, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      started,
      over.readDate ?? null,
      over.readDate ? started : null,
      started,
      over.by,
      over.by === "go_live" ? "u_sam" : over.by,
    );
}

/** Per closed day from `from` days ago to yesterday: visits per arm, no clicks. */
function outcomes(from: number, treat: number, holdout: number) {
  for (let d = from; d >= 1; d--) {
    for (const [arm, visits] of [
      ["treat", treat],
      ["holdout", holdout],
    ] as const) {
      if (visits === 0) continue;
      h.db
        .prepare(
          `INSERT INTO exposure_outcomes (customer_id, day, arm, page_path, intent_dim, source_dim,
             visits, converting_visits, computed_at)
           VALUES ('acme', ?, ?, '/', 'problem', 'ai', ?, 0, 1)`,
        )
        .run(ago(d), arm, visits);
    }
  }
}

const row = () =>
  h.db
    .prepare(
      "SELECT ended_at, read_date, end_reason, ended_actor FROM holdout_tests WHERE id = 'ht1'",
    )
    .get() as Record<string, unknown>;
const percent = () =>
  (
    h.db.prepare("SELECT holdout_percent FROM customers WHERE id = 'acme'").get() as {
      holdout_percent: number;
    }
  ).holdout_percent;
const testCount = () =>
  (h.db.prepare("SELECT COUNT(*) AS n FROM holdout_tests").get() as { n: number }).n;
const bundleH = () => (JSON.parse(h.kv.get("v1:vm:acme") ?? "{}") as { h?: number }).h;

describe("a go-live test past 52 weeks on day 14", () => {
  it("ends with low_traffic by system, the holdout back to 0, one notice line with no number", async () => {
    testRow({ startedDaysAgo: 15, by: "go_live" });
    outcomes(15, 2, 1);
    const out = await runProofChecks(h.env, NOW);
    expect(out.fixed).toEqual(["acme"]);
    expect(out.ended).toEqual(["low_traffic:acme"]);
    expect(row()).toMatchObject({ end_reason: "low_traffic", ended_actor: "system" });
    expect(row().ended_at).toBe(NOW);
    expect(percent()).toBe(0);
    expect(bundleH()).toBe(0);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toContain("test-low-traffic");
    expect(digitsBesideIdAndLink(h.alerts[0] as string, "acme")).toEqual([]);

    // The card says why.
    const report = buildLiftReport(await loadReportInput(h.env.DB, "acme", NOW, false));
    expect(report.state).toBe("ended_early");
    expect(report.test).toMatchObject({ started_by: "go_live", end_reason: "low_traffic" });
    expect(report.sentence).toMatch(/^Too little traffic to measure the versions within a year/);

    // Nothing restarts it.
    const again = await runProofChecks(h.env, NOW + 3600_000);
    expect(again.ended).toEqual([]);
    expect(testCount()).toBe(1);
    expect(percent()).toBe(0);
    expect(h.alerts).toHaveLength(1);
  });

  it.each([
    ["superadmin", "superadmin"],
    ["customer", "customer"],
    ["from before 0036", null],
  ])("a test started by %s is never ended for traffic", async (_name, by) => {
    testRow({ startedDaysAgo: 15, by });
    outcomes(15, 2, 1);
    const out = await runProofChecks(h.env, NOW);
    expect(out.fixed).toEqual(["acme"]);
    expect(out.ended).toEqual([]);
    expect(row().ended_at).toBeNull();
    expect(percent()).toBe(20);
  });

  it("no eligible visit in 14 days: no date can be fixed, so it ends for low traffic too", async () => {
    testRow({ startedDaysAgo: 15, by: "go_live" });
    const out = await runProofChecks(h.env, NOW);
    expect(out.ended).toEqual(["low_traffic:acme"]);
    expect(row()).toMatchObject({ end_reason: "low_traffic", read_date: null });
  });

  it("before day 14 nothing ends, whatever the traffic", async () => {
    testRow({ startedDaysAgo: 10, by: "go_live" });
    outcomes(10, 2, 1);
    const out = await runProofChecks(h.env, NOW);
    expect(out).toMatchObject({ fixed: [], ended: [] });
    expect(row().ended_at).toBeNull();
  });
});

describe("a go-live test on its read date", () => {
  it("ends with read_date by system, no alert; the result stays on the card", async () => {
    testRow({ startedDaysAgo: 60, by: "go_live", readDate: ago(0) });
    outcomes(60, 400, 100);
    const out = await runProofChecks(h.env, NOW);
    expect(out.ended).toEqual(["read_date:acme"]);
    expect(row()).toMatchObject({ end_reason: "read_date", ended_actor: "system" });
    expect(percent()).toBe(0);
    expect(h.alerts).toEqual([]);
    const report = buildLiftReport(await loadReportInput(h.env.DB, "acme", NOW, false));
    expect(report.state).toBe("ended");
    expect(report.test?.end_reason).toBe("read_date");
    expect(testCount()).toBe(1);
  });

  it("the day before, it runs on", async () => {
    testRow({ startedDaysAgo: 60, by: "go_live", readDate: ago(-1) });
    outcomes(60, 400, 100);
    const out = await runProofChecks(h.env, NOW);
    expect(out.ended).toEqual([]);
    expect(percent()).toBe(20);
  });

  it("a test started by hand runs past its read date until someone stops it", async () => {
    testRow({ startedDaysAgo: 60, by: "customer", readDate: ago(5) });
    outcomes(60, 400, 100);
    const out = await runProofChecks(h.env, NOW);
    expect(out.ended).toEqual([]);
    expect(row().ended_at).toBeNull();
  });
});

describe("goLiveEnd", () => {
  const t = (over: Partial<TestRow>): TestRow => ({
    id: "ht1",
    customer_id: "acme",
    percent: 20,
    started_at: NOW - 366 * DAY_MS,
    ended_at: null,
    read_date: null,
    read_fixed_at: null,
    started_by: "go_live",
    ...over,
  });
  const period = (test: TestRow) =>
    periodOf([test], NOW) as NonNullable<ReturnType<typeof periodOf>>;

  it("365 days after it started, a test whose read date was never fixed ends with limit", () => {
    expect(goLiveEnd(period(t({})), false, NOW)).toBe("limit");
    expect(goLiveEnd(period(t({ started_at: NOW - 364 * DAY_MS })), false, NOW)).toBeNull();
  });

  it("only a go-live test, and only a running one", () => {
    expect(goLiveEnd(period(t({ started_by: "customer" })), true, NOW)).toBeNull();
    expect(goLiveEnd(period(t({ started_by: "superadmin" })), true, NOW)).toBeNull();
    expect(goLiveEnd(period(t({ ended_at: NOW - DAY_MS })), true, NOW)).toBeNull();
  });

  it("a fixed read date within 52 weeks, not yet reached: no end", () => {
    const test = t({
      started_at: NOW - 20 * DAY_MS,
      read_date: ago(-100),
      read_fixed_at: NOW - 5 * DAY_MS,
    });
    expect(goLiveEnd(period(test), false, NOW)).toBeNull();
  });
});

describe("the read date from day 7 (provisional)", () => {
  function lite(fromAgo: number, tv: number, hv: number): OutcomeLite[] {
    const out: OutcomeLite[] = [];
    for (let d = fromAgo; d >= 1; d--) {
      for (const [arm, visits] of [
        ["treat", tv],
        ["holdout", hv],
      ] as const)
        out.push({
          day: ago(d),
          arm,
          source_dim: "ai",
          signal: 1,
          visits,
          converting_visits: 0,
          applied_visits: 0,
          applied_converting_visits: 0,
        });
    }
    return out;
  }
  const started = (n: number) =>
    ({
      id: "ht1",
      customer_id: "acme",
      percent: 20,
      started_at: dayStart(ago(n)) + 60_000,
      ended_at: null,
      read_date: null,
      read_fixed_at: null,
      started_by: "go_live",
    }) as TestRow;

  it("no traffic before the test: no date in the first week, an estimate from day 7, fixed on day 14", () => {
    const p5 = periodOf([started(5)], NOW) as NonNullable<ReturnType<typeof periodOf>>;
    expect(readDateOf(p5, lite(5, 400, 100))).toEqual({
      readDate: null,
      fixed: false,
      fixable: false,
    });
    const p9 = periodOf([started(9)], NOW) as NonNullable<ReturnType<typeof periodOf>>;
    const r9 = readDateOf(p9, lite(9, 400, 100));
    expect(r9.readDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r9).toMatchObject({ fixed: false, fixable: false });
    const p15 = periodOf([started(15)], NOW) as NonNullable<ReturnType<typeof periodOf>>;
    expect(readDateOf(p15, lite(15, 400, 100)).fixable).toBe(true);
  });

  it("the report gives the day-7 date as not fixed, with who started the test", () => {
    const report = buildLiftReport({
      customerId: "acme",
      now: NOW,
      superadmin: false,
      tests: [started(9)],
      outcomes: lite(9, 400, 100),
      mixedByDay: {},
      labels: ["Start free"],
    });
    expect(report.test).toMatchObject({
      read_date_fixed: false,
      started_by: "go_live",
      end_reason: null,
    });
    expect(report.test?.read_date).not.toBeNull();
  });
});
