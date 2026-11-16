/**
 * The answer before the page is parsed (Framer, 2026-10-25, live QA on
 * sample-project-000000.framer.app at the phone profile, 1 of 21 written
 * loads): `/select` answered at 835 ms, the h1 was parsed at 1,097 and
 * hydrated at 3,098, and the snippet wrote at 1,347 because the React check
 * ran once at answer time, before the body held React's marks. React logged
 * 9 recoverable errors. Now the decision waits for every part, or the end of
 * the parse, under the load cap; a React page then waits for hydration as
 * before, a page that is not React writes as soon as its parts are in.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsing } from "./helpers.ts";

const EDGE = "https://edge.test";

let sent: Array<Record<string, unknown>>;
let selectCalls: number;
let selectReply: () => Promise<Response>;

const variant = {
  customer_id: "acme",
  profile_key: "intent:problem",
  sections: { hero: { kind: "hero", headline: "New headline" } },
  generated_at: 0,
  prompt_hash: "h",
};
const personalized = {
  source: "kv",
  cohort: "personalized",
  variant_key: "v1:variant:acme:problem:ai",
  selection: { intent_dim: "problem", source_dim: "ai", confidence: 0.8 },
  variant,
  targets: { "hero.headline": { css: ["h1.hero"], text: [], structural: "" } },
  conversion_targets: [],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Answers after `ms` of fake time. */
const answerAfter = (ms: number) => () =>
  new Promise<Response>((r) => setTimeout(() => r(json(personalized)), ms));

/** The tag first in head, the body not parsed yet. */
function page(head = "") {
  const dom = new JSDOM(`<!doctype html><html><head>${head}</head><body></body></html>`, {
    url: "https://site.test/?utm_source=chatgpt.com",
  });
  const w = dom.window;
  parsing(w.document);
  vi.stubGlobal("window", w);
  vi.stubGlobal("document", w.document);
  vi.stubGlobal("location", w.location);
  vi.stubGlobal("history", w.history);
  vi.stubGlobal("sessionStorage", w.sessionStorage);
  vi.stubGlobal("navigator", { language: "en", sendBeacon: undefined });
  vi.stubGlobal("MutationObserver", w.MutationObserver);
  vi.stubGlobal("Element", w.Element);
  vi.stubGlobal("Node", w.Node);
  vi.stubGlobal("HTMLElement", w.HTMLElement);
  vi.stubGlobal("HTMLAnchorElement", w.HTMLAnchorElement);
  vi.stubGlobal("HTMLButtonElement", w.HTMLButtonElement);
  vi.stubGlobal("getComputedStyle", w.getComputedStyle.bind(w));
  vi.stubGlobal("PerformanceObserver", undefined);
  (w as unknown as { __rw: unknown }).__rw = { c: "acme", e: EDGE, h: { "/": ["h1.hero"] } };
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (url.startsWith(`${EDGE}/select`)) {
      selectCalls++;
      return selectReply();
    }
    if (url.startsWith(`${EDGE}/event`))
      sent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return w;
}

/** The parser reaches the hero: `markup` is appended to the body. */
function parse(markup: string) {
  document.body.insertAdjacentHTML("beforeend", markup);
}
/** DOMContentLoaded: the parse is over. */
function parsed() {
  Object.defineProperty(document, "readyState", { value: "interactive", configurable: true });
}
const hydrate = () => {
  (document.querySelector("h1") as unknown as Record<string, unknown>).__reactFiber$abc = {};
};

const headline = () => document.querySelector("h1")?.textContent;
const hidden = () => document.getElementById("__rawuser-hide") !== null;
const events = (type: string) => sent.filter((e) => e.event_type === type);
const issues = () =>
  events("snippet_issue").flatMap(
    (e) => (e.properties as { issues: Array<Record<string, unknown>> }).issues,
  );
