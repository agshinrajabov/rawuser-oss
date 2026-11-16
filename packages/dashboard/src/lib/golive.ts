/**
 * Measure at go live (mock design/mock/sales-readiness/measure-at-go-live.html,
 * approved 2026-10-05 with every call in its section 10 as drawn; contract
 * docs/specs/measure-at-go-live.md section 12).
 *
 * The Look screen's fourth row, "The button to count", in its five states;
 * the line and switch under Go live in its five states; the body Go live
 * sends; the one Live line. Pure functions, tested in
 * test/start/golive.test.ts. One short line per element (founder,
 * 2026-10-04), no dashes.
 */

import type { MeasureButton, MeasureProposal, PageRow, StoredLanguage } from "@/types/api";
import {
  COUNT_TARGET_PREFIX,
  CUSTOMER_TEST_PERCENT,
  countTargetPage,
  normalizePath,
} from "@rawuser/shared";
import { withPage } from "./languages";
import { oneIn } from "./proof";

// ---------------------------------------------------------------------------
// The button to count
// ---------------------------------------------------------------------------

/** Where a count slot sits, in the words of the mock's list ("top of the page"). */
const SLOT_PLACE: Record<string, string> = {
  "hero.cta.label": "top of the page",
  "forms.submit_label": "the form",
  "cta.cta.label": "bottom of the page",
  "pricing.cta.label": "pricing",
};

export function isPicked(sectionPath: string): boolean {
  return sectionPath.startsWith(COUNT_TARGET_PREFIX);
}

/** "top of the page", or "picked on the page" for a button picked with the count link. */
export function slotPlace(sectionPath: string): string {
  if (isPicked(sectionPath)) return "picked on the page";
  return SLOT_PLACE[sectionPath] ?? "on the page";
}

/** The proposal first, then the others, each slot once: the list Change opens. */
export function candidates(measure: MeasureProposal | null | undefined): MeasureButton[] {
  if (!measure) return [];
  const out: MeasureButton[] = [];
  for (const b of [measure.proposal, ...measure.others]) {
    if (b && !out.some((o) => o.section_path === b.section_path)) out.push(b);
  }
  return out;
}

/** "/az", "/az and /ru", "/az, /ru and /tr". */
export function pathList(paths: string[]): string {
  if (paths.length <= 1) return paths[0] ?? "";
  return `${paths.slice(0, -1).join(", ")} and ${paths[paths.length - 1]}`;
}

/**
 * The other language pages this go live will write: ready, ticked, and not
 * the page on screen. The same filter the server applies to `languages`.
 */
export function tickedPaths(
  languages: StoredLanguage[] | undefined,
  enabled: Set<string>,
  pagePath: string,
): string[] {
  // A language on the same address has no page: never a path to write.
  return withPage(languages)
    .filter((l) => l.status === "ready" && enabled.has(l.lang) && l.path !== pagePath)
    .map((l) => l.path);
}

export type ButtonRow =
  /** "Start free, top of the page." or "Start free. Also counted on /az." */
  | { kind: "chosen"; label: string; rest: string; warn: false }
  /** Amber: "Not found on /az, so clicks there are not counted." */
  | { kind: "missing"; line: string; warn: true }
  /** Amber: "No main button found." with Pick it on your page under it. */
  | { kind: "none"; line: string; warn: true };

export const NO_BUTTON_LINE = "No main button found.";
export const CHANGE_LINE = "Buttons we found on your page.";

/**
 * The row's one line for the chosen button. A slot is counted on a ticked
 * language page when that page carries it with a selector that matched once
 * (`per_language[].slots`); a button picked on the page counts on its own
 * page only (spec section 12), so it is never found on another.
 */
export function buttonRow(
  measure: MeasureProposal | null | undefined,
  chosen: MeasureButton | null,
  ticked: string[],
): ButtonRow {
  if (!chosen) return { kind: "none", line: NO_BUTTON_LINE, warn: true };
  const pages = measure?.per_language ?? [];
  const judged = ticked.filter((p) => pages.some((l) => l.path === p));
  const found = judged.filter((p) => {
    if (isPicked(chosen.section_path)) return false;
    const page = pages.find((l) => l.path === p);
    return page?.slots.includes(chosen.section_path) ?? false;
  });
  const missing = judged.filter((p) => !found.includes(p));
  if (missing.length > 0) {
    return {
      kind: "missing",
      line: `Not found on ${pathList(missing)}, so clicks there are not counted.`,
      warn: true,
    };
  }
  if (found.length > 0) {
    return {
      kind: "chosen",
      label: chosen.label,
      rest: `. Also counted on ${pathList(found)}.`,
      warn: false,
    };
  }
  return {
    kind: "chosen",
    label: chosen.label,
    rest: `, ${slotPlace(chosen.section_path)}.`,
    warn: false,
  };
}

