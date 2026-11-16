/**
 * Leaving the page (docs/specs/pilot-gaps.md, F7 and F1;
 * privacy review Q5; docs/specs/snippet-issues.md).
 *
 * F7. A written load held its issues for the ten seconds the hold counts
 * its restores, and a visitor who left inside them took the list along
 * wherever the browser sends nothing from a page that is going. Now:
 * - every load sends its list a second after the reveal;
 * - `reverted`, the one code that needs the ten seconds, follows alone in
 *   a second event when it happened, and no other code is ever sent twice;
 * - what is still pending at `pagehide`, or when the tab is hidden, is sent
 *   then, once, as text/plain by a keepalive fetch (no preflight).
 *
 * F1. `select_failed` gains 4, "aborted by page exit": presence only, set
 * by the `pagehide` listener or by a `visibilitychange` to hidden that
 * fired after the script started. Order: 1 our timeout, 3 http, 4 exit,
 * else 2. No time is read.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EDGE = "https://edge.test";

interface Sent {
  raw: string;
  body: Record<string, unknown>;
  init: RequestInit;
}

let sent: Sent[];
let selects: number;
let selectReply: (signal: AbortSignal | undefined) => Promise<Response>;
/** What `document.hidden` answers. */
let isHidden: boolean;

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const answerAfter = (ms: number, body: unknown, status = 200) =>
  new Promise<Response>((r) => setTimeout(() => r(json(body, status)), ms));
