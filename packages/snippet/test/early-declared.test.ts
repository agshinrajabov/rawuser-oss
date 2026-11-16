/**
 * The declared early write (docs/specs/faster-tag.md E3, step 5): on a React
 * page the snippet waits for hydration before it writes, because React throws
 * #418 on a text it did not render. A site owner who marks a part with
 * React's `suppressHydrationWarning` and our `data-rawuser-early` tells us
 * React will take a text difference there: such a part is written as on a
 * page that is not React, without the wait. Every part or none (the page
 * waits for hydration as before), and only a part that holds its words in one
 * text node of its own: one level, text only, as React's escape hatch covers.
 *
 * jsdom has no React: hydration is our `__reactFiber` mark set by the test,
 * a React 18 revert is the test putting the server text back.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsing } from "./helpers.ts";

const EDGE = "https://edge.test";

let sent: Array<Record<string, unknown>>;
let selectReply: () => Promise<Response>;

const HEAD = "New headline";
const BODY = "A new paragraph for the visit.";
const variant = {
  customer_id: "acme",
  profile_key: "intent:problem",
  sections: { hero: { kind: "hero", headline: HEAD, body: BODY } },
  generated_at: 0,
  prompt_hash: "h",
};
const targets = {
  "hero.headline": { css: ["h1.hero"], text: [], structural: "" },
  "hero.body": { css: ["p.lead"], text: [], structural: "" },
};
const answer = (t: Record<string, unknown> = targets) => ({
  source: "kv",
  cohort: "personalized",
  variant_key: "v1:variant:acme:problem:ai",
  selection: { intent_dim: "problem", source_dim: "ai", confidence: 0.8 },
  variant,
  targets: t,
  conversion_targets: [],
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
const answerAfter =
  (ms: number, body: unknown = answer()) =>
  () =>
    new Promise<Response>((r) => setTimeout(() => r(json(body)), ms));

/**
 * A Next.js page (its `#__next` and React's marks), the tag first in head:
 * still parsing when the snippet runs; `parsed()` ends the parse.
 */
