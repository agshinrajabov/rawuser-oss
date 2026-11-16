/**
 * /select with the customer's site map (docs/specs/site-shaped-intents.md
 * §6, §7.2, §11): the map before the global table, the own-versions gate
 * for both (decision 2), the fold before the argmax, the carry, the
 * `site_path` bit, and the reads: at most one extra KV batch, only when the
 * map or the fold changes the chosen version.
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
  const gets: string[] = [];
  const kv = {
    async get(k: string, opts?: string | { type?: string }) {
      gets.push(k);
      const v = data[k];
      if (v === undefined) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "json" ? v : JSON.stringify(v);
    },
    async put() {},
    async delete() {},
  } as unknown as KVNamespace;
  return { kv, gets };
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
const FOUR = ["evaluation", "feature", "problem", "brand"];

function bundle(extra: Record<string, unknown> = {}, pages = ["/", "/approach"]) {
  return {
    v: 1,
    pages: Object.fromEntries(pages.map((p) => [p, MANIFEST])),
    conv: [],
    ...extra,
  };
}

async function select(data: Record<string, unknown>, query: string, headers: HeadersInit = {}) {
  const { kv, gets } = kvWith(data);
  const res = await worker.fetch(
    new Request(`https://edge.test/select?customer_id=demo&${query}`, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh)", ...headers },
    }),
    { VARIANTS: kv, DB: db, ENVIRONMENT: "test", PREVIEW_TOKEN: "", HOLDOUT_PERCENT: "0" },
    ctx,
  );
  const body = (await res.json()) as Record<string, unknown>;
  const timing = res.headers.get("server-timing") ?? "";
  const batches = timing.split(",").filter((p) => /^\s*kv2?;/.test(p)).length;
  return { body, gets, batches, raw: JSON.stringify(body) };
}

const sel = (b: Record<string, unknown>) => b.selection as Record<string, string>;

describe("an old bundle (no pm, no sd) answers as today", () => {
  it("an unmapped page stays as built, a global path page with its own versions is personalised", async () => {
    const data = {
      "v1:vm:demo": bundle({}, ["/", "/approach", "/pricing"]),
      [key("/pricing", "pricing", "default")]: STUB("Pricing"),
    };
    const approach = await select(data, "path=%2Fapproach");
    expect(approach.body.source).toBe("original");
    expect(approach.batches).toBe(1);
    const pricing = await select(data, "path=%2Fpricing");
    expect(pricing.body.source).toBe("kv-sentinel");
    expect(sel(pricing.body).intent_dim).toBe("pricing");
    expect(pricing.body.site_path).toBeUndefined();
    expect(pricing.batches).toBe(1);
  });

  it("a utm visit to the homepage reads one batch", async () => {
    const r = await select(
      { "v1:vm:demo": bundle(), [key("/", "pricing", "default")]: STUB("P") },
      "path=%2F&utm_campaign=pricing",
    );
    expect(sel(r.body).intent_dim).toBe("pricing");
    expect(r.batches).toBe(1);
  });
});

describe("the map opens a page with its own versions (§6.1, §6.2)", () => {
  const data = {
    "v1:vm:demo": bundle({ pm: { "/approach": ["how", 1], "/work": ["proof", 1] } }),
    [key("/approach", "problem", "default")]: STUB("Approach"),
    [key("/", "evaluation", "default")]: STUB("Home evaluation"),
  };

  it("/approach: problem, its own version, site_path, one more batch than a no-signal page", async () => {
    const r = await select(data, "path=%2Fapproach");
    expect(r.body.source).toBe("kv-sentinel");
    expect(r.body.variant_key).toBe(key("/approach", "problem", "default"));
    expect(sel(r.body)).toMatchObject({ intent_dim: "problem", source_dim: "direct" });
    expect(r.body.site_path).toBe(true);
    expect(r.batches).toBe(2);
  });

  it("/work has no versions of its own: the page as built, never the homepage's", async () => {
    const r = await select(data, "path=%2Fwork");
    expect(r.body.source).toBe("original");
    expect(r.body.variant).toBeNull();
    expect(r.batches).toBe(1);
    // The tombstone rides in the same batch (closed.ts).
    expect(r.gets).toEqual(["v1:vm:demo", "v1:closed:demo"]);
  });

  it("a child of a mapped page follows it (the longest entry)", async () => {
    const r = await select(
      {
        "v1:vm:demo": bundle({ pm: { "/work": ["proof", 1] } }, ["/", "/work/portal"]),
        [key("/work/portal", "evaluation", "default")]: STUB("Portal"),
      },
      "path=%2Fwork%2Fportal",
    );
    expect(sel(r.body).intent_dim).toBe("evaluation");
    expect(r.body.site_path).toBe(true);
  });

  it("the bundle, the map and its paths never reach the browser", async () => {
    const r = await select(data, "path=%2Fapproach");
    expect(r.raw).not.toContain('"pm"');
    expect(r.raw).not.toContain('"sd"');
    expect(r.raw).not.toContain("/work");
    expect(r.raw).not.toContain('"how"');
  });
});

describe("decision 2 for the global table", () => {
  it("/pricing without its own versions: the page as built, not the homepage's pricing copy", async () => {
    const r = await select(
      { "v1:vm:demo": bundle(), [key("/", "pricing", "default")]: STUB("Home pricing") },
      "path=%2Fpricing",
    );
    expect(r.body.source).toBe("original");
    expect(r.body.variant).toBeNull();
  });

  it("without a bundle (not written yet) the gate is unknown: as before", async () => {
    const r = await select({ [key("/", "pricing", "default")]: STUB("P") }, "path=%2Fpricing");
    expect(sel(r.body).intent_dim).toBe("pricing");
  });
});

describe("an operator's none beats the global table", () => {
  it("/pricing set to no intent stays as built even with its own versions", async () => {
    const r = await select(
      {
        "v1:vm:demo": bundle({ pm: { "/pricing": ["none", 1] } }, ["/", "/pricing"]),
        [key("/pricing", "pricing", "default")]: STUB("Pricing"),
      },
      "path=%2Fpricing",
    );
    expect(r.body.source).toBe("original");
  });
});

describe("the fold (§7.2)", () => {
  it("a folded pricing visit gets the evaluation version, one more batch", async () => {
    const r = await select(
      {
        "v1:vm:demo": bundle({ sd: FOUR }),
        [key("/", "pricing", "default")]: STUB("Pricing, unused"),
        [key("/", "evaluation", "default")]: STUB("Evaluation"),
      },
      "path=%2F&utm_campaign=pricing",
    );
    expect(sel(r.body).intent_dim).toBe("evaluation");
    expect(r.body.variant_key).toBe(key("/", "evaluation", "default"));
    expect(r.body.site_path).toBeUndefined();
    expect(r.batches).toBe(2);
  });

  it("a competitor campaign folds the same way", async () => {
    const r = await select(
      { "v1:vm:demo": bundle({ sd: FOUR }), [key("/", "evaluation", "default")]: STUB("E") },
      "path=%2F&utm_campaign=vs-notion",
    );
    expect(sel(r.body).intent_dim).toBe("evaluation");
  });

  it("a carried pricing label folds", async () => {
    const r = await select(
      {
        "v1:vm:demo": bundle({ sd: FOUR }),
        [key("/", "evaluation", "social")]: STUB("Evaluation social"),
      },
      "path=%2F&carry=pricing:social",
    );
    expect(r.body.carried).toBe(true);
    expect(sel(r.body)).toMatchObject({ intent_dim: "evaluation", source_dim: "social" });
  });

  it("a served intent is untouched and reads one batch", async () => {
    const r = await select(
      {
        "v1:vm:demo": bundle({ sd: [...FOUR, "pricing"] }),
        [key("/", "pricing", "default")]: STUB("Pricing"),
      },
      "path=%2F&utm_campaign=pricing",
    );
    expect(sel(r.body).intent_dim).toBe("pricing");
    expect(r.batches).toBe(1);
  });
});

describe("the carry (§11): a mapped path is a path, never a source", () => {
  const data = {
    "v1:vm:demo": bundle({ pm: { "/work": ["proof", 1], "/contact": ["start", 1] } }, [
      "/",
      "/work",
      "/contact",
    ]),
    [key("/work", "evaluation", "social")]: STUB("Work social"),
    [key("/contact", "problem", "social")]: STUB("Contact social"),
    [key("/", "problem", "social")]: STUB("Home social"),
  };

  it("LinkedIn landed on / as problem:social; /work gives evaluation with the social tone", async () => {
    const r = await select(data, "path=%2Fwork&carry=problem:social");
    expect(sel(r.body)).toMatchObject({ intent_dim: "evaluation", source_dim: "social" });
    expect(r.body.carried).toBe(true);
    expect(r.body.site_path).toBe(true);
  });

  it("back on / the landing's pair again", async () => {
    const r = await select(data, "path=%2F&carry=problem:social");
    expect(sel(r.body)).toMatchObject({ intent_dim: "problem", source_dim: "social" });
    expect(r.body.site_path).toBeUndefined();
  });

  it("a start entry is context only: the carried pair whole", async () => {
    const r = await select(data, "path=%2Fcontact&carry=problem:social");
    expect(sel(r.body)).toMatchObject({ intent_dim: "problem", source_dim: "social" });
    expect(r.body.site_path).toBeUndefined();
  });

  it("a real new source still wins over the carry, and the map still adds the page's intent", async () => {
    const r = await select(
      { ...data, [key("/work", "evaluation", "ai")]: STUB("Work AI") },
      "path=%2Fwork&carry=problem:social&ref=https%3A%2F%2Fchatgpt.com%2F",
    );
    expect(sel(r.body)).toMatchObject({ intent_dim: "evaluation", source_dim: "ai" });
    expect(r.body.carried).toBeUndefined();
  });
});

describe("a page with no signal reads exactly what it read before, plus the tombstone in the same batch", () => {
  it("the homepage with a map: one read, the bundle", async () => {
    const r = await select(
      { "v1:vm:demo": bundle({ pm: { "/approach": ["how", 1] }, sd: FOUR }) },
      "path=%2F",
    );
    expect(r.body.source).toBe("original");
    // The bundle and the tombstone, read together (closed.ts).
    expect(r.gets).toEqual(["v1:vm:demo", "v1:closed:demo"]);
    expect(r.batches).toBe(1);
  });
});
