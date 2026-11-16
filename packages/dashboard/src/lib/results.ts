/**
 * The words and numbers of the Results page (/analytics), built from the
 * approved mock design/mock/sales-readiness/results-page.html (`e04d1c3`)
 * and the reads in docs/specs/results-data.md.
 *
 * The founder's rule for this page: one short line per element, numbers
 * plus a few words, every caveat behind "How this works" or an info toggle.
 * The honesty rules hold regardless:
 *   - the headline is grey until the read date, and never green;
 *   - no change is shown where the API gives null;
 *   - no "clicks most" claim unless `lead.top_rate` is set;
 *   - no Change column on a period whose period before is not comparable.
 *
 * Pure functions, tested in test/analytics/results.test.ts.
 */

import type {
  AnalyticsComparison,
  AnalyticsOverview,
  AnalyticsPeriod,
  LiftReport,
  ManifestResponse,
  PagesBreakdown,
  ResultsLead,
  UnknownRow,
  VariantBreakdownItem,
} from "@/types/api";
import { operatorDoes } from "./identity";
import { tooLittleTraffic } from "./measure";
import { dayLabel, dayShort, num, pct, signed } from "./proof";

// ---------------------------------------------------------------------------
// The period switch
// ---------------------------------------------------------------------------

export type ResultsWindow = "1h" | "24h" | "7d" | "30d";

const WINDOW_LABEL: Record<ResultsWindow, string> = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

/** A customer picks 7 or 30 days; hours are for operators (founder, 2026-10-04). */
export function windowsFor(superadmin: boolean): { value: ResultsWindow; label: string }[] {
  const all: ResultsWindow[] = superadmin ? ["1h", "24h", "7d", "30d"] : ["7d", "30d"];
  return all.map((value) => ({ value, label: WINDOW_LABEL[value] }));
}

/** The window from the URL, held to what this role may pick; 30 days by default. */
export function parseWindow(raw: string | null, superadmin: boolean): ResultsWindow {
  const allowed = windowsFor(superadmin).map((w) => w.value);
  return allowed.includes(raw as ResultsWindow) ? (raw as ResultsWindow) : "30d";
}

const WINDOW_MS: Record<ResultsWindow, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * "Last 30 days · Fri 4 Sep to Sun 4 Oct" for the traffic band. The period
 * is (start, end]; without one (a row from before 2026-10-04) it is counted
 * back from `computedAt`. Hours carry no dates.
 */
export function periodLabel(
  window: ResultsWindow,
  period: AnalyticsPeriod | undefined,
  computedAt: number | null,
): string {
  if (window === "1h") return "Last hour";
  if (window === "24h") return "Last 24 hours";
  const end = period?.end ?? computedAt;
  if (!end) return `Last ${WINDOW_LABEL[window]}`;
  const start = period?.start ?? end - WINDOW_MS[window];
  return `Last ${WINDOW_LABEL[window]} · ${dayLabel(isoDay(start + 1))} to ${dayLabel(isoDay(end))}`;
}

/** "against the 7 days before", or null when there is nothing to compare with. */
export function comparisonLabel(
  window: ResultsWindow,
  comparison: AnalyticsComparison | undefined,
): string | null {
  if (!comparison?.comparable) return null;
  if (window === "1h") return "against the hour before";
  return `against the ${WINDOW_LABEL[window]} before`;
}

/** The Change column shows only when the period before can be set against this one. */
export function showsChange(comparison: AnalyticsComparison | undefined): boolean {
  return comparison?.comparable === true;
}

/** +0.12 -> "+12%"; null stays null, so no cell ever invents a change. */
export function changeText(x: number | null | undefined): string | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  return signed(x);
}

// ---------------------------------------------------------------------------
// The goal's words
// ---------------------------------------------------------------------------

/** "Start free" for one confirmed button, else null (several, or no report). */
export function goalLabel(report: Pick<LiftReport, "metric"> | null): string | null {
  return report?.metric.labels.length === 1 ? (report.metric.labels[0] as string) : null;
}

/** "Clicked Start free" or "Clicked a goal". */
export function clickedLabel(report: Pick<LiftReport, "metric"> | null): string {
  const g = goalLabel(report);
  return g ? `Clicked ${g}` : "Clicked a goal";
}

