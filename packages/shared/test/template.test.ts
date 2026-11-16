/**
 * Template reading (docs/specs/template-writing.md §3.1, §4.1), on hand-built
 * trees. The lab page itself is read from both sides in the snippet and
 * generation tests.
 */
import { describe, expect, it } from "vitest";
import {
  type TplNode,
  parseTemplate,
  readTemplate,
  templateLength,
  templateText,
  templateViolations,
} from "../src/template.ts";

const t = (text: string): TplNode => ({ kind: "text", text });
const el = (tag: string, classes: string[], ...children: TplNode[]): TplNode => ({
  kind: "el",
  tag,
  classes,
  children,
});
const w = (word: string, ...extra: string[]) => el("span", ["w", ...extra], t(word));
const glyph = () => el("span", ["g", "w"], el("svg", []));

describe("readTemplate", () => {
  it("reads words, a glyph, a line break and a style group", () => {
    const tpl = readTemplate([
      w("Your", "dim"),
      t(" "),
      glyph(),
      w("visitors"),
      t(" "),
      w("already", "dim"),
      el("br", []),
      w("arrive", "dim"),
      t(" "),
      w("today"),
    ]);
    expect(tpl?.template).toBe(
      "{s1}Your{/s1} {g1}visitors {s1}already{/s1}{br}{s1}arrive{/s1} today",
    );
    expect(tpl).toMatchObject({ words: 5, glyphs: 1, breaks: 1, groups: ["dim"] });
  });

  it("reads a rotating slot with its alternatives and the punctuation after it", () => {
    const tpl = readTemplate([
      w("Now"),
      t(" "),
      w("choose"),
      t(" "),
      w("what"),
      t(" "),
      w("they"),
      t(" "),
      w("can"),
      t(" "),
      el(
        "span",
        ["w", "rot-wrap"],
        el("span", ["rot"], el("span", ["on"], t("read")), el("span", [], t("buy"))),
        t("."),
      ),
    ]);
    expect(tpl?.template).toBe("Now choose what they can {rot:read|buy}.");
    expect(tpl?.rotator).toEqual(["read", "buy"]);
    expect(tpl?.words).toBe(5);
  });

  it("makes a wrapper with two or more word elements and a class of its own a group", () => {
    const tpl = readTemplate([
      w("One"),
      t(" "),
      w("two"),
      el("br", []),
      el("span", ["muted"], w("three"), t(" "), w("four"), t(" "), w("five")),
    ]);
    expect(tpl?.template).toBe("One two{br}{s1}three four five{/s1}");
    expect(tpl?.groups).toEqual(["muted"]);
  });

  it("closes a group before a glyph", () => {
    const tpl = readTemplate([
      w("one", "dim"),
      t(" "),
      glyph(),
      w("two", "dim"),
      t(" "),
      w("three"),
      t(" "),
      w("four"),
      t(" "),
      w("five"),
    ]);
    expect(tpl?.template).toBe("{s1}one{/s1} {g1}{s1}two{/s1} three four five");
  });

  it("returns null for fewer than five word elements", () => {
    expect(readTemplate([w("One"), t(" "), w("two"), t(" "), w("three")])).toBeNull();
  });

  it("returns null for one element per letter", () => {
    const letters = "Welcome".split("").map((c) => el("span", ["c"], t(c)));
    expect(readTemplate(letters)).toBeNull();
  });

  it("reads siblings without a state class as a group of words, not a rotating slot", () => {
    const tpl = readTemplate([
      el("span", ["rot"], w("read"), w("buy")),
      t(" "),
      w("three"),
      t(" "),
      w("four"),
      t(" "),
      w("five"),
    ]);
    expect(tpl?.rotator).toBeUndefined();
    expect(tpl?.template).toBe("{s1}readbuy{/s1} three four five");
  });

  it("keeps token characters out of the words", () => {
    const tpl = readTemplate([
      w("{one}"),
      t(" "),
      w("two|three"),
      t(" "),
      w("four"),
      t(" "),
      w("five"),
      t(" "),
      w("six"),
    ]);
    expect(tpl?.template).toBe("one twothree four five six");
  });
});

describe("parseTemplate, templateText, templateLength", () => {
  const LAB =
    "{s1}Your{/s1} {g1}visitors {s1}already{/s1}{br}{s1}arrive through{/s1} {g2}AI tools.{br}{s2}Choose what they can {rot:read|compare|buy|skip}.{/s2}";

  it("tokenizes every kind of token in order", () => {
    const kinds = parseTemplate(LAB).map((tok) => tok.t);
    expect(kinds.filter((k) => k === "glyph")).toHaveLength(2);
    expect(kinds.filter((k) => k === "br")).toHaveLength(2);
    expect(kinds.filter((k) => k === "rot")).toHaveLength(1);
    expect(kinds.filter((k) => k === "open")).toHaveLength(4);
    expect(kinds.filter((k) => k === "close")).toHaveLength(4);
    const rot = parseTemplate(LAB).find((tok) => tok.t === "rot");
    expect(rot).toEqual({ t: "rot", alts: ["read", "compare", "buy", "skip"] });
  });

  it("reads the lines a visitor sees, with the rotating slot's longest alternative", () => {
    expect(templateText(LAB)).toBe(
      "Your visitors already\narrive through AI tools.\nChoose what they can compare.",
    );
  });

  it("counts one alternative, not all four", () => {
    const seen = "Your visitors already arrive through AI tools. Choose what they can compare.";
    expect(templateLength(LAB)).toBe(seen.length);
    const allFour =
      "Your visitors already arrive through AI tools. Choose what they can readcomparebuyskip.";
    expect(templateLength(LAB)).toBeLessThan(allFour.length);
  });
});

