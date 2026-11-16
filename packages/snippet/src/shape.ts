/**
 * The inline shape of an element, read from the live DOM
 * (docs/specs/design-preserving-rewrite.md §2). The rules are a private
 * copy of @rawuser/shared inline-shape.ts (the snippet bundles nothing
 * from shared); test/shape-parity.test.ts keeps the two identical.
 */

import { isMeasuringCopy, lineSet, treeOf, wordyLeafCount } from "./template.ts";

export interface InlineShape {
  icons: "none" | "leading" | "trailing" | "both";
  emphasis: number;
  emphasis_phrase?: string;
  split: boolean;
  animated_text: boolean;
  /** A headline built word by word, as a template (docs/specs/template-writing.md). */
  template?: string;
  /** Cut into this many lines (docs/specs/interactive-text.md §3.2). */
  lines?: number;
  /** The template's words are split into letters. */
  letters?: boolean;
}

export type InlinePart = { kind: "text"; text: string } | { kind: "el"; tag: string; text: string };

export const NO_TEXT_TAGS: ReadonlySet<string> = new Set([
  "svg",
  "img",
  "picture",
  "video",
  "canvas",
  "br",
  "hr",
  "script",
  "style",
  "template",
  "noscript",
  "i",
]);

export const SPLIT_TEXT_CHILDREN = 4;

const WORDS = /[\p{L}\p{N}]/u;

export function hasWords(part: InlinePart): boolean {
  if (part.kind === "el" && NO_TEXT_TAGS.has(part.tag.toLowerCase())) return false;
  return WORDS.test(part.text);
}

/**
 * The shape from an element's direct parts, and its word elements at any
 * depth (`leaves`): more than four either way is split text, a per-word,
 * per-letter or per-line animation.
 */
export function shapeFromParts(parts: readonly InlinePart[], leaves = 0): InlineShape {
  const wordyIdx: number[] = [];
  let wordyEls = 0;
  let phrase: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || !hasWords(p)) continue;
    wordyIdx.push(i);
    if (p.kind === "el") {
      wordyEls++;
      if (phrase === undefined) phrase = p.text.replace(/\s+/g, " ").trim().slice(0, 60);
    }
  }
  const firstWordy = wordyIdx[0];
  const lastWordy = wordyIdx[wordyIdx.length - 1];
  let leading = false;
  let trailing = false;
  parts.forEach((p, i) => {
    if (p.kind !== "el" || hasWords(p)) return;
    if (firstWordy === undefined) return;
    if (i < firstWordy) leading = true;
    if (lastWordy !== undefined && i > lastWordy) trailing = true;
  });
  const split = wordyEls > SPLIT_TEXT_CHILDREN || leaves > SPLIT_TEXT_CHILDREN;
  return {
    icons: leading && trailing ? "both" : leading ? "leading" : trailing ? "trailing" : "none",
    emphasis: split ? 0 : wordyEls,
    ...(phrase && !split ? { emphasis_phrase: phrase } : {}),
    split,
    animated_text: false,
  };
}

/** The element's child nodes as parts: direct text nodes and child elements. */
export function partsOf(el: Element): InlinePart[] {
  const out: InlinePart[] = [];
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) out.push({ kind: "text", text: n.nodeValue ?? "" });
    else if (n.nodeType === 1) {
      const e = n as Element;
      if (isMeasuringCopy(e.getAttribute("style"), e.hasAttribute("hidden"))) continue;
      out.push({ kind: "el", tag: e.tagName.toLowerCase(), text: e.textContent ?? "" });
    }
  }
  return out;
}

export function readInlineShape(el: Element): InlineShape {
  const tree = treeOf(el);
  const shape = shapeFromParts(partsOf(el), wordyLeafCount(tree));
  const lines = lineSet(tree);
  return lines ? { ...shape, split: true, lines: lines.length } : shape;
}

/** A child element that carries words a reader sees. */
export function elementHasWords(el: Element): boolean {
  return hasWords({ kind: "el", tag: el.tagName.toLowerCase(), text: el.textContent ?? "" });
}

/** Short line for the picker panel, from the shape. */
export function shortShapeLine(s: InlineShape | undefined): string {
  if (!s) return "";
  if (s.lines) return "cut into lines, kept";
  if (s.template) return s.letters ? "animated letter by letter, kept" : "built word by word, kept";
  if (s.animated_text) return "changes by itself, left alone";
  if (s.split) return "animated letter by letter";
  const bits: string[] = [];
  if (s.icons !== "none") bits.push("keeps the icon");
  if (s.emphasis >= 1) bits.push("keeps the emphasised phrase");
  return bits.join(", ");
}
