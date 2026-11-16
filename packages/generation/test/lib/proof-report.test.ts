/**
 * The lift report's states and words (docs/specs/proof-engine.md, D and G),
 * from fixtures: off, starting, not enough, interim, held back (split,
 * uncounted), result (positive, no difference, negative, inconclusive),
 * ended, ended early; the read date fixed after day 14 and no verdict
 * before it; the checks row for a superadmin only; no dashes anywhere.
 */
import { describe, expect, it } from "vitest";
import { DAY_MS, dayOf, dayStart } from "../../src/cron/exposure-rollup.ts";
import {
  type OutcomeLite,
  type ReportInput,
  type TestRow,
  buildLiftReport,
  periodOf,
  readDateOf,
} from "../../src/lib/proof-report.ts";
import { buildWeeklyDraft, weekCut } from "../../src/lib/proof-weekly.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const day = (n: number) => dayOf(NOW - n * DAY_MS); // n days ago

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

/** Per day from `fromAgo` to `toAgo` days ago: the given counts per arm. */
function days(
  fromAgo: number,
  toAgo: number,
  perDay: { tv: number; tc: number; hv: number; hc: number; none?: number; source?: string },
): OutcomeLite[] {
  const out: OutcomeLite[] = [];
  for (let d = fromAgo; d >= toAgo; d--) {
    const base = { day: day(d), source_dim: perDay.source ?? "ai", signal: 1 };
    out.push({
      ...base,
      arm: "treat",
      visits: perDay.tv,
      converting_visits: perDay.tc,
      applied_visits: perDay.tv - 1,
      applied_converting_visits: perDay.tc,
    });
    out.push({
      ...base,
      arm: "holdout",
      visits: perDay.hv,
      converting_visits: perDay.hc,
      applied_visits: 0,
      applied_converting_visits: 0,
    });
    if (perDay.none)
      out.push({
        ...base,
        arm: "none",
        visits: perDay.none,
        converting_visits: 0,
        applied_visits: perDay.none,
        applied_converting_visits: 0,
      });
  }
  return out;
}

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    customerId: "acme",
    now: NOW,
    superadmin: false,
    tests: [test()],
    outcomes: [],
    mixedByDay: {},
    labels: ["Start free"],
    ...over,
  };
}

/** En and em dashes, never in what a customer reads (the founder's rule). */
const NO_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
/** A 20% test started 70 days ago whose read date is today. */
const READ_TEST = test({ started_at: dayStart(day(70)), read_date: day(0), read_fixed_at: 1 });

