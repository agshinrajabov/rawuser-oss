import { DEFAULT_SELECTORS } from "./defaults.ts";
import { noteError, noteIssue, onIssueFlush, setWriting } from "./issues.ts";
import { lineCount, padTo } from "./lines.ts";
import {
  keepRotationReserved,
  reserveRotationHeight,
  rotationHeights,
  writeLines,
  writeTemplate,
} from "./rich-api.ts";
import { findTargets } from "./targets.ts";
import {
  restartAnimations,
  setMinHeight,
  templateText,
  treeOf,
  wordyLeafCount,
} from "./template.ts";
import type { ManifestEntry, SkipKind, VariantBody } from "./types.ts";

/**
 * Flatten a nested sections object into a dot-path map.
 *
 * variant.sections = { hero: { headline: "X", cta: { label: "Y" } } }
 * → { "hero.headline": "X", "hero.cta.label": "Y" }
 *
 * Only leaf string values are emitted — nested objects recurse.
 */
function flattenSections(
  obj: Record<string, unknown>,
  prefix = "",
  out: Map<string, string> = new Map(),
): Map<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out.set(path, value);
    } else if (value !== null && typeof value === "object") {
      flattenSections(value as Record<string, unknown>, path, out);
    }
  }
  return out;
}

/**
 * Apply a resolved variant to the DOM.
 *
 * Safety, per path: before any DOM mutation, every path the page CLAIMS
 * (manifest entry or data-rawuser tag; a convention default when there is
 * no manifest) must resolve, or we abort and mutate nothing, because a
 * claimed-but-absent element means this is not the manifest's page (e.g.
 * /admin, /404, where a tier-2 generic selector like `h1:first-of-type`
 * would match the wrong element). Paths the page never claimed (a
 * "comparison" block written before the page was read, a cta.headline the
 * manifest does not map) are skipped, not fatal. Nothing applies → false.
 *
 * Href paths are excluded from the presence check — they're metadata
 * that rides along with the corresponding `.label` path, and the apply
 * logic already short-circuits when no link/button is found.
 *
 * XSS safety: only textContent is ever written — never innerHTML.
 * href handling: set only when element is a link/button AND has no
 * existing href (customer's link choice wins over the variant default).
 *
 * @param variant  The VariantBody returned from the edge /select call.
 * @param targets  Optional per-path manifest from the edge (V1.5+).
 * @returns `true` if any DOM mutation actually happened. `false` if the
 *   pre-flight aborted (one or more renderable paths did not resolve to
 *   any element on the current page). The caller uses this to decide
 *   whether to fire `variant_shown` (true → personalization reached
 *   the visitor) or `personalization_skipped` (false → variant body had
 *   paths the manifest can't cover for this customer/page).
 */
/**
 * Does the page claim to have this path? With a confirmed manifest the
 * manifest is the authority: a path is expected only when the manifest maps
 * it or the customer tagged it. Without a manifest, a tag or a convention
 * default counts. Paths the page never claimed are skipped, not fatal.
 */
function expectedOnPage(path: string, targets?: Record<string, ManifestEntry>): boolean {
  const tagged = document.querySelectorAll(`[data-rawuser="${path}"]`).length > 0;
  // The operator's "leave it": never claimed, never written.
  if (targets?.[path]?.skip) return false;
  if (targets) return tagged || path in targets;
  return tagged || path in DEFAULT_SELECTORS;
}

/**
 * The elements of every path the page claims (expectedOnPage), path by
 * path, or null as soon as `keep` refuses a path's elements.
 */
function claimed(
  variant: VariantBody,
  targets: Record<string, ManifestEntry> | undefined,
  keep: (els: Element[], path: string, paths: Map<string, string>) => unknown,
): Element[] | null {
  const out: Element[] = [];
  const paths = flattenSections(variant.sections as Record<string, unknown>);
  for (const [path] of paths) {
    if (notPart(path)) continue;
    if (!expectedOnPage(path, targets)) continue;
    const els = findTargets(path, targets?.[path]);
    if (!keep(els, path, paths)) return null;
    out.push(...els);
  }
  return out;
}

/**
 * Every element the variant claims on this page, or null while one is still
 * missing (the page is still parsing). The early write snapshots them first.
 */
export function allTargetElements(
  variant: VariantBody,
  targets?: Record<string, ManifestEntry>,
): Element[] | null {
  return claimed(variant, targets, (els) => els.length);
}

/** The marker a site owner puts beside React's `suppressHydrationWarning`. */
const EARLY = "data-rawuser-early";

/**
 * The nodes under `n` in order, and the words of every text node whose
 * element does not carry the marker: a copy we wrote into reads the same
 * when it kept the page's nodes and changed words only where declared.
 */
function nodesOf(n: Node): string {
  return Array.from(n.childNodes, (c) =>
    c.nodeType === 3 ? (n as Element).hasAttribute(EARLY) || `"${c.nodeValue}` : `<${nodesOf(c)}>`,
  ).join();
}

