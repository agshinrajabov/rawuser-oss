/**
 * The visitor's own choice, shared (docs/specs/direct-visitors.md §2): the
 * stored question's shape, what a browser gets (never the cells), the carry,
 * the anchor and the bundle's `qc`.
 */
import { describe, expect, it } from "vitest";
import {
  type ChoiceConfig,
  choiceAnchor,
  choiceCarry,
  choiceClient,
  choiceSlotOf,
  parseChoice,
} from "../src/choice.ts";
import { bundleDirectFields } from "../src/direct.ts";

const GOOD = {
  q: "What brings you here?",
  a: [
    ["a", "I'm a broker", "problem", "default"],
    ["b", "I run a PE fund", "evaluation", "default"],
    ["c", "I'm selling my company", "feature", "social"],
  ],
  s: ["a.cta"],
};

describe("parseChoice", () => {
  it("reads a good question", () => {
    expect(parseChoice(JSON.stringify(GOOD))).toEqual(GOOD);
  });
  it("refuses the wrong shapes", () => {
    for (const bad of [
      { ...GOOD, a: GOOD.a.slice(0, 1) },
      { ...GOOD, a: [...GOOD.a, ["d", "x", "brand", "default"], ["e", "y", "pricing", "default"]] },
      { ...GOOD, a: [["b", ...(GOOD.a[0] as string[]).slice(1)], ...GOOD.a.slice(1)] },
      { ...GOOD, a: [["a", "I'm a broker", "problem", "direct"], ...GOOD.a.slice(1)] },
      { ...GOOD, a: [["a", "I'm a broker", "problem", "mk-gb"], ...GOOD.a.slice(1)] },
      { ...GOOD, a: [GOOD.a[0], ["b", "Same cell", "problem", "default"]] },
      { ...GOOD, q: "x".repeat(61) },
      { ...GOOD, q: "Why are you here — really?" },
      { ...GOOD, a: [["a", "<b>bold</b>", "problem", "default"], ...GOOD.a.slice(1)] },
    ]) {
      expect(parseChoice(bad)).toBeNull();
    }
    // No main button: the bar needs none (2026-11-04).
    expect(parseChoice({ ...GOOD, s: [] })?.s).toEqual([]);
    expect(parseChoice("nope")).toBeNull();
  });
});

describe("what a browser gets", () => {
  it("the words and the anchor, never which version an answer opens", () => {
    const c = parseChoice(GOOD);
    const client = choiceClient(c as ChoiceConfig);
    expect(client).toEqual({
      t: "What brings you here?",
      a: [
        ["a", "I'm a broker"],
        ["b", "I run a PE fund"],
        ["c", "I'm selling my company"],
      ],
      s: ["a.cta"],
    });
    expect(JSON.stringify(client)).not.toMatch(/problem|evaluation|social|default/);
    expect(choiceClient(c as ChoiceConfig, true).p).toBe(1);
  });

  it("the carry is one word and back", () => {
    expect(choiceCarry("b")).toBe("qb:direct");
    expect(choiceSlotOf("qb:direct")).toBe("b");
    expect(choiceSlotOf("qe:direct")).toBeNull();
    expect(choiceSlotOf("qa:ai")).toBeNull();
    expect(choiceSlotOf(null)).toBeNull();
  });

  it("the anchor is the hero's button part", () => {
    expect(
      choiceAnchor({ "hero.headline": { css: ["h1"] }, "hero.cta.label": { css: ["a.cta", "a"] } }),
    ).toEqual(["a.cta", "a"]);
    expect(choiceAnchor({ "hero.headline": { css: ["h1"] } })).toBeNull();
    expect(choiceAnchor(null)).toBeNull();
  });
});

describe("the bundle's qc", () => {
  const yes = { special_category: 0, sensitive: 0, plan: "pilot", choice: JSON.stringify(GOOD) };
  it("only when on, not killed, allowed and well formed", () => {
    expect(bundleDirectFields({ ...yes, choice_on: 1 }).qc).toEqual(GOOD);
    expect(bundleDirectFields({ ...yes, choice_on: 0 })).not.toHaveProperty("qc");
    expect(bundleDirectFields({ ...yes, choice_on: 1, choice_killed: 1 })).not.toHaveProperty("qc");
    // A site marked sensitive may have the question alone (the founder's
    // call, 2026-11-04), never the other parts.
    expect(bundleDirectFields({ ...yes, choice_on: 1, sensitive: 1 })).toEqual({
      qc: parseChoice(GOOD),
    });
    expect(bundleDirectFields({ ...yes, special_category: 1, choice_on: 1, sensitive: 1 })).toEqual(
      { qc: parseChoice(GOOD) },
    );
    // An unmarked "yes" never.
    expect(bundleDirectFields({ ...yes, special_category: 1, choice_on: 1 })).toEqual({});
    expect(bundleDirectFields({ ...yes, choice_on: 1, choice: "{}" })).not.toHaveProperty("qc");
  });
});
