/**
 * A version never speaks about where the visitor came from (A13 of
 * docs/specs/pilot-gaps.md; the founder's decision of 2026-10-12;
 * lint/source-addressed.ts).
 *
 * Live on the pilot's site, `problem:ai`, the hero paragraph: text meaning "if you
 * asked AI, the answer is this:". The AI modifier's own example had asked
 * for it. The source shapes the framing and is never said. Two pages decide
 * the rule here: the pilot's, which sells supplements and has no reason to say
 * "AI", and a page whose product is about AI, where the word is its subject.
 */
import type { Manifest, VariantBody } from "@rawuser/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeKv, makeSqliteD1 } from "./admin/sqlite-d1.ts";
import { MODEL_ENV } from "./model-env.ts";

interface ModelInput {
  prompt: string;
  cachedPreamble?: string;
}
let inputs: ModelInput[] = [];
let answerFor: (input: ModelInput) => string = () => "{}";
vi.mock("../src/generateVariant.ts", () => ({
  generateVariant: vi.fn(async (input: ModelInput) => {
    inputs.push(input);
    return {
      text: answerFor(input),
      model: "model-a",
      costUsd: 0.0002,
      promptHash: "h",
      cacheHit: false,
      cacheReadTokens: 0,
    };
  }),
}));

let pageHtml = "";
vi.mock("../src/detect-elements.ts", async (actual) => ({
  ...(await actual<typeof import("../src/detect-elements.ts")>()),
  fetchPageHtml: vi.fn(async () => pageHtml),
}));

const { sourceAddressed, SOURCE_ADDRESSED_FIX } = await import("../src/lint/source-addressed.ts");
const { lintVariant, collectNumbers, ownWordsFor } = await import("../src/lint/index.ts");
const { regenerateOne } = await import("../src/orchestrator.ts");
const { buildSourceModifier, GENERATED_SOURCE_DIMS, NEVER_SAY_THE_SOURCE } = await import(
  "../src/prompts/source-modifiers.ts"
);
const { CORE_QUALITY_RULES } = await import("../src/prompts/quality-rules.ts");
const { buildRevisePrompt } = await import("../src/prompts/revise.ts");
const { SENDABLE_RULES } = await import("../src/lib/lint-shares.ts");
const { resetPageLinks } = await import("../src/page-links.ts");
const { resetReads } = await import("../src/inline-shape-backfill.ts");

beforeEach(() => {
  inputs = [];
  answerFor = () => "{}";
  resetPageLinks();
  resetReads();
});

/** The pilot's own words: supplements made to order. No AI anywhere. */
const MEDORA =
  "Qida əlavələrinin sifarişlə istehsalı. Öz brendi olan şirkətlər. Öz formulunuz, GMP standartları. Sağlamlığınız üçün əlavələr.";
/** A page whose product is about AI. */
const AI_PRODUCT =
  "We craft AI-first software for startups. An AI assistant that answers your customers in your own voice.";

const flagged = (lang: string, text: string, own: string | undefined = MEDORA) =>
  sourceAddressed(text, lang, own) !== null;

describe("Medora, problem:ai, the hero paragraph", () => {
  it("'if you asked AI, the answer is this' is read, in the forms a model writes it", () => {
    for (const text of [
      "Süni intellektdən soruşdunuzsa, cavab budur: qida əlavələrini sifarişlə istehsal edirik.",
      "AI-dan soruşdunuzsa, qısa cavab budur.",
      "ChatGPT-dən soruşmusunuzsa, doğru ünvandasınız.",
      "Süni intellekt bizi sizə tövsiyə edib.",
      "Əgər bunu süni intellektdən öyrəndinizsə, davamı buradadır.",
    ]) {
      expect(flagged("az", text), text).toBe(true);
    }
    // The phrase that was read, and nothing more of the copy.
    expect(
      sourceAddressed(
        "Süni intellektdən soruşdunuzsa, cavab budur: qida əlavələrini istehsal edirik.",
        "az",
        MEDORA,
      ),
    ).toBe("soruşdunuzsa");
  });

  it("the page's own words and an honest version of them pass", () => {
    for (const text of [
      "Qida Əlavələri Sifarişlərdə Etibarlıq və Səriştə",
      "Sizin brendiniz üçün qida əlavələrini sifarişlə istehsal edirik.",
      "Reseptdən qablaşdırmaya qədər hər addımı yalnız bir heyət izləyir.",
      "Sağlamlığınız üçün əlavələr",
      "Məhsullarımızla tanış olun!",
      "Göndər",
    ]) {
      expect(flagged("az", text), text).toBe(false);
    }
  });
});

