/**
 * The visitor's own choice (ADR 0038 part 2; docs/specs/direct-visitors.md
 * §2; mock design/mock/direct-visitors/overlay.html): one optional question
 * in a bar at the bottom of the screen, for a visit with no signal on the
 * home page. Loaded with rich.js, after the edge's answer, so the core
 * carries only the call.
 *
 * - No look of its own: everything is read from the page. The question takes
 *   the hero paragraph's font and colour; each answer takes the main
 *   button's font and corners, drawn as an outline in that colour; the bar's
 *   ground is the solid colour behind the hero, its edge a hairline of the
 *   text colour. Its left edge and width follow the hero's text column (a
 *   centred hero, a centred bar). White words over a hero photo on a white
 *   page: the page's own text colour. No confirmed main button: the first filled
 *   link or button under the headline lends its look; none at all: the
 *   paragraph's font and square corners. Text under 4.5:1 on that ground:
 *   not shown.
 * - Nothing moves: the bar is fixed over the page, so the page's own layout
 *   never changes. Above every other overlay, covering none: it sits over
 *   what is already docked at the bottom (a chat bubble, a sticky button
 *   bar, a badge), waits while a cookie or consent banner is open, and is
 *   not shown when the bottom of the screen is already crowded (its top
 *   would rise over 45% of the height). Never full screen.
 * - One line where it fits the hero's column, else the question above the
 *   answers, which wrap onto as many rows as they need (always on a phone):
 *   every answer whole, nothing scrolls sideways.
 * - Kept small: an answer is one word in the tab's carry (`qa:direct`), and,
 *   while the customer remembers returning visitors (`m`), the visitor's
 *   latest reason in this browser's `localStorage` beside its code, so a
 *   later visit starts with it (the visitor memory, ADR 0039); the
 *   tab remembers that it was asked (`__rw_q`), so it is asked once; closing
 *   ends it for the tab too. The load sends one `choice` row with one fixed
 *   word (`shown`, `closed`, or why not: `fit`, `anchor`), never a size, a
 *   time or a position. A visitor who leaves while a consent banner is open
 *   sends nothing.
 * - Keyboard and screen readers: a region named by the question, answers
 *   and close are buttons, a polite live line names the answer taken. The
 *   page's keys are never listened to (the closed list of events), and the
 *   reduced-motion query is read only by the boot: the bar fades, it never
 *   slides.
 */

import { writeCarry } from "./carry.ts";
import { fireEvent } from "./events.ts";
import { dropReserve } from "./reserve.ts";

/** The question as the edge sends it (`q`). */
export interface ChoiceQ {
  t: string;
  a: Array<[string, string]>;
  s: string[];
  /** The operator's preview: nothing kept, nothing sent, nothing rewritten. */
  p?: 1;
  /** 1: the customer keeps returning visitors' answers (ADR 0039); else this tab only. */
  m?: 1;
}

const ASKED = "__rw_q";
const BAR_ID = "__rawuser-ask";
/** At this width or less: a phone, two lines and the page's own side gutter. */
const PHONE_MAX = 599;
/** How long after the page shows the bar comes up. */
const DELAY_MS = 900;
/** After an answer, how long the bar shows which one before it leaves. */
const DONE_MS = 1000;
/** A consent banner is waited for this long at most, then nothing is shown or sent. */
const WAIT_MAX_MS = 120000;
/** Ids, classes and labels of cookie and consent banners (the common managers and plain names). */
const CONSENT = /cookie|consent|gdpr|onetrust|didomi|usercentrics|iubenda|\bcmp/i;
/** The close button's name in the page's language. */
const CLOSE: Record<string, string> = { az: "Bağla", ru: "Закрыть", tr: "Kapat", de: "Schließen" };

type Why = "shown" | "closed" | "fit" | "anchor" | "answered";
type Rgb = [number, number, number, number];

function valid(q: unknown): q is ChoiceQ {
  const o = q as ChoiceQ | null;
  return (
    !!o &&
    typeof o.t === "string" &&
    Array.isArray(o.a) &&
    o.a.length >= 2 &&
    o.a.length <= 4 &&
    o.a.every(
      (x) => Array.isArray(x) && /^[a-d]$/.test(String(x[0])) && typeof x[1] === "string",
    ) &&
    Array.isArray(o.s)
  );
}

function storage(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/** The tab's visit marker, as the core keeps it (visit.ts), for the choice row. */
function visitMarker(): string | undefined {
  try {
    const v = (JSON.parse(storage()?.getItem("__rw_visit") ?? "null") as { v?: string } | null)?.v;
    return typeof v === "string" && /^[0-9a-f]{32}$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

const shown = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};
const px = (v: string): number => Number.parseFloat(v) || 0;

function rgb(s: string): Rgb | null {
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) return null;
  const p = (m[1] ?? "")
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p.length > 3 ? (p[3] ?? 1) : 1];
}
const css = (c: Rgb, a: number): string => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
function lum(c: Rgb): number {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function contrast(a: Rgb, b: Rgb): number {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The first visible element for the main button's selectors. */
function anchorOf(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    try {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        if (shown(el)) return el;
      }
    } catch {
      // Not a selector this browser reads.
    }
  }
  return null;
}

