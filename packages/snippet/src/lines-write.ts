/**
 * Writing into the lines a page made (docs/specs/interactive-text.md §3.2,
 * phase 3). The page cut its headline into line elements, often inside
 * masks its script slides up (GSAP SplitText, Noho on Webflow, Grigoletti
 * on Framer): the lines are what it animates, so they stay, and the
 * version's words are poured into them by measured width, the way the page
 * itself filled them. A line more is cloned from the last one and follows
 * it; a line less is removed. Nothing here reads the visitor.
 * Part of the rich module (`/rich.js`, rich.ts) since 2026-09-30: the core
 * reaches it through rich-api.ts and loads it only where a page needs it.
 */

import { balance } from "./lines.ts";
import { followModel, setUnitText, writeRun } from "./template-write.ts";
import { type Unit, isMeasuringCopy, lineSet, treeOf } from "./template.ts";

function wordy(n: Node): boolean {
  return /\S/.test(n.textContent ?? "");
}

/** The element inside a line that holds its words: down through wrappers with one wordy child. */
function holderOf(line: Element): Element {
  let h = line;
  for (;;) {
    const kids = Array.from(h.children).filter(wordy);
    const ownText = Array.from(h.childNodes).some((n) => n.nodeType === 3 && wordy(n));
    const only = kids[0];
    if (kids.length !== 1 || ownText || !only) return h;
    h = only;
  }
}

/** A line's words: into its word elements when it has them, else into its text. */
function fill(holder: Element, words: readonly string[]): void {
  const els = Array.from(holder.children).filter(wordy);
  const ownText = Array.from(holder.childNodes).some((n) => n.nodeType === 3 && wordy(n));
  if (els.length > 0 && !ownText) {
    const units: Unit[] = els.map((e) => ({
      text: (e.textContent ?? "").trim(),
      kind: "el",
      ref: e,
    }));
    writeRun(units, words);
  } else setUnitText(holder, words.join(" "));
}

/**
 * Does the line still hold one line of text inside its box? Its words fit
 * the width the mask gives it (a nowrap line would be clipped) and they sit
 * on one line box (a wrapping one would hide the second under its mask).
 * Read from the text's own boxes at the width it has now: a height taken at
 * 1280 px said "one line" for two at 390 (the zoo's lines-fixed after a
 * resize, 2026-09-29).
 */
export function fitsLine(line: Element, holder: Element): boolean {
  const width = (line as HTMLElement).clientWidth;
  if (width > 0 && (holder as HTMLElement).scrollWidth > width + 1) return false;
  try {
    const r = document.createRange();
    r.selectNodeContents(holder);
    const boxes = Array.from(r.getClientRects()).filter((b) => b.width > 0 && b.height > 0);
    const first = boxes[0];
    return !first || boxes.every((b) => b.top < first.top + first.height * 0.5);
  } catch {
    return true;
  }
}

export type Fits = (line: Element, holder: Element) => boolean;

/** The version each element was last given, for a second pour when the width or the font changes. */
const poured = new WeakMap<Element, string>();
/** How long a page that fits its font to our lines gets before we pour by width instead. */
const REFIT_WAIT_MS = 400;
/**
 * Settles once a page that fits its font to our lines has had its frames to
 * do it: the reveal waits for it, so the fit is not seen (the zoo's
 * lines-fit moved the content below 11 to 28 px one frame after the
 * reveal, 2026-09-29).
 */
let settling: Promise<void> | null = null;

export function linesSettled(): Promise<void> {
  return settling ?? Promise.resolve();
}

/** Headlines held one pixel narrower right now. */
const nudging = new WeakSet<Element>();
/** The last text written into each element's lines. */
const latest = new WeakMap<Element, string>();

/**
 * Pour again when the page's fonts arrive or the window changes size: the
 * first pour may have measured the fallback font (the zoo's lines-fit, a
 * write before the page's stylesheet: one line where three belonged).
 */
function keepPoured(el: Element, text: string): void {
  const had = poured.has(el);
  poured.set(el, text);
  if (had || typeof window === "undefined") return;
  const again = () => {
    const t = poured.get(el);
    if (t !== undefined) writeLines(el, t);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(again, 200);
  });
  (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready.then(again);
}

/**
 * The version's words into the page's lines. False when the element holds
 * no lines (the caller decides: a page that has not split yet takes the
 * words as plain text and splits them itself).
 */