describe("templateBlanks, templateAllWords", () => {
  const LAB =
    "{s1}Your{/s1} {g1}visitors {s1}already{/s1}{br}{s1}arrive through{/s1} {g2}AI tools.{br}{s2}Choose what they can {rot:read|compare|buy|skip}.{/s2}";

  it("blanks every word and keeps tokens, punctuation and the rotator's size", async () => {
    const { templateBlanks } = await import("../src/template.ts");
    expect(templateBlanks(LAB)).toBe(
      "{s1}_{/s1} {g1}_ {s1}_{/s1}{br}{s1}_ _{/s1} {g2}_ _.{br}{s2}_ _ _ _ {rot:_|_|_|_}.{/s2}",
    );
    expect(templateBlanks("Only $12/mo, (really).")).toBe("_ $_, (_).");
  });

  it("holds every word, each rotating alternative included", async () => {
    const { templateAllWords } = await import("../src/template.ts");
    expect(templateAllWords(LAB)).toBe(
      "yourvisitorsalreadyarrivethroughaitoolschoosewhattheycanreadcomparebuyskip",
    );
  });
});

describe("templateViolations (docs/specs/template-writing.md §3.2)", () => {
  const PAGE =
    "{s1}Your{/s1} {g1}visitors {s1}already{/s1}{br}{s1}arrive through{/s1} {g2}AI tools.{br}{s2}Choose what they can {rot:read|compare|buy|skip}.{/s2}";
  const SAME =
    "{s1}Your{/s1} {g1}buyers {s1}today{/s1}{br}{s1}come from{/s1} {g2}AI search.{br}{s2}Decide what they may {rot:see|test|order|keep}.{/s2}";
  const rules = (v: string) => templateViolations(PAGE, v).map((x) => x.rule);

  it("accepts the same structure with other words, and runs of another length", () => {
    expect(templateViolations(PAGE, SAME)).toEqual([]);
    expect(
      templateViolations(
        PAGE,
        "{s1}All{/s1} {g1}curious visitors {s1}now{/s1}{br}{s1}arrive{/s1} {g2}from AI answers.{br}{s2}Show them what you {rot:do|fix|ship|charge}.{/s2}",
      ),
    ).toEqual([]);
  });

  it("names each break of the structure", () => {
    expect(rules(SAME.replace("{g1}", ""))).toEqual(["template-glyphs"]);
    expect(rules(SAME.replace("{g1}", "{g2}").replace("{g2}AI", "{g1}AI"))).toEqual([
      "template-glyphs",
    ]);
    expect(rules(SAME.replace("{br}", " "))).toEqual(["template-lines"]);
    expect(rules(SAME.replace("{rot:see|test|order|keep}", "{rot:see|test|order}"))).toEqual([
      "template-rotator",
    ]);
    expect(rules(SAME.replace("see|test", "see|comprehensively"))).toEqual(["template-rotator"]);
    expect(rules(SAME.replace("{s2}", "").replace("{/s2}", ""))).toEqual(["template-groups"]);
    expect(rules(SAME.replace("{/s1} {g1}buyers", "{/s1} {g1}"))).toEqual(["template-words"]);
    expect(rules(SAME.replace("buyers", "*buyers*"))).toEqual(["template-markers"]);
    expect(rules(SAME.replace("buyers", "_"))).toEqual(["template-markers"]);
    expect(rules(SAME.replace("see|test", "_|test"))).toEqual(["template-markers"]);
    expect(rules(SAME.replace("keep}.{/s2}", "keep} works.{/s2}"))).toEqual(["template-words"]);
    expect(rules("A plain sentence with no tokens at all.")).toEqual([
      "template-glyphs",
      "template-lines",
      "template-rotator",
    ]);
  });

  it("tells the revise pass the page's shape with its words hidden", () => {
    const words = templateViolations(PAGE, SAME.replace("{/s1} {g1}buyers", "{/s1} {g1}"));
    expect(words[0]?.excerpt).toContain("{s1} … {/s1} {g1} … {s1} … {/s1} {br}");
    expect(words[0]?.excerpt).toContain("{rot×4} . {/s2}");
  });
});

describe("the operator's line for a part built word by word", () => {
  it("names what the page has and asks nothing", async () => {
    const { shapeLine, templateLine } = await import("../src/inline-shape.ts");
    const TPL =
      "{s1}Your{/s1} {g1}visitors {s1}already{/s1}{br}{s1}arrive through{/s1} {g2}AI tools.{br}{s2}Choose what they can {rot:read|compare|buy|skip}.{/s2}";
    expect(templateLine(TPL)).toBe(
      "Built word by word with 2 images, 3 lines and a rotating word. Versions keep all of it.",
    );
    const line = shapeLine({
      icons: "none",
      emphasis: 0,
      split: true,
      animated_text: true,
      template: TPL,
    });
    expect(line.ask).toBeUndefined();
    expect(line.text).toBe(templateLine(TPL));
    expect(templateLine("one two three four five")).toBe(
      "Built word by word. Versions keep all of it.",
    );
  });
});
