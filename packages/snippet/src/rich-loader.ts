/**
 * Loading `/rich.js` (2026-09-30). The customer script lists in
 * `window.__rw.x` the pages whose confirmed manifests have a part built word
 * by word or cut into lines (the edge reads them from `v1:rich:{customer}`).
 * On such a page the script tag goes in at the start of the pass, so it
 * loads while /select is on its way and adds no wait on a normal load.
 * A /select answer that needs the writers on a page the list missed (a
 * stale key) loads it then, one round trip on that load only. Either way
 * the wait is bounded by the reveal cap: a stuck rich.js never holds the
 * page, the parts that need it are left as the page built them.
 */

import { withNonce } from "./nonce.ts";
import { rich } from "./rich-api.ts";
import type { ManifestEntry } from "./types.ts";

/** A hash of rich.js, set by build.ts, so a new build is a new URL (immutable cache). */
declare const __RICH_VERSION__: string | undefined;
export const RICH_VERSION = typeof __RICH_VERSION__ === "string" ? __RICH_VERSION__ : "dev";

let loading: Promise<void> | null = null;

/**
 * Is this page on the list? Matched as the hide rules are: the exact path,
 * else the root page's when this page has no rules of its own (the edge
 * serves the root manifest there).
 */
export function richListed(
  x: readonly string[] | undefined,
  here: string,
  h?: Record<string, string[]>,
): boolean {
  if (!x) return false;
  return x.includes(here) || (!h?.[here] && x.includes("/"));
}

/** A part the writers must write: a template or lines the operator did not clear. */
export function targetsNeedRich(targets?: Record<string, ManifestEntry>): boolean {
  return Object.values(targets ?? {}).some(
    (e) => !e.skip && !e.plain && (!!e.inline?.template || !!e.inline?.lines),
  );
}

/** Inject the script once; resolves when it ran or failed (never rejects). */
export function loadRich(edgeOrigin: string, doc: Document = document): Promise<void> {
  if (rich()) return Promise.resolve();
  if (!loading) {
    loading = new Promise<void>((done) => {
      const s = withNonce(doc.createElement("script"));
      s.src = `${edgeOrigin}/rich.js?v=${RICH_VERSION}`;
      s.async = true;
      s.onload = s.onerror = () => done();
      (doc.head ?? doc.documentElement).appendChild(s);
    });
  }
  return loading;
}

/**
 * The load the boot started (start.ts, `page.rich`): a core that comes in
 * its own file has its own copy of this module, so it waits on the boot's
 * load instead of inserting the script a second time.
 */
export function adoptRich(p?: Promise<void>): void {
  if (p && !loading) loading = p;
}

/** The load under way, or null when none was started. */
export function richLoading(): Promise<void> | null {
  return rich() ? null : loading;
}

/** For tests: forget the injected script. */
export function resetRichLoader(): void {
  loading = null;
}

/**
 * Settles when the load under way ends or at `capAt` (a Date.now() time,
 * the reveal cap), whichever is first. At once when nothing is loading.
 */
export function richWait(capAt: number): Promise<void> {
  const p = richLoading();
  if (!p) return Promise.resolve();
  return Promise.race([
    p,
    new Promise<void>((r) => setTimeout(r, Math.max(0, capAt - Date.now()))),
  ]);
}
