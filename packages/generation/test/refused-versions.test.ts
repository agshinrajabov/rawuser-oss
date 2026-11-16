/**
 * One part must not cost the version (docs/specs/refused-versions.md, J1 of
 * docs/specs/pilot-gaps.md).
 *
 * The page is the pilot's home page as the read of 2026-10-12 found it: five
 * parts, hero.headline 48 characters, hero.body 64, hero.cta.label 27,
 * features.headline 27, forms.submit_label 6, language az, the hero button
 * counted and linked to /products. Two rows were refused on that morning's
 * rewrite: `problem:community` on "hero.body length-drift (80 characters;
 * the original has 64, write 61 to 67)" and `brand:community` on
 * "features.headline length-drift (38 characters; the original has 27, write
 * at most 28)". Both are the first two cases below. The texts are built to
 * the lengths of the read, not copied from the site.
 *
 * The database is SQLite with every migration, so `publishVersion` writes
 * its real rows and the tests read `version_bodies` and `variants` back.
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
const CALL_COST = 0.0002;
vi.mock("../src/generateVariant.ts", () => ({
  generateVariant: vi.fn(async (input: ModelInput) => {
    inputs.push(input);
    return {
      text: answerFor(input),
      model: "model-a",
      costUsd: CALL_COST,
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

const { regenerateOne, leavePartsAsBuilt, removePart, writtenParts, keepAsBuilt, fillTemplates } =
  await import("../src/orchestrator.ts");
const { judgeReadings, shortenMissing, markEmphasis, refusalReason, rowLintFlags } = await import(
  "../src/orchestrator.ts"
);
const { lintVariant, collectNumbers } = await import("../src/lint/index.ts");
const { partsAsBuiltOf, partAsBuiltFlag, lintFlagsOf } = await import(
  "../src/lib/parts-as-built.ts"
);
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
// The page
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

const html = (page: Record<string, string> = PAGE) =>
  `<html lang="az"><body><main><section class="hero"><h1>${page["hero.headline"]}</h1>
<p class="lead">${page["hero.body"]}</p><a class="btn" href="https://www.medora.test/products">${page["hero.cta.label"]}</a></section>
<section class="products"><h2>${page["features.headline"]}</h2></section>
<form class="contact"><button type="submit">${page["forms.submit_label"]}</button></form></main></body></html>`;

const PLAIN = { icons: "none", emphasis: 0, split: false, animated_text: false } as const;

function manifestOf(
  only: ReadonlyArray<keyof typeof PAGE> = Object.keys(PAGE) as Array<keyof typeof PAGE>,
): Manifest {
  const out: Manifest = {};
  for (const path of only) {
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
  // The pilot's buttons were rewritten that morning: both are on here
  // (lib/button-rewrite.ts). Off, a button is in no version at all.
  return Object.keys(out).reduce((m, path) => setRewrite(m, path, true) ?? m, out);
}

/** A version of the page that passes every hard rule. */
const GOOD = {
  "hero.headline": "Öz brendiniz üçün etibarlı əlavə istehsalçısı",
  "hero.body": "Reseptdən qablaşdırmaya qədər hər addımı yalnız bir heyət izləyir.",
  "hero.cta.label": "Məhsullarımıza baxın",
  "features.headline": "İstehsal etdiyimiz əlavələr",
  "forms.submit_label": "Göndərin",
} as const;

/** What the model wrote on 2026-10-12: 80 characters for the page's 64. */
const BODY_80 = "Reseptdən qablaşdırmaya qədər hər addımı öz heyətimiz izləyir, siz satışa baxın.";
/** And 38 for the page's 27. */
const HEAD_38 = "Hər mərhələ üzrə istehsal həlli burada";

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

/**
 * The model writes `parts` and returns the same on every revise pass; asked
 * for one part alone it answers `mend(prompt)`.
 */
function modelWriting(parts: Parts, mend: (prompt: string) => string) {
  let last = "";
  answerFor = (input) => {
    if (input.prompt.includes(PART_CALL)) return JSON.stringify({ text: mend(input.prompt) });
    if (input.prompt.includes("Revise the JSON object")) return last;
    if (input.prompt.includes("profile_key")) {
      last = versionOf(input.prompt, parts);
      return last;
    }
    // The short-length and emphasis calls: nothing usable, the part keeps its lengths.
    return "{}";
  };
}

function setup(manifest: Manifest = manifestOf(), counted = "hero.cta.label") {
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
  ).run(JSON.stringify(manifest));
  if (counted in manifest) {
    db.prepare(
      `INSERT INTO conversion_targets (id, customer_id, section_path, label, conversion_label, enabled, css_selectors, text_selectors, structural_selector, created_at, updated_at)
       VALUES ('t1', 'medora', ?, 'Hero button', 'other', 1, '[]', '[]', '', 1, 1)`,
    ).run(counted);
  }
  const kv = makeKv();
  pageHtml = html();
  return { env: { ...MODEL_ENV, DB: d1, VARIANTS: kv }, db, kv };
}

const KEY = (intent: string, source: string) => `v1:variant:medora:${intent}:${source}`;

function rowsOf(db: ReturnType<typeof setup>["db"]) {
  const variants = db.prepare("SELECT * FROM variants").all() as Array<Record<string, unknown>>;
  const bodies = db.prepare("SELECT * FROM version_bodies").all() as Array<Record<string, unknown>>;
  return { variants, bodies };
}

