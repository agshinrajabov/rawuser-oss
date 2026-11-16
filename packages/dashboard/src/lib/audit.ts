/**
 * The free AI-traffic audit's words and numbers (docs/specs/ai-traffic-audit.md
 * §5, §6, §11; mock design/mock/sales-readiness/ai-traffic-audit.html,
 * approved 2026-10-06). Pure functions, no React, so the tests read them
 * directly.
 *
 * Every number comes from the API as it is: a count is 0 ("None seen"), a
 * number of 5 or more, or "<5" ("fewer than 5"); a share comes only with the
 * report's own `share`. Nothing here computes a share or a remainder of the
 * visits (privacy review, 694c01d). Dates are UTC, so a frozen report reads
 * the same in every time zone.
 */

import type {
  AuditAnswers,
  AuditCount,
  AuditGroup,
  AuditGroupKey,
  AuditName,
  AuditReport,
  AuditSample,
  AuditShare,
  AuditStatus,
  AuditTestLine,
} from "@rawuser/shared";

import { OPERATOR_EMAIL, mailto, operatorDoes } from "./identity";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** The audit terms, a page of their own. */
export const TERMS_HREF = "/audit/terms/";

// ---------------------------------------------------------------------------
// Dates (UTC)
// ---------------------------------------------------------------------------

const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "14 October". */
export function dayMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTH_LONG[d.getUTCMonth()]}`;
}

/** "21 Oct". */
export function dayMon(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/** "Wed 7 Oct". */
export function weekdayDay(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/** "Wed 7 Oct 15:00". */
export function weekdayTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${weekdayDay(ms)} ${hh}:${mm}`;
}

/** "12 Jan 2027". */
export function fullDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The window's last counted day. A window of whole days (7 Oct 15:00 to
 * 14 Oct 15:00) reads "7 to 13 October", seven days; a window the row cap
 * closed early ends on the day it closed.
 */
export function lastDay(start: number, end: number): number {
  const span = end - start;
  return span > 0 && span % DAY_MS === 0 ? end - DAY_MS : end - 1;
}

/** "7 to 13 October", "28 September to 4 October". */
export function rangeLabel(start: number, end: number): string {
  const a = new Date(start);
  const b = new Date(lastDay(start, end));
  if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()) {
    return `${a.getUTCDate()} to ${dayMonth(b.getTime())}`;
  }
  return `${dayMonth(start)} to ${dayMonth(b.getTime())}`;
}

// ---------------------------------------------------------------------------
// Counts and shares, as the API gives them
// ---------------------------------------------------------------------------

