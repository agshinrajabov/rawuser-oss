/**
 * Write the words, keep the design (docs/specs/design-preserving-rewrite.md §1):
 * icons stay, a single text node is rewritten in place, emphasis elements
 * keep their decoration, split text is left alone, never innerHTML.
 */
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

function withDom(html: string) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("Text", dom.window.Text);
  vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  return dom.window.document;
}
/** The quiet swap's hide style on `sel` (the part not revealed yet); returns the reveal. */
function hide(d: Document, sel: string): () => void {
  const style = d.createElement("style");
  style.textContent = `${sel}{visibility:hidden!important}`;
  d.head.appendChild(style);
  return () => style.remove();
}
afterEach(() => vi.unstubAllGlobals());

describe("elementShape", () => {
  it("names plain, icons, emphasis and split", async () => {
    const d = withDom(
      '<h1 id="a">Plain</h1><a id="b"><svg></svg> Label</a><h1 id="c">We build <em>AI</em> things</h1><h1 id="d"><span>W</span><span>o</span><span>r</span><span>d</span><span>s</span></h1>',
    );
    const { elementShape } = await import("../src/apply.ts");
    expect(elementShape(d.getElementById("a") as Element)).toBe("plain");
    expect(elementShape(d.getElementById("b") as Element)).toBe("icons");
    expect(elementShape(d.getElementById("c") as Element)).toBe("emphasis");
    expect(elementShape(d.getElementById("d") as Element)).toBe("split");
  });
});

describe("writeText", () => {
  it("rewrites a plain element", async () => {
    const d = withDom("<h1>Old</h1>");
    const { writeText } = await import("../src/apply.ts");
    const h1 = d.querySelector("h1") as Element;
    expect(writeText(h1, "New")).toBe(true);
    expect(h1.textContent).toBe("New");
  });

  it("keeps a leading icon and the space after it", async () => {
    const d = withDom('<a class="btn"><svg class="ic"></svg> See our work</a>');
    const { writeText } = await import("../src/apply.ts");
    const a = d.querySelector("a") as Element;
    writeText(a, "See how it works");
    expect(a.querySelector("svg.ic")).not.toBeNull();
    expect(a.textContent).toBe(" See how it works");
    expect(a.childNodes.length).toBe(2);
  });

  it("keeps a trailing arrow span with only a symbol", async () => {
    const d = withDom("<a>İşlərimizə baxın <span>→</span></a>");
    const { writeText } = await import("../src/apply.ts");
    const a = d.querySelector("a") as Element;
    writeText(a, "Necə işlədiyimizə bax");
    expect(a.querySelector("span")?.textContent).toBe("→");
    expect(a.textContent).toBe("Necə işlədiyimizə bax →");
  });

  it("emphasis element keeps its decoration and is hidden when left without words", async () => {
    const d = withDom('<h1>We build <em>hand-made<span class="mark"></span></em> products.</h1>');
    const { writeText } = await import("../src/apply.ts");
    const h1 = d.querySelector("h1") as Element;
    writeText(h1, "AI and UX under one roof");
    const em = h1.querySelector("em") as HTMLElement;
    expect(em).not.toBeNull();
    expect(em.querySelector("span.mark")).not.toBeNull();
    expect(em.textContent).toBe("");
    expect(em.style.visibility).toBe("hidden");
    expect(h1.textContent?.replace(/\s+/g, " ").trim()).toBe("AI and UX under one roof");
  });

  it("leaves split text alone and says so", async () => {
    const d = withDom(
      "<h1><span>H</span><span>e</span><span>l</span><span>l</span><span>o</span></h1>",
    );
    const { writeText } = await import("../src/apply.ts");
    const h1 = d.querySelector("h1") as Element;
    expect(writeText(h1, "New")).toBe(false);
    expect(h1.textContent).toBe("Hello");
  });

  it("puts words after the leading decoration when only children had words", async () => {
    const d = withDom("<a><svg></svg><span>Label</span></a>");
    const { writeText } = await import("../src/apply.ts");
    const a = d.querySelector("a") as Element;
    writeText(a, "New label");
    expect(a.querySelector("svg")).not.toBeNull();
    expect(a.textContent).toBe("New label");
    expect(a.childNodes[1]?.nodeType).toBe(3);
  });
});

