/**
 * Keyword intent (docs/specs/keyword-intent.md): the lexicon check, the
 * matcher in four scripts, and the classifier reading only keywordIntent.
 */
import { describe, expect, it } from "vitest";
import { classify } from "../src/classify/index.ts";
import {
  foldKeyword,
  matchKeywordIntent,
  parseStoredLexicon,
  validateLexicon,
} from "../src/keyword-lexicon.ts";
import type { Signals } from "../src/types.ts";

const none = () => false;

describe("validateLexicon", () => {
  it("keeps served intents, folds, drops brand, long, digit-only and duplicate phrases", () => {
    const lex = validateLexicon(
      {
        pricing: ["CRM Pricing", "free  crm", "123", "a b c d e", "x".repeat(41)],
        competitor: ["HubSpot", "crm pricing"],
        brand: ["acme"],
        feature: ["api"],
      },
      ["pricing", "competitor", "brand"],
      none,
    );
    expect(lex).toEqual({ competitor: ["hubspot", "crm pricing"], pricing: ["free crm"] });
  });

  it("the screen refuses a phrase; nothing left is null", () => {
    expect(
      validateLexicon({ pricing: ["cancer test price"] }, null, (p) => p.includes("cancer")),
    ).toBeNull();
    expect(validateLexicon("nope", null, none)).toBeNull();
  });
});

describe("matchKeywordIntent", () => {
  const lex = validateLexicon(
    {
      competitor: ["hubspot", "pipedrive alternative", "альтернатива"],
      pricing: ["pricing", "qiymət", "цена", "fiyat"],
      evaluation: ["best crm", "en iyi"],
      problem: ["how to track leads"],
    },
    null,
    none,
  );

  it("matches whole words in four scripts", () => {
    expect(matchKeywordIntent("crm pricing for agencies", lex)).toBe("pricing");
    expect(matchKeywordIntent("crm proqramı qiymət", lex)).toBe("pricing");
    expect(matchKeywordIntent("crm цена в месяц", lex)).toBe("pricing");
    expect(matchKeywordIntent("crm fiyat", lex)).toBe("pricing");
    expect(matchKeywordIntent("альтернатива amocrm", lex)).toBe("competitor");
    expect(matchKeywordIntent("en iyi crm", lex)).toBe("evaluation");
  });

  it("never matches inside a word, and the longest phrase wins", () => {
    expect(matchKeywordIntent("repricing tool", lex)).toBeNull();
    expect(matchKeywordIntent("best crm pricing", lex)).toBe("evaluation");
    expect(matchKeywordIntent("hubspot pricing", lex)).toBe("competitor");
  });

  it("nothing without a lexicon, an empty or an overlong keyword", () => {
    expect(matchKeywordIntent("crm pricing", null)).toBeNull();
    expect(matchKeywordIntent("", lex)).toBeNull();
    expect(matchKeywordIntent(`pricing ${"x".repeat(130)}`, lex)).toBeNull();
  });

  it("the stored text reads back; malformed is null", () => {
    expect(parseStoredLexicon(JSON.stringify(lex))).toEqual(lex);
    expect(parseStoredLexicon("{bad")).toBeNull();
    expect(foldKeyword("  CRM,  Pricing! ")).toBe("crm pricing");
  });
});

describe("classify reads keywordIntent", () => {
  const base: Signals = {
    utm: { source: "google", medium: "cpc" },
    referrerHost: null,
    device: "desktop",
    language: "en",
    country: null,
    aiSource: null,
  };
  const top = (s: Signals) => {
    const v = classify(s, Date.UTC(2026, 9, 21, 12));
    return Object.entries(v.intent).sort((a, b) => b[1] - a[1])[0]?.[0];
  };

  it("a keyword intent beats the brand default; none leaves brand", () => {
    expect(top(base)).toBe("brand");
    expect(top({ ...base, keywordIntent: "pricing" })).toBe("pricing");
    expect(top({ ...base, keywordIntent: "competitor" })).toBe("competitor");
  });

  it("a keyword beats a campaign word", () => {
    expect(
      top({
        ...base,
        utm: { ...base.utm, campaign: "pricing-plans" },
        keywordIntent: "competitor",
      }),
    ).toBe("competitor");
  });
});

import { bundleKeywordLexicon } from "../src/visitor-bundle.ts";

describe("bundleKeywordLexicon, condition 8 read strictly", () => {
  const lexicon = JSON.stringify({ pricing: ["pricing"] });
  const row = { keyword_lexicon: lexicon, keyword_off: 0, sensitive: 0, special_category: 0 };

  it("only an explicit no gives kl", () => {
    expect(bundleKeywordLexicon(row)).toEqual({ pricing: ["pricing"] });
    expect(bundleKeywordLexicon({ ...row, special_category: null })).toBeUndefined();
    expect(bundleKeywordLexicon({ ...row, special_category: 1 })).toBeUndefined();
    expect(bundleKeywordLexicon({ ...row, sensitive: 1 })).toBeUndefined();
    expect(bundleKeywordLexicon({ ...row, keyword_off: 1 })).toBeUndefined();
    expect(bundleKeywordLexicon(null)).toBeUndefined();
  });
});
