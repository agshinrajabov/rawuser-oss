/**
 * The D1 `variants` row of a cell: its status, its provenance and, since
 * the proof engine, the id of its live body (docs/specs/proof-engine.md, C).
 * Moved out of orchestrator.ts (2026-10-04) so publishVersion can write the
 * ready row without a circular import. An error row never touches body_id:
 * the live body keeps serving and keeps its id.
 */

import type { IntentDim, MarketSource, SourceDim } from "@rawuser/shared";
import { INTENT_DIMENSIONS, marketSource } from "@rawuser/shared";
import type { GenerateResult } from "../generateVariant.ts";
import { GENERATED_SOURCE_DIMS } from "../prompts/source-modifiers.ts";

/**
 * The mark of a first write that was already tried again
 * (docs/specs/refused-versions.md, "A first write tries again at once"),
 * kept in the error row's own `lint_flags`: no migration, and the row says
 * what happened to it. A ready write puts the version's own flags there.
 */
export const FIRST_WRITE_RETRIED = "first-write-retried";

/**
 * A row that has never been ready: no body id, and no cost, which only a
 * ready write records (an error row is inserted with 0 and an error on an
 * existing row leaves the cost as it was). `t` is the table's name or alias.
 */
export function neverReadySql(t = "variants"): string {
  return `(${t}.body_id IS NULL AND ${t}.cost_usd = 0)`;
}

/**
 * An error row the queue tries again on its next pass instead of leaving it
 * for six hours: a first write the copy checks refused ("lint:"), not yet
 * tried again. A provider failure is not one, and a rewrite that failed is
 * not one (its older body serves meanwhile).
 */
/**
 * An error row whose model did not answer (call-model.ts PROVIDER_DOWN: a
 * timeout, a 5xx, a request that failed), as opposed to words the checks
 * refused or a broken answer. Such a try costs nothing, so the queue tries
 * it again after `PROVIDER_RETRY_MS`, not six hours (2026-10-18): a
 * customer that goes live during an outage gets its versions within
 * minutes of the provider coming back.
 */
export function providerDownSql(t = "variants"): string {
  const r = `COALESCE(${t}.error_reason, '')`;
  return `(${r} NOT LIKE 'lint:%' AND (${r} LIKE '%Timeout after%' OR ${r} LIKE '%HTTP 5%' OR ${r} LIKE '%request failed%' OR ${r} LIKE '%fetch failed%' OR ${r} LIKE '%network%'))`;
}

export function firstWriteRetryDueSql(t = "variants"): string {
  return `(${neverReadySql(t)} AND ${t}.error_reason LIKE 'lint:%' AND COALESCE(${t}.lint_flags, '') NOT LIKE '%${FIRST_WRITE_RETRIED}%')`;
}

/** A literal for `LIKE ? ESCAPE '\'`: its own `%`, `_` and `\` match only themselves. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

/**
 * The WHERE piece (and its binds) for the version rows of ONE page. The
 * variants table has no page column; the page lives in the key:
 *
 *   `/`      v1:variant:{cid}:{intent}:{source}
 *   `/start` v1:variant:{cid}:p:%2Fstart:{intent}:{source}
 *
 * So the home page is every key of the customer that is not a path key: the
 * prefix alone matches all pages (J6 of docs/specs/pilot-gaps.md:
 * "Regenerate, this page only" on the homepage marked every page stale). And
 * a path's own `%2F` is a LIKE wildcard unless escaped: unescaped, `/approach`
 * also matched `/az/approach`. Pass a normalized path, as the keys are built.
 */
export function pageKeyWhere(
  customerId: string,
  pagePath: string,
  column = "kv_key",
): { sql: string; binds: string[] } {
  const root = likeLiteral(`v1:variant:${customerId}:`);
  if (pagePath === "/") {
    return {
      sql: `${column} LIKE ? ESCAPE '\\' AND ${column} NOT LIKE ? ESCAPE '\\'`,
      binds: [`${root}%`, `${root}p:%`],
    };
  }
  return {
    sql: `${column} LIKE ? ESCAPE '\\'`,
    binds: [`${root}p:${likeLiteral(encodeURIComponent(pagePath))}:%`],
  };
}

/** One (intent, source) cell of a page. */
export interface GenerationTuple {
  intent_dim: IntentDim;
  /** `mk-{cc}` for a market version (docs/specs/direct-visitors.md §5). */
  source_dim: SourceDim | "default" | MarketSource;
}

/**
 * The tuples of one page: each served intent × (default + the four
 * generated sources), then one `brand` cell per market. An intent the site does not serve is not written; its
 * earlier versions stay in KV, unused (the founder's decision 5).
 */
export function buildTuples(
  served?: readonly IntentDim[] | null,
  markets: readonly string[] = [],
): GenerationTuple[] {
  const tuples: GenerationTuple[] = [];

  for (const intentDim of INTENT_DIMENSIONS) {
    if (served && !served.includes(intentDim)) continue;
    // Base intent variant (source = "default")
    tuples.push({ intent_dim: intentDim, source_dim: "default" });

    // Source-specialized variants
    for (const sourceDim of GENERATED_SOURCE_DIMS) {
      tuples.push({ intent_dim: intentDim, source_dim: sourceDim });
    }
  }

  // One market version per market (docs/specs/direct-visitors.md §5): the
  // intent of a visit with no reason, `brand`, always served.
  for (const cc of markets) tuples.push({ intent_dim: "brand", source_dim: marketSource(cc) });

  return tuples;
}

