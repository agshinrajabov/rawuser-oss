import type { VariantBody } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import {
  allowedNumbersFor,
  allowedUnitsFor,
  collectNumbers,
  collectUnits,
  headlineSameness,
  lintVariant,
  normalizeForCompare,
} from "../src/lint/index.ts";

function body(sections: Record<string, Record<string, unknown>>): VariantBody {
  return {
    customer_id: "c",
    profile_key: "intent:brand",
    sections,
    generated_at: 1,
    prompt_hash: "",
  } as VariantBody;
}
const ALLOWED = collectNumbers(["40+ məhsul", "4 illik təcrübə", "iki həftə", "2 həftəlik sprint"]);

describe("lintVariant — hard rules", () => {
  it("flags a number the brief never gave, and accepts the brief's own numbers", () => {
    const r = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "Sprint qiyməti: 12.000 AZN, sabitdir",
          body: "40+ məhsul, 4 il.",
        },
      }),
      { language: "az", allowedNumbers: ALLOWED },
    );
    expect(r.hard.map((f) => f.rule)).toEqual(["number-not-in-brief"]);
    expect(r.hard[0]?.excerpt).toBe("12.000");
  });

  it("flags a brief number used with another unit (4 il in the brief, 4 həftə in the copy)", () => {
    const brief = ["4 illik təcrübə", "40+ məhsul buraxıb", "iki həftəlik sprint"];
    const ctx = {
      language: "az",
      allowedNumbers: collectNumbers(brief),
      allowedUnits: collectUnits(brief),
    };
    const bad = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "Sabit qiymət",
          body: "4 həftə ərzində go/no-go qərarı alırsınız.",
        },
      }),
      ctx,
    );
    expect(bad.hard.map((f) => f.rule)).toEqual(["number-unit-mismatch"]);
    const good = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "Sabit qiymət",
          body: "4 illik təcrübə, 40-dan çox məhsul.",
        },
      }),
      ctx,
    );
    expect(good.hard).toEqual([]);
    // "4 il" and "4 illik" agree; "40-dan çox məhsul" matches "40+ məhsul".
    const alsoGood = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "Dörd il",
          body: "4 il ərzində 40-dan çox tətbiq qurmuşuq, bəli.",
        },
      }),
      ctx,
    );
    expect(alsoGood.hard).toEqual([]);
  });

  it("flags Turkish markers in Azerbaijani copy", () => {
    const r = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "AI-ni harada tətbiq edəcəyinizi bilmiyor musunuz?",
          body: "Bu düşükdür.",
        },
      }),
      { language: "az", allowedNumbers: ALLOWED },
    );
    expect(r.hard.some((f) => f.rule === "turkish-in-az")).toBe(true);
  });

  it("does not mistake Azerbaijani's perfect tense or attached question particle for Turkish", () => {
    const r = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "Bunu eşitmisiniz?",
          body: "Yəqin ki artıq sınamısınız. Gəlirsinizmi?",
        },
      }),
      { language: "az", allowedNumbers: ALLOWED },
    );
    expect(r.hard.filter((f) => f.rule === "turkish-in-az")).toEqual([]);
  });

  it("flags the wrong script for the language", () => {
    const r = lintVariant(
      body({ hero: { kind: "hero", headline: "Создаём продукты с AI", body: "Şəhərdə studiya." } }),
      { language: "az", allowedNumbers: ALLOWED },
    );
    expect(r.hard.some((f) => f.rule === "wrong-script" && f.path === "hero.headline")).toBe(true);
    const ok = lintVariant(
      body({ hero: { kind: "hero", headline: "Создаём продукты с AI", body: "Студия в Баку." } }),
      { language: "ru", allowedNumbers: ALLOWED },
    );
    expect(ok.hard).toEqual([]);
  });
});

