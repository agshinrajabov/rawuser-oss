/**
 * A carried return to a page (docs/specs/pilot-gaps.md, A6;
 * docs/specs/session-carry.md, "A carried return").
 *
 * the pilot's site, 2026-10-12, 3 of 3: a visit lands on `/` with a signal and gets
 * a version, goes to `/products`, comes back to `/`. On the return
 * 1. the hero button kept the page's own label while the other parts were
 *    rewritten;
 * 2. the headline and the paragraph took their first length, unmeasured (the
 *    paragraph 2 lines to 1 at 1280, the headline 3 to 2 at 390; the first
 *    visit had kept the length the fit check chose);
 * 3. the load still said `variant_shown`, personalized, `body_carry`, and
 *    nothing reported the part left as built.
 *
 * The whole flow runs here against the real entry (index.ts), the real
 * early write and the real body carry, on a page with a layout jsdom does
 * not have: a box is as tall as its words need at a fixed line length.
 * Nothing new is kept in the tab and nothing new is sent: the test reads
 * `__rw_body` and every request to say so.
 *
 * A10 (the recheck of 2026-10-12): the return was fitted only when the edge
 * confirmed, after the first paint, so at 390 the hidden parts grew 70 px at
 * the reveal and the button under them moved 34 px. The fit now runs behind
 * the hide as soon as the page's stylesheets are in: at the write, or when
 * the last of them loads.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsing } from "./helpers.ts";

const EDGE = "https://edge.test";

const OWN = {
  headline: "Vitamins and supplements made for the way you live every day",
  body: "Every capsule is produced and checked in our own plant, so you know what you take.",
  label: "Get to know our products",
};
// The first length is far under the page's own; the third holds its lines.
const COPY = {
  headline: "Supplements that fit your day",
  headline_alt: "Daily supplements",
  headline_alt2: "Vitamins and supplements built around the way you live",
  body: "Made in our own plant.",
  body_alt: "Made by us.",
  body_alt2: "Every capsule is made and tested in our own plant, so you always know.",
  label: "See the products",
};
const sections = {
  hero: {
    kind: "hero",
    headline: COPY.headline,
    headline_alt: COPY.headline_alt,
    headline_alt2: COPY.headline_alt2,
    body: COPY.body,
    body_alt: COPY.body_alt,
    body_alt2: COPY.body_alt2,
    cta: { label: COPY.label },
  },
};
const part = (css: string) => ({ css: [css], text: [], structural: "" });
const targets = {
  "hero.headline": part("h1.hero"),
  "hero.body": part("p.lead"),
  "hero.cta.label": part("a.btn"),
};
/** The manifest after the button was taken out of it. */
const withoutButton = {
  "hero.headline": targets["hero.headline"],
  "hero.body": targets["hero.body"],
};

const personalized = {
  source: "kv",
  cohort: "personalized",
  variant_key: "v1:variant:acme:problem:ai",
  selection: { intent_dim: "problem", source_dim: "ai", confidence: 0.8 },
  variant: {
    customer_id: "acme",
    profile_key: "intent:problem",
    sections,
    generated_at: 0,
    prompt_hash: "",
  },
  targets,
  carryable: true,
};

const HTML = `<section><h1 class="hero">${OWN.headline}</h1><p class="lead">${OWN.body}</p><div class="row"><a class="btn" href="/products">${OWN.label}</a></div></section>`;

interface Sent {
  raw: string;
  body: Record<string, unknown>;
}

/** What the tab keeps from one page to the next. */
let tab: Map<string, string>;
let sent: Sent[];
let selects: string[];
let selectReply: () => Promise<Response>;
let carryReply: () => unknown;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
const answerAfter = (ms: number, body: unknown) =>
  new Promise<Response>((r) => setTimeout(() => r(json(body)), ms));

/** A line holds this many characters; a box is its lines times its line height. */
const WIDE = { H1: [24, 44], P: [60, 25] } as const;
let LINE: { H1: readonly [number, number]; P: readonly [number, number] } = WIDE;
const words = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
function linesOf(el: Element): number {
  const [chars] = LINE[el.tagName as "H1" | "P"] ?? [40];
  return Math.max(1, Math.ceil(words(el).length / chars));
}
function heightOf(el: Element): number {
  // The button's row: one row, or two when the label is long.
  if (el.className === "row") return words(el).length > 30 ? 92 : 62;
  const [, lineHeight] = LINE[el.tagName as "H1" | "P"] ?? [40, 20];
  return linesOf(el) * lineHeight;
}