// ---------------------------------------------------------------------------
// The line and the switch under Go live
// ---------------------------------------------------------------------------

export const TEST_ON_LINE = `A test starts too: ${oneIn(CUSTOMER_TEST_PERCENT)} visits see your original page.`;
export const TEST_OFF_LINE = "No test. You can start one on Test.";
export const NO_BUTTON_TEST_LINE = "No test without a button to count.";
export const LOW_TRAFFIC_LINE =
  "Too little traffic for a test. Visitors shows who comes and from where.";
export const TEST_ACCOUNT_LINE = "Test accounts never run a test.";
export const NOTICE_LINK = "Text for your privacy notice";

export interface GoLiveTest {
  /**
   * switch: the customer's choice; none: a hollow dot holds the switch's
   * place (no button, too little traffic); disabled: Off and disabled (a
   * test customer, privacy review condition 3).
   */
  control: "switch" | "none" | "disabled";
  /** What "Test:" reads. */
  on: boolean;
  line: string;
}

/**
 * The first that applies, in the server's order (spec section 12): a test
 * customer, no button, too little traffic known now, then the switch.
 */
export function goLiveTest(input: {
  plan: string | null | undefined;
  chosen: MeasureButton | null;
  lowTraffic: boolean;
  switchOn: boolean;
}): GoLiveTest {
  if (input.plan === "test") return { control: "disabled", on: false, line: TEST_ACCOUNT_LINE };
  if (!input.chosen) return { control: "none", on: false, line: NO_BUTTON_TEST_LINE };
  if (input.lowTraffic) return { control: "none", on: false, line: LOW_TRAFFIC_LINE };
  return input.switchOn
    ? { control: "switch", on: true, line: TEST_ON_LINE }
    : { control: "switch", on: false, line: TEST_OFF_LINE };
}

/** The switch starts On, Off for a test customer (spec section 9 item 5). */
export function switchDefault(plan: string | null | undefined): boolean {
  return plan !== "test";
}

/**
 * Go live's `count` and `test`. `test: true` only when the switch reads On
 * (privacy review condition 1: the server starts nothing without it); otherwise
 * the field is left out. The button is sent even when no test starts, so
 * Results opens on step 2 or offers Start anyway.
 */
export function measureBody(
  chosen: MeasureButton | null,
  test: GoLiveTest,
): { count: { section_path: string } | null; test?: true } {
  const count = chosen ? { section_path: chosen.section_path } : null;
  return test.control === "switch" && test.on ? { count, test: true } : { count };
}

// ---------------------------------------------------------------------------
// The warning under the test line (mock design/mock/sales-readiness/
// pilot-gaps.html, screen 05, drawing A21, approved 2026-10-12)
// ---------------------------------------------------------------------------

/** Under this many visits in the period the share is not said. */
export const SHARE_MIN_VISITS = 30;
/** A wait longer than this many weeks is said. */
export const WAIT_SAID_FROM_WEEKS = 12;
/** Past this many weeks: "over a year". */
export const WAIT_YEAR_WEEKS = 52;
export const COUNT_ANOTHER = "Count another button";

/**
 * The pages that hold the chosen button: the page on screen and each ticked
 * language page that carries its slot; a button picked on the page counts on
 * its own page only. The same reading as `buttonRow`.
 */
export function countedPages(
  measure: MeasureProposal | null | undefined,
  chosen: MeasureButton | null,
  ticked: string[],
  pagePath: string,
): string[] {
  if (!chosen) return [];
  const picked = countTargetPage(chosen.section_path);
  if (picked !== null) return [normalizePath(picked)];
  const pages = measure?.per_language ?? [];
  const also = ticked.filter((p) =>
    pages.some((l) => l.path === p && l.slots.includes(chosen.section_path)),
  );
  return [...new Set([pagePath, ...also].map((p) => normalizePath(p)))];
}

/**
 * "Only 1 in 4 visits open the page with this button." Two counts the API
 * gives, divided: the visits of the last 7 days on the pages with the button
 * (the breakdown's `pages`) over all visits of those days (the overview's
 * total). Said only under half, from 30 visits, and only when every one of
 * those pages is in the list: the list holds the busiest pages with 5 visits
 * or more, so a page that is not in it has no number we may guess.
 */
