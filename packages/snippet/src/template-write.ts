/**
 * The template writer (docs/specs/template-writing.md §4.3), moved out of
 * template.ts on 2026-09-30 into the rich module (`/rich.js`, rich.ts): the
 * core was at 14,957 of 15,360 B gzip and template.ts alone minified to
 * 11,163 B, most of it this writer, which only pages built word by word
 * need. The core reaches it through rich-api.ts.
 */

import {
  STATE_CLASSES,
  type Segment,
  type TemplateToken,
  type Unit,
  WORDS,
  isLetterWord,
  restartAnimations,
  segmentsOf,
  setMinHeight,
  templateSkeleton,
  treeOf,
} from "./template.ts";

/** The version keeps the page's structure: same tokens in the same order, same rotator size. */
function sameStructure(page: readonly Segment[], version: readonly TemplateToken[]): boolean {
  if (page.length !== version.length) return false;
  return page.every((s, i) => {
    const v = version[i];
    if (!v || v.t !== s.t) return false;
    if ((s.t === "glyph" || s.t === "open" || s.t === "close") && "n" in v) return s.n === v.n;
    if (s.t === "rot" && v.t === "rot") return s.alts.length === v.alts.length;
    if (s.t === "text" && v.t === "text") {
      // Where the page has only punctuation, the version keeps it (the lint's shape rule).
      const own = s.units.map((u) => u.text).join("");
      return WORDS.test(own) === WORDS.test(v.text) && (WORDS.test(own) || own === v.text);
    }
    return true;
  });
}

/**
 * The page sized its rotating slot to the word showing at load (an inline
 * width in px, set by its own script); a version's word may be wider and
 * would show clipped until the page's next tick (template-lab, 2026-09-27:
 * "sign" for "signal" for 2.9 s). Fit the slot to the new word at once.
 */
function fitRotator(box: unknown, alts: readonly unknown[]): void {
  const slot = box as HTMLElement;
  if (!/px$/.test(slot.style?.width ?? "")) return;
  const on = alts.find((a) =>
    Array.from((a as Element).classList ?? []).some((c) => STATE_CLASSES.has(c)),
  ) as HTMLElement | undefined;
  const width = on?.offsetWidth ?? 0;
  if (width <= 0) return;
  const transition = slot.style.transition;
  slot.style.transition = "none";
  slot.style.width = `${width}px`;
  void slot.offsetWidth;
  slot.style.transition = transition;
}

/** The first text node with words under a node, or null. */
function wordyTextNode(node: Node): Text | null {
  if (node.nodeType === 3) return /\S/.test(node.nodeValue ?? "") ? (node as Text) : null;
  for (const c of Array.from(node.childNodes)) {
    const t = wordyTextNode(c);
    if (t) return t;
  }
  return null;
}

/** A live word in letters (the reader's isLetterWord on the element). */
function letterWordEl(node: Node): node is Element {
  if (node.nodeType !== 1) return false;
  const e = node as Element;
  return isLetterWord({
    kind: "el",
    tag: e.tagName.toLowerCase(),
    classes: [],
    children: treeOf(e),
  });
}

/** One letter, and the attribute a page may draw it from (Splitting.js's data-char). */
function setLetter(l: Element, ch: string): void {
  l.textContent = ch;
  if (l.hasAttribute("data-char")) l.setAttribute("data-char", ch);
}

/**
 * A word into the page's letters: its letter elements reused in order, a
 * surplus letter cloned from the last one (following it, so it animates
 * with the page's own), the rest removed.
 */
function writeLetters(w: Element, word: string): void {
  const chars = Array.from(word);
  const letters = Array.from(w.children);
  const model = letters[letters.length - 1];
  letters.forEach((l, i) => {
    if (i < chars.length) setLetter(l, chars[i] ?? "");
    else l.parentNode?.removeChild(l);
  });
  let after = model;
  for (let i = letters.length; model && after && i < chars.length; i++) {
    const c = model.cloneNode(true) as Element;
    after.parentNode?.insertBefore(c, after.nextSibling);
    setLetter(c, chars[i] ?? "");
    followModel(c, model);
    after = c;
  }
  if (w.hasAttribute("data-word")) w.setAttribute("data-word", word);
}

/** Words into one unit, keeping the whitespace its text node had around them. */
export function setUnitText(ref: unknown, words: string): void {
  const node = ref as Node;
  if (letterWordEl(node)) {
    writeLetters(node, words);
    return;
  }
  const t = wordyTextNode(node);
  if (!t) {
    node.textContent = words;
    return;
  }
  const m = /^(\s*)[\s\S]*?(\s*)$/.exec(t.nodeValue ?? "");
  t.nodeValue = `${m?.[1] ?? ""}${words}${m?.[2] ?? ""}`;
}

