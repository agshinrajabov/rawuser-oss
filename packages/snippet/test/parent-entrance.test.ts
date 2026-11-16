/**
 * An entrance on a parent that ended while its parts were hidden
 * (docs/specs/pilot-gaps.md, A12; docs/specs/quiet-swap.md).
 *
 * the pilot's site, 2026-10-12: `.hero-content` fades in over 1 s (`fadeInUp`).
 * When /select took 943 ms or the cap fired, the fade was over and the
 * headline and the paragraph appeared at once, after the button (not
 * hidden) had faded in with the block.
 *
 * The parts we held come in with a short fade of their own. The block's
 * animation is never started again, a part whose own entrance was started
 * again gets no second one, a load where nothing was hidden gets nothing,
 * and a visitor who asked for less motion gets nothing.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EDGE = "https://edge.test";
const HTML = `<section class="hero-content"><div class="copy"><h1 class="hero">Old headline</h1><p class="lead">Old body</p></div><a class="btn" href="/products">Our products</a></section>`;

const part = (css: string) => ({ css: [css], text: [], structural: "" });
const personalized = {
  source: "kv",
  cohort: "personalized",
  variant_key: "v1:variant:acme:problem:ai",
  selection: { intent_dim: "problem", source_dim: "ai", confidence: 0.8 },
  variant: {
    customer_id: "acme",
    profile_key: "intent:problem",
    sections: { hero: { kind: "hero", headline: "New headline", body: "New body" } },
    generated_at: 0,
    prompt_hash: "h",
  },
  targets: { "hero.headline": part("h1.hero"), "hero.body": part("p.lead") },
};

interface FakeAnimation {
  playState: string;
  currentTime: number;
}

/** What the browser would say: each element's animations, and its `animation-name`. */
let animations: Map<Element, FakeAnimation[]>;
let names: Map<Element, string>;
/** Every `element.animate()` the snippet made. */
let faded: Array<{ el: Element; keyframes: unknown; timing: unknown }>;
let reduced: boolean;
let selectReply: () => Promise<Response>;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
const answerAfter = (ms: number, body: unknown) =>
  new Promise<Response>((r) => setTimeout(() => r(json(body)), ms));

