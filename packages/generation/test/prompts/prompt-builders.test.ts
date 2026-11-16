/**
 * Unit tests for prompt builders.
 *
 * Uses a sanitized fake DNA fixture: not a customer's data.
 * No real API calls are made; these are pure string-construction tests.
 */

import type { BusinessDNA } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { buildDnaPreamble } from "../../src/prompts/dna.ts";
import { buildIntentPrompt } from "../../src/prompts/intent-prompts.ts";
import { INTENT_STRUCTURES, expectedSectionKinds } from "../../src/prompts/intent-structures.ts";
import { GENERATED_SOURCE_DIMS, buildSourceModifier } from "../../src/prompts/source-modifiers.ts";

// ---------------------------------------------------------------------------
// Fixture: fake DNA, not a real customer
// ---------------------------------------------------------------------------

const FAKE_DNA: BusinessDNA = {
  customer_id: "test-acme",
  product: "Acme Widget Pro: a software tool that organizes widgets for small businesses.",
  icp: "Small business owners in the widget industry who want to scale operations.",
  value_props: [
    "Organize 100 widgets in under 5 minutes",
    "Real-time inventory sync across all locations",
    "24/7 support from widget experts",
  ],
  differentiators: [
    "Only tool built for widget businesses specifically",
    "Founder has 20 years in widget manufacturing",
    "Integrates with all major widget suppliers",
  ],
  proof_points: [
    "WidgetCo Inc. reduced inventory errors by 40%",
    "GlobalWidget GmbH processes 10,000 orders/month",
    "Founder: 20-year veteran of Acme Industries, WidgetWorld",
  ],
  brand_voice: "clear, practical, confident. Speaks to busy business owners",
  target_market: "English-speaking small business owners, primarily US and UK",
  target_language: "en",
  per_intent_hints: {
    problem: "Focus on the pain of tracking widgets manually in spreadsheets",
    competitor: "Compare honestly against WidgetTracker, which lacks real-time sync",
  },
  updated_at: 1_700_000_000,
};

// ---------------------------------------------------------------------------
// buildDnaPreamble
// ---------------------------------------------------------------------------

describe("buildDnaPreamble", () => {
  it("includes the customer product description", () => {
    const preamble = buildDnaPreamble(FAKE_DNA);
    expect(preamble).toContain("Acme Widget Pro");
  });

  it("includes all value props", () => {
    const preamble = buildDnaPreamble(FAKE_DNA);
    expect(preamble).toContain("Organize 100 widgets in under 5 minutes");
    expect(preamble).toContain("Real-time inventory sync across all locations");
    expect(preamble).toContain("24/7 support from widget experts");
  });

  it("includes all differentiators", () => {
    const preamble = buildDnaPreamble(FAKE_DNA);
    expect(preamble).toContain("Only tool built for widget businesses specifically");
    expect(preamble).toContain("Founder has 20 years in widget manufacturing");
  });

  it("includes all proof points verbatim", () => {
    const preamble = buildDnaPreamble(FAKE_DNA);
    // Proof points must NOT be paraphrased: the quality rule is explicit
    expect(preamble).toContain("WidgetCo Inc. reduced inventory errors by 40%");
    expect(preamble).toContain("GlobalWidget GmbH processes 10,000 orders/month");
  });

  it("includes the brand voice", () => {
    const preamble = buildDnaPreamble(FAKE_DNA);
    expect(preamble).toContain("clear, practical, confident. Speaks to busy business owners");
  });

  it("includes the target language (English)", () => {
    const preamble = buildDnaPreamble(FAKE_DNA);
    expect(preamble).toContain("English");
    expect(preamble).toContain("en");
  });

  it("includes Azerbaijani for az target language", () => {
    const azDna: BusinessDNA = { ...FAKE_DNA, target_language: "az" };
    const preamble = buildDnaPreamble(azDna);
    expect(preamble).toContain("Azerbaijani");
    expect(preamble).toContain("az");
  });

  it("instructs output JSON only (no markdown)", () => {
    const preamble = buildDnaPreamble(FAKE_DNA);
    expect(preamble).toContain("OUTPUT JSON ONLY");
  });

  it("contains the VariantBody schema description", () => {
    const preamble = buildDnaPreamble(FAKE_DNA);
    expect(preamble).toContain("VARIANTBODY SCHEMA");
    expect(preamble).toContain("customer_id");
    expect(preamble).toContain("profile_key");
    expect(preamble).toContain("sections");
    expect(preamble).toContain("generated_at");
  });

  it("instructs no placeholder tokens", () => {
    const preamble = buildDnaPreamble(FAKE_DNA);
    expect(preamble).toContain("NO PLACEHOLDERS");
  });

  it("instructs no em-dashes or en-dashes (P1.1, now in the core writing rules)", () => {
    const preamble = buildDnaPreamble(FAKE_DNA);
    expect(preamble).toContain("no em or en dashes anywhere");
    expect(preamble).toContain("ONLY WHAT THE BRIEF SAYS");
  });

  it("appends Azerbaijani quality rules when target_language is az (P1.3)", () => {
    const azDna: BusinessDNA = { ...FAKE_DNA, target_language: "az" };
    const preamble = buildDnaPreamble(azDna);
    expect(preamble).toContain("AZƏRBAYCAN DİLİ");
    expect(preamble).toContain("məbləğ");
    expect(preamble).toContain("lansman");
    expect(preamble).toContain("rüsum");
    expect(preamble).toContain("istinad hərfi");
    expect(preamble).toContain("tövsiyə");
    expect(preamble).toContain("məktubu");
  });

  it("does NOT append Azerbaijani guidance when target_language is en (P1.3)", () => {
    const preamble = buildDnaPreamble(FAKE_DNA);
    expect(preamble).not.toContain("AZƏRBAYCAN DİLİ");
    expect(preamble).not.toContain("məbləğ");
    expect(preamble).toContain("=== ENGLISH ===");
  });
});

