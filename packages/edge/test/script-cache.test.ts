/**
 * The location copy of /s/{id}.js (docs/specs/faster-tag.md, option A):
 * hit, stale and miss paths, the scripts that are never kept, the rebuild
 * that carries a bundle change, and Server-Timing on every answer.
 */
import { closedKey, hideRulesKey, richKey, visitorBundleKey } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { carryOffKey } from "../src/body-carry.ts";
import { BOOT_CORE, BOOT_ETAG } from "../src/boot-asset.ts";
import {
  COPY_FRESH_MS,
  COPY_MAX_AGE_MS,
  copyKey,
  handleCustomerScript,
} from "../src/customer-script.ts";
import worker from "../src/index.ts";
import { SNIPPET_ETAG } from "../src/snippet-asset.ts";

const T0 = 1_800_000_000_000;
const STALE_OK = "public, max-age=300, stale-while-revalidate=86400";
const LIVE_BUNDLE = { v: 1, pages: { "/": {} }, conv: [] };

/** A KV whose values can change between requests; records every read and its options. */
function liveKv(data: Record<string, unknown>) {
  const reads: { key: string; opts: unknown }[] = [];
  let failing = false;
  const kv = {
    async get(key: string, opts?: unknown) {
      reads.push({ key, opts });
      if (failing) throw new Error("kv down");
      const v = data[key];
      if (v === undefined) return null;
      const json = (opts as { type?: string } | undefined)?.type === "json";
      return json ? v : typeof v === "string" ? v : JSON.stringify(v);
    },
    async put() {},
    async delete() {},
  } as unknown as KVNamespace;
  return {
    kv,
    data,
    reads,
    fail(on: boolean) {
      failing = on;
    },
  };
}

/** An in-memory Cache API: stores status, headers and text. */
function fakeCache() {
  const store = new Map<string, { headers: Headers; text: string }>();
  const ops: string[] = [];
  const url = (r: RequestInfo | URL) =>
    typeof r === "string" ? r : r instanceof URL ? r.toString() : r.url;
  const cache = {
    async match(r: RequestInfo | URL) {
      ops.push("match");
      const hit = store.get(url(r));
      return hit ? new Response(hit.text, { headers: hit.headers }) : undefined;
    },
    async put(r: RequestInfo | URL, res: Response) {
      ops.push("put");
      store.set(url(r), { headers: new Headers(res.headers), text: await res.text() });
    },
    async delete(r: RequestInfo | URL) {
      ops.push("delete");
      return store.delete(url(r));
    },
  } as unknown as Cache;
  return { cache, store, ops };
}

function ctxCollect() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    async flush() {
      while (pending.length) await pending.shift();
    },
  };
}

const env = (kv: KVNamespace) => ({ VARIANTS: kv });

async function get(
  kv: KVNamespace,
  cache: Cache,
  ctx: ExecutionContext,
  now: number,
  init: RequestInit = {},
  url = "https://edge.test/s/acme.js",
) {
  return handleCustomerScript(new Request(url, init), env(kv), "acme", { ctx, cache, now });
}

function live(extra: Record<string, unknown> = {}) {
  return liveKv({
    [hideRulesKey("acme")]: JSON.stringify({ "/": ["h1"] }),
    [visitorBundleKey("acme")]: LIVE_BUNDLE,
    ...extra,
  });
}

