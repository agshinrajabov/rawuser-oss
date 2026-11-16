import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Inline shape read from captured HTML with node-html-parser, mirroring the
 * DOM reader in the snippet (docs/specs/design-preserving-rewrite.md §2).
 */
import type { Manifest } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { attachInlineShapes, markEmphasis, refreshLengths } from "../src/inline-shape-html.ts";

const HTML = `<main><section>
  <h1 class="headline">We build <em>hand-made<span class="mark"></span></em> products.</h1>
  <p class="lead">Plain lead text.</p>
  <a class="btn" href="/work"><svg viewBox="0 0 1 1"></svg> See our work</a>
  <a class="alt" href="/contact">Start a build <span>→</span></a>
  <h2 class="split"><span>H</span><span>e</span><span>l</span><span>l</span><span>o</span></h2>
</section></main>`;

const manifest: Manifest = {
  "hero.headline": {
    css: [".headline"],
    text: ["We build hand-made products."],
    structural: "first h1 in main",
  },
  "hero.body": { css: [".lead"], text: ["Plain lead text."], structural: "first p in main" },
  "hero.cta.label": { css: [".btn"], text: ["See our work"], structural: "first a in main" },
  "cta.cta.label": { css: [".alt"], text: ["Start a build"], structural: "2nd a in main" },
  "features.headline": { css: [".split"], text: ["Hello"], structural: "first h2 in main" },
  "forms.submit_label": { css: [".nowhere"], text: [], structural: "first button in main" },
};

describe("attachInlineShapes", () => {
  it("reads emphasis with its phrase, icons on either side, split text, and leaves unmatched slots alone", () => {
    const m = attachInlineShapes(HTML, manifest);
    expect(m["hero.headline"]?.inline).toEqual({
      icons: "none",
      emphasis: 1,
      emphasis_phrase: "hand-made",
      split: false,
      animated_text: false,
    });
    expect(m["hero.body"]?.inline).toEqual({
      icons: "none",
      emphasis: 0,
      split: false,
      animated_text: false,
    });
    expect(m["hero.cta.label"]?.inline?.icons).toBe("leading");
    expect(m["cta.cta.label"]?.inline?.icons).toBe("trailing");
    expect(m["features.headline"]?.inline?.split).toBe(true);
    expect(m["forms.submit_label"]?.inline).toBeUndefined();
  });
});

describe("markEmphasis", () => {
  it("wraps the phrase when present, else returns the text", () => {
    expect(markEmphasis("We build hand-made products.", "hand-made")).toBe(
      "We build *hand-made* products.",
    );
    expect(markEmphasis("We build products.", "hand-made")).toBe("We build products.");
    expect(markEmphasis(null, "x")).toBeNull();
    expect(markEmphasis("text", undefined)).toBe("text");
  });
});

/**
 * Template reading, the HTML side (docs/specs/template-writing.md §4.1): the
 * same lab page the snippet tests read through the DOM gives the same
 * template through node-html-parser.
 */
describe("template reading on the lab page, the HTML side", () => {
  const LAB = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "snippet",
      "test",
      "fixtures",
      "word-split-hero.html",
    ),
    "utf8",
  );
  const TEMPLATE =
    "{s1}Your{/s1} {g1}visitors {s1}already{/s1}{br}{s1}arrive through{/s1} {g2}AI tools.{br}{s2}Choose what they can {rot:read|compare|buy|skip}.{/s2}";
  const labManifest: Manifest = {
    "hero.headline": {
      css: ['[data-rawuser="hero.headline"]'],
      text: [],
      structural: "first h1",
      original_char_length: 999,
      original_word_count: 99,
    },
    "hero.body": { css: ['[data-rawuser="hero.body"]'], text: [], structural: "first p" },
  };

  it("stores the headline's template on its shape, the same string the DOM side reads", () => {
    const out = attachInlineShapes(LAB, labManifest);
    expect(out["hero.headline"]?.inline?.split).toBe(true);
    expect(out["hero.headline"]?.inline?.template).toBe(TEMPLATE);
    // four bolds: an emphasis shape, no template
    expect(out["hero.body"]?.inline?.template).toBeUndefined();
    expect(out["hero.body"]?.inline?.emphasis).toBe(4);
  });

  it("counts the headline's length with one alternative of the rotating slot, not all four", () => {
    const { manifest: out, changed } = refreshLengths(LAB, labManifest);
    const seen = "Your visitors already arrive through AI tools. Choose what they can compare.";
    expect(changed).toContain("hero.headline");
    expect(out["hero.headline"]?.original_char_length).toBe(seen.length);
    expect(out["hero.headline"]?.original_word_count).toBe(seen.split(" ").length);
    expect(out["hero.headline"]?.text[0]).toBe(seen.slice(0, 40));
  });
});

