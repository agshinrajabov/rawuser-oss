/**
 * Page one chooses page two at /select (docs/specs/direct-visitors.md §4):
 * a no-signal page that names an intent but has no versions tells the tab
 * to keep that word (`kc`); counted buttons carry their section's word
 * (`i`); a `direct` carry on a page naming another word is replaced; a real
 * source is never overwritten; nothing without `dp`, for a sensitive or an
 * audit bundle, or with the carry off.
 */
import { variantKeyForPath } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";

const STUB = (headline: string) => ({
  customer_id: "demo",
  profile_key: "x",
  sections: { hero: { kind: "hero", headline } },
  generated_at: 0,
  prompt_hash: "p",
});
const key = (path: string, intent: string, source: string) =>
  variantKeyForPath("demo", path, intent, source);

function kvWith(data: Record<string, unknown>) {
  const kv = {
    async get(k: string, opts?: string | { type?: string }) {
      const v = data[k];
      if (v === undefined) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "json" ? v : typeof v === "string" ? v : JSON.stringify(v);
    },
    async put() {},
    async delete() {},
  } as unknown as KVNamespace;
  return kv;
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

const MANIFEST = { "hero.headline": { css: ["h1"], text: ["Old"], structural: "h1" } };
const CONV = [
  {
    section_path: "pricing.cta",
    conversion_label: "signup",
    css: ["a.p"],
    text: [],
    structural: "",
  },
  { section_path: "hero.cta", conversion_label: "signup", css: ["a.h"], text: [], structural: "" },
  { section_path: "count:/", conversion_label: "contact", css: ["a.c"], text: [], structural: "" },
];

function bundle(extra: Record<string, unknown> = {}) {
  return { v: 1, pages: { "/": MANIFEST }, conv: CONV, dp: 1, ...extra };
}

async function select(data: Record<string, unknown>, query: string) {
  const res = await worker.fetch(
    new Request(`https://edge.test/select?customer_id=demo&${query}`, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh)" },
    }),
    {
      VARIANTS: kvWith(data),
      DB: db,
      ENVIRONMENT: "test",
      PREVIEW_TOKEN: "",
      HOLDOUT_PERCENT: "0",
    },
    ctx,
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("page one chooses page two: opens (§4)", () => {
  it("a /pricing page with no versions stays as built and names its word", async () => {
    const r = await select({ "v1:vm:demo": bundle() }, "path=%2Fpricing");
    expect(r.source).toBe("original");
    expect(r.kc).toBe("pricing:direct");
  });

  it("the customer's map decides the word, folded into what the site serves", async () => {
    const data = {
      "v1:vm:demo": bundle({
        pm: { "/plans-and-prices": ["price", 1] },
        sd: ["evaluation", "feature", "problem", "brand"],
      }),
    };
    const r = await select(data, "path=%2Fplans-and-prices");
    expect(r.kc).toBe("evaluation:direct");
  });

  it("the root and an about page name nothing", async () => {
    const root = await select({ "v1:vm:demo": bundle() }, "path=%2F");
    expect(root).not.toHaveProperty("kc");
    const about = await select(
      { "v1:vm:demo": bundle({ pm: { "/about": ["about", 1] } }) },
      "path=%2Fabout",
    );
    expect(about).not.toHaveProperty("kc");
  });

  it("nothing without dp, for a sensitive, no-events or audit bundle", async () => {
    for (const extra of [{ dp: undefined }, { s: 1 }, { ne: 1 }, { a: 1, ad: "edge.test" }]) {
      const r = await select({ "v1:vm:demo": bundle(extra) }, "path=%2Fpricing");
      expect(r).not.toHaveProperty("kc");
      for (const t of (r.conversion_targets ?? []) as Array<Record<string, unknown>>) {
        expect(t).not.toHaveProperty("i");
      }
    }
  });
});

describe("page one chooses page two: clicks (§4)", () => {
  it("a counted button in the pricing section carries its word; hero and count-only none", async () => {
    const r = await select({ "v1:vm:demo": bundle() }, "path=%2F");
    const t = r.conversion_targets as Array<Record<string, unknown>>;
    const by = Object.fromEntries(t.map((x) => [x.section_path, x.i]));
    expect(by["pricing.cta"]).toBe("pricing");
    expect(by["hero.cta"]).toBeUndefined();
    expect(by["count:/"]).toBeUndefined();
  });
});

describe("a direct carry meets a page that names another word (§4)", () => {
  const data = {
    "v1:vm:demo": bundle({ pages: { "/": MANIFEST, "/features": MANIFEST } }),
    [key("/", "feature", "default")]: STUB("Home feature"),
    [key("/", "pricing", "default")]: STUB("Home pricing"),
    [key("/features", "feature", "default")]: STUB("Features"),
  };

  it("a carried feature:direct on /pricing (no versions) keeps the carried version and passes the new word", async () => {
    const r = await select(data, "path=%2Fpricing&carry=feature%3Adirect");
    expect(r.carried).toBe(true);
    expect(r.kc).toBe("pricing:direct");
  });

  it("the same word, or a carry with a real source, changes nothing", async () => {
    const same = await select(data, "path=%2Fpricing&carry=pricing%3Adirect");
    expect(same).not.toHaveProperty("kc");
    const ai = await select(data, "path=%2Fpricing&carry=feature%3Aai");
    expect(ai).not.toHaveProperty("kc");
  });

  it("the carry switched off sends no word", async () => {
    const r = await select(
      { ...data, "v1:carry-off:demo": "1" },
      "path=%2Fpricing&carry=feature%3Adirect",
    );
    expect(r).not.toHaveProperty("kc");
  });
});
