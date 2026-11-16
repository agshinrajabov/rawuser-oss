/**
 * The hide holds against the site's own CSS (docs/specs/pilot-gaps.md,
 * A5; docs/specs/quiet-swap.md, "Against the page's own CSS").
 *
 * the pilot's site, 2026-10-12: `.btn-light { transition: all 0.3s ease }`. The
 * button had its style before our rule landed (the tag sits at the foot of
 * the page), `visibility` took the site's transition, and the original
 * label stayed painted for 296 to 302 ms in 11 of 12 loads.
 *
 * jsdom does not paint and runs no transition, so these tests hold what can
 * be held here: the text of the rules, that the transitions of `visibility`
 * are cancelled (those and no other, on the parts and under them), and the
 * order of the steps at the hide and at the reveal. The paint itself is
 * measured in a real browser, on a lab page with the markup of the fixture
 * this file reads (`fixtures/transition-all.html`, `window.__zoo`).
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsing } from "./helpers.ts";

const EDGE = "https://edge.test";
const FIXTURE = readFileSync(new URL("./fixtures/transition-all.html", import.meta.url), "utf8");
/** The page's own selectors for its parts, as a confirmed manifest would ship them. */
const SELECTORS = ["main h1", "p.sub", "a.btn-light"];

interface FakeAnimation {
  transitionProperty?: string;
  animationName?: string;
  currentTime: number | null;
  cancelled: boolean;
  cancel: () => void;
}

/** A running animation of the page, as `getAnimations` hands it out. */
function fake(log: string[], name: string, transitionProperty?: string): FakeAnimation {
  let time: number | null = 120;
  const a: FakeAnimation = {
    ...(transitionProperty ? { transitionProperty } : { animationName: name }),
    get currentTime() {
      return time;
    },
    // What restartAnimations does to the page's own animations: back to the start.
    set currentTime(t: number | null) {
      time = t;
      log.push(`restart ${name}`);
    },
    cancelled: false,
    cancel() {
      a.cancelled = true;
      log.push(`cancel ${name}`);
    },
  };
  return a;
}

/**
 * The engine's side of `transition: all`: an element whose computed
 * `visibility` changes runs a transition of it, and a child starts its own
 * only once the parent's has been cancelled (measured in Chromium and
 * WebKit: the child inherits the value through its own transition).
 */
function transitions(w: Window, log: string[]) {
  const live: Array<[Element, FakeAnimation]> = [];
  const waiting: Array<[FakeAnimation, Element, FakeAnimation]> = [];
  const proto = (w as unknown as { Element: { prototype: Element } }).Element.prototype;
  (proto as unknown as { getAnimations: unknown }).getAnimations = function (
    this: Element,
    opts?: { subtree?: boolean },
  ) {
    log.push(`ask ${this.tagName.toLowerCase()}${opts?.subtree ? " subtree" : ""}`);
    // A cancelled parent lets its child's own transition start.
    for (const row of waiting.filter(([parent]) => parent.cancelled)) {
      waiting.splice(waiting.indexOf(row), 1);
      live.push([row[1], row[2]]);
    }
    return live
      .filter(([el, a]) => !a.cancelled && (el === this || (opts?.subtree && this.contains(el))))
      .map(([, a]) => a);
  };
  return {
    run(el: Element, a: FakeAnimation) {
      live.push([el, a]);
    },
    after(parent: FakeAnimation, kid: Element, a: FakeAnimation) {
      waiting.push([parent, kid, a]);
    },
  };
}

function fixtureDom(url = "https://lab.test/zoo/transition-all/") {
  const dom = new JSDOM(FIXTURE, { url });
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  return dom.window as unknown as Window & typeof globalThis;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the page (fixtures/transition-all.html)", () => {
  it("carries the site's transition on the headline and the button, and our tag at the foot", () => {
    const w = fixtureDom();
    const css = w.document.querySelector("style")?.textContent ?? "";
    expect(css).toMatch(/h1 \{[^}]*transition: all 0\.3s ease/);
    expect(css).toMatch(/a\.btn-light \{[^}]*transition: all 0\.3s ease/);
    // A child with a transition and a delay of its own.
    expect(css).toMatch(/\.arrow \{[^}]*transition: all 0\.3s ease 0\.2s/);
    const tag = w.document.querySelector('script[src$="/s/template-lab.js"]');
    expect(tag?.parentElement?.tagName).toBe("BODY");
    expect(tag?.hasAttribute("async")).toBe(false);
    // After the parts, as on the pilot's site.
    const btn = w.document.querySelector("a.btn-light") as Element;
    expect(btn.compareDocumentPosition(tag as Element) & 4).toBe(4);
    for (const sel of SELECTORS) expect(w.document.querySelectorAll(sel)).toHaveLength(1);
  });
});

