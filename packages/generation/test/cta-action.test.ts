/**
 * Buttons keep their action (the measure-lab QA, 2026-10-05): the counted
 * "Start free" (to /signup/) came back as "See how" and "See the facts", and
 * "See plans" (to /pricing/) came back as "Start free", so the page showed
 * two start buttons and counted one.
 */
import type { Manifest, VariantBody } from "@rawuser/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "./model-env.ts";

let answers: string[] = [];
let prompts: string[] = [];
vi.mock("../src/generateVariant.ts", () => ({
  generateVariant: vi.fn(async (input: { prompt: string }) => {
    prompts.push(input.prompt);
    return {
      text: answers.shift() ?? "{}",
      model: "model-a",
      costUsd: 0.0002,
      promptHash: "h",
      cacheHit: false,
      cacheReadTokens: 0,
    };
  }),
}));

const { ctaKindOfWords, ctaKindOfHref, ctaFactsOf } = await import("../src/lint/cta-action.ts");
const { lintVariant, collectNumbers } = await import("../src/lint/index.ts");
const { ctasOf, fixLabels } = await import("../src/orchestrator.ts");
const { readButtonHrefs } = await import("../src/page-links.ts");
const { buttonsBlock } = await import("../src/prompts/intent-prompts.ts");

beforeEach(() => {
  answers = [];
  prompts = [];
});

/** measure-lab's own page (packages/lab-measure/index.html), the parts that matter. */
const LAB_HTML = `<html lang="en"><body><main>
<section class="hero"><h1>Invoices your clients pay on time.</h1>
<p class="lead">Send an invoice in two minutes.</p>
<div class="actions"><a class="btn primary" href="/signup/">Start free</a><a class="btn" href="#how">How it works</a></div></section>
<section class="pricing"><h2>One price per studio.</h2><a class="btn primary" href="/pricing/">See plans</a></section>
</main></body></html>`;

/** measure-lab's confirmed manifest, the two buttons (production, 2026-10-05). */
const MANIFEST: Manifest = {
  "hero.cta.label": {
    css: ["section.hero .actions a.btn.primary", "section.hero a.btn.primary"],
    text: ["Start free"],
    structural: "primary CTA button in the hero actions group",
    original_char_length: 10,
  },
  "pricing.cta.label": {
    css: ["section.pricing a.btn.primary", "section.pricing a.primary"],
    text: ["See plans"],
    structural: "primary CTA button in the pricing section",
    original_char_length: 9,
  },
};

const COUNTED = new Set(["hero.cta.label"]);
const ctas = ctasOf(MANIFEST, readButtonHrefs(LAB_HTML, MANIFEST), COUNTED);

const ctx = {
  language: "en",
  allowedNumbers: collectNumbers(["none"]),
  originalLengths: new Map([
    ["hero.cta.label", 10],
    ["pricing.cta.label", 9],
  ]),
  originalTexts: new Map([
    ["hero.cta.label", "Start free"],
    ["pricing.cta.label", "See plans"],
  ]),
  ctas,
};

function body(hero?: string, pricing?: string): VariantBody {
  const sections: Record<string, unknown> = {};
  if (hero !== undefined) sections.hero = { kind: "hero", cta: { label: hero, href: "#start" } };
  if (pricing !== undefined)
    sections.pricing = { kind: "pricing", cta: { label: pricing, href: "#pricing" } };
  return { sections } as unknown as VariantBody;
}

const rules = (r: {
  hard: { path: string; rule: string }[];
  soft: { path: string; rule: string }[];
}) => ({
  hard: r.hard.filter((f) => f.rule.startsWith("cta-")).map((f) => `${f.path} ${f.rule}`),
  soft: r.soft.filter((f) => f.rule.startsWith("cta-a")).map((f) => `${f.path} ${f.rule}`),
});

