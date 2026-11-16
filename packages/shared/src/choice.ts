/**
 * The visitor's own choice (ADR 0038 part 2; docs/specs/direct-visitors.md
 * §2): one optional question on the home page, for visits
 * with no signal of their own. Each answer points to an existing version of
 * the home page; the answer the visitor taps is kept in the tab's carry as
 * one word (`q{slot}:direct`) and nothing else.
 *
 * Pure data and functions. The question and the answers are the customer's
 * own words (or model words the customer approved), screened for special
 * categories; nothing about a visitor is in them. Since 2026-11-04 the
 * question is a bar at the bottom of the screen (rich.js, choice.ts): no
 * space is reserved in the page, so the customer's script carries nothing
 * for it.
 */

import { INTENT_DIMENSIONS, SOURCE_DIMENSIONS } from "./vector/dimensions.ts";

/** The slots of the answers, in order. */
export const CHOICE_SLOTS = ["a", "b", "c", "d"] as const;
export type ChoiceSlot = (typeof CHOICE_SLOTS)[number];
/** Answers: at least two, three by default, four at most (the mock, Q5). */
export const CHOICE_MIN = 2;
export const CHOICE_MAX = 4;
export const CHOICE_DEFAULT = 3;
/** The longest question and answer, in characters. */
export const CHOICE_QUESTION_MAX = 60;
export const CHOICE_LABEL_MAX = 32;

/** One answer: its slot, its words, and the version it points to. */
export type ChoiceAnswer = [slot: ChoiceSlot, label: string, intent: string, source: string];

/** The stored question (`customers.choice`, `choice_draft`) and the bundle's `qc`. */
export interface ChoiceConfig {
  q: string;
  a: ChoiceAnswer[];
  /** The hero's main button, its css selectors from the home page's manifest. */
  s: string[];
}

/** What a browser receives (`q` on a /select answer): the words and the anchor, never the cells. */
export interface ChoiceClient {
  t: string;
  a: Array<[ChoiceSlot, string]>;
  s: string[];
  /** 1 in the operator's preview: nothing kept, nothing sent. */
  p?: 1;
  /** 1 while "Remember returning visitors" is on: the answer is kept in the browser with the visitor's code. */
  m?: 1;
}

/** The sources an answer may point to: the written ones and the base version. */
const CELL_SOURCES: readonly string[] = [
  "default",
  ...SOURCE_DIMENSIONS.filter((s) => s !== "direct"),
];

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  // No dashes of the two long kinds, no markup, no line breaks.
  if (!t || t.length > max || /[<>–—]/.test(t)) return null;
  return t;
}

/**
 * A stored question read back, or null when it is not one: 2 to 4 answers in
 * slot order, words within their lengths, each pointing to a known cell,
 * no two to the same cell. The anchor (the main button, whose look the bar
 * borrows) may be empty since the bar (2026-11-04): it needs no button to sit under.
 */
export function parseChoice(raw: unknown): ChoiceConfig | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const o = v as { q?: unknown; a?: unknown; s?: unknown };
  const q = cleanText(o.q, CHOICE_QUESTION_MAX);
  if (!q || !Array.isArray(o.a) || o.a.length < CHOICE_MIN || o.a.length > CHOICE_MAX) return null;
  const answers: ChoiceAnswer[] = [];
  const cells = new Set<string>();
  for (const [i, e] of o.a.entries()) {
    if (!Array.isArray(e) || e.length !== 4) return null;
    const [slot, label, intent, source] = e as unknown[];
    if (slot !== CHOICE_SLOTS[i]) return null;
    const words = cleanText(label, CHOICE_LABEL_MAX);
    if (!words) return null;
    if (!(INTENT_DIMENSIONS as readonly unknown[]).includes(intent)) return null;
    if (!CELL_SOURCES.includes(source as string)) return null;
    const cell = `${intent}:${source}`;
    if (cells.has(cell)) return null;
    cells.add(cell);
    answers.push([slot as ChoiceSlot, words, intent as string, source as string]);
  }
  const s = Array.isArray(o.s)
    ? o.s.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200)
    : [];
  return { q, a: answers, s: s.slice(0, 3) };
}