// ---------------------------------------------------------------------------
// "Is it working?": the headline
// ---------------------------------------------------------------------------

export interface Headline {
  /** The answer. */
  lead: string;
  /** A few words after it, quieter. */
  tail: string | null;
  /** Ink on the read date; grey before it. Never green. */
  final: boolean;
  /** Not an answer but the block's title (no test yet): ink, never a result. */
  title?: boolean;
}

function endedDay(report: LiftReport): string | null {
  const at = report.test?.ended_at;
  return at ? dayShort(isoDay(at)) : null;
}

/**
 * The headline over the card, built from the card's own numbers and rules
 * (mock section 02, "Every state's headline"), cut to one short line. Says
 * "visits", never "people" (founder, 2026-10-04).
 */
/** "Too little traffic to measure the versions within a year." (measure-at-go-live mock, 06 D) */
export const TOO_LITTLE_HEADLINE = "Too little traffic to measure the versions within a year.";

/**
 * The early headlines of a test go live started (measure-at-go-live mock,
 * section 06; spec section 12): no date in the first week, "around" from
 * day 7, "on" once day 14 fixed it. Grey, never a result. A test started by
 * hand keeps the approved measure-setup headlines.
 */
export function goLiveEarly(report: LiftReport): Headline | null {
  const t = report.test;
  if (t?.started_by !== "go_live") return null;
  if (report.state !== "starting" && report.state !== "not_enough") return null;
  if (!t.read_date) {
    return { lead: "Test running.", tail: "A date after a week of visits.", final: false };
  }
  return {
    lead: "Test running,",
    tail: `result ${t.read_date_fixed ? "on" : "around"} ${dayLabel(t.read_date)}.`,
    final: false,
  };
}

export function headlineFor(report: LiftReport): Headline {
  const early = goLiveEarly(report);
  if (early) return early;
  if (tooLittleTraffic(report)) {
    return { lead: TOO_LITTLE_HEADLINE, tail: null, final: false, title: true };
  }
  const goal = goalLabel(report);
  const on = goal ?? "your goals";
  const t = report.test;
  const l = report.lift;
  switch (report.state) {
    case "off":
      // No test has run: the title over the three steps (measure-setup mock,
      // section 01). How long a test takes is step 3's line, not a headline.
      return { lead: "Measure what Rawuser brings.", tail: null, final: false, title: true };
    case "starting":
      return { lead: "The test starts today.", tail: "First numbers tomorrow.", final: false };
    case "not_enough":
      return {
        lead: "Too early to say.",
        tail: `Each group needs 10 clicks on ${on} first.`,
        final: false,
      };
    case "interim": {
      const tail = t?.read_date ? `Final on ${dayLabel(t.read_date)}.` : "Not final yet.";
      if (!l) return { lead: "Too early to say.", tail, final: false };
      return {
        lead: `Visits with a version clicked ${on} ${pct(l.value)} ${l.value >= 0 ? "more" : "less"} so far.`,
        tail,
        final: false,
      };
    }
    case "held_back":
      return {
        lead: "We are checking the test.",
        tail: `${operatorDoes("will write", "will write", true)} to you.`,
        final: false,
      };
    case "result":
      return resultHeadline(report, on);
    case "ended": {
      const d = endedDay(report);
      return {
        lead: d ? `The test ended on ${d}.` : "The test ended.",
        tail: endedTail(report, on),
        final: true,
      };
    }
    case "ended_early": {
      const d = endedDay(report);
      if (t?.end_reason === "limit") {
        // A go-live test ends 365 days after it started (privacy review condition 4).
        return {
          lead: d
            ? `The test ended on ${d}, a year after it started.`
            : "The test ended after a year.",
          tail: "No clear answer.",
          final: false,
        };
      }
      return {
        lead: d ? `The test stopped on ${d}, before its read date.` : "The test stopped early.",
        tail: "No clear answer.",
        final: false,
      };
    }
  }
}