/**
 * May every part be written before React hydrates it (docs/specs/
 * faster-tag.md E3)? React takes a text difference without a throw only in
 * an element with `suppressHydrationWarning` (one level: that element's own
 * text nodes, or its text when its children are one string), and throws on
 * any node added, removed or replaced whatever the prop says. The prop never
 * reaches the DOM, so the site owner puts `data-rawuser-early` beside it.
 * So each part is written, every length in turn as the fit check may, into
 * a copy, and the copy must keep the page's nodes, its words changed only in
 * marked elements: an emphasis and its headline both marked, an arrow
 * span without words untouched and needing nothing. A part the rich writers
 * own (built word by word, cut into lines) never goes early. Every part, or
 * the page waits for hydration as before: a part React will read and throw
 * on cannot be written early beside one it will not.
 */
export function declared(variant: VariantBody, targets?: Record<string, ManifestEntry>): boolean {
  return !!claimed(variant, targets, (els, path, paths) => {
    const entry = targets?.[path];
    const inl = entry?.inline;
    return (
      els.length &&
      !(inl?.template || inl?.lines) &&
      els.every((el) => {
        const c = el.cloneNode(true) as Element;
        const page = nodesOf(el);
        return ["", "_alt", "_alt2", ""].every((x) => {
          const v = paths.get(path + x);
          return (!v || writeText(c, v, entry)) && nodesOf(c) === page;
        });
      })
    );
  })?.length;
}

/**
 * The rotation height reserve for every part built word by word, measured
 * now (after an early write that could not measure while the page parsed).
 */
export function reserveRotations(
  variant: VariantBody,
  targets?: Record<string, ManifestEntry>,
  measure: (el: Element) => number = measureHeight,
): void {
  for (const [path] of flattenSections(variant.sections as Record<string, unknown>)) {
    const entry = targets?.[path];
    if (!entry?.inline?.template || entry.plain) continue;
    for (const el of findTargets(path, entry)) {
      reserveRotationHeight(el, measure);
      keepRotationReserved(el, measure);
    }
  }
}

/**
 * Every element the variant's paths resolve to on this page, for the
 * hydration wait (hydration.ts), which holds the write until React is done
 * with all of them, not only the first (#418 on a pilot site's /approach,
 * 2026-10-06). Paths that resolve to nothing yet are left out.
 */
export function targetElements(
  variant: VariantBody,
  targets?: Record<string, ManifestEntry>,
): Element[] {
  return claimed(variant, targets, () => 1) as Element[];
}

import { SPLIT_TEXT_CHILDREN, elementHasWords } from "./shape.ts";

/** One `*phrase*` in the version marks the phrase the design emphasises (spec §2). */
const MARKER = /\*([^*\n]{1,80})\*/g;

/** The version's text without markers, and its single emphasised phrase if it has exactly one. */
export function splitMarkers(value: string): {
  plain: string;
  before?: string;
  phrase?: string;
  after?: string;
} {
  const [m, more] = Array.from(value.matchAll(MARKER));
  const unstar = (t: string) => t.replace(/\*/g, "");
  const plain = unstar(value);
  if (!m || more) return { plain };
  const i = m.index ?? 0;
  return {
    plain,
    before: unstar(value.slice(0, i)),
    phrase: m[1] ?? "",
    after: unstar(value.slice(i + m[0].length)),
  };
}

/**
 * The shape of an element for writing: "plain" (no element children),
 * "icons" (element children without words), "emphasis" (one to four
 * children with words), "split" (a per-word or per-letter animation).
 */
/** Set on an emphasis element this snippet emptied, so a later pass still treats it as one. */
const RW_EM = "data-rw-em";

/** Children that carry words, or carried them before we emptied them. */
function wordyChildren(el: Element): Element[] {
  return Array.from(el.children).filter((k) => elementHasWords(k) || k.hasAttribute(RW_EM));
}

/**
 * Never a target of its own: an href or a kind (metadata), or a second or
 * third length of a part (`_alt`, `_alt2`), used with its base.
 */
const notPart = (path: string): boolean => /\.(href|kind)$|_alt2?$/.test(path);

export function elementShape(el: Element): "plain" | "icons" | "emphasis" | "split" {
  if (el.children.length === 0) return "plain";
  const wordy = wordyChildren(el).length;
  // Word elements at any depth: a split nested in lines or groups is still
  // split text, never written as one plain string (the 2026-09-29 survey).
  if (wordy > SPLIT_TEXT_CHILDREN || wordyLeafCount(treeOf(el)) > SPLIT_TEXT_CHILDREN)
    return "split";
  return wordy === 0 ? "icons" : "emphasis";
}

/**
 * The first text node among `nodes` with words, else (with `any`) the first
 * text node at all: a write goes into a node the page already has (one we
 * emptied, React's `{" "}`) before it makes one, so the part keeps the
 * number and order of its nodes, which a page React has not hydrated yet
 * must (docs/specs/faster-tag.md E3), and a second length written over the
 * first finds the same nodes.
 */
function textNode(nodes: ArrayLike<Node>, any = 1): Text | undefined {
  const a = Array.from(nodes).filter((n) => n.nodeType === 3);
  return (a.find((n) => /\S/.test(n.nodeValue ?? "")) ?? (any ? a[0] : undefined)) as
    | Text
    | undefined;
}

