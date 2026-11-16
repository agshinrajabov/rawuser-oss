/**
 * The page's Content-Security-Policy nonce, carried (docs/specs/install-friction.md,
 * E1; privacy review ruling 2026-10-03, condition 5).
 *
 * Read once from our own script element and copied, as a property only,
 * onto the elements we create: the hide `<style>` and the `/rich.js` and
 * `/picker.js` scripts. On a nonce policy the hide rules then apply without
 * a hash and the inserted scripts run without 'strict-dynamic'. The value
 * never goes into a URL, an event, storage, the carry or a log: it lives in
 * this module and on those elements, nowhere else.
 */

let nonce = "";

/** Keep the nonce of our own script element (`document.currentScript`). */
export function keepNonce(s: HTMLScriptElement | null): void {
  nonce = s?.nonce || "";
}

/** Give an element we create the page's nonce, before it is inserted. */
export function withNonce<T extends HTMLElement>(el: T): T {
  if (nonce) el.nonce = nonce;
  return el;
}
