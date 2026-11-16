/**
 * The one way a version goes live (docs/specs/proof-engine.md, section C).
 *
 * publishVersion is the only code that writes a live variant key
 * (`v1:variant:...`). It computes the body's id, inserts the immutable body
 * into version_bodies, writes the KV value with `body_id` inside it, retires
 * the cell's previous body and points the `variants` row at the new one. A
 * static test (test/lib/publish-version.test.ts) fails the build when any
 * other source file writes a variant key.
 *
 * Order: the body row first, so any id a visitor reports resolves; then the
 * KV value; then the retirement and the status row. An errored rewrite
 * never reaches here, so the live body keeps serving, as before.
 *
 * Also here, because they write live keys too: the preview write (refuses a
 * live key) and the one-off backfill of bodies written before this existed.
 * Our generated text only; nothing about a visitor. version_bodies is per
 * customer, deleted with it, never read across customers (condition 8).
 */

import {
  type IntentDim,
  type MarketSource,
  type SourceDim,
  type VariantBody,
  computeBodyId,
  normalizePath,
  variantKeyForPath,
} from "@rawuser/shared";
import type { GenerateResult } from "../generateVariant.ts";
import { writeVariantRow } from "./variant-rows.ts";

export interface PublishEnv {
  DB: D1Database;
  VARIANTS: KVNamespace;
}

export interface VersionCell {
  customerId: string;
  pagePath: string;
  intentDim: IntentDim;
  /** A market version's cell has `mk-{cc}` (docs/specs/direct-visitors.md §5). */
  sourceDim: SourceDim | "default" | MarketSource;
  /** The path's language; read from its manifest when not given. */
  language?: string | null;
}

export type PublishProvenance = Pick<GenerateResult, "model" | "promptHash" | "costUsd"> & {
  lintFlags: readonly string[];
};

export interface Published {
  body_id: string;
  kv_key: string;
  /** The body as written, `body_id` inside (an off button's words never reach a browser: proof-engine.md). */
  body: VariantBody;
}

const LIVE_PREFIX = "v1:variant:";

async function pathLanguage(
  db: D1Database,
  customerId: string,
  pagePath: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT language FROM element_manifests WHERE customer_id = ? AND page_path = ?")
    .bind(customerId, pagePath)
    .first<{ language: string | null }>();
  return row?.language ?? null;
}

/** A body as its cell stores it: the path normalized, its key, its id, `body_id` inside. */
export interface CellBody {
  pagePath: string;
  kvKey: string;
  bodyId: string;
  served: VariantBody;
}

/** The id of `body` in `cell` and the body with it inside (no write). */
export async function cellBody(cell: VersionCell, body: VariantBody): Promise<CellBody> {
  const pagePath = normalizePath(cell.pagePath);
  const kvKey = variantKeyForPath(cell.customerId, pagePath, cell.intentDim, cell.sourceDim);
  const { body_id: _previous, ...clean } = body;
  const bodyId = await computeBodyId(
    {
      customer_id: cell.customerId,
      page_path: pagePath,
      intent_dim: cell.intentDim,
      source_dim: cell.sourceDim,
    },
    clean.sections,
  );
  return { pagePath, kvKey, bodyId, served: { ...clean, body_id: bodyId } };
}

/**
 * The immutable row of a body. The same words in the same cell are the same
 * id, so a second insert is ignored. `liveFrom` 0 is a body that waits for
 * the customer's OK (docs/specs/versions-approval.md): publishVersion sets
 * its time when it goes live.
 */
export async function insertBody(
  env: PublishEnv,
  cell: VersionCell,
  cb: CellBody,
  prov: PublishProvenance,
  liveFrom: number,
): Promise<void> {
  const language =
    cell.language !== undefined
      ? cell.language
      : await pathLanguage(env.DB, cell.customerId, cb.pagePath);
  const lintFlags = prov.lintFlags.length > 0 ? JSON.stringify(prov.lintFlags) : null;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO version_bodies
       (body_id, customer_id, page_path, intent_dim, source_dim, language, model, prompt_hash,
        lint_flags, body_json, live_from, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      cb.bodyId,
      cell.customerId,
      cb.pagePath,
      cell.intentDim,
      cell.sourceDim,
      language,
      prov.model,
      prov.promptHash,
      lintFlags,
      JSON.stringify(cb.served),
      liveFrom,
    )
    .run();
}

/**
 * Put `body` live in its cell. Throws when a write fails (the caller records
 * the error). Approving a waiting body comes here too
 * (docs/specs/versions-approval.md): its row is already in version_bodies
 * with live_from 0, which gets the time it went live. A waiting body of the
 * cell that is not this one is replaced, so it is marked discarded.
 */
