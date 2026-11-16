/**
 * The country off switch (ADR 0036, point 6; docs/specs/visitors-page.md):
 * the customer turns recording of the visitor's country off, or on again.
 *
 *   POST /admin/country/off   { customer_id }
 *   POST /admin/country/on    { customer_id }
 *
 * Customer-scoped, a superadmin too (the auth of POST /admin/keywords/off).
 * Stores `customers.country_off` and rewrites the visitor bundle, so `co`
 * reaches the edge and `/event` stops writing `events.country` within the
 * bundle's five minutes. Turning it off also sets that customer's
 * `events.country` to NULL, by customer and never by age, in chunks; what one
 * call leaves (a long history, or rows the edge wrote before `co` arrived) the
 * 6-hour sweep finishes (`clearSwitchedOffCountries`). Turning it on again
 * records from then on; nothing cleared comes back.
 */

import { type CountrySwitchResponse, visitorBundleKey } from "@rawuser/shared";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { writeVisitorBundle } from "./onboard.ts";
import { requireCustomerScope } from "./scope.ts";

/** Rows per statement when the switch clears a customer's country. */
export const COUNTRY_CLEAR_CHUNK = 5000;
/** Statements per call (endpoint) or per customer per run (sweep). */
export const COUNTRY_CLEAR_MAX_STATEMENTS = 20;

/** One chunk of a customer's rows that still hold a country. By customer, never by age. */
export const COUNTRY_CLEAR_SQL = `UPDATE events SET country = NULL WHERE rowid IN (
  SELECT rowid FROM events WHERE customer_id = ? AND country IS NOT NULL LIMIT ?)`;

export interface CountryClearResult {
  cleared: number;
  /** True when no row of the customer holds a country any more. */
  done: boolean;
}

/** Clears the customer's `events.country` in chunks, at most `maxStatements` of them. */
export async function clearCountry(
  db: D1Database,
  customerId: string,
  opts: { chunk?: number; maxStatements?: number } = {},
): Promise<CountryClearResult> {
  const chunk = opts.chunk ?? COUNTRY_CLEAR_CHUNK;
  let left = opts.maxStatements ?? COUNTRY_CLEAR_MAX_STATEMENTS;
  let cleared = 0;
  while (left > 0) {
    left--;
    const r = await db.prepare(COUNTRY_CLEAR_SQL).bind(customerId, chunk).run();
    const n = Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0);
    cleared += n;
    if (n < chunk) return { cleared, done: true };
  }
  return { cleared, done: false };
}

/**
 * The 6-hour sweep: every customer with the switch on loses what country its
 * rows still hold. Counts only; one customer's failure never stops the rest.
 */
export async function clearSwitchedOffCountries(
  db: D1Database,
): Promise<{ customers: number; cleared: number; errors: number }> {
  const rows = await db
    .prepare("SELECT id FROM customers WHERE country_off = 1 ORDER BY id")
    .all<{ id: string }>();
  const out = { customers: 0, cleared: 0, errors: 0 };
  for (const { id } of rows.results ?? []) {
    try {
      const r = await clearCountry(db, id);
      out.customers++;
      out.cleared += r.cleared;
    } catch {
      out.errors++;
    }
  }
  return out;
}

export async function handleCountrySwitch(
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

  await env.DB.prepare("UPDATE customers SET country_off = ? WHERE id = ?")
    .bind(off ? 1 : 0, customerId)
    .run();
  // Written whether or not the flag moved: sending the same request again
  // heals a bundle that was lost.
  try {
    await writeVisitorBundle(env, customerId);
  } catch {
    // A bundle from before the change could still lack `co`. With none, the
    // edge reads the switch from the database, which now says off.
    try {
      await env.VARIANTS.delete(visitorBundleKey(customerId));
    } catch {
      console.error("[rawuser/country] stale bundle not removed");
    }
    console.error("[rawuser/country] bundle not written after the switch");
    return jsonWithCors(
      { error: "Saved, but the edge copy was not written. Send the same request again." },
      env,
      500,
    );
  }
  const clear = off ? await clearCountry(env.DB, customerId) : { cleared: 0, done: true };
  const result: CountrySwitchResponse = {
    ok: true,
    customer_id: customerId,
    country_recording: off ? "off" : "on",
    cleared: clear.cleared,
    done: clear.done,
  };
  return jsonWithCors(result, env, 200);
}
