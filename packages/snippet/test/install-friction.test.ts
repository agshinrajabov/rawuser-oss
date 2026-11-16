/**
 * The snippet half of docs/specs/install-friction.md ("What the other passes
 * need", snippet 1 to 4; privacy review ruling 2026-10-03, conditions 4
 * and 5; the founder's calls of 2026-10-04):
 *
 * - the page's CSP nonce is copied, as a property only, onto the hide
 *   `<style>` and the `/rich.js` and `/picker.js` scripts, and goes nowhere
 *   else: no URL, event, beacon, storage, carry or log;
 * - a late tag is decided from presence only (async/defer on our script,
 *   `document.readyState`, a paint entry existing), never from a time; it
 *   hides nothing, writes nothing (docs/specs/late-tag.md, 2026-10-12; until
 *   then it swapped in place) and reports `late_tag` once, in the one
 *   snippet_issue, with no visit marker; the rule itself is tested in
 *   late-tag.test.ts;
 * - the head-first tag behaves as before, and the hide style text is
 *   byte-identical (its sha256 is pinned, the policy line depends on it).
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EDGE = "https://edge.test";
const NONCE = "N0nceR4nd0mValue9q";
const HIDE_TEXT = "[data-rawuser]{visibility:hidden!important}";

interface Out {
  kind: "fetch" | "beacon";
  url: string;
  body: string;
}

let out: Out[];
let logs: string[];
let selectReply: () => Promise<Response>;
let paint: unknown[];

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

function after(ms: number, body: unknown): Promise<Response> {
  return new Promise((r) => setTimeout(() => r(json(body)), ms));
}

interface PageOpts {
  url?: string;
  /** The body as the script finds it (the hero may not be parsed yet). */
  html?: string;
  /** Our own script element: its async/defer attributes and nonce. */
  tag?: { async?: boolean; defer?: boolean; nonce?: string };
  readyState?: "loading" | "interactive" | "complete";
  rich?: boolean;
}

function page(o: PageOpts = {}) {
  const html = o.html ?? `<h1 class="hero">Old headline</h1><a class="cta" href="#">Start</a>`;
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, {
    url: o.url ?? "https://site.test/?utm_source=chatgpt.com",
  });
  const w = dom.window;
  const doc = w.document;
  Object.defineProperty(doc, "readyState", {
    value: o.readyState ?? "loading",
    configurable: true,
  });
  const tag = doc.createElement("script");
  tag.src = `${EDGE}/s/acme.js`;
  if (o.tag?.async) tag.async = true;
  if (o.tag?.defer) tag.defer = true;
  if (o.tag?.nonce) tag.nonce = o.tag.nonce;
  doc.head.appendChild(tag);
  Object.defineProperty(doc, "currentScript", { value: tag, configurable: true });

  vi.stubGlobal("window", w);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", w.location);
  vi.stubGlobal("history", w.history);
  vi.stubGlobal("sessionStorage", w.sessionStorage);
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
  vi.stubGlobal("navigator", {
    language: "en",
    sendBeacon: (url: string, data: Blob) => {
      void data.text().then((body) => out.push({ kind: "beacon", url, body }));
      return true;
    },
  });
  (w as unknown as { __rw: unknown }).__rw = {
    c: "acme",
    e: EDGE,
    h: { "/": ["h1.hero"] },
    ...(o.rich ? { x: ["/"] } : {}),
  };
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    out.push({ kind: "fetch", url, body: String(init?.body ?? "") });
    if (url.startsWith(`${EDGE}/select`)) return selectReply();
    if (url.startsWith(`${EDGE}/carry`)) return Promise.resolve(json({ bodies: {} }));
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  }
  return w;
}

async function boot(): Promise<void> {
  await import("../src/index.ts");
}

const events = (type: string) =>
  out
    .filter((o) => o.url.startsWith(`${EDGE}/event`))
    .map((o) => JSON.parse(o.body) as Record<string, unknown>)
    .filter((b) => b.event_type === type);
const issuesOf = (b: Record<string, unknown>) =>
  (b.properties as { issues: Array<Record<string, unknown>> }).issues;
const headline = () => document.querySelector("h1")?.textContent;
const hideStyle = () => document.getElementById("__rawuser-hide") as HTMLStyleElement | null;

const g = globalThis as { __rwx?: unknown };
let writers: unknown;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  out = [];
  logs = [];
  paint = [];
  selectReply = () => after(400, personalized);
  writers = g.__rwx;
});

afterEach(() => {
  g.__rwx = writers;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the hide style text (pinned)", () => {
  it("is byte-identical, its sha256 the one the policy lines carry", async () => {
    page();
    selectReply = () => new Promise(() => {});
    await boot();
    const text = hideStyle()?.textContent ?? "";
    expect(text).toBe(HIDE_TEXT);
    expect(createHash("sha256").update(text).digest("base64")).toBe(
      "uUswyaXbEHXp14LMbwYoLUMHybPzmIVetSQk2E7czKY=",
    );
  });
});

