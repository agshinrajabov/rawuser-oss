/**
 * holdVariant: a framework that hydrates after the swap and restores the
 * server text gets overwritten again; text the site changed on its own is
 * left alone.
 */
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

function page(html: string) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("HTMLAnchorElement", dom.window.HTMLAnchorElement);
  vi.stubGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
  return dom.window.document;
}

const variant = {
  customer_id: "c",
  profile_key: "intent:brand",
  sections: { hero: { kind: "hero", headline: "New headline", body: "New body" } },
  generated_at: 0,
  prompt_hash: "h",
};

describe("holdVariant", () => {
  it("re-applies when the text reverts to the original, at each check", async () => {
    const doc = page(`<h1 class="hero-title">Old headline</h1><p class="lead">Old body</p>`);
    const { applyVariant, holdVariant } = await import("../src/apply.ts");
    const targets = {
      "hero.headline": { css: ["h1.hero-title"], text: [], structural: "" },
      "hero.body": { css: ["p.lead"], text: [], structural: "" },
    };
    expect(applyVariant(variant as never, targets)).toBe(true);
    const timers: Array<() => void> = [];
    holdVariant(targets, [10, 20], (fn) => timers.push(fn));
    // Hydration puts the server text back.
    const h1 = doc.querySelector("h1") as HTMLElement;
    h1.textContent = "Old headline";
    timers[0]?.();
    expect(h1.textContent).toBe("New headline");
    // The site changed the text on its own: left alone.
    h1.textContent = "Something the site wrote";
    timers[1]?.();
    expect(h1.textContent).toBe("Something the site wrote");
    expect(doc.querySelector("p")?.textContent).toBe("New body");
  });

  it("undoes a revert that happened before the hold started, at once (the zoo's React rotator)", async () => {
    const doc = page(`<h1 class="hero-title">Old headline</h1>`);
    const { applyVariant, holdVariant } = await import("../src/apply.ts");
    const targets = { "hero.headline": { css: ["h1.hero-title"], text: [], structural: "" } };
    expect(applyVariant(variant as never, targets)).toBe(true);
    const h1 = doc.querySelector("h1") as HTMLElement;
    h1.textContent = "Old headline";
    holdVariant(targets, [], () => undefined);
    expect(h1.textContent).toBe("New headline");
  });

  it("re-finds a replaced node (hydration recreated the element)", async () => {
    const doc = page(`<div id="root"><h1 class="hero-title">Old headline</h1></div>`);
    const { applyVariant, holdVariant } = await import("../src/apply.ts");
    const targets = { "hero.headline": { css: ["h1.hero-title"], text: [], structural: "" } };
    applyVariant(variant as never, targets);
    const timers: Array<() => void> = [];
    holdVariant(targets, [10], (fn) => timers.push(fn));
    const root = doc.getElementById("root") as HTMLElement;
    root.innerHTML = `<h1 class="hero-title">Old headline</h1>`;
    timers[0]?.();
    expect(doc.querySelector("h1")?.textContent).toBe("New headline");
  });
});

describe("holdVariant observer", () => {
  it("undoes a hydration revert as a microtask, before the timers", async () => {
    const doc = page(`<h1 class="hero-title">Old headline</h1>`);
    const { applyVariant, holdVariant } = await import("../src/apply.ts");
    vi.stubGlobal(
      "MutationObserver",
      (doc.defaultView as Window & typeof globalThis).MutationObserver,
    );
    const targets = { "hero.headline": { css: ["h1.hero-title"], text: [], structural: "" } };
    applyVariant(variant as never, targets);
    holdVariant(targets, [], () => 0);
    const h1 = doc.querySelector("h1") as HTMLElement;
    h1.textContent = "Old headline";
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(h1.textContent).toBe("New headline");
  });
});

describe("holdVariant when the version renders as the original", () => {
  it("does not rewrite, so the observer cannot feed itself (lumera.test /approach, 2026-09-16)", async () => {
    // The page typed its capitals and its arrow into the label; matchOriginal
    // restores both, so "Start a build" is written as "START A BUILD →", the
    // original. Before the fix the hold compared against the raw value,
    // found the element "reverted" on every mutation it caused, and looped.
    const doc = page(`<a class="cta-btn">START A BUILD →</a>`);
    const { applyVariant, holdVariant, lastApplied } = await import("../src/apply.ts");
    const win = doc.defaultView as Window & typeof globalThis;
    vi.stubGlobal("MutationObserver", win.MutationObserver);
    const targets = { "cta.cta.label": { css: ["a.cta-btn"], text: [], structural: "" } };
    const v = { sections: { cta: { kind: "cta", cta: { label: "Start a build" } } } };
    applyVariant(v as never, targets);
    const a = doc.querySelector("a.cta-btn") as HTMLElement;
    expect(a.textContent).toBe("START A BUILD →");
    expect(lastApplied()[0]?.rendered).toBe("START A BUILD →");
    const proto = win.Element.prototype;
    const writes = vi.spyOn(proto, "textContent", "set");
    holdVariant(targets, [], () => 0);
    a.textContent = "START A BUILD →";
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
    // One write: ours, above. The hold added none.
    expect(writes).toHaveBeenCalledTimes(1);
    writes.mockRestore();
  });

  it("still undoes a real revert when the rendered text differs from the original", async () => {
    const doc = page(`<a class="cta-btn">START A BUILD →</a>`);
    const { applyVariant, holdVariant } = await import("../src/apply.ts");
    const win = doc.defaultView as Window & typeof globalThis;
    vi.stubGlobal("MutationObserver", win.MutationObserver);
    const targets = { "cta.cta.label": { css: ["a.cta-btn"], text: [], structural: "" } };
    const v = { sections: { cta: { kind: "cta", cta: { label: "Book a sprint" } } } };
    applyVariant(v as never, targets);
    const a = doc.querySelector("a.cta-btn") as HTMLElement;
    expect(a.textContent).toBe("BOOK A SPRINT →");
    holdVariant(targets, [], () => 0);
    a.textContent = "START A BUILD →";
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(a.textContent).toBe("BOOK A SPRINT →");
  });
});
