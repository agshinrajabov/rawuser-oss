/**
 * Client-side navigation (docs/specs/session-carry.md §SPA).
 *
 * On a Next.js, Nuxt or similar site the language switch and most links do
 * not reload the page: the router calls history.pushState and renders the
 * new route in place. The snippet ran once at load and would never see
 * `/az`. This watches pushState, replaceState and popstate and reports a
 * change of normalised path, so the snippet can personalise the new route.
 */

import { normalizePath } from "./path.ts";

export function watchNavigation(onPathChange: (path: string) => void): () => void {
  let last = normalizePath(location.pathname);
  const check = () => {
    const now = normalizePath(location.pathname);
    if (now === last) return;
    last = now;
    onPathChange(now);
  };
  const h = history as History & { __rwPatched?: boolean };
  const origPush = h.pushState;
  const origReplace = h.replaceState;
  if (!h.__rwPatched) {
    h.pushState = function (this: History, ...args: Parameters<History["pushState"]>) {
      const r = origPush.apply(this, args);
      check();
      return r;
    };
    h.replaceState = function (this: History, ...args: Parameters<History["replaceState"]>) {
      const r = origReplace.apply(this, args);
      check();
      return r;
    };
    h.__rwPatched = true;
  }
  window.addEventListener("popstate", check);
  return () => {
    window.removeEventListener("popstate", check);
  };
}

/**
 * Waits for the router to render the new route: the first DOM mutation
 * batch after the navigation plus a short settle, or `maxMs` if nothing
 * moves. The page language (`<html lang>`) and the new hero exist after this.
 */
export function afterRender(maxMs = 400, settleMs = 60): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setTimeout(resolve, settleMs);
    };
    const t = setTimeout(finish, maxMs);
    if (typeof MutationObserver === "undefined" || !document.body) return;
    const mo = new MutationObserver(() => {
      mo.disconnect();
      clearTimeout(t);
      finish();
    });
    mo.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}
