/**
 * Templates on the DOM side (docs/specs/template-writing.md §4.1 and §4.3).
 * The reading rules are a private copy of @rawuser/shared template.ts (the
 * snippet bundles nothing from shared); test/template-parity.test.ts keeps
 * the two identical. Below the copy: the DOM tree builder, the page's own
 * animation restarted, and a box held at a height. The writer itself is in
 * template-write.ts, loaded on demand as /rich.js (2026-09-30).
 */

/** A light tree of an element's children, built by either side. `ref` is the side's own node. */
export type TplNode =
  | { kind: "text"; text: string; ref?: unknown }
  | {
      kind: "el";
      tag: string;
      classes: readonly string[];
      children: readonly TplNode[];
      /** The inline style attribute, when the side has it (lines are marked by their masks). */
      style?: string;
      ref?: unknown;
    };

/** What the reader found, with the template. */
export interface PageTemplate {
  template: string;
  words: number;
  glyphs: number;
  breaks: number;
  /** One entry per style group, in first-appearance order: its class signature. */
  groups: string[];
  /** The rotating slot's alternatives, when the headline has one. */
  rotator?: string[];
  /** Its words are split into letters. */
  letters?: boolean;
}

/** One piece of words in a text segment: a word element or a loose text node. */
export interface Unit {
  text: string;
  kind: "el" | "text";
  ref?: unknown;
  /** What stands between this unit and the one before it in the segment: " " or "". */
  sep?: string;
}

/** The element cut into the parts a template names, in page order. */
export type Segment =
  | { t: "text"; units: Unit[] }
  | { t: "space" }
  | { t: "br"; ref?: unknown }
  | { t: "glyph"; n: number; ref?: unknown }
  | { t: "open"; n: number }
  | { t: "close"; n: number }
  | { t: "rot"; alts: string[]; ref?: unknown; altRefs: unknown[] };

/** Tags that never carry words a reader sees (kept in step with inline-shape.ts). */
const NO_TEXT_TAGS: ReadonlySet<string> = new Set([
  "svg",
  "img",
  "picture",
  "video",
  "canvas",
  "hr",
  "script",
  "style",
  "template",
  "noscript",
  "i",
]);

/** Classes a page puts on the one visible alternative of a rotating slot. */
export const STATE_CLASSES: ReadonlySet<string> = new Set([
  "on",
  "active",
  "current",
  "is-active",
  "is-current",
  "visible",
  "is-visible",
  "show",
  "shown",
  "selected",
]);

export const WORDS = /[\p{L}\p{N}]/u;
const TOKEN_CHARS = /[{}|]/g;

function textOf(n: TplNode): string {
  if (n.kind === "text") return n.text;
  if (n.tag === "br" || NO_TEXT_TAGS.has(n.tag)) return "";
  return n.children.map(textOf).join("");
}

function hasWords(n: TplNode): boolean {
  return WORDS.test(textOf(n));
}

function wordyChildren(n: TplNode): TplNode[] {
  return n.kind === "el" ? n.children.filter((c) => c.kind === "el" && hasWords(c)) : [];
}

/** A word element: words, and no child element with words of its own. */
/**
 * A word split into letters: two or more one-character elements side by side
 * with nothing between them (Framer's text effect, a nowrap span per word;
 * Splitting.js's span.word). Read as one word, so a letter split is a
 * template like any other (docs/specs/interactive-text.md §3.2).
 */
export function isLetterWord(n: TplNode): boolean {
  if (n.kind !== "el" || n.children.length < 2 || !hasWords(n)) return false;
  return n.children.every(
    (c) =>
      c.kind === "el" &&
      c.children.every((k) => k.kind === "text") &&
      clean(textOf(c)).length === 1,
  );
}

function isLeafWord(n: TplNode): boolean {
  return n.kind === "el" && hasWords(n) && (wordyChildren(n).length === 0 || isLetterWord(n));
}

/** An element holding only a space (Splitting.js's span.whitespace between words). */
function isSpaceEl(n: TplNode): boolean {
  return n.kind === "el" && n.children.every((c) => c.kind === "text") && /^\s+$/.test(textOf(n));
}

const LINE_CLASS = /(?:^|[-_])lines?\d*(?:[-_]|$)/i;
const LINE_STYLE = /overflow(?:-y)?:(?:hidden|clip)|white-space:nowrap/;