describe("lintVariant — soft rules", () => {
  it("catches the no-ai-slop patterns", () => {
    const r = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline:
            "Not just a studio, it's a partner? Or a team? And a vendor of seamless leverage for you today",
          body: "Nəticə: işləyən məhsul. Sürprizsiz. Sadə. Aydın. Biz qururuq – siz böyüyürsünüz.",
          cta: { label: "Start", href: "#x" },
        },
      }),
      { language: "az", allowedNumbers: ALLOWED },
    );
    const rules = r.soft.map((f) => f.rule);
    expect(rules).toContain("question-stack");
    expect(rules).toContain("headline-over-12-words");
    expect(rules).toContain("banned:seamless");
    expect(rules).toContain("banned:leverage");
    expect(rules).toContain("colon-reveal");
    expect(rules).toContain("fragments");
    expect(rules).toContain("dash");
    expect(rules).toContain("binary-contrast");
    expect(r.hard).toEqual([]);
  });

  it("is quiet on plain, specific copy", () => {
    const r = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "Agentlik yox, öz məhsullarını da quran komanda",
          body: "4 ildə 40+ məhsul buraxmışıq. Nümunə Bank və Şəhər Bank üçün Portal məhsulunu birlikdə qurduq.",
          cta: { label: "Fərqi görün", href: "#compare" },
        },
      }),
      { language: "az", allowedNumbers: ALLOWED },
    );
    expect(r.hard).toEqual([]);
    expect(r.soft).toEqual([]);
  });

  it("ignores kind and href fields", () => {
    const r = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "Salam",
          body: "Salam dünya, necəsiniz bu gün.",
          cta: { label: "Go", href: "#12345" },
        },
      }),
      { language: "az", allowedNumbers: new Set() },
    );
    expect(r.hard).toEqual([]);
  });
});

describe("helpers", () => {
  it("collects numbers with separators stripped", () => {
    expect([...collectNumbers(["12.000 AZN", "40+ məhsul", "1,500 users"])].sort()).toEqual([
      "12000",
      "1500",
      "40",
    ]);
  });

  it("allowedNumbersFor reads every brief field, hints and samples", () => {
    const set = allowedNumbersFor(
      {
        product: "6-month course",
        icp: "",
        target_market: "",
        value_props: ["2 weeks"],
        differentiators: [],
        proof_points: ["400+ designers"],
        per_intent_hints: { pricing: "1200 AZN" },
      },
      ["Since 2020"],
    );
    expect([...set].sort()).toEqual(["1200", "2", "2020", "400", "6"]);
  });

  it("allowedUnitsFor collects the stems after each number", () => {
    const u = allowedUnitsFor({
      product: "",
      icp: "",
      target_market: "",
      value_props: [],
      differentiators: [],
      proof_points: ["4 illik təcrübə", "400+ dizayner hazırlayıb"],
    });
    expect([...(u.get("4") ?? [])]).toContain("il");
    expect([...(u.get("400") ?? [])]).toContain("di");
  });

  it("headlineSameness is 0 for different lines and 1 for copies", () => {
    expect(headlineSameness(["a b c d", "e f g h"])).toBe(0);
    expect(headlineSameness(["we build ai products fast", "we build ai products fast"])).toBe(1);
  });
});

describe("lintVariant — distinct slots (design-preserving-rewrite §2)", () => {
  const ctx = { language: "en", allowedNumbers: ALLOWED };

  it("hard-flags a section headline that repeats the hero headline", () => {
    const r = lintVariant(
      body({
        hero: { kind: "hero", headline: "AI and UX under one roof", body: "We build products." },
        features: {
          kind: "features",
          headline: "AI and UX under one roof",
          body: "Seven services in one studio.",
        },
      }),
      ctx,
    );
    expect(r.hard.map((f) => f.rule)).toEqual(["slot-duplicate:hero.headline"]);
    expect(r.hard[0]?.path).toBe("features.headline");
  });

  it("treats punctuation and case as the same text", () => {
    const r = lintVariant(
      body({
        hero: { kind: "hero", headline: "Fixed fee. Two weeks." },
        features: { kind: "features", headline: "fixed fee, two weeks" },
      }),
      ctx,
    );
    expect(r.hard.map((f) => f.rule)).toEqual(["slot-duplicate:hero.headline"]);
  });

  it("two buttons with one label is soft, not hard", () => {
    const r = lintVariant(
      body({
        hero: { kind: "hero", headline: "One", cta: { label: "Start a sprint" } },
        cta: { kind: "cta", cta: { label: "Start a sprint" } },
      }),
      ctx,
    );
    expect(r.hard).toEqual([]);
    expect(r.soft.map((f) => f.rule)).toEqual(["cta-same-label:hero.cta.label"]);
  });

  it("hard-flags a lead sentence reused in another paragraph", () => {
    const r = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "One",
          body: "We open with the one thing your last vendor never asked. Then we build.",
        },
        features: {
          kind: "features",
          headline: "Two",
          body: "We open with the one thing your last vendor never asked, and we keep few clients.",
        },
      }),
      ctx,
    );
    expect(r.hard.map((f) => f.rule)).toEqual(["sentence-reuse:hero.body"]);
    expect(r.hard[0]?.path).toBe("features.body");
  });

  it("ignores short labels and is quiet when every part has its own words", () => {
    const r = lintVariant(
      body({
        hero: { kind: "hero", headline: "Go", body: "We build products.", cta: { label: "Go" } },
        features: { kind: "features", headline: "What we do", body: "Seven services." },
        cta: { kind: "cta", cta: { label: "Go" } },
      }),
      ctx,
    );
    expect(r.hard).toEqual([]);
    expect(r.soft.filter((f) => f.rule.startsWith("cta-same"))).toEqual([]);
  });

  it("normalizeForCompare folds case, punctuation and spacing", () => {
    expect(normalizeForCompare("  Fixed fee.  Two weeks! ")).toBe("fixed fee two weeks");
  });
});

