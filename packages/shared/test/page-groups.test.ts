/**
 * The pattern rules of docs/specs/page-groups.md, phase 1: what a pattern
 * is, the match (one segment more, `:id`, never the fixed part, a deeper
 * path or a longer sibling), and the group's count page.
 */
import { describe, expect, it } from "vitest";
import {
  GROUP_PATTERN_REFUSAL,
  MAX_PAGE_GROUPS,
  countPageIsGroup,
  groupFixedPart,
  isPageGroupPattern,
  pageGroupMatches,
  pageGroupOf,
  validGroupSegment,
  validPageGroupPattern,
} from "../src/page-groups.ts";
import { countTargetPage, countTargetPath } from "../src/pick.ts";

describe("validPageGroupPattern", () => {
  it("accepts one or two fixed segments and one * last", () => {
    expect(validPageGroupPattern("/products/*")).toBe("/products/*");
    expect(validPageGroupPattern("/shop/items/*")).toBe("/shop/items/*");
  });

  it("normalizes case and a trailing slash", () => {
    expect(validPageGroupPattern("/Products/*")).toBe("/products/*");
    expect(validPageGroupPattern("/products/*/")).toBe("/products/*");
  });

  it("refuses /* alone and three fixed segments", () => {
    expect(validPageGroupPattern("/*")).toBeNull();
    expect(validPageGroupPattern("/a/b/c/*")).toBeNull();
  });

  it("refuses a pattern without * last or with * elsewhere", () => {
    expect(validPageGroupPattern("/products")).toBeNull();
    expect(validPageGroupPattern("/products/")).toBeNull();
    expect(validPageGroupPattern("/*/products")).toBeNull();
    expect(validPageGroupPattern("/products/*/*")).toBeNull();
    expect(validPageGroupPattern("/products/x*")).toBeNull();
  });

  it("refuses :id, :item and any colon segment (privacy review condition 6)", () => {
    expect(validPageGroupPattern("/:id/*")).toBeNull();
    expect(validPageGroupPattern("/:item/*")).toBeNull();
    expect(validPageGroupPattern("/products/:id/*")).toBeNull();
  });

  it("refuses a fixed segment that holds an identifier", () => {
    expect(validPageGroupPattern("/482/*")).toBeNull();
    expect(validPageGroupPattern("/users/a@b.c/*")).toBeNull();
    expect(validPageGroupPattern("/8f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f/*")).toBeNull();
    expect(validPageGroupPattern("/aB3dE5fG7hI9jK1lM3nO5p/*")).toBeNull();
  });

  it("refuses a query, fragment, whitespace, dot segments and non-strings", () => {
    expect(validPageGroupPattern("/products/*?x=1")).toBeNull();
    expect(validPageGroupPattern("/products/*#a")).toBeNull();
    expect(validPageGroupPattern("/pro ducts/*")).toBeNull();
    expect(validPageGroupPattern("/../*")).toBeNull();
    expect(validPageGroupPattern("//*")).toBeNull();
    expect(validPageGroupPattern("products/*")).toBeNull();
    expect(validPageGroupPattern(null)).toBeNull();
    expect(validPageGroupPattern(42)).toBeNull();
    expect(validPageGroupPattern(`/${"a".repeat(200)}/*`)).toBeNull();
  });

  it("the refusal line is one plain line without a dash", () => {
    expect(GROUP_PATTERN_REFUSAL).not.toMatch(/[–—\n]/);
    expect(MAX_PAGE_GROUPS).toBe(5);
  });

  it("validGroupSegment and isPageGroupPattern agree with the validator", () => {
    expect(validGroupSegment("products")).toBe(true);
    expect(validGroupSegment("*")).toBe(false);
    expect(validGroupSegment(":item")).toBe(false);
    expect(isPageGroupPattern("/products/*")).toBe(true);
    expect(isPageGroupPattern("/Products/*")).toBe(false);
    expect(isPageGroupPattern("/products")).toBe(false);
  });
});

describe("groupFixedPart and countPageIsGroup", () => {
  it("gives the fixed part", () => {
    expect(groupFixedPart("/products/*")).toBe("/products");
    expect(groupFixedPart("/shop/items/*")).toBe("/shop/items");
    expect(groupFixedPart("/products")).toBe("/products");
  });

  it("tells a group's count page from a single page's", () => {
    expect(countPageIsGroup(countTargetPage(countTargetPath("/products/*")))).toBe(true);
    expect(countPageIsGroup("/products/ginseng")).toBe(false);
    expect(countPageIsGroup("/*")).toBe(false);
    expect(countPageIsGroup(null)).toBe(false);
  });
});

describe("pageGroupMatches", () => {
  it("matches a path with exactly one segment more, :id too", () => {
    expect(pageGroupMatches("/products/*", "/products/ginseng")).toBe(true);
    expect(pageGroupMatches("/products/*", "/products/:id")).toBe(true);
    expect(pageGroupMatches("/products/*", "/Products/Ginseng/")).toBe(true);
    expect(pageGroupMatches("/shop/items/*", "/shop/items/x")).toBe(true);
  });

  it("never matches the fixed part, a deeper path, a sibling or the root", () => {
    expect(pageGroupMatches("/products/*", "/products")).toBe(false);
    expect(pageGroupMatches("/products/*", "/products/x/reviews")).toBe(false);
    expect(pageGroupMatches("/products/*", "/productsale")).toBe(false);
    expect(pageGroupMatches("/products/*", "/")).toBe(false);
    expect(pageGroupMatches("/shop/items/*", "/shop/x")).toBe(false);
  });

  it("an invalid pattern matches nothing", () => {
    expect(pageGroupMatches("/*", "/x")).toBe(false);
    expect(pageGroupMatches("/products", "/products/x")).toBe(false);
  });

  it("pageGroupOf finds the one group of a path", () => {
    const groups = ["/products/*", "/blog/*", "/shop/items/*"];
    expect(pageGroupOf(groups, "/blog/post")).toBe("/blog/*");
    expect(pageGroupOf(groups, "/shop/items/a")).toBe("/shop/items/*");
    expect(pageGroupOf(groups, "/shop/a")).toBeNull();
    expect(pageGroupOf([], "/products/a")).toBeNull();
  });
});