describe("what a button does, by its words", () => {
  it.each([
    ["Start free", "start"],
    ["Try it free", "start"],
    ["Get started", "start"],
    ["Start free trial", "start"],
    ["Join the waitlist", "start"],
    ["See plans", "pricing"],
    ["See pricing", "pricing"],
    ["Compare plans", "pricing"],
    ["Book a demo", "demo"],
    ["Talk to sales", "demo"],
    ["Contact us", "contact"],
    ["Buy now", "buy"],
    ["Download the app", "download"],
    ["See how", "learn"],
    ["See the facts", "learn"],
    ["How it works", "learn"],
    ["Learn more →", "learn"],
    ["Compare", "learn"],
    // Azerbaijani, Russian, Turkish.
    ["Pulsuz başla", "start"],
    ["Başla →", "start"],
    ["Qiymətlərə bax", "pricing"],
    ["Ətraflı", "learn"],
    ["Начать бесплатно", "start"],
    ["Тарифы", "pricing"],
    ["Подробнее", "learn"],
    ["Ücretsiz başla", "start"],
    ["Fiyatları gör", "pricing"],
    ["Daha fazla bilgi", "learn"],
  ])("%s is %s", (words, kind) => {
    expect(ctaKindOfWords(words)).toBe(kind);
  });

  it("does not read a word inside a longer one", () => {
    // "Bookkeeping" is no booking, "planner" no plan.
    expect(ctaKindOfWords("Try bookkeeping free")).toBe("start");
    expect(ctaKindOfWords("Open the planner")).toBeNull();
    expect(ctaKindOfWords("Sign in")).toBeNull();
    expect(ctaKindOfWords("Tallybook")).toBeNull();
  });
});

describe("what a button does, by its link", () => {
  it.each([
    ["/signup/", "start"],
    ["https://app.tallybook.io/sign-up?ref=x", "start"],
    ["/pricing/", "pricing"],
    ["/az/qiymetler", "pricing"],
    ["#how", "learn"],
    ["/demo", "demo"],
    ["https://calendly.com/tallybook/intro", "demo"],
    ["mailto:hi@tallybook.example", "contact"],
  ])("%s is %s", (href, kind) => {
    expect(ctaKindOfHref(href)).toBe(kind);
  });

  it("knows nothing of the home page, an empty fragment or script", () => {
    expect(ctaKindOfHref("/")).toBeNull();
    expect(ctaKindOfHref("#")).toBeNull();
    expect(ctaKindOfHref("javascript:void(0)")).toBeNull();
    expect(ctaKindOfHref(undefined)).toBeNull();
  });

  it("reads the lab page's links for the manifest's buttons", () => {
    const hrefs = readButtonHrefs(LAB_HTML, MANIFEST);
    expect(hrefs.get("hero.cta.label")).toBe("/signup/");
    expect(hrefs.get("pricing.cta.label")).toBe("/pricing/");
  });

  it("the link decides when the words do not", () => {
    const f = ctaFactsOf("Tallybook for studios", "/signup/", true);
    expect([...f.kinds]).toEqual(["start"]);
    expect(f.wordsKnown).toBe(false);
  });
});

describe("the lint: a button keeps its action", () => {
  it("the counted button turned into a reading link is hard (problem:default, evaluation:default)", () => {
    for (const label of ["See how", "See the facts", "Compare"]) {
      expect(rules(lintVariant(body(label), ctx)).hard).toEqual([
        "hero.cta.label cta-action-changed",
      ]);
    }
    const flag = lintVariant(body("See how"), ctx).hard.find(
      (f) => f.rule === "cta-action-changed",
    );
    expect(flag?.excerpt).toContain('the page\'s "Start free"');
    expect(flag?.excerpt).toContain("a start label");
    expect(flag?.excerpt).toContain("at most 13 characters");
    expect(flag?.excerpt).not.toMatch(/[—–]/);
  });

  it("the counted button turned into pricing is hard (every pricing intent version)", () => {
    expect(rules(lintVariant(body("See pricing", "Start free"), ctx))).toEqual({
      hard: ["hero.cta.label cta-action-changed", "pricing.cta.label cta-duplicates-counted"],
      soft: ["pricing.cta.label cta-action-changed"],
    });
  });

  it("the pricing button with the counted button's words is hard; with other start words, soft", () => {
    expect(rules(lintVariant(body("Start free", "Start free"), ctx)).hard).toEqual([
      "pricing.cta.label cta-duplicates-counted",
    ]);
    // The version left the counted button as the page has it.
    expect(rules(lintVariant(body(undefined, "Start free"), ctx)).hard).toEqual([
      "pricing.cta.label cta-duplicates-counted",
    ]);
    expect(rules(lintVariant(body("Start free", "Try it free"), ctx))).toEqual({
      hard: [],
      soft: ["pricing.cta.label cta-action-changed"],
    });
  });

  it("the counted button given the words the pricing button keeps is flagged on the counted one", () => {
    const r = lintVariant(body("See plans"), ctx);
    expect(rules(r).hard).toEqual([
      "hero.cta.label cta-action-changed",
      "hero.cta.label cta-duplicates-counted",
    ]);
  });

  it("new words for the same action pass", () => {
    for (const [hero, pricing] of [
      ["Try it free", "See pricing"],
      ["Get started", "Compare plans"],
      ["Start invoicing", "View plans"],
    ]) {
      expect(rules(lintVariant(body(hero, pricing), ctx))).toEqual({ hard: [], soft: [] });
    }
  });

  it("a counted label the tables cannot read is hard when they read the page's own; a non-counted one passes", () => {
    expect(rules(lintVariant(body("Send my first bill"), ctx)).hard).toEqual([
      "hero.cta.label cta-action-changed",
    ]);
    expect(rules(lintVariant(body(undefined, "The numbers"), ctx))).toEqual({
      hard: [],
      soft: [],
    });
  });

  it("in a language the tables do not cover, the link decides and unread words pass", () => {
    const de = ctasOf(
      {
        "hero.cta.label": { css: ["a"], text: ["Kostenlos testen"], structural: "" },
      },
      new Map([["hero.cta.label", "/signup/"]]),
      COUNTED,
    );
    const dctx = { ...ctx, language: "de", ctas: de };
    expect(rules(lintVariant(body("Jetzt loslegen"), dctx)).hard).toEqual([]);
    // Words the tables do read still count: a German page's English "Pricing".
    expect(rules(lintVariant(body("Pricing"), dctx)).hard).toEqual([
      "hero.cta.label cta-action-changed",
    ]);
  });

  it("nothing is checked without the page's facts", () => {
    const { ctas: _none, ...plain } = ctx;
    expect(rules(lintVariant(body("See how", "Start free"), plain)).hard).toEqual([]);
  });
});