/**
 * Lines the page made: two to eight sibling elements with words, each
 * marked as a line (a class named for lines, or an overflow mask, or
 * nowrap) and at least one holding several words, reached through
 * wrappers with one wordy child. Null otherwise. Noho (Webflow), Grigoletti
 * (Framer) and GSAP SplitText all build one; the 2026-09-29 survey found
 * five among fifteen Awwwards heroes.
 */
export function lineSet(nodes: readonly TplNode[]): TplNode[] | null {
  const kids = nodes.filter((c) => c.kind === "el" && hasWords(c));
  const only = kids[0];
  if (kids.length === 1 && only?.kind === "el")
    return isLeafWord(only) ? null : lineSet(only.children);
  if (kids.length < 2 || kids.length > 8) return null;
  const marked = kids.every(
    (k) =>
      k.kind === "el" &&
      !isLetterWord(k) &&
      (k.classes.some((c) => LINE_CLASS.test(c)) ||
        LINE_STYLE.test((k.style ?? "").toLowerCase().replace(/\s+/g, ""))),
  );
  return marked && kids.some((k) => /\S\s+\S/.test(textOf(k))) ? kids : null;
}

/** Two or more word elements, no text between them, exactly one in a state class. */
function isRotator(n: TplNode): boolean {
  if (n.kind !== "el") return false;
  const kids = n.children.filter((c) => !(c.kind === "text" && !/\S/.test(c.text)));
  if (kids.length < 2) return false;
  if (!kids.every((c) => c.kind === "el" && isLeafWord(c))) return false;
  const on = kids.filter((c) => c.kind === "el" && c.classes.some((k) => STATE_CLASSES.has(k)));
  return on.length === 1;
}

function clean(text: string): string {
  return text.replace(TOKEN_CHARS, "").replace(/\s+/g, " ").trim();
}

/**
 * The classes every word element carries (the page's "w"): the base, not a
 * style. Every one, not most: when most words are dimmed, "dim" is still a
 * style.
 */
function baseClasses(leaves: readonly TplNode[]): Set<string> {
  let base: Set<string> | undefined;
  for (const l of leaves) {
    if (l.kind !== "el") continue;
    const own = new Set<string>(l.classes.map(stem));
    const before: Set<string> | undefined = base;
    base = before === undefined ? own : new Set<string>([...before].filter((c) => own.has(c)));
  }
  return base ?? new Set<string>();
}

/** Rotating slots under these nodes, not looking inside one. */
function rotatorsIn(nodes: readonly TplNode[]): number {
  let n = 0;
  for (const c of nodes) {
    if (c.kind !== "el") continue;
    n += isRotator(c) ? 1 : rotatorsIn(c.children);
  }
  return n;
}

/**
 * A class with the number a split library gives each piece taken off
 * (`gsap_split_word1` and `gsap_split_word2` are one class, `word3-mask`
 * is `word-mask`): read as styles, the numbers made every word its own
 * group (Sirene, a Webflow template, 2026-09-29 survey).
 */
function stem(c: string): string {
  return c.replace(/\d+(?=(?:-[a-z]+)?$)/, "");
}

/**
 * Word elements at any depth: a split nests them in lines or groups, so
 * counting direct children missed it and the page's split was written as
 * plain text (8 of 53 heroes in the 2026-09-29 survey).
 */
export function wordyLeafCount(nodes: readonly TplNode[]): number {
  let n = 0;
  for (const c of nodes) {
    if (c.kind !== "el" || c.tag === "br" || NO_TEXT_TAGS.has(c.tag)) continue;
    // A word in letters alone makes the element split text: never flattened.
    n += isLetterWord(c) ? 5 : isLeafWord(c) ? 1 : wordyLeafCount(c.children);
  }
  return n;
}

function collectLeaves(nodes: readonly TplNode[], out: TplNode[]): void {
  for (const n of nodes) {
    if (n.kind !== "el" || n.tag === "br" || NO_TEXT_TAGS.has(n.tag)) continue;
    if (isRotator(n)) continue;
    if (isLeafWord(n)) out.push(n);
    else collectLeaves(n.children, out);
  }
}

type Piece =
  | { t: "word"; text: string; group: string; unit: Unit }
  | { t: "glyph"; ref?: unknown }
  | { t: "br"; ref?: unknown }
  | { t: "rot"; alts: string[]; group: string; ref?: unknown; altRefs: unknown[] }
  | { t: "space" };

