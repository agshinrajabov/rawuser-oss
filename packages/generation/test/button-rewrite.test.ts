/**
 * Buttons are not rewritten unless the operator turns that button on (the
 * founder's decision of 2026-10-12; lib/button-rewrite.ts; mock
 * design/mock/sales-readiness/pilot-gaps.html, screen 04).
 *
 * The page is the pilot's home page as it was read on 2026-10-12: five parts,
 * two of them buttons (the hero button, counted, and the form's submit).
 * On that page 7 of 20 versions gave the hero button words that asked for
 * something else. Off, a button is in no prompt, no body, no lint, no hide
 * rule and no visitor bundle; counted, it is still counted.
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

vi.mock("../src/site-map/served-load.ts", () => ({
  loadServedIntents: vi.fn(async () => ["problem"]),
}));

const { orchestrate, regenerateOne, ctasOf, NOTHING_TO_WRITE } = await import(
  "../src/orchestrator.ts"
);
const {
  buttonsOf,
  carryRewrite,
  isCounted,
  isOffButton,
  nothingToWrite,
  rewriteOn,
  setRewrite,
  unwrittenButtons,
  writtenManifest,
} = await import("../src/lib/button-rewrite.ts");
const { writeHideRules, storeUnconfirmedManifest, storedManifestOf } = await import(
  "../src/admin/onboard.ts"
);
const { previewHero, currentHero } = await import("../src/admin/quickstart.ts");
const { buildIntentPrompt, buttonsBlock } = await import("../src/prompts/intent-prompts.ts");
const { attachInlineShapes } = await import("../src/inline-shape-html.ts");
const { resetPageLinks } = await import("../src/page-links.ts");
const { resetReads } = await import("../src/inline-shape-backfill.ts");

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
type Path = keyof typeof PAGE;

const SELECTORS: Record<Path, string> = {
  "hero.headline": "section.hero h1",
  "hero.body": "section.hero p.lead",
  "hero.cta.label": "section.hero a.btn",
  "features.headline": "section.products h2",
  "forms.submit_label": "form.contact button",
};

const html = () =>
  `<html lang="az"><body><main><section class="hero"><h1>${PAGE["hero.headline"]}</h1>
<p class="lead">${PAGE["hero.body"]}</p><a class="btn" href="https://www.medora.test/products">${PAGE["hero.cta.label"]}</a></section>
<section class="products"><h2>${PAGE["features.headline"]}</h2></section>
<form class="contact"><button type="submit">${PAGE["forms.submit_label"]}</button></form></main></body></html>`;

const PLAIN = { icons: "none", emphasis: 0, split: false, animated_text: false } as const;

/** The manifest as every customer's is stored today: no button says `rewrite`. */
function manifestOf(only: readonly Path[] = Object.keys(PAGE) as Path[]): Manifest {
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
  return out;
}
const on = (m: Manifest, path: string): Manifest => setRewrite(m, path, true) as Manifest;

/** What a model that was never told about the switch writes: all five parts. */
const ALL = {
  "hero.headline": "Öz brendiniz üçün etibarlı əlavə istehsalçısı",
  "hero.body": "Reseptdən qablaşdırmaya qədər hər addımı yalnız bir heyət izləyir.",
  "hero.cta.label": "Məhsullarımıza baxın",
  "features.headline": "İstehsal etdiyimiz əlavələr",
  "forms.submit_label": "Göndərin",
} as const;

