/**
 * Pick on the page, operator side (docs/specs/visual-picker.md).
 *
 *   POST /admin/onboard/pick-token  { customer_id, page_path? }
 *     Mints a one-time token seeded with the current manifest for that
 *     path (detected or confirmed; empty when none). 30 minutes.
 *
 *   GET  /admin/onboard/pick-status?customer_id=X&page_path=Y
 *     When the picker has posted, stores the manifest unconfirmed for the
 *     path (the operator confirms on the next screen), deletes the KV key,
 *     returns { landed: true, manifest }. Otherwise { landed: false }.
 */

import type { Manifest } from "@rawuser/shared";
import { PICK_TTL_S, normalizePath, pagePathRefusal, pickKey, pickTokenKey } from "@rawuser/shared";
import { siteOrigin } from "@rawuser/shared";
import { sensitivePageRefusal } from "../lib/sensitive-guard.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { storeUnconfirmedManifest } from "./onboard.ts";
import { tagWithheldRefusal } from "./readiness.ts";
import { requireCustomerScope } from "./scope.ts";

interface PickTokenBody {
  customer_id: string;
  page_path?: string;
}

export async function handlePickToken(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  const params = body as Partial<PickTokenBody>;
  if (!params.customer_id || typeof params.customer_id !== "string") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const scope = requireCustomerScope(user, params.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  // The manifest pick refuses a page whose address names one account, as
  // the count pick does (event-paths.md §8, condition 3).
  const refusal = pagePathRefusal(params.page_path);
  if (refusal) return jsonWithCors({ error: refusal }, env, 400);

  const customer = await env.DB.prepare("SELECT id, domain FROM customers WHERE id = ?")
    .bind(params.customer_id)
    .first<{ id: string; domain: string }>();
  if (!customer) return jsonWithCors({ error: "Customer not found" }, env, 404);

  const pagePath = normalizePath(params.page_path);
  // A sensitive customer picks only on `/` and its kept sections
  // (docs/specs/sensitive-customers.md, condition 2): no link is minted.
  const kept = await sensitivePageRefusal(env.DB, customer.id, pagePath);
  if (kept) return jsonWithCors(kept, env, 409);
  // No pick link while the tag is withheld (readiness-check.md, condition 2).
  const withheld = await tagWithheldRefusal(env.DB, customer.id);
  if (withheld) return jsonWithCors(withheld, env, 409);
  const row = await env.DB.prepare(
    "SELECT manifest FROM element_manifests WHERE customer_id = ? AND page_path = ?",
  )
    .bind(customer.id, pagePath)
    .first<{ manifest: string }>();
  let seed: Manifest = {};
  if (row) {
    try {
      seed = JSON.parse(row.manifest) as Manifest;
    } catch {
      seed = {};
    }
  }

  const token = crypto.randomUUID().replace(/-/g, "");
  await env.VARIANTS.put(
    pickTokenKey(token),
    JSON.stringify({ customer_id: customer.id, page_path: pagePath, manifest: seed }),
    { expirationTtl: PICK_TTL_S },
  );
  return jsonWithCors(
    {
      token,
      page_path: pagePath,
      expires_in_s: PICK_TTL_S,
      link: `${siteOrigin(customer.domain)}${pagePath === "/" ? "/" : pagePath}#rawuser_pick=${token}`,
    },
    env,
    200,
  );
}

export async function handlePickStatus(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const refusal = pagePathRefusal(url.searchParams.get("page_path"));
  if (refusal) return jsonWithCors({ error: refusal }, env, 400);
  const pagePath = normalizePath(url.searchParams.get("page_path"));

  // A pick minted before the customer was marked sensitive never lands on a
  // page outside its kept sections (condition 2): it is dropped unread.
  const kept = await sensitivePageRefusal(env.DB, customerId, pagePath);
  if (kept) {
    await env.VARIANTS.delete(pickKey(customerId, pagePath));
    return jsonWithCors(kept, env, 409);
  }

  const raw = await env.VARIANTS.get(pickKey(customerId, pagePath));
  if (raw === null) return jsonWithCors({ landed: false, page_path: pagePath }, env, 200);

  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw) as Manifest;
  } catch {
    await env.VARIANTS.delete(pickKey(customerId, pagePath));
    return jsonWithCors({ error: "picked manifest unreadable" }, env, 500);
  }

  const customer = await env.DB.prepare("SELECT domain FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ domain: string }>();
  const domain = (customer?.domain ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const generatedAt = await storeUnconfirmedManifest(env.DB, {
    customer_id: customerId,
    page_path: pagePath,
    manifest,
    source_url: `https://${domain}${pagePath === "/" ? "/" : pagePath}`,
    cost_usd: 0,
  });
  await env.VARIANTS.delete(pickKey(customerId, pagePath));

  return jsonWithCors(
    { landed: true, page_path: pagePath, manifest, generated_at: generatedAt },
    env,
    200,
  );
}
