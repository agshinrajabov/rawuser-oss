/**
 * The first outside pilot (the pilot's site, 2026-10-12, docs/specs/pilot-gaps.md
 * A1 and A2). The counted hero button "Məhsullarımızla tanış olun!" goes to
 * https://medora.test/products. Five of its version labels asked for a
 * conversation, a consultation or a start, shipped without a
 * `cta-action-changed` flag, and 19 of 20 bodies carried an href the page
 * does not have.
 *
 * Why the lint was silent: the tables read neither "tanış olun" nor
 * "/products", so the button had no kind at all, and the rule skipped a
 * button without a kind before it ever looked at the version's label. The
 * labels are production's, the page below is built from the facts of the
 * read (label, link, language), not a copy of the site.
 */
import type { Manifest, VariantBody } from "@rawuser/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  // The live page, read by the generation run (inline-shape-backfill.ts).
  fetchPageHtml: vi.fn(async () => pageHtml),
}));

const { ctaKindOfWords, ctaKindOfHref, ctaFactsOf, ctaKindsOfSiteKind, KEEP_OWN_ACTION } =
  await import("../src/lint/cta-action.ts");
const { lintVariant, collectNumbers } = await import("../src/lint/index.ts");
const { ctasOf, fixLabels, asksHref, orchestrate, parseAndValidate } = await import(
  "../src/orchestrator.ts"
);
const { readButtonHrefs, resetPageLinks } = await import("../src/page-links.ts");
const { resetReads } = await import("../src/inline-shape-backfill.ts");
const { setRewrite } = await import("../src/lib/button-rewrite.ts");
const { linkKindsFrom, loadLinkKinds, LINK_KINDS_SQL } = await import(
  "../src/site-map/link-kinds.ts"
);
const { buttonsBlock, hrefLine, buildIntentPrompt } = await import(
  "../src/prompts/intent-prompts.ts"
);
const { buildDnaPreamble } = await import("../src/prompts/dna.ts");

beforeEach(() => {
  inputs = [];
  answerFor = () => "{}";
  resetPageLinks();
  resetReads();
});

const OWN = "Məhsullarımızla tanış olun!";
const LINK = "https://medora.test/products";
const PATH = "hero.cta.label";

const pageWith = (label: string, href: string | null) =>
  `<html lang="az"><body><main><section class="hero"><h1>Sağlamlığınız üçün əlavələr</h1>
<a class="hero-btn"${href === null ? "" : ` href="${href}"`}>${label}</a></section></main></body></html>`;

/**
 * The hero button as the quickstart stored it, with its rewrite turned on by
 * the operator (lib/button-rewrite.ts): these rules are what protect a
 * button that is on. Off, the button is in no version at all.
 */
const manifestWith = (label: string): Manifest =>
  setRewrite(
    {
      [PATH]: {
        css: ["section.hero a.hero-btn"],
        text: [label],
        structural: "primary button in the hero section",
        original_char_length: label.length,
        conversion_candidate: true,
        inline: { icons: "none", emphasis: 0, split: false, animated_text: false },
      },
    },
    PATH,
    true,
  ) as Manifest;

const MANIFEST = manifestWith(OWN);
const COUNTED = new Set([PATH]);

/** The five labels that shipped (three rows carried the first). */
const BAD = [
  "Probleminizi bizə danışın",
  "Pulsuz məsləhət üçün yazın",
  "Layihəniz üçün əlaqə saxlayın",
  "Çevik formul üçün müraciət edin",
  "Layihənizə indi başlayın",
];
/** The nine that kept a reading action. */
const GOOD = [
  "İstehsal imkanlarımıza baxın",
  "Qablaşma prosesimizlə tanış olun",
  "İstehsal meyarlarını öyrən",
  "İstehsal imkanlarını araşdır",
  "İstehsal prosesinə baxın",
  "İstehsal meyarlarını öyrənin",
  "İstehsal imkanlarını öyrənin",
  "Məhsullarımıza baxın",
  "Qablaşma xidmətlərimizlə tanış olun",
];

const body = (label: string): VariantBody =>
  ({ sections: { hero: { kind: "hero", cta: { label } } } }) as unknown as VariantBody;

