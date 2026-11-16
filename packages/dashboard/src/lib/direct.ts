/**
 * Visits with nothing to go on (ADR 0038; docs/specs/direct-visitors.md).
 * Every call, answer reader and word of the dashboard's side is here:
 *
 *   Part 1, the device word and the in-app bit (Settings):
 *     POST /admin/direct-insights/off | /on { customer_id }
 *       -> { ok, customer_id, direct_insights: "on" | "off", cleared, done }
 *     the state is read from the Visitors answer's `direct.recording`.
 *   Part 2, the visitor's own choice (Versions, the Admin block):
 *     GET  /admin/choice?customer_id&path   (path: a language home, `/` by default)
 *     POST /admin/choice { customer_id, path?, on?, question?, answers?, approve_draft?, discard_draft? }
 *     POST /admin/choice/write { customer_id, path? }
 *     POST /admin/choice/preview-link { customer_id, path? } -> { token, link, expires_in_s }
 *     POST /admin/choice/kill { customer_id, killed }   superadmin only
 *   Parts 3 to 5 (Settings):
 *     GET|POST /admin/customers/direct-switches
 *       -> { customer_id, page_one, learned_default, market_versions, markets, allowed }
 *
 * Buyer words only: no intent, cohort, bandit or model on the screen.
 */

import {
  CHOICE_LABEL_MAX,
  CHOICE_MAX,
  CHOICE_MIN,
  CHOICE_QUESTION_MAX,
  CHOICE_SLOTS,
} from "@rawuser/shared";
import { ApiError, apiFetch } from "./api";

export { CHOICE_LABEL_MAX, CHOICE_MAX, CHOICE_MIN, CHOICE_QUESTION_MAX };

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** The `{ error }` of a refused call, as the worker wrote it; null when there is none. */
export function errorOf(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const m = e.message.match(/^API error \d+: (.*)$/s);
  if (!m?.[1]) return null;
  try {
    const body = JSON.parse(m[1]) as { error?: unknown };
    return typeof body.error === "string" && body.error ? body.error : null;
  } catch {
    return null;
  }
}

const FAILED = "That did not go through. Try again in a minute.";
/**
 * Words of a sentence written for us, not for a customer. It names no
 * provider: a failed model call says "request failed", "API", "endpoint",
 * "spare route" or "isolate" whichever model it was, and a worker one
 * deploy behind says the first two beside its provider's name.
 */
const MACHINE =
  /model|provider|endpoint|spare route|request failed|\bapi\b|isolate|timeout|json|workers ai|kv|bundle|sql/i;

/** The worker's sentence when it is one a customer can read, else a plain line. */
export function sayError(e: unknown, fallback = FAILED): string {
  if (e instanceof ApiError && e.status === 500)
    return "Saved, but not everywhere yet. Press it again.";
  const w = errorOf(e);
  if (!w || MACHINE.test(w)) return fallback;
  return w;
}

// ---------------------------------------------------------------------------
// Market versions (part 5): source `mk-{cc}`
// ---------------------------------------------------------------------------

const MARKET = /^mk-([a-z]{2})$/;