function resultHeadline(report: LiftReport, on: string): Headline {
  const l = report.lift;
  const x = report.extra_clicks;
  switch (report.verdict) {
    case "positive":
      if (x && l) {
        return {
          lead: `The versions brought about ${num(x.value)} extra clicks on ${on}.`,
          tail: `${signed(l.value)}, likely ${signed(l.low)} to ${signed(l.high)}.`,
          final: true,
        };
      }
      return {
        lead: l ? `Visits with a version clicked ${on} ${pct(l.value)} more.` : "The versions won.",
        tail: l ? `Likely ${signed(l.low)} to ${signed(l.high)}.` : null,
        final: true,
      };
    case "negative":
      return {
        lead: l
          ? `Visits with a version clicked ${on} ${pct(l.value)} less.`
          : "The versions lost clicks.",
        tail: "We recommend pausing them.",
        final: true,
      };
    case "no_difference":
      return {
        lead: "No difference found.",
        tail: l ? `Clicks moved between ${signed(l.low)} and ${signed(l.high)}.` : null,
        final: true,
      };
    default:
      return { lead: "No clear answer.", tail: "Too few clicks by the read date.", final: true };
  }
}

function endedTail(report: LiftReport, on: string): string {
  const x = report.extra_clicks;
  const l = report.lift;
  switch (report.verdict) {
    case "positive":
      return x
        ? `About ${num(x.value)} extra clicks on ${on}.`
        : l
          ? `${signed(l.value)} on ${on}.`
          : "The versions won.";
    case "negative":
      return l ? `Clicks fell ${pct(l.value)}.` : "The versions lost clicks.";
    case "no_difference":
      return "No difference found.";
    default:
      return "No clear answer.";
  }
}

/** "Test period · Mon 7 Sep to today", under the headline; null with no test. */
export function testPeriodLine(report: LiftReport): string | null {
  const t = report.test;
  if (!t) return null;
  const from = dayLabel(t.first_day);
  const running = report.state === "starting" || report.state === "not_enough";
  if (running || report.state === "interim" || report.state === "held_back") {
    return `Test period · ${from} to today`;
  }
  return t.last_day ? `Test period · ${from} to ${dayLabel(t.last_day)}` : `Test period · ${from}`;
}

const NUMBERS_STATES = new Set(["interim", "result", "ended", "ended_early"]);

/**
 * The card's numbers line, which replaces its own sentence now the headline
 * carries the answer (founder, 2026-10-04): "Versions 9.4%, original 7.8%,
 * range -5% to +50%". Null where the card has no rates to show.
 */
export function numbersLine(report: LiftReport): string | null {
  const a = report.arms;
  if (!a || a.treat.rate === null || a.holdout.rate === null) return null;
  if (!NUMBERS_STATES.has(report.state)) return null;
  const rates = `Versions ${(a.treat.rate * 100).toFixed(1)}%, original ${(a.holdout.rate * 100).toFixed(1)}%`;
  const l = report.lift;
  if (!l) return rates;
  const word = report.state === "interim" ? "range" : "likely";
  return `${rates}, ${word} ${signed(l.low)} to ${signed(l.high)}`;
}

/** The first sentence of the card's limits, kept under the card; the rest moves into How this works. */
export function limitsShort(limits: string): string {
  const at = limits.indexOf(". ");
  return at > 0 ? limits.slice(0, at + 1) : limits;
}

// ---------------------------------------------------------------------------
// "Who comes to your site, and why?"
// ---------------------------------------------------------------------------

export const SOURCE_LABEL: Record<string, string> = {
  organic: "Search",
  social: "Social apps",
  ai: "AI assistants",
  direct: "Came straight to a page",
  community: "Communities",
  paid: "Ads",
};

export function sourceLabel(dim: string): string {
  return SOURCE_LABEL[dim] ?? dim.charAt(0).toUpperCase() + dim.slice(1);
}

/** "from search": where a version's visits came from, in the version table. */
export function sourcePhrase(dim: string | null): string {
  switch (dim) {
    case "organic":
      return "from search";
    case "social":
      return "from social apps";
    case "ai":
      return "from AI assistants";
    case "community":
      return "from communities";
    case "paid":
      return "from ads";
    case "direct":
      return "came straight to a page";
    default:
      return "";
  }
}

