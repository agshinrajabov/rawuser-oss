/**
 * A deleted customer's tombstone, `v1:closed:{id}` (docs/specs/
 * security-hardening.md §6, condition 1; ai-traffic-audit.md §8, condition
 * 2). While it exists a forgotten tag records nothing: `/s/{id}.js` serves
 * the off script, `/select` the record-nothing answer (no bundle written
 * back), `/event` drops the row.
 *
 * The read rides in each handler's existing KV batch, never a round trip of
 * its own. It goes through the copy of kv-copy.ts: read from KV at
 * `cacheTtl` 60 s (R), kept in the isolate's memory (and, on routes that
 * pass a location cache, in the Cache API) only while `now - at + R <= 300
 * s`, counted from the KV read. So `/event` (no KV on a normal event since
 * event-capacity A) costs at most one read per customer per isolate per four
 * minutes. As built (2026-10-26): a delete reaches every route within KV's
 * propagation (about 60 s) plus 300 s, about six minutes; until then a
 * request may still be answered as open. A closed id stays closed. Before
 * this build the memo's five minutes sat on top of a 300 s KV read, about
 * ten minutes in all.
 */

import { closedKey } from "@rawuser/shared";
import { COPY_BOUND_MS, type CopyIo, KV_R_S, inMemory, readThrough } from "./kv-copy.ts";

/** How long an isolate keeps a tombstone read: the 300 s bound less R, from the read. */
export const CLOSED_MEMO_MS = COPY_BOUND_MS - KV_R_S.closed * 1000;

export async function isClosed(
  kv: KVNamespace,
  customerId: string,
  now = Date.now(),
  io: Omit<CopyIo, "now"> = {},
): Promise<boolean> {
  try {
    const read = await readThrough(kv, closedKey(customerId), "closed", "text", { ...io, now });
    return read.value !== null && read.value !== undefined;
  } catch {
    // A failed read is not a tombstone, and is not kept; the next request reads again.
    return false;
  }
}

/**
 * True only when this isolate already holds the tombstone, inside its bound.
 * No read: the tag's location copy (customer-script.ts) asks this before it
 * serves a copy, so a customer this isolate saw deleted never gets its old
 * script from the copy.
 */
export function closedInMemo(kv: KVNamespace, customerId: string, now = Date.now()): boolean {
  const k = inMemory(kv, closedKey(customerId), now);
  return k !== null && k.v !== null && k.v !== undefined;
}
