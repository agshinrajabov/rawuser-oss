/**
 * The two-part tag (docs/specs/faster-tag.md step 6): the site pastes a
 * `<style data-rawuser-pre>` that hides the parts from the first paint, then
 * our tag with `async`. The page paints at once; only the parts wait for us.
 * The style's text comes from the dashboard (`preHideStyle`, @rawuser/shared):
 * the confirmed pages' hide rules, each with its own CSS backstop
 * (`PRE_REVEAL_MS`), so a script that never comes shows the page anyway.
 *
 * The boot's file only (entry-boot.ts): the single file (`/snippet.js`, the
 * generic tag, which never gets a paste) keeps the late-tag rule as it was,
 * so an async tag there is late and its page stays as built. Every
 * per-customer script is the boot (step 6, E1).
 *
 * Nothing here is stored or sent. What is read: whether such a style is in
 * the page, whether it comes before each part, and whether each part is
 * hidden now. The answer is the `tagIsLate` boolean, as before (`lp`).
 */

import { hiddenParts } from "./boot.ts";
import { tagIsLate } from "./late-tag.ts";

const PRE = "style[data-rawuser-pre]";

/**
 * The late-tag rule with the pasted style (late-tag.md). An async tag runs
 * after the page may have painted; a part already in the DOM was not seen
 * when the pasted style comes before it in the document and holds it hidden
 * now (its backstop has not shown it yet). Every part in the DOM must pass,
 * or the page stays as built for this load, as for any late tag: a part the
 * style does not cover (a stale paste), a style pasted below the parts, one
 * a policy refused (no sheet, so nothing hidden), or a script that came
 * after the backstop. Parts not in the DOM yet are hidden by our own rules
 * before they are parsed. Without the style: `tagIsLate`, unchanged.
 */
export function preLate(s: HTMLScriptElement | null, selectors: readonly string[]): boolean {
  const pre = document.querySelector(PRE);
  return (
    tagIsLate(s, selectors) &&
    (!pre ||
      hiddenParts(selectors).some(
        (el) =>
          !(pre.compareDocumentPosition(el) & 4) || getComputedStyle(el).visibility !== "hidden",
      ))
  );
}

/**
 * The pasted style has done its part. Called by the boot when it is through,
 * in the same task as the pass's own hide style went in, so no frame is
 * painted between the two: what this pass writes stays hidden under our
 * rules, anything else the paste hid shows now. On every way out: nothing to
 * do, a deleted customer, an audit off its host or past its end, pick or
 * capture, the core refused, a page left as built, an error.
 *
 * Disabled, never removed: on a React site the style is the site's own node
 * in a head React hydrates, and a node gone from it is a hydration error.
 */
export function preDone(): void {
  for (const s of document.querySelectorAll<HTMLStyleElement>(PRE)) s.disabled = true;
}
