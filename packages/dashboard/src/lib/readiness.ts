/**
 * The readiness check before go live (mock design/mock/sales-readiness/
 * readiness-check.html, approved as drawn 2026-10-14; contract
 * docs/specs/readiness-check.md, "The API" and "As approved"). One short
 * list on Look above Go live, one question on Connect before the tag, the
 * day-3 traffic line on Results, the full list in the superadmin's Admin
 * block, one column on the customers list.
 *
 * Every sentence on a line and every action label is the API's, rendered as
 * written. The strings here are the ones the mock shows outside the list
 * (its section 08): the question row, the disclosure, the withheld box, the
 * folded summary, the "What does that mean?" lines. No dashes.
 *
 * The response types stay local to the dashboard until the API lands.
 */

import { ApiError, apiFetch } from "./api";

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export const READINESS_PATH = "/admin/onboard/readiness";
export const SPECIAL_CATEGORY_PATH = "/admin/customers/special-category";

export type ReadinessState = "green" | "amber" | "red" | "grey";

export type ReadinessId =
  | "tag"
  | "counted"
  | "contact_hint"
  | "category"
  | "traffic"
  | "language"
  | "terms"
  | "buttons"
  | "versions";

export interface ReadinessAction {
  label: string;
  href: string | null;
}

export interface ReadinessCheck {
  id: ReadinessId | string;
  state: ReadinessState;
  line: string;
  action: ReadinessAction | null;
  known: "now" | "after_day_3";
  blocks: boolean;
  superadmin_only: boolean;
}

export interface ReadinessResponse {
  ok: boolean;
  blocks_go_live: boolean;
  /** The operator's answer: null unanswered. */
  special_category: boolean | null;
  /** True while the answer is null, or true with the site not yet marked. */
  tag_withheld: boolean;
  checks: ReadinessCheck[];
}

export type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

/**
 * The read. `missing` is an older worker (404) or an answer without the
 * list: the screens then behave as before this change (no list, no
 * question, the tag shown). `failed` is any other failure, treated the
 * same way by every screen.
 */
export type ReadinessRead =
  | { kind: "ok"; answer: ReadinessResponse }
  | { kind: "missing" }
  | { kind: "failed" };

function isState(v: unknown): v is ReadinessState {
  return v === "green" || v === "amber" || v === "red" || v === "grey";
}

/** One check as the API writes it, or null when the row is not one. */
function readCheck(raw: unknown): ReadinessCheck | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !isState(r.state) || typeof r.line !== "string") return null;
  const a = r.action;
  let action: ReadinessAction | null = null;
  if (a && typeof a === "object" && typeof (a as Record<string, unknown>).label === "string") {
    const href = (a as Record<string, unknown>).href;
    action = {
      label: (a as Record<string, unknown>).label as string,
      href: typeof href === "string" && href ? href : null,
    };
  }
  return {
    id: r.id,
    state: r.state,
    line: r.line,
    action,
    known: r.known === "after_day_3" ? "after_day_3" : "now",
    blocks: r.blocks === true,
    superadmin_only: r.superadmin_only === true,
  };
}

/** The answer's shape, or null when it is not the readiness answer. */
export function readAnswer(raw: unknown): ReadinessResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.checks)) return null;
  const checks = r.checks.map(readCheck).filter((c): c is ReadinessCheck => c !== null);
  const special = r.special_category === true ? true : r.special_category === false ? false : null;
  return {
    ok: r.ok !== false,
    blocks_go_live: r.blocks_go_live === true || checks.some((c) => c.blocks),
    special_category: special,
    tag_withheld: r.tag_withheld === true,
    checks,
  };
}

export async function readReadiness(
  customerId: string,
  api: Api = apiFetch,
): Promise<ReadinessRead> {
  try {
    const raw = await api<unknown>(
      `${READINESS_PATH}?customer_id=${encodeURIComponent(customerId)}`,
    );
    const answer = readAnswer(raw);
    return answer ? { kind: "ok", answer } : { kind: "missing" };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { kind: "missing" };
    return { kind: "failed" };
  }
}

