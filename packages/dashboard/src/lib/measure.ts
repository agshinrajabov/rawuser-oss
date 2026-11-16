/**
 * "Measure what Rawuser brings": the customer's own test on Results
 * (mock design/mock/sales-readiness/measure-setup.html, `6fcb113`, approved
 * 2026-10-04; contract docs/specs/proof-engine.md, "The customer's own
 * test" and section G).
 *
 * With no test, three steps: choose the button to count, start the test,
 * get the result. While a test runs, the approved card with "Test: On" and
 * Stop test. After it ends, "Test: Off" and a quiet Start again.
 *
 * One short line per element (founder, 2026-10-04); the exact meaning of
 * "1 in 5" stays under How this works. Pure functions plus the two POSTs
 * with an injectable fetch, tested in test/analytics/measure.test.ts.
 */

import type {
  ConversionTarget,
  ConversionsListResponse,
  CountPickStatusResponse,
  CountPickTokenResponse,
  CustomerTestRefusal,
  CustomerTestResult,
  LiftReport,
  StartBlock,
  TestStart,
} from "@/types/api";
import { COUNT_TARGET_PREFIX, CUSTOMER_TEST_PERCENT, MAX_READ_WEEKS } from "@rawuser/shared";
import { ApiError, apiFetch } from "./api";
import { dayLabel, isRunning, oneIn } from "./proof";
import { COUNTS_ON_EVERY_PAGE, isSiteWideTarget } from "./site-wide";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Which block the page shows
// ---------------------------------------------------------------------------

/** The three steps replace the card only while no test has run (mock decision 1). */
export function showsSetup(report: Pick<LiftReport, "state">): boolean {
  return report.state === "off";
}

/**
 * "Too little traffic to measure the versions within a year"
 * (measure-at-go-live mock, section 06 D): a go-live test that ended for low
 * traffic on day 14, or no test and a start refused for traffic. "Who comes
 * to your site, and why?" then leads the page and "Is it working?" keeps one
 * line and Start anyway.
 */
export function tooLittleTraffic(report: LiftReport): boolean {
  if (report.state === "ended_early" && report.test?.end_reason === "low_traffic") return true;
  return report.state === "off" && report.start?.blocked === "too_little_traffic";
}

/** Which block "Is it working?" shows: the three steps, the card, or the one line. */
export function resultsLayout(report: LiftReport): "setup" | "card" | "too-little" {
  if (tooLittleTraffic(report)) return "too-little";
  return showsSetup(report) ? "setup" : "card";
}

/** "Test: On" from the switch on, the read date included, until it is stopped. */
export function testIsOn(report: Pick<LiftReport, "state">): boolean {
  return isRunning(report) || report.state === "held_back" || report.state === "result";
}

// ---------------------------------------------------------------------------
// The start block, or one built from an older report
// ---------------------------------------------------------------------------

/**
 * `report.start`, or the same answer built from the fields an older
 * generation worker already sends (metric, estimate), so the steps still
 * read right before the new worker is deployed. The date is counted from
 * today, as the mock's note A4 says.
 */
export function startOf(report: LiftReport, now: number): TestStart {
  if (report.start) return report.start;
  const counted = report.metric.labels.length;
  const estimate = report.estimate ?? {
    percent: CUSTOMER_TEST_PERCENT,
    weeks: null,
    eligible_per_month: 0,
    baseline_rate: 0.03,
    rate_source: "default" as const,
  };
  const weeks = estimate.weeks;
  const blocked: StartBlock | null = testIsOn(report)
    ? "running"
    : counted === 0
      ? "no_button"
      : weeks !== null && weeks > MAX_READ_WEEKS
        ? "too_little_traffic"
        : null;
  const read =
    weeks !== null && !testIsOn(report)
      ? new Date(now + weeks * 7 * DAY_MS).toISOString().slice(0, 10)
      : null;
  return {
    counted_buttons: counted,
    can_start: blocked === null,
    blocked,
    estimate,
    read_date: read,
  };
}

// ---------------------------------------------------------------------------
// The three steps
// ---------------------------------------------------------------------------

export type StepMode = "on" | "done" | "locked";

export interface ChosenButton {
  label: string;
  /** "homepage, top"; null when the list has not loaded. */
  place: string | null;
  /** Further counted buttons: "Start free and 1 more". */
  more: number;
}

