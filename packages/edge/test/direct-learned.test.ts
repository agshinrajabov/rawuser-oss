/**
 * The learned best default at /select (docs/specs/direct-visitors.md §3): a
 * visit with no signal on a page with weights gets one of the page's base
 * versions or the page as built, drawn from the weights with the edge's own
 * random number (never the visit marker); the test's coin first; the
 * original arm is kept as `none:direct` and held on later pages; `nd`
 * carries the set and the probability; never with the carry off.
 */
import { variantKeyForPath } from "@rawuser/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planDirect } from "../src/direct.ts";
import { decideArm } from "../src/holdout.ts";
import worker from "../src/index.ts";

const BODY = (headline: string, id: string) => ({
  customer_id: "demo",
  profile_key: "x",
  sections: { hero: { kind: "hero", headline } },
  generated_at: 0,
  prompt_hash: "p",
  body_id: id,
});
const FEATURE = variantKeyForPath("demo", "/", "feature", "default");
const MANIFEST = { "hero.headline": { css: ["h1"], text: ["Old"], structural: "h1" } };
const W = [
  ["none", 400],
  ["feature", 600],
];

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
  return { v: 1, pages: { "/": MANIFEST }, conv: [], dl: { s: "k3x9", w: { "/": W } }, ...extra };
}
const data = (extra: Record<string, unknown> = {}) => ({
  "v1:vm:demo": bundle(extra),
  [FEATURE]: BODY("Feature words", "aaaaaaaaaaaaaaaa"),
});

/** The edge's random number, pinned: a value under 0.4 draws `none`, above it `feature`. */
function pinRandom(x: number) {
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((a: Uint32Array) => {
    a[0] = Math.floor(x * 2 ** 32);
    return a;
  }) as never);
}
afterEach(() => vi.restoreAllMocks());

async function select(d: Record<string, unknown>, query: string, holdout = "0") {
  const res = await worker.fetch(
    new Request(`https://edge.test/select?customer_id=demo&${query}`, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh)" },
    }),
    {
      VARIANTS: kvWith(d),
      DB: db,
      ENVIRONMENT: "test",
      PREVIEW_TOKEN: "",
      HOLDOUT_PERCENT: holdout,
    },
    ctx,
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("planDirect (§3)", () => {
  const b = bundle() as never;
  it("draws by the weights; the market first; a held original stays", () => {
    expect(planDirect(b, "/", { r: 0.1 })).toEqual({ kind: "o", nd: "l:k3x9:400", held: false });
    expect(planDirect(b, "/", { r: 0.7 })).toEqual({
      kind: "l",
      intent: "feature",
      source: "default",
      nd: "l:k3x9:600",
    });
    expect(planDirect(b, "/", { r: 0.7, carry: "none:direct" })).toEqual({
      kind: "o",
      nd: "l:k3x9",
      held: true,
    });
    const m = bundle({ mk: ["GB"] }) as never;
    expect(planDirect(m, "/", { r: 0.7, country: "GB" })).toMatchObject({
      kind: "m",
      source: "mk-gb",
    });
  });

  it("nothing for a page without weights, bad weights, or a sensitive bundle", () => {
    expect(planDirect(b, "/pricing", { r: 0.7 })).toBeNull();
    expect(
      planDirect(
        bundle({
          dl: {
            s: "x",
            w: {
              "/": [
                ["none", 500],
                ["feature", 400],
              ],
            },
          },
        }) as never,
        "/",
        { r: 0.7 },
      ),
    ).toBeNull();
    expect(planDirect(bundle({ s: 1 }) as never, "/", { r: 0.7 })).toBeNull();
    expect(
      planDirect(
        bundle({
          dl: {
            s: "x",
            w: {
              "/": [
                ["none", 500],
                ["hacked", 500],
              ],
            },
          },
        }) as never,
        "/",
        { r: 0.7 },
      ),
    ).toBeNull();
  });
});

describe("/select draws the learned default (§3)", () => {
  it("a version arm: personalized, selection feature:direct, nd with its probability, no kc", async () => {
    pinRandom(0.7);
    const r = await select(data(), "path=%2F");
    expect(r).toMatchObject({
      source: "kv",
      cohort: "personalized",
      variant_key: FEATURE,
      nd: "l:k3x9:600",
      body_id: "aaaaaaaaaaaaaaaa",
    });
    expect(r.selection).toMatchObject({ intent_dim: "feature", source_dim: "direct" });
    expect(r).not.toHaveProperty("kc");
  });

  it("the original arm: the page as built, kept as none:direct, nd", async () => {
    pinRandom(0.1);
    const r = await select(data(), "path=%2F");
    expect(r).toMatchObject({
      source: "original",
      cohort: "no_signal",
      kc: "none:direct",
      nd: "l:k3x9:400",
    });
    expect(r.variant).toBeNull();
  });

  it("a held original draws nothing and keeps its carry", async () => {
    pinRandom(0.7);
    const r = await select(data(), "path=%2F&carry=none%3Adirect");
    expect(r.source).toBe("original");
    expect(r).not.toHaveProperty("kc");
    expect(r).not.toHaveProperty("nd");
  });

  it("the drawn version carried to page two, as any carry", async () => {
    const r = await select(
      data({ pages: { "/": MANIFEST, "/about": MANIFEST } }),
      "path=%2Fabout&carry=feature%3Adirect",
    );
    expect(r.carried).toBe(true);
    expect(r.variant_key).toBe(FEATURE);
  });

  it("never with the carry off, never without dl", async () => {
    pinRandom(0.7);
    expect((await select({ ...data(), "v1:carry-off:demo": "1" }, "path=%2F")).source).toBe(
      "original",
    );
    expect((await select(data({ dl: undefined }), "path=%2F")).source).toBe("original");
  });

  it("the draw is never the marker: the same marker draws both arms", async () => {
    const v = "0".repeat(32);
    pinRandom(0.1);
    const a = await select(data(), `path=%2F&visit=${v}`);
    pinRandom(0.9);
    const b = await select(data(), `path=%2F&visit=${v}`);
    expect([a.source, b.source]).toEqual(["original", "kv"]);
  });

  it("the test's coin first: a holdout visit draws nothing shown, keeps nothing", async () => {
    const visits: Record<string, string> = {};
    for (let i = 0; Object.keys(visits).length < 2 && i < 200; i++) {
      const v = i.toString(16).padStart(32, "0");
      visits[(await decideArm("demo", v, 50)) ?? "none"] ??= v;
    }
    pinRandom(0.7);
    const h = await select(data({ h: 50 }), `path=%2F&visit=${visits.holdout}`);
    expect(h).toMatchObject({ source: "holdout", arm: "holdout", kc: "" });
    expect(h).not.toHaveProperty("nd");
    pinRandom(0.1);
    const t = await select(data({ h: 50 }), `path=%2F&visit=${visits.treat}`);
    expect(t).toMatchObject({ source: "original", arm: "treat", kc: "none:direct" });
  });
});
