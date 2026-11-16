/**
 * The two-part tag (docs/specs/faster-tag.md step 6): the style a live
 * customer pastes first in <head>, and the async script line under it.
 *
 * The paste is built from the CONFIRMED manifests, the parts Rawuser writes
 * (writtenRows: a button left as built is neither hidden nor pasted), by the
 * same rules that make the hide rules (`hideRulesFromManifests`), then
 * `preHideStyle`: one style for the whole site, sorted, so its text and its
 * CSP hash change only when a confirm, an added page, a pick or a button
 * switch changes the set of selectors. The hide rules in KV can be a subset
 * (a part no version writes is not hidden, lib/hidden-parts.ts); the paste
 * keeps every written part so it does not go stale each time a version is
 * written. A pasted part the boot does not hide shows when the boot runs.
 *
 * The probe reads the paste on the customer's homepage (`findPrePaste`) and
 * stores only a state word and the hash of the text it found (privacy review
 * ruling 2026-10-26, condition 2): never the HTML, never the pasted text.
 */

import { type HideRules, hideRulesFromManifests, preHideHash, preHideStyle } from "@rawuser/shared";
import type { Manifest } from "../detect-elements.ts";
import { writtenRows } from "./button-rewrite.ts";
import { PRE_POLICIES, type PrePolicy } from "./csp.ts";

/** What the probe stores about the paste on the page. */
export const PRE_STATES = ["none", "current", "stale"] as const;
export type PreState = (typeof PRE_STATES)[number];

/** `'sha256-<44 base64>'`, the form preHideHash returns and the policy carries. */
const HASH_RE = /^'sha256-[A-Za-z0-9+/]{43}='$/;

/** The first part, the style: what the probe compares a page's paste with. */
export interface CurrentPasteStyle {
  /** The text between `<style data-rawuser-pre>` and `</style>`. */
  css: string;
  /** The style element, as pasted into an HTML head. */
  style: string;
  /** CSP source for the style, `'sha256-...'`. */
  hash: string;
  /** Selectors in the paste, without the constant `[data-rawuser]` rule. */
  selectors: number;
}

export interface CurrentPaste extends CurrentPasteStyle {
  /** The async script line, under the style. */
  script: string;
  /** Both lines, as one paste. */
  html: string;
}

/**
 * The second part: the customer's own script, async. The edge serves it at
 * /s/{id}.js, on the same origin as the one-line tag (EDGE_ORIGIN).
 */
export function preScriptTag(edgeOrigin: string, customerId: string): string {
  return `<script async data-cfasync="false" src="${edgeOrigin}/s/${customerId}.js"></script>`;
}

/** The rules the paste is built from: every confirmed page's written parts. */
export async function pasteRules(db: D1Database, customerId: string): Promise<HideRules> {
  const ended = await db
    .prepare("SELECT status FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ status: string | null }>();
  // An ended audit ships no hide rules; it has nothing to paste either.
  if (ended?.status === "ended") return {};
  const result = await db
    .prepare(
      "SELECT page_path, manifest FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL",
    )
    .bind(customerId)
    .all<{ page_path: string; manifest: string }>();
  const rows = writtenRows(
    (result.results ?? []).flatMap((r) => {
      try {
        return [{ page_path: r.page_path, manifest: JSON.parse(r.manifest) as Manifest }];
      } catch {
        return [];
      }
    }),
  );
  return hideRulesFromManifests(rows);
}

/** The paste's style for this customer now; null when no confirmed page has a part to hide. */
export async function currentPasteStyle(
  db: D1Database,
  customerId: string,
): Promise<CurrentPasteStyle | null> {
  const rules = await pasteRules(db, customerId);
  const selectors = new Set(Object.values(rules).flat()).size;
  if (selectors === 0) return null;
  const css = preHideStyle(rules);
  return {
    css,
    style: `<style data-rawuser-pre>${css}</style>`,
    hash: await preHideHash(css),
    selectors,
  };
}

/** The whole paste, with the script line on `edgeOrigin`; null as currentPasteStyle. */
export async function currentPaste(
  db: D1Database,
  customerId: string,
  edgeOrigin: string,
): Promise<CurrentPaste | null> {
  const first = await currentPasteStyle(db, customerId);
  if (!first) return null;
  const script = preScriptTag(edgeOrigin, customerId);
  return {
    css: first.css,
    style: first.style,
    script,
    html: `${first.style}\n${script}`,
    hash: first.hash,
    selectors: first.selectors,
  };
}

export interface FoundPaste {
  /** The CSP hash of each pasted text found, in page order. Never the text. */
  hashes: string[];
  /** Some paste carries a nonce attribute. */
  nonce: boolean;
}

const STYLE_RE = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;

/**
 * Every `<style data-rawuser-pre>` in the HTML, reduced at once to its hash.
 * The text is hashed exactly as written (the bytes a browser hashes for CSP)
 * and dropped; only the hashes leave this function.
 */
export async function findPrePaste(html: string): Promise<FoundPaste> {
  const hashes: string[] = [];
  let nonce = false;
  for (const m of html.matchAll(STYLE_RE)) {
    const attrs = m[1] ?? "";
    if (!/(?:^|\s)data-rawuser-pre(?:[\s=]|$)/i.test(attrs)) continue;
    if (/(?:^|\s)nonce\s*=/i.test(attrs)) nonce = true;
    hashes.push(await preHideHash(m[2] ?? ""));
    if (hashes.length >= 4) break;
  }
  return { hashes, nonce };
}

/**
 * The state word and the one hash the probe stores: `current` when a paste on
 * the page is the current paste (its hash stored), `stale` when one is there
 * and none is current (the first one's hash stored), `none` otherwise.
 */
export function preStateOf(
  found: FoundPaste,
  currentHash: string | null,
): { state: PreState; hash: string | null } {
  if (found.hashes.length === 0) return { state: "none", hash: null };
  if (currentHash && found.hashes.includes(currentHash)) {
    return { state: "current", hash: currentHash };
  }
  return { state: "stale", hash: found.hashes[0] ?? null };
}

/** The stored form: a closed word and a hash of the exact shape, else NULL. */
export function storedPreFacts(f: { state?: unknown; hash?: unknown; policy?: unknown }): {
  pre_state: PreState | null;
  pre_hash: string | null;
  pre_policy: PrePolicy | null;
} {
  const state =
    typeof f.state === "string" && (PRE_STATES as readonly string[]).includes(f.state)
      ? (f.state as PreState)
      : null;
  const hash = typeof f.hash === "string" && HASH_RE.test(f.hash) ? f.hash : null;
  const policy =
    typeof f.policy === "string" && (PRE_POLICIES as readonly string[]).includes(f.policy)
      ? (f.policy as PrePolicy)
      : null;
  // A state that says a paste is there carries its hash; `none` carries none.
  if (state === "none") return { pre_state: state, pre_hash: null, pre_policy: policy };
  if (state && !hash) return { pre_state: null, pre_hash: null, pre_policy: policy };
  return { pre_state: state, pre_hash: state ? hash : null, pre_policy: policy };
}
