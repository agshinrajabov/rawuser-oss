/**
 * The boot and the core in their own files (docs/specs/faster-tag.md step 4,
 * C). The boot (entry-boot.ts) hides the page's parts, asks `/select` and
 * inserts the core; the core (index.ts) takes the pass over through the
 * handoff on its script element. These tests run the boot alone and bring
 * the core in by hand, at the moment each case needs.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsing } from "./helpers.ts";

const EDGE = "https://edge.test";

interface Sent {
  raw: string;
  body: Record<string, unknown>;
}

let sent: Sent[];
let asked: string[];
let selectReply: (signal?: AbortSignal | null) => Promise<Response>;
/** At each `/select`: the core's script was sent for, and whether a core had taken the pass. */
let coreAtSelect: Array<{ sent: boolean; taken: boolean }>;

const variant = {
  customer_id: "acme",
  profile_key: "intent:problem",
  sections: { hero: { kind: "hero", headline: "New headline" } },
  generated_at: 0,
  prompt_hash: "h",
};
const targets = { "hero.headline": { css: ["h1.hero"], text: [], structural: "" } };
const personalized = {
  source: "kv",
  cohort: "personalized",
  variant_key: "v1:variant:acme:problem:ai",
  selection: { intent_dim: "problem", source_dim: "ai", confidence: 0.8 },
  variant,
  targets,
  carryable: true,
  conversion_targets: [],
};
const original = { source: "original", cohort: "no_signal", variant: null };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
const answerAfter = (ms: number, body: unknown) =>
  new Promise<Response>((r) => setTimeout(() => r(json(body)), ms));

interface Opts {
  url?: string;
  nonce?: string;
}