export interface SetupSteps {
  choose: { mode: StepMode; line: string; chosen: ChosenButton | null };
  start: {
    mode: StepMode;
    line: string;
    /** Null: no Start test button at all (too little traffic). */
    button: { primary: boolean; enabled: boolean } | null;
  };
  result: { mode: StepMode; line: string };
}

export const CHOOSE_LINE = "The click you want more of, like Start or Sign up.";
export const START_LINE = `${oneIn(CUSTOMER_TEST_PERCENT)} visits see your original page, to compare.`;
export const TOO_LITTLE = "Too little traffic to read within a year.";
export const NO_TRAFFIC_YET = "The date comes after the first days of traffic.";

/** "Around Sun 13 Dec, if you start today." */
export function aroundLine(readDate: string): string {
  return `Around ${dayLabel(readDate)}, if you start today.`;
}

/** Step 3's one line: the date, too little traffic, or no traffic yet. */
export function resultLine(start: TestStart, now: number): string {
  if (start.blocked === "too_little_traffic") return TOO_LITTLE;
  const weeks = start.estimate.weeks;
  if (weeks === null) return NO_TRAFFIC_YET;
  if (weeks > MAX_READ_WEEKS) return TOO_LITTLE;
  const read = start.read_date ?? new Date(now + weeks * 7 * DAY_MS).toISOString().slice(0, 10);
  return aroundLine(read);
}

const PLACE: Record<string, string> = {
  hero: "Homepage, top",
  cta: "Homepage, bottom",
  forms: "Homepage, form",
  pricing: "Homepage, pricing",
  features: "Homepage, features",
  features_core: "Homepage, features",
  comparison: "Homepage, comparison",
  social_proof: "Homepage, reviews",
  faq: "Homepage, questions",
};

/**
 * Where a counted button sits, from its section path ("hero.cta.label" ->
 * "Homepage, top"). A button picked with the count link counts on its own
 * page only (visual-picker.md section 9.5), so it says which page. A
 * button on every page (a navbar link added by its selector, or marked
 * `site` by the API) says "Counts on every page".
 */
export function buttonPlace(sectionPath: string, site?: boolean): string {
  if (sectionPath.startsWith(COUNT_TARGET_PREFIX)) {
    const page = sectionPath.slice(COUNT_TARGET_PREFIX.length) || "/";
    return page === "/" ? "Picked on the homepage" : `Picked on ${page}`;
  }
  if (isSiteWideTarget({ section_path: sectionPath, site })) return COUNTS_ON_EVERY_PAGE;
  const head = sectionPath.split(".")[0] ?? "";
  return PLACE[head] ?? "Homepage";
}

/** The counted (enabled) buttons, in the list's order. */
export function countedButtons(items: ConversionTarget[] | null): ConversionTarget[] {
  return (items ?? []).filter((t) => t.enabled);
}

function chosenOf(report: LiftReport, items: ConversionTarget[] | null): ChosenButton | null {
  const on = countedButtons(items);
  if (on.length > 0) {
    const first = on[0] as ConversionTarget;
    const place = buttonPlace(first.section_path, first.site);
    return {
      label: first.label,
      place: place.charAt(0).toLowerCase() + place.slice(1),
      more: on.length - 1,
    };
  }
  const labels = report.metric.labels;
  if (labels.length === 0) return null;
  return { label: labels[0] as string, place: null, more: labels.length - 1 };
}

/** The three steps for a report with no test (mock sections 01 and 02). */
export function setupSteps(
  report: LiftReport,
  items: ConversionTarget[] | null,
  now: number,
): SetupSteps {
  const start = startOf(report, now);
  // The list is fresher than the report right after "Count this button".
  const counted = items ? countedButtons(items).length : start.counted_buttons;
  const chosen = counted > 0 ? chosenOf(report, items) : null;
  const tooLittle =
    start.blocked === "too_little_traffic" ||
    (start.estimate.weeks !== null && start.estimate.weeks > MAX_READ_WEEKS);
  const ready = counted > 0 && !tooLittle;
  return {
    choose: { mode: counted > 0 ? "done" : "on", line: CHOOSE_LINE, chosen },
    start: {
      mode: ready ? "on" : "locked",
      line: START_LINE,
      button: tooLittle ? null : { primary: ready, enabled: ready && start.can_start },
    },
    result: { mode: "locked", line: resultLine(start, now) },
  };
}

/** "Start free and 1 more". */
export function chosenText(c: ChosenButton): string {
  return c.more > 0 ? `${c.label} and ${c.more} more` : c.label;
}

// ---------------------------------------------------------------------------
// The question row: Test: On / Off
// ---------------------------------------------------------------------------

