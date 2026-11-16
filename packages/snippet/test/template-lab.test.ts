/**
 * Template writing, step 1 (docs/specs/template-writing.md §6): the lab page
 * with a word-by-word hero, and what today's snippet does with it. The
 * "today" tests pin the current behaviour so the writer of step 3 changes it
 * on purpose; the todo list is the behaviour step 3 must reach.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

const LAB = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "word-split-hero.html"),
  "utf8",
);

/** The lab page in JSDOM, scripts off (the page's own rotator does not run here). */
function lab() {
  const dom = new JSDOM(LAB);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("Text", dom.window.Text);
  const d = dom.window.document;
  return {
    d,
    h1: d.querySelector('[data-rawuser="hero.headline"]') as Element,
    sub: d.querySelector('[data-rawuser="hero.body"]') as Element,
  };
}
afterEach(() => vi.unstubAllGlobals());

/** What the headline is made of, counted the way a reader of the spec would. */
function anatomy(h1: Element) {
  return {
    words: h1.querySelectorAll(".w:not(.g):not(.rot-wrap)").length,
    glyphs: h1.querySelectorAll(".g svg").length,
    breaks: h1.querySelectorAll("br").length,
    dim: h1.querySelectorAll(".dim").length,
    muted: h1.querySelectorAll(".muted").length,
    rotator: h1.querySelectorAll(".rot > span").length,
  };
}

const PAGE = { words: 11, glyphs: 2, breaks: 2, dim: 4, muted: 1, rotator: 4 };

describe("the lab page", () => {
  it("has the structure the spec describes", () => {
    const { h1, sub } = lab();
    expect(anatomy(h1)).toEqual(PAGE);
    // --i runs 0..13 in reading order over every animated child.
    const order = Array.from(h1.querySelectorAll<HTMLElement>("[style*='--i']")).map((el) =>
      Number(el.style.getPropertyValue("--i")),
    );
    expect(order).toEqual(Array.from({ length: 14 }, (_, i) => i));
    expect(sub.querySelectorAll("b").length).toBe(4);
  });
});

describe("today's snippet on the lab page (pinned; step 3 changes these)", () => {
  it("calls the headline split text", async () => {
    const { h1 } = lab();
    const { elementShape } = await import("../src/apply.ts");
    const { readInlineShape } = await import("../src/shape.ts");
    expect(elementShape(h1)).toBe("split");
    const shape = readInlineShape(h1);
    expect(shape.split).toBe(true);
    expect(shape.emphasis).toBe(0);
  });

  it("leaves the headline alone by default, so the version never shows", async () => {
    const { h1 } = lab();
    const before = h1.innerHTML;
    const { writeText } = await import("../src/apply.ts");
    expect(writeText(h1, "Your visitors came from AI search")).toBe(false);
    expect(h1.innerHTML).toBe(before);
  });

  it("flattens it on 'Replace as plain text': glyphs, word spans, lines and the rotating word are gone", async () => {
    const { h1 } = lab();
    const { writeText } = await import("../src/apply.ts");
    const entry = { css: [], text: [], structural: "", plain: true };
    expect(writeText(h1, "Your visitors came from AI search", entry as never)).toBe(true);
    expect(anatomy(h1)).toEqual({ words: 0, glyphs: 0, breaks: 0, dim: 0, muted: 0, rotator: 0 });
    expect(h1.textContent).toBe("Your visitors came from AI search");
  });

  it("keeps only one of the sub-paragraph's four bolds for a single marked phrase", async () => {
    const { sub } = lab();
    const { elementShape, writeText } = await import("../src/apply.ts");
    expect(elementShape(sub)).toBe("emphasis");
    writeText(sub, "Rawuser lets each part *greet* the visitor who came from a comparison.");
    const bolds = Array.from(sub.querySelectorAll<HTMLElement>("b"));
    const shown = bolds.filter(
      (b) => b.style.visibility !== "hidden" && /\S/.test(b.textContent ?? ""),
    );
    expect(bolds.length).toBe(4);
    expect(shown.length).toBe(1);
  });
});

/** The lab headline as a template (docs/specs/template-writing.md §3.1). */
const LAB_TEMPLATE =
  "{s1}Your{/s1} {g1}visitors {s1}already{/s1}{br}{s1}arrive through{/s1} {g2}AI tools.{br}{s2}Choose what they can {rot:read|compare|buy|skip}.{/s2}";

