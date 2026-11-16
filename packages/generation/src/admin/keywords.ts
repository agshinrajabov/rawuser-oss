/**
 * The keyword off switch (docs/specs/keyword-intent.md §5; privacy review,
 * section 10e): the customer turns keyword reading off or on again.
 *
 *   POST /admin/keywords/off   { customer_id, off: boolean }
 *
 * Customer-scoped, a superadmin too (the auth of POST /admin/proof/test).
 * Stores `customers.keyword_off` and rewrites the visitor bundle, so `kl`
 * leaves the edge at once (bundleKeywordLexicon). The stored lexicon is
 * kept while off, so turning it on again needs no model call; a live
 * customer with none gets a build in the background. The answer says
 * whether a lexicon is stored, never what it holds.
 */

import { visitorBundleKey } from "@rawuser/shared";
import { refreshKeywordLexicon } from "../keywords/lexicon.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { writeVisitorBundle } from "./onboard.ts";
import { requireCustomerScope } from "./scope.ts";

export interface KeywordOffResult {
  ok: true;
  customer_id: string;
  off: boolean;
  /** A lexicon is stored (used only while `off` is false). */
  lexicon: boolean;
}

export async function handleKeywordsOff(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  let body: { customer_id?: unknown; off?: unknown };
  try {
    body = ((await request.json()) ?? {}) as typeof body;
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  const customerId = typeof body.customer_id === "string" ? body.customer_id : "";
  const scope = requireCustomerScope(user, customerId || null);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  if (typeof body.off !== "boolean") {
    return jsonWithCors({ error: "off must be true or false" }, env, 400);
  }
  const off = body.off;
  const row = await env.DB.prepare(
    "SELECT keyword_off, keyword_lexicon IS NOT NULL AS has_lexicon FROM customers WHERE id = ?",
  )
    .bind(customerId)
    .first<{ keyword_off: number | null; has_lexicon: number }>();
  if (!row) return jsonWithCors({ error: "Customer not found" }, env, 404);

  await env.DB.prepare("UPDATE customers SET keyword_off = ? WHERE id = ?")
    .bind(off ? 1 : 0, customerId)
    .run();
  // Written whether or not the flag moved: sending the same request again
  // heals a bundle that was lost.
  try {
    await writeVisitorBundle(env, customerId);
  } catch {
    // A bundle from before the change could still carry `kl`. With none, the
    // edge writes it back from the database, which now says off.
    try {
      await env.VARIANTS.delete(visitorBundleKey(customerId));
    } catch {
      console.error("[rawuser/keywords] stale bundle not removed");
    }
    console.error("[rawuser/keywords] bundle not written after the switch");
    return jsonWithCors(
      { error: "Saved, but the edge copy was not written. Send the same request again." },
      env,
      500,
    );
  }
  if (!off && Number(row.has_lexicon) !== 1) {
    await refreshKeywordLexicon(env, customerId, ctx);
  }
  const result: KeywordOffResult = {
    ok: true,
    customer_id: customerId,
    off,
    lexicon: Number(row.has_lexicon) === 1,
  };
  return jsonWithCors(result, env, 200);
}