export async function publishVersion(
  env: PublishEnv,
  cell: VersionCell,
  body: VariantBody,
  prov: PublishProvenance,
  now = Date.now(),
): Promise<Published> {
  const cb = await cellBody(cell, body);
  const { pagePath, kvKey, bodyId, served } = cb;

  // 1. The immutable body. The same words in the same cell are the same id.
  await insertBody(env, cell, cb, prov, now);

  // 2. The live key, one value per cell as before; only its content changes.
  await env.VARIANTS.put(kvKey, JSON.stringify(served));

  // 3. The cell's previous body is retired; a body that comes back is live again.
  await env.DB.prepare(
    `UPDATE version_bodies SET retired_at = ?
     WHERE customer_id = ? AND page_path = ? AND intent_dim = ? AND source_dim = ?
       AND retired_at IS NULL AND body_id != ?`,
  )
    .bind(now, cell.customerId, pagePath, cell.intentDim, cell.sourceDim, bodyId)
    .run();
  await env.DB.prepare(
    `UPDATE version_bodies
     SET retired_at = NULL, discarded_at = NULL,
         live_from = CASE WHEN live_from = 0 THEN ? ELSE live_from END
     WHERE body_id = ? AND customer_id = ?`,
  )
    .bind(now, bodyId, cell.customerId)
    .run();
  // A body that waited in this cell and is not the one going live never will.
  await env.DB.prepare(
    `UPDATE version_bodies SET discarded_at = ?
     WHERE customer_id = ? AND body_id != ? AND discarded_at IS NULL
       AND body_id IN (SELECT pending_body_id FROM variants WHERE customer_id = ? AND kv_key = ?)`,
  )
    .bind(now, cell.customerId, bodyId, cell.customerId, kvKey)
    .run();
  await writeVariantRow(
    cell.customerId,
    { intent_dim: cell.intentDim, source_dim: cell.sourceDim },
    kvKey,
    prov,
    env.DB,
    pagePath,
    prov.lintFlags,
    bodyId,
  );

  return { body_id: bodyId, kv_key: kvKey, body: served };
}

/**
 * A preview body (script-first onboarding) under its own key with a TTL.
 * Never a live key: go-live promotes it with publishVersion.
 */
export async function putPreviewBody(
  env: Pick<PublishEnv, "VARIANTS">,
  key: string,
  body: VariantBody,
  ttlSeconds: number,
): Promise<void> {
  if (key.startsWith(LIVE_PREFIX)) {
    throw new Error("a preview body cannot be written to a live variant key");
  }
  await env.VARIANTS.put(key, JSON.stringify(body), { expirationTtl: ttlSeconds });
}

/** (page, intent, source) of a live key of this customer, or null. */
export function parseVariantKey(
  key: string,
  customerId: string,
): { pagePath: string; intentDim: string; sourceDim: string } | null {
  const prefix = `${LIVE_PREFIX}${customerId}:`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length).split(":");
  if (rest.length === 2)
    return { pagePath: "/", intentDim: rest[0] ?? "", sourceDim: rest[1] ?? "" };
  if (rest.length === 4 && rest[0] === "p") {
    return {
      pagePath: decodeURIComponent(rest[1] ?? ""),
      intentDim: rest[2] ?? "",
      sourceDim: rest[3] ?? "",
    };
  }
  return null;
}

export interface BodyBackfillResult {
  scanned: number;
  /** Bodies inserted or KV values given their id. */
  written: number;
  /** Rows whose KV value was gone, unreadable, or rewritten meanwhile. */
  skipped: number;
}

/**
 * The one-off backfill (spec C): every ready variant row of one customer,
 * its live KV value, its id, the body row with live_from = generated_at, the
 * KV value written back with body_id, variants.body_id set. Idempotent: a
 * second run finds every id in place and writes nothing. Bodies overwritten
 * before the backfill are gone; exposures before it have body_id NULL.
 *
 * A row rewritten while the backfill runs (its generated_at moved) is left
 * alone: publishVersion already gave it its id, and writing the older value
 * back would undo the rewrite.
 */
export async function backfillBodies(
  env: PublishEnv,
  customerId: string,
): Promise<BodyBackfillResult> {
  const rows = await env.DB.prepare(
    `SELECT id, kv_key, model, prompt_hash, lint_flags, generated_at, body_id
     FROM variants WHERE customer_id = ? AND status = 'ready'`,
  )
    .bind(customerId)
    .all<{
      id: string;
      kv_key: string;
      model: string;
      prompt_hash: string;
      lint_flags: string | null;
      generated_at: number;
      body_id: string | null;
    }>();
  const out: BodyBackfillResult = { scanned: 0, written: 0, skipped: 0 };
  for (const row of rows.results ?? []) {
    out.scanned++;
    const cell = parseVariantKey(row.kv_key, customerId);
    let live: VariantBody | null = null;
    try {
      const raw = cell ? await env.VARIANTS.get(row.kv_key) : null;
      live = raw ? (JSON.parse(raw) as VariantBody) : null;
    } catch {
      live = null;
    }
    if (!cell || !live || typeof live !== "object" || !live.sections) {
      out.skipped++;
      continue;
    }
    const { body_id: had, ...clean } = live;
    const bodyId = await computeBodyId(
      {
        customer_id: customerId,
        page_path: cell.pagePath,
        intent_dim: cell.intentDim,
        source_dim: cell.sourceDim,
      },
      clean.sections,
    );
    if (had === bodyId && row.body_id === bodyId) continue;
    const served: VariantBody = { ...clean, body_id: bodyId };
    const language = await pathLanguage(env.DB, customerId, cell.pagePath);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO version_bodies
         (body_id, customer_id, page_path, intent_dim, source_dim, language, model, prompt_hash,
          lint_flags, body_json, live_from, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
      .bind(
        bodyId,
        customerId,
        cell.pagePath,
        cell.intentDim,
        cell.sourceDim,
        language,
        row.model,
        row.prompt_hash,
        row.lint_flags,
        JSON.stringify(served),
        row.generated_at,
      )
      .run();
    // Rewritten meanwhile? Then the queue already published it with its id.
    const still = await env.DB.prepare("SELECT generated_at FROM variants WHERE id = ?")
      .bind(row.id)
      .first<{ generated_at: number }>();
    if (!still || still.generated_at !== row.generated_at) {
      out.skipped++;
      continue;
    }
    if (had !== bodyId) await env.VARIANTS.put(row.kv_key, JSON.stringify(served));
    await env.DB.prepare("UPDATE variants SET body_id = ? WHERE id = ?").bind(bodyId, row.id).run();
    out.written++;
  }
  return out;
}
