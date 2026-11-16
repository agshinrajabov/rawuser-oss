import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PRE_REVEAL_MS,
  hideRulesFromManifests,
  hideRulesKey,
  preHideHash,
  preHideStyle,
  preHideTag,
  richKey,
  richPathsFromManifests,
} from "../src/hide-rules.ts";
import type { ElementTargets } from "../src/types.ts";

describe("hideRulesFromManifests", () => {
  it("collects every css candidate per path, deduped, unsafe ones dropped", () => {
    const rules = hideRulesFromManifests([
      {
        page_path: "/",
        manifest: {
          "hero.headline": { css: ["h1.hero-title", "#hero > h1"], text: [], structural: "x" },
          "hero.cta.label": {
            css: ["a.btn-primary", "h1.hero-title", "bad{}", "a</script>"],
            text: [],
            structural: "x",
          },
        },
      },
      { page_path: "/az", manifest: {} },
    ]);
    expect(rules["/"]).toEqual(["h1.hero-title", "#hero > h1", "a.btn-primary"]);
    expect(rules["/az"]).toBeUndefined();
    expect(hideRulesKey("lumera")).toBe("v1:hide:lumera");
  });
});

describe("richPathsFromManifests", () => {
  const plainPart: ElementTargets = { css: ["p"], text: [], structural: "x" };
  const templatePart: ElementTargets = {
    css: ["h1"],
    text: [],
    structural: "x",
    inline: {
      icons: "none",
      emphasis: 0,
      split: true,
      animated_text: false,
      template: "Ship {g0} faster{br}with {rot:less|fewer} work",
    },
  };
  const linesPart: ElementTargets = {
    css: ["h1"],
    text: [],
    structural: "x",
    inline: { icons: "none", emphasis: 0, split: true, animated_text: false, lines: 3 },
  };

  it("lists the pages with a template or a lines part the snippet writes", () => {
    const paths = richPathsFromManifests([
      { page_path: "/", manifest: { "hero.body": plainPart, "hero.headline": templatePart } },
      { page_path: "/lines", manifest: { "hero.headline": linesPart } },
      { page_path: "/plain", manifest: { "hero.headline": plainPart } },
      { page_path: "/empty", manifest: {} },
    ]);
    expect(paths).toEqual(["/", "/lines"]);
  });

  it("leaves out a rich part the operator skipped or asked for as plain text", () => {
    const paths = richPathsFromManifests([
      { page_path: "/skipped", manifest: { "hero.headline": { ...templatePart, skip: true } } },
      { page_path: "/plain-text", manifest: { "hero.headline": { ...linesPart, plain: true } } },
      {
        page_path: "/mixed",
        manifest: {
          "hero.headline": { ...templatePart, skip: true },
          "features.headline": linesPart,
        },
      },
    ]);
    expect(paths).toEqual(["/mixed"]);
  });

  it("returns nothing when no page has a rich part, and the key is a contract", () => {
    expect(richPathsFromManifests([{ page_path: "/", manifest: { a: plainPart } }])).toEqual([]);
    expect(richPathsFromManifests([])).toEqual([]);
    expect(richKey("lumera")).toBe("v1:rich:lumera");
  });
});

describe("the pasted style of the two-part tag (faster-tag.md step 6)", () => {
  const RULE = "{visibility:hidden;animation:__rwp 0s 1500ms both!important}";
  const KEYFRAMES = "@keyframes __rwp{from{visibility:hidden}to{visibility:visible}}";

  it("every page's selectors once, sorted, after the tagged parts, each its own rule", () => {
    const css = preHideStyle({
      "/pricing": ["section.plans h2", "h1.hero"],
      "/": ["h1.hero", "p.lead"],
    });
    expect(css).toBe(
      `${KEYFRAMES}[data-rawuser]${RULE}h1.hero${RULE}p.lead${RULE}section.plans h2${RULE}`,
    );
    expect(PRE_REVEAL_MS).toBe(1500);
  });

  it("the same set in any order makes the same text, so the hash moves only with the set", () => {
    const a = preHideStyle({ "/": ["b", "a"], "/x": ["c"] });
    const b = preHideStyle({ "/x": ["c", "a"], "/": ["b"] });
    expect(a).toBe(b);
    expect(preHideStyle({ "/": ["a", "b", "c", "d"] })).not.toBe(a);
  });

  it("an unsafe or empty selector never reaches the style, and the tag is never doubled", () => {
    const css = preHideStyle({
      "/": ["  ", "a{}", "b</style><script>", "@import x", "[data-rawuser]"],
    });
    expect(css).toBe(`${KEYFRAMES}[data-rawuser]${RULE}`);
    expect(css).not.toMatch(/<|@import/);
  });

  it("no rules: the tagged parts alone, still a valid style", () => {
    expect(preHideStyle({})).toBe(`${KEYFRAMES}[data-rawuser]${RULE}`);
  });

  it("the HTML part carries the marker the snippet reads and nothing of React's", () => {
    const tag = preHideTag({ "/": ["h1"] });
    expect(tag).toBe(`<style data-rawuser-pre>${preHideStyle({ "/": ["h1"] })}</style>`);
    expect(tag).not.toMatch(/precedence|nonce|id=/);
  });

  it("the CSP hash is sha256 of the exact text, base64, quoted as a source", async () => {
    const css = preHideStyle({ "/": ["section.hero h1"] });
    const want = createHash("sha256").update(css, "utf8").digest("base64");
    expect(await preHideHash(css)).toBe(`'sha256-${want}'`);
    // The boot's own constant style gives the hash install-friction.md pins.
    expect(await preHideHash("[data-rawuser]{visibility:hidden!important}")).toBe(
      "'sha256-uUswyaXbEHXp14LMbwYoLUMHybPzmIVetSQk2E7czKY='",
    );
  });
});