/**
 * A customer's questions, one for the home page of each language it writes
 * (docs/specs/direct-visitors.md §2, "A question per language"): `/` and,
 * say, `/az`, each in that page's language, its answers pointing to that
 * page's own versions. A question stored before 2026-11-04 (one object) is
 * the question of `/`.
 */
export type ChoiceSet = Record<string, ChoiceConfig>;

/** A language's home page: `/`, or a path that is a language prefix only (`/az`, `/en-gb/`). */
export function isLanguageHome(path: string): boolean {
  return path === "/" || /^\/[a-z]{2}(?:-[a-z]{2})?\/?$/i.test(path);
}

/** The stored set read back; a question that does not parse, or not on a language home, is left out. */
export function parseChoiceSet(raw: unknown): ChoiceSet {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  if ("q" in v) {
    const one = parseChoice(v);
    return one ? { "/": one } : {};
  }
  const out: ChoiceSet = {};
  for (const [path, c] of Object.entries(v as Record<string, unknown>)) {
    const parsed = isLanguageHome(path) ? parseChoice(c) : null;
    if (parsed) out[path] = parsed;
  }
  return out;
}

/** The browser's part of a question: the words and the anchor, never which version an answer opens. */
export function choiceClient(c: ChoiceConfig, preview = false, remember = false): ChoiceClient {
  return {
    t: c.q,
    a: c.a.map(([slot, label]) => [slot, label]),
    s: c.s,
    ...(preview ? { p: 1 } : {}),
    ...(remember && !preview ? { m: 1 } : {}),
  };
}

/** The tab's carry for an answer (`qa:direct`). */
export function choiceCarry(slot: ChoiceSlot): string {
  return `q${slot}:direct`;
}

/**
 * The slot of a carry that holds an answer, or null: `qa:direct` for an
 * answer taken in this tab, `ra:direct` for one the visitor's browser
 * remembered from an earlier visit (the recall, below).
 */
export function choiceSlotOf(carry: string | null | undefined): ChoiceSlot | null {
  const m = typeof carry === "string" ? /^[qr]([a-d]):direct$/.exec(carry) : null;
  return m ? (m[1] as ChoiceSlot) : null;
}

/** True for a remembered answer (`ra:direct`): the visitor came back. */
export function choiceRecalled(carry: string | null | undefined): boolean {
  return typeof carry === "string" && /^r[a-d]:direct$/.test(carry);
}

/**
 * The visitor's browser keeps its own code this long from the first visit,
 * 13 months, never extended by a later visit (the cookie-lifetime bound
 * CNIL sets; ADR 0039 as amended 2026-11-05).
 */
export const REMEMBER_MS = 395 * 86_400_000;

/** The visitor's own code (ADR 0039): 32 random hex characters drawn in its browser. */
export const PERSON_SHAPE = /^[0-9a-f]{32}$/;

/** A reason the browser may remember: an intent and a source the visit gave, never `direct`. */
const REASON = `(${INTENT_DIMENSIONS.join("|")}):(${SOURCE_DIMENSIONS.filter((s) => s !== "direct").join("|")})`;

/** A remembered reason as the `returned` row carries it (`rc`), e.g. `problem:ai`. */
export const REMEMBERED_REASON = new RegExp(`^${REASON}$`);

