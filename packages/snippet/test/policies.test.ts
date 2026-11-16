/**
 * Every per-customer script is the boot (docs/specs/faster-tag.md step 6,
 * E1): the off script, an audit's, one before go live and one without a read
 * bundle were the single file until then, and the single file treats an
 * `async` tag as late and never disables a pasted `<style data-rawuser-pre>`,
 * so a page with the paste kept its parts hidden to the paste's 1.5 s
 * backstop. The configurations here are the edge's own lines for those
 * policies (packages/edge/test/core-script.test.ts pins them).
 *
 * Two promises:
 * - without a paste, the boot does what the single file did for each of
 *   them: the same requests, the same tab keys, the same page at every
 *   moment (only the delivery differs: the boot loads the core when it
 *   passes the page);
 * - with a paste and an `async` tag, no part stays hidden longer than
 *   today's rules allow (the boot's cap, or nothing when the boot leaves the
 *   page alone), the paste is disabled in the boot's own task, and a page we
 *   write nothing on shows as built.
 */
import { preHideStyle } from "@rawuser/shared";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EDGE = "https://edge.test";
const RULES = { "/": ["h1.hero", "p.lead"] };
const HTML = `<section class="hero"><h1 class="hero">Old headline</h1><p class="lead">Old body</p></section>`;
const PASTE = `<style data-rawuser-pre>${preHideStyle(RULES)}</style>`;
const DAY = 24 * 3600 * 1000;

const part = (css: string) => ({ css: [css], text: [], structural: "" });
const TREAT = {
  source: "kv",
  cohort: "personalized",
  arm: "treat",
  body_id: "0123456789abcdef",
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
  carryable: true,
  conversion_targets: [],
};
const ORIGINAL = { source: "original", cohort: "no_signal", variant: null, carryable: false };

type Answer = "treat" | "original" | "hang";
/** A policy: its config line as the edge writes it, and what `/select` answers there. */
interface Policy {
  cfg: () => Record<string, unknown>;
  answer: Answer;
}
const base = { c: "acme", e: EDGE };
const POLICIES: Record<string, Policy> = {
  "the off script": { cfg: () => ({ ...base, off: 1 }), answer: "treat" },
  "an audit's, on its host": {
    cfg: () => ({ ...base, h: RULES, p: ["/"], nt: 1, ad: "site.test", ae: Date.now() + DAY }),
    answer: "treat",
  },
  "an audit's, off its host": {
    cfg: () => ({ ...base, h: RULES, p: ["/"], nt: 1, ad: "other.test", ae: Date.now() + DAY }),
    answer: "treat",
  },
  // The edge serves the off script past the end; a browser may still run
  // the audit's script it kept for its five minutes.
  "an audit's, past its end": {
    cfg: () => ({ ...base, h: RULES, p: ["/"], nt: 1, ad: "site.test", ae: Date.now() - 1 }),
    answer: "treat",
  },
  "one before go live": { cfg: () => ({ ...base, h: {}, nt: 1 }), answer: "original" },
  "one without a read bundle": { cfg: () => ({ ...base, h: RULES, nt: 1 }), answer: "treat" },
};

interface Sent {
  url: string;
  body: Record<string, unknown> | null;
}
let tab: Map<string, string>;
let sent: Sent[];

interface PageOpts {
  cfg: Record<string, unknown>;
  answer: Answer;
  /** The paste above an `async` tag (the two-part tag); else our tag sync, first in head. */
  paste?: boolean;
}