describe("states", () => {
  it("off: no test, an estimate of the read time from the last 30 days", () => {
    const r = buildLiftReport(
      input({ tests: [], outcomes: days(30, 1, { tv: 0, tc: 0, hv: 0, hc: 0, none: 200 }) }),
    );
    expect(r.title).toBe("What the versions did");
    expect(r.state).toBe("off");
    expect(r.arms).toBeNull();
    expect(r.estimate?.percent).toBe(20);
    expect(r.estimate?.rate_source).toBe("default");
    expect(r.estimate?.weeks).toBeGreaterThan(0);
    expect(r.sentence).toContain("No test is running");
  });

  it("starting: switched on today, nothing closed yet", () => {
    const r = buildLiftReport(input({ tests: [test({ started_at: NOW - 60_000 })] }));
    expect(r.state).toBe("starting");
    expect(r.lift).toBeNull();
    expect(r.sentence).toContain("1 in 5");
  });

  it("not enough: 9 clicks in the original group, no range, the counts shown", () => {
    const r = buildLiftReport(
      input({
        tests: [test({ started_at: dayStart(day(3)) })],
        outcomes: days(3, 1, { tv: 100, tc: 10, hv: 25, hc: 3 }),
      }),
    );
    expect(r.state).toBe("not_enough");
    expect(r.lift).toBeNull();
    expect(r.needs).toEqual({ treat: 0, holdout: 1 });
    expect(r.arms?.holdout).toEqual({ visits: 75, converting_visits: 9, rate: 0.12 });
    expect(r.sentence).toContain("9 of the 75 visits that saw your original clicked Start free");
    expect(r.extra_clicks).toBeNull();
  });

  it("interim: a range marked interim, no verdict and no extra clicks before the read date", () => {
    const r = buildLiftReport(
      input({
        outcomes: days(70, 1, { tv: 80, tc: 8, hv: 20, hc: 2 }).map((o) => o),
        tests: [test({ started_at: dayStart(day(25)), read_date: day(-40), read_fixed_at: 1 })],
      }),
    );
    expect(r.state).toBe("interim");
    expect(r.verdict).toBeNull();
    expect(r.lift?.interim).toBe(true);
    expect(r.extra_clicks).toBeNull();
    expect(r.as_treated).toBeNull();
    expect(r.sentence).toMatch(/^Interim, week 4 of \d+\./);
  });

  it("held back: a 30/70 split at a set 20% hides rates and range, and says why", () => {
    const r = buildLiftReport(
      input({
        superadmin: true,
        tests: [test({ started_at: dayStart(day(20)) })],
        outcomes: days(20, 1, { tv: 70, tc: 7, hv: 30, hc: 3 }),
      }),
    );
    expect(r.state).toBe("held_back");
    expect(r.held_back_reason).toBe("split");
    expect(r.lift).toBeNull();
    expect(r.arms?.treat.rate).toBeNull();
    expect(r.checks?.split_ok).toBe(false);
    expect(r.checks?.split_p ?? 1).toBeLessThan(0.001);
    expect(r.sentence).toContain("The split looks off");
  });

  it("held back: over 5% of eligible visits without an arm", () => {
    const r = buildLiftReport(
      input({
        tests: [test({ started_at: dayStart(day(20)) })],
        outcomes: days(20, 1, { tv: 80, tc: 8, hv: 20, hc: 2, none: 10 }),
      }),
    );
    expect(r.state).toBe("held_back");
    expect(r.held_back_reason).toBe("uncounted");
  });

  it("result, positive: green only now, the extra clicks and the as-treated line", () => {
    const r = buildLiftReport(
      input({ tests: [READ_TEST], outcomes: days(70, 1, { tv: 160, tc: 16, hv: 40, hc: 3 }) }),
    );
    expect(r.state).toBe("result");
    expect(r.verdict).toBe("positive");
    expect(r.lift?.interim).toBe(false);
    expect(r.lift?.low ?? 0).toBeGreaterThan(0);
    expect(r.extra_clicks?.value ?? 0).toBeGreaterThan(0);
    expect(r.as_treated?.left_out_visits).toBe(70);
    expect(r.sentence).toMatch(
      /^Visits that saw Rawuser's versions clicked Start free \d+% more often/,
    );
  });

  it("result, no difference: never 'no effect', no extra clicks", () => {
    const r = buildLiftReport(
      input({ tests: [READ_TEST], outcomes: days(70, 1, { tv: 80, tc: 8, hv: 20, hc: 2 }) }),
    );
    expect(r.verdict).toBe("no_difference");
    expect(r.extra_clicks).toBeNull();
    expect(r.sentence).toMatch(/^We did not find a difference\./);
    expect(r.sentence).not.toMatch(/no effect|it works/i);
  });

  it("result, negative: fewer clicks, the recommendation to pause", () => {
    const r = buildLiftReport(
      input({ tests: [READ_TEST], outcomes: days(70, 1, { tv: 160, tc: 8, hv: 40, hc: 4 }) }),
    );
    expect(r.verdict).toBe("negative");
    expect(r.extra_clicks?.value ?? 0).toBeLessThan(0);
    expect(r.sentence).toContain("less often");
    expect(r.sentence).toContain("pausing the versions");
  });

  it("result without 10 clicks per group is inconclusive", () => {
    const r = buildLiftReport(
      input({ tests: [READ_TEST], outcomes: days(70, 62, { tv: 10, tc: 1, hv: 4, hc: 1 }) }),
    );
    expect(r.verdict).toBe("inconclusive");
    expect(r.lift).toBeNull();
  });

  it("the result is frozen at the read date: later days do not move it", () => {
    const at = buildLiftReport(
      input({ tests: [READ_TEST], outcomes: days(70, 1, { tv: 160, tc: 16, hv: 40, hc: 3 }) }),
    );
    const later = buildLiftReport(
      input({
        now: NOW + 7 * DAY_MS,
        tests: [READ_TEST],
        outcomes: [
          ...days(70, 1, { tv: 160, tc: 16, hv: 40, hc: 3 }),
          ...days(0, -6, { tv: 160, tc: 1, hv: 40, hc: 30 }),
        ],
      }),
    );
    expect(later.arms).toEqual(at.arms);
    expect(later.lift).toEqual(at.lift);
  });

  it("ended after the read date: the result as read, with one line about the versions being back", () => {
    const r = buildLiftReport(
      input({
        tests: [{ ...READ_TEST, ended_at: NOW - DAY_MS / 2 }],
        outcomes: days(70, 1, { tv: 160, tc: 16, hv: 40, hc: 3 }),
      }),
    );
    expect(r.state).toBe("ended");
    expect(r.verdict).toBe("positive");
    expect(r.sentence).toMatch(
      /^Test ended on .+ Every visit with a signal gets a version again\. The result as read on/,
    );
  });

  it("ended before the read date: inconclusive, with today's range", () => {
    const r = buildLiftReport(
      input({
        tests: [
          test({
            started_at: dayStart(day(40)),
            read_date: day(-30),
            read_fixed_at: 1,
            ended_at: dayStart(day(1)) + 3600_000,
          }),
        ],
        outcomes: days(40, 1, { tv: 80, tc: 8, hv: 20, hc: 2 }),
      }),
    );
    expect(r.state).toBe("ended_early");
    expect(r.verdict).toBe("inconclusive");
    expect(r.sentence).toMatch(/^Inconclusive at the end of the test\./);
  });
});

