/**
 * Snippet issues (docs/specs/snippet-issues.md): each code from its trigger,
 * at most three per load and one send, nothing on a clean load, never the
 * visit marker, never anything read from a caught error, and the layout
 * shift observer reads three entry fields only.
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
let selectReply: (signal: AbortSignal | undefined) => Promise<Response>;

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
};

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

/** A page, the per-customer config and a fake network; nothing runs until `boot()`. */
function page(html = `<h1 class="hero">Old headline</h1>`, hide: string[] = ["h1.hero"]) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, {
    url: "https://site.test/",
  });
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
  vi.stubGlobal("HTMLAnchorElement", w.HTMLAnchorElement);
  vi.stubGlobal("HTMLButtonElement", w.HTMLButtonElement);
  vi.stubGlobal("getComputedStyle", w.getComputedStyle.bind(w));
  // No layout-shift entries unless a test gives an observer.
  vi.stubGlobal("PerformanceObserver", undefined);
  (w as unknown as { __rw: unknown }).__rw = { c: "acme", e: EDGE, h: { "/": hide } };
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (url.startsWith(`${EDGE}/select`)) return selectReply(init?.signal ?? undefined);
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

const issueEvents = () => sent.filter((s) => s.body.event_type === "snippet_issue");
const issuesOf = (s: Sent | undefined) =>
  (s?.body.properties as { issues: Array<Record<string, unknown>> } | undefined)?.issues;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  sent = [];
  selectReply = () => json(personalized);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the collector", () => {
  it("keeps the first three in order and sends them once", async () => {
    const { noteIssue, startIssues } = await import("../src/issues.ts");
    const sends: unknown[] = [];
    const send = startIssues((issues) => sends.push(issues));
    noteIssue("reveal_cap", undefined, 1);
    noteIssue("select_failed", undefined, 2);
    noteIssue("rich_failed");
    noteIssue("apply_error", "hero.headline");
    send();
    send();
    expect(sends).toEqual([
      [{ c: "reveal_cap", n: 1 }, { c: "select_failed", n: 2 }, { c: "rich_failed" }],
    ]);
  });

  it("sends nothing when nothing went wrong", async () => {
    const { startIssues } = await import("../src/issues.ts");
    const sends: unknown[] = [];
    startIssues((issues) => sends.push(issues))();
    expect(sends).toEqual([]);
  });

  it("updates a repeated code and slot, takes it back at 0, and drops a slot outside the rule", async () => {
    const { noteIssue, startIssues } = await import("../src/issues.ts");
    const sends: unknown[] = [];
    const send = startIssues((issues) => sends.push(issues));
    noteIssue("lines_changed", "hero.headline", 2);
    noteIssue("lines_changed", "hero.headline", 1);
    noteIssue("lines_changed", "hero.body", 1);
    noteIssue("lines_changed", "hero.body", 0);
    noteIssue("apply_error", "features.items.0.title");
    noteIssue("apply_error", "Old headline at https://x");
    send();
    expect(sends).toEqual([
      [{ c: "lines_changed", s: "hero.headline", n: 1 }, { c: "apply_error" }],
    ]);
  });

  it("a new load sends the previous one, and the old load's timer sends nothing of the new one", async () => {
    const { noteIssue, startIssues } = await import("../src/issues.ts");
    const sends: Array<[string, unknown]> = [];
    const first = startIssues((issues) => sends.push(["first", issues]));
    noteIssue("reveal_cap", undefined, 1);
    const second = startIssues((issues) => sends.push(["second", issues]));
    noteIssue("reveal_cap", undefined, 2);
    first();
    expect(sends).toEqual([["first", [{ c: "reveal_cap", n: 1 }]]]);
    second();
    expect(sends[1]).toEqual(["second", [{ c: "reveal_cap", n: 2 }]]);
  });
});