/** 1240 -> "1,240". */
export function num(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** A table cell or a number standing alone: "None seen", "fewer than 5", "1,240". */
export function countCell(c: AuditCount): string {
  if (c === "<5") return "fewer than 5";
  if (c === 0) return "None seen";
  return num(c);
}

/** Inside a sentence: "none", "fewer than 5", "61". */
export function countInline(c: AuditCount): string {
  if (c === "<5") return "fewer than 5";
  if (c === 0) return "none";
  return num(c);
}

export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "4%", "under 1%". */
export function shareWord(s: AuditShare): string {
  return s.under_one ? "under 1%" : `${s.pct}%`;
}

/** "about 4%", "under 1%". */
export function aboutShare(s: AuditShare): string {
  return s.under_one ? "under 1%" : `about ${s.pct}%`;
}

/** A bar's width from the API's own whole percent; under 1% still shows a sliver. */
export function barWidth(s: AuditShare): number {
  return s.under_one ? 0.5 : s.pct;
}

/** "ChatGPT 31, Perplexity 9, other 12", or null with nothing to list. */
export function namesLine(names: AuditName[], other: AuditCount | null): string | null {
  const bits = names.map((n) => `${n.label} ${num(n.visits)}`);
  if (other !== null && other !== 0) bits.push(`other ${countInline(other)}`);
  return bits.length > 0 ? bits.join(", ") : null;
}

// ---------------------------------------------------------------------------
// The three answers (§5.1)
// ---------------------------------------------------------------------------

export interface BarPart {
  /** Whole percent of all visits, from the API. */
  width: number;
  /** The "probably" part, hatched. */
  hatched?: boolean;
}

export interface Answer {
  title: string;
  sub: string | null;
  /** Null without a share (counts only, a count under 5, or a zero). */
  bar: BarPart[] | null;
  /** The two-part key under the in-app bar. */
  key?: boolean;
}

export function aiAnswer(a: AuditAnswers["ai"]): Answer {
  const names = namesLine(a.names, a.other);
  if (a.share) {
    return {
      title: `AI assistants sent ${aboutShare(a.share)} of your visits.`,
      sub: `${countCell(a.visits)} visits.${names ? ` ${names}.` : ""}`,
      bar: [{ width: barWidth(a.share) }],
    };
  }
  if (a.visits === 0) return { title: "AI assistants: none seen.", sub: null, bar: null };
  return {
    title: `AI assistants sent ${countInline(a.visits)} visits.`,
    sub: names ? `${names}.` : null,
    bar: null,
  };
}

export function inAppAnswer(a: AuditAnswers["in_app"]): Answer {
  const title = a.share
    ? `Links opened inside apps: ${aboutShare(a.share)}.`
    : a.visits === 0
      ? "Links opened inside apps: none seen."
      : `Links opened inside apps: ${countInline(a.visits)}.`;
  const sub =
    a.visits === 0
      ? null
      : `${cap(countInline(a.named))} we could name, ${countInline(a.probably)} probably.`;
  let bar: BarPart[] | null = null;
  if (a.share) {
    const w = barWidth(a.share);
    // The API's own percent, drawn in its two given parts when both are counts.
    if (typeof a.named === "number" && typeof a.probably === "number" && a.named + a.probably > 0) {
      const named = (w * a.named) / (a.named + a.probably);
      bar = [{ width: named }, { width: w - named, hatched: true }];
    } else {
      bar = [{ width: w }];
    }
  }
  return { title, sub, bar, key: bar !== null && bar.length === 2 };
}

export function noReferrerAnswer(a: AuditAnswers["no_referrer"]): Answer {
  const tail = "came from inside an app with no referrer and no tags.";
  const title =
    a.visits === 0
      ? "Inside an app with no referrer and no tags: none seen."
      : a.visits === "<5"
        ? `Fewer than 5 visits ${tail}`
        : `${num(a.visits)} visits ${tail}`;
  return {
    title,
    sub: a.visits === 0 ? null : "Most analytics tools count these as Direct.",
    bar: a.share ? [{ width: barWidth(a.share) }] : null,
  };
}

// ---------------------------------------------------------------------------
// The groups (§4.3) and landing pages
// ---------------------------------------------------------------------------

export const GROUP_LABEL: Record<AuditGroupKey, string> = {
  ai: "AI assistants",
  social: "Social and chat apps",
  community: "Communities",
  search: "Search",
  ads: "Ads",
  other: "Other sources we could read",
  none: "No source to read",
  language: "Pages in a language we did not write",
};

/** In a sentence: "What your visitors from search saw". */
const GROUP_PHRASE: Record<AuditGroupKey, string> = {
  ai: "AI assistants",
  social: "social and chat apps",
  community: "communities",
  search: "search",
  ads: "ads",
  other: "other sources",
  none: "no source",
  language: "other languages",
};

/** Ink to light grey, the last group hatched (the mock's swatches). */
export const GROUP_SWATCH: Record<AuditGroupKey, string | null> = {
  ai: "#171717",
  social: "#404040",
  community: "#6b6b6b",
  search: "#8f8f8f",
  ads: "#b3b3b3",
  other: "#cfcfcf",
  none: null,
  language: "#e5e5e5",
};

export function groupSub(g: AuditGroup): string | null {
  if (g.key === "none") {
    const p = g.probably;
    return p !== undefined && p !== 0
      ? `No referrer, no tags. ${cap(countInline(p))} probably a link from a phone app.`
      : "No referrer, no tags.";
  }
  if (g.key === "other") return g.visits === 0 ? null : "Email apps and your own tagged links";
  return namesLine(g.names, g.other);
}

export const LANDING_LABEL = {
  ai: "AI assistants",
  no_referrer: "Inside an app, no referrer",
  all: "All visits",
} as const;

// ---------------------------------------------------------------------------
// The sample (§5.2)
// ---------------------------------------------------------------------------

export function sampleTitle(s: AuditSample): string {
  const who = s.source.kind === "name" ? s.source.label : GROUP_PHRASE[s.source.group];
  return s.form === "would_see"
    ? `What a visitor from ${who} would see`
    : `What your visitors from ${who} saw`;
}

/** "One of 90 versions written for your site." */
export function versionsNote(total: number): string {
  return total === 1
    ? "One version written for your site."
    : `One of ${num(total)} versions written for your site.`;
}

// ---------------------------------------------------------------------------
// What the versions did (§5.3)
// ---------------------------------------------------------------------------

export interface TestLineView {
  lead: string;
  rest: string | null;
  /** too_early: weeks for the quiet strip (2 to 52), else null. */
  weeks: number | null;
}

export function testLineView(line: AuditTestLine): TestLineView {
  switch (line.state) {
    case "no_button":
      return { lead: "No button was counted, so there is no test yet.", rest: null, weeks: null };
    case "off":
      return { lead: "No test was running.", rest: null, weeks: null };
    case "low_traffic":
      return {
        lead: "Too little traffic to measure the versions within a year.",
        rest: null,
        weeks: null,
      };
    case "checking":
      return { lead: "We are checking the test.", rest: null, weeks: null };
    case "result":
      return { lead: line.sentence, rest: null, weeks: null };
    case "too_early": {
      const need =
        line.visits_needed !== null
          ? `The test needs about ${num(line.visits_needed)} visits with a version${
              line.weeks !== null
                ? `, about ${line.weeks} week${line.weeks === 1 ? "" : "s"} at this week's traffic`
                : ""
            }. `
          : "";
      return {
        lead: "Too early.",
        rest: `${need}It keeps running in a pilot.`,
        weeks: line.weeks !== null && line.weeks >= 2 && line.weeks <= 52 ? line.weeks : null,
      };
    }
  }
}

/** 0.25 -> "+25%". */
export function signed(x: number): string {
  const p = Math.round(x * 100);
  return p > 0 ? `+${p}%` : `${p}%`;
}

/** The range under a result, in the Results words. */
export function resultRange(l: { value: number; low: number; high: number }): {
  range: string;
  note: string;
} {
  const pct = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
  const note =
    l.low >= 0
      ? `Likely between ${pct(l.low)} and ${pct(l.high)} more than your original page.`
      : l.high <= 0
        ? `Likely between ${pct(l.high)} and ${pct(l.low)} less than your original page.`
        : `Likely between ${signed(l.low)} and ${signed(l.high)} against your original page.`;
  return { range: `likely ${signed(l.low)} to ${signed(l.high)}`, note };
}

/** The axis of a result: a domain around zero and the range, with its three ticks. */
export function resultAxis(l: { value: number; low: number; high: number }): {
  min: number;
  max: number;
  at: (x: number) => number;
} {
  const lo = Math.min(0, l.low);
  const hi = Math.max(0, l.high);
  const pad = Math.max(0.1, (hi - lo) * 0.3);
  const min = Math.floor((lo - pad) * 10) / 10;
  const max = Math.ceil((hi + pad) * 10) / 10;
  return { min, max, at: (x) => ((x - min) / (max - min)) * 100 };
}

// ---------------------------------------------------------------------------
// The last line and the disclosures
// ---------------------------------------------------------------------------

export function lastLine(r: Pick<AuditReport, "saw_version" | "test_running">): {
  lead: string;
  rest: string;
} {
  if (r.saw_version === 0) {
    return {
      lead: "Your versions are written and ready.",
      rest: "A pilot keeps them going and measures what they earn.",
    };
  }
  return {
    lead: `${cap(countInline(r.saw_version))} visits saw a version made for why they came.`,
    rest: r.test_running
      ? "The test keeps running in a pilot."
      : "A pilot keeps it going and measures what it earns.",
  };
}

/** The banner line, in the privacy review's words. Only when the prospect ticked the box. */
export const BANNER_LINE =
  "If your banner holds our tag back, only visits that accepted it are counted.";

export function cannotSee(r: Pick<AuditReport, "window" | "consent_banner">): {
  text: string;
  banner?: boolean;
}[] {
  const days = Math.round((r.window.end - r.window.start) / DAY_MS);
  const span = days >= 13 ? "This is two weeks." : "This is one week.";
  const out: { text: string; banner?: boolean }[] = [
    {
      text: "Some AI apps send nothing at all. Our research puts it at a quarter to a third of AI clicks. Those visits are in No source to read, not in AI.",
    },
    { text: "Visitors whose browser blocked our script, and crawlers, are not counted." },
    { text: "Pages without the tag are not counted." },
    { text: `${span} A launch or a holiday changes it.` },
  ];
  if (r.consent_banner) out.push({ text: BANNER_LINE, banner: true });
  return out;
}

export function howWeCount(r: Pick<AuditReport, "sample">): string[] {
  const out = [
    "Each visit is counted once, by where it landed from.",
    "A visit that said nothing about where it came from is in No source to read, even when its page gave it a version.",
    "Results counts a visit once in each group it crossed, so its numbers can differ by a few.",
  ];
  if (r.sample) {
    out.push(
      "The sample shows each part's first length. On some screens the page used a shorter or longer one.",
    );
  }
  return out;
}

/** "How sure": each share with its range, in the order of the page. Full state only. */
export function howSure(r: AuditReport): { label: string; low: number; high: number }[] {
  if (r.state !== "full") return [];
  const out: { label: string; low: number; high: number }[] = [];
  const push = (label: string, s: AuditShare | null | undefined) => {
    if (s) out.push({ label, low: s.low, high: s.high });
  };
  if (r.answers) {
    push("AI assistants", r.answers.ai.share);
    push("Links opened inside apps", r.answers.in_app.share);
    push("Inside an app, no referrer", r.answers.no_referrer.share);
  }
  for (const g of r.groups) if (g.key !== "ai") push(GROUP_LABEL[g.key], g.share);
  return out;
}

/** "64 of 90 versions were written when counting began.", only when some were missing. */
export function versionsAtStartLine(r: Pick<AuditReport, "versions_at_start">): string | null {
  const v = r.versions_at_start;
  if (!v || v.written >= v.total) return null;
  return `${num(v.written)} of ${num(v.total)} versions were written when counting began.`;
}

/** "Talk about a pilot": a message to the operator, or no link when no address is set. */
export function pilotMailto(domain: string): string | null {
  return mailto(OPERATOR_EMAIL, `A pilot for ${domain}`);
}

/** The print footer: "quoteloom.example · audit report · 7 to 13 October". */
export function printFooter(r: Pick<AuditReport, "domain" | "window">): string {
  return `${r.domain} · audit report · ${rangeLabel(r.window.start, r.window.end)}`;
}

// ---------------------------------------------------------------------------
// Where the audit stands (the Audit page, the first-run lines)
// ---------------------------------------------------------------------------

/**
 * When the audit ends: the end date once released, else the expected one
 * (seven days after the report is due, never past the 28-day ceiling).
 */
export function expectedEnd(s: AuditStatus): number | null {
  if (s.report_released_at !== null && s.ends_at !== null) return s.ends_at;
  if (s.report_due === null) return null;
  const end = s.report_due + 7 * DAY_MS;
  return s.ends_at_latest !== null ? Math.min(end, s.ends_at_latest) : end;
}

/** The report's expected date: due, or a week after go live while counting has not begun. */
export function reportDate(s: AuditStatus): number | null {
  if (s.report_due !== null) return s.report_due;
  if (s.live_at !== null) return s.live_at + 7 * DAY_MS;
  return null;
}

/** The strip on Connect, Look and Live: "report about 14 October". */
export function stripText(s: AuditStatus | null): string {
  if (s?.stage === "ready") return "report ready";
  const at = s ? reportDate(s) : null;
  return at === null ? "report a week after you go live" : `report about ${dayMonth(at)}`;
}

export const GO_LIVE_LINE = "Your audit report counts the 7 days after this.";

/** Live, under "What happens next". */
export function liveNextLine(s: AuditStatus): string | null {
  const end = expectedEnd(s);
  const endBit = end !== null ? ` The audit ends ${dayMonth(end)} unless you start a pilot.` : "";
  if (s.stage === "ready") return `Your report is ready.${endBit}`;
  if (s.report_due !== null) return `Your report: ${dayMonth(s.report_due)}.${endBit}`;
  const at = reportDate(s);
  return at !== null ? `Your report: about ${dayMonth(at)}.` : null;
}

export type PillTone = "muted" | "ok" | "warn" | "ink";

export interface AuditPageView {
  pill: string;
  tone: PillTone;
  live?: boolean;
  s1: string;
  s2: string | null;
  /** "Live since 7 October · 412 visits counted". */
  period: string | null;
  /** The day strip: cells and the one that is today (0-based). */
  days: { cells: number; today: number; first: string; mid: string; last: string } | null;
  after: string | null;
  foot: string | null;
}

export function auditPageView(s: AuditStatus): AuditPageView {
  const end = expectedEnd(s);
  const foot = end !== null ? `The audit ends ${dayMonth(end)} unless you start a pilot.` : null;
  switch (s.stage) {
    case "before_go_live":
      return {
        pill: "Before go live",
        tone: "muted",
        s1: "Your report counts the 7 days after you go live.",
        s2: null,
        period: null,
        days: null,
        after: null,
        foot: null,
      };
    case "writing":
      return {
        pill: "Writing",
        tone: "muted",
        s1: "Counting starts when your versions are written.",
        s2: `${num(s.written)} of ${num(s.total)} so far.`,
        period: null,
        days: null,
        after: "So every visit in the report could get its version.",
        foot: null,
      };
    case "counting": {
      const of = s.of_days ?? 7;
      const day = Math.min(of, Math.max(1, s.day ?? 1));
      const start = s.window_start ?? s.live_at ?? 0;
      return {
        pill: "Counting",
        tone: "muted",
        live: true,
        s1: `Day ${day} of ${of}.`,
        s2: s.report_due !== null ? `Your report: about ${dayMonth(s.report_due)}.` : null,
        period: `Live since ${dayMonth(s.live_at ?? start)} · ${num(s.visits_counted ?? 0)} visits counted`,
        days: {
          cells: of,
          today: day - 1,
          first: weekdayDay(start),
          mid: `day ${day}`,
          last: weekdayDay(start + (of - 1) * DAY_MS),
        },
        after: s.extended
          ? "Under 300 visits in the first week, so we count one more."
          : "Where they came from comes with the report.",
        foot,
      };
    }
    case "checking":
      return {
        pill: "Being checked",
        tone: "muted",
        s1:
          s.window_start !== null && s.window_end !== null
            ? `Counted ${rangeLabel(s.window_start, s.window_end)}.`
            : "Counting is done.",
        s2: `${operatorDoes("reads", "read", true)} every report before it goes out.`,
        period: null,
        days: null,
        after: "You get it in the thread your invite came in.",
        foot: null,
      };
    case "ready":
      return {
        pill: "Ready",
        tone: "ok",
        s1: "Your report is ready.",
        s2:
          s.window_start !== null && s.window_end !== null
            ? `${rangeLabel(s.window_start, s.window_end)}, ${num(s.visits_counted ?? 0)} visits.`
            : null,
        period: null,
        days: null,
        after: null,
        foot,
      };
    case "lapsed":
      return {
        pill: "Lapsed",
        tone: "muted",
        s1: "No go live within 14 days, so the audit closed.",
        s2: null,
        period: null,
        days: null,
        after:
          s.delete_at !== null
            ? `Nothing was shown to visitors. Your account is deleted on ${dayMonth(s.delete_at)}.`
            : "Nothing was shown to visitors.",
        foot: null,
      };
    case "ended":
      return {
        pill: s.ended_at !== null ? `Audit ended ${weekdayDay(s.ended_at)}` : "Audit ended",
        tone: "muted",
        s1: "The audit ended.",
        s2: "Your page shows as you built it. You can remove the tag.",
        period: null,
        days: null,
        after: null,
        foot: null,
      };
    case "pilot":
      return {
        pill: "Pilot",
        tone: "ok",
        s1: "Your audit became a pilot.",
        s2: null,
        period: null,
        days: null,
        after: null,
        foot: null,
      };
  }
}

/** "A new link replaces the one sent before." under Copy a share link. */
export const SHARE_LINE = "A new link replaces the one sent before.";
/** After a copy: the privacy review's "the old link stops working". */
export const SHARE_COPIED = "Copied. The link sent before no longer works.";

/** The ended screen's foot, while the report lives. */
export function endedFoot(s: AuditStatus): string | null {
  return s.delete_at !== null
    ? `Your report and data are deleted on ${dayMonth(s.delete_at)} unless you start a pilot.`
    : null;
}

// ---------------------------------------------------------------------------
// Superadmin: the Applications row and the review
// ---------------------------------------------------------------------------

/** "$0.18". */
export function spendText(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export interface AuditRowView {
  label: string;
  tone: PillTone;
  live?: boolean;
  detail: string | null;
  faint?: boolean;
}

export function auditRowView(s: AuditStatus, now: number): AuditRowView {
  const spendCap = s.caps.spend_used_up && s.written < s.total;
  if (spendCap && (s.stage === "writing" || s.stage === "counting" || s.stage === "checking")) {
    return {
      label: "Spend cap",
      tone: "warn",
      detail: `${num(s.written)} of ${num(s.total)} written`,
    };
  }
  switch (s.stage) {
    case "before_go_live": {
      const day = Math.max(1, Math.floor((now - s.signed_up_at) / DAY_MS) + 1);
      return {
        label: "Waiting for go live",
        tone: "muted",
        detail: `day ${Math.min(day, 14)} of 14`,
      };
    }
    case "writing":
      return { label: "Writing", tone: "muted", detail: `${num(s.written)} of ${num(s.total)}` };
    case "counting":
      return {
        label: "Counting",
        tone: "muted",
        live: true,
        detail: `day ${s.day ?? 1} of ${s.of_days ?? 7} · ${num(s.visits_counted ?? 0)} visits`,
      };
    case "checking":
      return s.report_built_at !== null
        ? { label: "Ready to review", tone: "ink", detail: `${num(s.visits_counted ?? 0)} visits` }
        : { label: "Building the report", tone: "muted", detail: "at the next hourly check" };
    case "ready": {
      const end = expectedEnd(s);
      return { label: "Released", tone: "ok", detail: end !== null ? `ends ${dayMon(end)}` : null };
    }
    case "ended":
      return {
        label: "Ended",
        tone: "muted",
        detail: s.delete_at !== null ? `deleted on ${dayMon(s.delete_at)}` : null,
        faint: true,
      };
    case "lapsed":
      return {
        label: "Lapsed",
        tone: "muted",
        detail: s.delete_at !== null ? `deleted on ${dayMon(s.delete_at)}` : null,
        faint: true,
      };
    case "pilot":
      return { label: "Became a pilot", tone: "ok", detail: null };
  }
}

/** The review's "Test" line, from the frozen report. */
export function reviewTestLine(r: Pick<AuditReport, "versions_did" | "test_running">): string {
  const state: Record<AuditTestLine["state"], string> = {
    no_button: "no button counted",
    off: "no test",
    too_early: "too early",
    result: "a result",
    low_traffic: "too little traffic",
    checking: "being checked",
  };
  return `${r.test_running ? "Running" : "Not running"} · ${state[r.versions_did.state]}`;
}

/** The End now dialog's delete date: 60 days after the release, else the build, else now. */
export function endDeleteDate(s: AuditStatus, now: number): number {
  return (s.report_released_at ?? s.report_built_at ?? now) + 60 * DAY_MS;
}

export const PILOT_TERMS_NEEDED = "Needs signed pilot terms.";
export const RELEASE_NOTE = "Send it in the thread your invite went to.";
export const AUDITS_FULL_LINE = "Ten audits are open. One must end first.";

// ---------------------------------------------------------------------------
// Tokens and refusals
// ---------------------------------------------------------------------------

/** The token of a `#t=` fragment, or "". Never read from a query string. */
export function hashToken(hash: string): string {
  return (new URLSearchParams(hash.replace(/^#/, "")).get("t") ?? "").trim();
}

/**
 * A cap or state refusal (409 `{ error: "audit_…", message }`, or a
 * customer's daily rewrite cap `rewrite_…`,
 * docs/specs/versions-for-every-customer.md) out of an apiFetch error, with
 * the API's own sentence; null for anything else.
 */
export function auditRefusal(e: unknown): { code: string; message: string } | null {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const m = msg.match(/^API error \d+: (.*)$/s);
  if (!m?.[1]) return null;
  try {
    const body = JSON.parse(m[1]) as { error?: unknown; message?: unknown };
    if (
      typeof body.error === "string" &&
      (body.error.startsWith("audit_") || body.error.startsWith("rewrite_")) &&
      typeof body.message === "string"
    ) {
      return { code: body.error, message: body.message };
    }
  } catch {
    // not JSON
  }
  return null;
}

/** Any `{ message }` an apiFetch error carries (share link, make-pilot), else the fallback. */
export function apiMessage(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : "";
  const m = msg.match(/^API error \d+: (.*)$/s);
  if (m?.[1]) {
    try {
      const body = JSON.parse(m[1]) as { message?: unknown };
      if (typeof body.message === "string" && body.message) return body.message;
    } catch {
      // not JSON
    }
  }
  return fallback;
}
