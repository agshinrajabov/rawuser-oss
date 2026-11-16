/**
 * What the five-minute write queue has to do for a customer, decided before
 * anything is read from the customer's site (J7 of
 * docs/specs/pilot-gaps.md).
 *
 * The queue used to pick every customer with a row that was not ready. A
 * refused row waits six hours for its next try (lib/tried-marker.ts), so for
 * those six hours its customer was picked on every pass, and each pick ran
 * the orchestrator far enough to read the customer's site from our server
 * and then write nothing: every confirmed page for the live read
 * (inline-shape-backfill.ts, once per ten minutes per isolate, with its
 * `manifest_health` row) and the home page once more for the style samples
 * (page-samples.ts, on every pass).
 *
 * One rule now says both things: a version key is settled when its row is
 * ready or is an error waiting out its six hours (`loadReadyKvKeys`, the set
 * the orchestrator skips), and a customer has work when one of the keys a
 * pass would write is not settled (`hasDueWork`, what the queue's pick
 * asks). The pick and the pass cannot disagree: both read the same set.
 *
 * D1 and the tried markers in KV only. Nothing here fetches a page.
 */

import type { Manifest } from "@rawuser/shared";
import { variantKeyForPath } from "@rawuser/shared";
import { loadServedIntents } from "../site-map/served-load.ts";
import { nothingToWrite } from "./button-rewrite.ts";
import { loadMarkets } from "./markets.ts";
import { triedWithin } from "./tried-marker.ts";
import { buildTuples, firstWriteRetryDueSql, providerDownSql } from "./variant-rows.ts";

/**
 * Rows whose job is done: a ready body, a body waiting for the customer's OK
 * on a cell that never had one ('pending'), and such a body the customer
 * discarded ('discarded'). Neither the queue nor a pass writes them by
 * itself (docs/specs/versions-approval.md).
 */
export const SETTLED_STATUSES = "'ready', 'pending', 'discarded'";

/** How long the queue leaves a row whose model did not answer (providerDownSql). */
export const PROVIDER_RETRY_MS = 15 * 60_000;

/**
 * Loads the set of kv_keys that currently have a 'ready' variant for a
 * customer (across all paths). Used by orchestrate({ onlyMissing }) to skip
 * tuples that don't need regenerating. Errored/stale/missing tuples are absent.
 * With `skipErrorsYoungerThanMs` (the queue), an error row that is waiting
 * out its six hours is in the set too: the pass leaves it alone.
 */
