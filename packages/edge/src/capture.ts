/**
 * /onboard/capture on the edge — the snippet's capture mode posts here.
 *
 * The operator opened their own page with `?rawuser_capture=<token>`; the
 * snippet sends the rendered DOM under that one-time token (minted by an
 * authenticated operator in the generation worker, same KV namespace).
 * `receiveCapture` in @rawuser/shared validates, cleans, stores for fifteen
 * minutes and burns the token. This route shares no code, no KV read and
 * no latency with /select; `capture:*` keys are never read by the visitor
 * path (pinned by test/capture.test.ts).
 *
 * GDPR: operator-initiated processing of their own public page, legitimate
 * interest in onboarding their own site, no visitor data.
 *
 * Side effect: customers.tag_seen_at flips from NULL to now once, off the
 * response path. It is a per-customer funnel stamp, not a visitor record.
 */

import { receiveCapture } from "@rawuser/shared";

interface CaptureEnv {
  VARIANTS: KVNamespace;
  DB: D1Database;
}

// The snippet runs on the customer's origin, so the allow-origin must be *;
// the token is the auth, not a cookie (credentials are never sent).
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "private, no-store",
};

export function capturePreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

export async function handleCapture(
  request: Request,
  env: CaptureEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const outcome = await receiveCapture(body, env.VARIANTS);
  if (outcome.status === 200) {
    const customerId = outcome.body.customer_id;
    ctx.waitUntil(
      env.DB.prepare("UPDATE customers SET tag_seen_at = COALESCE(tag_seen_at, ?) WHERE id = ?")
        .bind(Date.now(), customerId)
        .run()
        .catch(() => {}),
    );
  }
  return json(outcome.body, outcome.status);
}