describe("the hide rules", () => {
  it("hold visibility hidden from the animation's first keyframe, and the animation is important", async () => {
    fixtureDom();
    const { injectHideStyle } = await import("../src/boot.ts");
    const style = injectHideStyle(SELECTORS);
    // The first rule is the style's own text, byte for byte (a hash-only CSP carries its sha256).
    expect(style.textContent).toBe("[data-rawuser]{visibility:hidden!important}");
    const rules = Array.from(style.sheet?.cssRules ?? []);
    const frames = rules.find((r) => r.cssText.startsWith("@keyframes __rwr"))?.cssText ?? "";
    expect(frames.replace(/\s+/g, "")).toBe(
      "@keyframes__rwr{from{visibility:hidden;}to{visibility:visible;}}",
    );
    const parts = rules.filter((r) => SELECTORS.includes((r as CSSStyleRule).selectorText));
    expect(parts).toHaveLength(3);
    for (const r of parts as CSSStyleRule[]) {
      expect(r.style.getPropertyValue("visibility")).toBe("hidden");
      // Not important: the animation's last keyframe has to win at 4000 ms.
      expect(r.style.getPropertyPriority("visibility")).toBe("");
      expect(r.style.getPropertyValue("animation")).toBe("__rwr 0s 4000ms both");
      // Important: the page's own animation, a reduced-motion reset of delay
      // and duration, cannot take the part's animation from us while it hides.
      expect(r.style.getPropertyPriority("animation")).toBe("important");
      // Never the page's transition switched off for the hidden time: the
      // page's own entrance by a transition has to keep running.
      expect(r.cssText).not.toContain("transition");
    }
  });

  it("the style goes at 4000 ms even when nothing reveals it (the script died mid-way)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const w = fixtureDom();
    const { injectHideStyle } = await import("../src/boot.ts");
    injectHideStyle(SELECTORS);
    vi.advanceTimersByTime(3999);
    expect(w.document.getElementById("__rawuser-hide")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(w.document.getElementById("__rawuser-hide")).toBeNull();
  });
});

describe("settle: the switch of visibility lands now", () => {
  it("cancels the transitions of visibility, on the part and under it, and no other", async () => {
    const w = fixtureDom();
    const log: string[] = [];
    const t = transitions(w, log);
    const btn = w.document.querySelector("a.btn-light") as Element;
    const arrow = w.document.querySelector(".arrow") as Element;
    const vis = fake(log, "button visibility", "visibility");
    const hover = fake(log, "button background", "background-color");
    const entrance = fake(log, "fade-in");
    const kid = fake(log, "arrow visibility", "visibility");
    t.run(btn, vis);
    t.run(btn, hover);
    t.run(btn, entrance);
    t.after(vis, arrow, kid);
    const { settle } = await import("../src/boot.ts");
    settle([btn]);
    expect(vis.cancelled).toBe(true);
    // The child's own transition starts once the parent's is gone: asked again.
    expect(kid.cancelled).toBe(true);
    expect(hover.cancelled).toBe(false);
    expect(entrance.cancelled).toBe(false);
    // The page's other animations are not touched at all.
    expect(hover.currentTime).toBe(120);
    expect(log.filter((l) => l.startsWith("cancel"))).toEqual([
      "cancel button visibility",
      "cancel arrow visibility",
    ]);
    // It stops asking once none is left.
    expect(log.at(-1)).toBe("ask a subtree");
    expect(log.filter((l) => l.startsWith("ask")).length).toBeLessThanOrEqual(4);
  });

  it("does nothing, and does not throw, where the engine has no getAnimations or refuses", async () => {
    const w = fixtureDom();
    const btn = w.document.querySelector("a.btn-light") as Element;
    const { settle } = await import("../src/boot.ts");
    expect(() => settle([btn])).not.toThrow();
    (btn as unknown as { getAnimations: unknown }).getAnimations = () => {
      throw new Error("no");
    };
    expect(() => settle([btn])).not.toThrow();
  });

  it("gives up after nine rounds on a page that keeps starting one", async () => {
    const w = fixtureDom();
    const btn = w.document.querySelector("a.btn-light") as Element;
    let asked = 0;
    (btn as unknown as { getAnimations: unknown }).getAnimations = () => {
      asked++;
      return [{ transitionProperty: "visibility", cancel() {} }];
    };
    const { settle } = await import("../src/boot.ts");
    settle([btn]);
    expect(asked).toBe(9);
  });
});

