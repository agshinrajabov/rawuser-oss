/**
 * GET /admin/dna/suggest?customer_id=…[&refresh=1]
 *
 * Reads the customer's home page and returns evidence-checked candidates
 * for every field of the product brief (docs/specs/dna-suggestions.md).
 * Prefers the operator's rendered-DOM capture when one exists (CSR sites),
 * otherwise fetches https://{domain} with the detection fetcher (same UA,
 * timeout and 50 KB cap; URL never logged) and renders it with Browser Run
 * when the server sends a shell. Cached in KV for 24 hours per
 * customer; refresh=1 bypasses the cache.
 */

import type { DnaSuggestions } from "@rawuser/shared";
import { siteOrigin } from "@rawuser/shared";
import { cleanHtml, fetchPageHtml } from "../detect-elements.ts";
import { suggestDnaFromHtml } from "../dna-suggest.ts";
import { fetcherUserAgent } from "../install-config.ts";
import { OFF_HOST_LINE, OffHostRedirectError } from "../lib/public-url.ts";
import { renderIfShell } from "../lib/read-page.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { captureKey } from "./onboard.ts";
import { requireCustomerScope } from "./scope.ts";

const CACHE_TTL_S = 24 * 60 * 60;

export function suggestCacheKey(customerId: string): string {
  return `dna-suggest:${customerId}`;
}

export async function handleDnaSuggest(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  if (!customerId) {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  const refresh = url.searchParams.get("refresh") === "1";
  const cacheKey = suggestCacheKey(customerId);
  if (!refresh) {
    const cached = await env.VARIANTS.get(cacheKey);
    if (cached) {
      return jsonWithCors(JSON.parse(cached) as DnaSuggestions, env, 200);
    }
  }

  const customer = await env.DB.prepare("SELECT domain FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ domain: string }>();
  if (!customer?.domain) {
    return jsonWithCors({ error: "Customer has no domain" }, env, 404);
  }
  const domain = customer.domain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const pageUrl = siteOrigin(domain);

  let html: string;
  try {
    const captured = await env.VARIANTS.get(captureKey(customerId, "/"));
    // Without a capture, a page built in the browser is rendered
    // (docs/specs/install-friction.md A); a server-rendered page is not.
    // Only the recorded host: a redirect to another host is never followed.
    html = captured
      ? cleanHtml(captured)
      : (
          await renderIfShell(
            await fetchPageHtml(pageUrl, { sameHostAs: domain, userAgent: fetcherUserAgent(env) }),
            pageUrl,
            env,
          )
        ).html;
  } catch (e) {
    if (e instanceof OffHostRedirectError) {
      return jsonWithCors({ error: "Could not read the site", reason: OFF_HOST_LINE }, env, 502);
    }
    return jsonWithCors({ error: "Could not read the site" }, env, 502);
  }

  let suggestions: DnaSuggestions;
  try {
    suggestions = await suggestDnaFromHtml(html, pageUrl, env);
  } catch {
    console.error("[rawuser/dna-suggest] suggestion failed (non-critical)");
    return jsonWithCors({ error: "Could not read suggestions from the site" }, env, 502);
  }

  await env.VARIANTS.put(cacheKey, JSON.stringify(suggestions), { expirationTtl: CACHE_TTL_S });
  return jsonWithCors(suggestions, env, 200);
}