// ---------------------------------------------------------------------------
// INTENT_STRUCTURES
// ---------------------------------------------------------------------------

describe("INTENT_STRUCTURES", () => {
  const intents = ["competitor", "evaluation", "feature", "problem", "brand", "pricing"] as const;

  it("has an entry for all 6 intent dims", () => {
    for (const dim of intents) {
      expect(INTENT_STRUCTURES[dim]).toBeDefined();
      expect(Array.isArray(INTENT_STRUCTURES[dim])).toBe(true);
      expect(INTENT_STRUCTURES[dim].length).toBeGreaterThan(0);
    }
  });

  it("competitor structure: hero → comparison → social_proof → cta", () => {
    const kinds = INTENT_STRUCTURES.competitor.map((s) => s.kind);
    expect(kinds).toEqual(["hero", "comparison", "social_proof", "cta"]);
  });

  it("evaluation structure: hero → features → social_proof → faq → cta", () => {
    const kinds = INTENT_STRUCTURES.evaluation.map((s) => s.kind);
    expect(kinds).toEqual(["hero", "features", "social_proof", "faq", "cta"]);
  });

  it("feature structure: hero → features → features → cta (two feature sections)", () => {
    const kinds = INTENT_STRUCTURES.feature.map((s) => s.kind);
    expect(kinds).toEqual(["hero", "features", "features", "cta"]);
  });

  it("problem structure: hero → features → social_proof → cta", () => {
    const kinds = INTENT_STRUCTURES.problem.map((s) => s.kind);
    expect(kinds).toEqual(["hero", "features", "social_proof", "cta"]);
  });

  it("brand structure: hero → features → social_proof → pricing → cta", () => {
    const kinds = INTENT_STRUCTURES.brand.map((s) => s.kind);
    expect(kinds).toEqual(["hero", "features", "social_proof", "pricing", "cta"]);
  });

  it("pricing structure: hero → pricing → features → cta", () => {
    const kinds = INTENT_STRUCTURES.pricing.map((s) => s.kind);
    expect(kinds).toEqual(["hero", "pricing", "features", "cta"]);
  });

  it("all sections have emphasis between 0 and 1", () => {
    for (const dim of intents) {
      for (const section of INTENT_STRUCTURES[dim]) {
        expect(section.emphasis).toBeGreaterThanOrEqual(0);
        expect(section.emphasis).toBeLessThanOrEqual(1);
      }
    }
  });

  it("hero is always first", () => {
    for (const dim of intents) {
      const first = INTENT_STRUCTURES[dim][0];
      expect(first?.kind).toBe("hero");
    }
  });

  it("hero has emphasis 1.0 for brand/problem/competitor/evaluation/pricing intents", () => {
    // These are the canonical narrative intents: hero leads with full weight
    const fullEmphasisIntents = [
      "brand",
      "problem",
      "competitor",
      "evaluation",
      "pricing",
    ] as const;
    for (const dim of fullEmphasisIntents) {
      const first = INTENT_STRUCTURES[dim][0];
      expect(first?.emphasis, `${dim} hero should have emphasis 1.0`).toBe(1.0);
    }
  });

  it("feature intent hero has lower emphasis (features sections are the centerpiece)", () => {
    // feature intent: the deep capability sections ARE the page; hero is secondary
    const first = INTENT_STRUCTURES.feature[0];
    expect(first?.kind).toBe("hero");
    expect(first?.emphasis).toBeLessThan(1.0);
    expect(first?.emphasis).toBeGreaterThan(0.5);
  });

  it("cta is always last", () => {
    for (const dim of intents) {
      const sections = INTENT_STRUCTURES[dim];
      const last = sections[sections.length - 1];
      expect(last?.kind).toBe("cta");
    }
  });
});

