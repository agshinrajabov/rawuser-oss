/**
 * Carry the version's copy within the visit (docs/specs/interactive-text.md
 * §3.1 b, privacy review docs/research/privacy-review-body-carry.md).
 *
 * On a later page of the visit that has no signal of its own, the words can
 * be written from the tab before the page's own split and animation scripts
 * read the text, so the page animates our copy with its own code and no
 * network race is left. The edge still decides: /select answers as always
 * and the snippet follows it.
 *
 * Privacy, the privacy review's conditions:
 * 1. only `sections`, `targets`, `prompt_hash` and the version's `body_id`
 *    (a fact about our text, docs/specs/proof-engine.md) per path, never a
 *    score;
 * 2. only for served, confirmed pages, the path normalised;
 * 3. one key living and dying with `__rw_carry`: same labels, same time;
 * 4. at most 16 KB per path, 64 KB in all, 8 paths;
 * 5. never sent anywhere (the edge only learns `bc=1`);
 * 7. checked on read.
 * The copy is the same for everyone arriving the same way, and holds
 * nothing about the person.
 */

import { readCarryStamp } from "./carry.ts";
import type { ManifestEntry, VariantBody } from "./types.ts";

const KEY = "__rw_body";
const MAX_PATH_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024;
const MAX_PATHS = 8;
const MAX_STRING = 2000;
const PATH = /^\/[a-z0-9/_\-.]{0,200}$/;

export interface CarriedBody {
  sections: VariantBody["sections"];
  targets?: Record<string, ManifestEntry>;
  prompt_hash?: string;
  /** The version's id (16 hex), so a page written early reports the words it showed. */
  body_id?: string;
}

interface Stored {
  i: string;
  s: string;
  t: number;
  p: Record<string, CarriedBody>;
}

function load(): Stored | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Stored;
    return v && typeof v === "object" && v.p && typeof v.p === "object" ? v : null;
  } catch {
    return null;
  }
}

export function clearBody(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

/** Every string under a value is short, every href relative or http(s) (condition 7). */
function sane(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === "string") return value.length <= MAX_STRING;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return true;
  if (Array.isArray(value)) return value.length <= 40 && value.every((v) => sane(v, depth + 1));
  if (typeof value !== "object") return false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "href" && typeof v === "string" && !/^(?:\/|#|https?:\/\/)/i.test(v)) return false;
    if (!sane(v, depth + 1)) return false;
  }
  return true;
}

/** Only the allowed fields of a body, or null when it breaks a cap (conditions 1, 4). */
export function allowed(body: unknown): CarriedBody | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const sections = b.sections;
  if (!sections || typeof sections !== "object" || Array.isArray(sections)) return null;
  const out: CarriedBody = { sections: sections as VariantBody["sections"] };
  if (b.targets && typeof b.targets === "object") {
    out.targets = b.targets as Record<string, ManifestEntry>;
  }
  if (typeof b.prompt_hash === "string" && b.prompt_hash.length <= 128) {
    out.prompt_hash = b.prompt_hash;
  }
  if (typeof b.body_id === "string" && /^[0-9a-f]{16}$/.test(b.body_id)) out.body_id = b.body_id;
  if (!sane(out)) return null;
  if (JSON.stringify(out).length > MAX_PATH_BYTES) return null;
  return out;
}

/**
 * The copy kept for this path, when the carry is valid with the same labels
 * and time; a stale or mismatched key is removed (condition 3).
 */
export function readBody(path: string, now = Date.now()): CarriedBody | null {
  const stored = load();
  if (!stored) return null;
  const carry = readCarryStamp(now);
  if (
    !carry ||
    carry.intent_dim !== stored.i ||
    carry.source_dim !== stored.s ||
    carry.t !== stored.t
  ) {
    clearBody();
    return null;
  }
  const hit = stored.p[path];
  return hit ? allowed(hit) : null;
}

/** The paths already kept for the current carry, for the prefetch to skip. */
export function keptPaths(now = Date.now()): string[] {
  const stored = load();
  const carry = readCarryStamp(now);
  if (
    !stored ||
    !carry ||
    carry.intent_dim !== stored.i ||
    carry.source_dim !== stored.s ||
    carry.t !== stored.t
  ) {
    return [];
  }
  return Object.keys(stored.p);
}

/**
 * Keep the copy of one or more paths under the current carry. Bodies over a
 * cap are skipped; beyond eight paths or 64 KB the oldest go first; a quota
 * error removes the key (condition 4).
 */
export function storeBodies(bodies: Record<string, unknown>, now = Date.now()): void {
  const carry = readCarryStamp(now);
  if (!carry) return;
  const prev = load();
  const same =
    prev && prev.i === carry.intent_dim && prev.s === carry.source_dim && prev.t === carry.t;
  const p: Record<string, CarriedBody> = same ? { ...prev.p } : {};
  for (const [path, body] of Object.entries(bodies)) {
    if (!PATH.test(path)) continue;
    const ok = allowed(body);
    if (!ok) continue;
    delete p[path];
    p[path] = ok;
  }
  const keys = Object.keys(p);
  while (keys.length > MAX_PATHS) delete p[keys.shift() as string];
  const next: Stored = { i: carry.intent_dim, s: carry.source_dim, t: carry.t, p };
  while (Object.keys(next.p).length > 0 && JSON.stringify(next).length > MAX_TOTAL_BYTES) {
    delete next.p[Object.keys(next.p)[0] as string];
  }
  try {
    if (Object.keys(next.p).length === 0) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    clearBody();
  }
}
