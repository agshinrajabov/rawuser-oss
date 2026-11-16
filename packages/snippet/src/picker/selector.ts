/**
 * Selector generation for the picker (docs/specs/visual-picker.md §2).
 *
 * Produces what the AI detector produces from HTML, computed in the real
 * DOM instead: up to three CSS selectors that each match exactly one
 * element, a short text signature, a human structural description and the
 * length fields generation uses. Pure functions over a Document so they
 * run under jsdom in tests.
 */

import { readInlineShape } from "../shape.ts";
import { readElementTemplate } from "../template.ts";
import type { ManifestEntry } from "../types.ts";
import type { WrapMetrics } from "./metrics.ts";

export interface PickedEntry extends ManifestEntry {
  original_char_length: number;
  original_word_count: number;
  conversion_candidate: boolean;
  /** How the page wraps it at three widths (headlines; picker/metrics.ts). */
  metrics?: WrapMetrics;
}

const TEXT_SIGNATURE_CHARS = 40;
const MAX_PATH_STEPS = 4;
const STABLE_ANCESTORS = new Set([
  "main",
  "header",
  "footer",
  "nav",
  "section",
  "article",
  "aside",
  "form",
]);

/** Classes that survive a redeploy: human words, no hash tail, no utility syntax. */
export function isStableClass(name: string): boolean {
  if (name.length < 3 || name.length > 40) return false;
  if (/[:[\]/!@#%&*()=+~,.]/.test(name)) return false; // tailwind variants, arbitrary values
  if (/^(css|sc|jsx|emotion|chakra|mui|Mui|svelte|astro|_)-?/.test(name)) return false;
  if (/^[a-z]{1,2}$/i.test(name)) return false;
  if (/[0-9a-f]{5,}$/i.test(name) && /[0-9]/.test(name)) return false; // hash tails
  if (/__[A-Za-z0-9]{4,}$/.test(name)) return false; // CSS modules: Hero_title__a8f3k
  if (/^[A-Za-z]+_[A-Za-z0-9]{4,}$/.test(name) && /[0-9]/.test(name)) return false; // module hashes
  if (/^-?[a-z]+-[0-9]+$/.test(name)) return false; // p-4, mt-12, gap-2
  if (
    /^(w|h|p|m|px|py|mx|my|pt|pb|pl|pr|mt|mb|ml|mr|gap|text|bg|border|rounded|flex|grid|items|justify|font|leading|tracking|shadow|opacity|z|top|left|right|bottom|inset|max|min|space|col|row|order|translate|scale|rotate|duration|ease|transition|overflow|object|place|self|content|ring|outline|fill|stroke|cursor|select|pointer|whitespace|break|truncate|hidden|block|inline|relative|absolute|fixed|sticky|static|sr|not|group|peer|container|prose|dark|light|hover|focus|active|lg|md|sm|xl|xs)(-|$)/.test(
      name,
    )
  ) {
    return false;
  }
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(name);
}

function isStableId(id: string): boolean {
  if (!id || id.length > 60) return false;
  if (/^[0-9]/.test(id)) return false;
  if (/^(radix|headlessui|react-aria|mui|:r)/i.test(id)) return false;
  if (/[0-9a-f]{6,}/i.test(id) && /[0-9]/.test(id)) return false;
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);
}

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape
    ? CSS.escape(s)
    : s.replace(/([^A-Za-z0-9_-])/g, "\\$1");
}

function unique(doc: Document, selector: string, el: Element): boolean {
  try {
    const matches = doc.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === el;
  } catch {
    return false;
  }
}

function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

function stableClasses(el: Element): string[] {
  return Array.from(el.classList).filter(isStableClass).slice(0, 3);
}

function nthOfType(el: Element): number {
  let n = 1;
  let sib = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === el.tagName) n++;
    sib = sib.previousElementSibling;
  }
  return n;
}

