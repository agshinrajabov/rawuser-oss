/**
 * The claims lock (docs/specs/claims-lock.md, lint/claims-lock.ts): three
 * hard rules for a customer whose site is about health, in az, en, ru and
 * tr; the prompt block; the road to part-as-built; and a customer that is
 * not sensitive left byte for byte as before.
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

const { claimsLockFlags, namesOf, CLAIMS_LOCK_FIX } = await import("../src/lint/claims-lock.ts");
const { lintVariant } = await import("../src/lint/index.ts");
const { regenerateOne, writtenParts, claimsLockFor } = await import("../src/orchestrator.ts");
const { buildDnaPreamble } = await import("../src/prompts/dna.ts");
const { CLAIMS_LOCK_RULES } = await import("../src/prompts/quality-rules.ts");
const { buildRevisePrompt } = await import("../src/prompts/revise.ts");
const { SENDABLE_RULES } = await import("../src/lib/lint-shares.ts");
const { lintFlagsOf } = await import("../src/lib/parts-as-built.ts");
const { resetPageLinks } = await import("../src/page-links.ts");
const { resetReads } = await import("../src/inline-shape-backfill.ts");
const { setRewrite } = await import("../src/lib/button-rewrite.ts");

beforeEach(() => {
  inputs = [];
  answerFor = () => "{}";
  resetPageLinks();
  resetReads();
});

// ---------------------------------------------------------------------------
// The rules, string by string
// ---------------------------------------------------------------------------

/** The pilot's own page, in four languages: GMP and "effective" are its own words. */
const PAGE_WORDS: Record<string, string> = {
  az: "Medora MMC qida əlavələri hazırlayır. Zavodumuz GMP və ISO 22000 üzrə sertifikat alıb və hər partiya AQTA nəzarətindən keçir. Təhlükəsiz və effektiv məhsullar. Sağlamlığınız üçün əlavələr. FERROSAMPLE no.60 kapsul.",
  en: "Medora makes dietary supplements. Our products are made in a GMP and ISO 22000 certified plant. Safe and effective products. Supplements for your health. FERROSAMPLE 60 capsules.",
  ru: "Medora производит пищевые добавки. Продукция выпускается на заводе, сертифицированном по GMP и ISO 22000. Безопасные и эффективные продукты. Добавки для вашего здоровья. FERROSAMPLE 60 капсул.",
  tr: "Medora gıda takviyeleri üretir. Ürünlerimiz GMP ve ISO 22000 sertifikalı tesiste üretilir. Güvenli ve etkili ürünler. Sağlığınız için takviyeler. FERROSAMPLE 60 kapsül.",
};

const rules = (lang: string, text: string, part?: { original?: string; originalLength?: number }) =>
  claimsLockFlags(text, lang, { pageWords: PAGE_WORDS[lang] ?? "" }, part).map((f) => f.rule);