describe("writeText keeps what the page typed into the text itself", () => {
  it("keeps a trailing arrow character and the capitals (lumera.test /approach)", async () => {
    const d = withDom('<a class="btn" href="/contact">START A FEASIBILITY SPRINT →</a>');
    const { writeText } = await import("../src/apply.ts");
    const a = d.querySelector("a") as Element;
    writeText(a, "See how the sprint works");
    expect(a.textContent).toBe("SEE HOW THE SPRINT WORKS →");
    expect(a.childNodes.length).toBe(1);
  });

  it("keeps a leading glyph, and does not double one the version already carries", async () => {
    const d = withDom("<a>» Read more</a><a>Read more →</a>");
    const { writeText } = await import("../src/apply.ts");
    const [a, b] = Array.from(d.querySelectorAll("a")) as Element[];
    writeText(a as Element, "See the cases");
    writeText(b as Element, "See the cases →");
    expect(a?.textContent).toBe("» See the cases");
    expect(b?.textContent).toBe("See the cases →");
  });

  it("does not read a child's arrow span as an edge glyph, and leaves normal casing alone", async () => {
    const d = withDom("<a>İşlərimizə baxın <span>→</span></a>");
    const { writeText } = await import("../src/apply.ts");
    const a = d.querySelector("a") as Element;
    writeText(a, "Necə işlədiyimizə bax");
    expect(a.textContent).toBe("Necə işlədiyimizə bax →");
    expect(a.querySelectorAll("span").length).toBe(1);
  });

  it("uppercases with the page language, so Azerbaijani i becomes İ, and ignores short acronyms", async () => {
    const d = withDom("<a>İŞLƏRİMİZƏ BAXIN</a><h1>AI</h1>");
    d.documentElement.lang = "az";
    const { writeText } = await import("../src/apply.ts");
    const a = d.querySelector("a") as Element;
    const h = d.querySelector("h1") as Element;
    writeText(a, "işlərimizə bax");
    writeText(h, "we build");
    expect(a.textContent).toBe("İŞLƏRİMİZƏ BAX");
    expect(h.textContent).toBe("we build");
  });

  it("is idempotent, so a second write of the same value changes nothing", async () => {
    const d = withDom("<a>START A SPRINT →</a>");
    const { writeText } = await import("../src/apply.ts");
    const a = d.querySelector("a") as Element;
    writeText(a, "See the sprint");
    const once = a.textContent;
    writeText(a, "See the sprint");
    expect(a.textContent).toBe(once);
    expect(once).toBe("SEE THE SPRINT →");
  });
});

describe("applyVariant with shapes", () => {
  it("a split-text claimed element aborts the whole variant", async () => {
    withDom(
      "<h1><span>H</span><span>e</span><span>l</span><span>l</span><span>o</span></h1><p>lead</p>",
    );
    const { applyVariant } = await import("../src/apply.ts");
    const ok = applyVariant({
      sections: { hero: { kind: "hero", headline: "New", body: "New lead" } },
    } as never);
    expect(ok).toBe(false);
    expect(document.querySelector("p")?.textContent).toBe("lead");
  });
});

describe("bundle never uses innerHTML", () => {
  it("apply.ts source has no innerHTML write", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/apply.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.innerHTML\s*=/);
  });
});

describe("writeText with a marked phrase (design-preserving-rewrite §2)", () => {
  it("maps before, phrase and after onto the emphasis element, keeping its decoration", async () => {
    const d = withDom('<h1>We build <em>hand-made<span class="mark"></span></em> products.</h1>');
    const { writeText } = await import("../src/apply.ts");
    const h1 = d.querySelector("h1") as Element;
    expect(writeText(h1, "Compare us *before you commit*.")).toBe(true);
    const em = h1.querySelector("em") as HTMLElement;
    expect(em.textContent).toBe("before you commit");
    expect(em.querySelector("span.mark")).not.toBeNull();
    expect(em.style.visibility).toBe("");
    expect(h1.textContent).toBe("Compare us before you commit.");
    expect(h1.children.length).toBe(1);
  });

  it("writes the phrase into an element that had words only in children, then a tail it did not have", async () => {
    const d = withDom("<h1><em>Old</em></h1>");
    const { writeText } = await import("../src/apply.ts");
    const h1 = d.querySelector("h1") as Element;
    writeText(h1, "*New words* and more");
    expect(h1.querySelector("em")?.textContent).toBe("New words");
    expect(h1.textContent).toBe("New words and more");
  });

  it("strips markers on a plain element and on an icon-only element", async () => {
    const d = withDom('<h1 id="a">Old</h1><a id="b"><svg></svg> Go</a>');
    const { writeText } = await import("../src/apply.ts");
    writeText(d.getElementById("a") as Element, "Compare us *before you commit*.");
    expect(d.getElementById("a")?.textContent).toBe("Compare us before you commit.");
    writeText(d.getElementById("b") as Element, "*See* the plans");
    expect(d.getElementById("b")?.textContent).toBe(" See the plans");
    expect(d.querySelector("#b svg")).not.toBeNull();
  });

  it("two marked phrases count as none: plain write, emphasis emptied", async () => {
    const d = withDom("<h1>We build <em>AI</em> things</h1>");
    const { writeText } = await import("../src/apply.ts");
    const h1 = d.querySelector("h1") as Element;
    writeText(h1, "*One* and *two*");
    expect(h1.textContent?.trim()).toBe("One and two");
    expect(h1.querySelector("em")?.textContent).toBe("");
  });

  it("the operator's plain choice replaces split text; skip is never claimed", async () => {
    withDom(
      "<h1><span>H</span><span>e</span><span>l</span><span>l</span><span>o</span></h1><p>lead</p>",
    );
    const { applyVariant, writeText } = await import("../src/apply.ts");
    const h1 = document.querySelector("h1") as Element;
    expect(writeText(h1, "New", { css: [], text: [], structural: "", plain: true })).toBe(true);
    expect(h1.textContent).toBe("New");
    const ok = applyVariant(
      { sections: { hero: { kind: "hero", headline: "Newer", body: "New lead" } } } as never,
      {
        "hero.headline": { css: ["h1"], text: [], structural: "", skip: true },
        "hero.body": { css: ["p"], text: [], structural: "" },
      },
    );
    expect(ok).toBe(true);
    expect(h1.textContent).toBe("New");
    expect(document.querySelector("p")?.textContent).toBe("New lead");
  });
});

