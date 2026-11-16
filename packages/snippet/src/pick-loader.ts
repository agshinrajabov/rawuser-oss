/**
 * Pick mode loader (docs/specs/visual-picker.md).
 *
 * The base snippet stays small: when the page carries `?rawuser_pick=`
 * it only scrubs the token from the address bar and loads the picker
 * module from the edge (`/picker.js`, built from src/picker/). The token
 * is handed over on the script tag's dataset, never in a URL again.
 */

import { withNonce } from "./nonce.ts";

// Mirrored from @rawuser/shared pick.ts (the snippet has zero runtime
// imports from shared); test/pick-parity.test.ts pins the two together.
export const PICK_PARAM = "rawuser_pick";
// Mirrored from @rawuser/shared capture.ts; test/capture-parity.test.ts pins
// the two together. Here, not in capture.ts, since capture runs in the
// operator module (faster-tag.md D): the boot checks for the token only.
export const CAPTURE_PARAM = "rawuser_capture";

/**
 * The token rides in the URL fragment (`#rawuser_pick=…`): fragments never
 * reach servers, logs or Referer headers. The query form is accepted too.
 */
export function pickToken(loc: Pick<Location, "search" | "hash">): string | null {
  return tokenFrom(loc, PICK_PARAM);
}

export function tokenFrom(loc: Pick<Location, "search" | "hash">, name: string): string | null {
  const fromHash = new URLSearchParams((loc.hash ?? "").replace(/^#/, "")).get(name);
  const token = fromHash ?? new URLSearchParams(loc.search).get(name);
  return token && /^[A-Za-z0-9_-]{8,64}$/.test(token) ? token : null;
}

export function scrubPickParam(win: Window): void {
  scrubParam(win, PICK_PARAM);
}

export function scrubParam(win: Window, ...names: string[]): void {
  try {
    const url = new URL(win.location.href);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    for (const name of names) {
      url.searchParams.delete(name);
      hash.delete(name);
    }
    const rest = hash.toString();
    url.hash = rest ? `#${rest}` : "";
    win.history.replaceState(win.history.state, "", url.toString());
  } catch {
    // Older browsers: the token expires on its own.
  }
}

/**
 * Pick or capture mode: both operator parameters leave the address bar in
 * this task, before anything else is inserted or read (the boot does it
 * before it inserts the core, script-first-onboarding.md §3). True when
 * the token is a capture's (pick first, as before).
 */
export function scrubOperator(): boolean {
  const capture = !tokenFrom(location, PICK_PARAM);
  scrubParam(window, PICK_PARAM, CAPTURE_PARAM);
  return capture;
}

/**
 * The operator module, `/picker.js`: the picker, or with `capture` the
 * capture of the rendered page (capture.ts), which moved out of the
 * visitor's file on 2026-10-25 (faster-tag.md D). Operator only.
 */
export function loadPicker(
  token: string,
  edgeOrigin: string,
  doc: Document,
  onBlocked?: (message: string) => void,
  capture = false,
): HTMLScriptElement {
  const s = withNonce(doc.createElement("script"));
  s.src = `${edgeOrigin}/picker.js`;
  s.async = true;
  s.dataset.token = token;
  s.dataset.edgeOrigin = edgeOrigin;
  if (capture) s.dataset.mode = "capture";
  // A strict Content-Security-Policy fails closed (no picker, nothing
  // sent); say so instead of leaving a blank page.
  s.onerror = () =>
    onBlocked?.(
      `Rawuser: this site's Content-Security-Policy blocked the ${capture ? "capture" : "picker"}. Allow ${edgeOrigin} in script-src and connect-src, then open the link again.`,
    );
  (doc.head ?? doc.documentElement).appendChild(s);
  return s;
}

/** A small corner note so the operator knows what happened (capture landed, a policy blocked us). */
export function showNote(message: string, doc: Document = document): void {
  const el = doc.createElement("div");
  el.setAttribute("data-rawuser-note", "");
  el.textContent = message;
  el.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 14px;background:#111;color:#fff;font:13px/1.4 system-ui,sans-serif;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.2)";
  doc.body.appendChild(el);
  setTimeout(() => el.remove(), 8000);
}