/** Remove a unit and the whitespace that separated it from the one before. */
function removeUnit(ref: unknown): void {
  const node = ref as Node;
  const prev = node.previousSibling;
  if (prev && prev.nodeType === 3 && !/\S/.test(prev.nodeValue ?? ""))
    prev.parentNode?.removeChild(prev);
  node.parentNode?.removeChild(node);
}

/** How long a clone follows its model: past the longest entrance the probes saw (4.3 s). */
const FOLLOW_MS = 8000;
const followers: Array<[Element, Element, Set<Animation>]> = [];
let followUntil = 0;

/** The animations a page's own script made on the model, copied to its clone once each. */
function copyAnimations(clone: Element, model: Element, copied: Set<Animation>): void {
  const anims = (model as Element & { getAnimations?: () => Animation[] }).getAnimations?.() ?? [];
  for (const a of anims) {
    // CSS animations and transitions: the clone's own classes run those.
    if (copied.has(a) || "animationName" in a || "transitionProperty" in a) continue;
    copied.add(a);
    const eff = a.effect as KeyframeEffect | null;
    if (!eff?.getKeyframes || !(clone as HTMLElement).animate) continue;
    const copy = (clone as HTMLElement).animate(eff.getKeyframes(), eff.getTiming());
    copy.startTime = a.startTime;
    if (a.playState === "paused") copy.pause();
  }
}

function followTick(): void {
  for (const [clone, model, copied] of followers) copyAnimations(clone, model, copied);
  if (Date.now() < followUntil) setTimeout(followTick, 100);
  else followers.length = 0;
}

/**
 * A clone moves with the piece it was made from. A page's script animates
 * the pieces it made, not ours: a plain clone stayed invisible in its
 * from-state (Framer letters at opacity 0.001 and blur 10px, GSAP lines at
 * translateY 108%; the 2026-09-29 probes). So the clone copies the model's
 * scripted animations (Framer's opacity and blur, also those the page starts
 * later) and mirrors its inline style (framer-motion's and GSAP's transform
 * per frame), keeping its own custom properties (a renumbered --char-index).
 * A page that animates with CSS alone needs none of it and costs nothing.
 */
export function followModel(clone: Element, model: Element): void {
  if (typeof MutationObserver === "undefined") return;
  const own = (clone as HTMLElement).style;
  const sync = () => {
    const keep: string[][] = [];
    for (let i = 0; i < (own?.length ?? 0); i++) {
      const p = own[i] ?? "";
      if (p.startsWith("--")) keep.push([p, own.getPropertyValue(p)]);
    }
    const st = model.getAttribute("style");
    if (st === null) clone.removeAttribute("style");
    else clone.setAttribute("style", st);
    for (const [p, v] of keep) own.setProperty(p ?? "", v ?? "");
  };
  const mo = new MutationObserver(sync);
  mo.observe(model, { attributes: true, attributeFilter: ["style"] });
  setTimeout(() => mo.disconnect(), FOLLOW_MS);
  const idle = followers.length === 0;
  const copied = new Set<Animation>();
  copyAnimations(clone, model, copied);
  followers.push([clone, model, copied]);
  followUntil = Date.now() + FOLLOW_MS;
  if (idle) setTimeout(followTick, 100);
  // Its children too, pair by pair (a line's mask and its words).
  const kids = clone.children;
  const models = model.children;
  for (let i = 0; i < kids.length && i < models.length; i++) {
    const k = kids[i];
    const m = models[i];
    if (k && m) followModel(k, m);
  }
}

/**
 * A run of words into the segment's units. One element per word on the page:
 * one word per element, a surplus word in a clone of the run's last element,
 * a missing word by removing the run's last elements (never its first).
 * Otherwise the first unit takes the run and the others go.
 */
export function writeRun(units: readonly Unit[], words: readonly string[]): void {
  const perWord = units.every((u) => u.kind === "el" && !u.text.includes(" "));
  if (!perWord) {
    setUnitText(units[0]?.ref, words.join(" "));
    for (let i = units.length - 1; i >= 1; i--) removeUnit(units[i]?.ref);
    return;
  }
  const shared = Math.min(units.length, words.length);
  for (let i = 0; i < shared; i++) setUnitText(units[i]?.ref, words[i] ?? "");
  if (words.length > units.length) {
    const model = units[units.length - 1]?.ref as Element;
    let after: Node = model;
    for (let i = units.length; i < words.length; i++) {
      const doc = model.ownerDocument;
      // A word in letters is cloned whole, then given its own letters.
      const letters = letterWordEl(model);
      const clone = model.cloneNode(letters) as Element;
      if (!letters) clone.appendChild(doc.createTextNode(words[i] ?? ""));
      const space = doc.createTextNode(" ");
      after.parentNode?.insertBefore(space, after.nextSibling);
      space.parentNode?.insertBefore(clone, space.nextSibling);
      followModel(clone, model);
      if (letters) writeLetters(clone, words[i] ?? "");
      after = clone;
    }
  } else {
    for (let i = units.length - 1; i >= words.length; i--) removeUnit(units[i]?.ref);
  }
}

