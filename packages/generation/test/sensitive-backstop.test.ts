/**
 * No version for a page of a sensitive customer outside `/` and its kept
 * sections (docs/specs/sensitive-customers.md, condition 2 and rule 4), even
 * if such a page were confirmed some way the endpoints' 409 does not cover:
 * the run and the single write both leave it out, and nothing is spent on
 * it. A customer that is not sensitive is written as before.
 * SQLite with every migration, the real statements; the model is stubbed.
 */
import type { Manifest } from "@rawuser/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeKv, makeSqliteD1 } from "./admin/sqlite-d1.ts";
import { MODEL_ENV } from "./model-env.ts";

let calls = 0;
vi.mock("../src/generateVariant.ts", () => ({
  generateVariant: vi.fn(async (input: { prompt: string }) => {
    calls++;
    const intent = /"intent:(\w+)"/.exec(input.prompt)?.[1] ?? "problem";
    return {
      text: input.prompt.includes("profile_key")
        ? JSON.stringify({
            customer_id: "medora",
            profile_key: `intent:${intent}`,
            sections: { hero: { kind: "hero", headline: "Öz brendiniz üçün əlavə istehsalı" } },
            generated_at: 1,
            prompt_hash: "",
          })
        : "{}",
      model: "model-a",
      costUsd: 0.0002,
      promptHash: "h",
      cacheHit: false,
      cacheReadTokens: 0,
    };
  }),
}));
const HEADLINE = "Qida əlavələrinin sifarişlə istehsalı";
vi.mock("../src/detect-elements.ts", async (actual) => ({
  ...(await actual<typeof import("../src/detect-elements.ts")>()),
  fetchPageHtml: vi.fn(async () => `<html lang="az"><body><h1>${HEADLINE}</h1></body></html>`),
}));
vi.mock("../src/site-map/served-load.ts", () => ({
  loadServedIntents: vi.fn(async () => ["problem"]),
}));

const { orchestrate, regenerateOne } = await import("../src/orchestrator.ts");
const { keptPagesOnly } = await import("../src/lib/sensitive-guard.ts");
const { resetPageLinks } = await import("../src/page-links.ts");
const { resetReads } = await import("../src/inline-shape-backfill.ts");

const MANIFEST: Manifest = {
  "hero.headline": {
    css: ["h1"],
    text: [HEADLINE],
    structural: "h1",
    original_char_length: HEADLINE.length,
    original_word_count: 4,
    inline: { icons: "none", emphasis: 0, split: false, animated_text: false },
  },
};

const FOREIGN = "/products/ginseng";
const FOREIGN_KEYS = `v1:variant:medora:p:${encodeURIComponent(FOREIGN)}:`;

function setup(opts: { sensitive: boolean; kept?: string[]; pages: string[] }) {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    `INSERT INTO customers (id, slug, domain, plan, status, created_at, auto_approve, live_at, site_map_off, sensitive, kept_sections)
     VALUES ('medora', 'medora', 'www.medora.test', 'pilot', 'active', 1, 1, 2, 1, ?, ?)`,
  ).run(opts.sensitive ? 1 : 0, opts.kept ? JSON.stringify(opts.kept) : null);
  db.prepare(
    `INSERT INTO business_dna (customer_id, product, icp, brand_voice, updated_at, value_props, differentiators, proof_points, target_market, target_language, per_intent_hints)
     VALUES ('medora', 'Qida əlavələrinin sifarişlə istehsalı', 'Öz brendi olan şirkətlər', 'sakit', 1, '["İstehsal"]', '["Formul"]', '["Sertifikat"]', 'Yerli bazar', 'az', '{}')`,
  ).run();
  // Seeded straight into the table: the endpoints would have refused it.
  for (const path of opts.pages) {
    db.prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('medora', ?, ?, 'https://www.medora.test/', 1, 1, 'az')",
    ).run(path, JSON.stringify(MANIFEST));
  }
  const kv = makeKv();
  return { env: { ...MODEL_ENV, DB: d1, VARIANTS: kv }, db, kv };
}

const variantKeys = (kv: ReturnType<typeof makeKv>) =>
  [...kv.store.keys()].filter((k) => k.startsWith("v1:variant:"));

