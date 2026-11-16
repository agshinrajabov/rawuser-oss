/**
 * GET /carry (body carry, docs/specs/interactive-text.md §3.1 b; privacy
 * review docs/research/privacy-review-body-carry.md).
 */
import { variantKeyForPath } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { carryOffKey } from "../src/body-carry.ts";
import worker from "../src/index.ts";

const body = (headline: string) => ({
  customer_id: "acme",
  profile_key: "intent:competitor",
  generated_at: 1,
  prompt_hash: `h-${headline}`,
  intent_vector: { meta: { lead_probability: 0.9 } },
  sections: { hero: { kind: "hero", headline } },
});

function env(
  kv: Record<string, unknown>,
  manifests: Array<{ page_path: string; manifest: string }>,
) {
  const sqls: string[] = [];
  return {
    sqls,
    env: {
      VARIANTS: {
        async get(key: string, type?: string) {
          const v = kv[key];
          if (v === undefined) return null;
          return type === "json" ? v : typeof v === "string" ? v : JSON.stringify(v);
        },
        async put() {},
        async delete() {},
      } as unknown as KVNamespace,
      DB: {
        prepare(sql: string) {
          sqls.push(sql);
          return {
            bind() {
              return {
                async all() {
                  return { results: manifests };
                },
                async first() {
                  return null;
                },
                async run() {
                  return { success: true };
                },
              };
            },
          };
        },
      } as unknown as D1Database,
      ENVIRONMENT: "test",
      PREVIEW_TOKEN: "",
    },
  };
}
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const manifest = JSON.stringify({ "hero.headline": { css: ["h1"], text: [], structural: "" } });

describe("/carry", () => {
  it("answers each confirmed page's copy for the segment, with the allowed fields only", async () => {
    const { env: e } = env(
      {
        [variantKeyForPath("acme", "/", "competitor", "social")]: body("Home"),
        [variantKeyForPath("acme", "/pricing", "competitor", "default")]: body("Pricing"),
      },
      [
        { page_path: "/", manifest },
        { page_path: "/pricing", manifest },
      ],
    );
    const res = await worker.fetch(
      new Request("https://edge.test/carry?customer_id=acme&carry=competitor:social"),
      e as never,
      ctx,
    );
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const j = (await res.json()) as { bodies: Record<string, Record<string, unknown>> };
    expect(Object.keys(j.bodies).sort()).toEqual(["/", "/pricing"]);
    expect(Object.keys(j.bodies["/"] ?? {}).sort()).toEqual(["prompt_hash", "sections", "targets"]);
    expect(JSON.stringify(j)).not.toContain("lead_probability");
    expect((j.bodies["/pricing"]?.sections as { hero: { headline: string } }).hero.headline).toBe(
      "Pricing",
    );
  });

  it("answers nothing for an unknown segment, a bad id, or a customer who turned the carry off", async () => {
    const kv = { [variantKeyForPath("acme", "/", "competitor", "social")]: body("Home") };
    const { env: e } = env(kv, [{ page_path: "/", manifest }]);
    for (const q of [
      "customer_id=acme&carry=evil:social",
      "customer_id=A%20B&carry=competitor:social",
    ]) {
      const r = await worker.fetch(new Request(`https://edge.test/carry?${q}`), e as never, ctx);
      expect(((await r.json()) as { bodies: object }).bodies).toEqual({});
    }
    const { env: off } = env({ ...kv, [carryOffKey("acme")]: "1" }, [{ page_path: "/", manifest }]);
    const r = await worker.fetch(
      new Request("https://edge.test/carry?customer_id=acme&carry=competitor:social"),
      off as never,
      ctx,
    );
    expect(((await r.json()) as { bodies: object }).bodies).toEqual({});
  });

  it("the customer script tells the snippet the carries are off", async () => {
    const { env: e } = env({ [carryOffKey("acme")]: "1" }, []);
    const res = await worker.fetch(new Request("https://edge.test/s/acme.js"), e as never, ctx);
    expect(await res.text()).toContain('"nc":1');
    const { env: on } = env({}, []);
    const res2 = await worker.fetch(new Request("https://edge.test/s/acme.js"), on as never, ctx);
    expect(await res2.text()).not.toContain('"nc"');
  });
});

