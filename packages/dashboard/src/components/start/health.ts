import { dayTime } from "@/lib/install";
import type { InstallPlatform, TagFlag, TagPosition } from "@/types/api";
import { normalizePath } from "@rawuser/shared";

/**
 * The page health line on the Pages card (docs/specs/snippet-issues.md,
 * phase 2). Reads the aggregates of GET /admin/health/issues and turns a
 * page's problems into at most two plain sentences: the most frequent in
 * full, the second short. Pure, so the copy is tested without a browser.
 */

export type IssueCode =
  | "select_failed"
  | "reveal_cap"
  | "apply_error"
  | "rich_failed"
  | "lines_changed"
  | "swap_shift"
  | "reverted"
  /** The tag ran after the page appeared (install-friction D, condition 4). */
  | "late_tag";

export interface HealthIssue {
  code: IssueCode;
  count: number;
  share: number;
  slot: string | null;
}

export interface HealthPage {
  page_path: string;
  loads: number;
  issues: HealthIssue[];
}

/**
 * The site-wide install facts from the six-hourly probe (install-friction,
 * UI item 5): closed enums and times only; the lines come from the probe.
 */
export interface HealthSite {
  probed_at: number | null;
  csp_blocks: boolean;
  csp_blocks_since: number | null;
  csp_degrades: boolean;
  csp_report_only_blocks: boolean;
  platform: InstallPlatform | null;
  tag_position: TagPosition | null;
  tag_flags: TagFlag[];
}

/** The answer of GET /admin/health/issues (packages/generation/src/admin/snippet-issues.ts). */
export interface HealthIssuesResponse {
  customer_id: string;
  hours: number;
  since: number;
  loads: number;
  pages: HealthPage[];
  site?: HealthSite | null;
  /** Absent from a worker older than 2026-10-12. */
  late?: LateTagShare | null;
}

/**
 * The last 7 days, whatever `hours` says (docs/specs/late-tag.md, "The Pages
 * card's read"): visits that met a page with a version ready, and how many
 * of them met one painted before our script ran. Not a share of all visits.
 */
export interface LateTagShare {
  exposures: number;
  late_exposures: number;
  /** late_exposures / exposures; null with no visit. */
  share: number | null;
  /** 30 visits or more: the share may be said. */
  enough: boolean;
}

export type HealthTone = "warn" | "err";

export interface HealthLine {
  tone: HealthTone;
  text: string;
  /**
   * "part" opens the picker as the missing-parts line does; "page" opens the
   * page; "tag" opens the tag's status with the fix.
   */
  link: "part" | "page" | "tag" | null;
}

/** A problem is shown only when at least this many page loads had it. */
export const MIN_LOADS_WITH_PROBLEM = 3;
/** Below this many loads on a page, the line writes counts, not a percentage. */
export const MIN_LOADS_FOR_SHARE = 100;
/** At most this many health lines under one page. */
export const MAX_HEALTH_LINES = 2;

const TONE: Record<IssueCode, HealthTone> = {
  lines_changed: "warn",
  swap_shift: "warn",
  reverted: "warn",
  late_tag: "warn",
  select_failed: "err",
  reveal_cap: "err",
  apply_error: "err",
  rich_failed: "err",
};

export function issueTone(code: IssueCode): HealthTone {
  return TONE[code];
}

const PART_NAMES: Record<string, string> = {
  "hero.headline": "the headline",
  "hero.body": "the opening paragraph",
  "hero.cta.label": "the main button",
  "cta.cta.label": "the call-to-action button",
  "features.headline": "the section headline",
  "features.body": "the section paragraph",
  "pricing.cta.label": "the pricing button",
  "forms.submit_label": "the form button",
};

/** "cta.cta.label" becomes "the call-to-action button": plain words for the card. */
export function partName(path: string): string {
  return PART_NAMES[path] ?? path;
}

/** Plain words for a reported slot, or null when it has none we can name. */
function slotWords(slot: string | null): string | null {
  return slot ? (PART_NAMES[slot] ?? null) : null;
}

