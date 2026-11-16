/**
 * React hydration wait: on a React site the initial-load swap waits until
 * the target carries React's fiber; elsewhere it applies at once.
 */
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

function withDom(html: string) {
  const dom = new JSDOM(html);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  return dom;
}

describe("isReactSite", () => {
  it("is false on a plain page", async () => {
    const dom = withDom("<!doctype html><html><head></head><body><h1>x</h1></body></html>");
    const { isReactSite } = await import("../src/hydration.ts");
    expect(isReactSite(dom.window as unknown as Window, dom.window.document)).toBe(false);
  });

  it("is true with a Next.js chunk or the flight data global", async () => {
    const dom = withDom(
      '<!doctype html><html><head><script src="/_next/static/chunks/a.js"></script></head><body></body></html>',
    );
    const { isReactSite } = await import("../src/hydration.ts");
    expect(isReactSite(dom.window as unknown as Window, dom.window.document)).toBe(true);
    const plain = withDom("<!doctype html><html><head></head><body></body></html>");
    (plain.window as unknown as Record<string, unknown>).__next_f = [];
    expect(isReactSite(plain.window as unknown as Window, plain.window.document)).toBe(true);
  });
});

describe("isReactSite on React's own server-render marks", () => {
  it("is true with a Suspense boundary comment or the text-separator comment, false on plain comments", async () => {
    const { isReactSite, hasReactComments } = await import("../src/hydration.ts");
    const lovable = withDom(
      '<!doctype html><html><head></head><body><!--$--><div class="min-h-screen"><h1>Get your week back</h1></div><!--/$--></body></html>',
    );
    expect(isReactSite(lovable.window as unknown as Window, lovable.window.document)).toBe(true);
    const next = withDom(
      "<!doctype html><html><head></head><body><h1>We build<!-- --> <span>AI</span></h1></body></html>",
    );
    expect(hasReactComments(next.window.document)).toBe(true);
    const plain = withDom(
      "<!doctype html><html><head></head><body><!-- a note --><h1>Plain</h1><!-- another --></body></html>",
    );
    expect(isReactSite(plain.window as unknown as Window, plain.window.document)).toBe(false);
  });
});

describe("waitForHydration", () => {
  it("resolves at once when the element already carries a fiber", async () => {
    const dom = withDom("<!doctype html><html><body><h1>x</h1></body></html>");
    const h1 = dom.window.document.querySelector("h1") as Element;
    (h1 as unknown as Record<string, unknown>).__reactFiber$abc = {};
    const { waitForHydration } = await import("../src/hydration.ts");
    const setTimer = vi.fn();
    expect(await waitForHydration(() => [h1], 1000, undefined, 50, setTimer)).toBe(true);
    expect(setTimer).not.toHaveBeenCalled();
  });

  it("polls until the fiber appears", async () => {
    const dom = withDom("<!doctype html><html><body><h1>x</h1></body></html>");
    const h1 = dom.window.document.querySelector("h1") as Element;
    const { waitForHydration } = await import("../src/hydration.ts");
    let t = 0;
    const queue: Array<() => void> = [];
    const setTimer = (fn: () => void, ms: number) => {
      t += ms;
      queue.push(fn);
    };
    const p = waitForHydration(
      () => [h1],
      1000,
      undefined,
      50,
      setTimer,
      () => t,
    );
    queue.shift()?.(); // 50 ms: nothing yet
    queue.shift()?.(); // 100 ms: nothing yet
    (h1 as unknown as Record<string, unknown>).__reactFiber$abc = {};
    queue.shift()?.(); // 150 ms: hydrated
    expect(await p).toBe(true);
    expect(queue.length).toBe(0);
  });

  it("gives up after maxMs", async () => {
    const dom = withDom("<!doctype html><html><body><h1>x</h1></body></html>");
    const h1 = dom.window.document.querySelector("h1") as Element;
    const { waitForHydration } = await import("../src/hydration.ts");
    let t = 0;
    const queue: Array<() => void> = [];
    const setTimer = (fn: () => void, ms: number) => {
      t += ms;
      queue.push(fn);
    };
    const p = waitForHydration(
      () => [h1],
      200,
      undefined,
      50,
      setTimer,
      () => t,
    );
    while (queue.length > 0) queue.shift()?.();
    expect(await p).toBe(false);
    expect(t).toBe(200);
  });
});