describe("phase 2 kinds from the 2026-09-29 survey, on the HTML side", () => {
  const entry = (css: string) => ({ css: [css], text: [], structural: "" });
  const w = (t: string) => `<span style="display:inline-block">${t}</span>`;

  it("reads a word split nested in a styled wrapper as split, with its template", () => {
    const html = `<h1 id="a">${w("The")} ${w("support")} ${w("copilot")} <span class="framer-text dim">${w("that")} ${w("never")} ${w("sleeps.")}</span></h1>`;
    const m = attachInlineShapes(html, { "hero.headline": entry("#a") } as Manifest);
    expect(m["hero.headline"]?.inline?.split).toBe(true);
    expect(m["hero.headline"]?.inline?.template).toBe(
      "The support copilot {s1}that never sleeps.{/s1}",
    );
  });

  it("skips the page's hidden measuring copy", () => {
    const html = `<h1 id="a"><div><div aria-hidden="true" style="position:absolute;visibility:hidden"><span>Framer websites</span><span>that nobody</span></div>${w("Framer")} ${w("websites")} ${w("that")} ${w("nobody")} ${w("ignores")}</div></h1>`;
    const m = attachInlineShapes(html, { "hero.headline": entry("#a") } as Manifest);
    expect(m["hero.headline"]?.inline?.template).toBe("Framer websites that nobody ignores");
  });

  it("keeps the picker's changes-by-itself flag when the shape is read again", () => {
    const html = `<h1 id="a">Plain words</h1>`;
    const m = attachInlineShapes(html, {
      "hero.headline": {
        ...entry("#a"),
        inline: { icons: "none", emphasis: 0, split: false, animated_text: true },
      },
    } as Manifest);
    expect(m["hero.headline"]?.inline?.animated_text).toBe(true);
  });
});

describe("phase 3 kinds on the HTML side (docs/specs/interactive-text.md §3.2)", () => {
  const entry = (css: string) => ({ css: [css], text: [], structural: "" });
  const FROM = "display:inline-block;opacity:0.001;filter:blur(10px)";
  const letters = (word: string) =>
    `<span style="white-space:nowrap">${Array.from(word)
      .map((c) => `<span style="${FROM}">${c}</span>`)
      .join("")}</span>`;

  it("reads Framer's letters as a template of words, marked as letters", () => {
    const html = `<h1 id="a">${["The", "Smartest", "Way", "to", "Bring", "ROI."].map(letters).join(" ")}</h1>`;
    const m = attachInlineShapes(html, { "hero.headline": entry("#a") } as Manifest);
    expect(m["hero.headline"]?.inline?.template).toBe("The Smartest Way to Bring ROI.");
    expect(m["hero.headline"]?.inline?.letters).toBe(true);
  });

  it("reads lines as lines, with no template, so the part is written as plain text", () => {
    const html = `<div id="a">${["We make furniture", "that's flexible, and", "playful, to fit"]
      .map(
        (l) =>
          `<div class="title-line-parent" style="overflow:hidden"><p class="title-line">${l}</p></div>`,
      )
      .join("")}</div>`;
    const m = attachInlineShapes(html, { "hero.headline": entry("#a") } as Manifest);
    expect(m["hero.headline"]?.inline?.lines).toBe(3);
    expect(m["hero.headline"]?.inline?.template).toBeUndefined();
  });

  it("keeps lines the picker saw after the page's script cut them", () => {
    const html = `<h1 id="a">Your visitors already arrive through AI tools.</h1>`;
    const m = attachInlineShapes(html, {
      "hero.headline": {
        ...entry("#a"),
        inline: { icons: "none", emphasis: 0, split: true, animated_text: false, lines: 3 },
      },
    } as Manifest);
    expect(m["hero.headline"]?.inline?.lines).toBe(3);
    expect(m["hero.headline"]?.inline?.split).toBe(true);
  });

  it("drops the template of text that changes by itself with no rotating slot (Framer's rotating letters)", () => {
    const html = `<h1 id="a">Turn traffic into <span style="display:inline-block">${letters("leads")}</span></h1>`;
    const m = attachInlineShapes(html, {
      "hero.headline": {
        ...entry("#a"),
        inline: { icons: "none", emphasis: 0, split: true, animated_text: true },
      },
    } as Manifest);
    expect(m["hero.headline"]?.inline?.template).toBeUndefined();
    expect(m["hero.headline"]?.inline?.animated_text).toBe(true);
  });
});

describe("refreshLengths counts what a visitor reads", () => {
  it("leaves out the page's measuring copy and joins lines with a space (the zoo's lines-fit)", () => {
    const html = `<h1 id="a"><div style="display:flex"><div aria-hidden="true" style="position:absolute;visibility:hidden"><span>Pages that know</span><span>why each visitor</span><span>came today</span></div>${[
      "Pages that know",
      "why each visitor",
      "came today",
    ]
      .map((l) => `<div style="overflow:hidden"><div style="white-space:nowrap">${l}</div></div>`)
      .join("")}</div></h1>`;
    const { manifest } = refreshLengths(html, {
      "hero.headline": { css: ["#a"], text: [], structural: "", original_char_length: 82 },
    } as Manifest);
    expect(manifest["hero.headline"]?.original_char_length).toBe(
      "Pages that know why each visitor came today".length,
    );
  });
});
