/**
 * Template reading (docs/specs/template-writing.md §3.1 and §4.1): a headline
 * built word by word, read as a template the version fills with its own
 * words. Pure: the DOM side (snippet, picker) and the HTML side (generation,
 * node-html-parser) each build a light tree of the element's children and
 * call this; test/template-parity.test.ts keeps the snippet's private copy
 * identical.
 *
 * Tokens: words; {br} a line break; {g1}, {g2}… the page's non-text children
 * in page order; {s1}…{/s1} a style group; {rot:a|b|c} a rotating slot.
 *
 * The reader first cuts the element into segments (runs of words, glyphs,
 * breaks, group edges, the rotating slot), then renders the template from
 * them. The snippet's writer cuts the live element the same way, so a version
 * and the page always agree on which words go where.
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
const STATE_CLASSES: ReadonlySet<string> = new Set([
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

const WORDS = /[\p{L}\p{N}]/u;
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

/**
 * A copy the page keeps out of sight to measure its own text (Framer: an
 * absolutely placed, visibility-hidden duplicate inside the h1; read as
 * words, it doubled the headline, the 2026-09-29 survey), or an element
 * with the `hidden` attribute. A split library's own pieces are placed
 * relative and may be hidden while they wait to animate in: those stay.
 * Both tree builders skip it (the snippet's DOM side keeps the same rule).
 */
