/**
 * Late answers (docs/specs/quiet-swap.md): once the safety timer has shown
 * the original, a version that arrives afterwards is not written. The visit
 * is still counted (`personalization_skipped`, kind `late`), the carry is
 * still written for the next page, nothing is kept or held, and a
 * conversion on the page counts as `skipped`.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsing } from "./helpers.ts";

const EDGE = "https://edge.test";

interface Sent {
  url: string;
  raw: string;
  body: Record<string, unknown>;
}

let sent: Sent[];
let selectReply: (call: number) => Promise<Response>;
let selectCalls: number;
/** /carry asks: the body-carry prefetch after the reveal. */
let carryCalls: number;

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
  conversion_targets: [
    {
      section_path: "hero.cta",
      conversion_label: "signup",
      css: ["a.cta"],
      text: [],
      structural: "",
    },
  ],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Answers `body` after `ms` of fake time. */
function answerAfter(ms: number, body: unknown): Promise<Response> {
  return new Promise((r) => setTimeout(() => r(json(body)), ms));
}

const HTML = `<h1 class="hero">Old headline</h1><a class="cta" href="#">Start</a>`;

function page(url = "https://site.test/") {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${HTML}</body></html>`, { url });
  const w = dom.window;
  // The tag first in head, as on a real page (not a late tag).
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
    if (url.startsWith(`${EDGE}/select`)) return selectReply(++selectCalls);
    if (url.startsWith(`${EDGE}/carry`)) {
      carryCalls++;
      // A real body for another confirmed page of the same segment.
      return Promise.resolve(
        json({
          bodies: {
            "/pricing": {
              sections: { hero: { kind: "hero", headline: "Pricing words" } },
              targets,
            },
          },
        }),
      );
    }
    if (url.startsWith(`${EDGE}/event`)) {
      const raw = String(init?.body ?? "");
      sent.push({ url, raw, body: JSON.parse(raw) as Record<string, unknown> });
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return w;
}

async function boot(): Promise<void> {
  await import("../src/index.ts");
}

const events = (type: string) => sent.filter((s) => s.body.event_type === type);
const issues = () =>
  events("snippet_issue").flatMap(
    (s) => (s.body.properties as { issues: Array<Record<string, unknown>> }).issues,
  );
const headline = () => document.querySelector("h1")?.textContent;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  sent = [];
  selectCalls = 0;
  carryCalls = 0;
  selectReply = () => Promise.resolve(json(personalized));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("an answer after the load cap", () => {
  it("writes nothing, keeps the original, counts the visit as late, writes the carry", async () => {
    const w = page();
    selectReply = () => answerAfter(2500, personalized);
    await boot();
    await vi.advanceTimersByTimeAsync(1500);
    // The cap showed the original.
    expect(document.getElementById("__rawuser-hide")).toBeNull();
    expect(headline()).toBe("Old headline");
    await vi.advanceTimersByTimeAsync(1500);
    // The answer is in, and the headline the visitor is reading stays.
    expect(headline()).toBe("Old headline");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(headline()).toBe("Old headline");

    expect(events("variant_shown")).toHaveLength(0);
    const skipped = events("personalization_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.body).toMatchObject({
      page_path: "/",
      variant_key: "v1:variant:acme:problem:ai",
      intent_dim: "problem",
      source_dim: "ai",
      cohort: "skipped",
      kind: "late",
    });
    expect(typeof skipped[0]?.body.visit).toBe("string");
    expect(skipped[0]?.body.body_carry).toBeUndefined();
    expect(issues()).toEqual([{ c: "reveal_cap", n: 1 }]);

    // The carry is written, so the next page of the visit carries it quietly.
    expect(JSON.parse(w.sessionStorage.getItem("__rw_carry") ?? "{}")).toMatchObject({
      i: "problem",
      s: "ai",
    });
    // A copy the visitor never saw is not kept for the next page.
    expect(w.sessionStorage.getItem("__rw_body")).toBeNull();

    // No hold: the page's own change to the element is left alone.
    (document.querySelector("h1") as HTMLElement).textContent = "Page changed it";
    await vi.advanceTimersByTimeAsync(2000);
    expect(headline()).toBe("Page changed it");

    // A conversion here counts for the original page the visitor saw.
    (document.querySelector("a.cta") as HTMLElement).dispatchEvent(
      new w.MouseEvent("click", { bubbles: true }),
    );
    const conv = events("conversion");
    expect(conv).toHaveLength(1);
    expect(conv[0]?.body.cohort).toBe("skipped");
  });
});

describe("the body-carry prefetch after the reveal (privacy review, 2026-10-02)", () => {
  it("a late load asks /carry for nothing and stores nothing", async () => {
    const w = page();
    selectReply = () => answerAfter(2500, personalized);
    await boot();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events("personalization_skipped")[0]?.body.kind).toBe("late");
    // The carry itself is there, so only the late rule stops the prefetch.
    expect(w.sessionStorage.getItem("__rw_carry")).not.toBeNull();
    expect(carryCalls).toBe(0);
    expect(w.sessionStorage.getItem("__rw_body")).toBeNull();
  });

  it("a normal load still prefetches and stores the other page's copy", async () => {
    const w = page();
    selectReply = () => answerAfter(400, personalized);
    await boot();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(headline()).toBe("New headline");
    expect(carryCalls).toBe(1);
    const kept = JSON.parse(w.sessionStorage.getItem("__rw_body") ?? "{}") as {
      p?: Record<string, unknown>;
    };
    expect(Object.keys(kept.p ?? {}).sort()).toEqual(["/", "/pricing"]);
    expect(JSON.stringify(kept.p?.["/pricing"])).toContain("Pricing words");
  });
});

describe("an answer before the load cap", () => {
  it("writes as before: variant_shown, the copy kept, no issue", async () => {
    const w = page();
    selectReply = () => answerAfter(400, personalized);
    await boot();
    await vi.advanceTimersByTimeAsync(1400);
    expect(headline()).toBe("New headline");
    expect(document.getElementById("__rawuser-hide")).toBeNull();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(events("variant_shown")).toHaveLength(1);
    expect(events("personalization_skipped")).toHaveLength(0);
    expect(issues()).toEqual([]);
    expect(w.sessionStorage.getItem("__rw_body")).toContain("New headline");
    (document.querySelector("a.cta") as HTMLElement).dispatchEvent(
      new w.MouseEvent("click", { bubbles: true }),
    );
    expect(events("conversion")[0]?.body.cohort).toBe("personalized");
  });
});

describe("a page written early from the tab's copy", () => {
  /** A later page of the visit: the carry and the copy for "/" in the tab, no signal of its own. */
  function carried(w: { sessionStorage: Storage }, headlineWords = "New headline") {
    const t = Date.now();
    w.sessionStorage.setItem("__rw_carry", JSON.stringify({ i: "problem", s: "ai", t }));
    w.sessionStorage.setItem(
      "__rw_body",
      JSON.stringify({
        i: "problem",
        s: "ai",
        t,
        p: { "/": { sections: { hero: { kind: "hero", headline: headlineWords } }, targets } },
      }),
    );
  }

  it("confirmed by the edge after the cap: unchanged, still personalized with body_carry", async () => {
    const w = page();
    carried(w);
    selectReply = () => answerAfter(2500, { ...personalized, carried: true });
    await boot();
    expect(headline()).toBe("New headline");
    await vi.advanceTimersByTimeAsync(1500);
    expect(document.getElementById("__rawuser-hide")).toBeNull();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(headline()).toBe("New headline");
    const shown = events("variant_shown");
    expect(shown).toHaveLength(1);
    expect(shown[0]?.body).toMatchObject({ cohort: "personalized", body_carry: 1, carried: 1 });
    expect(events("personalization_skipped")).toHaveLength(0);
  });

  it("a revert verdict after the cap still puts the page back", async () => {
    const w = page();
    carried(w);
    selectReply = () =>
      answerAfter(2500, { source: "original", cohort: "no_signal", variant: null });
    await boot();
    expect(headline()).toBe("New headline");
    await vi.advanceTimersByTimeAsync(5000);
    expect(headline()).toBe("Old headline");
    expect(w.sessionStorage.getItem("__rw_body")).toBeNull();
    expect(events("no_signal_passthrough")).toHaveLength(1);
  });

  it("another copy from the edge after the cap: not written, the page put back, the copy dropped", async () => {
    const w = page();
    carried(w, "Older carried words");
    selectReply = () => answerAfter(2500, { ...personalized, carried: true });
    await boot();
    expect(headline()).toBe("Older carried words");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(headline()).toBe("Old headline");
    expect(w.sessionStorage.getItem("__rw_body")).toBeNull();
    expect(events("personalization_skipped")[0]?.body).toMatchObject({ kind: "late", carried: 1 });
    expect(events("variant_shown")).toHaveLength(0);
  });
});

describe("a React page (hydration)", () => {
  function reactPage() {
    const w = page();
    (w as unknown as { __NEXT_DATA__: unknown }).__NEXT_DATA__ = {};
    return w;
  }
  const hydrate = () => {
    (document.querySelector("h1") as unknown as Record<string, unknown>).__reactFiber$abc = {};
  };

  it("hydration inside the moved cap: written, no issue, no late", async () => {
    reactPage();
    selectReply = () => answerAfter(300, personalized);
    await boot();
    // Past the load cap: the hydration wait moved it, nothing is shown yet.
    await vi.advanceTimersByTimeAsync(1600);
    expect(document.getElementById("__rawuser-hide")).not.toBeNull();
    hydrate();
    await vi.advanceTimersByTimeAsync(800);
    expect(headline()).toBe("New headline");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(events("variant_shown")).toHaveLength(1);
    expect(issues()).toEqual([]);
  });

  it("waits for every target React will hydrate, not the first one (lumera.test /approach, #418)", async () => {
    reactPage();
    // Next's app router: hydrateRoot(document) marks the document as the root.
    (document as unknown as Record<string, unknown>).__reactContainer$abc = {};
    const two = {
      ...personalized,
      variant: {
        ...variant,
        sections: { hero: { kind: "hero", headline: "New headline", cta: { label: "Go now" } } },
      },
      targets: {
        ...targets,
        "hero.cta.label": { css: ["a.cta"], text: [], structural: "" },
      },
    };
    selectReply = () => answerAfter(300, two);
    await boot();
    await vi.advanceTimersByTimeAsync(400);
    // React has completed the headline and not yet the button.
    hydrate();
    await vi.advanceTimersByTimeAsync(800);
    expect(headline()).toBe("Old headline");
    expect(document.querySelector("a.cta")?.textContent).toBe("Start");
    expect(document.getElementById("__rawuser-hide")).not.toBeNull();
    (document.querySelector("a.cta") as unknown as Record<string, unknown>).__reactFiber$abc = {};
    await vi.advanceTimersByTimeAsync(200);
    expect(headline()).toBe("New headline");
    expect(document.querySelector("a.cta")?.textContent).toBe("Go now");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(events("variant_shown")).toHaveLength(1);
    expect(issues()).toEqual([]);
  });

  it("the hydration cap fires first: the original stays, late with reveal_cap 3", async () => {
    reactPage();
    await boot();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(headline()).toBe("Old headline");
    expect(events("variant_shown")).toHaveLength(0);
    expect(events("personalization_skipped")[0]?.body.kind).toBe("late");
    expect(issues()).toEqual([{ c: "reveal_cap", n: 3 }]);
  });

  it("an answer after the load cap does not move the cap again: late, reveal_cap 1", async () => {
    reactPage();
    selectReply = () => answerAfter(2000, personalized);
    await boot();
    await vi.advanceTimersByTimeAsync(2100);
    hydrate();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(headline()).toBe("Old headline");
    expect(events("personalization_skipped")[0]?.body.kind).toBe("late");
    expect(issues()).toEqual([{ c: "reveal_cap", n: 1 }]);
  });
});

describe("a client-side navigation", () => {
  const original = { source: "original", cohort: "no_signal", variant: null };

  it("an answer inside the SPA cap writes the new route", async () => {
    const w = page();
    selectReply = (n) =>
      n === 1 ? Promise.resolve(json(original)) : answerAfter(300, personalized);
    await boot();
    await vi.advanceTimersByTimeAsync(2000);
    w.history.pushState({}, "", "/about");
    await vi.advanceTimersByTimeAsync(1400);
    expect(headline()).toBe("New headline");
    expect(events("variant_shown")).toHaveLength(1);
  });

  it("an answer after the SPA cap writes nothing: late, reveal_cap 2", async () => {
    const w = page();
    selectReply = (n) =>
      n === 1 ? Promise.resolve(json(original)) : answerAfter(2000, personalized);
    await boot();
    await vi.advanceTimersByTimeAsync(2000);
    w.history.pushState({}, "", "/about");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(headline()).toBe("Old headline");
    expect(events("variant_shown")).toHaveLength(0);
    expect(events("personalization_skipped")[0]?.body).toMatchObject({
      page_path: "/about",
      kind: "late",
    });
    expect(issues()).toEqual([{ c: "reveal_cap", n: 2 }]);
  });

  it("a route whose elements appear only after the SPA cap: late, not written", async () => {
    const w = page();
    selectReply = (n) =>
      n === 1 ? Promise.resolve(json(original)) : answerAfter(100, personalized);
    await boot();
    await vi.advanceTimersByTimeAsync(2000);
    document.querySelector("h1")?.remove();
    w.history.pushState({}, "", "/about");
    // The router renders the hero two seconds in, past the 1,500 ms cap.
    setTimeout(() => {
      const h1 = document.createElement("h1");
      h1.className = "hero";
      h1.textContent = "Old headline";
      document.body.prepend(h1);
    }, 2000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(headline()).toBe("Old headline");
    expect(events("personalization_skipped")[0]?.body.kind).toBe("late");
  });
});
