/**
 * A button's label keeps the page's own object (A1.6 of
 * docs/specs/pilot-gaps.md).
 *
 * The rewrite of 2026-10-12 fixed the action and not the object. The pilot's
 * counted hero button says "Məhsullarımızla tanış olun!" and opens
 * /products; 15 of its 20 new labels name the manufacturing services, the
 * production process or the labelling service, and only "Məhsullarımıza
 * baxın" says what the link opens. The labels are production's, read by
 * hand that morning; the page is built from the facts of the read.
 */
import type { Manifest, VariantBody } from "@rawuser/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const { ctaFactsOf, ctaObjectsOf, ctaStem, keepsCtaObject, keepObjectLine } = await import(
  "../src/lint/cta-action.ts"
);
const { lintVariant, collectNumbers } = await import("../src/lint/index.ts");
const { ctasOf, fixLabels } = await import("../src/orchestrator.ts");
const { buttonsBlock } = await import("../src/prompts/intent-prompts.ts");
const { buildRevisePrompt } = await import("../src/prompts/revise.ts");

beforeEach(() => {
  inputs = [];
  answerFor = () => "{}";
});

const OWN = "Məhsullarımızla tanış olun!";
const PATH = "hero.cta.label";

const manifestWith = (label: string, path = PATH): Manifest => ({
  [path]: {
    css: ["a.btn"],
    text: [label],
    structural: "button",
    original_char_length: label.length,
    inline: { icons: "none", emphasis: 0, split: false, animated_text: false },
  },
});

const body = (label: string): VariantBody =>
  ({ sections: { hero: { kind: "hero", cta: { label } } } }) as unknown as VariantBody;

/** The lint's context for one button: its own label, counted or not, the link read as a page to read. */
function ctxFor(own: string, counted: boolean, language = "az") {
  return {
    language,
    allowedNumbers: collectNumbers(["none"]),
    originalLengths: new Map([[PATH, own.length]]),
    originalTexts: new Map([[PATH, own]]),
    ctas: new Map([[PATH, ctaFactsOf(own, undefined, counted, ["learn"])]]),
  };
}

const objectFlags = (r: ReturnType<typeof lintVariant>) => ({
  hard: r.hard.filter((f) => f.rule === "cta-object-changed"),
  soft: r.soft.filter((f) => f.rule === "cta-object-changed"),
});

/**
 * The pilot's 20 labels after the rewrite (docs/specs/pilot-gaps.md,
 * A1.5), as rows per label. The three "xidmətlərinə baxın and close forms"
 * held five rows between them.
 */
const MEDORA: Array<{ labels: string[]; rows: number; keeps: boolean }> = [
  { labels: ["Məhsullarımıza baxın"], rows: 5, keeps: true },
  { labels: ["Qablaşma xidmətlərimizlə tanış olun"], rows: 5, keeps: false },
  { labels: ["Qablaşma prosesimizlə tanış olun"], rows: 4, keeps: false },
  {
    labels: [
      "İstehsal xidmətlərinə baxın",
      "İstehsal xidmətlərimizə baxın",
      "İstehsal imkanlarımıza baxın",
    ],
    rows: 5,
    keeps: false,
  },
  { labels: ["Çevik etiketləmə xidmətinə baxın"], rows: 1, keeps: false },
];

describe("the stem of a label's noun", () => {
  it.each([
    // Azerbaijani: the forms of the pilot's button and its versions.
    ["az", "Məhsullarımızla", "məhsul"],
    ["az", "Məhsullarımıza", "məhsul"],
    ["az", "məhsulları", "məhsul"],
    ["az", "məhsullara", "məhsul"],
    ["az", "MƏHSULLARIMIZLA", "məhsul"],
    ["az", "xidmətlərimizlə", "xidmət"],
    ["az", "xidmətinə", "xidmət"],
    ["az", "prosesimizlə", "proses"],
    ["az", "imkanlarımıza", "imkan"],
    ["az", "kataloq", "kataloq"],
    // A short word keeps its letters: "qida" is not "qid".
    ["az", "qida", "qida"],
    // English.
    ["en", "products", "product"],
    ["en", "Product", "product"],
    ["en", "plans", "plan"],
    ["en", "categories", "categor"],
    ["en", "guide", "guide"],
    // Russian.
    ["ru", "продукты", "продукт"],
    ["ru", "товаров", "товар"],
    ["ru", "услугами", "услуг"],
    ["ru", "каталоге", "каталог"],
    // Turkish.
    ["tr", "ürünlerimize", "ürün"],
    ["tr", "Ürünlerimizi", "ürün"],
    ["tr", "hizmetlerimizi", "hizmet"],
    ["tr", "kataloğu", "kataloğ"],
  ])("%s %s is %s", (lang, word, stem) => {
    expect(ctaStem(word, lang)).toBe(stem);
  });
});

