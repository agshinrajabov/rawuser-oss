/**
 * The bundle's `g` (docs/specs/page-groups.md, Data): the accepted
 * patterns, sorted, absent when there are none, so a customer without
 * groups has the bundle it had, byte for byte.
 */
import { describe, expect, it } from "vitest";
import { BUNDLE_GROUPS_SQL, bundleGroups, visitorBundleFrom } from "../src/visitor-bundle.ts";

const MANIFESTS = [
  {
    page_path: "/",
    manifest: { "hero.headline": { css: ["h1"], text: ["Hi"], structural: "first h1" } },
  },
];
const CONV = [
  {
    section_path: "count:/products/*",
    conversion_label: "contact",
    css_selectors: '["nav a.contact"]',
    text_selectors: '["Contact"]',
    structural_selector: "first a in nav",
  },
];

describe("bundleGroups", () => {
  it("is null for none, and keeps only valid patterns, each once, sorted", () => {
    expect(bundleGroups(null)).toBeNull();
    expect(bundleGroups([])).toBeNull();
    expect(bundleGroups(["/x", "/*"])).toBeNull();
    expect(bundleGroups(["/products/*", "/blog/*", "/products/*", "/bad"])).toEqual([
      "/blog/*",
      "/products/*",
    ]);
  });

  it("the shared read is the page_groups table of one customer", () => {
    expect(BUNDLE_GROUPS_SQL).toMatch(/^SELECT pattern FROM page_groups WHERE customer_id = \?/);
  });
});

describe("visitorBundleFrom with groups", () => {
  it("carries g sorted, after every other field", () => {
    const b = visitorBundleFrom(MANIFESTS, CONV, 20, null, null, ["/products/*", "/blog/*"]);
    expect(b.g).toEqual(["/blog/*", "/products/*"]);
    expect(Object.keys(b)).toEqual(["v", "pages", "conv", "h", "g"]);
    // The target itself still rides in conv, as any count target does.
    expect(b.conv[0]?.section_path).toBe("count:/products/*");
  });

  it("a customer without groups has the bundle it had, byte for byte", () => {
    const before = JSON.stringify(visitorBundleFrom(MANIFESTS, CONV, 20));
    expect(JSON.stringify(visitorBundleFrom(MANIFESTS, CONV, 20, null, null, null))).toBe(before);
    expect(JSON.stringify(visitorBundleFrom(MANIFESTS, CONV, 20, null, null, []))).toBe(before);
    expect(before).not.toContain('"g"');
  });
});