describe("the read date", () => {
  it("is an estimate before day 14, fixable once 14 whole days have closed", () => {
    const t13 = test({ started_at: dayStart(day(13)) });
    const p13 = periodOf([t13], NOW);
    expect(p13).not.toBeNull();
    expect(
      readDateOf(p13 as NonNullable<typeof p13>, days(13, 1, { tv: 400, tc: 32, hv: 100, hc: 8 }))
        .fixable,
    ).toBe(false);
    const t14 = test({ started_at: dayStart(day(14)) });
    const p14 = periodOf([t14], NOW) as NonNullable<ReturnType<typeof periodOf>>;
    const r = readDateOf(p14, days(14, 1, { tv: 400, tc: 32, hv: 100, hc: 8 }));
    expect(r.fixable).toBe(true);
    expect(r.readDate).not.toBeNull();
    // A stored date wins and never moves.
    const fixed = readDateOf({ ...p14, test: { ...t14, read_date: "2027-01-04" } }, []);
    expect(fixed).toEqual({ readDate: "2027-01-04", fixed: true, fixable: false });
  });

  it("no verdict before the read date, however clear the range", () => {
    const r = buildLiftReport(
      input({
        tests: [test({ started_at: dayStart(day(30)), read_date: day(-1), read_fixed_at: 1 })],
        outcomes: days(30, 1, { tv: 400, tc: 80, hv: 100, hc: 8 }),
      }),
    );
    expect(r.state).toBe("interim");
    expect(r.verdict).toBeNull();
  });

  it("a test that follows another on the same day reads from the next whole day", () => {
    const prev = test({
      id: "ht0",
      started_at: dayStart(day(30)),
      ended_at: dayStart(day(10)) + 9 * 3600_000,
    });
    const next = test({ id: "ht1", started_at: dayStart(day(10)) + 9 * 3600_000 + 600_000 });
    expect(periodOf([prev, next], NOW)?.firstDay).toBe(day(9));
    const fresh = test({ started_at: dayStart(day(10)) + 9 * 3600_000 });
    expect(periodOf([fresh], NOW)?.firstDay).toBe(day(10));
  });
});