describe("writeText after an earlier hide", () => {
  it("shows the emphasis element again when a marked phrase arrives", async () => {
    const d = withDom("<h1>We build <em>AI</em> things</h1>");
    const { writeText } = await import("../src/apply.ts");
    const h1 = d.querySelector("h1") as Element;
    writeText(h1, "Plain first");
    const em = h1.querySelector("em") as HTMLElement;
    expect(em.style.visibility).toBe("hidden");
    writeText(h1, "Then *marked words* here");
    expect(em.style.visibility).toBe("");
    expect(em.textContent).toBe("marked words");
    expect(h1.textContent).toBe("Then marked words here");
  });
});

describe("three lengths, the page picks (2026-09-16)", () => {
  const measure = (el: Element) => ((el.textContent ?? "").trim().length >= 30 ? 150 : 75);

  it("falls back to the third length when the first and the second both change the line count", async () => {
    withDom("<h1>Get your week back</h1>");
    const { applyVariant, lastApplied } = await import("../src/apply.ts");
    const ok = applyVariant(
      {
        sections: {
          hero: {
            kind: "hero",
            headline: "Your whole week, planned around your energy",
            headline_alt: "Your whole week, planned around your energy and your deadlines",
            headline_alt2: "Your week, planned",
          },
        },
      } as never,
      { "hero.headline": { css: ["h1"], text: [], structural: "" } },
      measure,
    );
    expect(ok).toBe(true);
    expect(document.querySelector("h1")?.textContent).toBe("Your week, planned");
    expect(lastApplied()[0]?.value).toBe("Your week, planned");
  });

  it("on a tie keeps the candidate under the original's height, not the first (2026-09-16 evening)", async () => {
    // Original 3 lines (90 px); the first length takes 4, the third takes 2:
    // one line off each way. The shorter one wins the tie.
    withDom("<h1>Get your week back today</h1>");
    const { applyVariant, lastApplied } = await import("../src/apply.ts");
    const heights: Record<string, number> = {
      "Get your week back today": 90,
      "Your whole week, planned around your energy": 120,
      "Your whole week, planned around your energy and deadlines": 150,
      "Your week, planned": 60,
    };
    const measure = (el: Element) => heights[(el.textContent ?? "").trim()] ?? 999;
    applyVariant(
      {
        sections: {
          hero: {
            kind: "hero",
            headline: "Your whole week, planned around your energy",
            headline_alt: "Your whole week, planned around your energy and deadlines",
            headline_alt2: "Your week, planned",
          },
        },
      } as never,
      { "hero.headline": { css: ["h1"], text: [], structural: "" } },
      measure,
    );
    expect(document.querySelector("h1")?.textContent).toBe("Your week, planned");
    expect(lastApplied()[0]?.value).toBe("Your week, planned");
    // A tie between two candidates both over the original keeps the first.
    withDom("<h1>Get your week back today</h1>");
    const over = (el: Element) =>
      ({ "Get your week back today": 90, A: 120, B: 120, C: 120 })[(el.textContent ?? "").trim()] ??
      999;
    applyVariant(
      {
        sections: { hero: { kind: "hero", headline: "A", headline_alt: "B", headline_alt2: "C" } },
      } as never,
      { "hero.headline": { css: ["h1"], text: [], structural: "" } },
      over,
    );
    expect(document.querySelector("h1")?.textContent).toBe("A");
  });

  it("never claims _alt2 as a target of its own", async () => {
    withDom("<h1>Get your week back</h1>");
    const { applyVariant, lastApplied } = await import("../src/apply.ts");
    applyVariant(
      {
        sections: { hero: { kind: "hero", headline: "Your week, planned", headline_alt2: "x" } },
      } as never,
      { "hero.headline": { css: ["h1"], text: [], structural: "" } },
      measure,
    );
    expect(lastApplied().map((a) => a.path)).toEqual(["hero.headline"]);
  });
});