/** What the bar looks like and where it goes, read from the page. */
interface Look {
  ink: Rgb;
  bg: Rgb;
  font: string;
  size: number;
  weight: string;
  bFont: string;
  bWeight: string;
  bLetter: string;
  bCase: string;
  radius: number;
  bHeight: number;
  left: number;
  right: number;
  center: boolean;
}

/** The page's look, or the word for why the bar cannot take one. */
function read(q: ChoiceQ): Look | "fit" | "anchor" {
  const h1 = Array.from(document.querySelectorAll("h1")).find(shown);
  if (!h1) return "anchor";
  // No confirmed main button: the first filled link or button under the
  // headline, within five boxes of it, lends its look.
  let btn = anchorOf(q.s);
  for (let up = h1.parentElement, n = 0; !btn && up && n < 5; up = up.parentElement, n++)
    btn =
      Array.from(up.querySelectorAll<HTMLElement>("a,button")).find((e) => {
        const c = rgb(getComputedStyle(e).backgroundColor);
        return (
          shown(e) &&
          !!c &&
          c[3] > 0.9 &&
          e.getBoundingClientRect().top > h1.getBoundingClientRect().top
        );
      }) ?? null;
  const hb = h1.getBoundingClientRect().bottom;
  // The hero's paragraph: the first real sentence after the headline.
  const para =
    Array.from(document.querySelectorAll("p")).find(
      (p) =>
        shown(p) &&
        h1.compareDocumentPosition(p) & 4 &&
        (p.textContent ?? "").trim().length > 40 &&
        p.getBoundingClientRect().top < hb + 400,
    ) ?? h1;
  // The text column: the box that holds the headline and the button (else its paragraph).
  const holds = btn ?? para;
  let col: HTMLElement | null = h1.parentElement;
  while (col && !col.contains(holds)) col = col.parentElement;
  if (!col) return "anchor";
  let bg: Rgb | null = null;
  for (let at: Element | null = col; at && !bg; at = at.parentElement) {
    const c = rgb(getComputedStyle(at).backgroundColor);
    if (c && c[3] > 0.95) bg = c;
  }
  bg ??= [255, 255, 255, 1];
  const ps = getComputedStyle(para);
  // The paragraph's colour, else the headline's, else the page's own text
  // colour (a hero of white words over a photo, on a white page).
  const ink = [ps.color, getComputedStyle(h1).color, getComputedStyle(document.body).color]
    .map(rgb)
    .find((c): c is Rgb => !!c && contrast(c, bg) >= 4.5);
  if (!ink) return "fit";
  const bs = btn ? getComputedStyle(btn) : ps;
  const r = col.getBoundingClientRect();
  const cs = getComputedStyle(col);
  return {
    ink,
    bg,
    font: ps.fontFamily,
    size: px(ps.fontSize),
    weight: ps.fontWeight,
    bFont: bs.fontFamily,
    bWeight: bs.fontWeight,
    bLetter: (btn && bs.letterSpacing) || "normal",
    bCase: (btn && bs.textTransform) || "none",
    radius: btn ? px(bs.borderTopLeftRadius) : 0,
    bHeight: btn ? btn.getBoundingClientRect().height : 44,
    left: r.left + px(cs.paddingLeft),
    right: r.right - px(cs.paddingRight),
    center: getComputedStyle(h1).textAlign === "center",
  };
}

/**
 * What is already docked at the bottom of the screen across [l, r]: the top
 * of the highest fixed or sticky box there, and whether one is a consent
 * banner. Read at a few points of the bottom band, never every element.
 */
