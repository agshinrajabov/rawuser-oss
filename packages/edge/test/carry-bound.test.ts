/**
 * The /carry answer a location keeps (privacy review, re-review of warm
 * /select, 2026-10-26): stored with a max-age no longer than what is left of
 * the copy's bound, `300 s - (now - at) - R`, timed from the oldest KV read
 * the answer was made of; not stored when nothing is left. The browser keeps
 * its `public, max-age=300`.
 */
import { closedKey, variantKeyForPath, visitorBundleKey } from "@rawuser/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { carryOffKey, handleCarry, storedMaxAgeS } from "../src/body-carry.ts";
import { COPY_BOUND_MS, KV_R_S, keep } from "../src/kv-copy.ts";

const T0 = Date.parse("2026-10-26T15:00:00Z");
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterAll(() => {
  vi.useRealTimers();
});

const CUSTOMER = "acme";
const MANIFEST = { "hero.headline": { css: ["h1"], text: ["Old"], structural: "h1" } };
const DATA: Record<string, unknown> = {
  [visitorBundleKey(CUSTOMER)]: { v: 1, pages: { "/": MANIFEST }, conv: [] },
  [variantKeyForPath(CUSTOMER, "/", "problem", "ai")]: {
    customer_id: CUSTOMER,
    profile_key: "x",
    sections: { hero: { kind: "hero", headline: "New" } },
    generated_at: 0,
    prompt_hash: "p",
  },
};

function kvOf(data: Record<string, unknown>): KVNamespace {
  return {
    async get(key: string, opts?: unknown) {
      const v = data[key];
      if (v === undefined) return null;
      const type = typeof opts === "string" ? opts : (opts as { type?: string } | undefined)?.type;
      return type === "json" ? v : typeof v === "string" ? v : JSON.stringify(v);
    },
    async put() {},
    async delete() {},
  } as unknown as KVNamespace;
}

const db = {
  prepare: () => ({
    bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }),
  }),
} as unknown as D1Database;

function fakeCache() {
  const store = new Map<string, { headers: Headers; text: string }>();
  const url = (r: RequestInfo | URL) =>
    typeof r === "string" ? r : r instanceof URL ? r.toString() : r.url;
  const cache = {
    async match(r: RequestInfo | URL) {
      const hit = store.get(url(r));
      return hit ? new Response(hit.text, { headers: hit.headers }) : undefined;
    },
    async put(r: RequestInfo | URL, res: Response) {
      store.set(url(r), { headers: new Headers(res.headers), text: await res.text() });
    },
  } as unknown as Cache;
  (globalThis as unknown as { caches?: unknown }).caches = { default: cache };
  return store;
}
afterEach(() => {
  (globalThis as unknown as { caches?: unknown }).caches = undefined;
});

async function carry(kv: KVNamespace) {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const u = `https://edge.test/carry?customer_id=${CUSTOMER}&carry=problem:ai`;
  const res = await handleCarry(new Request(u), new URL(u), { VARIANTS: kv, DB: db }, ctx);
  while (pending.length) await pending.shift();
  return res;
}

const maxAge = (h: Headers | undefined) =>
  Number(/max-age=(\d+)/.exec(h?.get("cache-control") ?? "")?.[1] ?? Number.NaN);

describe("the /carry entry a location keeps", () => {
  it("fresh reads: stored for 240 s at most; the browser still gets 300", async () => {
    const store = fakeCache();
    const res = await carry(kvOf(DATA));
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const [entry] = [...store.values()];
    expect(maxAge(entry?.headers)).toBe((COPY_BOUND_MS - KV_R_S.carry * 1000) / 1000);
    // A hit hands the browser its five minutes, not the location's time left.
    const again = await carry(kvOf(DATA));
    expect(again.headers.get("cache-control")).toBe("public, max-age=300");
    expect(((await again.json()) as { bodies: object }).bodies).toHaveProperty("/");
  });

  it("timed from the oldest read: a carry switch from this isolate's copy shortens it", async () => {
    const store = fakeCache();
    const kv = kvOf(DATA);
    for (const age of [0, 1_000, 100_000, 199_500, 239_000]) {
      store.clear();
      keep(kv, carryOffKey(CUSTOMER), "carry", { v: null, at: T0 - age, r: 60 }, {}, T0);
      await carry(kv);
      const [entry] = [...store.values()];
      const left = storedMaxAgeS(T0 - age, T0);
      expect(maxAge(entry?.headers), `age ${age}`).toBe(left);
      expect(maxAge(entry?.headers)).toBeLessThanOrEqual(
        Math.floor((COPY_BOUND_MS - age - KV_R_S.carry * 1000) / 1000),
      );
    }
  });

  it("nothing left of the bound: not stored at all", async () => {
    const store = fakeCache();
    const kv = kvOf(DATA);
    keep(kv, carryOffKey(CUSTOMER), "carry", { v: null, at: T0 - 240_000, r: 60 }, {}, T0);
    await carry(kv);
    expect(store.size).toBe(0);
    expect(storedMaxAgeS(T0 - 240_000, T0)).toBe(0);
    expect(storedMaxAgeS(T0, T0)).toBe(240);
  });

  it("an empty answer (carry off) is bounded the same way", async () => {
    const store = fakeCache();
    await carry(kvOf({ ...DATA, [carryOffKey(CUSTOMER)]: "1", [closedKey(CUSTOMER)]: undefined }));
    const [entry] = [...store.values()];
    expect(entry?.text).toBe('{"bodies":{}}');
    expect(maxAge(entry?.headers)).toBeLessThanOrEqual(240);
  });
});
