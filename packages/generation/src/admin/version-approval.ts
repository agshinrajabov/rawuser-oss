/**
 * The customer's OK on a changed version (docs/specs/versions-approval.md,
 * the founder's yes on 2026-11-02). Customer-scoped, a superadmin too.
 *
 *   GET  /admin/variants/pending       ?customer_id[&page_path]
 *   POST /admin/variant/approve        { customer_id, page_path?, intent_dim, source_dim }
 *   POST /admin/variants/approve-all   { customer_id, page_path? }
 *   POST /admin/variant/discard        { customer_id, page_path?, intent_dim, source_dim }
 *   GET  /admin/customers/auto-approve ?customer_id
 *   POST /admin/customers/auto-approve { customer_id, on }
 *
 * Approve publishes through publishVersion (lib/version-approval.ts), the one
 * way to go live, so the KV value carries its body_id and the previous body
 * is retired as for any write. Discard keeps the live body.
 *
 * A customer's answers carry its own words only: no body id, model, cost or
 * prompt hash (docs/specs/versions-for-every-customer.md). Nothing about a
 * visitor.
 */

import { type VariantBody, normalizePath } from "@rawuser/shared";
import { auditGate, capBody } from "../audit/caps.ts";
import { sensitivePageRefusal } from "../lib/sensitive-guard.ts";
import {
  approveCell,
  cellOf,
  discardCell,
  waitingBody,
  waitingCount,
  waitingRows,
} from "../lib/version-approval.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import { bodyForCustomer, isCustomer, knownCell } from "./customer-versions.ts";
import type { AdminEnv } from "./handlers.ts";
import { writeHideRules } from "./onboard.ts";
import { requireCustomerScope } from "./scope.ts";

/** Waiting versions a list answers at most. A customer has about 30 a page. */
export const PENDING_LIST_MAX = 400;

/** One part of a version: its primary words, without the other lengths. */
export interface PartText {
  path: string;
  live: string | null;
  new: string | null;
}

/** The parts of a body as `section.slot` and its words; `kind`, `href` and other lengths left out. */
export function partsOf(body: VariantBody | null): Map<string, string> {
  const out = new Map<string, string>();
  const sections = (body?.sections ?? {}) as Record<string, unknown>;
  for (const [section, value] of Object.entries(sections)) {
    if (!value || typeof value !== "object") continue;
    for (const [slot, text] of Object.entries(value as Record<string, unknown>)) {
      if (typeof text !== "string") continue;
      if (slot === "kind" || slot === "href" || /_alt2?$/.test(slot) || slot.endsWith(".href")) {
        continue;
      }
      out.set(`${section}.${slot}`, text);
    }
  }
  return out;
}