/** A swatch per source, darkest for AI, as the mock draws them. Fixed, so a row keeps its tone. */
export const SOURCE_TONE: Record<string, string> = {
  ai: "#0a0a0a",
  organic: "#3f3f46",
  social: "#71717a",
  direct: "#a1a1aa",
  community: "#c4c4c9",
  paid: "#dedee2",
};

export function sourceTone(dim: string): string {
  return SOURCE_TONE[dim] ?? "#d4d4d8";
}

export const INTENT_LABEL: Record<string, string> = {
  competitor: "Comparison",
  evaluation: "Choosing a tool",
  feature: "Features",
  problem: "Problem first",
  brand: "Knows you already",
  pricing: "Pricing",
};

export function intentLabel(dim: string | null): string {
  if (!dim) return "Your original";
  return INTENT_LABEL[dim] ?? dim.charAt(0).toUpperCase() + dim.slice(1);
}

/** The two versions a source's visits see most, with their share of it. */
export function seesFor(
  byTuple: VariantBreakdownItem[],
  source: string,
): { name: string; share: number }[] {
  const rows = byTuple.filter((r) => r.source_dim === source && r.intent_dim);
  const total = rows.reduce((s, r) => s + r.visits, 0);
  if (total === 0) return [];
  const byIntent = new Map<string, number>();
  for (const r of rows) {
    const k = r.intent_dim as string;
    byIntent.set(k, (byIntent.get(k) ?? 0) + r.visits);
  }
  return [...byIntent.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 2)
    .map(([k, v]) => ({ name: intentLabel(k), share: v / total }));
}