describe("targetElements", () => {
  it("returns the elements of every renderable path", async () => {
    withDom("<!doctype html><html><body><h1>Old</h1><p>lead</p></body></html>");
    const { targetElements } = await import("../src/apply.ts");
    const els = targetElements({
      sections: { hero: { kind: "hero", headline: "New", body: "b" } },
    } as never);
    expect(els.map((e) => e.tagName)).toEqual(["H1", "P"]);
  });
});

/** A fake clock for waitForHydration: `step()` runs the next poll. */
function clock() {
  let t = 0;
  const queue: Array<() => void> = [];
  return {
    setTimer: (fn: () => void, ms: number) => {
      t += ms;
      queue.push(fn);
    },
    now: () => t,
    step: () => queue.shift()?.(),
    drain: () => {
      while (queue.length > 0) queue.shift()?.();
    },
    pending: () => queue.length,
  };
}

const fiber = (el: Node | null) => {
  (el as unknown as Record<string, unknown>).__reactFiber$abc = {};
};
const root = (n: Node | null) => {
  (n as unknown as Record<string, unknown>).__reactContainer$abc = {};
};

/**
 * A pilot site's /approach, 2026-10-06: the six targets of a ChatGPT version, as
 * the QA saw them at the write in both failing traces. React had completed
 * five; the button in #product-build was still to come, and React threw #418
 * on it 9 ms after the write.
 */
const APPROACH = `<!doctype html><html><head><script src="/_next/static/chunks/main.js"></script></head><body>
<section id="ai-feasibility-sprint"><h2 class="section-head-h2">Sprint</h2><div class="prose"><p>First.</p><p>Second.</p></div><a class="btn btn-primary" href="/contact">START A SPRINT</a></section>
<section id="ux-services"><h2 class="section-head-h2">UX</h2><div class="section-head-meta">Meta</div><div class="section-head-meta">More</div></section>
<section id="product-build"><h2 class="section-head-h2">Build</h2><a class="btn btn-primary" href="/contact">START A BUILD</a></section>
</body></html>`;
const APPROACH_TARGETS = {
  "sprint.headline": { css: ["#ai-feasibility-sprint .section-head-h2"], text: [], structural: "" },
  "sprint.body": {
    css: ["#ai-feasibility-sprint .prose p:first-of-type"],
    text: [],
    structural: "",
  },
  "sprint.cta.label": {
    css: ["#ai-feasibility-sprint .btn.btn-primary"],
    text: [],
    structural: "",
  },
  "ux.headline": { css: ["#ux-services .section-head-h2"], text: [], structural: "" },
  "ux.body": { css: ["#ux-services .section-head-meta:first-of-type"], text: [], structural: "" },
  "build.cta.label": { css: ["#product-build .btn.btn-primary"], text: [], structural: "" },
};
const APPROACH_VARIANT = {
  sections: {
    sprint: { kind: "features", headline: "a", body: "b", cta: { label: "c" } },
    ux: { kind: "features", headline: "d", body: "e" },
    build: { kind: "cta", cta: { label: "f" } },
  },
};

