/**
 * A changed version waits for the customer's OK
 * (docs/specs/versions-approval.md, the founder's yes on 2026-11-02).
 *
 * Every write of a version that is not a preview comes through
 * `storeVersion`. It decides between two ways:
 *   - live: publishVersion, as before (the KV key the edge reads, the body
 *     row, body_id, the previous body retired);
 *   - waiting: the body row only (live_from 0) and the cell's
 *     `variants.pending_body_id`. Nothing reaches KV, so visitors keep the
 *     live body, or the edge's cascade when the cell has none.
 *
 * Live when the customer has `auto_approve`, when it has never gone live,
 * or when the cell has no live body and is one of the first set written at
 * the first go live (its pages and intents, for FIRST_SET_DAYS). Everything
 * else waits: a rewrite of a live cell, and a cell that never had a body
 * after the first set (a page added later, an intent the site serves later).
 *
 * Approve publishes the waiting body through publishVersion, so the proof
 * engine's body_id and retirement stay the one way to go live. Discard
 * marks it discarded and keeps the live body.
 *
 * Our own text and the customer's own setting; nothing about a visitor.
 */

import {
  type IntentDim,
  type SourceDim,
  type VariantBody,
  marketOfSource,
  normalizePath,
  variantKeyForPath,
} from "@rawuser/shared";
import {
  type CellBody,
  type PublishEnv,
  type PublishProvenance,
  type VersionCell,
  cellBody,
  insertBody,
  parseVariantKey,
  publishVersion,
} from "./publish-version.ts";
import { deterministicId, lookupProfileId } from "./variant-rows.ts";

/** How long after the first go live a first-set cell's first body publishes at once. */
export const FIRST_SET_DAYS = 7;
const DAY_MS = 24 * 3600 * 1000;

/** What was written at the first go live (`customers.first_set`). */
export interface FirstSet {
  at: number;
  pages: string[];
  /** The intents the site served then; null for all six. */
  intents: string[] | null;
}

interface ApprovalCustomer {
  live_at: number | null;
  auto_approve: number | null;
  first_set: string | null;
}

export function parseFirstSet(raw: string | null | undefined): FirstSet | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<FirstSet>;
    if (typeof v.at !== "number" || !Array.isArray(v.pages)) return null;
    return {
      at: v.at,
      pages: v.pages.filter((p): p is string => typeof p === "string").map(normalizePath),
      intents: Array.isArray(v.intents)
        ? v.intents.filter((i): i is string => typeof i === "string")
        : null,
    };
  } catch {
    return null;
  }
}

/** The first set at a true first go live. A later go live never moves it. */
export async function recordFirstSet(
  db: D1Database,
  customerId: string,
  set: FirstSet,
): Promise<void> {
  await db
    .prepare("UPDATE customers SET first_set = ? WHERE id = ? AND first_set IS NULL")
    .bind(
      JSON.stringify({
        at: set.at,
        pages: [...new Set(set.pages.map(normalizePath))],
        intents: set.intents,
      }),
      customerId,
    )
    .run();
}

async function loadApprovalCustomer(
  db: D1Database,
  customerId: string,
): Promise<ApprovalCustomer | null> {
  const row = await db
    .prepare("SELECT live_at, auto_approve, first_set FROM customers WHERE id = ?")
    .bind(customerId)
    .first<Partial<ApprovalCustomer>>();
  if (!row) return null;
  return {
    live_at: typeof row.live_at === "number" ? row.live_at : null,
    auto_approve: typeof row.auto_approve === "number" ? row.auto_approve : null,
    first_set: typeof row.first_set === "string" ? row.first_set : null,
  };
}

/** Whether the cell has a body visitors are served: its row says so, or its KV key holds one. */
async function hasLiveBody(env: PublishEnv, customerId: string, kvKey: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT body_id FROM variants WHERE customer_id = ? AND kv_key = ?",
  )
    .bind(customerId, kvKey)
    .first<{ body_id: string | null }>();
  if (row?.body_id) return true;
  return (await env.VARIANTS.get(kvKey)) !== null;
}

export type Route = "live" | "waiting";

/**
 * Where a new body of `cell` goes. `live` is the cell's state: whether a
 * body already serves there (read when not given).
 */