describe("two lengths, the page picks", () => {
  // jsdom has no layout: the measure stub stands in for the page's font and
  // width. Thirty or more characters wrap to two lines (150 px), fewer to one (75 px).
  const measure = (el: Element) => ((el.textContent ?? "").trim().length >= 30 ? 150 : 75);

  it("keeps the first length when it holds the line count", async () => {
    withDom("<h1>Get your week back, every week</h1>");
    const { applyVariant, lastApplied } = await import("../src/apply.ts");
    const ok = applyVariant(
      {
        sections: {
          hero: {
            kind: "hero",
            headline: "Your week, planned around your energy",
            headline_alt: "Your whole week, planned around your energy and deadlines",
          },
        },
      } as never,
      { "hero.headline": { css: ["h1"], text: [], structural: "" } },
      measure,
    );
    expect(ok).toBe(true);
    expect(document.querySelector("h1")?.textContent).toBe("Your week, planned around your energy");
    expect(lastApplied()[0]?.value).toBe("Your week, planned around your energy");
  });

  it("switches to the second length when the first changes the line count", async () => {
    withDom("<h1>Get your week back, every week</h1>");
    const { applyVariant, lastApplied } = await import("../src/apply.ts");
    applyVariant(
      {
        sections: {
          hero: {
            kind: "hero",
            headline: "Free to start, $12 for Pro",
            headline_alt: "Free to start, and Pro is $12 a month",
          },
        },
      } as never,
      { "hero.headline": { css: ["h1"], text: [], structural: "" } },
      measure,
    );
    expect(document.querySelector("h1")?.textContent).toBe("Free to start, and Pro is $12 a month");
    expect(lastApplied()[0]?.value).toBe("Free to start, and Pro is $12 a month");
  });

  it("keeps the first when neither holds the line count but the first is closer, and never claims _alt", async () => {
    withDom("<h1>Get your week back, every week</h1>");
    const { applyVariant } = await import("../src/apply.ts");
    const tall = (el: Element) =>
      (el.textContent ?? "").length >= 60 ? 225 : (el.textContent ?? "").length >= 30 ? 150 : 75;
    const ok = applyVariant(
      {
        sections: {
          hero: {
            kind: "hero",
            headline: "Short one",
            headline_alt:
              "A very long second headline that runs past the width of the box and wraps to three lines",
          },
        },
      } as never,
      { "hero.headline": { css: ["h1"], text: [], structural: "" } },
      tall,
    );
    expect(ok).toBe(true);
    expect(document.querySelector("h1")?.textContent).toBe("Short one");
  });
});

