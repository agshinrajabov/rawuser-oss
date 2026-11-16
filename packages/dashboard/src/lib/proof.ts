/**
 * The words and shapes of the "What the versions did" card, the holdout
 * control and its dialogs (docs/specs/proof-engine.md D and G; mock
 * design/mock/sales-readiness/proof-engine.html, approved 2026-10-04).
 *
 * Pure functions over LiftReport and HoldoutControl, so the rules the card
 * keeps are tested without a browser:
 *   - the sentence on the left is the answer, the column on the right is
 *     the number behind it;
 *   - before the read date the number is grey, the range hatched, and there
 *     is no estimate of extra clicks;
 *   - green and red only on the read date, and only when the range is clear
 *     of zero;
 *   - counts always shown.
 */

import type { HoldoutControl, HoldoutOption, LiftReport, ProofChecks } from "@/types/api";
import { operatorDoes } from "./identity";
import { dayTime } from "./install";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------------------
// Numbers and dates
// ---------------------------------------------------------------------------

/** 12000 -> "12,000". */
export function num(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 0.094 -> "9.4%". */
export function rate1(x: number | null | undefined): string {
  return x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

/** 0.19 -> "+19%", -0.05 -> "-5%", 0 -> "0%". */
export function signed(x: number): string {
  const p = Math.round(x * 100);
  return p > 0 ? `+${p}%` : `${p}%`;
}

/** 0.25 -> "25%" (no sign). */
export function pct(x: number): string {
  return `${Math.round(Math.abs(x) * 100)}%`;
}

function utc(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** '2026-11-16' -> "Mon 16 Nov". */
export function dayLabel(day: string): string {
  const d = utc(day);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/** '2026-11-16' -> "16 Nov". */
export function dayShort(day: string): string {
  const d = utc(day);
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/** Epoch ms -> the UTC day "Mon 14 Dec". */
export function dayLabelMs(ms: number): string {
  return dayLabel(new Date(ms).toISOString().slice(0, 10));
}

function daysBetween(from: string, to: string): number {
  return Math.round((utc(to).getTime() - utc(from).getTime()) / DAY_MS);
}

/** 20 -> "1 in 5"; the share that sees the original. */
export function oneIn(percent: number): string {
  if (percent === 10) return "1 in 10";
  if (percent === 20) return "1 in 5";
  if (percent === 50) return "1 in 2";
  return `${percent} in 100`;
}

/** 20 -> "4 in 5"; the share that sees a version. */
export function restIn(percent: number): string {
  if (percent === 10) return "9 in 10";
  if (percent === 20) return "4 in 5";
  if (percent === 50) return "1 in 2";
  return `${100 - percent} in 100`;
}

// ---------------------------------------------------------------------------
// The metric
// ---------------------------------------------------------------------------

/** "Start free" for one confirmed button, else "one of your confirmed buttons". */
export function metricWhat(report: Pick<LiftReport, "metric">): string {
  return report.metric.labels.length === 1
    ? (report.metric.labels[0] as string)
    : "one of your confirmed buttons";
}

/**
 * The card's subline. "Put in the test", not "a written version": a visit
 * with a signal gets an arm on any page the edge tried a version on
 * (proof-engine.md, "Visits that never met a version", as built).
 */
export function cardSub(report: Pick<LiftReport, "metric">): string {
  const on = report.metric.labels.length === 1 ? report.metric.labels[0] : "your confirmed buttons";
  return `Clicks on ${on}, visits with a signal that were put in the test`;
}

// ---------------------------------------------------------------------------
// The pill
// ---------------------------------------------------------------------------

export interface Pill {
  tone: "muted" | "ok" | "warn" | "err";
  text: string;
  live: boolean;
  icon: "check" | "alert" | null;
}

const RUNNING = new Set(["starting", "not_enough", "interim"]);

export function isRunning(report: Pick<LiftReport, "state">): boolean {
  return RUNNING.has(report.state);
}

export function pillFor(report: LiftReport): Pill {
  const t = report.test;
  switch (report.state) {
    case "off":
      return { tone: "muted", text: "No test", live: false, icon: null };
    case "starting":
      return { tone: "muted", text: "Test starting", live: true, icon: null };
    case "not_enough":
      return { tone: "muted", text: `Test running · day ${t?.day ?? 1}`, live: true, icon: null };
    case "interim": {
      const week = Math.max(1, Math.ceil(Math.max(1, t?.day ?? 1) / 7));
      const of = t?.weeks_total ? ` of ${t.weeks_total}` : "";
      return { tone: "muted", text: `Test running · week ${week}${of}`, live: true, icon: null };
    }
    case "held_back":
      return { tone: "warn", text: "Checking the test", live: false, icon: "alert" };
    case "result": {
      const read = t?.read_date ? ` · read ${dayShort(t.read_date)}` : "";
      if (report.verdict === "positive")
        return { tone: "ok", text: `Result${read}`, live: false, icon: "check" };
      if (report.verdict === "negative")
        return { tone: "err", text: `Result${read}`, live: false, icon: "alert" };
      return { tone: "muted", text: `Result${read}`, live: false, icon: null };
    }
    case "ended":
      return {
        tone: "muted",
        text: t?.ended_at
          ? `Test ended ${dayShort(new Date(t.ended_at).toISOString().slice(0, 10))}`
          : "Test ended",
        live: false,
        icon: null,
      };
    case "ended_early":
      return {
        tone: "muted",
        text: t?.ended_at
          ? `Test ended ${dayShort(new Date(t.ended_at).toISOString().slice(0, 10))} · before its read date`
          : "Test ended before its read date",
        live: false,
        icon: null,
      };
  }
}

// ---------------------------------------------------------------------------
// The sentence
// ---------------------------------------------------------------------------

export interface Verdict {
  /** The answer, first. */
  text: string;
  /** Grey, smaller: the answer has no verdict yet. */
  quiet: boolean;
  /** A second line under it, the same weight (the ended state's frozen result). */
  next: string | null;
}

const AS_READ = " The result as read on ";

/**
 * The server's sentence, split where the mock splits it: an ended test says
 * that it ended in the verdict line and carries the frozen result under it.
 */
export function verdictFor(report: LiftReport): Verdict {
  const s = report.sentence;
  const quiet =
    report.state === "off" ||
    report.state === "starting" ||
    report.state === "not_enough" ||
    report.state === "interim";
  if (report.state === "ended") {
    const at = s.indexOf(AS_READ);
    if (at > 0) {
      return { text: s.slice(0, at + 1).trim(), quiet: true, next: s.slice(at + 1).trim() };
    }
  }
  if (report.state === "held_back" && report.held_back_reason === "split") {
    return {
      text: "The split looks off. We are checking it before showing a result.",
      quiet: false,
      next: null,
    };
  }
  return { text: s, quiet, next: null };
}

export const FIXED_ON_DAY_14 = "The date is fixed on day 14.";

/** The line under the arms, or null. */
export function afterLine(report: LiftReport, _superadmin = false): string | null {
  const t = report.test;
  switch (report.state) {
    case "off":
      // The three steps above the card start a test (measure-setup mock).
      return null;
    case "interim":
    case "not_enough":
      // A go-live test's date is "around" from day 7 to day 14 (measure-at-go-live
      // mock, 06 B, decision 6): one short line says when it is fixed.
      if (t?.started_by === "go_live" && t.read_date && !t.read_date_fixed) {
        return FIXED_ON_DAY_14;
      }
      if (t?.readable_lift && t.read_date) {
        return `Can tell a lift of ${pct(t.readable_lift)} or more from none by ${dayShort(t.read_date)}.`;
      }
      return null;
    case "result":
      return report.verdict === "negative"
        ? `${operatorDoes("will write", "will write", true)} to you today.`
        : null;
    case "ended_early": {
      const a = report.arms;
      if (!a || !t?.last_day) return null;
      return `${num(a.treat.visits + a.holdout.visits)} visits, ${dayShort(t.first_day)} to ${dayShort(t.last_day)}.`;
    }
    default:
      return null;
  }
}

/** The as-treated secondary line on a positive result. */
export function asTreatedLine(report: LiftReport): string | null {
  if (report.state !== "result" || report.verdict !== "positive") return null;
  const at = report.as_treated;
  if (!at?.lift) return null;
  return `As treated, a secondary read: counting only the ${num(at.applied.visits)} visits where the version was written, ${signed(at.lift.value)} (${pct(at.lift.low)} to ${pct(at.lift.high)}). It leaves out ${num(at.left_out_visits)} visits where the version came late or was skipped, so it runs high.`;
}

// ---------------------------------------------------------------------------
// The arms
// ---------------------------------------------------------------------------

export interface ArmRow {
  name: string;
  /** Bar width, 0 to 100. */
  width: number;
  /** The figure on the right of the bar. */
  value: string;
  /** The counts after it. */
  counts: string;
  original: boolean;
}

export function armRows(report: LiftReport): ArmRow[] | null {
  const a = report.arms;
  if (!a || report.state === "held_back") return null;
  if (report.state === "not_enough" || report.state === "starting") {
    const row = (name: string, clicks: number, original: boolean): ArmRow => ({
      name,
      original,
      width: Math.min(100, (clicks / 10) * 100),
      value: num(clicks),
      counts: clicks >= 10 ? "clicks, enough" : `clicks, ${10 - clicks} to go`,
    });
    return [
      row("Versions", a.treat.converting_visits, false),
      row("Your original", a.holdout.converting_visits, true),
    ];
  }
  const top = Math.max(a.treat.rate ?? 0, a.holdout.rate ?? 0) * 1.25;
  const row = (name: string, arm: typeof a.treat, original: boolean): ArmRow => ({
    name,
    original,
    width: top > 0 && arm.rate !== null ? Math.min(100, (arm.rate / top) * 100) : 0,
    value: rate1(arm.rate),
    counts: `${num(arm.converting_visits)} of ${num(arm.visits)}`,
  });
  return [row("Versions", a.treat, false), row("Your original", a.holdout, true)];
}

// ---------------------------------------------------------------------------
// The timeline (running only)
// ---------------------------------------------------------------------------

export interface Timeline {
  /** Today along the line, 0 to 100. */
  done: number;
  start: string;
  /** Under "today"; null when it would sit on the start label. */
  mid: string | null;
  end: string;
  /**
   * The read-date ring: faint with no date yet, dashed while the date is
   * an estimate, solid once day 14 fixed it (measure-at-go-live mock, 06 A
   * and B).
   */
  ring: "none" | "estimate" | "fixed";
}

export function timelineFor(report: LiftReport): Timeline | null {
  const t = report.test;
  if (!t || !isRunning(report)) return null;
  const total = t.read_date ? daysBetween(t.first_day, t.read_date) : null;
  const day = Math.max(1, t.day);
  const done = total ? Math.min(100, Math.max(0, ((day - 1) / total) * 100)) : 2;
  const ring: Timeline["ring"] = !t.read_date ? "none" : t.read_date_fixed ? "fixed" : "estimate";
  if (t.started_by === "go_live") {
    // The mock's words for a test go live started (06 A and B).
    const end = !t.read_date
      ? "a date after day 7"
      : t.read_date_fixed
        ? `${dayLabel(t.read_date)} · read date`
        : `around ${dayLabel(t.read_date)}`;
    const start = `${dayLabel(t.first_day)} · start`;
    if (done < 18) return { done, start: `${start} · day ${day}`, mid: null, end, ring };
    return { done, start, mid: `today, day ${day}${total ? ` of ${total}` : ""}`, end, ring };
  }
  const start = `${dayLabel(t.first_day)} · start`;
  const end = !t.read_date
    ? "read date set on day 14"
    : t.read_date_fixed
      ? `${dayLabel(t.read_date)} · read date`
      : `about ${dayLabel(t.read_date)} · read date, fixed on day 14`;
  if (done < 18) return { done, start: `${start} · today is day ${day}`, mid: null, end, ring };
  return { done, start, mid: `today, day ${day}${total ? ` of ${total}` : ""}`, end, ring };
}

// ---------------------------------------------------------------------------
// The figure column
// ---------------------------------------------------------------------------

export type Ink = "muted" | "ok" | "err" | "fg";

export interface Strip {
  /** Domain in whole percent. */
  min: number;
  max: number;
  low: number;
  high: number;
  value: number;
  band: "moving" | "ok" | "err" | "solid";
  ink: Ink;
}

export interface Figure {
  key: string;
  /** Null: "Not yet". */
  big: string | null;
  ink: Ink;
  small: string | null;
  range: string;
  strip: Strip | null;
  earn: { strong: string | null; rest: string; em: string | null } | null;
}

/** A domain wide enough for the range, in steps of 20, at least -40 to +60. */
export function axisDomain(low: number, high: number): { min: number; max: number } {
  const lo = Math.floor((low * 100) / 20) * 20;
  const hi = Math.ceil((high * 100) / 20) * 20;
  return { min: Math.min(-40, lo), max: Math.max(60, hi) };
}

/** Where a fraction sits on the domain, 0 to 100. */
export function axisPos(x: number, d: { min: number; max: number }): number {
  const v = Math.min(d.max, Math.max(d.min, x * 100));
  return ((v - d.min) / (d.max - d.min)) * 100;
}

/** min, 0, a middle positive tick, max. */
export function axisTicks(d: { min: number; max: number }): number[] {
  const mid = Math.floor(d.max / 2 / 20) * 20;
  const out = [d.min, 0];
  if (mid > 0 && mid < d.max) out.push(mid);
  out.push(d.max);
  return out;
}

function earnFor(report: LiftReport, what: string): Figure["earn"] {
  if (report.state === "interim" || report.state === "not_enough") {
    return { strong: null, rest: "No estimate of extra clicks before the read date.", em: null };
  }
  if (report.state !== "result" && report.state !== "ended") return null;
  const x = report.extra_clicks;
  if (report.verdict === "no_difference" || report.verdict === "inconclusive" || !x) {
    return report.verdict === "no_difference"
      ? { strong: null, rest: "No estimate of extra clicks.", em: null }
      : null;
  }
  const a = Math.round(Math.min(Math.abs(x.low), Math.abs(x.high)));
  const b = Math.round(Math.max(Math.abs(x.low), Math.abs(x.high)));
  if (report.verdict === "negative") {
    return {
      strong: `About ${num(Math.abs(x.value))} fewer clicks`,
      rest: ` on ${what}, between ${num(a)} and ${num(b)}.`,
      em: null,
    };
  }
  return {
    strong: `About ${num(x.value)} extra clicks`,
    rest: ` on ${what}, between ${num(a)} and ${num(b)}.`,
    em: null,
  };
}

export function figureFor(report: LiftReport): Figure | null {
  const what = metricWhat(report);
  const onWhat = report.metric.labels.length === 1 ? what : "your buttons";
  switch (report.state) {
    case "off":
    case "held_back":
      return null;
    case "starting":
    case "not_enough":
      return {
        key: "Lift so far",
        big: null,
        ink: "muted",
        small: null,
        range:
          report.state === "starting"
            ? "the first day has not closed"
            : "needs 10 clicks in each group",
        strip: null,
        earn: null,
      };
    case "interim": {
      const l = report.lift;
      if (!l) return null;
      const d = axisDomain(l.low, l.high);
      return {
        key: "Lift so far",
        big: signed(l.value),
        ink: "muted",
        small: "interim",
        range: `range ${signed(l.low)} to ${signed(l.high)}`,
        strip: { ...d, low: l.low, high: l.high, value: l.value, band: "moving", ink: "muted" },
        earn: earnFor(report, what),
      };
    }
    case "result":
    case "ended":
    case "ended_early": {
      const final = report.state !== "result" ? ", final" : "";
      const key = `Lift on ${onWhat}${final}`;
      const l = report.lift;
      if (!l) {
        return {
          key,
          big: null,
          ink: "fg",
          small: null,
          range: "too few clicks for a range",
          strip: null,
          earn: null,
        };
      }
      const clear = report.state !== "ended_early" && (l.low > 0 || l.high < 0);
      const ink: Ink = clear ? (l.low > 0 ? "ok" : "err") : "fg";
      const d = axisDomain(l.low, l.high);
      return {
        key,
        big: signed(l.value),
        ink,
        small: clear ? null : "not clear of zero",
        range: `likely ${signed(l.low)} to ${signed(l.high)}`,
        strip: {
          ...d,
          low: l.low,
          high: l.high,
          value: l.value,
          band: clear ? (ink as "ok" | "err") : "solid",
          ink,
        },
        earn: earnFor(report, what),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// The checks row (superadmin) and the foot
// ---------------------------------------------------------------------------

export function checksItems(c: ProofChecks): { text: string; tone: "ok" | "warn" | "muted" }[] {
  const out: { text: string; tone: "ok" | "warn" | "muted" }[] = [];
  const set = `${Math.round(c.split_set * 100)}%`;
  if (c.split_seen !== null) {
    out.push({
      text: `Split ${(c.split_seen * 100).toFixed(1)}% for a set ${set}`,
      tone: c.split_ok ? "ok" : "warn",
    });
  }
  if (c.uncounted_share !== null) {
    out.push({
      text: `${(c.uncounted_share * 100).toFixed(1)}% of visits could not be counted`,
      tone: c.uncounted_ok ? "muted" : "warn",
    });
  }
  if (c.mixed_visits > 0) {
    out.push({
      text: `${num(c.mixed_visits)} visit${c.mixed_visits === 1 ? "" : "s"} saw both`,
      tone: "muted",
    });
  }
  return out;
}

export const ENDED_ITSELF = "Ended by itself on its read date";

/**
 * The card's foot on an ended test: "Ended by itself on its read date" for
 * a go-live test that ended itself (measure-at-go-live mock, 06 C), else
 * "Read from closed days, 7 Sep to 15 Nov".
 */
export function closedDaysLine(report: LiftReport): string | null {
  const t = report.test;
  if (report.state === "ended" && t?.end_reason === "read_date") return ENDED_ITSELF;
  if ((report.state !== "ended" && report.state !== "ended_early") || !t?.last_day) return null;
  return `Read from closed days, ${dayShort(t.first_day)} to ${dayShort(t.last_day)}`;
}

/** The held-back box: what was set, what was seen. */
export function heldBackBox(report: LiftReport): {
  text: string;
  rows: [string, string][];
} | null {
  if (report.state !== "held_back" || !report.test || !report.arms) return null;
  const t = report.test;
  const hv = report.arms.holdout.visits;
  const all = report.arms.treat.visits + hv;
  const seen = all > 0 ? `${((hv / all) * 100).toFixed(1)}%` : "n/a";
  const since = `${dayLabel(t.first_day)}, day ${t.day}`;
  if (report.held_back_reason === "uncounted") {
    return {
      text: "Over 1 in 20 visits in the test could not be placed in a group. Held back until fixed.",
      rows: [
        ["Set", `${t.percent}.0% · ${oneIn(t.percent)}`],
        ["Counted", `${num(all)} visits`],
        ["Since", since],
      ],
    };
  }
  return {
    text: `Set to show your original to ${oneIn(t.percent)} visits. So far ${num(hv)} of ${num(all)} did (${seen}). Held back until we know why.`,
    rows: [
      ["Set", `${t.percent}.0% · ${oneIn(t.percent)}`],
      ["Seen", `${seen} · ${num(hv)} of ${num(all)} visits`],
      ["Since", since],
    ],
  };
}

// ---------------------------------------------------------------------------
// How this works
// ---------------------------------------------------------------------------

export function howItWorks(report: LiftReport): { k: string; text: string }[] {
  const p = report.test?.percent ?? 20;
  const what = metricWhat(report);
  const read = report.test?.read_date ? ` (${dayShort(report.test.read_date)} here)` : "";
  return [
    {
      k: "The two groups",
      text: `When a visit lands on a page that has a version for it, it is put in one of two groups at random, once for the whole visit. ${restIn(p)} see the version, ${oneIn(p)} see your original page. Both groups arrive from the same sources at the same time, so the difference between them is what the versions do.`,
    },
    {
      k: "What counts",
      text: `A visit counts as a click when someone in it clicks ${what} on any page during that visit. A visit that clicks twice counts once. Visits we could not place in a group are left out and counted apart.`,
    },
    {
      k: "The range",
      text: "The range is a 95% interval. With this many visits, the true effect is very likely inside it. A narrow range is a firm answer; a range that crosses zero means we cannot tell yet.",
    },
    {
      k: "One read date",
      text: `The result is read on one date, set when the test started${read}. Checking every week and stopping on a good week finds wins that are not there, so before that date the number is marked interim.`,
    },
    {
      k: "What it costs you",
      text: `You give up the versions on ${oneIn(p)} of these visits while the test runs. You stop the test when you have your answer.`,
    },
    {
      k: "The checks",
      text: `Each day we test that about ${oneIn(p)} visits really saw the original. If the split drifts, the card says so and holds the result back until we know why.`,
    },
    ...moreHow(report),
  ];
}

/**
 * The caveats the Results page keeps off the card (founder, 2026-10-04: one
 * short line per element, method behind How this works): what the number
 * does not say, why there is no estimate yet, how it is made, the as-treated
 * read.
 */
function moreHow(report: LiftReport): { k: string; text: string }[] {
  const out: { k: string; text: string }[] = [{ k: "What it does not say", text: report.limits }];
  const t = report.test;
  if ((report.state === "interim" || report.state === "not_enough") && t?.readable_lift) {
    out.push({
      k: "Smaller effects",
      text: `A lift under ${pct(t.readable_lift)} may end as "no difference found". No estimate of extra clicks before the read date, so nobody decides on an interim number.`,
    });
  }
  if (report.extra_clicks && (report.verdict === "positive" || report.verdict === "negative")) {
    out.push({
      k: "Extra clicks",
      text: "An estimate: the difference in rates times the visits that got a version. Fewer clicks are counted the same way.",
    });
  }
  const treated = asTreatedLine(report);
  if (treated) out.push({ k: "As treated", text: treated });
  return out;
}

// ---------------------------------------------------------------------------
// By source
// ---------------------------------------------------------------------------

const SOURCE_NAME: Record<string, string> = {
  organic: "Search",
  social: "Social",
  ai: "AI assistants",
  community: "Communities",
  paid: "Paid",
  direct: "Direct, by entry page",
};

export function sourceName(dim: string): string {
  return SOURCE_NAME[dim] ?? dim.charAt(0).toUpperCase() + dim.slice(1);
}

/** The by-source block opens by itself on the read date. */
export function bySourceOpen(report: Pick<LiftReport, "state">): boolean {
  return report.state === "result" || report.state === "ended";
}

/** The mini range bars run from -40% to +100%, the line is zero. */
export const SOURCE_DOMAIN = { min: -40, max: 100 } as const;

// ---------------------------------------------------------------------------
// The holdout control and its dialogs
// ---------------------------------------------------------------------------

/** One piece of the test size line; `strong` is set in ink (the mock's "started at go live"). */
export interface StatusPart {
  text: string;
  strong?: boolean;
}

const GO_LIVE_ENDS: Partial<Record<string, (endedDay: string) => string>> = {
  read_date: (d) => `ended itself on its read date, ${d}`,
  low_traffic: () => "ended on day 14, too little traffic",
  limit: () => "ended after 365 days",
};

/**
 * The Admin test size line (measure-at-go-live mock, section 08): who
 * started the running test, and for a go-live test that ended, how it
 * ended. Every other line as before.
 */
export function controlParts(c: HoldoutControl): StatusPart[] {
  const r = c.running;
  if (r) {
    const read = r.read_date
      ? r.read_date_fixed
        ? ` · read date ${dayLabel(r.read_date)}, fixed on day 14`
        : ` · read date about ${dayLabel(r.read_date)}, fixed on day 14`
      : " · read date fixed on day 14";
    const starts = r.started_at > Date.now() ? "starts " : "since ";
    const head = `${r.percent}% ${starts}${dayTime(r.started_at)}`;
    if (r.started_by === "go_live") {
      return [{ text: `${head} · ` }, { text: "started at go live", strong: true }, { text: read }];
    }
    return [{ text: `${head}${read}` }];
  }
  const last = [...c.history].reverse().find((h) => h.ended_at !== null);
  if (last?.ended_at) {
    const day = new Date(last.ended_at).toISOString().slice(0, 10);
    const end = last.end_reason ? GO_LIVE_ENDS[last.end_reason] : undefined;
    if (last.started_by === "go_live" && end) {
      return [{ text: `Started at go live · ${end(dayLabel(day))}` }];
    }
    return [{ text: `No test since the last one ended on ${dayShort(day)}` }];
  }
  return [{ text: "No test has run" }];
}

export function controlStatus(c: HoldoutControl): string {
  return controlParts(c)
    .map((p) => p.text)
    .join("");
}

export type DialogKind = "start" | "change" | "end";

export function dialogKind(from: number, to: number): DialogKind {
  if (to === 0) return "end";
  if (from === 0) return "start";
  return "change";
}

export interface LedgerRow {
  dt: string;
  dd: string;
  m: string | null;
}

export interface StartLedger {
  rows: LedgerRow[];
  compare: { percent: number; weeks: string; visits: string; clicks: string; on: boolean }[];
  basis: string;
}

function optionOf(c: HoldoutControl, percent: number): HoldoutOption | null {
  return c.options.find((o) => o.percent === percent) ?? null;
}

/** The cost and read time of a test at `percent`, at this customer's traffic. */
export function startLedger(
  c: HoldoutControl,
  percent: number,
  what: string,
  now: number,
): StartLedger {
  const o = optionOf(c, percent);
  const clicksOn =
    what === "one of your confirmed buttons" ? "clicks on your buttons" : `${what} clicks`;
  const rows: LedgerRow[] = [
    {
      dt: "Costs",
      dd: `About ${num(o?.visits_given_up_per_month ?? 0)} visits a month see the original instead of a version.`,
      m: `If the versions lift clicks by 20%, that is about ${num(o?.clicks_given_up_per_month ?? 0)} ${clicksOn} a month given up.`,
    },
  ];
  if (o?.weeks) {
    rows.push({
      dt: "Reads in",
      dd: `About ${o.weeks} weeks, around ${dayLabelMs(now + o.weeks * 7 * DAY_MS)}.`,
      m: "Fixed on day 14 from the test's own numbers, then it does not move.",
    });
    rows.push({
      dt: "Smallest lift",
      dd: "A 20% lift is readable in that time. A smaller one may end as no difference found.",
      m: null,
    });
  } else {
    rows.push({
      dt: "Reads in",
      dd: "No estimate yet: too few visits with a version in the last 30 days.",
      m: null,
    });
  }
  rows.push({
    dt: "Starts",
    dd: "10 minutes after you confirm, when every location has the setting.",
    m: null,
  });
  const compare = c.options.map((x) => ({
    percent: x.percent,
    weeks: x.weeks ? `about ${x.weeks} weeks` : "no estimate",
    visits: `about ${num(x.visits_given_up_per_month)}`,
    clicks: `about ${num(x.clicks_given_up_per_month)}`,
    on: x.percent === percent,
  }));
  const b = c.basis;
  const basis =
    b.rate_source === "measured"
      ? `Based on the last ${b.days} days: about ${num(b.eligible_per_month)} visits with a signal and a version, ${rate1(b.baseline_rate)} clicked ${what}.`
      : `Based on the last ${b.days} days: about ${num(b.eligible_per_month)} visits with a signal and a version. Too few clicks to measure a rate, so ${rate1(b.baseline_rate)} is assumed.`;
  return { rows, compare, basis };
}

export interface DialogText {
  title: string;
  lead: string;
  rows: LedgerRow[];
  cancel: string;
  confirm: string;
  danger: boolean;
}

export function startDialog(domain: string, percent: number): Omit<DialogText, "rows"> {
  return {
    title: `Start a ${percent}% holdout on ${domain}?`,
    lead: `${oneIn(percent)} visits that would get a version sees the original page instead, picked at random per visit.`,
    cancel: "Cancel",
    confirm: "Start the test",
    danger: false,
  };
}

export function endDialog(domain: string, report: LiftReport | null): DialogText {
  const t = report?.test ?? null;
  const day = t?.day ?? 0;
  const total = t?.read_date ? daysBetween(t.first_day, t.read_date) : null;
  let lead: string;
  let card: string;
  if (report?.state === "result" && t?.read_date) {
    lead = `The read date has passed. The result stays on the card as read on ${dayShort(t.read_date)}.`;
    card = "Keeps the result as read, with its counts.";
  } else if (report?.state === "starting" || !t) {
    lead = "The test has not read a day yet. Ending now leaves nothing to read.";
    card = "Goes back to no test.";
  } else {
    const l = report?.lift;
    const range = l
      ? `, with today's range at ${signed(l.low)} to ${signed(l.high)}`
      : ", with too few clicks for a range";
    lead = `It is day ${day}${total ? ` of ${total}` : ""}. Ending now leaves the result inconclusive${range}.`;
    card = `Says "Inconclusive at the end of the test"${l ? " with today's range" : ""}, and keeps the counts.`;
  }
  return {
    title: `End the test on ${domain}?`,
    lead,
    rows: [
      {
        dt: "Visitors",
        dd: "Every visit with a signal gets a version again within 10 minutes.",
        m: null,
      },
      { dt: "The card", dd: card, m: null },
      {
        dt: "Restarting",
        dd:
          day > 0
            ? `A new test starts from zero. ${day === 1 ? "This day does" : `These ${day} days do`} not count toward it.`
            : "A new test starts from zero.",
        m: null,
      },
    ],
    cancel: "Keep it running",
    confirm: "End the test",
    danger: true,
  };
}

export function changeDialog(
  domain: string,
  c: HoldoutControl,
  report: LiftReport | null,
  from: number,
  to: number,
  now: number,
): Omit<DialogText, "rows"> {
  const day = report?.test?.day ?? 0;
  const o = optionOf(c, to);
  const was = c.running?.read_date ? dayShort(c.running.read_date) : null;
  const next = o?.weeks
    ? `about ${dayLabelMs(now + o.weeks * 7 * DAY_MS)} (about ${o.weeks} weeks)`
    : null;
  const days =
    day === 1
      ? "The day so far does not count toward it"
      : day > 1
        ? `The ${day} days so far do not count toward it`
        : "";
  const move = next
    ? was
      ? `the read date moves from ${was} to ${next}`
      : `the read date becomes ${next}`
    : "";
  const tail = [days, move].filter(Boolean).join(", and ");
  return {
    title: `Change the holdout on ${domain} to ${to}%?`,
    lead: `This starts a new test.${tail ? ` ${tail}.` : ""}`,
    cancel: `Keep ${from}%`,
    confirm: `Start a new test at ${to}%`,
    danger: false,
  };
}