/** Write words into one node, keeping the whitespace the markup had around them. */
function setWords(node: Text, words: string): void {
  const m = /^(\s*)[\s\S]*?(\s*)$/.exec(node.nodeValue ?? "");
  node.nodeValue = `${m?.[1] ?? ""}${words}${m?.[2] ?? ""}`;
}

/**
 * Write the words and keep the design (docs/specs/design-preserving-rewrite.md §1).
 * Never innerHTML: only nodeValue on text nodes, textContent on childless
 * elements, and visibility on an emphasis element left without words.
 * Returns false for a split-text element the operator did not clear.
 */
/** Arrow-like glyphs a page writes as bare characters at the edge of a label. */
const LEAD_GLYPH = /^([\u2190-\u21ff\u27a1-\u27bf\u00bb\u203a]+\s*)/;
const TRAIL_GLYPH = /(\s*[\u2190-\u21ff\u27a1-\u27bf\u00bb\u203a]+)$/;

/** The element's own words: its direct text nodes, not its children's. */
function ownText(el: Element): string {
  let out = "";
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) out += n.nodeValue ?? "";
  return out;
}

/**
 * Two things the page wrote into the text itself, not into markup or CSS,
 * that the version must keep: an arrow glyph at either edge of the label
 * ("START A SPRINT →", seen on a pilot site's /approach, where the nav button's
 * arrow was a span and survived but this one was a character and vanished),
 * and capitals the page typed itself (`.btn` there has `text-transform:
 * none`). Idempotent, so the hold and the two-lengths measure can call it.
 */
export function matchOriginal(original: string, value: string, lang?: string): string {
  const o = original.trim();
  let v = value.trim();
  const lead = LEAD_GLYPH.exec(o)?.[1];
  const trail = TRAIL_GLYPH.exec(o)?.[1];
  const core = o.slice(lead?.length ?? 0, o.length - (trail?.length ?? 0));
  const letters = core.replace(/[^\p{L}]/gu, "");
  if (
    letters.length >= 4 &&
    letters === letters.toLocaleUpperCase(lang) &&
    letters !== letters.toLocaleLowerCase(lang)
  ) {
    v = v.toLocaleUpperCase(lang);
  }
  if (lead && !LEAD_GLYPH.test(v)) v = lead + v;
  if (trail && !TRAIL_GLYPH.test(v)) v = v + trail;
  return v;
}

/**
 * The element's own label, or an SVG's that holds the text (the zoo's
 * svg-text page kept the old words on the <svg>).
 */
function labelled(el: Element): Element[] {
  return [el, el.closest?.("svg")].filter(
    (h, i, a): h is Element => !!h && a.indexOf(h) === i && h.hasAttribute("aria-label"),
  );
}