describe("lintVariant — emphasis markers (design-preserving-rewrite §2)", () => {
  const ctx = {
    language: "en",
    allowedNumbers: ALLOWED,
    emphasisSlots: new Set(["hero.headline"]),
  };

  it("accepts one marked phrase where the page emphasises one", () => {
    const r = lintVariant(
      body({ hero: { kind: "hero", headline: "Compare us *before you commit*." } }),
      ctx,
    );
    expect(r.hard).toEqual([]);
    expect(r.soft.filter((f) => f.rule.startsWith("emphasis"))).toEqual([]);
  });

  it("is soft when the marked phrase is missing, hard when there are two or the slot has no emphasis", () => {
    const missing = lintVariant(
      body({ hero: { kind: "hero", headline: "Compare us first." } }),
      ctx,
    );
    expect(missing.soft.map((f) => f.rule)).toContain("emphasis-missing");
    const two = lintVariant(
      body({ hero: { kind: "hero", headline: "*Compare* us *before you commit*." } }),
      ctx,
    );
    expect(two.hard.map((f) => f.rule)).toEqual(["emphasis-count"]);
    const stray = lintVariant(
      body({ hero: { kind: "hero", headline: "Plain", body: "Some *marked words* here." } }),
      ctx,
    );
    expect(stray.hard.map((f) => f.rule)).toEqual(["emphasis-unexpected"]);
  });

  it("an unbalanced asterisk is hard", () => {
    const r = lintVariant(body({ hero: { kind: "hero", headline: "Compare *us first." } }), ctx);
    expect(r.hard.map((f) => f.rule)).toEqual(["emphasis-unbalanced"]);
  });
});