/** "mk-gb" -> "GB"; null for any other source word. */
export function marketCode(source: string | null | undefined): string | null {
  const m = MARKET.exec(source ?? "");
  return m?.[1] ? m[1].toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// The switches of parts 3 to 5
// ---------------------------------------------------------------------------

export interface DirectSwitches {
  page_one: boolean;
  learned_default: boolean;
  market_versions: boolean;
  /** "Remember returning visitors" (ADR 0039). */
  remember: boolean;
  /** False: the memory may not run for this site, whatever the switch says. */
  remember_allowed: boolean;
  /** ISO codes the 6-hour run chose, at most three. */
  markets: string[];
  /** False: none of the three may run for this site, whatever the switches say. */
  allowed: boolean;
}
export type DirectSwitchName = "page_one" | "learned_default" | "market_versions" | "remember";

export function readSwitches(raw: unknown): DirectSwitches | null {
  const r = obj(raw);
  if (
    typeof r.page_one !== "boolean" &&
    typeof r.learned_default !== "boolean" &&
    typeof r.market_versions !== "boolean"
  ) {
    return null;
  }
  return {
    page_one: r.page_one !== false,
    learned_default: r.learned_default !== false,
    market_versions: r.market_versions !== false,
    // A worker from before the memory says nothing: shown as off, not for this site.
    remember: r.remember === true,
    remember_allowed: r.remember_allowed === true,
    markets: Array.isArray(r.markets)
      ? r.markets.filter((x): x is string => typeof x === "string" && /^[A-Z]{2}$/.test(x))
      : [],
    // An answer without the field (the spec's own shape) is allowed.
    allowed: r.allowed !== false,
  };
}

export const switchesPath = (customerId: string) =>
  `/admin/customers/direct-switches?customer_id=${encodeURIComponent(customerId)}`;

export type Outcome<T> = { kind: "ok"; value: T } | { kind: "failed"; message: string };

export async function getSwitches(
  customerId: string,
  api: typeof apiFetch = apiFetch,
): Promise<DirectSwitches | null> {
  try {
    return readSwitches(await api<unknown>(switchesPath(customerId)));
  } catch {
    return null;
  }
}

export async function setSwitch(
  customerId: string,
  name: DirectSwitchName,
  on: boolean,
  api: typeof apiFetch = apiFetch,
): Promise<Outcome<DirectSwitches>> {
  try {
    const raw = await api<unknown>("/admin/customers/direct-switches", {
      method: "POST",
      body: JSON.stringify({ customer_id: customerId, [name]: on }),
    });
    const v = readSwitches(raw);
    return v ? { kind: "ok", value: v } : { kind: "failed", message: FAILED };
  } catch (e) {
    return { kind: "failed", message: sayError(e) };
  }
}

/** Part 1's switch: off clears the device word and the in-app bit from past visits too. */
export async function setDirectInsights(
  customerId: string,
  on: boolean,
  api: typeof apiFetch = apiFetch,
): Promise<Outcome<{ on: boolean }>> {
  try {
    const raw = obj(
      await api<unknown>(`/admin/direct-insights/${on ? "on" : "off"}`, {
        method: "POST",
        body: JSON.stringify({ customer_id: customerId }),
      }),
    );
    const v = raw.direct_insights === "off" ? false : raw.direct_insights === "on" ? true : on;
    return { kind: "ok", value: { on: v } };
  } catch (e) {
    return { kind: "failed", message: sayError(e) };
  }
}

/** One short line each, the details behind a disclosure (ui-text-short). */
export const SWITCH_LINES = {
  insights: {
    label: "What direct is made of",
    sub: "Phone, tablet or computer, and whether the page opened inside an app.",
    more: [
      "Shown on Visitors, under Came straight to the page.",
      "We keep one word for the device and one yes or no for an app. Never the browser, the device itself or the screen.",
      "Turning it off removes both from past visits too. That cannot be undone.",
    ],
    notice:
      "It also records the kind of device (phone, tablet or computer) and whether the page opened inside an app, never the browser or device itself, and keeps them with the same records.",
    confirmTitle: "Stop recording the device and app?",
    confirmLine: "Turning it off removes them from past visits too. That cannot be undone.",
    keep: "Keep it on",
  },
  page_one: {
    label: "Page one shapes page two",
    sub: "The page a visitor opens first can choose the words of the next one.",
    more: [
      "Only for visits with nothing else to go on.",
      "The browser tab keeps one word, such as price, and forgets it when the tab closes. No click, time or position is sent.",
    ],
    notice:
      "If a visit gives no reason of its own, the page it opens or the kind of main button clicked may choose the wording of the next page; this is kept in the browser tab only, as one word, and erased when it closes.",
  },
  learned_default: {
    label: "Learn the best default",
    sub: "Visits with nothing to go on get the version that gets the most clicks.",
    more: [
      "Your page as built always stays one of the choices.",
      "The odds come from counts of clicks, never from a person. The visit keeps one choice until the tab closes.",
      "This picks a default. Test is still where you see what versions add.",
    ],
    notice:
      "When a visit gives no reason of its own, the site may show one of its existing versions or the original page, chosen at random with odds learned from how often each was clicked before; the choice is kept in the browser tab for the rest of the visit only.",
  },
  market_versions: {
    label: "Versions for your top countries",
    sub: "Your biggest countries get words written for them, in your page's language.",
    more: [
      "Up to three countries with enough visits, chosen every six hours.",
      "The words follow the country's spelling and formats. Never a price, an offer or who can buy, and never where the reader is from.",
      "A new country version waits for your OK on Versions.",
    ],
    notice:
      "For visits that give no reason of their own, the site may show wording written for the visitor's country or language region (for example British spelling), read from the network connection and the browser's language setting at that moment; it never changes prices, offers or who may buy.",
  },
  remember: {
    label: "Remember returning visitors",
    sub: "A visitor who comes back sees the version for why they first came.",
    more: [
      "The browser keeps a random code and the last reason, on your site only, for 13 months.",
      "Counted on Visitors, under New and returning.",
      "Turning it off stops new codes and reasons. Codes already in browsers are no longer read.",
    ],
    notice:
      "To show a returning visitor the wording that fits why they first came, the browser keeps a random code and the reason of an earlier visit (the kind of site that sent it, such as an AI assistant, or the option they picked) for 13 months from the first visit, and our service receives the code once per visit to count new and returning visitors. The code is not linked to a name, an account, the device or any other site. Clearing the site's data in the browser forgets it.",
  },
  on: "On",
  off: "Off",
  turnOn: "Turn on",
  turnOff: "Turn off",
  saving: "Saving",
  notHere: "Not for this site",
  notHereMore:
    "Not used on a site that handles health or another sensitive subject, or before the question on Connect is answered.",
} as const;

/** "Now: United Kingdom, Germany." or the empty line. */
export function marketsLine(codes: readonly string[], name: (cc: string) => string): string {
  return codes.length
    ? `Now: ${codes.map(name).join(", ")}.`
    : "None yet. A country needs 30 visits a month first.";
}

// ---------------------------------------------------------------------------
// Visitor choice (part 2)
// ---------------------------------------------------------------------------

export interface ChoiceAnswer {
  slot: string;
  label: string;
  intent_dim: string;
  source_dim: string;
}
export interface ChoiceText {
  question: string;
  answers: ChoiceAnswer[];
}
export interface ChoiceCounts {
  days: number;
  /** Visits shown the question. */
  shown: number;
  /** Loads where the bar was not shown, by reason. */
  skipped: { fit: number; anchor: number; covered: number };
  /** Visits that closed the bar without an answer. */
  closed: number;
  /** Visits per slot. */
  answered: Record<string, number>;
  /** Visits that came back with each answer remembered by their browser. */
  returned: Record<string, number>;
  /** Visits shown the question that clicked a button that counts. */
  clicked: number;
  clicked_by_answer: Record<string, number>;
}
export interface ChoiceVersion {
  intent_dim: string;
  source_dim: string;
  headline: string;
}
/** A language home of the site: `/`, or `/az`; each has its own question. */
export interface ChoiceHome {
  path: string;
  lang: string;
  hasQuestion: boolean;
}
export interface ChoiceState {
  /** The language home this state is about. */
  path: string;
  homes: ChoiceHome[];
  on: boolean;
  killed: boolean;
  allowed: boolean;
  live: ChoiceText | null;
  draft: ChoiceText | null;
  hasAnchor: boolean;
  versions: ChoiceVersion[];
  counts: ChoiceCounts;
  /** Seconds until a change reaches every visitor. */
  reachS: number;
}

function readText(v: unknown): ChoiceText | null {
  const r = obj(v);
  const question = s(r.question);
  if (!question || !Array.isArray(r.answers)) return null;
  const answers = r.answers.map(obj).map((a, i) => ({
    slot: s(a.slot) ?? CHOICE_SLOTS[i] ?? String(i),
    label: s(a.label) ?? "",
    intent_dim: s(a.intent_dim) ?? "",
    source_dim: s(a.source_dim) ?? "",
  }));
  return { question, answers };
}

function readRecord(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(obj(v))) out[k] = n(x);
  return out;
}