function page(body: string) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body><div id="__next"><!--$-->${body}<!--/$--></div></body></html>`,
    { url: "https://site.test/?utm_source=chatgpt.com" },
  );
  const w = dom.window;
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
  (w as unknown as { __rw: unknown }).__rw = {
    c: "acme",
    e: EDGE,
    h: { "/": ["h1.hero", "p.lead"] },
  };
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (url.startsWith(`${EDGE}/select`)) return selectReply();
    if (url.startsWith(`${EDGE}/event`))
      sent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return w;
}

/** DOMContentLoaded: the parse is over. */
const parsed = () =>
  Object.defineProperty(document, "readyState", { value: "interactive", configurable: true });
/** React has hydrated the hero: every element in it carries its fiber. */
const hydrate = () => {
  for (const el of Array.from(document.querySelectorAll("#__next, #__next *")))
    (el as unknown as Record<string, unknown>).__reactFiber$abc = {};
};
const text = (sel: string) => document.querySelector(sel)?.textContent;
const hidden = () => document.getElementById("__rawuser-hide") !== null;
const events = (type: string) => sent.filter((e) => e.event_type === type);
const issues = () =>
  events("snippet_issue").flatMap(
    (e) => (e.properties as { issues: Array<Record<string, unknown>> }).issues,
  );

const marked = `<h1 class="hero" data-rawuser-early="true">Old headline</h1><p class="lead" data-rawuser-early="true">Old paragraph text here.</p>`;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  sent = [];
  selectReply = answerAfter(50);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("declared()", () => {
  /** A parsed page with these parts, and the module to ask (it reads the page's document). */
  const on = async (html: string) => {
    const w = new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window;
    vi.stubGlobal("document", w.document);
    vi.stubGlobal("Node", w.Node);
    vi.stubGlobal("HTMLElement", w.HTMLElement);
    return import("../src/apply.ts");
  };
  const v = (sections: Record<string, unknown>) => ({ ...variant, sections }) as never;
  const T = (paths: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(paths).map(([k, css]) => [k, { css: [css], text: [], structural: "" }]),
    );
  const E = 'data-rawuser-early="true"';
  // A pilot site's hero headline as React renders `{pre}{" "}<span>{key}<span/></span>{" "}{post}`.
  const H1 = (span = E) =>
    `<h1 class="hero" ${E}>We build<!-- --> <span class="key" ${span}>hand-made<span class="mark" aria-hidden="true"></span></span> <!-- -->products.</h1>`;
  const nodes = (sel: string) => {
    const out: string[] = [];
    const walk = (n: Node) => {
      for (const c of Array.from(n.childNodes)) {
        out.push(c.nodeName);
        walk(c);
      }
    };
    walk(document.querySelector(sel) as Node);
    return out.join(" ");
  };

  it("every part marked and holding its words in one text node; an icon beside the words", async () => {
    const { declared } = await on(marked);
    expect(declared(variant as never, targets)).toBe(true);
    const a = await on(`<a class="cta" ${E}>Start <svg><path d="M0 0"/></svg></a>`);
    expect(
      a.declared(v({ hero: { cta: { label: "Book" } } }), T({ "hero.cta.label": "a.cta" })),
    ).toBe(true);
  });

  it("refuses an unmarked part, a plain part made of two text nodes, a rich part, and nothing", async () => {
    let m = await on(`<h1 class="hero" ${E}>Old</h1><p class="lead">React reads this one.</p>`);
    expect(m.declared(variant as never, targets)).toBe(false);
    expect(m.declared(v({}), targets)).toBe(false);
    // React's separator between two strings: the plain write makes them one node.
    m = await on(`<h1 class="hero" ${E}>Hello <!-- -->world</h1><p class="lead" ${E}>x</p>`);
    expect(m.declared(variant as never, targets)).toBe(false);
    // A part the rich writers own, every word marked: never early.
    m = await on(
      `<h1 class="hero" ${E}><span ${E}>Old</span> <span ${E}>one</span></h1><p class="lead" ${E}>x</p>`,
    );
    const rich = {
      ...targets,
      "hero.headline": {
        ...targets["hero.headline"],
        inline: { icons: "none", emphasis: 0, split: true, animated_text: true, template: "{w}" },
      },
    };
    expect(m.declared(variant as never, rich as never)).toBe(false);
  });

  it("an emphasis between React's separators: every length written into the page's own nodes", async () => {
    const { declared, applyVariant } = await on(H1());
    const t = T({ "hero.headline": "h1.hero" });
    const ver = v({
      hero: {
        headline: "Products that are *AI-first* from day one",
        // Starts with the phrase: the words before it go into the emptied node.
        headline_alt: "*AI-first* products, built with you",
        headline_alt2: "Ship *AI-first* work",
      },
    });
    const before = nodes("h1.hero");
    expect(declared(ver, t)).toBe(true);
    // A length with no marker: the words go into the first node, the span emptied.
    expect(declared(v({ hero: { headline: "Plain words now" } }), t)).toBe(true);
    // The real write, with the fit trying every length, keeps every node.
    expect(applyVariant(ver, t, () => 0)).toBe(true);
    expect(nodes("h1.hero")).toBe(before);
    expect(document.querySelector("h1.hero .key")?.firstChild?.nodeValue).toBe("AI-first");
  });

  it("a child with words left unmarked waits, unless the version leaves its words as they are", async () => {
    const { declared } = await on(H1(""));
    const t = T({ "hero.headline": "h1.hero" });
    expect(declared(v({ hero: { headline: "Ship *AI-first* products" } }), t)).toBe(false);
    // The span's own words unchanged: React compares nothing it would refuse.
    expect(declared(v({ hero: { headline: "Ship *hand-made* products" } }), t)).toBe(true);
  });

  it("a link with an arrow span: the span holds no words and needs nothing, and is kept", async () => {
    const { declared, applyVariant } = await on(
      `<a class="cta" href="#x" ${E}>Start a build<!-- --> <span aria-hidden="true">→</span></a>`,
    );
    const ver = v({ hero: { cta: { label: "Book a sprint" } } });
    const t = T({ "hero.cta.label": "a.cta" });
    const before = nodes("a.cta");
    expect(declared(ver, t)).toBe(true);
    expect(applyVariant(ver, t, () => 0)).toBe(true);
    expect(nodes("a.cta")).toBe(before);
    expect(document.querySelector("a.cta span")?.textContent).toBe("→");
    expect(document.querySelector("a.cta")?.firstChild?.nodeValue).toBe("Book a sprint");
  });

  it("a headline ending in its emphasis: early when the version keeps the phrase last, not when words follow it", async () => {
    const { declared } = await on(
      `<h2 class="sec" ${E}>Seven products. <em ${E}>Two workshops. One studio.</em></h2>`,
    );
    const t = T({ "features.headline": "h2.sec" });
    expect(
      declared(v({ features: { headline: "Seven tools. *Two practices, one team.*" } }), t),
    ).toBe(true);
    // Words after the phrase need a text node the page does not have.
    expect(declared(v({ features: { headline: "*One studio,* seven services." } }), t)).toBe(false);
  });

  it("a headline with a <br>: written into its first line, and a cut that fails keeps the break", async () => {
    const { declared, applyVariant } = await on(
      `<h1 class="hero" ${E}>Build faster<br>with AI</h1>`,
    );
    const t = T({ "hero.headline": "h1.hero" });
    const ver = v({ hero: { headline: "Ship it" } });
    expect(declared(ver, t)).toBe(true);
    expect(applyVariant(ver, t, () => 0)).toBe(true);
    const h1 = document.querySelector("h1.hero") as Element;
    expect(h1.childNodes.length).toBe(3);
    // The fit's cut into the page's lines (lines.ts padTo), when it cannot cut
    // (jsdom counts no lines): what it did not write it does not put back.
    const { padTo } = await import("../src/lines.ts");
    expect(padTo(h1, "Ship it", 2, false)).toBe(false);
    expect(h1.childNodes.length).toBe(3);
    expect(h1.querySelector("br")).not.toBeNull();
  });
});

describe("the declared early write on a React page", () => {
  it("every part marked: written before hydration, at the first answer, and kept", async () => {
    page(marked);
    await import("../src/index.ts");
    parsed();
    expect(hidden()).toBe(true);
    // The answer at 50 ms, the fonts wait (at most 500): written long before
    // any hydration and before the load cap.
    await vi.advanceTimersByTimeAsync(800);
    expect(text("h1.hero")).toBe(HEAD);
    expect(text("p.lead")).toBe(BODY);
    expect(hidden()).toBe(false);
    expect(events("variant_shown")).toHaveLength(1);
    // React hydrates later: React 19 keeps our words. React 18 puts the
    // server text back at its commit; the hold writes ours again before the
    // paint (a MutationObserver callback).
    hydrate();
    (document.querySelector("h1.hero") as Element).textContent = "Old headline";
    (document.querySelector("p.lead") as Element).textContent = "Old paragraph text here.";
    await vi.advanceTimersByTimeAsync(0);
    expect(text("h1.hero")).toBe(HEAD);
    expect(text("p.lead")).toBe(BODY);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events("variant_shown")).toHaveLength(1);
    expect(events("personalization_skipped")).toHaveLength(0);
    // One revert is no `reverted` issue, and no cap fired.
    expect(issues()).toEqual([]);
  });

  it("one part without the mark: nothing is written before hydration, the marked part included", async () => {
    page(
      `<h1 class="hero" data-rawuser-early="true">Old headline</h1><p class="lead">Old paragraph text here.</p>`,
    );
    await import("../src/index.ts");
    parsed();
    await vi.advanceTimersByTimeAsync(2000);
    expect(text("h1.hero")).toBe("Old headline");
    expect(text("p.lead")).toBe("Old paragraph text here.");
    expect(hidden()).toBe(true);
    hydrate();
    await vi.advanceTimersByTimeAsync(700);
    expect(text("h1.hero")).toBe(HEAD);
    expect(text("p.lead")).toBe(BODY);
    expect(hidden()).toBe(false);
  });

  it("a marked part whose emphasis holds words and is not marked waits for hydration", async () => {
    page(
      `<h1 class="hero" data-rawuser-early="true">Old <em>headline</em></h1><p class="lead" data-rawuser-early="true">Old paragraph text here.</p>`,
    );
    await import("../src/index.ts");
    parsed();
    await vi.advanceTimersByTimeAsync(2000);
    expect(text("h1.hero")).toBe("Old headline");
    hydrate();
    await vi.advanceTimersByTimeAsync(700);
    // Written after the fiber; the emptied emphasis keeps its node.
    expect(text("h1.hero")?.trim()).toBe(HEAD);
  });

  it("lumera.test's shapes, every element with words marked: written before hydration, nodes kept, React 18's revert undone in every child", async () => {
    const E = 'data-rawuser-early="true"';
    const ver = {
      ...variant,
      sections: {
        hero: {
          headline: "Products that are *AI-first* from day one",
          body: BODY,
          cta: { label: "Book a sprint" },
        },
        features: { headline: "Seven tools. *Two practices, one team.*" },
      },
    };
    const t = {
      ...targets,
      "hero.cta.label": { css: ["a.cta"], text: [], structural: "" },
      "features.headline": { css: ["h2.sec"], text: [], structural: "" },
    };
    selectReply = answerAfter(50, { ...answer(t), variant: ver });
    const w = page(
      `<h1 class="hero" ${E}>We build<!-- --> <span class="key" ${E}>hand-made<span class="mark" aria-hidden="true"></span></span> <!-- -->products.</h1>` +
        `<p class="lead" ${E}>Old paragraph text here.</p>` +
        `<a class="cta" href="#x" ${E}>Start a build<!-- --> <span aria-hidden="true">→</span></a>` +
        `<h2 class="sec" ${E}>Seven products. <em ${E}>Two workshops. One studio.</em></h2>`,
    );
    (w as unknown as { __rw: { h: Record<string, string[]> } }).__rw.h["/"] = [
      "h1.hero",
      "p.lead",
      "a.cta",
      "h2.sec",
    ];
    const shape = () =>
      ["h1.hero", "a.cta", "h2.sec"].map((q) =>
        Array.from(document.querySelector(q)?.childNodes ?? []).map((n) => n.nodeName),
      );
    await import("../src/index.ts");
    const built = shape();
    // Server text, node by node, as React 18 writes it back at its commit.
    const server = Array.from(document.querySelectorAll("#__next *")).flatMap((el) =>
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => [n, n.nodeValue] as const),
    );
    parsed();
    await vi.advanceTimersByTimeAsync(800);
    expect(text("h1.hero")).toBe("Products that are AI-first from day one");
    expect(text("a.cta")).toBe("Book a sprint→");
    expect(document.querySelector("a.cta span")?.textContent).toBe("→");
    expect(text("h2.sec")).toBe("Seven tools. Two practices, one team.");
    expect(shape()).toEqual(built);
    expect(hidden()).toBe(false);
    hydrate();
    for (const [n, v] of server) n.nodeValue = v;
    await vi.advanceTimersByTimeAsync(0);
    expect(text("h1.hero")).toBe("Products that are AI-first from day one");
    expect(text("h2.sec")).toBe("Seven tools. Two practices, one team.");
    expect(text("a.cta")).toBe("Book a sprint→");
    expect(shape()).toEqual(built);
    expect(events("variant_shown")).toHaveLength(1);
  });

  it("a version that needs a node the page lacks waits for hydration", async () => {
    const E = 'data-rawuser-early="true"';
    selectReply = answerAfter(50, {
      ...answer({ "features.headline": { css: ["h2.sec"], text: [], structural: "" } }),
      variant: {
        ...variant,
        sections: { features: { headline: "*One studio,* seven services." } },
      },
    });
    const w = page(
      `<h2 class="sec" ${E}>Seven products. <em ${E}>Two workshops. One studio.</em></h2>`,
    );
    (w as unknown as { __rw: { h: Record<string, string[]> } }).__rw.h["/"] = ["h2.sec"];
    await import("../src/index.ts");
    parsed();
    await vi.advanceTimersByTimeAsync(2000);
    expect(text("h2.sec")).toBe("Seven products. Two workshops. One studio.");
    expect(hidden()).toBe(true);
    hydrate();
    await vi.advanceTimersByTimeAsync(700);
    expect(text("h2.sec")).toBe("One studio, seven services.");
  });

  it("a part the rich writers own (built word by word) is never written early", async () => {
    selectReply = answerAfter(
      50,
      answer({
        ...targets,
        "hero.headline": {
          css: ["h1.hero"],
          text: [],
          structural: "",
          inline: { icons: "none", emphasis: 0, split: true, animated_text: true, template: "{w}" },
        },
      }),
    );
    page(
      `<h1 class="hero" data-rawuser-early="true"><span class="w">Old</span> <span class="w">headline</span></h1><p class="lead" data-rawuser-early="true">Old paragraph text here.</p>`,
    );
    await import("../src/index.ts");
    parsed();
    await vi.advanceTimersByTimeAsync(2000);
    // Not one part early: the page waits for hydration as a whole.
    expect(text("p.lead")).toBe("Old paragraph text here.");
    expect(hidden()).toBe(true);
  });

  it("the answer before the body is parsed: written once the parse is over, when every part holds all its nodes", async () => {
    selectReply = answerAfter(50);
    const w = page("");
    await import("../src/index.ts");
    await vi.advanceTimersByTimeAsync(300);
    expect(text("h1.hero")).toBeUndefined();
    w.document.querySelector("#__next")?.insertAdjacentHTML("beforeend", marked);
    await vi.advanceTimersByTimeAsync(700);
    // Still parsing: a part's later nodes may not be in yet.
    expect(text("h1.hero")).toBe("Old headline");
    expect(hidden()).toBe(true);
    parsed();
    await vi.advanceTimersByTimeAsync(600);
    expect(text("h1.hero")).toBe(HEAD);
    expect(text("p.lead")).toBe(BODY);
    expect(hidden()).toBe(false);
  });

  it("the hydration cap still holds a page that is not declared", async () => {
    page(`<h1 class="hero">Old headline</h1><p class="lead">Old paragraph text here.</p>`);
    await import("../src/index.ts");
    parsed();
    await vi.advanceTimersByTimeAsync(3000);
    // HYDRATION_WAIT_MS (2,500) after the answer: the original, a late skip.
    expect(hidden()).toBe(false);
    expect(text("h1.hero")).toBe("Old headline");
    expect(events("personalization_skipped").map((e) => e.kind)).toEqual(["late"]);
    hydrate();
    await vi.advanceTimersByTimeAsync(2000);
    expect(text("h1.hero")).toBe("Old headline");
  });
});

describe("the hide style on a page React hydrates whole", () => {
  it("carries data-precedence, so React 19 does not take it for the page's own <style>; its text unchanged", async () => {
    page(marked);
    await import("../src/index.ts");
    parsed();
    const s = document.getElementById("__rawuser-hide") as HTMLStyleElement;
    expect(s.getAttribute("data-precedence")).toBe("rawuser");
    expect(s.textContent).toBe("[data-rawuser]{visibility:hidden!important}");
  });
});