describe("lintVariant — length drift (taskboard-test 2026-09-14)", () => {
  const ctx = {
    language: "en",
    allowedNumbers: ALLOWED,
    originalLengths: new Map([
      ["hero.headline", 31],
      ["hero.body", 140],
      ["hero.cta.label", 16],
    ]),
  };

  it("soft-flags a headline under 60% of the original's length, with the range in the excerpt", () => {
    const r = lintVariant(body({ hero: { kind: "hero", headline: "Plan your day." } }), ctx);
    const f = r.soft.find((x) => x.rule === "length-drift");
    expect(f?.path).toBe("hero.headline");
    expect(f?.excerpt).toBe("14 characters; the original has 31, write 29 to 33");
  });

  it("is quiet at 75% and above and for short originals", () => {
    const r = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "Your week, planned by an AI.",
          cta: { label: "Go" },
        },
      }),
      ctx,
    );
    expect(r.soft.filter((x) => x.rule === "length-drift")).toEqual([]);
  });

  it("caps a headline's base at 1.05x and its alt at 1.15x", () => {
    const over = lintVariant(
      body({ hero: { kind: "hero", headline: "Fintech üçün AI-əsaslı tətbiq studiyası." } }),
      ctx,
    );
    expect(over.soft.find((x) => x.rule === "length-drift")?.excerpt).toBe(
      "40 characters; the original has 31, write at most 33",
    );
    const far = lintVariant(body({ hero: { kind: "hero", headline: "x".repeat(45) } }), ctx);
    expect(far.hard.find((x) => x.rule === "length-drift")?.excerpt).toBe(
      "45 characters; the original has 31, write at most 33",
    );
    const alt = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "AI-əsaslı məhsul studiyası.",
          headline_alt: "x".repeat(42),
        },
      }),
      ctx,
    );
    const f = alt.soft.find((x) => x.rule === "length-drift");
    expect(f?.path).toBe("hero.headline_alt");
    expect(f?.excerpt).toBe("42 characters; the original has 31, write 33 to 36");
    const fine = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "AI-əsaslı məhsul studiyası.",
          headline_alt: "x".repeat(35),
        },
      }),
      ctx,
    );
    expect(fine.soft.filter((x) => x.rule === "length-drift")).toEqual([]);
  });

  it("holds a paragraph's second length to 75 to 90% (0031) and wants it shorter than the first", () => {
    const long = lintVariant(
      body({ hero: { kind: "hero", body: "x".repeat(140), body_alt: "y".repeat(150) } }),
      ctx,
    );
    const rules = long.soft.filter((x) => x.path === "hero.body_alt").map((x) => x.rule);
    expect(rules).toContain("length-drift");
    expect(rules).toContain("alt-not-shorter");
    expect(
      long.soft.find((x) => x.path === "hero.body_alt" && x.rule === "length-drift")?.excerpt,
    ).toBe("150 characters; the original has 140, write 105 to 126");
    const fine = lintVariant(
      body({ hero: { kind: "hero", body: "x".repeat(150), body_alt: "y".repeat(120) } }),
      ctx,
    );
    expect(fine.soft.filter((x) => x.path === "hero.body_alt")).toEqual([]);
  });

  it("soft-flags a paragraph when no length is at or under the original (soft since 2026-09-16), and is quiet when one is", () => {
    const both = lintVariant(
      body({ hero: { kind: "hero", body: "x".repeat(150), body_alt: "y".repeat(145) } }),
      ctx,
    );
    const f = both.soft.find((x) => x.rule === "paragraph-over-original");
    expect(both.hard.filter((x) => x.rule === "paragraph-over-original")).toEqual([]);
    expect(f?.path).toBe("hero.body_alt");
    expect(f?.excerpt).toBe(
      "150 and 145 characters against the original's 140; write hero.body_alt with at most 140",
    );
    const noAlt = lintVariant(body({ hero: { kind: "hero", body: "x".repeat(150) } }), ctx);
    expect(noAlt.soft.find((x) => x.rule === "paragraph-over-original")?.excerpt).toBe(
      "150 characters against the original's 140; write hero.body_alt with at most 140",
    );
    const altUnder = lintVariant(
      body({ hero: { kind: "hero", body: "x".repeat(150), body_alt: "y".repeat(138) } }),
      ctx,
    );
    expect(altUnder.soft.filter((x) => x.rule === "paragraph-over-original")).toEqual([]);
    const baseUnder = lintVariant(body({ hero: { kind: "hero", body: "x".repeat(130) } }), ctx);
    expect(baseUnder.soft.filter((x) => x.rule === "paragraph-over-original")).toEqual([]);
  });

  it("one or two characters over a label's cap stay soft; more is hard", () => {
    const near = lintVariant(body({ hero: { kind: "hero", cta: { label: "Layihəni başla" } } }), {
      ...ctx,
      originalLengths: new Map([["hero.cta.label", 7]]),
    });
    expect(near.hard.filter((x) => x.rule === "length-drift")).toEqual([]);
    expect(near.soft.find((x) => x.rule === "length-drift")?.excerpt).toBe(
      "14 characters; the original has 7, write at most 12",
    );
  });

  it("wants the two lengths to bracket the original: both paragraph lengths under, or both headline lengths over, is a soft flag", () => {
    const under = lintVariant(
      body({ hero: { kind: "hero", body: "x".repeat(120), body_alt: "y".repeat(100) } }),
      ctx,
    );
    expect(under.soft.find((x) => x.rule === "bracket-missing")?.excerpt).toBe(
      "120 and 100 characters, all under the original's 140; write hero.body_alt2 at 147 to 161",
    );
    const bracketed = lintVariant(
      body({
        hero: {
          kind: "hero",
          body: "x".repeat(120),
          body_alt: "y".repeat(100),
          body_alt2: "z".repeat(150),
        },
      }),
      ctx,
    );
    expect(bracketed.soft.filter((x) => x.rule === "bracket-missing")).toEqual([]);
    expect(bracketed.soft.filter((x) => x.rule === "paragraph-over-original")).toEqual([]);
    const over = lintVariant(
      body({ hero: { kind: "hero", headline: "x".repeat(33), headline_alt: "y".repeat(38) } }),
      ctx,
    );
    expect(over.soft.find((x) => x.rule === "bracket-missing")?.excerpt).toBe(
      "33 and 38 characters, all over the original's 31; write hero.headline_alt2 at 22 to 26",
    );
    const third = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "x".repeat(33),
          headline_alt: "y".repeat(38),
          headline_alt2: "z".repeat(26),
        },
      }),
      ctx,
    );
    expect(third.soft.filter((x) => x.rule === "bracket-missing")).toEqual([]);
    const wrongWay = lintVariant(
      body({ hero: { kind: "hero", headline: "x".repeat(29), headline_alt2: "z".repeat(31) } }),
      ctx,
    );
    expect(wrongWay.soft.find((x) => x.rule === "alt2-not-shorter")?.excerpt).toBe(
      "31 characters against 29; write fewer than 29",
    );
    const fine = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "x".repeat(29),
          headline_alt: "y".repeat(38),
          body: "x".repeat(150),
          body_alt: "y".repeat(120),
        },
      }),
      ctx,
    );
    expect(fine.soft.filter((x) => x.rule === "bracket-missing")).toEqual([]);
  });

  it("soft-flags a second or third length that copies another word for word, with its own range (2026-09-16)", () => {
    const r = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "Two practices. *One studio.*",
          headline_alt: "Two practices in one studio, side by side.",
          headline_alt2: "*Two practices.* One studio.",
          body: "x".repeat(140),
          body_alt: "x".repeat(140),
          body_alt2: "y".repeat(150),
        },
      }),
      ctx,
    );
    const copies = r.soft.filter((x) => x.rule === "alt-copies");
    expect(copies.map((x) => x.path)).toEqual(["hero.headline_alt2", "hero.body_alt"]);
    expect(copies[0]?.excerpt).toBe(
      "the same text as hero.headline; write the same idea in other words at 22 to 26 characters",
    );
    expect(copies[1]?.excerpt).toBe(
      "the same text as hero.body; write the same idea in other words at 105 to 126 characters",
    );
    const distinct = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "x".repeat(30),
          headline_alt: "y".repeat(33),
          headline_alt2: "z".repeat(27),
        },
      }),
      ctx,
    );
    expect(distinct.soft.filter((x) => x.rule === "alt-copies")).toEqual([]);
  });

  it("caps a short label at 12, so a seven-character button cannot come back as twenty on a phone", () => {
    const r = lintVariant(body({ hero: { kind: "hero", cta: { label: "Layihənizi danışaq" } } }), {
      ...ctx,
      originalLengths: new Map([["hero.cta.label", 7]]),
    });
    expect(r.hard.find((x) => x.rule === "length-drift")?.excerpt).toBe(
      "18 characters; the original has 7, write at most 12",
    );
  });

  it("flags a button label over the cap (1.25x, never under 12), so a five-character button cannot come back as twenty-six", () => {
    const r = lintVariant(
      body({ hero: { kind: "hero", cta: { label: "Gəlin layihənizi müzakirə edək" } } }),
      ctx,
    );
    const f = r.hard.find((x) => x.rule === "length-drift");
    expect(f?.path).toBe("hero.cta.label");
    expect(f?.excerpt).toBe("30 characters; the original has 16, write at most 20");
    const ok = lintVariant(
      body({ hero: { kind: "hero", cta: { label: "Layihəni başlat" } } }),
      ctx,
    );
    expect(ok.hard.filter((x) => x.rule === "length-drift")).toEqual([]);
  });

  it("flags a paragraph under 90% or over 110% of the original (hard over 120%), with the 95 to 105 range", () => {
    const short = lintVariant(body({ hero: { kind: "hero", body: "Short." } }), ctx);
    const f = short.soft.find((x) => x.rule === "length-drift");
    expect(f?.path).toBe("hero.body");
    expect(f?.excerpt).toBe("6 characters; the original has 140, write 133 to 147");
    const long = lintVariant(body({ hero: { kind: "hero", body: "x".repeat(180) } }), ctx);
    expect(long.hard.find((x) => x.rule === "length-drift")?.path).toBe("hero.body");
  });

  it("is quiet for a paragraph inside the window and for a short original paragraph", () => {
    const ok = lintVariant(body({ hero: { kind: "hero", body: "x".repeat(130) } }), ctx);
    expect(ok.soft.filter((x) => x.rule === "length-drift")).toEqual([]);
    const tiny = lintVariant(body({ hero: { kind: "hero", body: "a" } }), {
      ...ctx,
      originalLengths: new Map([["hero.body", 30]]),
    });
    expect(tiny.soft.filter((x) => x.rule === "length-drift")).toEqual([]);
  });

  it("ignores emphasis markers when measuring", () => {
    const r = lintVariant(
      body({ hero: { kind: "hero", headline: "Your *week*, planned by AI." } }),
      ctx,
    );
    expect(r.soft.filter((x) => x.rule === "length-drift")).toEqual([]);
  });
});