describe("the nonce, carried (E1, condition 5)", () => {
  it("is set on the hide style before it goes in", async () => {
    page({ tag: { nonce: NONCE } });
    selectReply = () => new Promise(() => {});
    await boot();
    expect(hideStyle()?.nonce).toBe(NONCE);
  });

  it("is set on the /rich.js script, whose URL does not carry it", async () => {
    g.__rwx = undefined;
    page({ tag: { nonce: NONCE }, rich: true });
    selectReply = () => new Promise(() => {});
    await boot();
    const s = document.querySelector('script[src*="/rich.js"]') as HTMLScriptElement | null;
    expect(s).not.toBeNull();
    expect(s?.nonce).toBe(NONCE);
    expect(s?.src).not.toContain(NONCE);
  });

  it("is set on the /picker.js script in pick mode, whose URL and data do not carry it", async () => {
    page({ tag: { nonce: NONCE }, url: "https://site.test/#rawuser_pick=tok_12345678" });
    await boot();
    const s = document.querySelector('script[src*="/picker.js"]') as HTMLScriptElement | null;
    expect(s).not.toBeNull();
    expect(s?.nonce).toBe(NONCE);
    expect(s?.src).not.toContain(NONCE);
    expect(JSON.stringify({ ...s?.dataset })).not.toContain(NONCE);
  });

  it("nothing is set when the page has no nonce", async () => {
    g.__rwx = undefined;
    page({ rich: true });
    selectReply = () => new Promise(() => {});
    await boot();
    expect(hideStyle()?.nonce ?? "").toBe("");
    expect(
      (document.querySelector('script[src*="/rich.js"]') as HTMLScriptElement).nonce ?? "",
    ).toBe("");
  });

  it("is in no outgoing request, beacon, storage, carry or log, through a whole visit", async () => {
    g.__rwx = undefined;
    const w = page({ tag: { nonce: NONCE }, rich: true });
    await boot();
    // rich.js arrives (jsdom loads no scripts): the writers register, then load.
    g.__rwx = writers;
    document.querySelector('script[src*="/rich.js"]')?.dispatchEvent(new w.Event("load"));
    await vi.advanceTimersByTimeAsync(3000);
    // A conversion and the pagehide flush (snippet_issue), both by a
    // keepalive fetch, a client-side route (/select again), the body-carry
    // prefetch.
    (document.querySelector("a.cta") as HTMLElement).dispatchEvent(
      new w.MouseEvent("click", { bubbles: true }),
    );
    w.history.pushState({}, "", "/pricing");
    await vi.advanceTimersByTimeAsync(5000);
    w.dispatchEvent(new w.Event("pagehide"));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(out.some((o) => o.url.startsWith(`${EDGE}/select`))).toBe(true);
    expect(events("conversion").length).toBeGreaterThan(0);
    expect(events("variant_shown").length).toBeGreaterThan(0);
    for (const o of out) {
      expect(o.url).not.toContain(NONCE);
      expect(o.body).not.toContain(NONCE);
    }
    for (let i = 0; i < w.sessionStorage.length; i++) {
      const k = w.sessionStorage.key(i) ?? "";
      expect(k + (w.sessionStorage.getItem(k) ?? "")).not.toContain(NONCE);
    }
    for (const l of logs) expect(l).not.toContain(NONCE);
    for (const s of Array.from(document.querySelectorAll("script"))) {
      expect(s.src).not.toContain(NONCE);
    }
  });

  it("the source sets it as a property only, never as an attribute", () => {
    const dir = new URL("../src/", import.meta.url);
    const files = readdirSync(dir, { recursive: true }) as string[];
    for (const f of files.filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(/setAttribute\(\s*["']nonce/);
      expect(src, f).not.toMatch(/\[nonce|nonce=/);
    }
  });
});

describe("the head-first tag (unchanged)", () => {
  it("hides the parts, swaps, reveals, and sends no snippet_issue", async () => {
    page();
    await boot();
    expect(hideStyle()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(headline()).toBe("Old headline");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(headline()).toBe("New headline");
    expect(hideStyle()).toBeNull();
    expect(events("variant_shown")).toHaveLength(1);
    expect(events("snippet_issue")).toHaveLength(0);
  });

  it("a sync tag at the top of the body, a paint already done above it, the hero not parsed yet: not late", async () => {
    paint = [{ name: "first-paint" }, { name: "first-contentful-paint" }];
    page({ html: "<nav>Menu</nav>" });
    await boot();
    expect(hideStyle()).not.toBeNull();
    // The hero arrives after our rules are in: hidden from its first paint.
    document.body.insertAdjacentHTML("beforeend", `<h1 class="hero">Old headline</h1>`);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(headline()).toBe("New headline");
    expect(events("snippet_issue")).toHaveLength(0);
  });
});

describe("a late tag (D, condition 4; the page stays as built, docs/specs/late-tag.md)", () => {
  const cases: Array<[string, PageOpts, unknown[]]> = [
    ["async on our script", { tag: { async: true } }, []],
    ["defer on our script", { tag: { defer: true } }, []],
    ["readyState interactive", { readyState: "interactive" }, []],
    ["readyState complete", { readyState: "complete" }, []],
    ["a paint entry exists", {}, [{ name: "first-contentful-paint" }]],
  ];

  it.each(cases)(
    "%s: nothing hidden, nothing written, the original stays for the whole load",
    async (_, opts, entries) => {
      paint = entries;
      page(opts);
      await boot();
      // No empty box: no hide style at all, the parts keep showing.
      expect(document.querySelectorAll("style")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(headline()).toBe("Old headline");
      expect(document.querySelectorAll("style")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(15_000);
      // Until 2026-10-12 the words changed in place here.
      expect(headline()).toBe("Old headline");

      expect(events("variant_shown")).toHaveLength(0);
      const skipped = events("personalization_skipped");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatchObject({ kind: "late", lp: 1, cohort: "skipped" });
      expect(typeof skipped[0]?.visit).toBe("string");
      // One snippet_issue, late_tag alone, no slot, no number, no marker, no bit.
      const issues = events("snippet_issue");
      expect(issues).toHaveLength(1);
      const ev = issues[0] as Record<string, unknown>;
      expect(issuesOf(ev)).toEqual([{ c: "late_tag" }]);
      expect(ev.visit).toBeUndefined();
      expect(Object.keys(ev).sort()).toEqual(
        ["event_type", "page_path", "properties", "variant_key"].sort(),
      );
    },
  );

  it("an answer after the cap's time changes nothing: nothing was hidden, so no cap is reported", async () => {
    page({ tag: { async: true } });
    selectReply = () => after(2500, personalized);
    await boot();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(headline()).toBe("Old headline");
    expect(events("personalization_skipped")[0]).toMatchObject({ kind: "late", lp: 1 });
    const issues = issuesOf(events("snippet_issue")[0] as Record<string, unknown>);
    expect(issues).toEqual([{ c: "late_tag" }]);
  });

  it("an async tag that runs before the hero is parsed still hides it: not late", async () => {
    page({ tag: { async: true }, html: "<nav>Menu</nav>" });
    await boot();
    expect(hideStyle()).not.toBeNull();
    // The rest of the page is parsed after the answer (the decision waits for it).
    await vi.advanceTimersByTimeAsync(100);
    document.body.insertAdjacentHTML(
      "beforeend",
      '<h1 class="hero">Old headline</h1><a class="cta" href="#">Start</a>',
    );
    Object.defineProperty(document, "readyState", { value: "interactive", configurable: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events("snippet_issue")).toHaveLength(0);
  });

  it("a page without a version: no change, late_tag still reported, no marker on it", async () => {
    page({ readyState: "complete", url: "https://site.test/" });
    selectReply = () =>
      Promise.resolve(
        json({ source: "original", variant_key: "", variant: null, cohort: "no_signal" }),
      );
    await boot();
    await vi.advanceTimersByTimeAsync(5000);
    expect(headline()).toBe("Old headline");
    expect(events("no_signal_passthrough")).toHaveLength(1);
    const ev = events("snippet_issue")[0] as Record<string, unknown>;
    expect(issuesOf(ev)).toEqual([{ c: "late_tag" }]);
    expect(ev.visit).toBeUndefined();
  });

  it("a client-side route after a late load hides as before and reports nothing new", async () => {
    const w = page({ tag: { async: true } });
    await boot();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events("snippet_issue")).toHaveLength(1);
    selectReply = () => new Promise(() => {});
    w.history.pushState({}, "", "/pricing");
    await vi.advanceTimersByTimeAsync(10);
    expect(hideStyle()?.textContent).toBe(HIDE_TEXT);
    await vi.advanceTimersByTimeAsync(10_000);
    const late = events("snippet_issue")
      .flatMap(issuesOf)
      .filter((i) => i.c === "late_tag");
    expect(late).toHaveLength(1);
  });

  it("never reads a paint entry's time", async () => {
    const reads: string[] = [];
    paint = [
      new Proxy(
        { name: "first-contentful-paint" },
        {
          get(t, k) {
            reads.push(String(k));
            return (t as Record<string | symbol, unknown>)[k];
          },
        },
      ),
    ];
    page();
    await boot();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events("snippet_issue").flatMap(issuesOf)[0]).toEqual({ c: "late_tag" });
    expect(reads).not.toContain("startTime");
    expect(reads).not.toContain("duration");
    expect(reads).not.toContain("toJSON");
  });
});