/** A request the browser fails only when told to: our abort, or `fail()`. */
function pending() {
  let fail: (e: unknown) => void = () => {};
  const reply = (signal: AbortSignal | undefined) =>
    new Promise<Response>((_, reject) => {
      fail = reject;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  return { reply, fail: () => fail(new TypeError("Failed to fetch")) };
}

/** A network failure on both tries: the first, the 250 ms pause, the retry. */
async function failBoth(ask: { fail: () => void }): Promise<void> {
  ask.fail();
  await vi.advanceTimersByTimeAsync(250);
  ask.fail();
}

function page(o: { late?: boolean; loadedHidden?: boolean } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body><h1 class="hero">Old headline</h1></body></html>`,
    { url: "https://site.test/" },
  );
  const w = dom.window;
  const doc = w.document;
  Object.defineProperty(doc, "readyState", {
    value: o.late ? "complete" : "loading",
    configurable: true,
  });
  isHidden = !!o.loadedHidden;
  Object.defineProperty(doc, "hidden", { get: () => isHidden, configurable: true });
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
  vi.stubGlobal("getComputedStyle", w.getComputedStyle.bind(w));
  vi.stubGlobal("PerformanceObserver", undefined);
  (w as unknown as { __rw: unknown }).__rw = { c: "acme", e: EDGE, h: { "/": ["h1.hero"] } };
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (url.startsWith(`${EDGE}/select`)) {
      selects++;
      return selectReply(init?.signal ?? undefined);
    }
    if (url.startsWith(`${EDGE}/event`)) {
      const raw = String(init?.body ?? "");
      sent.push({ raw, body: JSON.parse(raw) as Record<string, unknown>, init: init ?? {} });
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return {
    w,
    pagehide: () => w.dispatchEvent(new w.Event("pagehide")),
    hide: () => {
      isHidden = true;
      doc.dispatchEvent(new w.Event("visibilitychange"));
    },
    show: () => {
      isHidden = false;
      doc.dispatchEvent(new w.Event("visibilitychange"));
    },
  };
}

async function boot(): Promise<void> {
  await import("../src/index.ts");
}

const issueEvents = () => sent.filter((s) => s.body.event_type === "snippet_issue");
const issuesOf = (s: Sent | undefined) =>
  (s?.body.properties as { issues: Array<Record<string, unknown>> } | undefined)?.issues;
const allIssues = () => issueEvents().map(issuesOf);
const h1 = () => document.querySelector("h1") as HTMLElement;

/** The page takes the headline back `times` times; the hold restores it each time. */
async function takeBack(times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    h1().textContent = "Old headline";
    await vi.advanceTimersByTimeAsync(1);
    expect(h1().textContent).toBe("New headline");
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  sent = [];
  selects = 0;
  selectReply = () => answerAfter(100, personalized);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("F7: a written load no longer holds its issues for ten seconds", () => {
  /** A layout-shift observer the test feeds: three fields per entry, nothing else. */
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
  }
  /** A written load whose swap moved the page: an issue known a second after the reveal. */
  async function writtenLoadThatShifted() {
    observers = [];
    const p = page();
    vi.stubGlobal("PerformanceObserver", FakePO);
    await boot();
    await vi.advanceTimersByTimeAsync(150);
    expect(h1().textContent).toBe("New headline");
    expect(observers).toHaveLength(1);
    observers[0]?.cb({
      getEntries: () => [{ value: 0.03, hadRecentInput: false, startTime: performance.now() }],
    });
    return p;
  }

  it("a load that wrote sends what went wrong a second after the reveal, not at ten", async () => {
    await writtenLoadThatShifted();
    await vi.advanceTimersByTimeAsync(900);
    expect(issueEvents()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    // Until 2026-10-12 this waited nine seconds more, for the hold's count.
    expect(allIssues()).toEqual([[{ c: "swap_shift", n: 1 }]]);
    expect(issueEvents()[0]?.body.variant_key).toBe("v1:variant:acme:problem:ai");
    await vi.advanceTimersByTimeAsync(60_000);
    // The hold restored nothing: no second event.
    expect(issueEvents()).toHaveLength(1);
  });

  it("the hold's count follows alone at ten seconds, in a second event, and no code is sent twice", async () => {
    await writtenLoadThatShifted();
    await vi.advanceTimersByTimeAsync(1100);
    expect(allIssues()).toEqual([[{ c: "swap_shift", n: 1 }]]);
    await takeBack(5);
    await vi.advanceTimersByTimeAsync(5000);
    expect(issueEvents()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(allIssues()).toEqual([
      [{ c: "swap_shift", n: 1 }],
      [{ c: "reverted", s: "hero.headline", n: 5 }],
    ]);
    // Both rows are the load's own: the page, the version, no visit marker.
    for (const e of issueEvents()) {
      expect(Object.keys(e.body).sort()).toEqual([
        "event_type",
        "page_path",
        "properties",
        "variant_key",
      ]);
      expect(e.raw).not.toContain("visit");
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(issueEvents()).toHaveLength(2);
  });

  it("left between the two: the first went at one second, the count so far goes with the visitor", async () => {
    const p = await writtenLoadThatShifted();
    await vi.advanceTimersByTimeAsync(1100);
    await takeBack(4);
    await vi.advanceTimersByTimeAsync(2000);
    p.pagehide();
    expect(allIssues()).toEqual([
      [{ c: "swap_shift", n: 1 }],
      [{ c: "reverted", s: "hero.headline", n: 4 }],
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(issueEvents()).toHaveLength(2);
  });

  it("a load that wrote nothing sends once, a second after it was decided", async () => {
    page({ late: true });
    await boot();
    await vi.advanceTimersByTimeAsync(900);
    expect(issueEvents()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(allIssues()).toEqual([[{ c: "late_tag" }]]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(issueEvents()).toHaveLength(1);
  });

  it("a client-side route that wrote: nothing at one second when nothing went wrong, the count at ten", async () => {
    const { w } = page({ late: true });
    await boot();
    await vi.advanceTimersByTimeAsync(1500);
    expect(allIssues()).toEqual([[{ c: "late_tag" }]]);
    sent = [];
    selectReply = () => answerAfter(100, personalized);
    w.history.pushState({}, "", "/pricing");
    await vi.advanceTimersByTimeAsync(600);
    expect(h1().textContent).toBe("New headline");
    await takeBack(5);
    await vi.advanceTimersByTimeAsync(1200);
    expect(issueEvents()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(allIssues()).toEqual([[{ c: "reverted", s: "hero.headline", n: 5 }]]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(issueEvents()).toHaveLength(1);
  });

  it("the collector: after the first send only the hold's count is taken, and no code goes twice", async () => {
    const { noteIssue, startIssues } = await import("../src/issues.ts");
    const sends: unknown[] = [];
    const send = startIssues((issues) => sends.push(issues));
    noteIssue("lines_changed", "hero.headline", 1);
    noteIssue("swap_shift", undefined, 1);
    send(false);
    expect(sends).toEqual([
      [
        { c: "lines_changed", s: "hero.headline", n: 1 },
        { c: "swap_shift", n: 1 },
      ],
    ]);
    // A later fit, a later error: what was true a second after the reveal stands.
    noteIssue("lines_changed", "hero.headline", 2);
    noteIssue("lines_changed", "hero.body", 1);
    noteIssue("apply_error", "hero.headline");
    noteIssue("reverted", "hero.headline", 6);
    send();
    expect(sends[1]).toEqual([{ c: "reverted", s: "hero.headline", n: 6 }]);
    // Closed: nothing more, whatever is noted or asked.
    noteIssue("reverted", "hero.body", 9);
    send();
    send(false);
    expect(sends).toHaveLength(2);
  });

  it("the collector: a first send with nothing to say sends nothing, and the count still follows", async () => {
    const { noteIssue, startIssues } = await import("../src/issues.ts");
    const sends: unknown[] = [];
    const send = startIssues((issues) => sends.push(issues));
    send(false);
    expect(sends).toEqual([]);
    noteIssue("reverted", "hero.headline", 4);
    send();
    expect(sends).toEqual([[{ c: "reverted", s: "hero.headline", n: 4 }]]);
  });

  it("every snippet_issue leaves as text/plain by a keepalive fetch with no credentials: no preflight", async () => {
    const p = page({ late: true });
    await boot();
    await vi.advanceTimersByTimeAsync(1200);
    // The timed send.
    expect(issueEvents()).toHaveLength(1);
    // And one at pagehide, on another load.
    vi.resetModules();
    const q = page({ late: true });
    await boot();
    await vi.advanceTimersByTimeAsync(300);
    q.pagehide();
    expect(issueEvents()).toHaveLength(2);
    for (const e of issueEvents()) {
      expect(e.init.method).toBe("POST");
      expect(e.init.keepalive).toBe(true);
      expect(e.init.credentials).toBe("omit");
      // The only header, and a CORS-safelisted one.
      expect(e.init.headers).toEqual({ "content-type": "text/plain;charset=UTF-8" });
    }
    void p;
  });
});

describe("F7: what is pending when the visitor leaves is sent then, once", () => {
  it("pagehide before the first send: sent at once, and never again", async () => {
    const p = page({ late: true });
    await boot();
    await vi.advanceTimersByTimeAsync(300);
    expect(issueEvents()).toHaveLength(0);
    p.pagehide();
    expect(allIssues()).toEqual([[{ c: "late_tag" }]]);
    // The browser fires visibilitychange right after pagehide.
    p.hide();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(issueEvents()).toHaveLength(1);
  });

  it("the tab is hidden (a phone: the last event there is): sent at once, and never again", async () => {
    const p = page({ late: true });
    await boot();
    await vi.advanceTimersByTimeAsync(300);
    p.hide();
    expect(allIssues()).toEqual([[{ c: "late_tag" }]]);
    p.show();
    p.hide();
    p.pagehide();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(issueEvents()).toHaveLength(1);
  });

  it("the tab becoming visible sends nothing", async () => {
    const p = page({ late: true, loadedHidden: true });
    await boot();
    await vi.advanceTimersByTimeAsync(300);
    p.show();
    expect(issueEvents()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(issueEvents()).toHaveLength(1);
  });

  it("left inside the hold's ten seconds: the count so far goes with the visitor when it is over three", async () => {
    const p = page();
    await boot();
    await vi.advanceTimersByTimeAsync(1500);
    expect(h1().textContent).toBe("New headline");
    expect(issueEvents()).toHaveLength(0);
    await takeBack(5);
    await vi.advanceTimersByTimeAsync(1500);
    p.pagehide();
    expect(allIssues()).toEqual([[{ c: "reverted", s: "hero.headline", n: 5 }]]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(issueEvents()).toHaveLength(1);
  });

  it("left inside the ten seconds with three restores or fewer: nothing to send", async () => {
    const p = page();
    await boot();
    await vi.advanceTimersByTimeAsync(1500);
    await takeBack(3);
    p.pagehide();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(issueEvents()).toHaveLength(0);
  });

  it("a clean load sends nothing at one second, at ten, at hidden or at pagehide", async () => {
    const p = page();
    await boot();
    await vi.advanceTimersByTimeAsync(15_000);
    p.hide();
    p.pagehide();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sent.map((s) => s.body.event_type)).toEqual(["variant_shown"]);
  });
});

describe("F1: select_failed 4, the page was left or hidden while we asked", () => {
  it("else 2: a network failure with the page in view", async () => {
    page();
    const ask = pending();
    selectReply = ask.reply;
    await boot();
    await vi.advanceTimersByTimeAsync(200);
    await failBoth(ask);
    await vi.advanceTimersByTimeAsync(1100);
    expect(allIssues()).toEqual([[{ c: "select_failed", n: 2 }]]);
  });

  it("4: the tab was hidden, then the request failed", async () => {
    const p = page();
    const ask = pending();
    selectReply = ask.reply;
    await boot();
    await vi.advanceTimersByTimeAsync(200);
    p.hide();
    // Still asking: nothing is sent yet, the edge may still answer.
    expect(issueEvents()).toHaveLength(0);
    ask.fail();
    await vi.advanceTimersByTimeAsync(1100);
    expect(allIssues()).toEqual([[{ c: "select_failed", n: 4 }]]);
    // The same keys as ever: a code and a number.
    expect(Object.keys(issueEvents()[0]?.body ?? {}).sort()).toEqual([
      "event_type",
      "page_path",
      "properties",
    ]);
    expect(issueEvents()[0]?.raw).not.toContain("visit");
  });

  it("4: the page goes with the request still on its way, said at the pagehide flush", async () => {
    const p = page({ late: true });
    const ask = pending();
    selectReply = ask.reply;
    await boot();
    await vi.advanceTimersByTimeAsync(200);
    p.pagehide();
    expect(allIssues()).toEqual([[{ c: "late_tag" }, { c: "select_failed", n: 4 }]]);
    // The browser then fails the request: nothing more is sent.
    ask.fail();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(issueEvents()).toHaveLength(1);
  });

  it("4: a network failure just before the page goes is the exit's", async () => {
    const p = page();
    const ask = pending();
    selectReply = ask.reply;
    await boot();
    await vi.advanceTimersByTimeAsync(200);
    // Some engines fail the request first and fire pagehide after.
    ask.fail();
    await vi.advanceTimersByTimeAsync(5);
    p.pagehide();
    expect(allIssues()).toEqual([[{ c: "select_failed", n: 4 }]]);
  });

  // The kind is settled when the list is sent (2026-10-13; the pilot: 13 of 14
  // "network" rows were lone loads whose issue row still arrived, so the
  // network was there and the exit had killed the request before it
  // announced itself). A 2 is provisional until its list goes.
  describe("settled at the send", () => {
    /** The request fails as a network error; the page is revealed and nothing is sent yet. */
    async function rejected() {
      const p = page();
      const ask = pending();
      selectReply = ask.reply;
      await boot();
      await vi.advanceTimersByTimeAsync(200);
      await failBoth(ask);
      await vi.advanceTimersByTimeAsync(50);
      expect(issueEvents()).toHaveLength(0);
      return p;
    }

    it("a rejection, then pagehide 50 ms later: sent at the exit as 4, once", async () => {
      const p = await rejected();
      p.pagehide();
      p.hide();
      expect(allIssues()).toEqual([[{ c: "select_failed", n: 4 }]]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(issueEvents()).toHaveLength(1);
    });

    it("a rejection and no exit: sent a second later as 2, and a later exit cannot relabel it", async () => {
      const p = await rejected();
      await vi.advanceTimersByTimeAsync(1000);
      expect(allIssues()).toEqual([[{ c: "select_failed", n: 2 }]]);
      p.hide();
      p.pagehide();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(allIssues()).toEqual([[{ c: "select_failed", n: 2 }]]);
    });

    // The rule: a hide before the rejection waits for the request (the edge
    // may still answer); a hide after it is this load's exit, since the list
    // goes then and a phone gives no later event. A request that died as the
    // visitor switched app is the exit's failure, not the edge's, the same
    // as hidden-then-failed. Shown again changes nothing: the list has gone.
    it("a rejection, then the tab hidden and shown again, no exit: sent at the hide as 4, nothing more", async () => {
      const p = await rejected();
      p.hide();
      expect(allIssues()).toEqual([[{ c: "select_failed", n: 4 }]]);
      p.show();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(issueEvents()).toHaveLength(1);
      expect(allIssues()).toEqual([[{ c: "select_failed", n: 4 }]]);
    });

    it("our own timeout stays 1 whatever follows", async () => {
      const p = page();
      selectReply = pending().reply;
      await boot();
      await vi.advanceTimersByTimeAsync(5300);
      expect(issueEvents()).toHaveLength(0);
      p.hide();
      p.pagehide();
      expect(allIssues()).toEqual([
        [
          { c: "reveal_cap", n: 1 },
          { c: "select_failed", n: 1 },
        ],
      ]);
    });

    it("an http answer stays 3 whatever follows", async () => {
      const p = page();
      selectReply = () => answerAfter(300, { error: "boom" }, 500);
      await boot();
      await vi.advanceTimersByTimeAsync(400);
      expect(issueEvents()).toHaveLength(0);
      p.hide();
      p.pagehide();
      expect(allIssues()).toEqual([[{ c: "select_failed", n: 3 }]]);
    });

    it("the collector: only an unsent 2 is relabelled, and a pending request only when the page goes", async () => {
      const { leftAsking, noteIssue, startIssues } = await import("../src/issues.ts");
      const sends: unknown[][] = [];
      const send = startIssues((issues) => sends.push(issues));
      // Hidden with the request on its way: nothing noted, the edge may still answer.
      leftAsking(false);
      expect(sends).toEqual([]);
      noteIssue("select_failed", undefined, 2);
      leftAsking(false);
      send();
      expect(sends).toEqual([[{ c: "select_failed", n: 4 }]]);
    });
  });

  it("1 before 4: our own timeout stays our timeout, hidden or left", async () => {
    const p = page();
    selectReply = pending().reply;
    await boot();
    await vi.advanceTimersByTimeAsync(200);
    p.hide();
    await vi.advanceTimersByTimeAsync(5000);
    p.pagehide();
    expect(allIssues()).toEqual([
      [
        { c: "reveal_cap", n: 1 },
        { c: "select_failed", n: 1 },
      ],
    ]);
  });

  it("3 before 4: an answer we could not use stays that, hidden or left", async () => {
    const p = page();
    selectReply = () => answerAfter(300, { error: "boom" }, 500);
    await boot();
    await vi.advanceTimersByTimeAsync(200);
    p.hide();
    await vi.advanceTimersByTimeAsync(150);
    p.pagehide();
    expect(allIssues()).toEqual([[{ c: "select_failed", n: 3 }]]);
  });

  it("a page that loaded hidden is not a page that was left: 2", async () => {
    page({ loadedHidden: true });
    const ask = pending();
    selectReply = ask.reply;
    await boot();
    await vi.advanceTimersByTimeAsync(200);
    await failBoth(ask);
    await vi.advanceTimersByTimeAsync(1100);
    expect(allIssues()).toEqual([[{ c: "select_failed", n: 2 }]]);
  });

  it("hidden while asking, and the edge answers after all: the page is written, no failure", async () => {
    const p = page();
    selectReply = () => answerAfter(300, personalized);
    await boot();
    await vi.advanceTimersByTimeAsync(100);
    p.hide();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h1().textContent).toBe("New headline");
    expect(sent.map((s) => s.body.event_type)).toEqual(["variant_shown"]);
  });

  it("each pass starts clean: hidden once on the first page, a route's network failure is still 2", async () => {
    const p = page();
    await boot();
    await vi.advanceTimersByTimeAsync(500);
    p.hide();
    p.show();
    sent = [];
    const ask = pending();
    selectReply = ask.reply;
    p.w.history.pushState({}, "", "/pricing");
    await vi.advanceTimersByTimeAsync(600);
    expect(selects).toBe(2);
    await failBoth(ask);
    await vi.advanceTimersByTimeAsync(1100);
    expect(allIssues()).toEqual([[{ c: "select_failed", n: 2 }]]);
  });

  // 2026-10-18: about 3% of loads on two pilot sites failed as network.
  it("a network failure is asked once more after 250 ms; an answer then is written, no failure", async () => {
    page();
    let n = 0;
    selectReply = () =>
      ++n === 1
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(
            new Response(JSON.stringify(personalized), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
    await boot();
    await vi.advanceTimersByTimeAsync(249);
    expect(selects).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(selects).toBe(2);
    expect(h1().textContent).toBe("New headline");
    expect(issueEvents()).toHaveLength(0);
    expect(sent.map((s) => s.body.event_type)).toEqual(["variant_shown"]);
  });

  it("no second try after an unusable answer, our timeout, or a page left in the pause", async () => {
    page();
    selectReply = () => Promise.resolve(new Response("{}", { status: 500 }));
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(selects).toBe(1);
    expect(allIssues()).toEqual([[{ c: "select_failed", n: 3 }]]);
  });

  it("hidden in the pause: no second try, the failure is the exit's (4)", async () => {
    const p = page();
    const ask = pending();
    selectReply = ask.reply;
    await boot();
    await vi.advanceTimersByTimeAsync(200);
    ask.fail();
    await vi.advanceTimersByTimeAsync(100);
    p.hide();
    await vi.advanceTimersByTimeAsync(2000);
    expect(selects).toBe(1);
    expect(allIssues()).toEqual([[{ c: "select_failed", n: 4 }]]);
  });

  it("static: the exit is a boolean set by the two listeners, and no time is read for it", () => {
    const code = (f: string) =>
      readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(
        /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
        "",
      );
    // Since the boot and core split (faster-tag.md C) the boot (start.ts)
    // owns the listeners and the boolean; the core only reads it.
    const start = code("start.ts");
    // One boolean, false on the page and at each pass's own request, true only in `leave`.
    expect(start).toMatch(/\{ v: PROTOCOL, cfg, c, e, script, left: false, asking: false \}/);
    expect(start.match(/\bleft = true\b/g)).toHaveLength(1);
    expect(start.match(/\bleft = false\b/g)).toHaveLength(1);
    const leave = /const leave = \(gone: boolean\) => \{[\s\S]*?\n {2}\};/.exec(start)?.[0] ?? "";
    expect(leave).toContain("left = true;");
    expect(leave).not.toMatch(/Date|performance|timeStamp|now\(/);
    // The listeners: pagehide, and a visibilitychange that finds the page hidden.
    expect(start).toMatch(/addEventListener\("pagehide", \(\) => leave\(true\)\)/);
    expect(start).toMatch(
      /addEventListener\("visibilitychange", \(\) => \{\s*if \(document\.hidden\) leave\(false\);\s*\}\)/,
    );
    // The state of the page is read nowhere else: a page that loaded hidden sets nothing.
    expect(start.match(/document\.hidden|visibilityState/g)).toHaveLength(1);
    for (const f of ["core.ts", "index.ts", "entry-boot.ts", "issues.ts"]) {
      expect(code(f), f).not.toMatch(/document\.hidden|visibilityState|timeStamp/);
      // Nobody else writes the boolean.
      expect(code(f), f).not.toMatch(/\bleft = (true|false)\b/);
    }
    // No event object is read by either listener.
    expect(start).not.toMatch(/addEventListener\("(pagehide|visibilitychange)", \(\w/);
  });
});
