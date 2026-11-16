/**
 * The visit marker: drawn once per tab, reused while active, expires after
 * thirty idle minutes, ignores junk, absent without crypto or storage.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com/" });
  vi.stubGlobal("sessionStorage", dom.window.sessionStorage);
});
afterEach(() => vi.unstubAllGlobals());

const SHAPE = /^[0-9a-f]{32}$/;

describe("ensureVisit", () => {
  it("draws a 32-hex marker and reuses it while the tab is active", async () => {
    const { ensureVisit } = await import("../src/visit.ts");
    const a = ensureVisit(1_000);
    expect(a).toMatch(SHAPE);
    const b = ensureVisit(1_000 + 29 * 60 * 1000);
    expect(b).toBe(a);
    const stored = JSON.parse(sessionStorage.getItem("__rw_visit") ?? "{}") as { t: number };
    expect(stored.t).toBe(1_000 + 29 * 60 * 1000);
  });

  it("draws a new one after thirty idle minutes", async () => {
    const { ensureVisit } = await import("../src/visit.ts");
    const a = ensureVisit(1_000);
    const b = ensureVisit(1_000 + 31 * 60 * 1000);
    expect(b).toMatch(SHAPE);
    expect(b).not.toBe(a);
  });

  it("replaces a junk value", async () => {
    const { ensureVisit } = await import("../src/visit.ts");
    sessionStorage.setItem("__rw_visit", JSON.stringify({ v: "not-hex", t: 1_000 }));
    expect(ensureVisit(1_000)).toMatch(SHAPE);
    sessionStorage.setItem("__rw_visit", "garbage");
    expect(ensureVisit(1_000)).toMatch(SHAPE);
  });

  it("is null without crypto", async () => {
    const { ensureVisit } = await import("../src/visit.ts");
    vi.stubGlobal("crypto", undefined);
    expect(ensureVisit(1_000)).toBeNull();
  });

  it("still returns a marker when storage throws, without keeping it", async () => {
    const { ensureVisit } = await import("../src/visit.ts");
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const a = ensureVisit(1_000);
    expect(a).toMatch(SHAPE);
    expect(ensureVisit(1_000)).not.toBe(a);
  });

  it("two markers differ", async () => {
    const { ensureVisit } = await import("../src/visit.ts");
    const a = ensureVisit(1_000);
    sessionStorage.clear();
    const b = ensureVisit(1_000);
    expect(a).not.toBe(b);
  });
});
