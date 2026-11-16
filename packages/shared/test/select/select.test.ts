/**
 * Tests for selectVariantKey — deterministic argmax snap from IntentVector
 * to (intent_dim, source_dim) VariantSelection.
 *
 * Covers:
 *   - Single dominant dim in each axis
 *   - Tie-break by tuple order (first declared wins)
 *   - All-zero (both axes): first dim in each tuple wins
 *   - Multi-strong: both axes have clear winners simultaneously
 *   - Source NEVER overrides intent invariant
 *   - Confidence propagated from meta
 *   - Determinism: same input twice → same output
 */

import { describe, expect, it } from "vitest";
import { selectVariantKey } from "../../src/select/index.ts";
import type { IntentVector } from "../../src/types.ts";
import { INTENT_DIMENSIONS, SOURCE_DIMENSIONS } from "../../src/vector/dimensions.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroVector(): IntentVector {
  const intent = Object.fromEntries(INTENT_DIMENSIONS.map((d) => [d, 0])) as IntentVector["intent"];
  const source = Object.fromEntries(SOURCE_DIMENSIONS.map((d) => [d, 0])) as IntentVector["source"];
  const context = {
    price_sensitivity: 0,
    technical_depth: 0,
    urgency: 0,
    trust_need: 0,
    mobile_context: 0,
    offhours_context: 0,
  };
  return { intent, source, context, meta: { confidence: 0.5, lead_probability: 0.2 } };
}

function withIntent(dim: (typeof INTENT_DIMENSIONS)[number], score: number): IntentVector {
  const v = zeroVector();
  v.intent[dim] = score;
  return v;
}

function withSource(dim: (typeof SOURCE_DIMENSIONS)[number], score: number): IntentVector {
  const v = zeroVector();
  v.source[dim] = score;
  return v;
}

// ---------------------------------------------------------------------------
// Single dominant dim
// ---------------------------------------------------------------------------

describe("selectVariantKey — single dominant", () => {
  for (const dim of INTENT_DIMENSIONS) {
    it(`intent.${dim} dominant → selection.intent_dim === "${dim}"`, () => {
      const v = withIntent(dim, 0.8);
      const sel = selectVariantKey(v);
      expect(sel.intent_dim).toBe(dim);
    });
  }

  for (const dim of SOURCE_DIMENSIONS) {
    it(`source.${dim} dominant → selection.source_dim === "${dim}"`, () => {
      const v = withSource(dim, 0.8);
      const sel = selectVariantKey(v);
      expect(sel.source_dim).toBe(dim);
    });
  }
});

// ---------------------------------------------------------------------------
// All-zero → first dim in each tuple wins
// ---------------------------------------------------------------------------

describe("selectVariantKey — all-zero fallback", () => {
  it("all intent dims = 0 → brand (no evidence is not competitor)", () => {
    const v = zeroVector();
    const sel = selectVariantKey(v);
    expect(sel.intent_dim).toBe("brand");
  });

  it("all source dims = 0 → direct (no evidence is not ai)", () => {
    const v = zeroVector();
    const sel = selectVariantKey(v);
    expect(sel.source_dim).toBe("direct");
  });

  it("confidence propagated from meta even on all-zero", () => {
    const v = zeroVector();
    v.meta.confidence = 0.5;
    expect(selectVariantKey(v).confidence).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Tie-break: first declared in tuple wins
// ---------------------------------------------------------------------------

describe("selectVariantKey — tie-break by tuple order", () => {
  it("equal intent scores → earlier dim in INTENT_DIMENSIONS tuple wins", () => {
    const v = zeroVector();
    // Set evaluation and feature equal — evaluation is earlier (index 1) vs feature (index 2).
    v.intent.evaluation = 0.6;
    v.intent.feature = 0.6;
    const sel = selectVariantKey(v);
    expect(sel.intent_dim).toBe("evaluation");
  });

  it("equal source scores → earlier dim in SOURCE_DIMENSIONS tuple wins", () => {
    const v = zeroVector();
    // Set social and community equal — social (index 1) is earlier than community (index 2).
    v.source.social = 0.7;
    v.source.community = 0.7;
    const sel = selectVariantKey(v);
    expect(sel.source_dim).toBe("social");
  });

  it("all dims equal → first in each tuple wins (competitor, ai)", () => {
    const v = zeroVector();
    for (const d of INTENT_DIMENSIONS) v.intent[d] = 0.4;
    for (const d of SOURCE_DIMENSIONS) v.source[d] = 0.4;
    const sel = selectVariantKey(v);
    expect(sel.intent_dim).toBe("competitor");
    expect(sel.source_dim).toBe("ai");
  });
});

// ---------------------------------------------------------------------------
// Multi-strong: both axes have clear winners simultaneously
// -----------------------------------------------------------------------

describe("selectVariantKey — multi-strong", () => {
  it("competitor intent AND ai source both high → (competitor, ai) selection", () => {
    const v = zeroVector();
    v.intent.competitor = 0.75;
    v.intent.problem = 0.4; // second highest
    v.source.ai = 1.0;
    v.source.paid = 0.2;
    const sel = selectVariantKey(v);
    expect(sel.intent_dim).toBe("competitor");
    expect(sel.source_dim).toBe("ai");
  });

  it("evaluation intent AND community source → (evaluation, community)", () => {
    const v = zeroVector();
    v.intent.evaluation = 0.6;
    v.source.community = 0.85;
    const sel = selectVariantKey(v);
    expect(sel.intent_dim).toBe("evaluation");
    expect(sel.source_dim).toBe("community");
  });
});

// ---------------------------------------------------------------------------
// Source NEVER overrides intent invariant
// ---------------------------------------------------------------------------

describe("selectVariantKey — source never overrides intent", () => {
  it("source.ai=1.0 with competitor intent dominant → intent_dim is competitor", () => {
    const v = zeroVector();
    v.intent.competitor = 0.75;
    v.source.ai = 1.0;
    v.meta.confidence = 0.9;
    const sel = selectVariantKey(v);
    // The intent axis is selected independently of the source axis.
    expect(sel.intent_dim).toBe("competitor");
    expect(sel.source_dim).toBe("ai");
  });

  it("source.paid=1.0 with pricing intent dominant → intent_dim is pricing", () => {
    const v = zeroVector();
    v.intent.pricing = 0.65;
    v.source.paid = 1.0;
    const sel = selectVariantKey(v);
    expect(sel.intent_dim).toBe("pricing");
    expect(sel.source_dim).toBe("paid");
  });
});

// ---------------------------------------------------------------------------
// Confidence propagation
// ---------------------------------------------------------------------------

describe("selectVariantKey — confidence", () => {
  it("confidence is taken from vector.meta.confidence", () => {
    const v = zeroVector();
    v.intent.feature = 0.8;
    v.meta.confidence = 0.82;
    const sel = selectVariantKey(v);
    expect(sel.confidence).toBe(0.82);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("selectVariantKey — determinism", () => {
  it("identical input twice → identical output", () => {
    const v = zeroVector();
    v.intent.evaluation = 0.65;
    v.source.community = 0.8;
    v.meta.confidence = 0.75;
    const s1 = selectVariantKey(v);
    const s2 = selectVariantKey(v);
    expect(s1).toEqual(s2);
  });
});
