/**
 * Market versions (ADR 0038 part 5; docs/specs/direct-visitors.md §5): the
 * markets a customer's pages get a version for. The same rule as the
 * bundle's `mk` (bundleDirectFields), so the write queue writes exactly the
 * cells the edge may read: an explicit "no" to the special-category
 * question, not sensitive, not an audit, the switch on, a stored list.
 */

import { BUNDLE_DIRECT_SQL, type BundleDirectRow, bundleDirectFields } from "@rawuser/shared";

/** The customer's markets (upper-case ISO codes), or none. A failed read is none. */
export async function loadMarkets(customerId: string, db: D1Database): Promise<string[]> {
  try {
    const row = await db.prepare(BUNDLE_DIRECT_SQL).bind(customerId).first<BundleDirectRow>();
    return bundleDirectFields(row).mk ?? [];
  } catch {
    return [];
  }
}