describe("at the hide: parts that already have their style (the tag at the foot)", () => {
  it("the rules go in first, then the transitions of visibility are cancelled, in the same task", async () => {
    const w = fixtureDom();
    const log: string[] = [];
    const t = transitions(w, log);
    const h1 = w.document.querySelector("h1") as Element;
    const btn = w.document.querySelector("a.btn-light") as Element;
    const rulesAtCancel: number[] = [];
    for (const [el, name] of [
      [h1, "headline visibility"],
      [btn, "button visibility"],
    ] as const) {
      const a = fake(log, name, "visibility");
      const cancel = a.cancel;
      a.cancel = () => {
        rulesAtCancel.push(
          (w.document.getElementById("__rawuser-hide") as HTMLStyleElement).sheet?.cssRules
            .length ?? 0,
        );
        cancel();
      };
      t.run(el, a);
    }
    const { injectHideStyle } = await import("../src/boot.ts");
    injectHideStyle(SELECTORS);
    // The base rule, the keyframes and the three parts were in before any cancel.
    expect(rulesAtCancel).toEqual([5, 5]);
    expect(log.filter((l) => l.startsWith("cancel")).sort()).toEqual([
      "cancel button visibility",
      "cancel headline visibility",
    ]);
  });

  it("a tagged part ([data-rawuser]) is settled too, with no selector at all", async () => {
    const w = fixtureDom();
    const log: string[] = [];
    const t = transitions(w, log);
    const a = fake(log, "headline visibility", "visibility");
    t.run(w.document.querySelector("h1") as Element, a);
    const { injectHideStyle } = await import("../src/boot.ts");
    injectHideStyle();
    expect(a.cancelled).toBe(true);
  });

  it("in the head, before the body exists, nothing is asked: a part parsed later has no transition to run", async () => {
    const dom = new JSDOM("<!doctype html><html><head></head></html>");
    const doc = dom.window.document;
    doc.body?.remove();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", dom.window);
    let asked = 0;
    (
      dom.window as unknown as { Element: { prototype: { getAnimations: unknown } } }
    ).Element.prototype.getAnimations = () => {
      asked++;
      return [];
    };
    const { injectHideStyle } = await import("../src/boot.ts");
    expect(() => injectHideStyle(SELECTORS)).not.toThrow();
    expect(asked).toBe(0);
  });
});