describe("lintVariant — same as the original (taskboard-test 2026-09-14)", () => {
  const ctx = {
    language: "en",
    allowedNumbers: ALLOWED,
    originalTexts: new Map([
      ["hero.headline", "Get your week back, every week"],
      ["hero.cta.label", "Start free trial"],
      ["hero.body", "TaskBoard plans your day around your energy"],
    ]),
  };

  it("soft-flags a headline or button that repeats the page word for word", () => {
    const r = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "Get your *week* back, every week!",
          cta: { label: "start free trial" },
        },
      }),
      ctx,
    );
    expect(r.soft.filter((f) => f.rule === "same-as-original").map((f) => f.path)).toEqual([
      "hero.headline",
      "hero.cta.label",
    ]);
  });

  it("is quiet for paragraphs and for a rewritten headline", () => {
    const r = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "Your week, planned around your energy",
          body: "TaskBoard plans your day around your energy",
        },
      }),
      ctx,
    );
    expect(r.soft.filter((f) => f.rule === "same-as-original")).toEqual([]);
  });
});

describe("collectUnits and a slash", () => {
  it("reads $12/mo as the unit mo, so a price the brief states passes", () => {
    const units = collectUnits(["Free for 3 active projects, Pro is $12/mo", "12 Pro seats"]);
    expect(units.get("12")).toContain("mo");
    expect(units.get("12")).toContain("pr");
    const r = lintVariant(
      body({ hero: { kind: "hero", headline: "Pro is $12/mo", body: "Free for 3 projects." } }),
      {
        language: "en",
        allowedNumbers: collectNumbers(["Pro is $12/mo", "3 active projects"]),
        allowedUnits: units,
      },
    );
    expect(r.hard).toEqual([]);
  });
});

