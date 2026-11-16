/**
 * UTM parameter extraction.
 *
 * Rules:
 * - Keys are lower-cased (UTM_CAMPAIGN == utm_campaign).
 * - Values are trimmed and lower-cased for consistent matching.
 * - Empty strings (after trim) are dropped — not stored in Signals.utm.
 * - Only the five standard UTM parameters are extracted.
 */

import type { Signals } from "../types.ts";

/** The shape of the parsed UTM object (same as Signals["utm"]). */
type UtmParams = Signals["utm"];

/**
 * Parses UTM parameters from a URL.
 *
 * @param url - Already-parsed URL object (caller owns the parse once).
 * @returns A (possibly empty) object with only the present UTM keys.
 */
export function parseUtm(url: URL): UtmParams {
  const result: UtmParams = {};

  const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

  for (const key of keys) {
    // Case-insensitive: iterate over all params and find matching key.
    let value: string | null = null;
    for (const [paramKey, paramValue] of url.searchParams.entries()) {
      if (paramKey.toLowerCase() === key) {
        value = paramValue;
        break;
      }
    }

    if (value === null) continue;

    const trimmed = value.trim().toLowerCase();
    if (!trimmed) continue; // Drop empty strings after trim.

    const shortKey = key.slice("utm_".length) as keyof UtmParams;
    result[shortKey] = trimmed;
  }

  return result;
}