/** A short unique path from the nearest stable ancestor down to the element. */
function pathSelector(doc: Document, el: Element): string | null {
  const steps: string[] = [];
  let cur: Element | null = el;
  let anchor = "";
  for (
    let i = 0;
    i < MAX_PATH_STEPS && cur && cur !== doc.body && cur !== doc.documentElement;
    i++
  ) {
    const parent: Element | null = cur.parentElement;
    if (parent && parent !== doc.body) {
      const pid = parent.getAttribute("id");
      if (pid && isStableId(pid)) {
        anchor = `#${cssEscape(pid)}`;
        steps.unshift(`${tagOf(cur)}:nth-of-type(${nthOfType(cur)})`);
        break;
      }
    }
    const tag = tagOf(cur);
    const classes = stableClasses(cur);
    const step =
      classes.length > 0
        ? `${tag}.${classes.map(cssEscape).join(".")}`
        : `${tag}:nth-of-type(${nthOfType(cur)})`;
    steps.unshift(step);
    if (STABLE_ANCESTORS.has(tag)) {
      // A landmark is a good enough root; stop climbing.
      break;
    }
    cur = parent;
  }
  const candidates = [anchor ? `${anchor} > ${steps.join(" > ")}` : steps.join(" > ")];
  if (!anchor) candidates.push(`body > ${steps.join(" > ")}`);
  for (const c of candidates) {
    if (unique(doc, c, el)) return c;
  }
  return null;
}

/** Up to three selectors, each unique in the document, best first. */
/** Two texts with the same words, spacing and case aside. */
function sameWords(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) !== "" && norm(a) === norm(b);
}

export function cssCandidates(doc: Document, el: Element): string[] {
  const out: string[] = [];
  const push = (s: string | null) => {
    if (s && out.indexOf(s) === -1 && unique(doc, s, el)) out.push(s);
  };
  const id = el.getAttribute("id");
  if (id && isStableId(id)) push(`#${cssEscape(id)}`);
  for (const attr of [
    "data-rawuser",
    "data-testid",
    "data-test",
    "data-cy",
    "aria-label",
    "name",
  ]) {
    const v = el.getAttribute(attr);
    // A label that repeats the element's own words is the words, not a
    // handle: a split library copies the text there after load (GSAP
    // SplitText on the Webflow test page, 2026-09-29) and our writer
    // rewrites it, so the selector matched neither before nor after.
    if (attr === "aria-label" && v && sameWords(v, el.textContent ?? "")) continue;
    if (v && v.length <= 80) push(`${tagOf(el)}[${attr}="${v.replace(/"/g, '\\"')}"]`);
  }
  const classes = stableClasses(el);
  if (classes.length > 0) {
    push(`${tagOf(el)}.${classes.map(cssEscape).join(".")}`);
    const parent = el.parentElement;
    if (parent) {
      const pc = stableClasses(parent);
      if (pc.length > 0)
        push(`.${pc.map(cssEscape).join(".")} ${tagOf(el)}.${classes.map(cssEscape).join(".")}`);
    }
  }
  if (out.length < 3) push(pathSelector(doc, el));
  return out.slice(0, 3);
}

export function visibleText(el: Element): string {
  const raw = (el as HTMLElement).innerText ?? el.textContent ?? "";
  return raw.replace(/\s+/g, " ").trim();
}

/** First 40 characters, cut at a word boundary so the signature never ends mid-word. */
export function textSignature(el: Element): string[] {
  return signatureOf(visibleText(el));
}

function signatureOf(t: string): string[] {
  if (t.length === 0) return [];
  if (t.length <= TEXT_SIGNATURE_CHARS) return [t];
  const head = t.slice(0, TEXT_SIGNATURE_CHARS + 1);
  const cut = head.lastIndexOf(" ");
  return [cut >= 12 ? head.slice(0, cut) : t.slice(0, TEXT_SIGNATURE_CHARS)];
}

/** "first h1 in main", "2nd button in section 3", in the finder's vocabulary. */
export function structuralDescription(doc: Document, el: Element): string {
  const tag = tagOf(el);
  let scope: Element | null = el.parentElement;
  while (scope && !STABLE_ANCESTORS.has(tagOf(scope)) && scope !== doc.body)
    scope = scope.parentElement;
  const scopeTag = scope && scope !== doc.body ? tagOf(scope) : "body";
  const scopeEl = scope && scope !== doc.body ? scope : doc.body;
  const sameTag = Array.from(scopeEl.querySelectorAll(tag));
  const index = sameTag.indexOf(el);
  if (index === 0) return `first ${tag} in ${scopeTag}`;
  const ord = index === 1 ? "2nd" : index === 2 ? "3rd" : `${index + 1}th`;
  return `${ord} ${tag} in ${scopeTag}`;
}