describe("what the reader did before arriving, in four languages", () => {
  const SAID: Record<string, string[]> = {
    az: [
      "Etibarlı istehsalçı axtarırdınızsa, tapdınız.",
      "Google-da axtardınız və bura gəldiniz.",
      "Bizi LinkedIn-də gördünüzsə, daha ətraflı burada.",
      "Axtarışdan gələnlər üçün qısa izah.",
      "Haqqımızda forumda oxudunuz, indi özünüz baxın.",
      "Soruşduğunuz sualın cavabı sadədir.",
    ],
    en: [
      "If you asked AI, here is the answer.",
      "You searched for a calmer way to plan. Here it is.",
      "You found us on Google for a reason.",
      "If you're here from Reddit, here's the honest version.",
      "ChatGPT sent you here for a reason.",
      "As the AI said, we ship in a week.",
      "Recommended by ChatGPT for small teams.",
      "You saw us on LinkedIn. Here is the rest.",
      "Stop scrolling. This is the planner you need.",
      "You came from a search, so here is the short version.",
    ],
    ru: [
      "Если вы спросили ИИ, вот ответ.",
      "Вы искали надёжного производителя. Вот он.",
      "Вы пришли из поиска, поэтому коротко.",
      "Вам посоветовал ассистент, и не зря.",
      "Вы увидели нас в Instagram, остальное здесь.",
    ],
    tr: [
      "Yapay zekaya sorduysanız, cevap bu.",
      "Güvenilir üretici aradıysanız, buldunuz.",
      "Bizi LinkedIn'de gördünüz, gerisi burada.",
      "Aramadan gelenler için kısa özet.",
    ],
  };
  for (const [lang, texts] of Object.entries(SAID)) {
    it(`${lang}: flagged`, () => {
      for (const text of texts) expect(flagged(lang, text), text).toBe(true);
    });
  }

  /** What a page says of a need, of itself, or of where to find it. */
  const FINE: Record<string, string[]> = {
    az: [
      "Etibarlı istehsalçı axtarırsınızsa, doğru yerə gəldiniz.",
      "Axtardığınız keyfiyyət burada.",
      "Suallarınızı WhatsApp-da yazın.",
      "Bizi Instagram-da izləyin.",
      "Bizi Google-da tapın.",
      "Müştərilərimiz soruşdu, biz cavab verdik.",
    ],
    en: [
      "Looking for a calmer way to plan the week?",
      "Everything you asked for, nothing you did not.",
      "Coming from Trello? Import your boards in a minute.",
      "Follow us on LinkedIn for updates.",
      "Join 2,000 founders on Discord.",
      "The planner you have been looking for.",
      "You got through the week. Now plan the next.",
      "Found us useful? Tell a friend on LinkedIn.",
    ],
    ru: [
      "Именно то, что вы искали.",
      "Ищете надёжного производителя?",
      "Подпишитесь на нас в Telegram.",
      "Производим добавки под вашим брендом.",
    ],
    tr: [
      "Aradığınız kalite burada.",
      "Güvenilir üretici mi arıyorsunuz?",
      "Bizi Instagram'da takip edin.",
      "Bir sorun mu var? Bize yazın.",
    ],
  };
  for (const [lang, texts] of Object.entries(FINE)) {
    it(`${lang}: not flagged`, () => {
      for (const text of texts) expect(flagged(lang, text), text).toBe(false);
    });
  }

  it("English is read on every page: a model slips into it", () => {
    expect(flagged("az", "If you asked AI, the answer is this.")).toBe(true);
  });
});

