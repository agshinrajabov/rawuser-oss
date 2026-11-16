/**
 * Quiet swap: the hide style covers [data-rawuser] and the page's own
 * selectors, each with a CSS-only 4000 ms reveal; invalid selectors are
 * skipped without breaking the rest.
 */
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

function withDom() {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body><h1 class='hero-title'>x</h1></body></html>",
  );
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  return dom;
}

describe("injectHideStyle", () => {
  it("adds one rule per selector plus the keyframes (invalid selectors are skipped by the browser's insertRule; jsdom does not validate)", async () => {
    withDom();
    const { injectHideStyle } = await import("../src/boot.ts");
    const style = injectHideStyle(["h1.hero-title", "a.btn-primary"]);
    const rules = Array.from(style.sheet?.cssRules ?? []).map((r) => r.cssText);
    expect(rules[0]).toContain("[data-rawuser]");
    expect(rules.some((r) => r.startsWith("@keyframes __rwr"))).toBe(true);
    expect(
      rules.some((r) => r.startsWith("h1.hero-title") && r.includes("visibility: hidden")),
    ).toBe(true);
    expect(rules.some((r) => r.startsWith("a.btn-primary"))).toBe(true);
    expect(rules.filter((r) => r.includes("__rwr 0s 4000ms")).length).toBe(2);
  });

  it("with no selectors hides only [data-rawuser]", async () => {
    withDom();
    const { injectHideStyle } = await import("../src/boot.ts");
    const style = injectHideStyle();
    expect(style.sheet?.cssRules.length).toBe(1);
  });
});