export function shareLine(input: {
  pages: string[];
  rows: readonly Pick<PageRow, "page_path" | "visits">[] | null | undefined;
  total: number | null | undefined;
}): string | null {
  const { pages, rows, total } = input;
  if (pages.length === 0 || !rows || typeof total !== "number") return null;
  if (!(total >= SHARE_MIN_VISITS)) return null;
  let onPages = 0;
  for (const page of pages) {
    const row = rows.find((r) => normalizePath(r.page_path) === page);
    if (!row || !(row.visits > 0)) return null;
    onPages += row.visits;
  }
  if (onPages * 2 >= total) return null;
  return `Only 1 in ${Math.round(total / onPages)} visits open the page with this button.`;
}

/** "A result may take about 30 weeks.", past a year "A result may take over a year." */
export function resultWaitLine(weeks: number | null | undefined): string | null {
  if (typeof weeks !== "number" || !Number.isFinite(weeks)) return null;
  if (weeks > WAIT_YEAR_WEEKS) return "A result may take over a year.";
  if (weeks > WAIT_SAID_FROM_WEEKS) return `A result may take about ${Math.round(weeks)} weeks.`;
  return null;
}

/**
 * The amber line under the test line, in view before the click; Go live
 * itself is the "anyway". Only when this go live would start a test: with
 * the test off, or refused for traffic, there is nothing to warn about
 * (mock A23). Null when neither sentence can be said.
 */
export function goLiveWarning(input: {
  test: GoLiveTest;
  share: string | null;
  wait: string | null;
}): string | null {
  if (input.test.control !== "switch" || !input.test.on) return null;
  const lines = [input.share, input.wait].filter((l): l is string => Boolean(l));
  return lines.length > 0 ? lines.join(" ") : null;
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

export const LIVE_TEST_LINE = "A test is running. Test gives its date after a week of visits.";

// ---------------------------------------------------------------------------
// The paste paragraph (docs/sales/privacy-notice.md, "Paste-ready")
// ---------------------------------------------------------------------------

export const NOTICE_HINT = "Paste it where your notice lists the tools on your site.";

/**
 * Word for word the paste paragraph of docs/sales/privacy-notice.md;
 * test/start/golive.test.ts fails when the two drift apart.
 */
export const NOTICE_PARAGRAPH =
  "This site adapts some of its headings and buttons to the reason a visit appears to have (for example a campaign link, the site a visitor came from, the page opened, or an AI assistant that cited us). No cookies are set for this, no visitor is identified, and nothing about a visitor is stored across visits unless this notice says the site remembers returning visitors. To keep a chosen version consistent while you move between pages, and to show it without delay, the browser tab keeps two short labels and a copy of the adapted headings and texts of the pages you opened, for up to thirty minutes; they are cleared when the tab closes. This copy is the same text everyone arriving the same way sees and holds nothing that identifies you. To count each visit once and to fairly split which visitors see a version being tested, the browser tab holds one random code with no meaning on its own, for up to thirty minutes; it is cleared when the tab closes and is never used to identify a person. When a visitor clicks one of the site's main buttons (for example Start trial), the script records which kind of button it was, the page and that random code, so the operator can count whether the adapted pages lead to more clicks. A button the site shows on every page, such as a menu's contact or phone link, is counted on whichever page it is clicked. While a test runs, some visits, picked at random by that code and by nothing about the visitor, see the original page instead, so the difference can be measured. When the adaptation does not work properly on a page (for example the page could not reach the service, or a heading wrapped differently), the script reports a fixed code and a rounded number about the page, with no visit code and nothing about you, so the operator can fix it. The script also records which known platform a visit came from (for example LinkedIn, Google or ChatGPT, from a fixed list, never the address of the page before) and whether the link carried campaign tags (yes or no, never the tags themselves); these are kept with the page-view records for the life of the operator's account. The service records the country of each visit (from the network connection, never the region or city) with every page view and counted click, so the site owner can see which versions work in which countries. It is kept with those records. It also records the kind of device (phone, tablet or computer) and whether the page opened inside an app, never the browser or device itself, and keeps them with the same records. Rawuser records which page was viewed as its path only: the query string and fragment are never stored, and any part of the path shaped like a record id, a token or an email address is replaced with :id before it is stored.";
