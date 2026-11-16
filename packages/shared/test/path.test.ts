import { describe, expect, it } from "vitest";
import { normalizePath } from "../src/path.ts";

describe("normalizePath", () => {
  it("returns '/' for empty / nullish input", () => {
    expect(normalizePath("")).toBe("/");
    expect(normalizePath(null)).toBe("/");
    expect(normalizePath(undefined)).toBe("/");
  });

  it("keeps root as '/'", () => {
    expect(normalizePath("/")).toBe("/");
  });

  it("lowercases", () => {
    expect(normalizePath("/Start")).toBe("/start");
    expect(normalizePath("/Courses/UX-UI")).toBe("/courses/ux-ui");
  });

  it("strips trailing slash except root", () => {
    expect(normalizePath("/start/")).toBe("/start");
    expect(normalizePath("/a/b/")).toBe("/a/b");
    expect(normalizePath("/")).toBe("/");
  });

  it("drops query string", () => {
    expect(normalizePath("/start?utm_campaign=x")).toBe("/start");
    expect(normalizePath("/?token=secret")).toBe("/");
  });

  it("drops fragment", () => {
    expect(normalizePath("/start#enroll")).toBe("/start");
    expect(normalizePath("/page#frag?notquery")).toBe("/page");
  });

  it("drops fragment before query when both present", () => {
    // '#' appears before '?' in the raw string
    expect(normalizePath("/p#a?b")).toBe("/p");
    // '?' appears before '#'
    expect(normalizePath("/p?a#b")).toBe("/p");
  });

  it("collapses repeated slashes", () => {
    expect(normalizePath("//start")).toBe("/start");
    expect(normalizePath("/a//b///c")).toBe("/a/b/c");
  });

  it("adds a leading slash when missing", () => {
    expect(normalizePath("start")).toBe("/start");
  });

  it("is idempotent", () => {
    const inputs = ["/Start/", "//a//b/", "/x?y#z", "page", "/"];
    for (const i of inputs) {
      const once = normalizePath(i);
      expect(normalizePath(once)).toBe(once);
    }
  });

  it("snippet and edge agree on the canonical lumera paths", () => {
    // The two paths that matter for a pilot site's /start fix.
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/start")).toBe("/start");
    expect(normalizePath("/start/")).toBe("/start");
    expect(normalizePath("/START?utm_source=fb")).toBe("/start");
  });
});
