/**
 * A tag that runs after the page appeared (docs/specs/install-friction.md,
 * D; privacy review ruling 2026-10-03, condition 4).
 *
 * Decided from presence only, never from a time: `async` or `defer` on our
 * own script, `document.readyState` past "loading", or a paint entry that
 * already exists; and a part this page rewrites is already in the DOM, so
 * the visitor may have seen it. A tag first in head (or a sync tag at the
 * top of the body, above the parts, as on Webflow's free plan) is never
 * late: the parts are parsed after our hide rules are in.
 *
 * On a late tag the page stays as built for that load: nothing hidden,
 * nothing written (docs/specs/late-tag.md, the founder's yes of 2026-10-12;
 * until then the words were swapped in place, in view). The edge is still
 * asked and the tab keeps the carry and the copy for the visit's next pages.
 * The load reports `late_tag` once, with no slot and no number, and its
 * exposure carries the bit `lp`, which is this function's result and nothing
 * else (privacy review, 2026-10-12, Q2 condition 1).
 */

export function tagIsLate(s: HTMLScriptElement | null, selectors: readonly string[]): boolean {
  let painted = false;
  try {
    painted = performance.getEntriesByType("paint").length > 0;
  } catch {
    // no paint timing here: the other two facts decide
  }
  if (!(s?.async || s?.defer || document.readyState !== "loading" || painted)) return false;
  for (const sel of ["[data-rawuser]", ...selectors]) {
    try {
      if (document.querySelector(sel)) return true;
    } catch {
      // a selector this browser refuses matches nothing
    }
  }
  return false;
}
