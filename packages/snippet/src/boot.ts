/**
 * Anti-flicker synchronous style injection (quiet swap, docs/specs/quiet-swap.md).
 *
 * INVARIANT: this function must be called as the very first DOM mutation
 * after the snippet script tag is evaluated. The script tag is placed first
 * in <head> and loaded without async, so it runs before the browser paints
 * any body content: the elements Rawuser will rewrite are hidden before
 * they are first rendered.
 *
 * Why visibility:hidden and not display:none?
 * - display:none collapses the element's box entirely, causing layout shift
 *   (CLS) when the element is revealed. visibility:hidden preserves the box
 *   geometry, so the page layout stays stable. CLS = 0 is achievable.
 *
 * What is hidden:
 * - [data-rawuser] elements (the manual override path), and
 * - the customer's own selectors for the current page, shipped inside the
 *   per-customer script (`/s/{customer}.js`) from the confirmed manifest.
 *   Each selector is inserted as its own rule inside try/catch, so one
 *   invalid selector never breaks the others.
 *
 * Safety without JavaScript: every per-customer rule carries a 0-second
 * animation that flips visibility back after 4000 ms. If the script dies
 * mid-way, the page shows itself anyway. The JS reveal (on apply, the
 * 1500 ms safety timer, or the hydration wait in index.ts) normally lands
 * first; the CSS number only has to outlast the longest JS hold.
 *
 * The hide holds against the page's own CSS (the pilot's site, 2026-10-12: the
 * original label painted for up to 302 ms in 11 of 12 loads):
 * - `visibility` can be transitioned, and under `transition: all 0.3s` a
 *   part that already had its style when our rule landed (a tag at the foot
 *   of the page, a client-side route) stayed visible for the whole
 *   duration. `settle` cancels those transitions, the part's and its
 *   descendants', and no other: the page's own entrance keeps running.
 * - The animation is `!important` and holds `visibility: hidden` from its
 *   first keyframe through the delay, so neither the page's own animation
 *   on the part, nor a reduced-motion reset of delay and duration, nor an
 *   inline `visibility` a script sets (GSAP autoAlpha) shows the original.
 *   The page's own animation starts, from its start, when the style goes.
 * The first rule's text stays as it is, byte for byte: the policy line a
 * customer with a hash-only CSP pasted carries its sha256.
 */

import { withNonce } from "./nonce.ts";

const REVEAL_MS = 4000;

/** The parts the hide style holds on this page: the tagged ones and the page's own selectors. */
export function hiddenParts(selectors: readonly string[] = []): Element[] {
  // Each part once: a tagged part can match one of the selectors as well.
  const out = new Set<Element>();
  for (const sel of ["[data-rawuser]", ...selectors]) {
    try {
      for (const el of document.querySelectorAll(sel)) out.add(el);
    } catch {
      // A selector this browser refuses matches nothing.
    }
  }
  return [...out];
}

/**
 * The switch of `visibility` lands now, in both directions, whatever the
 * page's own `transition` says. Only the transitions of `visibility` are
 * cancelled, on the parts and under them (a child inherits the value and
 * runs its own transition once the parent's is gone, so it is asked again
 * until none is left). Nothing where the engine has no Web Animations API:
 * the page's own timing stands, as before.
 */
export function settle(parts: readonly Element[]): void {
  try {
    for (let pass = 0, found = true; found && pass < 9; pass++) {
      found = false;
      for (const el of parts) {
        for (const a of el.getAnimations?.({ subtree: true }) ?? []) {
          if ((a as CSSTransition).transitionProperty === "visibility") {
            a.cancel();
            found = true;
          }
        }
      }
    }
  } catch {
    // An engine that refuses: the page's own timing stands.
  }
}

/** How long a part we held takes to appear when its block's entrance is over. */
const EASE_MS = 180;

/**
 * An entrance on a parent that ended while its parts were hidden (A12).
 * The pilot's site, 2026-10-12: `.hero-content` fades in over 1 s; when /select
 * took 943 ms or the cap fired, the fade was over and the headline and
 * the paragraph appeared at once, after the button (not hidden) had faded
 * in with the block.
 *
 * The block's own animation is not started again: that would fade out and
 * in everything in the block the visitor has already watched come in, for
 * the sake of our parts. And once it has ended without a fill it is no
 * longer in the page's animations, so its keyframes cannot be played on
 * our parts either. So a part we held comes in with a short fade of its
 * own, from 0 to its own opacity, and nothing else of the page moves.
 *
 * Only for a part whose own entrance was not started again (that one comes
 * in as the page wrote it), only under a parent whose CSS animation is
 * over (one still running carries the part with it), and never when the
 * visitor asked for less motion. Nothing where the engine cannot say.
 */
export function easeIn(parts: readonly Element[]): void {
  try {
    if (matchMedia("(prefers-reduced-motion:reduce)").matches) return;
    for (const el of parts) {
      if (el.getAnimations({ subtree: true }).length) continue;
      for (let a = el.parentElement; a; a = a.parentElement) {
        if (
          getComputedStyle(a).animationName !== "none" &&
          !a.getAnimations().some((x) => x.playState === "running")
        ) {
          el.animate([{ opacity: 0, offset: 0 }], EASE_MS);
          break;
        }
      }
    }
  } catch {
    // An engine that cannot say: the parts appear as before.
  }
}

export function injectHideStyle(selectors: readonly string[] = []): HTMLStyleElement {
  // The page's CSP nonce, as a property, before the element goes in (E1).
  const style = withNonce(document.createElement("style"));
  style.id = "__rawuser-hide";
  // React 19 hydrates a whole-document app's <head> by position and skips a
  // node whose tag it does not expect, but a <style> it does: our style,
  // right after our tag, was taken for the page's own JSX <style> after the
  // tag, its text compared and React threw #418 and rendered the page again
  // (a Next 15 and 16 lab app, 2026-10-26, every written load). React skips
  // a <style> that carries data-precedence (its own hoisted styles).
  style.dataset.precedence = "rawuser";
  style.textContent = "[data-rawuser]{visibility:hidden!important}";
  document.head.appendChild(style);
  const sheet = style.sheet;
  if (sheet && selectors.length > 0) {
    try {
      sheet.insertRule(
        "@keyframes __rwr{from{visibility:hidden}to{visibility:visible}}",
        sheet.cssRules.length,
      );
    } catch {
      return style;
    }
    for (const sel of selectors) {
      try {
        sheet.insertRule(
          `${sel}{visibility:hidden;animation:__rwr 0s ${REVEAL_MS}ms both!important}`,
          sheet.cssRules.length,
        );
      } catch {
        // Invalid selector for this engine: skip it, the rest still apply.
      }
    }
  }
  // Parts already in the page had their style before our rules: hidden now,
  // not after their own transition. In the head there is nothing to ask.
  if (document.body) settle(hiddenParts(selectors));
  // The animation above is ours until the style goes, so if the script
  // dies mid-way the style still goes: the page's own animation of a part
  // (a fade from `opacity: 0`) then runs as the page wrote it.
  setTimeout(() => style.remove(), REVEAL_MS);
  return style;
}
