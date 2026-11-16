/**
 * The late tag rule (docs/specs/late-tag.md, the founder's yes of
 * 2026-10-12; privacy review Q2, docs/specs/pilot-gaps.md).
 *
 * A page that was painted before our script ran stays as built for that
 * load: nothing hidden, nothing written. The edge is still asked and the tab
 * keeps the carry and the copy, so the visit's next page is written from the
 * tab at once. The load is `personalization_skipped`, kind `late`, with the
 * bit `lp: 1`; a holdout exposure carries the bit too. `lp` is the
 * `tagIsLate` boolean and nothing else, and it is on no other event.
 *
 * Not late-tag cases, unchanged: a client-side route, capture mode, pick
 * mode, and a late answer on a tag that ran in time (kind `late`, no `lp`).
 *
 * privacy review (docs/specs/pilot-gaps.md, 2026-10-12),
 * the test condition: with the customer's carry off, such a load keeps no
 * `__rw_carry` and no `__rw_body` and asks no `/carry`. The standing note:
 * `prefers-reduced-motion` is read for the fade and reaches no event, no
 * storage and no request.
 */
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreScriptOnly, pageMarkup } from "./helpers.ts";

const EDGE = "https://edge.test";
const BODY_ID = "0123456789abcdef";
const HTML = `<section class="hero-content"><h1 class="hero">Old headline</h1><p class="lead">Old body</p><a class="cta" href="#">Start</a></section>`;

const sections = { hero: { kind: "hero", headline: "New headline", body: "New body" } };
const part = (css: string) => ({ css: [css], text: [], structural: "" });
const targets = { "hero.headline": part("h1.hero"), "hero.body": part("p.lead") };
const selection = { intent_dim: "problem", source_dim: "ai", confidence: 0.8 };
const CONV = [
  {
    section_path: "hero.cta",
    conversion_label: "signup",
    css: ["a.cta"],
    text: [],
    structural: "",
  },
];
const treat = {
  source: "kv",
  cohort: "personalized",
  arm: "treat",
  body_id: BODY_ID,
  variant_key: "v1:variant:acme:problem:ai",
  selection,
  variant: {
    customer_id: "acme",
    profile_key: "intent:problem",
    sections,
    generated_at: 0,
    prompt_hash: "h",
  },
  targets,
  carryable: true,
  conversion_targets: CONV,
};
const holdout = {
  source: "holdout",
  cohort: "holdout",
  arm: "holdout",
  body_id: BODY_ID,
  variant_key: "",
  variant: null,
  selection,
  conversion_targets: CONV,
};
const noSignal = {
  source: "original",
  cohort: "no_signal",
  variant_key: "",
  variant: null,
  conversion_targets: CONV,
};

/**
 * What the edge answers for a customer whose carry is off: `carry_off`, and
 * never `carryable` (packages/edge/src/index.ts, the personalised answer).
 */
const { carryable: _carryable, ...notCarryable } = treat;
const treatOff = { ...notCarryable, carry_off: true };
/** A carried page of such a customer: the page as built, and the switch. */
const noSignalOff = { ...noSignal, carry_off: true };

interface Sent {
  raw: string;
  body: Record<string, unknown>;
}

/** What the tab keeps from one page to the next. */
let tab: Map<string, string>;
/** Every key and value the snippet set in the tab, in order: what was kept at any moment. */
let wrote: Array<[string, string]>;
let sent: Sent[];
let asked: string[];
let selectReply: () => Promise<Response>;
let paint: unknown[];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
const answerAfter = (ms: number, body: unknown) =>
  new Promise<Response>((r) => setTimeout(() => r(json(body)), ms));

interface PageOpts {
  url?: string;
  referrer?: string;
  html?: string;
  /** The page was painted before our script ran (the default here). */
  late?: boolean;
  rich?: boolean;
  /** More fields of the per-customer script's `window.__rw` (`nc: 1` is the carry off). */
  cfg?: Record<string, unknown>;
}