export type AnswerOutcome =
  | { kind: "ok" }
  /** The API's 409 sentence, shown as written. */
  | { kind: "refused"; sentence: string }
  | { kind: "failed"; message: string };

export const ANSWER_FAILED = "That did not go through. Try again in a minute.";

/** The API's `error` on a 409, exactly as written; null for anything else. */
export function errorSentence(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const raw = e.message.replace(/^API error \d+: ?/, "");
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error ? parsed.error : null;
  } catch {
    return null;
  }
}

/** POST /admin/customers/special-category: the operator's answer about the site. */
export async function answerSpecialCategory(
  customerId: string,
  answer: boolean,
  api: Api = apiFetch,
): Promise<AnswerOutcome> {
  try {
    await api<unknown>(SPECIAL_CATEGORY_PATH, {
      method: "POST",
      body: JSON.stringify({ customer_id: customerId, answer }),
    });
    return { kind: "ok" };
  } catch (e) {
    const sentence = errorSentence(e);
    if (sentence) return { kind: "refused", sentence };
    return { kind: "failed", message: ANSWER_FAILED };
  }
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** Red first, then amber, then green, then grey (mock A4, A18); stable inside a state. */
const RANK: Record<ReadinessState, number> = { red: 0, amber: 1, green: 2, grey: 3 };

export function sortChecks(checks: readonly ReadinessCheck[]): ReadinessCheck[] {
  return checks
    .map((c, i) => ({ c, i }))
    .sort((a, b) => RANK[a.c.state] - RANK[b.c.state] || a.i - b.i)
    .map(({ c }) => c);
}

/**
 * What a session may see. A customer session never receives a superadmin
 * line from the API; the screen filters once more so a line never leaks
 * through a cached or mixed answer. The Look list is the customer's view
 * for a superadmin too (mock A4): the superadmin lines live in Results'
 * Admin block.
 */
export function visibleChecks(
  checks: readonly ReadinessCheck[],
  superadmin: boolean,
): ReadinessCheck[] {
  return sortChecks(checks).filter((c) => superadmin || !c.superadmin_only);
}

/** The list folds to "Ready to go live." when no line is amber or red (A1, A3). */
export function listFolded(checks: readonly ReadinessCheck[]): boolean {
  return !checks.some((c) => c.state === "amber" || c.state === "red");
}

/** The sentence under a closed Go live: the first blocking line (A13). */
export function blockingLine(checks: readonly ReadinessCheck[]): string | null {
  return checks.find((c) => c.blocks)?.line ?? null;
}

export function checkById(
  checks: readonly ReadinessCheck[] | null | undefined,
  id: ReadinessId,
): ReadinessCheck | null {
  return checks?.find((c) => c.id === id) ?? null;
}

/**
 * The day-3 traffic line for Results' test card (A14, A15): the traffic
 * check once it says something a customer can act on. Grey ("Not known
 * yet") is not drawn there.
 */
export function trafficLine(answer: ReadinessResponse | null): ReadinessCheck | null {
  const c = checkById(answer?.checks, "traffic");
  return c && (c.state === "green" || c.state === "amber") ? c : null;
}

// ---------------------------------------------------------------------------
// The customers list, one column (A19)
// ---------------------------------------------------------------------------

export interface ReadinessCount {
  red: number;
  amber: number;
}

export function readinessCount(checks: readonly ReadinessCheck[]): ReadinessCount {
  return {
    red: checks.filter((c) => c.state === "red").length,
    amber: checks.filter((c) => c.state === "amber").length,
  };
}

export const READY_WORD = "Ready";

/** "2 red", "4 amber" in that order; "Ready" when neither. */
export function countWords(count: ReadinessCount): { tone: ReadinessState; text: string }[] {
  const out: { tone: ReadinessState; text: string }[] = [];
  if (count.red > 0) out.push({ tone: "red", text: `${count.red} red` });
  if (count.amber > 0) out.push({ tone: "amber", text: `${count.amber} amber` });
  return out.length > 0 ? out : [{ tone: "green", text: READY_WORD }];
}

// ---------------------------------------------------------------------------
// The question (check 3), the strings outside the list
// ---------------------------------------------------------------------------

export const QUESTION =
  "Is your site about health, religion, sexuality, politics or union membership?";
export const YES = "Yes";
export const NO = "No";
export const WHY_WE_ASK = "Why we ask";
export const WHY_LINES = [
  "On such a site we count product pages as a group, never one by one, and versions make no claim.",
  "The law treats these subjects apart (GDPR Art. 9).",
] as const;
export const CHANGE = "Change";
export const HIDE = "Hide";

/** The tag block while the question is unanswered (A7). */
export const ANSWER_FIRST = "Answer this first.";
/** After a Yes that is not yet marked (A9, A22): the row and the tag block. */
export const YES_HELD_LINE =
  "We need to set this site up for a sensitive topic first. We have been told and will write to you.";
export const TAG_WITH_NOTE = "The tag comes with our note.";

/**
 * The spec's plain ask for an unanswered question with no page hit. The
 * amber line is shown above the question only when it says more than
 * this (A10, "Your page reads like a health site. Tell us if it is."),
 * so the plain ask is never printed twice over the question itself.
 */
export const GENERIC_ASK =
  "Tell us whether your site is about health, religion, sexuality, politics or union membership.";

/** The amber prompt over the question, when the page read gave one (A10). */
export function promptLine(category: ReadinessCheck | null): string | null {
  if (!category || category.state !== "amber") return null;
  return category.line === GENERIC_ASK ? null : category.line;
}

/**
 * What the Connect screen shows for the question and the tag, from the
 * API's answer. `asking` is the row's Change pressed: the question again,
 * the tag as it was.
 */
export type ConnectCategory =
  | { kind: "ask"; prompt: string | null; held: string }
  | { kind: "no"; line: string }
  | { kind: "yes-held"; line: string; held: string }
  | { kind: "yes-marked"; line: string };

export function connectCategory(answer: ReadinessResponse): ConnectCategory {
  const category = checkById(answer.checks, "category");
  if (answer.special_category === null) {
    return { kind: "ask", prompt: promptLine(category), held: ANSWER_FIRST };
  }
  if (answer.special_category === false) {
    return { kind: "no", line: category?.line ?? "" };
  }
  if (answer.tag_withheld) return { kind: "yes-held", line: YES_HELD_LINE, held: TAG_WITH_NOTE };
  return { kind: "yes-marked", line: category?.line ?? "" };
}

// ---------------------------------------------------------------------------
// The list's other strings (A5, A14, A16, A18)
// ---------------------------------------------------------------------------

export const BEFORE_HEADING = "Before you go live";
export const READY_LINE = "Ready to go live.";
export const SHOW_CHECKS = "Show the checks";
/** The tag opened in place under the tag line (A5). */
export const TAG_LABEL = "Tag · first in the head";

export const WHAT_MEAN = "What does that mean?";
/** Behind "What does that mean?" with enough traffic (A14). */
export const TRAFFIC_WHY_OK = [
  "1 in 5 visits see your original page. The rest see a version.",
  "A result needs enough clicks on both sides to tell a change from chance.",
] as const;
/** Behind it with too little traffic (A16). */
export const TRAFFIC_WHY_DIRECTION = [
  "A direction test says which way the versions lean, not by how much.",
  "We start it at 20% and write to you when it can be read.",
] as const;

export function trafficWhy(state: ReadinessState): readonly string[] {
  return state === "amber" ? TRAFFIC_WHY_DIRECTION : TRAFFIC_WHY_OK;
}

export const SUPERADMIN_ONLY = "superadmin only";
export const NO_TAG_UNTIL_MARKED = "no tag until marked";
export const AS_CUSTOMER_SEES = "As the customer sees it, plus the terms";