export function readChoice(raw: unknown): ChoiceState | null {
  const r = obj(raw);
  if (typeof r.on !== "boolean") return null;
  const c = obj(r.counts);
  const sk = obj(c.skipped);
  return {
    on: r.on,
    killed: r.killed === true,
    allowed: r.allowed !== false,
    live: readText(r.live),
    draft: readText(r.draft),
    hasAnchor: r.has_anchor !== false,
    versions: Array.isArray(r.versions)
      ? r.versions.map(obj).map((v) => ({
          intent_dim: s(v.intent_dim) ?? "",
          source_dim: s(v.source_dim) ?? "",
          headline: s(v.headline) ?? "",
        }))
      : [],
    counts: {
      days: n(c.days) || 30,
      shown: n(c.shown),
      skipped: { fit: n(sk.fit), anchor: n(sk.anchor), covered: n(sk.covered) },
      closed: n(c.closed),
      answered: readRecord(c.answered),
      returned: readRecord(c.returned),
      clicked: n(c.clicked),
      clicked_by_answer: readRecord(c.clicked_by_answer),
    },
    reachS: n(r.reaches_visitors_within_s) || 360,
    path: s(r.path) ?? "/",
    homes: Array.isArray(r.homes)
      ? r.homes.map(obj).map((h) => ({
          path: s(h.path) ?? "/",
          lang: s(h.lang) ?? "",
          hasQuestion: h.has_question === true,
        }))
      : [],
  };
}