describe("the page's line count by construction (docs/decisions/0031, 2026-09-30)", () => {
  const entry = { css: ["h1"], text: [], structural: "" };
  const variant = (hero: Record<string, string>) =>
    ({ sections: { hero: { kind: "hero", ...hero } } }) as never;

  it("takes a length under the original over a closer one above it, and holds the box at the original's height", async () => {
    const d = withDom("<h1>Get your week back today</h1>");
    const { applyVariant, lastApplied } = await import("../src/apply.ts");
    const heights: Record<string, number> = {
      "Get your week back today": 90,
      Over: 120,
      Under: 30,
    };
    applyVariant(
      variant({ headline: "Over", headline_alt: "Under" }),
      { "hero.headline": entry },
      (el) => heights[(el.textContent ?? "").trim()] ?? 999,
    );
    const h1 = d.querySelector("h1") as HTMLElement;
    expect(h1.textContent).toBe("Under");
    expect(lastApplied()[0]?.value).toBe("Under");
    expect(h1.style.minHeight).toBe("90px");
  });

  it("keeps the first length at the original's height, in order, and reserves nothing", async () => {
    const d = withDom("<h1>Get your week back today</h1>");
    const { applyVariant } = await import("../src/apply.ts");
    const heights: Record<string, number> = { "Get your week back today": 90, A: 60, B: 91, C: 90 };
    applyVariant(
      variant({ headline: "A", headline_alt: "B", headline_alt2: "C" }),
      { "hero.headline": entry },
      (el) => heights[(el.textContent ?? "").trim()] ?? 999,
    );
    const h1 = d.querySelector("h1") as HTMLElement;
    expect(h1.textContent).toBe("B");
    expect(h1.style.minHeight).toBe("");
  });

  it("takes the shortest over only when every length is over", async () => {
    const d = withDom("<h1>Get your week back today</h1>");
    const { applyVariant } = await import("../src/apply.ts");
    const heights: Record<string, number> = {
      "Get your week back today": 90,
      A: 180,
      B: 120,
      C: 150,
    };
    applyVariant(
      variant({ headline: "A", headline_alt: "B", headline_alt2: "C" }),
      { "hero.headline": entry },
      (el) => heights[(el.textContent ?? "").trim()] ?? 999,
    );
    const h1 = d.querySelector("h1") as HTMLElement;
    expect(h1.textContent).toBe("B");
    expect(h1.style.minHeight).toBe("");
  });

  // jsdom has no layout: a Range stub gives one line per <br>-separated
  // segment, and 20 characters to a line where there is no <br>.
  function stubLayout(d: Document) {
    const linesOf = (el: Element) => {
      const brs = el.querySelectorAll("br").length;
      const text = el.textContent ?? "";
      if (text.includes("\n")) return text.split("\n").length;
      return brs > 0 ? brs + 1 : Math.ceil(text.trim().length / 20);
    };
    let node: Element | null = null;
    (d as unknown as { createRange: () => unknown }).createRange = () => ({
      selectNodeContents: (n: Element) => {
        node = n;
      },
      getClientRects: () =>
        Array.from({ length: node ? linesOf(node) : 0 }, (_, i) => ({
          width: 10,
          height: 20,
          top: i * 20,
        })),
    });
    return (el: Element) => linesOf(el) * 20;
  }

  it("cuts a shorter version into the page's own lines before the page splits it", async () => {
    const d = withDom("<h1>Every visitor reads the page written for why they came.</h1>");
    const measure = stubLayout(d);
    const { applyVariant, lastApplied } = await import("../src/apply.ts");
    applyVariant(
      variant({
        headline: "Pay per page version, not per seat.",
        headline_alt: "Pay for each version of the page you run, never for the seats on your team.",
      }),
      {
        "hero.headline": {
          ...entry,
          inline: { icons: "none", emphasis: 0, split: true, animated_text: false, lines: 3 },
        },
      } as never,
      measure,
    );
    const h1 = d.querySelector("h1") as HTMLElement;
    expect(h1.querySelectorAll("br")).toHaveLength(2);
    expect(measure(h1)).toBe(60);
    // Words stay apart in the text a split library copies into aria-label.
    expect(h1.textContent?.replace(/\s+/g, " ").trim()).toBe("Pay per page version, not per seat.");
    expect(h1.style.minHeight).toBe("");
    expect(lastApplied()[0]?.value).toBe("Pay per page version, not per seat.");
  });

  it("cuts a shorter plain headline into the page's lines inside one text node, no markup added", async () => {
    const d = withDom("<h1>Every visitor reads the page written for why they came.</h1>");
    const measure = stubLayout(d);
    const h1 = d.querySelector("h1") as HTMLElement;
    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(
      variant({
        headline: "Pay per page version, not per seat.",
        headline_alt: "Pay for each version of the page you run, never for the seats on your team.",
      }),
      { "hero.headline": entry } as never,
      measure,
    );
    expect(h1.childNodes.length).toBe(1);
    expect(h1.style.whiteSpace).toBe("pre-line");
    expect(h1.textContent?.split("\n")).toHaveLength(3);
    expect(h1.style.minHeight).toBe("");
  });

  it("keeps the page's own label when ours would make its row taller, and ours when it does not", async () => {
    const d = withDom('<div class="row"><a class="btn">Start</a><a class="btn2">More</a></div>');
    const { applyVariant } = await import("../src/apply.ts");
    const rowHeight = (el: Element) =>
      el.classList.contains("row") ? ((el.textContent ?? "").length > 20 ? 96 : 48) : 20;
    applyVariant(
      variant({ "cta.label": "A much longer label here" } as never),
      { "hero.cta.label": { css: ["a.btn"], text: [], structural: "" } } as never,
      rowHeight,
    );
    expect(d.querySelector("a.btn")?.textContent).toBe("Start");
    const d2 = withDom('<div class="row"><a class="btn">Start</a><a class="btn2">More</a></div>');
    applyVariant(
      variant({ "cta.label": "Go now" } as never),
      { "hero.cta.label": { css: ["a.btn"], text: [], structural: "" } } as never,
      rowHeight,
    );
    expect(d2.querySelector("a.btn")?.textContent).toBe("Go now");
  });

  it("puts a label with an icon back exactly, never doubling its arrow (lumera.test /az, 2026-09-30)", async () => {
    const html =
      '<form class="row"><a class="btn">Başla → <span aria-hidden="true">→</span></a></form>';
    const d = withDom(html);
    const { applyVariant } = await import("../src/apply.ts");
    const rowHeight = (el: Element) =>
      el.classList.contains("row") ? ((el.textContent ?? "").length > 12 ? 103 : 48) : 20;
    applyVariant(
      variant({ "cta.label": "İndi başlayaq →" } as never),
      { "hero.cta.label": { css: ["a.btn"], text: [], structural: "" } } as never,
      rowHeight,
    );
    expect(d.querySelector("form")?.innerHTML).toBe(
      '<a class="btn">Başla → <span aria-hidden="true">→</span></a>',
    );
  });

  it("gives a label back when the page's fonts arrive before the reveal and make its row taller, and the hold leaves it", async () => {
    const d = withDom('<div class="row"><a class="btn">Başla</a></div>');
    hide(d, "a.btn");
    let loaded!: () => void;
    // As in a browser, status turns "loaded" when ready resolves; a stub left
    // on "loading" kept the fit re-arming past the test's end.
    const fontSet = { status: "loading", ready: Promise.resolve() };
    fontSet.ready = new Promise<void>((r) => {
      loaded = () => {
        fontSet.status = "loaded";
        r();
      };
    });
    const ready = fontSet.ready;
    Object.defineProperty(d, "fonts", { value: fontSet, configurable: true });
    let late = false;
    const rowHeight = (el: Element) =>
      el.classList.contains("row") ? (late && (el.textContent ?? "").length > 6 ? 103 : 48) : 20;
    const { applyVariant, holdVariant } = await import("../src/apply.ts");
    const targets = { "hero.cta.label": { css: ["a.btn"], text: [], structural: "" } } as never;
    applyVariant(variant({ "cta.label": "Başlayaq" } as never), targets, rowHeight);
    const a = d.querySelector("a.btn") as HTMLElement;
    expect(a.textContent).toBe("Başlayaq");
    late = true;
    loaded();
    await ready;
    await Promise.resolve();
    expect(a.textContent).toBe("Başla");
    holdVariant(targets, [], () => 0, 0);
    expect(a.textContent).toBe("Başla");
  });

  it("cuts four short words into four lines when the page has four", async () => {
    const d = withDom(`<h1>${"x".repeat(70)}</h1>`);
    const measure = stubLayout(d);
    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(
      variant({ headline: "We build hand-made products." }),
      { "hero.headline": entry } as never,
      measure,
    );
    const h1 = d.querySelector("h1") as HTMLElement;
    expect(h1.textContent?.split("\n")).toHaveLength(4);
    expect(h1.style.minHeight).toBe("");
  });

  it("prefers a length that carries the page's emphasis when two hold the same height", async () => {
    const d = withDom("<h1>We settle the argument before <em>building</em>.</h1>");
    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(
      variant({
        headline: "We answer it before we build.",
        headline_alt: "We answer it before *we build*.",
      }),
      {
        "hero.headline": {
          ...entry,
          inline: { icons: "none", emphasis: 1, split: false, animated_text: false },
        },
      } as never,
      () => 50,
    );
    expect(d.querySelector("em")?.textContent).toBe("we build");
  });

  it("fits again once the page's fonts arrive before the reveal (a fit in the fallback font chose wrong)", async () => {
    const d = withDom("<p>The headline, the text and the button change</p>");
    hide(d, "p");
    let loaded!: () => void;
    // As in a browser, status turns "loaded" when ready resolves; a stub left
    // on "loading" kept the fit re-arming past the test's end.
    const fontSet = { status: "loading", ready: Promise.resolve() };
    fontSet.ready = new Promise<void>((r) => {
      loaded = () => {
        fontSet.status = "loaded";
        r();
      };
    });
    const ready = fontSet.ready;
    Object.defineProperty(d, "fonts", { value: fontSet, configurable: true });
    const O = "The headline, the text and the button change";
    const fallback: Record<string, number> = { [O]: 40, Short: 20, "Long text": 40 };
    const real: Record<string, number> = { [O]: 60, Short: 40, "Long text": 80 };
    let at = fallback;
    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(
      variant({ body: "Short", body_alt: "Long text" }),
      { "hero.body": { css: ["p"], text: [], structural: "" } },
      (el) => at[(el.textContent ?? "").trim()] ?? 999,
    );
    const p = d.querySelector("p") as HTMLElement;
    expect(p.textContent).toBe("Long text");
    // Held at the original's height while the fonts load.
    expect(p.style.minHeight).toBe("40px");
    at = real;
    loaded();
    await ready;
    await Promise.resolve();
    expect(p.textContent).toBe("Short");
    expect(p.style.minHeight).toBe("60px");
  });

  it("never fits again once the page changes the words itself (a typewriter or scramble)", async () => {
    const d = withDom("<p>The headline, the text and the button change</p>");
    let loaded!: () => void;
    // As in a browser, status turns "loaded" when ready resolves; a stub left
    // on "loading" kept the fit re-arming past the test's end.
    const fontSet = { status: "loading", ready: Promise.resolve() };
    fontSet.ready = new Promise<void>((r) => {
      loaded = () => {
        fontSet.status = "loaded";
        r();
      };
    });
    const ready = fontSet.ready;
    Object.defineProperty(d, "fonts", { value: fontSet, configurable: true });
    const O = "The headline, the text and the button change";
    const h: Record<string, number> = { [O]: 40, Short: 20, "Long text": 40 };
    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(
      variant({ body: "Short", body_alt: "Long text" }),
      { "hero.body": { css: ["p"], text: [], structural: "" } },
      (el) => h[(el.textContent ?? "").trim()] ?? 30,
    );
    const p = d.querySelector("p") as HTMLElement;
    p.textContent = "The head"; // the page types its own words
    loaded();
    await ready;
    await Promise.resolve();
    expect(p.textContent).toBe("The head");
  });

  it("holds the box instead when the words cannot make the page's lines", async () => {
    const d = withDom("<h1>Every visitor reads the page written for why they came.</h1>");
    const measure = stubLayout(d);
    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(
      variant({ headline: "Hello there", headline_alt: "x".repeat(90) }),
      {
        "hero.headline": {
          ...entry,
          inline: { icons: "none", emphasis: 0, split: true, animated_text: false, lines: 3 },
        },
      } as never,
      measure,
    );
    const h1 = d.querySelector("h1") as HTMLElement;
    expect(h1.querySelectorAll("br")).toHaveLength(0);
    expect(h1.textContent).toBe("Hello there");
    expect(h1.style.minHeight).toBe("60px");
  });

  it("fits again at a new width before the reveal: the original measured there, the lengths tried again", async () => {
    vi.useFakeTimers();
    const d = withDom("<p>The headline, the text and the button change</p>");
    hide(d, "p");
    const w = d.defaultView as unknown as { innerWidth: number; dispatchEvent: (e: Event) => void };
    const O = "The headline, the text and the button change";
    const wide: Record<string, number> = { [O]: 40, Short: 20, "Long text": 40 };
    // At 390 the original takes 3 lines, the longer length 4, the shorter 2.
    const narrow: Record<string, number> = { [O]: 60, Short: 40, "Long text": 80 };
    let at = wide;
    const measure = (el: Element) => at[(el.textContent ?? "").trim()] ?? 999;
    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(
      variant({ body: "Short", body_alt: "Long text" }),
      { "hero.body": { css: ["p"], text: [], structural: "" } },
      measure,
    );
    const p = d.querySelector("p") as HTMLElement;
    expect(p.textContent).toBe("Long text");
    at = narrow;
    w.innerWidth = 390;
    w.dispatchEvent(new (d.defaultView as unknown as { Event: typeof Event }).Event("resize"));
    vi.advanceTimersByTime(250);
    expect(p.textContent).toBe("Short");
    expect(p.style.minHeight).toBe("60px");
    vi.useRealTimers();
  });

  /** A font set still loading, and the call that lands its fonts (status turns "loaded" as ready resolves). */
  function loadingFonts(d: Document) {
    let loaded!: () => void;
    const fontSet = { status: "loading", ready: Promise.resolve() };
    fontSet.ready = new Promise<void>((r) => {
      loaded = () => {
        fontSet.status = "loaded";
        r();
      };
    });
    Object.defineProperty(d, "fonts", { value: fontSet, configurable: true });
    const ready = fontSet.ready;
    return async () => {
      loaded();
      await ready;
      await Promise.resolve();
    };
  }

  // A pilot site's /az at 390, 2026-10-26: fitted in the fallback font the short
  // length won; the fonts came at 4.7 s, after the reveal, and the fit again
  // put the base length's words in its place before the visitor's eyes.
  const O = "The headline, the text and the button change";
  const body = { "hero.body": { css: ["p"], text: [], structural: "" } };

  it("keeps the words once revealed when the page's fonts arrive, and only holds the box", async () => {
    const d = withDom(`<p>${O}</p>`);
    const reveal = hide(d, "p");
    const land = loadingFonts(d);
    const fallback: Record<string, number> = { [O]: 40, "Long text": 60, Short: 40 };
    // In the real font the base length holds the page's lines, the short one is a line under.
    const real: Record<string, number> = { [O]: 60, "Long text": 60, Short: 40 };
    let at = fallback;
    const { applyVariant, holdVariant } = await import("../src/apply.ts");
    applyVariant(
      variant({ body: "Long text", body_alt: "Short" }),
      body,
      (el) => at[(el.textContent ?? "").trim()] ?? 999,
    );
    const p = d.querySelector("p") as HTMLElement;
    expect(p.textContent).toBe("Short");
    expect(p.style.minHeight).toBe("40px");
    reveal();
    at = real;
    await land();
    // The words the visitor read stay; the box is held at the original's height.
    expect(p.textContent).toBe("Short");
    expect(p.style.minHeight).toBe("60px");
    holdVariant(body, [], () => 0, 0);
    expect(p.textContent).toBe("Short");
  });

  it("chooses the length again when the fonts arrive while the part is still hidden", async () => {
    const d = withDom(`<p>${O}</p>`);
    hide(d, "p");
    const land = loadingFonts(d);
    const fallback: Record<string, number> = { [O]: 40, "Long text": 60, Short: 40 };
    const real: Record<string, number> = { [O]: 60, "Long text": 60, Short: 40 };
    let at = fallback;
    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(
      variant({ body: "Long text", body_alt: "Short" }),
      body,
      (el) => at[(el.textContent ?? "").trim()] ?? 999,
    );
    const p = d.querySelector("p") as HTMLElement;
    expect(p.textContent).toBe("Short");
    at = real;
    await land();
    expect(p.textContent).toBe("Long text");
    expect(p.style.minHeight).toBe("");
  });

  it("keeps the words once revealed at a new width (a phone turned), and only holds the box", async () => {
    vi.useFakeTimers();
    const d = withDom(`<p>${O}</p>`);
    const reveal = hide(d, "p");
    const w = d.defaultView as unknown as { innerWidth: number; dispatchEvent: (e: Event) => void };
    const wide: Record<string, number> = { [O]: 40, "Long text": 60, Short: 40 };
    const narrow: Record<string, number> = { [O]: 60, "Long text": 60, Short: 40 };
    let at = wide;
    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(
      variant({ body: "Long text", body_alt: "Short" }),
      body,
      (el) => at[(el.textContent ?? "").trim()] ?? 999,
    );
    const p = d.querySelector("p") as HTMLElement;
    expect(p.textContent).toBe("Short");
    reveal();
    at = narrow;
    w.innerWidth = 390;
    w.dispatchEvent(new (d.defaultView as unknown as { Event: typeof Event }).Event("resize"));
    vi.advanceTimersByTime(250);
    expect(p.textContent).toBe("Short");
    expect(p.style.minHeight).toBe("60px");
    // Seen once is seen: hidden again by the page, the words still stay.
    hide(d, "p");
    at = wide;
    w.innerWidth = 1280;
    w.dispatchEvent(new (d.defaultView as unknown as { Event: typeof Event }).Event("resize"));
    vi.advanceTimersByTime(250);
    expect(p.textContent).toBe("Short");
    expect(p.style.minHeight).toBe("");
    vi.useRealTimers();
  });

  it("keeps our label once revealed when the page's fonts make its row taller", async () => {
    const d = withDom('<div class="row"><a class="btn">Başla</a></div>');
    const reveal = hide(d, "a.btn");
    const land = loadingFonts(d);
    let late = false;
    const rowHeight = (el: Element) =>
      el.classList.contains("row") ? (late && (el.textContent ?? "").length > 6 ? 103 : 48) : 20;
    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(
      variant({ "cta.label": "Başlayaq" } as never),
      { "hero.cta.label": { css: ["a.btn"], text: [], structural: "" } } as never,
      rowHeight,
    );
    const a = d.querySelector("a.btn") as HTMLElement;
    reveal();
    late = true;
    await land();
    expect(a.textContent).toBe("Başlayaq");
  });
});