describe("a product about AI keeps its own subject", () => {
  it("the word is the product's where the brief or the page says it", () => {
    for (const text of [
      "An AI assistant that answers your customers in seconds.",
      "Ask our AI anything about your contracts.",
      "We ship AI-first software in four weeks.",
    ]) {
      expect(flagged("en", text, AI_PRODUCT), text).toBe(false);
    }
    // In the page's other language too: the family is one subject.
    expect(flagged("az", "Süni intellekt əsaslı məhsullar yaradırıq.", AI_PRODUCT)).toBe(false);
  });

  it("the same words on a page that never says AI are not its subject", () => {
    expect(flagged("en", "The AI-powered way to plan your week.", MEDORA)).toBe(true);
    expect(flagged("az", "Süni intellekt əsaslı istehsal.", MEDORA)).toBe(true);
  });

  it("what is said about the reader's arrival is flagged there too", () => {
    expect(flagged("en", "If you asked AI about us, here is the answer.", AI_PRODUCT)).toBe(true);
    expect(flagged("az", "Süni intellektdən soruşdunuzsa, cavab budur.", AI_PRODUCT)).toBe(true);
    expect(flagged("en", "ChatGPT sent you here for a reason.", AI_PRODUCT)).toBe(true);
  });

  it("an assistant's name is the customer's own only when the customer says it", () => {
    expect(flagged("en", "Better answers than ChatGPT.", AI_PRODUCT)).toBe(true);
    expect(flagged("en", "Better answers than ChatGPT.", `${AI_PRODUCT} Works with ChatGPT.`)).toBe(
      false,
    );
    // A name that is also a word is read with its capital only.
    expect(flagged("en", "Your copilot for the week.", MEDORA)).toBe(false);
    expect(flagged("en", "Ask Claude how we compare.", MEDORA)).toBe(true);
  });

  it("without the customer's own words only the arrival is read", () => {
    expect(sourceAddressed("The AI-powered way to plan your week.", "en")).toBeNull();
    expect(sourceAddressed("If you asked AI, here is the answer.", "en")).not.toBeNull();
  });
});

