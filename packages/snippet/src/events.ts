/**
 * Snippet-side analytics event emission.
 *
 * Fires fire-and-forget POSTs to the edge worker's /event endpoint. Never
 * blocks rendering. Never surfaces errors to the visitor. One transport,
 * `fetch(..., { keepalive: true })`, which survives the navigation a
 * conversion click starts; events sent while the page is leaving go as
 * text/plain (see fireEvent). sendBeacon only where keepalive is missing.
 *
 * Privacy invariants (mirror the edge contract in ADR 0019):
 * - page_path is `location.pathname` only — no search, no hash. The edge
 *   re-strips defensively but we never send sensitive query strings.
 * - No referrer, no UA, no screen, no timezone, no visitor identifier.
 * - JSON body contains ONLY the typed EventPayload fields.
 */

import type { EventPayload } from "./types.ts";

/**
 * Build the page_path: pathname only, never search or hash.
 * Defensive: if location is unavailable (SSR test envs), return "/".
 */
export function pagePath(): string {
  try {
    return location.pathname || "/";
  } catch {
    return "/";
  }
}

/**
 * Build the /event endpoint URL. Customer id is in the query string so the
 * edge can authenticate the write without parsing the body.
 */
function eventUrl(edgeOrigin: string, customerId: string): string {
  return `${edgeOrigin}/event?cid=${encodeURIComponent(customerId)}`;
}

/**
 * True when this browser keeps a `fetch` alive past the page (`keepalive`),
 * every current engine; older ones fall back to sendBeacon.
 */
function canKeepAlive(): boolean {
  try {
    return typeof Request === "function" && "keepalive" in Request.prototype;
  } catch {
    return false;
  }
}

/**
 * Fire a single event. Returns immediately; never awaits, never throws.
 *
 * Every event goes by `fetch(..., { keepalive: true })`, which outlives
 * the page, with no credentials. `leaving` (a conversion click, the
 * pagehide flush of snippet issues) sends it as `text/plain`, a simple
 * CORS request: no preflight to wait for while the page goes, and the
 * browser sets the real `Origin` whatever the page's Referrer-Policy. Until
 * 2026-10-06 those went by `navigator.sendBeacon`, a no-cors request whose
 * `Origin` is `null` under `no-referrer` or `same-origin`, so the audit's
 * host check (docs/specs/ai-traffic-audit.md, privacy review condition 1) would
 * have dropped them. sendBeacon stays only where `keepalive` is missing.
 * The edge parses the body as JSON whatever its type.
 */
export function fireEvent(
  edgeOrigin: string,
  customerId: string,
  payload: EventPayload,
  leaving = false,
): void {
  const url = eventUrl(edgeOrigin, customerId);
  const body = JSON.stringify(payload);
  const type = leaving ? "text/plain;charset=UTF-8" : "application/json";

  if (leaving && !canKeepAlive() && beacon(url, body, type)) return;
  try {
    void fetch(url, {
      method: "POST",
      headers: { "content-type": type },
      body,
      // Never credentials: a credentialed request fails CORS against the
      // edge's wildcard origin (the beacon fault found 2026-10-04).
      credentials: "omit",
      cache: "no-store",
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // fetch construction failed (an old engine, an invalid URL): the
    // beacon, when leaving, else give up silently (analytics is best effort).
    if (leaving) beacon(url, body, type);
  }
}

/** navigator.sendBeacon with a CORS-safelisted type; false when absent or refused. */
function beacon(url: string, body: string, type: string): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(url, new Blob([body], { type }))
    );
  } catch {
    return false;
  }
}