describe("waitForHydration on a page React hydrates in slices", () => {
  it("5 of 6 targets hydrated is not hydrated: the write waits for the sixth", async () => {
    const dom = withDom(APPROACH);
    const doc = dom.window.document;
    root(doc); // Next's app router: hydrateRoot(document)
    const { targetElements } = await import("../src/apply.ts");
    const { waitForHydration } = await import("../src/hydration.ts");
    const els = targetElements(APPROACH_VARIANT as never, APPROACH_TARGETS as never);
    expect(els).toHaveLength(6);
    const last = doc.querySelector("#product-build .btn.btn-primary");
    for (const el of els) if (el !== last) fiber(el);
    const c = clock();
    let done: boolean | undefined;
    const p = waitForHydration(
      () => targetElements(APPROACH_VARIANT as never, APPROACH_TARGETS as never),
      2500,
      undefined,
      50,
      c.setTimer,
      c.now,
    ).then((v) => {
      done = v;
    });
    // The old check resolved here, on the first poll: one target had a fiber.
    await Promise.resolve();
    expect(done).toBeUndefined();
    c.step(); // 50 ms
    c.step(); // 100 ms
    await Promise.resolve();
    expect(done).toBeUndefined();
    fiber(last);
    c.step(); // 150 ms: React reached #product-build
    await p;
    expect(done).toBe(true);
    expect(c.pending()).toBe(0);
  });

  it("a target outside every React root does not hold the write (Framer zoo shape)", async () => {
    const dom = withDom(
      '<!doctype html><html><body><main><!--$--><div id="root"><h1>Your visitors</h1></div><!--/$--><p class="sub">lead</p><a class="cta">Start</a></main></body></html>',
    );
    const doc = dom.window.document;
    const h1 = doc.querySelector("h1") as Element;
    const others = [doc.querySelector("p.sub"), doc.querySelector("a.cta")] as Element[];
    const { waitForHydration, hydrationState } = await import("../src/hydration.ts");
    const c = clock();
    let done: boolean | undefined;
    const p = waitForHydration(() => [h1, ...others], 2500, undefined, 50, c.setTimer, c.now).then(
      (v) => {
        done = v;
      },
    );
    // Before hydrateRoot: no root anywhere, React has not started.
    c.step();
    await Promise.resolve();
    expect(done).toBeUndefined();
    root(doc.getElementById("root")); // hydrateRoot(#root) at 600 ms
    expect(hydrationState(h1)).toBe(2);
    expect(others.map((e) => hydrationState(e))).toEqual([0, 0]);
    c.step();
    await Promise.resolve();
    expect(done).toBeUndefined();
    fiber(h1);
    c.step();
    await p;
    expect(done).toBe(true);
  });

  it("a Suspense boundary that hydrates late holds the write until its target has a fiber", async () => {
    const dom = withDom(
      '<!doctype html><html><body><div id="app"><h1>Head</h1><!--$--><div class="late"><p>Lead</p></div><!--/$--><!--$?--><template></template><div class="later"><a>Go</a></div><!--/$--></div></body></html>',
    );
    const doc = dom.window.document;
    root(doc);
    const app = doc.getElementById("app");
    const h1 = doc.querySelector("h1") as Element;
    const p = doc.querySelector("p") as Element;
    const a = doc.querySelector("a") as Element;
    // React completed the shell: #app and the h1; both boundaries dehydrated.
    fiber(app);
    fiber(h1);
    const { waitForHydration, hydrationState } = await import("../src/hydration.ts");
    expect([h1, p, a].map((e) => hydrationState(e))).toEqual([1, 2, 2]);
    const c = clock();
    let done: boolean | undefined;
    const wait = waitForHydration(() => [h1, p, a], 2500, undefined, 50, c.setTimer, c.now).then(
      (v) => {
        done = v;
      },
    );
    // The first boundary hydrates.
    fiber(doc.querySelector(".late"));
    fiber(p);
    c.step();
    await Promise.resolve();
    expect(done).toBeUndefined();
    // The second one, later.
    fiber(doc.querySelector(".later"));
    fiber(a);
    c.step();
    await wait;
    expect(done).toBe(true);
  });

  it("a closed boundary before the target is not the target's boundary", async () => {
    const dom = withDom(
      '<!doctype html><html><body><div id="app"><!--$--><div>a</div><!--/$--><!--$--><!--$--><i>b</i><!--/$--><!--/$--><h2>Shell</h2></div></body></html>',
    );
    const doc = dom.window.document;
    root(doc);
    fiber(doc.getElementById("app"));
    const { hydrationState } = await import("../src/hydration.ts");
    expect(hydrationState(doc.querySelector("h2") as Element)).toBe(1);
  });

  it("an element React skips (innerHTML under a hydrated parent) is settled, not waited for", async () => {
    const dom = withDom(
      '<!doctype html><html><body><div id="app"><article class="cms"><h2>From the CMS</h2></article></div></body></html>',
    );
    const doc = dom.window.document;
    root(doc);
    fiber(doc.getElementById("app"));
    fiber(doc.querySelector("article"));
    const { waitForHydration } = await import("../src/hydration.ts");
    const setTimer = vi.fn();
    expect(
      await waitForHydration(
        () => [doc.querySelector("h2") as Element],
        2500,
        undefined,
        50,
        setTimer,
      ),
    ).toBe(true);
    expect(setTimer).not.toHaveBeenCalled();
  });

  it("a target in a root that never hydrates: false at the cap, as before", async () => {
    const dom = withDom(APPROACH);
    const doc = dom.window.document;
    root(doc);
    const { targetElements } = await import("../src/apply.ts");
    const { waitForHydration } = await import("../src/hydration.ts");
    const els = () => targetElements(APPROACH_VARIANT as never, APPROACH_TARGETS as never);
    const last = doc.querySelector("#product-build .btn.btn-primary");
    for (const el of els()) if (el !== last) fiber(el);
    const c = clock();
    const p = waitForHydration(els, 2500, undefined, 50, c.setTimer, c.now);
    c.drain();
    expect(await p).toBe(false);
    expect(c.now()).toBe(2500);
  });

  it("finds the targets again when a client render replaced one", async () => {
    const dom = withDom(
      '<!doctype html><html><body><div id="app"><h1>Old</h1><p>lead</p></div></body></html>',
    );
    const doc = dom.window.document;
    root(doc);
    const { waitForHydration } = await import("../src/hydration.ts");
    const find = vi.fn(() => Array.from(doc.querySelectorAll("h1, p")));
    const c = clock();
    const p = waitForHydration(find, 2500, undefined, 50, c.setTimer, c.now);
    expect(find).toHaveBeenCalledTimes(1);
    c.step();
    expect(find).toHaveBeenCalledTimes(1); // cached while both are on the page
    // React gave up on the server HTML and rendered the subtree again.
    const fresh = doc.createElement("p");
    fresh.textContent = "lead";
    fiber(fresh);
    doc.querySelector("p")?.replaceWith(fresh);
    fiber(doc.querySelector("h1"));
    c.step();
    expect(find).toHaveBeenCalledTimes(2);
    expect(await p).toBe(true);
  });
});

