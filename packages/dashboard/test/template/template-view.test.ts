/**
 * The dashboard shows a template as words, never tokens
 * (docs/specs/template-writing.md §4.5), and the Look screen counts a part
 * built word by word as written.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Marked, unmarked } from "../../src/components/ui/Marked";
import { isTemplate, templateParts, templatePlain, writesPart } from "../../src/lib/template-view";

const TPL =
  "{s1}You{/s1} {g1}pay for traffic {s1}that{/s1}{br}{s1}lands on{/s1} {g2}one page.{br}{s2}Every visitor reads the {rot:same|wrong|old|flat} pitch.{/s2}";

describe("template view", () => {
  it("tells a template from plain or marked copy", () => {
    expect(isTemplate(TPL)).toBe(true);
    expect(isTemplate("We build *hand-made* products.")).toBe(false);
    expect(isTemplate("Plain words {not a token}.")).toBe(false);
  });

  it("parts: words, glyphs, breaks, styled runs and the rotating word", () => {
    const parts = templateParts(TPL);
    expect(parts.filter((p) => p.kind === "glyph")).toHaveLength(2);
    expect(parts.filter((p) => p.kind === "br")).toHaveLength(2);
    expect(parts.find((p) => p.kind === "rot")).toEqual({
      kind: "rot",
      alts: ["same", "wrong", "old", "flat"],
      styled: true,
    });
    expect(parts.find((p) => p.kind === "text" && p.text === "You")).toMatchObject({
      styled: true,
    });
    expect(
      parts.find((p) => p.kind === "text" && p.text.includes("pay for traffic")),
    ).toMatchObject({
      styled: false,
    });
  });

  it("gives titles and tooltips the plain words with the first alternative", () => {
    expect(templatePlain(TPL)).toBe(
      "You pay for traffic that lands on one page. Every visitor reads the same pitch.",
    );
    expect(unmarked(TPL)).toBe(templatePlain(TPL));
    expect(unmarked("We build *hand-made* products.")).toBe("We build hand-made products.");
  });

  it("renders no token, a <br> per line break, a ring per image, the rotating word with its alternatives", () => {
    const html = renderToStaticMarkup(createElement(Marked, { text: TPL }));
    expect(html).not.toMatch(/\{(br|g\d|\/?s\d|rot:)/);
    expect(html.match(/<br\/>/g)).toHaveLength(2);
    expect(html.match(/title="an image on your page"/g)).toHaveLength(2);
    expect(html).toContain('title="Rotates: same · wrong · old · flat"');
    expect(html).toContain(">same<");
  });

  it("still renders a marked phrase as emphasis", () => {
    const html = renderToStaticMarkup(
      createElement(Marked, { text: "We build *hand-made* products." }),
    );
    expect(html).toContain("<em");
    expect(html).toContain("hand-made");
    expect(html).not.toContain("*");
  });
});

describe("writesPart (the Look screen's count of parts left alone)", () => {
  it("writes a part built word by word, even when its rotating word made it look animated", () => {
    expect(writesPart({ inline: { split: true, animated_text: true, template: TPL } })).toBe(true);
    expect(writesPart({ inline: { split: true, template: TPL } })).toBe(true);
  });

  it("leaves the operator's choice, letter-split text and text that changes by itself", () => {
    expect(writesPart({ skip: true, inline: { split: true, template: TPL } })).toBe(false);
    expect(writesPart({ inline: { split: true } })).toBe(false);
    expect(writesPart({ inline: { split: true }, plain: true })).toBe(true);
    expect(writesPart({ inline: { animated_text: true } })).toBe(false);
    expect(writesPart({})).toBe(true);
  });
});