/** The two ways a line opens: "On 7% of visits in the last 24 h" and "On 7%". */
function lead(issue: HealthIssue, loads: number, hours: number): { full: string; short: string } {
  const window = `in the last ${hours} h`;
  if (loads < MIN_LOADS_FOR_SHARE) {
    const n = Math.min(issue.count, loads);
    return { full: `On ${n} of ${loads} visits ${window}`, short: `On ${n} of ${loads}` };
  }
  const pct = Math.round(issue.share * 100);
  const share = pct < 1 ? "fewer than 1%" : `${pct}%`;
  return { full: `On ${share} of visits ${window}`, short: `On ${share}` };
}

function fullLine(issue: HealthIssue, opener: string): Omit<HealthLine, "tone"> {
  const part = slotWords(issue.slot);
  switch (issue.code) {
    case "select_failed":
      return {
        text: `${opener}, Rawuser did not answer in time, so visitors saw your original page. Nothing to change on your side.`,
        link: null,
      };
    case "reveal_cap":
      return {
        text: `${opener}, the version came too late, so visitors saw your original page. Nothing to change on your side.`,
        link: null,
      };
    case "apply_error":
      return {
        text: `${opener}, Rawuser hit an error while writing ${part ?? "this page"}. Nothing to change on your side.`,
        link: null,
      };
    case "rich_failed":
      return {
        text: `${opener}, a file Rawuser needs for this page did not load, so the headline stayed as you built it. Nothing to change on your side.`,
        link: null,
      };
    case "lines_changed":
      return {
        text: `${opener}, ${part ?? "a part of the page"} took more lines than yours.`,
        link: "part",
      };
    case "swap_shift":
      return { text: `${opener}, your page moved when the words changed.`, link: "page" };
    case "reverted":
      return {
        text: part
          ? `${opener}, your page put its own words back in ${part}, so those visitors saw yours.`
          : `${opener}, your page put its own words back, so those visitors saw yours.`,
        link: "part",
      };
    case "late_tag":
      return {
        // A page painted first stays as built for that load (docs/specs/late-tag.md).
        text: `${opener}, your tag ran after the page appeared, so those visitors saw your page as you built it.`,
        link: "tag",
      };
  }
}

function shortLine(issue: HealthIssue, opener: string): string {
  const part = slotWords(issue.slot);
  switch (issue.code) {
    case "select_failed":
      return `${opener}, Rawuser did not answer and visitors saw your original page.`;
    case "reveal_cap":
      return `${opener}, the version came too late and visitors saw your original page.`;
    case "apply_error":
      return `${opener}, Rawuser hit an error while writing ${part ?? "this page"}.`;
    case "rich_failed":
      return `${opener}, a file Rawuser needs did not load and the headline stayed as you built it.`;
    case "lines_changed":
      return `${opener}, ${part ?? "a part of the page"} took more lines than yours.`;
    case "swap_shift":
      return `${opener}, your page moved when the words changed.`;
    case "reverted":
      return part
        ? `${opener}, your page put its own words back in ${part}.`
        : `${opener}, your page put its own words back.`;
    case "late_tag":
      return `${opener}, your tag ran after the page appeared.`;
  }
}

/**
 * The health lines under one page: problems seen on at least three loads,
 * the most frequent first and written in full, the second short, never
 * more than two. A clean page, or a page with no data, gets none. `skip`
 * leaves codes out before the two are chosen: the late tag's own line
 * (`lateTagLine`) replaces `late_tag` when it shows.
 */
export function healthLines(
  page: HealthPage | undefined,
  hours = 24,
  skip: readonly IssueCode[] = [],
): HealthLine[] {
  if (!page || page.loads <= 0) return [];
  const shown = page.issues
    .filter((i) => i.code in TONE && !skip.includes(i.code) && i.count >= MIN_LOADS_WITH_PROBLEM)
    .sort((a, b) => b.count - a.count || b.share - a.share)
    .slice(0, MAX_HEALTH_LINES);
  return shown.map((issue, idx) => {
    const opener = lead(issue, page.loads, hours);
    if (idx === 0) return { tone: issueTone(issue.code), ...fullLine(issue, opener.full) };
    return { tone: issueTone(issue.code), text: shortLine(issue, opener.short), link: null };
  });
}

