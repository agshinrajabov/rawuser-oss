/**
 * React hydration (docs/specs/quiet-swap.md §React).
 *
 * On a server-rendered React site (Next.js on a pilot site) the framework
 * hydrates after the page paints. If our text swap lands first, React
 * compares the server text with the DOM, finds our version, throws the
 * recoverable error #418 and renders the whole page again from scratch on
 * the client: every handler is dead until that finishes, entrance
 * animations replay or stall, and the hero flashes (seen live on
 * 2026-09-13: the AZ button did nothing, the hero wrapper stayed at
 * opacity 0). So on a React site the initial-load swap waits for the
 * target to be hydrated. React marks every hydrated element with an own
 * `__reactFiber$…` property; before that the element has none.
 *
 * Nothing here reads anything about the visitor: only whether the page's
 * own framework has finished its work.
 */

const REACT_MARK = "__reactFiber";

/**
 * Does this page look like a server-rendered React app that will hydrate?
 * Framework globals and ids first; then React's own server-render marks,
 * which every React SSR emits whatever the framework: Suspense boundary
 * comments (`<!--$-->`, `<!--$?-->`, `<!--$!-->`) and the one-space comment
 * React puts between adjacent text nodes (`<!-- -->`). A Vite + React
 * Router site (Lovable, 2026-09-14) has none of the ids and every one of
 * the comments; without this check the swap raced hydration and lost one
 * load in four (React #418).
 */
export function isReactSite(win: Window = window, doc: Document = document): boolean {
  const w = win as unknown as Record<string, unknown>;
  if (w.__next_f || w.__NEXT_DATA__ || w.__remixContext || w.__reactRouterContext) return true;
  try {
    // Framer's generator tag sits in the head, so it answers before the body
    // (and its React marks) is parsed (the Framer race of 2026-10-25).
    if (
      doc.querySelector(
        'script[src*="/_next/"], [data-reactroot], #___gatsby, #__next, meta[name="generator"][content^="Framer"]',
      ) !== null
    )
      return true;
    return hasReactComments(doc);
  } catch {
    return false;
  }
}

/** How many comment nodes to look at before giving up; the marks sit near the top. */
const COMMENT_SCAN_LIMIT = 400;

export function hasReactComments(doc: Document): boolean {
  if (typeof doc.createTreeWalker !== "function" || !doc.body) return false;
  const walker = doc.createTreeWalker(doc.body, 128 /* NodeFilter.SHOW_COMMENT */);
  let seen = 0;
  let n = walker.nextNode();
  while (n && seen < COMMENT_SCAN_LIMIT) {
    const v = n.nodeValue ?? "";
    if (v === " " || v === "$" || v === "$?" || v === "$!" || v === "/$") return true;
    seen++;
    n = walker.nextNode();
  }
  return false;
}

/** React's mark on a root container (`createRoot`, `hydrateRoot`; `document` on Next's app router). */
const ROOT_MARK = "__reactContainer";

/** Does this node carry an own property whose name starts with `mark`? */
function hasMark(n: object, mark: string): boolean {
  return Object.keys(n).some((k) => k.startsWith(mark));
}

/** Has React attached its fiber to this element yet? */
export function isHydrated(el: Element): boolean {
  return hasMark(el, REACT_MARK);
}

/**
 * Does `c` sit inside a Suspense or Activity boundary among its siblings?
 * React's server HTML opens one with `<!--$-->`, `<!--$?-->`, `<!--$!-->`
 * or `<!--&-->` and closes it with `<!--/$-->` or `<!--/&-->`.
 */
function inBoundary(c: Node): boolean {
  let depth = 0;
  for (let n = c.previousSibling; n; n = n.previousSibling) {
    if (n.nodeType !== 8) continue;
    const v = n.nodeValue;
    if (v === "/$" || v === "/&") depth++;
    else if (v === "$" || v === "$?" || v === "$!" || v === "&") {
      if (depth === 0) return true;
      depth--;
    }
  }
  return false;
}