describe("who sees what", () => {
  it("the checks row is for a superadmin only", () => {
    const outcomes = days(20, 1, { tv: 80, tc: 8, hv: 20, hc: 2 });
    const customer = buildLiftReport(input({ outcomes }));
    const admin = buildLiftReport(input({ outcomes, superadmin: true }));
    expect(customer).not.toHaveProperty("checks");
    expect(admin.checks).toMatchObject({ split_set: 0.2, split_ok: true, mixed_visits: 0 });
  });

  it("by source: a range only where each group has 10 clicks", () => {
    const r = buildLiftReport(
      input({
        tests: [READ_TEST],
        outcomes: [
          ...days(70, 1, { tv: 160, tc: 16, hv: 40, hc: 3, source: "ai" }),
          ...days(3, 1, { tv: 10, tc: 1, hv: 3, hc: 1, source: "social" }),
        ],
      }),
    );
    const ai = r.by_source.find((s) => s.source_dim === "ai");
    const social = r.by_source.find((s) => s.source_dim === "social");
    expect(ai?.range).not.toBeNull();
    expect(social?.range).toBeNull();
  });

  it("no sentence in any state carries an em or en dash", () => {
    const fixtures: ReportInput[] = [
      input({ tests: [] }),
      input({ tests: [test({ started_at: NOW - 1000 })] }),
      input({ outcomes: days(20, 1, { tv: 80, tc: 8, hv: 20, hc: 2 }) }),
      input({ tests: [READ_TEST], outcomes: days(70, 1, { tv: 160, tc: 16, hv: 40, hc: 3 }) }),
      input({ tests: [READ_TEST], outcomes: days(70, 1, { tv: 160, tc: 8, hv: 40, hc: 4 }) }),
    ];
    for (const f of fixtures) {
      const r = buildLiftReport(f);
      expect(r.sentence).not.toMatch(NO_DASHES);
      expect(r.limits).not.toMatch(NO_DASHES);
    }
  });
});

describe("the weekly draft", () => {
  it("is a draft, never sent by the code; a negative one tells the founder to write first", () => {
    const neg = buildLiftReport(
      input({ tests: [READ_TEST], outcomes: days(70, 1, { tv: 160, tc: 8, hv: 40, hc: 4 }) }),
    );
    const d = buildWeeklyDraft(neg, "brisk.test", "2026-11-15", "https://app.example.com");
    expect(d.send).toBe("draft");
    expect(d.subject).toBe("brisk.test: the versions did worse, pausing them");
    expect(d.text.startsWith("DRAFT ONLY")).toBe(true);
    expect(d.text).not.toMatch(NO_DASHES);
  });

  it("interim and positive subjects", () => {
    const pos = buildLiftReport(
      input({ tests: [READ_TEST], outcomes: days(70, 1, { tv: 160, tc: 16, hv: 40, hc: 3 }) }),
    );
    expect(buildWeeklyDraft(pos, "brisk.test", "2026-11-15", undefined).subject).toMatch(
      /^brisk\.test: the versions lifted Start free by \d+%$/,
    );
    const interim = buildLiftReport(
      input({
        tests: [test({ started_at: dayStart(day(25)), read_date: day(-40), read_fixed_at: 1 })],
        outcomes: days(25, 1, { tv: 80, tc: 8, hv: 20, hc: 2 }),
      }),
    );
    expect(buildWeeklyDraft(interim, "brisk.test", "2026-11-15", undefined).subject).toMatch(
      /^brisk\.test, week 4 of \d+$/,
    );
  });

  it("reads closed days to the Sunday before", () => {
    // 2026-11-20 is a Friday; the Monday before is the 16th, the Sunday the 15th.
    expect(weekCut(NOW)).toEqual({
      asOf: Date.parse("2026-11-16T00:00:00Z"),
      weekEnding: "2026-11-15",
    });
  });
});

