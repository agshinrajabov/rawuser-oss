/**
 * The three switches of ADR 0038 parts 3 to 5 (docs/specs/direct-visitors.md
 * §6), customer-scoped, a superadmin too:
 *
 *   GET  /admin/customers/direct-switches?customer_id
 *   POST /admin/customers/direct-switches
 *        { customer_id, page_one?, learned_default?, market_versions?, remember? }
 *
 * Booleans, true = on. A change stores `customers.page_one_off`,
 * `learned_default_off`, `market_versions_off` or `remember_off` (the visitor
 * memory, ADR 0039) and rewrites the visitor
 * bundle, so the edge stops (or starts) within the bundle's five minutes.
 * The answer: `{ customer_id, page_one, learned_default, market_versions,
 * remember, remember_allowed, markets, allowed }`; `allowed` is false for a customer none of the three
 * may run for (not an explicit "no" to the special-category question,
 * sensitive, or an audit), whatever its switches say.
 *
 * `remember_allowed` is `rememberAllowed`: where the question may run, and
 * on a site marked sensitive only when the install has
 * REMEMBER_ON_SENSITIVE = "on". Turning `remember` on where it is not
 * allowed is refused (409), as the question's own switch is.
 */

import {
  type RememberOptions,
  directAllowed,
  parseMarkets,
  rememberAllowed,
  visitorBundleKey,
} from "@rawuser/shared";
import { rememberOptions } from "../install-config.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { writeVisitorBundle } from "./onboard.ts";
import { requireCustomerScope } from "./scope.ts";

interface SwitchRow {
  page_one_off: number | null;
  learned_default_off: number | null;
  market_versions_off: number | null;
  remember_off: number | null;
  markets: string | null;
  sensitive: number | null;
  special_category: number | null;
  plan: string | null;
}

export interface DirectSwitches {
  customer_id: string;
  page_one: boolean;
  learned_default: boolean;
  market_versions: boolean;
  /** "Remember returning visitors" (ADR 0039, migration 0053). */
  remember: boolean;
  /**
   * False when the memory may not run for this customer: an unanswered or
   * a yes customer that is not marked, an audit, or a marked site on an
   * install that does not allow the memory there.
   */
  remember_allowed: boolean;
  /** The customer's markets (ISO codes), as the 6-hour cron chose them. */
  markets: string[];
  /** False when none of the three may run for this customer. */
  allowed: boolean;
}

const COLUMNS: Record<string, string> = {
  page_one: "page_one_off",
  learned_default: "learned_default_off",
  market_versions: "market_versions_off",
  remember: "remember_off",
};

async function readRow(db: D1Database, customerId: string): Promise<SwitchRow | null> {
  return db
    .prepare(
      "SELECT page_one_off, learned_default_off, market_versions_off, remember_off, markets, sensitive, special_category, plan FROM customers WHERE id = ?",
    )
    .bind(customerId)
    .first<SwitchRow>();
}

function answer(customerId: string, row: SwitchRow, remember: RememberOptions): DirectSwitches {
  return {
    customer_id: customerId,
    page_one: Number(row.page_one_off) !== 1,
    learned_default: Number(row.learned_default_off) !== 1,
    market_versions: Number(row.market_versions_off) !== 1,
    remember: Number(row.remember_off) !== 1,
    remember_allowed: rememberAllowed(row, remember),
    markets: parseMarkets(row.markets),
    allowed: directAllowed(row),
  };
}

export async function handleDirectSwitches(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  let customerId = url.searchParams.get("customer_id") ?? "";
  let changes: Array<[string, boolean]> = [];
  if (request.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>;
    } catch {
      return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
    }
    customerId = typeof body.customer_id === "string" ? body.customer_id : "";
    for (const name of Object.keys(COLUMNS)) {
      const v = body[name];
      if (v === undefined) continue;
      if (typeof v !== "boolean")
        return jsonWithCors({ error: `${name} must be true or false` }, env, 400);
      changes.push([name, v]);
    }
  }
  const scope = requireCustomerScope(user, customerId || null);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  let row = await readRow(env.DB, customerId);
  if (!row) return jsonWithCors({ error: "Customer not found" }, env, 404);
  const remember = rememberOptions(env);
  if (request.method !== "POST") return jsonWithCors(answer(customerId, row, remember), env, 200);

  changes = changes.filter(([n]) => COLUMNS[n] !== undefined);
  // The memory is turned on only where it may run; turning it off always works.
  if (changes.some(([n, on]) => n === "remember" && on) && !rememberAllowed(row, remember)) {
    return jsonWithCors({ error: "Not for this site." }, env, 409);
  }
  for (const [name, on] of changes) {
    await env.DB.prepare(`UPDATE customers SET ${COLUMNS[name]} = ? WHERE id = ?`)
      .bind(on ? 0 : 1, customerId)
      .run();
  }
  // Written whether or not a switch moved: the same request again heals a
  // bundle that was lost.
  try {
    await writeVisitorBundle(env, customerId);
  } catch {
    try {
      await env.VARIANTS.delete(visitorBundleKey(customerId));
    } catch {
      console.error("[rawuser/direct] stale bundle not removed");
    }
    return jsonWithCors(
      { error: "Saved, but the edge copy was not written. Send the same request again." },
      env,
      500,
    );
  }
  row = (await readRow(env.DB, customerId)) ?? row;
  return jsonWithCors(answer(customerId, row, remember), env, 200);
}
