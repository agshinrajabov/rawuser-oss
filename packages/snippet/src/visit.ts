/**
 * The visit marker (docs/specs/visit-marker.md).
 *
 * A random 32-hex value drawn once per tab, kept in sessionStorage for
 * thirty minutes of inactivity, gone when the tab closes. It goes to the
 * edge on /select and on every event, and is used for two things only:
 * one consistent holdout arm per visit, and counting visits instead of
 * rows. It is random, not derived from the device; it never crosses sites
 * (sessionStorage is per origin), tabs or sessions; nothing on our side
 * keeps it past the aggregation horizon.
 *
 * With crypto or storage unavailable there is no marker and the snippet
 * behaves exactly as before.
 */

const KEY = "__rw_visit";
const MAX_IDLE_MS = 30 * 60 * 1000;
const SHAPE = /^[0-9a-f]{32}$/;

function draw(): string | null {
  try {
    // No crypto, or no getRandomValues: it throws, and there is no marker.
    const bytes = (globalThis as { crypto: Crypto }).crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/**
 * The tab's visit marker: the stored one when it is well-formed and not
 * idle for more than thirty minutes, else a fresh one. Refreshes the time
 * on every call. Null when storage or crypto is unavailable.
 */
export function ensureVisit(now = Date.now()): string | null {
  let stored: { v?: string; t?: number } | null = null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) stored = JSON.parse(raw) as { v?: string; t?: number };
  } catch {
    stored = null;
  }
  let v: string | null = null;
  if (
    stored &&
    typeof stored.v === "string" &&
    SHAPE.test(stored.v) &&
    typeof stored.t === "number" &&
    now - stored.t <= MAX_IDLE_MS
  ) {
    v = stored.v;
  } else {
    v = draw();
  }
  if (!v) return null;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ v, t: now }));
  } catch {
    // Storage blocked: the marker lives for this pass only. Without a way
    // to keep it, the next page starts a new visit; still no identifier.
  }
  return v;
}