function page(o: { late?: boolean; waapi?: boolean } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${HTML}</body></html>`, {
    url: "https://site.test/?utm_source=chatgpt.com",
  });
  const w = dom.window;
  const doc = w.document;
  Object.defineProperty(doc, "readyState", {
    value: o.late ? "complete" : "loading",
    configurable: true,
  });
  if (o.waapi !== false) {
    // The element's own, or with `subtree` the ones under it too.
    w.Element.prototype.getAnimations = function (this: Element, opts?: { subtree?: boolean }) {
      const own = animations.get(this) ?? [];
      if (!opts?.subtree) return own as unknown as Animation[];
      const under = Array.from(this.querySelectorAll("*")).flatMap((k) => animations.get(k) ?? []);
      return [...own, ...under] as unknown as Animation[];
    };
    w.Element.prototype.animate = function (this: Element, keyframes: unknown, timing: unknown) {
      faded.push({ el: this, keyframes, timing });
      return {} as Animation;
    };
  }
  const computed = w.getComputedStyle.bind(w);
  vi.stubGlobal("window", w);
  vi.stubGlobal("document", doc);
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
  vi.stubGlobal("PerformanceObserver", undefined);
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: /prefers-reduced-motion:\s*reduce/.test(q) && reduced,
  }));
  vi.stubGlobal("getComputedStyle", (el: Element) => {
    const cs = computed(el);
    return new Proxy(cs, {
      get: (t, k) =>
        k === "animationName"
          ? (names.get(el) ?? "none")
          : (t as unknown as Record<string | symbol, unknown>)[k],
    });
  });
  (w as unknown as { __rw: unknown }).__rw = {
    c: "acme",
    e: EDGE,
    h: { "/": ["h1.hero", "p.lead"] },
  };
  vi.stubGlobal("fetch", (u: string) =>
    u.startsWith(`${EDGE}/select`)
      ? selectReply()
      : Promise.resolve(new Response(null, { status: 202 })),
  );
  return w;
}

async function boot(): Promise<void> {
  await import("../src/index.ts");
}

const q = (sel: string) => document.querySelector(sel) as Element;
const hidden = () => document.getElementById("__rawuser-hide") !== null;
const fadedParts = () => faded.map((f) => (f.el as HTMLElement).className).sort();

/** The block's entrance, as the page's stylesheet gives it. */
function blockFades(state: "over" | "over, filled" | "running"): FakeAnimation | undefined {
  names.set(q(".hero-content"), "fadeInUp");
  if (state === "over") return undefined; // no fill: gone from the page's animations
  const a = { playState: state === "running" ? "running" : "finished", currentTime: 400 };
  animations.set(q(".hero-content"), [a]);
  return a;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  animations = new Map();
  names = new Map();
  faded = [];
  reduced = false;
  selectReply = () => answerAfter(1100, personalized);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a parent's entrance that ended while we held its parts", () => {
  it("the parts come in with a short fade of their own, from 0 to their own opacity", async () => {
    page();
    blockFades("over");
    await boot();
    await vi.advanceTimersByTimeAsync(1000);
    expect(hidden()).toBe(true);
    expect(faded).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(hidden()).toBe(false);
    expect(q("h1").textContent).toBe("New headline");
    // The two parts we held, once each; never the button, which was not hidden.
    expect(fadedParts()).toEqual(["hero", "lead"]);
    for (const f of faded) {
      // One keyframe at the start: it ends at the part's own opacity, whatever that is.
      expect(f.keyframes).toEqual([{ opacity: 0, offset: 0 }]);
      expect(f.timing).toBeGreaterThanOrEqual(150);
      expect(f.timing).toBeLessThanOrEqual(200);
    }
  });

  it("an entrance that ended and stays filled is over too", async () => {
    page();
    const a = blockFades("over, filled");
    await boot();
    await vi.advanceTimersByTimeAsync(1200);
    expect(fadedParts()).toEqual(["hero", "lead"]);
    // The block's own animation is never started again: the button, and
    // everything else in the block, stays as the visitor already has it.
    expect(a?.currentTime).toBe(400);
  });

  it("an entrance on a parent further up counts the same", async () => {
    page();
    names.set(document.body, "pageIn");
    await boot();
    await vi.advanceTimersByTimeAsync(1200);
    expect(fadedParts()).toEqual(["hero", "lead"]);
  });

  it("an entrance still running carries the parts with it: no fade of ours", async () => {
    page();
    const a = blockFades("running");
    selectReply = () => answerAfter(300, personalized);
    await boot();
    await vi.advanceTimersByTimeAsync(400);
    expect(hidden()).toBe(false);
    expect(faded).toEqual([]);
    expect(a?.currentTime).toBe(400);
  });

  it("a page with no entrance on any parent: the parts appear as before", async () => {
    page();
    await boot();
    await vi.advanceTimersByTimeAsync(1200);
    expect(hidden()).toBe(false);
    expect(faded).toEqual([]);
  });

  it("a part whose own entrance was started again gets no second one", async () => {
    page();
    blockFades("over");
    const own = { playState: "finished", currentTime: 800 };
    animations.set(q("h1"), [own]);
    await boot();
    await vi.advanceTimersByTimeAsync(1200);
    // The page's own entrance of the headline, from its start.
    expect(own.currentTime).toBe(0);
    // The paragraph has none: it gets ours.
    expect(fadedParts()).toEqual(["lead"]);
  });

  it("a visitor who asked for less motion gets no fade", async () => {
    page();
    blockFades("over");
    reduced = true;
    await boot();
    await vi.advanceTimersByTimeAsync(1200);
    expect(hidden()).toBe(false);
    expect(q("h1").textContent).toBe("New headline");
    expect(faded).toEqual([]);
  });

  it("the cap, or a visit with nothing to write: parts we held and show as built fade in too", async () => {
    page();
    blockFades("over");
    selectReply = () => new Promise(() => {});
    await boot();
    await vi.advanceTimersByTimeAsync(1500);
    expect(hidden()).toBe(false);
    expect(q("h1").textContent).toBe("Old headline");
    expect(fadedParts()).toEqual(["hero", "lead"]);
  });

  it("a load where nothing was hidden replays nothing and fades nothing (a late tag)", async () => {
    page({ late: true });
    const a = blockFades("over, filled");
    const own = { playState: "finished", currentTime: 800 };
    animations.set(q("h1"), [own]);
    selectReply = () => answerAfter(100, personalized);
    await boot();
    await vi.advanceTimersByTimeAsync(5000);
    expect(q("h1").textContent).toBe("Old headline");
    expect(faded).toEqual([]);
    expect(own.currentTime).toBe(800);
    expect(a?.currentTime).toBe(400);
  });

  it("an engine without the Web Animations API: the page is shown and nothing throws", async () => {
    page({ waapi: false });
    blockFades("over");
    await boot();
    await vi.advanceTimersByTimeAsync(1200);
    expect(hidden()).toBe(false);
    expect(q("h1").textContent).toBe("New headline");
  });
});