function page(o: Opts = {}) {
  vi.resetModules();
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body><h1 class="hero">Old headline</h1><a class="cta" href="#">Start</a></body></html>`,
    { url: o.url ?? "https://site.test/?utm_source=chatgpt.com" },
  );
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
  if (o.nonce !== undefined) {
    // The tag the page's policy trusts by nonce, as the boot sees itself.
    const tag = w.document.createElement("script");
    tag.nonce = o.nonce;
    Object.defineProperty(w.document, "currentScript", { value: tag, configurable: true });
  }
  (w as unknown as { __rw: unknown }).__rw = { c: "acme", e: EDGE, h: { "/": ["h1.hero"] } };
  vi.stubGlobal("fetch", (u: string, init?: RequestInit) => {
    asked.push(u);
    if (u.startsWith(`${EDGE}/select`)) {
      const handed = (core() as unknown as { __rwh?: { first?: { core: boolean } } } | null)?.__rwh;
      coreAtSelect.push({ sent: !!core(), taken: !!handed?.first?.core });
      return selectReply(init?.signal);
    }
    if (u.startsWith(`${EDGE}/event`)) {
      const raw = String(init?.body ?? "");
      sent.push({ raw, body: JSON.parse(raw) as Record<string, unknown> });
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return w;
}

const core = () => document.querySelector<HTMLScriptElement>('script[src*="/s/_core/"]');
const hide = () => document.getElementById("__rawuser-hide");
const h1 = () => document.querySelector("h1")?.textContent;
const selects = () => asked.filter((u) => u.startsWith(`${EDGE}/select`));
const events = (type: string) => sent.filter((s) => s.body.event_type === type);
const issues = () =>
  events("snippet_issue").flatMap(
    (s) => (s.body.properties as { issues: Array<Record<string, unknown>> }).issues,
  );

async function bootOnly(): Promise<void> {
  await import("../src/entry-boot.ts");
}

/** The core's script runs: `document.currentScript` is the element the boot inserted. */
async function coreArrives(el: HTMLScriptElement | null = core()): Promise<void> {
  Object.defineProperty(document, "currentScript", { value: el, configurable: true });
  try {
    await import("../src/./index.ts");
  } finally {
    Reflect.deleteProperty(document, "currentScript");
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  sent = [];
  asked = [];
  coreAtSelect = [];
  selectReply = () => answerAfter(200, personalized);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the boot alone", () => {
  it("sends for the core, hides the parts and asks /select in one go, with the handoff", async () => {
    page();
    await bootOnly();
    expect(hide()).not.toBeNull();
    expect(hide()?.textContent).toBe("[data-rawuser]{visibility:hidden!important}");
    expect(selects()).toHaveLength(1);
    // The core was sent for first (its download is the longer one), and
    // /select went out long before any core could run.
    expect(coreAtSelect).toEqual([{ sent: true, taken: false }]);
    const s = core();
    expect(s?.src).toBe(`${EDGE}/s/_core/dev.js`);
    expect(s?.getAttribute("fetchpriority")).toBe("high");
    // The same file for every site: the page's address is not sent for it.
    expect(s?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(s?.parentNode).toBe(document.head);
    const handed = (
      s as unknown as { __rwh?: { v: number; c: string; first?: { answer?: unknown } } }
    ).__rwh;
    expect(handed?.v).toBe(1);
    expect(handed?.c).toBe("acme");
    // The pass is in place by the time the core can run (a later task).
    expect(handed?.first?.answer).toBeInstanceOf(Promise);
    // Nothing is written and nothing is sent by the boot.
    expect(h1()).toBe("Old headline");
    await vi.advanceTimersByTimeAsync(300);
    expect(h1()).toBe("Old headline");
    expect(hide()).not.toBeNull();
    expect(sent).toEqual([]);
  });

  it("copies the page's nonce onto the core's script", async () => {
    page({ nonce: "n0nce" });
    await bootOnly();
    expect(core()?.nonce).toBe("n0nce");
  });

  it("a core that cannot load (a blocker, a policy that does not cover it): the page shows at once", async () => {
    page();
    await bootOnly();
    expect(hide()).not.toBeNull();
    core()?.dispatchEvent(new window.Event("error"));
    // At once: no timer advanced.
    expect(hide()).toBeNull();
    expect(h1()).toBe("Old headline");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h1()).toBe("Old headline");
    expect(sent).toEqual([]);
    expect(selects()).toHaveLength(1);
    // The handoff (it holds the visit marker) comes off the element too.
    expect((core() as unknown as { __rwh?: unknown }).__rwh).toBeUndefined();
  });

  it("a Trusted Types policy refuses the core's address: nothing hidden, nothing asked, nothing inserted", async () => {
    page();
    const proto = window.HTMLScriptElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "src");
    Object.defineProperty(proto, "src", {
      configurable: true,
      get: desc?.get,
      set() {
        throw new TypeError("This document requires 'TrustedScriptURL' assignment.");
      },
    });
    try {
      await bootOnly();
    } finally {
      if (desc) Object.defineProperty(proto, "src", desc);
    }
    expect(hide()).toBeNull();
    expect(core()).toBeNull();
    expect(h1()).toBe("Old headline");
    // No answer could be used: none is asked, and the tab keeps nothing new.
    expect(selects()).toHaveLength(0);
    expect(window.sessionStorage.getItem("__rw_visit")).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([]);
  });

  it("an answer that keeps the original shows the page before the core is here", async () => {
    page();
    selectReply = () => answerAfter(100, original);
    await bootOnly();
    await vi.advanceTimersByTimeAsync(100);
    expect(hide()).toBeNull();
    expect(sent).toEqual([]);
    // The core then counts the visit as before.
    await coreArrives();
    await vi.advanceTimersByTimeAsync(5000);
    expect(events("no_signal_passthrough")).toHaveLength(1);
    expect(issues()).toEqual([]);
  });

  it("a failed /select shows the page before the core is here; the core reports it", async () => {
    page();
    selectReply = () => Promise.resolve(new Response("{}", { status: 500 }));
    await bootOnly();
    await vi.advanceTimersByTimeAsync(0);
    expect(hide()).toBeNull();
    await coreArrives();
    await vi.advanceTimersByTimeAsync(5000);
    expect(issues()).toEqual([{ c: "select_failed", n: 3 }]);
    expect(events("variant_shown")).toHaveLength(0);
  });

  it("the holdout shows the page before the core is here", async () => {
    page();
    selectReply = () =>
      answerAfter(50, { ...personalized, source: "holdout", cohort: "holdout", variant: null });
    await bootOnly();
    await vi.advanceTimersByTimeAsync(50);
    expect(hide()).toBeNull();
    await coreArrives();
    await vi.advanceTimersByTimeAsync(5000);
    expect(events("variant_shown")[0]?.body.cohort).toBe("holdout");
  });
});

describe("the core takes the pass over", () => {
  it("a version that arrived before the core waits for it, hidden, and is written by it", async () => {
    page();
    selectReply = () => answerAfter(50, personalized);
    await bootOnly();
    await vi.advanceTimersByTimeAsync(300);
    expect(hide()).not.toBeNull();
    expect(h1()).toBe("Old headline");
    await coreArrives();
    await vi.advanceTimersByTimeAsync(500);
    expect(h1()).toBe("New headline");
    expect(hide()).toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events("variant_shown")).toHaveLength(1);
    // One /select for the load: the core asks nothing again.
    expect(selects()).toHaveLength(1);
    expect(issues()).toEqual([]);
  });

  it("a core already here when the version arrives writes it as the single file does", async () => {
    page();
    await bootOnly();
    await coreArrives();
    expect(h1()).toBe("Old headline");
    await vi.advanceTimersByTimeAsync(200);
    expect(h1()).toBe("New headline");
    expect(hide()).toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events("variant_shown")).toHaveLength(1);
    expect(selects()).toHaveLength(1);
  });

  it("the cap fired before the core came: the original stays, the visit is late, the cap is reported", async () => {
    page();
    selectReply = () => answerAfter(200, personalized);
    await bootOnly();
    await vi.advanceTimersByTimeAsync(1500);
    expect(hide()).toBeNull();
    await coreArrives();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h1()).toBe("Old headline");
    expect(events("variant_shown")).toHaveLength(0);
    expect(events("personalization_skipped")[0]?.body).toMatchObject({ kind: "late" });
    expect(issues()).toEqual([{ c: "reveal_cap", n: 1 }]);
  });

  it("the boot's cap is the core's: one cap, at the same moment, never twice", async () => {
    page();
    selectReply = () => answerAfter(3000, personalized);
    await bootOnly();
    await vi.advanceTimersByTimeAsync(1000);
    await coreArrives();
    await vi.advanceTimersByTimeAsync(499);
    expect(hide()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(hide()).toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h1()).toBe("Old headline");
    expect(issues()).toEqual([{ c: "reveal_cap", n: 1 }]);
  });

  it("a page the boot showed is not written from the tab's copy when the core comes", async () => {
    const w = page({ url: "https://site.test/" });
    const t = Date.now();
    w.sessionStorage.setItem("__rw_carry", JSON.stringify({ i: "problem", s: "ai", t }));
    w.sessionStorage.setItem(
      "__rw_body",
      JSON.stringify({
        i: "problem",
        s: "ai",
        t,
        p: { "/": { sections: variant.sections, targets } },
      }),
    );
    selectReply = () => answerAfter(10, original);
    await bootOnly();
    await vi.advanceTimersByTimeAsync(10);
    expect(hide()).toBeNull();
    await coreArrives();
    // In view already: the copy is never written in front of the visitor.
    expect(h1()).toBe("Old headline");
    await vi.advanceTimersByTimeAsync(5000);
    expect(h1()).toBe("Old headline");
  });

  it("the core writes the tab's copy early when it comes before the answer (a later page)", async () => {
    const w = page({ url: "https://site.test/" });
    const t = Date.now();
    w.sessionStorage.setItem("__rw_carry", JSON.stringify({ i: "problem", s: "ai", t }));
    w.sessionStorage.setItem(
      "__rw_body",
      JSON.stringify({
        i: "problem",
        s: "ai",
        t,
        p: { "/": { sections: variant.sections, targets } },
      }),
    );
    selectReply = () => answerAfter(200, { ...personalized, carried: true });
    await bootOnly();
    await coreArrives();
    // Written as the core comes, behind the hide, before the edge answered.
    expect(h1()).toBe("New headline");
    expect(hide()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events("variant_shown")[0]?.body).toMatchObject({ body_carry: 1, carried: 1 });
  });

  it("a route taken before the core came: the load's pass ends, the route gets its own", async () => {
    page({ url: "https://site.test/" });
    (window as unknown as { __rw: Record<string, unknown> }).__rw = {
      c: "acme",
      e: EDGE,
      h: { "/": ["h1.hero"], "/az": ["h1.hero"] },
    };
    await bootOnly();
    history.pushState(null, "", "/az");
    await coreArrives();
    await vi.advanceTimersByTimeAsync(20_000);
    const paths = selects().map((u) => new URL(u).searchParams.get("path"));
    expect(paths).toEqual(["/", "/az"]);
    expect(events("variant_shown").map((e) => e.body.page_path)).toEqual(["/az"]);
  });

  it("a handoff of another version: the page as built at once, nothing asked again", async () => {
    page();
    await bootOnly();
    const s = core();
    (s as unknown as { __rwh: { v: number } }).__rwh.v = 999;
    await coreArrives(s);
    expect(hide()).toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h1()).toBe("Old headline");
    expect(selects()).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("the handoff is taken off the element once read", async () => {
    page();
    await bootOnly();
    const s = core();
    await coreArrives(s);
    expect((s as unknown as { __rwh?: unknown }).__rwh).toBeUndefined();
  });
});

describe("operator modes", () => {
  it("pick: the boot takes the token out of the address before it inserts the core, and hands it over; the core loads the picker", async () => {
    page({ url: "https://site.test/#rawuser_pick=tok_12345678" });
    let atInsert: string | null = null;
    const append = document.head.appendChild.bind(document.head);
    document.head.appendChild = <T extends Node>(n: T): T => {
      if ((n as unknown as HTMLScriptElement).src?.includes("/s/_core/")) atInsert = location.href;
      return append(n);
    };
    await bootOnly();
    // Before the core module runs: the address holds no token.
    expect(atInsert).toBe("https://site.test/");
    expect(location.href).toBe("https://site.test/");
    expect(location.hash).toBe("");
    expect(hide()).toBeNull();
    expect(selects()).toHaveLength(0);
    const s = core();
    expect(s).not.toBeNull();
    expect((s as unknown as { __rwh?: unknown }).__rwh).toEqual({
      v: 1,
      op: "tok_12345678",
      cap: false,
      e: EDGE,
    });
    await coreArrives(s);
    const picker = document.querySelector<HTMLScriptElement>('script[src$="/picker.js"]');
    expect(picker?.dataset.token).toBe("tok_12345678");
    expect(picker?.dataset.edgeOrigin).toBe(EDGE);
    expect(picker?.dataset.mode).toBeUndefined();
    expect((s as unknown as { __rwh?: unknown }).__rwh).toBeUndefined();
    expect(location.hash).toBe("");
    expect(selects()).toHaveLength(0);
    expect(sent).toEqual([]);
  });

  it("capture: the token leaves the address before the core is inserted; the operator module loads in capture mode", async () => {
    page({ url: "https://site.test/?a=1&rawuser_capture=tok_12345678#x=2" });
    await bootOnly();
    // Before the core module runs: neither parameter, the page's own kept.
    expect(location.href).toBe("https://site.test/?a=1#x=2");
    expect(location.href).not.toContain("rawuser_");
    expect(hide()).toBeNull();
    const s = core();
    expect((s as unknown as { __rwh?: { op?: string; cap?: boolean } }).__rwh).toMatchObject({
      op: "tok_12345678",
      cap: true,
    });
    await coreArrives(s);
    const op = document.querySelector<HTMLScriptElement>('script[src$="/picker.js"]');
    expect(op?.dataset.mode).toBe("capture");
    expect(op?.dataset.token).toBe("tok_12345678");
    expect(location.search).toBe("?a=1");
    expect(selects()).toHaveLength(0);
    expect(sent).toEqual([]);
  });

  it("pick: a core that fails to load takes the token off the element", async () => {
    page({ url: "https://site.test/#rawuser_pick=tok_12345678" });
    await bootOnly();
    expect(location.hash).toBe("");
    const s = core();
    s?.dispatchEvent(new window.Event("error"));
    expect((s as unknown as { __rwh?: unknown }).__rwh).toBeUndefined();
    expect(document.querySelector('script[src$="/picker.js"]')).toBeNull();
    expect(selects()).toHaveLength(0);
  });

  it("no configuration, or a deleted customer: the boot inserts nothing", async () => {
    page();
    (window as unknown as { __rw: Record<string, unknown> }).__rw = { c: "acme", e: EDGE, off: 1 };
    await bootOnly();
    expect(core()).toBeNull();
    expect(hide()).toBeNull();
    expect(selects()).toHaveLength(0);
  });
});
