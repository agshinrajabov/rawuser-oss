/**
 * Tests for the expanded BusinessDNA type shape (Unit 1).
 *
 * These tests use TypeScript's type-system as the primary check — if the
 * type changes break the shape, tsc will fail before vitest even runs.
 * The runtime assertions verify that values satisfying the interface are
 * structurally correct at runtime (useful for generated / JSON data).
 */

import { describe, expect, it } from "vitest";
import type { BusinessDNA } from "../../src/types.ts";

const VALID_DNA: BusinessDNA = {
  customer_id: "test-customer",
  product: "A test product that does things.",
  icp: "Developers who need things done.",
  value_props: ["Value prop one", "Value prop two", "Value prop three"],
  differentiators: ["Differentiator one", "Differentiator two"],
  proof_points: ["Proof point one", "Proof point two"],
  brand_voice: "warm, direct, credible",
  target_market: "Global English-speaking developers",
  target_language: "en",
  per_intent_hints: {
    problem: "Focus on the pain of X",
    competitor: "Compare against Y honestly",
  },
  prompt_cache_id: "cache-key-123",
  updated_at: 1_700_000_000,
};

describe("BusinessDNA shape", () => {
  it("has all required fields", () => {
    expect(VALID_DNA.customer_id).toBe("test-customer");
    expect(VALID_DNA.product).toBeTruthy();
    expect(VALID_DNA.icp).toBeTruthy();
    expect(Array.isArray(VALID_DNA.value_props)).toBe(true);
    expect(VALID_DNA.value_props.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(VALID_DNA.differentiators)).toBe(true);
    expect(VALID_DNA.differentiators.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(VALID_DNA.proof_points)).toBe(true);
    expect(VALID_DNA.proof_points.length).toBeGreaterThanOrEqual(1);
    expect(VALID_DNA.brand_voice).toBeTruthy();
    expect(VALID_DNA.target_market).toBeTruthy();
    expect(VALID_DNA.target_language).toBeTruthy();
    expect(typeof VALID_DNA.updated_at).toBe("number");
  });

  it("per_intent_hints is optional", () => {
    const dnaWithoutHints: BusinessDNA = {
      customer_id: "test-2",
      product: "Another product",
      icp: "Another ICP",
      value_props: ["Value"],
      differentiators: ["Diff"],
      proof_points: ["Proof"],
      brand_voice: "friendly",
      target_market: "Global",
      target_language: "en",
      updated_at: 1_700_000_000,
    };
    expect(dnaWithoutHints.per_intent_hints).toBeUndefined();
  });

  it("per_intent_hints can contain individual intent hints", () => {
    expect(VALID_DNA.per_intent_hints?.problem).toBe("Focus on the pain of X");
    expect(VALID_DNA.per_intent_hints?.competitor).toBe("Compare against Y honestly");
    // Other intents can be absent from the Partial record
    expect(VALID_DNA.per_intent_hints?.pricing).toBeUndefined();
    expect(VALID_DNA.per_intent_hints?.brand).toBeUndefined();
  });

  it("prompt_cache_id is optional", () => {
    const dnaWithCache: BusinessDNA = { ...VALID_DNA, prompt_cache_id: "abc" };
    expect(dnaWithCache.prompt_cache_id).toBe("abc");

    const dnaWithoutCache: BusinessDNA = { ...VALID_DNA, prompt_cache_id: undefined };
    expect(dnaWithoutCache.prompt_cache_id).toBeUndefined();
  });

  it("target_language accepts BCP-47 tags", () => {
    const azerbaijani: BusinessDNA = { ...VALID_DNA, target_language: "az" };
    expect(azerbaijani.target_language).toBe("az");

    const turkish: BusinessDNA = { ...VALID_DNA, target_language: "tr" };
    expect(turkish.target_language).toBe("tr");
  });

  it("value_props, differentiators, proof_points are arrays of strings", () => {
    for (const item of VALID_DNA.value_props) {
      expect(typeof item).toBe("string");
    }
    for (const item of VALID_DNA.differentiators) {
      expect(typeof item).toBe("string");
    }
    for (const item of VALID_DNA.proof_points) {
      expect(typeof item).toBe("string");
    }
  });
});