function docked(l: number, r: number, own: Element): { top: number; consent: boolean } {
  const vh = window.innerHeight;
  let top = vh;
  let consent = false;
  const seen = new Set<Element>();
  for (let i = 0; i < 5; i++) {
    for (const dy of [4, 40, 90, 150]) {
      const x = l + 4 + ((r - l - 8) * i) / 4;
      for (const hit of document.elementsFromPoint?.(x, vh - dy) ?? []) {
        for (
          let el: Element | null = hit;
          el && el !== document.body && el !== document.documentElement;
          el = el.parentElement
        ) {
          if (seen.has(el) || own.contains(el)) break;
          seen.add(el);
          const pos = getComputedStyle(el).position;
          if (pos !== "fixed" && pos !== "sticky") continue;
          const b = el.getBoundingClientRect();
          if (b.top < vh * 0.35) continue;
          const names = `${el.id} ${el.getAttribute("class") ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
          if (CONSENT.test(names)) consent = true;
          else top = Math.min(top, b.top);
        }
      }
    }
  }
  return { top, consent };
}

/**
 * Draws the bar for `q` when the page allows it, or reports why not.
 * `again` reruns the page's pass after an answer (the core's navigation
 * pass, at once), which asks the edge with the answer in the tab's carry.
 */
export function choice(q: unknown, page: { c: string; e: string }, again: () => void): void {
  // A customer's script from before the bar (a day at most) may still have
  // reserved the old row's space: it goes now.
  dropReserve();
  const tab = storage();
  const preview = valid(q) && q.p === 1;
  if (!valid(q) || (!preview && (!tab || tab.getItem(ASKED)))) return;
  if (document.getElementById(BAR_ID)) return;
  /** The tab counts as asked, and the row is sent; never in the preview, which keeps and sends nothing. */
  const done = (why: Why, slot = "1", pid = "") => {
    if (preview) return;
    try {
      tab?.setItem(ASKED, slot);
    } catch {
      // Storage blocked: the bar is not shown again on this page anyway.
    }
    if (slot !== "1" && why !== "answered") return;
    fireEvent(page.e, page.c, {
      event_type: "choice",
      page_path: location.pathname || "/",
      cohort: "no_signal",
      ch: why,
      visit: visitMarker(),
      ...(why === "answered" ? { qa: slot, ...(pid ? { pid } : {}) } : {}),
    });
  };
  try {
    const look = read(q);
    if (typeof look === "string") done(look);
    else draw(q, look, preview, done, again);
  } catch {
    // Anything this page throws at us: no bar, nothing sent.
    document.getElementById(BAR_ID)?.remove();
  }
}

function draw(
  q: ChoiceQ,
  t: Look,
  preview: boolean,
  done: (why: Why, slot?: string, pid?: string) => void,
  again: () => void,
): void {
  const phone = window.innerWidth <= PHONE_MAX;
  const fs = Math.max(14, Math.min(17, Math.round(t.size * 0.9)));
  const ansH = Math.max(phone ? 36 : 32, Math.min(44, Math.round(t.bHeight * 0.72)));
  const pad = Math.round(ansH * 0.28);
  const ink = (a: number) => css(t.ink, a);
  // Every node starts from nothing, so no rule of the page reaches it.
  const base = "all:initial;box-sizing:border-box;visibility:inherit;font:inherit;color:inherit;";
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, style: string, text = "") => {
    const n = document.createElement(tag);
    n.style.cssText = base + style;
    n.textContent = text;
    return n;
  };
  const look = `position:fixed;z-index:2147483647;display:flex;align-items:center;line-height:1.25;visibility:hidden;opacity:0;transition:opacity .22s;padding:${pad}px ${pad}px ${pad}px ${Math.round(pad * 1.6)}px;font-family:${t.font};font-size:${fs}px;font-weight:${t.weight};border:1px solid ${ink(0.14)};box-shadow:0 1px 2px ${ink(0.06)},0 12px 32px -18px ${ink(0.45)};`;
  const el = make("div", look);
  el.id = BAR_ID;
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", q.t);
  const s = el.style;
  s.color = ink(1);
  s.background = css(t.bg, 1);
  const button = (text: string, style: string) => {
    const b = make(
      "button",
      `display:inline-flex;align-items:center;justify-content:center;flex:none;cursor:pointer;white-space:nowrap;${style}`,
      text,
    );
    b.type = "button";
    return b;
  };
  const label = make("span", "", q.t);
  const strip = make("div", "");
  const x = button(
    "×",
    `width:32px;height:32px;font-size:22px;line-height:1;color:${ink(0.6)};border-radius:${Math.min(t.radius, 16)}px`,
  );
  x.setAttribute("aria-label", CLOSE[(document.documentElement.lang || "").slice(0, 2)] ?? "Close");
  const live = make(
    "span",
    "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)",
  );
  live.setAttribute("aria-live", "polite");

  let ended = false;
  const end = (why?: Why) => {
    if (ended) return;
    ended = true;
    window.removeEventListener("resize", place);
    s.opacity = "0";
    setTimeout(() => el.remove(), 300);
    if (why) done(why);
  };
  x.onclick = () => end("closed");
  for (const [slot, words] of q.a) {
    const b = button(
      words,
      `height:${ansH}px;max-width:100%;overflow:hidden;text-overflow:ellipsis;padding:0 ${Math.round(ansH * 0.42)}px;font-family:${t.bFont};font-weight:${t.bWeight};letter-spacing:${t.bLetter};text-transform:${t.bCase}`,
    );
    // Set as properties: the page's corners and outline must survive any parser.
    b.style.border = `1px solid ${ink(0.32)}`;
    b.style.borderRadius = `${Math.min(t.radius, ansH / 2)}px`;
    b.onclick = () => {
      label.textContent = `✓ ${words}`;
      strip.remove();
      live.textContent = words;
      if (preview) return;
      writeCarry(`q${slot}`, "direct");
      // Remembered by this browser for a later visit while the customer
      // keeps returning visitors (`m`, ADR 0039): the slot, when, and the
      // visitor's own code (drawn once, random, kept with it); the
      // customer's script reads it back. The answer and the code go to our
      // database on one `answered` row.
      let pid = "";
      if (q.m === 1) {
        try {
          const old = JSON.parse(localStorage.getItem("__rw_pick") ?? "null") as {
            p?: string;
            f?: number;
          } | null;
          const kept = !!old?.p && /^[0-9a-f]{32}$/.test(old.p);
          pid = kept
            ? (old?.p as string)
            : Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) =>
                x.toString(16).padStart(2, "0"),
              ).join("");
          const t = Date.now();
          // The memory's own fields (`f`, the first page) stay; the answer is
          // the visitor's latest reason (`k`), `s` and `t` for older scripts.
          localStorage.setItem(
            "__rw_pick",
            JSON.stringify({
              ...(kept ? old : {}),
              p: pid,
              f: (kept && old?.f) || t,
              s: slot,
              t,
              k: `r${slot}:direct`,
            }),
          );
        } catch {
          // Storage blocked: only this visit has the answer.
        }
      }
      done("answered", slot, pid);
      again();
      setTimeout(() => end(), DONE_MS);
    };
    strip.appendChild(b);
  }
  el.append(label, x, strip, live);
  document.body.appendChild(el);

  /**
   * One line (the close last), or the question above the answers, which wrap
   * onto as many rows as they need: every answer always whole, never a row
   * that scrolls (the bar is over the page, so its height moves nothing).
   */
  const lay = (two: boolean) => {
    s.flexWrap = two ? "wrap" : "nowrap";
    label.style.cssText = `${base}flex:${two ? "1 1 0" : "none;white-space:nowrap"};margin-right:${Math.round(pad * 1.5)}px`;
    x.style.order = two ? "" : "1";
    x.style.marginLeft = two ? "auto" : `${Math.round(pad * 0.6)}px`;
    strip.style.cssText = `${base}display:flex;flex-wrap:${two ? "wrap" : "nowrap"};gap:${Math.round(pad * 0.9)}px;min-width:0;margin-top:${two ? Math.round(pad * 0.6) : 0}px;flex:${two ? "1 1 100%" : "none"}`;
  };

  /** Lays the bar out over whatever is docked; its top, or -1 while a consent banner is open. */
  function place(): number {
    let l = phone ? Math.max(t.left, 8) : t.left;
    const r = phone ? Math.min(t.right, window.innerWidth - 8) : t.right;
    // As wide as its words on a wide screen, never wider than the hero's column.
    lay(false);
    s.width = "max-content";
    let w = Math.min(r - l, Math.ceil(el.getBoundingClientRect().width));
    s.width = `${w}px`;
    const two =
      phone || el.scrollWidth > el.clientWidth + 1 || strip.scrollWidth > strip.clientWidth + 1;
    if (two) {
      w = r - l;
      s.width = `${w}px`;
      lay(true);
    }
    if (t.center) l = (t.left + t.right) / 2 - w / 2;
    s.left = `${Math.round(l)}px`;
    const h = el.getBoundingClientRect().height;
    s.borderRadius = `${Math.round(t.radius >= t.bHeight / 2 - 1 && !two ? h / 2 : Math.min(t.radius, two ? 20 : 16))}px`;
    const below = docked(l, l + w, el);
    if (below.consent) return -1;
    const gap = phone ? Math.max(8, Math.min(24, t.left)) : 24;
    s.bottom = `${Math.round(window.innerHeight - below.top + gap)}px`;
    return below.top - gap - h;
  }

  let waited = 0;
  const show = () => {
    if (ended) return;
    const top = place();
    if (top < 0 && waited < WAIT_MAX_MS) {
      // A consent banner is open: the bar waits for it to close.
      waited += 500;
      setTimeout(show, 500);
      return;
    }
    if (top < window.innerHeight * 0.45) {
      ended = true;
      el.remove();
      // A banner still open after the wait: nothing shown, nothing sent.
      if (top >= 0) done("fit");
      return;
    }
    s.visibility = "";
    (window.requestAnimationFrame ?? setTimeout)(() => {
      s.opacity = "1";
    });
    window.addEventListener("resize", place);
    done("shown");
  };
  setTimeout(show, preview ? 0 : DELAY_MS);
}