// ---------------------------------------------------------------------------
// The two rows of 2026-10-12
// ---------------------------------------------------------------------------

describe("the fixture is the page of the read", () => {
  it("has the five parts at their lengths", () => {
    expect(Object.fromEntries(Object.entries(PAGE).map(([p, t]) => [p, t.length]))).toEqual({
      "hero.headline": 48,
      "hero.body": 64,
      "hero.cta.label": 27,
      "features.headline": 27,
      "forms.submit_label": 6,
    });
    expect(BODY_80).toHaveLength(80);
    expect(HEAD_38).toHaveLength(38);
  });
});

describe("problem:community, the paragraph of 80 characters for the page's 64", () => {
  it("a model that keeps overshooting: the row is ready without the paragraph, flagged part-as-built", async () => {
    const { env, db, kv } = setup();
    modelWriting({ ...GOOD, "hero.body": BODY_80 }, () => BODY_80);
    const result = await regenerateOne("medora", "problem", "community", env, "/");

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.parts_as_built).toEqual([{ path: "hero.body", rule: "length-drift" }]);
    // Two revise passes, then one call for the paragraph alone, with
    // production's own flag and the rule's instruction.
    expect(reviseCalls()).toHaveLength(2);
    expect(partCalls()).toHaveLength(1);
    expect(partCalls()[0]?.prompt).toContain(
      "- length-drift: 80 characters; the original has 64, write 61 to 67",
    );
    expect(partCalls()[0]?.prompt).toContain("at most 67 characters, counting spaces");
    expect(partCalls()[0]?.prompt).toContain(JSON.stringify(BODY_80));

    // The body serves four parts; the paragraph is the page's own.
    const served = JSON.parse(kv.store.get(KEY("problem", "community")) ?? "{}") as VariantBody;
    expect(writtenParts(served.sections as unknown as Record<string, unknown>).sort()).toEqual([
      "features.headline",
      "forms.submit_label",
      "hero.cta.label",
      "hero.headline",
    ]);
    expect(served.sections.hero?.body).toBeUndefined();
    expect(served.sections.hero?.headline).toBe(GOOD["hero.headline"]);
    expect(result.body).toEqual(served);

    // The row: ready, its live body, the flag with the path and the rule.
    const { variants, bodies } = rowsOf(db);
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ status: "ready", error_reason: null });
    expect(variants[0]?.body_id).toBe(served.body_id);
    expect(partsAsBuiltOf(variants[0]?.lint_flags)).toEqual([
      { path: "hero.body", rule: "length-drift" },
    ]);
    expect(lintFlagsOf(variants[0]?.lint_flags)).toContain("part-as-built:hero.body:length-drift");
    expect(result.provenance?.lint_flags).toContain("part-as-built:hero.body:length-drift");

    // The immutable body is the served one, with the same flags.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.body_id).toBe(served.body_id);
    expect(JSON.parse(String(bodies[0]?.body_json))).toEqual(served);
    expect(partsAsBuiltOf(bodies[0]?.lint_flags)).toEqual([
      { path: "hero.body", rule: "length-drift" },
    ]);

    // The failing text is nowhere: not in KV, not in version_bodies, not on the row.
    const everything = [
      ...kv.store.values(),
      ...bodies.map((b) => JSON.stringify(b)),
      ...variants.map((v) => JSON.stringify(v)),
    ].join("\n");
    expect(everything).not.toContain(BODY_80);
    expect(everything).not.toContain("siz satışa baxın");

    // Every call is paid for in the row's answer: the extra ones too.
    expect(result.cost_usd).toBeCloseTo(inputs.length * CALL_COST, 10);
    expect(inputs.length).toBeGreaterThanOrEqual(4);
  });

  it("a model that fixes the paragraph on its own call: the row is ready with it", async () => {
    const { env, db, kv } = setup();
    modelWriting({ ...GOOD, "hero.body": BODY_80 }, () => GOOD["hero.body"]);
    const result = await regenerateOne("medora", "problem", "community", env, "/");

    expect(result.ok).toBe(true);
    expect(result.parts_as_built).toEqual([]);
    expect(partCalls()).toHaveLength(1);
    const served = JSON.parse(kv.store.get(KEY("problem", "community")) ?? "{}") as VariantBody;
    expect(served.sections.hero?.body).toBe(GOOD["hero.body"]);
    const { variants, bodies } = rowsOf(db);
    expect(variants[0]).toMatchObject({ status: "ready", error_reason: null });
    expect(partsAsBuiltOf(variants[0]?.lint_flags)).toEqual([]);
    expect(JSON.stringify(bodies)).not.toContain(BODY_80);
    expect(result.cost_usd).toBeCloseTo(inputs.length * CALL_COST, 10);
  });

  it("an answer over the cap again is not kept, whatever else it fixes", async () => {
    const { env, kv } = setup();
    // 78 characters: still past 120% of 64.
    const still = `${BODY_80.slice(0, 77)}.`;
    expect(still.length).toBeGreaterThan(64 * 1.2);
    modelWriting({ ...GOOD, "hero.body": BODY_80 }, () => still);
    const result = await regenerateOne("medora", "problem", "community", env, "/");
    expect(result.parts_as_built).toEqual([{ path: "hero.body", rule: "length-drift" }]);
    expect([...kv.store.values()].join("\n")).not.toContain(still);
  });
});

