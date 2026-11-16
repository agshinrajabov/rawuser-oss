/**
 * The learning counters without a sensitive customer's rows
 * (docs/specs/sensitive-customers.md, rule 3: its data enters no
 * cross-customer count).
 *
 * ua_token_counts and signal_token_counts hold no customer, only a bucket:
 * the first byte of SHA-256("{customer}|{week}") as two hex characters
 * (packages/edge/src/ua-tokens.ts `customerBucket`). The edge writes no
 * counter for a sensitive customer; as a second line the two proposal
 * scripts leave out the week's buckets of every sensitive customer, so a
 * row counted before a customer was marked is never shown to a human.
 * Another customer that shares a bucket (1 in 256) is left out with it,
 * which only makes "seen across customers" stricter.
 *
 * The same formula as packages/generation/src/lib/sensitive-guard.ts
 * (parity test: packages/generation/test/cron/sensitive-cross-customer.test.ts).
 */

import { createHash } from "node:crypto";

/** The bucket a customer's counters are filed under in a week. */
export function bucketOf(customerId: string, week: string): string {
  return createHash("sha256").update(`${customerId}|${week}`).digest("hex").slice(0, 2);
}

/**
 * The SQL that leaves the customers' buckets of the week out:
 * ` AND customer_bucket NOT IN ('3f', 'a1')`, or nothing for no customer.
 * A bucket is two hex characters, so it is safe inside the statement.
 */
export function withoutBuckets(customerIds: readonly string[], week: string): string {
  const buckets = [...new Set(customerIds.map((id) => bucketOf(id, week)))].sort();
  return buckets.length > 0
    ? ` AND customer_bucket NOT IN (${buckets.map((b) => `'${b}'`).join(", ")})`
    : "";
}

/** The read both scripts make first; it fails, and the script stops, before migration 0042. */
export const SENSITIVE_IDS_SQL = "SELECT id FROM customers WHERE sensitive = 1";