/**
 * The visitor memory (docs/specs/direct-visitors.md §2, "A visitor who comes
 * back"; ADR 0039 as amended 2026-11-05): a statement the edge puts in the
 * customer's script, after the configuration and before the boot, while the
 * customer's "Remember returning visitors" is on (`rm`).
 *
 * The browser keeps `localStorage.__rw_pick`: the visitor's own code `p`
 * (32 random hex characters drawn on its first page, never derived from the
 * device), the time of that first page `f`, and the last reason the visit
 * gave `k`: a tapped answer (`ra:direct`, written by the bar) or the source
 * and intent of a visit that came with one (`problem:ai`, copied from the
 * tab's carry when the page is left). A new tab with no carry of its own
 * starts with that reason as its carry, so a visitor who came from ChatGPT
 * and comes back by typing the address sees the ChatGPT version again; a
 * link or source of the new visit still wins at the edge.
 *
 * Every new visit sends one `choice` row with the code and the visit marker:
 * `first` for a code drawn now, `returned` for one kept from before (with
 * `qa`, the answer's slot, or `rc`, the reason, when one was given back).
 * After 13 months from the first page the browser forgets all of it and
 * draws a new code. The code lives on the customer's own domain only, so no
 * two customers ever see the same one, and the server never joins it
 * across customers.
 */
export function rememberJs(): string {
  return `try{if(!/rawuser_/.test(location.hash)){var s=sessionStorage,L=localStorage,K="__rw_pick",n=Date.now(),w=window.__rw,H=/^[0-9a-f]{32}$/,G=/^${REASON}$/,R=/^(?:r[a-d]:direct|${REASON})$/,x=function(){return Array.from(crypto.getRandomValues(new Uint8Array(16)),function(b){return(b<16?"0":"")+b.toString(16)}).join("")},m=JSON.parse(L.getItem(K)||"null"),o=!!m&&H.test(m.p)&&n-(m.f||m.t)<${REMEMBER_MS};if(o){m.f=m.f||m.t;if(!m.k&&/^[a-d]$/.test(m.s))m.k="r"+m.s+":direct"}else m={p:x(),f:n};L.setItem(K,JSON.stringify(m));var v=JSON.parse(s.getItem("__rw_visit")||"null"),N=!v||!H.test(v.v)||n-v.t>18e5,c=R.test(m.k)?m.k.split(":"):null,r=0;if(N)v={v:x()};v.t=n;s.setItem("__rw_visit",JSON.stringify(v));if(c&&!s.getItem("__rw_carry")&&!s.getItem("__rw_q")){s.setItem("__rw_carry",JSON.stringify({i:c[0],s:c[1],t:n}));if(c[1]=="direct")s.setItem("__rw_q",c[0][1]);r=1}if(N&&w)fetch(w.e+"/event?cid="+encodeURIComponent(w.c),{method:"POST",headers:{"content-type":"text/plain;charset=UTF-8"},body:JSON.stringify({event_type:"choice",page_path:location.pathname||"/",ch:o?"returned":"first",pid:m.p,visit:v.v,qa:r&&c[1]=="direct"?c[0][1]:void 0,rc:r&&c[1]!="direct"?m.k:void 0}),credentials:"omit",keepalive:!0}).catch(function(){});var f=function(){try{var a=JSON.parse(s.getItem("__rw_carry")||"null"),q=JSON.parse(L.getItem(K)||"null"),k=a&&a.i+":"+a.s;if(q&&q.p==m.p&&k&&k!=q.k&&G.test(k)){q.k=k;L.setItem(K,JSON.stringify(q))}}catch(e){}};addEventListener("pagehide",f);document.addEventListener("visibilitychange",f)}}catch(e){}`;
}

/** The hero's main button in a page's manifest: the first hero part that is a button. */
export function choiceAnchor(
  manifest: Record<string, { css?: unknown }> | null | undefined,
): string[] | null {
  if (!manifest) return null;
  for (const [path, entry] of Object.entries(manifest)) {
    if (!/^hero\.(?:[a-z_]*\.)?(?:cta|button)[a-z_]*(?:\.label)?$/.test(path)) continue;
    const css = Array.isArray(entry?.css)
      ? entry.css.filter(
          (x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200,
        )
      : [];
    if (css.length > 0) return css.slice(0, 3);
  }
  return null;
}