/** Pages keyed by normalized path, so "/az" and "/az/" are the same page. */
export function healthByPath(resp: HealthIssuesResponse | null): Map<string, HealthPage> {
  const map = new Map<string, HealthPage>();
  for (const p of resp?.pages ?? []) map.set(normalizePath(p.page_path), p);
  return map;
}

export function healthFor(
  byPath: Map<string, HealthPage>,
  pagePath: string,
): HealthPage | undefined {
  return byPath.get(normalizePath(pagePath));
}

/**
 * Loads the last day's problems for one customer. Silent by design: the
 * endpoint is scoped to the signed-in user's customer, so a 403 (another
 * customer) or any other failure leaves the card as it was; every error
 * resolves to null.
 */
export async function loadHealth(
  customerId: string,
  fetcher: <T>(path: string) => Promise<T>,
): Promise<HealthIssuesResponse | null> {
  try {
    const r = await fetcher<HealthIssuesResponse>(
      `/admin/health/issues?customer_id=${encodeURIComponent(customerId)}&hours=24`,
    );
    return r && Array.isArray(r.pages) ? r : null;
  } catch {
    return null;
  }
}

/**
 * The site-wide line under the Pages card's intro: the site's security
 * policy blocks the tag on every page. Amber (the founder's call,
 * 2026-10-04): the change is on the customer's side. Null when it does not
 * block.
 */
export function siteLine(site: HealthSite | null | undefined): string | null {
  if (!site?.csp_blocks) return null;
  if (site.csp_blocks_since) {
    return `Since ${dayTime(site.csp_blocks_since)}, your site's security policy blocks Rawuser, so visitors see your pages as built.`;
  }
  return "Your site's security policy now blocks Rawuser, so visitors see your pages as built.";
}

// ---------------------------------------------------------------------------
// The tag at the bottom of the page (mock design/mock/sales-readiness/
// pilot-gaps.html, screen 06, approved 2026-10-12; docs/specs/late-tag.md,
// "What is counted and shown")
// ---------------------------------------------------------------------------

/** From this share of the visits on, the cost of a late tag is said. */
export const LATE_SHARE_SAID_FROM = 0.05;

export const LATE_CAUSE_LINE = "Your tag sits at the end of your page.";
export const LATE_TOO_FEW_LINE =
  "Your tag sits at the end of your page. Too few visits yet to say what that costs.";

export interface LateTagLine {
  /** Amber: a measured cost. Quiet: the tag's place only, too few visits to say. */
  tone: "warn" | "quiet";
  text: string;
  /** The first line behind "What you can do", when the probe saw the tag at the end. */
  cause: string | null;
  /** What the number counts, said behind the disclosure (the analytics note). */
  counted: string | null;
}

/** "1 in 10", or "most" when it is nearer every visit than every second. */
function oneInWords(share: number): { visits: string; of: string } {
  const n = Math.round(1 / share);
  if (n <= 1) return { visits: "On most visits", of: "Most" };
  return { visits: `On about 1 in ${n} visits`, of: `About 1 in ${n}` };
}

/**
 * The late tag's one line on the Pages card, or null:
 * - amber, with the share, from 30 visits and a share of 5% or more;
 * - quiet, when the tag sits at the end of the page and the visits are too
 *   few to say a share;
 * - nothing otherwise (the tag in the head or first in the body with a share
 *   under 5%, a tag at the end whose measured share is under 5%, or a worker
 *   that sends no `late`).
 */
export function lateTagLine(resp: HealthIssuesResponse | null | undefined): LateTagLine | null {
  const late = resp?.late;
  if (!late || typeof late !== "object") return null;
  const atEnd = resp?.site?.tag_position === "body_late";
  if (late.enough === true) {
    const share = late.share;
    if (typeof share !== "number" || !(share >= LATE_SHARE_SAID_FROM)) return null;
    const words = oneInWords(share);
    return {
      tone: "warn",
      text: `${words.visits} your page appeared before the versions were ready.`,
      cause: atEnd ? LATE_CAUSE_LINE : null,
      counted: `${words.of} of the visits that would get a version, in the last 7 days.`,
    };
  }
  if (atEnd) return { tone: "quiet", text: LATE_TOO_FEW_LINE, cause: null, counted: null };
  return null;
}
