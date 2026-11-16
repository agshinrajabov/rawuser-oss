/**
 * Classifier tests — vector output (V1 refactor).
 *
 * Covers:
 *   - All 6 intent dims as dominant
 *   - All 6 source dims as dominant
 *   - Multi-strong (AI + competitor)
 *   - Trial/demo UTM → urgency, NOT evaluation
 *   - Competitor vs evaluation distinction
 *   - Bot → lead_probability = 0
 *   - Determinism
 *   - Privacy (referrer host-only)
 *   - Citation-click lead_probability boost
 *   - Confidence always in [0.5, 1.0]
 *   - All dims always present in output
 *
 * Lead-probability scenarios previously in lead-probability.test.ts are
 * now verified here as vector meta.lead_probability assertions, since
 * leadProbability was folded into the classifier (Unit 2).
 */

import { describe, expect, it } from "vitest";
import { classify } from "../src/classify/index.ts";
import { extractSignals } from "../src/signals/extract.ts";
import type { Signals } from "../src/types.ts";
import {
  CONTEXT_DIMENSIONS,
  INTENT_DIMENSIONS,
  SOURCE_DIMENSIONS,
} from "../src/vector/dimensions.ts";
import { CLASSIFY_CASES } from "./fixtures/classify-cases.ts";

// Fixed timestamp for deterministic tests (offhours logic needs a clock).
// 2026-05-22 14:00 UTC — within business hours so offhours_context = 0.
const FIXED_TS = new Date("2026-05-22T14:00:00Z").getTime();

function makeHeaders(obj: Record<string, string>): Headers {
  return new Headers(obj);
}

function makeSignals(req: {
  url: string;
  headers: Record<string, string>;
  cf?: { country?: string; timezone?: string };
}): Signals {
  const parsed = new URL(req.url);
  return extractSignals({
    url: parsed,
    headers: makeHeaders(req.headers),
    cf: req.cf ? { country: req.cf.country } : undefined,
    selfHost: "rawuser.test",
    // In production the snippet sends location.pathname as ?path=; in these
    // unit fixtures the request URL's own pathname stands in as the entry path.
    entryPath: parsed.pathname,
  });
}

// -----------------------------------------------------------------------
// Fixture-driven suite
// -----------------------------------------------------------------------
describe("classify — fixture cases", () => {
  for (const c of CLASSIFY_CASES) {
    it(c.name, () => {
      const signals = makeSignals(c.request);

      // Signal-level assertions
      if (c.expect.referrerHost !== undefined) {
        expect(signals.referrerHost).toBe(c.expect.referrerHost);
      }
      if (c.expect.isBot !== undefined) {
        expect(signals.device === "bot").toBe(c.expect.isBot);
      }
      if (c.expect.aiSource !== undefined) {
        expect(signals.aiSource).toBe(c.expect.aiSource);
      }

      const vector = classify(signals, FIXED_TS);

      // Verify all dims are present
      for (const d of INTENT_DIMENSIONS) {
        expect(d in vector.intent, `intent.${d} missing`).toBe(true);
      }
      for (const d of SOURCE_DIMENSIONS) {
        expect(d in vector.source, `source.${d} missing`).toBe(true);
      }
      for (const d of CONTEXT_DIMENSIONS) {
        expect(d in vector.context, `context.${d} missing`).toBe(true);
      }

      // Intent assertions
      if (c.expect.intent) {
        for (const [dim, [min, max]] of Object.entries(c.expect.intent)) {
          const val = vector.intent[dim as keyof typeof vector.intent];
          expect(val, `intent.${dim} expected [${min}, ${max}], got ${val}`).toBeGreaterThanOrEqual(
            min,
          );
          expect(val, `intent.${dim} expected [${min}, ${max}], got ${val}`).toBeLessThanOrEqual(
            max,
          );
        }
      }

      // Source assertions
      if (c.expect.source) {
        for (const [dim, [min, max]] of Object.entries(c.expect.source)) {
          const val = vector.source[dim as keyof typeof vector.source];
          expect(val, `source.${dim} expected [${min}, ${max}], got ${val}`).toBeGreaterThanOrEqual(
            min,
          );
          expect(val, `source.${dim} expected [${min}, ${max}], got ${val}`).toBeLessThanOrEqual(
            max,
          );
        }
      }

      // Context assertions
      if (c.expect.context) {
        for (const [dim, [min, max]] of Object.entries(c.expect.context)) {
          const val = vector.context[dim as keyof typeof vector.context];
          expect(
            val,
            `context.${dim} expected [${min}, ${max}], got ${val}`,
          ).toBeGreaterThanOrEqual(min);
          expect(val, `context.${dim} expected [${min}, ${max}], got ${val}`).toBeLessThanOrEqual(
            max,
          );
        }
      }

      // Meta assertions
      if (c.expect.meta) {
        if (c.expect.meta.confidence) {
          const [min, max] = c.expect.meta.confidence;
          expect(vector.meta.confidence).toBeGreaterThanOrEqual(min);
          expect(vector.meta.confidence).toBeLessThanOrEqual(max);
        }
        if (c.expect.meta.lead_probability) {
          const [min, max] = c.expect.meta.lead_probability;
          expect(
            vector.meta.lead_probability,
            `lead_prob expected [${min}, ${max}], got ${vector.meta.lead_probability}`,
          ).toBeGreaterThanOrEqual(min);
          expect(vector.meta.lead_probability).toBeLessThanOrEqual(max);
        }
      }

      // Selection assertions (using selectVariantKey logic manually)
      if (c.expect.selection) {
        // Find dominant intent dim
        const topIntent = INTENT_DIMENSIONS.reduce(
          (top, d) => (vector.intent[d] > vector.intent[top] ? d : top),
          INTENT_DIMENSIONS[0],
        );
        const topSource = SOURCE_DIMENSIONS.reduce(
          (top, d) => (vector.source[d] > vector.source[top] ? d : top),
          SOURCE_DIMENSIONS[0],
        );
        expect(topIntent, "selection.intent_dim").toBe(c.expect.selection.intent_dim);
        expect(topSource, "selection.source_dim").toBe(c.expect.selection.source_dim);
      }
    });
  }
});

