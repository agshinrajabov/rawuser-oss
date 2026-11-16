/**
 * The two-part tag (docs/specs/faster-tag.md step 6): the site pastes
 * `<style data-rawuser-pre>` (preHideStyle, @rawuser/shared) above our tag
 * loaded `async`. The page paints at once; the parts stay hidden by the
 * pasted style until the boot takes them over with its own hide style and
 * disables the paste, in one task. A part already in the page counts as not
 * seen only when the paste comes before it and holds it hidden now; any other
 * part in the page makes the load late (as built, `lp`), as a late tag is.
 *
 * The boot's file only (pre.ts). Every test here boots one of the two files
 * explicitly, so both vitest projects run the same paths:
 * - the boot (`./split-entry.ts`: the boot, then the core through the handoff);
 * - the single file (`../src/./index.ts`, which the split alias does not catch).
 *
 * Nothing new is stored or sent: the last block compares a two-part load
 * with a sync tag's, request by request and key by key.
 */
import { preHideStyle } from "@rawuser/shared";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EDGE = "https://edge.test";
const RULES = { "/": ["h1.hero", "p.lead"] };
const HTML = `<section class="hero"><h1 class="hero">Old headline</h1><p class="lead">Old body</p></section>`;
const TAG = `<script async src="${EDGE}/s/acme.js"></script>`;
const pre = (rules: Record<string, string[]> = RULES) =>
  `<style data-rawuser-pre>${preHideStyle(rules)}</style>`;

const sections = { hero: { kind: "hero", headline: "New headline", body: "New body" } };
const part = (css: string) => ({ css: [css], text: [], structural: "" });
const treat = {
  source: "kv",
  cohort: "personalized",
  arm: "treat",
  body_id: "0123456789abcdef",
  variant_key: "v1:variant:acme:problem:ai",
  selection: { intent_dim: "problem", source_dim: "ai", confidence: 0.8 },
  variant: {
    customer_id: "acme",
    profile_key: "intent:problem",
    sections,
    generated_at: 0,
    prompt_hash: "h",
  },
  targets: { "hero.headline": part("h1.hero"), "hero.body": part("p.lead") },
  carryable: true,
  conversion_targets: [],
};

interface Sent {
  url: string;
  body: Record<string, unknown> | null;
}
let tab: Map<string, string>;
let sent: Sent[];
let paint: unknown[];

interface PageOpts {
  url?: string;
  /** What sits in the head before our tag: the paste by default. */
  head?: string;
  /** The body, the paste moved into it in one test. */
  html?: string;
  /** Our tag as the site wrote it: async by default, `sync` first in head. */
  sync?: boolean;
  cfg?: Record<string, unknown>;
  name?: string;
}

