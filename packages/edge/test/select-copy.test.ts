/**
 * Warm /select (docs/specs/faster-tag.md §10, "Warm /select (2026-10-26)"):
 * the copy of kv-copy.ts and warm on the tag, against the privacy review's
 * conditions 2 and 3 of 2026-10-26.
 */
import { closedKey, customerLangKey, variantKeyForPath, visitorBundleKey } from "@rawuser/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { carryOffKey } from "../src/body-carry.ts";
import { handleCustomerScript } from "../src/customer-script.ts";
import worker from "../src/index.ts";
import {
  COPY_BOUND_MS,
  KV_R_S,
  type Kept,
  copyCacheKey,
  forgetCopy,
  inMemory,
  keep,
  readThrough,
  remainingS,
  servable,
} from "../src/kv-copy.ts";
import { MAX_WARM_READS, warmKeys } from "../src/select-warm.ts";

const T0 = Date.parse("2026-10-26T14:00:00Z");
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterAll(() => {
  vi.useRealTimers();
});

const CUSTOMER = "acme";
const MANIFEST = { "hero.headline": { css: ["h1"], text: ["Old"], structural: "h1" } };
const BUNDLE = {
  v: 1,
  pages: { "/": MANIFEST, "/pricing": MANIFEST },
  conv: [],
};
const STUB = (headline: string) => ({
  customer_id: CUSTOMER,
  profile_key: "x",
  sections: { hero: { kind: "hero", headline } },
  generated_at: 0,
  prompt_hash: "p",
});
const vkey = (path: string, intent: string, source: string) =>
  variantKeyForPath(CUSTOMER, path, intent, source);

function baseData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [visitorBundleKey(CUSTOMER)]: BUNDLE,
    [customerLangKey(CUSTOMER)]: JSON.stringify({ "/": "en" }),
    [vkey("/", "problem", "ai")]: STUB("Root for AI"),
    [vkey("/", "problem", "default")]: STUB("Root default"),
    [vkey("/pricing", "pricing", "default")]: STUB("Pricing"),
    [vkey("/pricing", "pricing", "ai")]: STUB("Pricing for AI"),
    ...extra,
  };
}