/** Exposure rows: exactly one per load. */
const exposures = () =>
  sent.filter((e) => e.event_type !== "snippet_issue" && e.event_type !== "conversion");

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  sent = [];
  selectCalls = 0;
  selectReply = answerAfter(50);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the answer before the body is parsed", () => {
  it("a page with React's marks in the body: the decision waits for the parts, then for hydration", async () => {
    page();
    await import("../src/index.ts");
    await vi.advanceTimersByTimeAsync(300);
    // The answer is in; the body is not: nothing decided, nothing written.
    parse('<div id="main"><!--$--><h1 class="hero">Old headline</h1><!--/$--></div>');
    await vi.advanceTimersByTimeAsync(1500);
    // Past the load cap (1,500 ms): the hydration wait moved it.
    expect(hidden()).toBe(true);
    expect(headline()).toBe("Old headline");
    parsed();
    await vi.advanceTimersByTimeAsync(200);
    expect(headline()).toBe("Old headline");
    hydrate();
    await vi.advanceTimersByTimeAsync(200);
    expect(headline()).toBe("New headline");
    expect(hidden()).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(selectCalls).toBe(1);
    expect(exposures().map((e) => e.event_type)).toEqual(["variant_shown"]);
    expect(issues()).toEqual([]);
  });

  it("Framer's generator tag in the head: React from the answer on, written after the fiber (the live load)", async () => {
    page('<meta name="generator" content="Framer 3a3e4c7">');
    selectReply = answerAfter(835);
    await import("../src/index.ts");
    await vi.advanceTimersByTimeAsync(1100);
    parse('<div id="main"><h1 class="hero">Old headline</h1></div>');
    await vi.advanceTimersByTimeAsync(1000);
    // 2,100 ms: parsed, not hydrated. The old code wrote here.
    expect(headline()).toBe("Old headline");
    expect(hidden()).toBe(true);
    hydrate();
    await vi.advanceTimersByTimeAsync(200);
    expect(headline()).toBe("New headline");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(selectCalls).toBe(1);
    expect(exposures().map((e) => e.event_type)).toEqual(["variant_shown"]);
    expect(issues()).toEqual([]);
  });

  it("a page that is not React: written as soon as its parts are in, inside the load cap", async () => {
    page();
    await import("../src/index.ts");
    await vi.advanceTimersByTimeAsync(300);
    expect(headline()).toBeUndefined();
    parse('<h1 class="hero">Old headline</h1><p>more of the page</p>');
    await vi.advanceTimersByTimeAsync(100);
    expect(headline()).toBe("New headline");
    expect(hidden()).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(selectCalls).toBe(1);
    expect(exposures().map((e) => e.event_type)).toEqual(["variant_shown"]);
    expect(issues()).toEqual([]);
  });

  it("the parse ends without the part: skipped as missing at the end of the parse, not at the cap", async () => {
    page();
    await import("../src/index.ts");
    await vi.advanceTimersByTimeAsync(300);
    parse("<h2>Another page</h2>");
    await vi.advanceTimersByTimeAsync(200);
    // Still parsing: the decision waits, the hide holds.
    expect(hidden()).toBe(true);
    parsed();
    await vi.advanceTimersByTimeAsync(100);
    expect(hidden()).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(selectCalls).toBe(1);
    expect(exposures().map((e) => e.event_type)).toEqual(["personalization_skipped"]);
    expect(exposures()[0]?.kind).not.toBe("late");
    expect(issues()).toEqual([]);
  });

  it("the parts come after the load cap: the cap reveals, the original stays, late with reveal_cap 1", async () => {
    page();
    await import("../src/index.ts");
    await vi.advanceTimersByTimeAsync(1600);
    expect(hidden()).toBe(false);
    parse('<!--$--><h1 class="hero">Old headline</h1><!--/$-->');
    parsed();
    hydrate();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(headline()).toBe("Old headline");
    expect(selectCalls).toBe(1);
    expect(exposures().map((e) => e.event_type)).toEqual(["personalization_skipped"]);
    expect(exposures()[0]?.kind).toBe("late");
    expect(issues()).toEqual([{ c: "reveal_cap", n: 1 }]);
  });

  it("React, parsed in time, never hydrated: the hydration cap reveals the original (2,500 ms after the answer)", async () => {
    page('<meta name="generator" content="Framer 3a3e4c7">');
    await import("../src/index.ts");
    await vi.advanceTimersByTimeAsync(300);
    parse('<div id="main"><h1 class="hero">Old headline</h1></div>');
    parsed();
    await vi.advanceTimersByTimeAsync(2100);
    // 2,400 ms: the answer came at 50, the cap is at 2,550.
    expect(hidden()).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(hidden()).toBe(false);
    hydrate();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(headline()).toBe("Old headline");
    expect(selectCalls).toBe(1);
    expect(exposures()[0]?.kind).toBe("late");
    expect(issues()).toEqual([{ c: "reveal_cap", n: 3 }]);
  });
});