function sectionsOf(parts: Partial<Record<Path, string>>): Record<string, unknown> {
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

/** The model answers `parts`, whatever the prompt asked for, and the same on a revise. */
function modelWriting(parts: Partial<Record<Path, string>>) {
  let last = "";
  answerFor = (input) => {
    if (input.prompt.includes("Revise the JSON object")) return last;
    if (!input.prompt.includes("profile_key")) return "{}";
    last = JSON.stringify({
      customer_id: "medora",
      profile_key: `intent:${/"intent:(\w+)"/.exec(input.prompt)?.[1] ?? "problem"}`,
      sections: sectionsOf(parts),
      generated_at: 1,
      prompt_hash: "",
    });
    return last;
  };
}

function setup(manifest: Manifest = manifestOf(), counted: string | null = "hero.cta.label") {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    "INSERT INTO customers (id, slug, domain, plan, status, created_at, auto_approve, live_at, site_map_off) VALUES ('medora', 'medora', 'www.medora.test', 'pilot', 'active', 1, 1, 2, 1)",
  ).run();
  db.prepare(
    `INSERT INTO business_dna (customer_id, product, icp, brand_voice, updated_at, value_props, differentiators, proof_points, target_market, target_language, per_intent_hints)
     VALUES ('medora', 'Qida əlavələrinin sifarişlə istehsalı', 'Öz brendi olan şirkətlər', 'sakit, dəqiq', 1, '["İstehsal"]', '["Fərdi formul"]', '["Sertifikat"]', 'Yerli bazar', 'az', '{}')`,
  ).run();
  db.prepare(
    "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('medora', '/', ?, 'https://www.medora.test/', 1, 1, 'az')",
  ).run(JSON.stringify(manifest));
  if (counted) {
    db.prepare(
      `INSERT INTO conversion_targets (id, customer_id, section_path, label, conversion_label, enabled, css_selectors, text_selectors, structural_selector, created_at, updated_at)
       VALUES ('t1', 'medora', ?, 'Hero button', 'other', 1, ?, ?, 'primary CTA button in the hero section', 1, 1)`,
    ).run(
      counted,
      JSON.stringify([".hero-section .btn-light"]),
      JSON.stringify([PAGE["hero.cta.label"]]),
    );
  }
  const kv = makeKv();
  pageHtml = html();
  return { env: { ...MODEL_ENV, DB: d1, VARIANTS: kv }, db, kv };
}

const firstPrompt = () => inputs.find((i) => i.prompt.includes("profile_key:"))?.prompt ?? "";
const served = (kv: ReturnType<typeof makeKv>, source = "ai") =>
  JSON.parse(kv.store.get(`v1:variant:medora:problem:${source}`) ?? "{}") as VariantBody;
const leaves = (body: VariantBody): string[] => {
  const out: string[] = [];
  const walk = (o: unknown, prefix: string) => {
    for (const [k, v] of Object.entries((o ?? {}) as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "string") {
        if (k !== "kind" && !/_alt2?$/.test(k)) out.push(p);
      } else walk(v, p);
    }
  };
  walk(body.sections, "");
  return out.sort();
};

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

describe("the switch on a manifest entry", () => {
  it("absent means off for a button, and means nothing on a part that is not a button", () => {
    const m = manifestOf();
    expect(isOffButton("hero.cta.label", m["hero.cta.label"])).toBe(true);
    expect(isOffButton("forms.submit_label", m["forms.submit_label"])).toBe(true);
    expect(isOffButton("hero.headline", m["hero.headline"])).toBe(false);
    expect(Object.keys(writtenManifest(m))).toEqual([
      "hero.headline",
      "hero.body",
      "features.headline",
    ]);
    // A headline that somehow carries the field is written like any headline.
    const odd = { ...m, "hero.headline": { ...m["hero.headline"], rewrite: false } } as Manifest;
    expect("hero.headline" in writtenManifest(odd)).toBe(true);
  });

  it("only `true` is on", () => {
    const m = manifestOf();
    for (const value of ["true", 1, "yes", {}, null, false]) {
      const e = { ...m["hero.cta.label"], rewrite: value } as unknown as Manifest[string];
      expect(rewriteOn(e)).toBe(false);
    }
    expect(rewriteOn(on(m, "hero.cta.label")["hero.cta.label"])).toBe(true);
  });

  it("on keeps the button, off stores the entry as it always was", () => {
    const m = manifestOf();
    const turnedOn = on(m, "hero.cta.label");
    expect(Object.keys(writtenManifest(turnedOn))).toEqual([
      "hero.headline",
      "hero.body",
      "hero.cta.label",
      "features.headline",
    ]);
    expect(setRewrite(turnedOn, "hero.cta.label", false)).toEqual(m);
    // The stored manifest is never changed by a read.
    expect(Object.keys(turnedOn)).toHaveLength(5);
    expect(setRewrite(m, "hero.headline", true)).toBeNull();
    expect(setRewrite(m, "pricing.cta.label", true)).toBeNull();
  });

  it("an off button's link path goes with it", () => {
    const m: Manifest = {
      ...manifestOf(["hero.headline", "hero.cta.label"]),
      "hero.cta.href": { css: ["section.hero a.btn"], text: [], structural: "its link" },
    };
    expect(Object.keys(writtenManifest(m))).toEqual(["hero.headline"]);
    expect(Object.keys(writtenManifest(on(m, "hero.cta.label")))).toEqual([
      "hero.headline",
      "hero.cta.label",
      "hero.cta.href",
    ]);
  });

  it("a page of buttons only has nothing to write; a customer without a manifest is another case", () => {
    const m = manifestOf(["hero.cta.label", "forms.submit_label"]);
    expect(nothingToWrite(m)).toBe(true);
    expect(nothingToWrite(on(m, "forms.submit_label"))).toBe(false);
    expect(nothingToWrite(manifestOf())).toBe(false);
    expect(nothingToWrite(null)).toBe(false);
    expect(nothingToWrite({})).toBe(false);
  });

  it("the page's own read keeps the field (shapes and lengths are attached around it)", () => {
    const m = on(manifestOf(), "hero.cta.label");
    expect(rewriteOn(attachInlineShapes(html(), m)["hero.cta.label"])).toBe(true);
  });
});