describe("measure-lab's stored versions under the new rule (production KV, 2026-10-05)", () => {
  // [tuple, hero.cta.label, pricing.cta.label] as served; undefined = not written.
  const STORED: Array<[string, string, string | undefined]> = [
    ["brand:ai", "Start free", "See pricing"],
    ["brand:community", "Start free", "See pricing"],
    ["brand:default", "Start free", undefined],
    ["brand:organic", "Start free", "See pricing"],
    ["brand:social", "Start free", "Start free"],
    ["competitor:ai", "Start free", "Get started"],
    ["competitor:community", "Compare", "Start free"],
    ["competitor:default", "Start free", "Try it free"],
    ["evaluation:ai", "See the facts", "See pricing"],
    ["evaluation:community", "Start free", "Get started"],
    ["evaluation:default", "See the facts", "Start free"],
    ["evaluation:organic", "Start free", "Start free"],
    ["feature:ai", "Start free", "Start free"],
    ["feature:community", "Start free", "Get started"],
    ["feature:default", "Start free", "Start free"],
    ["feature:organic", "Start free", "Get started"],
    ["pricing:ai", "See the price", "Start free"],
    ["pricing:community", "See pricing", "Start free"],
    ["pricing:default", "See pricing", "Start free"],
    ["pricing:organic", "See pricing", "Start free"],
    ["pricing:social", "See pricing", "Start free"],
    ["problem:ai", "Start free", undefined],
    ["problem:community", "Start free", undefined],
    ["problem:default", "See how", undefined],
    ["problem:organic", "Start free", "Get started"],
  ];

  it("flags every version that moved or copied the counted button, and only those", () => {
    const hardRows = STORED.filter(
      ([, h, p]) => rules(lintVariant(body(h, p), ctx)).hard.length > 0,
    );
    const softOnly = STORED.filter(([, h, p]) => {
      const r = rules(lintVariant(body(h, p), ctx));
      return r.hard.length === 0 && r.soft.length > 0;
    });
    // 13 of 25 would have gone back to the revise pass on a hard flag: 11
    // with a pricing button that says "Start free", 9 with a counted button
    // that no longer starts anything (7 rows have both).
    expect(hardRows.map(([t]) => t)).toEqual([
      "brand:social",
      "competitor:community",
      "evaluation:ai",
      "evaluation:default",
      "evaluation:organic",
      "feature:ai",
      "feature:default",
      "pricing:ai",
      "pricing:community",
      "pricing:default",
      "pricing:organic",
      "pricing:social",
      "problem:default",
    ]);
    // A pricing button with other start words ("Get started", "Try it free"): soft.
    expect(softOnly.map(([t]) => t)).toEqual([
      "competitor:ai",
      "competitor:default",
      "evaluation:community",
      "feature:community",
      "feature:organic",
      "problem:organic",
    ]);
  });
});