export const choicePath = (customerId: string, home = "/") =>
  `/admin/choice?customer_id=${encodeURIComponent(customerId)}${home === "/" ? "" : `&path=${encodeURIComponent(home)}`}`;

/** The question of one language home. */
export async function getChoice(
  customerId: string,
  home: string,
  api: typeof apiFetch = apiFetch,
): Promise<Outcome<ChoiceState>> {
  try {
    const v = readChoice(await api<unknown>(choicePath(customerId, home)));
    return v ? { kind: "ok", value: v } : { kind: "failed", message: FAILED };
  } catch (e) {
    return { kind: "failed", message: sayError(e) };
  }
}

async function post(
  path: string,
  body: Record<string, unknown>,
  api: typeof apiFetch,
  fallback?: string,
): Promise<Outcome<ChoiceState> & { written?: string }> {
  try {
    const raw = await api<unknown>(path, { method: "POST", body: JSON.stringify(body) });
    const v = readChoice(raw);
    if (!v) return { kind: "failed", message: FAILED };
    const w = s(obj(raw).written);
    return { kind: "ok", value: v, ...(w ? { written: w } : {}) };
  } catch (e) {
    return { kind: "failed", message: sayError(e, fallback) };
  }
}

export interface ChoiceEdit {
  /** The language home the edit is for (`/` when left out). */
  path?: string;
  on?: boolean;
  question?: string;
  answers?: { label: string; intent_dim: string; source_dim: string }[];
  approve_draft?: true;
  discard_draft?: true;
}

export function saveChoice(customerId: string, edit: ChoiceEdit, api: typeof apiFetch = apiFetch) {
  return post("/admin/choice", { customer_id: customerId, ...edit }, api);
}

