/**
 * Overview (dashboard v2 mock, section 01): one sentence, three numbers
 * that each open their screen, then at most three things that need the
 * customer, each with one button. Pure, tested in test/v2/overview.test.ts.
 *
 * Reads: GET /admin/analytics/overview (window 30d), the lift report, the
 * readiness list and the version list. No claim the API does not give: no
 * change where the delta is null, no "clicked most" without 30 visits.
 */

import type { ReadinessCheck, ReadinessResponse } from "@/lib/readiness";
import type { AnalyticsOverview, LiftReport, VariantListItem } from "@/types/api";
import { waitingVersions } from "./approval";
import { kindOf, pageName, sourceRow } from "./kinds";
import { dayShort, num, signed } from "./proof";

export function rate(conversions: number, visits: number): string {
  return visits > 0 ? `${((conversions / visits) * 100).toFixed(1)}%` : "0%";
}

/** The best-clicking source with at least `floor` visits, from the breakdown's per_source. */
export function bestSource(
  rows: readonly { source_dim: string; visits: number; conversions: number }[] | undefined,
  floor = 30,
): { source: string; rate: number } | null {
  const ok = (rows ?? []).filter((r) => r.visits >= floor && r.conversions > 0);
  if (ok.length === 0) return null;
  const best = ok.reduce((a, b) => (b.conversions / b.visits > a.conversions / a.visits ? b : a));
  return { source: best.source_dim, rate: best.conversions / best.visits };
}

export interface OverviewSentence {
  lead: string;
  tail: string | null;
}

export function overviewSentence(
  visits: number,
  clicked: number,
  best: { source: string } | null,
): OverviewSentence {
  if (visits === 0) {
    return {
      lead: "No visits in the last 30 days yet.",
      tail: "Numbers show from the first visit.",
    };
  }
  const v = visits === 1 ? "1 visit" : `${num(visits)} visits`;
  return {
    lead: `${v} in the last 30 days, and ${num(clicked)} clicked a button that counts.`,
    tail: best ? `Visitors from ${sourceRow(best.source).label} clicked most often.` : null,
  };
}

/** "+12%" and "on the 30 days before", or null where the API gives no comparable change. */
export function visitsChange(
  ov: AnalyticsOverview | null,
): { value: string; up: boolean; rest: string } | null {
  const d = ov?.delta?.vs_previous_period_visits_pct;
  if (d === null || d === undefined || !Number.isFinite(d)) return null;
  return { value: signed(d), up: d > 0, rest: "on the 30 days before" };
}

export interface TestTile {
  value: string;
  small: string | null;
  line: string;
}

/** The third tile, from the lift report's own state. */
export function testTile(report: LiftReport | null): TestTile {
  if (!report) return { value: "Off", small: null, line: "Not started." };
  const read = report.test?.read_date ? dayShort(report.test.read_date) : null;
  switch (report.state) {
    case "off":
      return { value: "Off", small: null, line: "Not started. Set it up on Test." };
    case "starting":
      return { value: "Day 1", small: null, line: "First numbers tomorrow." };
    case "not_enough":
      return {
        value: `Day ${report.test?.day ?? 1}`,
        small: null,
        line: read ? `Too early to say. Answer around ${read}.` : "Too early to say.",
      };
    case "interim": {
      const l = report.lift;
      return {
        value: l ? signed(l.value) : `Day ${report.test?.day ?? 1}`,
        small: l ? "so far" : null,
        line: read ? `Not sure yet. Answer around ${read}.` : "Not sure yet.",
      };
    }
    case "held_back":
      return { value: "Paused", small: null, line: "Waiting on your buttons." };
    default: {
      const l = report.lift;
      const clear = l && report.state !== "ended_early" && (l.low > 0 || l.high < 0);
      return {
        value: l ? signed(l.value) : "Ended",
        small: null,
        line: clear ? "Answer ready." : "Ended without a clear answer.",
      };
    }
  }
}

export interface AttentionRow {
  id: string;
  icon: "alert" | "link" | "info";
  title: string;
  line: string;
  action: { label: string; href: string };
}

/** Readiness checks that need the customer after go live, and where their button goes. */
const CHECK_HREF: Record<string, { label: string; href: string }> = {
  tag: { label: "Show the tag", href: "/settings?tab=install" },
  counted: { label: "Choose buttons", href: "/test" },
  contact_hint: { label: "Choose buttons", href: "/test" },
  versions: { label: "See versions", href: "/versions" },
  language: { label: "See versions", href: "/versions" },
};

/**
 * At most three rows, the waiting versions first (absent until the API has
 * the state), then visits with nothing to go on, then the readiness list's
 * own lines (as the API writes them).
 */
export function attentionRows(input: {
  items: readonly VariantListItem[] | null;
  /** `pending_versions` of the overview, else the list's count (lib/approval.ts pendingCount). */
  pending?: number;
  noSignalVisits: number;
  readiness: ReadinessResponse | null;
}): AttentionRow[] {
  const out: AttentionRow[] = [];
  const waiting = waitingVersions(input.items);
  const n = input.pending ?? waiting.length;
  if (n > 0) {
    const first = waiting[0];
    const kind = first ? kindOf(first.source_dim) : null;
    const who = kind ? `${kind.short} visitors` : "your visitors";
    out.push({
      id: "waiting",
      icon: "alert",
      title:
        n === 1
          ? `A new version for ${who} is waiting for your OK.`
          : `${num(n)} new versions are waiting for your OK.`,
      line:
        n === 1 && first
          ? `${pageName(first.page_path)} page. Visitors see the old one until you approve.`
          : "Visitors see the old ones until you approve.",
      action: { label: "Review", href: "/versions" },
    });
  }
  if (input.noSignalVisits > 0) {
    out.push({
      id: "no-signal",
      icon: "link",
      title: `${num(input.noSignalVisits)} ${input.noSignalVisits === 1 ? "visit" : "visits"} came with nothing to go on.`,
      line: "They see your original page. Tag the links you share to change that.",
      action: { label: "Make a link", href: "/settings?tab=links" },
    });
  }
  const checks = (input.readiness?.checks ?? []).filter(
    (c: ReadinessCheck) =>
      !c.superadmin_only && (c.state === "red" || c.state === "amber") && CHECK_HREF[c.id],
  );
  for (const c of checks) {
    out.push({
      id: `check-${c.id}`,
      icon: "info",
      title: c.line,
      line: "",
      action: CHECK_HREF[c.id] as { label: string; href: string },
    });
  }
  return out.slice(0, 3);
}