export function describeElement(
  doc: Document,
  el: Element,
  conversion: boolean,
  animated = false,
): PickedEntry {
  const text = visibleText(el);
  const inline = readInlineShape(el);
  inline.animated_text = animated;
  if (inline.split && !inline.lines) {
    const tpl = readElementTemplate(el);
    // Text that changes by itself is written only through a rotating slot we
    // can see; a framework that swaps the word in its own state (Framer's
    // rotating letters, optivio) keeps its words.
    if (tpl && !(animated && !tpl.rotator)) {
      inline.template = tpl.template;
      if (tpl.letters) inline.letters = true;
    }
  }
  return {
    css: cssCandidates(doc, el),
    text: textSignature(el),
    structural: structuralDescription(doc, el),
    original_char_length: text.length,
    original_word_count: text.length === 0 ? 0 : text.split(" ").length,
    conversion_candidate: conversion,
    inline,
  };
}

// ---------------------------------------------------------------------------
// Count-only pick (docs/specs/visual-picker.md §9)
// ---------------------------------------------------------------------------

/** What a visitor presses: links, buttons, submit inputs, ARIA buttons. */
const CLICKABLE =
  "a[href],button,input[type=submit],input[type=button],input[type=image],[role=button],[role=link],summary";

/**
 * The element a click on `el` presses: the nearest clickable ancestor (a
 * click on the icon inside a link counts the link), else `el` itself. The
 * snippet counts with `closest(selector)`, so the selector must name it.
 */
export function clickTarget(el: Element): Element {
  return el.closest(CLICKABLE) ?? el;
}

export function isClickable(el: Element): boolean {
  return el.matches(CLICKABLE);
}

/** The button to count as it is sent: selectors and a 40-character signature, nothing else. */
export interface PickedButton {
  css: string[];
  text: string[];
  structural: string;
}

/**
 * The words that name a button. A submit input's words are its `value`
 * (its label); no other input's value is ever read, so nothing a person
 * typed can leave the page.
 */
function buttonWords(el: Element): string {
  const own = visibleText(el);
  if (own) return own;
  if (el.tagName === "INPUT" && /^(submit|button|image)$/i.test(el.getAttribute("type") ?? "")) {
    const v = (el as HTMLInputElement).value || el.getAttribute("alt") || "";
    if (v.trim()) return v.replace(/\s+/g, " ").trim();
  }
  return (el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim();
}

export function describeButton(doc: Document, el: Element): PickedButton {
  return {
    css: cssCandidates(doc, el),
    text: signatureOf(buttonWords(el)),
    structural: structuralDescription(doc, el),
  };
}

// Mirrored from @rawuser/shared pick.ts (the picker has no runtime import
// from shared); test/picker-count.test.ts pins the two together (§9.8).
export const COUNT_REFUSALS = {
  notButton: "Pick a link or a button.",
  account: "This button shows something about one account. Pick a button every visitor sees.",
  path: "This address belongs to one account. Pick the button on a page every visitor sees.",
} as const;

const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const DIGIT_RUN = /\d{6,}/;
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** An email shape or six or more digits in a row: something about one account. */
export function holdsAccountDetail(s: string): boolean {
  return EMAIL_SHAPE.test(s) || DIGIT_RUN.test(s);
}

/**
 * A path segment with an `@`, all digits, a long number, a UUID or a
 * token-like run (letters and digits, or upper and lower case).
 */
export function pathHoldsIdentifier(path: string): boolean {
  for (const raw of path.split("/")) {
    let seg = raw;
    try {
      seg = decodeURIComponent(raw);
    } catch {}
    if (seg.includes("@") || /^\d+$/.test(seg) || DIGIT_RUN.test(seg) || UUID_SHAPE.test(seg))
      return true;
    for (const run of seg.match(/[A-Za-z0-9_-]{20,}/g) ?? []) {
      if (/[A-Za-z]/.test(run) && /[0-9]/.test(run)) return true;
      if (/[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
    }
  }
  return false;
}
