import type { Manifest } from "@rawuser/shared/types";
import { describe, expect, it } from "vitest";
import { forVisitors } from "../src/visitor-manifest.ts";

describe("forVisitors", () => {
  it("drops the wrap measurement and keeps everything the snippet reads", () => {
    const manifest = {
      "hero.headline": {
        css: ["h1"],
        text: ["Hello"],
        structural: "h1",
        original_char_length: 5,
        inline: { icons: "none", emphasis: 0, split: false, animated_text: false },
        metrics: { v: 1, kind: "plain", chars: { a: 50 }, widths: [] },
      },
    } as unknown as Manifest;
    const out = forVisitors(manifest);
    expect(out["hero.headline"]?.metrics).toBeUndefined();
    expect(out["hero.headline"]?.css).toEqual(["h1"]);
    expect(out["hero.headline"]?.inline?.split).toBe(false);
    // The stored manifest is not touched.
    expect(manifest["hero.headline"]?.metrics).toBeDefined();
  });

  it("drops a button's rewrite switch: an operator setting a browser does not need", () => {
    // As a bundle from the generation worker live today (`719cffa6`) holds it.
    const manifest = {
      "hero.headline": { css: ["h1"], text: [], structural: "h1" },
      "cta.cta.label": { css: ["a.cta"], text: ["Start"], structural: "a.cta", rewrite: true },
    } as unknown as Manifest;
    const out = forVisitors(manifest);
    expect(out["cta.cta.label"]).toEqual({ css: ["a.cta"], text: ["Start"], structural: "a.cta" });
    expect(JSON.stringify(out)).not.toContain("rewrite");
    // It removes fields, never parts: both parts are still there.
    expect(Object.keys(out)).toEqual(["hero.headline", "cta.cta.label"]);
    expect(manifest["cta.cta.label"]?.rewrite).toBe(true);
  });
});