describe("an ad (docs/specs/ads-platforms.md §3, privacy review condition 3)", () => {
  /** A customer whose product is advertising: an ad word is its own subject. */
  const AD_AGENCY =
    "Rəqəmsal reklam agentliyi. Google və Meta reklamlarını idarə edirik. Digital advertising for small brands.";

  const ADDRESSED: Record<string, string[]> = {
    az: [
      "Reklamımızı gördünüz, indi məhsula yaxından baxın.",
      "Reklamdan gəldinizsə, qısa izah budur.",
      "Reklama kliklədiniz, doğru yerdəsiniz.",
      "Gördüyünüz reklam bu xidmət haqqındadır.",
    ],
    tr: [
      "Reklamımızı gördünüz, gerisi burada.",
      "Reklama tıkladıysanız, doğru yerdesiniz.",
      "Tıkladığınız reklam bu ürün içindi.",
    ],
    ru: [
      "Вы увидели нашу рекламу, вот подробности.",
      "Вы пришли по рекламе? Вот коротко.",
      "Реклама, которую вы видели, рассказывала об этом.",
    ],
    en: [
      "You saw our ad, so here is the rest.",
      "The ad you clicked was about this planner.",
      "You clicked on a sponsored post. Here is the product.",
    ],
  };
  for (const [lang, texts] of Object.entries(ADDRESSED)) {
    it(`${lang}: the reader's ad is flagged, on an agency's page too`, () => {
      for (const text of texts) {
        expect(flagged(lang, text, AD_AGENCY), text).toBe(true);
        expect(flagged(lang, text), text).toBe(true);
      }
    });
  }

  it("an agency's own lines about advertising pass", () => {
    for (const [lang, text] of [
      ["az", "Reklamdan gələn müştərilərinizi artırırıq."],
      ["az", "Reklam kampaniyanızı bir həftədə qururuq."],
      ["tr", "Reklamdan gelen müşterilerinizi artırıyoruz."],
      ["tr", "Reklam bütçenizi biz yönetiyoruz."],
      ["ru", "Клиенты пришли по рекламе и остались."],
      ["ru", "Настроим вашу рекламу за неделю."],
      ["en", "Advertising that small brands can afford."],
    ] as const) {
      expect(flagged(lang, text, AD_AGENCY), text).toBe(false);
    }
  });

  it("an ad word where the customer's own words have none is flagged", () => {
    expect(
      sourceAddressed("Reklamda dediyimiz kimi, sifarişlə istehsal edirik.", "az", MEDORA),
    ).toBe("Reklamda");
    expect(flagged("tr", "Reklamdaki fırsat burada.")).toBe(true);
    expect(flagged("ru", "Как в рекламе: производим под вашим брендом.")).toBe(true);
    expect(flagged("en", "As in the advertisement, we make it to order.")).toBe(true);
    // A complaint about goods is not an ad.
    expect(flagged("az", "Reklamasiya halında məhsulu dəyişirik.")).toBe(false);
    expect(flagged("tr", "Reklamasyon durumunda ürünü değiştiriyoruz.")).toBe(false);
    expect(flagged("ru", "Рекламация принимается в течение 14 дней.")).toBe(false);
    // Without the customer's own words only the reader's ad is read.
    expect(sourceAddressed("Reklam kampaniyası", "az")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The lint
// ---------------------------------------------------------------------------

const ctx = (ownWords: string | undefined, language = "az") => ({
  language,
  allowedNumbers: collectNumbers(["none"]),
  ...(ownWords === undefined ? {} : { ownWords }),
});
const bodyOf = (sections: Record<string, unknown>) => ({ sections }) as unknown as VariantBody;

describe("the lint flag", () => {
  it("is hard, on the part that says it, with the phrase alone", () => {
    const r = lintVariant(
      bodyOf({
        hero: {
          kind: "hero",
          headline: "Öz brendiniz üçün etibarlı əlavə istehsalçısı",
          body: "Süni intellektdən soruşdunuzsa, cavab budur: sifarişlə istehsal edirik.",
        },
        features: { kind: "features", headline: "İstehsal etdiyimiz əlavələr" },
      }),
      ctx(MEDORA),
    );
    expect(r.hard.filter((f) => f.rule === "source-addressed")).toEqual([
      { path: "hero.body", rule: "source-addressed", excerpt: "soruşdunuzsa", severity: "hard" },
    ]);
  });

  it("each length of a part is read on its own", () => {
    const r = lintVariant(
      bodyOf({
        hero: {
          kind: "hero",
          body: "Sifarişlə qida əlavələri hazırlayırıq, reseptdən qablaşdırmaya qədər.",
          body_alt: "ChatGPT-dən soruşdunuzsa, cavab budur.",
        },
      }),
      ctx(MEDORA),
    );
    expect(r.hard.filter((f) => f.rule === "source-addressed").map((f) => f.path)).toEqual([
      "hero.body_alt",
    ]);
  });

  it("the page's own parts count as the customer's own words", () => {
    const withPage = {
      ...ctx("A planning board for small teams."),
      language: "en",
      originalTexts: new Map([["hero.headline", "Plan the week with AI"]]),
    };
    const body = bodyOf({ hero: { kind: "hero", headline: "Let AI plan your week" } });
    expect(lintVariant(body, withPage).hard.map((f) => f.rule)).not.toContain("source-addressed");
    expect(
      lintVariant(body, { ...ctx("A planning board for small teams."), language: "en" }).hard.map(
        (f) => f.rule,
      ),
    ).toContain("source-addressed");
  });

  it("the customer's own words are the brief and the page's sentences", () => {
    const own = ownWordsFor(
      {
        product: "A planning board",
        icp: "Team leads",
        target_market: "Global",
        value_props: ["One board"],
        differentiators: ["Works with ChatGPT"],
        proof_points: [],
        per_intent_hints: { feature: "the AI summary" },
      },
      ["Plan the week in one calm place."],
    );
    expect(own).toContain("Works with ChatGPT");
    expect(own).toContain("the AI summary");
    expect(own).toContain("Plan the week in one calm place.");
  });

  it("its name may be sent in the ops summary, and the revise pass knows it", () => {
    expect(SENDABLE_RULES.has("source-addressed")).toBe(true);
    const revise = buildRevisePrompt("{}", [
      { path: "hero.body", rule: "source-addressed", excerpt: "soruşdunuzsa", severity: "hard" },
    ]);
    expect(revise).toContain('- hero.body: source-addressed ("soruşdunuzsa")');
    expect(revise).toContain("- source-addressed: the string speaks about where the reader came");
  });
});

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

describe("the source modifiers", () => {
  it("each one ends with the rule, and none asks for the source to be said", () => {
    for (const dim of GENERATED_SOURCE_DIMS) {
      const m = buildSourceModifier(dim);
      expect(m.endsWith(NEVER_SAY_THE_SOURCE), dim).toBe(true);
      // The words that invited it: the AI modifier's example of 2026-10-12
      // and before, the "stop scrolling" hook, the search bar.
      expect(m).not.toContain("If you found this via");
      expect(m).not.toContain("you were probably");
      expect(m).not.toContain("Here's the direct answer");
      expect(m).not.toContain("makes them stop scrolling");
      expect(m).not.toContain("search bar");
      expect(m).not.toMatch(/Acknowledge that they arrived/);
    }
    expect(buildSourceModifier("default")).toBe("");
  });

  it("no example in a modifier would be flagged by the lint it feeds", () => {
    // Quoted examples a model may copy: every one must pass the rule.
    for (const dim of GENERATED_SOURCE_DIMS) {
      const body = buildSourceModifier(dim).replace(NEVER_SAY_THE_SOURCE, "");
      for (const quoted of body.match(/"[^"]{4,}"/g) ?? []) {
        expect(sourceAddressed(quoted, "en", `${AI_PRODUCT} UX course`), quoted).toBeNull();
      }
    }
  });

  it("the paid modifier: one offer, one action, and never a price the others do not state", () => {
    expect(GENERATED_SOURCE_DIMS).toContain("paid");
    const m = buildSourceModifier("paid");
    expect(m).toContain("SOURCE MODIFIER: Paid visitor");
    expect(m).toContain("clicked a promise");
    expect(m).toContain("One offer, one action");
    expect(m).toContain(
      "Never a price, discount, offer or eligibility the other versions\n  do not state",
    );
    expect(m.endsWith(NEVER_SAY_THE_SOURCE)).toBe(true);
    for (const words of ["an ad", "a sponsored post", "a promotion"]) {
      expect(NEVER_SAY_THE_SOURCE.replace(/\s+/g, " ")).toContain(words);
    }
  });

  it("the cached rules say it once for every call, the part's own call included", () => {
    expect(CORE_QUALITY_RULES).toContain("9. NEVER SAY HOW THE READER ARRIVED.");
    expect(SOURCE_ADDRESSED_FIX).toContain("say nothing about where the reader came from");
  });
});

// ---------------------------------------------------------------------------
// The whole path: a model that insists
// ---------------------------------------------------------------------------

const PAGE = {
  "hero.headline": "Qida Əlavələri Sifarişlərdə Etibarlıq və Səriştə",
  "hero.body": "Sizin brendiniz üçün qida əlavələrini sifarişlə istehsal edirik.",
  "features.headline": "Sağlamlığınız üçün əlavələr",
} as const;
type Path = keyof typeof PAGE;
const SELECTORS: Record<Path, string> = {
  "hero.headline": "section.hero h1",
  "hero.body": "section.hero p.lead",
  "features.headline": "section.products h2",
};
const PLAIN = { icons: "none", emphasis: 0, split: false, animated_text: false } as const;
const MANIFEST: Manifest = Object.fromEntries(
  (Object.keys(PAGE) as Path[]).map((path) => [
    path,
    {
      css: [SELECTORS[path]],
      text: [PAGE[path].slice(0, 40)],
      structural: path,
      original_char_length: PAGE[path].length,
      original_word_count: PAGE[path].split(" ").length,
      inline: { ...PLAIN },
    },
  ]),
);

const GOOD = {
  "hero.headline": "Öz brendiniz üçün etibarlı əlavə istehsalçısı",
  "hero.body": "Reseptdən qablaşdırmaya qədər hər addımı yalnız bir heyət izləyir.",
  "features.headline": "İstehsal etdiyimiz əlavələr",
} as const;
/** 64 characters, like the page's own paragraph, and it speaks of the source. */
const ADDRESSED = "Süni intellektdən soruşdunuzsa, cavab budur: sifarişlə istehsal.";

function versionOf(prompt: string, parts: Record<string, string>) {
  const sections: Record<string, Record<string, unknown>> = {};
  for (const [path, text] of Object.entries(parts)) {
    const [section, field] = path.split(".") as [string, string];
    sections[section] = { ...(sections[section] ?? { kind: section }), [field]: text };
  }
  return JSON.stringify({
    customer_id: "medora",
    profile_key: `intent:${/"intent:(\w+)"/.exec(prompt)?.[1] ?? "problem"}`,
    sections,
    generated_at: 1,
    prompt_hash: "",
  });
}
const PART_CALL = "It cannot go on the page as it is";

function setup() {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    "INSERT INTO customers (id, slug, domain, plan, status, created_at, auto_approve, live_at) VALUES ('medora', 'medora', 'www.medora.test', 'pilot', 'active', 1, 1, 2)",
  ).run();
  db.prepare(
    `INSERT INTO business_dna (customer_id, product, icp, brand_voice, updated_at, value_props, differentiators, proof_points, target_market, target_language, per_intent_hints)
     VALUES ('medora', 'Qida əlavələrinin sifarişlə istehsalı', 'Öz brendi olan şirkətlər', 'sakit, dəqiq', 1, '["İstehsal"]', '["Fərdi formul"]', '["Sertifikat"]', 'Yerli bazar', 'az', '{}')`,
  ).run();
  db.prepare(
    "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('medora', '/', ?, 'https://www.medora.test/', 1, 1, 'az')",
  ).run(JSON.stringify(MANIFEST));
  const kv = makeKv();
  pageHtml = `<html lang="az"><body><main><section class="hero"><h1>${PAGE["hero.headline"]}</h1>
<p class="lead">${PAGE["hero.body"]}</p></section><section class="products"><h2>${PAGE["features.headline"]}</h2></section></main></body></html>`;
  return { env: { ...MODEL_ENV, DB: d1, VARIANTS: kv }, db, kv };
}

describe("problem:ai on Medora, the whole path", () => {
  it("a model that insists: the paragraph is left as the page built it, the rest ships", async () => {
    const { env, kv, db } = setup();
    let last = "";
    answerFor = (input) => {
      if (input.prompt.includes(PART_CALL)) return JSON.stringify({ text: ADDRESSED });
      if (input.prompt.includes("Revise the JSON object")) return last;
      if (!input.prompt.includes("profile_key")) return "{}";
      last = versionOf(input.prompt, { ...GOOD, "hero.body": ADDRESSED });
      return last;
    };
    const result = await regenerateOne("medora", "problem", "ai", env, "/");
    expect(result.ok).toBe(true);
    expect(result.parts_as_built).toEqual([{ path: "hero.body", rule: "source-addressed" }]);

    // The first prompt carried the modifier with the rule; the part's own
    // call carried the rule's instruction and the phrase that was read.
    const first = inputs.find((i) => i.prompt.includes("profile_key:"))?.prompt ?? "";
    expect(first).toContain("SOURCE MODIFIER: AI referral visitor");
    expect(first).toContain("NEVER SAY WHERE THE READER CAME FROM.");
    const part = inputs.find((i) => i.prompt.includes(PART_CALL))?.prompt ?? "";
    expect(part).toContain("- source-addressed:");
    expect(part).toContain("say nothing about where the reader came from");
    expect(part).toContain('"soruşdunuzsa" does');

    // No word of it reaches a visitor or the record of what was served.
    const served = kv.store.get("v1:variant:medora:problem:ai") ?? "";
    expect(served).not.toContain("soruşdunuz");
    expect(served).not.toContain("intellekt");
    expect((JSON.parse(served) as VariantBody).sections.hero?.body).toBeUndefined();
    expect((JSON.parse(served) as VariantBody).sections.hero?.headline).toBe(GOOD["hero.headline"]);
    const row = db.prepare("SELECT status, lint_flags FROM variants").get() as {
      status: string;
      lint_flags: string;
    };
    expect(row.status).toBe("ready");
    expect(row.lint_flags).toContain("part-as-built:hero.body:source-addressed");
    expect(row.lint_flags).not.toContain("soruşdunuz");
  });

  it("a model that takes the instruction: the paragraph is written", async () => {
    const { env, kv } = setup();
    let last = "";
    answerFor = (input) => {
      if (input.prompt.includes(PART_CALL)) return JSON.stringify({ text: GOOD["hero.body"] });
      if (input.prompt.includes("Revise the JSON object")) return last;
      if (!input.prompt.includes("profile_key")) return "{}";
      last = versionOf(input.prompt, { ...GOOD, "hero.body": ADDRESSED });
      return last;
    };
    const result = await regenerateOne("medora", "problem", "ai", env, "/");
    expect(result.ok).toBe(true);
    expect(result.parts_as_built).toEqual([]);
    const served = JSON.parse(kv.store.get("v1:variant:medora:problem:ai") ?? "{}") as VariantBody;
    expect(served.sections.hero?.body).toBe(GOOD["hero.body"]);
  });

  it("the page's own words back as a version are never refused by this rule", async () => {
    const { env } = setup();
    let last = "";
    answerFor = (input) => {
      if (input.prompt.includes("Revise the JSON object")) return last;
      if (!input.prompt.includes("profile_key")) return "{}";
      last = versionOf(input.prompt, GOOD);
      return last;
    };
    const result = await regenerateOne("medora", "problem", "ai", env, "/");
    expect(result.ok).toBe(true);
    expect(result.parts_as_built).toEqual([]);
    expect(result.provenance?.lint_flags.join(" ")).not.toContain("source-addressed");
  });
});
