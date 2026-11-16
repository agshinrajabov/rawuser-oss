/**
 * A page with no versions of its own, and a pass that ends when the path
 * changes under it (docs/specs/quiet-swap.md §2b, pilot-gaps.md F8).
 *
 * 1. Under a script that lists the confirmed pages (`p`), a page that is not
 *    among them is left as built: nothing hidden, nothing written, no cap,
 *    no `rich.js`, no early copy, on a full load and on a client-side
 *    navigation alike. The edge is still asked, once: the carry, the arm, the
 *    counted buttons and the exposure are as before, the skip is `missing`
 *    and never carries `lp`.
 * 2. A customer with no confirmed page, and a script that does not list the
 *    pages (from before the edge sent `p`), are as before.
 * 3. A pass whose path is no longer the tab's removes its hide, stops its
 *    timer, writes nothing, sends no exposure and drops its issues. The new
 *    path's pass is the only one that speaks (the wrong-page `variant_shown`
 *    of 2026-10-08).
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreScriptOnly, isCoreScript, pageMarkup } from "./helpers.ts";

const EDGE = "https://edge.test";
const HERO = (headline = "Old headline") =>
  `<main><h1 class="hero">${headline}</h1><p class="lead">Old body</p><a class="cta" href="#">Start</a></main>`;

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
/** The home page's version, as the edge's cascade offers it on any path. */
const treat = {
  source: "kv",
  cohort: "personalized",
  arm: "treat",
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
  conversion_targets: CONV,
};
const holdout = {
  source: "holdout",
  cohort: "holdout",
  arm: "holdout",
  variant_key: "",
  variant: null,
  selection,
  conversion_targets: CONV,
};
const original = { source: "original", cohort: "no_signal", variant_key: "", variant: null };

/** A hand-tagged page: no manifest, the parts carry their own names. */
const TAGGED = `<main><h1 data-rawuser="hero.headline">Old headline</h1><p data-rawuser="hero.body">Old body</p></main>`;

/** A pilot site: three confirmed pages, the rest of the site has no versions. */
const LISTED = {
  h: { "/": ["h1.hero", "p.lead"], "/az": ["h1.hero"] },
  p: ["/", "/az", "/approach"],
};
/** The same customer under a script from before the edge listed the pages. */
const UNLISTED = { h: LISTED.h };

interface Sent {
  body: Record<string, unknown>;
}

let tab: Map<string, string>;
let sent: Sent[];
let asked: string[];
let selectReply: (call: number) => Promise<Response>;
let selectCalls: number;

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
  html?: string;
  /** The page was painted before our script ran. */
  late?: boolean;
  cfg?: Record<string, unknown>;
}