/** One element per letter is an animation of letters, not words: no template. */
function isLetterSplit(leaves: readonly TplNode[]): boolean {
  if (leaves.length < 5) return false;
  const short = leaves.filter((l) => clean(textOf(l)).length <= 1).length;
  return short * 2 > leaves.length;
}

function piecesOf(children: readonly TplNode[], base: Set<string>): Piece[] {
  const pieces: Piece[] = [];
  const signature = (classes: readonly string[]) =>
    [...new Set(classes.map(stem))]
      .filter((c) => !base.has(c) && !STATE_CLASSES.has(c))
      .sort()
      .join(" ");
  const walk = (nodes: readonly TplNode[], group: string): void => {
    for (const n of nodes) {
      if (n.kind === "text") {
        const words = clean(n.text);
        if (/^\s/.test(n.text) || (!words && /\s/.test(n.text))) pieces.push({ t: "space" });
        if (words) {
          pieces.push({
            t: "word",
            text: words,
            group,
            unit: { text: words, kind: "text", ref: n.ref },
          });
        }
        if (words && /\s$/.test(n.text)) pieces.push({ t: "space" });
        continue;
      }
      if (n.tag === "br") {
        pieces.push({ t: "br", ref: n.ref });
        continue;
      }
      if (isSpaceEl(n)) {
        pieces.push({ t: "space" });
        continue;
      }
      if (NO_TEXT_TAGS.has(n.tag) || !hasWords(n)) {
        pieces.push({ t: "glyph", ref: n.ref });
        continue;
      }
      if (isRotator(n)) {
        const kids = n.children.filter((c) => c.kind === "el");
        pieces.push({
          t: "rot",
          alts: kids.map((c) => clean(textOf(c))),
          altRefs: kids.map((c) => c.ref),
          group,
          ref: n.ref,
        });
        continue;
      }
      if (isLeafWord(n)) {
        const text = clean(textOf(n));
        const sig = signature(n.classes);
        pieces.push({
          t: "word",
          text,
          group: sig || group,
          unit: { text, kind: "el", ref: n.ref },
        });
        continue;
      }
      // A container: a style group when it holds two or more word elements
      // (a rotating slot counts as one) and has a class of its own;
      // otherwise only a wrapper to walk through. The rotating slot counts
      // so a group stays a group when a version leaves one word beside it:
      // "for {rot:…}" read as no group and the page's own length could not
      // be written back (template-lab, 2026-09-28, problem:community at 390).
      const inner: TplNode[] = [];
      collectLeaves(n.children, inner);
      const sig = signature(n.classes);
      const count = inner.length + rotatorsIn(n.children);
      walk(n.children, count >= 2 && sig ? `@${sig}` : group);
    }
  };
  walk(children, "");
  return pieces;
}

/**
 * The element cut into segments, with the facts the reader reports, or null
 * when it is not built word by word (fewer than five word elements, or split
 * by letter).
 */
export function segmentsOf(
  children: readonly TplNode[],
): { segments: Segment[]; groups: string[]; words: number } | null {
  const leaves: TplNode[] = [];
  collectLeaves(children, leaves);
  // Five word elements make a split, or one word in letters.
  if ((leaves.length < 5 && !leaves.some(isLetterWord)) || isLetterSplit(leaves)) return null;
  const pieces = piecesOf(children, baseClasses(leaves));

  // Groups get their numbers in first-appearance order.
  const groupIds = new Map<string, number>();
  for (const p of pieces) {
    if ((p.t === "word" || p.t === "rot") && p.group && !groupIds.has(p.group)) {
      groupIds.set(p.group, groupIds.size + 1);
    }
  }

  const segs: Segment[] = [];
  let open = "";
  let pendingSpace = false;
  let glyphs = 0;
  let words = 0;
  const last = (): Segment | undefined => segs[segs.length - 1];
  const pushSpace = () => {
    const prev = last();
    if (pendingSpace && prev !== undefined && prev.t !== "br") segs.push({ t: "space" });
    pendingSpace = false;
  };
  const closeGroup = () => {
    const id = groupIds.get(open);
    if (open && id !== undefined) segs.push({ t: "close", n: id });
    open = "";
  };
  const enter = (group: string) => {
    if (group !== open) {
      closeGroup();
      pushSpace();
      const id = groupIds.get(group);
      if (group && id !== undefined) {
        segs.push({ t: "open", n: id });
        open = group;
      }
    } else {
      pushSpace();
    }
  };
  for (const p of pieces) {
    if (p.t === "space") {
      pendingSpace = true;
      continue;
    }
    if (p.t === "br") {
      closeGroup();
      if (last()?.t === "space") segs.pop();
      segs.push({ t: "br", ref: p.ref });
      pendingSpace = false;
      continue;
    }
    if (p.t === "glyph") {
      // A glyph is not part of a style group: the group closes before it.
      glyphs++;
      closeGroup();
      pushSpace();
      segs.push({ t: "glyph", n: glyphs, ref: p.ref });
      continue;
    }
    if (p.t === "rot") {
      enter(p.group);
      segs.push({ t: "rot", alts: p.alts, ref: p.ref, altRefs: p.altRefs });
      continue;
    }
    words += p.text.split(" ").filter((w) => WORDS.test(w)).length;
    // Words of one group, one after the other, are one segment: the writer
    // fills a segment's word elements with that run's words.
    const prev = last();
    if (p.group === open && prev?.t === "text") {
      prev.units.push({ ...p.unit, sep: pendingSpace ? " " : "" });
      pendingSpace = false;
    } else {
      enter(p.group);
      segs.push({ t: "text", units: [p.unit] });
    }
  }
  closeGroup();
  while (last()?.t === "space") segs.pop();
  while (segs[0]?.t === "space") segs.shift();
  return { segments: segs, groups: [...groupIds.keys()].map((g) => g.replace(/^@/, "")), words };
}

