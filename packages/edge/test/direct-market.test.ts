/**
 * Market versions at /select (docs/specs/direct-visitors.md §5): a visit
 * with no signal from one of the customer's markets gets the page's market
 * version; the 20% test's coin first (holdout: the page as built); the
 * language gate; nothing kept in the carry; never with a signal, never
 * without `mk`, never for a sensitive or audit bundle, never on a page not
 * confirmed for its own path.
 */
import { variantKeyForPath } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { decideArm } from "../src/holdout.ts";
import worker from "../src/index.ts";

const BODY = (headline: string) => ({
  customer_id: "demo",
  profile_key: "x",
  sections: { hero: { kind: "hero", headline } },
  generated_at: 0,
  prompt_hash: "p",
  body_id: "00112233aabbccdd",
});
const GB = variantKeyForPath("demo", "/", "brand", "mk-gb");
const MANIFEST = { "hero.headline": { css: ["h1"], text: ["Old"], structural: "h1" } };

function kvWith(data: Record<string, unknown>) {
  return {
    async get(k: string, opts?: string | { type?: string }) {
      const v = data[k];
      if (v === undefined) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "json" ? v : typeof v === "string" ? v : JSON.stringify(v);
    },
    async put() {},
    async delete() {},
  } as unknown as KVNamespace;
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
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function bundle(extra: Record<string, unknown> = {}) {
  return { v: 1, pages: { "/": MANIFEST }, conv: [], mk: ["GB", "DE"], ...extra };
}

async function select(data: Record<string, unknown>, query: string, country = "GB", holdout = "0") {
  const req = new Request(`https://edge.test/select?customer_id=demo&${query}`, {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh)" },
  });
  Object.defineProperty(req, "cf", { value: { country } });
  const res = await worker.fetch(
    req,
    {
      VARIANTS: kvWith(data),
      DB: db,
      ENVIRONMENT: "test",
      PREVIEW_TOKEN: "",
      HOLDOUT_PERCENT: holdout,
    },
    ctx,
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("a market visit with no signal (§5)", () => {
  const data = { "v1:vm:demo": bundle(), [GB]: BODY("Built for UK teams") };

  it("gets the market version, selection brand:direct, nd m, nothing kept", async () => {
    const r = await select(data, "path=%2F");
    expect(r.source).toBe("kv");
    expect(r.cohort).toBe("personalized");
    expect(r.variant_key).toBe(GB);
    expect((r.variant as { sections: { hero: { headline: string } } }).sections.hero.headline).toBe(
      "Built for UK teams",
    );
    expect(r.selection).toMatchObject({ intent_dim: "brand", source_dim: "direct" });
    expect(r.nd).toBe("m");
    expect(r.kc).toBe("");
    expect(r.body_id).toBe("00112233aabbccdd");
  });

  it("the browser's language region picks it when the connection is elsewhere", async () => {
    const r = await select(data, "path=%2F&lang=en-GB", "FR");
    expect(r.variant_key).toBe(GB);
  });

  it("another country, a signal, a carry, or no version: the page as before", async () => {
    expect((await select(data, "path=%2F", "FR")).source).toBe("original");
    expect((await select(data, "path=%2F&utm_source=newsletter")).variant_key).not.toBe(GB);
    expect((await select(data, "path=%2F&carry=feature%3Aai")).variant_key).not.toBe(GB);
    expect((await select({ "v1:vm:demo": bundle() }, "path=%2F")).source).toBe("original");
  });

  it("never without mk, for a sensitive, no-events or audit bundle, or a page not confirmed for itself", async () => {
    for (const extra of [{ mk: undefined }, { s: 1 }, { ne: 1 }, { a: 1, ad: "edge.test" }]) {
      const r = await select({ ...data, "v1:vm:demo": bundle(extra) }, "path=%2F");
      expect(r.variant_key).not.toBe(GB);
    }
    const other = await select(
      { ...data, [variantKeyForPath("demo", "/blog", "brand", "mk-gb")]: BODY("x") },
      "path=%2Fblog",
    );
    expect(other.source).toBe("original");
  });

  it("a page shown in another language than its versions keeps the page as built", async () => {
    const r = await select({ ...data, "v1:customer:demo:lang": "az" }, "path=%2F&plang=en");
    expect(r.source).toBe("original");
    const same = await select({ ...data, "v1:customer:demo:lang": "en" }, "path=%2F&plang=en");
    expect(same.variant_key).toBe(GB);
  });

  it("the test's coin first: a holdout visit gets the page as built, the arm and the would-be id", async () => {
    // Find markers on each side of a 50% coin.
    const visits: Record<string, string> = {};
    for (let i = 0; Object.keys(visits).length < 2 && i < 200; i++) {
      const v = i.toString(16).padStart(32, "0");
      visits[(await decideArm("demo", v, 50)) ?? "none"] ??= v;
    }
    const held = { ...data, "v1:vm:demo": bundle({ h: 50 }) };
    const h = await select(held, `path=%2F&visit=${visits.holdout}`);
    expect(h).toMatchObject({ source: "holdout", cohort: "holdout", arm: "holdout", kc: "" });
    expect(h.variant).toBeNull();
    expect(h.body_id).toBe("00112233aabbccdd");
    const t = await select(held, `path=%2F&visit=${visits.treat}`);
    expect(t).toMatchObject({ source: "kv", arm: "treat", variant_key: GB });
  });
});