describe("/select marks only a page confirmed for its own path as carryable (condition 2)", () => {
  function selectEnv(row: { manifest: string; page_path: string } | null) {
    return {
      VARIANTS: {
        async get(key: string, type?: string) {
          if (!key.startsWith("v1:variant:acme")) return null;
          const v = body("Hi");
          return type === "json" ? v : JSON.stringify(v);
        },
        async put() {},
        async delete() {},
      } as unknown as KVNamespace,
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                async first() {
                  return sql.includes("element_manifests") ? row : null;
                },
                async all() {
                  return { results: [] };
                },
                async run() {
                  return { success: true };
                },
              };
            },
          };
        },
      } as unknown as D1Database,
      ENVIRONMENT: "test",
      PREVIEW_TOKEN: "",
      HOLDOUT_PERCENT: "0",
    };
  }
  const url =
    "https://edge.test/select?customer_id=acme&path=%2Fpricing&lang=en&self_host=acme.com&ref=https%3A%2F%2Fnews.ycombinator.com%2F";

  it("is carryable with the path's own manifest", async () => {
    const r = await worker.fetch(
      new Request(url),
      selectEnv({ manifest, page_path: "/pricing" }) as never,
      ctx,
    );
    expect(((await r.json()) as { carryable?: boolean }).carryable).toBe(true);
  });

  it("is not carryable when the path borrows the root's manifest", async () => {
    const r = await worker.fetch(
      new Request(url),
      selectEnv({ manifest, page_path: "/" }) as never,
      ctx,
    );
    const j = (await r.json()) as { carryable?: boolean; targets?: unknown };
    expect(j.targets).toBeTruthy();
    expect(j.carryable).toBeUndefined();
  });

  it("never sends the wrap measurement in /select's targets (phase 4)", async () => {
    const r = await worker.fetch(
      new Request(
        "https://edge.test/select?customer_id=acme&path=%2Fpricing&lang=en&self_host=acme.com&ref=https%3A%2F%2Fnews.ycombinator.com%2F",
      ),
      selectEnv({
        manifest: JSON.stringify({
          "hero.headline": {
            css: ["h1"],
            text: [],
            structural: "",
            metrics: { v: 1, kind: "plain", chars: { a: 50 }, widths: [] },
          },
        }),
        page_path: "/pricing",
      }) as never,
      ctx,
    );
    const j = (await r.json()) as { targets?: Record<string, Record<string, unknown>> };
    expect(j.targets?.["hero.headline"]).toBeDefined();
    expect(j.targets?.["hero.headline"]?.metrics).toBeUndefined();
  });
});

describe("the wrap measurement never reaches a visitor (phase 4, privacy review condition 3)", () => {
  const measured = JSON.stringify({
    "hero.headline": {
      css: ["h1"],
      text: [],
      structural: "",
      metrics: { v: 1, kind: "plain", chars: { a: 50 }, widths: [] },
    },
  });

  it("is not in /carry's targets", async () => {
    const { env: e } = env(
      { [variantKeyForPath("acme", "/", "competitor", "social")]: body("Home") },
      [{ page_path: "/", manifest: measured }],
    );
    const res = await worker.fetch(
      new Request("https://edge.test/carry?customer_id=acme&carry=competitor:social"),
      e as never,
      ctx,
    );
    const text = await res.text();
    expect(text).toContain("hero.headline");
    expect(text).not.toContain("metrics");
  });
});

describe("/carry: the version id rides along (docs/specs/proof-engine.md, C)", () => {
  it("returns each body's body_id when it has a valid one, and nothing else new", async () => {
    const { env: e } = env(
      {
        [variantKeyForPath("acme", "/", "competitor", "social")]: {
          ...body("Home"),
          body_id: "0123456789abcdef",
        },
        [variantKeyForPath("acme", "/pricing", "competitor", "default")]: {
          ...body("Pricing"),
          body_id: "NOT-AN-ID",
        },
      },
      [
        { page_path: "/", manifest },
        { page_path: "/pricing", manifest },
      ],
    );
    const res = await worker.fetch(
      new Request("https://edge.test/carry?customer_id=acme&carry=competitor:social"),
      e as never,
      ctx,
    );
    const { bodies } = (await res.json()) as { bodies: Record<string, Record<string, unknown>> };
    expect(bodies["/"]?.body_id).toBe("0123456789abcdef");
    expect(bodies["/pricing"]).not.toHaveProperty("body_id");
    expect(Object.keys(bodies["/"] ?? {}).sort()).toEqual([
      "body_id",
      "prompt_hash",
      "sections",
      "targets",
    ]);
  });
});