/** The template string of a list of segments. */
export function renderSegments(segments: readonly Segment[]): string {
  return segments
    .map((s) => {
      switch (s.t) {
        case "text":
          return s.units.map((u, i) => (i === 0 ? "" : (u.sep ?? " ")) + u.text).join("");
        case "space":
          return " ";
        case "br":
          return "{br}";
        case "glyph":
          return `{g${s.n}}`;
        case "open":
          return `{s${s.n}}`;
        case "close":
          return `{/s${s.n}}`;
        case "rot":
          return `{rot:${s.alts.join("|")}}`;
        default:
          return "";
      }
    })
    .join("");
}

/**
 * The page's template for an element built word by word, or null when the
 * element is not one (fewer than five word elements, or split by letter).
 */
export function readTemplate(children: readonly TplNode[]): PageTemplate | null {
  const cut = segmentsOf(children);
  if (!cut) return null;
  const { segments, groups, words } = cut;
  let rotator: string[] | undefined;
  for (const s of segments) if (s.t === "rot") rotator = s.alts;
  const leaves: TplNode[] = [];
  collectLeaves(children, leaves);
  return {
    template: renderSegments(segments),
    ...(leaves.some(isLetterWord) ? { letters: true } : {}),
    words,
    glyphs: segments.filter((s) => s.t === "glyph").length,
    breaks: segments.filter((s) => s.t === "br").length,
    groups,
    ...(rotator ? { rotator } : {}),
  };
}

/** The template's tokens, in order. */
export type TemplateToken =
  | { t: "text"; text: string }
  | { t: "br" }
  | { t: "glyph"; n: number }
  | { t: "open"; n: number }
  | { t: "close"; n: number }
  | { t: "rot"; alts: string[] };

export function parseTemplate(template: string): TemplateToken[] {
  const out: TemplateToken[] = [];
  const re = /\{br\}|\{g(\d+)\}|\{s(\d+)\}|\{\/s(\d+)\}|\{rot:([^}]*)\}/g;
  let last = 0;
  for (const m of template.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: "text", text: template.slice(last, at) });
    if (m[0] === "{br}") out.push({ t: "br" });
    else if (m[1] !== undefined) out.push({ t: "glyph", n: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: "open", n: Number(m[2]) });
    else if (m[3] !== undefined) out.push({ t: "close", n: Number(m[3]) });
    else if (m[4] !== undefined) out.push({ t: "rot", alts: m[4].split("|").map((a) => a.trim()) });
    last = at + m[0].length;
  }
  if (last < template.length) out.push({ t: "text", text: template.slice(last) });
  return out;
}

/**
 * The words a reader sees, one line per {br}, with the rotating slot's
 * longest alternative (the width the slot can take). Its length is the
 * element's character count; textContent would count every alternative.
 */
export function templateText(template: string): string {
  return parseTemplate(template)
    .map((tok) => {
      if (tok.t === "text") return tok.text;
      if (tok.t === "br") return "\n";
      if (tok.t === "rot") return tok.alts.reduce((a, b) => (b.length > a.length ? b : a), "");
      return "";
    })
    .join("")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .join("\n");
}

