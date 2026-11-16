import { describe, expect, it } from "vitest";
import { briefLangFor } from "../src/index.ts";

describe("briefLangFor", () => {
  it("reads the path's language from the map, falls back to the root, accepts a bare tag", () => {
    const map = JSON.stringify({ "/": "en", "/az": "az" });
    expect(briefLangFor(map, "/az")).toBe("az");
    expect(briefLangFor(map, "/")).toBe("en");
    expect(briefLangFor(map, "/pricing")).toBe("en");
    expect(briefLangFor('"az"', "/")).toBe("az");
    expect(briefLangFor("en-US", "/")).toBe("en");
    expect(briefLangFor(null, "/")).toBeNull();
    expect(briefLangFor("{broken", "/")).toBeNull();
  });

  // Task F9 (pilot-gaps.md): a pilot site's map is { "/": en, "/approach":
  // en, "/az": az }; `/az/work` read as the root's English.
  it("a path the map does not list takes its longest listed whole-segment prefix", () => {
    const map = JSON.stringify({ "/": "en", "/approach": "en", "/az": "az", "/az/blog": "ru" });
    // Listed paths keep their own answer.
    expect(briefLangFor(map, "/approach")).toBe("en");
    expect(briefLangFor(map, "/az")).toBe("az");
    expect(briefLangFor(map, "/az/blog")).toBe("ru");
    // Unlisted under a listed prefix: the prefix's.
    expect(briefLangFor(map, "/az/work")).toBe("az");
    expect(briefLangFor(map, "/az/work/2026")).toBe("az");
    expect(briefLangFor(map, "/az/blog/post")).toBe("ru");
    expect(briefLangFor(map, "/az/")).toBe("az");
    // Unlisted under no prefix: the root's.
    expect(briefLangFor(map, "/work")).toBe("en");
    expect(briefLangFor(map, "/approach/team")).toBe("en");
    // A near-miss prefix is not a prefix.
    expect(briefLangFor(map, "/azure")).toBe("en");
    expect(briefLangFor(map, "/azure/docs")).toBe("en");
  });

  it("a bare tag from before the map answers the same on every path", () => {
    expect(briefLangFor("az", "/az/work")).toBe("az");
    expect(briefLangFor("az", "/azure")).toBe("az");
    expect(briefLangFor('"en"', "/az/work")).toBe("en");
  });

  it("a map without a root entry answers null off every listed prefix", () => {
    const map = JSON.stringify({ "/az": "az" });
    expect(briefLangFor(map, "/az/work")).toBe("az");
    expect(briefLangFor(map, "/work")).toBeNull();
    expect(briefLangFor(map, "/")).toBeNull();
  });
});