/** 0.534 -> "53%". */
export function share0(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * The lead line: how much of the traffic told us where it came from, the
 * biggest grower when there is one, and the top click rate only when the
 * server's gate let it through.
 */
export function leadLine(lead: ResultsLead, report: Pick<LiftReport, "metric"> | null): string {
  if (lead.total_visits === 0) return "No visits in this period yet.";
  const parts = [
    `${share0(lead.signal_visits / lead.total_visits)} of visits told us where they came from.`,
  ];
  const grower = lead.grower && lead.grower.visits_change > 0 ? lead.grower : null;
  const top = lead.top_rate;
  const goal = goalLabel(report) ?? "your goals";
  const topText = top ? `clicked ${goal} most often, ${(top.rate * 100).toFixed(1)}%` : null;
  if (grower && top && top.group === grower.source_dim) {
    parts.push(
      `${sourceLabel(grower.source_dim)} grew most, ${signed(grower.visits_change)}, and ${topText}.`,
    );
  } else {
    if (grower) {
      parts.push(`${sourceLabel(grower.source_dim)} grew most, ${signed(grower.visits_change)}.`);
    }
    if (top) {
      const g = top.group === "unknown" ? "Unknown" : sourceLabel(top.group);
      parts.push(`${g} ${topText}.`);
    }
  }
  return parts.join(" ");
}

/** The share bar: one part per source, then Unknown split into chat-app links and the rest. */
export function shareBar(
  bySource: { source_dim: string; visits: number }[],
  unknown: Pick<UnknownRow, "visits" | "dark_social_probable">,
): {
  known: { dim: string; visits: number }[];
  dark: number;
  rest: number;
  knownShare: number;
  unknownShare: number;
} {
  const known = bySource
    .filter((r) => r.visits > 0)
    .map((r) => ({ dim: r.source_dim, visits: r.visits }));
  const k = known.reduce((s, r) => s + r.visits, 0);
  const dark = Math.min(unknown.dark_social_probable, unknown.visits);
  const total = k + unknown.visits;
  return {
    known,
    dark,
    rest: unknown.visits - dark,
    knownShare: total ? k / total : 0,
    unknownShare: total ? unknown.visits / total : 0,
  };
}

// ---------------------------------------------------------------------------
// "What to do next"
// ---------------------------------------------------------------------------

export type NextAction = { kind: "tag" } | { kind: "setup"; path: string };

export interface NextStep {
  id: string;
  title: string;
  fact: string;
  action: NextAction;
  /** The button's words. */
  button: string;
}

export interface NextInput {
  report: LiftReport | null;
  total: number;
  unknownVisits: number;
  pages: PagesBreakdown | null | undefined;
  manifests: ManifestResponse[] | null;
}

/** Unknown at this share of visits or more asks for tagged links (mock §05). */
export const TAG_SHARE = 0.3;

/** At most three steps, the biggest first. */
export function nextSteps(i: NextInput): NextStep[] {
  const out: NextStep[] = [];

  // No "Start a test" step: the three steps under "Is it working?" offer it,
  // and the same action is never offered twice (measure-setup mock, decision 6).

  if (i.total > 0 && i.unknownVisits / i.total >= TAG_SHARE) {
    out.push({
      id: "tag",
      title: "Tag the links you share.",
      fact: `${num(i.unknownVisits)} visits (${share0(i.unknownVisits / i.total)}) told us nothing and saw your original.`,
      action: { kind: "tag" },
      button: "Make a tagged link",
    });
  }

  const wv = i.pages?.without_versions;
  if (wv && wv.signal_visits > 0) {
    const top = [...(i.pages?.pages ?? [])]
      .filter((p) => !p.has_versions && p.signal_visits > 0)
      .sort((a, b) => b.signal_visits - a.signal_visits)[0];
    if (top) {
      out.push({
        id: "page",
        title: `Give ${top.page_path} its versions.`,
        fact: `${num(top.signal_visits)} visits with a source landed there.`,
        action: { kind: "setup", path: top.page_path },
        button: `Set up ${top.page_path}`,
      });
    } else {
      out.push({
        id: "page",
        title: "Give more pages their versions.",
        fact: `${num(wv.signal_visits)} visits with a source landed on ${wv.pages === 1 ? "a page" : `${wv.pages} pages`} without versions.`,
        action: { kind: "setup", path: "/" },
        button: "Add a page",
      });
    }
  }

  const lost = (i.manifests ?? []).find((m) => (m.missing_parts?.length ?? 0) > 0);
  if (lost) {
    const n = lost.missing_parts?.length ?? 0;
    const where = lost.page_path === "/" ? "Your homepage" : lost.page_path;
    out.push({
      id: "part",
      title:
        n === 1 ? "Show us the part your page lost." : `Show us the ${n} parts your page lost.`,
      fact: `${where} changed, so ${n === 1 ? "that part keeps" : "those parts keep"} your own words.`,
      action: { kind: "setup", path: lost.page_path },
      button: "Pick it on the page",
    });
  }

  return out.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Advanced
// ---------------------------------------------------------------------------

export interface GroupRow {
  label: string;
  visits: number;
  conversions: number;
  total?: boolean;
}

/** Visits by what each visit saw, with plain labels (mock, Advanced). */
export function groupRows(o: AnalyticsOverview): GroupRow[] {
  const c = o.cohorts;
  const rows: GroupRow[] = [
    {
      label: "Saw a version",
      visits: c.personalized.visits,
      conversions: c.personalized.conversions,
    },
    {
      label: "Saw your original, for the test",
      visits: c.holdout.visits,
      conversions: c.holdout.conversions,
    },
  ];
  if (c.skipped && c.skipped.visits > 0) {
    rows.push({
      label: "Had a source, page kept as built",
      visits: c.skipped.visits,
      conversions: c.skipped.conversions,
    });
  }
  rows.push({
    label: "Told us nothing, saw your original",
    visits: c.no_signal.visits,
    conversions: c.no_signal.conversions,
  });
  rows.push({
    label: "All visits",
    visits: o.hero.total_visits,
    conversions: o.hero.total_conversions,
    total: true,
  });
  return rows;
}

/** 0.0943 -> "9.4%", or an empty cell at 0 visits. */
export function rateOf(conversions: number, visits: number): string {
  return visits > 0 ? `${((conversions / visits) * 100).toFixed(1)}%` : "";
}

/** The daily series cut to the period picked; hours get no chart. */
export function seriesFor<T extends { date: string }>(series: T[], window: ResultsWindow): T[] {
  if (window === "1h" || window === "24h") return [];
  const days = window === "7d" ? 7 : 30;
  return series.slice(-days);
}