describe("collectUnits and a sentence end", () => {
  it("never reads the next sentence's words as a price's unit", () => {
    // Numbers are keyed without their separators: 0.45 is "45".
    // The price keeps its currency and nothing from the next sentence.
    expect([...(collectUnits(["Pay $0.45. Choose what they can read."]).get("45") ?? [])]).toEqual([
      "¤",
    ]);
    const brief = ["$0.45 per generated version"];
    const r = lintVariant(
      body({
        hero: { kind: "hero", headline: "Each version costs $0.45. Choose what they can read." },
      }),
      {
        language: "en",
        allowedNumbers: collectNumbers(brief),
        allowedUnits: collectUnits(brief),
      },
    );
    expect(r.hard.filter((f) => f.rule === "number-unit-mismatch")).toEqual([]);
    expect(collectUnits(["4.5 weeks"]).get("45")).toContain("we");
  });
});

describe("lintVariant — two lengths (headline_alt)", () => {
  const ctx = {
    language: "en",
    allowedNumbers: ALLOWED,
    emphasisSlots: new Set(["hero.headline"]),
  };

  it("does not treat a headline and its alt as duplicates, and wants the alt longer", () => {
    const r = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "Your week, planned around your energy",
          headline_alt: "Your week, planned around your energy",
        },
      }),
      ctx,
    );
    expect(r.hard.filter((f) => f.rule.startsWith("slot-duplicate"))).toEqual([]);
    expect(r.soft.map((f) => f.rule)).toContain("alt-not-longer");
  });

  it("the alt shares the base slot's emphasis expectation", () => {
    const r = lintVariant(
      body({
        hero: {
          kind: "hero",
          headline: "Your *week*, planned",
          headline_alt: "Your *whole week*, planned around your energy",
        },
      }),
      ctx,
    );
    expect(r.hard.filter((f) => f.rule.startsWith("emphasis"))).toEqual([]);
  });
});

