/**
 * The boot (docs/specs/faster-tag.md step 4, C): what a customer's tag
 * `/s/{id}.js` runs, after the edge's `window.__rw=...;` line. It hides
 * this page's parts, starts the reveal cap and asks `/select` (start.ts),
 * then inserts the shared core, `/s/_core/{hash}.js` of the build it was
 * made with, which takes the pass over (index.ts, core.ts).
 *
 * The core comes in parallel with `/select`, on the same host and
 * connection, with the page's nonce, and at high priority: the parts stay
 * hidden until both are here. It is immutable for a year, so a visit's
 * later pages run it from the cache.
 *
 * When the core cannot come, the page shows as built at once, never after
 * the cap: a policy or a blocker refused it (`error`); the handoff comes
 * off the element then too. A Trusted Types
 * policy that refuses its address (setting `src` throws) is known before
 * anything is hidden: nothing is hidden or asked then. Nothing is sent in
 * either case, as with a blocked tag.
 *
 * The two-part tag (faster-tag.md step 6, pre.ts): when the site pasted a
 * style that hides the parts and loads this file `async`, the boot takes the
 * parts over from it and disables it, in the same task, on every way out.
 */

import { withNonce } from "./nonce.ts";
import { scrubOperator } from "./pick-loader.ts";
import { preDone, preLate } from "./pre.ts";
import { RESERVE_ID, dropReserve } from "./reserve.ts";
import { type Op, PROTOCOL, type Page, show, startBoot } from "./start.ts";

/** The core's build hash, set by build.ts: the boot loads exactly the core it was made with. */
declare const __CORE_VERSION__: string | undefined;
const CORE_VERSION = typeof __CORE_VERSION__ === "string" ? __CORE_VERSION__ : "dev";

/**
 * The core, from this boot's build, with its handoff: the load's `Page`, or
 * in pick or capture mode (operator only) the token, which the boot has
 * taken out of the address before this (`Op`; the core loads the operator
 * module, index.ts, so none of the operator code rides in the visitor's
 * boot). False when the address is refused at once (Trusted Types): then
 * the boot hides nothing.
 *
 * Sent with no Referer: the core is the same file for every site, so the
 * customer's page address has no business on that request.
 */
function core(edge: string, h: Page | Op): boolean {
  const s = withNonce(document.createElement("script")) as HTMLScriptElement & {
    __rwh?: Page | Op;
  };
  s.__rwh = h;
  // A blocker or a policy that refuses the core: the handoff comes off the
  // element (it holds the visit marker or a token), and the page shows as
  // built, at once (the pass is in place by then: the error comes in a
  // later task).
  s.onerror = () => {
    s.__rwh = undefined;
    const first = (h as Page).first;
    first && show(first);
    // No core, so no row: the choice reserve goes with the hide.
    dropReserve();
  };
  try {
    s.src = `${edge}/s/_core/${CORE_VERSION}.js`;
  } catch {
    return false;
  }
  s.setAttribute("fetchpriority", "high");
  s.setAttribute("referrerpolicy", "no-referrer");
  (document.head ?? document.documentElement).appendChild(s);
  return true;
}

let page: Page | null = null;
try {
  page = startBoot(
    // Pick or capture: the token leaves the address in this task, before the
    // core is inserted (script-first-onboarding.md §3), and rides to the core
    // in memory on its script element.
    (op, e) => core(e, { v: PROTOCOL, cap: scrubOperator(), op, e }),
    // The late-tag rule that knows a pasted style (the two-part tag, pre.ts):
    // set before the load's pass begins, read by it alone.
    (p) => {
      p.late = preLate;
      return core(p.e, p);
    },
  );
} finally {
  // The pasted style goes in this same task, whatever happened above (pre.ts).
  preDone();
  // The visitor-choice reserve (reserve.ts) stays only for an answer that
  // asks the question (the core draws the row into it); the holdout (the
  // page as built, the tab marked as asked), a failed ask, an answer without
  // it, or a page the boot leaves alone (pick, capture, the measuring frame,
  // a refused core) removes it now.
  // The arm holds for the visit, so a holdout tab is marked as asked: its
  // later loads neither reserve nor shift. Storage cannot throw here: the
  // customer's script reserved only after reading it.
  page
    ? page.first.answer?.then((r) => {
        if (r.q) return;
        if (r.source === "holdout" && document.getElementById(RESERVE_ID))
          sessionStorage.setItem("__rw_q", "1");
        dropReserve();
      }, dropReserve)
    : dropReserve();
}