export function writeLines(el: Element, text: string, fits: Fits = fitsLine): boolean {
  const found = lineSet(treeOf(el));
  if (!found) return false;
  latest.set(el, text);
  const lines = found.map((n) => n.ref as Element);
  const holders = lines.map(holderOf);
  // The page's own count, taken on the first write and kept: the fit check
  // writes several lengths in one task, and a longer one's cloned lines are
  // not the page's (the Webflow test page at 390 took five for three,
  // 2026-09-29).
  const pageCount = pageCounts.get(el) ?? lines.length;
  pageCounts.set(el, pageCount);
  toCount(lines, holders, pageCount);
  const words = text.split(/\s+/).filter(Boolean);
  const parent = lines[0]?.parentElement;
  const copy = parent
    ? Array.from(parent.children).find((c) =>
        isMeasuringCopy(c.getAttribute("style"), c.hasAttribute("hidden")),
      )
    : undefined;
  // A page that fits its font to a measuring copy keeps its line count; the
  // copy gets the same lines and the page sizes the font to ours.
  if (copy && copy.children.length === pageCount) {
    const cut = balance(words, pageCount);
    lines.forEach((line, k) => {
      const ws = cut[k];
      if (ws) fill(holders[k] as Element, ws);
      else if (k > 0) line.parentNode?.removeChild(line);
    });
    Array.from(copy.children).forEach((c, k) => {
      c.textContent = (cut[k] ?? []).join(" ");
    });
    // Its fit runs on a resize of the box: one pixel, one frame. A page that
    // does not fit at this width (grigoletti.ch keeps its phone font, 2026-09-29:
    // our last line clipped by 26 px at 390) gets the lines poured by width
    // instead, two frames later, once it has had its chance.
    // The headline itself, whose width the page's fit reads (grigoletti.ch
    // re-fits when the h1's width changes), kept one pixel narrower through
    // one full frame: restored in the same frame, the page's ResizeObserver
    // saw no change and fitted only after our fallback added a fourth line
    // (9 of 12 loads, 2026-09-29).
    // One nudge at a time: the fit check writes several lengths in one task,
    // and a second nudge would take the first one's width for the page's own.
    const box = el as HTMLElement;
    if (typeof requestAnimationFrame !== "undefined" && box.offsetWidth > 0) {
      if (!nudging.has(el)) {
        nudging.add(el);
        const hadStyle = box.hasAttribute("style");
        const w = box.style.width;
        box.style.width = `${box.offsetWidth - 1}px`;
        settling = new Promise((done) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              box.style.width = w;
              if (!hadStyle && box.getAttribute("style") === "") box.removeAttribute("style");
              nudging.delete(el);
              // The page fits in the frame after the width comes back.
              requestAnimationFrame(() => done());
            }),
          ),
        );
      }
      // Two frames were not enough: the page fitted after our check and a
      // fourth line came from us, not from it (grigoletti.ch, 11 of 12 loads).
      // Its fit lands within a few frames; ours waits past it.
      setTimeout(() => {
        // Only for the length the fit check kept, the last one written.
        if (latest.get(el) === text && overflows(lines, holders))
          pourByWidth(el, text, fits, lines, holders);
      }, REFIT_WAIT_MS);
    }
    return true;
  }
  // One line's height, taken before our first pour and kept for the next.
  // The page's own line count first, evenly filled, when every line fits:
  // a shorter version then keeps the page's lines instead of losing one
  // (the zoo's lines-fixed took two for three, the paragraph below moved).
  const cut = balance(words, pageCount);
  if (cut.length === pageCount) {
    cut.forEach((ws, k) => fill(holders[k] as Element, ws));
    if (lines.every((l, k) => fits(l, holders[k] as Element))) {
      keepPoured(el, text);
      return true;
    }
  }
  return pourByWidth(el, text, fits, lines, holders);
}

const pageCounts = new WeakMap<Element, number>();

/**
 * The line elements brought to the page's count: surplus lines a longer
 * length cloned are removed, missing ones cloned from the last (following
 * it, so they animate with the page's own).
 */
function toCount(lines: Element[], holders: Element[], n: number): void {
  while (lines.length > n) {
    const extra = lines.pop();
    holders.pop();
    extra?.parentNode?.removeChild(extra);
  }
  while (lines.length < n && lines.length > 0) {
    const model = lines[lines.length - 1] as Element;
    const line = model.cloneNode(true) as Element;
    model.parentNode?.insertBefore(line, model.nextSibling);
    followModel(line, model);
    lines.push(line);
    holders.push(holderOf(line));
  }
}

/** Any line whose words run past the width its mask gives it. */
function overflows(lines: readonly Element[], holders: readonly Element[]): boolean {
  return lines.some(
    (l, k) =>
      l.isConnected &&
      (l as HTMLElement).clientWidth > 0 &&
      ((holders[k] as HTMLElement | undefined)?.scrollWidth ?? 0) >
        (l as HTMLElement).clientWidth + 1,
  );
}

function pourByWidth(
  el: Element,
  text: string,
  fits: Fits,
  lines: Element[],
  holders: Element[],
): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  let i = 0;
  let li = 0;
  while (i < words.length) {
    let line = lines[li];
    let holder = holders[li];
    if (!line || !holder) {
      const model = lines[lines.length - 1] as Element;
      line = model.cloneNode(true) as Element;
      model.parentNode?.insertBefore(line, model.nextSibling);
      followModel(line, model);
      holder = holderOf(line);
      lines.push(line);
      holders.push(holder);
    }
    // Greedy, as a page fills its own lines: one more word while it fits.
    let n = 1;
    fill(holder, words.slice(i, i + 1));
    while (i + n < words.length) {
      fill(holder, words.slice(i, i + n + 1));
      if (!fits(line, holder)) {
        fill(holder, words.slice(i, i + n));
        break;
      }
      n++;
    }
    i += n;
    li++;
  }
  for (let k = lines.length - 1; k >= li && k > 0; k--)
    lines[k]?.parentNode?.removeChild(lines[k] as Node);
  keepPoured(el, text);
  return true;
}