const ctxFor = (manifest: Manifest, ctas: ReturnType<typeof ctasOf>, language = "az") => ({
  language,
  allowedNumbers: collectNumbers(["none"]),
  originalLengths: new Map([[PATH, manifest[PATH]?.original_char_length ?? 0]]),
  originalTexts: new Map([[PATH, manifest[PATH]?.text[0] ?? ""]]),
  ctas,
});

const actionFlags = (r: ReturnType<typeof lintVariant>) => ({
  hard: r.hard.filter((f) => f.rule === "cta-action-changed").map((f) => f.path),
  soft: r.soft.filter((f) => f.rule === "cta-action-changed").map((f) => f.path),
});

describe("the words that were missing (A1.2)", () => {
  it("reads the page's own label and its link's words as the read found them", () => {
    expect(ctaKindOfWords(OWN)).toBe("learn");
    // The link's own words still say nothing: the site map answers (A1.3).
    expect(ctaKindOfHref(LINK)).toBeNull();
  });

  it.each([
    // Azerbaijani: the families the pilot's labels used.
    ["Probleminizi bizə danışın", "contact"],
    ["Layihəni danışaq", "contact"],
    ["Pulsuz məsləhət üçün yazın", "contact"],
    ["Bizə yazaq", "contact"],
    ["Çevik formul üçün müraciət edin", "contact"],
    ["Müraciət et", "contact"],
    ["Pulsuz məsləhət al", "contact"],
    ["Zəng edin", "contact"],
    ["Layihəniz üçün əlaqə saxlayın", "contact"],
    ["Layihənizə indi başlayın", "start"],
    ["Kursa yazıl", "start"],
    ["Sifariş verin", "buy"],
    ["Səbətə əlavə et", "buy"],
    ["Görüşək", "demo"],
    ["Məhsullarımızla tanış olun!", "learn"],
    ["Məhsullarımıza baxın", "learn"],
    ["BAX →", "learn"],
    ["İmkanları araşdır", "learn"],
    ["Ətraflı məlumat", "learn"],
    // Russian.
    ["Написать нам", "contact"],
    ["Обсудить проект", "contact"],
    ["Получить консультацию", "contact"],
    ["Оставить заявку", "contact"],
    ["Записаться на курс", "start"],
    ["Начните сейчас", "start"],
    ["Ознакомиться с продукцией", "learn"],
    ["Изучить возможности", "learn"],
    // Turkish.
    ["Bizimle konuşun", "contact"],
    ["Hemen başvurun", "contact"],
    ["Teklif alın", "contact"],
    ["Sepete ekle", "buy"],
    ["Daha fazla öğren", "learn"],
    ["Ürünlere göz atın", "learn"],
    ["Ürünlere bakın", "learn"],
  ])("%s is %s", (words, kind) => {
    expect(ctaKindOfWords(words)).toBe(kind);
  });

  it("does not read the neighbours of the new words", () => {
    // Articles and software are not an enrolment; opinions are no meeting;
    // recordings are no sign-up; rich is no phone call.
    expect(ctaKindOfWords("Yazılar")).toBeNull();
    expect(ctaKindOfWords("Yazılım")).toBeNull();
    expect(ctaKindOfWords("Müşteri görüşleri")).toBe("learn");
    expect(ctaKindOfWords("Записи")).toBeNull();
    expect(ctaKindOfWords("Zəngin seçim")).toBeNull();
    expect(ctaKindOfWords("Bakım")).toBeNull();
  });

  it("reads the plain-letter slugs of the contact words in a link", () => {
    expect(ctaKindOfHref("/elaqe")).toBe("contact");
    expect(ctaKindOfHref("/az/muraciet")).toBe("contact");
    expect(ctaKindOfHref("/pulsuz-meslehet")).toBe("contact");
  });
});

describe("a button's link is kept without its query", () => {
  it("drops the query and keeps the path and the hash", () => {
    const links = readButtonHrefs(pageWith(OWN, "/products?session=abc123&u=42#list"), MANIFEST);
    expect([...links.values()]).toEqual(["/products#list"]);
  });
  it("leaves a link without a query as it is", () => {
    const links = readButtonHrefs(pageWith(OWN, LINK), MANIFEST);
    expect([...links.values()]).toEqual([LINK]);
  });
});

