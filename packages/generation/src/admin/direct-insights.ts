/**
 * The direct-insights off switch (ADR 0038, part 1; docs/specs/
 * direct-visitors.md §1, docs/specs/visitors-page.md §2): the customer turns
 * recording of the device word and the in-app bit off, or on again.
 *
 *   POST /admin/direct-insights/off   { customer_id }
 *   POST /admin/direct-insights/on    { customer_id }
 *
 * Customer-scoped, a superadmin too (the auth of the other switch on
 * Settings). Stores `customers.direct_insights_off` and rewrites the visitor
 * bundle, so `dx` reaches the edge and `/event` stops writing
 * `events.device_class` and `events.web_view` within the bundle's five
 * minutes. Turning it off also sets both columns of that customer's rows to
 * NULL, by customer and never by age, in chunks; what one call leaves the
 * 6-hour sweep finishes (`clearSwitchedOffDirect`). Turning it on again
 * records from then on; nothing cleared comes back.
 */

import { type DirectInsightsSwitchResponse, visitorBundleKey } from "@rawuser/shared";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { writeVisitorBundle } from "./onboard.ts";
import { requireCustomerScope } from "./scope.ts";

/** Rows per statement when the switch clears a customer's device facts. */
export const DIRECT_CLEAR_CHUNK = 5000;
/** Statements per call (endpoint) or per customer per run (sweep). */
export const DIRECT_CLEAR_MAX_STATEMENTS = 20;

/** One chunk of a customer's rows that still hold either fact. By customer, never by age. */
export const DIRECT_CLEAR_SQL = `UPDATE events SET device_class = NULL, web_view = NULL WHERE rowid IN (
  SELECT rowid FROM events WHERE customer_id = ?
    AND (device_class IS NOT NULL OR web_view IS NOT NULL) LIMIT ?)`;

export interface DirectClearResult {
  cleared: number;
  /** True when no row of the customer holds either fact any more. */
  done: boolean;
}

/** Clears the customer's `events.device_class` and `events.web_view` in chunks. */
export async function clearDirectFacts(
  db: D1Database,
  customerId: string,
  opts: { chunk?: number; maxStatements?: number } = {},
): Promise<DirectClearResult> {
  const chunk = opts.chunk ?? DIRECT_CLEAR_CHUNK;
  let left = opts.maxStatements ?? DIRECT_CLEAR_MAX_STATEMENTS;
  let cleared = 0;
  while (left > 0) {
    left--;
    const r = await db.prepare(DIRECT_CLEAR_SQL).bind(customerId, chunk).run();
    const n = Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0);
    cleared += n;
    if (n < chunk) return { cleared, done: true };
  }
  return { cleared, done: false };
}

/**
 * The 6-hour sweep: every customer with the switch on loses the device
 * facts its rows still hold. Counts only; one customer's failure never stops
 * the rest.
 */
export async function clearSwitchedOffDirect(
  db: D1Database,
): Promise<{ customers: number; cleared: number; errors: number }> {
  const rows = await db
    .prepare("SELECT id FROM customers WHERE direct_insights_off = 1 ORDER BY id")
    .all<{ id: string }>();
  const out = { customers: 0, cleared: 0, errors: 0 };
  for (const { id } of rows.results ?? []) {
    try {
      const r = await clearDirectFacts(db, id);
      out.customers++;
      out.cleared += r.cleared;
    } catch {
      out.errors++;
    }
  }
  return out;
}

export async function handleDirectInsightsSwitch(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
  off: boolean,
): Promise<Response> {
  let body: { customer_id?: unknown };
  try {
    body = ((await request.json()) ?? {}) as typeof body;
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  const customerId = typeof body.customer_id === "string" ? body.customer_id : "";
  const scope = requireCustomerScope(user, customerId || null);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const row = await env.DB.prepare("SELECT id FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ id: string }>();
  if (!row) return jsonWithCors({ error: "Customer not found" }, env, 404);

  await env.DB.prepare("UPDATE customers SET direct_insights_off = ? WHERE id = ?")
    .bind(off ? 1 : 0, customerId)
    .run();
  // Written whether or not the flag moved: sending the same request again
  // heals a bundle that was lost.
  try {
    await writeVisitorBundle(env, customerId);
  } catch {
    // A bundle from before the change could still lack `dx`. With none, the
    // edge reads the switch from the database, which now says off.
    try {
      await env.VARIANTS.delete(visitorBundleKey(customerId));
    } catch {
      console.error("[rawuser/direct-insights] stale bundle not removed");
    }
    console.error("[rawuser/direct-insights] bundle not written after the switch");
    return jsonWithCors(
      { error: "Saved, but the edge copy was not written. Send the same request again." },
      env,
      500,
    );
  }
  const clear = off ? await clearDirectFacts(env.DB, customerId) : { cleared: 0, done: true };
  const result: DirectInsightsSwitchResponse = {
    ok: true,
    customer_id: customerId,
    direct_insights: off ? "off" : "on",
    cleared: clear.cleared,
    done: clear.done,
  };
  return jsonWithCors(result, env, 200);
}
