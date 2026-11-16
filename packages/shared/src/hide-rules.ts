/**
 * Quiet swap (docs/specs/quiet-swap.md): the per-customer list of CSS
 * selectors the snippet hides before first paint, so a rewritten headline
 * never flashes its original first. Derived from the CONFIRMED manifests
 * at confirm time, stored in KV, and shipped inside the customer's own
 * script (`/s/{customer}.js`). Selectors only; nothing about a visitor.
 */

import type { Manifest } from "./types.ts";

/** path → selectors to hide on that page. */
export type HideRules = Record<string, string[]>;

export function hideRulesKey(customerId: string): string {
  return `v1:hide:${customerId}`;
}

const MAX_PER_PATH = 40;
const MAX_LEN = 300;
/** A selector we are willing to put in a stylesheet: no braces, no markup, no at-rules. */
const SAFE_SELECTOR = /^[^{}<@]+$/;

export function hideRulesFromManifests(
  rows: { page_path: string; manifest: Manifest }[],
): HideRules {
  const out: HideRules = {};
  for (const row of rows) {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const entry of Object.values(row.manifest)) {
      for (const sel of entry.css) {
        const s = sel.trim();
        if (!s || s.length > MAX_LEN || !SAFE_SELECTOR.test(s) || seen.has(s)) continue;
        seen.add(s);
        list.push(s);
        if (list.length >= MAX_PER_PATH) break;
      }
      if (list.length >= MAX_PER_PATH) break;
    }
    if (list.length > 0) out[row.page_path] = list;
  }
  return out;
}

/**
 * Rich writers on demand (2026-09-30, plan "Room in the snippet"): the
 * snippet core was at 14,957 of 15,360 B gzip, and most of it was the
 * word-split template and poured-lines writers that only a few pages use
 * (the lab's zoo, Webflow SplitText). Those writers moved to `/rich.js`,
 * loaded only on the pages this key lists. The edge reads the key into the
 * customer script (`window.__rw.x`); the string is a contract with the edge.
 */
export function richKey(customerId: string): string {
  return `v1:rich:${customerId}`;
}

/**
 * The confirmed pages that need the rich writers: a manifest entry the
 * snippet will write (not `skip`, not `plain`) whose inline shape is a
 * template or a line split. Paths are keyed exactly as
 * `hideRulesFromManifests` keys them (the stored `page_path`, normalized at
 * write by `normalizePath`), so the snippet matches them against
 * `normalizePath(location.pathname)` the same way it matches the hide rules.
 */
export function richPathsFromManifests(
  rows: { page_path: string; manifest: Manifest }[],
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (out.includes(row.page_path)) continue;
    const rich = Object.values(row.manifest).some(
      (entry) =>
        entry.skip !== true &&
        entry.plain !== true &&
        (Boolean(entry.inline?.template) || (entry.inline?.lines ?? 0) > 0),
    );
    if (rich) out.push(row.page_path);
  }
  return out;
}

/**
 * The two-part tag (docs/specs/faster-tag.md step 6): the style a site
 * pastes above the async tag, so the parts are hidden from the first paint
 * while our script is still on its way. One style for the whole site (a head
 * is pasted once): every confirmed page's selectors, once each, sorted, so
 * the text and its CSP hash change only when the set of selectors does.
 *
 * Each selector is its own rule, so one selector a browser refuses does not
 * take the others with it (as the snippet's insertRule does). Each rule
 * carries its own backstop: visibility comes back after PRE_REVEAL_MS from
 * the part's first style, with or without our script. The boot takes the
 * parts over from it when it runs in time and disables it (pre.ts). The
 * keyframes are not the snippet's `__rwr`: when the boot's own rules land,
 * the part's animation is a new one, counted from then.
 *
 * Selectors only, the same as the hide rules; nothing about a visitor. The
 * text is the contract with the snippet (`style[data-rawuser-pre]`) and with
 * the hash in the customer's policy: change it only with a repaste.
 */
export const PRE_REVEAL_MS = 1500;

/** The style's text: what goes between `<style data-rawuser-pre>` and `</style>`. */
export function preHideStyle(rules: HideRules): string {
  const sels = new Set<string>(["[data-rawuser]"]);
  for (const sel of Object.values(rules)
    .flat()
    .map((s) => s.trim())
    .sort()) {
    if (sel && sel.length <= MAX_LEN && SAFE_SELECTOR.test(sel)) sels.add(sel);
  }
  const rule = `{visibility:hidden;animation:__rwp 0s ${PRE_REVEAL_MS}ms both!important}`;
  return `@keyframes __rwp{from{visibility:hidden}to{visibility:visible}}${[...sels]
    .map((s) => s + rule)
    .join("")}`;
}

/** The first part of the two-part tag, as pasted into an HTML head. */
export function preHideTag(rules: HideRules): string {
  return `<style data-rawuser-pre>${preHideStyle(rules)}</style>`;
}

/**
 * The CSP source for the style, `'sha256-...'`: the hash of the exact text
 * between the tags, for a policy that blocks inline styles
 * (docs/specs/install-friction.md, "The exact lines").
 */
export async function preHideHash(css: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(css));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return `'sha256-${btoa(bin)}'`;
}