describe("select_failed and reveal_cap, from index.ts", () => {
  it("a network failure: select_failed 2, sent a second after the reveal, no visit", async () => {
    page();
    selectReply = () => Promise.reject(new TypeError("Failed to fetch"));
    await boot();
    // Asked twice (the retry after 250 ms), then the reveal and a second.
    await vi.advanceTimersByTimeAsync(1249);
    expect(issueEvents()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10);
    const ev = issueEvents();
    expect(ev).toHaveLength(1);
    expect(issuesOf(ev[0])).toEqual([{ c: "select_failed", n: 2 }]);
    expect(ev[0]?.body).toEqual({
      event_type: "snippet_issue",
      page_path: "/",
      properties: { issues: [{ c: "select_failed", n: 2 }] },
    });
    expect(ev[0]?.raw).not.toContain("visit");
    // The hidden headline is shown as built.
    expect(document.getElementById("__rawuser-hide")).toBeNull();
  });

  it("a non-2xx answer: select_failed 3", async () => {
    page();
    selectReply = () => json({ error: "boom" }, 500);
    await boot();
    await vi.advanceTimersByTimeAsync(2000);
    expect(issuesOf(issueEvents()[0])).toEqual([{ c: "select_failed", n: 3 }]);
  });

  it("our timeout: the load cap fires first (reveal_cap 1), then select_failed 1", async () => {
    page();
    selectReply = (signal) =>
      new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    await boot();
    await vi.advanceTimersByTimeAsync(1500);
    expect(document.getElementById("__rawuser-hide")).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(issueEvents()).toHaveLength(1);
    expect(issuesOf(issueEvents()[0])).toEqual([
      { c: "reveal_cap", n: 1 },
      { c: "select_failed", n: 1 },
    ]);
  });

  it("the hydration cap on a React page: reveal_cap 3, with the variant key", async () => {
    const w = page();
    (w as unknown as { __NEXT_DATA__: unknown }).__NEXT_DATA__ = {};
    await boot();
    await vi.advanceTimersByTimeAsync(2600);
    // No write after the cap (quiet-swap, Late answers): the original stays.
    expect(document.querySelector("h1")?.textContent).toBe("Old headline");
    await vi.advanceTimersByTimeAsync(11_000);
    expect(sent.find((s) => s.body.event_type === "personalization_skipped")?.body.kind).toBe(
      "late",
    );
    const ev = issueEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]?.body.variant_key).toBe("v1:variant:acme:problem:ai");
    expect(issuesOf(ev[0])).toEqual([{ c: "reveal_cap", n: 3 }]);
  });

  it("a visitor who leaves first: sent on pagehide, once", async () => {
    const w = page();
    selectReply = () => Promise.reject(new TypeError("Failed to fetch"));
    await boot();
    await vi.advanceTimersByTimeAsync(100);
    expect(issueEvents()).toHaveLength(0);
    w.dispatchEvent(new w.Event("pagehide"));
    expect(issueEvents()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(issueEvents()).toHaveLength(1);
  });
});

describe("a clean load", () => {
  it("sends variant_shown with the visit, and no snippet_issue at all", async () => {
    page();
    await boot();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(document.querySelector("h1")?.textContent).toBe("New headline");
    const shown = sent.find((s) => s.body.event_type === "variant_shown");
    expect(typeof shown?.body.visit).toBe("string");
    expect(issueEvents()).toHaveLength(0);
  });
});

describe("apply_error: the payload shape (privacy review condition 4)", () => {
  it("a write that throws sends the code and the part only: exact keys, nothing of the error", async () => {
    const w = page();
    const h1 = w.document.querySelector("h1") as HTMLElement;
    Object.defineProperty(h1, "textContent", {
      get: () => "Old headline",
      set: () => {
        throw new Error("https://x/?email=a@b");
      },
    });
    await boot();
    await vi.advanceTimersByTimeAsync(5000);
    const ev = issueEvents();
    expect(ev).toHaveLength(1);
    const body = ev[0]?.body ?? {};
    expect(Object.keys(body).sort()).toEqual([
      "event_type",
      "page_path",
      "properties",
      "variant_key",
    ]);
    expect(Object.keys(body.properties as object)).toEqual(["issues"]);
    expect(issuesOf(ev[0])).toEqual([{ c: "apply_error", s: "hero.headline" }]);
    for (const issue of issuesOf(ev[0]) ?? []) {
      for (const k of Object.keys(issue)) expect(["c", "s", "n"]).toContain(k);
    }
    const raw = ev[0]?.raw ?? "";
    expect(raw).not.toContain("email");
    expect(raw).not.toContain("https://x");
    expect(raw).not.toContain("visit");
    // The page is shown at once, not at the cap.
    expect(document.getElementById("__rawuser-hide")).toBeNull();
  });
});

