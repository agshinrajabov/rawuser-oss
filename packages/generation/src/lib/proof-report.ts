/**
 * The lift report (docs/specs/proof-engine.md, D and G): what the card
 * "What the versions did", the weekly draft and the hourly checks read.
 *
 * Read from exposure_outcomes (closed UTC days only, never events, never a
 * marker), per customer. Intent-to-treat: every visit as the coin assigned
 * it; a visit converts when it clicked a confirmed button on any page.
 * Wilson per arm and the log-ratio range (computeLift), shown only when each
 * arm has 30 visits and 10 converting visits. A read date set in advance:
 * estimated when the test starts, recomputed once on day 15 from the
 * test's own numbers and then fixed; before it every number is interim.
 *
 * What the numbers do not mean (the limits line): clicks on confirmed
 * buttons, not signups or revenue; visits with a signal and a written
 * version, not the whole site; this period, not the future.
 *
 * The two groups (docs/specs/late-tag.md, "What is counted and shown";
 * privacy review Q2, condition 6). A page that was painted before our
 * script ran stays as built, in both arms, and its exposure carries the bit
 * `lp`. When more than 5% of the test's visits had it on their first
 * exposure, the report gives, beside the headline (unchanged, every visit
 * the coin assigned), the visits painted first and the rest, each with its
 * own two arms. A group's lift is shown only on the read date and only with
 * 30 visits and 10 converting visits per arm in that group: never an
 * interim one, never a "directional" one, and under the gate counts only,
 * no rate.
 *
 * Why a group is still a randomized comparison. The arm is a hash of the
 * customer and the visit marker. The bit is `tagIsLate`, decided when our
 * script starts, before /select is asked, from the page's own load order;
 * and the exposure that carries it is the visit's first with an arm, before
 * which both arms were served the same pages the same way (a page without a
 * version gets no arm and is the page as built for everyone). So the bit is
 * fixed before the arm can change anything, the same share of each arm is
 * painted first, and comparing treat with holdout inside a group compares
 * like with like. The first exposure decides the group for the whole visit,
 * as it decides the row: a visit painted first on its landing and written on
 * page two is in the painted-first group, and its treat arm did see versions
 * (later pages), which is what that group's lift measures. The holdout arm
 * of that group exists only because the bit is recorded in both arms. If
 * the two groups do not hold the set share of holdout visits (the split
 * check, per group), the bit is being recorded unevenly and no group is
 * compared.
 */

import {
  type ArmCounts,
  CUSTOMER_TEST_PERCENT,
  type LiftRange,
  type LiftReport,
  MAX_READ_WEEKS,
  MIN_CONVERSIONS,
  PROOF_CARD_TITLE,
  type ProofChecks,
  type ProofState,
  type ProofVerdict,
  type ReadEstimate,
  type SourceRow,
  type TestEndReason,
  type TestPeriod,
  type TestStart,
  type TestStartedBy,
} from "@rawuser/shared";
import { DAY_MS, dayOf, dayStart } from "../cron/exposure-rollup.ts";
import {
  MIN_SAMPLE,
  SPLIT_P_THRESHOLD,
  WEEKS_PER_MONTH,
  computeGatedLift,
  newcombeDiff,
  readableLift,
  sampleSizeTotal,
  splitCheck,
} from "./lift.ts";

/** A test starts reading this long after the change: KV reaches every colo, the edge's 300 s cache expires. */
export const HOLDOUT_SETTLE_MS = 10 * 60 * 1000;

/** The base rate when a customer has too few clicks of its own (spec D). */
export const DEFAULT_RATE = 0.03;
/** The read date is fixed once this many whole days of the test have closed. */
export const READ_FIX_DAYS = 14;
/** From this many closed days the estimate comes from the test's own visits (measure-at-go-live.md §5). */
export const READ_OWN_DAYS = 7;
/** Over this share of eligible visits without an arm, the result is held back. */
export const UNCOUNTED_LIMIT = 0.05;
/** The uncounted share is judged only from this many eligible visits on. */
const UNCOUNTED_MIN_VISITS = 100;
/** A measured base rate needs this many converting visits. */
const BASELINE_MIN_CONVERSIONS = 10;

/** Over this share of the test's visits painted first, the report gives the two groups. */
export const LATE_TAG_SHOW_SHARE = 0.05;

/**
 * Why a group has no lift, the first that applies:
 * - held_back: the whole result is held back (the split or the uncounted share);
 * - split: inside the groups the holdout share is off, so the bit was recorded unevenly;
 * - ended_early: the test stopped before its read date;
 * - read_date: the read date has not come;
 * - clicks: the read date came without 30 visits and 10 converting visits per arm in this group.
 */
export type GroupWait = "held_back" | "split" | "ended_early" | "read_date" | "clicks";

/** One of the two groups: its own two arms, intent-to-treat inside it. */
export interface LateTagGroup {
  /** Counts in every state. `rate` only where `lift` is shown, else null. */
  treat: ArmCounts;
  holdout: ArmCounts;
  /** Converting visits still missing per arm to reach 10 in this group (0 when reached). */
  needs: { treat: number; holdout: number };
  /** Only on result and ended, and only past the gate in this group. No verdict, no significance mark. */
  lift: LiftRange | null;
  waits_for: GroupWait | null;
  /** One plain line. No dashes. */
  sentence: string;
}