describe("Medora's twenty labels under the rule", () => {
  const links = readButtonHrefs(pageWith(OWN, LINK), MANIFEST);
  const ctas = ctasOf(MANIFEST, links, COUNTED);
  const ctx = ctxFor(MANIFEST, ctas);

  it("finds the button's link on the page and reads the button as a reading link", () => {
    expect(links.get(PATH)).toBe(LINK);
    const facts = ctas.get(PATH);
    expect([...(facts?.kinds ?? [])]).toEqual(["learn"]);
    expect(facts?.wordsKnown).toBe(true);
    expect(facts?.unread).toBe(false);
  });

  it.each(BAD)("flags %s, hard, on the counted button", (label) => {
    const r = lintVariant(body(label), ctx);
    expect(actionFlags(r)).toEqual({ hard: [PATH], soft: [] });
    const flag = r.hard.find((f) => f.rule === "cta-action-changed");
    expect(flag?.excerpt).toContain(`the page's "${OWN}"`);
    expect(flag?.excerpt).toContain("a reading label");
    expect(flag?.excerpt).not.toMatch(/[\u2014\u2013]/);
  });

  it.each(GOOD)("passes %s", (label) => {
    expect(actionFlags(lintVariant(body(label), ctx))).toEqual({ hard: [], soft: [] });
  });

  it("the same five are soft when the button is not counted", () => {
    const notCounted = ctxFor(MANIFEST, ctasOf(MANIFEST, links, new Set()));
    for (const label of BAD) {
      expect(actionFlags(lintVariant(body(label), notCounted))).toEqual({ hard: [], soft: [PATH] });
    }
  });
});

describe("the link decides through the site map when its own words do not (A1.3)", () => {
  const rows = [
    { path: "/products", kind: "features" as const, confidence: "medium" as const },
    { path: "/contact", kind: "start" as const, confidence: "high" as const },
    { path: "/qiymetler", kind: "price" as const, confidence: "operator" as const },
    { path: "/partners", kind: "proof" as const, confidence: "model" as const },
    { path: "/terms", kind: "none" as const, confidence: "operator" as const },
  ];
  const kinds = linkKindsFrom(rows, "www.medora.test");

  it("reads the customer's own pages, the apex and www as one host, a deeper page by its parent", () => {
    expect(kinds(LINK)).toEqual(["learn"]);
    expect(kinds("/products")).toEqual(["learn"]);
    expect(kinds("https://www.medora.test/products/omega-3?ref=hero")).toEqual(["learn"]);
    expect(kinds("/qiymetler")).toEqual(["pricing"]);
    // The site map's start is a sign-up, a contact or a demo page.
    expect(kinds("/contact")).toEqual(["start", "contact", "demo"]);
  });

  it("says nothing of another host, a fragment, an unmapped page, a model's guess or the operator's none", () => {
    expect(kinds("https://shop.example.com/products")).toEqual([]);
    expect(kinds("#products")).toEqual([]);
    expect(kinds("mailto:info@medora.test")).toEqual([]);
    expect(kinds("/blog")).toEqual([]);
    expect(kinds("/partners")).toEqual([]);
    expect(kinds("/terms")).toEqual([]);
    expect(kinds(undefined)).toEqual([]);
    // No recorded domain: only a relative link is the customer's own.
    const noDomain = linkKindsFrom(rows, null);
    expect(noDomain("/products")).toEqual(["learn"]);
    expect(noDomain(LINK)).toEqual([]);
  });

  it("maps every site kind, and an unknown one to nothing", () => {
    expect(ctaKindsOfSiteKind("price")).toEqual(["pricing"]);
    for (const k of ["vs", "compare", "proof", "features", "docs", "how", "learn", "about"]) {
      expect(ctaKindsOfSiteKind(k)).toEqual(["learn"]);
    }
    expect(ctaKindsOfSiteKind("none")).toEqual([]);
    expect(ctaKindsOfSiteKind("toString")).toEqual([]);
  });

  it("is asked only when the link's own words give no kind", () => {
    // "/pricing" names itself; a site row that calls it features changes nothing.
    const f = ctaFactsOf("Kataloq", "/pricing", true, ["learn"]);
    expect([...f.kinds]).toEqual(["pricing"]);
    const g = ctaFactsOf("Kataloq", "/products", true, ["learn"]);
    expect([...g.kinds]).toEqual(["learn"]);
    expect(g.wordsKnown).toBe(false);
    expect(g.unread).toBe(false);
  });

  it("a label the tables cannot read is still held to the page's link: the five flag, the nine pass", () => {
    // The pilot's button under a label with no verb at all.
    const manifest = manifestWith("Məhsullarımız");
    const links = readButtonHrefs(pageWith("Məhsullarımız", LINK), manifest);
    expect(ctaKindOfWords("Məhsullarımız")).toBeNull();
    const ctas = ctasOf(manifest, links, COUNTED, kinds);
    expect([...(ctas.get(PATH)?.kinds ?? [])]).toEqual(["learn"]);
    const ctx = ctxFor(manifest, ctas);
    for (const label of BAD)
      expect(actionFlags(lintVariant(body(label), ctx)).hard).toEqual([PATH]);
    for (const label of GOOD) expect(actionFlags(lintVariant(body(label), ctx)).hard).toEqual([]);
    // Without the site map the same button has no kind from its link.
    expect(ctasOf(manifest, links, COUNTED).get(PATH)?.kinds.size).toBe(0);
  });

  it("loads the rows in one statement that also checks the customer's switch, and fails quiet", async () => {
    const seen: string[] = [];
    const db = {
      prepare: (sql: string) => {
        seen.push(sql);
        return { bind: () => ({ all: async () => ({ results: rows }) }) };
      },
    } as unknown as D1Database;
    const loaded = await loadLinkKinds("medora", "medora.test", db);
    expect(loaded(LINK)).toEqual(["learn"]);
    expect(seen).toEqual([LINK_KINDS_SQL]);
    expect(LINK_KINDS_SQL).toContain("site_map_off = 0");
    const broken = {
      prepare: () => {
        throw new Error("no such table: site_paths");
      },
    } as unknown as D1Database;
    expect((await loadLinkKinds("medora", "medora.test", broken))(LINK)).toEqual([]);
  });
});