/** Characters a reader sees, lines joined by one space. */
export function templateLength(template: string): number {
  return templateText(template).replace(/\n/g, " ").length;
}

// ---------------------------------------------------------------------------
// What a version must keep (docs/specs/template-writing.md §3.2)
// ---------------------------------------------------------------------------

/** A template's tokens without whitespace-only text, text trimmed: the structure the writer walks. */
export function templateSkeleton(template: string): TemplateToken[] {
  const out: TemplateToken[] = [];
  for (const tok of parseTemplate(template)) {
    if (tok.t !== "text") {
      out.push(tok);
      continue;
    }
    const text = tok.text.replace(/\s+/g, " ").trim();
    if (text) out.push({ t: "text", text });
  }
  return out;
}

function shapeKey(tok: TemplateToken): string {
  switch (tok.t) {
    case "text":
      // Punctuation alone (the "." after a rotating word) is the page's own
      // and stays as it is: a word written there lands in a node with no
      // space before it (template-lab, 2026-09-27: "choiceworks.").
      return WORDS.test(tok.text) ? "…" : tok.text;
    case "br":
      return "{br}";
    case "glyph":
      return `{g${tok.n}}`;
    case "open":
      return `{s${tok.n}}`;
    case "close":
      return `{/s${tok.n}}`;
    case "rot":
      return `{rot×${tok.alts.length}}`;
  }
}

/** The page's structure with its words hidden: what the revise pass is shown. */
export function templateShape(template: string): string {
  return templateSkeleton(template).map(shapeKey).join(" ");
}

export type TemplateRule =
  | "template-markers"
  | "template-glyphs"
  | "template-lines"
  | "template-rotator"
  | "template-groups"
  | "template-words";

/**
 * Every way a version's template breaks the page's structure, with the fix
 * in words. Empty when the snippet's writer will take it.
 */
export function templateViolations(
  page: string,
  version: string,
): Array<{ rule: TemplateRule; excerpt: string }> {
  const out: Array<{ rule: TemplateRule; excerpt: string }> = [];
  const p = templateSkeleton(page);
  const v = templateSkeleton(version);
  const leftover = version.replace(/\{br\}|\{g\d+\}|\{\/?s\d+\}|\{rot:[^}]*\}/g, "");
  if (/[*{}|]/.test(leftover)) {
    out.push({
      rule: "template-markers",
      excerpt: "only {br}, {gN}, {sN}…{/sN} and {rot:…} may appear; no asterisks, no other braces",
    });
  }
  const glyphs = (ts: TemplateToken[]) => ts.flatMap((t) => (t.t === "glyph" ? [t.n] : []));
  const pg = glyphs(p);
  if (glyphs(v).join(",") !== pg.join(",")) {
    out.push({
      rule: "template-glyphs",
      excerpt: `keep ${pg.map((n) => `{g${n}}`).join(" ") || "no glyph"}, each once, in this order`,
    });
  }
  const breaks = (ts: TemplateToken[]) => ts.filter((t) => t.t === "br").length;
  if (breaks(v) !== breaks(p)) {
    out.push({
      rule: "template-lines",
      excerpt: `keep ${breaks(p)} line breaks ({br}), as the page has`,
    });
  }
  const rots = (ts: TemplateToken[]) => ts.flatMap((t) => (t.t === "rot" ? [t.alts] : []));
  const [pr] = rots(p);
  const vr = rots(v);
  if (pr) {
    const longest = Math.max(...pr.map((a) => a.length));
    const alts = vr[0];
    const bad =
      vr.length !== 1 ||
      !alts ||
      alts.length !== pr.length ||
      alts.some((a) => a.length === 0 || a.length > longest + 2 || a.split(" ").length > 2);
    if (bad) {
      out.push({
        rule: "template-rotator",
        excerpt: `one {rot:…} with ${pr.length} alternatives, one or two words each, at most ${longest + 2} characters`,
      });
    }
  } else if (vr.length > 0) {
    out.push({
      rule: "template-rotator",
      excerpt: "the page has no rotating word; write no {rot:…}",
    });
  }
  if (out.length === 0 && v.map(shapeKey).join(" ") !== p.map(shapeKey).join(" ")) {
    const edges = (ts: TemplateToken[]) =>
      ts.flatMap((t) => (t.t === "open" || t.t === "close" ? [shapeKey(t)] : [])).join(" ");
    out.push({
      rule: edges(v) !== edges(p) ? "template-groups" : "template-words",
      excerpt: `keep the page's structure, words only where it has words (…): ${templateShape(page)}`,
    });
  }
  return out;
}

