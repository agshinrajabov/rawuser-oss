/**
 * The five-minute write queue (2026-09-15). The dashboard's write loops run
 * in the operator's browser tab and stop when the laptop sleeps; a rewrite
 * of 90 versions once took a night. This cron finishes what the tab left:
 * every customer's missing, stale and errored rows, a few at a time, under
 * a per-customer lock so two invocations never write the same tuple.
 */

import { parseServed } from "@rawuser/shared";
import { AUDIT_MAX_SPEND } from "../audit/constants.ts";
import { SETTLED_STATUSES, hasDueWork } from "../lib/queue-due.ts";
import { modelConfigured } from "../model-config.ts";
import type { OrchestrateEnv, OrchestrationResult } from "../orchestrator.ts";

/**
 * An ended audit is never written again, and an audit past its spend cap
 * waits (docs/specs/ai-traffic-audit.md §3.8, §9). A row without a
 * customers row keeps its old behaviour.
 */
const WRITABLE = `COALESCE(c.status, 'active') != 'ended'
  AND NOT (COALESCE(c.plan, '') = 'audit' AND COALESCE(c.audit_spend_usd, 0) >= ${AUDIT_MAX_SPEND})`;

export const QUEUE_TUPLES_PER_RUN = 12;
/**
 * An errored row is retried on the old six-hour rhythm, not every five
 * minutes: six hours from its last failed try (lib/tried-marker.ts keeps
 * that time in KV, and its TTL is this number).
 */
export const QUEUE_ERROR_RETRY_MS = 6 * 60 * 60_000;
/** A lock outlives one invocation's worst case (12 tuples × ~45 s). */
const LOCK_TTL_S = 10 * 60;

export interface QueueEnv extends OrchestrateEnv {
  DB: D1Database;
  VARIANTS: KVNamespace;
}

export type OrchestrateFn = (
  customerId: string,
  env: OrchestrateEnv,
  opts: { onlyMissing: boolean; maxTuples: number; skipErrorsYoungerThanMs: number },
) => Promise<OrchestrationResult>;

export interface QueueResult {
  ran: string[];
  locked: string[];
  capped: string[];
}

export function lockKey(customerId: string): string {
  return `gen:lock:${customerId}`;
}

export async function runRegenQueue(
  env: QueueEnv,
  orchestrate: OrchestrateFn,
  tuplesPerRun: number = QUEUE_TUPLES_PER_RUN,
): Promise<QueueResult> {
  const result: QueueResult = { ran: [], locked: [], capped: [] };
  // The model is not configured in this isolate (seen right after a deploy,
  // when a pass ran without the secret): write nothing, so every row stays
  // as it is and the next pass, five minutes on, writes it. Before, each row
  // failed on authentication and waited six hours as an error.
  if (!modelConfigured(env)) {
    console.warn("[regen-queue] the model is not configured in this isolate; pass skipped");
    return result;
  }
  for (const id of await queueCustomers(env.DB, env.VARIANTS)) {
    const key = lockKey(id);
    try {
      if ((await env.VARIANTS.get(key)) !== null) {
        result.locked.push(id);
        continue;
      }
      await env.VARIANTS.put(key, String(Date.now()), { expirationTtl: LOCK_TTL_S });
    } catch {
      result.locked.push(id);
      continue;
    }
    try {
      const r = await orchestrate(id, env, {
        onlyMissing: true,
        maxTuples: tuplesPerRun,
        skipErrorsYoungerThanMs: QUEUE_ERROR_RETRY_MS,
      });
      result.ran.push(id);
      if (r.capped) result.capped.push(id);
      // The served set grew (site-shaped intents §7.3): once a pass finishes
      // the customer's missing versions, the flag is done.
      else if (!r.aborted) await clearWriteFlag(env.DB, id);
    } catch (e) {
      console.error(`[regen-queue] ${id}:`, e instanceof Error ? e.message : String(e));
    } finally {
      try {
        await env.VARIANTS.delete(key);
      } catch {
        // the TTL frees it
      }
    }
  }
  return result;
}

/** The intent of a version key: `v1:variant:{cid}:{intent}:{source}` or `...:p:{path}:{intent}:{source}`. */
export function intentOfKvKey(kvKey: string): string | null {
  const parts = kvKey.split(":");
  return (parts[3] === "p" ? parts[5] : parts[3]) ?? null;
}