describe("rich_failed", () => {
  it("a page that needs rich.js and does not get it by the cap", async () => {
    const g = globalThis as { __rwx?: unknown };
    const writers = g.__rwx;
    // biome-ignore lint/performance/noDelete: the test needs the global absent, as on a page without rich.js
    delete g.__rwx;
    try {
      page();
      selectReply = () =>
        json({
          ...personalized,
          targets: {
            "hero.headline": {
              css: ["h1.hero"],
              text: [],
              structural: "",
              inline: {
                icons: "none",
                emphasis: 0,
                split: true,
                animated_text: true,
                template: "{w}",
              },
            },
          },
        });
      await boot();
      await vi.advanceTimersByTimeAsync(15_000);
      const issues = issuesOf(issueEvents()[0]) ?? [];
      expect(issues).toContainEqual({ c: "rich_failed" });
    } finally {
      g.__rwx = writers;
    }
  });
});

describe("lines_changed, from the fit check's own measures", () => {
  function linePage(lines: number) {
    const dom = new JSDOM(
      `<!doctype html><html><head></head><body><h1 class="hero">Old headline</h1></body></html>`,
    );
    const doc = dom.window.document;
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("HTMLAnchorElement", dom.window.HTMLAnchorElement);
    vi.stubGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
    // lineCount reads the text's line boxes: the original takes `lines`.
    doc.createRange = (() => ({
      selectNodeContents() {},
      getClientRects: () =>
        Array.from({ length: lines }, (_, i) => ({ top: i * 40, width: 100, height: 40 })),
    })) as unknown as Document["createRange"];
    return doc;
  }

  it("a headline that takes one line more: s the slot, n +1", async () => {
    const doc = linePage(2);
    const { startIssues } = await import("../src/issues.ts");
    const { applyVariant } = await import("../src/apply.ts");
    const sends: unknown[] = [];
    const send = startIssues((issues) => sends.push(issues));
    const h1 = doc.querySelector("h1") as HTMLElement;
    const measure = (el: Element) => (el.textContent === "Old headline" ? 80 : 120);
    expect(applyVariant(variant as never, targets, measure)).toBe(true);
    expect(h1.textContent).toBe("New headline");
    send();
    expect(sends).toEqual([[{ c: "lines_changed", s: "hero.headline", n: 1 }]]);
  });

  it("a shorter length held at the original's height by min-height: nothing", async () => {
    const doc = linePage(2);
    const { startIssues } = await import("../src/issues.ts");
    const { applyVariant } = await import("../src/apply.ts");
    const sends: unknown[] = [];
    const send = startIssues((issues) => sends.push(issues));
    // One word cannot be cut into the page's two lines: the box is held instead.
    const short = { ...variant, sections: { hero: { kind: "hero", headline: "Short" } } };
    applyVariant(short as never, targets, (el) => (el.textContent === "Old headline" ? 80 : 40));
    const h1 = doc.querySelector("h1") as HTMLElement;
    expect(h1.textContent).toBe("Short");
    expect(h1.style.minHeight).toBe("80px");
    send();
    expect(sends).toEqual([]);
  });

  it("a shorter length cut into the page's lines: nothing", async () => {
    const doc = linePage(2);
    const { startIssues } = await import("../src/issues.ts");
    const { applyVariant } = await import("../src/apply.ts");
    const sends: unknown[] = [];
    const send = startIssues((issues) => sends.push(issues));
    applyVariant(variant as never, targets, (el) => (el.textContent === "Old headline" ? 80 : 40));
    expect((doc.querySelector("h1") as HTMLElement).style.whiteSpace).toBe("pre-line");
    send();
    expect(sends).toEqual([]);
  });

  it("a box under half a line taller: nothing", async () => {
    linePage(2);
    const { startIssues } = await import("../src/issues.ts");
    const { applyVariant } = await import("../src/apply.ts");
    const sends: unknown[] = [];
    const send = startIssues((issues) => sends.push(issues));
    applyVariant(variant as never, targets, (el) => (el.textContent === "Old headline" ? 80 : 99));
    send();
    expect(sends).toEqual([]);
  });

  it("the same lines: nothing", async () => {
    linePage(2);
    const { startIssues } = await import("../src/issues.ts");
    const { applyVariant } = await import("../src/apply.ts");
    const sends: unknown[] = [];
    const send = startIssues((issues) => sends.push(issues));
    applyVariant(variant as never, targets, () => 80);
    send();
    expect(sends).toEqual([]);
  });

  it("never past nine either way", async () => {
    linePage(2);
    const { startIssues } = await import("../src/issues.ts");
    const { applyVariant } = await import("../src/apply.ts");
    const sends: unknown[] = [];
    const send = startIssues((issues) => sends.push(issues));
    applyVariant(variant as never, targets, (el) =>
      el.textContent === "Old headline" ? 80 : 4000,
    );
    send();
    expect(sends).toEqual([[{ c: "lines_changed", s: "hero.headline", n: 9 }]]);
  });
});

