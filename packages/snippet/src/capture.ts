/**
 * Capture mode (script-first onboarding).
 *
 * When the page URL carries `?rawuser_capture=<token>`, the operator is
 * onboarding their own site: instead of asking the edge for a version, the
 * snippet waits for the page to render, clones the DOM, drops script/style/
 * noscript/svg/iframe, and posts it to the edge under the one-time token
 * the dashboard minted. The page itself is left untouched and nothing is
 * hidden. Visitors never carry the parameter, so this code never runs for
 * them.
 *
 * The parameter is removed from the address bar the moment it is seen, so
 * analytics on the page that read location.href do not see the token.
 */

import { CAPTURE_PARAM, scrubParam, showNote, tokenFrom } from "./pick-loader.ts";

// Mirrored from @rawuser/shared capture.ts (the snippet has zero runtime
// imports from shared); test/capture-parity.test.ts pins the two together.
// Since 2026-10-25 this module runs in the operator module, `/picker.js`
// (picker/index.ts, `data-mode="capture"`); the visitor's files only check
// for the token (start.ts).
export { CAPTURE_PARAM };

/** Returns the token when the page was opened in capture mode (fragment or query), else null. */
export function captureToken(loc: Pick<Location, "search" | "hash">): string | null {
  return tokenFrom(loc, CAPTURE_PARAM);
}

/** Drops the token from the visible URL without a navigation. */
export function scrubCaptureParam(win: Window): void {
  scrubParam(win, CAPTURE_PARAM);
}

/**
 * The rendered DOM minus non-content markup and minus what its form fields
 * hold, as a string. The page is read as this browser shows it, so a
 * signed-in page has a name, an address or a hidden token in its fields:
 * they are taken out here, before anything leaves the page, and again at
 * the edge (`stripFieldValues`). A button's `value` is its label and stays.
 */
export function serializePage(doc: Document): string {
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  const junk = clone.querySelectorAll("script,style,noscript,svg,iframe");
  for (let i = 0; i < junk.length; i++) junk[i]?.remove();
  const fields = clone.querySelectorAll("input,textarea");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] as Element;
    if (f.tagName === "TEXTAREA") f.textContent = "";
    else if (!/^(submit|button|reset)$/i.test(f.getAttribute("type") ?? "")) {
      f.removeAttribute("value");
      f.removeAttribute("data-value");
    }
  }
  return clone.outerHTML.slice(0, 500000);
}

export interface CaptureDeps {
  doc: Document;
  win: Window;
  fetchFn: typeof fetch;
}

/**
 * Waits for `load` plus a settle delay (client-side apps render after load),
 * then posts the DOM. Resolves with the edge's answer for the on-page note.
 */
export function runCapture(
  token: string,
  edgeOrigin: string,
  deps: CaptureDeps,
  settleMs = 1500,
): Promise<{ ok: boolean; message: string }> {
  const { doc, win, fetchFn } = deps;
  const whenLoaded = new Promise<void>((resolve) => {
    if (doc.readyState === "complete") resolve();
    else win.addEventListener("load", () => resolve(), { once: true });
  });
  return whenLoaded
    .then(() => new Promise<void>((resolve) => setTimeout(resolve, settleMs)))
    .then(() =>
      fetchFn(`${edgeOrigin}/onboard/capture`, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          url: win.location.origin + win.location.pathname,
          html: serializePage(doc),
        }),
      }),
    )
    .then((r) => r.json() as Promise<{ ok?: boolean; error?: string }>)
    .then((j) =>
      j.ok
        ? { ok: true, message: "Rawuser: page captured. Return to the dashboard." }
        : { ok: false, message: `Rawuser: ${j.error ?? "capture failed"}` },
    )
    .catch(() => ({ ok: false, message: "Rawuser: capture failed (network)" }));
}

/** A small corner note so the operator knows the capture landed. */
export function showCaptureNote(doc: Document, message: string): void {
  showNote(message, doc);
}
