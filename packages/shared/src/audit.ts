/**
 * The free AI-traffic audit (docs/specs/ai-traffic-audit.md): the closed
 * `found_by` list (§4.2) and the audit's host and end rule (§3.4, privacy review
 * condition 1). Shared so the edge (`/select`, `/event`, `/s/{id}.js`), the
 * snippet and generation (the aggregator's reads and the report) cannot disagree.
 *
 * Privacy: `found_by` is one word from a fixed list naming which KIND of
 * fact showed the platform, never the fact itself (no utm value, host, UA
 * or click-id value). Written for audit customers only, kept with the
 * event row (ADR 0037).
 */

import { AUTO_TAG_UTM_SOURCES, isOwnTagged } from "./signals/source-vocabulary.ts";
import type { Signals } from "./types.ts";

/**
 * How a visit's platform was recognised, in precedence order (the first that
 * applies wins). Only `app_marker` backs the report's "no referrer and no
 * tags" line.
 */
export const FOUND_BY = [
  /** The customer's own utm tags (`isOwnTagged`). */
  "tag",
  /** A platform's own utm_source (`AUTO_TAG_UTM_SOURCES`, ChatGPT today). */
  "auto_tag",
  /** An ad or share click-id parameter NAME, no utm. */
  "click_id",
  /** A web referrer host. */
  "referrer",
  /** An `android-app://` referrer. */
  "app_package",
  /** Only an in-app browser marker or the Android WebView brand. */
  "app_marker",
] as const;

export type FoundBy = (typeof FOUND_BY)[number];

const FOUND_BY_SET: ReadonlySet<string> = new Set(FOUND_BY);

/** True for a word on the closed list; `/event` stores nothing else. */
export function isFoundBy(v: unknown): v is FoundBy {
  return typeof v === "string" && FOUND_BY_SET.has(v);
}

/**
 * The `found_by` word for a request's OWN signals (§4.2), or null: no
 * signal, a path only, a carried page. The caller passes the signals of
 * this request only (never a carried landing's), and calls it only for an
 * audit customer (bundle `a`).
 *
 * An app marker counts only at high or medium confidence (a named app's UA
 * marker, the Android WebView brand or `; wv)`); the low-confidence iOS
 * WebKit guess is not a marker and leaves the visit with no source to read,
 * the safe direction for the "no referrer, no tags" count.
 */
export function foundBy(
  s: Pick<Signals, "utm" | "referrerHost" | "referrerIsApp" | "appSource" | "clickId">,
): FoundBy | null {
  if (isOwnTagged(s.utm)) return "tag";
  const src = (s.utm.source ?? "").trim().toLowerCase();
  if (src && AUTO_TAG_UTM_SOURCES.has(src)) return "auto_tag";
  if (s.clickId) return "click_id";
  if (s.referrerHost && !s.referrerIsApp) return "referrer";
  if (s.referrerHost && s.referrerIsApp) return "app_package";
  if (s.appSource && s.appSource.confidence !== "low") return "app_marker";
  return null;
}

// ---------------------------------------------------------------------------
// The audit's host and end rule (§3.4, §3.8; privacy review conditions 1 and 2)
// ---------------------------------------------------------------------------

/**
 * The audit domain as the bundle's `ad` carries it: lower case, no scheme,
 * port, path, trailing dot or leading `www.`. Null for anything that is not
 * a plain host name (an IP literal or a single label never qualifies).
 */
export function normalizeAuditDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  h = h.split(/[/?#]/)[0] ?? "";
  h = h
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) return null;
  if (/^\d+(\.\d+){3}$/.test(h)) return null;
  return h;
}

/**
 * True when `host` (the browser-set Origin's host at the edge,
 * `location.hostname` in the snippet) is the audit domain or one of its
 * subdomains. `www.example.com` passes for `example.com`; `badexample.com`
 * and `example.com.evil.test` do not. No host (no Origin, `null`) fails.
 */
export function auditHostAllowed(host: string | null | undefined, ad: string): boolean {
  if (!host || !ad) return false;
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  return h === ad || h.endsWith(`.${ad}`);
}

/** Why an audit customer's request gets the record-nothing answer, or null. */
export type AuditRefusal = "host" | "ended";

/**
 * The one rule for an audit customer (bundle `a: 1`): a foreign or missing
 * host, or a time at or after `ae`, gets the record-nothing answer (the bot
 * answer at `/select`, a dropped row at `/event`, the page as built in the
 * snippet). A bundle without `a` is never refused here. An audit bundle
 * without `ad` refuses every host (a malformed domain must not open the
 * tag to every site).
 */
export function auditRefusal(
  bundle: { a?: 1; ad?: string; ae?: number } | null | undefined,
  host: string | null | undefined,
  now: number,
): AuditRefusal | null {
  if (!bundle || bundle.a !== 1) return null;
  if (typeof bundle.ae === "number" && now >= bundle.ae) return "ended";
  if (!bundle.ad || !auditHostAllowed(host, bundle.ad)) return "host";
  return null;
}