// -----------------------------------------------------------------------
// Invariants
// -----------------------------------------------------------------------
describe("classify — invariants", () => {
  it("confidence is always >= 0.5", () => {
    const signals = makeSignals({
      url: "https://rawuser.test/",
      headers: { referer: "https://some-random-blog.io/post" },
    });
    const v = classify(signals, FIXED_TS);
    expect(v.meta.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("confidence is always <= 1.0", () => {
    const signals = makeSignals({
      url: "https://rawuser.test/",
      headers: { referer: "https://chatgpt.com/" },
    });
    const v = classify(signals, FIXED_TS);
    expect(v.meta.confidence).toBeLessThanOrEqual(1.0);
  });

  it("all intent dims are in [0, 1]", () => {
    const signals = makeSignals({
      url: "https://rawuser.test/?utm_campaign=vs-salesforce",
      headers: { referer: "https://chatgpt.com/" },
    });
    const v = classify(signals, FIXED_TS);
    for (const d of INTENT_DIMENSIONS) {
      expect(v.intent[d]).toBeGreaterThanOrEqual(0);
      expect(v.intent[d]).toBeLessThanOrEqual(1);
    }
  });

  it("all source dims are in [0, 1]", () => {
    const signals = makeSignals({ url: "https://rawuser.test/", headers: {} });
    const v = classify(signals, FIXED_TS);
    for (const d of SOURCE_DIMENSIONS) {
      expect(v.source[d]).toBeGreaterThanOrEqual(0);
      expect(v.source[d]).toBeLessThanOrEqual(1);
    }
  });

  it("all context dims are in [0, 1]", () => {
    const signals = makeSignals({ url: "https://rawuser.test/?utm_campaign=demo", headers: {} });
    const v = classify(signals, FIXED_TS);
    for (const d of CONTEXT_DIMENSIONS) {
      expect(v.context[d]).toBeGreaterThanOrEqual(0);
      expect(v.context[d]).toBeLessThanOrEqual(1);
    }
  });

  it("lead_probability is exactly 0 for bots", () => {
    const signals = makeSignals({
      url: "https://rawuser.test/",
      headers: { "user-agent": "GPTBot/1.2" },
    });
    const v = classify(signals, FIXED_TS);
    expect(v.meta.lead_probability).toBe(0);
  });

  it("lead_probability is in [0.05, 0.95] for non-bots (never 0 or 1)", () => {
    const signals = makeSignals({
      url: "https://rawuser.test/",
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    });
    const v = classify(signals, FIXED_TS);
    expect(v.meta.lead_probability).toBeGreaterThanOrEqual(0.05);
    expect(v.meta.lead_probability).toBeLessThanOrEqual(0.95);
  });
});

// -----------------------------------------------------------------------
// Determinism
// -----------------------------------------------------------------------
describe("classify — determinism", () => {
  it("identical input twice → identical output", () => {
    const signals = makeSignals({
      url: "https://rawuser.test/?utm_campaign=enterprise",
      headers: { referer: "https://chatgpt.com/" },
    });
    const v1 = classify(signals, FIXED_TS);
    const v2 = classify(signals, FIXED_TS);
    expect(v1).toEqual(v2);
  });
});

// -----------------------------------------------------------------------
// Lead-probability scenarios (migrated from lead-probability.test.ts)
// -----------------------------------------------------------------------
describe("classify — lead_probability (migrated from lead-probability.test.ts)", () => {
  it("GPTBot UA → lead_probability = 0", () => {
    const signals = makeSignals({
      url: "https://rawuser.test/",
      headers: { "user-agent": "GPTBot/1.2" },
    });
    expect(classify(signals, FIXED_TS).meta.lead_probability).toBe(0);
  });

  it("ClaudeBot UA → lead_probability = 0", () => {
    const signals = makeSignals({
      url: "https://rawuser.test/",
      headers: { "user-agent": "ClaudeBot/1.0" },
    });
    expect(classify(signals, FIXED_TS).meta.lead_probability).toBe(0);
  });

  it("Googlebot UA → lead_probability = 0", () => {
    const signals = makeSignals({
      url: "https://rawuser.test/",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    });
    expect(classify(signals, FIXED_TS).meta.lead_probability).toBe(0);
  });

  it("ChatGPT-User UA (citation-click) → lead_probability ≥ 0.40", () => {
    const signals = makeSignals({
      url: "https://rawuser.test/",
      headers: { "user-agent": "ChatGPT-User/1.0" },
    });
    const v = classify(signals, FIXED_TS);
    expect(v.meta.lead_probability).toBeGreaterThanOrEqual(0.4);
    expect(v.meta.lead_probability).toBeLessThanOrEqual(0.95);
  });

  it("pricing UTM boosts lead_probability vs naked direct", () => {
    const withPricing = classify(
      makeSignals({ url: "https://rawuser.test/?utm_campaign=pricing", headers: {} }),
      FIXED_TS,
    );
    const withoutPricing = classify(
      makeSignals({
        url: "https://rawuser.test/",
        headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
      }),
      FIXED_TS,
    );
    expect(withPricing.meta.lead_probability).toBeGreaterThan(withoutPricing.meta.lead_probability);
  });

  it("demo UTM (urgency) boosts lead_probability vs naked direct", () => {
    const withDemo = classify(
      makeSignals({ url: "https://rawuser.test/?utm_campaign=demo", headers: {} }),
      FIXED_TS,
    );
    const withoutDemo = classify(
      makeSignals({
        url: "https://rawuser.test/",
        headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
      }),
      FIXED_TS,
    );
    expect(withDemo.meta.lead_probability).toBeGreaterThan(withoutDemo.meta.lead_probability);
  });

  it("g2.com referrer adds comparison-site bonus to lead_probability", () => {
    const withG2 = classify(
      makeSignals({
        url: "https://rawuser.test/",
        headers: { referer: "https://g2.com/products/rawuser" },
      }),
      FIXED_TS,
    );
    const nakedDirect = classify(
      makeSignals({
        url: "https://rawuser.test/",
        headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
      }),
      FIXED_TS,
    );
    expect(withG2.meta.lead_probability).toBeGreaterThan(nakedDirect.meta.lead_probability);
  });
});

// -----------------------------------------------------------------------
// Offhours context
// -----------------------------------------------------------------------
describe("classify — offhours_context", () => {
  it("timestamp in business hours → offhours_context = 0", () => {
    // 14:00 UTC
    const ts = new Date("2026-05-22T14:00:00Z").getTime();
    const signals = makeSignals({ url: "https://rawuser.test/", headers: {} });
    const v = classify(signals, ts, "UTC");
    expect(v.context.offhours_context).toBe(0);
  });

  it("timestamp outside business hours → offhours_context = 1", () => {
    // 22:00 UTC
    const ts = new Date("2026-05-22T22:00:00Z").getTime();
    const signals = makeSignals({ url: "https://rawuser.test/", headers: {} });
    const v = classify(signals, ts, "UTC");
    expect(v.context.offhours_context).toBe(1.0);
  });
});
