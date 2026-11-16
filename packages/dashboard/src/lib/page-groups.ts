/**
 * Page groups, phase 1 (mock design/mock/sales-readiness/page-groups.html,
 * approved 2026-10-12 as drawn; contract docs/specs/page-groups.md, API).
 * One button counted across the pages that share a layout: the rows on the
 * Pages card, the count pick scoped to a group, the counted list and the
 * second result line on Results.
 *
 * The words are the mock's. A number is printed only when the API gave it.
 * Pure functions plus the calls with an injectable fetch, tested in
 * test/start/page-groups.test.ts and test/analytics/on-versioned.test.ts.
 */

import type {
  ConversionTarget,
  ConversionsListResponse,
  CountPickStatusResponse,
  CountPickTokenResponse,
  LiftReport,
  OnVersioned,
  PageGroupCounts,
  PageGroupView,
  PageGroupsResponse,
  PagesBreakdown,
} from "@/types/api";
import { COUNT_TARGET_PREFIX, GROUP_PATTERN_SUFFIX, groupFixedPart } from "@rawuser/shared";
import { ApiError, apiFetch } from "./api";
import { type Api, LIST_PATH, PICK_STATUS_PATH, PICK_TOKEN_PATH, refusalOf } from "./measure";
import { num, signed } from "./proof";
import { ON_EVERY_PAGE, isSiteWideTarget } from "./site-wide";

export { ON_EVERY_PAGE, isSiteWideTarget } from "./site-wide";

export const GROUPS_PATH = "/admin/pages/groups";
export const GROUPS_DELETE_PATH = "/admin/pages/groups/delete";
export const UPSERT_PATH = "/admin/conversions/upsert";

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

export const COUNT_ON_THESE = "Count a button on these pages";
export const WHAT_IS_THIS = "What is this?";
export const WHAT_LINES = [
  "These pages get no versions yet.",
  "Counting a button here lets your test see clicks on them.",
] as const;
export const OPEN_LINE = "Open any of these pages and click the button to count.";
export const PRIVATE_WINDOW_LINE = "Use a private window. The link works once, for 15 minutes.";
export const WAITING_PICK_LINE = "Waiting for your pick.";
export const WAITING_SUB =
  "Click the button on the page you opened. This screen moves on by itself.";
export const USE_THIS_BUTTON = "Use this button";
export const PICK_AGAIN = "Pick again";
export const REMOVE = "Remove";
export const CANCEL = "Cancel";
export const TEST_RUNNING_LINE = "A test is running. Stop it to change what is counted.";
export const GO_TO_RESULTS = "Go to Test";
export const SENSITIVE_TAG = "Pages are recorded as a group";
export const NOT_FOUND_SOME = "Not found on some of these pages.";
export const SHOW_PAGES = "Show pages";
export const HIDE = "Hide";
export const CARD_SUB_COUNTED = "Clicks on your counted buttons, visits with a signal";
export const ON_VERSIONED_LEAD = "On pages that have versions:";
export const ON_VERSIONED_NOT_ENOUGH = "not enough visits yet.";
export const WHY_TWO_LINES = "Why two lines?";
export const WHY_LINES = [
  "Visits that only opened pages without versions cannot show a difference.",
  "This line leaves them out.",
] as const;

/** "/products/…": the pattern's fixed part and an ellipsis for its free segment. */
export function patternLabel(pattern: string): string {
  return `${groupFixedPart(pattern)}/…`;
}

/** The pattern behind a group's target: `count:/products/*` gives `/products/*`. */
export function groupPatternOf(
  t: Pick<ConversionTarget, "section_path" | "page" | "group">,
): string | null {
  if (t.page?.endsWith(GROUP_PATTERN_SUFFIX)) return t.page;
  const page = t.section_path.startsWith(COUNT_TARGET_PREFIX)
    ? t.section_path.slice(COUNT_TARGET_PREFIX.length)
    : null;
  if (page?.endsWith(GROUP_PATTERN_SUFFIX)) return page;
  return t.group ? page : null;
}

/** True when the target is a group's button. */
export function isGroupTarget(
  t: Pick<ConversionTarget, "section_path" | "page" | "group">,
): boolean {
  return groupPatternOf(t) !== null;
}