export interface TestStatus {
  on: boolean;
  /** The quiet action beside it. */
  action: "stop" | "start-again" | "choose" | null;
}

export function testStatus(report: LiftReport, now: number): TestStatus {
  if (testIsOn(report)) return { on: true, action: "stop" };
  if (showsSetup(report)) return { on: false, action: null };
  // Ended: a quiet Start again (founder's call 7, "Start again"), or the
  // way to a button when none is counted any more.
  const start = startOf(report, now);
  if (start.can_start) return { on: false, action: "start-again" };
  if (start.blocked === "no_button") return { on: false, action: "choose" };
  return { on: false, action: null };
}

/**
 * A quiet "Change button" beside "Test: Off" (privacy review, measure-at-
 * go-live.md section 9, item 8): the button list, with a picked button's
 * Turn off and Remove, stays one click away after a test ended and on the
 * too-little-traffic layout. Not while a test runs (the server's lock and
 * Stop test stand), not where "Choose button" already opens the list, and
 * not over the three steps, whose step 1 opens it.
 */
export function showsChangeButton(report: LiftReport, noAction: boolean, now: number): boolean {
  if (testIsOn(report)) return false;
  if (noAction) return true;
  if (showsSetup(report)) return false;
  return testStatus(report, now).action !== "choose";
}

/** Stop's one-line confirm (mock section 03). Red only before the read date. */
export function stopConfirm(report: LiftReport): { line: string; danger: boolean } {
  if (report.state === "result") {
    return { line: "The result stays on this page.", danger: false };
  }
  const read = report.test?.read_date;
  return {
    line: read
      ? `It ends before ${dayLabel(read)}, with no answer.`
      : "It ends before its read date, with no answer.",
    danger: true,
  };
}

// ---------------------------------------------------------------------------
// The two POSTs
// ---------------------------------------------------------------------------

export type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

export const TEST_PATH = "/admin/proof/test";
export const COUNT_PATH = "/admin/conversions/count";
export const LIST_PATH = "/admin/conversions/list";

/** The body of a refused call: `{error, reason}`; the sentence is shown as is. */
export function refusalOf(
  e: unknown,
): { status: number; error: string | null; reason: string | null } | null {
  if (!(e instanceof ApiError)) return null;
  const raw = e.message.replace(/^API error \d+: ?/, "");
  try {
    const parsed = JSON.parse(raw) as Partial<CustomerTestRefusal>;
    return {
      status: e.status,
      error: typeof parsed.error === "string" ? parsed.error : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
    };
  } catch {
    return { status: e.status, error: null, reason: null };
  }
}

export type TestOutcome =
  | { kind: "ok"; report: LiftReport }
  | { kind: "refused"; sentence: string; reason: StartBlock | null }
  | { kind: "failed"; message: string };

const FAILED = "That did not go through. Try again in a minute.";

/**
 * POST /admin/proof/test; a 409's sentence comes back as is. `anyway` is
 * "Start anyway" on the too-little-traffic Results: it passes the traffic
 * block only (measure-at-go-live.md section 12).
 */