export async function routeFor(
  env: PublishEnv,
  cell: VersionCell,
  kvKey: string,
  now = Date.now(),
  live?: boolean,
): Promise<Route> {
  const customer = await loadApprovalCustomer(env.DB, cell.customerId);
  // Not a customer we know of, or not live yet: as before this rule.
  if (!customer || customer.live_at === null) return "live";
  if (customer.auto_approve === 1) return "live";
  // A market version is never part of the first set: it waits for the
  // customer's OK (docs/specs/direct-visitors.md §5).
  if (marketOfSource(cell.sourceDim)) return "waiting";
  const hasLive = live ?? (await hasLiveBody(env, cell.customerId, kvKey));
  if (hasLive) return "waiting";
  const first = parseFirstSet(customer.first_set);
  if (!first || now > first.at + FIRST_SET_DAYS * DAY_MS) return "waiting";
  const inPages = first.pages.includes(normalizePath(cell.pagePath));
  const inIntents = first.intents === null || first.intents.includes(cell.intentDim);
  return inPages && inIntents ? "live" : "waiting";
}

export interface Stored {
  state: Route;
  body_id: string;
  kv_key: string;
  body: VariantBody;
}

/**
 * Stores a new body of a cell: live through publishVersion, or waiting for
 * the customer's OK. The same words as the live body are no change: they go
 * through publishVersion as before (the KV value is the same, nothing waits).
 */
export async function storeVersion(
  env: PublishEnv,
  cell: VersionCell,
  body: VariantBody,
  prov: PublishProvenance,
  now = Date.now(),
): Promise<Stored> {
  const cb = await cellBody(cell, body);
  const row = await env.DB.prepare(
    "SELECT body_id, pending_body_id FROM variants WHERE customer_id = ? AND kv_key = ?",
  )
    .bind(cell.customerId, cb.kvKey)
    .first<{ body_id: string | null; pending_body_id: string | null }>();
  const live = Boolean(row?.body_id) || (await env.VARIANTS.get(cb.kvKey)) !== null;
  const route =
    row?.body_id && row.body_id === cb.bodyId
      ? "live"
      : await routeFor(env, cell, cb.kvKey, now, live);
  if (route === "live") {
    const out = await publishVersion(env, cell, body, prov, now);
    return { state: "live", body_id: out.body_id, kv_key: out.kv_key, body: out.body };
  }
  await holdVersion(env, cell, cb, prov, live, row?.pending_body_id ?? null, now);
  return { state: "waiting", body_id: cb.bodyId, kv_key: cb.kvKey, body: cb.served };
}