/** The lift report's `late_tag` (docs/specs/late-tag.md; proof-engine.md, section G). */
export interface LateTagGroups {
  /** Visits the coin assigned in the days the report reads. */
  visits: number;
  /** Of them, visits whose first exposure had `lp`: the page was painted before our script ran. */
  late_visits: number;
  /** late_visits / visits; null at no visits. */
  share: number | null;
  /** share is over 5%: `groups` is given. */
  shown: boolean;
  /** The visits painted first (`late`) and the rest (`in_time`); null when not shown. */
  groups: { late: LateTagGroup; in_time: LateTagGroup } | null;
  /** One plain line above the two groups; null when not shown. */
  sentence: string | null;
  /** Superadmin sessions only: the split check inside each group. */
  checks?: {
    late_split_seen: number | null;
    late_split_p: number | null;
    in_time_split_seen: number | null;
    in_time_split_p: number | null;
    split_ok: boolean;
  };
}

/**
 * The second line, "on pages that have versions" (docs/specs/proof-engine.md,
 * "Visits that never met a version", option 3; page-groups.md, privacy review
 * condition 8). The headline's arms hold every visit the coin assigned, and
 * on a site like the pilot's two thirds of them never met a version (the edge
 * tried the homepage's body on a product page), which dilutes the lift. This
 * line is the same two arms restricted to the visits whose first exposure
 * with an arm was on a page with versions of its own: the row's page is the
 * page its `body_id` belongs to in version_bodies, so the class is fixed
 * before the arm could matter and the comparison stays randomized. Read
 * from exposure_outcomes after the rollup, per customer, counts only; the
 * marker join is not widened. A visit that landed on a page without
 * versions and read the homepage's version later is not in the class
 * (its row is the landing's). A row without a body id cannot be classed and
 * is left out. Its conversions are the visit's, on any page. Its own gate
 * (30 visits and 10 converting visits per arm in the class) and the read
 * date only, never interim: the same code path as the late tag's groups.
 */
export interface OnVersionedLine {
  /** Counts in every state. `rate` only where `lift` is shown, else null. */
  treat: ArmCounts;
  holdout: ArmCounts;
  /** Both arms have 30 visits and 10 converting visits in the class. */
  enough: boolean;
  /** Only on result and ended, past the gate, with the split inside the class in order. */
  lift: LiftRange | null;
  waits_for: GroupWait | null;
  /** One plain line. No dashes. */
  sentence: string;
}

/**
 * LiftReport with the two groups and the second line. Additive: `late_tag`
 * and `on_versioned` are null with no test and before the first closed
 * day. The shared type (packages/shared proof.ts) gains the fields when the
 * dashboard reads them.
 */
export type LateTagLiftReport = LiftReport & {
  late_tag: LateTagGroups | null;
  on_versioned: OnVersionedLine | null;
};

/**
 * The limits line, true as built (proof-engine.md, "Visits that never met a
 * version"): a visit with a signal gets an arm on any page the edge tried a
 * version on, the homepage's body on a page without versions of its own
 * included, so the headline covers more than visits with a written version.
 */
export const LIMITS_LINE =
  "Counts clicks on your confirmed buttons, not signups or revenue. Covers visits that had a signal and were put in the test, on pages without versions of their own too, not your whole site. Says what happened in this period, not what will happen.";

export interface TestRow {
  id: string;
  customer_id: string;
  percent: number;
  started_at: number;
  ended_at: number | null;
  read_date: string | null;
  read_fixed_at: number | null;
  /** Migration 0036; absent or null on older rows. */
  started_by?: TestStartedBy | null;
  started_actor?: string | null;
  end_reason?: TestEndReason | null;
  ended_actor?: string | null;
}

/** exposure_outcomes summed by day, arm, source and whether the visit had a signal. */
export interface OutcomeLite {
  day: string;
  arm: "treat" | "holdout" | "none";
  source_dim: string;
  /** 1 when intent_dim is not 'none': a visit with a signal (and, for 'none', a version). */
  signal: number;
  visits: number;
  converting_visits: number;
  applied_visits: number;
  applied_converting_visits: number;
  /** Of visits: the first exposure had `lp` (migration 0041). Absent reads as 0. */
  lp_visits?: number;
  /** Of converting_visits: the first exposure had `lp`. Absent reads as 0. */
  lp_converting_visits?: number;
}

/** exposure_outcomes summed by day and arm over the rows whose page is the page of their body: the class of the second line. */
export interface OwnPageLite {
  day: string;
  arm: "treat" | "holdout";
  visits: number;
  converting_visits: number;
}