describe("the prompt names each button's action", () => {
  it("lists both buttons, the counted one and the never-its-words rule", () => {
    const block = buttonsBlock(MANIFEST, ctas);
    expect(block).toContain("BUTTONS KEEP THEIR ACTION");
    expect(block).toContain(
      '- hero.cta.label (the page\'s own says "Start free"): a start label (sign up, start, try it free). This is the counted button',
    );
    expect(block).toContain(
      '- pricing.cta.label (the page\'s own says "See plans"): a pricing label (see the prices or the plans). Never the words of the counted button (hero.cta.label).',
    );
    expect(block).not.toMatch(/[—–]/);
    expect(buttonsBlock(MANIFEST)).toBe("");
  });
});

describe("a label over its cap gets a call for the label alone", () => {
  const call = {
    model: "model-a" as const,
    cachedPreamble: "",
    env: MODEL_ENV as never,
    intentDim: "feature" as const,
    customerId: "measure-lab",
    manifest: MANIFEST,
  };
  const outcome = (b: VariantBody) => {
    const r = lintVariant(b, ctx);
    return {
      body: b,
      result: {} as never,
      hard: r.hard,
      soft: r.soft,
      extraCost: 0,
      cacheHit: false,
    };
  };

  it("the four refused rows: 16 characters against a cap of 13 become a start label that fits", async () => {
    const b = body("Start free trial", "See pricing");
    const first = outcome(b);
    expect(first.hard.map((f) => `${f.path} ${f.rule}`)).toEqual(["hero.cta.label length-drift"]);
    answers = [JSON.stringify({ label: "Try it free" })];
    const out = await fixLabels(first, ctx, call, () => true);
    expect(out.hard).toEqual([]);
    expect((out.body.sections.hero as { cta: { label: string } }).cta.label).toBe("Try it free");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("at most 13 characters");
    expect(prompts[0]).toContain("the same action: a start label");
    expect(prompts[0]).toContain('not "See pricing"');
    expect(out.extraCost).toBeCloseTo(0.0002);
  });

  it("a second try is told what the first missed; a label that still fails is put back", async () => {
    const b = body("Start free trial");
    answers = [
      JSON.stringify({ label: "See how it works" }),
      JSON.stringify({ label: "Start your free month" }),
    ];
    const out = await fixLabels(outcome(b), ctx, call, () => true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Last time: "See how it works"');
    expect(prompts[1]).toContain("cta-action-changed");
    expect((out.body.sections.hero as { cta: { label: string } }).cta.label).toBe(
      "Start free trial",
    );
    expect(out.hard.map((f) => f.rule)).toEqual(["length-drift"]);
  });

  it("mends a counted button that lost its action", async () => {
    answers = [JSON.stringify({ label: "Try it free" })];
    const out = await fixLabels(outcome(body("See how")), ctx, call, () => true);
    expect(out.hard).toEqual([]);
    expect(prompts[0]).toContain('The page\'s own button says "Start free"');
  });

  it("mends both labels of a swap (every pricing version): the counted one starts again, the other gets its own words", async () => {
    const first = outcome(body("See pricing", "Start free"));
    expect(first.hard.map((f) => f.path)).toEqual(["hero.cta.label", "pricing.cta.label"]);
    answers = [
      JSON.stringify({ label: "Try it free" }),
      JSON.stringify({ label: "Compare plans" }),
    ];
    const out = await fixLabels(first, ctx, call, () => true);
    expect(out.hard).toEqual([]);
    expect(prompts[1]).toContain("a pricing label");
    expect(prompts[1]).toContain('not "Try it free"');
  });

  it("leaves a row with any other hard flag alone (competitor:organic, two paragraphs over 120%)", async () => {
    const b = {
      sections: {
        hero: { kind: "hero", body: "x".repeat(120), cta: { label: "Start free trial" } },
      },
    } as unknown as VariantBody;
    const pctx = { ...ctx, originalLengths: new Map([...ctx.originalLengths, ["hero.body", 98]]) };
    const r = lintVariant(b, pctx);
    expect(r.hard.map((f) => f.path).sort()).toEqual(["hero.body", "hero.cta.label"]);
    const out = await fixLabels(
      { body: b, result: {} as never, hard: r.hard, soft: r.soft, extraCost: 0, cacheHit: false },
      pctx,
      call,
      () => true,
    );
    expect(prompts).toHaveLength(0);
    expect(out.hard).toHaveLength(2);
  });

  it("spends nothing without budget", async () => {
    const out = await fixLabels(outcome(body("Start free trial")), ctx, call, () => false);
    expect(prompts).toHaveLength(0);
    expect(out.hard.map((f) => f.rule)).toEqual(["length-drift"]);
  });
});
