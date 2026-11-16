/**
 * The proof engine in the snippet (docs/specs/proof-engine.md, A and C):
 * - a holdout answer writes nothing and installs the conversion listeners;
 * - the no-signal branch installs them too (fault 2);
 * - the arm and the version id ride on every event of the page,
 *   conversions included; a late treat answer reports its arm;
 * - a page written early from the tab's copy reports the carried body's id;
 * - no kept lengths are ever sent (privacy review condition 2).
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

describe("holdout", () => {
  it("reveals without writing, reports the arm and the would-be body id, and counts clicks", async () => {
    const w = page();
    selectReply = () => Promise.resolve(json(holdout));
    await boot();
    expect(headline()).toBe("Old headline");
    expect(document.getElementById("__rawuser-hide")).toBeNull();
    const shown = events("variant_shown");
    expect(shown).toHaveLength(1);
    expect(shown[0]?.body).toMatchObject({ cohort: "holdout", arm: "holdout", body_id: BODY_ID });
    click(w as never);
    const conv = events("conversion");
    expect(conv).toHaveLength(1);
    expect(conv[0]?.body).toMatchObject({
      conversion_label: "trial_start",
      cohort: "holdout",
      arm: "holdout",
      body_id: BODY_ID,
    });
    expect(typeof conv[0]?.body.visit).toBe("string");
  });
});

describe("treat", () => {
  it("writes the version and sends the arm and the body id on the exposure and the conversion", async () => {
    const w = page();
    await boot();
    expect(headline()).toBe("New headline");
    expect(events("variant_shown")[0]?.body).toMatchObject({ arm: "treat", body_id: BODY_ID });
    click(w as never);
    expect(events("conversion")[0]?.body).toMatchObject({
      cohort: "personalized",
      arm: "treat",
      body_id: BODY_ID,
    });
  });

  it("a late treat answer is skipped kind late and keeps its arm (intent-to-treat)", async () => {
    page();
    selectReply = () => new Promise((r) => setTimeout(() => r(json(treat)), 2500));
    await boot(15_000);
    expect(headline()).toBe("Old headline");
    const skipped = events("personalization_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.body).toMatchObject({ kind: "late", arm: "treat", body_id: BODY_ID });
  });

  it("an answer without an arm (no test running) sends none", async () => {
    page();
    const { arm: _arm, ...noArm } = treat;
    selectReply = () => Promise.resolve(json(noArm));
    await boot();
    expect(events("variant_shown")[0]?.body.arm).toBeUndefined();
    expect(events("variant_shown")[0]?.body.body_id).toBe(BODY_ID);
  });
});

describe("no signal", () => {
  it("installs the conversion listeners on a page without a version", async () => {
    const w = page();
    selectReply = () => Promise.resolve(json(noSignal));
    await boot();
    expect(events("no_signal_passthrough")).toHaveLength(1);
    click(w as never);
    const conv = events("conversion");
    expect(conv).toHaveLength(1);
    expect(conv[0]?.body).toMatchObject({ cohort: "no_signal", conversion_label: "trial_start" });
    expect(conv[0]?.body.arm).toBeUndefined();
    expect(typeof conv[0]?.body.visit).toBe("string");
  });

  it("a no-signal answer without targets counts nothing", async () => {
    const w = page();
    const { conversion_targets: _c, ...bare } = noSignal;
    selectReply = () => Promise.resolve(json(bare));
    await boot();
    click(w as never);
    expect(events("conversion")).toHaveLength(0);
  });
});

describe("body carry", () => {
  it("a page written early from the tab's copy reports the carried body's id", async () => {
    const CARRIED = "fedcba9876543210";
    const now = Date.now();
    page("https://site.test/", (w) => {
      w.sessionStorage.setItem("__rw_carry", JSON.stringify({ i: "problem", s: "ai", t: now }));
      w.sessionStorage.setItem(
        "__rw_body",
        JSON.stringify({
          i: "problem",
          s: "ai",
          t: now,
          p: { "/": { sections, targets, body_id: CARRIED } },
        }),
      );
    });
    selectReply = () => Promise.resolve(json({ ...treat, carried: true }));
    await boot();
    expect(headline()).toBe("New headline");
    const shown = events("variant_shown")[0]?.body;
    expect(shown).toMatchObject({ body_carry: 1, body_id: CARRIED, arm: "treat" });
  });
});

describe("no kept lengths (privacy review condition 2)", () => {
  it("no event carries a kept_lengths field", async () => {
    const w = page();
    await boot();
    click(w as never);
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) expect(s.raw).not.toContain("kept");
  });
});

describe("the source name and the tag bit (N1, N3)", () => {
  it("echoes what /select said on the exposure and the conversion, nothing on a no-signal page", async () => {
    const w = page();
    selectReply = () => Promise.resolve(json({ ...treat, source_name: "chatgpt", tagged: true }));
    await boot();
    expect(events("variant_shown")[0]?.body).toMatchObject({ source_name: "chatgpt", tagged: 1 });
    click(w as never);
    expect(events("conversion")[0]?.body).toMatchObject({ source_name: "chatgpt", tagged: 1 });
  });

  it("sends neither when the answer has none", async () => {
    page();
    await boot();
    const body = events("variant_shown")[0]?.body ?? {};
    expect(body).not.toHaveProperty("source_name");
    expect(body).not.toHaveProperty("tagged");
  });

  it("a no-signal page sends neither", async () => {
    const w = page();
    selectReply = () => Promise.resolve(json({ ...noSignal, source_name: "google", tagged: true }));
    await boot();
    click(w as never);
    for (const s of sent) {
      expect(s.body).not.toHaveProperty("source_name");
      expect(s.body).not.toHaveProperty("tagged");
    }
  });
});