/** Letters and digits only, lowercased: an aria-label a split library copied from the text. */
function bareWords(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Write, and keep a label that repeated the old words in step with the new
 * ones: a split library copies the headline into `aria-label` (GSAP
 * SplitText, Framer), so a screen reader would read the page's original
 * words over the version (the 2026-09-29 survey).
 */
export function writeText(el: Element, value: string, entry?: ManifestEntry): boolean {
  const holders = labelled(el);
  const before = holders.length > 0 ? bareWords(el.textContent ?? "") : "";
  const ok = writeTextInto(el, value, entry);
  if (ok && before) {
    const shown =
      entry?.inline?.template && !entry.plain ? templateText(value) : splitMarkers(value).plain;
    for (const h of holders) {
      if (bareWords(h.getAttribute("aria-label") ?? "") === before) {
        h.setAttribute("aria-label", shown.replace(/\s+/g, " ").trim());
      }
    }
  }
  return ok;
}

function writeTextInto(el: Element, value: string, entry?: ManifestEntry): boolean {
  // A headline built word by word: its own writer fills the page's elements
  // (docs/specs/template-writing.md §4.3). A version that is not a template
  // of the same structure leaves the page whole, as split text always did.
  // A headline cut into lines takes its words into the page's lines
  // (docs/specs/interactive-text.md §3.2).
  const inl = entry?.inline;
  if (inl && !entry.plain && (inl.template || inl.lines)) {
    const text = inl.template ? templateText(value) : splitMarkers(value).plain;
    if (inl.template) {
      if (writeTemplate(el, value)) return true;
    } else if (writeLines(el, text)) {
      restartAnimations(el);
      return true;
    }
    // The page has not split it yet (its script runs later, the zoo and
    // Webflow's GSAP on load): the words go in as plain text and the page
    // splits ours. Phase 1's pre-split write, on the landing page.
    if (bare(el)) {
      el.textContent = text;
      return true;
    }
    skip = inl.template ? "template-mismatch" : "lines";
    return false;
  }
  const shape = elementShape(el);
  const lang = el.ownerDocument?.documentElement?.lang || undefined;
  const { plain, before, phrase, after } = splitMarkers(matchOriginal(ownText(el), value, lang));
  if (shape === "plain") {
    el.textContent = plain;
    return true;
  }
  if (shape === "split") {
    skip = "split";
    if (!entry?.plain) return false;
    el.textContent = plain; // the operator chose plain text over the letter animation
    return true;
  }
  const wordy = wordyChildren(el);
  const kids = Array.from(el.childNodes);
  const at = wordy[0] ? kids.indexOf(wordy[0]) : kids.length;

  if (shape === "emphasis" && phrase !== undefined && wordy[0]) {
    // Map the segments onto the shape: text before into the first text node,
    // the phrase into the emphasis element (its decorations kept), the rest
    // into the text node after it (made if the markup had none). Segments
    // carry their own spacing, so they are written as they are.
    const em = wordy[0];
    const beforeText = before ?? "";
    const afterText = after ?? "";
    let head = textNode(kids.slice(0, at));
    if (head) head.nodeValue = beforeText;
    else if (beforeText) {
      head = document.createTextNode(beforeText);
      el.insertBefore(head, em);
    }
    // A pass earlier in this tab may have hidden the element (no marked
    // phrase then); it carries words again now.
    if ((em as HTMLElement).style.visibility === "hidden")
      (em as HTMLElement).style.visibility = "";
    const emText = textNode(em.childNodes);
    if (emText) {
      emText.nodeValue = phrase;
      for (const n of Array.from(em.childNodes)) {
        if (n !== emText && n.nodeType === 3) n.nodeValue = "";
      }
    } else {
      em.insertBefore(document.createTextNode(phrase), em.firstChild);
    }
    let tail = textNode(kids.slice(at + 1));
    if (tail) tail.nodeValue = afterText;
    else if (afterText) {
      tail = document.createTextNode(afterText);
      el.insertBefore(tail, em.nextSibling);
    }
    // Any other text node and any second emphasis loses its words.
    for (const n of kids) {
      if (n.nodeType === 3 && n !== head && n !== tail) n.nodeValue = "";
    }
    for (const kid of wordy.slice(1)) {
      clearWords(kid);
      kid.setAttribute(RW_EM, "");
      if (!elementHasWords(kid)) (kid as HTMLElement).style.visibility = "hidden";
    }
    return true;
  }

  // Words first wherever they are; else a node before the first child with
  // words (the label stays ahead of its icon).
  const head = textNode(kids, 0) ?? textNode(kids.slice(0, at));
  if (head) {
    setWords(head, plain);
    for (const n of kids) {
      if (n.nodeType === 3 && n !== head) n.nodeValue = "";
    }
  } else {
    // Words lived only inside children (icons-only or emphasis-only).
    // Put the whole text after the leading decorations.
    const node = document.createTextNode(plain);
    if (wordy[0]) el.insertBefore(node, wordy[0]);
    else el.appendChild(node);
  }
  if (shape === "emphasis") {
    // The version carries no marked phrase: the emphasis elements lose their
    // words; one left holding only a decoration (an underline bar) is hidden,
    // never removed (React owns it).
    for (const kid of wordy) {
      clearWords(kid);
      kid.setAttribute(RW_EM, "");
      if (!elementHasWords(kid)) (kid as HTMLElement).style.visibility = "hidden";
    }
  }
  return true;
}

/** Empty every text node under the element; child elements stay. */
function clearWords(el: Element): void {
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) n.nodeValue = "";
    else if (n.nodeType === 1) clearWords(n as Element);
  }
}

/** What applyVariant wrote, so holdVariant can put it back if a framework reverts it. */
export interface AppliedText {
  path: string;
  value: string;
  /** The page's own text before the swap; only a revert to exactly this is redone. */
  original: string;
  /**
   * What the write left in the element (the version with the page's own
   * glyph and capitals restored, markers removed). When it equals the
   * original there is nothing to redo: a pilot site's /approach, 2026-09-16,
   * "Start a build" rendered as "START A BUILD →", the original, and the
   * hold's observer rewrote it on every mutation it caused, a million
   * querySelectorAll calls in 200 ms and a frozen tab.
   */
  rendered: string;
}

const applied: AppliedText[] = [];

let skip: SkipKind = "missing";

/**
 * What may still be done with the parts of the last write, each only while
 * the part is exactly as we left it (a page that has split or animated the
 * words since keeps them). For the tab's carried copy, written as the page
 * parses with nothing to measure (docs/specs/session-carry.md, "A carried
 * return"): `true` fits the lengths now that there is a box, as a first
 * page does; `false` puts the part back in place as the page built it,
 * before another copy is written.
 */
const sequels: Array<(fit: boolean) => void> = [];

/**
 * A fit leaves the list in place: it can run before the edge has answered
 * (a carried return fitted before the first paint, A10), and the edge may
 * still say another copy, which puts the parts back first.
 */
export function resume(fit: boolean): void {
  for (const f of fit ? sequels.slice() : sequels.splice(0)) {
    try {
      f(fit);
    } catch {
      noteError();
    }
  }
}

/** Why the last applyVariant left the page as built. */
export function lastSkip(): SkipKind {
  return skip;
}

/** The text swaps of the last applyVariant call (exported for holdVariant and tests). */
export function lastApplied(): readonly AppliedText[] {
  return applied;
}

/** The element's rendered height; layout is computed even while it is visibility:hidden. */
export function measureHeight(el: Element): number {
  return el.getBoundingClientRect().height;
}

/** Plain text, or plain text with our own <br>s: nothing of the page's inside. */
const bare = (el: Element): boolean => Array.from(el.children).every((c) => c.tagName === "BR");