/**
 * Frames, not a 50 ms poll (docs/specs/faster-tag.md E1): the default
 * scheduler checks on every animation frame and keeps a 50 ms timer for a
 * hidden tab, where no frame comes.
 */
describe("waitForHydration on animation frames", () => {
  /** A frame queue the test runs by hand; `cancelled` records cancelAnimationFrame. */
  function frames() {
    const queue = new Map<number, () => void>();
    const cancelled: number[] = [];
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      queue.set(++id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (n: number) => {
      cancelled.push(n);
      queue.delete(n);
    });
    return {
      /** One frame: run what was asked before it, 16 ms later. */
      tick: () => {
        vi.advanceTimersByTime(16);
        const due = [...queue.entries()];
        queue.clear();
        for (const [, cb] of due) cb();
      },
      pending: () => queue.size,
      cancelled,
    };
  }

  afterEach(() => vi.useRealTimers());

  it("the fiber appears between two frames: true on the next frame, before any 50 ms timer", async () => {
    vi.useFakeTimers();
    const dom = withDom("<!doctype html><html><body><h1>x</h1></body></html>");
    const h1 = dom.window.document.querySelector("h1") as Element;
    const f = frames();
    const { waitForHydration } = await import("../src/hydration.ts");
    let result: boolean | undefined;
    void waitForHydration(() => [h1], 2500).then((v) => {
      result = v;
    });
    f.tick(); // 16 ms: nothing yet
    f.tick(); // 32 ms: nothing yet
    fiber(h1);
    f.tick(); // 48 ms: hydrated, under the old poll's first 50 ms
    await Promise.resolve();
    expect(result).toBe(true);
    // Nothing left behind: no frame asked for, the fallback timer cleared.
    expect(f.pending()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hidden tab runs no frames: the timer keeps checking and finds the fiber", async () => {
    vi.useFakeTimers();
    const dom = withDom("<!doctype html><html><body><h1>x</h1></body></html>");
    const h1 = dom.window.document.querySelector("h1") as Element;
    const f = frames(); // asked for, never run
    const { waitForHydration } = await import("../src/hydration.ts");
    let result: boolean | undefined;
    void waitForHydration(() => [h1], 2500).then((v) => {
      result = v;
    });
    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(50);
    expect(result).toBeUndefined();
    fiber(h1);
    vi.advanceTimersByTime(50);
    await Promise.resolve();
    expect(result).toBe(true);
    // Every frame asked for and not run was cancelled when its timer ran.
    expect(f.pending()).toBe(0);
    expect(f.cancelled.length).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the cap still fires: false at maxMs on frames", async () => {
    vi.useFakeTimers();
    const dom = withDom("<!doctype html><html><body><h1>x</h1></body></html>");
    const h1 = dom.window.document.querySelector("h1") as Element;
    root(dom.window.document); // React's page, never hydrating this target
    const f = frames();
    const { waitForHydration } = await import("../src/hydration.ts");
    const start = Date.now();
    let result: boolean | undefined;
    let at = 0;
    void waitForHydration(() => [h1], 2500).then((v) => {
      result = v;
      at = Date.now() - start;
    });
    for (let i = 0; i < 200 && result === undefined; i++) {
      f.tick();
      await Promise.resolve();
    }
    expect(result).toBe(false);
    expect(at).toBeGreaterThanOrEqual(2500);
    expect(at).toBeLessThan(2500 + 16 + 1);
  });

  it("the cap still fires in a hidden tab: false at maxMs on the timer alone", async () => {
    vi.useFakeTimers();
    const dom = withDom("<!doctype html><html><body><h1>x</h1></body></html>");
    const h1 = dom.window.document.querySelector("h1") as Element;
    frames(); // never run
    const { waitForHydration } = await import("../src/hydration.ts");
    let result: boolean | undefined;
    void waitForHydration(() => [h1], 2500).then((v) => {
      result = v;
    });
    vi.advanceTimersByTime(2450);
    await Promise.resolve();
    expect(result).toBeUndefined();
    vi.advanceTimersByTime(50);
    await Promise.resolve();
    expect(result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("no busy loop once resolved: no frame, no timer, no more reads of the page", async () => {
    vi.useFakeTimers();
    const dom = withDom("<!doctype html><html><body><h1>x</h1></body></html>");
    const h1 = dom.window.document.querySelector("h1") as Element;
    const f = frames();
    const { waitForHydration } = await import("../src/hydration.ts");
    const find = vi.fn(() => [h1]);
    let reads = 0;
    Object.defineProperty(h1, "isConnected", {
      get: () => {
        reads++;
        return true;
      },
    });
    const p = waitForHydration(find, 2500);
    f.tick();
    fiber(h1);
    f.tick();
    expect(await p).toBe(true);
    const before = reads;
    for (let i = 0; i < 20; i++) f.tick();
    vi.advanceTimersByTime(5000);
    expect(f.pending()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(find).toHaveBeenCalledTimes(1);
    expect(reads).toBe(before);
  });

  it("without requestAnimationFrame the timer alone does the work", async () => {
    vi.useFakeTimers();
    const dom = withDom("<!doctype html><html><body><h1>x</h1></body></html>");
    const h1 = dom.window.document.querySelector("h1") as Element;
    vi.stubGlobal("requestAnimationFrame", undefined);
    const { waitForHydration } = await import("../src/hydration.ts");
    let result: boolean | undefined;
    void waitForHydration(() => [h1], 2500).then((v) => {
      result = v;
    });
    fiber(h1);
    vi.advanceTimersByTime(50);
    await Promise.resolve();
    expect(result).toBe(true);
  });
});