describe("health-addressed: the reader's own health", () => {
  it("az: a question or a possessive about the reader's body fails; the product's ingredient passes", () => {
    for (const t of [
      "Yorğunsunuz? Bu əlavə sizin üçündür.",
      "Qaraciyəriniz üçün dəstək.",
      "İmmunitetinizi gücləndirmək üçün.",
      "Yuxunuz pozulubsa, bu kompleks kömək edir.",
      "Simptomlarınız varsa, bizə yazın.",
    ]) {
      expect(rules("az", t), t).toContain("health-addressed");
    }
    for (const t of [
      "Tərkibində dəmir və C vitamini olan kompleks.",
      "Öz brendiniz üçün qida əlavələrini sifarişlə istehsal edirik.",
      "Probleminizi necə həll edirik",
      "Qaraciyər üçün nəzərdə tutulmuş kompleks.",
    ]) {
      expect(rules("az", t), t).not.toContain("health-addressed");
    }
  });

  it("az: the page's own heading passes word for word and inside a longer line", () => {
    expect(rules("az", "Sağlamlığınız üçün əlavələr")).toEqual([]);
    expect(rules("az", "Sağlamlığınız üçün yoxlanılmış əlavələr")).toEqual([]);
    // Another possessive the page does not have is still read.
    expect(rules("az", "Sağlamlığınız və qaraciyəriniz üçün")).toEqual(["health-addressed"]);
  });

  it("en: 'tired?', 'your liver', 'if you suffer from' fail; the ingredient passes", () => {
    for (const t of [
      "Tired? This is for you.",
      "Support for your liver.",
      "If you suffer from poor sleep, start here.",
      "You're exhausted and need a boost.",
    ]) {
      expect(rules("en", t), t).toContain("health-addressed");
    }
    for (const t of [
      "A complex with iron and vitamin C.",
      "Your brand, our production line.",
      "Supplements for your health.",
      "A formula made for the liver.",
    ]) {
      expect(rules("en", t), t).not.toContain("health-addressed");
    }
  });

  it("ru: 'если у вас болит', 'ваша печень', 'вы устали' fail; the ingredient passes", () => {
    for (const t of [
      "Если у вас болит желудок, этот комплекс для вас.",
      "Поддержка для вашей печени.",
      "Вы устали? Начните с этого.",
      "У вас есть симптомы усталости?",
    ]) {
      expect(rules("ru", t), t).toContain("health-addressed");
    }
    for (const t of [
      "Комплекс с железом и витамином C.",
      "Ваш бренд, наше производство.",
      "Добавки для вашего здоровья.",
      "Формула для печени.",
    ]) {
      expect(rules("ru", t), t).not.toContain("health-addressed");
    }
  });

  it("tr: 'karaciğeriniz', 'yorgun musunuz', 'şikayetiniz varsa' fail; the ingredient passes", () => {
    for (const t of [
      "Karaciğeriniz için destek.",
      "Yorgun musunuz? Bu takviye sizin için.",
      "Şikayetiniz varsa bize yazın.",
      "Uykunuz bozuksa bu kompleks yardımcı olur.",
    ]) {
      expect(rules("tr", t), t).toContain("health-addressed");
    }
    for (const t of [
      "Demir ve C vitamini içeren kompleks.",
      "Markanız için üretim.",
      "Sağlığınız için takviyeler.",
      "Karaciğer için formül.",
    ]) {
      expect(rules("tr", t), t).not.toContain("health-addressed");
    }
  });

  it("a bare symptom question with no pronoun fails in every language; a product or company question passes", () => {
    const fails: Array<[string, string]> = [
      ["az", "Yorğunluq?"],
      ["az", "Yuxusuzluq? Bu kompleks sizin üçündür."],
      ["az", "Yorğunluq mu?"],
      ["az", "Yorğunluqmu?"],
      ["az", "Baş ağrısı?"],
      ["az", "Yorğunluq və yuxusuzluq?"],
      ["az", "Ağrılardan?"],
      ["en", "Fatigue?"],
      ["en", "Tired? No. Headaches?"],
      ["ru", "Усталость?"],
      ["ru", "Головная боль?"],
      ["tr", "Yorgunluk mu?"],
      ["tr", "Uykusuzluk?"],
      ["tr", "Baş ağrısı?"],
    ];
    for (const [lang, t] of fails)
      expect(rules(lang, t), `${lang}: ${t}`).toContain("health-addressed");
    const passes: Array<[string, string]> = [
      ["az", "Hansı məhsul?"],
      ["az", "Niyə Medora?"],
      ["az", "Ağrıkəsici?"],
      ["az", "Yorğunluq üçün nə edirik?"],
      ["az", "Yorğunluq."],
      ["az", "Sağlamlığınız üçün əlavələr?"],
      ["en", "Which product?"],
      ["en", "Why Medora?"],
      ["en", "Fatigue in the team?"],
      ["ru", "Какой продукт?"],
      ["ru", "Почему Medora?"],
      ["ru", "Больше?"],
      ["tr", "Hangi ürün?"],
      ["tr", "Neden Medora?"],
      ["tr", "Ağrı kesici mi?"],
    ];
    for (const [lang, t] of passes) expect(rules(lang, t), `${lang}: ${t}`).toEqual([]);
    // The page's own question passes.
    expect(
      claimsLockFlags("Yorğunluq?", "az", { pageWords: `${PAGE_WORDS.az} Yorğunluq?` }),
    ).toEqual([]);
  });

  it("a language without a table gets the English table only", () => {
    expect(rules("de", "Support for your liver.")).toContain("health-addressed");
    expect(rules("de", "Für Ihre Leber.")).toEqual([]);
  });
});