describe("template reading, the DOM side (step 2)", () => {
  it("reads the lab headline's template: words, two glyphs, two lines, two groups, the rotating slot", async () => {
    const { h1 } = lab();
    const { readElementTemplate } = await import("../src/template.ts");
    const tpl = readElementTemplate(h1);
    expect(tpl?.template).toBe(LAB_TEMPLATE);
    expect(tpl).toMatchObject({
      words: 11,
      glyphs: 2,
      breaks: 2,
      groups: ["dim", "muted"],
      rotator: ["read", "compare", "buy", "skip"],
    });
  });

  it("counts the lines a visitor sees, with one alternative of the rotating slot", async () => {
    const { h1 } = lab();
    const { readElementTemplate, templateLength, templateText } = await import(
      "../src/template.ts"
    );
    const tpl = readElementTemplate(h1)?.template ?? "";
    expect(templateText(tpl)).toBe(
      "Your visitors already\narrive through AI tools.\nChoose what they can compare.",
    );
    const textContent = (h1.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(textContent).toContain("readcomparebuyskip");
    expect(templateLength(tpl)).toBe(
      "Your visitors already arrive through AI tools. Choose what they can compare.".length,
    );
  });

  it("gives no template to the sub-paragraph (emphasis, not split) or to a letter-split heading", async () => {
    const { d, sub } = lab();
    const { readElementTemplate } = await import("../src/template.ts");
    // Four bolds: an emphasis shape for §4.4, not a word-by-word headline.
    expect(readElementTemplate(sub)).toBeNull();
    const letters = d.createElement("h2");
    for (const c of "Welcome") {
      const s = d.createElement("span");
      s.textContent = c;
      letters.appendChild(s);
    }
    expect(readElementTemplate(letters)).toBeNull();
  });
});

describe("template writing, the writer (step 3, docs/specs/template-writing.md §4.3)", () => {
  // Same structure as the page, same number of words in every run.
  const SAME =
    "{s1}Your{/s1} {g1}buyers {s1}today{/s1}{br}{s1}come from{/s1} {g2}AI search.{br}{s2}Decide what they may {rot:see|test|order|keep}.{/s2}";
  // Same structure, runs longer and shorter: "visitors" becomes two words,
  // "arrive through" one, "AI tools." three.
  const RESIZED =
    "{s1}All{/s1} {g1}curious visitors {s1}now{/s1}{br}{s1}arrive{/s1} {g2}from AI answers.{br}{s2}Show them what you {rot:do|fix|ship|charge}.{/s2}";
  const entry = {
    css: ['[data-rawuser="hero.headline"]'],
    text: [],
    structural: "",
    inline: {
      icons: "none" as const,
      emphasis: 0,
      split: true,
      animated_text: false,
      template: LAB_TEMPLATE,
    },
  };
  const wordEls = (h1: Element) => Array.from(h1.querySelectorAll(".w:not(.g):not(.rot-wrap)"));

  it("writes a version's words into the existing word elements, never innerHTML", async () => {
    const { d, h1 } = lab();
    const before = wordEls(h1);
    const html = vi.spyOn(
      (d.defaultView as Window & typeof globalThis).Element.prototype,
      "innerHTML",
      "set",
    );
    const { writeText } = await import("../src/apply.ts");
    expect(writeText(h1, SAME, entry)).toBe(true);
    const after = wordEls(h1);
    expect(after).toEqual(before);
    expect(after.every((el, i) => el === before[i])).toBe(true);
    expect(after.map((el) => el.textContent)).toEqual([
      "Your",
      "buyers",
      "today",
      "come",
      "from",
      "AI",
      "search.",
      "Decide",
      "what",
      "they",
      "may",
    ]);
    expect(html).not.toHaveBeenCalled();
  });

  it("keeps both glyphs before the words the template anchors them to, and both line breaks", async () => {
    const { h1 } = lab();
    const glyphs = Array.from(h1.querySelectorAll(".g"));
    const { writeText } = await import("../src/apply.ts");
    expect(writeText(h1, RESIZED, entry)).toBe(true);
    const now = Array.from(h1.querySelectorAll(".g"));
    expect(now).toEqual(glyphs);
    expect(now.every((g, i) => g === glyphs[i])).toBe(true);
    expect(now[0]?.nextElementSibling?.textContent).toBe("curious");
    expect(now[1]?.nextElementSibling?.textContent).toBe("from");
    expect(h1.querySelectorAll("br")).toHaveLength(2);
    expect(h1.querySelectorAll(".g svg")).toHaveLength(2);
  });

  it("clones a run's last word element for a surplus word and removes one for a missing word", async () => {
    const { h1 } = lab();
    const { writeText } = await import("../src/apply.ts");
    writeText(h1, RESIZED, entry);
    expect(anatomy(h1)).toEqual({ ...PAGE, words: 12, dim: 3 });
    expect(wordEls(h1).map((el) => el.textContent)).toEqual([
      "All",
      "curious",
      "visitors",
      "now",
      "arrive",
      "from",
      "AI",
      "answers.",
      "Show",
      "them",
      "what",
      "you",
    ]);
    // A clone keeps its model's classes: "visitors" is plain like "curious".
    const visitors = wordEls(h1)[2] as Element;
    expect(Array.from(visitors.classList)).toEqual(["w"]);
    // The resized page reads back as the version.
    const { readElementTemplate } = await import("../src/template.ts");
    expect(readElementTemplate(h1)?.template).toBe(RESIZED);
  });

  it("renumbers --i in reading order after words are added or removed", async () => {
    const { h1 } = lab();
    const { writeText } = await import("../src/apply.ts");
    writeText(h1, RESIZED, entry);
    const order = Array.from(h1.querySelectorAll<HTMLElement>("[style*='--i']")).map((el) =>
      Number(el.style.getPropertyValue("--i")),
    );
    expect(order).toEqual(Array.from({ length: 15 }, (_, i) => i));
  });

  it("writes the rotating alternatives into the page's own spans, so its script still cycles them", async () => {
    const { h1 } = lab();
    const rot = h1.querySelector("#rot") as Element;
    // What the page's script holds: the four nodes, read once at load.
    const held = Array.from(rot.querySelectorAll("span"));
    const { writeText } = await import("../src/apply.ts");
    writeText(h1, SAME, entry);
    const now = Array.from(rot.querySelectorAll("span"));
    expect(now.every((el, i) => el === held[i])).toBe(true);
    expect(held.map((el) => el.textContent)).toEqual(["see", "test", "order", "keep"]);
    // One tick of the page's own cycle: the next held node shows its new word.
    held[0]?.classList.remove("on");
    held[1]?.classList.add("on");
    expect(rot.querySelector(".on")?.textContent).toBe("test");
    expect(held[0]?.classList.contains("on")).toBe(false);
  });

  it("fits the page's sized rotating slot to the version's showing word at once", async () => {
    const { h1 } = lab();
    const rot = h1.querySelector("#rot") as HTMLElement;
    // What the page's script did at load: the slot sized to "read", with a transition.
    rot.style.width = "130px";
    rot.style.transition = "width 0.55s ease";
    const on = rot.querySelector(".on") as HTMLElement;
    Object.defineProperty(on, "offsetWidth", { configurable: true, get: () => 159 });
    const { writeText } = await import("../src/apply.ts");
    writeText(h1, SAME, entry);
    expect(on.textContent).toBe("see");
    expect(rot.style.width).toBe("159px");
    expect(rot.style.transition).toBe("width 0.55s ease");
  });

  it("restarts the entry animations once the words are in", async () => {
    const { h1 } = lab();
    const anims = [{ currentTime: 480 }, { currentTime: 900 }];
    (h1 as unknown as { getAnimations: () => unknown[] }).getAnimations = () => anims;
    const { writeText } = await import("../src/apply.ts");
    writeText(h1, SAME, entry);
    expect(anims.map((a) => a.currentTime)).toEqual([0, 0]);
  });

  it("measures the three templates and keeps the one that holds the headline's lines", async () => {
    const { h1 } = lab();
    const { applyVariant, lastApplied } = await import("../src/apply.ts");
    // The page and SAME take three lines (200 px); RESIZED takes four.
    const measure = (el: Element) => ((el.textContent ?? "").includes("curious") ? 260 : 200);
    const ok = applyVariant(
      { sections: { hero: { kind: "hero", headline: RESIZED, headline_alt: SAME } } } as never,
      { "hero.headline": entry as never },
      measure,
    );
    expect(ok).toBe(true);
    expect(wordEls(h1)[1]?.textContent).toBe("buyers");
    expect(lastApplied()[0]?.value).toBe(SAME);
  });

  it("measures each length with every rotating word showing and keeps one that holds for all of them", async () => {
    const { h1 } = lab();
    const { applyVariant, lastApplied } = await import("../src/apply.ts");
    // The line wraps when the showing word is over seven letters: SAME's
    // first word fits but its fourth ("longerword") would add a line as the
    // page cycles to it; RESIZED's words are all short.
    const flips = SAME.replace("see|test|order|keep", "see|test|order|longerword");
    const measure = (el: Element) =>
      (el.querySelector("#rot .on")?.textContent ?? "").trim().length > 7 ? 260 : 200;
    applyVariant(
      { sections: { hero: { kind: "hero", headline: flips, headline_alt: RESIZED } } } as never,
      { "hero.headline": entry as never },
      measure,
    );
    expect(lastApplied()[0]?.value).toBe(RESIZED);
    // The page is left as the page's script had it: the first word showing, its node the same.
    const rot = h1.querySelector("#rot") as Element;
    expect(rot.querySelector(".on")?.textContent).toBe("do");
    expect(Array.from(rot.querySelectorAll("span")).map((e) => e.textContent)).toEqual([
      "do",
      "fix",
      "ship",
      "charge",
    ]);
  });

  it("writes the page's own length back after trying one that leaves one word beside the rotating slot", async () => {
    // problem:community at 390 (2026-09-28): the third length left "for" alone in the
    // styled group, the reader stopped calling it a group, and the first length
    // could not be written back.
    const { h1 } = lab();
    const { writeText } = await import("../src/apply.ts");
    const base =
      "{s1}Your{/s1} {g1}traffic {s1}lands{/s1}{br}{s1}on{/s1} {g2}one{br}{s2}static page for {rot:everyone|anyone|all|each}.{/s2}";
    const alt2 =
      "{s1}Your{/s1} {g1}traffic {s1}hits{/s1}{br}{s1}one{/s1} {g2}static page{br}{s2}for {rot:everyone|anyone|all|each}.{/s2}";
    expect(writeText(h1, base, entry)).toBe(true);
    expect(writeText(h1, alt2, entry)).toBe(true);
    expect(writeText(h1, base, entry)).toBe(true);
    expect((h1.textContent ?? "").replace(/\s+/g, " ")).toContain("static page for");
  });

  it("holds the headline at its tallest rotating word when the words change its line count", async () => {
    const { h1 } = lab();
    const { applyVariant } = await import("../src/apply.ts");
    // Every length wraps a line on its long fourth word: nothing to pick, so reserve.
    const flips = SAME.replace("see|test|order|keep", "see|test|order|longerword");
    const measure = (el: Element) =>
      (el.querySelector("#rot .on")?.textContent ?? "").trim().length > 7 ? 260 : 200;
    applyVariant(
      { sections: { hero: { kind: "hero", headline: flips } } } as never,
      { "hero.headline": entry as never },
      measure,
    );
    expect((h1 as HTMLElement).style.minHeight).toBe("260px");
    // The page as its script had it: the first word showing.
    expect(h1.querySelector("#rot .on")?.textContent).toBe("see");
  });

  it("reserves nothing when every rotating word keeps the same lines", async () => {
    const { h1 } = lab();
    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(
      { sections: { hero: { kind: "hero", headline: SAME } } } as never,
      { "hero.headline": entry as never },
      () => 200,
    );
    expect((h1 as HTMLElement).style.minHeight).toBe("");
  });

  it("keeps the hold quiet: the rotating word cycling does not change textContent", async () => {
    const { h1 } = lab();
    const original = h1.textContent;
    const { applyVariant, lastApplied } = await import("../src/apply.ts");
    applyVariant(
      { sections: { hero: { kind: "hero", headline: SAME } } } as never,
      { "hero.headline": entry as never },
      () => 100,
    );
    const rendered = lastApplied()[0]?.rendered;
    expect(rendered).toBe(h1.textContent);
    expect(rendered).not.toBe(original);
    const spans = Array.from(h1.querySelectorAll("#rot > span"));
    for (let i = 0; i < 4; i++) {
      spans[i]?.classList.remove("on");
      spans[(i + 1) % 4]?.classList.add("on");
      expect(h1.textContent).toBe(rendered);
    }
  });

  it("refuses a version whose glyphs, lines, groups or rotator size differ from the page's, and leaves the page whole", async () => {
    const { h1 } = lab();
    const before = h1.innerHTML;
    const { writeText } = await import("../src/apply.ts");
    const refused = [
      "Your visitors came from AI search", // plain text, no template
      SAME.replace("{g1}", ""), // a glyph dropped
      SAME.replace("{br}", " "), // a line dropped
      SAME.replace("{s2}", "").replace("{/s2}", ""), // a group dropped
      SAME.replace("{rot:see|test|order|keep}", "{rot:see|test|order}"), // three alternatives for four
      SAME.replace("{/s1} {g1}buyers", "{/s1} {g1}"), // a run left without words
      SAME.replace("keep}.{/s2}", "keep} works.{/s2}"), // a word where the page has only "." (live, 2026-09-27)
    ];
    for (const version of refused) {
      expect(writeText(h1, version, entry)).toBe(false);
      expect(h1.innerHTML).toBe(before);
    }
  });

  it.todo("writes up to four marked phrases into the sub-paragraph's four bolds, in order (§4.4)");
});