/**
 * One page of the tab: a new document, a new copy of the snippet, the same
 * sessionStorage. `head` is what the page links before the hero (jsdom
 * loads no stylesheet, so a linked one stays "still loading" until
 * `sheetLoads`).
 */
function page(url: string, referrer = "", html = HTML, head = "") {
  vi.resetModules();
  const dom = new JSDOM(`<!doctype html><html><head>${head}</head><body>${html}</body></html>`, {
    url,
    ...(referrer ? { referrer } : {}),
  });
  const w = dom.window;
  parsing(w.document);
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q !== "print" }));
  w.Element.prototype.getBoundingClientRect = function (this: Element) {
    return { height: heightOf(this), width: 400, top: 0, left: 0 } as DOMRect;
  };
  w.document.createRange = (() => {
    let node: Element | null = null;
    return {
      selectNodeContents(n: Element) {
        node = n;
      },
      getClientRects: () =>
        Array.from({ length: node ? linesOf(node) : 0 }, (_, i) => ({
          top: i * 44,
          width: 100,
          height: 44,
        })),
    };
  }) as unknown as Document["createRange"];
  vi.stubGlobal("window", w);
  vi.stubGlobal("document", w.document);
  vi.stubGlobal("location", w.location);
  vi.stubGlobal("history", w.history);
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => tab.get(k) ?? null,
    setItem: (k: string, v: string) => {
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
  (w as unknown as { __rw: unknown }).__rw = {
    c: "acme",
    e: EDGE,
    h: { "/": ["h1.hero", "p.lead", "a.btn"] },
  };
  vi.stubGlobal("fetch", (u: string, init?: RequestInit) => {
    if (u.startsWith(`${EDGE}/select`)) {
      selects.push(u);
      return selectReply();
    }
    if (u.startsWith(`${EDGE}/carry`)) return Promise.resolve(json({ bodies: carryReply() }));
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

const text = (sel: string) => words(document.querySelector(sel) as Element);
const hidden = () => document.getElementById("__rawuser-hide") !== null;
const events = (type: string) => sent.filter((s) => s.body.event_type === type);
const keptHome = () =>
  (JSON.parse(tab.get("__rw_body") ?? "{}") as { p?: Record<string, { targets?: object }> }).p?.[
    "/"
  ];

/** The landing: `/` with a signal, the version written and fitted, the other pages' copy fetched. */
async function land(): Promise<void> {
  page("https://site.test/?utm_source=chatgpt.com");
  selectReply = () => answerAfter(200, personalized);
  await boot();
  await vi.advanceTimersByTimeAsync(15_000);
}

/** The return: `/` again from a page of this site, no signal of its own; the edge carries the pair. */
function comeBack(html = HTML, head = "") {
  sent = [];
  selects = [];
  selectReply = () => answerAfter(200, { ...personalized, carried: true });
  return page("https://site.test/", "https://site.test/products", html, head);
}

const SHEET = `<link rel="stylesheet" href="/site.css">`;
/** The page's stylesheet arrives: the browser gives the link its sheet and fires `load` on it. */
function sheetLoads(w: { Event: typeof Event }): void {
  const link = document.querySelector("link") as HTMLLinkElement;
  Object.defineProperty(link, "sheet", { value: {}, configurable: true });
  link.dispatchEvent(new w.Event("load"));
}

/** The tab as a landing leaves it, with the copy of `/` written into `parts`. */
function carried(parts: object = targets, copy: object = sections): void {
  const t = Date.now();
  tab.set("__rw_carry", JSON.stringify({ i: "problem", s: "ai", t }));
  tab.set(
    "__rw_body",
    JSON.stringify({ i: "problem", s: "ai", t, p: { "/": { sections: copy, targets: parts } } }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  LINE = WIDE;
  tab = new Map();
  sent = [];
  selects = [];
  selectReply = () => answerAfter(200, { ...personalized, carried: true });
  // As on the pilot's site that morning: /carry reads the manifests themselves,
  // where the button was already taken out; /select's bundle still had it.
  carryReply = () => ({
    "/": { sections, targets: withoutButton, prompt_hash: "" },
    "/products": { sections: { hero: { kind: "hero", headline: "Products words" } }, targets },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the whole visit: land on /, leave, come back", () => {
  it("the return shows what the landing showed: the same lengths, the button written, the same report", async () => {
    await land();
    // The landing: the fit check kept the third length of both parts.
    const landed = { h1: text("h1"), p: text("p"), btn: text("a.btn") };
    expect(landed).toEqual({ h1: COPY.headline_alt2, p: COPY.body_alt2, btn: COPY.label });
    expect(events("variant_shown")).toHaveLength(1);
    // The other page's copy is kept for the visit; this page's own stays the
    // one the edge served here, with the button (1).
    const kept = JSON.parse(tab.get("__rw_body") ?? "{}") as { p: Record<string, unknown> };
    expect(Object.keys(kept.p).sort()).toEqual(["/", "/products"]);
    expect(Object.keys(keptHome()?.targets ?? {})).toEqual(Object.keys(targets));

    comeBack();
    await boot();
    // Written from the tab's copy as the page parses and fitted in the same
    // task, behind the hide, before the edge has said a word (A10): the
    // lengths the landing kept (2).
    expect(hidden()).toBe(true);
    expect({ h1: text("h1"), p: text("p"), btn: text("a.btn") }).toEqual(landed);
    // No `bc=1` since the boot and core split (faster-tag.md C): the boot
    // asks before the core writes the tab's copy; the event's `body_carry`
    // below is the fact.
    expect(selects[0]).not.toContain("bc=");
    expect(selects[0]).toContain("carry=problem%3Aai");

    await vi.advanceTimersByTimeAsync(300);
    // The edge confirmed the copy: shown as it already was.
    expect(hidden()).toBe(false);
    expect({ h1: text("h1"), p: text("p"), btn: text("a.btn") }).toEqual(landed);

    await vi.advanceTimersByTimeAsync(40_000);
    const shown = events("variant_shown");
    expect(shown).toHaveLength(1);
    expect(shown[0]?.body).toMatchObject({ cohort: "personalized", body_carry: 1, carried: 1 });
    expect(events("personalization_skipped")).toHaveLength(0);
    // Every part is written, so there is nothing left as built to report (3).
    expect(events("personalization_partial")).toHaveLength(0);
    expect(events("snippet_issue")).toHaveLength(0);
  });

  it("keeps nothing new in the tab and sends nothing new", async () => {
    await land();
    comeBack();
    await boot();
    await vi.advanceTimersByTimeAsync(40_000);
    expect([...tab.keys()].sort()).toEqual(["__rw_body", "__rw_carry", "__rw_visit"]);
    const body = JSON.parse(tab.get("__rw_body") ?? "{}") as {
      p: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(body).sort()).toEqual(["i", "p", "s", "t"]);
    for (const copy of Object.values(body.p)) {
      for (const k of Object.keys(copy))
        expect(["sections", "targets", "prompt_hash", "body_id"]).toContain(k);
    }
    // Which length the page kept is in no request and no event: the return
    // asks the edge with the parameters a carried page always sent, and its
    // events carry the fields they always carried.
    expect(selects).toHaveLength(1);
    expect([...new URL(selects[0] ?? "").searchParams.keys()].sort()).toEqual([
      "carry",
      "customer_id",
      "lang",
      "path",
      "self_host",
      "ss",
      "visit",
    ]);
    expect(sent.map((e) => Object.keys(e.body).sort())).toEqual([
      [
        "body_carry",
        "carried",
        "cohort",
        "event_type",
        "intent_dim",
        "page_path",
        "source_dim",
        "variant_key",
        "visit",
      ],
    ]);
    for (const e of sent) expect(e.raw).not.toMatch(/alt|length|lines|kept/);
  });
});

describe("(1) the button on a return", () => {
  it("is written from the tab's copy when the copy names it", async () => {
    carried();
    comeBack();
    await boot();
    expect(text("a.btn")).toBe(COPY.label);
    await vi.advanceTimersByTimeAsync(300);
    expect(text("a.btn")).toBe(COPY.label);
  });

  it("is written by the edge's answer when the tab's copy does not name it, and that copy is replaced", async () => {
    // What the prefetch left before the fix, and what a manifest changed in
    // the middle of a visit still leaves.
    carried(withoutButton);
    comeBack();
    await boot();
    expect(text("h1")).toBe(COPY.headline_alt2);
    expect(text("a.btn")).toBe(OWN.label);
    await vi.advanceTimersByTimeAsync(300);
    expect(hidden()).toBe(false);
    expect({ h1: text("h1"), p: text("p"), btn: text("a.btn") }).toEqual({
      h1: COPY.headline_alt2,
      p: COPY.body_alt2,
      btn: COPY.label,
    });
    await vi.advanceTimersByTimeAsync(40_000);
    // The words on the page are the edge's answer, not the tab's copy.
    const shown = events("variant_shown");
    expect(shown).toHaveLength(1);
    expect(shown[0]?.body.body_carry).toBeUndefined();
    expect(shown[0]?.body.carried).toBe(1);
    expect(events("personalization_partial")).toHaveLength(0);
    expect(Object.keys(keptHome()?.targets ?? {})).toEqual(Object.keys(targets));
  });

  it("a part the edge no longer names goes back as the page built it", async () => {
    carried();
    comeBack();
    selectReply = () =>
      answerAfter(200, { ...personalized, carried: true, targets: withoutButton });
    await boot();
    expect(text("a.btn")).toBe(COPY.label);
    await vi.advanceTimersByTimeAsync(300);
    expect(text("a.btn")).toBe(OWN.label);
    expect(text("h1")).toBe(COPY.headline_alt2);
    expect(events("variant_shown")).toHaveLength(1);
  });
});

describe("(2) the lengths on a return", () => {
  it("another copy from the edge is measured against the page's own words, not the tab's", async () => {
    // The tab holds an older copy whose headline takes one line; the page's
    // own takes three. Measured against the tab's, the one-line length wins.
    carried(targets, {
      hero: { kind: "hero", headline: "An older headline", body: "Older.", cta: { label: "Old" } },
    });
    comeBack();
    await boot();
    expect(text("h1")).toBe("An older headline");
    await vi.advanceTimersByTimeAsync(300);
    expect(text("h1")).toBe(COPY.headline_alt2);
    expect(text("p")).toBe(COPY.body_alt2);
    // The hold watches for the page's own words, as on a first page.
    const { lastApplied } = await import("../src/apply.ts");
    expect(lastApplied().map((a) => [a.path, a.original])).toEqual([
      ["hero.headline", OWN.headline],
      ["hero.body", OWN.body],
      ["hero.cta.label", OWN.label],
    ]);
  });

  it("a part the page has taken since the early write keeps the words as the page has them", async () => {
    carried();
    comeBack();
    await boot();
    // The page's own script split the headline it found: our words, its spans.
    const h1 = document.querySelector("h1") as HTMLElement;
    h1.innerHTML = COPY.headline
      .split(" ")
      .map((word) => `<span class="word">${word}</span>`)
      .join(" ");
    await vi.advanceTimersByTimeAsync(300);
    expect(h1.querySelectorAll("span.word")).toHaveLength(5);
    expect(text("h1")).toBe(COPY.headline);
    // The paragraph nobody touched is fitted.
    expect(text("p")).toBe(COPY.body_alt2);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(events("variant_shown")[0]?.body).toMatchObject({ body_carry: 1 });
  });

  it("once the cap has shown the page, what the visitor reads stays: no fit after it", async () => {
    // The page's stylesheet is slower than the cap, so nothing could be
    // measured behind the hide; it lands after the page is in view.
    carried();
    const w = comeBack(HTML, SHEET);
    selectReply = () => answerAfter(2500, { ...personalized, carried: true });
    await boot();
    await vi.advanceTimersByTimeAsync(1500);
    expect(hidden()).toBe(false);
    expect(text("h1")).toBe(COPY.headline);
    sheetLoads(w);
    expect(text("h1")).toBe(COPY.headline);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(text("h1")).toBe(COPY.headline);
    expect(text("p")).toBe(COPY.body);
    expect(events("variant_shown")[0]?.body).toMatchObject({ body_carry: 1 });
  });

  it("a label that would add a row is given back on the return too, as on a first page", async () => {
    const long = "See every one of the products we make for you";
    const copy = { hero: { ...sections.hero, cta: { label: long } } };
    carried(targets, copy);
    comeBack();
    selectReply = () =>
      answerAfter(200, {
        ...personalized,
        carried: true,
        variant: { ...personalized.variant, sections: copy },
      });
    await boot();
    // Measured at the write: the row would grow, so the page's own label stays.
    expect(text("a.btn")).toBe(OWN.label);
    await vi.advanceTimersByTimeAsync(300);
    expect(text("a.btn")).toBe(OWN.label);
    expect(text("h1")).toBe(COPY.headline_alt2);
  });

  it("a label that repeated the words follows the length the fit keeps", async () => {
    carried();
    comeBack(HTML.replace('<h1 class="hero">', `<h1 class="hero" aria-label="${OWN.headline}">`));
    await boot();
    expect(document.querySelector("h1")?.getAttribute("aria-label")).toBe(COPY.headline_alt2);
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector("h1")?.getAttribute("aria-label")).toBe(COPY.headline_alt2);
  });
});

describe("(A10) a carried return is fitted before the first paint", () => {
  const kept = { h1: COPY.headline_alt2, p: COPY.body_alt2, btn: COPY.label };
  const first = { h1: COPY.headline, p: COPY.body, btn: COPY.label };
  const now = () => ({ h1: text("h1"), p: text("p"), btn: text("a.btn") });
  const inline = (sel: string) => (document.querySelector(sel) as HTMLElement).style.cssText;

  it("the stylesheets are in at the write: fitted in that task, before the edge is heard", async () => {
    carried();
    const w = comeBack(HTML, SHEET);
    // The tag sits after the stylesheet (the foot of the page): it is loaded.
    Object.defineProperty(w.document.querySelector("link"), "sheet", { value: {} });
    selectReply = () => new Promise(() => {});
    await boot();
    expect(hidden()).toBe(true);
    expect(now()).toEqual(kept);
    expect(selects).toHaveLength(1);
  });

  it("a stylesheet still on its way: the first lengths, then fitted when it loads, still behind the hide", async () => {
    carried();
    const w = comeBack(HTML, SHEET);
    selectReply = () => new Promise(() => {});
    await boot();
    // A box measured now would be the unstyled page's: nothing is measured.
    expect(now()).toEqual(first);
    // Another resource finishing changes nothing.
    document.body.appendChild(document.createElement("img")).dispatchEvent(new w.Event("load"));
    expect(now()).toEqual(first);
    sheetLoads(w);
    // The same event the browser's first paint waits for.
    expect(now()).toEqual(kept);
    expect(hidden()).toBe(true);
  });

  it("the edge then confirms: nothing changes at the reveal", async () => {
    carried();
    const w = comeBack(HTML, SHEET);
    await boot();
    sheetLoads(w);
    const fitted = document.body.innerHTML;
    const style = { h1: inline("h1"), p: inline("p") };
    await vi.advanceTimersByTimeAsync(300);
    expect(hidden()).toBe(false);
    expect(document.body.innerHTML).toBe(fitted);
    expect({ h1: inline("h1"), p: inline("p") }).toEqual(style);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(events("variant_shown")[0]?.body).toMatchObject({ body_carry: 1, carried: 1 });
    expect(events("snippet_issue")).toHaveLength(0);
  });

  it("a stylesheet for print that never loads is not waited for", async () => {
    carried();
    comeBack(
      HTML,
      `<link rel="stylesheet" href="/late.css" media="print" onload="this.media='all'">`,
    );
    selectReply = () => new Promise(() => {});
    await boot();
    expect(now()).toEqual(kept);
  });

  it("an engine that cannot say whether the styles are in: fitted at the edge's confirm, as before", async () => {
    carried();
    comeBack(HTML, SHEET);
    vi.stubGlobal("matchMedia", undefined);
    await boot();
    expect(now()).toEqual(first);
    await vi.advanceTimersByTimeAsync(300);
    expect(hidden()).toBe(false);
    expect(now()).toEqual(kept);
  });

  it("the edge is still the authority: no version puts the page back exactly as built, no box held", async () => {
    // A copy shorter than the page's own: the fit holds the box at the
    // page's height or cuts the words into the page's lines.
    carried(targets, {
      hero: { kind: "hero", headline: "Short and plain", body: "Short.", cta: { label: "Go" } },
    });
    comeBack();
    const built = document.body.innerHTML;
    selectReply = () =>
      answerAfter(200, { source: "original", cohort: "no_signal", variant: null });
    await boot();
    expect(text("h1")).toBe("Short and plain");
    expect(inline("h1") + inline("p")).not.toBe("");
    await vi.advanceTimersByTimeAsync(300);
    expect(hidden()).toBe(false);
    expect(document.body.innerHTML).toBe(built);
    expect(inline("h1") + inline("p") + inline("a.btn")).toBe("");
    expect(tab.has("__rw_body")).toBe(false);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(events("variant_shown")).toHaveLength(0);
  });

  it("another copy from the edge, after the early fit was made again at a new width, still goes over the page's own words", async () => {
    carried(targets, {
      hero: { kind: "hero", headline: "An older headline", body: "Older.", cta: { label: "Old" } },
    });
    const w = comeBack();
    selectReply = () => answerAfter(900, { ...personalized, carried: true });
    await boot();
    expect(text("h1")).toBe("An older headline");
    // The window gets narrower before the edge answers: the fit runs again.
    LINE = { H1: [12, 44], P: [30, 25] };
    (w as unknown as { innerWidth: number }).innerWidth = 390;
    w.dispatchEvent(new w.Event("resize"));
    await vi.advanceTimersByTimeAsync(300);
    expect(text("h1")).toBe("An older headline");
    await vi.advanceTimersByTimeAsync(700);
    expect(hidden()).toBe(false);
    const { lastApplied } = await import("../src/apply.ts");
    expect(lastApplied().map((a) => [a.path, a.original])).toEqual([
      ["hero.headline", OWN.headline],
      ["hero.body", OWN.body],
      ["hero.cta.label", OWN.label],
    ]);
    expect(text("h1")).not.toBe("An older headline");
  });

  it("measures nothing new into the tab or the requests", async () => {
    carried();
    const w = comeBack(HTML, SHEET);
    await boot();
    sheetLoads(w);
    await vi.advanceTimersByTimeAsync(40_000);
    expect([...tab.keys()].sort()).toEqual(["__rw_body", "__rw_carry", "__rw_visit"]);
    expect(selects).toHaveLength(1);
    expect(selects[0]).not.toMatch(/alt|height|lines|fit/);
    for (const e of sent) expect(e.raw).not.toMatch(/alt|length|lines|kept|height/);
  });
});

describe("(3) a part left as built is reported", () => {
  /** The page takes the headline back in a shape we do not write into: its own words, word by word. */
  function takeBack(): void {
    (document.querySelector("h1") as HTMLElement).innerHTML = OWN.headline
      .split(" ")
      .map((word) => `<span>${word}</span>`)
      .join(" ");
  }

  it("on a carried return, the way a first page reports it", async () => {
    // The first page.
    page("https://site.test/?utm_source=chatgpt.com");
    selectReply = () => answerAfter(200, personalized);
    await boot();
    await vi.advanceTimersByTimeAsync(5000);
    takeBack();
    await vi.advanceTimersByTimeAsync(30_000);
    const first = events("personalization_partial");
    expect(first).toHaveLength(1);

    // The return.
    comeBack();
    await boot();
    await vi.advanceTimersByTimeAsync(5000);
    expect(events("variant_shown")[0]?.body).toMatchObject({ body_carry: 1 });
    takeBack();
    await vi.advanceTimersByTimeAsync(30_000);
    const back = events("personalization_partial");
    expect(back).toHaveLength(1);
    expect(back[0]?.body).toMatchObject({
      event_type: "personalization_partial",
      page_path: "/",
      variant_key: "v1:variant:acme:problem:ai",
      cohort: "personalized",
      paths: ["hero.headline"],
    });
    expect(back[0]?.body.paths).toEqual(first[0]?.body.paths);
    expect(typeof back[0]?.body.visit).toBe("string");
  });
});