describe("a button nobody could read is not a pass (A1.4)", () => {
  // No verb in the label, a link whose words say nothing, no site map row.
  const manifest = manifestWith("Kataloq");
  const links = readButtonHrefs(pageWith("Kataloq", "/kataloq"), manifest);
  const counted = ctasOf(manifest, links, COUNTED);
  const ctx = ctxFor(manifest, counted);

  it("marks the button unread", () => {
    const f = counted.get(PATH);
    expect(f?.kinds.size).toBe(0);
    expect(f?.unread).toBe(true);
    // No words at all on record: nothing to hold a version to.
    expect(ctaFactsOf(undefined, undefined, true).unread).toBe(false);
    expect(ctaFactsOf("→", undefined, true).unread).toBe(false);
  });

  it("a doing label on the counted button is hard, on another button soft", () => {
    const doing = ["Bizə yazın", "Pulsuz başla", "Görüş təyin et", "Sifariş verin", "Yüklə"];
    for (const label of doing) {
      expect(actionFlags(lintVariant(body(label), ctx))).toEqual({ hard: [PATH], soft: [] });
    }
    const flag = lintVariant(body("Bizə yazın"), ctx).hard.find(
      (f) => f.rule === "cta-action-changed",
    );
    expect(flag?.excerpt).toContain('neither the page\'s "Kataloq" nor its link reads as that');
    expect(flag?.excerpt).toContain(KEEP_OWN_ACTION);
    expect(flag?.excerpt).not.toMatch(/[\u2014\u2013]/);
    const other = ctxFor(manifest, ctasOf(manifest, links, new Set()));
    for (const label of doing) {
      expect(actionFlags(lintVariant(body(label), other))).toEqual({ hard: [], soft: [PATH] });
    }
  });

  it("a reading label, a pricing label and an unread label pass: nothing says they are wrong", () => {
    for (const label of ["Kataloqa baxın", "Qiymətlərə bax", "Kataloqu açın", "Kataloq"]) {
      expect(actionFlags(lintVariant(body(label), ctx))).toEqual({ hard: [], soft: [] });
    }
  });

  it("only in a language the tables cover", () => {
    const de = manifestWith("Zum Katalog");
    const dctas = ctasOf(de, new Map(), COUNTED);
    expect(dctas.get(PATH)?.unread).toBe(true);
    // "starten" is a cognate the tables happen to read.
    const r = lintVariant(body("Jetzt starten"), ctxFor(de, dctas, "de"));
    expect(actionFlags(r)).toEqual({ hard: [], soft: [] });
  });

  it("the prompt names the button and holds it to its own label", () => {
    const block = buttonsBlock(manifest, counted);
    expect(block).toContain("BUTTONS KEEP THEIR ACTION");
    expect(block).toContain(
      `- ${PATH} (the page's own says "Kataloq"): ${KEEP_OWN_ACTION}. No sign-up, contact, demo, buy or download label unless the page's own label is one. This is the counted button.`,
    );
    expect(block).not.toMatch(/[\u2014\u2013]/);
    // A button with no words on record is still left out.
    const bare: Manifest = { [PATH]: { css: ["a"], text: [], structural: "" } };
    expect(buttonsBlock(bare, ctasOf(bare, new Map(), COUNTED))).toBe("");
  });

  it("the call for the label alone is told to keep the page's own action, and mends it", async () => {
    const b = body("Bizə yazın");
    const first = lintVariant(b, ctx);
    answerFor = () => JSON.stringify({ label: "Kataloqa baxın" });
    const out = await fixLabels(
      {
        body: b,
        result: {} as never,
        hard: first.hard,
        soft: first.soft,
        extraCost: 0,
        cacheHit: false,
      },
      ctx,
      {
        model: "model-a",
        cachedPreamble: "",
        env: MODEL_ENV as never,
        intentDim: "problem",
        customerId: "medora",
        manifest,
      },
      () => true,
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.prompt).toContain('The page\'s own button says "Kataloq"');
    expect(inputs[0]?.prompt).toContain(`the same action: ${KEEP_OWN_ACTION}`);
    expect(out.hard).toEqual([]);
    expect((out.body.sections.hero as { cta: { label: string } }).cta.label).toBe("Kataloqa baxın");
  });
});

