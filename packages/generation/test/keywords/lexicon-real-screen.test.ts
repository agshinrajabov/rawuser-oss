/**
 * The lexicon build with the real special-category screen
 * (packages/shared/src/special-category/terms.ts; privacy review, section 10,
 * condition 7): a phrase the shared table refuses is never stored, in any
 * intent, and never reaches the bundle.
 */
import { visitorBundleKey } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildKeywordLexicon } from "../../src/keywords/lexicon.ts";
import { MODEL_ENV } from "../model-env.ts";
import { type Harness, harness } from "../proof-harness.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
  h.customer("acme");
  h.db.prepare("UPDATE customers SET live_at = 1 WHERE id = 'acme'").run();
  h.db
    .prepare(
      "INSERT INTO business_dna (customer_id, product, icp, target_language, updated_at) VALUES ('acme', 'A CRM for small teams', 'Small teams', 'en', 2)",
    )
    .run();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the real screen", () => {
  it("refuses health and religion phrases, keeps the commercial ones", async () => {
    const text = JSON.stringify({
      en: {
        pricing: ["crm pricing", "diabetes tracker"],
        problem: ["depression help", "lost leads"],
        evaluation: ["crm for churches", "best crm"],
      },
    });
    const call = vi.fn(async () => ({
      ok: true as const,
      value: {
        text,
        model: "model-a" as const,
        costUsd: 0,
        promptHash: "h",
        cacheHit: false,
        cacheReadTokens: 0,
      },
    }));
    const r = await buildKeywordLexicon("acme", { ...h.env, ...MODEL_ENV } as never, {
      call: call as never,
    });
    expect(r.ok).toBe(true);
    const row = h.db.prepare("SELECT keyword_lexicon FROM customers WHERE id = 'acme'").get() as {
      keyword_lexicon: string;
    };
    expect(JSON.parse(row.keyword_lexicon)).toEqual({
      pricing: ["crm pricing"],
      evaluation: ["best crm"],
      problem: ["lost leads"],
    });
    const kv = h.kv.get(visitorBundleKey("acme")) ?? "";
    for (const refused of ["diabetes", "depression", "churches"]) {
      expect(kv).not.toContain(refused);
    }
  });
});