/** "69 pages", "1 page"; null without a count. */
export function pagesWord(pages: number | null | undefined): string | null {
  if (typeof pages !== "number" || !Number.isFinite(pages)) return null;
  return pages === 1 ? "1 page" : `${num(pages)} pages`;
}

/**
 * The row's pages phrase: "69 pages share this layout" on the first
 * proposal, "12 pages" on a lighter one and on a counting row. Null without
 * a count.
 */
export function pagesLine(pages: number | null | undefined, lead: boolean): string | null {
  const w = pagesWord(pages);
  if (!w) return null;
  return lead ? `${w} share this layout` : w;
}

/** "190 visits, no versions"; null without a count. */
export function visitsLine(visits: number | null | undefined): string | null {
  if (typeof visits !== "number" || !Number.isFinite(visits)) return null;
  return `${num(visits)} ${visits === 1 ? "visit" : "visits"}, no versions`;
}

/** "The button to count on 69 pages", or "on these pages" without a count. */
export function pickTitle(pages: number | null | undefined): string {
  const w = pagesWord(pages);
  return `The button to count on ${w ?? "these pages"}`;
}

/** "Open /products/… to pick". */
export function openToPick(pattern: string): string {
  return `Open ${patternLabel(pattern)} to pick`;
}

/** "Counts on 69 pages", or "Counts on these pages" without a count. */
export function countsOn(pages: number | null | undefined): string {
  const w = pagesWord(pages);
  return `Counts on ${w ?? "these pages"}`;
}

/** The button's kind, one word: "Contact"; null for `other` or an unknown label. */
export function kindWord(label: string | null | undefined): string | null {
  switch (label) {
    case "signup":
      return "Sign up";
    case "demo_request":
      return "Demo";
    case "trial_start":
      return "Trial";
    case "purchase":
      return "Purchase";
    case "contact":
      return "Contact";
    case "waitlist":
      return "Waitlist";
    case "download":
      return "Download";
    default:
      return null;
  }
}

/** "Contact · Counts on 69 pages", or "Counts on 69 pages" without a kind. */
export function pickedLine(
  t: Pick<ConversionTarget, "conversion_label">,
  pages: number | null | undefined,
): string {
  const kind = kindWord(t.conversion_label);
  const on = countsOn(pages);
  return kind ? `${kind} · ${on}` : on;
}

/** The counting row: 'Counting clicks on "Əlaqə"' or '"Əlaqə", not counted'. */
export function countingLine(label: string, on: boolean): string {
  return on ? `Counting clicks on "${label}"` : `"${label}", not counted`;
}

