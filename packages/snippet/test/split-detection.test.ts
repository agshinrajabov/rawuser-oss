/**
 * Phase 2 of docs/specs/interactive-text.md: the kinds the 2026-09-29 survey
 * found (docs/research/awwwards-hero-text-2026.md), rebuilt as our own markup.
 */
import { readTemplate as sharedRead } from "@rawuser/shared/template";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

function h1(html: string, attrs = "") {
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><body><h1 ${attrs}>${html}</h1></body></html>`,
  );
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("HTMLAnchorElement", dom.window.HTMLAnchorElement);
  vi.stubGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
  vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle);
  return dom.window.document.querySelector("h1") as Element;
}
const w = (t: string) => `<span style="display:inline-block">${t}</span>`;

// A Framer word split whose second half sits in a styled wrapper: four direct
// children with words, six word elements in all (Solva's shape).
const NESTED_WORDS = `${w("The")} ${w("support")} ${w("copilot")} <span class="framer-text dim">${w("that")} ${w("never")} ${w("sleeps.")}</span>`;
// A rotating word split into letters inside one wrapper, with a hidden
// spacer (Optivio's shape): one direct child with words, five letter elements.
const NESTED_LETTERS = `Turn traffic into <span aria-hidden="true" style="display:inline-block;position:relative"><span style="visibility:hidden">​</span><span style="position:absolute">${["l", "e", "a", "d", "s"].map(w).join("")}</span></span>`;
// A hidden measuring copy inside the h1, then the visible words (Grigoletti's shape).
const MEASURING_COPY = `<div><div aria-hidden="true" style="position:absolute;visibility:hidden;top:0"><span>Framer websites</span><span>that nobody</span><span>can ignore</span></div>${w("Framer")} ${w("websites")} ${w("that")} ${w("nobody")} ${w("can")} ${w("ignore")}</div>`;
// GSAP SplitText words, each numbered, each in a numbered mask (Sirene's shape).
const NUMBERED = ["Serene", "at", "work.", "Calm", "and", "faster"]
  .map(
    (t, i) =>
      `<div class="gsap_split_word-mask gsap_split_word${i + 1}-mask" aria-hidden="true" style="position:relative;display:inline-block"><div class="gsap_split_word gsap_split_word${i + 1}" aria-hidden="true" style="position:relative;display:inline-block">${t}</div></div>`,
  )
  .join(" ");

describe("a split nested in groups is split text, never written as one string", () => {
  it("reads a nested word split as split, with its template", async () => {
    const el = h1(NESTED_WORDS);
    const { readInlineShape } = await import("../src/shape.ts");
    const { elementShape } = await import("../src/apply.ts");
    const shape = readInlineShape(el);
    expect(shape.split).toBe(true);
    expect(elementShape(el)).toBe("split");
    const { readElementTemplate } = await import("../src/template.ts");
    expect(readElementTemplate(el)?.template).toBe(
      "The support copilot {s1}that never sleeps.{/s1}",
    );
  });

  it("leaves a rotating word split into letters alone instead of flattening it", async () => {
    const el = h1(NESTED_LETTERS);
    const before = el.innerHTML;
    const { writeText, elementShape } = await import("../src/apply.ts");
    expect(elementShape(el)).toBe("split");
    expect(writeText(el, "Turn visitors into buyers")).toBe(false);
    expect(el.innerHTML).toBe(before);
  });
});

describe("the reader skips a measuring copy and a split library's numbers", () => {
  it("reads the visible words once, not the hidden copy too", async () => {
    const el = h1(MEASURING_COPY);
    const { readElementTemplate } = await import("../src/template.ts");
    expect(readElementTemplate(el)?.template).toBe("Framer websites that nobody can ignore");
  });

  it("reads SplitText's numbered words as one run, not six style groups", async () => {
    const el = h1(NUMBERED);
    const { readElementTemplate } = await import("../src/template.ts");
    expect(readElementTemplate(el)?.template).toBe("Serene at work. Calm and faster");
  });

  it("the shared reader agrees on the same trees (parity)", async () => {
    const { treeOf, readTemplate } = await import("../src/template.ts");
    for (const html of [NESTED_WORDS, MEASURING_COPY, NUMBERED]) {
      const tree = treeOf(h1(html));
      const strip = (nodes: readonly ReturnType<typeof treeOf>[number][]): unknown =>
        nodes.map((n) =>
          n.kind === "text"
            ? { kind: "text", text: n.text }
            : { ...n, ref: undefined, children: strip(n.children) },
        );
      expect(sharedRead(strip(tree) as never)?.template).toBe(readTemplate(tree)?.template);
    }
  });
});

describe("the label a split library copied follows the new words", () => {
  it("rewrites an aria-label that repeated the old headline", async () => {
    const el = h1(NUMBERED, 'aria-label="Serene at work.Calm and faster"');
    const { writeText } = await import("../src/apply.ts");
    const template = "Quiet at work. Fast and calm";
    expect(
      writeText(el, template, {
        css: [],
        text: [],
        structural: "",
        inline: {
          icons: "none",
          emphasis: 0,
          split: true,
          animated_text: false,
          template: "Serene at work. Calm and faster",
        },
      } as never),
    ).toBe(true);
    expect(el.getAttribute("aria-label")).toBe("Quiet at work. Fast and calm");
  });

  it("leaves a label that says something else alone", async () => {
    const el = h1("Plain words here", 'aria-label="Company logo"');
    const { writeText } = await import("../src/apply.ts");
    writeText(el, "New words");
    expect(el.getAttribute("aria-label")).toBe("Company logo");
  });
});