/** The live words beside the new ones, part by part, in the new body's order. */
export function partsBeside(live: VariantBody | null, next: VariantBody | null): PartText[] {
  const a = partsOf(live);
  const b = partsOf(next);
  const paths = [...b.keys(), ...[...a.keys()].filter((p) => !b.has(p))];
  return paths.map((path) => ({ path, live: a.get(path) ?? null, new: b.get(path) ?? null }));
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function liveBody(kv: KVNamespace, kvKey: string): Promise<VariantBody | null> {
  try {
    const raw = await kv.get(kvKey);
    return raw ? (JSON.parse(raw) as VariantBody) : null;
  } catch {
    return null;
  }
}

/** The hide rules follow what live versions write (lib/hidden-parts.ts). Best effort. */
async function rehide(env: AdminEnv, customerId: string): Promise<void> {
  try {
    await writeHideRules(env, customerId);
  } catch (e) {
    console.error(
      "[rawuser/approval] hide rules not rebuilt:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

// ---------------------------------------------------------------------------
// GET /admin/variants/pending
// ---------------------------------------------------------------------------

export async function handlePendingList(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const pagePath = url.searchParams.get("page_path");
  const customer = isCustomer(user);

  const rows = (await waitingRows(env.DB, customerId, pagePath)).slice(0, PENDING_LIST_MAX);
  const items: Record<string, unknown>[] = [];
  for (const row of rows) {
    const stored = await waitingBody(env.DB, customerId, row.pending_body_id);
    if (!stored) continue;
    const live = row.status === "pending" ? null : await liveBody(env.VARIANTS, row.kv_key);
    const shown = (b: VariantBody | null) =>
      b === null ? null : customer ? bodyForCustomer(b) : b;
    items.push({
      page_path: row.page_path,
      intent_dim: row.intent_dim,
      source_dim: row.source_dim,
      kv_key: row.kv_key,
      pending_since: row.pending_at,
      // No live body in the cell: visitors get the next step of the cascade,
      // or the page as built.
      has_live: live !== null,
      live: shown(live),
      new: shown(stored.body),
      parts: partsBeside(live, stored.body),
      ...(customer
        ? {}
        : { pending_body_id: row.pending_body_id, live_body_id: row.body_id ?? null }),
    });
  }
  return jsonWithCors(
    {
      customer_id: customerId,
      page_path: pagePath ? normalizePath(pagePath) : null,
      count: items.length,
      items,
    },
    env,
    200,
  );
}

// ---------------------------------------------------------------------------
// POST /admin/variant/approve and /admin/variant/discard
// ---------------------------------------------------------------------------

interface CellAsk {
  customer_id: string;
  page_path: string;
  intent_dim: string;
  source_dim: string;
}

/** The checks both one-cell calls share; a Response when refused. */
async function cellAsk(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<CellAsk | Response> {
  const body = await readJson(request);
  if (!body) return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  const { customer_id, page_path, intent_dim, source_dim } = body;
  if (
    typeof customer_id !== "string" ||
    !customer_id ||
    typeof intent_dim !== "string" ||
    typeof source_dim !== "string"
  ) {
    return jsonWithCors(
      { error: "customer_id, intent_dim, and source_dim are required" },
      env,
      400,
    );
  }
  const scope = requireCustomerScope(user, customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  if (!knownCell(intent_dim, source_dim)) {
    return jsonWithCors({ error: "unknown intent_dim or source_dim" }, env, 400);
  }
  return {
    customer_id,
    page_path: normalizePath(typeof page_path === "string" ? page_path : "/"),
    intent_dim,
    source_dim,
  };
}

/** Refusals before anything goes live: an ended audit, a page outside a sensitive customer's sections. */
async function liveRefusal(
  env: AdminEnv,
  customerId: string,
  pagePath: string | null,
): Promise<Response | null> {
  const gate = await auditGate(env.DB, customerId);
  if (gate.ended) return jsonWithCors(capBody("audit_ended"), env, 409);
  if (pagePath !== null) {
    const kept = await sensitivePageRefusal(env.DB, customerId, pagePath);
    if (kept) return jsonWithCors(kept, env, 409);
  }
  return null;
}

export async function handleApprove(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const ask = await cellAsk(request, env, user);
  if (ask instanceof Response) return ask;
  const refused = await liveRefusal(env, ask.customer_id, ask.page_path);
  if (refused) return refused;
  const cell = cellOf(ask.customer_id, ask.page_path, ask.intent_dim, ask.source_dim);
  const out = await approveCell(env, cell);
  if (!out.ok) return jsonWithCors({ ok: false, error: out.error }, env, 404);
  await rehide(env, ask.customer_id);
  return jsonWithCors(
    {
      ok: true,
      page_path: ask.page_path,
      intent_dim: ask.intent_dim,
      source_dim: ask.source_dim,
      pending_left: await waitingCount(env.DB, ask.customer_id),
      ...(isCustomer(user) ? {} : { body_id: out.body_id }),
    },
    env,
    200,
  );
}

export async function handleDiscard(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const ask = await cellAsk(request, env, user);
  if (ask instanceof Response) return ask;
  const cell = cellOf(ask.customer_id, ask.page_path, ask.intent_dim, ask.source_dim);
  const out = await discardCell(env, cell);
  if (!out.ok) return jsonWithCors({ ok: false, error: out.error }, env, 404);
  return jsonWithCors(
    {
      ok: true,
      page_path: ask.page_path,
      intent_dim: ask.intent_dim,
      source_dim: ask.source_dim,
      pending_left: await waitingCount(env.DB, ask.customer_id),
    },
    env,
    200,
  );
}

// ---------------------------------------------------------------------------
// POST /admin/variants/approve-all
// ---------------------------------------------------------------------------

export async function handleApproveAll(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  const customerId = body.customer_id;
  if (typeof customerId !== "string" || !customerId) {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const pagePath = typeof body.page_path === "string" ? normalizePath(body.page_path) : null;
  const refused = await liveRefusal(env, customerId, pagePath);
  if (refused) return refused;

  let approved = 0;
  let failed = 0;
  for (const row of await waitingRows(env.DB, customerId, pagePath)) {
    // Each page's own sensitive check when every page is asked.
    if (pagePath === null && (await sensitivePageRefusal(env.DB, customerId, row.page_path))) {
      failed++;
      continue;
    }
    try {
      const out = await approveCell(
        env,
        cellOf(customerId, row.page_path, row.intent_dim, row.source_dim),
      );
      if (out.ok) approved++;
      else failed++;
    } catch {
      failed++;
    }
  }
  if (approved > 0) await rehide(env, customerId);
  return jsonWithCors(
    {
      ok: true,
      page_path: pagePath,
      approved,
      failed,
      pending_left: await waitingCount(env.DB, customerId),
    },
    env,
    200,
  );
}

// ---------------------------------------------------------------------------
// GET and POST /admin/customers/auto-approve
// ---------------------------------------------------------------------------

export async function handleAutoApproveGet(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const customerId = new URL(request.url).searchParams.get("customer_id");
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const row = await env.DB.prepare("SELECT auto_approve FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ auto_approve: number | null }>();
  if (!row) return jsonWithCors({ error: "Customer not found" }, env, 404);
  return jsonWithCors(
    {
      customer_id: customerId,
      auto_approve: row.auto_approve === 1,
      pending: await waitingCount(env.DB, customerId),
    },
    env,
    200,
  );
}

/**
 * Turns auto approval on or off. Turning it on publishes nothing by itself:
 * the versions that wait keep waiting until approved (or approve-all); from
 * then on every new body goes live at once, as before the rule.
 */
export async function handleAutoApproveSet(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  const customerId = body.customer_id;
  if (typeof customerId !== "string" || !customerId) {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  if (typeof body.on !== "boolean")
    return jsonWithCors({ error: "on must be true or false" }, env, 400);
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const r = await env.DB.prepare("UPDATE customers SET auto_approve = ? WHERE id = ?")
    .bind(body.on ? 1 : 0, customerId)
    .run();
  if (Number(r.meta?.changes ?? 0) === 0) {
    return jsonWithCors({ error: "Customer not found" }, env, 404);
  }
  return jsonWithCors(
    {
      customer_id: customerId,
      auto_approve: body.on,
      pending: await waitingCount(env.DB, customerId),
    },
    env,
    200,
  );
}
