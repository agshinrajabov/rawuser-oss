/**
 * Pages without versions, on the Pages card (mock design/mock/
 * sales-readiness/pilot-gaps.html, screen 07, approved 2026-10-12): one
 * count line, context for the largest gap. No action: covering a group of
 * pages has no spec yet (pilot-gaps.md, task C).
 *
 * Built from the breakdown's `pages` (docs/specs/results-data.md section 4):
 * `without_versions` counts every page without its own versions and the
 * distinct visits across them; `pages` lists only the busiest of them, with
 * 5 visits or more each. Counts only, never one page beside a visit.
 */

import type { PagesBreakdown } from "@/types/api";

/** Under this many visits the line is noise; the same floor the API uses to list a page. */
export const UNCOVERED_MIN_VISITS = 5;
/** The breakdown read is the 7-day window. */
export const UNCOVERED_PERIOD = "Last 7 days.";

function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** "/products/vitamin-c" gives "products"; the home page gives "". */
function firstSegment(path: string): string {
  return path.split("/").filter(Boolean)[0] ?? "";
}

/**
 * The first segment every page without versions shares, or null. Said only
 * when the list holds every one of them: with 65 pages and five listed, the
 * other sixty are not known to sit under the same segment.
 */
export function sharedSegment(pages: PagesBreakdown): string | null {
  const total = pages.without_versions?.pages ?? 0;
  const listed = (pages.pages ?? []).filter((p) => !p.has_versions);
  if (total < 2 || listed.length !== total) return null;
  const segments = new Set(listed.map((p) => firstSegment(p.page_path)));
  if (segments.size !== 1) return null;
  const [only] = [...segments];
  return only ? only : null;
}

/**
 * "65 pages got 190 visits and have no versions." With a shared first
 * segment: "4 pages under /products got 60 visits and have no versions."
 * Null without the read (a row from before migration 0034, an older
 * worker), with no such page, or under five visits.
 */
export function uncoveredLine(
  pages: PagesBreakdown | null | undefined,
): { text: string; period: string } | null {
  const w = pages?.without_versions;
  if (!pages || !w || typeof w.pages !== "number" || typeof w.visits !== "number") return null;
  if (w.pages < 1 || w.visits < UNCOVERED_MIN_VISITS) return null;
  const segment = sharedSegment(pages);
  const who =
    w.pages === 1 ? "1 page" : `${count(w.pages)} pages${segment ? ` under /${segment}` : ""}`;
  const visits = `${count(w.visits)} ${w.visits === 1 ? "visit" : "visits"}`;
  return {
    text: `${who} got ${visits} and ${w.pages === 1 ? "has" : "have"} no versions.`,
    period: UNCOVERED_PERIOD,
  };
}