describe("a page read again keeps the switch where the button is the same one", () => {
  const prev = on(manifestOf(), "hero.cta.label");

  it("the same selector or the same words: kept", () => {
    const again = manifestOf();
    expect(rewriteOn(carryRewrite(again, prev)["hero.cta.label"])).toBe(true);
    const reselected: Manifest = {
      ...again,
      "hero.cta.label": {
        ...(again["hero.cta.label"] as Manifest[string]),
        css: ["main a.btn-light"],
      },
    };
    expect(rewriteOn(carryRewrite(reselected, prev)["hero.cta.label"])).toBe(true);
    // The other button was never on.
    expect(rewriteOn(carryRewrite(again, prev)["forms.submit_label"])).toBe(false);
  });

  it("the slot now points at another button: off again", () => {
    const other: Manifest = {
      ...manifestOf(),
      "hero.cta.label": {
        ...(manifestOf()["hero.cta.label"] as Manifest[string]),
        css: ["nav a.contact"],
        text: ["Əlaqə"],
      },
    };
    expect(rewriteOn(carryRewrite(other, prev)["hero.cta.label"])).toBe(false);
  });

  it("an entry that says the word itself decides, true or false", () => {
    const saysOff = setRewrite(manifestOf(), "hero.cta.label", false) as Manifest;
    const explicit = {
      ...saysOff,
      "hero.cta.label": { ...saysOff["hero.cta.label"], rewrite: false },
    } as Manifest;
    expect(rewriteOn(carryRewrite(explicit, prev)["hero.cta.label"])).toBe(false);
    const saysOn = on(manifestOf(), "forms.submit_label");
    expect(rewriteOn(carryRewrite(saysOn, manifestOf())["forms.submit_label"])).toBe(true);
  });

  it("storing a new read of the page keeps it, unconfirmed as ever", async () => {
    const { env, db } = setup(prev);
    await storeUnconfirmedManifest(env.DB, {
      customer_id: "medora",
      page_path: "/",
      manifest: manifestOf(),
      source_url: "https://www.medora.test/",
      cost_usd: 0,
    });
    const stored = (await storedManifestOf(env.DB, "medora", "/")) as Manifest;
    expect(rewriteOn(stored["hero.cta.label"])).toBe(true);
    expect(rewriteOn(stored["forms.submit_label"])).toBe(false);
    expect(
      db.prepare("SELECT confirmed_at FROM element_manifests WHERE customer_id = 'medora'").get(),
    ).toEqual({ confirmed_at: null });
  });
});

