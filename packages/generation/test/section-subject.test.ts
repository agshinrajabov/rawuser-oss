/**
 * A heading that labels what is under it keeps its subject (A3 of
 * docs/specs/pilot-gaps.md; lint/section-subject.ts).
 *
 * Live on the pilot's site the section heading "Sağlamlığınız üçün əlavələr" sits over
 * the product grid, and versions wrote "Probleminizi necə həll edirik",
 * "Qiymətləndirmə meyarları", "Sifarişdə etibarlıq və səriştə" over the
 * same grid. The fixture is those headings. The rule is soft: it is counted
 * here and on real rows before it may refuse anything.
 */
import type { Manifest, VariantBody } from "@rawuser/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeKv, makeSqliteD1 } from "./admin/sqlite-d1.ts";
import { MODEL_ENV } from "./model-env.ts";

interface ModelInput {
  prompt: string;
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

const { isSectionHeadingPath, keepsSectionSubject, sectionSubjectsOf } = await import(
  "../src/lint/section-subject.ts"
);
const { lintVariant, collectNumbers } = await import("../src/lint/index.ts");
const { sectionHeadingsBlock, buildIntentPrompt } = await import(
  "../src/prompts/intent-prompts.ts"
);
const { buildRevisePrompt } = await import("../src/prompts/revise.ts");
const { SENDABLE_RULES } = await import("../src/lib/lint-shares.ts");
const { regenerateOne } = await import("../src/orchestrator.ts");
const { resetPageLinks } = await import("../src/page-links.ts");
const { resetReads } = await import("../src/inline-shape-backfill.ts");

beforeEach(() => {
  inputs = [];
  answerFor = () => "{}";
  resetPageLinks();
  resetReads();
});

/** The page's own heading over the product grid. */
const OWN = "Sağlamlığınız üçün əlavələr";
/** What versions wrote over the same grid (the reads of 2026-10-12). */
const LIVE = [
  "Probleminizi necə həll edirik",
  "Hər məsələni addım-addım həll edirik",
  "Qiymətləndirmə meyarları",
  "Sifarişdə etibarlıq və səriştə",
];
/** Headings that change the angle and still name the grid. */
const KEPT = [
  "İstehsal etdiyimiz əlavələr",
  "Brendiniz üçün hazırladığımız əlavələr",
  "Əlavələrimiz necə seçilir",
  "Sağlamlıq üçün seçilmiş məhsullar",
  "Hər ehtiyac üçün qida əlavəsi",
];

describe("Medora's heading over the product grid", () => {
  const subjects = sectionSubjectsOf(OWN, "az");

  it("its subject is its content words, as stems", () => {
    expect(subjects).toEqual([
      { word: "sağlamlığınız", stem: "sağlamliğ" },
      { word: "əlavələr", stem: "əlavə" },
    ]);
  });

  it("the four headings read live name something else: 4 of 4 flagged", () => {
    const flagged = LIVE.filter((h) => !keepsSectionSubject(h, subjects));
    expect(flagged).toEqual(LIVE);
  });

  it("a heading that keeps one of the two words, in any form, passes: 0 of 5 flagged", () => {
    const flagged = KEPT.filter((h) => !keepsSectionSubject(h, subjects));
    expect(flagged).toEqual([]);
    // The page's own heading too.
    expect(keepsSectionSubject(OWN, subjects)).toBe(true);
  });
});

describe("which headings the rule reads", () => {
  it("the headline of a section, never the hero's, never the closing call to action's", () => {
    expect(isSectionHeadingPath("features.headline")).toBe(true);
    expect(isSectionHeadingPath("features_core.headline")).toBe(true);
    expect(isSectionHeadingPath("pricing.headline")).toBe(true);
    expect(isSectionHeadingPath("social_proof.headline")).toBe(true);
    expect(isSectionHeadingPath("hero.headline")).toBe(false);
    expect(isSectionHeadingPath("cta.headline")).toBe(false);
    expect(isSectionHeadingPath("features.body")).toBe(false);
    expect(isSectionHeadingPath("hero.cta.label")).toBe(false);
  });

  it("a heading with no subject of its own says nothing", () => {
    for (const [lang, heading] of [
      ["en", "How it works"],
      ["en", "Why us"],
      ["az", "Niyə biz"],
      ["az", "Necə işləyirik"],
      ["ru", "Почему мы"],
      ["tr", "Neden biz"],
    ] as const) {
      expect(sectionSubjectsOf(heading, lang), heading).toEqual([]);
    }
    // A language without a stop list: a verb would be read as a subject.
    expect(sectionSubjectsOf("Unsere Leistungen", "de")).toEqual([]);
    expect(sectionSubjectsOf(undefined, "az")).toEqual([]);
  });

  it("a word the action tables know is a heading's subject all the same", () => {
    // "Qiymətlər" over a price table: for a button it is an action word, here it is the label.
    const prices = sectionSubjectsOf("Qiymətlər", "az");
    expect(prices.map((s) => s.stem)).toEqual(["qiymət"]);
    expect(keepsSectionSubject("Sizə uyğun qiymət", prices)).toBe(true);
    expect(keepsSectionSubject("Niyə bizi seçirlər", prices)).toBe(false);
  });

  it("the other languages", () => {
    const en = sectionSubjectsOf("Our services", "en");
    expect(en.map((s) => s.stem)).toEqual(["servic"]);
    expect(keepsSectionSubject("Services for agencies", en)).toBe(true);
    expect(keepsSectionSubject("What you get on day one", en)).toBe(false);
    const ru = sectionSubjectsOf("Наши продукты", "ru");
    expect(keepsSectionSubject("Продукция для вашего бренда", ru)).toBe(true);
    expect(keepsSectionSubject("Как мы решаем задачу", ru)).toBe(false);
    const tr = sectionSubjectsOf("Ürünlerimiz", "tr");
    expect(keepsSectionSubject("Markanız için ürünler", tr)).toBe(true);
    expect(keepsSectionSubject("Sorununuzu nasıl çözüyoruz", tr)).toBe(false);
  });

  it("a signature cut at forty characters: its last word is not read", () => {
    const long = "Gündəlik enerjiniz, yuxunuz və sağlamlığınız üçün əlavələr";
    const signature = long.slice(0, 40);
    expect(signature).toBe("Gündəlik enerjiniz, yuxunuz və sağlamlığ");
    const subjects = sectionSubjectsOf(signature, "az").map((s) => s.word);
    expect(subjects).toEqual(["gündəlik", "enerjiniz", "yuxunuz"]);
  });
});

// ---------------------------------------------------------------------------
// The lint
// ---------------------------------------------------------------------------

const ctx = {
  language: "az",
  allowedNumbers: collectNumbers(["none"]),
  originalTexts: new Map([
    ["features.headline", OWN],
    ["hero.headline", "Qida Əlavələri Sifarişlərdə Etibarlıq"],
  ]),
};
const bodyOf = (sections: Record<string, unknown>) => ({ sections }) as unknown as VariantBody;
const subjectFlags = (r: ReturnType<typeof lintVariant>) => ({
  hard: r.hard.filter((f) => f.rule === "section-subject-changed").map((f) => f.path),
  soft: r.soft.filter((f) => f.rule === "section-subject-changed").map((f) => f.path),
});

describe("the lint flag", () => {
  it("is soft, on the heading, with the words to keep", () => {
    const r = lintVariant(
      bodyOf({
        hero: { kind: "hero", headline: "Probleminizi biz həll edirik" },
        features: { kind: "features", headline: "Probleminizi necə həll edirik" },
      }),
      ctx,
    );
    expect(subjectFlags(r)).toEqual({ hard: [], soft: ["features.headline"] });
    const flag = r.soft.find((f) => f.rule === "section-subject-changed");
    expect(flag?.excerpt).toBe(
      `"Probleminizi necə həll edirik" names something else than the page's "${OWN}", which labels what is under it: keep "sağlamlığınız" or "əlavələr", in any form of the word, and change the angle around it`,
    );
  });

  it("the hero's headline changes its subject freely", () => {
    const r = lintVariant(
      bodyOf({ hero: { kind: "hero", headline: "Probleminizi biz həll edirik" } }),
      ctx,
    );
    expect(subjectFlags(r)).toEqual({ hard: [], soft: [] });
  });

  it("each length is read on its own", () => {
    const r = lintVariant(
      bodyOf({
        features: {
          kind: "features",
          headline: "İstehsal etdiyimiz əlavələr",
          headline_alt: "Brendiniz üçün istehsal etdiyimiz əlavələr",
          headline_alt2: "Necə işləyirik",
        },
      }),
      ctx,
    );
    expect(subjectFlags(r)).toEqual({ hard: [], soft: ["features.headline_alt2"] });
  });

  it("over the fixture: the four live headings are flagged, the five kept ones are not", () => {
    const count = (headings: readonly string[]) =>
      headings.filter(
        (headline) =>
          subjectFlags(lintVariant(bodyOf({ features: { kind: "features", headline } }), ctx)).soft
            .length > 0,
      ).length;
    expect(count(LIVE)).toBe(4);
    expect(count(KEPT)).toBe(0);
  });

  it("without the page's own heading nothing is said", () => {
    const r = lintVariant(
      bodyOf({ features: { kind: "features", headline: "Probleminizi necə həll edirik" } }),
      { language: "az", allowedNumbers: collectNumbers(["none"]) },
    );
    expect(subjectFlags(r)).toEqual({ hard: [], soft: [] });
  });

  it("its name may be sent in the ops summary, and the revise pass knows it", () => {
    expect(SENDABLE_RULES.has("section-subject-changed")).toBe(true);
    expect(buildRevisePrompt("{}", [])).toContain(
      "- section-subject-changed: this heading labels the content under it",
    );
  });
});

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

const PLAIN = { icons: "none", emphasis: 0, split: false, animated_text: false } as const;
const part = (css: string, text: string) => ({
  css: [css],
  text: [text.slice(0, 40)],
  structural: css,
  original_char_length: text.length,
  original_word_count: text.split(" ").length,
  inline: { ...PLAIN },
});
const MANIFEST: Manifest = {
  "hero.headline": part("section.hero h1", "Qida Əlavələri Sifarişlərdə Etibarlıq və Səriştə"),
  "hero.body": part(
    "section.hero p.lead",
    "Sizin brendiniz üçün qida əlavələrini sifarişlə istehsal edirik.",
  ),
  "features.headline": part("section.products h2", OWN),
};

describe("the prompt", () => {
  it("names each section heading with the words to keep, never the hero's", () => {
    const block = sectionHeadingsBlock(MANIFEST, "az");
    expect(block).toContain("SECTION HEADINGS LABEL WHAT IS UNDER THEM.");
    expect(block).toContain(
      `- features.headline (the page's own says "${OWN}"): keep "sağlamlığınız" or "əlavələr", in any form of the word, and change the angle around it.`,
    );
    expect(block).not.toContain("hero.headline");
  });

  it("is in the version's prompt, and absent on a page with no such heading", () => {
    const dna = {
      customer_id: "medora",
      product: "Qida əlavələri",
      icp: "Brendlər",
      brand_voice: "sakit",
      value_props: ["İstehsal"],
      differentiators: [],
      proof_points: [],
      target_market: "Yerli bazar",
      target_language: "az",
      per_intent_hints: {},
      updated_at: 1,
    };
    expect(buildIntentPrompt("problem", dna, "medora", MANIFEST)).toContain(
      "SECTION HEADINGS LABEL WHAT IS UNDER THEM.",
    );
    const { "features.headline": _h, ...heroOnly } = MANIFEST;
    expect(buildIntentPrompt("problem", dna, "medora", heroOnly)).not.toContain(
      "SECTION HEADINGS LABEL",
    );
    expect(sectionHeadingsBlock(heroOnly, "az")).toBe("");
    // A language without a stop list reads no subject: no block.
    expect(sectionHeadingsBlock(MANIFEST, "de")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The whole path
// ---------------------------------------------------------------------------

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
const GOOD = {
  "hero.headline": "Öz brendiniz üçün etibarlı əlavə istehsalçısı",
  "hero.body": "Reseptdən qablaşdırmaya qədər hər addımı yalnız bir heyət izləyir.",
  "features.headline": "İstehsal etdiyimiz əlavələr",
};

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
  pageHtml = `<html lang="az"><body><main><section class="hero"><h1>Qida Əlavələri Sifarişlərdə Etibarlıq və Səriştə</h1>
<p class="lead">Sizin brendiniz üçün qida əlavələrini sifarişlə istehsal edirik.</p></section><section class="products"><h2>${OWN}</h2></section></main></body></html>`;
  return { env: { ...MODEL_ENV, DB: d1, VARIANTS: kv }, db, kv };
}
const flagsOf = (db: ReturnType<typeof setup>["db"]) =>
  (db.prepare("SELECT status, lint_flags FROM variants").get() as {
    status: string;
    lint_flags: string | null;
  }) ?? { status: "", lint_flags: null };

describe("problem on Medora, the whole path", () => {
  it("a model that keeps the other subject: the version ships, the row says so, the revise pass was told", async () => {
    const { env, db, kv } = setup();
    let last = "";
    answerFor = (input) => {
      if (input.prompt.includes("Revise the JSON object")) return last;
      if (!input.prompt.includes("profile_key")) return "{}";
      last = versionOf(input.prompt, { ...GOOD, "features.headline": LIVE[0] as string });
      return last;
    };
    const result = await regenerateOne("medora", "problem", "default", env, "/");
    // Soft: nothing is refused and no part is left as built for it.
    expect(result.ok).toBe(true);
    expect(result.parts_as_built).toEqual([]);
    expect(flagsOf(db).status).toBe("ready");
    expect(flagsOf(db).lint_flags).toContain("section-subject-changed");
    const served = JSON.parse(kv.store.get("v1:variant:medora:problem:default") ?? "{}");
    expect(served.sections.features.headline).toBe(LIVE[0]);

    const first = inputs.find((i) => i.prompt.includes("profile_key:"))?.prompt ?? "";
    expect(first).toContain("SECTION HEADINGS LABEL WHAT IS UNDER THEM.");
    const revise = inputs.find((i) => i.prompt.includes("Revise the JSON object"))?.prompt ?? "";
    expect(revise).toContain("- features.headline: section-subject-changed");
    expect(revise).toContain('keep "sağlamlığınız" or "əlavələr"');
  });

  it("a model that takes the revise pass: the heading names the grid and the flag is gone", async () => {
    const { env, db, kv } = setup();
    answerFor = (input) => {
      if (input.prompt.includes("Revise the JSON object")) return versionOf(input.prompt, GOOD);
      if (!input.prompt.includes("profile_key")) return "{}";
      return versionOf(input.prompt, { ...GOOD, "features.headline": LIVE[0] as string });
    };
    const result = await regenerateOne("medora", "problem", "default", env, "/");
    expect(result.ok).toBe(true);
    expect(flagsOf(db).lint_flags ?? "").not.toContain("section-subject-changed");
    const served = JSON.parse(kv.store.get("v1:variant:medora:problem:default") ?? "{}");
    expect(served.sections.features.headline).toBe(GOOD["features.headline"]);
  });
});
