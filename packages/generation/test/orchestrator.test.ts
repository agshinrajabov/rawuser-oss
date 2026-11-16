/**
 * Unit tests for the orchestrator.
 *
 * generateVariant is mocked: no real API calls. The DB and KV are
 * mocked with minimal implementations that capture writes.
 *
 * Tests cover:
 *   - Happy path: 36 tuples succeed
 *   - Validation failure + retry success
 *   - Double failure (error row logged, others succeed)
 *   - Cost ceiling abort
 *   - Partial success summary shape
 *   - parseAndValidate correctness
 */

import type { VariantBody } from "@rawuser/shared";
import { describe, expect, it, vi } from "vitest";
import { orchestrate, parseAndValidate, resetProviderState } from "../src/orchestrator.ts";
import type { OrchestrateEnv } from "../src/orchestrator.ts";
import { MODEL_ENV, MODEL_ENV_WITH_FALLBACK, SPARE_MODEL_ID } from "./model-env.ts";

// ---------------------------------------------------------------------------
// Mock generateVariant
// ---------------------------------------------------------------------------

let callCount = 0;
type Tier = "primary" | "fallback" | "spare";
/** `tier` is which try of the call this is (call-model.ts). */
let generateVariantImpl: (
  input: { prompt: string; role?: string },
  tier: Tier,
) => Promise<{
  text: string;
  model: string;
  costUsd: number;
  promptHash: string;
  cacheHit: boolean;
  cacheReadTokens: number;
}>;

vi.mock("../src/generateVariant.ts", () => ({
  generateVariant: vi.fn(
    async (input: { prompt: string; role?: string }, _env: unknown, tier: Tier = "primary") => {
      callCount++;
      return generateVariantImpl(input, tier);
    },
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DNA_ROW = {
  customer_id: "test-cust",
  product: "A test product",
  icp: "Test ICP",
  brand_voice: "test voice",
  value_props: JSON.stringify(["VP1", "VP2"]),
  differentiators: JSON.stringify(["Diff1"]),
  proof_points: JSON.stringify(["Proof1"]),
  target_market: "Global",
  target_language: "en",
  per_intent_hints: JSON.stringify({}),
  prompt_cache_id: null,
  updated_at: 1_700_000_000,
};

const MOCK_PROFILE_ROW = { id: "profile-123" };

function makeVariantBody(intentDim: string, sourceDim = "default"): VariantBody {
  const sectionSets: Record<string, Record<string, unknown>> = {
    competitor: {
      hero: {
        kind: "hero",
        headline: "Hero headline",
        body: "Hero body",
        cta: { label: "See comparison", href: "#compare" },
      },
      comparison: { kind: "comparison", headline: "Compare heading", body: "Compare body" },
      social_proof: { kind: "social_proof", headline: "Proof heading", body: "Proof body" },
      cta: { kind: "cta", headline: "CTA heading", cta: { label: "Start now", href: "#start" } },
    },
    evaluation: {
      hero: {
        kind: "hero",
        headline: "Hero headline",
        body: "Hero body",
        cta: { label: "Evaluate", href: "#eval" },
      },
      features: { kind: "features", headline: "Features", body: "Features body" },
      social_proof: { kind: "social_proof", headline: "Proof", body: "Proof body" },
      faq: { kind: "faq", headline: "FAQ", body: "FAQ body" },
      cta: { kind: "cta", headline: "CTA", cta: { label: "Book call", href: "#call" } },
    },
    feature: {
      hero: {
        kind: "hero",
        headline: "Hero headline",
        body: "Hero body",
        cta: { label: "Explore", href: "#explore" },
      },
      features_core: { kind: "features", headline: "Core Features", body: "Core body" },
      features_integrations: {
        kind: "features",
        headline: "Integrations",
        body: "Integrations body",
      },
      cta: { kind: "cta", headline: "CTA", cta: { label: "Read docs", href: "#docs" } },
    },
    problem: {
      hero: {
        kind: "hero",
        headline: "Hero headline",
        body: "Hero body",
        cta: { label: "See solution", href: "#solution" },
      },
      features: { kind: "features", headline: "Solution Features", body: "Solution body" },
      social_proof: { kind: "social_proof", headline: "Proof", body: "Proof body" },
      cta: {
        kind: "cta",
        headline: "CTA",
        cta: { label: "Start solving", href: "#start" },
      },
    },
    brand: {
      hero: {
        kind: "hero",
        headline: "Hero headline",
        body: "Hero body",
        cta: { label: "Get started", href: "#start" },
      },
      features: { kind: "features", headline: "Features", body: "Features body" },
      social_proof: { kind: "social_proof", headline: "Proof", body: "Proof body" },
      pricing: { kind: "pricing", headline: "Pricing", body: "Pricing body" },
      cta: { kind: "cta", headline: "CTA", cta: { label: "Enroll", href: "#enroll" } },
    },
    pricing: {
      hero: {
        kind: "hero",
        headline: "Hero headline",
        body: "Hero body",
        cta: { label: "See pricing", href: "#pricing" },
      },
      pricing: { kind: "pricing", headline: "Plans", body: "Plans body" },
      features: { kind: "features", headline: "Features", body: "Features body" },
      cta: { kind: "cta", headline: "CTA", cta: { label: "Start free", href: "#free" } },
    },
  };

  const sections = sectionSets[intentDim] ?? sectionSets.brand;

  return {
    customer_id: "test-cust",
    profile_key: `intent:${intentDim}`,
    sections: sections as VariantBody["sections"],
    generated_at: Date.now(),
    prompt_hash: "",
  };
}

function makeSuccessResponse(intentDim: string) {
  const body = makeVariantBody(intentDim);
  return {
    text: JSON.stringify(body),
    model: "model-a",
    costUsd: 0.001,
    promptHash: "abc123",
    cacheHit: false,
    cacheReadTokens: 0,
  };
}

// ---------------------------------------------------------------------------
// Mock D1 and KV
// ---------------------------------------------------------------------------

function makeMockDB(overrides?: {
  dnaRow?: unknown;
  profileRow?: unknown;
  runShouldFail?: boolean;
  /** Confirmed per-path manifests returned by loadConfirmedPaths (.all()). */
  manifestRows?: Array<{ page_path: string; manifest: string }>;
  /** kv_keys returned by loadReadyKvKeys (.all()) for onlyMissing mode. */
  readyKvKeys?: string[];
  /** Section paths whose clicks are counted (conversion_targets). */
  countedPaths?: string[];
}) {
  const writes: Array<{ sql: string; params: unknown[] }> = [];

  return {
    writes,
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...params: unknown[]) => ({
        first: vi.fn(async () => {
          if (sql.includes("SELECT") && sql.includes("business_dna")) {
            return overrides?.dnaRow ?? MOCK_DNA_ROW;
          }
          if (sql.includes("SELECT") && sql.includes("intent_profiles")) {
            return overrides?.profileRow ?? MOCK_PROFILE_ROW;
          }
          if (sql.includes("SELECT") && sql.includes("customers")) {
            return { id: "test-cust" };
          }
          return null;
        }),
        all: vi.fn(async () => {
          if (sql.includes("element_manifests")) {
            return { results: overrides?.manifestRows ?? [] };
          }
          if (sql.includes("conversion_targets")) {
            return {
              results: (overrides?.countedPaths ?? []).map((section_path) => ({ section_path })),
            };
          }
          if (sql.includes("kv_key FROM variants")) {
            return { results: (overrides?.readyKvKeys ?? []).map((kv_key) => ({ kv_key })) };
          }
          return { results: [] };
        }),
        run: vi.fn(async () => {
          if (overrides?.runShouldFail) throw new Error("DB write failed");
          writes.push({ sql, params });
          return { success: true };
        }),
      })),
    })),
  } as unknown as D1Database & { writes: Array<{ sql: string; params: unknown[] }> };
}

