/**
 * Unit 1 — Vector dimension tuple tests.
 *
 * Assert tuple length and order. These are the permanent frozen foundation;
 * changing length or order is a breaking change that must be caught here.
 */

import { describe, expect, it } from "vitest";
import {
  CONTEXT_DIMENSIONS,
  INTENT_DIMENSIONS,
  SOURCE_DIMENSIONS,
} from "../../src/vector/dimensions.ts";

describe("INTENT_DIMENSIONS", () => {
  it("has exactly 6 entries", () => {
    expect(INTENT_DIMENSIONS).toHaveLength(6);
  });

  it("has the correct order and names", () => {
    expect(INTENT_DIMENSIONS[0]).toBe("competitor");
    expect(INTENT_DIMENSIONS[1]).toBe("evaluation");
    expect(INTENT_DIMENSIONS[2]).toBe("feature");
    expect(INTENT_DIMENSIONS[3]).toBe("problem");
    expect(INTENT_DIMENSIONS[4]).toBe("brand");
    expect(INTENT_DIMENSIONS[5]).toBe("pricing");
  });
});

describe("SOURCE_DIMENSIONS", () => {
  it("has exactly 6 entries", () => {
    expect(SOURCE_DIMENSIONS).toHaveLength(6);
  });

  it("has the correct order and names", () => {
    expect(SOURCE_DIMENSIONS[0]).toBe("ai");
    expect(SOURCE_DIMENSIONS[1]).toBe("social");
    expect(SOURCE_DIMENSIONS[2]).toBe("community");
    expect(SOURCE_DIMENSIONS[3]).toBe("paid");
    expect(SOURCE_DIMENSIONS[4]).toBe("organic");
    expect(SOURCE_DIMENSIONS[5]).toBe("direct");
  });
});

describe("CONTEXT_DIMENSIONS", () => {
  it("has exactly 6 entries", () => {
    expect(CONTEXT_DIMENSIONS).toHaveLength(6);
  });

  it("has the correct order and names", () => {
    expect(CONTEXT_DIMENSIONS[0]).toBe("price_sensitivity");
    expect(CONTEXT_DIMENSIONS[1]).toBe("technical_depth");
    expect(CONTEXT_DIMENSIONS[2]).toBe("urgency");
    expect(CONTEXT_DIMENSIONS[3]).toBe("trust_need");
    expect(CONTEXT_DIMENSIONS[4]).toBe("mobile_context");
    expect(CONTEXT_DIMENSIONS[5]).toBe("offhours_context");
  });
});