/** Labels given back to the page's own words on purpose: the hold leaves them. */
const gaveBack = new WeakSet<Element>();

/** Parts whose box we hold at the original's height (so a later pass can let go). */
const reserved = new WeakSet<Element>();
/** A pixel and a half either way is the same line count. */
const SAME = 1.5;

/**
 * The page's line count, by construction (docs/decisions/0031). Of the
 * lengths, one at the original's height wins; otherwise any length under
 * the original beats any length over it (the tallest under, the shortest
 * over), and one under is then brought to the original's height: cut into
 * the page's own lines when the page will split it, else its box held at
 * the original's height. Under costs nothing; over always moves the page.
 * The Webflow test page, 2026-09-30: of 29 versions, 9 had every length
 * under the page at 1280 and 8 every length over at 390, and the page's own
 * count went 3, 2, 3, 4 between 1440 and 360 px.
 */
function fitLength(
  el: Element,
  cands: readonly string[],
  written: string,
  before: number,
  lines: number,
  entry: ManifestEntry | undefined,
  measure: (el: Element) => number,
  slot: string,
): string {
  let best = written;
  let bh = Number.NaN;
  // The caller wrote one already, to learn whether it could.
  let last = written;
  for (const c of cands) {
    if (c !== last) {
      last = c;
      writeText(el, c, entry);
    }
    const h = measure(el);
    if (Math.abs(h - before) < SAME) {
      best = c;
      bh = before;
      break;
    }
    if (Number.isNaN(bh) || (h < before ? bh > before || h > bh : bh > before && h < bh)) {
      best = c;
      bh = h;
    }
  }
  if (last !== best) writeText(el, best, entry);
  if (bh < before - SAME) {
    // Our lines are the page's: before its split, or in a plain headline.
    const cut =
      lines > 1 && bare(el) && padTo(el, splitMarkers(best).plain, lines, !!entry?.inline?.lines);
    if (!cut) setMinHeight(el, before);
    reserved.add(el);
  }
  // A visible change of lines only (snippet issues, lines_changed): the box
  // the visitor sees against the original's, from the heights and the count
  // measured above, nothing measured anew. A shorter length is held at the
  // original's height (cut into its lines or by min-height), so only a
  // longer box counts, by half a line or more. A later fit (fonts, width)
  // updates it; 0 takes it back. (`cands` is never empty: bh is a number.)
  if (lines > 0 && before > 0) {
    const d = Math.round((Math.max(0, bh - before) * lines) / before);
    noteIssue("lines_changed", slot, Math.min(9, d));
  }
  return best;
}

/** What each fitted part was given, for a fit again when the width or the font changes. */
const fitted = new WeakMap<Element, () => void>();

/**
 * At a new width the page's own count changes (3, 2, 3, 4 lines on the
 * Webflow test page), and a fit made before the page's fonts arrived
 * measured the fallback font (a pilot site, 4 of 6 loads with the fonts 1.5 s
 * late, 2026-09-30), so the fit runs again: the original written back and
 * measured, the lengths tried, all in one task. Parts the page has cut
 * into its own lines keep them (the lines writer re-pours those).
 */
