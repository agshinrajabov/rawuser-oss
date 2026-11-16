import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

function dom() {
  const d = new JSDOM("<!doctype html><html><body><main><h1>a</h1></main></body></html>", {
    url: "https://lumera.test/?utm_source=linkedin",
  });
  vi.stubGlobal("window", d.window);
  vi.stubGlobal("document", d.window.document);
  vi.stubGlobal("location", d.window.location);
  vi.stubGlobal("history", d.window.history);
  vi.stubGlobal("MutationObserver", d.window.MutationObserver);
  return d;
}

describe("watchNavigation", () => {
  it("reports pushState, replaceState and popstate path changes, ignores same-path and query-only changes", async () => {
    const d = dom();
    const { watchNavigation } = await import("../src/spa.ts");
    const seen: string[] = [];
    watchNavigation((p) => seen.push(p));
    d.window.history.pushState({}, "", "/az");
    d.window.history.pushState({}, "", "/az?x=1");
    d.window.history.replaceState({}, "", "/AZ/");
    d.window.history.pushState({}, "", "/pricing");
    d.window.history.back?.();
    expect(seen).toEqual(["/az", "/pricing"]);
  });
});

describe("afterRender", () => {
  it("resolves after the first mutation batch, or after the cap", async () => {
    vi.useFakeTimers();
    const d = dom();
    const { afterRender } = await import("../src/spa.ts");
    const p = afterRender(400, 10);
    d.window.document.body.appendChild(d.window.document.createElement("p"));
    await vi.advanceTimersByTimeAsync(20);
    await expect(p).resolves.toBeUndefined();
    const q = afterRender(50, 0);
    await vi.advanceTimersByTimeAsync(60);
    await expect(q).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