describe("the object a label names", () => {
  it.each([
    ["az", OWN, ["məhsul"]],
    ["az", "Məhsullarımız", ["məhsul"]],
    ["az", "Kataloqa baxın", ["kataloq"]],
    ["az", "Bütün xidmətlərimizlə tanış olun", ["xidmət"]],
    // "İşlər" are the works, a thing; "işləyir" is the verb.
    ["az", "İşlərimizə baxın", ["işlər"]],
    ["en", "Explore our products", ["product"]],
    ["en", "See the product catalog", ["product", "catalog"]],
    ["en", "Download the guide", []],
    ["ru", "Смотреть наши продукты", ["продукт"]],
    ["ru", "Перейти в каталог", ["каталог"]],
    ["tr", "Ürünlerimizi inceleyin", ["ürün"]],
    ["tr", "Hizmetlere göz atın", ["hizmet"]],
  ])("%s %s", (lang, label, stems) => {
    expect(ctaObjectsOf(label, lang).map((o) => o.stem)).toEqual(stems);
  });

  it.each([
    // Only a verb, or a verb and its small words: no object, the rule says nothing.
    ["az", "Başla"],
    ["az", "Göndər"],
    ["az", "Göndərin"],
    ["az", "İndi başlayın"],
    ["az", "Bizə yazın"],
    ["az", "Ətraflı"],
    ["az", "Tanış olun"],
    ["az", "Əlaqə saxlayın"],
    ["az", "Müraciət edin"],
    ["az", "Necə işləyir"],
    ["az", "Necə işlədiyimizə bax"],
    ["en", "Learn more"],
    ["en", "Get started"],
    ["en", "Start free"],
    ["en", "See plans"],
    ["en", "See how it works"],
    ["en", "Book a demo"],
    ["en", "Contact us"],
    ["en", "Send"],
    ["en", "Sign up now"],
    ["en", "Try it free"],
    ["ru", "Подробнее"],
    ["ru", "Отправить"],
    ["ru", "Начать бесплатно"],
    ["ru", "Оставить заявку"],
    ["ru", "Связаться с нами"],
    ["tr", "Hemen başla"],
    ["tr", "Gönder"],
    ["tr", "Ücretsiz dene"],
    ["tr", "Bize ulaşın"],
    ["tr", "Daha fazla bilgi"],
    ["tr", "Nasıl çalışır"],
    ["ru", "Как это работает"],
    ["ru", "Напишите нам"],
  ])("%s %s names none", (lang, label) => {
    expect(ctaObjectsOf(label, lang)).toEqual([]);
  });

  it("is read only in a language the tables cover", () => {
    expect(ctaObjectsOf("Unsere Produkte ansehen", "de")).toEqual([]);
    expect(ctaObjectsOf(undefined, "az")).toEqual([]);
    expect(ctaObjectsOf("", "az")).toEqual([]);
  });

  it("keeps the word as the page writes it, for the instruction", () => {
    expect(ctaObjectsOf(OWN, "az")).toEqual([{ word: "məhsullarımızla", stem: "məhsul" }]);
    expect(keepObjectLine(ctaObjectsOf(OWN, "az"))).toBe(
      `the page's label names "məhsullarımızla", which is what the button opens: name the same thing, in any form of the word`,
    );
  });
});

