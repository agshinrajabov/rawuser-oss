/**
 * Pick on the page, edge side (docs/specs/visual-picker.md).
 *
 *   GET  /picker.js            the picker module (built from the snippet package)
 *   GET  /onboard/pick?token=  the seed manifest for a live token (not burned)
 *   POST /onboard/pick         {token, manifest} → validated, stored 30 min, token burned
 *                              {token, button, page_path} on a count link (§9): the
 *                              button to count, stored under `pick-count:*`, burned
 *
 * Operator-only: tokens are minted by an authenticated, scoped session in
 * the generation worker; a visitor never holds one. Shares no code and no
 * KV read with /select; `pick:*` and `pick-count:*` keys are never read by
 * the visitor path.
 */

import { readPickSeed, receivePick } from "@rawuser/shared";
import { etagMatches } from "./etag.ts";
import { PICKER_ETAG, PICKER_JS } from "./picker-asset.ts";

interface PickEnv {
  VARIANTS: KVNamespace;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "private, no-store",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

export function pickPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export async function handlePick(request: Request, env: PickEnv): Promise<Response> {
  if (request.method === "GET") {
    const token = new URL(request.url).searchParams.get("token");
    const out = await readPickSeed(token, env.VARIANTS);
    return json(out.body, out.status);
  }
  if (request.method !== "POST") return json({ error: "GET or POST" }, 405);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const out = await receivePick(body, env.VARIANTS);
  return json(out.body, out.status);
}

export function handlePickerAsset(request: Request): Response {
  if (etagMatches(request.headers.get("if-none-match"), PICKER_ETAG)) {
    return new Response(null, {
      status: 304,
      headers: { etag: PICKER_ETAG, "cache-control": "public, max-age=3600" },
    });
  }
  return new Response(PICKER_JS, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
      etag: PICKER_ETAG,
      "access-control-allow-origin": "*",
    },
  });
}