/** "Not found on 4 of these pages." from the API's own count; the sensitive line names no number. */
export function missingLine(missing: PageGroupView["missing"], sensitive: boolean): string | null {
  if (!missing || typeof missing.pages !== "number" || missing.pages <= 0) return null;
  if (sensitive) return NOT_FOUND_SOME;
  return `Not found on ${num(missing.pages)} of these pages.`;
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

export interface GroupRow {
  pattern: string;
  pages: number | null;
  visits: number | null;
  /** On the customer's list (accepted), with or without a button. */
  accepted: boolean;
  counted: ConversionTarget | null;
  missing: PageGroupView["missing"] | null;
  /** A proposal after the first sits lighter (mock A1). */
  lite: boolean;
}

function count(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * The rows in the card's order: the accepted groups, then the proposals by
 * visits, the first one plain and the rest lighter. An answer without the
 * fields (an older worker, a failed read) gives no rows.
 */
export function groupRows(answer: PageGroupsResponse | null | undefined): GroupRow[] {
  if (!answer || typeof answer !== "object") return [];
  const accepted: GroupRow[] = (Array.isArray(answer.groups) ? answer.groups : [])
    .filter((g) => g && typeof g.pattern === "string")
    .map((g) => ({
      pattern: g.pattern,
      pages: count(g.pages),
      visits: count(g.visits),
      accepted: true,
      counted: g.counted ?? null,
      missing: g.missing ?? null,
      lite: false,
    }));
  const known = new Set(accepted.map((g) => g.pattern));
  const proposals: GroupRow[] = (Array.isArray(answer.proposals) ? answer.proposals : [])
    .filter(
      (p): p is PageGroupCounts => !!p && typeof p.pattern === "string" && !known.has(p.pattern),
    )
    .map((p) => ({
      pattern: p.pattern,
      pages: count(p.pages),
      visits: count(p.visits),
      accepted: false,
      counted: null,
      missing: null,
      lite: false,
    }))
    .sort((a, b) => (b.visits ?? -1) - (a.visits ?? -1));
  // A proposal after the first row sits lighter (mock A1 and A8): the first
  // proposal is plain only when no accepted group stands above it.
  proposals.forEach((p, i) => {
    p.lite = accepted.length > 0 || i > 0;
  });
  return [...accepted, ...proposals];
}

// ---------------------------------------------------------------------------
// Results: the counted list and the second line
// ---------------------------------------------------------------------------

export interface CountedLine {
  id: string;
  label: string;
  /** "on the homepage", "on /pricing", "on 69 pages", "on these pages", "on every page". */
  where: string;
  /** A group's button. */
  group: boolean;
  /** A button on every page (navbar, footer). */
  site: boolean;
}

function groupCounts(pages: PagesBreakdown | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of pages?.groups ?? []) {
    if (g && typeof g.pattern === "string" && typeof g.pages === "number") {
      out.set(g.pattern, g.pages);
    }
  }
  return out;
}

/**
 * The counted buttons under the card's title (mock A16): '"Explore our
 * products" on the homepage', '"Əlaqə" on 69 pages', '"Əlaqə" on every
 * page'. A group's count is the target's own `pages`, else the breakdown's
 * `pages.groups`; without either, "on these pages".
 */
export function countedLines(
  items: ConversionTarget[] | null | undefined,
  pages?: PagesBreakdown | null,
): CountedLine[] {
  const counts = groupCounts(pages);
  return (items ?? []).filter((t) => t.enabled).map((t) => buttonWhere(t, counts));
}

/**
 * Where one button counts, enabled or not (the button list, mock A8, and
 * the counted list, A13): "on the homepage", "on /pricing", "on 69 pages",
 * "on these pages", "on every page". Never a selector.
 */
export function buttonWhere(
  t: ConversionTarget,
  counts: ReadonlyMap<string, number> = new Map(),
): CountedLine {
  const pattern = groupPatternOf(t);
  if (pattern) {
    const n = typeof t.pages === "number" ? t.pages : counts.get(pattern);
    const w = pagesWord(n);
    return {
      id: t.id,
      label: t.label,
      where: `on ${w ?? "these pages"}`,
      group: true,
      site: false,
    };
  }
  if (t.section_path.startsWith(COUNT_TARGET_PREFIX)) {
    const page = t.section_path.slice(COUNT_TARGET_PREFIX.length) || "/";
    return {
      id: t.id,
      label: t.label,
      where: page === "/" ? "on the homepage" : `on ${page}`,
      group: false,
      site: false,
    };
  }
  if (isSiteWideTarget(t)) {
    return { id: t.id, label: t.label, where: ON_EVERY_PAGE, group: false, site: true };
  }
  return { id: t.id, label: t.label, where: "on the homepage", group: false, site: false };
}

/**
 * The list under the title shows once a group or a site-wide button
 * counts, or more than one button does: a customer with one homepage
 * button sees the card as it was (sign-off note 3, decided as drawn).
 */
export function showsCountedList(lines: CountedLine[]): boolean {
  return lines.length > 1 || lines.some((l) => l.group || l.site);
}

/**
 * The second result line ("On pages that have versions") shows once a
 * group or a site-wide button counts: both count clicks on pages without
 * versions, which is what the line leaves out.
 */
export function showsSecondLine(lines: CountedLine[]): boolean {
  return lines.some((l) => l.group || l.site);
}

/** The report's `on_versioned`, when the worker sends one with a readable shape. */
export function onVersionedOf(report: LiftReport | null | undefined): OnVersioned | null {
  const raw = (report as { on_versioned?: unknown } | null | undefined)?.on_versioned;
  if (!raw || typeof raw !== "object") return null;
  return raw as OnVersioned;
}

export interface SecondLine {
  /** The API's own tail after "On pages that have versions:", or "not enough visits yet." */
  text: string;
  /** "range +2% to +48%" in mono, only where the dashboard composed the line itself. */
  range: string | null;
}

/**
 * "On pages that have versions: ..." (mock A17 and A18). The API's own
 * `sentence` is shown as it comes, its lead taken off for the bold label.
 * Without one (an older shape): the lift as "23% more, likely +2% to
 * +48%", else "not enough visits yet.". Null when the report carries no
 * such field, so a customer without it sees the card as it was.
 */
export function secondLine(report: LiftReport): SecondLine | null {
  const v = onVersionedOf(report);
  if (!v) return null;
  if (typeof v.sentence === "string" && v.sentence.trim() !== "") {
    const s = v.sentence.trim();
    const lead = `${ON_VERSIONED_LEAD}`;
    const text = s.startsWith(lead) ? s.slice(lead.length).trim() : s;
    return { text, range: null };
  }
  const range = v.lift ?? null;
  if (v.enough !== true || !range || typeof range.value !== "number") {
    return { text: ON_VERSIONED_NOT_ENOUGH, range: null };
  }
  const p = Math.round(Math.abs(range.value) * 100);
  const word = range.value < 0 ? "fewer" : "more";
  return {
    text: `${p}% ${word}, `,
    range: `likely ${signed(range.low)} to ${signed(range.high)}`,
  };
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

export type GroupsOutcome =
  | { kind: "ok"; answer: PageGroupsResponse }
  | { kind: "none" }
  | { kind: "failed" };

/** GET the groups; a worker without the endpoint (404) is "none": the card stays as it was. */
export async function readGroups(customerId: string, api: Api = apiFetch): Promise<GroupsOutcome> {
  try {
    const answer = await api<PageGroupsResponse>(
      `${GROUPS_PATH}?customer_id=${encodeURIComponent(customerId)}`,
    );
    return answer && typeof answer === "object" ? { kind: "ok", answer } : { kind: "none" };
  } catch (e) {
    const r = refusalOf(e);
    if (r?.status === 404) return { kind: "none" };
    return { kind: "failed" };
  }
}

export type Outcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "refused"; sentence: string }
  | { kind: "failed"; message: string };

const FAILED = "That did not go through. Try again in a minute.";

function outcomeOf<T>(e: unknown, fallback: string): Outcome<T> {
  const r = refusalOf(e);
  if (r && (r.status === 409 || r.status === 400) && r.error) {
    return { kind: "refused", sentence: r.error };
  }
  return { kind: "failed", message: fallback };
}

/** POST /admin/pages/groups: accept a proposal. 409 (five groups, sensitive) as its sentence. */
export async function acceptGroup(
  customerId: string,
  pattern: string,
  api: Api = apiFetch,
): Promise<Outcome<PageGroupView | null>> {
  try {
    const r = await api<{ group?: PageGroupView | null }>(GROUPS_PATH, {
      method: "POST",
      body: JSON.stringify({ customer_id: customerId, pattern }),
    });
    return { kind: "ok", value: r?.group ?? null };
  } catch (e) {
    return outcomeOf(e, FAILED);
  }
}

/** POST /admin/pages/groups/delete: the group and its button go. 409 while a test runs. */
export async function removeGroup(
  customerId: string,
  pattern: string,
  api: Api = apiFetch,
): Promise<Outcome<true>> {
  try {
    await api<unknown>(GROUPS_DELETE_PATH, {
      method: "POST",
      body: JSON.stringify({ customer_id: customerId, pattern }),
    });
    return { kind: "ok", value: true };
  } catch (e) {
    return outcomeOf(e, FAILED);
  }
}

/**
 * The group's switch: the same upsert the button list uses, the target's
 * own selectors riding along. Then the list, so the row shows what is stored.
 */
export async function setGroupCounted(
  customerId: string,
  t: ConversionTarget,
  on: boolean,
  api: Api = apiFetch,
): Promise<Outcome<ConversionTarget | null>> {
  try {
    await api<unknown>(UPSERT_PATH, {
      method: "POST",
      body: JSON.stringify({
        customer_id: customerId,
        id: t.id,
        section_path: t.section_path,
        label: t.label,
        conversion_label: t.conversion_label,
        enabled: on,
        css_selectors: t.css_selectors,
        text_selectors: t.text_selectors,
        structural_selector: t.structural_selector,
      }),
    });
    const list = await api<ConversionsListResponse>(
      `${LIST_PATH}?customer_id=${encodeURIComponent(customerId)}`,
    );
    return { kind: "ok", value: list.items.find((i) => i.id === t.id) ?? null };
  } catch (e) {
    return outcomeOf(e, FAILED);
  }
}

export type MintOutcome =
  | Outcome<{ link: string; pagePath: string }>
  /** The worker found no page of the group to open: ask for one. */
  | { kind: "page_needed"; sentence: string };

/** The 409 code of a group link the worker could not open on its own. */
export const GROUP_PAGE_NEEDED_CODE = "group_page_needed";
export const PASTE_PAGE_LINE = "Paste the address of one of these pages.";

/** The machine word beside a refusal's sentence, when the API gives one. */
function codeOf(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(e.message.replace(/^API error \d+: ?/, "")) as { code?: unknown };
    return typeof parsed.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
}

/**
 * A one-time count link for one page of the group (visual-picker.md section
 * 9, scoped by `group`). `pagePath` is one page the dashboard knows; without
 * one the worker chooses. 409 (a test runs, an unknown group) as its sentence;
 * 409 `group_page_needed` as `page_needed`, so the row asks for a page.
 */
export async function mintGroupPick(
  customerId: string,
  pattern: string,
  pagePath: string | null,
  api: Api = apiFetch,
): Promise<MintOutcome> {
  try {
    const body: Record<string, unknown> = { customer_id: customerId, group: pattern };
    if (pagePath) body.page_path = pagePath;
    const r = await api<CountPickTokenResponse>(PICK_TOKEN_PATH, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { kind: "ok", value: { link: r.link, pagePath: r.page_path } };
  } catch (e) {
    if (codeOf(e) === GROUP_PAGE_NEEDED_CODE) {
      return { kind: "page_needed", sentence: refusalOf(e)?.error ?? PASTE_PAGE_LINE };
    }
    return outcomeOf(e, "Could not make the link. Try again.");
  }
}

/**
 * The path of what the operator pasted: a full address
 * (`https://www.medora.test/products/omega-3?x=1#top`) or a path, the query
 * and the fragment dropped. Null for nothing.
 */
export function pastedPagePath(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  let path = v;
  if (/^https?:\/\//i.test(v)) {
    try {
      path = new URL(v).pathname;
    } catch {
      return null;
    }
  } else if (!v.startsWith("/")) {
    // "www.medora.test/products/omega-3" without its scheme.
    try {
      path = new URL(`https://${v}`).pathname;
    } catch {
      return null;
    }
  }
  path = path.split(/[?#]/, 1)[0] ?? "";
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * The page the next mint sends: the pasted one when the row asked for it,
 * else one the breakdown knows, else none (the worker chooses).
 */
export function pageToSend(
  pasted: string | null,
  pattern: string,
  pages: PagesBreakdown | null | undefined,
): string | null {
  return (pasted !== null ? pastedPagePath(pasted) : null) ?? knownPageOf(pattern, pages);
}

export type PollOutcome =
  | { kind: "waiting" }
  | { kind: "landed"; target: ConversionTarget; items: ConversionTarget[] }
  | { kind: "refused"; sentence: string }
  | { kind: "failed"; message: string };

/** One poll of the group's count link. */
export async function pollGroupPick(
  customerId: string,
  pattern: string,
  api: Api = apiFetch,
): Promise<PollOutcome> {
  try {
    const r = await api<CountPickStatusResponse>(
      `${PICK_STATUS_PATH}?customer_id=${encodeURIComponent(customerId)}&group=${encodeURIComponent(pattern)}`,
    );
    return r.landed ? { kind: "landed", target: r.target, items: r.items } : { kind: "waiting" };
  } catch (e) {
    const r = refusalOf(e);
    if (r?.status === 409 && r.error) return { kind: "refused", sentence: r.error };
    if (r && r.status >= 400 && r.error) return { kind: "failed", message: r.error };
    return { kind: "waiting" };
  }
}

/**
 * One page of the group the dashboard already knows, from the breakdown's
 * page rows (a page without versions, never a sensitive customer's group
 * row). Null when none is known: the worker chooses.
 */
export function knownPageOf(
  pattern: string,
  pages: PagesBreakdown | null | undefined,
): string | null {
  const fixed = groupFixedPart(pattern);
  for (const p of pages?.pages ?? []) {
    if (p.group || p.has_versions) continue;
    const path = p.page_path;
    if (!path.startsWith(`${fixed}/`)) continue;
    const rest = path.slice(fixed.length + 1);
    if (rest.length > 0 && !rest.includes("/") && !rest.startsWith(":")) return path;
  }
  return null;
}
