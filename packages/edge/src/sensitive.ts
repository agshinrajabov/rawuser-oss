/**
 * A customer whose site is about health or another special category, at the
 * edge (docs/specs/sensitive-customers.md; the privacy review's ruling of
 * 2026-10-12, seven conditions). The rule itself is shared
 * (@rawuser/shared sensitive.ts); this file reads its inputs and applies it
 * to one event row.
 *
 * For such a customer no row holding a visit marker names a product or topic
 * page (condition 1): `/event` stores the path as `storedPath` returns it and
 * the `variant_key` as `storedVariantKey` does, for every event type, and
 * counts the load in `page_days` under the full masked path with no marker,
 * source, intent, arm or time beside it (condition 4).
 *
 * Where the flag comes from, in this order (condition 3, fail closed):
 * 1. the visitor bundle in KV (`s`, `sk`), the read `/event` already makes
 *    for the audit (event-bundle.ts): no read added;
 * 2. no readable bundle: the customers row in D1 (`SENSITIVE_CUSTOMER_SQL`),
 *    inside the same `waitUntil`. This is not the visitor path: the 202 is
 *    already out, so the read adds nothing to the answer. Its answer is kept
 *    five minutes per isolate. A D1 answer is current when read, so five
 *    minutes is its whole age; a flag changed in D1 reaches `/event` within
 *    about ten minutes in all (sensitive-customers.md, "Ten minutes"), as
 *    the bundle's KV propagation plus the 300 s bound give on path 1;
 * 3. that read fails: nothing is known, so the row is stored with
 *    `FAIL_CLOSED_PATH` and a NULL `variant_key`, and no counter row.
 *
 * Nothing here reaches a browser (condition 5): no answer and no script
 * reads `s` or `sk`, and no event column or `properties` key holds the flag.
 *
 * "No events" (docs/specs/readiness-check.md, "As approved"; the privacy review's
 * condition 2 there): a customer that answered yes to the special-category
 * question and is not yet marked carries `ne: 1` in the same bundle. For it
 * `/event` stores no row and counts nothing, and `/select`'s learning
 * counters skip it. The flag comes from the same places in the same order:
 * the bundle read `/event` already makes, else the customers row (the same
 * D1 read as the sensitive flag's, one more column), else nothing is known
 * and the row is stored fail closed as above. Like `s`, `ne` is for the edge
 * alone (condition 4): nothing a browser gets differs by it.
 */

import {
  type BundleCountryRow,
  type BundleNoEventsRow,
  FAIL_CLOSED_PATH,
  PAGE_DAY_EVENT_TYPES,
  type SensitiveCustomerRow,
  type SensitiveSettings,
  type VisitorBundle,
  bundleCountryFields,
  bundleNoEventsFields,
  bundleSensitive,
  pageDayOf,
  pageDayPath,
  sensitiveSettingsFrom,
  storedPath,
  storedVariantKey,
} from "@rawuser/shared";
import type { EventBundle } from "./event-bundle.ts";

/** The settings a bundle that was read gives, or null when none was read. */
export function sensitiveOfBundle(bundle: EventBundle): SensitiveSettings | null {
  return bundle.readable ? bundleSensitive(bundle.fields) : null;
}

/**
 * What `/event` needs to know about the customer before it writes: the
 * sensitive settings and whether it stores nothing at all (`ne`).
 */
export interface EventCustomer {
  settings: SensitiveSettings;
  /** True while the special-category yes is not yet marked: no row, no counter. */
  ne: boolean;
  /** True when the customer turned country recording off (ADR 0036): no `events.country`. */
  countryOff: boolean;
  /** True when the customer turned direct insights off (ADR 0038): no device class, no web view. */
  directOff: boolean;
}

/** Both facts from a bundle that was read, or null when none was read. */
export function customerOfBundle(bundle: EventBundle): EventCustomer | null {
  if (!bundle.readable) return null;
  return {
    settings: bundleSensitive(bundle.fields),
    ne: bundle.fields?.ne === 1,
    countryOff: bundle.fields?.co === 1,
    directOff: bundle.fields?.dx === 1,
  };
}

/**
 * Whether cross-customer counting may run for the customer of this `/select`
 * (spec, the rule's point 3): only when its bundle was read and says neither
 * sensitive nor `ne`. Without a bundle nothing is known, and the counters
 * wait for the next visit rather than count a customer that may be
 * sensitive; no read is made to find out.
 */