/** The waiting write: the body row with live_from 0, the cell's row pointing at it. */
async function holdVersion(
  env: PublishEnv,
  cell: VersionCell,
  cb: CellBody,
  prov: PublishProvenance,
  live: boolean,
  previous: string | null,
  now: number,
): Promise<void> {
  await insertBody(env, cell, cb, prov, 0);
  // The same words may have waited before and been discarded: they wait again.
  await env.DB.prepare(
    "UPDATE version_bodies SET discarded_at = NULL WHERE body_id = ? AND customer_id = ?",
  )
    .bind(cb.bodyId, cell.customerId)
    .run();
  // The body that waited before in this cell is replaced by this one.
  if (previous && previous !== cb.bodyId) {
    await env.DB.prepare(
      "UPDATE version_bodies SET discarded_at = ? WHERE body_id = ? AND customer_id = ? AND discarded_at IS NULL",
    )
      .bind(now, previous, cell.customerId)
      .run();
  }
  const id = deterministicId(cell.customerId, cell.intentDim, cell.sourceDim, cb.pagePath);
  const lintFlags = prov.lintFlags.length > 0 ? JSON.stringify(prov.lintFlags) : null;
  if (live) {
    // The live body serves; the row's job is done (the queue leaves it), its
    // provenance stays the live body's.
    await env.DB.prepare(
      `UPDATE variants SET status = 'ready', error_reason = NULL, pending_body_id = ?, pending_at = ?
       WHERE id = ?`,
    )
      .bind(cb.bodyId, now, id)
      .run();
    return;
  }
  // No body serves in this cell: the row is the waiting body's.
  const profileId = await lookupProfileId(cell.intentDim as IntentDim, env.DB);
  await env.DB.prepare(
    `INSERT INTO variants
       (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status,
        error_reason, lint_flags, body_id, pending_body_id, pending_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       kv_key = excluded.kv_key,
       model = excluded.model,
       prompt_hash = excluded.prompt_hash,
       generated_at = excluded.generated_at,
       cost_usd = excluded.cost_usd,
       status = 'pending',
       error_reason = NULL,
       lint_flags = excluded.lint_flags,
       pending_body_id = excluded.pending_body_id,
       pending_at = excluded.pending_at`,
  )
    .bind(
      id,
      cell.customerId,
      profileId,
      cb.kvKey,
      prov.model,
      prov.promptHash,
      now,
      prov.costUsd,
      lintFlags,
      cb.bodyId,
      now,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Reading what waits
// ---------------------------------------------------------------------------

/** The approval state of a version as the list answers it (the contract, spec §4). */
export interface ApprovalFields {
  pending: boolean;
  pending_since: number | null;
  approval: "waiting" | "approved";
  waiting_since: number | null;
}

export function approvalFields(row: {
  pending_body_id?: string | null;
  pending_at?: number | null;
}): ApprovalFields {
  const pending = Boolean(row.pending_body_id);
  const since = pending ? Number(row.pending_at) || null : null;
  return {
    pending,
    pending_since: since,
    approval: pending ? "waiting" : "approved",
    waiting_since: since,
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface WaitingRow {
  kv_key: string;
  page_path: string;
  intent_dim: string;
  source_dim: string;
  status: string;
  body_id: string | null;
  pending_body_id: string;
  pending_at: number;
  cost_usd: number;
}

/** The cells of a customer with a waiting body, of one page when a path is given, oldest first. */
export async function waitingRows(
  db: D1Database,
  customerId: string,
  pagePath?: string | null,
): Promise<WaitingRow[]> {
  const res = await db
    .prepare(
      `SELECT kv_key, status, body_id, pending_body_id, pending_at, cost_usd FROM variants
       WHERE customer_id = ? AND pending_body_id IS NOT NULL
       ORDER BY pending_at ASC, kv_key ASC`,
    )
    .bind(customerId)
    .all<Omit<WaitingRow, "page_path" | "intent_dim" | "source_dim">>();
  const page = pagePath ? normalizePath(pagePath) : null;
  const out: WaitingRow[] = [];
  for (const r of res.results ?? []) {
    const cell = parseVariantKey(r.kv_key, customerId);
    if (!cell) continue;
    if (page !== null && cell.pagePath !== page) continue;
    out.push({
      ...r,
      page_path: cell.pagePath,
      intent_dim: cell.intentDim,
      source_dim: cell.sourceDim,
      pending_at: Number(r.pending_at) || 0,
    });
  }
  return out;
}

/** How many versions wait for the customer's OK. Zero when it cannot be read. */
export async function waitingCount(db: D1Database, customerId: string): Promise<number> {
  try {
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM variants WHERE customer_id = ? AND pending_body_id IS NOT NULL",
      )
      .bind(customerId)
      .first<{ n: number }>();
    return Number(row?.n ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** A waiting body as stored, or null. */
export async function waitingBody(
  db: D1Database,
  customerId: string,
  bodyId: string,
): Promise<{ body: VariantBody; model: string; prompt_hash: string; lint_flags: string[] } | null> {
  const row = await db
    .prepare(
      "SELECT body_json, model, prompt_hash, lint_flags FROM version_bodies WHERE customer_id = ? AND body_id = ?",
    )
    .bind(customerId, bodyId)
    .first<{ body_json: string; model: string; prompt_hash: string; lint_flags: string | null }>();
  if (!row) return null;
  try {
    const flags = row.lint_flags ? (JSON.parse(row.lint_flags) as unknown) : [];
    return {
      body: JSON.parse(row.body_json) as VariantBody,
      model: row.model,
      prompt_hash: row.prompt_hash,
      lint_flags: Array.isArray(flags)
        ? flags.filter((f): f is string => typeof f === "string")
        : [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Approve and discard
// ---------------------------------------------------------------------------

export type ApproveResult =
  | { ok: true; body_id: string; kv_key: string }
  | { ok: false; error: "nothing_waiting" | "body_missing" };

/** Publishes a cell's waiting body through publishVersion. */
export async function approveCell(
  env: PublishEnv,
  cell: VersionCell,
  now = Date.now(),
): Promise<ApproveResult> {
  const kvKey = keyOf(cell);
  const row = await env.DB.prepare(
    "SELECT pending_body_id, cost_usd FROM variants WHERE customer_id = ? AND kv_key = ?",
  )
    .bind(cell.customerId, kvKey)
    .first<{ pending_body_id: string | null; cost_usd: number | null }>();
  if (!row?.pending_body_id) return { ok: false, error: "nothing_waiting" };
  const stored = await waitingBody(env.DB, cell.customerId, row.pending_body_id);
  if (!stored) return { ok: false, error: "body_missing" };
  const out = await publishVersion(
    env,
    cell,
    stored.body,
    {
      model: stored.model as PublishProvenance["model"],
      promptHash: stored.prompt_hash,
      costUsd: Number(row.cost_usd ?? 0) || 0,
      lintFlags: stored.lint_flags,
    },
    now,
  );
  return { ok: true, body_id: out.body_id, kv_key: out.kv_key };
}

/**
 * Drops a cell's waiting body: the body is marked discarded, the live body
 * keeps serving. A cell with no live body keeps a `discarded` row, so neither
 * the queue nor the Live screen's loop writes it again by itself; a rewrite
 * asked for by hand, a brief save or Rewrite everything does.
 */
export async function discardCell(
  env: PublishEnv,
  cell: VersionCell,
  now = Date.now(),
): Promise<{ ok: boolean; error?: "nothing_waiting" }> {
  const kvKey = keyOf(cell);
  const row = await env.DB.prepare(
    "SELECT pending_body_id, status FROM variants WHERE customer_id = ? AND kv_key = ?",
  )
    .bind(cell.customerId, kvKey)
    .first<{ pending_body_id: string | null; status: string }>();
  if (!row?.pending_body_id) return { ok: false, error: "nothing_waiting" };
  await env.DB.prepare(
    "UPDATE version_bodies SET discarded_at = ? WHERE body_id = ? AND customer_id = ? AND discarded_at IS NULL",
  )
    .bind(now, row.pending_body_id, cell.customerId)
    .run();
  await env.DB.prepare(
    `UPDATE variants SET pending_body_id = NULL, pending_at = NULL,
       status = CASE WHEN status = 'pending' THEN 'discarded' ELSE status END
     WHERE customer_id = ? AND kv_key = ?`,
  )
    .bind(cell.customerId, kvKey)
    .run();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Marking versions to be written again
// ---------------------------------------------------------------------------

/**
 * Marks a customer's ready versions stale (the queue writes them again), as
 * every caller did with its own UPDATE before; `where` narrows it (a page, a
 * folded intent) with its binds. A body waiting in those cells was written
 * from what is now outdated (the brief, the parts, the claims lock), so it is
 * dropped: marked discarded, never approvable. A cell with no live body whose
 * body waited, or was discarded, has its row removed: it is a cell never
 * written, and the queue writes it as one.
 *
 * Answers how many ready rows went stale, as the callers' UPDATE did.
 */
export async function markVersionsStale(
  db: D1Database,
  customerId: string,
  where = "",
  binds: readonly unknown[] = [],
  now = Date.now(),
): Promise<number> {
  await db
    .prepare(
      `UPDATE version_bodies SET discarded_at = ?
       WHERE customer_id = ? AND discarded_at IS NULL AND body_id IN (
         SELECT pending_body_id FROM variants
         WHERE customer_id = ? AND pending_body_id IS NOT NULL${where})`,
    )
    .bind(now, customerId, customerId, ...binds)
    .run();
  // A waiting body on a cell whose rewrite failed, or that is stale already.
  await db
    .prepare(
      `UPDATE variants SET pending_body_id = NULL, pending_at = NULL
       WHERE customer_id = ? AND pending_body_id IS NOT NULL AND status NOT IN ('ready', 'pending', 'discarded')${where}`,
    )
    .bind(customerId, ...binds)
    .run();
  await db
    .prepare(
      `DELETE FROM variants WHERE customer_id = ? AND status IN ('pending', 'discarded')${where}`,
    )
    .bind(customerId, ...binds)
    .run();
  // Last, as each caller ran it before: its count is the answer.
  const stale = await db
    .prepare(
      `UPDATE variants SET status = 'stale', pending_body_id = NULL, pending_at = NULL
       WHERE customer_id = ? AND status = 'ready'${where}`,
    )
    .bind(customerId, ...binds)
    .run();
  return Number(stale.meta?.changes ?? 0) || 0;
}

/** The live KV key of a cell. */
export function keyOf(cell: VersionCell): string {
  return variantKeyForPath(
    cell.customerId,
    normalizePath(cell.pagePath),
    cell.intentDim,
    cell.sourceDim,
  );
}

/** A cell from a request's names (the endpoints check them first). */
export function cellOf(
  customerId: string,
  pagePath: string | null | undefined,
  intentDim: string,
  sourceDim: string,
): VersionCell {
  return {
    customerId,
    pagePath: normalizePath(pagePath),
    intentDim: intentDim as IntentDim,
    sourceDim: sourceDim as SourceDim | "default",
  };
}