export interface ReportInput {
  customerId: string;
  now: number;
  superadmin: boolean;
  /** Every test period of the customer, oldest first. */
  tests: TestRow[];
  /** Rows from 30 days before the latest test's first day (or before today) to yesterday. */
  outcomes: OutcomeLite[];
  /** The same days, the arms on pages with versions of their own (OwnPageLite). Absent reads as none. */
  ownOutcomes?: OwnPageLite[];
  mixedByDay: Record<string, number>;
  /** Display labels of the enabled conversion targets. */
  labels: string[];
  /** How many conversion targets are enabled (labels are deduplicated); defaults to labels.length. */
  countedButtons?: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const addDays = (day: string, n: number) => dayOf(dayStart(day) + n * DAY_MS);
const daysBetween = (from: string, toExclusive: string) =>
  Math.round((dayStart(toExclusive) - dayStart(from)) / DAY_MS);

function counts(visits: number, converting: number): ArmCounts {
  return { visits, converting_visits: converting, rate: visits > 0 ? converting / visits : null };
}

function inWindow(rows: OutcomeLite[], from: string, to: string): OutcomeLite[] {
  return rows.filter((r) => r.day >= from && r.day <= to);
}

function sum(rows: OutcomeLite[], pick: (r: OutcomeLite) => number): number {
  let n = 0;
  for (const r of rows) n += Number(pick(r)) || 0;
  return n;
}

/** Visits with a signal and a written (or skipped) version: the test's population. */
function eligible(rows: OutcomeLite[]): OutcomeLite[] {
  return rows.filter((r) => r.arm !== "none" || r.signal === 1);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : "-"}${Math.abs(Math.round(x * 100))}%`;
const rate1 = (x: number | null) => (x === null ? "no visits" : `${(x * 100).toFixed(1)}%`);
const num = (n: number) => Math.round(n).toLocaleString("en-US");
const oneIn = (percent: number) => `1 in ${Math.round(100 / percent)}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(day: string): string {
  const d = new Date(dayStart(day));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The read date: the day after the last day the test needs, from its first day. */
export function readDateFrom(
  firstDay: string,
  percent: number,
  rate: number,
  eligiblePerDay: number,
): string | null {
  const n = sampleSizeTotal(rate, percent / 100);
  if (n === null || !(eligiblePerDay > 0)) return null;
  return addDays(firstDay, Math.max(1, Math.ceil(n / eligiblePerDay)));
}

/** The base rate and eligible traffic over a window of closed days. */
export function baselineOf(
  rows: OutcomeLite[],
  from: string,
  to: string,
): { eligible_visits: number; days: number; rate: number; rate_source: "measured" | "default" } {
  const all = inWindow(rows, from, to);
  const el = eligible(all);
  const visits = sum(el, (r) => r.visits);
  const converting = sum(el, (r) => r.converting_visits);
  const measured = converting >= BASELINE_MIN_CONVERSIONS && visits > 0;
  // Divide by the days that have rows, not the whole window: before the
  // outcomes backfill only the last few closed days exist, and dividing 3
  // days of traffic by 30 made a pilot site's estimate 1,265 weeks (2026-10-04).
  const daysWithRows = new Set(all.map((r) => r.day)).size;
  return {
    eligible_visits: visits,
    days: Math.max(1, Math.min(daysWithRows, daysBetween(from, addDays(to, 1)))),
    rate: measured ? converting / visits : DEFAULT_RATE,
    rate_source: measured ? "measured" : "default",
  };
}

/** "If a test started now" at `percent`, from a baseline. */
export function estimateFor(
  base: {
    eligible_visits: number;
    days: number;
    rate: number;
    rate_source: "measured" | "default";
  },
  percent: number,
): ReadEstimate {
  const perMonth = (base.eligible_visits / base.days) * 30;
  const weeks =
    perMonth > 0
      ? (() => {
          const n = sampleSizeTotal(base.rate, percent / 100);
          return n === null ? null : Math.ceil((n / perMonth) * WEEKS_PER_MONTH);
        })()
      : null;
  return {
    percent,
    weeks,
    eligible_per_month: Math.round(perMonth),
    baseline_rate: base.rate,
    rate_source: base.rate_source,
  };
}

function range(l: {
  lift: number | null;
  ci_lower: number | null;
  ci_upper: number | null;
}): LiftRange | null {
  return l.lift === null || l.ci_lower === null || l.ci_upper === null
    ? null
    : { value: l.lift, low: l.ci_lower, high: l.ci_upper };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface ReportPeriod {
  test: TestRow;
  firstDay: string;
  /** Last closed day of the test so far (may be before firstDay). */
  lastDay: string;
}

/** The latest test, the first whole day it reads and its last closed day. */
export function periodOf(tests: TestRow[], now: number): ReportPeriod | null {
  const test = tests[tests.length - 1];
  if (!test) return null;
  const prev = tests[tests.length - 2];
  const startDay = dayOf(test.started_at);
  // A day's rows cannot be split by time: when the previous test still had
  // arms on the start day, this test reads from the next whole day.
  const firstDay =
    prev && (prev.ended_at === null || prev.ended_at >= dayStart(startDay))
      ? addDays(startDay, 1)
      : startDay;
  const yesterday = addDays(dayOf(now), -1);
  let lastDay = yesterday;
  if (test.ended_at !== null && dayOf(test.ended_at) < lastDay) lastDay = dayOf(test.ended_at);
  return { test, firstDay, lastDay };
}

/** The read date for a test: fixed if stored, else the current estimate, and whether it can be fixed now. */
export function readDateOf(
  period: ReportPeriod,
  outcomes: OutcomeLite[],
): { readDate: string | null; fixed: boolean; fixable: boolean } {
  const { test, firstDay, lastDay } = period;
  if (test.read_date) return { readDate: test.read_date, fixed: true, fixable: false };
  const daysRead = lastDay >= firstDay ? daysBetween(firstDay, addDays(lastDay, 1)) : 0;
  if (daysRead >= READ_OWN_DAYS) {
    // From the test's own numbers: the holdout arm's rate and the eligible
    // visits per day it saw. Provisional ("around") from day 7, fixed once
    // on day 14 (measure-at-go-live.md §5).
    const rows = inWindow(outcomes, firstDay, lastDay);
    const hold = rows.filter((r) => r.arm === "holdout");
    const hv = sum(hold, (r) => r.visits);
    const hc = sum(hold, (r) => r.converting_visits);
    const base = baselineOf(outcomes, addDays(firstDay, -30), addDays(firstDay, -1));
    const rate = hc >= BASELINE_MIN_CONVERSIONS && hv > 0 ? hc / hv : base.rate;
    const perDay = sum(eligible(rows), (r) => r.visits) / daysRead;
    return {
      readDate: readDateFrom(firstDay, test.percent, rate, perDay),
      fixed: false,
      fixable: daysRead >= READ_FIX_DAYS,
    };
  }
  const base = baselineOf(outcomes, addDays(firstDay, -30), addDays(firstDay, -1));
  return {
    readDate: readDateFrom(firstDay, test.percent, base.rate, base.eligible_visits / base.days),
    fixed: false,
    fixable: false,
  };
}

/**
 * What a customer's own start would do now (docs/specs/proof-engine.md,
 * "The customer's own test"): the same 20% estimate the off state shows, and
 * the read date a test started now would get, by the running test's own
 * rule (periodOf on the test list with the new test appended, readDateOf
 * before its first day closes), so the date before Start test equals the
 * date right after it.
 */
export function testStartOf(input: ReportInput): TestStart {
  const { customerId, now, tests, outcomes } = input;
  const counted = input.countedButtons ?? input.labels.length;
  const today = dayOf(now);
  const estimate = estimateFor(
    baselineOf(outcomes, addDays(today, -30), addDays(today, -1)),
    CUSTOMER_TEST_PERCENT,
  );
  const running = tests.some((t) => t.ended_at === null);
  const blocked: TestStart["blocked"] = running
    ? "running"
    : counted === 0
      ? "no_button"
      : estimate.weeks !== null && estimate.weeks > MAX_READ_WEEKS
        ? "too_little_traffic"
        : null;
  let readDate: string | null = null;
  if (!running) {
    const next: TestRow = {
      id: "next",
      customer_id: customerId,
      percent: CUSTOMER_TEST_PERCENT,
      started_at: now + HOLDOUT_SETTLE_MS,
      ended_at: null,
      read_date: null,
      read_fixed_at: null,
    };
    const period = periodOf([...tests, next], now);
    if (period) readDate = readDateOf(period, outcomes).readDate;
  }
  return {
    counted_buttons: counted,
    can_start: blocked === null,
    blocked,
    estimate,
    read_date: readDate,
  };
}

export function buildLiftReport(input: ReportInput): LateTagLiftReport {
  return { ...reportByState(input), start: testStartOf(input) };
}

const GROUP_LABEL = {
  late: "Where your page appeared first",
  in_time: "Where the versions were ready in time",
} as const;

/**
 * The two groups from the report's rows (the header says why they are
 * randomized comparisons). `mode` is where the test stands: a lift is
 * computed only on `final` (the read date has come), and then only past the
 * gate in the group. Never an interim number.
 */
function lateTagGroups(
  rows: OutcomeLite[],
  percent: number,
  mode: "running" | "held_back" | "ended_early" | "final",
  what: string,
  superadmin: boolean,
): LateTagGroups | null {
  const of = (arm: "treat" | "holdout") => {
    const r = rows.filter((x) => x.arm === arm);
    const visits = sum(r, (x) => x.visits);
    const converting = sum(r, (x) => x.converting_visits);
    const lateVisits = sum(r, (x) => x.lp_visits ?? 0);
    const lateConverting = sum(r, (x) => x.lp_converting_visits ?? 0);
    return {
      late: { v: lateVisits, c: lateConverting },
      in_time: { v: visits - lateVisits, c: converting - lateConverting },
    };
  };
  const t = of("treat");
  const hold = of("holdout");
  const visits = t.late.v + t.in_time.v + hold.late.v + hold.in_time.v;
  if (visits === 0) return null;
  const lateVisits = t.late.v + hold.late.v;
  const share = lateVisits / visits;
  const shown = share > LATE_TAG_SHOW_SHARE;

  const splitOf = (g: "late" | "in_time") =>
    splitCheck(hold[g].v, t[g].v + hold[g].v, percent / 100);
  const lateSplit = splitOf("late");
  const inTimeSplit = splitOf("in_time");
  const splitOk =
    (lateSplit === null || lateSplit.p >= SPLIT_P_THRESHOLD) &&
    (inTimeSplit === null || inTimeSplit.p >= SPLIT_P_THRESHOLD);
  const checks = superadmin
    ? {
        checks: {
          late_split_seen: lateSplit?.seen ?? null,
          late_split_p: lateSplit?.p ?? null,
          in_time_split_seen: inTimeSplit?.seen ?? null,
          in_time_split_p: inTimeSplit?.p ?? null,
          split_ok: splitOk,
        },
      }
    : {};
  if (!shown) {
    return {
      visits,
      late_visits: lateVisits,
      share,
      shown,
      groups: null,
      sentence: null,
      ...checks,
    };
  }

  const group = (g: "late" | "in_time"): LateTagGroup => {
    const tv = t[g].v;
    const tc = t[g].c;
    const hv = hold[g].v;
    const hc = hold[g].c;
    const gated = mode === "final" && splitOk ? range(computeGatedLift(tv, tc, hv, hc)) : null;
    const waits: GroupWait | null =
      mode === "held_back"
        ? "held_back"
        : !splitOk
          ? "split"
          : mode === "ended_early"
            ? "ended_early"
            : mode === "running"
              ? "read_date"
              : gated === null
                ? "clicks"
                : null;
    const countsLine = `${num(tc)} of the ${num(tv)} visits in the versions group clicked ${what}, and ${num(hc)} of the ${num(hv)} in the original group.`;
    const tail =
      waits === null && gated
        ? g === "late"
          ? `${signed(gated.value)} (range ${signed(gated.low)} to ${signed(gated.high)}). The first page stayed as you built it, so this is what the versions did on the pages after it.`
          : `${signed(gated.value)} (range ${signed(gated.low)} to ${signed(gated.high)}).`
        : waits === "read_date"
          ? `${countsLine} Compared on the read date.`
          : waits === "clicks"
            ? `${countsLine} A range needs ${MIN_CONVERSIONS} clicks in each group.`
            : waits === "split"
              ? `${countsLine} The split inside these visits looks off, so they are not compared.`
              : waits === "ended_early"
                ? `${countsLine} The test stopped before its read date, so they are not compared.`
                : countsLine;
    return {
      // Under the gate: counts only, as on a held back result.
      treat: gated ? counts(tv, tc) : { visits: tv, converting_visits: tc, rate: null },
      holdout: gated ? counts(hv, hc) : { visits: hv, converting_visits: hc, rate: null },
      needs: {
        treat: Math.max(0, MIN_CONVERSIONS - tc),
        holdout: Math.max(0, MIN_CONVERSIONS - hc),
      },
      lift: gated,
      waits_for: waits,
      sentence: `${GROUP_LABEL[g]}: ${tail}`,
    };
  };
  return {
    visits,
    late_visits: lateVisits,
    share,
    shown,
    groups: { late: group("late"), in_time: group("in_time") },
    sentence: `On ${pct(share)} of these visits your page appeared before the versions were ready, so that page stayed as you built it. The two kinds of visit are compared apart.`,
    ...checks,
  };
}

const ON_VERSIONED_LABEL = "On pages that have versions";

/**
 * The second line from the class's rows (the header says why it is still a
 * randomized comparison). `mode` as for the late tag's groups: a lift only
 * on `final`, past the gate in the class and with the split in order. Null
 * at no visits in the class.
 */
function onVersionedLine(
  rows: readonly OwnPageLite[],
  percent: number,
  mode: "running" | "held_back" | "ended_early" | "final",
  what: string,
): OnVersionedLine | null {
  let tv = 0;
  let tc = 0;
  let hv = 0;
  let hc = 0;
  for (const r of rows) {
    const v = Number(r.visits) || 0;
    const c = Number(r.converting_visits) || 0;
    if (r.arm === "treat") {
      tv += v;
      tc += c;
    } else if (r.arm === "holdout") {
      hv += v;
      hc += c;
    }
  }
  if (tv + hv === 0) return null;
  const split = splitCheck(hv, tv + hv, percent / 100);
  const splitOk = split === null || split.p >= SPLIT_P_THRESHOLD;
  const enough =
    tv >= MIN_SAMPLE && hv >= MIN_SAMPLE && tc >= MIN_CONVERSIONS && hc >= MIN_CONVERSIONS;
  const gated =
    mode === "final" && splitOk && enough ? range(computeGatedLift(tv, tc, hv, hc)) : null;
  const waits: GroupWait | null =
    mode === "held_back"
      ? "held_back"
      : !splitOk
        ? "split"
        : mode === "ended_early"
          ? "ended_early"
          : mode === "running"
            ? "read_date"
            : gated === null
              ? "clicks"
              : null;
  const countsLine = `${num(tc)} of the ${num(tv)} visits in the versions group clicked ${what}, and ${num(hc)} of the ${num(hv)} in the original group.`;
  const tail =
    waits === null && gated
      ? `${signed(gated.value)} (range ${signed(gated.low)} to ${signed(gated.high)}). Visits whose first page had versions of its own.`
      : waits === "read_date"
        ? `${countsLine} Compared on the read date.`
        : waits === "clicks"
          ? `${countsLine} A range needs ${MIN_SAMPLE} visits and ${MIN_CONVERSIONS} clicks in each group.`
          : waits === "split"
            ? `${countsLine} The split inside these visits looks off, so they are not compared.`
            : waits === "ended_early"
              ? `${countsLine} The test stopped before its read date, so they are not compared.`
              : countsLine;
  return {
    treat: gated ? counts(tv, tc) : { visits: tv, converting_visits: tc, rate: null },
    holdout: gated ? counts(hv, hc) : { visits: hv, converting_visits: hc, rate: null },
    enough,
    lift: gated,
    waits_for: waits,
    sentence: `${ON_VERSIONED_LABEL}: ${tail}`,
  };
}

function reportByState(input: ReportInput): LateTagLiftReport {
  const { customerId, now, superadmin, outcomes, labels } = input;
  const ownOutcomes = input.ownOutcomes ?? [];
  const metric = { kind: "cta_clicks" as const, labels };
  const what = labels.length === 1 ? (labels[0] as string) : "one of your confirmed buttons";
  const base: Omit<LateTagLiftReport, "state" | "sentence"> = {
    customer_id: customerId,
    title: PROOF_CARD_TITLE,
    computed_at: now,
    verdict: null,
    held_back_reason: null,
    metric,
    limits: LIMITS_LINE,
    test: null,
    arms: null,
    needs: null,
    lift: null,
    extra_clicks: null,
    as_treated: null,
    by_source: [],
    estimate: null,
    late_tag: null,
    on_versioned: null,
  };

  const period = periodOf(input.tests, now);
  const today = dayOf(now);
  if (!period) {
    const est = estimateFor(baselineOf(outcomes, addDays(today, -30), addDays(today, -1)), 20);
    return {
      ...base,
      state: "off",
      estimate: est,
      sentence:
        est.weeks === null
          ? "No test is running, so there is no measured result yet. A test shows your original page to 1 in 5 of the visits that would get a version, picked at random, and compares the two groups. There is not enough traffic with a version yet to say how long it would take."
          : `No test is running, so there is no measured result yet. A test shows your original page to 1 in 5 of the visits that would get a version, picked at random, and compares the two groups. At your traffic it takes about ${est.weeks} weeks to read.`,
    };
  }

  const { test, firstDay, lastDay } = period;
  const h = test.percent;
  const read = readDateOf(period, outcomes);
  const readReached = read.readDate !== null && read.readDate <= today;
  const ended = test.ended_at !== null;
  const endedAfterRead =
    ended && read.readDate !== null && dayOf(test.ended_at as number) >= read.readDate;

  // The days the numbers come from: frozen at the read date once it has come.
  const windowEnd =
    read.readDate !== null && (readReached || endedAfterRead)
      ? (() => {
          const beforeRead = addDays(read.readDate as string, -1);
          return beforeRead < lastDay ? beforeRead : lastDay;
        })()
      : lastDay;
  const rows = windowEnd >= firstDay ? inWindow(outcomes, firstDay, windowEnd) : [];
  // The second line's rows: the same days, the class only.
  const ownRows =
    windowEnd >= firstDay ? ownOutcomes.filter((r) => r.day >= firstDay && r.day <= windowEnd) : [];
  const onVersioned = (mode: "running" | "held_back" | "ended_early" | "final") =>
    onVersionedLine(ownRows, h, mode, what);
  const treatRows = rows.filter((r) => r.arm === "treat");
  const holdRows = rows.filter((r) => r.arm === "holdout");
  const tv = sum(treatRows, (r) => r.visits);
  const tc = sum(treatRows, (r) => r.converting_visits);
  const hv = sum(holdRows, (r) => r.visits);
  const hc = sum(holdRows, (r) => r.converting_visits);
  const uncounted = sum(
    rows.filter((r) => r.arm === "none" && r.signal === 1),
    (r) => r.visits,
  );
  let mixed = 0;
  for (const [d, n] of Object.entries(input.mixedByDay))
    if (d >= firstDay && d <= windowEnd) mixed += n;

  const daysTotal = read.readDate ? daysBetween(firstDay, read.readDate) : null;
  const daysRead = windowEnd >= firstDay ? daysBetween(firstDay, addDays(windowEnd, 1)) : 0;
  const perDay = daysRead > 0 ? sum(eligible(rows), (r) => r.visits) / daysRead : 0;
  const holdRate = hv > 0 && hc > 0 ? hc / hv : DEFAULT_RATE;
  const testPeriod: TestPeriod = {
    id: test.id,
    percent: h,
    started_at: test.started_at,
    ended_at: test.ended_at,
    started_by: test.started_by ?? null,
    end_reason: test.end_reason ?? null,
    first_day: firstDay,
    last_day: windowEnd >= firstDay ? windowEnd : null,
    day: Math.max(0, Math.floor((now - test.started_at) / DAY_MS) + 1),
    read_date: read.readDate,
    read_date_fixed: read.fixed,
    weeks_total: daysTotal === null ? null : Math.ceil(daysTotal / 7),
    readable_lift:
      daysTotal === null || perDay === 0
        ? null
        : readableLift(holdRate, h / 100, perDay * daysTotal),
  };

  const split = splitCheck(hv, tv + hv, h / 100);
  const splitOk = split === null || split.p >= SPLIT_P_THRESHOLD;
  const elig = tv + hv + uncounted;
  const uncountedShare = elig > 0 ? uncounted / elig : null;
  const uncountedOk =
    uncountedShare === null || elig < UNCOUNTED_MIN_VISITS || uncountedShare <= UNCOUNTED_LIMIT;
  const checks: ProofChecks = {
    split_set: h / 100,
    split_seen: tv + hv > 0 ? hv / (tv + hv) : null,
    split_p: split?.p ?? null,
    split_ok: splitOk,
    uncounted_share: uncountedShare,
    uncounted_ok: uncountedOk,
    mixed_visits: mixed,
  };

  const gated = computeGatedLift(tv, tc, hv, hc);
  const liftRange = range(gated);
  const bySource = bySourceRows(rows);
  const common = {
    ...base,
    test: testPeriod,
    arms: { treat: counts(tv, tc), holdout: counts(hv, hc) },
    by_source: bySource,
    // Before the read date: counts per group, never a lift.
    late_tag: lateTagGroups(rows, h, "running", what, superadmin),
    on_versioned: onVersioned("running"),
    ...(superadmin ? { checks } : {}),
  };
  const dates = `${num(tv + hv)} visits from ${shortDate(firstDay)} to ${shortDate(windowEnd)}; ${oneIn(h)} saw the original, picked at random.`;

  // Starting: nothing closed yet.
  if (daysRead === 0 && !ended) {
    const est = estimateFor(baselineOf(outcomes, addDays(today, -30), addDays(today, -1)), h);
    return {
      ...common,
      state: "starting",
      estimate: est,
      sentence: `Test running since ${shortDate(dayOf(test.started_at))}. ${oneIn(h)} of the visits that would get a version see your original page instead, picked at random per visit. The first counts show once its first day has closed.`,
    };
  }

  // A check failed: counts only, no rate and no range.
  if (!ended && (!splitOk || !uncountedOk)) {
    const reason = !splitOk ? "split" : "uncounted";
    return {
      ...common,
      state: "held_back",
      held_back_reason: reason,
      arms: {
        treat: { visits: tv, converting_visits: tc, rate: null },
        holdout: { visits: hv, converting_visits: hc, rate: null },
      },
      by_source: [],
      late_tag: lateTagGroups(rows, h, "held_back", what, superadmin),
      on_versioned: onVersioned("held_back"),
      sentence:
        reason === "split"
          ? `The split looks off. We are checking it before showing a result. The test is set to show your original to ${oneIn(h)} visits; so far ${num(hv)} of ${num(tv + hv)} did.`
          : "Too many visits could not be placed in a group. We are checking why before showing a result.",
    };
  }

  const verdictOf = (): ProofVerdict =>
    liftRange === null
      ? "inconclusive"
      : liftRange.low > 0
        ? "positive"
        : liftRange.high < 0
          ? "negative"
          : "no_difference";
  const resultSentence = (v: ProofVerdict): string => {
    if (v === "inconclusive" || liftRange === null)
      return `Inconclusive at the read date: fewer than ${MIN_CONVERSIONS} clicks in a group, so no range can be read. ${num(hc)} of the ${num(hv)} visits that saw your original clicked ${what}, and ${num(tc)} of the ${num(tv)} that saw a version.`;
    if (v === "positive")
      return `Visits that saw Rawuser's versions clicked ${what} ${pct(liftRange.value)} more often than visits that saw your original page (likely between ${pct(liftRange.low)} and ${pct(liftRange.high)} more). ${dates}`;
    if (v === "negative")
      return `Visits that saw the versions clicked ${what} less often, ${pct(-liftRange.value)} fewer (between ${pct(-liftRange.high)} and ${pct(-liftRange.low)} fewer). We recommend pausing the versions while we look at why. ${dates}`;
    return `We did not find a difference. The effect is somewhere between ${signed(liftRange.low)} and ${signed(liftRange.high)}, so the versions may help a little, do nothing, or hurt a little. ${dates}`;
  };
  const resultExtras = (v: ProofVerdict) => {
    const diff = newcombeDiff(tc, tv, hc, hv);
    const appliedRows = treatRows;
    const av = sum(appliedRows, (r) => r.applied_visits);
    const ac = sum(appliedRows, (r) => r.applied_converting_visits);
    return {
      extra_clicks:
        (v === "positive" || v === "negative") && diff
          ? { value: diff.diff * tv, low: diff.low * tv, high: diff.high * tv }
          : null,
      as_treated: {
        applied: counts(av, ac),
        left_out_visits: tv - av,
        lift: range(computeGatedLift(av, ac, hv, hc)),
      },
    };
  };

  if (ended && !endedAfterRead) {
    const endDay = shortDate(dayOf(test.ended_at as number));
    // The automatic ends of a go-live test say why (measure-at-go-live.md §7).
    const automatic =
      test.end_reason === "low_traffic"
        ? `Too little traffic to measure the versions within a year, so the test ended on ${endDay}. Every visit with a signal gets a version again.`
        : test.end_reason === "limit"
          ? `The test ended on ${endDay}, a year after it started, without enough traffic for a result. Every visit with a signal gets a version again.`
          : null;
    return {
      ...common,
      state: "ended_early",
      verdict: "inconclusive",
      lift: liftRange ? { ...liftRange, interim: false } : null,
      late_tag: lateTagGroups(rows, h, "ended_early", what, superadmin),
      on_versioned: onVersioned("ended_early"),
      sentence:
        automatic ??
        (liftRange
          ? `Inconclusive at the end of the test. The test stopped on ${shortDate(dayOf(test.ended_at as number))}, before its read date, with the effect somewhere between ${signed(liftRange.low)} and ${signed(liftRange.high)}. Every visit with a signal gets a version again.`
          : `Inconclusive at the end of the test. The test stopped on ${shortDate(dayOf(test.ended_at as number))}, before its read date, with too few clicks for a range. Every visit with a signal gets a version again.`),
    };
  }

  if (readReached || endedAfterRead) {
    const v = verdictOf();
    const state: ProofState = ended ? "ended" : "result";
    const sentence = ended
      ? `Test ended on ${shortDate(dayOf(test.ended_at as number))}. Every visit with a signal gets a version again. The result as read on ${shortDate(read.readDate as string)}: ${resultSentence(v)}`
      : resultSentence(v);
    return {
      ...common,
      state,
      verdict: v,
      lift: liftRange ? { ...liftRange, interim: false } : null,
      // The read date has come: each group's lift, past its own gate only.
      late_tag: lateTagGroups(rows, h, "final", what, superadmin),
      on_versioned: onVersioned("final"),
      ...resultExtras(v),
      sentence,
    };
  }

  // Running, before the read date.
  const week = Math.max(1, Math.ceil(Math.max(1, testPeriod.day) / 7));
  const of = testPeriod.weeks_total ? ` of ${testPeriod.weeks_total}` : "";
  if (liftRange === null || tv < MIN_SAMPLE || hv < MIN_SAMPLE) {
    return {
      ...common,
      state: "not_enough",
      needs: {
        treat: Math.max(0, MIN_CONVERSIONS - tc),
        holdout: Math.max(0, MIN_CONVERSIONS - hc),
      },
      sentence: `Not enough clicks yet to say anything. ${num(hc)} of the ${num(hv)} visits that saw your original clicked ${what}, and ${num(tc)} of the ${num(tv)} that saw a version. A range means something once each group has ${MIN_CONVERSIONS} clicks.`,
    };
  }
  return {
    ...common,
    state: "interim",
    lift: { ...liftRange, interim: true },
    sentence: `Interim, week ${week}${of}. Versions ${rate1(tv > 0 ? tc / tv : null)}, original ${rate1(hv > 0 ? hc / hv : null)}, so far ${signed(liftRange.value)} (range ${signed(liftRange.low)} to ${signed(liftRange.high)}). This moves week to week, so do not decide on it yet.`,
  };
}

function bySourceRows(rows: OutcomeLite[]): SourceRow[] {
  const map = new Map<string, { tv: number; tc: number; hv: number; hc: number }>();
  for (const r of rows) {
    if (r.arm === "none") continue;
    const m = map.get(r.source_dim) ?? { tv: 0, tc: 0, hv: 0, hc: 0 };
    if (r.arm === "treat") {
      m.tv += r.visits;
      m.tc += r.converting_visits;
    } else {
      m.hv += r.visits;
      m.hc += r.converting_visits;
    }
    map.set(r.source_dim, m);
  }
  return [...map.entries()]
    .sort((a, b) => b[1].tv + b[1].hv - (a[1].tv + a[1].hv))
    .map(([source_dim, m]) => {
      const l = computeGatedLift(m.tv, m.tc, m.hv, m.hc);
      return {
        source_dim,
        treat: counts(m.tv, m.tc),
        holdout: counts(m.hv, m.hc),
        range:
          l.ci_lower !== null && l.ci_upper !== null ? { low: l.ci_lower, high: l.ci_upper } : null,
      };
    });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadTests(db: D1Database, customerId: string): Promise<TestRow[]> {
  const r = await db
    .prepare(
      `SELECT id, customer_id, percent, started_at, ended_at, read_date, read_fixed_at,
              started_by, started_actor, end_reason, ended_actor
       FROM holdout_tests WHERE customer_id = ? ORDER BY started_at ASC, created_at ASC`,
    )
    .bind(customerId)
    .all<TestRow>();
  return r.results ?? [];
}

/** Summed exposure_outcomes rows of one customer between two days, inclusive. */
export async function loadOutcomes(
  db: D1Database,
  customerId: string,
  fromDay: string,
  toDay: string,
): Promise<OutcomeLite[]> {
  const r = await db
    .prepare(
      `SELECT day, arm, source_dim, (intent_dim != 'none') AS signal,
              SUM(visits) AS visits, SUM(converting_visits) AS converting_visits,
              SUM(applied_visits) AS applied_visits,
              SUM(applied_converting_visits) AS applied_converting_visits,
              SUM(lp_visits) AS lp_visits,
              SUM(lp_converting_visits) AS lp_converting_visits
       FROM exposure_outcomes
       WHERE customer_id = ? AND day >= ? AND day <= ?
       GROUP BY day, arm, source_dim, (intent_dim != 'none')`,
    )
    .bind(customerId, fromDay, toDay)
    .all<OutcomeLite>();
  return (r.results ?? []).map((x) => ({
    ...x,
    signal: Number(x.signal),
    visits: Number(x.visits),
    converting_visits: Number(x.converting_visits),
    applied_visits: Number(x.applied_visits),
    applied_converting_visits: Number(x.applied_converting_visits),
    lp_visits: Number(x.lp_visits) || 0,
    lp_converting_visits: Number(x.lp_converting_visits) || 0,
  }));
}

/** A stored path as the manifests and version_bodies key it: lowercase, no trailing slash except "/". */
const NORM = (col: string) =>
  `CASE WHEN rtrim(${col}, '/') = '' THEN '/' ELSE lower(rtrim(${col}, '/')) END`;

/**
 * The class of the second line (OnVersionedLine): exposure_outcomes rows of
 * one customer whose page is the page of their body in that customer's
 * version_bodies, the two arms, summed by day and arm. Counts only; neither
 * table holds a marker.
 */
export const OWN_PAGE_OUTCOMES_SQL = `/* own_page_outcomes */
SELECT o.day AS day, o.arm AS arm,
       SUM(o.visits) AS visits, SUM(o.converting_visits) AS converting_visits
FROM exposure_outcomes o
JOIN version_bodies b ON b.customer_id = o.customer_id AND b.body_id = o.body_id
WHERE o.customer_id = ? AND o.day >= ? AND o.day <= ?
  AND o.arm IN ('treat', 'holdout')
  AND ${NORM("b.page_path")} = ${NORM("o.page_path")}
GROUP BY o.day, o.arm`;

/** The second line's rows of one customer between two days, inclusive. */
export async function loadOwnPageOutcomes(
  db: D1Database,
  customerId: string,
  fromDay: string,
  toDay: string,
): Promise<OwnPageLite[]> {
  const r = await db
    .prepare(OWN_PAGE_OUTCOMES_SQL)
    .bind(customerId, fromDay, toDay)
    .all<OwnPageLite>();
  return (r.results ?? [])
    .filter((x) => x.arm === "treat" || x.arm === "holdout")
    .map((x) => ({
      day: String(x.day),
      arm: x.arm,
      visits: Number(x.visits) || 0,
      converting_visits: Number(x.converting_visits) || 0,
    }));
}

export async function loadReportInput(
  db: D1Database,
  customerId: string,
  now: number,
  superadmin: boolean,
): Promise<ReportInput> {
  const tests = await loadTests(db, customerId);
  const today = dayOf(now);
  const period = periodOf(tests, now);
  const from = addDays(period && period.firstDay < today ? period.firstDay : today, -30);
  const to = addDays(today, -1);
  const [outcomes, ownOutcomes, mixed, labels] = await Promise.all([
    loadOutcomes(db, customerId, from, to),
    loadOwnPageOutcomes(db, customerId, from, to),
    db
      .prepare(
        "SELECT day, mixed_visits FROM exposure_rollup_days WHERE customer_id = ? AND day >= ? AND day <= ?",
      )
      .bind(customerId, from, to)
      .all<{ day: string; mixed_visits: number }>(),
    db
      .prepare(
        "SELECT label FROM conversion_targets WHERE customer_id = ? AND enabled = 1 ORDER BY created_at ASC",
      )
      .bind(customerId)
      .all<{ label: string }>(),
  ]);
  const mixedByDay: Record<string, number> = {};
  for (const m of mixed.results ?? []) mixedByDay[m.day] = Number(m.mixed_visits) || 0;
  const enabledRows = labels.results ?? [];
  return {
    customerId,
    now,
    superadmin,
    tests,
    outcomes,
    ownOutcomes,
    mixedByDay,
    labels: [...new Set(enabledRows.map((l) => l.label).filter(Boolean))],
    countedButtons: enabledRows.length,
  };
}

export async function loadLiftReport(
  db: D1Database,
  customerId: string,
  now: number,
  superadmin: boolean,
): Promise<LateTagLiftReport> {
  return buildLiftReport(await loadReportInput(db, customerId, now, superadmin));
}
