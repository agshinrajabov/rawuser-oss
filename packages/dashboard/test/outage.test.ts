import { describe, expect, it } from "vitest";
import { OUTAGE_STOP_AFTER, looksLikeOutage } from "../src/lib/outage";

describe("looksLikeOutage", () => {
  it("reads a timeout, a dead request or a 5xx as the service, not the words", () => {
    expect(looksLikeOutage("Error: Timeout after 45000ms")).toBe(true);
    expect(looksLikeOutage("Error: Model request failed: HTTP 503")).toBe(true);
    expect(looksLikeOutage("Error: Workers AI request failed: TypeError")).toBe(true);
    expect(looksLikeOutage("Error: The model is not configured")).toBe(true);
    expect(looksLikeOutage(undefined)).toBe(true);
  });
  it("leaves a lint verdict alone", () => {
    expect(looksLikeOutage("lint: number-not-in-brief: 4 weeks")).toBe(false);
    expect(looksLikeOutage("Invalid JSON: unexpected token")).toBe(false);
  });
  it("stops after three", () => {
    expect(OUTAGE_STOP_AFTER).toBe(3);
  });
});
