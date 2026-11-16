/**
 * A language on the same address is recorded and nothing more
 * (docs/specs/per-language.md; I1 of docs/specs/pilot-gaps.md).
 *
 * The customer's `languages` JSON holds an entry with no path for it. This
 * file proves, on SQLite with every migration and the real statements, that
 * such an entry is never a path to write and never a row of the edge's path
 * to language map: both read the confirmed manifests, not that list.
 */
import type { Manifest } from "@rawuser/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeKv, makeSqliteD1 } from "./admin/sqlite-d1.ts";
import { MODEL_ENV } from "./model-env.ts";

interface ModelInput {
  prompt: string;
  cachedPreamble?: string;
}
let inputs: ModelInput[] = [];
vi.mock("../src/generateVariant.ts", () => ({
  generateVariant: vi.fn(async (input: ModelInput) => {
    inputs.push(input);
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
  fetchPageHtml: vi.fn(
    async () =>
      `<html lang="az"><body><a href="/language/az">AZ</a><a href="/language/en">English</a><h1>${HEADLINE}</h1></body></html>`,
  ),
}));
vi.mock("../src/site-map/served-load.ts", () => ({
  loadServedIntents: vi.fn(async () => ["problem"]),
}));

const { orchestrate } = await import("../src/orchestrator.ts");
const { writeLangMap } = await import("../src/admin/onboard.ts");
const { queueCustomers } = await import("../src/cron/regen-queue.ts");
const { isSameAddress } = await import("../src/admin/quickstart.ts");
const { resetPageLinks } = await import("../src/page-links.ts");
const { resetReads } = await import("../src/inline-shape-backfill.ts");

const LANGUAGES = [
  {
    lang: "az",
    path: "/",
    source: "html-lang",
    status: "primary",
    parts: 1,
    brief_drafted: true,
    enabled: true,
  },
  {
    lang: "en",
    path: null,
    source: "switch",
    status: "same_address",
    parts: 0,
    brief_drafted: false,
    enabled: false,
  },
];

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

function setup() {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    `INSERT INTO customers (id, slug, domain, plan, status, created_at, auto_approve, live_at, site_map_off, languages)
     VALUES ('medora', 'medora', 'www.medora.test', 'pilot', 'active', 1, 1, 2, 1, ?)`,
  ).run(JSON.stringify(LANGUAGES));
  db.prepare(
    `INSERT INTO business_dna (customer_id, product, icp, brand_voice, updated_at, value_props, differentiators, proof_points, target_market, target_language, per_intent_hints)
     VALUES ('medora', 'Qida əlavələrinin sifarişlə istehsalı', 'Öz brendi olan şirkətlər', 'sakit', 1, '["İstehsal"]', '["Formul"]', '["Sertifikat"]', 'Yerli bazar', 'az', '{}')`,
  ).run();
  db.prepare(
    "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('medora', '/', ?, 'https://www.medora.test/', 1, 1, 'az')",
  ).run(JSON.stringify(MANIFEST));
  const kv = makeKv();
  return { env: { ...MODEL_ENV, DB: d1, VARIANTS: kv }, db, kv };
}

beforeEach(() => {
  inputs = [];
  resetPageLinks();
  resetReads();
});

describe("an entry with no path in the customer's languages", () => {
  it("is told apart by its status and its missing path", () => {
    expect(LANGUAGES.map((l) => isSameAddress(l as never))).toEqual([false, true]);
  });

  it("is no row of the edge's path to language map", async () => {
    const { env, kv } = setup();
    await writeLangMap(env as never, "medora");
    expect(JSON.parse(kv.store.get("v1:customer:medora:lang") ?? "{}")).toEqual({ "/": "az" });
  });

  it("is no path to write: a run writes the home page in Azerbaijani and nothing else", async () => {
    const { env, db, kv } = setup();
    const result = await orchestrate("medora", env, {});
    expect(result.errors).toBe(0);
    expect(result.generated).toBe(6);
    // Every key is a home page key: no `:p:` path, no language in a key.
    expect(result.kv_keys.sort()).toEqual(
      ["ai", "community", "default", "organic", "paid", "social"].map(
        (s) => `v1:variant:medora:problem:${s}`,
      ),
    );
    expect([...kv.store.keys()].filter((k) => k.startsWith("v1:variant:")).sort()).toEqual(
      result.kv_keys.sort(),
    );
    const bodies = db.prepare("SELECT page_path, language FROM version_bodies").all() as Array<{
      page_path: string;
      language: string | null;
    }>;
    expect(bodies).toHaveLength(6);
    expect(bodies.every((b) => b.page_path === "/" && b.language === "az")).toBe(true);
    // No page was read or stored for English.
    const manifests = db
      .prepare("SELECT page_path, language FROM element_manifests")
      .all() as Array<{ page_path: string; language: string | null }>;
    expect(manifests).toEqual([{ page_path: "/", language: "az" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM business_dna_i18n").get()).toEqual({ n: 0 });
    // The model was asked for Azerbaijani each time.
    const firsts = inputs.filter((i) => i.prompt.includes("profile_key:"));
    expect(firsts).toHaveLength(6);
    expect(firsts.every((i) => /\baz\b/.test(i.cachedPreamble ?? ""))).toBe(true);
  });

  it("gives the queue nothing to do once the home page is written", async () => {
    const { env } = setup();
    await orchestrate("medora", env, {});
    expect(await queueCustomers(env.DB)).toEqual([]);
  });
});