describe("expectedSectionKinds", () => {
  it("returns the kinds for competitor in order", () => {
    expect(expectedSectionKinds("competitor")).toEqual([
      "hero",
      "comparison",
      "social_proof",
      "cta",
    ]);
  });

  it("returns two features for feature intent", () => {
    const kinds = expectedSectionKinds("feature");
    expect(kinds.filter((k) => k === "features").length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildIntentPrompt
// ---------------------------------------------------------------------------

describe("buildIntentPrompt", () => {
  it("includes the customer_id in the output requirements", () => {
    const prompt = buildIntentPrompt("brand", FAKE_DNA, "test-acme");
    expect(prompt).toContain("test-acme");
  });

  it("includes the correct profile_key", () => {
    const prompt = buildIntentPrompt("competitor", FAKE_DNA, "test-acme");
    expect(prompt).toContain("intent:competitor");
  });

  it("includes per_intent_hints when present", () => {
    const prompt = buildIntentPrompt("problem", FAKE_DNA, "test-acme");
    expect(prompt).toContain("tracking widgets manually in spreadsheets");
  });

  it("does NOT include per_intent_hints for a different intent", () => {
    // pricing has no hint in FAKE_DNA
    const prompt = buildIntentPrompt("pricing", FAKE_DNA, "test-acme");
    expect(prompt).not.toContain("tracking widgets manually");
    expect(prompt).not.toContain("CUSTOMER HINT");
  });

  it("includes the structure plan sections", () => {
    const prompt = buildIntentPrompt("evaluation", FAKE_DNA, "test-acme");
    expect(prompt).toContain("features");
    expect(prompt).toContain("faq");
    expect(prompt).toContain("social_proof");
  });

  it("feature intent uses disambiguated keys features_core and features_integrations", () => {
    const prompt = buildIntentPrompt("feature", FAKE_DNA, "test-acme");
    expect(prompt).toContain("features_core");
    expect(prompt).toContain("features_integrations");
  });

  it("does not include source modifier (that is appended separately)", () => {
    const prompt = buildIntentPrompt("brand", FAKE_DNA, "test-acme");
    expect(prompt).not.toContain("SOURCE MODIFIER");
  });

  it("instructs no markdown in output", () => {
    const prompt = buildIntentPrompt("brand", FAKE_DNA, "test-acme");
    expect(prompt).toContain("No markdown");
  });

  it("does NOT include a length constraints block when no manifest is provided (P1.2 backward compat)", () => {
    const prompt = buildIntentPrompt("brand", FAKE_DNA, "test-acme");
    expect(prompt).not.toContain("LENGTH LIMITS");
  });

  it("does NOT include a length constraints block when manifest entries lack length data (P1.2)", () => {
    const prompt = buildIntentPrompt("brand", FAKE_DNA, "test-acme", {
      "hero.headline": { css: ["h1"], text: [], structural: "first h1" },
    });
    expect(prompt).not.toContain("LENGTH LIMITS");
  });

  it("includes per-path length limits (a floor for headlines and buttons, an upper bound for the rest) when manifest has length data (P1.2)", () => {
    const prompt = buildIntentPrompt("brand", FAKE_DNA, "test-acme", {
      "hero.headline": {
        css: ["h1"],
        text: [],
        structural: "first h1",
        original_char_length: 24,
        original_word_count: 6,
      },
      "hero.body": {
        css: ["h1 + p"],
        text: [],
        structural: "first paragraph after h1",
        original_char_length: 80,
        original_word_count: 14,
      },
    });
    expect(prompt).toContain("LENGTH LIMITS");
    // Headlines: 95% to 105% of the original's characters (2026-09-16, the
    // windows pulled in; the second and third lengths sit just either side).
    // Paragraphs of 40 characters or more: 95% to 105%. No word range
    // (bake-off 2026-09-11).
    expect(prompt).toMatch(/hero\.headline:\s*between 23 and 25 characters/);
    expect(prompt).toMatch(/hero\.body:\s*between 76 and 84 characters/);
    // The paragraph's shorter second length rides next to it (2026-09-15).
    expect(prompt).toContain("hero.body_alt2");
    expect(prompt).toContain("hero.headline_alt2");
    expect(prompt).toContain("between 75% and 90% of the original's count");
    expect(prompt).toContain("between 105% and 115%");
    expect(prompt).not.toMatch(/\d+-\d+ chars/);
    expect(prompt).toContain("shortest complete sentence wins");
  });

  it("renders char-only or word-only ranges when only one is present (P1.2)", () => {
    const prompt = buildIntentPrompt("brand", FAKE_DNA, "test-acme", {
      "hero.headline": {
        css: ["h1"],
        text: [],
        structural: "first h1",
        original_char_length: 24,
      },
    });
    expect(prompt).toContain("LENGTH LIMITS");
    expect(prompt).toMatch(/hero\.headline:\s*between 23 and 25 characters/);
    expect(prompt).not.toMatch(/at most \d+ words/);
  });
});

describe("buildIntentPrompt: ALLOWED PATHS manifest constraint (Fix Pass A / QA-2)", () => {
  it("emits ALLOWED PATHS list when manifest has keys", () => {
    const prompt = buildIntentPrompt("brand", FAKE_DNA, "test-acme", {
      "hero.headline": { css: ["h1"], text: [], structural: "h1" },
      "cta.cta.label": { css: [".cta a"], text: [], structural: ".cta a" },
    });
    // The full block heading appears (not just the words in OUTPUT REQUIREMENTS).
    expect(prompt).toContain("ALLOWED PATHS (the customer's confirmed element manifest");
    expect(prompt).toContain("- hero.headline");
    expect(prompt).toContain("- cta.cta.label");
    expect(prompt).toContain("STRICT SUBSET");
  });

  it("omits ALLOWED PATHS list block when no manifest supplied", () => {
    const prompt = buildIntentPrompt("brand", FAKE_DNA, "test-acme");
    expect(prompt).not.toContain("ALLOWED PATHS (the customer's");
  });

  it("omits ALLOWED PATHS list block when manifest is empty", () => {
    const prompt = buildIntentPrompt("brand", FAKE_DNA, "test-acme", {});
    expect(prompt).not.toContain("ALLOWED PATHS (the customer's");
  });

  it("STRUCTURE PLAN heading is marked advisory when manifest constrains output", () => {
    const prompt = buildIntentPrompt("pricing", FAKE_DNA, "test-acme", {
      "hero.headline": { css: ["h1"], text: [], structural: "h1" },
    });
    expect(prompt).toContain("STRUCTURE PLAN (advisory");
  });

  it("STRUCTURE PLAN is filtered to manifest-covered sections (no orphan sections)", () => {
    // Manifest only has hero.* paths. The evaluation intent's structure
    // canonically includes social_proof, faq, etc.: but those shouldn't
    // appear in the structure plan because the model would emit them and
    // the validator would reject.
    const prompt = buildIntentPrompt("evaluation", FAKE_DNA, "test-acme", {
      "hero.headline": { css: ["h1"], text: [], structural: "h1" },
      "hero.cta.label": { css: [".cta"], text: [], structural: ".cta" },
    });
    expect(prompt).not.toContain("social_proof");
    expect(prompt).not.toContain("faq");
    // hero section IS expected (manifest covers hero.*).
    expect(prompt).toContain('section key: "hero"');
  });

  it("STRUCTURE PLAN keeps all sections when no manifest supplied (legacy)", () => {
    const prompt = buildIntentPrompt("evaluation", FAKE_DNA, "test-acme");
    // Legacy path: full INTENT_STRUCTURES used: evaluation has social_proof, faq.
    expect(prompt).toContain("social_proof");
    expect(prompt).toContain("faq");
  });
});

// ---------------------------------------------------------------------------
// buildSourceModifier
// ---------------------------------------------------------------------------

describe("buildSourceModifier", () => {
  it('returns empty string for "default"', () => {
    expect(buildSourceModifier("default")).toBe("");
  });

  it("ai modifier references AI tools", () => {
    const mod = buildSourceModifier("ai");
    expect(mod).toContain("ChatGPT");
    expect(mod).toContain("Claude");
    expect(mod).toContain("Perplexity");
  });

  it("social modifier references social media", () => {
    const mod = buildSourceModifier("social");
    expect(mod).toContain("social media");
    expect(mod).toContain("LinkedIn");
  });

  it("community modifier instructs technical, non-marketing tone", () => {
    const mod = buildSourceModifier("community");
    expect(mod).toContain("Reddit");
    expect(mod).toContain("Hacker News");
    expect(mod).toContain("skeptical");
  });

  it("organic modifier references search engines", () => {
    const mod = buildSourceModifier("organic");
    expect(mod).toContain("Google");
    expect(mod).toContain("organic search");
  });

  it("all GENERATED_SOURCE_DIMS produce non-empty modifiers", () => {
    for (const dim of GENERATED_SOURCE_DIMS) {
      const mod = buildSourceModifier(dim);
      expect(mod.length).toBeGreaterThan(50);
    }
  });

  it("all modifiers explicitly say NOT to change structure plan", () => {
    for (const dim of GENERATED_SOURCE_DIMS) {
      const mod = buildSourceModifier(dim);
      expect(mod).toContain("Do NOT change");
      expect(mod).toContain("structure plan");
    }
  });

  it("ai and community modifiers are distinguishably different", () => {
    const aiMod = buildSourceModifier("ai");
    const communityMod = buildSourceModifier("community");
    // They must differ in meaningful content, not just whitespace
    expect(aiMod).not.toBe(communityMod);
    // ai modifier should reference research mode, community should reference skepticism
    expect(aiMod).toContain("research mode");
    expect(communityMod).toContain("skeptical");
  });
});

describe("buildIntentPrompt: TEMPLATE block (docs/specs/template-writing.md §4.2)", () => {
  const TPL =
    "{s1}Your{/s1} {g1}visitors {s1}already{/s1}{br}{s1}arrive through{/s1} {g2}AI tools.{br}{s2}Choose what they can {rot:read|compare|buy|skip}.{/s2}";
  const manifest = {
    "hero.headline": {
      css: ["h1"],
      text: [],
      structural: "first h1",
      original_char_length: 76,
      inline: {
        icons: "none" as const,
        emphasis: 0,
        split: true,
        animated_text: false,
        template: TPL,
      },
    },
  };

  it("asks for a word list per run, line by line, with the page's grammar and never a template", () => {
    const prompt = buildIntentPrompt("brand", FAKE_DNA, "test-acme", manifest);
    expect(prompt).toContain("BUILT WORD BY WORD.");
    expect(prompt).toContain(
      'The page\'s own reads "Your visitors already / arrive through AI tools. / Choose what they can read (or compare, buy, skip)."',
    );
    expect(prompt).toContain(
      "line 1 (19 to 23 characters; the headline starts here, with a capital letter): run 1, 1 word; run 2, 1 word; run 3, 1 word",
    );
    expect(prompt).toContain(
      'line 3 (27 to 29 characters counting the longest rotating word, "compare", never more)',
    );
    // The rotating words are the page's own: named, never asked for.
    expect(prompt).toContain(
      "then the page's own rotating word (read, compare, buy, skip), which the page keeps",
    );
    expect(prompt).toContain('"headline": ["…", "…", "…", "… …", "… …", "… … … …"]');
    expect(prompt).toContain("(_alt, _alt2)");
    // No token reaches the model: code places them.
    const block = prompt.slice(prompt.indexOf("BUILT WORD BY WORD."));
    expect(block).not.toMatch(/\{g1\}|\{br\}|\{s1\}|\{rot:/);
  });

  it("stays out of prompts whose parts carry no template", () => {
    const prompt = buildIntentPrompt("brand", FAKE_DNA, "test-acme", {
      "hero.headline": { css: ["h1"], text: [], structural: "first h1", original_char_length: 30 },
    });
    expect(prompt).not.toContain("BUILT WORD BY WORD.");
  });
});