/**
 * Customers with work for the queue: a row that is not ready for an intent
 * the site serves, or a served set that grew and is not written yet
 * (docs/specs/site-shaped-intents.md §7.3). A folded intent's stale row is
 * left alone: its versions stay in KV, unused (the founder's decision 5),
 * and a customer is never picked again and again for rows it will not write.
 *
 * And there must be work due (J7 of docs/specs/pilot-gaps.md,
 * lib/queue-due.ts). A customer whose rows that are not ready are all errors
 * waiting out their six hours has nothing a pass would write: picked, it had
 * its pages read from our server again and then wrote nothing, on every pass
 * of those six hours. It is picked again on the first pass after a row comes
 * due or goes stale. `kv` holds the time of each row's last failed try;
 * without it only the rows' own clock in D1 decides, as the pass itself does
 * without KV. A check that fails picks the customer, as before.
 *
 * A version that has no row at all names no customer, so until 2026-11-10 a
 * row was the only way in and a page added after the first go live was never
 * written by this queue: its versions have no rows, every older row is
 * settled, and the served set did not grow, so nothing picked the customer
 * and `hasDueWork`, which would have said yes, was never asked. Only the
 * dashboard's own loop wrote such a page, and it stops with the operator's
 * tab (the pilot's `/products`, 2 of 24 written, nothing after; the 6-hour cron
 * has not regenerated since 2026-09-15). Every live customer with a
 * confirmed page is a candidate now, and `hasDueWork` decides, so the queue
 * writes what is missing however the gap arose.
 */
export async function queueCustomers(db: D1Database, kv?: KVNamespace): Promise<string[]> {
  const [rows, flagged, live] = await Promise.all([
    db
      .prepare(
        `SELECT v.customer_id AS id, v.kv_key AS kv_key, c.served_intents AS served, c.site_map_off AS off
         FROM variants v LEFT JOIN customers c ON c.id = v.customer_id
         WHERE v.status NOT IN (${SETTLED_STATUSES}) AND ${WRITABLE}`,
      )
      .all<{ id: string; kv_key: string; served: string | null; off: number | null }>(),
    db
      .prepare(
        `SELECT c.id AS id FROM customers c WHERE c.live_at IS NOT NULL AND json_extract(c.served_reasons, '$.write_at') IS NOT NULL AND ${WRITABLE}`,
      )
      .all<{ id: string }>(),
    // A live customer with a confirmed page: its missing versions have no
    // rows to name it, so the row query above cannot see them.
    liveCustomers(db),
  ]);
  // Customers with a row that is not ready for a served intent, in the
  // rows' order.
  const candidates = new Set<string>();
  for (const r of rows.results ?? []) {
    if (candidates.has(r.id)) continue;
    const served = r.off === 1 ? null : parseServed(r.served);
    if (!served) {
      candidates.add(r.id);
      continue;
    }
    const intent = typeof r.kv_key === "string" ? intentOfKvKey(r.kv_key) : null;
    if (intent === null || (served as string[]).includes(intent)) candidates.add(r.id);
  }
  // Then every live customer with a page: `hasDueWork` builds the keys a
  // pass would write and answers no when they are all settled, so a
  // customer with nothing missing costs four reads and is not picked.
  for (const id of live) candidates.add(id);
  // A grown served set is written whatever its rows say; its flag is cleared
  // by the pass that finishes it.
  const grown = new Set((flagged.results ?? []).map((r) => r.id));
  const out: string[] = [];
  for (const id of candidates) {
    if (grown.has(id) || (await isDue(id, db, kv))) out.push(id);
  }
  for (const id of grown) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Every live, writable customer that has a confirmed page. This is the only
 * way a page whose versions have no rows reaches the queue, so it must never
 * cost a pass: a read that fails leaves the queue exactly as it was, picking
 * by row and by the grown flag.
 */
async function liveCustomers(db: D1Database): Promise<string[]> {
  try {
    const r = await db
      .prepare(
        `SELECT c.id AS id FROM customers c
          WHERE c.live_at IS NOT NULL AND ${WRITABLE}
            AND EXISTS (SELECT 1 FROM element_manifests m
                         WHERE m.customer_id = c.id AND m.confirmed_at IS NOT NULL)`,
      )
      .all<{ id: string }>();
    return (r.results ?? []).map((x) => x.id);
  } catch (e) {
    console.error(
      "[regen-queue] live customers read failed:",
      e instanceof Error ? e.message : String(e),
    );
    return [];
  }
}

/** `hasDueWork`, and yes when it cannot be asked: the pass decides then, as it always did. */
async function isDue(
  customerId: string,
  db: D1Database,
  kv: KVNamespace | undefined,
): Promise<boolean> {
  try {
    return await hasDueWork(customerId, db, kv, QUEUE_ERROR_RETRY_MS);
  } catch (e) {
    console.error(
      `[regen-queue] due check for ${customerId} failed:`,
      e instanceof Error ? e.message : String(e),
    );
    return true;
  }
}

async function clearWriteFlag(db: D1Database, customerId: string): Promise<void> {
  try {
    await db
      .prepare(
        "UPDATE customers SET served_reasons = json_remove(served_reasons, '$.write_at') WHERE id = ? AND json_extract(served_reasons, '$.write_at') IS NOT NULL",
      )
      .bind(customerId)
      .run();
  } catch {
    // The next pass clears it.
  }
}