/** One page: a new document and a new copy of the snippet. */
function page(o: PageOpts = {}) {
  vi.resetModules();
  const tag = o.sync ? `<script src="${EDGE}/s/acme.js"></script>` : TAG;
  const dom = new JSDOM(
    `<!doctype html><html><head>${o.head ?? pre()}${tag}</head><body>${o.html ?? HTML}</body></html>`,
    { url: o.url ?? "https://site.test/?utm_source=chatgpt.com" },
  );
  const w = dom.window;
  const doc = w.document;
  if (o.name) w.name = o.name;
  // A sync tag first in head runs while the page parses and before any
  // paint; an async one here after the page parsed and painted.
  Object.defineProperty(doc, "readyState", {
    value: o.sync ? "loading" : "complete",
    configurable: true,
  });
  paint = o.sync ? [] : [{ name: "first-contentful-paint", startTime: 80, duration: 0 }];
  Object.defineProperty(doc, "currentScript", {
    value: doc.querySelector(`script[src="${EDGE}/s/acme.js"]`),
    configurable: true,
  });
  vi.stubGlobal("window", w);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", w.location);
  vi.stubGlobal("history", w.history);
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => tab.get(k) ?? null,
    setItem: (k: string, v: string) => tab.set(k, v),
    removeItem: (k: string) => tab.delete(k),
  });
  vi.stubGlobal("navigator", { language: "en", sendBeacon: undefined });
  vi.stubGlobal("MutationObserver", w.MutationObserver);
  vi.stubGlobal("Element", w.Element);
  vi.stubGlobal("Node", w.Node);
  vi.stubGlobal("HTMLElement", w.HTMLElement);
  vi.stubGlobal("HTMLAnchorElement", w.HTMLAnchorElement);
  vi.stubGlobal("HTMLButtonElement", w.HTMLButtonElement);
  vi.stubGlobal("getComputedStyle", w.getComputedStyle.bind(w));
  vi.stubGlobal("PerformanceObserver", undefined);
  const real = performance;
  vi.stubGlobal("performance", {
    now: () => real.now(),
    getEntriesByType: (t: string) => (t === "paint" ? paint : real.getEntriesByType(t)),
  });
  (w as unknown as { __rw: unknown }).__rw = { c: "acme", e: EDGE, h: RULES, p: ["/"], ...o.cfg };
  vi.stubGlobal("fetch", (u: string, init?: RequestInit) => {
    sent.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (u.startsWith(`${EDGE}/select`))
      return new Promise<Response>((r) =>
        setTimeout(() => r(new Response(JSON.stringify(treat), { status: 200 })), 200),
      );
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return doc;
}

/** The customer's tag as the edge serves it today: the boot, then the core. */
const bootTag = () => import("./split-entry.ts");
/** The single file (`/snippet.js`; since E1 no per-customer script is it). */
const singleFile = () => import("../src/./index.ts");

const pastes = () => [...document.querySelectorAll<HTMLStyleElement>("style[data-rawuser-pre]")];
/** jsdom has no `disabled` on a style element: the test reads the property the boot sets. */
const disabled = (s: HTMLStyleElement | undefined) =>
  (s as { disabled?: boolean } | undefined)?.disabled === true;
/**
 * When the boot disables the paste, is our own hide style already in? Both
 * must happen in one task, ours first: no frame between them.
 */
function watchDisable(): { oursFirst: boolean | null } {
  const seen = { oursFirst: null as boolean | null };
  for (const s of pastes()) {
    let v = false;
    Object.defineProperty(s, "disabled", {
      configurable: true,
      get: () => v,
      set: (x: boolean) => {
        if (x && seen.oursFirst === null)
          seen.oursFirst = document.getElementById("__rawuser-hide") !== null;
        v = x;
      },
    });
  }
  return seen;
}
const events = (type: string) => sent.filter((s) => s.body?.event_type === type);
const selects = () => sent.filter((s) => s.url.startsWith(`${EDGE}/select`));
const text = (sel: string) => document.querySelector(sel)?.textContent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  tab = new Map();
  sent = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a paste above the parts and an async tag after the paint", () => {
  it("the boot takes the parts over, disables the paste in the same task, and writes", async () => {
    page();
    const seen = watchDisable();
    await bootTag();
    // Our hide style went in before the paste was disabled, in one task.
    expect(seen.oursFirst).toBe(true);
    expect(disabled(pastes()[0])).toBe(true);
    // Disabled, never removed: on a React site the node is the site's own.
    expect(pastes()).toHaveLength(1);
    expect(document.getElementById("__rawuser-hide")).not.toBeNull();
    expect(text("h1")).toBe("Old headline");
    await vi.advanceTimersByTimeAsync(5000);
    expect(text("h1")).toBe("New headline");
    expect(text("p")).toBe("New body");
    const shown = events("variant_shown");
    expect(shown).toHaveLength(1);
    expect(shown[0]?.body?.lp).toBeUndefined();
    expect(events("personalization_skipped")).toHaveLength(0);
    expect(document.getElementById("__rawuser-hide")).toBeNull();
  });

  it("a part not parsed yet needs no paste: our own rules hide it before it comes", async () => {
    // The paste holds the headline; the paragraph is parsed after the boot
    // ran, under our own rules, never painted with its words.
    page({ head: pre({ "/": ["h1.hero"] }) });
    document.querySelector("p.lead")?.remove();
    Object.defineProperty(document, "readyState", { value: "loading", configurable: true });
    await bootTag();
    expect(document.getElementById("__rawuser-hide")).not.toBeNull();
    const p = document.createElement("p");
    p.className = "lead";
    p.textContent = "Old body";
    document.querySelector("section")?.append(p);
    expect(getComputedStyle(p).visibility).toBe("hidden");
    Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(text("h1")).toBe("New headline");
    expect(text("p")).toBe("New body");
    expect(events("variant_shown")[0]?.body?.lp).toBeUndefined();
  });

  it("several pastes (a stale one left beside the new): every one is disabled", async () => {
    page({ head: `${pre({ "/": ["h1.old"] })}${pre()}` });
    await bootTag();
    expect(pastes()).toHaveLength(2);
    expect(pastes().every(disabled)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(text("h1")).toBe("New headline");
  });
});

