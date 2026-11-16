/**
 * Test (dashboard v2 mock, section 04): one sentence and two bars, the
 * buttons that count below. The sentence is the approved headline of the
 * lift report (lib/results.ts headlineFor); this file adds the screen's own
 * short lines. Pure, tested in test/v2/test-screen.test.ts.
 */

import type { LiftReport } from "@/types/api";
import { startOf } from "./measure";
import { dayShort, isRunning, oneIn } from "./proof";

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface TestPill {
  tone: "ok" | "muted" | "warn";
  live: boolean;
  text: string;
}

/** The pill over the sentence; null with no test. */
export function testPill(report: LiftReport): TestPill | null {
  const t = report.test;
  if (!t || report.state === "off") return null;
  const from = dayShort(t.first_day);
  if (isRunning(report)) {
    return { tone: "muted", live: true, text: `Running since ${from} · day ${Math.max(1, t.day)}` };
  }
  if (report.state === "held_back") {
    return { tone: "warn", live: false, text: `Paused · since ${from}` };
  }
  const to = t.ended_at ? dayShort(iso(t.ended_at)) : t.last_day ? dayShort(t.last_day) : null;
  const ran = to ? `ran ${from} to ${to}` : `since ${from}`;
  const clear =
    report.lift && report.state !== "ended_early" && (report.lift.low > 0 || report.lift.high < 0);
  return clear
    ? { tone: "ok", live: false, text: `Answer ready · ${ran}` }
    : { tone: "muted", live: false, text: `Ended · ${ran}` };
}

/** Not started: the sentence over the three steps. */
export function offLine(report: LiftReport, now: number): { lead: string; tail: string | null } {
  const weeks = startOf(report, now).estimate.weeks;
  return {
    lead: "Find out if your versions bring more clicks.",
    tail:
      weeks === null ? null : `At your traffic, about ${weeks} ${weeks === 1 ? "week" : "weeks"}.`,
  };
}

/** The line at the card's foot. */
export function footLine(report: LiftReport): string {
  const p = report.test?.percent ?? 20;
  if (isRunning(report) || report.state === "held_back") {
    return `${oneIn(p)} visits we can shape see your original page, to compare.`;
  }
  return "Versions now show to every visit we can shape.";
}
