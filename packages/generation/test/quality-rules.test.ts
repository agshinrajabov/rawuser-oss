import { describe, expect, it } from "vitest";
import { extractSamples, samplesBesideTemplates } from "../src/page-samples.ts";
import { buildDnaPreamble } from "../src/prompts/dna.ts";
import { buildSamplesBlock, languageLayer } from "../src/prompts/quality-rules.ts";
import { buildRevisePrompt } from "../src/prompts/revise.ts";

const dna = {
  customer_id: "c",
  product: "P",
  icp: "I",
  brand_voice: "warm",
  value_props: ["v"],
  differentiators: ["d"],
  proof_points: ["p"],
  target_market: "Local market",
  target_language: "az",
  updated_at: 1,
};

describe("preamble layers", () => {
  it("carries the core rules, the language layer and the samples", () => {
    const p = buildDnaPreamble(dna, ["Biz AI-əsaslı tətbiqlər qururuq.", "Dörd ildə 40+ məhsul."]);
    expect(p).toContain("WRITING RULES (every language)");
    expect(p).toContain("ONLY WHAT THE BRIEF SAYS");
    expect(p).toContain("AZƏRBAYCAN DİLİ");
    expect(p).toContain("THE CUSTOMER'S OWN WORDS");
    expect(p).toContain("- Biz AI-əsaslı tətbiqlər qururuq.");
    expect(p).not.toContain("NO EM-DASHES OR EN-DASHES"); // folded into the core rules
  });

  it("falls back to the generic language block for a language without its own", () => {
    const l = languageLayer("pt-BR", "Portuguese", "Brazil");
    expect(l).toContain("Portuguese");
    expect(l).toContain("Brazil");
    expect(languageLayer("ru", "Russian", "")).toContain("РУССКИЙ");
  });

  it("is stable across calls with the same input (cache key)", () => {
    expect(buildDnaPreamble(dna, ["x y z w"])).toBe(buildDnaPreamble(dna, ["x y z w"]));
    expect(buildSamplesBlock([])).toBe("");
  });
});

describe("revise prompt", () => {
  it("lists every flag and tells the model to change only those strings", () => {
    const p = buildRevisePrompt('{"a":1}', [
      { path: "hero.headline", rule: "number-not-in-brief", excerpt: "12.000", severity: "hard" },
      { path: "hero.body", rule: "dash", excerpt: "a – b", severity: "soft" },
    ]);
    expect(p).toContain("hero.headline: number-not-in-brief");
    expect(p).toContain("Change ONLY the strings listed");
    expect(p.trim().endsWith('{"a":1}')).toBe(true);
  });
});

describe("extractSamples", () => {
  it("keeps headline-sized complete sentences and drops nav, links and duplicates", () => {
    const html = `<html><body><nav>Home | About | Contact</nav>
      <h1>We build hand-made products.</h1>
      <p>We open with the one thing your last vendor did not ask. Read more at https://x.y today please.</p>
      <h2>We build hand-made products.</h2>
      <p>A</p><p>Seven services, two practices, one studio, all under one roof for fintech teams that ship weekly.</p>
      </body></html>`;
    const s = extractSamples(html);
    expect(s[0]).toBe("We build hand-made products.");
    expect(s).toContain("We open with the one thing your last vendor did not ask.");
    expect(s.some((x) => x.includes("https://"))).toBe(false);
    expect(s.filter((x) => x === "We build hand-made products.")).toHaveLength(1);
    expect(s.some((x) => x.includes("|"))).toBe(false);
  });
});

describe("samplesBesideTemplates", () => {
  const manifest = {
    "hero.headline": {
      css: ["h1"],
      text: [],
      structural: "first h1",
      inline: {
        icons: "none" as const,
        emphasis: 0,
        split: true,
        animated_text: false,
        template:
          "{s1}Your{/s1} {g1}visitors {s1}already{/s1}{br}{s1}arrive through{/s1} {g2}AI tools.{br}{s2}Choose what they can {rot:read|compare|buy|skip}.{/s2}",
      },
    },
  };

  it("drops the lines of a part built word by word and keeps the page's other sentences", () => {
    const samples = [
      "arrive through AI tools.",
      "Choose what they can read compare buy skip .",
      "One tag in the head.",
      "Rawuser reads why each visitor came.",
    ];
    expect(samplesBesideTemplates(samples, [manifest])).toEqual([
      "One tag in the head.",
      "Rawuser reads why each visitor came.",
    ]);
    expect(samplesBesideTemplates(samples, [null])).toEqual(samples);
  });
});
