/**
 * The special-category question (docs/specs/readiness-check.md, check 3,
 * D4): "Is your site about health, religion, sexuality, politics or union
 * membership?", asked on Connect before the tag and on Look while unanswered.
 *
 *   POST /admin/customers/special-category   customer-scoped:
 *        { customer_id, answer: true | false }
 *
 * Writes `customers.special_category` and `special_category_at`, the
 * operator's answer about the site and nothing else, then writes the
 * visitor bundle again so the edge's `ne` follows (a yes that is not marked
 * stores no event row). A yes sends one line to the ops channel with the
 * site's domain and the words "special category" only (privacy review condition
 * 1): no operator email, no page words, no category name. The founder then
 * marks the site with POST /admin/customers/sensitive, which hands the tag
 * out.
 */

import { clearKeywordLexicon } from "../keywords/lexicon.ts";
import { sendAlert } from "../lib/alert.ts";
import { tagWithheld } from "../lib/readiness.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { writeVisitorBundle } from "./onboard.ts";
import { requireCustomerScope } from "./scope.ts";

/** The ops line on a yes: the domain, or the id without one, and the two words. */
export function specialCategoryAlert(customerId: string, domain: string | null): string {
  const site = (domain ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return `Special category: ${site !== "" ? site : customerId}`;
}

export async function handleSpecialCategorySet(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  let body: { customer_id?: unknown; answer?: unknown };
  try {
    body = ((await request.json()) ?? {}) as typeof body;
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  if (typeof body.customer_id !== "string" || body.customer_id === "") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const scope = requireCustomerScope(user, body.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  if (typeof body.answer !== "boolean") {
    return jsonWithCors({ error: "answer must be true or false" }, env, 400);
  }
  const customerId = body.customer_id;
  const answer = body.answer;

  const before = await env.DB.prepare(
    "SELECT domain, live_at, sensitive, special_category, special_category_at FROM customers WHERE id = ?",
  )
    .bind(customerId)
    .first<{
      domain: string | null;
      live_at: number | null;
      sensitive: number | null;
      special_category: number | null;
      special_category_at: number | null;
    }>();
  if (!before) return jsonWithCors({ error: "Customer not found" }, env, 404);

  const now = Date.now();
  const stored = before.special_category === null ? null : Number(before.special_category) === 1;
  const changed = stored !== answer;
  if (changed) {
    await env.DB.prepare(
      "UPDATE customers SET special_category = ?, special_category_at = ? WHERE id = ?",
    )
      .bind(answer ? 1 : 0, now, customerId)
      .run();
  }
  // A yes keeps no keyword lexicon (docs/specs/keyword-intent.md; privacy review,
  // section 10, condition 8): cleared, and the bundle below goes without `kl`.
  if (answer) {
    try {
      await clearKeywordLexicon(env.DB, customerId);
    } catch {
      console.error("[rawuser/special-category] keyword lexicon not cleared");
      return jsonWithCors(
        { error: "Saved, but the keyword list was not cleared. Send the same request again." },
        env,
        500,
      );
    }
  }
  // The bundle follows the answer at once: `ne` while a yes is not marked,
  // absent otherwise. Written whether or not the row moved, which heals a
  // bundle that was lost.
  try {
    await writeVisitorBundle(env, customerId);
  } catch {
    console.error("[rawuser/special-category] bundle not written after the answer");
    return jsonWithCors(
      { error: "Saved, but the edge copy was not written. Send the same request again." },
      env,
      500,
    );
  }
  // One line to the founder on a yes that is news and not marked yet.
  if (changed && answer && Number(before.sensitive) !== 1) {
    const alert = sendAlert(env.ALERT_WEBHOOK_URL, specialCategoryAlert(customerId, before.domain));
    if (ctx) ctx.waitUntil(alert);
    else await alert;
  }
  const sensitive = Number(before.sensitive) === 1;
  return jsonWithCors(
    {
      ok: true,
      customer_id: customerId,
      special_category: answer,
      special_category_at: changed ? now : (before.special_category_at ?? null),
      changed,
      tag_withheld: tagWithheld({
        liveAt: before.live_at ?? null,
        sensitive,
        specialCategory: answer,
      }),
    },
    env,
    200,
  );
}
