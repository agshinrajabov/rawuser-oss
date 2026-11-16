/**
 * The snippet's main file: `/snippet.js` (the generic tag) and the shared
 * core `/s/_core/{hash}.js` that a customer's boot loads (entry-boot.ts,
 * docs/specs/faster-tag.md step 4). One build for both. Every customer
 * script `/s/{id}.js` is the boot, whatever its policy (step 6, E1).
 *
 * Inserted by a boot, the script element carries the boot's `Page`
 * (`__rwh`): the core takes the load's pass over from it (core.ts). A boot
 * of another handoff version shows the page as built. Without a handoff
 * (the generic tag) it starts the pass
 * itself, at once, as before the split.
 */

import { runCore } from "./core.ts";
import { loadPicker, scrubOperator, showNote } from "./pick-loader.ts";
import { type Op, PROTOCOL, type Page, startBoot } from "./start.ts";

/**
 * Pick or capture mode (operator only): the operator module, `/picker.js`,
 * loads; capture sends the rendered DOM (capture.ts, in that module since
 * 2026-10-25, faster-tag.md D). The token has left the address bar by then:
 * here (the single file) or in the boot (a split tag, `Op`).
 */
const operator = (token: string, edge: string, capture: boolean) =>
  loadPicker(token, edge, document, showNote, capture);

(() => {
  const s = document.currentScript as (HTMLScriptElement & { __rwh?: Page | Op }) | null;
  const handed = s?.__rwh;
  if (handed) {
    s.__rwh = undefined;
    // Not ours to read: the page as built, at once (the boot's cap and the
    // CSS backstop would show it later anyway).
    if (handed.v !== PROTOCOL) document.getElementById("__rawuser-hide")?.remove();
    else if ("op" in handed) operator(handed.op, handed.e, handed.cap);
    else runCore(handed);
    return;
  }
  const page = startBoot((token, edge) => operator(token, edge, scrubOperator()));
  if (page) runCore(page);
})();
