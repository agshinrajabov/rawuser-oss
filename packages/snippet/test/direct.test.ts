/**
 * Visitors with no signal in the snippet (docs/specs/direct-visitors.md §3 to
 * §6): the tab keeps the edge's `kc` (a word, `none:direct`, or nothing), a
 * click on a counted button with a word writes it, `nd` rides on the page's
 * events, and the page as built of a learned default sends its arm and `nd`
 * on the passthrough and the clicks. Nothing about the click is sent beyond
 * what a conversion always carried.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsing } from "./helpers.ts";

const EDGE = "https://edge.test";
const BODY_ID = "0123456789abcdef";
const CONV = [
  {
    section_path: "hero.cta",
    conversion_label: "trial_start",
    css: ["a.cta"],
    text: [],
    structural: "",
  },
];
const sections = { hero: { kind: "hero", headline: "New headline" } };
const variant = {
  customer_id: "acme",
  profile_key: "intent:problem",
  sections,
  generated_at: 0,
  prompt_hash: "h",
  body_id: BODY_ID,
};
const targets = { "hero.headline": { css: ["h1.hero"], text: [], structural: "" } };
const selection = { intent_dim: "problem", source_dim: "ai", confidence: 0.8 };

const treat = {
  source: "kv",
  cohort: "personalized",
  arm: "treat",
  body_id: BODY_ID,
  variant_key: "v1:variant:acme:problem:ai",
  selection,
  variant,
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
  selection: { intent_dim: "none", source_dim: "none", confidence: 0 },
  conversion_targets: CONV,
};

interface Sent {
  body: Record<string, unknown>;
  raw: string;
}
let sent: Sent[];
let selectReply: () => Promise<Response>;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const HTML = `<h1 class="hero">Old headline</h1><a class="cta" href="#">Start</a>`;

function page(url = "https://site.test/", seed?: (w: Window) => void) {
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
  seed?.(w as unknown as Window);
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (url.startsWith(`${EDGE}/select`)) return selectReply();
    if (url.startsWith(`${EDGE}/carry`)) return Promise.resolve(json({ bodies: {} }));
    if (url.startsWith(`${EDGE}/event`)) {
      const raw = String(init?.body ?? "");
      sent.push({ raw, body: JSON.parse(raw) as Record<string, unknown> });
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return w;
}

/** rich.js as setup-rich.ts loaded it, with the question's writer replaced. */
const realRich = (globalThis as { __rwx?: object }).__rwx;
const withChoice = (choice: unknown) => ({ ...realRich, choice });
const events = (type: string) => sent.filter((s) => s.body.event_type === type);
const headline = () => document.querySelector("h1")?.textContent;
function click(w: { MouseEvent: typeof MouseEvent }) {
  (document.querySelector("a.cta") as HTMLElement).dispatchEvent(
    new w.MouseEvent("click", { bubbles: true }),
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  sent = [];
  selectReply = () => Promise.resolve(json(treat));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function boot(ms = 5000) {
  await import("../src/index.ts");
  await vi.advanceTimersByTimeAsync(ms);
}

const carry = () =>
  JSON.parse(sessionStorage.getItem("__rw_carry") ?? "null") as {
    i: string;
    s: string;
  } | null;

describe("the tab keeps the edge's kc", () => {
  it("a no-signal page that names pricing keeps pricing:direct", async () => {
    page("https://site.test/pricing");
    selectReply = () => Promise.resolve(json({ ...noSignal, kc: "pricing:direct" }));
    await boot();
    expect(carry()).toMatchObject({ i: "pricing", s: "direct" });
  });

  it("kc '' keeps nothing even on a personalised answer", async () => {
    page();
    selectReply = () => Promise.resolve(json({ ...treat, kc: "" }));
    await boot();
    expect(headline()).toBe("New headline");
    expect(carry()).toBeNull();
  });

  it("without kc the selection is kept as before", async () => {
    page();
    await boot();
    expect(carry()).toMatchObject({ i: "problem", s: "ai" });
  });

  it("none:direct is kept for a learned default's original", async () => {
    page();
    selectReply = () => Promise.resolve(json({ ...noSignal, kc: "none:direct" }));
    await boot();
    expect(carry()).toMatchObject({ i: "none", s: "direct" });
  });

  it("a customer with the carry off keeps nothing", async () => {
    page("https://site.test/pricing", (w) => {
      (w as unknown as { __rw: Record<string, unknown> }).__rw.nc = 1;
    });
    selectReply = () => Promise.resolve(json({ ...noSignal, kc: "pricing:direct" }));
    await boot();
    expect(carry()).toBeNull();
  });
});

describe("a click on a counted button with a word", () => {
  it("writes the word, and the conversion carries nothing new", async () => {
    const w = page();
    selectReply = () =>
      Promise.resolve(json({ ...noSignal, conversion_targets: [{ ...CONV[0], i: "pricing" }] }));
    await boot();
    expect(carry()).toBeNull();
    click(w as never);
    expect(carry()).toMatchObject({ i: "pricing", s: "direct" });
    const conv = events("conversion")[0]?.body ?? {};
    expect(conv).not.toHaveProperty("i");
    expect(Object.keys(conv).sort()).toEqual([
      "cohort",
      "conversion_label",
      "event_type",
      "page_path",
      "visit",
    ]);
  });
});

describe("nd and the arm on a visit with no signal", () => {
  it("a learned version sends nd on its exposure and its click", async () => {
    const w = page();
    selectReply = () => Promise.resolve(json({ ...treat, nd: "l:abc:412" }));
    await boot();
    click(w as never);
    expect(events("variant_shown")[0]?.body.nd).toBe("l:abc:412");
    expect(events("conversion")[0]?.body.nd).toBe("l:abc:412");
  });

  it("a learned original sends its arm and nd on the passthrough and the click, never a source", async () => {
    const w = page();
    selectReply = () =>
      Promise.resolve(json({ ...noSignal, arm: "treat", nd: "l:abc:300", source_name: "google" }));
    await boot();
    click(w as never);
    const ns = events("no_signal_passthrough")[0]?.body ?? {};
    expect(ns).toMatchObject({ arm: "treat", nd: "l:abc:300" });
    expect(ns).not.toHaveProperty("source_name");
    expect(events("conversion")[0]?.body).toMatchObject({
      arm: "treat",
      nd: "l:abc:300",
      cohort: "no_signal",
    });
  });
});

describe("the core hands the question to rich.js", () => {
  it("only when the answer carries q, with the page and a rerun", async () => {
    const choice = vi.fn();
    page("https://site.test/", (w) => {
      (w as unknown as { __rwx: unknown }).__rwx = withChoice(choice);
    });
    vi.stubGlobal("__rwx", withChoice(choice));
    const q = {
      t: "Q?",
      a: [
        ["a", "A"],
        ["b", "B"],
      ],
      s: ["a.cta"],
    };
    selectReply = () => Promise.resolve(json({ ...noSignal, q }));
    await boot();
    expect(choice).toHaveBeenCalledTimes(1);
    expect(choice.mock.calls[0]?.[0]).toEqual(q);
    expect(choice.mock.calls[0]?.[1]).toMatchObject({ c: "acme", e: EDGE });
    expect(typeof choice.mock.calls[0]?.[2]).toBe("function");
  });

  it("not without q", async () => {
    const choice = vi.fn();
    page();
    vi.stubGlobal("__rwx", withChoice(choice));
    await boot();
    expect(choice).not.toHaveBeenCalled();
  });
});

describe("the choice reserve's ways out (reserve.ts)", () => {
  const q = {
    t: "Q?",
    a: [
      ["a", "A"],
      ["b", "B"],
    ],
    s: ["a.cta"],
  };
  /** The customer's script added the reserve before the boot (choiceReserveJs). */
  const reserved = (w: Window) => {
    const s = w.document.createElement("style");
    s.id = "__rawuser-q";
    w.document.head.appendChild(s);
  };
  const reserve = () => document.getElementById("__rawuser-q");
  /** The customer's tag as the edge serves it: the boot, then the core. */
  const bootTag = async (ms = 5000) => {
    await import("./split-entry.ts");
    await vi.advanceTimersByTimeAsync(ms);
  };

  it("an answer without the question (killed, off, a signal only the edge sees): gone", async () => {
    page("https://site.test/", reserved);
    selectReply = () => Promise.resolve(json(noSignal));
    await bootTag();
    expect(reserve()).toBeNull();
  });

  it("a failed /select: gone", async () => {
    page("https://site.test/", reserved);
    selectReply = () => Promise.reject(new TypeError("network"));
    await bootTag();
    expect(reserve()).toBeNull();
  });

  it("the holdout: gone and the tab asked; a failure does not mark the tab", async () => {
    page("https://site.test/", reserved);
    selectReply = () => Promise.resolve(json(holdout));
    await bootTag();
    expect(reserve()).toBeNull();
    expect(sessionStorage.getItem("__rw_q")).toBe("1");
    vi.resetModules();
    page("https://site.test/", reserved);
    selectReply = () => Promise.reject(new TypeError("network"));
    await bootTag();
    expect(reserve()).toBeNull();
    expect(sessionStorage.getItem("__rw_q")).toBeNull();
  });

  it("an answer that asks keeps it for the row", async () => {
    vi.resetModules();
    page("https://site.test/", (w) => {
      reserved(w);
      (w as unknown as { __rwx: unknown }).__rwx = withChoice(vi.fn());
    });
    vi.stubGlobal("__rwx", withChoice(vi.fn()));
    selectReply = () => Promise.resolve(json({ ...noSignal, q }));
    await bootTag();
    expect(reserve()).not.toBeNull();
  });

  it("rich.js that does not load: gone", async () => {
    page("https://site.test/", reserved);
    vi.stubGlobal("__rwx", undefined);
    selectReply = () => Promise.resolve(json({ ...noSignal, q }));
    await boot(50);
    const rich = document.querySelector<HTMLScriptElement>('script[src*="/rich.js"]');
    expect(rich).not.toBeNull();
    expect(reserve()).not.toBeNull();
    rich?.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("error"));
    await vi.advanceTimersByTimeAsync(10);
    expect(reserve()).toBeNull();
  });

  it("an answer asks the edge again at once, not after a route render", async () => {
    const choice = vi.fn();
    page("https://site.test/", (w) => {
      (w as unknown as { __rwx: unknown }).__rwx = withChoice(choice);
    });
    vi.stubGlobal("__rwx", withChoice(choice));
    let asked = 0;
    selectReply = () => {
      asked++;
      return Promise.resolve(json(asked === 1 ? { ...noSignal, q } : treat));
    };
    await boot();
    expect(asked).toBe(1);
    const again = choice.mock.calls[0]?.[2] as () => void;
    sessionStorage.setItem("__rw_carry", JSON.stringify({ i: "qa", s: "direct", t: Date.now() }));
    again();
    // No wait for a mutation that never comes (afterRender's 400 + 60 ms).
    await vi.advanceTimersByTimeAsync(5);
    expect(asked).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(headline()).toBe("New headline");
  });
});
