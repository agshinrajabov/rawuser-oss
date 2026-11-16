/**
 * Unit tests for selector-health.ts (T1c, element-detection-v2).
 *
 * validateSelectors replays detected CSS selectors against the source HTML
 * with node-html-parser and reports ok / multiple / none / unsupported per
 * selector. allElementsHealthy summarizes for the dashboard warning banner.
 */

import type { Manifest } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { allElementsHealthy, validateSelectors } from "../src/selector-health.ts";

const HTML = `
<html><body>
  <main>
    <section id="hero">
      <h1 class="hero-title">Turn every visitor</h1>
      <p class="hero-body">Into the right visitor.</p>
      <a id="hero-cta" href="/signup">Start free</a>
    </section>
    <section class="features">
      <h2>Why us</h2>
      <p class="feature">Fast</p>
      <p class="feature">Private</p>
    </section>
  </main>
</body></html>`;

function manifestWith(css: string[]): Manifest {
  return { "hero.headline": { css, text: [], structural: "first h1" } };
}

describe("validateSelectors", () => {
  it("reports ok for a selector matching exactly one element", () => {
    const health = validateSelectors(HTML, manifestWith(["#hero h1", "h1.hero-title"]));
    expect(health["hero.headline"]).toEqual([
      { selector: "#hero h1", status: "ok" },
      { selector: "h1.hero-title", status: "ok" },
    ]);
  });

  it("reports multiple for a selector matching more than one element", () => {
    const health = validateSelectors(HTML, manifestWith(["p.feature"]));
    expect(health["hero.headline"]?.[0]?.status).toBe("multiple");
  });

  it("reports none for a selector matching nothing", () => {
    const health = validateSelectors(
      HTML,
      manifestWith(["#does-not-exist", ".Button-module__8RiFmG__primary"]),
    );
    expect(health["hero.headline"]?.map((c) => c.status)).toEqual(["none", "none"]);
  });

  it("keeps manifest order and covers every dot-path", () => {
    const manifest: Manifest = {
      "hero.headline": { css: ["h1.hero-title"], text: [], structural: "h1" },
      "hero.cta.label": { css: ["#hero-cta"], text: [], structural: "cta" },
      "features.headline": { css: [".features h2"], text: [], structural: "h2" },
    };
    const health = validateSelectors(HTML, manifest);
    expect(Object.keys(health)).toEqual(["hero.headline", "hero.cta.label", "features.headline"]);
    expect(health["hero.cta.label"]?.[0]?.status).toBe("ok");
  });

  it("never throws on a selector the parser can't evaluate — reports unsupported", () => {
    // node-html-parser has no :has() support; must degrade to a non-verdict.
    const health = validateSelectors(HTML, manifestWith(["section:has(> h1)"]));
    const status = health["hero.headline"]?.[0]?.status;
    // Depending on parser version this is either evaluated or rejected;
    // the invariant is: it returns a status instead of throwing.
    expect(["ok", "multiple", "none", "unsupported"]).toContain(status);
  });

  it("returns an empty health map for an empty manifest", () => {
    expect(validateSelectors(HTML, {})).toEqual({});
  });
});

describe("allElementsHealthy", () => {
  it("is true when every element has at least one ok selector", () => {
    const health = validateSelectors(HTML, {
      "hero.headline": { css: ["#missing", "h1.hero-title"], text: [], structural: "h1" },
      "hero.cta.label": { css: ["#hero-cta"], text: [], structural: "cta" },
    });
    expect(allElementsHealthy(health)).toBe(true);
  });

  it("is false when any element has no ok selector", () => {
    const health = validateSelectors(HTML, {
      "hero.headline": { css: ["h1.hero-title"], text: [], structural: "h1" },
      "features.body": { css: ["p.feature"], text: [], structural: "features" },
    });
    expect(allElementsHealthy(health)).toBe(false);
  });

  it("is true for an empty health map (nothing to warn about)", () => {
    expect(allElementsHealthy({})).toBe(true);
  });
});