/**
 * Where React's hydration stands for one target: 0 outside every React
 * root (React never touches it), 1 settled (hydrated, or React has passed
 * it and never will), 2 still to come.
 *
 * React marks an element when it completes it, and completes bottom-up: an
 * ancestor with a fiber means everything under it was hydrated in the same
 * pass, except a Suspense boundary left dehydrated for later. So a target
 * without a fiber under a hydrated ancestor is waited for only when it sits
 * inside such a boundary; otherwise React skipped it on purpose
 * (`dangerouslySetInnerHTML`, a node another script added) and writing it
 * cannot make React throw. A target inside a root with no hydrated ancestor
 * yet is still to come. A target that is itself a root container counts by
 * its ancestors only.
 */
export function hydrationState(el: Element): 0 | 1 | 2 {
  if (isHydrated(el)) return 1;
  let c: Node = el;
  for (let n = el.parentNode; n; c = n, n = n.parentNode) {
    if (hasMark(n, REACT_MARK)) return inBoundary(c) ? 2 : 1;
    if (hasMark(n, ROOT_MARK)) return 2;
  }
  return 0;
}

/**
 * Has React finished with every target? True when none is still to come
 * and at least one sits in a root. React hydrates a page in slices (Next's
 * app router yields every few ms), so "one target hydrated" is not "the
 * page hydrated": on a pilot site's /approach 5 of 6 targets carried a fiber
 * when the old check let the write through, and React threw #418 on the
 * sixth 9 ms later (2026-10-06). Targets outside every root do not hold the
 * write; when no target is in a root yet, React has not started here.
 */
export function hydrationDone(els: Element[]): boolean {
  let inRoot = false;
  for (let i = 0; i < els.length; i++) {
    const s = hydrationState(els[i] as Element);
    if (s === 2) return false;
    if (s === 1) inRoot = true;
  }
  return inRoot;
}

/**
 * Run `fn` on the next animation frame, or after `ms` when no frame comes.
 * A frame comes every ~16 ms in a visible tab, so the parts show 0 to 50 ms
 * sooner than on a 50 ms poll (docs/specs/faster-tag.md E1), and a check
 * that passes inside the frame lets the write land before that frame's
 * paint. A hidden tab runs no frames: the timer keeps the wait (and its
 * false at the cap) going. Whichever fires first cancels the other.
 */
export function nextFrame(fn: () => void, ms: number): void {
  let done = false;
  let f: unknown;
  const run = () => {
    if (done) return;
    done = true;
    clearTimeout(t);
    if (f && typeof cancelAnimationFrame === "function") cancelAnimationFrame(f as number);
    fn();
  };
  const t = setTimeout(run, ms);
  if (typeof requestAnimationFrame === "function") f = requestAnimationFrame(run);
}

/**
 * Resolves true once React is done with every target (hydrationDone), or
 * at once when `early` says every part may go before it (apply.ts
 * `declared`), false after `maxMs`. Checks on every animation frame, with an `everyMs`
 * timer for a hidden tab (nextFrame): hydration of a matching tree mutates
 * nothing, so a MutationObserver would not see it. The elements are found
 * once and found again only when one has left the page (a client render
 * replaced it), so a check costs a few property reads per target. Nothing
 * is scheduled once it has resolved.
 */
export function waitForHydration(
  elements: () => Element[],
  maxMs: number,
  early: () => unknown = () => 0,
  everyMs = 50,
  setTimer: (fn: () => void, ms: number) => unknown = nextFrame,
  now: () => number = () => Date.now(),
): Promise<boolean> {
  let els: Element[] = [];
  return waitUntil(
    () => {
      if (els.length === 0 || els.some((el) => !el.isConnected)) els = elements();
      return hydrationDone(els) || early();
    },
    maxMs,
    everyMs,
    setTimer,
    now,
  );
}

/**
 * Resolves true once `test` passes, false after `maxMs`: the one wait loop
 * (frames, with the timer for a hidden tab), used by the hydration wait and
 * by the wait for the page to be parsed far enough to tell a React page
 * (core.ts). Nothing is scheduled once it has resolved.
 */
export function waitUntil(
  test: () => unknown,
  maxMs: number,
  everyMs = 50,
  setTimer: (fn: () => void, ms: number) => unknown = nextFrame,
  now: () => number = () => Date.now(),
): Promise<boolean> {
  return new Promise((resolve) => {
    const started = now();
    const check = () => {
      if (test()) return resolve(true);
      if (now() - started >= maxMs) return resolve(false);
      setTimer(check, everyMs);
    };
    check();
  });
}