/** The element's children as a light tree, each node carrying its DOM node. */
/**
 * A copy the page keeps out of sight to measure its own text (Framer: an
 * absolutely placed, visibility-hidden duplicate inside the h1; read as
 * words, it doubled the headline, the 2026-09-29 survey), or an element
 * with the `hidden` attribute. A split library's own pieces are placed
 * relative and may be hidden while they wait to animate in: those stay.
 */
export function isMeasuringCopy(style: string | null, hiddenAttr: boolean): boolean {
  if (hiddenAttr) return true;
  const st = (style ?? "").toLowerCase().replace(/\s+/g, "");
  return (
    /(?:^|;)(?:visibility:hidden|display:none)/.test(st) && /(?:^|;)position:absolute/.test(st)
  );
}

export function treeOf(el: Element): TplNode[] {
  const out: TplNode[] = [];
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) out.push({ kind: "text", text: n.nodeValue ?? "", ref: n });
    else if (n.nodeType === 1) {
      const e = n as Element;
      if (isMeasuringCopy(e.getAttribute("style"), e.hasAttribute("hidden"))) continue;
      out.push({
        kind: "el",
        tag: e.tagName.toLowerCase(),
        classes: Array.from(e.classList),
        children: treeOf(e),
        style: e.getAttribute("style") ?? "",
        ref: e,
      });
    }
  }
  return out;
}

/** The live element's template, or null when it is not built word by word. */
export function readElementTemplate(el: Element): PageTemplate | null {
  return readTemplate(treeOf(el));
}

// ---------------------------------------------------------------------------
// What the core keeps of the writing side: the page's own animation restarted,
// a box held at a height. The writers are in template-write.ts (rich.js).
// ---------------------------------------------------------------------------

/** The page's entry animations run again from their start, now that the words are in. */
interface GsapTween {
  restart: (includeDelay?: boolean) => unknown;
  paused?: () => boolean;
  scrollTrigger?: unknown;
  parent?: GsapTween | null;
}

/**
 * A tween the page holds for later: paused, or driven by scrolling (a
 * ScrollTrigger on it or on a timeline above it). Restarting it would play
 * a below-the-fold entrance at the reveal, before the visitor scrolls there.
 */
function heldForLater(t: GsapTween): boolean {
  for (let p: GsapTween | null | undefined = t; p; p = p.parent) {
    if (p.scrollTrigger || p.paused?.()) return true;
  }
  return false;
}

export function restartAnimations(el: Element): void {
  const withAnims = el as Element & { getAnimations?: (o?: { subtree?: boolean }) => Animation[] };
  try {
    for (const a of withAnims.getAnimations?.({ subtree: true }) ?? []) a.currentTime = 0;
  } catch {
    // an engine without the Web Animations API: the page's own timing stands
  }
  // A page that animates with GSAP (Webflow's SplitText and interactions)
  // holds its tweens itself: its own entrance plays again, from the start,
  // on our words. On a warm load the Webflow test page split and started
  // its lines before our answer came, and the entrance ran out while the
  // headline was still hidden (2026-09-29). Only tweens still alive are
  // found; one that already finished is left as it ended, and one the page
  // holds for later (paused, or waiting on a scroll) is left waiting.
  const gsap = (globalThis as { gsap?: { getTweensOf?: (t: Element[]) => GsapTween[] } }).gsap;
  try {
    const tweens = gsap?.getTweensOf?.([el, ...Array.from(el.querySelectorAll("*"))]) ?? [];
    for (const t of new Set(tweens)) if (!heldForLater(t)) t.restart(true);
  } catch {
    // the page's GSAP is not the one we expect: its own timing stands
  }
}

/** The element's box held at least this tall (a border-box height, px), whatever its box-sizing. */
export function setMinHeight(el: Element, height: number): void {
  const style = (el as HTMLElement).style;
  if (!style) return;
  let edge = 0;
  try {
    const cs = getComputedStyle(el);
    if (cs.boxSizing !== "border-box") {
      for (const v of [cs.paddingTop, cs.paddingBottom, cs.borderTopWidth, cs.borderBottomWidth]) {
        edge += Number.parseFloat(v) || 0;
      }
    }
  } catch {
    // No computed style (a detached node): the border box it is.
  }
  style.minHeight = `${height - edge}px`;
}