export async function loadReadyKvKeys(
  customerId: string,
  db: D1Database,
  skipErrorsYoungerThanMs?: number,
  kv?: KVNamespace,
): Promise<Set<string>> {
  if (skipErrorsYoungerThanMs === undefined) {
    const rows = await db
      .prepare(
        `SELECT kv_key FROM variants WHERE customer_id = ? AND status IN (${SETTLED_STATUSES})`,
      )
      .bind(customerId)
      .all<{ kv_key: string }>();
    return new Set((rows.results ?? []).map((r) => r.kv_key));
  }
  // An error row is "left alone" by listing it with the ready ones: the
  // queue retries a stubborn row on the old six-hour rhythm, not every five
  // minutes (2026-09-16). Two clocks say whether it is left alone:
  // - `generated_at`, the row's last ready write, or the first failure of a
  //   row that never was ready (an error never moves it);
  // - the time of its last failed try, kept in KV (lib/tried-marker.ts,
  //   2026-10-12, J5): without it a row whose last ready write was over six
  //   hours old was tried, and paid for, on every pass.
  // One exception (2026-10-12, docs/specs/refused-versions.md): a first
  // write the copy checks refused has no version at all, so it is tried once
  // more on the next pass whatever the clocks say; its second failure marks
  // the row and the wait applies.
  // A row whose model did not answer is held by its last try alone, for
  // `PROVIDER_RETRY_MS` (2026-10-18): the six hours are for rows that cost a
  // version each time.
  const cutoff = Date.now() - skipErrorsYoungerThanMs;
  const rows = await db
    .prepare(
      `SELECT kv_key FROM variants WHERE customer_id = ? AND (status IN (${SETTLED_STATUSES}) OR (status = 'error' AND generated_at > ? AND NOT ${firstWriteRetryDueSql()} AND NOT ${providerDownSql()}))`,
    )
    .bind(customerId, cutoff)
    .all<{ kv_key: string }>();
  const out = new Set((rows.results ?? []).map((r) => r.kv_key));
  if (!kv) return out;
  // The error rows the first clock does not hold: one KV read each.
  const old = await db
    .prepare(
      `SELECT kv_key, ${providerDownSql()} AS provider FROM variants WHERE customer_id = ? AND status = 'error' AND NOT ${firstWriteRetryDueSql()} AND (generated_at <= ? OR ${providerDownSql()})`,
    )
    .bind(customerId, cutoff)
    .all<{ kv_key: string; provider: number }>();
  const held = (old.results ?? []).filter((r) => !out.has(r.kv_key));
  const providerMs = Math.min(PROVIDER_RETRY_MS, skipErrorsYoungerThanMs);
  const recent = await Promise.all(
    held.map((r) => triedWithin(kv, r.kv_key, r.provider ? providerMs : skipErrorsYoungerThanMs)),
  );
  held.forEach((r, i) => {
    if (recent[i]) out.add(r.kv_key);
  });
  return out;
}

/**
 * The pages a pass writes, as `orchestrate` chooses them, from the stored
 * manifests alone: every confirmed page that has a part to write (a page
 * whose every part is a button left as built has none); a customer with no
 * confirmed manifest keeps its one path-agnostic set on `/`. A manifest that
 * does not parse is skipped, as the pass skips it.
 */
export async function writtenPages(customerId: string, db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare(
      "SELECT page_path, manifest FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL",
    )
    .bind(customerId)
    .all<{ page_path: string; manifest: string }>();
  const confirmed: Array<{ pagePath: string; manifest: Manifest }> = [];
  for (const row of rows.results ?? []) {
    try {
      confirmed.push({ pagePath: row.page_path, manifest: JSON.parse(row.manifest) as Manifest });
    } catch {
      // not a page the pass writes
    }
  }
  if (confirmed.length === 0) return ["/"];
  return confirmed.filter((p) => !nothingToWrite(p.manifest)).map((p) => p.pagePath);
}

/**
 * True when a queue pass would try at least one version of this customer:
 * a key of its written pages and served intents whose row is stale, missing,
 * or an error past its wait (six hours from its last ready write and from
 * its last failed try, or a first write the copy checks refused that has not
 * had its one early retry).
 *
 * False when everything is ready or waiting. Then a pass would write nothing,
 * so the queue does not pick the customer and none of its pages is read. A
 * row that is not ready on a page that is no longer confirmed, or of an
 * intent the site folded, is not work either: no pass writes it.
 */
export async function hasDueWork(
  customerId: string,
  db: D1Database,
  kv: KVNamespace | undefined,
  skipErrorsYoungerThanMs: number,
): Promise<boolean> {
  const [settled, pages, served, markets] = await Promise.all([
    loadReadyKvKeys(customerId, db, skipErrorsYoungerThanMs, kv),
    writtenPages(customerId, db),
    // The pass's own read of the served set, so the two build the same keys.
    loadServedIntents(customerId, db),
    // And of the markets (docs/specs/direct-visitors.md §5).
    loadMarkets(customerId, db),
  ]);
  const tuples = buildTuples(served, markets);
  for (const page of pages) {
    for (const t of tuples) {
      if (!settled.has(variantKeyForPath(customerId, page, t.intent_dim, t.source_dim))) {
        return true;
      }
    }
  }
  return false;
}