function makeMockKV() {
  const stored = new Map<string, string>();
  return {
    stored,
    put: vi.fn(async (key: string, value: string) => {
      stored.set(key, value);
    }),
    get: vi.fn(async (key: string) => stored.get(key) ?? null),
  } as unknown as KVNamespace & { stored: Map<string, string> };
}

function makeEnv(dbOverrides?: Parameters<typeof makeMockDB>[0]): OrchestrateEnv & {
  DB: ReturnType<typeof makeMockDB>;
  VARIANTS: ReturnType<typeof makeMockKV>;
} {
  return {
    ...MODEL_ENV,
    DB: makeMockDB(dbOverrides),
    VARIANTS: makeMockKV(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("orchestrate: happy path", () => {
  it("generates 36 variants when all calls succeed", async () => {
    callCount = 0;

    // Return a valid body for every call, varying by intent dim extracted from the prompt
    const intentDimMap: Record<string, string> = {
      competitor: "competitor",
      evaluation: "evaluation",
      feature: "feature",
      problem: "problem",
      brand: "brand",
      pricing: "pricing",
    };

    generateVariantImpl = async (input) => {
      // Extract intent dim from the prompt (it's in the profile_key instruction)
      const match = /profile_key:.*?"intent:(\w+)"/.exec(input.prompt);
      const intentDim = match?.[1] ?? "brand";
      const mappedDim = intentDimMap[intentDim] ?? "brand";
      return makeSuccessResponse(mappedDim);
    };

    const env = makeEnv();
    const result = await orchestrate("test-cust", env);

    expect(result.generated).toBe(36);
    expect(result.errors).toBe(0);
    expect(result.kv_keys).toHaveLength(36);
    expect(result.aborted).toBe(false);
    expect(result.cost_usd).toBeCloseTo(0.036, 3); // 36 × 0.001
  });
});

describe("orchestrate: the fallback model (2026-09-14)", () => {
  it("a call the primary model does not answer is made once more on the fallback and the row records its id", async () => {
    callCount = 0;
    const tiers: Tier[] = [];
    generateVariantImpl = async (input, tier) => {
      tiers.push(tier);
      if (tier === "primary") throw new Error("Timeout after 45000ms");
      const m = /profile_key:.*?"intent:(\w+)"/.exec(input.prompt);
      return { ...makeSuccessResponse(m?.[1] ?? "brand"), model: "model-b" };
    };
    const env = { ...makeEnv(), ...MODEL_ENV_WITH_FALLBACK };
    resetProviderState();
    const result = await orchestrate("test-cust", env);
    expect(result.errors).toBe(0);
    expect(result.generated).toBe(36);
    // The primary is tried once; after it fails to answer the run goes
    // straight to the fallback for ten minutes instead of paying the
    // timeout 36 times.
    expect(tiers.filter((t) => t === "primary")).toHaveLength(1);
    expect(tiers.filter((t) => t === "fallback")).toHaveLength(36);
    // The provenance rows name the model that answered, by its id.
    const written = env.DB.writes.flatMap((w) => w.params);
    expect(written).toContain("model-b");
    expect(written).not.toContain("model-a");
    resetProviderState();
  });

  it("stays a failure without a fallback model, and a refusal of the words never falls back", async () => {
    callCount = 0;
    const tiers: Tier[] = [];
    generateVariantImpl = async (_input, tier) => {
      tiers.push(tier);
      throw new Error("Timeout after 45000ms");
    };
    resetProviderState();
    const r1 = await orchestrate("test-cust", makeEnv());
    expect(r1.generated).toBe(0);
    expect(tiers.every((t) => t === "primary")).toBe(true);

    tiers.length = 0;
    generateVariantImpl = async (_input, tier) => {
      tiers.push(tier);
      throw new Error("Model output truncated at max_tokens=2048 (content 10 chars)");
    };
    const on = { ...makeEnv(), ...MODEL_ENV_WITH_FALLBACK };
    const r2 = await orchestrate("test-cust", on);
    expect(r2.generated).toBe(0);
    expect(tiers.every((t) => t === "primary")).toBe(true);
  });

  it("without a model configured nothing is called", async () => {
    callCount = 0;
    generateVariantImpl = async () => {
      throw new Error("never called");
    };
    const env = { ...makeEnv(), MODEL_API_KEY: "" };
    await expect(orchestrate("test-cust", env)).rejects.toThrow(
      "The model configuration is not visible to this isolate",
    );
    expect(callCount).toBe(0);
  });
});

describe("orchestrate: the queue's tuple cap and the spare route (2026-09-15, 2026-10-18)", () => {
  it("stops after maxTuples with capped set", async () => {
    callCount = 0;
    generateVariantImpl = async (input) => {
      const m = /profile_key:.*?"intent:(\w+)"/.exec(input.prompt);
      return makeSuccessResponse(m?.[1] ?? "brand");
    };
    const env = makeEnv();
    const first = await orchestrate("test-cust", env, { onlyMissing: true, maxTuples: 12 });
    expect(first.generated).toBe(12);
    expect(first.capped).toBe(true);
    expect(first.aborted).toBe(false);
  });

  it("with the spare route an outage of the primary and the fallback ends on the spare; without it, a failure", async () => {
    const tiers: Tier[] = [];
    generateVariantImpl = async (input, tier) => {
      tiers.push(tier);
      if (tier !== "spare") throw new Error("Timeout after 45000ms");
      const m = /profile_key:.*?"intent:(\w+)"/.exec(input.prompt);
      return { ...makeSuccessResponse(m?.[1] ?? "brand"), model: SPARE_MODEL_ID };
    };
    resetProviderState();
    const withSpare = {
      ...makeEnv(),
      ...MODEL_ENV_WITH_FALLBACK,
      AI: { run: async () => ({}) },
      WORKERS_AI_MODEL: SPARE_MODEL_ID,
    };
    const r1 = await orchestrate("test-cust", withSpare, { maxTuples: 3 });
    expect(r1.generated).toBe(3);
    expect(tiers.filter((t) => t === "spare").length).toBe(3);
    // The endpoint's two timeouts are paid once, not per version.
    expect(tiers.filter((t) => t !== "spare")).toEqual(["primary", "fallback"]);
    resetProviderState();
    tiers.length = 0;
    const without = { ...makeEnv(), ...MODEL_ENV_WITH_FALLBACK };
    const r2 = await orchestrate("test-cust", without, { maxTuples: 3 });
    expect(r2.generated).toBe(0);
    expect(tiers.includes("spare")).toBe(false);
    resetProviderState();
  });
});

describe("orchestrate: per-path generation (A1)", () => {
  it("generates a full set per confirmed path with path-aware KV keys", async () => {
    callCount = 0;
    generateVariantImpl = async (input) => {
      const match = /profile_key:.*?"intent:(\w+)"/.exec(input.prompt);
      return makeSuccessResponse(match?.[1] ?? "brand");
    };

    // Two confirmed paths: root '/' and '/start'. Each manifest covers the hero
    // leaves so at least one leaf survives pruning → variant accepted.
    const heroManifest = JSON.stringify({
      "hero.headline": { css: ["h1"], text: [], structural: "h1" },
      "hero.body": { css: ["p"], text: [], structural: "p" },
      "hero.cta.label": { css: ["a.cta"], text: [], structural: "a.cta" },
    });
    const env = makeEnv({
      manifestRows: [
        { page_path: "/", manifest: heroManifest },
        { page_path: "/start", manifest: heroManifest },
      ],
    });

    const result = await orchestrate("test-cust", env);

    expect(result.generated).toBe(72); // 36 tuples × 2 paths
    expect(result.errors).toBe(0);
    // Root path keeps the historical path-agnostic key shape…
    expect(result.kv_keys).toContain("v1:variant:test-cust:brand:default");
    // …and the non-root path carries the encoded :p: segment.
    expect(result.kv_keys).toContain("v1:variant:test-cust:p:%2Fstart:brand:default");
    // Both keys were written to KV.
    expect(env.VARIANTS.stored.has("v1:variant:test-cust:p:%2Fstart:brand:default")).toBe(true);
  });

  it("falls back to a single path-agnostic '/' set when no manifest is confirmed", async () => {
    callCount = 0;
    generateVariantImpl = async (input) => {
      const match = /profile_key:.*?"intent:(\w+)"/.exec(input.prompt);
      return makeSuccessResponse(match?.[1] ?? "brand");
    };

    const env = makeEnv(); // manifestRows defaults to [] → no confirmed paths
    const result = await orchestrate("test-cust", env);

    expect(result.generated).toBe(36);
    expect(result.kv_keys.every((k) => !k.includes(":p:"))).toBe(true);
  });
});

describe("orchestrate: onlyMissing (cron heal)", () => {
  it("skips tuples that already have a ready variant", async () => {
    callCount = 0;
    generateVariantImpl = async (input) => {
      const match = /profile_key:.*?"intent:(\w+)"/.exec(input.prompt);
      return makeSuccessResponse(match?.[1] ?? "brand");
    };

    // 34 of 36 root tuples already ready → only 2 should regenerate.
    const allKeys: string[] = [];
    for (const intent of ["competitor", "evaluation", "feature", "problem", "brand", "pricing"]) {
      for (const source of ["default", "ai", "social", "community", "organic", "paid"]) {
        allKeys.push(`v1:variant:test-cust:${intent}:${source}`);
      }
    }
    const readyKvKeys = allKeys.slice(0, 34); // leave 2 missing

    const env = makeEnv({ readyKvKeys });
    const result = await orchestrate("test-cust", env, { onlyMissing: true });

    expect(result.generated).toBe(2); // only the 2 non-ready tuples
    expect(callCount).toBe(2); // no LLM calls for the 34 ready ones
  });

  it("with skipErrorsYoungerThanMs the ready-key query also lists young error rows", async () => {
    generateVariantImpl = async (input) => {
      const match = /profile_key:.*?"intent:(\w+)"/.exec(input.prompt);
      return makeSuccessResponse(match?.[1] ?? "brand");
    };
    const env = makeEnv({ readyKvKeys: [] });
    await orchestrate("test-cust", env, {
      onlyMissing: true,
      maxTuples: 1,
      skipErrorsYoungerThanMs: 6 * 3600_000,
    });
    const sqls = (env.DB.prepare as unknown as { mock: { calls: string[][] } }).mock.calls.map(
      (c) => c[0],
    );
    expect(sqls.some((q) => q.includes("status = 'error' AND generated_at >"))).toBe(true);
  });
});

describe("orchestrate: validation failure + retry", () => {
  it("retries once on validation failure and counts it as generated if retry succeeds", async () => {
    callCount = 0;
    let callsForProblem = 0;

    generateVariantImpl = async (input) => {
      const match = /profile_key:.*?"intent:(\w+)"/.exec(input.prompt);
      const intentDim = match?.[1] ?? "brand";

      // Fail the first call for the 'problem' default variant, succeed on retry
      if (intentDim === "problem" && input.prompt.includes("default") === false) {
        // This is not quite right: let's just fail the first two calls for problem
        // Actually simpler: fail on first call count for problem, succeed on second
        callsForProblem++;
        if (callsForProblem === 1) {
          return {
            text: "this is not valid json {{{",
            model: "model-a",
            costUsd: 0.001,
            promptHash: "bad",
            cacheHit: false,
            cacheReadTokens: 0,
          };
        }
      }

      return makeSuccessResponse(intentDim);
    };

    const env = makeEnv();
    const result = await orchestrate("test-cust", env);

    // Should have 36 generated (retry succeeded) or close to it
    expect(result.errors).toBe(0);
    expect(result.generated).toBe(36);
    // callCount should be > 36 due to the retry
    expect(callCount).toBeGreaterThan(36);
  });
});

describe("orchestrate: double failure", () => {
  it("logs error row for tuple that fails twice, others still succeed", async () => {
    callCount = 0;
    let brandCallCount = 0;

    generateVariantImpl = async (input) => {
      const match = /profile_key:.*?"intent:(\w+)"/.exec(input.prompt);
      const intentDim = match?.[1] ?? "brand";

      // Fail BOTH attempts for the brand default variant
      if (intentDim === "brand" && !input.prompt.includes("SOURCE MODIFIER")) {
        brandCallCount++;
        if (brandCallCount <= 2) {
          return {
            text: "{invalid json}",
            model: "model-a",
            costUsd: 0.001,
            promptHash: "bad",
            cacheHit: false,
            cacheReadTokens: 0,
          };
        }
      }

      return makeSuccessResponse(intentDim);
    };

    const env = makeEnv();
    const result = await orchestrate("test-cust", env);

    // At least some should succeed (all except the double-failed brand)
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.generated).toBeGreaterThan(0);
    expect(result.generated + result.errors).toBe(36);

    // A3: the failure REASON must be persisted (error_reason column), not
    // discarded: the R3 investigation was blind because it was thrown away.
    const errorInserts = env.DB.writes.filter(
      (w) => w.sql.includes("INSERT INTO variants") && w.sql.includes("'error'"),
    );
    expect(errorInserts.length).toBeGreaterThanOrEqual(1);
    expect(errorInserts[0]?.sql).toContain("error_reason");
    const reasonArg = errorInserts[0]?.params[7]; // last bind: error_reason
    expect(typeof reasonArg).toBe("string");
    expect(reasonArg as string).toContain("Invalid JSON");

    // And a successful write clears it.
    const readyInserts = env.DB.writes.filter(
      (w) => w.sql.includes("INSERT INTO variants") && w.sql.includes("'ready'"),
    );
    expect(readyInserts[0]?.sql).toContain("error_reason = NULL");
  });
});

describe("orchestrate: lint and one revise pass", () => {
  it("a number the brief never gave triggers one revise; a clean revise ships, a stubborn one leaves that part as built", async () => {
    callCount = 0;
    let pricingRevises = 0;
    let partCalls = 0;

    generateVariantImpl = async (input) => {
      // The call for the part alone (refused-versions.md): it invents again.
      if (input.prompt.includes("It cannot go on the page as it is")) {
        partCalls++;
        expect(input.prompt).toContain("no number the brief does not have");
        return {
          ...makeSuccessResponse("pricing"),
          text: JSON.stringify({ text: "Sprint price: 7.000 AZN, fixed" }),
        };
      }
      const isRevise = input.prompt.includes("FLAGS (rule, then the offending text)");
      // The original JSON rides at the end of a revise prompt; read the intent from it.
      const match = isRevise
        ? /"profile_key":"intent:(\w+)"/.exec(input.prompt)
        : /profile_key:.*?"intent:(\w+)"/.exec(input.prompt);
      const intentDim = match?.[1] ?? "brand";
      const base = makeSuccessResponse(intentDim);
      const body = JSON.parse(base.text) as { sections: Record<string, Record<string, unknown>> };

      if (intentDim === "pricing" && !input.prompt.includes("SOURCE MODIFIER")) {
        if (!isRevise) {
          // First draft invents a price.
          (body.sections.hero as Record<string, unknown>).headline =
            "Sprint price: 12.000 AZN, fixed";
          return { ...base, text: JSON.stringify(body) };
        }
        pricingRevises++;
        // The revise keeps inventing: hard flag survives, tuple must fail.
        (body.sections.hero as Record<string, unknown>).headline = "Sprint price: 9.500 AZN, fixed";
        return { ...base, text: JSON.stringify(body) };
      }
      if (intentDim === "brand" && !input.prompt.includes("SOURCE MODIFIER")) {
        if (!isRevise) {
          // First draft has a dash (soft) and an invented number (hard).
          (body.sections.hero as Record<string, unknown>).body = "We build – for 500 teams.";
          return { ...base, text: JSON.stringify(body) };
        }
        // The revise fixes both.
        return base;
      }
      return base;
    };

    const env = makeEnv();
    const result = await orchestrate("test-cust", env);

    // pricing default: revised twice (the second pass is for surviving hard
    // flags, 2026-09-15), then one call for the headline alone, and it still
    // invents. Since 2026-10-12 the row is not refused for it: the headline
    // is left as the page built it and the rest of the version ships.
    expect(pricingRevises).toBe(2);
    expect(partCalls).toBe(1);
    const errorInserts = env.DB.writes.filter(
      (w) => w.sql.includes("INSERT INTO variants") && w.sql.includes("'error'"),
    );
    expect(errorInserts.length).toBe(0);
    expect(result.generated).toBe(36);
    expect(result.errors).toBe(0);
    expect(result.parts_as_built).toBe(1);
    const readyInserts = env.DB.writes.filter(
      (w) => w.sql.includes("INSERT INTO variants") && w.sql.includes("'ready'"),
    );
    expect(readyInserts[0]?.sql).toContain("lint_flags");
    // brand default: revised and clean → ready, no lint flags stored. Only
    // the pricing row carries one: the part and the rule, never the text.
    const flagged = readyInserts.filter((w) => w.params[8] !== null);
    expect(flagged.map((w) => w.params[8])).toEqual([
      JSON.stringify(["part-as-built:hero.headline:number-not-in-brief"]),
    ]);
    // The invented prices are in no body: not in KV, not in version_bodies.
    const kv = [...env.VARIANTS.stored.values()].join("\n");
    const bodies = env.DB.writes
      .filter((w) => w.sql.includes("version_bodies"))
      .map((w) => JSON.stringify(w.params))
      .join("\n");
    for (const price of ["12.000", "9.500", "7.000"]) {
      expect(kv).not.toContain(price);
      expect(bodies).not.toContain(price);
    }
    const pricing = JSON.parse(
      env.VARIANTS.stored.get("v1:variant:test-cust:pricing:default") ?? "{}",
    ) as VariantBody;
    expect(pricing.sections.hero?.headline).toBeUndefined();
    expect(pricing.sections.hero?.body).toBe("Hero body");
  });
});

describe("orchestrate: buttons keep their action (measure-lab, 2026-10-05)", () => {
  // The operator turned this button's rewrite on (lib/button-rewrite.ts).
  const manifest = JSON.stringify({
    "hero.cta.label": {
      css: ["a.primary"],
      text: ["Start free"],
      structural: "hero button",
      original_char_length: 10,
      rewrite: true,
    },
  });
  const answer = (text: string) => ({
    text,
    model: "model-a" as const,
    costUsd: 0.0002,
    promptHash: "h",
    cacheHit: false,
    cacheReadTokens: 0,
  });
  const versionWith = (prompt: string, label: string) => {
    const intent = /"intent:(\w+)"/.exec(prompt)?.[1] ?? "brand";
    return JSON.stringify({
      customer_id: "test-cust",
      profile_key: `intent:${intent}`,
      sections: { hero: { kind: "hero", cta: { label, href: "#start" } } },
      generated_at: Date.now(),
      prompt_hash: "",
    });
  };

  it("the counted button's action rides in the prompt; a counted label that lost it is mended alone, not refused", async () => {
    const prompts: string[] = [];
    let last = "";
    generateVariantImpl = async (input) => {
      prompts.push(input.prompt);
      if (input.prompt.includes("This button label is on a web page")) {
        return answer(JSON.stringify({ label: "Try it free" }));
      }
      if (input.prompt.includes("Revise the JSON object")) return answer(last);
      last = versionWith(input.prompt, "See how");
      return answer(last);
    };
    const env = makeEnv({
      manifestRows: [{ page_path: "/", manifest }],
      countedPaths: ["hero.cta.label"],
    });
    const result = await orchestrate("test-cust", env, { maxTuples: 1 });
    expect(result.errors).toBe(0);
    expect(result.generated).toBe(1);
    expect(prompts[0]).toContain("BUTTONS KEEP THEIR ACTION");
    expect(prompts[0]).toContain("This is the counted button");
    const key = result.kv_keys[0] as string;
    const stored = JSON.parse(env.VARIANTS.stored.get(key) ?? "{}") as VariantBody;
    expect(stored.sections.hero?.cta?.label).toBe("Try it free");
  });

  it("without a counted button the same label is a soft flag and ships", async () => {
    generateVariantImpl = async (input) => answer(versionWith(input.prompt, "See how"));
    const env = makeEnv({ manifestRows: [{ page_path: "/", manifest }] });
    const result = await orchestrate("test-cust", env, { maxTuples: 1 });
    expect(result.errors).toBe(0);
    expect(result.generated).toBe(1);
  });
});

describe("orchestrate: cost ceiling", () => {
  it("aborts when cost ceiling is reached", async () => {
    callCount = 0;

    // Each call costs $1.50: will hit $2.00 ceiling after 2 calls
    generateVariantImpl = async (input) => {
      const match = /profile_key:.*?"intent:(\w+)"/.exec(input.prompt);
      const intentDim = match?.[1] ?? "brand";
      return {
        ...makeSuccessResponse(intentDim),
        costUsd: 1.5,
      };
    };

    const env = makeEnv();
    const result = await orchestrate("test-cust", env);

    expect(result.aborted).toBe(true);
    expect(result.abort_reason).toBe("cost_ceiling");
    // Should have generated some but not all
    expect(result.generated).toBeGreaterThan(0);
    expect(result.generated).toBeLessThan(36);
    expect(result.cost_usd).toBeGreaterThanOrEqual(2.0);
  });
});

describe("orchestrate: partial success summary", () => {
  it("returns a complete summary even on partial failure", async () => {
    callCount = 0;

    generateVariantImpl = async (input) => {
      const match = /profile_key:.*?"intent:(\w+)"/.exec(input.prompt);
      const intentDim = match?.[1] ?? "brand";
      return makeSuccessResponse(intentDim);
    };

    const env = makeEnv();
    const result = await orchestrate("test-cust", env);

    // Check result shape
    expect(result.customer_id).toBe("test-cust");
    expect(typeof result.generated).toBe("number");
    expect(typeof result.errors).toBe("number");
    expect(typeof result.cost_usd).toBe("number");
    expect(typeof result.cache_hit_rate).toBe("number");
    expect(result.cache_hit_rate).toBeGreaterThanOrEqual(0);
    expect(result.cache_hit_rate).toBeLessThanOrEqual(1);
    expect(Array.isArray(result.kv_keys)).toBe(true);
    expect(Array.isArray(result.failed_tuples)).toBe(true);
    expect(typeof result.aborted).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// parseAndValidate unit tests
// ---------------------------------------------------------------------------

describe("parseAndValidate: syntax repair", () => {
  it("repairs a trailing comma (a habit of the writer's model) and then validates as usual", () => {
    const good = makeSuccessResponse("brand").text;
    const broken = good.replace(/"\s*}/, '",}'); // first `"}` becomes `",}`
    expect(broken).not.toBe(good);
    expect(() => JSON.parse(broken)).toThrow();
    const result = parseAndValidate(broken, "brand", "test-cust");
    expect(result.ok).toBe(true);
  });

  it("still rejects text that repair cannot turn into the schema", () => {
    const result = parseAndValidate("not json at all", "brand", "test-cust");
    expect(result.ok).toBe(false);
  });
});

describe("parseAndValidate", () => {
  it("accepts a valid brand variant body", () => {
    const body = makeVariantBody("brand");
    const result = parseAndValidate(JSON.stringify(body), "brand", "test-cust");
    expect(result.ok).toBe(true);
  });

  it("accepts a valid competitor variant body", () => {
    const body = makeVariantBody("competitor");
    const result = parseAndValidate(JSON.stringify(body), "competitor", "test-cust");
    expect(result.ok).toBe(true);
  });

  it("accepts JSON wrapped in markdown fences", () => {
    const body = makeVariantBody("pricing");
    const fenced = `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;
    const result = parseAndValidate(fenced, "pricing", "test-cust");
    expect(result.ok).toBe(true);
  });

  it("rejects invalid JSON", () => {
    const result = parseAndValidate("not json", "brand", "test-cust");
    expect(result.ok).toBe(false);
    // jsonrepair turns bare text into a JSON string, which then fails the
    // root-object check; either reason is a rejection of the same input.
    if (!result.ok) expect(result.reason).toMatch(/Invalid JSON|Root value is not an object/);
  });

  it("rejects wrong customer_id", () => {
    const body = makeVariantBody("brand");
    const result = parseAndValidate(JSON.stringify(body), "brand", "wrong-id");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("customer_id mismatch");
  });

  it("rejects wrong profile_key", () => {
    const body = makeVariantBody("brand");
    const result = parseAndValidate(JSON.stringify(body), "competitor", "test-cust");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("profile_key mismatch");
  });

  it("rejects missing sections.hero", () => {
    const body = makeVariantBody("brand");
    // biome-ignore lint/performance/noDelete: test requires property removal
    delete (body.sections as Record<string, unknown>).hero;
    const result = parseAndValidate(JSON.stringify(body), "brand", "test-cust");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("hero");
  });

  it("rejects missing sections.cta", () => {
    const body = makeVariantBody("brand");
    // biome-ignore lint/performance/noDelete: test requires property removal
    delete (body.sections as Record<string, unknown>).cta;
    const result = parseAndValidate(JSON.stringify(body), "brand", "test-cust");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("cta");
  });

  it("rejects a body containing [PLACEHOLDER]", () => {
    const body = makeVariantBody("brand");
    const heroSection = (body.sections as Record<string, { headline?: string }>).hero;
    if (heroSection) {
      heroSection.headline = "[PLACEHOLDER] This is a placeholder";
    }
    const result = parseAndValidate(JSON.stringify(body), "brand", "test-cust");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("[PLACEHOLDER]");
  });

  it("rejects a body missing the competitor comparison section", () => {
    const body = makeVariantBody("competitor");
    // biome-ignore lint/performance/noDelete: test requires property removal
    delete (body.sections as Record<string, unknown>).comparison;
    const result = parseAndValidate(JSON.stringify(body), "competitor", "test-cust");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("comparison");
  });
});

// ---------------------------------------------------------------------------
// Fix Pass A / QA-2: manifest-subset validation
// ---------------------------------------------------------------------------

describe("parseAndValidate: manifest-subset pruning (R3; was Fix Pass A / QA-2 reject)", () => {
  // Minimal manifest fixture: matches the keys we'd expect on a real customer
  // page where only hero.headline and cta.cta.label have selectors.
  const manifest = {
    "hero.headline": { css: ["h1"], text: [], structural: "h1" },
    "cta.cta.label": { css: [".cta a"], text: [], structural: ".cta a" },
  };

  it("accepts a variant whose leaf paths are a strict subset of the manifest (no prune)", () => {
    const body = {
      customer_id: "test-cust",
      profile_key: "intent:brand",
      generated_at: Date.now(),
      sections: {
        hero: { kind: "hero", headline: "Welcome" },
        cta: { kind: "cta", cta: { label: "Sign up" } },
      },
    };
    const result = parseAndValidate(JSON.stringify(body), "brand", "test-cust", manifest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pruned).toBeUndefined();
  });

  it("prunes a leaf path NOT in the manifest instead of rejecting the variant", () => {
    const body = {
      customer_id: "test-cust",
      profile_key: "intent:brand",
      generated_at: Date.now(),
      sections: {
        hero: { kind: "hero", headline: "Welcome", body: "Body text here" }, // body not in manifest
        cta: { kind: "cta", cta: { label: "Sign up" } },
      },
    };
    const result = parseAndValidate(JSON.stringify(body), "brand", "test-cust", manifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pruned).toContain("hero.body");
      // The off-manifest leaf is gone from the accepted body; the allowed
      // sibling leaf survives.
      const hero = (result.body.sections as Record<string, Record<string, unknown>>).hero;
      expect(hero.body).toBeUndefined();
      expect(hero.headline).toBe("Welcome");
    }
  });

  it("prunes pricing.* paths (and the emptied pricing section) when the manifest has none", () => {
    // The exact production failure case from QA-2: now pruned, not rejected.
    const body = {
      customer_id: "test-cust",
      profile_key: "intent:pricing",
      generated_at: Date.now(),
      sections: {
        hero: { kind: "hero", headline: "Pricing hero" },
        pricing: { kind: "pricing", headline: "Plans", body: "Choose a plan" },
        cta: { kind: "cta", cta: { label: "Start" } },
      },
    };
    const result = parseAndValidate(JSON.stringify(body), "pricing", "test-cust", manifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pruned).toContain("pricing.headline");
      expect(result.pruned).toContain("pricing.body");
      const sections = result.body.sections as Record<string, unknown>;
      // The pricing section had no manifest-covered leaf → dropped entirely.
      expect(sections.pricing).toBeUndefined();
      // The manifest-covered leaves survive.
      expect((sections.hero as Record<string, unknown>).headline).toBe("Pricing hero");
      expect(sections.cta).toBeDefined();
    }
  });

  it("rejects only when NO manifest path remains after pruning", () => {
    const body = {
      customer_id: "test-cust",
      profile_key: "intent:brand",
      generated_at: Date.now(),
      sections: {
        // Nothing here maps to hero.headline or cta.cta.label.
        story: { kind: "story", headline: "Our mission", body: "Long narrative" },
      },
    };
    const result = parseAndValidate(JSON.stringify(body), "brand", "test-cust", manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("covered no manifest paths");
  });

  it(".kind metadata paths are exempt from the subset check", () => {
    // sections.hero.kind = "hero" is metadata; even though "hero.kind"
    // isn't in the manifest, validation should pass.
    const body = {
      customer_id: "test-cust",
      profile_key: "intent:brand",
      generated_at: Date.now(),
      sections: {
        hero: { kind: "hero", headline: "Welcome" },
        cta: { kind: "cta", cta: { label: "Sign up" } },
      },
    };
    const result = parseAndValidate(JSON.stringify(body), "brand", "test-cust", manifest);
    expect(result.ok).toBe(true);
  });

  it("a headline_alt rides with its base path through the subset check, and is pruned with it", () => {
    const manifest = { "hero.headline": { css: ["h1"], text: [], structural: "" } } as never;
    const kept = parseAndValidate(
      JSON.stringify({
        customer_id: "c",
        profile_key: "intent:brand",
        sections: {
          hero: { kind: "hero", headline: "One", headline_alt: "One, and longer" },
          features: { kind: "features", headline: "Two", headline_alt: "Two, and longer" },
        },
        generated_at: 1,
        prompt_hash: "",
      }),
      "brand",
      "c",
      manifest,
    );
    expect(kept.ok).toBe(true);
    const body = (kept as { body: { sections: Record<string, Record<string, unknown>> } }).body;
    expect(body.sections.hero?.headline_alt).toBe("One, and longer");
    expect(body.sections.features).toBeUndefined();
    expect((kept as { pruned?: string[] }).pruned).toEqual([
      "features.headline",
      "features.headline_alt",
    ]);
  });

  it("an .href never fails the subset check, and is dropped: the button keeps the page's own link", () => {
    const body = {
      customer_id: "test-cust",
      profile_key: "intent:brand",
      generated_at: Date.now(),
      sections: {
        hero: { kind: "hero", headline: "Welcome" },
        cta: { kind: "cta", cta: { label: "Sign up", href: "/signup" } },
      },
    };
    const result = parseAndValidate(JSON.stringify(body), "brand", "test-cust", manifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Not a pruned path (no retry, no warning), but not in the body either
      // (the first outside pilot, 2026-10-12, cta-pilot.test.ts).
      expect(result.pruned).toBeUndefined();
      expect(result.body.sections.cta?.cta).toEqual({ label: "Sign up" });
    }
  });

  it("when manifest is null, the subset rule is skipped (legacy customer path)", () => {
    const body = makeVariantBody("brand"); // emits many paths, none constrained
    const result = parseAndValidate(JSON.stringify(body), "brand", "test-cust", null);
    expect(result.ok).toBe(true);
  });

  it("when manifest is empty {}, the subset rule is skipped (defensive)", () => {
    const body = makeVariantBody("brand");
    const result = parseAndValidate(JSON.stringify(body), "brand", "test-cust", {});
    expect(result.ok).toBe(true);
  });
});
