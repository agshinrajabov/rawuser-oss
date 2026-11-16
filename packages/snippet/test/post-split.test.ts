/**
 * Phase 3 of docs/specs/interactive-text.md: writing into a headline the
 * page has already split, by letter and by line. The markup is our own,
 * rebuilt from what the 2026-09-29 probes read on salix.framer.website,
 * Splitting.js, noho.ink, grigoletti.ch and GSAP SplitText.
 */
import { lineSet as sharedLines, readTemplate as sharedRead } from "@rawuser/shared/template";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function page(body: string, head = "") {
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`,
  );
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

// Framer's text effect: a nowrap span per word, a span per letter in its
// from-state, spaces between words (salix.framer.website).
const FROM = "display:inline-block;opacity:0.001;filter:blur(10px);transform:translateY(10px)";
const framerWord = (w: string) =>
  `<span style="white-space:nowrap">${Array.from(w)
    .map((c) => `<span style="${FROM}">${c}</span>`)
    .join("")}</span>`;
const FRAMER = `<h1 class="framer-text">${["The", "Smartest", "Way", "to", "Bring", "ROI."].map(framerWord).join(" ")}</h1>`;

// Splitting.js after Splitting(): words, letters, the numbers its CSS reads.
function splitting(words: string[]): string {
  let c = 0;
  const parts = words.map(
    (w, wi) =>
      `<span class="word" data-word="${w}" style="--word-index:${wi}">${Array.from(w)
        .map(
          (ch) => `<span class="char" data-char="${ch}" style="--char-index:${c++}">${ch}</span>`,
        )
        .join("")}</span>`,
  );
  return `<h1 class="words chars splitting" data-rawuser="hero.headline" style="--word-total:${words.length};--char-total:${c}">${parts.join('<span class="whitespace"> </span>')}</h1>`;
}

describe("a word split into letters is read as a word", () => {
  it("reads Framer's letters as a template of words, the same on both sides", async () => {
    const doc = page(FRAMER);
    const { readElementTemplate, treeOf } = await import("../src/template.ts");
    const h1 = doc.querySelector("h1") as Element;
    const tpl = readElementTemplate(h1);
    expect(tpl?.template).toBe("The Smartest Way to Bring ROI.");
    expect(tpl?.letters).toBe(true);
    const strip = (n: unknown): unknown =>
      JSON.parse(JSON.stringify(n, (k, v) => (k === "ref" ? undefined : v)));
    expect(sharedRead(strip(treeOf(h1)) as never)).toEqual(strip(tpl));
  });

  it("reads Splitting.js, its whitespace spans as spaces and a full stop inside a word", async () => {
    const doc = page(splitting(["Your", "visitors", "arrive", "through", "AI", "tools."]));
    const { readElementTemplate } = await import("../src/template.ts");
    expect(readElementTemplate(doc.querySelector("h1") as Element)?.template).toBe(
      "Your visitors arrive through AI tools.",
    );
  });

  it("still leaves letters with no word around them alone", async () => {
    const doc = page(
      `<h1>${Array.from("Welcome")
        .map((c) => `<span>${c}</span>`)
        .join("")}</h1>`,
    );
    const { readElementTemplate } = await import("../src/template.ts");
    expect(readElementTemplate(doc.querySelector("h1") as Element)).toBeNull();
  });

  it("makes one short word in letters split text, never flattened", async () => {
    const doc = page(`<h1>${framerWord("Hello")}</h1>`);
    const { elementShape } = await import("../src/apply.ts");
    expect(elementShape(doc.querySelector("h1") as Element)).toBe("split");
  });
});

describe("the letter writer", () => {
  it("reuses the page's letters, clones and removes, and numbers them again", async () => {
    const doc = page(splitting(["Your", "visitors", "arrive", "through", "AI", "tools."]));
    const h1 = doc.querySelector("h1") as HTMLElement;
    const firstLetter = h1.querySelector(".char");
    const { writeTemplate } = await import("../src/template-write.ts");
    expect(writeTemplate(h1, "Every visit gets its own page today.")).toBe(true);
    expect(h1.textContent?.replace(/\s+/g, " ")).toBe("Every visit gets its own page today.");
    expect(h1.querySelector(".char")).toBe(firstLetter);
    const chars = Array.from(h1.querySelectorAll<HTMLElement>(".char"));
    expect(chars.map((c) => c.style.getPropertyValue("--char-index"))).toEqual(
      chars.map((_, i) => String(i)),
    );
    expect(chars.every((c) => c.getAttribute("data-char") === c.textContent)).toBe(true);
    const words = Array.from(h1.querySelectorAll<HTMLElement>(".word"));
    expect(words.map((w) => w.style.getPropertyValue("--word-index"))).toEqual(
      words.map((_, i) => String(i)),
    );
    expect(words.map((w) => w.getAttribute("data-word"))).toEqual([
      "Every",
      "visit",
      "gets",
      "its",
      "own",
      "page",
      "today.",
    ]);
    expect(h1.style.getPropertyValue("--char-total")).toBe(String(chars.length));
    expect(h1.style.getPropertyValue("--word-total")).toBe("7");
  });

  it("gives a cloned letter the page's own animation: style mirrored, scripted animations copied", async () => {
    vi.useFakeTimers();
    const doc = page(FRAMER);
    const h1 = doc.querySelector("h1") as HTMLElement;
    // The page's script animates the last letter of "Way" with WAAPI.
    const model = h1.querySelectorAll("span[style*='nowrap']")[2]?.lastElementChild as HTMLElement;
    const anim = {
      effect: {
        getKeyframes: () => [{ opacity: 0 }, { opacity: 1 }],
        getTiming: () => ({ duration: 1000 }),
      },
      startTime: 1200,
      playState: "running",
    };
    (model as unknown as { getAnimations: () => unknown[] }).getAnimations = () => [anim];
    const made: Array<{ startTime: number | null }> = [];
    (
      doc.defaultView as unknown as { HTMLElement: { prototype: { animate: unknown } } }
    ).HTMLElement.prototype.animate = () => {
      const a = { startTime: null as number | null, pause() {} };
      made.push(a);
      return a;
    };
    const { writeTemplate } = await import("../src/template-write.ts");
    // "Way" becomes "Wayss": two letters cloned from its last.
    expect(writeTemplate(h1, "The Smartest Wayss to Bring ROI.")).toBe(true);
    const word = h1.querySelectorAll("span[style*='nowrap']")[2] as HTMLElement;
    expect(word.textContent).toBe("Wayss");
    const clone = word.lastElementChild as HTMLElement;
    expect(clone).not.toBe(model);
    expect(made.length).toBeGreaterThanOrEqual(1);
    expect(made[0]?.startTime).toBe(1200);
    // framer-motion writes the model's transform: the clone follows.
    model.style.transform = "translateY(3px)";
    await vi.advanceTimersByTimeAsync(0);
    expect(clone.style.transform).toBe("translateY(3px)");
  });

  it("gives a cloned word of a word split the model's style as the page animates it", async () => {
    const doc = page(
      `<h1>${["Launch", "your", "AI", "or", "SaaS", "startup"].map((w) => `<span style="display:inline-block;opacity:0.001">${w}</span>`).join(" ")}</h1>`,
    );
    const h1 = doc.querySelector("h1") as HTMLElement;
    const { writeTemplate } = await import("../src/template-write.ts");
    expect(writeTemplate(h1, "Launch your AI or SaaS startup in days")).toBe(true);
    const words = Array.from(h1.children) as HTMLElement[];
    expect(words).toHaveLength(8);
    (words[5] as HTMLElement).style.opacity = "1";
    await new Promise((r) => setTimeout(r, 0));
    expect((words[7] as HTMLElement).style.opacity).toBe("1");
  });
});

// Noho (Webflow): a mask per line, one paragraph per line.
const NOHO = `<div class="hero-title-parent" data-rawuser="hero.headline">${[
  "We make furniture",
  "that's flexible, and",
  "playful, to fit every",
  "space you live in.",
]
  .map(
    (l) =>
      `<div class="title-line-parent" style="overflow:hidden"><p class="title-line">${l}</p></div>`,
  )
  .join("")}</div>`;
// Grigoletti (Framer): a measuring copy, then masks by inline style.
const GRIGOLETTI = `<h1 data-rawuser="hero.headline"><div style="display:flex;flex-direction:column"><div aria-hidden="true" style="position:absolute;visibility:hidden"><span>Framer websites,</span><span>die es unmöglich</span><span>machen, dein Business</span></div>${[
  "Framer websites,",
  "die es unmöglich",
  "machen, dein Business",
]
  .map((l) => `<div style="overflow:hidden"><div style="white-space:nowrap">${l}</div></div>`)
  .join("")}</div></h1>`;
// GSAP SplitText with masks: line-mask > line > a div per word.
const SPLITTEXT = `<h1 data-rawuser="hero.headline" aria-label="Your visitors already arrive through AI tools.">${[
  ["Your", "visitors", "already"],
  ["arrive", "through", "AI"],
  ["tools."],
]
  .map(
    (ws) =>
      `<div class="line-mask" aria-hidden="true" style="overflow:clip"><div class="line" style="transform:translate(0%, 100%)">${ws.map((w) => `<div style="display:inline-block">${w}</div>`).join(" ")}</div></div>`,
  )
  .join("")}</h1>`;

describe("lines the page made", () => {
  it("finds the lines on Noho, Grigoletti and SplitText, the same on both sides", async () => {
    const { lineSet, treeOf } = await import("../src/template.ts");
    const { readInlineShape } = await import("../src/shape.ts");
    for (const [html, n] of [
      [NOHO, 4],
      [GRIGOLETTI, 3],
      [SPLITTEXT, 3],
    ] as const) {
      const doc = page(html);
      const el = doc.querySelector("[data-rawuser]") as Element;
      expect(lineSet(treeOf(el))?.length).toBe(n);
      const strip = JSON.parse(JSON.stringify(treeOf(el), (k, v) => (k === "ref" ? undefined : v)));
      expect(sharedLines(strip)?.length).toBe(n);
      const shape = readInlineShape(el);
      expect(shape.lines).toBe(n);
      expect(shape.split).toBe(true);
    }
  });

  it("never takes a word split or a letter split for lines", async () => {
    const { lineSet, treeOf } = await import("../src/template.ts");
    const doc = page(FRAMER);
    expect(lineSet(treeOf(doc.querySelector("h1") as Element))).toBeNull();
    const doc2 = page(`<h1>${framerWord("Build")} ${framerWord("faster")}</h1>`);
    expect(lineSet(treeOf(doc2.querySelector("h1") as Element))).toBeNull();
  });
});

describe("the line writer", () => {
  // A line holds at most 22 characters here; jsdom has no layout.
  const fits = (_line: Element, holder: Element) => (holder.textContent ?? "").trim().length <= 22;

  it("pours the words into the page's lines, reusing their elements", async () => {
    const doc = page(NOHO);
    const el = doc.querySelector("[data-rawuser]") as Element;
    const paras = Array.from(el.querySelectorAll("p"));
    const { writeLines } = await import("../src/lines-write.ts");
    expect(
      writeLines(el, "We build furniture that bends to the room you have, not the other way", fits),
    ).toBe(true);
    const lines = Array.from(el.querySelectorAll("p")).map((p) => p.textContent ?? "");
    // The page's four lines kept, evenly filled, each inside its width.
    expect(lines).toHaveLength(4);
    expect(lines.join(" ")).toBe(
      "We build furniture that bends to the room you have, not the other way",
    );
    expect(lines.every((l) => l.length <= 22)).toBe(true);
    expect(Array.from(el.querySelectorAll("p"))).toEqual(paras);
  });

  it("clones the last line when the words need one more, and it follows the model", async () => {
    const doc = page(SPLITTEXT);
    const el = doc.querySelector("h1") as HTMLElement;
    const { writeLines } = await import("../src/lines-write.ts");
    expect(
      writeLines(
        el,
        "Every visitor who arrives from an AI tool now sees a page that answers why they came",
        fits,
      ),
    ).toBe(true);
    const masks = Array.from(el.querySelectorAll<HTMLElement>(".line-mask"));
    expect(masks.length).toBeGreaterThan(3);
    const lastModel = masks[2]?.querySelector(".line") as HTMLElement;
    const clone = masks[3]?.querySelector(".line") as HTMLElement;
    // GSAP moves the model's line up; the clone moves with it.
    lastModel.style.transform = "translate(0px, 0px)";
    await new Promise((r) => setTimeout(r, 0));
    expect(clone.style.transform).toBe("translate(0px, 0px)");
    // Word elements reused, one per word.
    expect(masks[0]?.querySelectorAll(".line > div")).toHaveLength(
      (masks[0]?.textContent ?? "").trim().split(/\s+/).length,
    );
  });

  it("removes lines it does not need", async () => {
    const doc = page(NOHO);
    const el = doc.querySelector("[data-rawuser]") as Element;
    const { writeLines } = await import("../src/lines-write.ts");
    // Two words cannot fill four lines: poured by width, one line, the rest removed.
    expect(writeLines(el, "We build", fits)).toBe(true);
    expect(Array.from(el.querySelectorAll("p")).map((p) => p.textContent)).toEqual(["We build"]);
    expect(el.querySelectorAll(".title-line-parent")).toHaveLength(1);
  });

  it("keeps the line count of a page that fits its font to a measuring copy, and gives the copy our lines", async () => {
    const doc = page(GRIGOLETTI);
    const el = doc.querySelector("h1") as Element;
    const { writeLines } = await import("../src/lines-write.ts");
    expect(writeLines(el, "Framer sites that sell, built in a week", fits)).toBe(true);
    const visible = Array.from(el.querySelectorAll("div[style*='nowrap']")).map(
      (d) => d.textContent,
    );
    const copy = Array.from(el.querySelectorAll("[aria-hidden] span")).map((s) => s.textContent);
    expect(visible).toHaveLength(3);
    expect(visible.join(" ")).toBe("Framer sites that sell, built in a week");
    expect(copy).toEqual(visible);
  });

  it("balances words into lines of even length", async () => {
    const { balance } = await import("../src/lines.ts");
    const cut = balance("Framer sites that sell, built in a week".split(" "), 3);
    expect(cut).toHaveLength(3);
    const lens = cut.map((l) => l.join(" ").length);
    expect(Math.max(...lens) - Math.min(...lens)).toBeLessThanOrEqual(6);
    expect(balance(["One"], 3)).toEqual([["One"]]);
  });
});

describe("routing, the landing race and the reason for a skip", () => {
  const LINES = {
    css: ["h1"],
    text: [],
    structural: "",
    inline: { icons: "none", emphasis: 0, split: true, animated_text: false, lines: 3 },
  };

  it("writes plain text when the page has not split yet, and the page splits ours", async () => {
    const doc = page(
      `<h1 data-rawuser="hero.headline">Your visitors already arrive through AI tools.</h1>`,
    );
    const { applyVariant } = await import("../src/apply.ts");
    const ok = applyVariant(
      { sections: { hero: { kind: "hero", headline: "Every visit gets its own page." } } } as never,
      { "hero.headline": LINES } as never,
      () => 0,
    );
    expect(ok).toBe(true);
    expect(doc.querySelector("h1")?.textContent).toBe("Every visit gets its own page.");
  });

  it("says why when it leaves a split it cannot write", async () => {
    const doc = page(
      `<h1>${Array.from("Welcome home")
        .map((c) => `<span>${c}</span>`)
        .join("")}</h1>`,
    );
    const before = doc.querySelector("h1")?.innerHTML;
    const { applyVariant, lastSkip } = await import("../src/apply.ts");
    const ok = applyVariant(
      { sections: { hero: { kind: "hero", headline: "Hello there" } } } as never,
      { "hero.headline": { css: ["h1"], text: [], structural: "" } } as never,
      () => 0,
    );
    expect(ok).toBe(false);
    expect(lastSkip()).toBe("split");
    expect(doc.querySelector("h1")?.innerHTML).toBe(before);
  });
});

describe("no early write on a page React will hydrate", () => {
  const kept = {
    sections: { hero: { kind: "hero", headline: "Carried words" } },
    targets: { "hero.headline": { css: ["h1"], text: [], structural: "" } },
    prompt_hash: "",
  } as never;

  it("leaves a Framer page to the edge's answer after hydration", async () => {
    const doc = page("<h1>Page words</h1>", '<meta name="generator" content="Framer 1a2b">');
    const { earlyApply } = await import("../src/early.ts");
    const early = earlyApply(kept);
    expect(early.applied).toBe(false);
    // Off before writing: /select is not told the tab's copy was carried (bc).
    expect(early.off).toBe(true);
    expect(doc.querySelector("h1")?.textContent).toBe("Page words");
  });

  it("and a page carrying React's server marks", async () => {
    const doc = page("<!--$--><h1>Page words</h1><!--/$-->");
    const { earlyApply } = await import("../src/early.ts");
    expect(earlyApply(kept).applied).toBe(false);
    expect(doc.querySelector("h1")?.textContent).toBe("Page words");
  });
});

describe("a fitted page that does not fit at this width (grigoletti.ch at 390)", () => {
  it("pours the kept length by width when the page has not fitted its font to it after 400 ms", async () => {
    const doc = page(GRIGOLETTI);
    const el = doc.querySelector("h1") as HTMLElement;
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => frames.push(f));
    const box = el.firstElementChild as HTMLElement;
    Object.defineProperty(el, "offsetWidth", { value: 300 });
    // Every mask is 100 px; a holder is 10 px a character (jsdom has no layout).
    for (const m of Array.from(
      box.querySelectorAll<HTMLElement>(":scope > div[style*='overflow']"),
    ))
      Object.defineProperty(m, "clientWidth", { value: 100, configurable: true });
    const proto = (doc.defaultView as unknown as { HTMLElement: { prototype: object } }).HTMLElement
      .prototype;
    Object.defineProperty(proto, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return (this.textContent ?? "").length * 10;
      },
    });
    const { writeLines } = await import("../src/lines-write.ts");
    const fits = (_l: Element, h: Element) => (h.textContent ?? "").length * 10 <= 100;
    vi.useFakeTimers();
    writeLines(el, "Some words that run long", fits);
    writeLines(el, "Other words that run much longer here", fits);
    // The headline is one pixel narrower through a whole frame, so the
    // page's ResizeObserver sees it, and restored in the frame after.
    expect(el.style.width).toBe("299px");
    for (const f of frames.splice(0)) f();
    expect(el.style.width).toBe("299px");
    for (const f of frames.splice(0)) f();
    expect(el.style.width).toBe("");
    // The page gets 400 ms to fit its font to our lines; this one does not.
    vi.advanceTimersByTime(400);
    const visible = Array.from(el.querySelectorAll("div[style*='nowrap']")).map(
      (d) => d.textContent,
    );
    expect(visible.join(" ")).toBe("Other words that run much longer here");
    expect(visible.every((t) => (t ?? "").length <= 10)).toBe(true);
    // biome-ignore lint/performance/noDelete: removes the stub so the prototype's own getter is back
    delete (proto as { scrollWidth?: number }).scrollWidth;
  });
});

describe("the fit check's lengths never change the page's line count (the Webflow test page at 390)", () => {
  it("a shorter length written after a longer one goes back to the page's lines", async () => {
    const doc = page(NOHO);
    const el = doc.querySelector("[data-rawuser]") as Element;
    const { writeLines } = await import("../src/lines-write.ts");
    const fits = (_l: Element, h: Element) => (h.textContent ?? "").trim().length <= 22;
    // A long length clones lines past the page's four.
    writeLines(
      el,
      "Every visitor who arrives from an AI tool now sees a page that answers why they came to it today",
      fits,
    );
    expect(el.querySelectorAll(".title-line-parent").length).toBeGreaterThan(4);
    // The kept, shorter length fills the page's own four, no clone left.
    writeLines(el, "One snippet serves thirty versions of your page", fits);
    const lines = Array.from(el.querySelectorAll("p")).map((p) => p.textContent);
    expect(lines).toHaveLength(4);
    expect(lines.join(" ")).toBe("One snippet serves thirty versions of your page");
  });
});

describe("the page's own GSAP entrance plays again on our words (the Webflow test page, warm load)", () => {
  it("restarts the page's live tweens on the lines it wrote into, once each", async () => {
    const doc = page(SPLITTEXT);
    const el = doc.querySelector("h1") as HTMLElement;
    const restarted: boolean[] = [];
    const tween = { restart: (d?: boolean) => restarted.push(!!d) };
    vi.stubGlobal("gsap", {
      getTweensOf: (targets: Element[]) =>
        targets.some((t) => t.classList?.contains("line")) ? [tween, tween] : [],
    });
    const { applyVariant } = await import("../src/apply.ts");
    const ok = applyVariant(
      {
        sections: { hero: { kind: "hero", headline: "Every visit gets its own page now" } },
      } as never,
      {
        "hero.headline": {
          css: ["h1"],
          text: [],
          structural: "",
          inline: { icons: "none", emphasis: 0, split: true, animated_text: false, lines: 3 },
        },
      } as never,
      () => 0,
    );
    expect(ok).toBe(true);
    // One tween, restarted once with its delay (the stagger), not once per target.
    expect(restarted).toEqual([true]);
  });

  it("leaves a tween the page holds for later: paused, on a ScrollTrigger, or inside a timeline that is", async () => {
    const doc = page(SPLITTEXT);
    const el = doc.querySelector("h1") as HTMLElement;
    const restarted: string[] = [];
    const tw = (name: string, extra: Record<string, unknown> = {}) => ({
      restart: () => restarted.push(name),
      paused: () => false,
      ...extra,
    });
    const scrolled = { scrollTrigger: {}, paused: () => false };
    const tweens = [
      tw("live"),
      tw("paused", { paused: () => true }),
      tw("scroll", { scrollTrigger: {} }),
      tw("in-scroll-timeline", { parent: scrolled }),
    ];
    vi.stubGlobal("gsap", { getTweensOf: () => tweens });
    const { restartAnimations } = await import("../src/template.ts");
    restartAnimations(el);
    expect(restarted).toEqual(["live"]);
  });
});
