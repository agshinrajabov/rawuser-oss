/**
 * Path pages keep the carried source (docs/specs/session-carry.md,
 * measure-lab 2026-10-05). The edge answers a page whose only signal is its
 * path with the path's intent, the carried source and `carried: true`; the
 * snippet then leaves the tab's carry as the landing wrote it, so the next
 * page without a signal still carries the landing's source. A fresh answer
 * (a real new source) still replaces it.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsing } from "./helpers.ts";

const EDGE = "https://edge.test";
const sections = { hero: { kind: "hero", headline: "New headline" } };
const targets = { "hero.headline": { css: ["h1.hero"], text: [], structural: "" } };

function answer(intent: string, source: string, carried: boolean) {
  return {
    source: "kv",
    cohort: "personalized",
    variant_key: `v1:variant:acme:${intent}:${source}`,
    selection: { intent_dim: intent, source_dim: source, confidence: 0.7 },
    variant: { customer_id: "acme", profile_key: "x", sections, generated_at: 0, prompt_hash: "h" },
    targets,
    ...(carried ? { carried: true } : {}),
  };
}

let reply: unknown;
let selectUrls: string[];

function page(url: string, referrer: string, seedCarry: { i: string; s: string }) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body><h1 class="hero">Old headline</h1></body></html>`,
    referrer ? { url, referrer } : { url },
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
  (w as unknown as { __rw: unknown }).__rw = { c: "acme", e: EDGE, h: { "/pricing": ["h1.hero"] } };
  w.sessionStorage.setItem(
    "__rw_carry",
    JSON.stringify({ i: seedCarry.i, s: seedCarry.s, t: Date.now() }),
  );
  vi.stubGlobal("fetch", (u: string) => {
    if (u.startsWith(`${EDGE}/select`)) {
      selectUrls.push(u);
      return Promise.resolve(
        new Response(JSON.stringify(reply), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (u.startsWith(`${EDGE}/carry`)) {
      return Promise.resolve(new Response(JSON.stringify({ bodies: {} }), { status: 200 }));
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return w;
}

const carryIn = (w: Window) =>
  JSON.parse(w.sessionStorage.getItem("__rw_carry") ?? "{}") as { i?: string; s?: string };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  selectUrls = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function boot() {
  await import("../src/index.ts");
  await vi.advanceTimersByTimeAsync(5000);
}

describe("a path page after a ChatGPT landing", () => {
  it("offers the carry, writes pricing:ai, and keeps problem:ai in the tab", async () => {
    const w = page("https://site.test/pricing", "https://site.test/", { i: "problem", s: "ai" });
    reply = answer("pricing", "ai", true);
    await boot();
    const sent = new URL(selectUrls[0] ?? "");
    expect(sent.searchParams.get("carry")).toBe("problem:ai");
    expect(sent.searchParams.get("ss")).toBe("1");
    expect(document.querySelector("h1")?.textContent).toBe("New headline");
    expect(carryIn(w as unknown as Window)).toMatchObject({ i: "problem", s: "ai" });
  });

  it("a fresh answer (a real new source) replaces the tab's carry", async () => {
    const w = page("https://site.test/pricing?utm_source=linkedin", "", { i: "problem", s: "ai" });
    reply = answer("pricing", "social", false);
    await boot();
    expect(carryIn(w as unknown as Window)).toMatchObject({ i: "pricing", s: "social" });
  });
});