describe("a version keeps the object in any form of the word", () => {
  it.each([
    ["az", OWN, "Məhsullarımıza baxın", true],
    ["az", OWN, "Məhsullara baxın", true],
    ["az", OWN, "Bütün məhsulları araşdırın", true],
    ["az", OWN, "MƏHSULLARA BAXIN", true],
    ["az", OWN, "*Məhsullarımızı* kəşf edin", true],
    ["az", OWN, "Qablaşma xidmətlərimizlə tanış olun", false],
    ["az", OWN, "Ətraflı baxın", false],
    ["en", "Explore our products", "See every product", true],
    ["en", "Explore our products", "Browse the product range", true],
    ["en", "Explore our products", "See our services", false],
    ["en", "See the product catalog", "Open the catalog", true],
    ["ru", "Смотреть наши продукты", "Посмотрите продукцию", true],
    ["ru", "Смотреть наши продукты", "Изучите продукт", true],
    ["ru", "Смотреть наши продукты", "Посмотрите услуги", false],
    ["tr", "Ürünlerimizi inceleyin", "Ürünlere göz atın", true],
    ["tr", "Ürünlerimizi inceleyin", "Hizmetlerimizi inceleyin", false],
    ["tr", "Kataloğu inceleyin", "Katalog burada", true],
  ])("%s %s then %s: %s", (lang, own, version, keeps) => {
    expect(keepsCtaObject(version, ctaObjectsOf(own, lang))).toBe(keeps);
  });

  it("a label with no object is kept by anything", () => {
    expect(keepsCtaObject("Whatever", ctaObjectsOf("Learn more", "en"))).toBe(true);
  });
});

describe("Medora's twenty labels under the rule", () => {
  const ctx = ctxFor(OWN, true);

  it("is twenty rows", () => {
    expect(MEDORA.reduce((n, g) => n + g.rows, 0)).toBe(20);
  });

  it("five keep the products, fifteen name something else", () => {
    let pass = 0;
    let flag = 0;
    for (const group of MEDORA) {
      for (const label of group.labels) {
        const flags = objectFlags(lintVariant(body(label), ctx));
        // The counted button: hard.
        expect(flags.hard.map((f) => f.path)).toEqual(group.keeps ? [] : [PATH]);
        expect(flags.soft).toEqual([]);
      }
      if (group.keeps) pass += group.rows;
      else flag += group.rows;
    }
    expect([pass, flag]).toEqual([5, 15]);
  });

  it("the action rule has nothing to say about any of them: that is the gap", () => {
    for (const label of MEDORA.flatMap((g) => g.labels)) {
      const r = lintVariant(body(label), ctx);
      expect([...r.hard, ...r.soft].filter((f) => f.rule === "cta-action-changed")).toEqual([]);
    }
  });

  it("the flag says what to keep, in the page's own word, and how long", () => {
    const [flag] = objectFlags(lintVariant(body("Qablaşma xidmətlərimizlə tanış olun"), ctx)).hard;
    expect(flag?.excerpt).toBe(
      `"Qablaşma xidmətlərimizlə tanış olun" names something else than the page's "${OWN}", and it is the counted button: the page's label names "məhsullarımızla", which is what the button opens: name the same thing, in any form of the word in at most 34 characters`,
    );
    // Nothing of a link or the site map: the page's own label is all it reads.
    expect(flag?.excerpt).not.toMatch(/products|\/|http/);
  });

  it("is soft on a button that is not counted, like the action rule", () => {
    const soft = objectFlags(
      lintVariant(body("Qablaşma prosesimizlə tanış olun"), ctxFor(OWN, false)),
    );
    expect(soft.hard).toEqual([]);
    expect(soft.soft.map((f) => f.path)).toEqual([PATH]);
  });
});