describe("lintVariant — wrong language in the same script", () => {
  it("hard-flags an Azerbaijani sentence in an English version, and stays quiet for Azerbaijani briefs", () => {
    const en = lintVariant(
      body({
        hero: { kind: "hero", headline: "AI layihəniz harada ilişib?", body: "Plain English." },
      }),
      { language: "en", allowedNumbers: ALLOWED },
    );
    expect(en.hard.map((f) => f.rule)).toEqual(["wrong-language"]);
    expect(en.hard[0]?.path).toBe("hero.headline");
    const az = lintVariant(
      body({ hero: { kind: "hero", headline: "AI layihəniz harada ilişib?" } }),
      { language: "az", allowedNumbers: ALLOWED },
    );
    expect(az.hard.filter((f) => f.rule === "wrong-language")).toEqual([]);
  });
});

describe("number-unit-mismatch fires only for measurement units", () => {
  it("lets the same number stand with another noun, still catches a swapped time or money unit", () => {
    const brief = ["A regional lender: 11-person team", "17-month plan delivered in 11", "$12/mo"];
    const ctx = {
      language: "en",
      allowedNumbers: collectNumbers(brief),
      allowedUnits: collectUnits(brief),
    };
    const noun = lintVariant(
      body({ hero: { kind: "hero", headline: "Delivered in 11 months by one team" } }),
      ctx,
    );
    expect(noun.hard.filter((f) => f.rule === "number-unit-mismatch")).toEqual([]);
    const money = lintVariant(
      body({ hero: { kind: "hero", headline: "12 projects a year" } }),
      ctx,
    );
    // The brief's 12 is a price: written without its currency it is caught first.
    expect(money.hard.map((f) => f.rule)).toContain("currency-missing");
  });
});

describe('currency-missing (the lab run, 2026-09-28: "0.45 to generate")', () => {
  const brief = ["About $0.45 to generate thirty versions", "Lumera costs 800 manat"];
  const ctx = {
    language: "en",
    allowedNumbers: collectNumbers(brief),
    allowedUnits: collectUnits(brief),
  };
  const rules = (headline: string) =>
    lintVariant(body({ hero: { kind: "hero", headline } }), ctx).hard.map((f) => f.rule);

  it("fails a price the brief gives with a currency and the copy writes without one", () => {
    expect(rules("Thirty versions cost about 0.45 to generate")).toContain("currency-missing");
    expect(rules("The course is 800 for the term")).toContain("currency-missing");
  });

  it("passes the price with its currency, whatever words follow it", () => {
    expect(rules("Thirty versions cost about $0.45.")).toEqual([]);
    expect(rules("$0.45 buys thirty versions")).toEqual([]);
    expect(rules("The course costs 800 manat")).toEqual([]);
    expect(rules("The course costs ₼800")).toEqual([]);
  });
});