/** One page of the tab: a new document, a new copy of the snippet, the same sessionStorage. */
function page(o: PageOpts = {}) {
  vi.resetModules();
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${o.html ?? HTML}</body></html>`, {
    url: o.url ?? "https://site.test/?utm_source=chatgpt.com",
    ...(o.referrer ? { referrer: o.referrer } : {}),
  });
  const w = dom.window;
  const doc = w.document;
  Object.defineProperty(doc, "readyState", {
    value: o.late === false ? "loading" : "complete",
    configurable: true,
  });
  vi.stubGlobal("window", w);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", w.location);
  vi.stubGlobal("history", w.history);
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => tab.get(k) ?? null,
    setItem: (k: string, v: string) => {
      wrote.push([k, v]);
      tab.set(k, v);
    },
    removeItem: (k: string) => {
      tab.delete(k);
    },
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
  (w as unknown as { __rw: unknown }).__rw = {
    c: "acme",
    e: EDGE,
    h: { "/": ["h1.hero", "p.lead"] },
    ...(o.rich ? { x: ["/"] } : {}),
    ...o.cfg,
  };
  vi.stubGlobal("fetch", (u: string, init?: RequestInit) => {
    asked.push(u);
    if (u.startsWith(`${EDGE}/select`)) return selectReply();
    if (u.startsWith(`${EDGE}/carry`))
      return Promise.resolve(
        json({ bodies: { "/pricing": { sections, targets, prompt_hash: "h" } } }),
      );
    if (u.startsWith(`${EDGE}/event`)) {
      const raw = String(init?.body ?? "");
      sent.push({ raw, body: JSON.parse(raw) as Record<string, unknown> });
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return w;
}

async function boot(): Promise<void> {
  await import("../src/index.ts");
}

const events = (type: string) => sent.filter((s) => s.body.event_type === type);
const text = (sel: string) => document.querySelector(sel)?.textContent;
const selects = () => asked.filter((u) => u.startsWith(`${EDGE}/select`));
const carryAsks = () => asked.filter((u) => u.startsWith(`${EDGE}/carry`));
/** The keys the snippet set, the visit marker aside. */
const keptEver = () => wrote.map(([k]) => k).filter((k) => k !== "__rw_visit");
/** The source, for the static tests. */
const SRC = new URL("../src/", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, SRC), "utf8");
/** The code alone: a comment may name what the code must never read. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const sourceFiles = () =>
  (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).sort();
const issuesOf = (s: Sent | undefined) =>
  (s?.body.properties as { issues: Array<Record<string, unknown>> } | undefined)?.issues;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  tab = new Map();
  wrote = [];
  sent = [];
  asked = [];
  paint = [];
  selectReply = () => answerAfter(200, treat);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a page painted before our script ran stays as built", () => {
  it("nothing is hidden and nothing is written, at any moment of the load", async () => {
    page();
    const before = pageMarkup(document);
    const seen = new Set<string>();
    const mo = new MutationObserver((records) => {
      for (const r of records) if (!coreScriptOnly(r)) seen.add(r.type);
    });
    mo.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    await boot();
    for (const ms of [0, 100, 150, 1300, 3000, 40_000]) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(document.querySelectorAll("style")).toHaveLength(0);
      expect(text("h1")).toBe("Old headline");
      expect(text("p")).toBe("Old body");
    }
    // Not one mutation of the document: no style, no text, no attribute.
    expect([...seen]).toEqual([]);
    expect(pageMarkup(document)).toBe(before);
    mo.disconnect();
  });

  it("the edge is still asked, once, with the parameters of any landing", async () => {
    page();
    await boot();
    await vi.advanceTimersByTimeAsync(5000);
    expect(selects()).toHaveLength(1);
    expect([...new URL(selects()[0] ?? "").searchParams.keys()].sort()).toEqual([
      "customer_id",
      "lang",
      "path",
      "self_host",
      "utm_source",
      "visit",
    ]);
  });

  it("is recorded as personalization_skipped, kind late, lp 1, and as nothing else", async () => {
    page();
    await boot();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sent.map((s) => s.body.event_type)).toEqual([
      "personalization_skipped",
      "snippet_issue",
    ]);
    const skipped = events("personalization_skipped")[0]?.body ?? {};
    expect(skipped).toEqual({
      event_type: "personalization_skipped",
      page_path: "/",
      variant_key: "v1:variant:acme:problem:ai",
      intent_dim: "problem",
      source_dim: "ai",
      cohort: "skipped",
      kind: "late",
      lp: 1,
      visit: skipped.visit,
      arm: "treat",
      body_id: BODY_ID,
    });
    expect(skipped.visit).toMatch(/^[0-9a-f]{32}$/);
    // late_tag stays the issue code, with no marker and without the bit.
    const issue = events("snippet_issue")[0];
    expect(issuesOf(issue)).toEqual([{ c: "late_tag" }]);
    expect(issue?.raw).not.toContain("visit");
    expect(issue?.raw).not.toContain('"lp"');
  });

  it("the holdout arm records its exposure as always, with the bit", async () => {
    page();
    selectReply = () => answerAfter(200, holdout);
    await boot();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(text("h1")).toBe("Old headline");
    const shown = events("variant_shown");
    expect(shown).toHaveLength(1);
    expect(shown[0]?.body).toMatchObject({ cohort: "holdout", arm: "holdout", lp: 1 });
    expect(events("personalization_skipped")).toHaveLength(0);
  });

  it("a visit with no signal carries no bit", async () => {
    page({ url: "https://site.test/" });
    selectReply = () => answerAfter(200, noSignal);
    await boot();
    await vi.advanceTimersByTimeAsync(40_000);
    const through = events("no_signal_passthrough");
    expect(through).toHaveLength(1);
    expect(through[0]?.raw).not.toContain('"lp"');
  });

  it("a conversion on such a load counts as skipped (or holdout) and never carries the bit", async () => {
    for (const [answer, cohort] of [
      [treat, "skipped"],
      [holdout, "holdout"],
    ] as const) {
      sent = [];
      tab = new Map();
      const w = page();
      selectReply = () => answerAfter(200, answer);
      await boot();
      await vi.advanceTimersByTimeAsync(3000);
      (document.querySelector("a.cta") as HTMLElement).dispatchEvent(
        new w.MouseEvent("click", { bubbles: true }),
      );
      await vi.advanceTimersByTimeAsync(1000);
      const conv = events("conversion");
      expect(conv).toHaveLength(1);
      expect(conv[0]?.body).toMatchObject({ cohort, conversion_label: "signup" });
      expect(conv[0]?.raw).not.toContain('"lp"');
    }
  });

  it("a failed /select reports the failure beside late_tag, and no exposure", async () => {
    page();
    selectReply = () => Promise.reject(new TypeError("Failed to fetch"));
    await boot();
    await vi.advanceTimersByTimeAsync(5000);
    expect(text("h1")).toBe("Old headline");
    expect(sent.map((s) => s.body.event_type)).toEqual(["snippet_issue"]);
    expect(issuesOf(sent[0])).toEqual([{ c: "late_tag" }, { c: "select_failed", n: 2 }]);
  });

  it("neither waits for hydration on a React page nor loads the rich writers", async () => {
    const w = page({ rich: true });
    (w as unknown as { __NEXT_DATA__: unknown }).__NEXT_DATA__ = {};
    await boot();
    // Recorded as soon as the edge answers: no hydration wait, no cap.
    await vi.advanceTimersByTimeAsync(250);
    expect(events("personalization_skipped")[0]?.body).toMatchObject({ kind: "late", lp: 1 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(document.querySelector('script[src*="/rich.js"]')).toBeNull();
    expect(issuesOf(events("snippet_issue")[0])).toEqual([{ c: "late_tag" }]);
  });
});

describe("the tab still keeps the visit's carry and copy", () => {
  it("the two words, this page's copy and the other pages' copy are kept on a late load", async () => {
    page();
    await boot();
    await vi.advanceTimersByTimeAsync(5000);
    expect(JSON.parse(tab.get("__rw_carry") ?? "{}")).toMatchObject({ i: "problem", s: "ai" });
    const body = JSON.parse(tab.get("__rw_body") ?? "{}") as { p: Record<string, unknown> };
    // The prefetch ran after the load, as on a load that showed the version.
    expect(asked.filter((u) => u.startsWith(`${EDGE}/carry`))).toHaveLength(1);
    expect(Object.keys(body.p).sort()).toEqual(["/", "/pricing"]);
    // Nothing else is kept: the three keys a visit always had.
    expect([...tab.keys()].sort()).toEqual(["__rw_body", "__rw_carry", "__rw_visit"]);
    expect(JSON.stringify([...tab.values()])).not.toContain("lp");
  });

  it("the next page of the visit, its tag in time, is written from the tab at once", async () => {
    page();
    await boot();
    await vi.advanceTimersByTimeAsync(5000);
    expect(text("h1")).toBe("Old headline");

    sent = [];
    asked = [];
    page({ url: "https://site.test/", referrer: "https://site.test/pricing", late: false });
    selectReply = () => answerAfter(200, { ...treat, carried: true });
    await boot();
    // Before the edge answers: the tab's copy, behind the hide.
    expect(document.getElementById("__rawuser-hide")).not.toBeNull();
    expect(text("h1")).toBe("New headline");
    // No `bc=1` since the boot and core split (faster-tag.md C): the event's
    // `body_carry` below is the fact.
    expect(selects()[0]).not.toContain("bc=");
    await vi.advanceTimersByTimeAsync(15_000);
    const shown = events("variant_shown");
    expect(shown).toHaveLength(1);
    expect(shown[0]?.body).toMatchObject({ cohort: "personalized", body_carry: 1, carried: 1 });
    expect(shown[0]?.raw).not.toContain('"lp"');
  });

  it("a next page that was painted first stays as built too: no early write from the tab", async () => {
    page();
    await boot();
    await vi.advanceTimersByTimeAsync(5000);

    sent = [];
    asked = [];
    page({ url: "https://site.test/", referrer: "https://site.test/pricing" });
    selectReply = () => answerAfter(200, { ...treat, carried: true });
    await boot();
    expect(text("h1")).toBe("Old headline");
    expect(selects()[0]).not.toContain("bc=1");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(text("h1")).toBe("Old headline");
    expect(events("variant_shown")).toHaveLength(0);
    expect(events("personalization_skipped")[0]?.body).toMatchObject({
      kind: "late",
      lp: 1,
      carried: 1,
    });
    expect(events("personalization_skipped")[0]?.raw).not.toContain("body_carry");
  });
});

describe("the customer's carry off switch on a late-tag load (privacy review)", () => {
  /**
   * The switch reaches the browser two ways (docs/specs/session-carry.md):
   * `nc: 1` in the per-customer script and `carry_off` on the answer of
   * `/select`, which then never says `carryable`. Each alone must be enough:
   * the script can be cached from before the switch, and the edge reads the
   * switch from KV with a five-minute cache.
   */
  const forms: Array<[string, Record<string, unknown>, unknown]> = [
    ["the script's nc: 1, the edge still answering carryable", { nc: 1 }, treat],
    ["the script's nc: 1 and the answer's carry_off", { nc: 1 }, treatOff],
    ["the answer's carry_off alone, not carryable (a cached script)", {}, treatOff],
    ["the answer's carry_off beside carryable: the switch wins", {}, { ...treat, carry_off: true }],
  ];

  it.each(forms)(
    "%s: no __rw_carry, no __rw_body, no /carry; the edge is asked and the page stays as built",
    async (_form, cfg, answer) => {
      page({ cfg });
      selectReply = () => answerAfter(200, answer);
      const before = pageMarkup(document);
      await boot();
      for (const ms of [0, 250, 1500, 3000, 40_000]) {
        await vi.advanceTimersByTimeAsync(ms);
        expect(tab.has("__rw_carry")).toBe(false);
        expect(tab.has("__rw_body")).toBe(false);
        expect(text("h1")).toBe("Old headline");
        expect(text("p")).toBe("Old body");
        expect(document.querySelectorAll("style")).toHaveLength(0);
      }
      // After the whole load the tab holds the visit marker and nothing else,
      // and neither key was set at any moment on the way.
      expect([...tab.keys()]).toEqual(["__rw_visit"]);
      expect(keptEver()).toEqual([]);
      // No prefetch. The only requests of the load: /select once, then events.
      expect(carryAsks()).toEqual([]);
      expect(selects()).toHaveLength(1);
      const params = new URL(selects()[0] ?? "").searchParams;
      expect(params.has("carry")).toBe(false);
      expect(params.has("bc")).toBe(false);
      for (const u of asked) expect(u).toMatch(/^https:\/\/edge\.test\/(select|event)\b/);
      expect(pageMarkup(document)).toBe(before);
      // The switch changes what the tab keeps, not how the load is counted.
      expect(events("personalization_skipped")[0]?.body).toMatchObject({ kind: "late", lp: 1 });
      expect(events("variant_shown")).toHaveLength(0);
    },
  );

  /** Page two of a visit whose landing kept both, the switch turned off in between. */
  const later: Array<[string, Record<string, unknown>, string, unknown]> = [
    ["the script's nc: 1", { nc: 1 }, "https://site.test/", noSignal],
    ["the script's nc: 1 and the answer's carry_off", { nc: 1 }, "https://site.test/", noSignalOff],
    ["the answer's carry_off alone, on a carried page", {}, "https://site.test/", noSignalOff],
    [
      "the answer's carry_off alone, on a page with its own signal",
      {},
      "https://site.test/?utm_source=chatgpt.com",
      treatOff,
    ],
  ];

  it.each(later)(
    "a tab that kept both on an earlier page loses both, and nothing is kept again: %s",
    async (_form, cfg, url, answer) => {
      page();
      await boot();
      await vi.advanceTimersByTimeAsync(5000);
      expect([...tab.keys()].sort()).toEqual(["__rw_body", "__rw_carry", "__rw_visit"]);

      sent = [];
      asked = [];
      wrote = [];
      page({ url, referrer: "https://site.test/pricing", cfg });
      selectReply = () => answerAfter(200, answer);
      const before = pageMarkup(document);
      await boot();
      // nc: 1 empties the tab before anything is asked; carry_off as the edge answers.
      expect(tab.has("__rw_carry")).toBe(cfg.nc !== 1);
      expect(tab.has("__rw_body")).toBe(cfg.nc !== 1);
      await vi.advanceTimersByTimeAsync(40_000);
      expect([...tab.keys()]).toEqual(["__rw_visit"]);
      expect(keptEver()).toEqual([]);
      expect(carryAsks()).toEqual([]);
      expect(selects()).toHaveLength(1);
      const params = new URL(selects()[0] ?? "").searchParams;
      // With nc: 1 the two words are not even offered to the edge.
      if (cfg.nc === 1) expect(params.has("carry")).toBe(false);
      // A painted page is never written from the tab's copy, off switch or not.
      expect(params.has("bc")).toBe(false);
      expect(text("h1")).toBe("Old headline");
      expect(pageMarkup(document)).toBe(before);
      for (const s of sent) expect(s.raw).not.toContain("body_carry");
    },
  );

  it("an answer that is only not carryable is not the off switch: this page's copy is never kept, the carry stays on", async () => {
    // A page without its own confirmed manifest, on a customer whose carry is
    // on (body carry, condition 2). `carryable` gates this page's copy and
    // nothing else: the two words are kept and the other confirmed pages'
    // copy is asked for, as on a load that showed the version
    // (session-carry.md, "Where it comes from and where it goes").
    page();
    selectReply = () => answerAfter(200, notCarryable);
    await boot();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(text("h1")).toBe("Old headline");
    expect(JSON.parse(tab.get("__rw_carry") ?? "{}")).toMatchObject({ i: "problem", s: "ai" });
    expect(carryAsks()).toHaveLength(1);
    const bodies = wrote.filter(([k]) => k === "__rw_body");
    expect(bodies).toHaveLength(1);
    for (const [, v] of bodies) {
      expect(Object.keys((JSON.parse(v) as { p: Record<string, unknown> }).p)).toEqual([
        "/pricing",
      ]);
    }
    expect(Object.keys(JSON.parse(tab.get("__rw_body") ?? "{}").p)).toEqual(["/pricing"]);
  });
});

describe("what is not a late-tag case stays as it was", () => {
  it("a tag that ran in time: the version is shown, and no event has the bit", async () => {
    page({ late: false });
    await boot();
    expect(document.getElementById("__rawuser-hide")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(text("h1")).toBe("New headline");
    expect(events("variant_shown")).toHaveLength(1);
    for (const s of sent) expect(s.raw).not.toContain('"lp"');
  });

  it("a tag that ran in time, holdout: the exposure has no bit", async () => {
    page({ late: false });
    selectReply = () => answerAfter(200, holdout);
    await boot();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(events("variant_shown")[0]?.body).toMatchObject({ cohort: "holdout" });
    for (const s of sent) expect(s.raw).not.toContain('"lp"');
  });

  it("a late answer on a tag that ran in time is kind late without the bit: the two are told apart by lp", async () => {
    page({ late: false });
    selectReply = () => answerAfter(2500, treat);
    await boot();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(text("h1")).toBe("Old headline");
    const skipped = events("personalization_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.body.kind).toBe("late");
    expect(skipped[0]?.raw).not.toContain('"lp"');
    expect(issuesOf(events("snippet_issue")[0])).toEqual([{ c: "reveal_cap", n: 1 }]);
  });

  it("a client-side route after a late load is hidden and written as before, without the bit", async () => {
    const w = page();
    await boot();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(text("h1")).toBe("Old headline");
    sent = [];
    w.history.pushState({}, "", "/pricing");
    await vi.advanceTimersByTimeAsync(10);
    expect(document.getElementById("__rawuser-hide")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(text("h1")).toBe("New headline");
    const shown = events("variant_shown");
    expect(shown).toHaveLength(1);
    expect(shown[0]?.body.page_path).toBe("/pricing");
    for (const s of sent) expect(s.raw).not.toContain('"lp"');
    expect(sent.flatMap((s) => issuesOf(s) ?? []).filter((i) => i.c === "late_tag")).toHaveLength(
      0,
    );
  });

  it("capture mode on a painted page: the page is sent to the edge, no version is asked, no event", async () => {
    page({ url: "https://site.test/?rawuser_capture=tok_12345678" });
    await boot();
    // Capture runs in the operator module since 2026-10-25 (faster-tag.md D):
    // the snippet loads it with the token, and it sends the page.
    const op = document.querySelector<HTMLScriptElement>('script[src*="/picker.js"]');
    expect(op?.dataset.mode).toBe("capture");
    expect(op?.dataset.token).toBe("tok_12345678");
    Object.defineProperty(document, "currentScript", { value: op, configurable: true });
    await import("../src/picker/index.ts");
    await vi.advanceTimersByTimeAsync(5000);
    expect(asked.some((u) => u.startsWith(`${EDGE}/onboard/capture`))).toBe(true);
    expect(selects()).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(text("h1")).toBe("Old headline");
    expect(document.getElementById("__rawuser-hide")).toBeNull();
  });

  it("pick mode on a painted page: the picker loads, no version is asked, no event", async () => {
    page({ url: "https://site.test/#rawuser_pick=tok_12345678" });
    await boot();
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.querySelector('script[src*="/picker.js"]')).not.toBeNull();
    expect(selects()).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(text("h1")).toBe("Old headline");
    expect(document.getElementById("__rawuser-hide")).toBeNull();
  });
});

describe("lp is the tagIsLate boolean and nothing else (privacy review Q2, condition 1)", () => {
  it("static: one place sets it, from tagIsLate, as the literal 1", () => {
    // Since the boot and core split (faster-tag.md C) the boolean is made at
    // the start of the pass (start.ts, the boot's part) and the bit in the
    // core (core.ts), from that boolean alone.
    const index = code(read("core.ts"));
    const start = code(read("start.ts"));
    // The bit is made once, from the boolean, and spread from there.
    expect(index.match(/\blp\s*:/g)).toEqual(["lp:"]);
    expect(index).toMatch(/const lp = lateTag \? \{ lp: 1 as const \} : \{\};/);
    expect(index).toMatch(/const \{ here, own, lateTag, asBuilt \} = p;/);
    // Only narrowed since quiet-swap.md 2b: never on a page that is not the
    // site's own to write, where nothing would have been hidden or written.
    // The boot's file may hand its own rule that knows a pasted style
    // (the two-part tag, pre.ts), itself `tagIsLate` and one more test.
    expect(start).toMatch(
      /const lateTag = own && !spa && \(page\.late \?\? tagIsLate\)\(page\.script, rules\);/,
    );
    expect(start).toMatch(/const rules = hideRulesFor\(page\.cfg, here\);/);
    expect(start).toMatch(/const own = ownPage\(page\.cfg, here\);/);
    expect(start.match(/\blateTag\s*=[^=]/g)).toHaveLength(1);
    expect(index.match(/\blateTag\s*=[^=]/g)).toBeNull();
    // No other source file writes the key; the type says 1 and only 1.
    for (const f of sourceFiles()) {
      if (f === "core.ts") continue;
      const src = code(read(f));
      if (f === "types.ts") expect(src.match(/\blp\??\s*:[^;]*;/g)).toEqual(["lp?: 1;"]);
      else expect(src, f).not.toMatch(/\blp\??\s*:/);
    }
    // Not part of what rides on a conversion.
    const prov = /export interface Provenance \{[\s\S]*?\n\}/.exec(read("types.ts"))?.[0] ?? "";
    expect(prov).not.toBe("");
    expect(prov).not.toMatch(/\blp\b/);
  });

  it("static: tagIsLate reads no time, no duration and no count", () => {
    const src = code(read("late-tag.ts"));
    expect(src).not.toMatch(/startTime|duration|timeOrigin|\.now\(|Date\b|timing/i);
    // The paint entries are asked one thing: is there any.
    expect(src.match(/getEntriesByType\([^)]*\)[^;]*;/g)).toEqual([
      'getEntriesByType("paint").length > 0;',
    ]);
    expect(src.match(/\.length\b/g)).toHaveLength(1);
    expect(src).toMatch(/\): boolean \{/);
  });

  it("three paint entries or one, early or late: the payload is the same 1", async () => {
    const bodies: string[] = [];
    for (const entries of [
      [{ name: "first-paint", startTime: 12, duration: 0 }],
      [
        { name: "first-paint", startTime: 3200, duration: 5 },
        { name: "first-contentful-paint", startTime: 3300, duration: 9 },
        { name: "first-contentful-paint", startTime: 9999, duration: 1 },
      ],
    ]) {
      sent = [];
      tab = new Map();
      paint = entries;
      page({ late: false });
      await boot();
      await vi.advanceTimersByTimeAsync(15_000);
      const skipped = events("personalization_skipped")[0]?.body ?? {};
      expect(skipped.lp).toBe(1);
      const { visit: _visit, ...rest } = skipped;
      bodies.push(JSON.stringify(rest));
      // The random visit marker is taken out first: 32 hex digits can hold
      // "3200" or "9999" by chance, which made this test fail now and then.
      const raw = sent
        .map((s) => s.raw)
        .join("")
        .replace(/[0-9a-f]{32}/g, "");
      expect(raw).not.toMatch(/3200|3300|9999|startTime|duration/);
    }
    expect(bodies[0]).toBe(bodies[1]);
  });
});

describe("prefers-reduced-motion is read for the fade and goes nowhere (the privacy review's standing note)", () => {
  const QUERY = 'matchMedia("(prefers-reduced-motion:reduce)")';

  it("static: the only read of the media query in the source is the early return of easeIn in boot.ts", () => {
    const files = sourceFiles();
    expect(files).toContain("boot.ts");
    // Named in code by one file only (a comment may name it anywhere).
    const naming = files.filter((f) => /reduced?[-_ ]?motion|prefers-reduced/i.test(code(read(f))));
    expect(naming).toEqual(["boot.ts"]);

    const boot = code(read("boot.ts"));
    // One line, and the line is a branch: the answer is never bound to a
    // name, never returned, never passed on.
    const lines = boot
      .split("\n")
      .filter((l) => /reduced?[-_ ]?motion/i.test(l))
      .map((l) => l.trim());
    expect(lines).toEqual([`if (${QUERY}.matches) return;`]);
    // The branch is easeIn's own, and easeIn gives nothing back.
    const ease = /export function easeIn\([^)]*\): void \{[\s\S]*?\n\}/.exec(boot)?.[0] ?? "";
    expect(ease).toContain(QUERY);
    expect(ease).not.toMatch(/\breturn\s+[^;\s]/);
    // boot.ts has no way to store or send anything at all.
    expect(boot).not.toMatch(
      /sessionStorage|localStorage|\.cookie|indexedDB|fetch\(|sendBeacon|XMLHttpRequest|WebSocket|fireEvent|searchParams|postMessage/,
    );
    expect(boot.match(/^import .*$/gm)).toEqual(['import { withNonce } from "./nonce.ts";']);
    // Its one caller uses it as a statement, on the parts it held hidden
    // (the reveal, start.ts, since the boot and core split).
    const index = code(read("start.ts"));
    expect(index.match(/[^\n]*\beaseIn\([^\n]*/g)?.map((l) => l.trim())).toEqual(["easeIn(held);"]);
    for (const f of files.filter((x) => x !== "start.ts" && x !== "boot.ts"))
      expect(code(read(f)), f).not.toMatch(/\beaseIn\(/);

    // Every media query the source asks at all: this one, and the page's own
    // stylesheet `media` while waiting for its CSS (early.ts). A new read
    // fails here and gets a review.
    const asks = files.flatMap((f) =>
      (code(read(f)).match(/matchMedia\s*\([^\n]*?\)\.matches/g) ?? []).map((m) => `${f}: ${m}`),
    );
    expect(asks).toEqual([
      `boot.ts: ${QUERY}.matches`,
      'early.ts: matchMedia(l.media || "all").matches',
    ]);
    const every = files.flatMap((f) => code(read(f)).match(/matchMedia/g) ?? []);
    expect(every).toHaveLength(2);
  });

  it("a visitor who asked for less motion and one who did not: the same events, the same tab, the same requests", async () => {
    const runs: string[] = [];
    const fades: number[] = [];
    for (const reduce of [true, false]) {
      vi.setSystemTime(new Date("2026-10-12T00:00:00Z"));
      sent = [];
      asked = [];
      wrote = [];
      tab = new Map();
      const w = page({ late: false });
      // The block's own entrance is over, so the parts we held would fade in.
      const queries: string[] = [];
      let animated = 0;
      const proto = w.Element.prototype as unknown as Record<string, unknown>;
      proto.getAnimations = () => [];
      proto.animate = () => {
        animated++;
        return {};
      };
      const computed = w.getComputedStyle.bind(w);
      vi.stubGlobal("getComputedStyle", (el: Element) => {
        const cs = computed(el);
        return new Proxy(cs, {
          get: (t, k) =>
            k === "animationName"
              ? el.matches(".hero-content")
                ? "enter"
                : "none"
              : (t as unknown as Record<string | symbol, unknown>)[k],
        });
      });
      vi.stubGlobal("matchMedia", (q: string) => {
        queries.push(q);
        return { matches: /prefers-reduced-motion:\s*reduce/.test(q) && reduce };
      });
      await boot();
      await vi.advanceTimersByTimeAsync(40_000);
      expect(text("h1")).toBe("New headline");
      expect(queries).toContain("(prefers-reduced-motion:reduce)");
      fades.push(animated);
      const all = JSON.stringify({
        events: sent.map((s) => s.raw),
        requests: asked,
        tab: [...tab.entries()].sort(),
        wrote,
      }).replace(/[0-9a-f]{32}/g, "VISIT");
      expect(all).not.toMatch(/reduce|motion/i);
      runs.push(all);
    }
    // The preference did its one job, locally: no fade, or a fade.
    expect(fades[0]).toBe(0);
    expect(fades[1]).toBeGreaterThan(0);
    // And it changed nothing that is sent or kept.
    expect(runs[0]).toBe(runs[1]);
    expect(runs[0]).toContain("variant_shown");
  });
});