/**
 * The ready row of a cell after a body went live. A body that waited for the
 * customer's OK (docs/specs/versions-approval.md) waits no more: a published
 * body, approved or written at once, clears the cell's waiting one.
 */
export async function writeVariantRow(
  customerId: string,
  tuple: GenerationTuple,
  kvKey: string,
  result: Pick<GenerateResult, "model" | "promptHash" | "costUsd">,
  db: D1Database,
  pagePath = "/",
  lintFlags: readonly string[] = [],
  bodyId: string | null = null,
): Promise<void> {
  const id = deterministicId(customerId, tuple.intent_dim, tuple.source_dim, pagePath);
  const profileId = await lookupProfileId(tuple.intent_dim, db);

  await db
    .prepare(
      `INSERT INTO variants
         (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status, error_reason, lint_flags, body_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kv_key = excluded.kv_key,
         model = excluded.model,
         prompt_hash = excluded.prompt_hash,
         generated_at = excluded.generated_at,
         cost_usd = excluded.cost_usd,
         status = 'ready',
         error_reason = NULL,
         lint_flags = excluded.lint_flags,
         body_id = excluded.body_id,
         pending_body_id = NULL,
         pending_at = NULL`,
    )
    .bind(
      id,
      customerId,
      profileId,
      kvKey,
      result.model,
      result.promptHash,
      Date.now(),
      result.costUsd,
      lintFlags.length > 0 ? JSON.stringify(lintFlags) : null,
      bodyId,
    )
    .run();
}

/**
 * The error row of a cell. A first failure inserts it; a failure of a row
 * that is already an error and was never ready is its second, and marks it
 * `first-write-retried`, so the queue's one early retry is not a loop.
 * `generated_at` is not moved by an error: it stays the time of the last
 * ready write, or of the first failure of a row that never was ready. The
 * time of the last failed try is kept apart, in KV (tried-marker.ts); the
 * orchestrator writes it with this row.
 */
export async function writeErrorRow(
  customerId: string,
  tuple: GenerationTuple,
  kvKey: string,
  reason: string,
  db: D1Database,
  pagePath: string,
  /** The id of the model the call was routed to: the row says what failed. */
  model: string,
): Promise<void> {
  const id = deterministicId(customerId, tuple.intent_dim, tuple.source_dim, pagePath);
  const profileId = await lookupProfileId(tuple.intent_dim, db);

  await db
    .prepare(
      `INSERT INTO variants
         (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status, error_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0.0, 'error', ?)
       ON CONFLICT(id) DO UPDATE SET
         lint_flags = CASE
           WHEN variants.status = 'error' AND ${neverReadySql()} THEN '["${FIRST_WRITE_RETRIED}"]'
           ELSE variants.lint_flags END,
         status = 'error',
         model = excluded.model,
         prompt_hash = excluded.prompt_hash,
         error_reason = excluded.error_reason`,
    )
    .bind(
      id,
      customerId,
      profileId,
      kvKey,
      model,
      `error:${reason.slice(0, 200)}`,
      Date.now(),
      // Full-ish reason for diagnosis (the prompt_hash slot above keeps its
      // legacy 200-char copy for back-compat with anything parsing it).
      reason.slice(0, 500),
    )
    .run();
}

/** Looks up the global intent profile ID for a given intent dim. */
export async function lookupProfileId(intentDim: IntentDim, db: D1Database): Promise<string> {
  const row = await db
    .prepare(
      `SELECT id FROM intent_profiles
       WHERE profile_key = ? AND customer_id IS NULL
       LIMIT 1`,
    )
    .bind(`intent:${intentDim}`)
    .first<{ id: string }>();

  if (!row) {
    throw new Error(`No global intent_profile found for intent:${intentDim}`);
  }
  return row.id;
}

/**
 * Deterministic variant row ID from (customer_id, intent_dim, source_dim).
 * Re-running for the same customer+tuple uses ON CONFLICT REPLACE.
 */
export function deterministicId(
  customerId: string,
  intentDim: string,
  sourceDim: string,
  pagePath = "/",
): string {
  // Simple deterministic key: prefix + content hash-like string
  // Using btoa for brevity: not cryptographic, just unique.
  //
  // Path-aware (A1 per-path variants): the root '/' keeps the historical
  // id shape so existing rows never move; non-root paths get an encoded
  // `:p:<encoded>` segment. Mirrors variantKeyForPath so the D1 row id and
  // the KV key stay in lockstep and '/' vs '/start' never collide on one id.
  const seg = pagePath === "/" ? "" : `:p:${encodeURIComponent(pagePath)}`;
  const raw = `gen:${customerId}${seg}:${intentDim}:${sourceDim}`;
  return raw.replace(/[^a-z0-9_:-]/gi, "_").slice(0, 64);
}