describe("/s/{id}.js location copy", () => {
  it("a miss reads KV, answers, and keeps a copy; the next request within a minute is a hit with no KV read", async () => {
    const k = live();
    const c = fakeCache();
    const w = ctxCollect();
    const first = await get(k.kv, c.cache, w.ctx, T0);
    expect(first.status).toBe(200);
    expect(first.headers.get("server-timing")).toMatch(
      /^cache;desc=miss, kv;dur=\d+, total;dur=\d+$/,
    );
    expect(first.headers.get("age")).toBeNull();
    const body = await first.text();
    await w.flush();
    expect(c.store.has(copyKey("https://edge.test", "acme"))).toBe(true);

    const readsBefore = k.reads.length;
    const second = await get(k.kv, c.cache, w.ctx, T0 + COPY_FRESH_MS);
    expect(k.reads.length).toBe(readsBefore);
    expect(second.headers.get("server-timing")).toMatch(/^cache;desc=hit, total;dur=\d+$/);
    expect(second.headers.get("age")).toBe(String(COPY_FRESH_MS / 1000));
    expect(second.headers.get("cache-control")).toBe(STALE_OK);
    expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
    expect(second.headers.get("access-control-allow-origin")).toBe("*");
    expect(second.headers.get("content-type")).toContain("javascript");
    expect(await second.text()).toBe(body);
    await w.flush();
    expect(c.ops.filter((o) => o === "put")).toHaveLength(1);
  });

  it("a stale copy is answered at once and rebuilt in the background", async () => {
    const k = live();
    const c = fakeCache();
    const w = ctxCollect();
    await get(k.kv, c.cache, w.ctx, T0);
    await w.flush();
    const readsBefore = k.reads.length;
    const later = T0 + COPY_FRESH_MS + 1000;
    const res = await get(k.kv, c.cache, w.ctx, later);
    expect(res.headers.get("server-timing")).toMatch(/^cache;desc=stale, total;dur=\d+$/);
    expect(res.headers.get("age")).toBe("61");
    // The answer did not wait for the rebuild: the copy is still the old one.
    const key = copyKey("https://edge.test", "acme");
    expect(c.store.get(key)?.headers.get("x-rw-built")).toBe(String(T0));
    await w.flush();
    expect(k.reads.length).toBeGreaterThan(readsBefore);
    expect(c.store.get(key)?.headers.get("x-rw-built")).toBe(String(later));
  });

  it("a bundle or hide rule change reaches the copy through the rebuild (invalidation)", async () => {
    const k = live();
    const c = fakeCache();
    const w = ctxCollect();
    const old = await get(k.kv, c.cache, w.ctx, T0);
    const oldBody = await old.text();
    await w.flush();
    // The operator confirms a second page: new hide rules and a new bundle.
    k.data[hideRulesKey("acme")] = JSON.stringify({ "/": ["h1"], "/pricing": ["h2"] });
    k.data[visitorBundleKey("acme")] = { v: 1, pages: { "/": {}, "/pricing": {} }, conv: [] };
    // Inside the fresh minute: still the copy.
    const within = await get(k.kv, c.cache, w.ctx, T0 + 30_000);
    expect(await within.text()).toBe(oldBody);
    // After it: the old copy once, rebuilt behind it.
    const stale = await get(k.kv, c.cache, w.ctx, T0 + COPY_FRESH_MS + 1);
    expect(await stale.text()).toBe(oldBody);
    await w.flush();
    const next = await get(k.kv, c.cache, w.ctx, T0 + COPY_FRESH_MS + 2);
    expect(next.headers.get("server-timing")).toMatch(/^cache;desc=hit/);
    expect(next.headers.get("etag")).not.toBe(old.headers.get("etag"));
    const text = await next.text();
    expect(text).toContain('"/pricing":["h2"]');
    expect(text).toContain('"p":["/","/pricing"]');
  });

  it("a copy older than a day is not answered: KV is read first", async () => {
    const k = live();
    const c = fakeCache();
    const w = ctxCollect();
    await get(k.kv, c.cache, w.ctx, T0);
    await w.flush();
    const readsBefore = k.reads.length;
    const res = await get(k.kv, c.cache, w.ctx, T0 + COPY_MAX_AGE_MS + 1);
    expect(res.headers.get("server-timing")).toMatch(/^cache;desc=miss, kv;dur=/);
    expect(k.reads.length).toBeGreaterThan(readsBefore);
  });

  it("a 304 from the copy renews the same policy and carries Age", async () => {
    const k = live();
    const c = fakeCache();
    const w = ctxCollect();
    const first = await get(k.kv, c.cache, w.ctx, T0);
    await w.flush();
    const etag = first.headers.get("etag") ?? "";
    for (const sent of [etag, `W/${etag}`]) {
      const res = await get(k.kv, c.cache, w.ctx, T0 + 5000, {
        headers: { "if-none-match": sent },
      });
      expect(res.status).toBe(304);
      expect(res.headers.get("cache-control")).toBe(STALE_OK);
      expect(res.headers.get("age")).toBe("5");
      expect(res.headers.get("server-timing")).toMatch(/^cache;desc=hit/);
    }
  });

  it("the off script is never kept, and a copy is dropped once the customer is closed", async () => {
    // Closed from the start: built from KV every time, nothing stored.
    const gone = liveKv({ [closedKey("acme")]: "1", [visitorBundleKey("acme")]: LIVE_BUNDLE });
    const c1 = fakeCache();
    const w1 = ctxCollect();
    for (const at of [T0, T0 + 1000]) {
      const res = await get(gone.kv, c1.cache, w1.ctx, at);
      expect(await res.text()).toContain('"off":1');
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      expect(res.headers.get("server-timing")).toMatch(/^cache;desc=miss/);
    }
    await w1.flush();
    expect(c1.store.size).toBe(0);

    // Closed after a copy was kept: the stale answer's rebuild drops it, and
    // the isolate that saw the tombstone never answers from a copy again.
    const k = live();
    const c = fakeCache();
    const w = ctxCollect();
    await get(k.kv, c.cache, w.ctx, T0);
    await w.flush();
    k.data[closedKey("acme")] = "1";
    // The isolate memo of closed.ts keeps "open" five minutes; past it the rebuild sees the tombstone.
    const at = T0 + 6 * 60_000;
    await get(k.kv, c.cache, w.ctx, at);
    await w.flush();
    expect(c.store.size).toBe(0);
    const after = await get(k.kv, c.cache, w.ctx, at + 1000);
    expect(await after.text()).toContain('"off":1');
  });

  it("an isolate that knows the customer is closed never answers from a copy", async () => {
    const k = live();
    const c = fakeCache();
    const w = ctxCollect();
    await get(k.kv, c.cache, w.ctx, T0);
    await w.flush();
    k.data[closedKey("acme")] = "1";
    // Another route of the same isolate saw the tombstone (the memo is per KV binding).
    const { isClosed } = await import("../src/closed.ts");
    await isClosed(k.kv, "acme", T0 + 6 * 60_000);
    const res = await get(k.kv, c.cache, w.ctx, T0 + 6 * 60_000 + 1);
    expect(await res.text()).toContain('"off":1');
    expect(res.headers.get("server-timing")).toMatch(/^cache;desc=miss/);
  });

  it("an audit customer's script is never kept, before or after its end, and a copy turns into none", async () => {
    for (const bundle of [
      { ...LIVE_BUNDLE, a: 1, ad: "acme.com", ae: T0 + 10 * 86_400_000 },
      { ...LIVE_BUNDLE, a: 1, ad: "acme.com", ae: T0 - 1 },
      { ...LIVE_BUNDLE, a: 1 },
    ]) {
      const k = liveKv({ [visitorBundleKey("acme")]: bundle });
      const c = fakeCache();
      const w = ctxCollect();
      await get(k.kv, c.cache, w.ctx, T0);
      await get(k.kv, c.cache, w.ctx, T0 + 1000);
      await w.flush();
      expect(c.store.size).toBe(0);
      expect(c.ops).not.toContain("put");
    }
    // A kept copy whose customer's bundle turns into an audit's is dropped by the rebuild.
    const k = live();
    const c = fakeCache();
    const w = ctxCollect();
    await get(k.kv, c.cache, w.ctx, T0);
    await w.flush();
    k.data[visitorBundleKey("acme")] = { ...LIVE_BUNDLE, a: 1, ad: "acme.com" };
    await get(k.kv, c.cache, w.ctx, T0 + COPY_FRESH_MS + 1);
    await w.flush();
    expect(c.store.size).toBe(0);
    const res = await get(k.kv, c.cache, w.ctx, T0 + COPY_FRESH_MS + 2);
    expect(await res.text()).toContain('"ad":"acme.com"');
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("a script before go live or without a read bundle is never kept", async () => {
    for (const data of [
      { [visitorBundleKey("acme")]: { v: 1, pages: {}, conv: [] } },
      {},
      { [visitorBundleKey("acme")]: { pages: { "/": {} } } },
    ]) {
      const k = liveKv(data);
      const c = fakeCache();
      const w = ctxCollect();
      const res = await get(k.kv, c.cache, w.ctx, T0);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
      await w.flush();
      expect(c.store.size).toBe(0);
    }
  });

  it("a stored copy of any other policy is never answered", async () => {
    const k = live();
    const c = fakeCache();
    const w = ctxCollect();
    await get(k.kv, c.cache, w.ctx, T0);
    await w.flush();
    const key = copyKey("https://edge.test", "acme");
    const stored = c.store.get(key);
    stored?.headers.set("x-rw-policy", "public, max-age=300");
    const res = await get(k.kv, c.cache, w.ctx, T0 + 1000);
    expect(res.headers.get("server-timing")).toMatch(/^cache;desc=miss/);
  });

  it("a failed rebuild keeps the copy; a broken cache falls back to KV", async () => {
    const k = live();
    const c = fakeCache();
    const w = ctxCollect();
    const first = await get(k.kv, c.cache, w.ctx, T0);
    const body = await first.text();
    await w.flush();
    k.fail(true);
    const res = await get(k.kv, c.cache, w.ctx, T0 + COPY_FRESH_MS + 1);
    expect(await res.text()).toBe(body);
    await w.flush();
    expect(c.store.size).toBe(1);
    k.fail(false);

    const broken = {
      match: async () => {
        throw new Error("cache down");
      },
      put: async () => {
        throw new Error("cache down");
      },
      delete: async () => false,
    } as unknown as Cache;
    const ok = await get(k.kv, broken, w.ctx, T0);
    await w.flush();
    expect(ok.status).toBe(200);
    expect(ok.headers.get("server-timing")).toMatch(/^cache;desc=miss/);
  });

  it("holds nothing per visitor: the copy is the same whatever the request carries", async () => {
    const k = live();
    const c = fakeCache();
    const w = ctxCollect();
    const a = await get(k.kv, c.cache, w.ctx, T0, {
      headers: { "user-agent": "Browser A", cookie: "x=1", referer: "https://a.example/p" },
    });
    const bodyA = await a.text();
    await w.flush();
    const stored = c.store.get(copyKey("https://edge.test", "acme"));
    expect(stored?.text).toBe(bodyA);
    expect(stored?.text).not.toContain("Browser A");
    expect(stored?.text).not.toContain("a.example");
    // Another visitor, another query string: the same copy, the same key.
    const b = await get(
      k.kv,
      c.cache,
      w.ctx,
      T0 + 1000,
      { headers: { "user-agent": "Browser B" } },
      "https://edge.test/s/acme.js?utm_source=x&v=abc",
    );
    expect(await b.text()).toBe(bodyA);
    expect(c.store.size).toBe(1);
    // The stored headers name no request value either.
    for (const [name] of stored?.headers ?? []) {
      expect(["content-type", "cache-control", "x-rw-etag", "x-rw-policy", "x-rw-built"]).toContain(
        name,
      );
    }
  });

  it("the key names the edge's origin, the customer and the snippet build", async () => {
    const key = copyKey("https://edge.example.com", "acme");
    // The boot's build since the split (faster-tag.md step 4): a copy is
    // always the boot, and the boot names its core, so a new core is a new key.
    expect(key).toBe(
      `https://edge.example.com/s/acme.js?build=${encodeURIComponent(BOOT_ETAG.replace(/"/g, ""))}`,
    );
    expect(BOOT_CORE).toBe(SNIPPET_ETAG.replace(/"/g, ""));
    expect(copyKey("https://edge-old.example.com", "acme")).not.toBe(key);
    // Each host keeps its own copy, since the script names its own origin as `e`.
    const k = live();
    const c = fakeCache();
    const w = ctxCollect();
    await get(k.kv, c.cache, w.ctx, T0, {}, "https://edge.example.com/s/acme.js");
    await get(k.kv, c.cache, w.ctx, T0, {}, "https://edge-old.example.com/s/acme.js");
    await w.flush();
    expect(c.store.size).toBe(2);
    expect(c.store.get(copyKey("https://edge-old.example.com", "acme"))?.text).toContain(
      '"e":"https://edge-old.example.com"',
    );
  });

  it("the rich pages are kept 300 s at the location; the carry switch and the bundle at R (60 s, kv-copy.ts); the hide rules keep KV's minute", async () => {
    const k = live({ [richKey("acme")]: '["/"]', [carryOffKey("acme")]: "1" });
    const c = fakeCache();
    const w = ctxCollect();
    await get(k.kv, c.cache, w.ctx, T0);
    const opts = (key: string) => k.reads.find((r) => r.key === key)?.opts;
    expect(opts(richKey("acme"))).toEqual({ cacheTtl: 300 });
    expect(opts(carryOffKey("acme"))).toEqual({ cacheTtl: 60 });
    expect(opts(visitorBundleKey("acme"))).toEqual({ type: "json", cacheTtl: 60 });
    expect(opts(hideRulesKey("acme"))).toBeUndefined();
  });

  it("without a Cache API (workers.dev, tests) the route reads KV as before and still sends Server-Timing", async () => {
    const k = live();
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const res = await worker.fetch(
      new Request("https://edge.test/s/acme.js"),
      { VARIANTS: k.kv, DB: {} as D1Database, ENVIRONMENT: "test", PREVIEW_TOKEN: "" },
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("server-timing")).toMatch(
      /^cache;desc=miss, kv;dur=\d+, total;dur=\d+$/,
    );
    expect(res.headers.get("timing-allow-origin")).toBe("*");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });
});
