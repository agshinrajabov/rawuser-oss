/**
 * What `/event` reads from the visitor bundle, in one read (2026-10-12).
 *
 * `/event` needs two things the bundle holds and the request does not: the
 * audit's host and end (audit.ts) and whether the customer is sensitive with
 * its kept sections (sensitive.ts, docs/specs/sensitive-customers.md). Both
 * come from the same KV value `/select` answers from, read once per customer
 * per isolate per four minutes, in `waitUntil`, never before the 202. The
 * memo follows the copy's rule (kv-copy.ts, privacy review answer 5 of
 * 2026-10-26): read at `cacheTtl` R (60 s), kept while `now - at + R <= 300
 * s`, counted from the KV read; before, five minutes on top of a 300 s read. Until
 * this file the audit read the bundle by itself; the read and its memo moved
 * here unchanged so the second reader costs no second read.
 *
 * The third reader is `ne` (docs/specs/readiness-check.md, privacy review
 * condition 2): a special-category yes not yet marked, for which `/event`
 * stores nothing. The same read, one more field.
 *
 * The fourth is `co` (ADR 0036, point 6): the customer turned country
 * recording off, so `/event` writes no `events.country`. Same read.
 *
 * The fifth is `dx` (ADR 0038, part 1): the customer turned direct insights
 * off, so `/event` writes no `events.device_class` and no `events.web_view`.
 * Same read.
 *
 * Only the eight small fields are kept in memory, never the pages.
 */

import { type VisitorBundle, visitorBundleKey } from "@rawuser/shared";
import { COPY_BOUND_MS, KV_R_S } from "./kv-copy.ts";

/** The bundle fields `/event` acts on, as stored: each reader checks its own. */
export type EventBundleFields = Pick<
  VisitorBundle,
  "a" | "ad" | "ae" | "s" | "sk" | "ne" | "co" | "dx"
>;

export interface EventBundle {
  /**
   * True when KV answered with a bundle (`v === 1`). False when the key is
   * missing, the value is not a bundle, or the read failed: then nothing is
   * known about the customer from KV.
   */
  readable: boolean;
  /** The fields of whatever object KV held; null when it held none. */
  fields: EventBundleFields | null;
}

/** R of the bundle: the `cacheTtl` of this read and of every other reader. */
const EVENT_BUNDLE_CACHE_TTL_S = KV_R_S.bundle;
/** How long a read is kept: the 300 s bound less R, counted from the read. */
export const EVENT_BUNDLE_MEMO_MS = COPY_BOUND_MS - EVENT_BUNDLE_CACHE_TTL_S * 1000;
/** Past this many ids the memo starts again (a flood of made-up ids). */
const MEMO_MAX = 5000;

const UNREAD: EventBundle = { readable: false, fields: null };

const memos = new WeakMap<KVNamespace, Map<string, { bundle: EventBundle; until: number }>>();

/** A KV value is whatever was written: copy the eight fields, nothing else. */
function fieldsOf(value: unknown): EventBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return UNREAD;
  const b = value as EventBundleFields & { v?: unknown };
  const fields: EventBundleFields = {};
  if (b.a !== undefined) fields.a = b.a;
  if (b.ad !== undefined) fields.ad = b.ad;
  if (b.ae !== undefined) fields.ae = b.ae;
  if (b.s !== undefined) fields.s = b.s;
  if (b.sk !== undefined) fields.sk = b.sk;
  if (b.ne !== undefined) fields.ne = b.ne;
  if (b.co !== undefined) fields.co = b.co;
  if (b.dx !== undefined) fields.dx = b.dx;
  return { readable: b.v === 1, fields };
}

/**
 * The customer's bundle fields for `/event`: one KV read per customer per
 * isolate per four minutes (EVENT_BUNDLE_MEMO_MS). A failed read is not remembered (the next event
 * reads again) and answers as unread, the same choice as the tombstone read
 * (closed.ts). A missing key is remembered like any answer.
 */
export async function eventBundleFor(
  kv: KVNamespace,
  customerId: string,
  now = Date.now(),
): Promise<EventBundle> {
  let memo = memos.get(kv);
  if (!memo) {
    memo = new Map();
    memos.set(kv, memo);
  }
  const hit = memo.get(customerId);
  // Kept while `now - at + R <= 300 s`: `until` is the read's start plus the bound less R.
  if (hit && now <= hit.until) return hit.bundle;
  let bundle: EventBundle;
  try {
    bundle = fieldsOf(
      await kv.get(visitorBundleKey(customerId), {
        type: "json",
        cacheTtl: EVENT_BUNDLE_CACHE_TTL_S,
      }),
    );
  } catch {
    return UNREAD;
  }
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(customerId, { bundle, until: now + EVENT_BUNDLE_MEMO_MS });
  return bundle;
}