describe("claim-added: claims, doses, certificates and numbers the page does not make", () => {
  it("az: GMP, ISO, 'effektiv' and 60 are the page's; HACCP, 'müalicə edir', 'sübut olunmuş', a dose and 50 are not", () => {
    for (const t of [
      "GMP və ISO 22000 üzrə sertifikatlı zavod işi.",
      "Effektiv məhsullar, AQTA nəzarəti altında.",
      "60 kapsul, hər qutuda.",
    ]) {
      expect(rules("az", t), t).toEqual([]);
    }
    for (const t of [
      "HACCP sertifikatlı zavod.",
      "Bu əlavə xəstəliyi müalicə edir.",
      "Klinik sübut olunmuş formul.",
      "Gündə 500 mg qəbul edin.",
      "50-dən çox hazır formul.",
      "100% GMP standartları.",
    ]) {
      const r = rules("az", t);
      expect(r.length, t).toBeGreaterThan(0);
      expect(
        r.every((x) => x === "claim-added"),
        t,
      ).toBe(true);
    }
  });

  it("en: 'certified' and 'effective' are the page's; 'cures', 'clinically proven', 'approved', a dose fail", () => {
    expect(rules("en", "Made in a GMP certified plant, effective and safe.")).toEqual([]);
    for (const t of [
      "Cures fatigue in a week.",
      "Clinically proven formula.",
      "FDA approved.",
      "Take 500 mg a day.",
      "Over 50 formulas.",
    ]) {
      const r = rules("en", t);
      expect(r.length, t).toBeGreaterThan(0);
      expect(
        r.every((x) => x === "claim-added"),
        t,
      ).toBe(true);
    }
  });

  it("ru: 'сертифицированном' and 'эффективные' are the page's; 'лечит', 'одобрено', a dose fail", () => {
    expect(rules("ru", "Сертифицированное производство, эффективные продукты.")).toEqual([]);
    for (const t of [
      "Лечит усталость.",
      "Одобрено врачами.",
      "По 500 мг в день.",
      "Более 50 формул.",
    ]) {
      expect(rules("ru", t), t).toEqual(["claim-added"]);
    }
  });

  it("tr: 'sertifikalı' and 'etkili' are the page's; 'tedavi eder', 'onaylı', a dose fail", () => {
    expect(rules("tr", "Sertifikalı tesis, etkili ürünler.")).toEqual([]);
    for (const t of [
      "Hastalığı tedavi eder.",
      "Bakanlık onaylı.",
      "Günde 500 mg.",
      "50'den fazla formül.",
    ]) {
      expect(rules("tr", t), t).toEqual(["claim-added"]);
    }
  });

  it("names the claim it read, once, and a dose is not also a number", () => {
    const flags = claimsLockFlags("Gündə 500 mg, 500 mg.", "az", {
      pageWords: PAGE_WORDS.az ?? "",
    });
    expect(flags).toEqual([{ rule: "claim-added", excerpt: "500 mg" }]);
  });
});