describe("the list the Look screen reads", () => {
  it("every button with its switch, its words, and whether it is counted", () => {
    const m = on(manifestOf(), "forms.submit_label");
    expect(buttonsOf(m, "/", [{ section_path: "hero.cta.label" }])).toEqual([
      {
        path: "hero.cta.label",
        label: "Hero button",
        text: "Məhsullarımızla tanış olun!",
        rewrite: false,
        counted: true,
        form: false,
      },
      {
        path: "forms.submit_label",
        label: "Form submit button",
        text: "Göndər",
        rewrite: true,
        counted: false,
        form: true,
      },
    ]);
  });

  it("a button picked on the page is counted when it is the same element, on that page only", () => {
    const entry = manifestOf()["hero.cta.label"] as Manifest[string];
    const picked = { section_path: "count:/", css: ["section.hero a.btn"], text: [] };
    expect(isCounted("hero.cta.label", entry, "/", [picked])).toBe(true);
    expect(isCounted("hero.cta.label", entry, "/pricing", [picked])).toBe(false);
    const byWords = { section_path: "count:/", css: ["#x"], text: ["Məhsullarımızla tanış olun!"] };
    expect(isCounted("hero.cta.label", entry, "/", [byWords])).toBe(true);
    const another = { section_path: "count:/", css: ["nav a"], text: ["Əlaqə"] };
    expect(isCounted("hero.cta.label", entry, "/", [another])).toBe(false);
    expect(isCounted("hero.cta.label", entry, "/", [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

describe("generation leaves an off button out, like a part the manifest does not have", () => {
  it("the prompt names no button path, in no list", () => {
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
    const full = manifestOf();
    const prompt = buildIntentPrompt(
      "problem",
      dna,
      "medora",
      writtenManifest(full),
      ctasOf(full, new Map(), new Set(["hero.cta.label"])),
    );
    expect(prompt).toContain("- hero.headline");
    expect(prompt).toContain("- features.headline");
    expect(prompt).not.toContain("hero.cta.label");
    expect(prompt).not.toContain("forms.submit_label");
    expect(prompt).not.toContain("cta.label");
    expect(prompt).not.toContain("BUTTONS KEEP THEIR ACTION");
    // The page's own label is not shown either: nothing asks for a button.
    expect(prompt).not.toContain(PAGE["hero.cta.label"]);
    // One line says why, without naming a button.
    expect(prompt).toContain(
      "A button that is not in the ALLOWED PATHS keeps the page's own words: emit no label for it.",
    );
    // With every button on, the line is not there.
    const allOn = on(on(full, "hero.cta.label"), "forms.submit_label");
    expect(
      buildIntentPrompt(
        "problem",
        dna,
        "medora",
        writtenManifest(allOn),
        ctasOf(allOn, new Map(), new Set()),
      ),
    ).not.toContain("keeps the page's own words: emit no label");
  });

  it("a model that writes the buttons anyway: they are pruned, the body has three parts", async () => {
    const { env, kv, db } = setup();
    modelWriting(ALL);
    const result = await regenerateOne("medora", "problem", "ai", env, "/");
    expect(result.ok).toBe(true);
    expect(firstPrompt()).not.toContain("hero.cta.label");
    expect(firstPrompt()).not.toContain("submit_label");
    expect(leaves(served(kv))).toEqual(["features.headline", "hero.body", "hero.headline"]);
    expect(served(kv).sections.hero?.cta).toBeUndefined();
    expect(served(kv).sections.forms).toBeUndefined();
    // Not linted: no button rule on the row, and nothing left as built.
    const row = db.prepare("SELECT status, lint_flags FROM variants").get() as {
      status: string;
      lint_flags: string | null;
    };
    expect(row.status).toBe("ready");
    expect(row.lint_flags ?? "").not.toMatch(/cta-|part-as-built/);
    expect(result.parts_as_built).toEqual([]);
  });

  it("a label that asks for a conversation, on a counted button that is off, refuses nothing", async () => {
    // The pilot, 2026-10-12: "Probleminizi bizə danışın" on a button that opens
    // the product list. Off, the words never reach the body, so no rule has
    // anything to say and no call is spent mending them.
    const { env, kv } = setup();
    modelWriting({ ...ALL, "hero.cta.label": "Probleminizi bizə danışın" });
    const result = await regenerateOne("medora", "problem", "ai", env, "/");
    expect(result.ok).toBe(true);
    expect(inputs.filter((i) => i.prompt.includes("It cannot go on the page"))).toEqual([]);
    expect(JSON.stringify(served(kv))).not.toContain("danışın");
  });

  it("turned on, the hero button is written and held by the action and object rules", async () => {
    const { env, kv } = setup(on(manifestOf(), "hero.cta.label"));
    modelWriting(ALL);
    const result = await regenerateOne("medora", "problem", "ai", env, "/");
    expect(result.ok).toBe(true);
    expect(firstPrompt()).toContain("- hero.cta.label");
    expect(firstPrompt()).toContain("BUTTONS KEEP THEIR ACTION");
    expect(firstPrompt()).not.toContain("forms.submit_label");
    expect(leaves(served(kv))).toEqual([
      "features.headline",
      "hero.body",
      "hero.cta.label",
      "hero.headline",
    ]);
    expect(served(kv).sections.hero?.cta?.label).toBe("Məhsullarımıza baxın");

    // The same button, a label that changes its object: the rule of A1.6
    // still stands for a button that is on (it is counted, so hard).
    inputs = [];
    modelWriting({ ...ALL, "hero.cta.label": "Qablaşma prosesimizlə tanış olun" });
    const second = await regenerateOne("medora", "problem", "social", env, "/");
    expect(second.ok).toBe(true);
    expect(second.parts_as_built).toEqual([{ path: "hero.cta.label", rule: "cta-object-changed" }]);
    expect(served(kv, "social").sections.hero?.cta).toBeUndefined();
  });

  it("no other button may show the words of a counted button that stays as built", async () => {
    // The form's button is on, the counted hero button is off. A version
    // that gives the form's button the hero button's own words would show
    // them twice, one of them counted.
    const manifest = on(manifestOf(), "forms.submit_label");
    const { env, kv } = setup(manifest);
    modelWriting({ ...ALL, "forms.submit_label": PAGE["hero.cta.label"] });
    const result = await regenerateOne("medora", "problem", "ai", env, "/");
    // The prompt says the words the model must stay away from.
    expect(firstPrompt()).toContain(
      `Never the words of the counted button (hero.cta.label, which keeps the page's "${PAGE["hero.cta.label"]}")`,
    );
    // The label is refused and left as built; the rest ships.
    expect(result.ok).toBe(true);
    expect(result.parts_as_built?.map((p) => p.path)).toEqual(["forms.submit_label"]);
    expect(served(kv).sections.forms).toBeUndefined();
  });

  it("the buttons block names a counted button's path when it is written", () => {
    const full = on(on(manifestOf(), "hero.cta.label"), "forms.submit_label");
    const block = buttonsBlock(
      writtenManifest(full),
      ctasOf(full, new Map(), new Set(["hero.cta.label"])),
      "az",
    );
    expect(block).toContain("- hero.cta.label");
    expect(block).toContain("This is the counted button");
    expect(block).not.toContain("which keeps the page's");
  });

  it("a button that is on and outside the intent's plan is asked for by name", () => {
    // The form's submit has no section in any plan: before, nothing asked
    // for it and no version of the pilot's twenty wrote it.
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
    const prompt = (m: Manifest) =>
      buildIntentPrompt(
        "problem",
        dna,
        "medora",
        writtenManifest(m),
        ctasOf(m, new Map(), new Set()),
      );
    const formOn = prompt(on(manifestOf(), "forms.submit_label"));
    expect(formOn).toContain("ALSO WRITE (buttons of this page that the plan above does not name");
    expect(formOn.slice(formOn.indexOf("ALSO WRITE"))).toMatch(/\n- forms\.submit_label\n/);
    // The hero button has its section in every plan: no extra line for it.
    const heroOn = prompt(on(manifestOf(), "hero.cta.label"));
    expect(heroOn).not.toContain("ALSO WRITE");
    expect(heroOn).toContain("cta.label");
    // Every button off: nothing is asked.
    expect(prompt(manifestOf())).not.toContain("ALSO WRITE");
  });

  it("a whole run: no version of the page carries a button, whatever the model writes", async () => {
    const { env, kv, db } = setup();
    modelWriting(ALL);
    const run = await orchestrate("medora", env, {});
    expect(run.generated).toBe(6);
    expect(run.errors).toBe(0);
    for (const src of ["default", "ai", "social", "community", "organic", "paid"]) {
      expect(leaves(served(kv, src))).toEqual(["features.headline", "hero.body", "hero.headline"]);
    }
    // The immutable bodies too: what is recorded is what a visitor can get.
    const bodies = db.prepare("SELECT body_json FROM version_bodies").all() as Array<{
      body_json: string;
    }>;
    expect(bodies).toHaveLength(6);
    for (const b of bodies) expect(b.body_json).not.toMatch(/"cta"|submit_label/);
  });

  it("a page of buttons only is not written: no call, no row, a plain answer", async () => {
    const { env, db } = setup(manifestOf(["hero.cta.label", "forms.submit_label"]));
    modelWriting(ALL);
    const one = await regenerateOne("medora", "problem", "ai", env, "/");
    expect(one).toMatchObject({ ok: false, error: NOTHING_TO_WRITE, cost_usd: 0 });
    const run = await orchestrate("medora", env, {});
    expect(run.generated).toBe(0);
    expect(run.errors).toBe(0);
    expect(inputs).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM variants").get()).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------------------
// What a visitor's browser is given
// ---------------------------------------------------------------------------

describe("the hide rules and the visitor bundle", () => {
  const hide = (kv: ReturnType<typeof makeKv>) =>
    JSON.parse(kv.store.get("v1:hide:medora") ?? "{}") as Record<string, string[]>;
  const bundle = (kv: ReturnType<typeof makeKv>) =>
    JSON.parse(kv.store.get("v1:vm:medora") ?? "{}") as {
      pages: Record<string, Manifest>;
      conv: Array<{ section_path: string; css: string[] }>;
    };

  it("an off button is not hidden and is not a target; the counted one is still counted", async () => {
    const { env, kv } = setup();
    await writeHideRules(env, "medora");
    expect(hide(kv)["/"]).toEqual([
      "section.hero h1",
      "section.hero p.lead",
      "section.products h2",
    ]);
    expect(Object.keys(bundle(kv).pages["/"] ?? {})).toEqual([
      "hero.headline",
      "hero.body",
      "features.headline",
    ]);
    // Its own row, its own selectors: counted whatever the switch says.
    expect(bundle(kv).conv).toEqual([
      expect.objectContaining({
        section_path: "hero.cta.label",
        css: [".hero-section .btn-light"],
      }),
    ]);
  });

  it("a button that is on is hidden and is a target, like any written part", async () => {
    const { env, kv } = setup(on(manifestOf(), "hero.cta.label"));
    await writeHideRules(env, "medora");
    expect(hide(kv)["/"]).toContain("section.hero a.btn");
    expect(hide(kv)["/"]).not.toContain("form.contact button");
    expect(Object.keys(bundle(kv).pages["/"] ?? {})).toContain("hero.cta.label");
    expect(Object.keys(bundle(kv).pages["/"] ?? {})).not.toContain("forms.submit_label");
    expect(bundle(kv).conv).toHaveLength(1);
  });

  it("the stored manifest keeps every part, on or off", async () => {
    const { env } = setup();
    await writeHideRules(env, "medora");
    expect(Object.keys((await storedManifestOf(env.DB, "medora", "/")) ?? {})).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

describe("the preview on the Look screen", () => {
  it("shows the page's own words where the version leaves a part as built", () => {
    const current = currentHero(manifestOf());
    const body = {
      sections: sectionsOf({
        "hero.headline": ALL["hero.headline"],
        "hero.body": ALL["hero.body"],
      }),
    } as unknown as VariantBody;
    expect(previewHero(body, current)).toEqual({
      headline: ALL["hero.headline"],
      body: ALL["hero.body"],
      cta: PAGE["hero.cta.label"],
    });
    // Without the page's words, as before.
    expect(previewHero(body).cta).toBeNull();
  });

  it("a version written before a button was turned on owes it its words", () => {
    const m = on(manifestOf(), "hero.cta.label");
    const without = { sections: sectionsOf({ "hero.headline": ALL["hero.headline"] }) };
    const withLabel = { sections: sectionsOf(ALL) };
    expect(unwrittenButtons(m, without)).toEqual(["hero.cta.label"]);
    expect(unwrittenButtons(m, withLabel)).toEqual([]);
    // Left as built by the copy checks: said on the row, no rewrite owed.
    expect(
      unwrittenButtons(m, without, ["part-as-built:hero.cta.label:cta-object-changed"]),
    ).toEqual([]);
    // Every button off: nothing is owed.
    expect(unwrittenButtons(manifestOf(), without)).toEqual([]);
  });
});
