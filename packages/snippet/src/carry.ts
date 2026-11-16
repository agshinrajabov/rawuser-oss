/**
 * Carry the intent within the tab (docs/specs/session-carry.md).
 *
 * A visitor lands from LinkedIn on /, then clicks the site's own language
 * switch to /az. The second page has no signal of its own (same-site
 * referrer, no parameters), so it showed the original. The tab remembers
 * what the edge decided for the landing, for thirty minutes, and offers it
 * to the edge on later pages that carry nothing themselves.
 *
 * GDPR Art. 6(1)(f) legitimate interest: continuing the personalisation
 * already shown for the current visit, with a 36-value, non-identifying,
 * 30-minute session marker that dies with the tab.
 *
 * Privacy: sessionStorage is per tab and dies with it; nothing crosses
 * sites, tabs or sessions; what is stored is two dimension names and a
 * time, never an identifier. The edge uses it only when the page has no
 * signal of its own, and the language gate still applies.
 */

const KEY = "__rw_carry";
const MAX_AGE_MS = 30 * 60 * 1000;
const DIM = /^[a-z]{2,16}$/;

export interface Carry {
  intent_dim: string;
  source_dim: string;
}

/** Set by the customer's `carry: "off"` (docs/specs/session-carry.md, body carry). */
let off = false;

/** Turns both carries off for this page and removes what the tab kept. */
export function carryOff(): void {
  off = true;
  try {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem("__rw_body");
  } catch {
    // Storage blocked: nothing was kept.
  }
}

/**
 * A deleted customer (`off: 1`, security-hardening.md §6 condition 1): the
 * tab's visit marker, carry and body copy go, and nothing is written again
 * on this page.
 */
export function closeTab(): void {
  carryOff();
  try {
    sessionStorage.removeItem("__rw_visit");
  } catch {
    // Storage blocked: nothing was kept.
  }
}

/** The carry with the time it was written, for the body carry to live and die with it. */
export function readCarryStamp(now = Date.now()): (Carry & { t: number }) | null {
  if (off) return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { i?: string; s?: string; t?: number };
    if (!v.i || !v.s || !DIM.test(v.i) || !DIM.test(v.s)) return null;
    if (typeof v.t !== "number" || now - v.t > MAX_AGE_MS) return null;
    return { intent_dim: v.i, source_dim: v.s, t: v.t };
  } catch {
    return null;
  }
}

export function readCarry(now = Date.now()): Carry | null {
  const c = readCarryStamp(now);
  return c ? { intent_dim: c.intent_dim, source_dim: c.source_dim } : null;
}

export function writeCarry(intentDim: string, sourceDim: string, now = Date.now()): void {
  if (off || !DIM.test(intentDim) || !DIM.test(sourceDim)) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ i: intentDim, s: sourceDim, t: now }));
  } catch {
    // Storage blocked (private mode on some engines): the carry is simply off.
  }
}