describe("brand:community, the section heading of 38 characters for the page's 27", () => {
  it("a model that keeps overshooting: ready without the heading, and its section goes with it", async () => {
    const { env, db, kv } = setup();
    modelWriting({ ...GOOD, "features.headline": HEAD_38 }, () => HEAD_38);
    const result = await regenerateOne("medora", "brand", "community", env, "/");

    expect(result.ok).toBe(true);
    expect(result.parts_as_built).toEqual([{ path: "features.headline", rule: "length-drift" }]);
    expect(partCalls()).toHaveLength(1);
    expect(partCalls()[0]?.prompt).toContain(
      "- length-drift: 38 characters; the original has 27, write at most 28",
    );
    expect(partCalls()[0]?.prompt).toContain("at most 28 characters, counting spaces");
    const served = JSON.parse(kv.store.get(KEY("brand", "community")) ?? "{}") as VariantBody;
    // The heading was the section's only part: no empty section is left behind.
    expect(served.sections.features).toBeUndefined();
    expect(served.sections.hero?.body).toBe(GOOD["hero.body"]);
    const { variants, bodies } = rowsOf(db);
    expect(variants[0]).toMatchObject({ status: "ready", error_reason: null });
    expect(partsAsBuiltOf(variants[0]?.lint_flags)).toEqual([
      { path: "features.headline", rule: "length-drift" },
    ]);
    const everything = [...kv.store.values(), JSON.stringify(bodies), JSON.stringify(variants)];
    expect(everything.join("\n")).not.toContain(HEAD_38);
  });

  it("a model that fixes the heading on its own call: ready with it", async () => {
    const { env, kv } = setup();
    modelWriting({ ...GOOD, "features.headline": HEAD_38 }, () => GOOD["features.headline"]);
    const result = await regenerateOne("medora", "brand", "community", env, "/");
    expect(result.ok).toBe(true);
    expect(result.parts_as_built).toEqual([]);
    const served = JSON.parse(kv.store.get(KEY("brand", "community")) ?? "{}") as VariantBody;
    expect(served.sections.features?.headline).toBe(GOOD["features.headline"]);
  });
});

// ---------------------------------------------------------------------------
// Step 4: when the row is still refused
// ---------------------------------------------------------------------------