/** A question from the brief: live when there is none yet, else it waits for the OK. */
export function writeChoice(customerId: string, api: typeof apiFetch = apiFetch, home = "/") {
  return post(
    "/admin/choice/write",
    { customer_id: customerId, path: home },
    api,
    "We could not write a question just now. Try again in a minute.",
  );
}

/** Superadmin only: off for every visitor, whatever the customer's switch says. */
export function killChoice(customerId: string, killed: boolean, api: typeof apiFetch = apiFetch) {
  return post("/admin/choice/kill", { customer_id: customerId, killed }, api);
}

export async function previewLink(
  customerId: string,
  api: typeof apiFetch = apiFetch,
  home = "/",
): Promise<Outcome<{ link: string; expiresS: number }>> {
  try {
    const r = obj(
      await api<unknown>("/admin/choice/preview-link", {
        method: "POST",
        body: JSON.stringify({ customer_id: customerId, path: home }),
      }),
    );
    const link = s(r.link);
    if (!link || !/^https:\/\//.test(link)) return { kind: "failed", message: FAILED };
    return { kind: "ok", value: { link, expiresS: n(r.expires_in_s) || 900 } };
  } catch (e) {
    return { kind: "failed", message: sayError(e) };
  }
}

/** "about 6 minutes". */
export function reachText(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  return `about ${m} ${m === 1 ? "minute" : "minutes"}`;
}

export function answeredTotal(c: ChoiceCounts): number {
  return Object.values(c.answered).reduce((t, x) => t + x, 0);
}

export interface AnswerRow {
  slot: string | null;
  label: string;
  chose: number;
  clicked: number;
  /** Clicked over chose; null with none. */
  rate: number | null;
  best: boolean;
}

/** One row per answer and "Did not answer" last (shown minus answered). */
export function answerRows(text: ChoiceText, c: ChoiceCounts): AnswerRow[] {
  const rows: AnswerRow[] = text.answers.map((a) => {
    const chose = c.answered[a.slot] ?? 0;
    const clicked = c.clicked_by_answer[a.slot] ?? 0;
    return {
      slot: a.slot,
      label: a.label,
      chose,
      clicked,
      rate: chose > 0 ? clicked / chose : null,
      best: false,
    };
  });
  const top = Math.max(0, ...rows.map((r) => r.rate ?? 0));
  if (top > 0) for (const r of rows) r.best = r.rate === top;
  const answered = rows.reduce((t, r) => t + r.chose, 0);
  const clickedAnswered = rows.reduce((t, r) => t + r.clicked, 0);
  const chose = Math.max(0, c.shown - answered);
  const clicked = Math.max(0, c.clicked - clickedAnswered);
  rows.push({
    slot: null,
    label: "Did not answer",
    chose,
    clicked,
    rate: chose > 0 ? clicked / chose : null,
    best: false,
  });
  return rows;
}

/** The big line on the card. */
export function choiceLead(state: ChoiceState): { lead: string; tail: string | null } {
  const c = state.counts;
  const text = state.live;
  if (!state.on || c.shown === 0 || !text) {
    return {
      lead: "These visits come with nothing to go on.",
      tail: state.on
        ? "The question shows from their next visit."
        : "They see your page as built. You can ask them why they came.",
    };
  }
  const answered = answeredTotal(c);
  const top = text.answers
    .map((a) => ({ a, v: c.answered[a.slot] ?? 0 }))
    .sort((x, y) => y.v - x.v)[0];
  return {
    lead: `${c.shown.toLocaleString("en-US")} ${c.shown === 1 ? "visit" : "visits"} saw the question and ${answered.toLocaleString("en-US")} answered.`,
    tail: top && top.v > 0 && answered >= 10 ? `Most chose "${top.a.label}".` : null,
  };
}

/** "34% answer" for the kind list; null before anyone saw it. */
export function answerShare(state: ChoiceState | null | undefined): string | null {
  if (!state?.on || state.killed || state.counts.shown === 0) return null;
  return `${Math.round((answeredTotal(state.counts) / state.counts.shown) * 100)}% answer`;
}

/** Visits that came back and saw their remembered answer at once, in words; null with none. */
export function returnedLine(c: ChoiceCounts): string | null {
  const total = Object.values(c.returned).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  return `${total.toLocaleString("en-US")} ${total === 1 ? "visit" : "visits"} came back and saw their answer's version at once, without being asked again.`;
}

/** Loads where the bar was not shown, and visits that closed it, in words; null with neither. */
export function skippedLine(c: ChoiceCounts): string | null {
  const parts: string[] = [];
  if (c.skipped.fit) parts.push(`${c.skipped.fit} had no room at the bottom`);
  if (c.skipped.anchor) parts.push(`${c.skipped.anchor} found no headline`);
  if (c.skipped.covered) parts.push(`${c.skipped.covered} had something over it`);
  const total = c.skipped.fit + c.skipped.anchor + c.skipped.covered;
  const closed = c.closed
    ? `${c.closed} ${c.closed === 1 ? "visitor" : "visitors"} closed it without an answer.`
    : "";
  if (total === 0) return closed || null;
  const not = `Not shown on ${total} ${total === 1 ? "load" : "loads"}: ${parts.join(", ")}. Those visitors saw your page as built.`;
  return closed ? `${not} ${closed}` : not;
}

/** An edited question and answers, checked before the call (the worker screens again). */
export function checkEdit(text: ChoiceText): string | null {
  const q = text.question.trim();
  if (!q) return "Write a question.";
  if (q.length > CHOICE_QUESTION_MAX)
    return `Keep the question under ${CHOICE_QUESTION_MAX + 1} characters.`;
  if (text.answers.length < CHOICE_MIN || text.answers.length > CHOICE_MAX) {
    return `Give ${CHOICE_MIN} to ${CHOICE_MAX} answers.`;
  }
  for (const a of text.answers) {
    const l = a.label.trim();
    if (!l) return "Every answer needs words.";
    if (l.length > CHOICE_LABEL_MAX)
      return `Keep each answer under ${CHOICE_LABEL_MAX + 1} characters.`;
    if (!a.intent_dim || !a.source_dim) return "Choose the version each answer shows.";
  }
  if (/[–—]/.test(q + text.answers.map((a) => a.label).join(""))) {
    return "Use a comma or a full stop instead of a long dash.";
  }
  return null;
}

/** The notice sentence (docs/specs/direct-visitors.md §2), to paste. */
export const CHOICE_NOTICE =
  "If a visitor picks an option such as their role on the page, the page shows wording for that choice for the rest of the visit.";

export const CHOICE_LINES = {
  title: "Visitor choice",
  sub: "One question at the bottom of the screen, once per tab. Each answer shows its own version.",
  firstBox: "We wrote the answers from your brief. Check the words, then turn it on.",
  none: "No question yet. We write one from your brief, with an answer for each kind of visitor.",
  write: "Write a question",
  suggest: "Suggest from your brief",
  noAnchor: "Your home page needs a main button first. The question sits under it.",
  notHere:
    "Not for this site. We never ask on a site that handles health or another sensitive subject, or before the question on Connect is answered.",
  killed: "Rawuser turned this off for your site. Write to us to turn it back on.",
  homeOnly: "The question shows on your home page only.",
  compare:
    "People who answer are keener to begin with, so compare answers with each other. Test shows what asking adds.",
  draft: "A new question waits for your OK. Visitors keep the one below until you approve.",
  previewOpen: "Open your page with the question",
  previewNote: "Only you see it there. The link works once, for 15 minutes.",
  never: [
    "Nothing about health, religion, politics, sexuality or union membership.",
    "An answer never changes a price, an offer or who can buy.",
  ],
} as const;