describe("at the reveal (index.ts)", () => {
  let sent: Array<Record<string, unknown>>;
  let selectReply: () => Promise<Response>;

  const variant = {
    customer_id: "template-lab",
    profile_key: "intent:problem",
    sections: {
      hero: {
        kind: "hero",
        headline: "New headline",
        body: "New paragraph",
        cta: { label: "New label" },
      },
    },
    generated_at: 0,
    prompt_hash: "",
  };
  const personalized = {
    source: "kv",
    cohort: "personalized",
    variant_key: "v1:variant:template-lab:problem:ai",
    selection: { intent_dim: "problem", source_dim: "ai", confidence: 0.8 },
    variant,
  };

  function page() {
    const w = fixtureDom("https://lab.test/zoo/transition-all/?utm_source=chatgpt.com");
    // The tag at the foot, running before anything was painted: not a late tag.
    parsing(w.document);
    vi.stubGlobal("location", w.location);
    vi.stubGlobal("history", w.history);
    vi.stubGlobal("sessionStorage", w.sessionStorage);
    vi.stubGlobal("navigator", { language: "en", sendBeacon: undefined });
    vi.stubGlobal("MutationObserver", w.MutationObserver);
    vi.stubGlobal("Node", w.Node);
    vi.stubGlobal("HTMLElement", w.HTMLElement);
    vi.stubGlobal("HTMLAnchorElement", w.HTMLAnchorElement);
    vi.stubGlobal("HTMLButtonElement", w.HTMLButtonElement);
    vi.stubGlobal("getComputedStyle", w.getComputedStyle.bind(w));
    vi.stubGlobal("PerformanceObserver", undefined);
    (w as unknown as { __rw: unknown }).__rw = {
      c: "template-lab",
      e: EDGE,
      h: { "/zoo/transition-all": SELECTORS },
    };
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (url.startsWith(`${EDGE}/select`)) return selectReply();
      if (url.startsWith(`${EDGE}/event`)) sent.push(JSON.parse(String(init?.body ?? "{}")));
      return Promise.resolve(new Response(JSON.stringify({ bodies: {} }), { status: 200 }));
    });
    return w;
  }

  const answerAfter = (ms: number, body: unknown) =>
    new Promise<Response>((r) =>
      setTimeout(() => r(new Response(JSON.stringify(body), { status: 200 })), ms),
    );

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    sent = [];
    selectReply = () => answerAfter(300, personalized);
  });

  it("the style goes first, the transitions of visibility are cancelled, the page's entrance starts again", async () => {
    const w = page();
    const log: string[] = [];
    const t = transitions(w, log);
    const btn = w.document.querySelector("a.btn-light") as Element;
    const arrow = w.document.querySelector(".arrow") as Element;
    const p = w.document.querySelector("p.sub") as Element;
    await import("../src/index.ts");
    const hide = () => w.document.getElementById("__rawuser-hide");
    expect(hide()).not.toBeNull();
    // Hidden, by the page's own selectors and by the tag.
    expect(w.getComputedStyle(btn).visibility).toBe("hidden");

    // What the engine starts when our style goes: the button's visibility
    // under `transition: all 0.3s ease`, then the arrow's under its own with
    // a delay; and the paragraph's entrance is still on its way.
    const states: string[] = [];
    const vis = fake(log, "button visibility", "visibility");
    const cancelVis = vis.cancel;
    vis.cancel = () => {
      states.push(`style ${hide() ? "in" : "gone"}, label ${btn.textContent?.trim()}`);
      cancelVis();
    };
    const kid = fake(log, "arrow visibility", "visibility");
    const entrance = fake(log, "paragraph opacity", "opacity");
    t.run(btn, vis);
    t.after(vis, arrow, kid);
    t.run(p, entrance);

    await vi.advanceTimersByTimeAsync(1000);
    expect(hide()).toBeNull();
    // Cancelled once our rules were gone and our words were in: shown at
    // once, already rewritten.
    expect(states).toEqual(["style gone, label New label →"]);
    expect(vis.cancelled).toBe(true);
    expect(kid.cancelled).toBe(true);
    // The page's own entrance is not cancelled; it plays again from its start.
    expect(entrance.cancelled).toBe(false);
    expect(entrance.currentTime).toBe(0);
    // Every cancel came before the first restart, and nothing cancelled is restarted.
    const steps = log.filter((l) => !l.startsWith("ask"));
    expect(steps).toEqual([
      "cancel button visibility",
      "cancel arrow visibility",
      "restart paragraph opacity",
    ]);
    expect(w.document.querySelector("h1")?.textContent).toBe("New headline");

    // Nothing of ours is left on the part: the site's own transition (its
    // hover) is what it computes again.
    expect(w.getComputedStyle(btn).visibility).not.toBe("hidden");
    expect(w.document.querySelectorAll("style")).toHaveLength(1);
    expect(btn.getAttribute("style")).toBeNull();
    expect(sent.map((e) => e.event_type)).toContain("variant_shown");
  });

  it("the cap reveals the original the same way when the edge does not answer", async () => {
    const w = page();
    selectReply = () => new Promise(() => {});
    const log: string[] = [];
    const t = transitions(w, log);
    const btn = w.document.querySelector("a.btn-light") as Element;
    await import("../src/index.ts");
    const vis = fake(log, "button visibility", "visibility");
    t.run(btn, vis);
    await vi.advanceTimersByTimeAsync(1500);
    expect(w.document.getElementById("__rawuser-hide")).toBeNull();
    expect(vis.cancelled).toBe(true);
    expect(btn.textContent?.trim()).toBe("Start a pilot →");
  });
});
