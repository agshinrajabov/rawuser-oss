/**
 * The rich writers on demand (2026-09-30): the core without /rich.js leaves
 * a split part as the page built it, the loader injects the script only on
 * the listed pages and once, the apply waits for it inside the reveal cap,
 * and a /select answer that needs it loads it when the list missed.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RichWriters } from "../src/rich-api.ts";

const g = globalThis as { __rwx?: RichWriters };
let writers: RichWriters | undefined;

beforeEach(() => {
  writers = g.__rwx;
});

afterEach(async () => {
  g.__rwx = writers;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  (await import("../src/rich-loader.ts")).resetRichLoader();
});

function page(body: string) {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head></head><body>${body}</body></html>`);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("HTMLAnchorElement", dom.window.HTMLAnchorElement);
  vi.stubGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle);
  return dom.window.document;
}

const WORDS = ["Your", "visitors", "already", "arrive", "through", "AI"];
const SPLIT = `<h1>${WORDS.map((w) => `<span class="w">${w}</span>`).join(" ")}</h1>`;
const TEMPLATE = {
  css: ["h1"],
  text: [],
  structural: "",
  inline: {
    icons: "none",
    emphasis: 0,
    split: true,
    animated_text: false,
    template: WORDS.join(" "),
  },
};
const LINED = `<h1><div class="line">Your visitors already</div><div class="line">arrive through AI tools</div><div class="line">and compare.</div></h1>`;
const LINES = {
  css: ["h1"],
  text: [],
  structural: "",
  inline: { icons: "none", emphasis: 0, split: true, animated_text: false, lines: 3 },
};
const version = (headline: string) => ({ sections: { hero: { kind: "hero", headline } } }) as never;

describe("the core without the rich writers", () => {
  it("leaves a word-split part whole, as a template mismatch", async () => {
    const doc = page(SPLIT);
    const before = doc.querySelector("h1")?.innerHTML;
    g.__rwx = undefined;
    const { applyVariant, lastSkip } = await import("../src/apply.ts");
    const ok = applyVariant(
      version("Every visit gets its own page"),
      { "hero.headline": TEMPLATE } as never,
      () => 0,
    );
    expect(ok).toBe(false);
    expect(lastSkip()).toBe("template-mismatch");
    expect(doc.querySelector("h1")?.innerHTML).toBe(before);
  });

  it("leaves a part cut into lines whole, as a lines skip", async () => {
    const doc = page(LINED);
    const before = doc.querySelector("h1")?.innerHTML;
    g.__rwx = undefined;
    const { applyVariant, lastSkip } = await import("../src/apply.ts");
    const ok = applyVariant(
      version("Every visit gets its own page today"),
      { "hero.headline": LINES } as never,
      () => 0,
    );
    expect(ok).toBe(false);
    expect(lastSkip()).toBe("lines");
    expect(doc.querySelector("h1")?.innerHTML).toBe(before);
  });

  it("still writes a page that has not split yet (the pre-split write needs no writer)", async () => {
    const doc = page("<h1>Your visitors already arrive through AI</h1>");
    g.__rwx = undefined;
    const { applyVariant } = await import("../src/apply.ts");
    const ok = applyVariant(
      version("Every visit gets its own page"),
      { "hero.headline": TEMPLATE } as never,
      () => 0,
    );
    expect(ok).toBe(true);
    expect(doc.querySelector("h1")?.textContent).toBe("Every visit gets its own page");
  });

  it("falls back without throwing: one height, no reserve, lines settled at once", async () => {
    const doc = page(SPLIT);
    g.__rwx = undefined;
    const api = await import("../src/rich-api.ts");
    const el = doc.querySelector("h1") as Element;
    expect(api.rotationHeights(el, () => 42)).toEqual([42]);
    expect(() => api.reserveRotationHeight(el, () => 42)).not.toThrow();
    expect(() => api.keepRotationReserved(el, () => 42)).not.toThrow();
    expect(api.writeTemplate(el, "a b c d e f")).toBe(false);
    expect(api.writeLines(el, "a b c")).toBe(false);
    await expect(api.linesSettled()).resolves.toBeUndefined();
    expect((el as HTMLElement).style.minHeight).toBe("");
  });

  it("writes the same part once the writers are in", async () => {
    const doc = page(SPLIT);
    const { applyVariant } = await import("../src/apply.ts");
    const ok = applyVariant(
      version("Every visit gets its own page"),
      { "hero.headline": TEMPLATE } as never,
      () => 0,
    );
    expect(ok).toBe(true);
    const words = Array.from(doc.querySelectorAll("h1 .w")).map((w) => w.textContent);
    expect(words).toEqual(["Every", "visit", "gets", "its", "own", "page"]);
  });
});

describe("the loader", () => {
  it("lists a page by its exact path, or the root's when the page has no rules of its own", async () => {
    const { richListed } = await import("../src/rich-loader.ts");
    expect(richListed(undefined, "/")).toBe(false);
    expect(richListed(["/lab"], "/lab")).toBe(true);
    expect(richListed(["/lab"], "/")).toBe(false);
    expect(richListed(["/"], "/blog/post", { "/": ["h1"] })).toBe(true);
    expect(richListed(["/"], "/pricing", { "/pricing": ["h1"] })).toBe(false);
  });

  it("injects the script once, with the build's version in its URL", async () => {
    const doc = page("<h1>Plain</h1>");
    g.__rwx = undefined;
    const { RICH_VERSION, loadRich } = await import("../src/rich-loader.ts");
    const a = loadRich("https://edge.test", doc);
    const b = loadRich("https://edge.test", doc);
    expect(a).toBe(b);
    const scripts = doc.querySelectorAll("script");
    expect(scripts.length).toBe(1);
    const s = scripts[0] as HTMLScriptElement;
    expect(s.getAttribute("src")).toBe(`https://edge.test/rich.js?v=${RICH_VERSION}`);
    expect(s.async).toBe(true);
    s.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event("error"));
    await expect(a).resolves.toBeUndefined();
  });

  it("injects nothing when the writers are already in", async () => {
    const doc = page("<h1>Plain</h1>");
    const { loadRich } = await import("../src/rich-loader.ts");
    await loadRich("https://edge.test", doc);
    expect(doc.querySelectorAll("script").length).toBe(0);
  });

  it("a /select answer needs the writers only for a template or lines the operator did not clear", async () => {
    const { targetsNeedRich } = await import("../src/rich-loader.ts");
    expect(targetsNeedRich(undefined)).toBe(false);
    expect(targetsNeedRich({ "hero.headline": TEMPLATE } as never)).toBe(true);
    expect(targetsNeedRich({ "hero.headline": LINES } as never)).toBe(true);
    expect(targetsNeedRich({ "hero.headline": { ...TEMPLATE, plain: true } } as never)).toBe(false);
    expect(targetsNeedRich({ "hero.headline": { ...LINES, skip: true } } as never)).toBe(false);
    expect(
      targetsNeedRich({ "hero.headline": { css: ["h1"], text: [], structural: "" } } as never),
    ).toBe(false);
  });

  it("the fallback load settles when the script runs, and the answer is written", async () => {
    const doc = page(SPLIT);
    g.__rwx = undefined;
    const { loadRich, richWait, targetsNeedRich } = await import("../src/rich-loader.ts");
    const { applyWhenReady } = await import("../src/ready.ts");
    const targets = { "hero.headline": TEMPLATE } as never;
    // The page was not on the list: the answer's targets start the load.
    expect(doc.querySelectorAll("script").length).toBe(0);
    if (targetsNeedRich(targets)) void loadRich("https://edge.test", doc);
    const s = doc.querySelector("script") as HTMLScriptElement;
    expect(s.getAttribute("src")).toContain("/rich.js?v=");
    const done = applyWhenReady(
      { source: "kv", variant: version("Every visit gets its own page"), targets } as never,
      false,
      richWait(Date.now() + 1500),
    );
    // The script runs: it registers the writers, then its load event fires.
    g.__rwx = writers;
    s.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event("load"));
    expect(await done).toBe(true);
    expect(doc.querySelector("h1 .w")?.textContent).toBe("Every");
  });

  it("a stuck script holds nothing past the reveal cap", async () => {
    vi.useFakeTimers();
    const doc = page(SPLIT);
    g.__rwx = undefined;
    const { loadRich, richWait } = await import("../src/rich-loader.ts");
    void loadRich("https://edge.test", doc);
    let settled = false;
    void richWait(Date.now() + 1500).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it("no wait at all when nothing is loading", async () => {
    const { richWait } = await import("../src/rich-loader.ts");
    let settled = false;
    void richWait(Date.now() + 1500).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(true);
  });
});

describe("applyWhenReady waits for the writers", () => {
  it("applies only after the rich wait settles", async () => {
    const doc = page(SPLIT);
    g.__rwx = undefined;
    const { applyWhenReady } = await import("../src/ready.ts");
    let release: () => void = () => {};
    const rich = new Promise<void>((r) => {
      release = r;
    });
    let result: boolean | undefined;
    const done = applyWhenReady(
      {
        source: "kv",
        variant: version("Every visit gets its own page"),
        targets: { "hero.headline": TEMPLATE },
      } as never,
      false,
      rich,
    ).then((r) => {
      result = r;
      return r;
    });
    // Past the fonts wait (500 ms at most), still waiting for rich.
    await new Promise((r) => setTimeout(r, 550));
    expect(result).toBeUndefined();
    expect(doc.querySelector("h1 .w")?.textContent).toBe("Your");
    g.__rwx = writers;
    release();
    expect(await done).toBe(true);
    expect(doc.querySelector("h1 .w")?.textContent).toBe("Every");
  });

  it("on a client-side navigation too", async () => {
    const doc = page(SPLIT);
    g.__rwx = undefined;
    const { applyWhenReady } = await import("../src/ready.ts");
    let release: () => void = () => {};
    const rich = new Promise<void>((r) => {
      release = r;
    });
    const done = applyWhenReady(
      {
        source: "kv",
        variant: version("Every visit gets its own page"),
        targets: { "hero.headline": TEMPLATE },
      } as never,
      true,
      rich,
    );
    await Promise.resolve();
    expect(doc.querySelector("h1 .w")?.textContent).toBe("Your");
    g.__rwx = writers;
    release();
    expect(await done).toBe(true);
    expect(doc.querySelector("h1 .w")?.textContent).toBe("Every");
  });
});

describe("the early write without the writers", () => {
  const kept = {
    sections: { hero: { kind: "hero", headline: "Every visit gets its own page" } },
    targets: { "hero.headline": TEMPLATE },
    prompt_hash: "",
  } as never;

  it("writes nothing, not half a page, while a split part waits for rich.js", async () => {
    const doc = page(`<p class="lead">Old lead</p>${SPLIT}`);
    const before = doc.querySelector("h1")?.innerHTML;
    g.__rwx = undefined;
    const { earlyApply } = await import("../src/early.ts");
    const early = earlyApply({
      sections: {
        hero: { kind: "hero", body: "New lead", headline: "Every visit gets its own page" },
      },
      targets: {
        "hero.body": { css: ["p.lead"], text: [], structural: "" },
        "hero.headline": TEMPLATE,
      },
      prompt_hash: "",
    } as never);
    expect(early.applied).toBe(false);
    expect(doc.querySelector("p")?.textContent).toBe("Old lead");
    expect(doc.querySelector("h1")?.innerHTML).toBe(before);
    early.stop();
  });

  it("writes a part the page has not split yet, as before", async () => {
    const doc = page("<h1>Your visitors already arrive through AI</h1>");
    g.__rwx = undefined;
    const { earlyApply } = await import("../src/early.ts");
    const early = earlyApply(kept);
    expect(early.applied).toBe(true);
    expect(doc.querySelector("h1")?.textContent).toBe("Every visit gets its own page");
    early.stop();
  });
});
