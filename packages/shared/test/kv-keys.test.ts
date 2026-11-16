import { describe, expect, it } from "vitest";
import { variantKey, variantKeyForPath } from "../src/kv-keys.ts";

describe("variantKey (path-agnostic)", () => {
  it("produces the historical v1 shape", () => {
    expect(variantKey("lumera-school", "pricing", "direct")).toBe(
      "v1:variant:lumera-school:pricing:direct",
    );
  });

  it("supports the 'default' source sentinel", () => {
    expect(variantKey("acme", "brand", "default")).toBe("v1:variant:acme:brand:default");
  });
});

describe("variantKeyForPath", () => {
  it("root '/' produces the IDENTICAL key to variantKey (back-compat)", () => {
    expect(variantKeyForPath("lumera-school", "/", "pricing", "direct")).toBe(
      variantKey("lumera-school", "pricing", "direct"),
    );
  });

  it("non-root path gets a URL-encoded :p: segment", () => {
    expect(variantKeyForPath("lumera-school", "/start", "brand", "paid")).toBe(
      "v1:variant:lumera-school:p:%2Fstart:brand:paid",
    );
  });

  it("encodes nested paths so '/' can't collide with the delimiter", () => {
    expect(variantKeyForPath("acme", "/a/b", "brand", "direct")).toBe(
      "v1:variant:acme:p:%2Fa%2Fb:brand:direct",
    );
  });

  it("root and non-root keys are distinct for the same intent/source", () => {
    const root = variantKeyForPath("c", "/", "brand", "direct");
    const start = variantKeyForPath("c", "/start", "brand", "direct");
    expect(root).not.toBe(start);
  });
});
