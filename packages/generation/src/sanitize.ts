/**
 * Post-generation sanitization: belt-and-suspenders against LLM quirks.
 *
 * The prompt instructs the model NEVER to emit em-dashes or en-dashes, but
 * the model occasionally slips one in. This pass walks every visible string
 * field in a VariantBody and replaces typographic dashes with commas: the
 * grammatically safest substitution across languages (notably Azerbaijani,
 * Turkish, and Russian where em-dashes read as translated/awkward).
 *
 * Why comma over period: a comma never breaks sentence structure ("X — Y"
 * → "X, Y" stays valid). Splitting into two sentences would require
 * language-aware capitalization of Y, which is brittle for non-Latin
 * scripts.
 *
 * Pure function: no I/O, no state, no logging. Safe to call from edge or
 * test contexts.
 */

import type { VariantBody } from "@rawuser/shared";

const DASH_RE = /\s*[—–]\s*/g;

/** Replace em/en-dashes in a single string. */
export function sanitizeString(s: string): string {
  return (
    s
      .replace(DASH_RE, ", ")
      // Normalize accidental ", ," (e.g. " — , " edge cases)
      .replace(/,\s*,/g, ",")
      // Normalize " ," → "," (em-dash sometimes had trailing space variant)
      .replace(/\s+,/g, ",")
      .trim()
  );
}

/** Walk a sections subtree and sanitize all leaf string values in place. */
function sanitizeSubtree(node: unknown): void {
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === "string") {
      obj[key] = sanitizeString(value);
    } else if (value !== null && typeof value === "object") {
      sanitizeSubtree(value);
    }
  }
}

/**
 * Returns a NEW VariantBody with all sections fields sanitized.
 *
 * Does not mutate the input. Top-level metadata fields (customer_id,
 * profile_key, prompt_hash, generated_at) are passed through unchanged.
 */
export function sanitizeVariantBody(variant: VariantBody): VariantBody {
  const cloned = JSON.parse(JSON.stringify(variant)) as VariantBody;
  sanitizeSubtree(cloned.sections);
  return cloned;
}
