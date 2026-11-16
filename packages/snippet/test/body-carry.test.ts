/**
 * Body carry (docs/specs/interactive-text.md §3.1 b) against the privacy
 * review's conditions (docs/research/privacy-review-body-carry.md).
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let store: Map<string, string>;
beforeEach(() => {
  vi.resetModules();
  store = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const T = 1_000_000;
const carry = (i = "competitor", s = "social", t = T) =>
  store.set("__rw_carry", JSON.stringify({ i, s, t }));

// Everything /select can send for a personalized page (the review's fixture).
const fullResponse = {
  source: "kv",
  cohort: "personalized",
  variant_key: "v1:variant:acme:competitor:social",
  selection: { intent_dim: "competitor", source_dim: "social", confidence: 0.8 },
  intent_vector: { meta: { lead_probability: 0.7, confidence: 0.6 } },
  classifier: { ai_source: null },
  dark_social_probable: false,
  conversion_targets: [
    { section_path: "hero.cta", conversion_label: "x", css: [], text: [], structural: "" },
  ],
  visit: "a".repeat(32),
  sections: { hero: { kind: "hero", headline: "New words", cta: { label: "Go", href: "/start" } } },
  targets: { "hero.headline": { css: ["h1"], text: [], structural: "" } },
  prompt_hash: "abc",
};

describe("what is kept (conditions 1 and 4)", () => {
  it("keeps only sections, targets and prompt_hash: never a score, the visit or the key", async () => {
    carry();
    const { storeBodies } = await import("../src/body-carry.ts");
    storeBodies({ "/pricing": fullResponse }, T + 1000);
    const kept = JSON.parse(store.get("__rw_body") ?? "{}");
    expect(Object.keys(kept.p["/pricing"]).sort()).toEqual(["prompt_hash", "sections", "targets"]);
    const raw = store.get("__rw_body") ?? "";
    for (const banned of [
      "intent_vector",
      "lead_probability",
      "confidence",
      "cohort",
      "visit",
      "classifier",
      "dark_social",
      "conversion_targets",
      "variant_key",
    ]) {
      expect(raw).not.toContain(banned);
    }
  });

  it("skips a body over 16 KB, keeps at most eight paths, the oldest dropped first", async () => {
    carry();
    const { storeBodies, keptPaths } = await import("../src/body-carry.ts");
    storeBodies(
      {
        "/big": {
          sections: {
            hero: { kind: "hero", headline: "x".repeat(1999), body: "y".repeat(1999) },
            a: { kind: "a", headline: "z".repeat(1999) },
            b: { kind: "b", headline: "z".repeat(1999) },
            c: { kind: "c", headline: "z".repeat(1999) },
            d: { kind: "d", headline: "z".repeat(1999) },
            e: { kind: "e", headline: "z".repeat(1999) },
            f: { kind: "f", headline: "z".repeat(1999) },
            g: { kind: "g", headline: "z".repeat(1999) },
          },
        },
      },
      T,
    );
    expect(keptPaths(T)).toEqual([]);
    for (let n = 0; n < 10; n++)
      storeBodies({ [`/p${n}`]: { sections: { hero: { kind: "hero", headline: `h${n}` } } } }, T);
    expect(keptPaths(T)).toEqual(["/p2", "/p3", "/p4", "/p5", "/p6", "/p7", "/p8", "/p9"]);
  });

  it("refuses a body with an href that is not relative or http(s) (condition 7)", async () => {
    carry();
    const { storeBodies, keptPaths } = await import("../src/body-carry.ts");
    storeBodies(
      {
        "/x": {
          sections: { hero: { kind: "hero", cta: { label: "Go", href: "javascript:alert(1)" } } },
        },
      },
      T,
    );
    expect(keptPaths(T)).toEqual([]);
  });
});

describe("one key, one life (condition 3)", () => {
  it("reads while the carry is the same, and removes the key when the carry changed or expired", async () => {
    carry();
    const { storeBodies, readBody } = await import("../src/body-carry.ts");
    storeBodies({ "/": { sections: { hero: { kind: "hero", headline: "Hi" } } } }, T);
    expect(readBody("/", T + 1000)?.sections).toBeTruthy();
    // A fresh landing wrote a new carry: the old copy goes.
    carry("problem", "ai", T + 5000);
    expect(readBody("/", T + 6000)).toBeNull();
    expect(store.has("__rw_body")).toBe(false);
  });

  it("dies with the carry after thirty minutes", async () => {
    carry();
    const { storeBodies, readBody } = await import("../src/body-carry.ts");
    storeBodies({ "/": { sections: { hero: { kind: "hero", headline: "Hi" } } } }, T);
    expect(readBody("/", T + 31 * 60 * 1000)).toBeNull();
  });

  it("the customer's off switch removes both keys and stops both carries (condition 6)", async () => {
    carry();
    const body = await import("../src/body-carry.ts");
    const c = await import("../src/carry.ts");
    body.storeBodies({ "/": { sections: { hero: { kind: "hero", headline: "Hi" } } } }, T);
    c.carryOff();
    expect(store.has("__rw_carry")).toBe(false);
    expect(store.has("__rw_body")).toBe(false);
    c.writeCarry("problem", "ai", T);
    expect(store.has("__rw_carry")).toBe(false);
  });
});

describe("ownSignal: only a page without its own signal is written from the tab", () => {
  it("sees UTM, a click id name and a referrer from another site", async () => {
    vi.stubGlobal("document", { referrer: "" });
    const { ownSignal } = await import("../src/fetch.ts");
    expect(ownSignal({ search: "?utm_source=x", hostname: "a.com" }, "")).toBe(true);
    expect(ownSignal({ search: "?gclid=1", hostname: "a.com" }, "")).toBe(true);
    expect(ownSignal({ search: "", hostname: "a.com" }, "https://news.ycombinator.com/")).toBe(
      true,
    );
    expect(ownSignal({ search: "", hostname: "a.com" }, "https://a.com/az")).toBe(false);
    expect(ownSignal({ search: "?lang=az", hostname: "a.com" }, "")).toBe(false);
  });
});

describe("the early write and the edge's verdict", () => {
  function page(html: string) {
    const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("HTMLAnchorElement", dom.window.HTMLAnchorElement);
    vi.stubGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
    vi.stubGlobal("Node", dom.window.Node);
    vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle);
    return dom;
  }
  const kept = {
    sections: { hero: { kind: "hero", headline: "Carried words" } },
    targets: { "hero.headline": { css: ["h1"], text: [], structural: "" } },
    prompt_hash: "abc",
  } as never;

  it("writes the carried words once the element exists, and puts the page back on a revert", async () => {
    const dom = page("<h1>Page words</h1>");
    const { earlyApply } = await import("../src/early.ts");
    const early = earlyApply(kept);
    expect(early.applied).toBe(true);
    expect(dom.window.document.querySelector("h1")?.textContent).toBe("Carried words");
    early.revert();
    expect(dom.window.document.querySelector("h1")?.textContent).toBe("Page words");
  });

  it("waits for an element the parser has not reached, then writes it", async () => {
    const dom = page("");
    const { earlyApply } = await import("../src/early.ts");
    const early = earlyApply(kept);
    expect(early.applied).toBe(false);
    const h1 = dom.window.document.createElement("h1");
    h1.textContent = "Page words";
    dom.window.document.body.appendChild(h1);
    await new Promise((r) => setTimeout(r, 0));
    expect(early.applied).toBe(true);
    expect(h1.textContent).toBe("Carried words");
    early.stop();
  });

  it("keeps the write when the edge serves the same copy, reapplies another, reverts when it serves none", async () => {
    page("<h1>Page words</h1>");
    const { earlyApply, earlyVerdict } = await import("../src/early.ts");
    const early = earlyApply(kept);
    // prompt_hash is empty in the KV bodies (the zoo check): the copy decides,
    // with the parts it is written into.
    const targets = { "hero.headline": { css: ["h1"], text: [], structural: "" } };
    const same = {
      cohort: "personalized",
      source: "kv",
      variant: { prompt_hash: "", sections: { hero: { kind: "hero", headline: "Carried words" } } },
      targets,
    } as never;
    const other = {
      cohort: "personalized",
      source: "kv",
      variant: { prompt_hash: "", sections: { hero: { kind: "hero", headline: "Other words" } } },
      targets,
    } as never;
    // The same words for other parts (the pilot's site, 2026-10-12: the manifest the
    // tab's copy came with had lost the button, the edge's answer named it).
    const otherParts = {
      cohort: "personalized",
      source: "kv",
      variant: { prompt_hash: "", sections: { hero: { kind: "hero", headline: "Carried words" } } },
      targets: { ...targets, "hero.cta.label": { css: ["a.btn"], text: [], structural: "" } },
    } as never;
    const none = { cohort: "holdout", source: "holdout", variant: null } as never;
    expect(earlyVerdict(early, same)).toBe("keep");
    expect(earlyVerdict(early, other)).toBe("reapply");
    expect(earlyVerdict(early, otherParts)).toBe("reapply");
    expect(earlyVerdict(early, none)).toBe("revert");
    expect(earlyVerdict(null, same)).toBe("none");
  });

  it("does not throw while the head is parsing, and writes once the body arrives", async () => {
    const dom = new JSDOM("<!doctype html><html><head></head></html>");
    const doc = dom.window.document;
    doc.body?.remove();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("Node", dom.window.Node);
    vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle);
    const { earlyApply } = await import("../src/early.ts");
    const textOnly = {
      sections: { hero: { kind: "hero", headline: "Carried words" } },
      targets: { "hero.headline": { css: [], text: ["Page words"], structural: "" } },
      prompt_hash: "",
    } as never;
    expect(doc.body).toBeNull();
    let early: ReturnType<typeof earlyApply> | null = null;
    expect(() => {
      early = earlyApply(textOnly);
    }).not.toThrow();
    const body = doc.createElement("body");
    body.innerHTML = "<h1>Page words</h1>";
    doc.documentElement.appendChild(body);
    await new Promise((r) => setTimeout(r, 0));
    expect((early as unknown as { applied: boolean }).applied).toBe(true);
    expect(doc.querySelector("h1")?.textContent).toBe("Carried words");
  });
});

describe("the svg's label follows the new words", () => {
  it("rewrites an aria-label on the enclosing svg that read the old words", async () => {
    const dom = new JSDOM(
      '<!doctype html><body><svg aria-label="Page words"><text id="t">Page words</text></svg></body>',
    );
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("Node", dom.window.Node);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle);
    const { writeText } = await import("../src/apply.ts");
    const t = dom.window.document.getElementById("t") as Element;
    expect(writeText(t, "New words")).toBe(true);
    expect(dom.window.document.querySelector("svg")?.getAttribute("aria-label")).toBe("New words");
  });

  it("a revert of the early write puts the svg's label back too", async () => {
    const dom = new JSDOM(
      '<!doctype html><body><svg aria-label="Page words"><text>Page words</text></svg></body>',
    );
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
    vi.stubGlobal("Node", dom.window.Node);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle);
    const { earlyApply } = await import("../src/early.ts");
    const early = earlyApply({
      sections: { hero: { kind: "hero", headline: "Carried words" } },
      targets: { "hero.headline": { css: ["svg text"], text: [], structural: "" } },
      prompt_hash: "",
    } as never);
    const svg = dom.window.document.querySelector("svg");
    expect(early.applied).toBe(true);
    expect(svg?.getAttribute("aria-label")).toBe("Carried words");
    early.revert();
    expect(svg?.textContent).toBe("Page words");
    expect(svg?.getAttribute("aria-label")).toBe("Page words");
  });
});