describe("lintVariant — templates (docs/specs/template-writing.md §3.2, §4.2)", () => {
  const PAGE =
    "{s1}Your{/s1} {g1}visitors {s1}already{/s1}{br}{s1}arrive through{/s1} {g2}AI tools.{br}{s2}Choose what they can {rot:read|compare|buy|skip}.{/s2}";
  const SAME =
    "{s1}Your{/s1} {g1}buyers {s1}today{/s1}{br}{s1}come from{/s1} {g2}AI search.{br}{s2}Decide what they may {rot:see|test|order|keep}.{/s2}";
  const ctx = {
    language: "en",
    allowedNumbers: collectNumbers(["no numbers here"]),
    // the page's visible length (templateLength of PAGE)
    originalLengths: new Map([["hero.headline", 76]]),
    templates: new Map([["hero.headline", PAGE]]),
  };
  const hardRules = (headline: string, extra: Record<string, unknown> = {}) =>
    lintVariant(body({ hero: { kind: "hero", headline, ...extra } }), ctx).hard.map((f) => f.rule);

  it("never reads a token's digit as a number the brief never gave", () => {
    const r = lintVariant(body({ hero: { kind: "hero", headline: SAME } }), ctx);
    expect(r.hard.filter((f) => f.rule === "number-not-in-brief")).toEqual([]);
    expect(r.hard).toEqual([]);
  });

  it("measures a template by the words a visitor sees, not by its tokens", () => {
    // SAME is 18 characters of tokens longer than its words; the words fit.
    const r = lintVariant(body({ hero: { kind: "hero", headline: SAME } }), ctx);
    expect(r.hard.filter((f) => f.rule === "length-drift")).toEqual([]);
  });

  it("fails a version that breaks the page's structure, on the base and on its other lengths", () => {
    expect(hardRules(SAME.replace("{g1}", ""))).toContain("template-glyphs");
    expect(hardRules(SAME.replace("{br}", " "))).toContain("template-lines");
    expect(
      hardRules(SAME, { headline_alt: SAME.replace("see|test|order|keep", "see|test") }),
    ).toContain("template-rotator");
    expect(hardRules("Your buyers came from AI search and decided.")).toEqual(
      expect.arrayContaining(["template-glyphs", "template-lines", "template-rotator"]),
    );
  });

  it("gives the revise pass the page's structure with its words blank, never the page's words", () => {
    const r = lintVariant(
      body({ hero: { kind: "hero", headline: SAME.replace("{g1}", "") } }),
      ctx,
    );
    const first = r.hard.find((f) => f.rule === "template-glyphs");
    expect(first?.excerpt).toContain("{s1}_{/s1} {g1}_ {s1}_{/s1}{br}");
    expect(first?.excerpt).not.toMatch(/visitors|arrive through/);
  });

  it("soft-flags a line outside its window around the page line, with the range", () => {
    const long = SAME.replace("come from", "come to you straight from");
    const r = lintVariant(body({ hero: { kind: "hero", headline: long } }), ctx);
    const f = r.soft.find((x) => x.rule === "length-drift" && x.excerpt.startsWith("line 2"));
    expect(f?.excerpt).toBe("line 2 has 36 characters; the page's has 24: write 22 to 26");
  });

  it("caps the last line, with its longest rotating word, at the page's own", () => {
    // The page's last line with "compare" is 29 characters; this one is 35.
    const longLast = SAME.replace(
      "Decide what they may {rot:see|test|order|keep}.",
      "Decide what each visitor can {rot:read|compare|buy|skip}.",
    );
    const r = lintVariant(body({ hero: { kind: "hero", headline: longLast } }), ctx);
    const f = r.hard.find(
      (x) => x.rule === "template-line-length" && x.excerpt.startsWith("the last line"),
    );
    expect(f?.excerpt).toBe(
      "the last line has 37 characters with its longest rotating word; the page's has 29: write 27 to 29, counting the longest rotating word",
    );
  });

  it("leaves slots without a template alone", () => {
    const r = lintVariant(
      body({ hero: { kind: "hero", body: "Plain {g1} braces in a paragraph." } }),
      {
        ...ctx,
        originalLengths: new Map(),
      },
    );
    expect(r.hard.filter((f) => f.rule.startsWith("template-"))).toEqual([]);
  });
});

describe("short-missing: one safely short length (docs/decisions/0031)", () => {
  const ctx = {
    language: "en",
    allowedNumbers: new Set<string>(),
    originalLengths: new Map([
      ["hero.headline", 50],
      ["hero.body", 140],
    ]),
  };
  const make = (hero: Record<string, string>) =>
    ({ sections: { hero: { kind: "hero", ...hero } } }) as never;

  it("flags a headline with no length at or under 88% of the original, on its short slot", () => {
    const r = lintVariant(
      make({
        headline: "h".repeat(50),
        headline_alt: "h".repeat(55),
        headline_alt2: "h".repeat(46),
      }),
      ctx,
    );
    const f = r.soft.find((x) => x.rule === "short-missing");
    expect(f?.path).toBe("hero.headline_alt2");
    expect(f?.excerpt).toBe(
      "50 and 55 and 46 characters against the original's 50; write hero.headline_alt2 with at most 42 characters",
    );
    expect(r.hard.some((x) => x.rule === "short-missing")).toBe(false);
    const ok = lintVariant(
      make({
        headline: "h".repeat(50),
        headline_alt: "h".repeat(55),
        headline_alt2: "h".repeat(40),
      }),
      ctx,
    );
    expect(ok.soft.some((x) => x.rule === "short-missing")).toBe(false);
  });

  it("flags a paragraph with no length at or under 92%, on its short slot", () => {
    const r = lintVariant(
      make({ body: "b".repeat(140), body_alt: "b".repeat(132), body_alt2: "b".repeat(150) }),
      ctx,
    );
    expect(r.soft.find((x) => x.rule === "short-missing")?.path).toBe("hero.body_alt");
    const ok = lintVariant(
      make({ body: "b".repeat(140), body_alt: "b".repeat(120), body_alt2: "b".repeat(150) }),
      ctx,
    );
    expect(ok.soft.some((x) => x.rule === "short-missing")).toBe(false);
  });
});