function keepFitted(el: Element, slot: string, fit: () => void): void {
  const had = fitted.has(el);
  fitted.set(el, fit);
  if (had || typeof window === "undefined") return;
  // Only while the words are ours: a page that animates its own text
  // (scramble, typewriter) changes the box every frame, and fitting again
  // then fought it, the page typing and us writing back every 33 ms (the
  // lab's zoo, 2026-09-30).
  let mine = el.textContent;
  let off = false;
  const again = () => {
    if (off || el.textContent !== mine) {
      off = true;
      return;
    }
    try {
      fitted.get(el)?.();
    } catch {
      noteError(slot);
    }
    mine = el.textContent;
    arm();
  };
  // Once more when the page's fonts land (the fonts' promise, as a fallback).
  const arm = () => fontsLoading() && document.fonts.ready.then(again);
  // A box that changes size for any reason but ours (the page's fonts
  // arriving, a new width) is fitted again between layout and paint, so no
  // frame shows the fit made for the other size (a pilot site's /az at 390 with
  // the fonts 1.5 s late: the headline painted 65 px short for 33 to 100 ms,
  // 2026-09-30). The fonts' promise and the resize stay as the fallback.
  if (typeof ResizeObserver !== "undefined") {
    const size = () => {
      const r = el.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)}`;
    };
    let last = size();
    let runs = 0;
    const ro = new ResizeObserver(() => {
      if (off) return ro.disconnect();
      if (size() === last || runs++ > 20) return;
      // Our own change to the box inside the callback would stay pending and
      // the page would throw "ResizeObserver loop completed with undelivered
      // notifications" (a pilot site, 2026-09-30): not watched while we fit,
      // watched again from the next frame.
      ro.unobserve(el);
      again();
      last = size();
      requestAnimationFrame(() => ro.observe(el));
    });
    ro.observe(el);
  }
  arm();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let width = window.innerWidth;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (window.innerWidth === width) return;
      width = window.innerWidth;
      again();
    }, 200);
  });
}

/** The page's fonts still on their way (a fit now measures a fallback). */
function fontsLoading(): boolean {
  return (document as Document & { fonts?: FontFaceSet }).fonts?.status === "loading";
}

/** Let go of a height or a line cut we set, before measuring again. */
function unreserve(el: Element): void {
  if (!reserved.has(el)) return;
  const style = (el as HTMLElement).style;
  style.minHeight = "";
  style.whiteSpace = "";
  // Nothing of ours left on a part that goes back as the page built it.
  if (!el.getAttribute("style")) el.removeAttribute("style");
}

/**
 * The part as the page built it, put back exactly: every text node's words
 * and every child's visibility; text nodes a write added are emptied. A
 * label written back through textContent doubled its icon's arrow ("Başla
 * → →", a pilot site, 18 of 72 loads, 2026-09-30).
 */
function snapshot(el: Element): () => void {
  const texts: Array<[Node, string | null]> = [];
  const kids: Array<[HTMLElement, string]> = [];
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) texts.push([c, c.nodeValue]);
      else if (c.nodeType === 1) {
        kids.push([c as HTMLElement, (c as HTMLElement).style?.visibility ?? ""]);
        walk(c);
      }
    }
  };
  walk(el);
  const plain = el.textContent ?? "";
  // A label that repeated the words goes back with them, so the next write
  // finds it reading the page's own words and keeps it in step.
  const labels = labelled(el).map((h) => [h, h.getAttribute("aria-label") ?? ""] as const);
  return () => {
    for (const [h, v] of labels) h.setAttribute("aria-label", v);
    if (kids.length === 0) {
      el.textContent = plain;
      return;
    }
    const known = new Set(texts.map(([n]) => n));
    const empty = (n: Node) => {
      for (const c of Array.from(n.childNodes)) {
        if (c.nodeType === 3 && !known.has(c)) c.nodeValue = "";
        else empty(c);
      }
    };
    empty(el);
    for (const [n, v] of texts) n.nodeValue = v;
    for (const [k, v] of kids) if (k.style) k.style.visibility = v;
  };
}

/** The page's own line count, for a part whose lines we may cut: a headline, or a part the page splits into lines. */
function linesOf(el: Element, entry: ManifestEntry | undefined, head: boolean): number {
  return entry?.inline?.lines || head ? lineCount(el) : 0;
}

export function applyVariant(
  variant: VariantBody,
  targets?: Record<string, ManifestEntry>,
  boxOf: (el: Element) => number = measureHeight,
  /** For a part built word by word (the early write reserves its rotation only once the edge confirmed). */
  rotBoxOf: (el: Element) => number = boxOf,
): boolean {
  applied.length = 0;
  sequels.length = 0;
  skip = "missing";
  setWriting();
  const paths = flattenSections(variant.sections as Record<string, unknown>);

  // Pre-flight, per path. A variant can carry paths the page never claimed
  // (a "comparison" block written before the page was read, a cta.headline
  // the manifest does not map): those are skipped. A path the page DOES
  // claim (manifest entry, data-rawuser tag, or a convention default when
  // there is no manifest) must resolve, or this is not the manifest's page
  // and we mutate nothing.
  //
  // Paths excluded from the check (they're metadata, not DOM targets):
  //   .kind  — section type discriminator ("hero" / "cta" / etc.)
  //   .href  — co-located metadata for the corresponding .label element
  const resolved = new Map<string, Element[]>();
  const skipped = new Set<string>();
  for (const [path] of paths) {
    if (notPart(path)) continue;
    if (!expectedOnPage(path, targets)) {
      skipped.add(path);
      continue;
    }
    const elements = findTargets(path, targets?.[path]);
    if (elements.length === 0) return false; // claimed by the page, absent: not this page
    resolved.set(path, elements);
  }
  if (resolved.size === 0) return false;

  let mutated = false;
  for (const [path, value] of paths) {
    const href = path.endsWith(".href");
    // A kind is never rendered, a second or third length goes with its base.
    if ((!href && notPart(path)) || skipped.has(path)) continue;
    // An href rides with its label: skip it when the label was skipped.
    if (href && skipped.has(path.replace(/\.href$/, ".label"))) continue;
    const elements = href ? findTargets(path, targets?.[path]) : (resolved.get(path) ?? []);
    setWriting(path);

    for (const el of elements) {
      if (href) {
        // href path: set only on link/button elements without an existing href
        if (
          (el instanceof HTMLAnchorElement || el instanceof HTMLButtonElement) &&
          !(el as HTMLAnchorElement).href
        ) {
          (el as HTMLAnchorElement).href = value;
          mutated = true;
        }
      } else {
        // All other paths: words only, design kept (never innerHTML).
        const original = el.textContent ?? "";
        const entry = targets?.[path];
        // Two lengths, the page picks (docs/specs/NEXT.md): with a second
        // length in hand, write the first, read the box against the
        // original's, and if the line count changed try the other and keep
        // the closer. All before the reveal, inside one task, so nothing
        // between the two is ever painted.
        // Three lengths since 2026-09-16: the second on one side of the
        // original, the third on the other, so there is always a candidate
        // to fall back to whichever way the first one wraps.
        const alts = [paths.get(`${path}_alt`), paths.get(`${path}_alt2`)].filter(
          (a): a is string => typeof a === "string" && a.length > 0 && a !== value,
        );
        const rotating = !!entry?.inline?.template && !entry.plain;
        const measure = rotating ? rotBoxOf : boxOf;
        // A headline or paragraph is fitted even when its lengths came back
        // as one text (two Webflow versions, 2026-09-30: all three the same,
        // the paragraph lost a line with nothing to measure against).
        const fit = !rotating && (alts.length > 0 || /\.(headline|body)$/.test(path));
        const head = /headline$/.test(path);
        // A label has one length: when ours makes its row taller (a wrapped
        // button row on a phone: a pilot site's /az at 390 and 360, +55 to +60 px,
        // 2026-09-30), the page's own label stays.
        const label = /label$/.test(path);
        const row = (x: Element) => measure(x.parentElement ?? x);
        unreserve(el);
        const restore = snapshot(el);
        // The part exactly as we left it, kept current through our own later
        // fits, so the early write can still be told from a page that took it.
        let html = "";
        // Once the visitor has seen the part, a fit again keeps its words and
        // adjusts only the hold (a pilot site's /az at 390, 2026-10-26: the fonts at
        // 4.7 s swapped the shown short length for the base, 19 of 19 loads).
        let seen = false;
        const shown = () => {
          seen ||= getComputedStyle(el).visibility !== "hidden";
          return seen;
        };
        const mark = (b: number): number => {
          html = el.innerHTML;
          return b;
        };
        const before = alts.length > 0 || fit ? measure(el) : label ? row(el) : 0;
        const lines = fit ? linesOf(el, entry, head) : 0;
        if (!writeText(el, value, entry)) {
          setWriting();
          return false; // split text: leave the page whole
        }
        let chosen = value;
        // A part built word by word is measured with each of its rotating
        // words showing, and scored by the one farthest from the original:
        // a length must hold the page's lines for every word the page will
        // show (template-lab, 2026-09-28).
        const worst = (): number =>
          rotationHeights(el, measure).reduce((w, h) =>
            Math.abs(h - before) > Math.abs(w - before) ? h : w,
          );
        // The fit of this part, run again: the page's own words back, their
        // box measured, ours written and fitted. Returns the box it measured.
        let again: (() => number) | undefined;
        if (fit) {
          // The page's emphasis kept where a length carries it (a pilot site
          // /approach, 2026-09-30: six cells kept a length without its
          // *phrase* and the page's italic word stood empty).
          const em = entry?.inline?.emphasis;
          const cands = [value, ...alts].sort((a, b) =>
            em ? +b.includes("*") - +a.includes("*") : 0,
          );
          // Fitted in a fallback font: the box keeps the original's height
          // until the page's fonts land and the fit runs again, so a length
          // that loses a line in the real font does not pull the page up at
          // the swap (a pilot site's /az at 390, fonts 1.5 s late: CLS 0.10 to 0.16,
          // 2026-09-30). The fonts' own swap still moves what the page moves.
          // Faces load as the text asks for them (an italic word), so a fit
          // again can start another round: it holds again the same way.
          const fitNow = (b: number, n: number, c = cands): string => {
            const kept = fitLength(el, c, value, b, n, entry, measure, path);
            if (b > 0 && fontsLoading()) {
              setMinHeight(el, b);
              reserved.add(el);
            }
            return kept;
          };
          chosen = fitNow(before, lines);
          again = () => {
            // The page has cut it into its own lines since: those it keeps.
            if (entry?.inline?.lines && !bare(el)) return 0;
            unreserve(el);
            restore();
            const b = measure(el);
            const n = linesOf(el, entry, head);
            writeText(el, value, entry);
            chosen = fitNow(b, n, shown() ? [chosen] : cands);
            return mark(b);
          };
        } else if (label && (before > 0 || alts.length === 0)) {
          const give = (b: number) => {
            if (row(el) > b + SAME) {
              restore();
              gaveBack.add(el);
            } else gaveBack.delete(el);
            chosen = gaveBack.has(el) ? original : value;
          };
          if (before > 0) give(before);
          again = () => {
            if (shown()) return 0;
            restore();
            const b = row(el);
            writeText(el, value, entry);
            give(b);
            return mark(b);
          };
        } else if (alts.length > 0) {
          let bestSigned = worst() - before;
          let bestDiff = Math.abs(bestSigned);
          if (bestDiff !== 0) {
            for (const cand of alts) {
              writeText(el, cand, entry);
              const signed = worst() - before;
              const diff = Math.abs(signed);
              // The closer wins; on a tie the one under the original (the
              // founder's call, 2026-09-16 evening: a headline that gains a
              // line pushes the buttons down, one that loses a line does
              // not; a pilot site's /az at 390 px sat at +1 and -1 and kept +1).
              if (diff < bestDiff || (diff === bestDiff && signed < 0 && bestSigned > 0)) {
                bestDiff = diff;
                bestSigned = signed;
                chosen = cand;
                if (diff === 0) break;
              }
            }
            writeText(el, chosen, entry);
          }
        }
        if (again && before > 0) keepFitted(el, path, again);
        if (rotating) {
          reserveRotationHeight(el, measure);
          keepRotationReserved(el, measure);
        }
        const rec = { path, value: chosen, original, rendered: el.textContent ?? "" };
        applied.push(rec);
        mutated = true;
        mark(0);
        // Not measured yet (the early write, before the page's styles were in).
        let fitLater = before > 0 ? undefined : again;
        sequels.push((fitIt) => {
          // A box we held goes whatever the page did with the words since.
          if (!fitIt) unreserve(el);
          if (el.innerHTML !== html) return;
          if (!fitIt) {
            // What the rich writers poured into the page's own elements is
            // not put back in place; the next write goes over it, as before.
            const inl = entry?.inline;
            if (!inl || entry?.plain || !(inl.template || inl.lines)) restore();
          } else if (fitLater && fitLater() > 0) {
            // Fitted against a real box: once is enough, the rest is keepFitted's.
            keepFitted(el, path, fitLater);
            fitLater = undefined;
            rec.value = chosen;
            rec.rendered = el.textContent ?? "";
          }
        });
      }
    }
  }

  setWriting();
  return mutated;
}

/** When to look again after the swap, in ms. Covers React/Next/Vue hydration on a cold load. */
export const HOLD_CHECKS_MS: readonly number[] = [250, 800, 2000, 4500];
/**
 * How long the observer watches for a revert after the swap. Infinity: the
 * page's life (docs/specs/design-preserving-rewrite.md §3); a re-mount on
 * viewport entry or a language re-render after six seconds had left the
 * hero original with the section below rewritten.
 */
export const HOLD_OBSERVE_MS = Number.POSITIVE_INFINITY;
/** When to report slots that still show the original after every redo. */
export const PARTIAL_CHECK_MS = 30_000;
/** The hold's restores are counted for this long (snippet issues, `reverted`). */
export const REVERT_WINDOW_MS = 10_000;

/**
 * Hold the swap through hydration. On a client-rendered site the framework
 * hydrates after the page paints; on a cold load that can land AFTER our
 * swap, and React restores the server text (seen on a pilot site, Next.js,
 * 2026-09-12: hard reload showed the original, soft reload the version).
 * At a few points after the swap, re-find each element and, only if its
 * text went back to exactly the original we replaced, write the version
 * again. A site that changed the text to something else is left alone.
 */
export function holdVariant(
  targets?: Record<string, ManifestEntry>,
  checks: readonly number[] = HOLD_CHECKS_MS,
  setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  observeMs = HOLD_OBSERVE_MS,
  onPartial?: (paths: string[]) => void,
  partialMs = PARTIAL_CHECK_MS,
): () => void {
  const snapshot = applied.slice();
  if (snapshot.length === 0) return () => {};
  // Restores per part in the first ten seconds: a part put back more than
  // three times is a page taking our words back (snippet issues, `reverted`).
  const restores = new Map<string, number>();
  let counted = false;
  const report = () => {
    if (counted) return;
    counted = true;
    restores.forEach((n, path) => {
      if (n > 3) noteIssue("reverted", path, Math.min(n, 99));
    });
  };
  let stopped = false;
  const redo = () => {
    // Stopped: the tab is on another page, and a part of it that reads like
    // ours did is not ours to write (quiet-swap.md 2b). The timed looks too.
    if (stopped) return;
    for (const { path, value, original, rendered } of snapshot) {
      if (rendered === original) continue;
      for (const el of findTargets(path, targets?.[path])) {
        if (el.textContent === original && !gaveBack.has(el)) {
          try {
            writeText(el, value, targets?.[path]);
          } catch {
            noteError(path);
          }
          if (!counted) restores.set(path, (restores.get(path) ?? 0) + 1);
        }
      }
    }
  };
  // Once now: a framework that re-rendered while the part was hidden (the
  // zoo's React rotator after a carried write) is undone before the reveal.
  redo();
  const stops: Array<() => void> = [];
  // Slots still showing the original after every redo: the site rewrote
  // them in a way we do not touch. Reported once so the operator sees it.
  if (onPartial) {
    setTimer(() => {
      if (stopped) return;
      const paths: string[] = [];
      for (const { path, original, rendered } of snapshot) {
        if (rendered === original) continue;
        const els = findTargets(path, targets?.[path]);
        if (els.length === 0 || els.some((el) => el.textContent === original)) paths.push(path);
      }
      if (paths.length > 0) onPartial(paths);
    }, partialMs);
  }
  // A MutationObserver callback runs before the next paint, so a revert by
  // the framework is undone before anyone sees it. The timers stay as the
  // backup for engines without it.
  if (typeof MutationObserver !== "undefined" && document.body) {
    let guard = false;
    const observer = new MutationObserver(() => {
      if (guard) return;
      guard = true;
      try {
        redo();
      } finally {
        guard = false;
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    stops.push(() => observer.disconnect());
    if (Number.isFinite(observeMs)) setTimer(() => observer.disconnect(), observeMs);
  }
  for (const ms of checks) setTimer(redo, ms);
  setTimer(report, REVERT_WINDOW_MS);
  onIssueFlush(report);
  // The next personalisation pass (a client-side navigation) stops this one.
  return () => {
    stopped = true;
    for (const s of stops) s();
  };
}