describe("a part that may have been seen: the page stays as built, as for any late tag", () => {
  const cases: Array<[string, PageOpts]> = [
    // The dashboard's paste predates a part this page now rewrites.
    ["a stale paste that does not cover a part in the page", { head: pre({ "/": ["h1.hero"] }) }],
    // Pasted at the foot of the body: the parts were parsed, and maybe
    // painted, before it.
    ["a paste below the parts", { head: "", html: `${HTML}${pre()}` }],
    // Its backstop has shown the parts already, or the page's own CSS wins.
    [
      "a paste the page's own CSS overrides",
      { head: `${pre()}<style>p.lead{visibility:visible!important}</style>` },
    ],
    // A policy refused the paste: no rules in it.
    ["a paste with no rules in it", { head: "<style data-rawuser-pre></style>" }],
    // No paste: the async tag is late, as before step 6.
    ["no paste at all", { head: "" }],
  ];
  for (const [name, o] of cases) {
    it(name, async () => {
      page(o);
      await bootTag();
      for (const ms of [0, 200, 1500, 5000]) {
        await vi.advanceTimersByTimeAsync(ms);
        expect(document.getElementById("__rawuser-hide")).toBeNull();
        expect(text("h1")).toBe("Old headline");
        expect(text("p")).toBe("Old body");
      }
      expect(pastes().every(disabled)).toBe(true);
      // The edge is still asked (the carry for the next page), once.
      expect(selects()).toHaveLength(1);
      const skipped = events("personalization_skipped");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.body?.kind).toBe("late");
      expect(skipped[0]?.body?.lp).toBe(1);
      expect(events("variant_shown")).toHaveLength(0);
    });
  }
});

describe("every way out of the boot disables the paste", () => {
  const cases: Array<[string, PageOpts]> = [
    ["a deleted customer", { cfg: { off: 1 } }],
    ["an audit's tag off its host", { cfg: { ad: "other.test" } }],
    ["pick mode", { url: "https://site.test/#rawuser_pick=abcdefgh12345678" }],
    ["the picker's measuring frame", { name: "rawuser-measure" }],
    ["no configuration", { cfg: { c: "" } }],
  ];
  for (const [name, o] of cases) {
    it(name, async () => {
      page(o);
      await bootTag();
      expect(pastes().every(disabled)).toBe(true);
      expect(document.getElementById("__rawuser-hide")).toBeNull();
      await vi.advanceTimersByTimeAsync(5000);
      expect(selects()).toHaveLength(0);
      expect(text("h1")).toBe("Old headline");
    });
  }

  it("a page that is not the site's own: nothing hidden, the paste off at once", async () => {
    page({ url: "https://site.test/blog/post?utm_source=chatgpt.com" });
    await bootTag();
    expect(pastes().every(disabled)).toBe(true);
    expect(document.getElementById("__rawuser-hide")).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(text("h1")).toBe("Old headline");
    // Not the site's own: no late_tag, no lp (quiet-swap.md 2b).
    expect(events("personalization_skipped")[0]?.body?.lp).toBeUndefined();
  });

  it("a sync tag first in head with a paste: as a sync tag, the paste disabled", async () => {
    page({ sync: true });
    await bootTag();
    expect(pastes().every(disabled)).toBe(true);
    expect(document.getElementById("__rawuser-hide")).not.toBeNull();
    Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(text("h1")).toBe("New headline");
    expect(events("variant_shown")[0]?.body?.lp).toBeUndefined();
  });
});

describe("the single file knows nothing of the paste (faster-tag.md step 6, edge note)", () => {
  // `/snippet.js` keeps the late-tag rule as it was: an async tag is late
  // and the page stays as built; a paste would stay until its own backstop
  // (PRE_REVEAL_MS). Since E1 the edge serves the boot for every
  // per-customer policy (policies.test.ts), so this file is only
  // `/snippet.js`, the generic tag, which never gets a paste.
  it("an async single file with a paste: late, as built, the paste left to its backstop", async () => {
    page();
    await singleFile();
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.getElementById("__rawuser-hide")).toBeNull();
    expect(text("h1")).toBe("Old headline");
    expect(events("personalization_skipped")[0]?.body?.lp).toBe(1);
    expect(pastes().some(disabled)).toBe(false);
  });
});

describe("nothing new is stored or sent", () => {
  /** One load: what left the page and what the tab kept, the marker and times blanked. */
  async function run(o: PageOpts) {
    tab = new Map();
    sent = [];
    page(o);
    await bootTag();
    if (o.sync)
      Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
    await vi.advanceTimersByTimeAsync(5000);
    // The visit marker and the tab's clock (the fake clock runs on between loads).
    const blank = (s: string) => s.replace(/[0-9a-f]{32}/g, "V").replace(/"t":\d+/g, '"t":T');
    return {
      requests: sent.map((s) => `${blank(s.url)} ${blank(JSON.stringify(s.body))}`),
      kept: [...tab.entries()].map(([k, v]) => `${k}=${blank(v)}`).sort(),
      h1: text("h1"),
    };
  }

  it("a two-part load sends and keeps exactly what a sync tag's load does", async () => {
    const twoPart = await run({});
    const sync = await run({ sync: true, head: "" });
    expect(twoPart.h1).toBe("New headline");
    expect(twoPart).toEqual(sync);
  });
});