describe("when the row is still refused", () => {
  const refused = (db: ReturnType<typeof setup>["db"], kv: ReturnType<typeof setup>["kv"]) => {
    const { variants, bodies } = rowsOf(db);
    expect(variants).toHaveLength(1);
    expect(variants[0]?.status).toBe("error");
    expect(bodies).toEqual([]);
    expect([...kv.store.keys()].filter((k) => k.startsWith("v1:variant:"))).toEqual([]);
    return String(variants[0]?.error_reason);
  };

  it("no part is left: a page of one part whose only part fails", async () => {
    const { env, db, kv } = setup(manifestOf(["hero.body"]));
    modelWriting({ "hero.body": BODY_80 }, () => BODY_80);
    const result = await regenerateOne("medora", "problem", "community", env, "/");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("lint: no part is left to write; hero.body length-drift");
    expect(partCalls()).toHaveLength(1);
    expect(refused(db, kv)).toBe(result.error);
  });

  it("more than half of the parts were left as built: three of five", async () => {
    const { env, db, kv } = setup();
    // A headline of 63 for the page's 48 is past 125% plus two.
    const head = "Öz brendiniz üçün etibarlı və təcrübəli əlavə istehsalçısı buradadır";
    expect(head.length).toBeGreaterThan(Math.round(48 * 1.25) + 2);
    const mine: Record<string, string> = {
      [head]: head,
      [BODY_80]: BODY_80,
      [HEAD_38]: HEAD_38,
    };
    modelWriting(
      { ...GOOD, "hero.headline": head, "hero.body": BODY_80, "features.headline": HEAD_38 },
      (prompt) => Object.keys(mine).find((t) => prompt.includes(JSON.stringify(t))) ?? "",
    );
    const result = await regenerateOne("medora", "problem", "community", env, "/");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("lint: 3 of 5 parts could not be written; ");
    // Each of the three had its call, and the reason names each with its rule.
    expect(partCalls()).toHaveLength(3);
    for (const path of ["hero.headline", "hero.body", "features.headline"]) {
      expect(result.error).toContain(`${path} length-drift`);
    }
    expect(refused(db, kv)).toBe(result.error?.slice(0, 500));
  });

  it("two of five is not more than half: the version ships with three parts", async () => {
    const { env, kv } = setup();
    modelWriting({ ...GOOD, "hero.body": BODY_80, "features.headline": HEAD_38 }, (prompt) =>
      prompt.includes(JSON.stringify(BODY_80)) ? BODY_80 : HEAD_38,
    );
    const result = await regenerateOne("medora", "problem", "community", env, "/");
    expect(result.ok).toBe(true);
    expect(result.parts_as_built).toEqual([
      { path: "hero.body", rule: "length-drift" },
      { path: "features.headline", rule: "length-drift" },
    ]);
    const served = JSON.parse(kv.store.get(KEY("problem", "community")) ?? "{}") as VariantBody;
    expect(writtenParts(served.sections as unknown as Record<string, unknown>)).toHaveLength(3);
  });

  it("a rule about the parts together still fails: two parts with the same words", async () => {
    const { env, db, kv } = setup();
    // The hero headline says what the section heading says, and the heading
    // keeps saying it (27 characters: inside both parts' caps).
    const twin = GOOD["features.headline"];
    modelWriting({ ...GOOD, "hero.headline": twin }, () => twin);
    const result = await regenerateOne("medora", "problem", "community", env, "/");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("lint: two parts still say the same thing; ");
    expect(result.error).toContain("features.headline slot-duplicate:hero.headline");
    // The heading had its call, told which part says the same.
    expect(partCalls()).toHaveLength(1);
    expect(partCalls()[0]?.prompt).toContain("its own words, nothing hero.headline says");
    refused(db, kv);
  });

  it("the same two parts, mended on the heading's own call, ship whole", async () => {
    const { env } = setup();
    modelWriting(
      { ...GOOD, "hero.headline": GOOD["features.headline"] },
      () => "Hazır əlavələrimiz burada",
    );
    const result = await regenerateOne("medora", "problem", "community", env, "/");
    expect(result.ok).toBe(true);
    expect(result.parts_as_built).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The step itself, without a run around it
// ---------------------------------------------------------------------------

const CALL = (manifest: Manifest | null) => ({
  model: "model-a" as const,
  cachedPreamble: "",
  env: MODEL_ENV as never,
  intentDim: "problem" as const,
  customerId: "medora",
  manifest,
});

function ctxOf(manifest: Manifest, extra: Record<string, unknown> = {}) {
  return {
    language: "az",
    allowedNumbers: collectNumbers(["none"]),
    originalLengths: new Map(
      Object.entries(manifest).map(([p, e]) => [p, e.original_char_length ?? 0]),
    ),
    originalTexts: new Map(Object.entries(manifest).map(([p, e]) => [p, e.text[0] ?? ""])),
    ...extra,
  };
}

function outcomeOf(sections: Record<string, unknown>, ctx: ReturnType<typeof ctxOf>) {
  const body = { customer_id: "medora", sections } as unknown as VariantBody;
  const lint = lintVariant(body, ctx);
  return {
    body,
    result: { model: "model-a", promptHash: "h", costUsd: 0 } as never,
    hard: lint.hard,
    soft: lint.soft,
    extraCost: 0,
    cacheHit: false,
  };
}

describe("leavePartsAsBuilt", () => {
  it("does nothing to a row without a hard flag", async () => {
    const m = manifestOf();
    const ctx = ctxOf(m);
    const out = outcomeOf(sectionsOf(GOOD), ctx);
    expect(out.hard).toEqual([]);
    expect(await leavePartsAsBuilt(out, ctx, CALL(m), () => true)).toBe(out);
    expect(inputs).toHaveLength(0);
  });

  it("at most three parts get a call; a fourth goes as built without one", async () => {
    // Eight parts, four of them over their hard cap.
    const NAMES = [
      "Formul",
      "Kapsul",
      "Tablet",
      "Şərbət",
      "Etiket",
      "Qablaşdırma",
      "Sənəd",
      "Çatdırılma",
    ];
    const m: Manifest = {};
    const sections: Record<string, Record<string, unknown>> = {};
    NAMES.forEach((name, i) => {
      const text = `${name} üçün qısa və aydın başlıq`;
      m[`s${i}.headline`] = {
        css: [`section.s${i} h2`],
        text: [text],
        structural: `s${i}`,
        original_char_length: text.length,
        inline: { ...PLAIN },
      };
      sections[`s${i}`] = {
        kind: "features",
        headline:
          i < 4
            ? `${name} üçün həddindən artıq uzun yazılmış və səhifəyə sığmayan başlıq`
            : `${name} üçün aydın və qısa başlıq`,
      };
    });
    const ctx = ctxOf(m);
    const out = outcomeOf(sections, ctx);
    expect(new Set(out.hard.map((f) => f.path)).size).toBe(4);
    // The call for a part alone answers within the cap.
    answerFor = (input) => {
      const name = NAMES.find((n) => input.prompt.includes(`"${n} üçün`));
      return JSON.stringify({ text: `${name} üçün yeni və qısa başlıq` });
    };
    const done = await leavePartsAsBuilt(out, ctx, CALL(m), () => true);
    expect(partCalls()).toHaveLength(3);
    expect(done.hard).toEqual([]);
    expect(done.asBuilt).toEqual([{ path: "s3.headline", rule: "length-drift" }]);
    expect(done.partsWritten).toBe(8);
    expect(writtenParts(sections)).toHaveLength(7);
    expect(done.extraCost).toBeCloseTo(3 * CALL_COST, 10);
  });

  it("no call when the run's call budget is spent: the part is left as built", async () => {
    const m = manifestOf();
    const ctx = ctxOf(m);
    const out = outcomeOf(sectionsOf({ ...GOOD, "hero.body": BODY_80 }), ctx);
    const done = await leavePartsAsBuilt(out, ctx, CALL(m), () => false);
    expect(inputs).toHaveLength(0);
    expect(done.asBuilt).toEqual([{ path: "hero.body", rule: "length-drift" }]);
  });

  it("another length with a hard flag of its own is left out alone: the part stays", async () => {
    const m = manifestOf();
    const ctx = ctxOf(m);
    const sections = sectionsOf(GOOD);
    // An invented number in the longer headline only.
    (sections.hero as Record<string, unknown>).headline_alt =
      "Öz brendiniz üçün 40 illik etibarlı əlavə istehsalçısı";
    const out = outcomeOf(sections, ctx);
    expect(out.hard.map((f) => `${f.path} ${f.rule}`)).toEqual([
      "hero.headline_alt number-not-in-brief",
    ]);
    const done = await leavePartsAsBuilt(out, ctx, CALL(m), () => true);
    expect(inputs).toHaveLength(0);
    expect(done.hard).toEqual([]);
    expect(done.asBuilt).toEqual([]);
    expect((sections.hero as Record<string, unknown>).headline).toBe(GOOD["hero.headline"]);
    expect("headline_alt" in (sections.hero as object)).toBe(false);
  });

  it.each([
    ["an invented number", "Öz brendiniz üçün 40 illik əlavə istehsalçısı", "number-not-in-brief"],
    ["the wrong script", "Надёжный производитель добавок для вашего бренда", "wrong-script"],
    ["Turkish in Azerbaijani", "Öz brendiniz için etibarlı əlavə istehsalçısı", "turkish-in-az"],
    [
      "an emphasis the page does not have",
      "Öz brendiniz üçün *etibarlı* istehsalçı",
      "emphasis-unexpected",
    ],
  ])("%s leaves the part as built, and the text does not ship", async (_name, text, rule) => {
    const m = manifestOf();
    const ctx = ctxOf(m);
    const sections = sectionsOf({ ...GOOD, "hero.headline": text });
    const out = outcomeOf(sections, ctx);
    expect(out.hard.map((f) => f.rule)).toContain(rule);
    answerFor = () => JSON.stringify({ text });
    const done = await leavePartsAsBuilt(out, ctx, CALL(m), () => true);
    expect(partCalls()).toHaveLength(1);
    expect(done.hard).toEqual([]);
    expect(done.asBuilt).toEqual([{ path: "hero.headline", rule }]);
    expect(JSON.stringify(done.body)).not.toContain(text);
  });

  it("a changed action on the counted button: the label goes back to the page's own, with its link", async () => {
    const { ctaFactsOf } = await import("../src/lint/cta-action.ts");
    const m = manifestOf();
    const ctas = new Map([
      [
        "hero.cta.label",
        ctaFactsOf(PAGE["hero.cta.label"], "https://www.medora.test/products", true, ["learn"]),
      ],
    ]);
    const ctx = ctxOf(m, { ctas });
    const sections = sectionsOf({ ...GOOD, "hero.cta.label": "Probleminizi bizə danışın" });
    ((sections.hero as Record<string, unknown>).cta as Record<string, unknown>).href = "#contact";
    // A second hard flag, so the row is not one fixLabels takes whole.
    (sections.hero as Record<string, unknown>).body = BODY_80;
    const out = outcomeOf(sections, ctx);
    expect(out.hard.map((f) => f.rule).sort()).toEqual([
      "cta-action-changed",
      "cta-object-changed",
      "length-drift",
    ]);
    answerFor = (input) =>
      input.prompt.includes("This button label is on a web page")
        ? JSON.stringify({ label: "Layihənizə indi başlayın" })
        : JSON.stringify({ text: GOOD["hero.body"] });
    const done = await leavePartsAsBuilt(out, ctx, CALL(m), () => true);
    // One call for the label, one for the paragraph.
    expect(inputs).toHaveLength(2);
    expect(inputs.filter((i) => i.prompt.includes("This button label"))).toHaveLength(1);
    expect(done.hard).toEqual([]);
    // The first rule the lint names for the label: it changed the object too.
    expect(done.asBuilt).toEqual([{ path: "hero.cta.label", rule: "cta-object-changed" }]);
    const hero = sections.hero as Record<string, unknown>;
    expect(hero.cta).toBeUndefined();
    expect(hero.body).toBe(GOOD["hero.body"]);
    expect(JSON.stringify(sections)).not.toContain("#contact");
  });

  it("a label fixLabels already called for gets no second call here", async () => {
    const { ctaFactsOf } = await import("../src/lint/cta-action.ts");
    const m = manifestOf();
    const ctas = new Map([
      ["hero.cta.label", ctaFactsOf(PAGE["hero.cta.label"], undefined, true, ["learn"])],
    ]);
    const ctx = ctxOf(m, { ctas });
    const out = outcomeOf(
      sectionsOf({ ...GOOD, "hero.cta.label": "Probleminizi bizə danışın" }),
      ctx,
    );
    const done = await leavePartsAsBuilt(out, ctx, CALL(m), () => true, {
      tried: new Set(["hero.cta.label"]),
    });
    expect(inputs).toHaveLength(0);
    // The first rule the lint names for the label: it changed the object too.
    expect(done.asBuilt).toEqual([{ path: "hero.cta.label", rule: "cta-object-changed" }]);
  });

  describe("a headline built word by word", () => {
    const TEMPLATE = "Read every {br} visitor's {rot:intent|source|page}";
    const template = (extra: Manifest = {}): Manifest => ({
      "hero.headline": {
        css: ["h1"],
        text: ["Read every visitor's intent"],
        structural: "h1",
        original_char_length: 27,
        inline: {
          icons: "none",
          emphasis: 0,
          split: true,
          animated_text: true,
          template: TEMPLATE,
        },
      },
      "hero.body": {
        css: ["p"],
        text: ["One line under the headline of the page here."],
        structural: "p",
        original_char_length: 45,
        inline: { ...PLAIN },
      },
      ...extra,
    });
    const ctxT = (m: Manifest) => ({
      language: "en",
      allowedNumbers: collectNumbers(["none"]),
      originalLengths: new Map(Object.entries(m).map(([p, e]) => [p, e.original_char_length ?? 0])),
      originalTexts: new Map(Object.entries(m).map(([p, e]) => [p, e.text[0] ?? ""])),
      templates: new Map([["hero.headline", TEMPLATE]]),
    });
    const broken = () => ({
      hero: {
        kind: "hero",
        // The model answered a plain sentence: the page's lines and rotating word are gone.
        headline: "See who is reading your page today",
        body: "A line under the headline, written for you.",
      },
    });

    it("that lost its structure and is the page's only headline: the row is refused, no call", async () => {
      const m = template();
      const ctx = ctxT(m);
      const out = outcomeOf(broken(), ctx);
      expect(out.hard.some((f) => f.rule.startsWith("template-"))).toBe(true);
      const done = await leavePartsAsBuilt(out, ctx, CALL(m), () => true);
      expect(inputs).toHaveLength(0);
      expect(done.refusal).toBe("the page's only headline lost its structure");
      expect(done.hard.length).toBeGreaterThan(0);
      expect(refusalReason(done)).toMatch(
        /^lint: the page's only headline lost its structure; hero\.headline template-/,
      );
    });

    it("on a page with another headline it is left as built", async () => {
      const m = template({
        "features.headline": {
          css: ["h2"],
          text: ["What you get with it"],
          structural: "h2",
          original_char_length: 20,
          inline: { ...PLAIN },
        },
      });
      const ctx = ctxT(m);
      const sections = {
        ...broken(),
        features: { kind: "features", headline: "What it gives you" },
      };
      const out = outcomeOf(sections, ctx);
      const done = await leavePartsAsBuilt(out, ctx, CALL(m), () => true);
      expect(done.hard).toEqual([]);
      expect(done.asBuilt?.map((p) => p.path)).toEqual(["hero.headline"]);
      expect(done.asBuilt?.[0]?.rule).toMatch(/^template-/);
      expect((sections.hero as Record<string, unknown>).headline).toBeUndefined();
    });

    it("that keeps its structure and copies the page gets its call as a list of words", async () => {
      const m = template();
      const ctx = ctxT(m);
      const sections = {
        hero: {
          kind: "hero",
          headline: "Read every {br} visitor's {rot:intent|source|page}",
          body: "A line under the headline, written for you.",
        },
      };
      const out = outcomeOf(sections, ctx);
      expect(out.hard.map((f) => f.rule)).toContain("template-copy");
      answerFor = () => JSON.stringify({ words: ["Know each", "reader's"] });
      const done = await leavePartsAsBuilt(out, ctx, CALL(m), () => true);
      expect(partCalls()).toHaveLength(1);
      expect(partCalls()[0]?.prompt).toContain('["Read every","visitor\'s"]');
      expect(partCalls()[0]?.prompt).toContain("- template-copy");
      expect(done.hard).toEqual([]);
      expect(done.asBuilt).toEqual([]);
      expect(sections.hero.headline).toBe("Know each {br} reader's {rot:intent|source|page}");
    });

    it("a rotating headline the grammar check turned down is left as built without a call", async () => {
      const m = template({
        "features.headline": {
          css: ["h2"],
          text: ["What you get with it"],
          structural: "h2",
          original_char_length: 20,
          inline: { ...PLAIN },
        },
      });
      const ctx = ctxT(m);
      const sections = {
        hero: {
          kind: "hero",
          headline: "Know each {br} reader's {rot:intent|source|page}",
          body: "A line under the headline, written for you.",
        },
        features: { kind: "features", headline: "What it gives you" },
      };
      const out = outcomeOf(sections, ctx);
      expect(out.hard).toEqual([]);
      const judged = {
        ...out,
        hard: [
          {
            path: "hero.headline",
            rule: "rotator-grammar",
            excerpt: '"Know each reader\'s page" does not read as a sentence',
            severity: "hard" as const,
          },
        ],
      };
      const done = await leavePartsAsBuilt(judged, ctx, CALL(m), () => true, { calls: false });
      expect(inputs).toHaveLength(0);
      expect(done.hard).toEqual([]);
      expect(done.asBuilt).toEqual([{ path: "hero.headline", rule: "rotator-grammar" }]);
      // The grammar check has nothing left to judge on that part.
      expect(await judgeReadings(done.body, CALL(m), "en")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// The body without the part
// ---------------------------------------------------------------------------

describe("a part taken out of a body", () => {
  it("goes with its other lengths, its spare candidates and a label's link", () => {
    const sections: Record<string, unknown> = {
      hero: {
        kind: "hero",
        headline: "One",
        headline_alt: "One longer",
        headline_alt2: "On",
        headline_more: ["x"],
        body: "Body",
        body_alt: "Bod",
        cta: { label: "Go", href: "#go" },
      },
      features: { kind: "features", headline: "Only part" },
      forms: { kind: "forms", submit_label: "Send" },
    };
    expect(removePart(sections, "hero.headline")).toBe(true);
    expect(removePart(sections, "hero.cta.label")).toBe(true);
    expect(removePart(sections, "features.headline")).toBe(true);
    expect(removePart(sections, "pricing.headline")).toBe(false);
    expect(sections).toEqual({
      hero: { kind: "hero", body: "Body", body_alt: "Bod" },
      forms: { kind: "forms", submit_label: "Send" },
    });
    expect(writtenParts(sections)).toEqual(["hero.body", "forms.submit_label"]);
  });

  it("the later passes leave the missing part alone", async () => {
    // The page emphasises a phrase of the paragraph and measured nothing.
    const m = manifestOf();
    (m["hero.body"] as { inline: Record<string, unknown> }).inline.emphasis = 1;
    const ctx = ctxOf(m, { emphasisSlots: new Set(["hero.body"]) });
    const sections = sectionsOf({ ...GOOD, "hero.body": BODY_80 });
    const out = outcomeOf(sections, ctx);
    // Before: the paragraph owes a short length and an emphasised phrase.
    expect(out.soft.map((f) => `${f.path} ${f.rule}`)).toEqual(
      expect.arrayContaining(["hero.body emphasis-missing", "hero.body_alt short-missing"]),
    );
    const done = await leavePartsAsBuilt(out, ctx, CALL(m), () => false);
    expect(done.asBuilt).toEqual([{ path: "hero.body", rule: "length-drift" }]);
    expect(done.soft.some((f) => f.path.startsWith("hero.body"))).toBe(false);
    inputs = [];
    const short = await shortenMissing(done, ctx, CALL(m), () => true);
    const marked = await markEmphasis(short, ctx, CALL(m), () => true);
    // Calls for the headlines' short lengths only; none names the paragraph.
    expect(inputs.every((i) => !i.prompt.includes("paragraph"))).toBe(true);
    expect(inputs.every((i) => !i.prompt.includes("italics"))).toBe(true);
    expect((marked.body.sections.hero as Record<string, unknown>).body).toBeUndefined();
    // Building the templates and choosing by wrap find nothing to do there.
    const again = JSON.parse(JSON.stringify(marked.body.sections)) as Record<string, unknown>;
    fillTemplates(again, m);
    expect(again).toEqual(marked.body.sections);
  });

  it("a later pass that hands the part back does not put it on the page", () => {
    const m = manifestOf();
    const ctx = ctxOf(m);
    const out = {
      ...outcomeOf(sectionsOf(GOOD), ctx),
      asBuilt: [{ path: "hero.body", rule: "length-drift" }],
    };
    const kept = keepAsBuilt(out, ctx);
    expect((kept.body.sections.hero as Record<string, unknown>).body).toBeUndefined();
    expect(kept.hard).toEqual([]);
    // Nothing to take out: the same outcome comes back.
    expect(keepAsBuilt(kept, ctx)).toBe(kept);
  });
});

describe("the row's flags and reason", () => {
  it("writes and reads part-as-built with the path and the rule only", () => {
    const flag = partAsBuiltFlag({ path: "hero.body", rule: "length-drift" });
    expect(flag).toBe("part-as-built:hero.body:length-drift");
    const stored = JSON.stringify(["length-drift", "alt-copies", flag, "banned:seamless"]);
    expect(partsAsBuiltOf(stored)).toEqual([{ path: "hero.body", rule: "length-drift" }]);
    expect(partsAsBuiltOf(null)).toEqual([]);
    expect(partsAsBuiltOf("not json")).toEqual([]);
    expect(partsAsBuiltOf(["part-as-built:", "part-as-built:hero.body:"])).toEqual([]);
    expect(lintFlagsOf(stored)).toHaveLength(4);
  });

  it("stores the soft rules, then the parts as built", () => {
    expect(
      rowLintFlags({
        soft: [{ path: "hero.headline", rule: "length-drift", excerpt: "x", severity: "soft" }],
        asBuilt: [{ path: "hero.body", rule: "number-not-in-brief" }],
      }),
    ).toEqual(["length-drift", "part-as-built:hero.body:number-not-in-brief"]);
  });

  it("a refusal still reads as a verdict of the copy checks, rule by rule", () => {
    const reason = refusalReason({
      refusal: "3 of 5 parts could not be written",
      hard: [
        { path: "hero.body", rule: "length-drift", excerpt: "80 characters", severity: "hard" },
        { path: "features.headline", rule: "length-drift", excerpt: "38", severity: "hard" },
      ],
    });
    expect(reason.startsWith("lint: ")).toBe(true);
    // The ops summary's own reading of a reason (cron/ops-heartbeat.ts).
    const rules = [...reason.matchAll(/(?:lint:|;)\s*[\w-]+\.[\w.-]+ ([a-z][a-z-]*)/g)].map(
      (x) => x[1],
    );
    expect(rules).toEqual(["length-drift", "length-drift"]);
  });
});

// ---------------------------------------------------------------------------
// The admin reads (the contract for the dashboard)
// ---------------------------------------------------------------------------

describe("the admin reads", () => {
  const SUPER = { id: "u", email: "a@b.c", role: "superadmin", customer_id: null } as never;
  const list = async (env: ReturnType<typeof setup>["env"], query = "") => {
    const { handleVariantsList } = await import("../src/admin/handlers.ts");
    const res = await handleVariantsList(
      new Request(`https://api.test/admin/variants/list?customer_id=medora${query}`),
      { ...env, DASHBOARD_ORIGIN: "https://app.test", ENVIRONMENT: "test" } as never,
      SUPER,
    );
    return res.json() as Promise<unknown>;
  };

  it("a row says which parts it leaves as built; the old fields are as they were", async () => {
    const { env } = setup();
    modelWriting({ ...GOOD, "hero.body": BODY_80 }, () => BODY_80);
    await regenerateOne("medora", "problem", "community", env, "/");
    modelWriting(GOOD, () => "");
    await regenerateOne("medora", "brand", "community", env, "/");

    const items = (await list(env)) as Array<Record<string, unknown>>;
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(2);
    const problem = items.find((i) => i.intent_dim === "problem");
    const brand = items.find((i) => i.intent_dim === "brand");
    expect(problem).toMatchObject({
      intent_dim: "problem",
      source_dim: "community",
      page_path: "/",
      model: "model-a",
      status: "ready",
      kv_key: KEY("problem", "community"),
      parts_as_built: [{ path: "hero.body", rule: "length-drift" }],
    });
    expect(typeof problem?.generated_at).toBe("number");
    expect(typeof problem?.cost_usd).toBe("number");
    expect(problem?.lint_flags).toContain("part-as-built:hero.body:length-drift");
    expect(brand?.parts_as_built).toEqual([]);
    expect(Array.isArray(brand?.lint_flags)).toBe(true);
  });

  it("the summary counts written, with parts as built and refused, and says what a refused row serves", async () => {
    const { env, db, kv } = setup();
    // One row with a part as built, one whole.
    modelWriting({ ...GOOD, "hero.body": BODY_80 }, () => BODY_80);
    await regenerateOne("medora", "problem", "community", env, "/");
    modelWriting(GOOD, () => "");
    await regenerateOne("medora", "problem", "default", env, "/");
    await regenerateOne("medora", "brand", "ai", env, "/");
    // brand:ai is rewritten and refused: its older body keeps serving.
    const twin = GOOD["features.headline"];
    modelWriting({ ...GOOD, "hero.headline": twin }, () => twin);
    expect((await regenerateOne("medora", "brand", "ai", env, "/")).ok).toBe(false);
    // problem:social is refused on its first write: the page's default serves.
    expect((await regenerateOne("medora", "problem", "social", env, "/")).ok).toBe(false);
    // feature:ai too, and no version of that intent exists: the page as built.
    expect((await regenerateOne("medora", "feature", "ai", env, "/")).ok).toBe(false);
    // A provider failure is not a verdict of the copy checks.
    db.prepare(
      "INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status, error_reason) SELECT 'x1', 'medora', id, ?, 'model-a', 'e', 1, 0, 'error', 'Timeout after 45000ms' FROM intent_profiles WHERE profile_key = 'intent:brand' AND customer_id IS NULL",
    ).run(KEY("brand", "social"));

    const answer = (await list(env, "&summary=1")) as {
      items: Array<Record<string, unknown>>;
      summary: Record<string, unknown> & { refused_rows: Array<Record<string, unknown>> };
    };
    // The items are the ready and stale rows, as without the summary.
    expect(answer.items.map((i) => `${i.intent_dim}:${i.source_dim}`).sort()).toEqual([
      "problem:community",
      "problem:default",
    ]);
    expect(answer.summary).toMatchObject({
      written: 2,
      with_parts_as_built: 1,
      refused: 3,
      failed: 1,
    });
    const serving = Object.fromEntries(
      answer.summary.refused_rows.map((r) => [`${r.intent_dim}:${r.source_dim}`, r.serving]),
    );
    expect(serving).toEqual({
      "brand:ai": "older",
      "problem:social": "nearest",
      "feature:ai": "original",
    });
    for (const r of answer.summary.refused_rows) {
      expect(r.page_path).toBe("/");
      expect(String(r.error_reason).startsWith("lint: two parts still say the same thing")).toBe(
        true,
      );
    }
    // The older body of brand:ai is still the live one.
    const live = JSON.parse(kv.store.get(KEY("brand", "ai")) ?? "{}") as VariantBody;
    expect(live.sections.hero?.headline).toBe(GOOD["hero.headline"]);
  });

  it("a folded intent's rows are in no count", async () => {
    const { env, db } = setup();
    modelWriting(GOOD, () => "");
    await regenerateOne("medora", "problem", "default", env, "/");
    await regenerateOne("medora", "pricing", "default", env, "/");
    db.prepare(
      `UPDATE customers SET served_intents = '["evaluation","feature","problem","brand"]' WHERE id = 'medora'`,
    ).run();
    const answer = (await list(env, "&summary=1")) as { summary: { written: number } };
    expect(answer.summary.written).toBe(1);
  });
});