// 2026-10-04: before the outcomes backfill only three closed days existed, and
// dividing them by 30 days made a pilot site's estimate 1,265 weeks.
describe("baselineOf counts only the days that have rows", () => {
  it("three days of rows read as three days, not thirty", async () => {
    const { baselineOf } = await import("../../src/lib/proof-report.ts");
    const rows: OutcomeLite[] = ["2026-10-01", "2026-10-02", "2026-10-03"].map((d) => ({
      day: d,
      arm: "none",
      source_dim: "social",
      signal: 1,
      visits: 30,
      converting_visits: 1,
      applied_visits: 30,
    })) as OutcomeLite[];
    const b = baselineOf(rows, "2026-09-04", "2026-10-03");
    expect(b.days).toBe(3);
    expect(b.eligible_visits / b.days).toBe(30);
  });
});

// The customer's own test (docs/specs/proof-engine.md, "The customer's own
// test"): the report says whether a start would pass and the read date it
// would get, by the running test's own rule.
describe("start: what the setup steps need", () => {
  const traffic = days(30, 1, { tv: 0, tc: 0, hv: 0, hc: 0, none: 200 });
  const startedNow = (now: number, over: Partial<ReportInput> = {}) =>
    buildLiftReport(
      input({
        now,
        outcomes: traffic,
        tests: [
          ...(over.tests ?? []),
          test({ id: "new", started_at: now + 10 * 60_000, ended_at: null }),
        ],
      }),
    );

  it("is in every state", () => {
    expect(buildLiftReport(input({ tests: [] })).start).toBeDefined();
    expect(buildLiftReport(input()).start?.blocked).toBe("running");
    expect(buildLiftReport(input({ tests: [READ_TEST] })).start).toMatchObject({
      can_start: false,
      blocked: "running",
      read_date: null,
    });
  });

  it("off with a button: the start passes, and its read date is the one the started test gets", () => {
    const off = buildLiftReport(input({ tests: [], outcomes: traffic }));
    expect(off.start).toMatchObject({ counted_buttons: 1, can_start: true, blocked: null });
    expect(off.start?.estimate).toEqual(off.estimate);
    expect(off.start?.read_date).toBe(startedNow(NOW).test?.read_date);
  });

  it("ten minutes before midnight UTC the test reads from the next day, and so does the promise", () => {
    const late = Date.parse("2026-11-20T23:55:00Z");
    const off = buildLiftReport(input({ now: late, tests: [], outcomes: traffic }));
    const started = startedNow(late);
    expect(started.test?.first_day).toBe("2026-11-21");
    expect(off.start?.read_date).toBe(started.test?.read_date);
  });

  it("after a test ended today the new one reads from tomorrow, and the promise says so", () => {
    const ended = test({ started_at: dayStart(day(40)), ended_at: NOW - 60_000 });
    const off = buildLiftReport(input({ tests: [ended], outcomes: traffic }));
    expect(off.state).toBe("ended_early");
    expect(off.start?.can_start).toBe(true);
    const started = startedNow(NOW, { tests: [ended] });
    expect(started.test?.first_day).toBe(day(-1));
    expect(off.start?.read_date).toBe(started.test?.read_date);
  });

  it("no button, then too little traffic, block in that order", () => {
    expect(
      buildLiftReport(input({ tests: [], labels: [], outcomes: traffic })).start,
    ).toMatchObject({ counted_buttons: 0, can_start: false, blocked: "no_button" });
    const thin = days(30, 1, { tv: 0, tc: 0, hv: 0, hc: 0, none: 1 });
    const r = buildLiftReport(input({ tests: [], outcomes: thin }));
    expect(r.start?.estimate.weeks).toBeGreaterThan(52);
    expect(r.start).toMatchObject({ can_start: false, blocked: "too_little_traffic" });
    expect(buildLiftReport(input({ tests: [], labels: [], outcomes: thin })).start?.blocked).toBe(
      "no_button",
    );
  });

  it("counts enabled buttons, not distinct labels", () => {
    const r = buildLiftReport(input({ tests: [], labels: ["Start free"], countedButtons: 2 }));
    expect(r.start?.counted_buttons).toBe(2);
  });
});
