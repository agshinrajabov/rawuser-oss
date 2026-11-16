/**
 * GET /carry: the same segment's copy for a customer's confirmed pages, for
 * the visit's later pages (body carry, docs/specs/interactive-text.md §3.1 b;
 * privacy review docs/research/privacy-review-body-carry.md).
 *
 * The request carries the customer id and the two segment labels only: no
 * visit marker, no referrer, no UTM, no page. The answer is the same for
 * everyone in the segment, so it is cached at the edge per segment; it holds
 * each confirmed page's `sections`, `targets`, `prompt_hash` and the
 * version's `body_id` (a fact about our text), never a score. No event is written: this is not a page view.
 * The `sections` leave out the words of a button the operator has not
 * turned on, as /select's do (visitor-manifest.ts, `bodyForVisitors`).
 *
 * The pages and their parts come from the visitor bundle in KV
 * (`v1:vm:{customer}`), the value /select answers from, so the two cannot
 * name different parts for one page (2026-10-12, docs/specs/
 * button-rewrite.md: until then this read `element_manifests` in D1 on
 * every answer the cache missed, and a button turned off in the bundle was
 * still a target here). No database on this path unless KV has no bundle,
 * which is /select's own fallback (bundle-writeback.ts).
 */

import {
  INTENT_DIMENSIONS,
  SOURCE_DIMENSIONS,
  isRenderBrowser,
  normalizePath,
  parseBodyId,
  variantKeyForPath,
} from "@rawuser/shared";
import type { VariantBody } from "@rawuser/shared/types";
import { bundleForAnswer } from "./bundle-writeback.ts";
import { type CopyIo, KV_COPY_TTL_S, type Kept, readThrough, remainingS } from "./kv-copy.ts";
import { bodyForVisitors, forVisitors, ownSiteCustomer } from "./visitor-manifest.ts";

interface CarryEnv {
  VARIANTS: KVNamespace;
  DB: D1Database;
  OWN_SITE_CUSTOMER?: string;
}

const CUSTOMER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_PATHS = 8;
const MAX_PATH_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024;
/** What a browser is told; the location's own entry lives less (stored below). */
const CACHE = "public, max-age=300";

/** The KV key whose presence turns a customer's carries off (condition 6). */
export function carryOffKey(customerId: string): string {
  return `v1:carry-off:${customerId}`;
}

/**
 * Whether the customer turned the carries off. One KV read through the copy
 * of kv-copy.ts (warm /select, docs/specs/faster-tag.md §10): read at
 * `cacheTtl` 60 s (R), used no later than 300 s after that read, counted from
 * KV, by every route (`/select`, `/carry`, `/s/{id}.js`). Until 2026-10-26
 * `/select` and `/carry` read it at KV's default minute and the tag at 300 s;
 * the privacy review accepted the 300 s bound on `/select` (session-carry.md
 * promises the behaviour, not a time).
 */
export async function isCarryOff(
  kv: KVNamespace,
  customerId: string,
  io: CopyIo = {},
): Promise<boolean> {
  try {
    const read = await readThrough(kv, carryOffKey(customerId), "carry", "text", io);
    return read.value !== null && read.value !== undefined;
  } catch {
    return false;
  }
}

function answer(bodies: Record<string, unknown>, cache = CACHE): Response {
  return new Response(JSON.stringify({ bodies }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cache,
      "access-control-allow-origin": "*",
    },
  });
}

/** The two labels when they name a known intent and source, else null. */
export function parseLabels(raw: string | null): { intent: string; source: string } | null {
  const m = /^([a-z]{2,16}):([a-z]{2,16})$/.exec(raw ?? "");
  if (!m) return null;
  const [, intent, source] = m as unknown as [string, string, string];
  if (!(INTENT_DIMENSIONS as readonly string[]).includes(intent)) return null;
  if (!(SOURCE_DIMENSIONS as readonly string[]).includes(source)) return null;
  return { intent, source };
}