describe("name-changed: the page's own names stay", () => {
  it("reads a capitalised or all-capitals token that does not open a sentence, never a title-case line", () => {
    expect(namesOf("Qida əlavələri üçün Medora istehsalı")).toEqual(["Medora"]);
    // A legal form is not a name of its own (2026-11-11).
    expect(namesOf("FERROSAMPLE no.60 kapsul, Medora MMC")).toEqual(["Medora"]);
    expect(namesOf("Qida Əlavələri Sifarişlərdə Etibarlıq və")).toEqual([]);
    expect(namesOf("Göndər")).toEqual([]);
    expect(namesOf("Sağlamlığınız üçün əlavələr")).toEqual([]);
    // The last token of a cut signature is skipped.
    expect(namesOf("Supplements made by Medora for your brand", 41)).toEqual(["Medora"]);
    expect(namesOf("Supplements made for brands by Medora MMC", 60)).toEqual(["Medora"]);
  });

  it("a legal form is not a name; the brand that opens the sentence is (2026-11-11)", () => {
    // The pilot's /products paragraph: `MMC` was the only name the rule read,
    // so nine of twenty-four versions had the paragraph left as built for
    // dropping the suffix, while dropping "Medora" itself passed.
    const ORIG = "Medora MMC olaraq onlarla növ qida əlavəsi hazırlayıb satırıq";
    expect(namesOf(ORIG)).toEqual([]);
    expect(namesOf(ORIG, undefined, "medora")).toEqual(["Medora"]);
    // The brand is read past its spelling, and a short label names nothing.
    expect(namesOf("Med-Ora MMC olaraq hazırlayırıq", undefined, "medora")).toEqual(["Med-Ora"]);
    expect(namesOf(ORIG, undefined, "az")).toEqual([]);
    // Every form we know, alone, is skipped.
    for (const f of ["MMC", "LLC", "GmbH", "OOO", "A.Ş", "Ltd"]) {
      expect(namesOf(`Brend ${f} istehsal edir`), f).toEqual([]);
    }

    const part = { original: ORIG, originalLength: ORIG.length };
    const lock = { pageWords: PAGE_WORDS.az ?? "", brand: "medora" };
    const flags = (t: string) => claimsLockFlags(t, "az", lock, part).map((f) => f.rule);
    // Was refused for the missing suffix, now written.
    expect(flags("Medora onlarla növ qida əlavəsi hazırlayıb satır")).toEqual([]);
    expect(flags("Medora MMC geniş çeşiddə istehsal edir")).toEqual([]);
    // The hole the suffix rule left open: the brand itself may not go.
    expect(flags("Onlarla növ qida əlavəsi hazırlayıb satırıq")).toEqual(["name-changed"]);
    // Without a brand the first word stays the sentence's, as before.
    expect(claimsLockFlags("Geniş çeşiddə istehsal edirik", "az", { pageWords: "" }, part)).toEqual(
      [],
    );
  });

  it("az, en, ru, tr: a name kept passes, with a suffix too; a changed or dropped one fails", () => {
    const part = { original: "Qida əlavələri üçün Medora istehsalı", originalLength: 36 };
    expect(rules("az", "Medora-in qida əlavələri istehsalı", part)).toEqual([]);
    expect(rules("az", "Medorain istehsalı", part)).toEqual([]);
    expect(rules("az", "Medora istehsalı", part)).toEqual([]);
    expect(rules("az", "Evamet istehsalı", part)).toEqual(["name-changed"]);
    expect(rules("az", "Qida əlavələri istehsalı", part)).toEqual(["name-changed"]);
    const en = { original: "Supplements made by Medora", originalLength: 26 };
    expect(rules("en", "Medora makes your supplements", en)).toEqual([]);
    expect(rules("en", "We make your supplements", en)).toEqual(["name-changed"]);
    const ru = { original: "Добавки от Medora для вашего бренда", originalLength: 35 };
    expect(rules("ru", "Medora делает добавки для бренда", ru)).toEqual([]);
    expect(rules("ru", "Мы делаем добавки для бренда", ru)).toEqual(["name-changed"]);
    const tr = { original: "Markanız için Medora üretimi", originalLength: 28 };
    expect(rules("tr", "Medora markanız için üretir", tr)).toEqual([]);
    expect(rules("tr", "Markanız için üretim", tr)).toEqual(["name-changed"]);
    // Without the part's original the rule is not read.
    expect(rules("az", "Qida əlavələri istehsalı")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The lint, the prompt, the lists
// ---------------------------------------------------------------------------

function body(sections: Record<string, Record<string, unknown>>): VariantBody {
  return {
    customer_id: "medora",
    profile_key: "intent:brand",
    sections,
    generated_at: 1,
    prompt_hash: "",
  } as VariantBody;
}

describe("lintVariant", () => {
  const HEALTH = body({
    hero: {
      kind: "hero",
      headline: "Qaraciyəriniz üçün dəstək",
      headline_alt: "Qaraciyəriniz üçün hər gün dəstək",
      body: "Sübut olunmuş formul, 50-dən çox məhsul.",
    },
  });
  const ctx = { language: "az", allowedNumbers: new Set(["50"]) };

  it("with the lock: hard flags on every length, by rule, with the phrase", () => {
    const r = lintVariant(HEALTH, { ...ctx, claimsLock: { pageWords: PAGE_WORDS.az ?? "" } });
    expect(r.hard.map((f) => [f.path, f.rule, f.excerpt])).toEqual([
      ["hero.headline", "health-addressed", "Qaraciyəriniz"],
      ["hero.headline_alt", "health-addressed", "Qaraciyəriniz"],
      ["hero.body", "claim-added", "Sübut olunmuş"],
      ["hero.body", "claim-added", "50"],
    ]);
  });

  it("without the lock: the same body, no lock flag, as before", () => {
    const r = lintVariant(HEALTH, ctx);
    expect(r.hard.filter((f) => /health|claim|name/.test(f.rule))).toEqual([]);
  });
});

const DNA = {
  product: "Qida əlavələrinin sifarişlə istehsalı",
  icp: "Öz brendi olan şirkətlər",
  target_market: "Yerli bazar",
  target_language: "az",
  brand_voice: "sakit, dəqiq",
  value_props: ["İstehsal"],
  differentiators: ["Fərdi formul"],
  proof_points: ["Sertifikat"],
  per_intent_hints: {},
} as unknown as Parameters<typeof buildDnaPreamble>[0];

describe("the prompt", () => {
  it("the preamble carries the block only with the lock; off, byte for byte as before", () => {
    const plain = buildDnaPreamble(DNA, ["Bir cümlə burada."]);
    expect(buildDnaPreamble(DNA, ["Bir cümlə burada."], { claimsLock: false })).toBe(plain);
    expect(buildDnaPreamble(DNA, ["Bir cümlə burada."], { href: true })).toBe(plain);
    expect(plain).not.toContain("CLAIMS LOCK");
    const locked = buildDnaPreamble(DNA, ["Bir cümlə burada."], { claimsLock: true });
    expect(locked).toContain(CLAIMS_LOCK_RULES);
    expect(locked).toContain("NEVER ABOUT THE READER'S");
    expect(locked).toContain("ADD NO CLAIM THE PAGE DOES NOT MAKE");
    expect(locked).toContain("KEEP NAMES AS WRITTEN");
    // The block sits after the writing rules and before the language layer.
    expect(locked.indexOf("=== WRITING RULES")).toBeLessThan(locked.indexOf("=== CLAIMS LOCK"));
    expect(locked.indexOf("=== CLAIMS LOCK")).toBeLessThan(locked.indexOf("=== AZƏRBAYCAN"));
    // Nothing else moved.
    expect(locked.replace(`\n\n${CLAIMS_LOCK_RULES}`, "")).toBe(plain);
  });

  it("the revise prompt carries the three fix lines only beside such a flag", () => {
    const other = buildRevisePrompt("{}", [
      { path: "hero.body", rule: "length-drift", excerpt: "x", severity: "hard" },
    ]);
    expect(other).not.toContain("health-addressed");
    expect(other).not.toContain("claim-added");
    expect(other).not.toContain("name-changed");
    const locked = buildRevisePrompt("{}", [
      { path: "hero.body", rule: "claim-added", excerpt: "500 mg", severity: "hard" },
    ]);
    expect(locked).toContain(
      "- claim-added: the quoted claim, dose, certificate, approval or number",
    );
    expect(locked).toContain("- health-addressed:");
    expect(locked).toContain("- name-changed:");
  });

  it("the three rules are sendable in the daily summary and have a fix line each", () => {
    for (const rule of ["health-addressed", "claim-added", "name-changed"]) {
      expect(SENDABLE_RULES.has(rule), rule).toBe(true);
      expect(CLAIMS_LOCK_FIX[rule], rule).toBeTruthy();
    }
  });

  it("claimsLockFor: the page's text and the originals for a sensitive customer, nothing for another", () => {
    const manifest = {
      "hero.headline": { css: ["h1"], text: ["Medora istehsalı"], structural: "h1" },
    } as unknown as Manifest;
    expect(claimsLockFor(false, "page", manifest)).toBeUndefined();
    expect(claimsLockFor(true, "page text", manifest)).toEqual({
      pageWords: "page text\nMedora istehsalı",
      brand: "",
    });
    expect(claimsLockFor(true, "page text", manifest, "www.medora.test")?.brand).toBe("medora");
  });
});

// ---------------------------------------------------------------------------
// The road: revise, the part's own call, then left as built
// ---------------------------------------------------------------------------

const PAGE = {
  "hero.headline": "Qida Əlavələri Sifarişlərdə Etibarlıq və Səriştə",
  "hero.body": "Sizin brendiniz üçün qida əlavələrini sifarişlə istehsal edirik.",
  "hero.cta.label": "Məhsullarımızla tanış olun!",
  "features.headline": "Sağlamlığınız üçün əlavələr",
  "forms.submit_label": "Göndər",
} as const;

const SELECTORS: Record<keyof typeof PAGE, string> = {
  "hero.headline": "section.hero h1",
  "hero.body": "section.hero p.lead",
  "hero.cta.label": "section.hero a.btn",
  "features.headline": "section.products h2",
  "forms.submit_label": "form.contact button",
};

const html = () =>
  `<html lang="az"><body><main><section class="hero"><h1>${PAGE["hero.headline"]}</h1>
<p class="lead">${PAGE["hero.body"]}</p><a class="btn" href="https://www.medora.test/products">${PAGE["hero.cta.label"]}</a></section>
<section class="products"><h2>${PAGE["features.headline"]}</h2><p>Əlavələrimiz GMP qaydaları ilə, öz zavodumuzda hazırlanır.</p></section>
<form class="contact"><button type="submit">${PAGE["forms.submit_label"]}</button></form></main></body></html>`;

const PLAIN = { icons: "none", emphasis: 0, split: false, animated_text: false } as const;

function manifestOf(): Manifest {
  const out: Manifest = {};
  for (const path of Object.keys(PAGE) as Array<keyof typeof PAGE>) {
    const text = PAGE[path];
    out[path] = {
      css: [SELECTORS[path]],
      text: [text.slice(0, 40)],
      structural: path,
      original_char_length: text.length,
      original_word_count: text.split(" ").length,
      inline: { ...PLAIN },
    };
  }
  return Object.keys(out).reduce((m, path) => setRewrite(m, path, true) ?? m, out);
}

/** A version that passes every rule, the lock included: GMP is the page's own word. */
const GOOD = {
  "hero.headline": "Öz brendiniz üçün etibarlı əlavə istehsalçısı",
  "hero.body": "GMP standartlarına uyğun hazırlıq, reseptdən qablaşdırmaya qədər.",
  "hero.cta.label": "Məhsullarımıza baxın",
  "features.headline": "İstehsal etdiyimiz əlavələr",
  "forms.submit_label": "Göndərin",
} as const;

/** The reader's own liver, 63 characters for the page's 64: no length rule fires. */
const LIVER = "Qaraciyəriniz üçün hazırlanan əlavələri sifarişlə istehsal edirik.";

type Parts = Partial<Record<keyof typeof PAGE, string>>;

function sectionsOf(parts: Parts): Record<string, unknown> {
  const sections: Record<string, Record<string, unknown>> = {};
  for (const [path, text] of Object.entries(parts)) {
    const [section, ...rest] = path.split(".");
    const node = sections[section as string] ?? { kind: section };
    sections[section as string] = node;
    if (rest.length === 1) node[rest[0] as string] = text;
    else
      node[rest[0] as string] = {
        ...(node[rest[0] as string] as object),
        [rest[1] as string]: text,
      };
  }
  return sections;
}

const versionOf = (prompt: string, parts: Parts) =>
  JSON.stringify({
    customer_id: "medora",
    profile_key: `intent:${/"intent:(\w+)"/.exec(prompt)?.[1] ?? "brand"}`,
    sections: sectionsOf(parts),
    generated_at: 1,
    prompt_hash: "",
  });

const PART_CALL = "It cannot go on the page as it is";
const partCalls = () => inputs.filter((i) => i.prompt.includes(PART_CALL));
const reviseCalls = () => inputs.filter((i) => i.prompt.includes("Revise the JSON object"));

function modelWriting(parts: Parts, mend: (prompt: string) => string) {
  let last = "";
  answerFor = (input) => {
    if (input.prompt.includes(PART_CALL)) return JSON.stringify({ text: mend(input.prompt) });
    if (input.prompt.includes("Revise the JSON object")) return last;
    if (input.prompt.includes("profile_key")) {
      last = versionOf(input.prompt, parts);
      return last;
    }
    return "{}";
  };
}

function setup(sensitive: 0 | 1) {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    "INSERT INTO customers (id, slug, domain, plan, status, created_at, auto_approve, live_at, sensitive) VALUES ('medora', 'medora', 'www.medora.test', 'pilot', 'active', 1, 1, 2, ?)",
  ).run(sensitive);
  db.prepare(
    `INSERT INTO business_dna (customer_id, product, icp, brand_voice, updated_at, value_props, differentiators, proof_points, target_market, target_language, per_intent_hints)
     VALUES ('medora', 'Qida əlavələrinin sifarişlə istehsalı', 'Öz brendi olan şirkətlər', 'sakit, dəqiq', 1, '["İstehsal"]', '["Fərdi formul"]', '["Sertifikat"]', 'Yerli bazar', 'az', '{}')`,
  ).run();
  db.prepare(
    "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('medora', '/', ?, 'https://www.medora.test/', 1, 1, 'az')",
  ).run(JSON.stringify(manifestOf()));
  db.prepare(
    `INSERT INTO conversion_targets (id, customer_id, section_path, label, conversion_label, enabled, css_selectors, text_selectors, structural_selector, created_at, updated_at)
     VALUES ('t1', 'medora', 'hero.cta.label', 'Hero button', 'other', 1, '[]', '[]', '', 1, 1)`,
  ).run();
  const kv = makeKv();
  pageHtml = html();
  return { env: { ...MODEL_ENV, DB: d1, VARIANTS: kv }, db, kv };
}

const KEY = "v1:variant:medora:brand:community";

describe("a sensitive customer, the hero paragraph about the reader's liver", () => {
  it("revise, the part's own call, then the paragraph is left as built and the version ships", async () => {
    const { env, db, kv } = setup(1);
    modelWriting({ ...GOOD, "hero.body": LIVER }, () => LIVER);
    const result = await regenerateOne("medora", "brand", "community", env, "/");

    expect(result.ok).toBe(true);
    expect(result.parts_as_built).toEqual([{ path: "hero.body", rule: "health-addressed" }]);
    // The preamble carries the lock; the revise and the part's call name the rule.
    expect(inputs[0]?.cachedPreamble).toContain("=== CLAIMS LOCK");
    expect(reviseCalls()).toHaveLength(2);
    expect(reviseCalls()[0]?.prompt).toContain('hero.body: health-addressed ("Qaraciyəriniz")');
    expect(reviseCalls()[0]?.prompt).toContain("- health-addressed: the string states or asks");
    expect(partCalls()).toHaveLength(1);
    expect(partCalls()[0]?.prompt).toContain(CLAIMS_LOCK_FIX["health-addressed"]);

    // Served without the paragraph; the page keeps its own words there.
    const served = JSON.parse(kv.store.get(KEY) ?? "{}") as VariantBody;
    expect(writtenParts(served.sections as unknown as Record<string, unknown>).sort()).toEqual([
      "features.headline",
      "forms.submit_label",
      "hero.cta.label",
      "hero.headline",
    ]);
    expect(served.sections.hero?.body).toBeUndefined();
    const row = db.prepare("SELECT status, error_reason, lint_flags FROM variants").get() as {
      status: string;
      error_reason: string | null;
      lint_flags: string;
    };
    expect(row.status).toBe("ready");
    expect(row.error_reason).toBeNull();
    expect(lintFlagsOf(row.lint_flags)).toContain("part-as-built:hero.body:health-addressed");
    // The failing text is nowhere.
    const everything = [...kv.store.values(), JSON.stringify(row)].join("\n");
    expect(everything).not.toContain("Qaraciyəriniz");
  });

  it("a model that mends the paragraph on its own call: the version ships whole", async () => {
    const { env, kv } = setup(1);
    modelWriting({ ...GOOD, "hero.body": LIVER }, () => GOOD["hero.body"]);
    const result = await regenerateOne("medora", "brand", "community", env, "/");
    expect(result.ok).toBe(true);
    expect(result.parts_as_built ?? []).toEqual([]);
    const served = JSON.parse(kv.store.get(KEY) ?? "{}") as VariantBody;
    expect(served.sections.hero?.body).toBe(GOOD["hero.body"]);
  });

  it("the same page and the same answer with the flag off: no lock in the prompt, no flag, the paragraph ships", async () => {
    const { env, db, kv } = setup(0);
    modelWriting({ ...GOOD, "hero.body": LIVER }, () => LIVER);
    const result = await regenerateOne("medora", "brand", "community", env, "/");
    expect(result.ok).toBe(true);
    expect(result.parts_as_built ?? []).toEqual([]);
    expect(inputs[0]?.cachedPreamble).not.toContain("CLAIMS LOCK");
    expect(reviseCalls().every((c) => !c.prompt.includes("health-addressed"))).toBe(true);
    const served = JSON.parse(kv.store.get(KEY) ?? "{}") as VariantBody;
    expect(served.sections.hero?.body).toBe(LIVER);
    const row = db.prepare("SELECT lint_flags FROM variants").get() as { lint_flags: string };
    expect(lintFlagsOf(row.lint_flags).some((f) => /health|claim|name/.test(f))).toBe(false);
  });
});