describe("where the rule says nothing", () => {
  it.each([
    ["az", "Başla", "İndi qoşulun"],
    ["az", "Göndər", "Təqdim edin"],
    ["en", "Learn more", "See how it works"],
    ["en", "Start free", "Try it free"],
    ["ru", "Подробнее", "Узнать больше"],
    ["tr", "Hemen başla", "Ücretsiz dene"],
  ])("%s: the page's %s is only a verb", (lang, own, version) => {
    const ctx = {
      ...ctxFor(own, true, lang),
      ctas: new Map([[PATH, ctaFactsOf(own, undefined, true)]]),
    };
    expect(objectFlags(lintVariant(body(version), ctx))).toEqual({ hard: [], soft: [] });
  });

  it("a language without tables", () => {
    const ctx = ctxFor("Unsere Produkte ansehen", true, "de");
    expect(objectFlags(lintVariant(body("Mehr erfahren"), ctx))).toEqual({ hard: [], soft: [] });
  });

  it("a label the version does not write", () => {
    const r = lintVariant({ sections: { hero: { kind: "hero" } } } as never, ctxFor(OWN, true));
    expect(objectFlags(r)).toEqual({ hard: [], soft: [] });
  });

  it("a signature cut at forty characters: its last word cannot be trusted", () => {
    const long = "Bütün məhsullarımızla və xidmətlərimizlə"; // 40 characters
    expect(long).toHaveLength(40);
    expect(objectFlags(lintVariant(body("Bizə baxın"), ctxFor(long, true)))).toEqual({
      hard: [],
      soft: [],
    });
  });
});

describe("the model is told, and a label is mended on its own call", () => {
  it("the BUTTONS block names the object from the page's own label", () => {
    const manifest = manifestWith(OWN);
    const ctas = ctasOf(manifest, new Map(), new Set([PATH]));
    const block = buttonsBlock(manifest, ctas, "az");
    expect(block).toContain(
      `- ${PATH} (the page's own says "${OWN}"): a reading label (learn more, see how it works). This is the counted button: every version keeps it this kind of label. It opens what "məhsullarımızla" names: keep that word in the label, in any form.`,
    );
    expect(block).toContain("A label keeps what it points at too.");
    expect(block).not.toMatch(/[—–]/);
    // No link, no path, no site map text: only what the label itself says.
    expect(block).not.toMatch(/\/products|https?:|href/);
  });

  it("a button that names no object gets no such line, and the block no such sentence", () => {
    const manifest = manifestWith("Start free");
    const ctas = ctasOf(manifest, new Map(), new Set([PATH]));
    const block = buttonsBlock(manifest, ctas, "en");
    expect(block).toContain("a start label");
    expect(block).not.toContain("It opens what");
    expect(block).not.toContain("A label keeps what it points at too.");
    // Without a language the block is as it was.
    expect(
      buttonsBlock(manifestWith(OWN), ctasOf(manifestWith(OWN), new Map(), new Set())),
    ).not.toContain("It opens what");
  });

  it("the revise pass is told how to fix it", () => {
    expect(buildRevisePrompt("{}", [])).toContain("- cta-object-changed:");
  });

  it("fixLabels asks for the same thing and keeps the answer that names it", async () => {
    const ctx = ctxFor(OWN, true);
    const b = body("Qablaşma xidmətlərimizlə tanış olun");
    const first = lintVariant(b, ctx);
    expect(first.hard.map((f) => f.rule)).toEqual(["cta-object-changed"]);
    answerFor = () => JSON.stringify({ label: "Məhsullarımıza baxın" });
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
        manifest: manifestWith(OWN),
      },
      () => true,
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.prompt).toContain(
      `and the same thing: the page's label names "məhsullarımızla", which is what the button opens: name the same thing, in any form of the word`,
    );
    expect(out.hard).toEqual([]);
    expect((out.body.sections.hero as { cta: { label: string } }).cta.label).toBe(
      "Məhsullarımıza baxın",
    );
  });

  it("an answer that names another thing again is not kept, and the second try is told", async () => {
    const ctx = ctxFor(OWN, true);
    const b = body("Qablaşma xidmətlərimizlə tanış olun");
    const first = lintVariant(b, ctx);
    answerFor = () => JSON.stringify({ label: "İstehsal prosesimizə baxın" });
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
        manifest: manifestWith(OWN),
      },
      () => true,
    );
    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.prompt).toContain("Last time:");
    expect(inputs[1]?.prompt).toContain("cta-object-changed");
    expect(out.hard.map((f) => f.rule)).toEqual(["cta-object-changed"]);
    expect((out.body.sections.hero as { cta: { label: string } }).cta.label).toBe(
      "Qablaşma xidmətlərimizlə tanış olun",
    );
  });
});
