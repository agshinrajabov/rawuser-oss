/**
 * The holdout arm (docs/specs/proof-engine.md, section A; ADR 0022 and its
 * 2026-10-04 amendment).
 *
 * A visit is in the experiment only when the edge found a version for its
 * page and the tab sent a valid visit marker (docs/specs/visit-marker.md)
 * and the customer's percent is above 0. Then SHA-256(customer_id | visit),
 * the first four bytes as an unsigned integer mod 100, below the percent is
 * "holdout", else "treat": uniform over visits, constant within a visit.
 *
 * Not the first byte mod 100 (the hash until 2026-10-04): 256 is not a
 * multiple of 100, so buckets 0 to 55 came up three times in 256 and 56 to
 * 99 twice. A set 20% held out 23.4% of visits and 10% held out 11.7%, and
 * the split check would have failed every test. Four bytes leave a bias
 * below one in forty million.
 *
 * No user agent and no clock (privacy review condition 5, 2026-10-03):
 * the old browser-build-plus-hour hash put a whole hour of one browser build
 * in one arm and is gone, not kept as a fallback. Without a marker there is
 * no arm: the visit gets its version and is not in the test.
 *
 * Nothing is stored here: the hash is computed, the arm returned.
 */

import { HOLDOUT_CAP, type VisitorBundle, clampHoldout } from "@rawuser/shared";

/** The env default when HOLDOUT_PERCENT is unset or malformed (development). */
export const HOLDOUT_PERCENT = 10;

export type Arm = "treat" | "holdout";

/** The percent from the HOLDOUT_PERCENT env var: an integer 0 to 100 (capped at 50), else the default. */
export function holdoutPercent(raw: string | undefined): number {
  if (raw === undefined || raw === "") return HOLDOUT_PERCENT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? Math.min(n, HOLDOUT_CAP) : HOLDOUT_PERCENT;
}

/**
 * The customer's percent for this answer: the bundle's `h`, else the env
 * default, capped at 50. No bundle at all (a cold miss before the
 * write-back) means no holdout.
 */
export function bundleHoldout(
  bundle: VisitorBundle | null | undefined,
  envRaw: string | undefined,
): number {
  if (!bundle || bundle.v !== 1) return 0;
  return clampHoldout(bundle.h) ?? holdoutPercent(envRaw);
}

/**
 * The visit's arm, or null when the visit is not in the experiment (no
 * marker, or the percent is 0). The marker must already be validated
 * (parseVisit); the caller has already found a version for the page.
 */
export async function decideArm(
  customerId: string,
  visit: string | null,
  percent: number,
): Promise<Arm | null> {
  if (!visit || !(percent > 0)) return null;
  const capped = Math.min(percent, HOLDOUT_CAP);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${customerId}|${visit}`),
  );
  const bucket = new DataView(digest).getUint32(0) % 100;
  return bucket < capped ? "holdout" : "treat";
}