export function mayCountAcrossCustomers(bundle: VisitorBundle | null | undefined): boolean {
  if (!bundle || typeof bundle !== "object" || bundle.v !== 1) return false;
  return !bundleSensitive(bundle).sensitive && bundle.ne !== 1;
}

export const SENSITIVE_MEMO_MS = 5 * 60 * 1000;
/** Past this many ids the memo starts again (a flood of made-up ids). */
const MEMO_MAX = 5000;

const memos = new WeakMap<D1Database, Map<string, { customer: EventCustomer; until: number }>>();

/**
 * The read `/event` makes when the bundle cannot answer: the sensitive flag
 * and the kept list (migration 0042) and the special-category answer
 * (migration 0044), one statement. It names `special_category`, so the
 * migration is applied before this edge is deployed; until then the read
 * fails and every such row is stored fail closed. The country switch
 * (`country_off`, migration 0048) and the direct-insights switch
 * (`direct_insights_off`, migration 0050) ride in the same read.
 */
export const EVENT_CUSTOMER_SQL =
  "SELECT sensitive, kept_sections, special_category, country_off, direct_insights_off FROM customers WHERE id = ?";

/** The row EVENT_CUSTOMER_SQL returns. */
export type EventCustomerRow = SensitiveCustomerRow & BundleNoEventsRow & BundleCountryRow;

/** Both facts from a customers row, by the shared rules; no row is neither. */
export function eventCustomerFrom(row: EventCustomerRow | null | undefined): EventCustomer {
  return {
    settings: sensitiveSettingsFrom(row),
    ne: bundleNoEventsFields(row).ne === 1,
    countryOff: bundleCountryFields(row).co === 1,
    directOff: bundleCountryFields(row).dx === 1,
  };
}

/**
 * The flag, the list and `ne` from the customers row, for an event whose
 * bundle could not be read. One D1 read per customer per isolate per five
 * minutes; a failed read is not remembered and answers null (nothing known,
 * the caller fails closed). No row is not sensitive and not `ne`, as the
 * contract says.
 */
export async function eventCustomerFromD1(
  db: D1Database,
  customerId: string,
  now = Date.now(),
): Promise<EventCustomer | null> {
  let memo = memos.get(db);
  if (!memo) {
    memo = new Map();
    memos.set(db, memo);
  }
  const hit = memo.get(customerId);
  if (hit && hit.until > now) return hit.customer;
  let customer: EventCustomer;
  try {
    customer = eventCustomerFrom(
      await db.prepare(EVENT_CUSTOMER_SQL).bind(customerId).first<EventCustomerRow>(),
    );
  } catch {
    return null;
  }
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(customerId, { customer, until: now + SENSITIVE_MEMO_MS });
  return customer;
}

/** What one event row stores, and the load it counts, once the settings are known. */
export interface StoredEventPage {
  page_path: string;
  variant_key: string | null;
  /**
   * The bind values of `PAGE_DAYS_UPSERT_SQL`, exactly (customer_id, day,
   * page_path), or null when no load is counted. Nothing else of the event
   * is passed on: no marker, source, intent, arm or time of day.
   */
  pageDay: [customerId: string, day: string, pagePath: string] | null;
}

/**
 * The path and key one event row stores.
 *
 * - `settings` null (neither the bundle nor the database answered): the
 *   group of everything and no key, no counter.
 * - not sensitive: the row as it was, untouched, no counter.
 * - sensitive: the stored path and key, and for an exposure type one load
 *   under the full masked path on the UTC day of `ts`.
 *
 * `maskedPath` is `sanitizePath`'s output: `maskPath` has already run.
 */
export function storedEventPage(
  settings: SensitiveSettings | null,
  customerId: string,
  eventType: string,
  maskedPath: string,
  variantKey: string | null,
  ts: number,
): StoredEventPage {
  if (settings === null) {
    return { page_path: FAIL_CLOSED_PATH, variant_key: null, pageDay: null };
  }
  if (!settings.sensitive) {
    return { page_path: maskedPath, variant_key: variantKey, pageDay: null };
  }
  return {
    page_path: storedPath(maskedPath, settings.kept),
    variant_key: storedVariantKey(variantKey, settings.kept, customerId),
    pageDay: PAGE_DAY_EVENT_TYPES.includes(eventType)
      ? [customerId, pageDayOf(ts), pageDayPath(maskedPath)]
      : null,
  };
}