export function isMeasuringCopy(style: string | null, hiddenAttr: boolean): boolean {
  if (hiddenAttr) return true;
  const st = (style ?? "").toLowerCase().replace(/\s+/g, "");
  return (
    /(?:^|;)(?:visibility:hidden|display:none)/.test(st) && /(?:^|;)position:absolute/.test(st)
  );
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

/**
 * Every sentence a visitor will read: one per rotating word (one when there
 * is none), lines joined by a space. The grammar check reads these
 * (docs/specs/interactive-text.md §3.5).
 */
export function templateReadings(template: string): string[] {
  const toks = parseTemplate(template);
  const rot = toks.find((t) => t.t === "rot");
  const n = rot && rot.t === "rot" ? rot.alts.length : 1;
  const out: string[] = [];
  for (let a = 0; a < n; a++) {
    out.push(
      toks
        .map((t) =>
          t.t === "text" ? t.text : t.t === "br" ? " " : t.t === "rot" ? (t.alts[a] ?? "") : "",
        )
        .join("")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return out;
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

/**
 * The page's structure with every word a blank: each word becomes "_", its
 * punctuation stays, tokens stay, a rotating slot keeps its size. What the
 * model is shown instead of the page's words, which it copied back (the lab
 * run, 2026-09-27: 14 of 30 versions were the page's own headline).
 */
export function templateBlanks(template: string): string {
  const blank = (text: string) =>
    text.replace(/\S+/g, (w) =>
      WORDS.test(w) ? w.replace(/[\p{L}\p{N}](?:.*[\p{L}\p{N}])?/u, "_") : w,
    );
  return parseTemplate(template)
    .map((tok) => {
      switch (tok.t) {
        case "text":
          return blank(tok.text);
        case "br":
          return "{br}";
        case "glyph":
          return `{g${tok.n}}`;
        case "open":
          return `{s${tok.n}}`;
        case "close":
          return `{/s${tok.n}}`;
        case "rot":
          return `{rot:${tok.alts.map(() => "_").join("|")}}`;
      }
    })
    .join("");
}

/** Every word the element holds, each rotating alternative included, lowercased, no spacing or punctuation. */
export function templateAllWords(template: string): string {
  return parseTemplate(template)
    .map((tok) => (tok.t === "text" ? tok.text : tok.t === "rot" ? tok.alts.join(" ") : " "))
    .join(" ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** One place a version writes words into: a run of words, or the rotating slot. */
export type TemplateSlot =
  | {
      kind: "run";
      /** The page's word count in this run. */
      words: number;
      /** 0-based line. */
      line: number;
      /** The page's own text around the words: kept as the page has it. */
      pre: string;
      post: string;
      /** The page's run starts a sentence, with a capital letter. */
      capital: boolean;
    }
  | { kind: "rot"; n: number; longest: number; line: number };

const LEAD = /^(\s*[^\p{L}\p{N}\s]*)/u;
const TRAIL = /([^\p{L}\p{N}]*)$/u;

function cutRun(text: string): { pre: string; core: string; post: string } {
  const pre = LEAD.exec(text)?.[1] ?? "";
  const rest = text.slice(pre.length);
  const post = TRAIL.exec(rest)?.[1] ?? "";
  return { pre, core: rest.slice(0, rest.length - post.length), post };
}

/**
 * The places a version fills, in page order (docs/specs/template-writing.md
 * §4.2, construction): the model writes a list of words per slot and code
 * places every token, so a version cannot break the structure (the second
 * lab run, 2026-09-28: shown blanks and asked for a template, 0 of 19 kept
 * it).
 */
export function templateSlots(page: string): TemplateSlot[] {
  const out: TemplateSlot[] = [];
  let line = 0;
  // A sentence starts at the headline's start and after a full stop; a
  // capital elsewhere ("AI tools") is a name, not a sentence start.
  let sentenceStart = true;
  for (const tok of parseTemplate(page)) {
    if (tok.t === "br") line++;
    else if (tok.t === "text" && !WORDS.test(tok.text)) {
      if (/[.!?]/.test(tok.text)) sentenceStart = true;
    } else if (tok.t === "text") {
      const { pre, core, post } = cutRun(tok.text);
      out.push({
        kind: "run",
        words: core.trim().split(/\s+/).filter(Boolean).length,
        line,
        pre,
        post,
        capital: sentenceStart && /^\p{Lu}/u.test(core.trim()),
      });
      sentenceStart = /[.!?]\s*$/.test(tok.text);
    } else if (tok.t === "rot") {
      sentenceStart = false;
      out.push({
        kind: "rot",
        n: tok.alts.length,
        longest: Math.max(...tok.alts.map((a) => a.length)),
        line,
      });
    }
  }
  return out;
}

const EDGE_PUNCT = /^[\s.,;:!?…]+|[\s.,;:!?…]+$/g;

/**
 * The page's template filled with a version's words: one string per run;
 * the rotating slot keeps the page's own words. Null when the list does not
 * fit the runs. Punctuation at a run's edges is the page's, so the model's own is
 * dropped there; token characters never reach the template.
 */
/**
 * A word that starts a sentence: a capital then a small letter. Not "I", not
 * a name in capitals ("AI answer": the stop went in after "through an", the
 * lab run, 2026-09-28).
 */
function startsSentence(words: string): boolean {
  const first = words.trim().split(/\s+/)[0] ?? "";
  return /^\p{Lu}\p{Ll}/u.test(first);
}

/** Words a sentence never ends on, in the languages we write. */
const SMALL_WORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "for",
  "to",
  "through",
  "with",
  "and",
  "or",
  "in",
  "on",
  "at",
  "by",
  "from",
  "və",
  "ilə",
  "üçün",
  "bir",
  "и",
  "в",
  "на",
  "для",
  "с",
  "ve",
  "ile",
  "için",
  "bir",
]);

function endsOnSmallWord(words: string): boolean {
  const last = words.trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  return SMALL_WORDS.has(last);
}

export function fillTemplate(page: string, list: unknown): string | null {
  const slots = templateSlots(page);
  const entries = fitEntries(slots, list);
  if (!entries) return null;
  const clean = (v: string) =>
    v.replace(TOKEN_CHARS, "").replace(/\s+/g, " ").replace(EDGE_PUNCT, "");
  // The headline starts with a capital when the page's does.
  const capital = (v: string, slot: TemplateSlot, first: boolean) =>
    first && slot.kind === "run" && slot.capital
      ? v.replace(/^\p{Ll}/u, (c) => c.toUpperCase())
      : v;
  // The version punctuates its own sentences: asked to stop where the page
  // stops, the lab trial wrote "for one. / Kind of visitor"; stripped of its
  // own stops, it ran two sentences together. The page's stops at a run's
  // end give way to the version's; nothing goes right before the rotating
  // word, whose full stop is the page's.
  const SENTENCE = /[.,;:!?…]+/g;
  const nextIsRot = (i: number) => slots[i]?.kind === "rot";
  let k = 0;
  const out: string[] = [];
  for (const tok of parseTemplate(page)) {
    if (tok.t === "text") {
      if (!WORDS.test(tok.text)) {
        out.push(tok.text);
        continue;
      }
      const slot = slots[k];
      const v = entries[k++];
      if (slot?.kind !== "run" || typeof v !== "string" || !WORDS.test(v)) return null;
      let own = nextIsRot(k) ? "" : (/[.,;:!?…]+$/.exec(v.trim())?.[0] ?? "");
      // A line that ends without a stop before a line that starts a sentence
      // gets its full stop (the lab rewrite, 2026-09-28: 24 of 29 versions
      // ran two sentences together across a line; asked, the model did not).
      const next = slots[k];
      const nextWords = entries[k];
      if (
        own === "" &&
        next?.kind === "run" &&
        next.line > slot.line &&
        typeof nextWords === "string" &&
        startsSentence(nextWords) &&
        !endsOnSmallWord(v)
      ) {
        own = ".";
      }
      const words = capital(clean(v), slot, k === 1);
      out.push(`${slot.pre}${words}${own}${slot.post.replace(SENTENCE, "")}`);
    } else if (tok.t === "rot") {
      k++;
      out.push(`{rot:${tok.alts.join("|")}}`);
    } else if (tok.t === "br") out.push("{br}");
    else if (tok.t === "glyph") out.push(`{g${tok.n}}`);
    else if (tok.t === "open") out.push(`{s${tok.n}}`);
    else out.push(`{/s${tok.n}}`);
  }
  return out.join("");
}

/**
 * The model's list fitted to the slots. The list as asked passes through.
 * A list cut at other places (the lab trial, 2026-09-28: one word per string,
 * eight entries for seven runs) keeps its words in order and its rotating
 * list, and the words are dealt to the runs by the page's word counts; a
 * surplus goes to the page's longest run, a shortfall comes from the longest
 * runs first, never below one word. Null when there are fewer words than
 * runs.
 */
function fitEntries(slots: readonly TemplateSlot[], list: unknown): Array<string | null> | null {
  if (!Array.isArray(list)) return null;
  // The rotating words are the page's own (the founder's call, 2026-09-28,
  // spec §7.2): the version writes the runs around them, and any list the
  // model gives for the slot is ignored.
  const runs = slots.flatMap((s, i) => (s.kind === "run" ? [i] : []));
  const strings = list.filter((e): e is string => typeof e === "string");
  const place = (parts: readonly string[]) => {
    let w = 0;
    return slots.map((s) => (s.kind === "rot" ? null : (parts[w++] ?? "")));
  };
  if (strings.length === runs.length) return place(strings);
  const words = strings.flatMap((e) => e.trim().split(/\s+/).filter(Boolean));
  if (words.length < runs.length) return null;
  const counts = new Map(runs.map((i) => [i, (slots[i] as { words: number }).words]));
  const byLength = [...runs].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  let diff = words.length - [...counts.values()].reduce((a, b) => a + b, 0);
  for (let j = 0; diff !== 0; j = (j + 1) % byLength.length) {
    const i = byLength[diff > 0 ? 0 : j] as number;
    const c = counts.get(i) ?? 1;
    if (diff > 0) {
      counts.set(i, c + diff);
      diff = 0;
    } else if (c > 1) {
      counts.set(i, c - 1);
      diff++;
    }
  }
  let w = 0;
  const parts = runs.map((i) => {
    const n = counts.get(i) ?? 1;
    const part = words.slice(w, w + n).join(" ");
    w += n;
    return part;
  });
  return place(parts);
}

/**
 * A version's template back as the list the model writes (for the revise
 * pass, so it edits words and never tokens). Null when the version does not
 * keep the page's structure.
 */
export function templateEntries(page: string, version: string): string[] | null {
  if (templateViolations(page, version).length > 0) return null;
  const out: string[] = [];
  for (const tok of parseTemplate(version)) {
    if (tok.t === "text" && WORDS.test(tok.text)) out.push(cutRun(tok.text).core.trim());
  }
  return out.length === templateSlots(page).filter((s) => s.kind === "run").length ? out : null;
}

/** A template line's window around the page's line; the last line is capped at the page's own. */
export const LINE_FLOOR = 0.9;
export const LINE_CAP = 1.1;

/**
 * Each line of a version against its page line, in the characters a
 * visitor sees (the rotating slot counted with its longest word): the lines
 * outside their window. Lines of the page under eight characters are not
 * held. The last line's cap is the page's own length, so the page's layout
 * proves every rotating word fits (template-lab, 2026-09-28: longer last
 * lines flipped a line as the words rotated).
 */
export function templateLineMisses(
  page: string,
  version: string,
): Array<{ line: number; n: number; lo: number; hi: number; last: boolean; own: number }> {
  const lines = templateText(version).split("\n");
  const own = templateText(page).split("\n");
  const out: Array<{
    line: number;
    n: number;
    lo: number;
    hi: number;
    last: boolean;
    own: number;
  }> = [];
  own.forEach((l, i) => {
    const n = lines[i]?.length;
    if (n === undefined || l.length < 8) return;
    const last = i === own.length - 1;
    const lo = Math.ceil(l.length * LINE_FLOOR);
    const hi = last ? l.length : Math.floor(l.length * LINE_CAP);
    if (n < lo || n > hi) out.push({ line: i + 1, n, lo, hi, last, own: l.length });
  });
  return out;
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
  if (/[*{}|_]/.test(leftover) || /\{rot:[^}]*_/.test(version)) {
    out.push({
      rule: "template-markers",
      excerpt:
        "only {br}, {gN}, {sN}…{/sN} and {rot:…} may appear; no asterisks, no other braces, no _ left blank",
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