/** A KV that records every read with its options and can change between requests. */
function recordingKv(data: Record<string, unknown>) {
  const reads: Array<{ key: string; opts: unknown }> = [];
  let failing = false;
  const kv = {
    async get(key: string, opts?: unknown) {
      reads.push({ key, opts });
      if (failing) throw new Error("kv down");
      const v = data[key];
      if (v === undefined) return null;
      const type = typeof opts === "string" ? opts : (opts as { type?: string } | undefined)?.type;
      return type === "json" ? v : typeof v === "string" ? v : JSON.stringify(v);
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

/** An in-memory Cache API that keeps the stored headers and text. */
function fakeCache() {
  const store = new Map<string, { headers: Headers; text: string }>();
  const ops: string[] = [];
  const url = (r: RequestInfo | URL) =>
    typeof r === "string" ? r : r instanceof URL ? r.toString() : r.url;
  const cache = {
    async match(r: RequestInfo | URL) {
      ops.push(`match ${url(r)}`);
      const hit = store.get(url(r));
      return hit ? new Response(hit.text, { headers: hit.headers }) : undefined;
    },
    async put(r: RequestInfo | URL, res: Response) {
      ops.push(`put ${url(r)}`);
      store.set(url(r), { headers: new Headers(res.headers), text: await res.text() });
    },
    async delete(r: RequestInfo | URL) {
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

const db = {
  prepare: () => ({
    bind: () => ({
      run: async () => ({}),
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
  }),
} as unknown as D1Database;

/** Install a fake `caches.default` for the worker's /select route. */
function withCaches() {
  const c = fakeCache();
  (globalThis as unknown as { caches?: unknown }).caches = { default: c.cache };
  return c;
}
afterEach(() => {
  (globalThis as unknown as { caches?: unknown }).caches = undefined;
});

async function select(
  kv: KVNamespace,
  query: string,
  opts: { off?: boolean; headers?: HeadersInit } = {},
) {
  const w = ctxCollect();
  const res = await worker.fetch(
    new Request(`https://edge.test/select?customer_id=${CUSTOMER}&self_host=site.test&${query}`, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh)", ...(opts.headers ?? {}) },
    }),
    {
      VARIANTS: kv,
      DB: db,
      ENVIRONMENT: "test",
      PREVIEW_TOKEN: "",
      HOLDOUT_PERCENT: "0",
      ...(opts.off ? { SELECT_COPY: "off" } : {}),
    },
    w.ctx,
  );
  await w.flush();
  return {
    status: res.status,
    text: await res.text(),
    timing: res.headers.get("server-timing") ?? "",
  };
}

const QUERIES = [
  "path=%2F",
  "path=%2F&utm_source=chatgpt.com",
  "path=%2F&utm_source=chatgpt.com&plang=en",
  "path=%2Fpricing&utm_source=chatgpt.com",
  "path=%2Fpricing&ss=1&carry=problem:ai",
  "path=%2Fnot-listed&utm_source=chatgpt.com",
];

describe("the /select answer is the same with the copy on and off", () => {
  it("on one KV state: off, on (cold), on (from memory), on (from the Cache API)", async () => {
    for (const q of QUERIES) {
      const off = await select(recordingKv(baseData()).kv, q, { off: true });
      const k = recordingKv(baseData());
      withCaches();
      const cold = await select(k.kv, q);
      const warm = await select(k.kv, q);
      // A new isolate at the same location: memory empty, the Cache API kept.
      forgetCopy(k.kv);
      const fromCache = await select(k.kv, q);
      expect(off.status).toBe(200);
      expect(cold.text, q).toBe(off.text);
      expect(warm.text, q).toBe(off.text);
      expect(fromCache.text, q).toBe(off.text);
    }
  });

  it("Server-Timing names where the batch came from: miss, then mem, then hit", async () => {
    const k = recordingKv(baseData());
    withCaches();
    const q = "path=%2F&utm_source=chatgpt.com";
    expect((await select(k.kv, q)).timing).toMatch(/kv;dur=\d+, cache;desc=miss, total;dur=\d+/);
    expect((await select(k.kv, q)).timing).toMatch(/cache;desc=mem/);
    forgetCopy(k.kv);
    expect((await select(k.kv, q)).timing).toMatch(/cache;desc=hit/);
  });

  it("a warm answer reads no KV; SELECT_COPY off reads KV every time", async () => {
    const k = recordingKv(baseData());
    await select(k.kv, "path=%2F&utm_source=chatgpt.com");
    const before = k.reads.length;
    await select(k.kv, "path=%2F&utm_source=chatgpt.com");
    expect(k.reads.length).toBe(before);
    const o = recordingKv(baseData());
    await select(o.kv, "path=%2F&utm_source=chatgpt.com", { off: true });
    const once = o.reads.length;
    await select(o.kv, "path=%2F&utm_source=chatgpt.com", { off: true });
    expect(o.reads.length).toBe(once * 2);
    expect(inMemory(o.kv, visitorBundleKey(CUSTOMER))).toBeNull();
  });

  it("a deleted customer is answered off whether the copy is on or off", async () => {
    const data = baseData({ [closedKey(CUSTOMER)]: "1" });
    const off = await select(recordingKv(data).kv, "path=%2F&utm_source=chatgpt.com", {
      off: true,
    });
    const k = recordingKv(data);
    const on1 = await select(k.kv, "path=%2F&utm_source=chatgpt.com");
    const on2 = await select(k.kv, "path=%2F&utm_source=chatgpt.com");
    expect(off.text).toContain('"off":1');
    expect(on1.text).toBe(off.text);
    expect(on2.text).toBe(off.text);
  });
});

describe("nothing past its bound", () => {
  it("served while now - at + R <= 300 s, then read from KV again", async () => {
    const k = recordingKv(baseData());
    const key = visitorBundleKey(CUSTOMER);
    const r = KV_R_S.bundle;
    await readThrough(k.kv, key, "bundle", "json", { now: T0 });
    expect(k.reads).toHaveLength(1);
    const last = T0 + COPY_BOUND_MS - r * 1000;
    expect((await readThrough(k.kv, key, "bundle", "json", { now: last })).from).toBe("mem");
    expect(k.reads).toHaveLength(1);
    const past = await readThrough(k.kv, key, "bundle", "json", { now: last + 1 });
    expect(past.from).toBe("miss");
    expect(k.reads).toHaveLength(2);
  });

  it("a Cache API value past its bound, without `at` or `r`, or unparsable, is never served", async () => {
    const k = recordingKv(baseData());
    const c = fakeCache();
    const origin = "https://edge.test";
    const key = visitorBundleKey(CUSTOMER);
    const ck = copyCacheKey(origin, key);
    const put = (text: string) =>
      c.store.set(ck, { headers: new Headers({ "cache-control": "max-age=300" }), text });
    const io = { cache: c.cache, origin, now: T0 };
    for (const text of [
      JSON.stringify({ v: { v: 1, pages: {}, conv: ["stale"] }, at: T0 - 240_001, r: 60 }),
      JSON.stringify({ v: { v: 1, pages: {}, conv: ["no-at"] }, r: 60 }),
      JSON.stringify({ v: { v: 1, pages: {}, conv: ["no-r"] }, at: T0 }),
      JSON.stringify({ v: { v: 1, pages: {}, conv: ["future"] }, at: T0 + 10_000, r: 60 }),
      "not json",
    ]) {
      forgetCopy(k.kv);
      put(text);
      const read = await readThrough(k.kv, key, "bundle", "json", io);
      expect(read.from, text).toBe("miss");
      expect(read.value).toEqual(BUNDLE);
    }
  });

  it("a Cache API value taken into memory keeps its `at`: the bound never restarts", async () => {
    const k = recordingKv(baseData());
    const c = fakeCache();
    const origin = "https://edge.test";
    const key = visitorBundleKey(CUSTOMER);
    const at = T0 - 200_000;
    c.store.set(copyCacheKey(origin, key), {
      headers: new Headers(),
      text: JSON.stringify({ v: BUNDLE, at, r: 60 }),
    });
    const hit = await readThrough(k.kv, key, "bundle", "json", { cache: c.cache, origin, now: T0 });
    expect(hit.from).toBe("hit");
    expect(inMemory(k.kv, key, T0)?.at).toBe(at);
    // 40 s later the value is 240 s old: its last moment, then KV.
    expect((await readThrough(k.kv, key, "bundle", "json", { now: T0 + 40_000 })).from).toBe("mem");
    expect((await readThrough(k.kv, key, "bundle", "json", { now: T0 + 40_001 })).from).toBe(
      "miss",
    );
  });

  it("the Cache API object's max-age is never longer than the value's remaining bound", async () => {
    const k = recordingKv(baseData());
    const c = fakeCache();
    const w = ctxCollect();
    const origin = "https://edge.test";
    const key = visitorBundleKey(CUSTOMER);
    const at = T0 - 100_000;
    const kept: Kept = { v: BUNDLE, at, r: 60 };
    keep(k.kv, key, "bundle", kept, { cache: c.cache, origin, defer: w.ctx.waitUntil }, T0);
    await w.flush();
    const stored = c.store.get(copyCacheKey(origin, key));
    expect(stored?.headers.get("cache-control")).toBe(`max-age=${remainingS(kept, T0)}`);
    expect(remainingS(kept, T0)).toBe(140);
    // A value with no time left is not stored at all.
    const done: Kept = { v: BUNDLE, at: T0 - 240_000, r: 60 };
    const c2 = fakeCache();
    keep(k.kv, key, "bundle", done, { cache: c2.cache, origin, defer: w.ctx.waitUntil }, T0);
    await w.flush();
    expect(c2.store.size).toBe(0);
    expect(servable(done, T0)).toBe(true);
    expect(servable(done, T0 + 1)).toBe(false);
  });

  it("a refresh reads KV only, after 30 s, and carries the new value; a failed refresh keeps the old to its bound", async () => {
    const k = recordingKv(baseData());
    const c = fakeCache();
    const w = ctxCollect();
    const origin = "https://edge.test";
    const key = visitorBundleKey(CUSTOMER);
    const io = (now: number) => ({ cache: c.cache, origin, defer: w.ctx.waitUntil, now });
    await readThrough(k.kv, key, "bundle", "json", io(T0));
    await w.flush();
    k.data[key] = { ...BUNDLE, h: 20 };
    // Inside 30 s: served, no refresh.
    await readThrough(k.kv, key, "bundle", "json", io(T0 + 30_000));
    await w.flush();
    expect(k.reads).toHaveLength(1);
    // After 30 s: served from memory, refreshed from KV in the background.
    vi.setSystemTime(T0 + 31_000);
    const served = await readThrough(k.kv, key, "bundle", "json", io(T0 + 31_000));
    expect(served.from).toBe("mem");
    expect((served.value as { h?: number }).h).toBeUndefined();
    c.ops.length = 0;
    await w.flush();
    expect(k.reads).toHaveLength(2);
    expect(c.ops.some((o) => o.startsWith("match"))).toBe(false);
    const next = await readThrough(k.kv, key, "bundle", "json", io(T0 + 32_000));
    expect((next.value as { h?: number }).h).toBe(20);
    // A failed refresh: the value stays until its bound, then KV is read first.
    k.fail(true);
    vi.setSystemTime(T0 + 70_000);
    await readThrough(k.kv, key, "bundle", "json", io(T0 + 70_000));
    await w.flush();
    const kept = inMemory(k.kv, key, T0 + 70_000);
    expect(kept?.at).toBe(T0 + 31_000);
    await expect(
      readThrough(k.kv, key, "bundle", "json", io(T0 + 31_000 + 240_001)),
    ).rejects.toThrow("kv down");
    vi.setSystemTime(T0);
  });

  it("a missing or unreadable bundle is never kept", async () => {
    const k = recordingKv({});
    await readThrough(k.kv, visitorBundleKey(CUSTOMER), "bundle", "json", { now: T0 });
    expect(inMemory(k.kv, visitorBundleKey(CUSTOMER), T0)).toBeNull();
    const j = recordingKv({ [visitorBundleKey(CUSTOMER)]: { pages: {} } });
    await readThrough(j.kv, visitorBundleKey(CUSTOMER), "bundle", "json", { now: T0 });
    expect(inMemory(j.kv, visitorBundleKey(CUSTOMER), T0)).toBeNull();
  });
});

describe("what the copy holds", () => {
  it("two different requests for one cell leave the same copy", async () => {
    const run = async (query: string, headers: HeadersInit) => {
      const k = recordingKv(baseData());
      const c = withCaches();
      await select(k.kv, query, { headers });
      return [...c.store.entries()]
        .map(([key, v]) => [key, v.text, v.headers.get("cache-control")])
        .sort();
    };
    const a = await run(
      "path=%2F&utm_source=chatgpt.com&utm_campaign=one&v=0123456789abcdef0123456789abcdef&plang=en",
      { "user-agent": "Mozilla/5.0 (iPhone)", referer: "https://chatgpt.com/c/1" },
    );
    const b = await run(
      "path=%2F&utm_source=chatgpt.com&utm_medium=x&v=fedcba9876543210fedcba9876543210&plang=en",
      { "user-agent": "Mozilla/5.0 (Windows NT 10.0)" },
    );
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    const all = JSON.stringify(a);
    for (const visitor of [
      "0123456789abcdef",
      "fedcba98",
      "iPhone",
      "Windows",
      "one",
      "chatgpt.com/c",
    ]) {
      expect(all).not.toContain(visitor);
    }
  });

  it("bodies are kept only for / or a path the bundle lists, never a path only a visitor sent", async () => {
    const k = recordingKv(baseData());
    const c = withCaches();
    await select(k.kv, "path=%2Fnot-listed&utm_source=chatgpt.com");
    await select(k.kv, "path=%2Fsecret-token-page&utm_source=chatgpt.com");
    const keys = [...c.store.keys()].join("\n");
    expect(keys).not.toContain("not-listed");
    expect(keys).not.toContain("secret-token-page");
    expect(inMemory(k.kv, vkey("/not-listed", "problem", "ai"))).toBeNull();
    // The root's bodies, which the cascade also read, are kept.
    expect(inMemory(k.kv, vkey("/", "problem", "ai"))).not.toBeNull();
    // A listed page's own bodies are kept.
    await select(k.kv, "path=%2Fpricing&utm_source=chatgpt.com");
    expect(keys).not.toContain("pricing");
    expect([...c.store.keys()].join("\n")).toContain(
      encodeURIComponent(vkey("/pricing", "pricing", "ai")),
    );
  });

  it("/_kv/ is answered 404 before any cache match", async () => {
    const c = withCaches();
    const key = copyCacheKey("https://edge.test", visitorBundleKey(CUSTOMER));
    c.store.set(key, {
      headers: new Headers(),
      text: JSON.stringify({ v: BUNDLE, at: T0, r: 60 }),
    });
    const res = await worker.fetch(
      new Request(key),
      { VARIANTS: recordingKv(baseData()).kv, DB: db, ENVIRONMENT: "test", PREVIEW_TOKEN: "" },
      ctxCollect().ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("pages");
    expect(c.ops).toEqual([]);
  });
});

describe("warm on the tag", () => {
  async function tag(data: Record<string, unknown>, opts: { warm?: boolean; id?: string } = {}) {
    const k = recordingKv(data);
    const sc = fakeCache();
    const w = ctxCollect();
    const res = await handleCustomerScript(
      new Request(`https://edge.test/s/${opts.id ?? CUSTOMER}.js`),
      { VARIANTS: k.kv },
      opts.id ?? CUSTOMER,
      {
        ctx: w.ctx,
        cache: null,
        selectCache: sc.cache,
        now: T0,
        ...(opts.warm === false ? { warm: false } : {}),
      },
    );
    await res.text();
    await w.flush();
    return { k, sc };
  }

  it("an open customer with a readable bundle: the bundle, the switches, the language map and the bodies are kept; /select then reads no KV", async () => {
    const log = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    const { k, sc } = await tag(baseData());
    expect(inMemory(k.kv, visitorBundleKey(CUSTOMER), T0)?.v).toEqual(BUNDLE);
    expect(inMemory(k.kv, closedKey(CUSTOMER), T0)).not.toBeNull();
    expect(inMemory(k.kv, carryOffKey(CUSTOMER), T0)).not.toBeNull();
    expect(inMemory(k.kv, customerLangKey(CUSTOMER), T0)).not.toBeNull();
    expect(inMemory(k.kv, vkey("/pricing", "pricing", "ai"), T0)).not.toBeNull();
    expect(sc.store.size).toBeGreaterThan(0);
    // The tag's own bundle read is reused: one bundle read in all.
    expect(k.reads.filter((r) => r.key === visitorBundleKey(CUSTOMER))).toHaveLength(1);
    const before = k.reads.length;
    await select(k.kv, "path=%2Fpricing&utm_source=chatgpt.com&plang=en");
    expect(k.reads.length).toBe(before);
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
    warn.mockRestore();
  });

  it("never for a closed customer, an audit past its end, an unknown id or an unreadable bundle", async () => {
    const cases: Array<[string, Record<string, unknown>, string?]> = [
      ["closed", baseData({ [closedKey(CUSTOMER)]: "1" })],
      [
        "audit past its end",
        baseData({ [visitorBundleKey(CUSTOMER)]: { ...BUNDLE, a: 1, ad: "acme.com", ae: T0 - 1 } }),
      ],
      ["unknown id", {}, "nobody"],
      ["unreadable bundle", baseData({ [visitorBundleKey(CUSTOMER)]: { pages: {} } })],
    ];
    for (const [name, data, id] of cases) {
      const { k, sc } = await tag(data, id ? { id } : {});
      const who = id ?? CUSTOMER;
      expect(inMemory(k.kv, visitorBundleKey(who), T0), name).toBeNull();
      expect(
        k.reads.some((r) => r.key.startsWith("v1:variant:")),
        name,
      ).toBe(false);
      expect(
        k.reads.some((r) => r.key === customerLangKey(who)),
        name,
      ).toBe(false);
      expect(
        [...sc.store.keys()].some((x) => x.includes("variant")),
        name,
      ).toBe(false);
    }
  });

  it("a live audit inside its window is warmed like any open customer", async () => {
    const { k } = await tag(
      baseData({
        [visitorBundleKey(CUSTOMER)]: { ...BUNDLE, a: 1, ad: "acme.com", ae: T0 + 86_400_000 },
      }),
    );
    expect(inMemory(k.kv, visitorBundleKey(CUSTOMER), T0)).not.toBeNull();
  });

  it("off with SELECT_COPY: no warm, nothing kept", async () => {
    const { k, sc } = await tag(baseData(), { warm: false });
    expect(inMemory(k.kv, visitorBundleKey(CUSTOMER), T0)).toBeNull();
    expect(k.reads.some((r) => r.key.startsWith("v1:variant:"))).toBe(false);
    expect(sc.store.size).toBe(0);
  });

  it("reads at most MAX_WARM_READS bodies, the root first, folded intents only", () => {
    const pages = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`/p${i}`, MANIFEST]).concat([["/", MANIFEST]]),
    );
    const keys = warmKeys(CUSTOMER, { v: 1, pages, conv: [] });
    expect(keys).toHaveLength(MAX_WARM_READS);
    expect(keys[0]).toBe(vkey("/", "competitor", "default"));
    const folded = warmKeys(CUSTOMER, {
      v: 1,
      pages: { "/": MANIFEST },
      conv: [],
      sd: ["problem"],
    });
    expect(folded).toHaveLength(7);
    expect(folded.every((x) => x.includes(":problem:"))).toBe(true);
  });
});