export async function postTest(
  customerId: string,
  action: "start" | "stop",
  api: Api = apiFetch,
  opts: { anyway?: boolean } = {},
): Promise<TestOutcome> {
  try {
    const body: Record<string, unknown> = { customer_id: customerId, action };
    if (action === "start" && opts.anyway) body.anyway = true;
    const r = await api<CustomerTestResult>(TEST_PATH, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { kind: "ok", report: r.report };
  } catch (e) {
    const r = refusalOf(e);
    if (r?.status === 409 && r.error) {
      return { kind: "refused", sentence: r.error, reason: (r.reason as StartBlock) ?? null };
    }
    return { kind: "failed", message: r?.error ?? FAILED };
  }
}

export type CountOutcome =
  | { kind: "ok"; items: ConversionTarget[] }
  | { kind: "refused"; sentence: string }
  | { kind: "failed"; message: string };

/** POST /admin/conversions/count: this button only. Refused (409) while a test runs. */
export async function countButton(
  customerId: string,
  id: string,
  api: Api = apiFetch,
): Promise<CountOutcome> {
  try {
    const r = await api<ConversionsListResponse>(COUNT_PATH, {
      method: "POST",
      body: JSON.stringify({ customer_id: customerId, id }),
    });
    return { kind: "ok", items: r.items };
  } catch (e) {
    const r = refusalOf(e);
    if (r?.status === 409 && r.error) return { kind: "refused", sentence: r.error };
    return { kind: "failed", message: r?.error ?? FAILED };
  }
}

export const UPSERT_PATH = "/admin/conversions/upsert";

/**
 * Turn a counted button off (privacy review, visual-picker.md section 9.8
 * condition 5: the notice's off switch is "removing the confirmed
 * buttons"). The target's own selectors ride along, so the write never
 * replaces a picked or multi-language button's selectors with the
 * homepage manifest's. Then the list again.
 */
export async function turnOff(
  customerId: string,
  t: ConversionTarget,
  api: Api = apiFetch,
): Promise<CountOutcome> {
  try {
    await api<unknown>(UPSERT_PATH, {
      method: "POST",
      body: JSON.stringify({
        customer_id: customerId,
        id: t.id,
        section_path: t.section_path,
        label: t.label,
        conversion_label: t.conversion_label,
        enabled: false,
        css_selectors: t.css_selectors,
        text_selectors: t.text_selectors,
        structural_selector: t.structural_selector,
      }),
    });
    const list = await api<ConversionsListResponse>(
      `${LIST_PATH}?customer_id=${encodeURIComponent(customerId)}`,
    );
    return { kind: "ok", items: list.items };
  } catch (e) {
    const r = refusalOf(e);
    if (r?.status === 409 && r.error) return { kind: "refused", sentence: r.error };
    return { kind: "failed", message: r?.error ?? FAILED };
  }
}

export const DELETE_PATH = "/admin/conversions/delete";

/** Remove a button for good (the same condition 5), then the list again. */
export async function removeTarget(
  customerId: string,
  t: ConversionTarget,
  api: Api = apiFetch,
): Promise<CountOutcome> {
  try {
    await api<unknown>(DELETE_PATH, { method: "POST", body: JSON.stringify({ id: t.id }) });
    const list = await api<ConversionsListResponse>(
      `${LIST_PATH}?customer_id=${encodeURIComponent(customerId)}`,
    );
    return { kind: "ok", items: list.items };
  } catch (e) {
    const r = refusalOf(e);
    if (r?.status === 409 && r.error) return { kind: "refused", sentence: r.error };
    return { kind: "failed", message: r?.error ?? FAILED };
  }
}

// ---------------------------------------------------------------------------
// The count link: pick the button on the page (visual-picker.md section 9)
// ---------------------------------------------------------------------------

export const PICK_TOKEN_PATH = "/admin/conversions/pick-token";
export const PICK_STATUS_PATH = "/admin/conversions/pick-status";

export type MintOutcome =
  | { kind: "ok"; link: string; pagePath: string }
  | { kind: "refused"; sentence: string }
  | { kind: "failed"; message: string };

/** A one-time count link for the page; 409 (a test runs) comes back as its sentence. */
export async function mintCountPick(
  customerId: string,
  pagePath: string,
  api: Api = apiFetch,
): Promise<MintOutcome> {
  try {
    const r = await api<CountPickTokenResponse>(PICK_TOKEN_PATH, {
      method: "POST",
      body: JSON.stringify({ customer_id: customerId, page_path: pagePath }),
    });
    return { kind: "ok", link: r.link, pagePath: r.page_path };
  } catch (e) {
    const r = refusalOf(e);
    if (r?.status === 409 && r.error) return { kind: "refused", sentence: r.error };
    return { kind: "failed", message: r?.error ?? "Could not make the link. Try again." };
  }
}

export type PollOutcome =
  | { kind: "waiting" }
  | { kind: "landed"; target: ConversionTarget; items: ConversionTarget[] }
  | { kind: "refused"; sentence: string }
  | { kind: "failed"; message: string };

/** One poll of the count link, on the page path the link was minted for. */
export async function pollCountPick(
  customerId: string,
  pagePath: string,
  api: Api = apiFetch,
): Promise<PollOutcome> {
  try {
    const r = await api<CountPickStatusResponse>(
      `${PICK_STATUS_PATH}?customer_id=${encodeURIComponent(customerId)}&page_path=${encodeURIComponent(pagePath)}`,
    );
    return r.landed ? { kind: "landed", target: r.target, items: r.items } : { kind: "waiting" };
  } catch (e) {
    const r = refusalOf(e);
    if (r?.status === 409 && r.error) return { kind: "refused", sentence: r.error };
    // A network hiccup keeps waiting; an answer the server gave is shown.
    if (r && r.status >= 400 && r.error) return { kind: "failed", message: r.error };
    return { kind: "waiting" };
  }
}