/** One page of the tab: a new document, a new copy of the snippet, the same sessionStorage. */
function page(o: PageOpts = {}) {
  vi.resetModules();
  // The previous document's timers died with it.
  vi.clearAllTimers();
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>${o.html ?? HERO()}</body></html>`,
    {
      url: o.url ?? "https://site.test/?utm_source=chatgpt.com",
    },
  );
  const w = dom.window;
  Object.defineProperty(w.document, "readyState", {
    value: o.late ? "complete" : "loading",
    configurable: true,
  });
  vi.stubGlobal("window", w);
  vi.stubGlobal("document", w.document);
  vi.stubGlobal("location", w.location);
  vi.stubGlobal("history", w.history);
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => tab.get(k) ?? null,
    setItem: (k: string, v: string) => void tab.set(k, v),
    removeItem: (k: string) => void tab.delete(k),
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
  (w as unknown as { __rw: unknown }).__rw = { c: "acme", e: EDGE, ...(o.cfg ?? LISTED) };
  vi.stubGlobal("fetch", (u: string, init?: RequestInit) => {
    asked.push(u);
    if (u.startsWith(`${EDGE}/select`)) return selectReply(++selectCalls);
    if (u.startsWith(`${EDGE}/carry`)) return Promise.resolve(json({ bodies: {} }));
    if (u.startsWith(`${EDGE}/event`)) {
      sent.push({ body: JSON.parse(String(init?.body ?? "")) as Record<string, unknown> });
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return w;
}

async function boot(): Promise<void> {
  await import("../src/index.ts");
}

/** The router: the address changes and the new route is rendered in place. */
function go(path: string, html: string | null = HERO()): void {
  history.pushState({}, "", path);
  if (html !== null) (document.querySelector("main") as Element).outerHTML = html;
}

const events = (type: string) => sent.filter((s) => s.body.event_type === type);
const exposures = () =>
  sent
    .filter((s) =>
      ["variant_shown", "personalization_skipped", "no_signal_passthrough"].includes(
        String(s.body.event_type),
      ),
    )
    .map((s) => [s.body.event_type, s.body.page_path]);
const issues = () =>
  events("snippet_issue").flatMap(
    (s) => (s.body.properties as { issues: Array<Record<string, unknown>> }).issues,
  );
const selects = () => asked.filter((u) => u.startsWith(`${EDGE}/select`));
const text = (sel: string) => document.querySelector(sel)?.textContent;
const hide = () => document.getElementById("__rawuser-hide") as HTMLStyleElement | null;
/** The selectors our style hides now (none when there is no style). */
const hidden = () =>
  Array.from(hide()?.sheet?.cssRules ?? [])
    .map((r) => (r as CSSStyleRule).selectorText)
    .filter(Boolean);
const scripts = () =>
  Array.from(document.querySelectorAll("script"))
    .filter((s) => !isCoreScript(s))
    .map((s) => s.src);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  tab = new Map();
  sent = [];
  asked = [];
  selectCalls = 0;
  selectReply = () => answerAfter(200, treat);
});

afterEach(() => {
  vi.doUnmock("../src/rich-api.ts");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a full load of a page that is not the site's own", () => {
  const URL_ = "https://site.test/insights?utm_source=chatgpt.com";

  it("nothing is hidden and nothing is written, at any moment of the load", async () => {
    page({ url: URL_, cfg: { ...LISTED, x: ["/"] } });
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
    for (const ms of [0, 100, 150, 1300, 2000, 40_000]) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(hide()).toBeNull();
      expect(text("h1")).toBe("Old headline");
      expect(text("p")).toBe("Old body");
    }
    // Not one mutation of the document: no style, no text, no rich.js tag.
    expect([...seen]).toEqual([]);
    expect(pageMarkup(document)).toBe(before);
    expect(scripts()).toEqual([]);
    mo.disconnect();
  });

  it("one /select, no reveal_cap after two seconds, the skip is `missing` for this page", async () => {
    // The edge never answers inside the cap a hidden page would have had.
    selectReply = () => answerAfter(1800, treat);
    page({ url: URL_ });
    await boot();
    await vi.advanceTimersByTimeAsync(2000);
    expect(selects()).toHaveLength(1);
    expect(new URL(selects()[0] ?? "").searchParams.get("path")).toBe("/insights");
    await vi.advanceTimersByTimeAsync(40_000);
    expect(selects()).toHaveLength(1);
    expect(events("snippet_issue")).toHaveLength(0);
    expect(events("variant_shown")).toHaveLength(0);
    const skips = events("personalization_skipped");
    expect(skips).toHaveLength(1);
    expect(skips[0]?.body).toMatchObject({
      page_path: "/insights",
      kind: "missing",
      cohort: "skipped",
      variant_key: treat.variant_key,
      intent_dim: "problem",
      source_dim: "ai",
      arm: "treat",
    });
    expect(skips[0]?.body.visit).toMatch(/^[0-9a-f]{32}$/);
  });

  it("the skip says `missing` whatever the last write on another page said", async () => {
    // A headline cut into letters on the home page: that pass's reason is `split`.
    const letters = Array.from("Old headline")
      .map((c) => `<span>${c}</span>`)
      .join("");
    const w = page({ html: `<main><h1 class="hero">${letters}</h1></main>` });
    selectReply = () =>
      answerAfter(100, {
        ...treat,
        variant: {
          ...treat.variant,
          sections: { hero: { kind: "hero", headline: "New headline" } },
        },
        targets: { "hero.headline": part("h1.hero") },
      });
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(events("personalization_skipped")[0]?.body.kind).toBe("split");
    sent = [];
    w.history.pushState({}, "", "/insights");
    await vi.advanceTimersByTimeAsync(3000);
    expect(events("personalization_skipped")[0]?.body).toMatchObject({
      page_path: "/insights",
      kind: "missing",
    });
  });

  it("the visit keeps its carry, the counted button counts as `skipped`", async () => {
    page({ url: URL_ });
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(JSON.parse(tab.get("__rw_carry") ?? "{}")).toMatchObject({ i: "problem", s: "ai" });
    (document.querySelector("a.cta") as HTMLElement).click();
    expect(events("conversion")).toHaveLength(1);
    expect(events("conversion")[0]?.body).toMatchObject({
      page_path: "/insights",
      cohort: "skipped",
      conversion_label: "signup",
      arm: "treat",
    });
  });

  it("the holdout arm records its exposure and counts its button, as before", async () => {
    selectReply = () => answerAfter(200, holdout);
    page({ url: URL_ });
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(hide()).toBeNull();
    expect(events("variant_shown")).toHaveLength(1);
    expect(events("variant_shown")[0]?.body).toMatchObject({
      page_path: "/insights",
      cohort: "holdout",
      arm: "holdout",
    });
    (document.querySelector("a.cta") as HTMLElement).click();
    expect(events("conversion")[0]?.body).toMatchObject({ cohort: "holdout" });
  });

  it("a visit with no signal is the no-signal exposure, as before", async () => {
    selectReply = () => answerAfter(200, original);
    page({ url: "https://site.test/insights" });
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(exposures()).toEqual([["no_signal_passthrough", "/insights"]]);
    expect(events("snippet_issue")).toHaveLength(0);
  });

  it("a tag that ran after the paint: no late_tag and no lp, in either arm", async () => {
    // The home page's parts are on this page too (a shared hero class).
    page({ url: URL_, late: true });
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(events("personalization_skipped")[0]?.body).toMatchObject({ kind: "missing" });
    expect(events("personalization_skipped")[0]?.body).not.toHaveProperty("lp");
    sent = [];
    selectCalls = 0;
    selectReply = () => answerAfter(200, holdout);
    page({ url: URL_, late: true });
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(events("variant_shown")).toHaveLength(1);
    expect(events("variant_shown")[0]?.body).not.toHaveProperty("lp");
    expect(events("snippet_issue")).toHaveLength(0);
  });

  it("a copy the tab kept for this path is not written early", async () => {
    // The page was confirmed when the visit's first load kept its copy.
    selectReply = () => answerAfter(100, { ...treat, carryable: true });
    page({ url: URL_, cfg: { h: LISTED.h, p: [...LISTED.p, "/insights"] } });
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(text("h1")).toBe("New headline");
    expect(tab.get("__rw_body")).toContain("/insights");
    // A later load of it, no signal of its own, under a script that no
    // longer lists it.
    sent = [];
    asked = [];
    page({ url: "https://site.test/insights" });
    await boot();
    expect(text("h1")).toBe("Old headline");
    await vi.advanceTimersByTimeAsync(3000);
    expect(new URL(selects()[0] ?? "").searchParams.has("bc")).toBe(false);
    expect(text("h1")).toBe("Old headline");
    expect(exposures()).toEqual([["personalization_skipped", "/insights"]]);
  });
});

describe("a client-side navigation to a page that is not the site's own", () => {
  it("no hide for the home page's parts, one /select, no write, no reveal_cap, `missing`", async () => {
    page();
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(text("h1")).toBe("New headline");
    expect(exposures()).toEqual([["variant_shown", "/"]]);
    sent = [];
    asked = [];
    // The route has the same hero classes and never the home page's words.
    // Its paragraph reads as the home page's did: the hold of the page that
    // was left (its observer, and its timed look at 4.5 s) must not write it.
    go("/insights", HERO("Insights"));
    for (const ms of [0, 50, 100, 400, 1500, 2000, 40_000]) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(hide()).toBeNull();
      expect(text("h1")).toBe("Insights");
      expect(text("p")).toBe("Old body");
    }
    expect(selects()).toHaveLength(1);
    expect(new URL(selects()[0] ?? "").searchParams.get("path")).toBe("/insights");
    expect(events("snippet_issue")).toHaveLength(0);
    expect(exposures()).toEqual([["personalization_skipped", "/insights"]]);
    expect(events("personalization_skipped")[0]?.body).toMatchObject({
      kind: "missing",
      cohort: "skipped",
    });
  });

  it("and back to a confirmed page: hidden and written again", async () => {
    selectReply = (n) => answerAfter(100, n === 1 ? original : treat);
    page({ url: "https://site.test/insights" });
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    sent = [];
    go("/", HERO());
    expect(hidden()).toEqual(["[data-rawuser]", "h1.hero", "p.lead"]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(text("h1")).toBe("New headline");
    expect(hide()).toBeNull();
    expect(exposures()).toEqual([["variant_shown", "/"]]);
  });
});

describe("which pages are the site's own", () => {
  it("a listed page with no rule of its own is written, and hides nothing of the home page's", async () => {
    page({ url: "https://site.test/approach?utm_source=chatgpt.com" });
    await boot();
    // Only the tagged-parts rule: `/approach` has no entry in `h`.
    expect(hidden()).toEqual(["[data-rawuser]"]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(text("h1")).toBe("New headline");
    expect(exposures()).toEqual([["variant_shown", "/approach"]]);
  });

  it("a page with rules is the site's own even when the list does not name it yet", async () => {
    page({
      url: "https://site.test/pricing?utm_source=chatgpt.com",
      cfg: { h: { ...LISTED.h, "/pricing": ["h1.hero"] }, p: LISTED.p },
    });
    await boot();
    expect(hidden()).toEqual(["[data-rawuser]", "h1.hero"]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(text("h1")).toBe("New headline");
    expect(exposures()).toEqual([["variant_shown", "/pricing"]]);
  });

  it.each([
    ["no rules at all", {}],
    ["empty rules and an empty list", { h: {}, p: [] }],
  ])(
    "a hand-tagged customer (%s): any page is hidden, capped and written as before",
    async (_n, cfg) => {
      page({
        url: "https://site.test/anything?utm_source=chatgpt.com",
        html: TAGGED,
        cfg,
      });
      selectReply = () => answerAfter(200, { ...treat, targets: undefined });
      await boot();
      expect(hidden()).toEqual(["[data-rawuser]"]);
      await vi.advanceTimersByTimeAsync(3000);
      expect(text("h1")).toBe("New headline");
      expect(exposures()).toEqual([["variant_shown", "/anything"]]);
      // And its cap still runs when the edge is slow.
      sent = [];
      selectReply = () => answerAfter(2500, treat);
      page({
        url: "https://site.test/anything?utm_source=chatgpt.com",
        html: TAGGED,
        cfg,
      });
      await boot();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(issues()).toEqual([{ c: "reveal_cap", n: 1 }]);
      expect(events("personalization_skipped")[0]?.body.kind).toBe("late");
    },
  );

  it("a script that does not list the pages: the home page's rules on any path, as before", async () => {
    page({ url: "https://site.test/insights?utm_source=chatgpt.com", cfg: UNLISTED });
    await boot();
    expect(hidden()).toEqual(["[data-rawuser]", "h1.hero", "p.lead"]);
    await vi.advanceTimersByTimeAsync(3000);
    // The home page's parts happen to be here: written, as today.
    expect(text("h1")).toBe("New headline");
    sent = [];
    // A route without them is tried until the cap, as today.
    go("/work", "<main><h2>Work</h2></main>");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(issues()).toEqual([{ c: "reveal_cap", n: 2 }]);
    expect(events("personalization_skipped")[0]?.body).toMatchObject({
      page_path: "/work",
      kind: "late",
    });
  });
});

describe("a pass ends when the path changes under it", () => {
  it("a navigation while the edge is asked: the first pass writes nothing, sends nothing, its hide is gone; the second writes once", async () => {
    selectReply = (n) => answerAfter(n === 1 ? 800 : 100, treat);
    page();
    await boot();
    const first = hide();
    expect(hidden()).toEqual(["[data-rawuser]", "h1.hero", "p.lead"]);
    await vi.advanceTimersByTimeAsync(300);
    go("/az", HERO("Köhnə başlıq"));
    // In the same task: the first pass's style is out, the new route's is in.
    expect(first?.isConnected).toBe(false);
    expect(document.querySelectorAll("#__rawuser-hide")).toHaveLength(1);
    expect(hidden()).toEqual(["[data-rawuser]", "h1.hero"]);
    await vi.advanceTimersByTimeAsync(400);
    expect(text("h1")).toBe("New headline");
    expect(hide()).toBeNull();
    // The first pass's answer lands now, on a page that is not its own.
    document.querySelector("h1.hero")?.replaceChildren("Köhnə başlıq");
    await vi.advanceTimersByTimeAsync(40_000);
    expect(selects()).toHaveLength(2);
    expect(exposures()).toEqual([["variant_shown", "/az"]]);
    expect(events("snippet_issue")).toHaveLength(0);
    expect(sent.every((s) => s.body.page_path === "/az")).toBe(true);
  });

  it("leaves no rule and no timer of its own behind: nothing hidden, nothing reported, later", async () => {
    // The edge does not answer the first pass at all (our own 5 s timeout).
    selectReply = (n) => (n === 1 ? new Promise<Response>(() => {}) : answerAfter(100, treat));
    page();
    await boot();
    expect(hide()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    go("/insights", HERO("Insights"));
    for (const ms of [0, 100, 1300, 1500, 2500, 5000, 40_000]) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(hide()).toBeNull();
      expect(text("h1")).toBe("Insights");
    }
    // No reveal_cap from the first pass's timer, no select_failed from its
    // timeout, no exposure for the page that was left.
    expect(events("snippet_issue")).toHaveLength(0);
    expect(exposures()).toEqual([["personalization_skipped", "/insights"]]);
  });

  it("the wrong-page variant_shown of 2026-10-08: /insights then / inside the retry window is one variant_shown, for /", async () => {
    selectReply = (n) => answerAfter(100, n === 1 ? original : treat);
    // A script from before the list: the pass for /insights tries for the
    // home page's parts every 100 ms, which is how production saw it.
    page({ url: "https://site.test/work", html: "<main><h2>Work</h2></main>", cfg: UNLISTED });
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    sent = [];
    go("/insights", "<main><h2>Insights</h2></main>");
    await vi.advanceTimersByTimeAsync(600);
    expect(hide()).not.toBeNull();
    // The router renders the home page while that pass is still trying.
    go("/", HERO());
    await vi.advanceTimersByTimeAsync(40_000);
    expect(text("h1")).toBe("New headline");
    expect(exposures()).toEqual([["variant_shown", "/"]]);
    expect(events("snippet_issue")).toHaveLength(0);
    expect(sent.some((s) => s.body.page_path === "/insights")).toBe(false);
  });

  it("a pass that left and came back to its own path stays ended", async () => {
    selectReply = (n) => answerAfter(n === 1 ? 900 : 100, treat);
    page();
    await boot();
    await vi.advanceTimersByTimeAsync(100);
    go("/az", HERO("Köhnə başlıq"));
    await vi.advanceTimersByTimeAsync(100);
    go("/", HERO());
    await vi.advanceTimersByTimeAsync(40_000);
    // Three asks (the route left in between asked too); one pass spoke.
    expect(exposures()).toEqual([["variant_shown", "/"]]);
    expect(text("h1")).toBe("New headline");
    expect(events("snippet_issue")).toHaveLength(0);
  });

  it("two navigations in a row: the route in between asks nothing and says nothing", async () => {
    selectReply = (n) => answerAfter(100, n === 1 ? original : treat);
    page({ url: "https://site.test/" });
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    sent = [];
    asked = [];
    go("/approach", null);
    go("/az", HERO("Köhnə başlıq"));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(selects().map((u) => new URL(u).searchParams.get("path"))).toEqual(["/az"]);
    expect(exposures()).toEqual([["variant_shown", "/az"]]);
  });

  it("the landing's carry is the visit's: kept though its pass ended, with no exposure for it", async () => {
    selectReply = (n) => answerAfter(n === 1 ? 500 : 100, n === 1 ? treat : original);
    page();
    await boot();
    await vi.advanceTimersByTimeAsync(200);
    go("/az", HERO("Köhnə başlıq"));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(JSON.parse(tab.get("__rw_carry") ?? "{}")).toMatchObject({ i: "problem", s: "ai" });
    expect(tab.has("__rw_body")).toBe(false);
    expect(text("h1")).toBe("Köhnə başlıq");
    expect(exposures()).toEqual([["no_signal_passthrough", "/az"]]);
    // The ended pass counted no button either: the new page has none.
    (document.querySelector("a.cta") as HTMLElement).click();
    expect(events("conversion")).toHaveLength(0);
  });

  it("a deleted customer's answer to an ended pass still clears the tab, and no later pass asks", async () => {
    // The first page's answer says off; the route in between was answered before it.
    selectReply = (n) => answerAfter(n === 1 ? 500 : 100, n === 1 ? { off: 1 } : treat);
    page();
    await boot();
    await vi.advanceTimersByTimeAsync(200);
    go("/az", HERO("Köhnə başlıq"));
    await vi.advanceTimersByTimeAsync(250);
    expect(tab.has("__rw_carry")).toBe(true);
    // The off answer lands on a pass whose page was left.
    await vi.advanceTimersByTimeAsync(200);
    expect([...tab.keys()].filter((k) => k.startsWith("__rw"))).toEqual([]);
    const before = sent.length;
    go("/approach");
    await vi.advanceTimersByTimeAsync(40_000);
    expect(selects()).toHaveLength(2);
    expect(sent).toHaveLength(before);
  });

  it("what an ended pass had noted is dropped: no late_tag, no lp, for the page that was left", async () => {
    selectReply = (n) => answerAfter(n === 1 ? 800 : 100, treat);
    page({ late: true });
    await boot();
    await vi.advanceTimersByTimeAsync(300);
    go("/az", HERO("Köhnə başlıq"));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(events("snippet_issue")).toHaveLength(0);
    expect(exposures()).toEqual([["variant_shown", "/az"]]);
    expect(sent.some((s) => "lp" in s.body)).toBe(false);
  });

  it("a cap that fired before the navigation is dropped with its pass", async () => {
    selectReply = (n) => answerAfter(n === 1 ? 4000 : 100, treat);
    page();
    await boot();
    await vi.advanceTimersByTimeAsync(2000);
    expect(hide()).toBeNull();
    go("/az", HERO("Köhnə başlıq"));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(events("snippet_issue")).toHaveLength(0);
    expect(exposures()).toEqual([["variant_shown", "/az"]]);
  });

  it("a pass that was over keeps its issues: sent for its own page when the visitor moves on", async () => {
    selectReply = (n) =>
      n === 1 ? Promise.resolve(new Response("no", { status: 500 })) : answerAfter(100, original);
    page();
    await boot();
    await vi.advanceTimersByTimeAsync(300);
    expect(events("snippet_issue")).toHaveLength(0);
    go("/az", HERO("Köhnə başlıq"));
    expect(events("snippet_issue")).toHaveLength(1);
    expect(events("snippet_issue")[0]?.body.page_path).toBe("/");
    expect(issues()).toEqual([{ c: "select_failed", n: 3 }]);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(events("snippet_issue")).toHaveLength(1);
  });

  it("a navigation in the frames between the write and the reveal: the pass has spoken, it is revealed at once", async () => {
    selectReply = () => answerAfter(100, treat);
    // A page that fits its font to our lines: the reveal waits its 120 ms.
    vi.doMock("../src/rich-api.ts", async (orig) => ({
      ...(await orig<typeof import("../src/rich-api.ts")>()),
      linesSettled: () => new Promise<void>(() => {}),
    }));
    page();
    await boot();
    // The answer and the write, not yet the 120 ms the reveal waits.
    await vi.advanceTimersByTimeAsync(110);
    expect(text("h1")).toBe("New headline");
    expect(exposures()).toEqual([["variant_shown", "/"]]);
    const first = hide();
    expect(first).not.toBeNull();
    go("/insights", HERO("Insights"));
    expect(first?.isConnected).toBe(false);
    expect(hide()).toBeNull();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(exposures()).toEqual([
      ["variant_shown", "/"],
      ["personalization_skipped", "/insights"],
    ]);
  });

  it("a navigation during the hydration wait: nothing is written when React is done, the hydration cap never fires", async () => {
    selectReply = () => answerAfter(200, treat);
    const w = page();
    (w as unknown as { __NEXT_DATA__: unknown }).__NEXT_DATA__ = {};
    await boot();
    // The version is in hand, the parts wait hidden for React.
    await vi.advanceTimersByTimeAsync(1000);
    expect(hide()).not.toBeNull();
    expect(text("h1")).toBe("Old headline");
    go("/insights", HERO("Insights"));
    expect(hide()).toBeNull();
    for (const el of document.querySelectorAll("h1, p")) {
      (el as unknown as Record<string, unknown>).__reactFiber$abc = {};
    }
    await vi.advanceTimersByTimeAsync(40_000);
    expect(text("h1")).toBe("Insights");
    expect(text("p")).toBe("Old body");
    expect(events("snippet_issue")).toHaveLength(0);
    expect(exposures()).toEqual([["personalization_skipped", "/insights"]]);
    // The landing's two words were kept when its answer came, before the wait.
    expect(JSON.parse(tab.get("__rw_carry") ?? "{}")).toMatchObject({ i: "problem", s: "ai" });
  });

  it("an event is filed under the path its pass started on", async () => {
    selectReply = () => answerAfter(300, treat);
    page({ url: "https://site.test/Approach/?utm_source=chatgpt.com" });
    await boot();
    await vi.advanceTimersByTimeAsync(100);
    // The same page under another spelling: no new pass, the pass goes on.
    history.replaceState({}, "", "/approach");
    await vi.advanceTimersByTimeAsync(3000);
    expect(selects()).toHaveLength(1);
    expect(exposures()).toEqual([["variant_shown", "/Approach/"]]);
  });
});

describe("no regression of the client-side route", () => {
  it("a confirmed route whose elements render late is still written by the retry", async () => {
    selectReply = (n) => answerAfter(100, n === 1 ? original : treat);
    page({ url: "https://site.test/" });
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    sent = [];
    go("/az", "<main><p>Loading</p></main>");
    expect(hidden()).toEqual(["[data-rawuser]", "h1.hero"]);
    // The router renders the hero 700 ms in, inside the 1,500 ms cap.
    setTimeout(() => {
      (document.querySelector("main") as Element).outerHTML = HERO("Köhnə başlıq");
    }, 700);
    await vi.advanceTimersByTimeAsync(650);
    expect(hide()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(text("h1")).toBe("New headline");
    expect(hide()).toBeNull();
    expect(exposures()).toEqual([["variant_shown", "/az"]]);
    expect(events("snippet_issue")).toHaveLength(0);
  });
});
