/**
 * A deleted customer (docs/specs/security-hardening.md §6 condition 1,
 * ai-traffic-audit.md §8 condition 2). The off script (`off: 1` from
 * /s/{id}.js) asks the edge nothing, hides nothing, and removes the tab's
 * visit marker, carry and body copy. An `off: 1` answer from /select (the
 * generic tag, or a script cached from before the delete) does the same
 * after the fact: nothing written, no event, no issue, no later pass.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsing } from "./helpers.ts";

const EDGE = "https://edge.test";
let requests: string[];
let reply: unknown;

function page(cfg: Record<string, unknown>) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body><h1 class="hero">Old headline</h1></body></html>`,
    { url: "https://site.test/" },
  );
  const w = dom.window;
  parsing(w.document);
  for (const [k, v] of [
    ["window", w],
    ["document", w.document],
    ["location", w.location],
    ["history", w.history],
    ["sessionStorage", w.sessionStorage],
    ["navigator", { language: "en", sendBeacon: undefined }],
    ["MutationObserver", w.MutationObserver],
    ["Element", w.Element],
    ["Node", w.Node],
    ["HTMLElement", w.HTMLElement],
    ["HTMLAnchorElement", w.HTMLAnchorElement],
    ["HTMLButtonElement", w.HTMLButtonElement],
    ["getComputedStyle", w.getComputedStyle.bind(w)],
    ["PerformanceObserver", undefined],
  ] as const) {
    vi.stubGlobal(k, v);
  }
  (w as unknown as { __rw: unknown }).__rw = cfg;
  const now = Date.now();
  w.sessionStorage.setItem("__rw_visit", JSON.stringify({ v: "a".repeat(32), t: now }));
  w.sessionStorage.setItem("__rw_carry", JSON.stringify({ i: "problem", s: "ai", t: now }));
  w.sessionStorage.setItem("__rw_body", JSON.stringify({ t: now, p: {} }));
  vi.stubGlobal("fetch", (u: string) => {
    requests.push(u);
    if (u.startsWith(`${EDGE}/select`)) {
      return Promise.resolve(
        new Response(JSON.stringify(reply), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return w;
}

const kept = (w: Window) =>
  ["__rw_visit", "__rw_carry", "__rw_body"].filter((k) => w.sessionStorage.getItem(k) !== null);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  requests = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function boot() {
  await import("../src/index.ts");
  await vi.advanceTimersByTimeAsync(8000);
}

describe("the off script", () => {
  it("asks nothing, hides nothing, and clears the tab's visit, carry and body keys", async () => {
    const w = page({ c: "gone-co", e: EDGE, off: 1 });
    await boot();
    expect(requests).toEqual([]);
    expect(kept(w as unknown as Window)).toEqual([]);
    expect(document.head.querySelector("style")).toBeNull();
    expect(document.querySelector("h1")?.textContent).toBe("Old headline");
    // A later navigation asks nothing either.
    history.pushState({}, "", "/pricing");
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests).toEqual([]);
  });
});

describe("an off answer from /select", () => {
  it("writes nothing, sends no event, clears the tab, and asks no more", async () => {
    const w = page({ c: "gone-co", e: EDGE, h: { "/": ["h1.hero"] } });
    reply = { source: "original", variant_key: "", variant: null, off: 1 };
    await boot();
    expect(requests.filter((u) => u.startsWith(`${EDGE}/select`))).toHaveLength(1);
    expect(requests.filter((u) => u.startsWith(`${EDGE}/event`))).toEqual([]);
    expect(kept(w as unknown as Window)).toEqual([]);
    expect(document.querySelector("h1")?.textContent).toBe("Old headline");
    history.pushState({}, "", "/pricing");
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests.filter((u) => u.startsWith(`${EDGE}/select`))).toHaveLength(1);
    // The page leaves: nothing pending goes out.
    w.dispatchEvent(new w.Event("pagehide"));
    expect(requests.filter((u) => u.startsWith(`${EDGE}/event`))).toEqual([]);
  });

  it("an open customer's no-signal answer still sends its event (control)", async () => {
    page({ c: "acme", e: EDGE, h: {} });
    reply = {
      source: "original",
      variant_key: "",
      variant: null,
      cohort: "no_signal",
      selection: { intent_dim: "none", source_dim: "none", confidence: 0 },
    };
    await boot();
    expect(requests.some((u) => u.startsWith(`${EDGE}/event`))).toBe(true);
  });
});
