/**
 * Admin pilot-request endpoints (superadmin only).
 *
 * The marketing site's /pilot-request edge endpoint writes leads into
 * D1.pilot_requests (migration 0016). These two handlers give the
 * dashboard an inbox over that table:
 *
 *   GET  /admin/pilot-requests/list           — newest first, capped at 200
 *   POST /admin/pilot-requests/update-status  — { id, status } closed enum
 *
 * Auth: superadmin-only check is enforced in routes.ts (not here).
 *
 * Privacy invariant: pilot_requests holds first-party, consent-based sales
 * contacts (someone typed their email into our form). It is never joined
 * to visitor events and these handlers never touch visitor data.
 *
 * Retention (privacy review, 2026-10-25, ruling 3 on
 * docs/sales/site-privacy.md): a row is deleted 12 months after its last
 * status change. `status_at` (migration 0046) is stamped by the edge's
 * insert and here when the status changes; the 6-hour cron runs
 * deleteOldPilotRequests and logs only the count.
 */

import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";

export interface PilotRequestRow {
  id: string;
  email: string;
  site_url: string | null;
  note: string | null;
  created_at: number;
  status: "new" | "contacted" | "closed";
}

const ALLOWED_STATUSES = new Set(["new", "contacted", "closed"]);

/** GET /admin/pilot-requests/list */
export async function handlePilotRequestsList(_request: Request, env: AdminEnv): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT id, email, site_url, note, created_at, status
       FROM pilot_requests
      ORDER BY created_at DESC
      LIMIT 200`,
  ).all<PilotRequestRow>();

  return jsonWithCors(result.results ?? [], env);
}

/** POST /admin/pilot-requests/update-status — body { id, status } */
export async function handlePilotRequestUpdateStatus(
  request: Request,
  env: AdminEnv,
): Promise<Response> {
  let body: { id?: unknown; status?: unknown };
  try {
    body = (await request.json()) as { id?: unknown; status?: unknown };
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }

  const id = typeof body.id === "string" ? body.id : "";
  const status = typeof body.status === "string" ? body.status : "";
  if (!id || !id.startsWith("plt_") || !ALLOWED_STATUSES.has(status)) {
    return jsonWithCors(
      { error: "Expected { id: 'plt_…', status: new|contacted|closed }" },
      env,
      400,
    );
  }

  // status_at moves only when the status does: setting the same status
  // again does not extend the row's 12 months.
  const result = await env.DB.prepare(
    `UPDATE pilot_requests
        SET status_at = CASE WHEN status = ? THEN COALESCE(status_at, created_at) ELSE ? END,
            status = ?
      WHERE id = ?`,
  )
    .bind(status, Date.now(), status, id)
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    return jsonWithCors({ error: "No pilot request with that id" }, env, 404);
  }
  return jsonWithCors({ ok: true, id, status }, env);
}

/** A pilot request is kept 365 days after its last status change. */
export const PILOT_REQUEST_KEEP_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Rows past their 12 months: the last status change, else (a row from
 * before migration 0046 that the backfill missed) the day it arrived.
 */
export const PILOT_REQUEST_DELETE_SQL =
  "DELETE FROM pilot_requests WHERE COALESCE(status_at, created_at) < ?";

/** Deletes pilot requests past their 12 months; returns the count only. */
export async function deleteOldPilotRequests(db: D1Database, now: number): Promise<number> {
  const r = await db
    .prepare(PILOT_REQUEST_DELETE_SQL)
    .bind(now - PILOT_REQUEST_KEEP_MS)
    .run();
  return Number(r.meta?.changes ?? 0);
}