/** One page: a new document and a new copy of the snippet. */
function page(o: PageOpts) {
  vi.resetModules();
  const tag = o.paste
    ? `${PASTE}<script async src="${EDGE}/s/acme.js"></script>`
    : `<script src="${EDGE}/s/acme.js"></script>`;
  const dom = new JSDOM(`<!doctype html><html><head>${tag}</head><body>${HTML}</body></html>`, {
    url: "https://site.test/?utm_source=chatgpt.com",
  });
  const w = dom.window;
  const doc = w.document;
  // A sync tag first in head runs while the page parses, before any paint;
  // an async one here after the page parsed and painted.
  Object.defineProperty(doc, "readyState", {
    value: o.paste ? "complete" : "loading",
    configurable: true,
  });
  const paint = o.paste ? [{ name: "first-contentful-paint", startTime: 80, duration: 0 }] : [];
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
  (w as unknown as { __rw: unknown }).__rw = o.cfg;
  vi.stubGlobal("fetch", (u: string, init?: RequestInit) => {
    sent.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (u.startsWith(`${EDGE}/select`)) {
      if (o.answer === "hang") return new Promise<Response>(() => {});
      const body = o.answer === "treat" ? TREAT : ORIGINAL;
      return new Promise<Response>((r) =>
        setTimeout(() => r(new Response(JSON.stringify(body), { status: 200 })), 200),
      );
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return doc;
}

/** The customer's tag as the edge serves it since E1: the boot, then the core. */
const bootTag = () => import("./split-entry.ts");
/** The single file (`/snippet.js`, and these policies' scripts before E1). */
const singleFile = () => import("../src/./index.ts");

const pastes = () => [...document.querySelectorAll<HTMLStyleElement>("style[data-rawuser-pre]")];
/** jsdom has no `disabled` on a style element: the test reads the property the boot sets. */
const disabled = (s: HTMLStyleElement) => (s as { disabled?: boolean }).disabled === true;
/** When the boot disables the paste, is our own hide style already in? */
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
/**
 * The parts held hidden now: by our hide style while it is in, and by the
 * paste while it is not disabled (jsdom does not honour `disabled`, so the
 * test reads it).
 */
function held(): string[] {
  const out: string[] = [];
  const hide = document.getElementById("__rawuser-hide") as HTMLStyleElement | null;
  const rules = [...(hide?.sheet?.cssRules ?? [])]
    .map((r) => (r as CSSStyleRule).selectorText)
    .filter((s): s is string => !!s);
  const pasteOn = pastes().some((s) => !disabled(s));
  for (const sel of ["h1.hero", "p.lead"]) {
    const el = document.querySelector(sel);
    if (!el) continue;
    if (pasteOn || rules.some((r) => el.matches(r))) out.push(sel);
  }
  return out;
}
const text = (sel: string) => document.querySelector(sel)?.textContent;
const selects = () => sent.filter((s) => s.url.startsWith(`${EDGE}/select`));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  tab = new Map();
  sent = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const CHECKS = [0, 100, 250, 1500, 5000];

describe("without a paste, every policy's boot does what its single file did", () => {
  /** One load: the page at each check, what left it and what the tab kept, marker and times blanked. */
  async function run(load: () => Promise<unknown>, p: Policy, async: boolean) {
    // A tab from an earlier page of the visit: the off script must clear it.
    tab = new Map([
      ["__rw_visit", JSON.stringify({ v: "a".repeat(32), t: Date.now() })],
      ["__rw_carry", JSON.stringify({ i: "problem", s: "ai", t: Date.now() })],
    ]);
    sent = [];
    page({ cfg: p.cfg(), answer: p.answer });
    if (async) {
      // Our tag as an async one after the paint, with no paste: late, as before.
      const s = document.currentScript as HTMLScriptElement;
      s.async = true;
      Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
    }
    await load();
    if (!async)
      Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
    const frames: string[] = [];
    let at = 0;
    for (const t of CHECKS) {
      await vi.advanceTimersByTimeAsync(t - at);
      at = t;
      frames.push(`${t}: held=${held().join(",")} h1=${text("h1")} p=${text("p")}`);
    }
    const blank = (s: string) => s.replace(/[0-9a-f]{32}/g, "V").replace(/"t":\d+/g, '"t":T');
    return {
      frames,
      requests: sent.map((s) => `${blank(s.url)} ${blank(JSON.stringify(s.body))}`),
      kept: [...tab.entries()].map(([k, v]) => `${k}=${blank(v)}`).sort(),
    };
  }

  for (const [name, p] of Object.entries(POLICIES)) {
    for (const async of [false, true]) {
      it(`${name}, ${async ? "an async tag" : "a sync tag first in head"}`, async () => {
        const single = await run(singleFile, p, async);
        const boot = await run(bootTag, p, async);
        expect(boot).toEqual(single);
      });
    }
  }
});

describe("with a paste and an async tag, no part is hidden longer than today's rules allow", () => {
  // The boot leaves these pages alone: nothing asked, nothing hidden, the
  // paste off in the boot's own task.
  for (const name of ["the off script", "an audit's, off its host", "an audit's, past its end"]) {
    it(`${name}: the page as built at once`, async () => {
      const p = POLICIES[name] as Policy;
      page({ cfg: p.cfg(), answer: p.answer, paste: true });
      await bootTag();
      expect(pastes().every(disabled)).toBe(true);
      expect(held()).toEqual([]);
      expect(document.getElementById("__rawuser-hide")).toBeNull();
      await vi.advanceTimersByTimeAsync(5000);
      expect(selects()).toHaveLength(0);
      expect(text("h1")).toBe("Old headline");
    });
  }

  it("one before go live: nothing to hide, the paste off at once, the page as built", async () => {
    const p = POLICIES["one before go live"] as Policy;
    page({ cfg: p.cfg(), answer: p.answer, paste: true });
    await bootTag();
    expect(pastes().every(disabled)).toBe(true);
    expect(held()).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(held()).toEqual([]);
    expect(document.getElementById("__rawuser-hide")).toBeNull();
    expect(text("h1")).toBe("Old headline");
    expect(text("p")).toBe("Old body");
  });

  // The boot takes the parts over from the paste and writes, as on a live
  // customer's script; with no answer, its cap shows the page at 1,500 ms.
  for (const name of ["an audit's, on its host", "one without a read bundle"]) {
    it(`${name}: taken over in one task, written, never held past the cap`, async () => {
      const p = POLICIES[name] as Policy;
      page({ cfg: p.cfg(), answer: p.answer, paste: true });
      const seen = watchDisable();
      await bootTag();
      expect(seen.oursFirst).toBe(true);
      expect(pastes().every(disabled)).toBe(true);
      expect(held()).toEqual(["h1.hero", "p.lead"]);
      await vi.advanceTimersByTimeAsync(1500);
      expect(held()).toEqual([]);
      expect(text("h1")).toBe("New headline");
      expect(text("p")).toBe("New body");
    });

    it(`${name}: an edge that never answers, the original at the cap`, async () => {
      const p = POLICIES[name] as Policy;
      page({ cfg: p.cfg(), answer: "hang", paste: true });
      await bootTag();
      expect(pastes().every(disabled)).toBe(true);
      await vi.advanceTimersByTimeAsync(1499);
      expect(held()).toEqual(["h1.hero", "p.lead"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(held()).toEqual([]);
      expect(text("h1")).toBe("Old headline");
    });

    it(`${name}: an answer that writes nothing, the page as built at the answer`, async () => {
      const p = POLICIES[name] as Policy;
      page({ cfg: p.cfg(), answer: "original", paste: true });
      await bootTag();
      await vi.advanceTimersByTimeAsync(250);
      expect(held()).toEqual([]);
      expect(text("h1")).toBe("Old headline");
      expect(text("p")).toBe("Old body");
    });
  }
});
