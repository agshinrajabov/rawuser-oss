/**
 * The inline shape of an element (docs/specs/design-preserving-rewrite.md §2),
 * computed from its child parts. Pure: the DOM side (snippet, picker) and
 * the HTML side (generation, node-html-parser) each build the parts and
 * call this; a parity test keeps the snippet's private copy identical.
 */

import { parseTemplate } from "./template.ts";
import type { InlineShape } from "./types.ts";

export type InlinePart = { kind: "text"; text: string } | { kind: "el"; tag: string; text: string };

/** Tags that never carry words a reader sees, whatever their text nodes say. */
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

/** More than this many children with words is a split-text animation. */
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

/** Old manifests carry no shape: plain text, nothing to keep. */
export const PLAIN_SHAPE: InlineShape = {
  icons: "none",
  emphasis: 0,
  split: false,
  animated_text: false,
};

/**
 * A part built word by word, in one sentence for the operator
 * (docs/specs/template-writing.md §4.5): no question, versions keep it.
 */
export function templateLine(template: string): string {
  const toks = parseTemplate(template);
  const images = toks.filter((t) => t.t === "glyph").length;
  const lines = toks.filter((t) => t.t === "br").length + 1;
  const rotating = toks.some((t) => t.t === "rot");
  const bits = [
    images === 1 ? "1 image" : images > 1 ? `${images} images` : "",
    lines > 1 ? `${lines} lines` : "",
    rotating ? "a rotating word" : "",
  ].filter(Boolean);
  const withBits =
    bits.length === 0
      ? ""
      : ` with ${bits.length > 1 ? `${bits.slice(0, -1).join(", ")} and ${bits[bits.length - 1]}` : bits[0]}`;
  return `Built word by word${withBits}. Versions keep all of it.`;
}

/**
 * One plain sentence per part for the operator (spec §4). `ask` names the
 * two cases that need a decision.
 */
export function shapeLine(
  inline: InlineShape | undefined,
  skip?: boolean,
  plain?: boolean,
): { text: string; ask?: "split" | "animated" } {
  const s = inline ?? PLAIN_SHAPE;
  if (s.lines && !skip && !plain)
    return {
      text: "Animated line by line. Rawuser writes its words into the same lines and keeps the animation.",
    };
  if (s.template && s.letters && !skip)
    return {
      text: "Animated letter by letter. Rawuser writes its words into the same letters and keeps the animation.",
    };
  if (s.template && !skip) return { text: templateLine(s.template) };
  if (s.animated_text) {
    return {
      text: "This text changes by itself (a typewriter or rotating words). Rawuser leaves it.",
      ask: "animated",
    };
  }
  if (s.split) {
    if (plain)
      return {
        text: "Animated letter by letter. You chose: replace it as plain text, so the letter animation is gone on this part.",
        ask: "split",
      };
    return {
      text: "Animated in a way Rawuser cannot write into yet. Leave it as your page built it, or replace it as plain text.",
      ask: "split",
    };
  }
  if (skip) return { text: "You chose: leave it. Rawuser never touches this part." };
  const bits: string[] = [];
  if (s.icons !== "none") bits.push(s.icons === "both" ? "Keeps both icons" : "Keeps the icon");
  if (s.emphasis === 1)
    bits.push("keeps the emphasised phrase and its decoration; the new text gets one too");
  if (s.emphasis >= 2) bits.push("keeps the first emphasised phrase; the second is left empty");
  if (bits.length === 0) return { text: "Plain text." };
  const line = bits.join(", ");
  return { text: `${line.charAt(0).toUpperCase()}${line.slice(1)}.` };
}