describe("no invented link in a version of a page we read (A2)", () => {
  const withHrefs = (label = "Məhsullarımıza baxın") =>
    JSON.stringify({
      customer_id: "medora",
      profile_key: "intent:problem",
      sections: {
        hero: { kind: "hero", cta: { label, href: "#enroll" } },
        cta: { kind: "cta", headline: "Yazın", cta: { label: "Bizə yazın", href: "#contact" } },
      },
      generated_at: 1,
      prompt_hash: "",
    });
  const hrefsIn = (b: VariantBody) => [...JSON.stringify(b).matchAll(/"href"/g)].length;

  it("drops every href the manifest does not list, without calling it a pruned path", () => {
    const manifest: Manifest = {
      ...MANIFEST,
      "cta.cta.label": { css: ["footer a"], text: ["Əlaqə"], structural: "" },
    };
    const r = parseAndValidate(withHrefs(), "problem", "medora", manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(hrefsIn(r.body)).toBe(0);
    expect(r.body.sections.hero?.cta?.label).toBe("Məhsullarımıza baxın");
    // cta.headline is off the manifest and is the only pruned path.
    expect(r.pruned).toEqual(["cta.headline"]);
  });

  it("keeps an href only where the manifest lists that path itself", () => {
    const manifest: Manifest = {
      ...MANIFEST,
      "hero.cta.href": { css: ["section.hero a.hero-btn"], text: [], structural: "" },
      "cta.cta.label": { css: ["footer a"], text: ["Əlaqə"], structural: "" },
    };
    const r = parseAndValidate(withHrefs(), "problem", "medora", manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.sections.hero?.cta?.href).toBe("#enroll");
    expect(r.body.sections.cta?.cta?.href).toBeUndefined();
    expect(asksHref(manifest)).toBe(true);
  });

  it("leaves a customer without a manifest as it was", () => {
    const legacy = JSON.stringify({
      customer_id: "c",
      profile_key: "intent:brand",
      sections: {
        hero: { kind: "hero", headline: "H", body: "B", cta: { label: "Go", href: "#go" } },
        features: { kind: "features", headline: "F", body: "Features body" },
        social_proof: { kind: "social_proof", headline: "S", body: "Proof body" },
        pricing: { kind: "pricing", headline: "P", body: "Pricing body" },
        cta: { kind: "cta", headline: "C", cta: { label: "Enroll", href: "#enroll" } },
      },
      generated_at: 1,
      prompt_hash: "",
    });
    for (const manifest of [null, {}]) {
      const r = parseAndValidate(legacy, "brand", "c", manifest);
      expect(r.ok).toBe(true);
      if (r.ok) expect(hrefsIn(r.body)).toBe(2);
    }
    expect(asksHref(null)).toBe(true);
    expect(asksHref({})).toBe(true);
    expect(asksHref(MANIFEST)).toBe(false);
  });

  it("the model is not asked for one: neither the schema nor the page's paths name href", () => {
    const dna = {
      customer_id: "medora",
      product: "Qida əlavələri istehsalı",
      icp: "Brend sahibləri",
      target_market: "Yerli bazar",
      brand_voice: "sakit",
      value_props: ["a"],
      differentiators: ["b"],
      proof_points: ["c"],
      target_language: "az",
      per_intent_hints: {},
    } as never;
    const preamble = buildDnaPreamble(dna, [], { href: asksHref(MANIFEST) });
    expect(preamble).not.toContain("href");
    expect(preamble).not.toContain("#enroll");
    // The schema as it was for a page that tags its own elements.
    expect(buildDnaPreamble(dna)).toContain('"href": string            // anchor target');
    const prompt = buildIntentPrompt("problem", dna, "medora", MANIFEST);
    expect(prompt).toContain("Emit no href field anywhere");
    expect(prompt).not.toContain("co-located link metadata");
    expect(hrefLine(["hero.cta.label", "hero.cta.href"])).toBe(
      "Emit an href only for hero.cta.href; every other button keeps the page's own link.",
    );
  });
});

describe("a rewrite of Medora's page, the whole path", () => {
  const DNA_ROW = {
    customer_id: "medora",
    product: "Qida əlavələrinin sifarişlə istehsalı",
    icp: "Öz brendi olan şirkətlər",
    brand_voice: "sakit, dəqiq",
    value_props: JSON.stringify(["İstehsal"]),
    differentiators: JSON.stringify(["Fərdi formul"]),
    proof_points: JSON.stringify(["Sertifikat"]),
    target_market: "Yerli bazar",
    target_language: "az",
    per_intent_hints: JSON.stringify({}),
    prompt_cache_id: null,
    updated_at: 1_700_000_000,
  };
  const PROFILE_ROW = {
    id: "p1",
    key: "problem",
    label: "Problem",
    signals: "{}",
    intent_vector: null,
    customer_id: null,
  };

  function makeEnv(manifest: Manifest, siteRows: unknown[]) {
    const stored = new Map<string, string>();
    const sqls: string[] = [];
    const db = {
      prepare: (sql: string) => {
        sqls.push(sql);
        return {
          bind: () => ({
            first: async () => {
              if (sql.includes("business_dna")) return DNA_ROW;
              if (sql.includes("intent_profiles")) return PROFILE_ROW;
              if (sql.includes("customers")) {
                return { id: "medora", domain: "www.medora.test", site_map_off: 0, plan: "pilot" };
              }
              return null;
            },
            all: async () => {
              if (sql.includes("element_manifests")) {
                return { results: [{ page_path: "/", manifest: JSON.stringify(manifest) }] };
              }
              if (sql.includes("conversion_targets")) {
                return { results: [{ section_path: PATH }] };
              }
              if (sql === LINK_KINDS_SQL) return { results: siteRows };
              return { results: [] };
            },
            run: async () => ({ success: true }),
          }),
        };
      },
    } as unknown as D1Database;
    const kv = {
      put: async (key: string, value: string) => {
        stored.set(key, value);
      },
      get: async (key: string) => stored.get(key) ?? null,
    } as unknown as KVNamespace;
    return { env: { ...MODEL_ENV, DB: db, VARIANTS: kv }, stored, sqls };
  }

  const version = (prompt: string, label: string) =>
    JSON.stringify({
      customer_id: "medora",
      profile_key: `intent:${/"intent:(\w+)"/.exec(prompt)?.[1] ?? "brand"}`,
      sections: { hero: { kind: "hero", cta: { label, href: "#enroll" } } },
      generated_at: Date.now(),
      prompt_hash: "",
    });

  /** The model writes `first`; asked for the label alone, it answers `mended`. */
  const modelWriting = (first: string, mended: string) => {
    let last = "";
    answerFor = (input) => {
      if (input.prompt.includes("This button label is on a web page")) {
        return JSON.stringify({ label: mended });
      }
      if (input.prompt.includes("Revise the JSON object")) return last;
      last = version(input.prompt, first);
      return last;
    };
  };
  const labelCalls = () =>
    inputs.filter((i) => i.prompt.includes("This button label is on a web page"));

  it("a label that asks for a conversation is mended to a reading label, and the body has no href", async () => {
    pageHtml = pageWith(OWN, LINK);
    modelWriting("Probleminizi bizə danışın", "Məhsullarımıza baxın");
    const { env, stored } = makeEnv(MANIFEST, []);
    const result = await orchestrate("medora", env, { maxTuples: 1 });
    expect(result.errors).toBe(0);
    expect(result.generated).toBe(1);
    // The model is told what the button does, and asked for no link.
    expect(inputs[0]?.prompt).toContain(
      `- ${PATH} (the page's own says "${OWN}"): a reading label (learn more, see how it works). This is the counted button`,
    );
    expect(inputs[0]?.prompt).toContain("Emit no href field anywhere");
    expect(inputs[0]?.cachedPreamble).not.toContain("href");
    expect(labelCalls()[0]?.prompt).toContain("the same action: a reading label");
    const written = JSON.parse(stored.get(result.kv_keys[0] as string) ?? "{}") as VariantBody;
    expect(written.sections.hero?.cta?.label).toBe("Məhsullarımıza baxın");
    expect(JSON.stringify(written)).not.toContain("href");
  });

  it("a label that cannot be mended is refused: an error row, nothing written over the live version", async () => {
    pageHtml = pageWith(OWN, LINK);
    modelWriting("Probleminizi bizə danışın", "Layihənizə indi başlayın");
    const { env, stored } = makeEnv(MANIFEST, []);
    const result = await orchestrate("medora", env, { maxTuples: 1 });
    expect(result.generated).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.failed_tuples[0]?.reason).toContain(`${PATH} cta-action-changed`);
    expect(labelCalls()).toHaveLength(2);
    expect([...stored.keys()].filter((k) => k.startsWith("v1:variant:"))).toEqual([]);
  });

  it("a label with no verb is read through the site map: /products is a page to read", async () => {
    pageHtml = pageWith("Məhsullarımız", LINK);
    modelWriting("Bizə yazın", "Məhsullara baxın");
    const { env, stored, sqls } = makeEnv(manifestWith("Məhsullarımız"), [
      { path: "/products", kind: "features", confidence: "medium" },
    ]);
    const result = await orchestrate("medora", env, { maxTuples: 1 });
    expect(sqls).toContain(LINK_KINDS_SQL);
    expect(result.errors).toBe(0);
    expect(inputs[0]?.prompt).toContain(
      `- ${PATH} (the page's own says "Məhsullarımız"): a reading label`,
    );
    const written = JSON.parse(stored.get(result.kv_keys[0] as string) ?? "{}") as VariantBody;
    expect(written.sections.hero?.cta?.label).toBe("Məhsullara baxın");
  });

  it("the same button without a site map row is held to its own label", async () => {
    pageHtml = pageWith("Məhsullarımız", LINK);
    modelWriting("Bizə yazın", "Bütün məhsullar");
    const { env, stored } = makeEnv(manifestWith("Məhsullarımız"), []);
    const result = await orchestrate("medora", env, { maxTuples: 1 });
    expect(result.errors).toBe(0);
    expect(inputs[0]?.prompt).toContain(
      `- ${PATH} (the page's own says "Məhsullarımız"): ${KEEP_OWN_ACTION}.`,
    );
    expect(labelCalls()[0]?.prompt).toContain(`the same action: ${KEEP_OWN_ACTION}`);
    const written = JSON.parse(stored.get(result.kv_keys[0] as string) ?? "{}") as VariantBody;
    expect(written.sections.hero?.cta?.label).toBe("Bütün məhsullar");
  });
});
