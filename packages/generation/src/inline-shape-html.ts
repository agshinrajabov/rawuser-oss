/**
 * The inline shape of every manifest slot, read from the captured HTML with
 * node-html-parser (docs/specs/design-preserving-rewrite.md §2). The
 * animated-text flag cannot be read from static HTML; the picker sets it
 * in the operator's browser.
 */

import type { InlinePart, InlineShape, Manifest } from "@rawuser/shared";
import { shapeFromParts } from "@rawuser/shared/inline-shape";
import {
  type TplNode,
  isMeasuringCopy,
  lineSet,
  readTemplate,
  templateText,
  wordyLeafCount,
} from "@rawuser/shared/template";
import { type Node, NodeType, type HTMLElement as ParsedElement, parse } from "node-html-parser";

function partsOf(el: ParsedElement): InlinePart[] {
  const out: InlinePart[] = [];
  for (const n of el.childNodes as Node[]) {
    if (n.nodeType === NodeType.TEXT_NODE) out.push({ kind: "text", text: n.text });
    else if (n.nodeType === NodeType.ELEMENT_NODE) {
      const e = n as ParsedElement;
      if (isMeasuringCopy(e.getAttribute("style") ?? null, e.hasAttribute("hidden"))) continue;
      out.push({ kind: "el", tag: e.rawTagName?.toLowerCase() ?? "", text: e.text });
    }
  }
  return out;
}

/** The element's children as a light tree, the way the DOM side builds it. */
function treeOf(el: ParsedElement): TplNode[] {
  const out: TplNode[] = [];
  for (const n of el.childNodes as Node[]) {
    if (n.nodeType === NodeType.TEXT_NODE) out.push({ kind: "text", text: n.text });
    else if (n.nodeType === NodeType.ELEMENT_NODE) {
      const e = n as ParsedElement;
      if (isMeasuringCopy(e.getAttribute("style") ?? null, e.hasAttribute("hidden"))) continue;
      out.push({
        kind: "el",
        tag: e.rawTagName?.toLowerCase() ?? "",
        classes: (e.getAttribute("class") ?? "").split(/\s+/).filter(Boolean),
        children: treeOf(e),
        style: e.getAttribute("style") ?? "",
      });
    }
  }
  return out;
}

/**
 * The inline shape, with the template when the element is built word by word
 * (docs/specs/template-writing.md §4.1).
 */
function shapeOf(el: ParsedElement) {
  const tree = treeOf(el);
  const shape = shapeFromParts(partsOf(el), wordyLeafCount(tree));
  // Lines first: their words are poured into the page's lines, no template.
  const lines = lineSet(tree);
  if (lines) return { ...shape, split: true, lines: lines.length };
  if (!shape.split) return shape;
  const tpl = readTemplate(tree);
  if (!tpl) return shape;
  return { ...shape, template: tpl.template, ...(tpl.letters ? { letters: true } : {}) };
}

/**
 * The words a reader sees in the element. For a template, the page's words
 * with the rotating slot's longest alternative: textContent would count every
 * alternative (the lab page reads "…they can readcomparebuyskip.").
 */
function visibleText(el: ParsedElement): string {
  const shape = shapeOf(el);
  if (shape.template) return templateText(shape.template).replace(/\n/g, " ");
  // Without the page's hidden measuring copy (the zoo's lines-fit counted
  // 82 characters for a 43-character headline, and its versions were
  // written near 74: the page shrank its font 37% to fit them, 2026-09-29),
  // and with a space between lines.
  const tree = treeOf(el);
  const flat = (n: TplNode): string => (n.kind === "text" ? n.text : n.children.map(flat).join(""));
  const lines = lineSet(tree);
  const text = lines ? lines.map(flat).join(" ") : tree.map(flat).join("");
  return text.replace(/\s+/g, " ").trim();
}

/** One element per manifest entry, where one selector matches exactly one element. */
function resolveOne(root: ReturnType<typeof parse>, css: readonly string[]): ParsedElement | null {
  for (const selector of css) {
    try {
      const matches = root.querySelectorAll(selector);
      if (matches.length === 1) return matches[0] ?? null;
    } catch {
      // unsupported selector: try the next
    }
  }
  return null;
}

/**
 * The manifest's lengths and text signature refreshed from the live page
 * (2026-09-15): a pilot site was rebuilt after its read, the /az hero
 * paragraph went from 305 to 255 characters, and a version at 109% of the
 * stored length was 131% of what visitors saw and took a line more at
 * every width. Returns the manifest and whether anything changed.
 */
export function refreshLengths(
  html: string,
  manifest: Manifest,
): { manifest: Manifest; changed: string[] } {
  let root: ReturnType<typeof parse>;
  try {
    root = parse(html);
  } catch {
    return { manifest, changed: [] };
  }
  const out: Manifest = {};
  const changed: string[] = [];
  for (const [path, entry] of Object.entries(manifest)) {
    const el = resolveOne(root, entry.css);
    const text = el ? visibleText(el) : "";
    if (!el || text.length === 0) {
      out[path] = entry;
      continue;
    }
    const sig = text.slice(0, 40);
    const words = text.split(" ").filter(Boolean).length;
    if (
      entry.original_char_length === text.length &&
      entry.original_word_count === words &&
      entry.text[0] === sig
    ) {
      out[path] = entry;
      continue;
    }
    out[path] = {
      ...entry,
      original_char_length: text.length,
      original_word_count: words,
      text: [sig, ...entry.text.filter((t) => t !== sig)].slice(0, 3),
    };
    changed.push(path);
  }
  return { manifest: out, changed };
}

/**
 * What only the picker sees survives a read of the server HTML: text that
 * changes by itself, and lines a script cut after the page loaded (the
 * zoo's GSAP SplitText; the server HTML holds one plain headline).
 */
function withPickerFacts(shape: InlineShape, picked: InlineShape | undefined): InlineShape {
  const out: InlineShape = { ...shape, animated_text: picked?.animated_text ?? false };
  // Text that changes by itself without a rotating slot we can read is a
  // framework's own state (Framer's rotating letters): no template.
  if (out.animated_text && out.template && !out.template.includes("{rot:")) {
    // biome-ignore lint/performance/noDelete: the stored shape must not carry the key at all
    delete out.template;
    // biome-ignore lint/performance/noDelete: the stored shape must not carry the key at all
    delete out.letters;
  }
  if (picked?.lines && !out.lines && !out.template) {
    out.lines = picked.lines;
    out.split = true;
  }
  return out;
}

/** Returns the manifest with `inline` filled where one selector matches exactly one element. */
export function attachInlineShapes(html: string, manifest: Manifest): Manifest {
  let root: ReturnType<typeof parse>;
  try {
    root = parse(html);
  } catch {
    return manifest;
  }
  const out: Manifest = {};
  for (const [path, entry] of Object.entries(manifest)) {
    const el = resolveOne(root, entry.css);
    // The picker's "changes by itself" cannot be read from static HTML: kept.
    out[path] = el
      ? {
          ...entry,
          inline: withPickerFacts(shapeOf(el), entry.inline),
        }
      : entry;
  }
  return out;
}

/** The original hero words with the emphasised phrase marked, for the Look screen. */
export function markEmphasis(text: string | null, phrase: string | undefined): string | null {
  if (!text || !phrase) return text;
  const i = text.indexOf(phrase);
  if (i < 0) return text;
  return `${text.slice(0, i)}*${phrase}*${text.slice(i + phrase.length)}`;
}
