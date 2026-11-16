/**
 * The early write of the body carry (docs/specs/interactive-text.md §3.1 b):
 * the tab's carried copy is written as the page parses, before the page's
 * own split and animation scripts read the text, and the edge's answer then
 * decides whether it stays.
 */

import { allTargetElements, applyVariant, measureHeight, resume } from "./apply.ts";
import type { CarriedBody } from "./body-carry.ts";
import { isReactSite } from "./hydration.ts";
import { noteError } from "./issues.ts";
import { rich } from "./rich-api.ts";
import { findTargets } from "./targets.ts";
import type { SelectResponse, VariantBody } from "./types.ts";

export interface Early {
  readonly applied: boolean;
  /** Turned off before writing anything (a page React will hydrate). */
  readonly off: boolean;
  /**
   * The carried sections and the parts they were written into, to tell the
   * edge's answer from the tab's copy (prompt_hash can be empty). The parts
   * count: with the same words and another manifest the edge's answer names
   * a part the tab's copy never wrote (the pilot's site, 2026-10-12: the button
   * stayed as built on a return to the home page, and the load still
   * reported the version as shown).
   */
  sig: string;
  /**
   * The edge confirmed the copy: fit whatever is not fitted yet, as a first
   * page does (the pilot's site, A6: a part left at its first length went from two
   * lines to one at 1280, from three to two at 390). Only parts still
   * exactly as written. Since A10 the fit normally ran already, behind the
   * hide, as soon as the page's stylesheets were in.
   */
  fit: () => void;
  /** Put the parts back in place as the page built them, before another copy is written. */
  undo: () => void;
  revert: () => void;
  stop: () => void;
}

/**
 * Write the tab's carried copy as the page parses, before the page's own
 * split and animation scripts read the text (docs/specs/interactive-text.md
 * §3.1). Snapshots the elements first so the edge can still say no.
 *
 * The lengths are fitted here too, behind the hide, as soon as a box can be
 * trusted: at the write when every stylesheet the page links is in (a tag
 * at the foot of the page, or a return with the CSS already there), else
 * when the last of them loads, which is also what the browser's first paint
 * waits for. Until 2026-10-12 the fit waited for the edge's answer, after
 * the first paint: on the pilot's site at 390 the hidden headline and paragraph
 * grew 70 px at the reveal and the button under them moved 34 px (A10).
 * The edge's answer still decides whether the copy stays. A part built word
 * by word keeps its rotation reserve for the edge's confirm, as before.
 */

/**
 * Every stylesheet the page links for this screen is in, so a box measured
 * now is the page's own. A sheet for another medium (`media="print"`, the
 * usual way to load one late) is not waited for.
 */
function styled(): boolean {
  try {
    return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')).every(
      (l) => l.sheet || !matchMedia(l.media || "all").matches,
    );
  } catch {
    // No answer here: the edge's confirm fits, as before.
    return false;
  }
}

/**
 * A part only the rich writers can write (built word by word or cut into
 * lines) that the page has already split, while /rich.js is not in yet.
 * Not split yet, the part takes the words as plain text and needs no writer.
 */
function waitsForWriters(targets: CarriedBody["targets"]): boolean {
  if (rich()) return false;
  return Object.entries(targets ?? {}).some(
    ([path, e]) =>
      !e.skip &&
      !e.plain &&
      (!!e.inline?.template || !!e.inline?.lines) &&
      findTargets(path, e).some((el) => Array.from(el.children).some((c) => c.tagName !== "BR")),
  );
}

/** React's server marks, or Framer's generator tag (read before the body has any). */
function reactPage(): boolean {
  try {
    return (
      document.querySelector('meta[name="generator"][content^="Framer"]') !== null || isReactSite()
    );
  } catch {
    return false;
  }
}

export function earlyApply(kept: CarriedBody): Early {
  const variant = { sections: kept.sections } as VariantBody;
  const snapshots = new Map<Element, Node[]>();
  // aria-labels the write may change (the element's own, an enclosing svg's).
  const labels = new Map<Element, string>();
  let done = false;
  let off = false;
  /** Whether a box measured now is the page's own: its stylesheets are in. */
  let live = false;
  /** The edge confirmed the copy: the rotation reserve may be measured. */
  let sure = false;
  const fit = () => {
    live = true;
    resume(true);
  };
  // A stylesheet came in after the write (`load` does not bubble: captured).
  const onLoad = () => {
    if (done && !live && styled()) fit();
  };
  const stop = () => {
    mo.disconnect();
    document.removeEventListener("load", onLoad, true);
  };
  const tryApply = () => {
    if (done || off) return;
    // In the head the body does not exist yet, and the finders read it: wait
    // for it (the zoo check, 2026-09-29: the first try threw and the edge was
    // never asked). A throw here must never stop the visit's flow.
    if (!document.body) return;
    // A page React will hydrate (Framer, Next.js) throws away anything written
    // before it, with a client re-render (#418; salix.framer.website,
    // 2026-09-29: reverted at 1.0 s). The edge's answer writes it after
    // hydration instead, as on a landing.
    if (reactPage()) {
      off = true;
      mo.disconnect();
      return;
    }
    let els: Element[] | null = null;
    try {
      els = allTargetElements(variant, kept.targets);
    } catch {
      return;
    }
    if (!els) return;
    // Nothing written early rather than half a page: without the writers
    // (rich.js still on its way) a split part would stop the write midway.
    // The next mutation tries again; failing that, the edge's answer writes
    // it (2026-09-30, rich writers on demand).
    if (waitsForWriters(kept.targets)) return;
    for (const el of els) {
      if (!snapshots.has(el))
        snapshots.set(
          el,
          Array.from(el.childNodes).map((n) => n.cloneNode(true)),
        );
      for (const h of [el, el.closest?.("svg")]) {
        const label = h?.getAttribute("aria-label");
        if (h && label != null && !labels.has(h)) labels.set(h, label);
      }
    }
    live = styled();
    try {
      if (
        applyVariant(
          variant,
          kept.targets,
          (el) => (live ? measureHeight(el) : 0),
          (el) => (sure ? measureHeight(el) : 0),
        )
      ) {
        done = true;
        mo.disconnect();
      }
    } catch {
      // Leave the page to the edge's answer; the code only, never the error.
      noteError();
    }
  };
  const mo = new MutationObserver(tryApply);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("load", onLoad, true);
  tryApply();
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      tryApply();
      mo.disconnect();
    },
    { once: true },
  );
  return {
    get applied() {
      return done;
    },
    get off() {
      return off;
    },
    sig: JSON.stringify([kept.sections, kept.targets]),
    fit: () => {
      sure = true;
      fit();
    },
    undo: () => resume(false),
    revert: () => {
      // A box the fit held goes first, then the page's own nodes come back.
      resume(false);
      for (const [el, nodes] of snapshots) el.replaceChildren(...nodes);
      for (const [el, label] of labels) el.setAttribute("aria-label", label);
    },
    stop,
  };
}

/**
 * What to do with an early write once the edge answered: keep it when the
 * edge serves the same copy for the same parts, apply the edge's when it
 * serves another, put
 * the page back when the edge serves none (holdout, original, a language
 * mismatch). "none" when nothing was written early.
 */
export function earlyVerdict(
  early: Early | null,
  response: SelectResponse,
): "none" | "keep" | "reapply" | "revert" {
  if (!early?.applied) return "none";
  if (response.cohort !== "personalized" || !response.variant) return "revert";
  return JSON.stringify([response.variant.sections, response.targets]) === early.sig
    ? "keep"
    : "reapply";
}