/** The numbers a page or a split library gives its pieces for a stagger. */
const INDEX_VARS = ["--i", "--char-index", "--word-index", "--line-index"];

function numbered(el: Element, v: string): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(`[style*='${v}']`)).filter(
    (e) => e.style.getPropertyValue(v) !== "",
  );
}

/** Each stagger number the page ran in sequence, with where it started. */
function numberings(el: Element): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const v of INDEX_VARS) {
    const nums = numbered(el, v).map((e) => Number.parseInt(e.style.getPropertyValue(v), 10));
    const start = nums[0];
    if (start !== undefined && nums.every((n, i) => n === start + i)) out.push([v, start]);
  }
  return out;
}

/** The stagger numbered again over the new pieces, and the totals Splitting.js keeps. */
function renumber(el: Element, nums: ReadonlyArray<[string, number]>): void {
  for (const [v, start] of nums) {
    const els = numbered(el, v);
    els.forEach((e, i) => e.style.setProperty(v, String(start + i)));
    const total = v.replace("-index", "-total");
    if (total !== v) {
      for (const t of [el, ...numbered(el, total)] as HTMLElement[])
        if (t.style?.getPropertyValue(total)) t.style.setProperty(total, String(els.length));
    }
  }
}

/**
 * The element's height with each rotating word showing in turn, the page
 * left as it was. A length that fits with one word can wrap with another,
 * and the page's own script cycles them after the reveal (template-lab,
 * 2026-09-28: five cells flipped a line as the words rotated, CLS up to
 * 0.119). Without a rotating slot, one height.
 */
export function rotationHeights(el: Element, measure: (el: Element) => number): number[] {
  const rot = segmentsOf(treeOf(el))?.segments.find((s) => s.t === "rot");
  if (rot?.t !== "rot") return [measure(el)];
  const on = rot.altRefs.find((a) =>
    Array.from((a as Element).classList ?? []).some((c) => STATE_CLASSES.has(c)),
  ) as HTMLElement | undefined;
  if (!on) return [measure(el)];
  const words = rot.altRefs.map((a) => (a as Node).textContent ?? "");
  const showing = on.textContent ?? "";
  const slot = rot.ref as HTMLElement;
  const width = slot.style?.width ?? "";
  const heights = words.map((w) => {
    setUnitText(on, w.trim());
    fitRotator(slot, rot.altRefs);
    return measure(el);
  });
  setUnitText(on, showing.trim());
  if (slot.style) {
    // Back to the page's width at once: with its transition on, the slot
    // slid from the last measured word for up to 358 ms after the reveal.
    const transition = slot.style.transition;
    slot.style.transition = "none";
    slot.style.width = width;
    void slot.offsetWidth;
    slot.style.transition = transition;
  }
  return heights;
}

/**
 * When the rotating words change the headline's line count at this width,
 * hold its box at the tallest of them (min-height), so a rotation never
 * moves the page: a character count holds a desktop line but not a phone
 * line (template-lab, 2026-09-28: two cells still flipped at 390 px, CLS up
 * to 0.258). Recomputed from scratch on every call.
 */
export function reserveRotationHeight(el: Element, measure: (el: Element) => number): void {
  const style = (el as HTMLElement).style;
  if (!style) return;
  style.minHeight = "";
  const hs = rotationHeights(el, measure);
  const max = Math.max(...hs);
  if (max - Math.min(...hs) < 1) return;
  setMinHeight(el, max);
}

const watched = new WeakSet<Element>();

/** The reservation again after a resize, when the width that decides the wrap changed. */
export function keepRotationReserved(el: Element, measure: (el: Element) => number): void {
  if (watched.has(el) || typeof window === "undefined") return;
  watched.add(el);
  let timer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => reserveRotationHeight(el, measure), 200);
  });
}

/**
 * Write a version's template into a headline built word by word. Returns
 * false, and leaves the page whole, when the version does not keep the page's
 * glyphs, lines, groups and rotator size, or the element is not one.
 */
export function writeTemplate(el: Element, template: string): boolean {
  const cut = segmentsOf(treeOf(el));
  if (!cut) return false;
  const page = cut.segments.filter((s) => s.t !== "space");
  const version = templateSkeleton(template);
  if (!sameStructure(page, version)) return false;
  const nums = numberings(el);
  page.forEach((s, i) => {
    const v = version[i];
    if (s.t === "text" && v?.t === "text") writeRun(s.units, v.text.split(" ").filter(Boolean));
    else if (s.t === "rot" && v?.t === "rot") {
      // The page's own script holds these nodes: only their words change.
      s.altRefs.forEach((ref, k) => setUnitText(ref, v.alts[k] ?? ""));
      fitRotator(s.ref, s.altRefs);
    }
  });
  renumber(el, nums);
  restartAnimations(el);
  return true;
}