export async function handleCarry(
  request: Request,
  url: URL,
  env: CarryEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  // Browser Run reading the page during setup gets nothing and fills no
  // cache entry (install-friction, privacy review condition 3).
  if (isRenderBrowser(request.headers)) return answer({}, "private, no-store");
  const customerId = url.searchParams.get("customer_id") ?? "";
  const labels = parseLabels(url.searchParams.get("carry"));
  if (!CUSTOMER_ID_RE.test(customerId) || !labels) return answer({});

  // One cache entry per customer and segment, whatever else the URL held.
  const keyUrl = new URL("/carry", url.origin);
  keyUrl.searchParams.set("customer_id", customerId);
  keyUrl.searchParams.set("carry", `${labels.intent}:${labels.source}`);
  const cacheKey = new Request(keyUrl.toString(), { method: "GET" });
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const hit = await cache?.match(cacheKey);
  if (hit) {
    // The browser gets its five minutes as before; the stored max-age is the location's.
    const headers = new Headers(hit.headers);
    headers.set("cache-control", CACHE);
    return new Response(hit.body, { status: hit.status, headers });
  }

  const started = Date.now();
  const { bodies, at } = await collect(env, ctx, customerId, labels.intent, labels.source, started);
  const res = answer(bodies);
  if (cache) {
    // The location keeps the answer only for what is left of the copy's bound
    // (kv-copy.ts, `now - at + R <= 300 s`), timed from the oldest KV read it
    // was made of: at most 240 s, never 300 s on top of a 60 s read
    // (privacy review, re-review of 2026-10-26). Nothing left: not stored.
    const left = storedMaxAgeS(at, Date.now());
    if (left > 0) {
      const stored = res.clone();
      const headers = new Headers(stored.headers);
      headers.set("cache-control", `public, max-age=${left}`);
      ctx.waitUntil(
        cache.put(cacheKey, new Response(stored.body, { status: stored.status, headers })),
      );
    }
  }
  return res;
}

/** Seconds a location may keep a /carry answer whose oldest KV read began at `at`. */
export function storedMaxAgeS(at: number, now: number): number {
  const k: Kept = { v: null, at, r: KV_COPY_TTL_S };
  return remainingS(k, now);
}

async function collect(
  env: CarryEnv,
  ctx: ExecutionContext,
  customerId: string,
  intent: string,
  source: string,
  started: number,
): Promise<{ bodies: Record<string, unknown>; at: number }> {
  // The carry switch and the bundle in one batch. The switch may come from
  // this isolate's copy, read earlier: the answer is as old as its oldest read.
  const [offRead, bundle] = await Promise.all([
    readThrough(env.VARIANTS, carryOffKey(customerId), "carry", "text", {}).catch(() => null),
    bundleForAnswer(env, customerId, (write) => ctx.waitUntil(write)),
  ]);
  const at = Math.min(started, offRead?.kept.at ?? started);
  const off = offRead !== null && offRead.value !== null && offRead.value !== undefined;
  if (off || !bundle) return { bodies: {}, at };
  // The confirmed pages as the bundle lists them, the first eight by path
  // (the order the database read gave: the root page first).
  // A KV value is whatever was written: a bundle without pages hands out none.
  const pages = bundle.pages && typeof bundle.pages === "object" ? bundle.pages : {};
  const rows = Object.entries(pages)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_PATHS);
  const out: Record<string, unknown> = {};
  let total = 0;
  for (const [pagePath, manifest] of rows) {
    // A page whose manifest is not one: skipped, the others stand.
    if (!manifest || typeof manifest !== "object") continue;
    const path = normalizePath(pagePath);
    // The same cascade /select walks: this path, then the root page.
    let variant: VariantBody | null = null;
    for (const p of path === "/" ? ["/"] : [path, "/"]) {
      for (const src of [source, "default"]) {
        variant = await env.VARIANTS.get<VariantBody>(
          variantKeyForPath(customerId, p, intent as never, src as never),
          // KV's default minute: R of a body (kv-copy.ts).
          "json",
        );
        if (variant) break;
      }
      if (variant) break;
    }
    if (!variant) continue;
    // The parts as /select gives them for this page: the bundle's, which
    // holds no button the operator has not turned on.
    const targets = forVisitors(manifest);
    // The version's id rides along (docs/specs/proof-engine.md, C), so a
    // page written early from the tab's copy reports the words it showed.
    const bodyId = parseBodyId(variant.body_id);
    // And the words as /select gives them for this page: without those of a
    // button that is off (task H9), from the same manifest, so the tab's
    // copy and the edge's answer are the same text.
    const body = {
      sections: bodyForVisitors(customerId, variant, manifest, ownSiteCustomer(env)).sections,
      targets,
      prompt_hash: variant.prompt_hash,
      ...(bodyId ? { body_id: bodyId } : {}),
    };
    const size = JSON.stringify(body).length;
    if (size > MAX_PATH_BYTES || total + size > MAX_TOTAL_BYTES) continue;
    total += size;
    out[path] = body;
  }
  return { bodies: out, at };
}