describe("swap_shift: the layout-shift observer (privacy review condition 3)", () => {
  /** An entry that throws on any field but the three allowed ones. */
  function entry(value: number, startTime: number, hadRecentInput = false) {
    const allowed: Record<string, unknown> = { value, startTime, hadRecentInput };
    return new Proxy(
      {},
      {
        get(_, k) {
          if (typeof k === "string" && k in allowed) return allowed[k];
          throw new Error(`read ${String(k)}`);
        },
      },
    );
  }

  let observers: FakePO[];
  class FakePO {
    static supportedEntryTypes = ["layout-shift"];
    opts: unknown;
    disconnected = false;
    constructor(public cb: (l: { getEntries: () => unknown[] }) => void) {
      observers.push(this);
    }
    observe(o: unknown) {
      this.opts = o;
    }
    takeRecords() {
      return [];
    }
    disconnect() {
      this.disconnected = true;
    }
    deliver(entries: unknown[]) {
      this.cb({ getEntries: () => entries });
    }
  }

  beforeEach(() => {
    observers = [];
  });

  it("sums the window's shifts without input, reads three fields, sends a bucket, disconnects", async () => {
    vi.stubGlobal("PerformanceObserver", FakePO);
    const { setWriting, startIssues, watchShift } = await import("../src/issues.ts");
    const sends: unknown[] = [];
    const send = startIssues((issues) => sends.push(issues));
    // Written (no frames here: the write's window stays open to the end).
    setWriting("hero.headline");
    setWriting();
    watchShift();
    const po = observers[0] as FakePO;
    expect(po.opts).toEqual({ type: "layout-shift", buffered: true });
    const t = performance.now();
    po.deliver([
      entry(0.04, t),
      entry(0.03, t + 10),
      entry(0.5, t + 20, true), // the visitor's own input
      entry(0.5, t - 500), // before the window
      entry(0.5, t + 5000), // after it
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(po.disconnected).toBe(true);
    send();
    expect(sends).toEqual([[{ c: "swap_shift", n: 2 }]]);
  });

  it("the buckets, and nothing at or under 0.01", async () => {
    vi.stubGlobal("PerformanceObserver", FakePO);
    const cases: Array<[number, number | null]> = [
      [0.01, null],
      [0.011, 1],
      [0.05, 1],
      [0.06, 2],
      [0.1, 2],
      [0.2, 3],
      [0.25, 3],
      [0.3, 4],
    ];
    for (const [value, bucket] of cases) {
      vi.resetModules();
      observers = [];
      const { setWriting, startIssues, watchShift } = await import("../src/issues.ts");
      const sends: unknown[] = [];
      const send = startIssues((issues) => sends.push(issues));
      setWriting("hero.headline");
      setWriting();
      watchShift();
      (observers[0] as FakePO).deliver([entry(value, performance.now())]);
      send();
      expect(sends).toEqual(bucket === null ? [] : [[{ c: "swap_shift", n: bucket }]]);
    }
  });

  it("an engine without layout-shift entries (WebKit): no observer at all", async () => {
    class NoShift extends FakePO {
      static override supportedEntryTypes = ["paint", "navigation"];
    }
    vi.stubGlobal("PerformanceObserver", NoShift);
    const { startIssues, watchShift } = await import("../src/issues.ts");
    const send = startIssues(() => undefined);
    watchShift();
    send();
    expect(observers).toHaveLength(0);
  });

  it("not on a load with nothing of the page hidden or written", async () => {
    // Nothing of the page is hidden and the edge leaves it as built.
    page(`<h1 class="hero">Old headline</h1>`, ["h2.missing"]);
    vi.stubGlobal("PerformanceObserver", FakePO);
    selectReply = () => json({ source: "original", cohort: "no_signal", variant: null });
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(observers).toHaveLength(0);
  });

  // A9 (docs/specs/pilot-gaps.md): a bot's load on the pilot's site sent
  // swap_shift with nothing written; the shift was the page's own font swap.
  // A part hidden and shown again as built keeps its box and moves nothing.
  it("a load that hid the headline and wrote nothing does not watch: the bot answer", async () => {
    page();
    vi.stubGlobal("PerformanceObserver", FakePO);
    // The edge takes 20 ms: in the split build an answer at once can come in
    // before the core, and the boot shows the page then (faster-tag.md C).
    selectReply = () =>
      new Promise((r) =>
        setTimeout(
          () => r(json({ source: "fallback-canonical-bot", variant_key: "", variant: null })),
          20,
        ),
      );
    await boot();
    // Hidden while the edge is asked, then shown as the page built it.
    expect(document.getElementById("__rawuser-hide")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(document.getElementById("__rawuser-hide")).toBeNull();
    expect(document.querySelector("h1")?.textContent).toBe("Old headline");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(observers).toHaveLength(0);
    // A bot's load sends nothing at all.
    expect(sent).toEqual([]);
  });

  it("nor does a visit with no signal, the holdout arm, or a version that could not be written", async () => {
    const answers = [
      { source: "original", cohort: "no_signal", variant: null },
      {
        source: "holdout",
        cohort: "holdout",
        variant_key: "v1:variant:acme:problem:ai",
        selection: personalized.selection,
        variant: null,
      },
      // The version names a part this page does not have: left as built, skipped.
      {
        ...personalized,
        targets: { ...targets, "hero.body": { css: ["p.nowhere"], text: [], structural: "" } },
        variant: {
          ...variant,
          sections: { hero: { kind: "hero", headline: "New headline", body: "New body" } },
        },
      },
    ];
    for (const answer of answers) {
      vi.resetModules();
      observers = [];
      sent = [];
      page();
      vi.stubGlobal("PerformanceObserver", FakePO);
      selectReply = () => json(answer);
      await boot();
      // The parse ends: a part still missing then is missing from this page.
      Object.defineProperty(document, "readyState", { value: "interactive", configurable: true });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(document.querySelector("h1")?.textContent).toBe("Old headline");
      expect(observers).toHaveLength(0);
      expect(issueEvents()).toHaveLength(0);
    }
  });

  it("nor when the cap shows the original and the edge never answers", async () => {
    page();
    vi.stubGlobal("PerformanceObserver", FakePO);
    selectReply = (signal) =>
      new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    await boot();
    await vi.advanceTimersByTimeAsync(1500);
    expect(document.getElementById("__rawuser-hide")).toBeNull();
    await vi.advanceTimersByTimeAsync(6000);
    expect(observers).toHaveLength(0);
    // What did go wrong is still reported, and only that.
    expect(issuesOf(issueEvents()[0])).toEqual([
      { c: "reveal_cap", n: 1 },
      { c: "select_failed", n: 1 },
    ]);
  });

  it("a page written early from the tab's copy and put back still watches: we changed it", async () => {
    const w = page();
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
    vi.stubGlobal("PerformanceObserver", FakePO);
    // The edge answers after the core is in: a page the boot already showed
    // is not written early (faster-tag.md C), and this case is about one that was.
    selectReply = () =>
      new Promise((r) =>
        setTimeout(() => r(json({ source: "original", cohort: "no_signal", variant: null })), 20),
      );
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelector("h1")?.textContent).toBe("Old headline");
    expect(observers).toHaveLength(1);
  });

  it("a load that wrote the headline watches the swap window", async () => {
    page();
    vi.stubGlobal("PerformanceObserver", FakePO);
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(observers).toHaveLength(1);
    expect(observers[0]?.disconnected).toBe(true);
  });
});

// A11 (docs/specs/pilot-gaps.md, the recheck of 2026-10-12): at 390
// the pilot's site shifts by 0.0165 when its own fonts land, with or without us.
// The write waits for those fonts, so the shift sat inside the window and
// swap_shift was sent on 3 of 3 cold written loads. Framer (our Framer test site,
// 2026-10-25): the page lays itself out again just after hydration, which
// our write waits for, and swap_shift was sent on 18 of 18 written loads at
// 1280. Our shift is one in the frame that renders a write of ours.
describe("swap_shift: only a shift in the frame of our write (A11, Framer)", () => {
  /** An entry that throws on any field but the three allowed ones. */
  function entry(value: number, startTime: number, hadRecentInput = false) {
    const allowed: Record<string, unknown> = { value, startTime, hadRecentInput };
    return new Proxy(
      {},
      {
        get(_, k) {
          if (typeof k === "string" && k in allowed) return allowed[k];
          throw new Error(`read ${String(k)}`);
        },
      },
    );
  }

  let observers: FakePO[];
  class FakePO {
    static supportedEntryTypes = ["layout-shift"];
    constructor(public cb: (l: { getEntries: () => unknown[] }) => void) {
      observers.push(this);
    }
    observe() {}
    takeRecords() {
      return [];
    }
    disconnect() {}
    deliver(entries: unknown[]) {
      this.cb({ getEntries: () => entries });
    }
  }

  /** The page's own clock, moved by hand. */
  let clock: number;
  /** Animation frame callbacks waiting for the next frame. */
  let rafs: Array<() => void>;

  beforeEach(() => {
    observers = [];
    clock = 0;
    rafs = [];
  });

  /** The browser begins a frame at `at`: its animation frame callbacks run, then its layout. */
  function frameAt(at: number): void {
    clock = at;
    const q = rafs;
    rafs = [];
    for (const f of q) f();
  }

  async function load() {
    vi.resetModules();
    observers = [];
    rafs = [];
    vi.stubGlobal("PerformanceObserver", FakePO);
    vi.stubGlobal("performance", { now: () => clock });
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => rafs.push(cb));
    const issues = await import("../src/issues.ts");
    const sends: unknown[] = [];
    const send = issues.startIssues((l) => sends.push(l));
    return { ...issues, sends, send };
  }

  /**
   * A load that writes at 500 and 510 and reveals at 520, all in one task;
   * the browser renders that write in the frame it begins at 525 and begins
   * the next at 541. Then the shifts the browser reports.
   */
  async function writtenLoad(shifts: Array<[number, number]>): Promise<unknown[]> {
    const { setWriting, watchShift, sends, send } = await load();
    clock = 500;
    setWriting("hero.headline");
    setWriting();
    clock = 510;
    // A second part in the same task is the same frame.
    setWriting("hero.body");
    setWriting();
    clock = 520;
    watchShift();
    frameAt(525);
    frameAt(541);
    (observers[0] as FakePO).deliver(shifts.map(([value, at]) => entry(value, at)));
    send();
    return sends;
  }

  it("a shift before the write is not counted, though it is inside the old window", async () => {
    // 480 is 40 ms before the reveal: counted until 2026-10-12.
    expect(await writtenLoad([[0.0165, 480]])).toEqual([]);
    expect(await writtenLoad([[0.3, 499.9]])).toEqual([]);
  });

  it("a shift in the frame that renders our write is counted: a version that pushes the page down", async () => {
    expect(await writtenLoad([[0.0165, 500]])).toEqual([[{ c: "swap_shift", n: 1 }]]);
    expect(await writtenLoad([[0.2, 505]])).toEqual([[{ c: "swap_shift", n: 3 }]]);
    // The frame begun at 525 is laid out after its callbacks: 530 is it.
    expect(await writtenLoad([[0.06, 530]])).toEqual([[{ c: "swap_shift", n: 2 }]]);
    expect(await writtenLoad([[0.3, 540.9]])).toEqual([[{ c: "swap_shift", n: 4 }]]);
  });

  // Framer (our test site, 2026-10-25): the write waits for hydration, and the
  // page lays itself out again 12 to 124 ms later, written or not (0.0107
  // at 1280 with our tag blocked too). That is a later frame than ours.
  it("the page's own shift after our write's frame is not counted (Framer after hydration)", async () => {
    expect(await writtenLoad([[0.0107, 541]])).toEqual([]);
    expect(await writtenLoad([[0.0107, 560]])).toEqual([]);
    expect(await writtenLoad([[0.06, 900]])).toEqual([]);
    expect(await writtenLoad([[0.3, 1521]])).toEqual([]);
  });

  it("the page's own before and after, ours in between: only ours is in the sum", async () => {
    // 0.045 before, 0.02 ours, 0.045 after: all three the second bucket, ours alone the first.
    expect(
      await writtenLoad([
        [0.045, 490],
        [0.02, 530],
        [0.045, 620],
      ]),
    ).toEqual([[{ c: "swap_shift", n: 1 }]]);
    // Only the page's own on both sides: nothing at all.
    expect(
      await writtenLoad([
        [0.045, 490],
        [0.045, 620],
      ]),
    ).toEqual([]);
  });

  it("a write in a later frame has its own window (a retry, a second pass)", async () => {
    const { setWriting, watchShift, sends, send } = await load();
    clock = 500;
    setWriting("hero.headline");
    setWriting();
    clock = 520;
    watchShift();
    frameAt(525);
    frameAt(541);
    clock = 700;
    setWriting("hero.headline");
    setWriting();
    frameAt(708);
    frameAt(725);
    (observers[0] as FakePO).deliver([entry(0.3, 650), entry(0.02, 712), entry(0.3, 730)]);
    send();
    expect(sends).toEqual([[{ c: "swap_shift", n: 1 }]]);
  });

  it("a write made inside a frame's callbacks is rendered in that frame: its window reaches the next", async () => {
    const { setWriting, watchShift, sends, send } = await load();
    clock = 500;
    // A callback of the frame begun at 500 writes; that frame is laid out after it.
    rafs.push(() => {
      setWriting("hero.headline");
      setWriting();
    });
    frameAt(500);
    clock = 503;
    watchShift();
    (observers[0] as FakePO).deliver([entry(0.06, 505)]);
    frameAt(517);
    frameAt(533);
    (observers[0] as FakePO).deliver([entry(0.3, 540)]);
    send();
    expect(sends).toEqual([[{ c: "swap_shift", n: 2 }]]);
  });

  it("the tab's copy written as the page parsed: its own frame counts, the page's shifts until the reveal do not", async () => {
    const { setWriting, watchShift, sends, send } = await load();
    clock = 20;
    setWriting("hero.headline");
    setWriting();
    frameAt(30);
    frameAt(46);
    clock = 600;
    watchShift();
    (observers[0] as FakePO).deliver([entry(0.02, 35), entry(0.3, 300), entry(0.3, 610)]);
    send();
    expect(sends).toEqual([[{ c: "swap_shift", n: 1 }]]);
  });

  it("a tab that renders no frame: the write's window stays open to the observer's end", async () => {
    const { setWriting, watchShift, sends, send } = await load();
    clock = 500;
    setWriting("hero.headline");
    setWriting();
    clock = 520;
    watchShift();
    (observers[0] as FakePO).deliver([entry(0.3, 490), entry(0.06, 900), entry(0.3, 1521)]);
    send();
    expect(sends).toEqual([[{ c: "swap_shift", n: 2 }]]);
  });

  it("each load has its own windows: a client-side route does not inherit the first page's", async () => {
    const { setWriting, startIssues, watchShift } = await load();
    const sends: unknown[] = [];
    clock = 100;
    setWriting("hero.headline");
    const send = startIssues((issues) => sends.push(issues));
    clock = 5000;
    setWriting("hero.headline");
    clock = 5010;
    watchShift();
    (observers[0] as FakePO).deliver([entry(0.2, 4990), entry(0.02, 5005)]);
    send();
    expect(sends).toEqual([[{ c: "swap_shift", n: 1 }]]);
  });
  /**
   * The whole load, as on the pilot's site: the edge answers at 100, the page's
   * fonts land at 190, and the browser renders the frame that swaps them in
   * (the page's own shift) at 206. `frames` are the ones the browser gives.
   */
  async function medora(o: { frames?: boolean } = {}) {
    const w = page();
    const start = Date.now();
    let tick = 0;
    // Strictly increasing, as a real clock: what happens later reads later.
    const now = () => Date.now() - start + ++tick / 1000;
    vi.stubGlobal("PerformanceObserver", FakePO);
    vi.stubGlobal("performance", { now, getEntriesByType: () => [] });
    let frameAt = -1;
    vi.stubGlobal(
      "requestAnimationFrame",
      o.frames === false
        ? () => 0 // a hidden tab: no frame comes
        : (cb: () => void) =>
            setTimeout(() => {
              // The frame is rendered here: the font swap is laid out and painted.
              frameAt = now();
              cb();
            }, 16),
    );
    const fonts = { status: "loading", ready: Promise.resolve() as Promise<unknown> };
    fonts.ready = new Promise((r) =>
      setTimeout(() => {
        fonts.status = "loaded";
        r(undefined);
      }, 190),
    );
    Object.defineProperty(w.document, "fonts", { value: fonts });
    selectReply = () =>
      new Promise((r) =>
        setTimeout(
          () =>
            r(
              new Response(JSON.stringify(personalized), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
          100,
        ),
      );
    await boot();
    return { frame: () => frameAt, now };
  }
  const h1 = () => document.querySelector("h1")?.textContent;
  const hiddenNow = () => document.getElementById("__rawuser-hide") !== null;

  it("the write waits for the frame that swaps the page's fonts in, behind the hide", async () => {
    await medora();
    await vi.advanceTimersByTimeAsync(150);
    // The edge has answered; the fonts are not in.
    expect(h1()).toBe("Old headline");
    await vi.advanceTimersByTimeAsync(50);
    // The fonts landed at 190: not written in that same frame.
    expect(h1()).toBe("Old headline");
    expect(hiddenNow()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    // The frame was rendered at 206: written and shown after it.
    expect(h1()).toBe("New headline");
    expect(hiddenNow()).toBe(false);
  });

  it("the page's own font shift is not reported: no snippet_issue at all", async () => {
    const page = await medora();
    await vi.advanceTimersByTimeAsync(210);
    expect(observers).toHaveLength(1);
    // The entry of the frame that swapped the fonts in: 0.0165, as measured.
    (observers[0] as FakePO).deliver([entry(0.0165, page.frame())]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(issueEvents()).toHaveLength(0);
  });

  it("a shift after the write on the same load is reported, without the page's own", async () => {
    const page = await medora();
    await vi.advanceTimersByTimeAsync(210);
    (observers[0] as FakePO).deliver([entry(0.045, page.frame()), entry(0.02, page.now())]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(issueEvents()).toHaveLength(1);
    expect(issuesOf(issueEvents()[0])).toEqual([{ c: "swap_shift", n: 1 }]);
  });

  it("the page's own shift a few frames after the write is not reported: no snippet_issue at all", async () => {
    const page = await medora();
    await vi.advanceTimersByTimeAsync(210);
    expect(h1()).toBe("New headline");
    // The write's frame and the one after it have been rendered (222, 238).
    await vi.advanceTimersByTimeAsync(50);
    (observers[0] as FakePO).deliver([entry(0.0107, page.now())]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(issueEvents()).toHaveLength(0);
  });

  it("a tab that renders no frame is not held past the font wait", async () => {
    await medora({ frames: false });
    await vi.advanceTimersByTimeAsync(400);
    expect(h1()).toBe("Old headline");
    // Half a second after the answer (100 + 500), frame or no frame.
    await vi.advanceTimersByTimeAsync(210);
    expect(h1()).toBe("New headline");
    expect(hiddenNow()).toBe(false);
  });

  it("fonts that are already in cost no frame", async () => {
    page();
    const raf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);
    Object.defineProperty(document, "fonts", {
      value: { status: "loaded", ready: Promise.resolve() },
    });
    await boot();
    await vi.advanceTimersByTimeAsync(5);
    // Written though no frame ever came: the frames asked for are the shift
    // window's, after the write, never waited on.
    expect(h1()).toBe("New headline");
  });
});

describe("reverted: the hold's restore counter", () => {
  function holdPage() {
    const dom = new JSDOM(
      `<!doctype html><html><head></head><body><h1 class="hero">Old headline</h1></body></html>`,
    );
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("HTMLAnchorElement", dom.window.HTMLAnchorElement);
    vi.stubGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
    vi.stubGlobal("MutationObserver", undefined);
    return dom.window.document;
  }

  async function run(reverts: number) {
    const doc = holdPage();
    const { startIssues } = await import("../src/issues.ts");
    const { applyVariant, holdVariant, REVERT_WINDOW_MS } = await import("../src/apply.ts");
    const sends: unknown[] = [];
    const send = startIssues((issues) => sends.push(issues));
    applyVariant(variant as never, targets, () => 0);
    const timers: Array<[() => void, number]> = [];
    const checks = Array.from({ length: reverts }, (_, i) => i + 1);
    holdVariant(targets, checks, (fn, ms) => timers.push([fn, ms]));
    const h1 = doc.querySelector("h1") as HTMLElement;
    for (const [fn, ms] of timers) {
      if (ms === REVERT_WINDOW_MS) continue;
      h1.textContent = "Old headline"; // the page takes our words back
      fn();
      expect(h1.textContent).toBe("New headline");
    }
    for (const [fn, ms] of timers) if (ms === REVERT_WINDOW_MS) fn();
    send();
    return sends;
  }

  it("more than three restores in the first ten seconds: s the slot, n the count", async () => {
    expect(await run(5)).toEqual([[{ c: "reverted", s: "hero.headline", n: 5 }]]);
  });

  it("three restores: nothing", async () => {
    expect(await run(3)).toEqual([]);
  });

  it("the count stops at 99", async () => {
    expect(await run(120)).toEqual([[{ c: "reverted", s: "hero.headline", n: 99 }]]);
  });
});