beforeEach(() => {
  calls = 0;
  resetPageLinks();
  resetReads();
});

describe("keptPagesOnly", () => {
  it("reads nothing for a list of the homepage alone", async () => {
    const db = {
      prepare: () => {
        throw new Error("no read expected");
      },
    } as unknown as D1Database;
    const pages = [{ pagePath: "/" }];
    expect(await keptPagesOnly(db, "medora", pages)).toBe(pages);
  });

  it("keeps / and the kept sections of a sensitive customer, every page of any other", async () => {
    const pages = [{ pagePath: "/" }, { pagePath: "/products" }, { pagePath: FOREIGN }];
    const marked = setup({ sensitive: true, kept: ["/products"], pages: [] });
    expect(await keptPagesOnly(marked.env.DB, "medora", pages)).toEqual([
      { pagePath: "/" },
      { pagePath: "/products" },
    ]);
    const plain = setup({ sensitive: false, kept: ["/products"], pages: [] });
    expect(await keptPagesOnly(plain.env.DB, "medora", pages)).toEqual(pages);
  });
});

describe("a run", () => {
  it("writes the homepage and a kept section, never the page outside the list", async () => {
    const { env, db, kv } = setup({
      sensitive: true,
      kept: ["/products"],
      pages: ["/", "/products", FOREIGN],
    });
    const result = await orchestrate("medora", env, {});
    expect(result.aborted).toBeFalsy();
    expect(result.generated).toBe(12);
    expect(variantKeys(kv).some((k) => k.startsWith(FOREIGN_KEYS))).toBe(false);
    expect(variantKeys(kv)).toHaveLength(12);
    const rows = db.prepare("SELECT kv_key FROM variants").all() as Array<{ kv_key: string }>;
    expect(rows.some((r) => r.kv_key.startsWith(FOREIGN_KEYS))).toBe(false);
    const bodies = db.prepare("SELECT DISTINCT page_path FROM version_bodies").all();
    expect(bodies).toEqual(
      expect.arrayContaining([{ page_path: "/" }, { page_path: "/products" }]),
    );
    expect(bodies).toHaveLength(2);
  });

  it("with only pages outside the list writes nothing, not even a homepage set", async () => {
    const { env, db, kv } = setup({ sensitive: true, pages: [FOREIGN] });
    const result = await orchestrate("medora", env, {});
    expect(result).toMatchObject({
      generated: 0,
      errors: 0,
      cost_usd: 0,
      aborted: true,
      abort_reason: "sensitive_page",
    });
    expect(calls).toBe(0);
    expect(variantKeys(kv)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM variants").get()).toEqual({ n: 0 });
  });

  it("of a customer that is not sensitive writes every confirmed page, as before", async () => {
    const { env, kv } = setup({ sensitive: false, pages: ["/", FOREIGN] });
    const result = await orchestrate("medora", env, {});
    expect(result.generated).toBe(12);
    expect(variantKeys(kv).filter((k) => k.startsWith(FOREIGN_KEYS))).toHaveLength(6);
  });
});

describe("one version", () => {
  it("is not written for a page outside the list: no model call, no row, no key", async () => {
    const { env, db, kv } = setup({ sensitive: true, kept: ["/products"], pages: ["/", FOREIGN] });
    const out = await regenerateOne("medora", "problem", "ai", env, FOREIGN);
    expect(out).toEqual({
      customer_id: "medora",
      intent_dim: "problem",
      source_dim: "ai",
      kv_key: `${FOREIGN_KEYS}problem:ai`,
      cost_usd: 0,
      ok: false,
      error: "sensitive_page",
    });
    expect(calls).toBe(0);
    expect(variantKeys(kv)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM variants").get()).toEqual({ n: 0 });
  });

  it("is written for the homepage of a sensitive customer", async () => {
    const { env, kv } = setup({ sensitive: true, pages: ["/"] });
    const out = await regenerateOne("medora", "problem", "ai", env, "/");
    expect(out.ok).toBe(true);
    expect(variantKeys(kv)).toEqual(["v1:variant:medora:problem:ai"]);
  });
});
