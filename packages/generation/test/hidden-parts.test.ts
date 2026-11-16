/**
 * A part no version writes is not hidden (A14 of
 * docs/specs/pilot-gaps.md; lib/hidden-parts.ts).
 *
 * Live on the pilot's site: the form's submit button was in the manifest and in no
 * version, so it was hidden and shown as built on every load. The page here
 * has the pilot's shape of that morning: five parts a version may write (both
 * buttons turned on) and versions that write four.
 *
 * The order of events is the test: every part stays hidden from the confirm
 * until the page's versions are all written or refused, and again while they
 * are rewritten, so no part is read in its own words and then changed.
 */
import type { Manifest } from "@rawuser/shared";
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

let served: string[] = ["problem"];
vi.mock("../src/site-map/served-load.ts", () => ({
  loadServedIntents: vi.fn(async () => served),
}));

const { orchestrate, regenerateOne } = await import("../src/orchestrator.ts");
const { runRegenQueue, QUEUE_ERROR_RETRY_MS } = await import("../src/cron/regen-queue.ts");
const { writeHideRules, sweepHideRules } = await import("../src/admin/onboard.ts");
const { handleVariantsStaleAll } = await import("../src/admin/handlers.ts");
const { partsVersionsWrite, partOfLeaf, unsettledReason } = await import(
  "../src/lib/hidden-parts.ts"
);
const { setRewrite } = await import("../src/lib/button-rewrite.ts");
const { resetPageLinks } = await import("../src/page-links.ts");
const { resetReads } = await import("../src/inline-shape-backfill.ts");

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
const ALL_FIVE = Object.values(SELECTORS);
const FOUR = ALL_FIVE.filter((s) => s !== "form.contact button");

const PLAIN = { icons: "none", emphasis: 0, split: false, animated_text: false } as const;
function manifestOf(): Manifest {
  let out: Manifest = {};
  for (const path of Object.keys(PAGE) as Path[]) {
    out[path] = {
      css: [SELECTORS[path]],
      text: [PAGE[path].slice(0, 40)],
      structural: path,
      original_char_length: PAGE[path].length,
      original_word_count: PAGE[path].split(" ").length,
      inline: { ...PLAIN },
    };
  }
  // That morning both buttons were written parts: on (lib/button-rewrite.ts).
  for (const path of ["hero.cta.label", "forms.submit_label"]) {
    out = setRewrite(out, path, true) as Manifest;
  }
  return out;
}

/** What the pilot's versions wrote: four parts, never the form's button. */
const FOUR_PARTS = {
  "hero.headline": "Öz brendiniz üçün etibarlı əlavə istehsalçısı",
  "hero.body": "Reseptdən qablaşdırmaya qədər hər addımı yalnız bir heyət izləyir.",
  "hero.cta.label": "Məhsullarımıza baxın",
  "features.headline": "İstehsal etdiyimiz əlavələr",
} as const;
/** A version that cannot be written: both text parts far over their caps. */
const TOO_LONG = {
  ...FOUR_PARTS,
  "hero.headline":
    "Öz brendiniz üçün etibarlı, təcrübəli və hər mərhələdə yanınızda olan əlavə istehsalçısı",
  "hero.body":
    "Reseptdən qablaşdırmaya qədər hər addımı yalnız bir heyət izləyir, sizə isə yalnız satış işi qalır sonda.",
  "features.headline": "Sizin üçün istehsal etdiyimiz bütün qida əlavələrinin tam siyahısı",
} as const;

function sectionsOf(parts: Record<string, string>): Record<string, unknown> {
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
/** Asked for one part alone, the model answers with this: over every cap. */
const STILL_TOO_LONG =
  "Reseptdən qablaşdırmaya qədər hər addımı yalnız bir heyət izləyir, sizə isə yalnız satış işi qalır sonda.";
function modelWriting(parts: Record<string, string>) {
  let last = "";
  answerFor = (input) => {
    if (input.prompt.includes("It cannot go on the page as it is")) {
      return JSON.stringify({ text: STILL_TOO_LONG });
    }
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

function setup(pages: string[] = ["/"]) {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    "INSERT INTO customers (id, slug, domain, plan, status, created_at, auto_approve, live_at, site_map_off) VALUES ('medora', 'medora', 'www.medora.test', 'pilot', 'active', 1, 1, 2, 1)",
  ).run();
  db.prepare(
    `INSERT INTO business_dna (customer_id, product, icp, brand_voice, updated_at, value_props, differentiators, proof_points, target_market, target_language, per_intent_hints)
     VALUES ('medora', 'Qida əlavələrinin sifarişlə istehsalı', 'Öz brendi olan şirkətlər', 'sakit, dəqiq', 1, '["İstehsal"]', '["Fərdi formul"]', '["Sertifikat"]', 'Yerli bazar', 'az', '{}')`,
  ).run();
  for (const page of pages) {
    db.prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('medora', ?, ?, 'https://www.medora.test/', 1, 1, 'az')",
    ).run(page, JSON.stringify(manifestOf()));
  }
  const kv = makeKv();
  pageHtml = `<html lang="az"><body><main><section class="hero"><h1>${PAGE["hero.headline"]}</h1>
<p class="lead">${PAGE["hero.body"]}</p><a class="btn" href="https://www.medora.test/products">${PAGE["hero.cta.label"]}</a></section>
<section class="products"><h2>${PAGE["features.headline"]}</h2></section>
<form class="contact"><button type="submit">${PAGE["forms.submit_label"]}</button></form></main></body></html>`;
  const env = { ...MODEL_ENV, DB: d1, VARIANTS: kv, ADMIN_ORIGIN: "*" };
  const hidden = (page = "/") =>
    (JSON.parse(kv.store.get("v1:hide:medora") ?? "{}") as Record<string, string[]>)[page] ?? [];
  const targets = (page = "/") =>
    Object.keys(
      (
        JSON.parse(kv.store.get("v1:vm:medora") ?? "{}") as {
          pages?: Record<string, Record<string, unknown>>;
        }
      ).pages?.[page] ?? {},
    );
  const pass = () => runRegenQueue(env as never, (id, e, o) => orchestrate(id, e, o));
  return { env, db, kv, hidden, targets, pass };
}

const T0 = Date.UTC(2026, 9, 12, 8, 0, 0);
const MIN = 60_000;

beforeEach(() => {
  inputs = [];
  served = ["problem"];
  answerFor = () => "{}";
  resetPageLinks();
  resetReads();
});

describe("Medora's page: five parts in the manifest, four written", () => {
  it("at the confirm, before any version, every part is hidden", async () => {
    const s = setup();
    await writeHideRules(s.env, "medora");
    expect(s.hidden()).toEqual(ALL_FIVE);
  });

  it("while the versions are being written, every part stays hidden", async () => {
    const s = setup();
    await writeHideRules(s.env, "medora");
    modelWriting(FOUR_PARTS);
    // Three of the five, as a capped pass leaves it.
    const run = await orchestrate("medora", s.env as never, { onlyMissing: true, maxTuples: 3 });
    expect(run.generated).toBe(3);
    expect(s.hidden()).toEqual(ALL_FIVE);
  });

  it("once every version is written, the part none of them writes is not hidden", async () => {
    const s = setup();
    await writeHideRules(s.env, "medora");
    modelWriting(FOUR_PARTS);
    const run = await orchestrate("medora", s.env as never, {});
    expect(run.generated).toBe(6);
    // Rebuilt by the run itself: no wait for the sweep.
    expect(s.hidden()).toEqual(FOUR);
    expect(s.hidden()).not.toContain("form.contact button");
    // The visitor bundle keeps every written part: a target without words is not written.
    expect(s.targets()).toEqual(Object.keys(PAGE));
    // The six-hourly sweep says the same.
    await sweepHideRules(s.env);
    expect(s.hidden()).toEqual(FOUR);
  });

  it("the Live screen's loop, one version at a time: all five until the last one lands", async () => {
    const s = setup();
    await writeHideRules(s.env, "medora");
    modelWriting(FOUR_PARTS);
    const sources = ["default", "ai", "social", "community", "organic", "paid"];
    for (const [i, source] of sources.entries()) {
      const r = await regenerateOne("medora", "problem", source, s.env as never, "/");
      expect(r.ok).toBe(true);
      expect(s.hidden()).toEqual(i < sources.length - 1 ? ALL_FIVE : FOUR);
    }
  });

  it("a version that writes the fifth part puts it back", async () => {
    const s = setup();
    modelWriting(FOUR_PARTS);
    await orchestrate("medora", s.env as never, {});
    expect(s.hidden()).toEqual(FOUR);
    modelWriting({ ...FOUR_PARTS, "forms.submit_label": "Göndərin" });
    const r = await regenerateOne("medora", "problem", "ai", s.env as never, "/");
    expect(r.ok).toBe(true);
    expect(s.hidden()).toEqual(ALL_FIVE);
  });
});

describe("a page is read only when its versions are all written or refused", () => {
  it("a refused first write waits for its early retry: hidden; refused twice: settled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(T0);
      const s = setup();
      modelWriting(FOUR_PARTS);
      await orchestrate("medora", s.env as never, { onlyMissing: true, maxTuples: 5 });
      // The sixth is refused on its first write.
      modelWriting(TOO_LONG);
      await orchestrate("medora", s.env as never, { onlyMissing: true });
      const rows = s.db.prepare("SELECT status FROM variants ORDER BY status").all() as Array<{
        status: string;
      }>;
      expect(rows.map((r) => r.status)).toEqual([
        "error",
        "ready",
        "ready",
        "ready",
        "ready",
        "ready",
      ]);
      expect(s.hidden()).toEqual(ALL_FIVE);

      // Five minutes on the queue tries it again; refused again, it waits six hours.
      vi.setSystemTime(T0 + 5 * MIN);
      await s.pass();
      expect(s.hidden()).toEqual(FOUR);

      // Six hours later the retry writes it: still four parts, still four hidden.
      vi.setSystemTime(T0 + 5 * MIN + QUEUE_ERROR_RETRY_MS);
      modelWriting(FOUR_PARTS);
      await s.pass();
      expect(
        (
          s.db.prepare("SELECT COUNT(*) AS n FROM variants WHERE status = 'ready'").get() as {
            n: number;
          }
        ).n,
      ).toBe(6);
      expect(s.hidden()).toEqual(FOUR);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Rewrite everything hides every part again until the rewrite is done", async () => {
    const s = setup();
    modelWriting(FOUR_PARTS);
    await orchestrate("medora", s.env as never, {});
    expect(s.hidden()).toEqual(FOUR);

    const res = await handleVariantsStaleAll(
      new Request("https://api.test/admin/variants/stale-all", {
        method: "POST",
        body: JSON.stringify({ customer_id: "medora" }),
      }),
      s.env as never,
      { role: "superadmin", customer_id: null } as never,
    );
    expect(res.status).toBe(200);
    // Before the queue writes the first new body.
    expect(s.hidden()).toEqual(ALL_FIVE);

    // This time the versions write the form's button too.
    modelWriting({ ...FOUR_PARTS, "forms.submit_label": "Göndərin" });
    await s.pass();
    expect(s.hidden()).toEqual(ALL_FIVE);

    // And a rewrite back to four parts ends with four hidden.
    s.db.prepare("UPDATE variants SET status = 'stale'").run();
    modelWriting(FOUR_PARTS);
    await s.pass();
    expect(s.hidden()).toEqual(FOUR);
  });

  it("a refused rewrite keeps its older body, and what that body writes still counts", async () => {
    const s = setup();
    modelWriting({ ...FOUR_PARTS, "forms.submit_label": "Göndərin" });
    await orchestrate("medora", s.env as never, {});
    expect(s.hidden()).toEqual(ALL_FIVE);
    // Five rows are rewritten without the form's button; the sixth is refused
    // and its older body, which writes the button, keeps serving.
    s.db.prepare("UPDATE variants SET status = 'stale'").run();
    modelWriting(FOUR_PARTS);
    await orchestrate("medora", s.env as never, { onlyMissing: true, maxTuples: 5 });
    modelWriting(TOO_LONG);
    await orchestrate("medora", s.env as never, { onlyMissing: true });
    const statuses = (
      s.db.prepare("SELECT status FROM variants ORDER BY status").all() as Array<{ status: string }>
    ).map((r) => r.status);
    expect(statuses).toEqual(["error", "ready", "ready", "ready", "ready", "ready"]);
    expect(s.hidden()).toEqual(ALL_FIVE);
  });

  it("a version written before bodies were kept cannot be read: every part stays hidden", async () => {
    const s = setup();
    modelWriting(FOUR_PARTS);
    await orchestrate("medora", s.env as never, {});
    expect(s.hidden()).toEqual(FOUR);
    s.db.prepare("UPDATE variants SET body_id = NULL WHERE kv_key LIKE '%:ai'").run();
    await writeHideRules(s.env, "medora");
    expect(s.hidden()).toEqual(ALL_FIVE);
  });

  it("rows of an intent the site does not serve are not waited for", async () => {
    const s = setup();
    modelWriting(FOUR_PARTS);
    await orchestrate("medora", s.env as never, {});
    // An older pricing version, stale for ever: the site has no pricing.
    s.db
      .prepare(
        "INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status) SELECT 'old-pricing', 'medora', id, 'v1:variant:medora:pricing:ai', 'model-a', 'h', 1, 0.001, 'stale' FROM intent_profiles WHERE profile_key = 'intent:pricing' AND customer_id IS NULL",
      )
      .run();
    await writeHideRules(s.env, "medora");
    expect(s.hidden()).toEqual(FOUR);
    // Served again, it is a version the page waits for.
    served = ["problem", "pricing"];
    await writeHideRules(s.env, "medora");
    expect(s.hidden()).toEqual(ALL_FIVE);
  });

  it("a part every version left as built is not hidden either", async () => {
    const s = setup();
    // The paragraph is refused in every version and left as the page built it (J1).
    modelWriting({ ...FOUR_PARTS, "hero.body": TOO_LONG["hero.body"] });
    const run = await orchestrate("medora", s.env as never, {});
    expect(run.generated).toBe(6);
    expect(run.parts_as_built).toBe(6);
    expect(s.hidden()).toEqual(FOUR.filter((sel) => sel !== "section.hero p.lead"));
  });
});

describe("a page other than the home page", () => {
  it("counts what the home page's versions write too: the edge lends them", async () => {
    const s = setup(["/", "/about"]);
    // The home page writes five parts, /about four.
    modelWriting({ ...FOUR_PARTS, "forms.submit_label": "Göndərin" });
    for (const src of ["default", "ai", "social", "community", "organic", "paid"]) {
      await regenerateOne("medora", "problem", src, s.env as never, "/");
    }
    modelWriting(FOUR_PARTS);
    for (const src of ["default", "ai", "social", "community", "organic", "paid"]) {
      await regenerateOne("medora", "problem", src, s.env as never, "/about");
    }
    expect(s.hidden("/")).toEqual(ALL_FIVE);
    expect(s.hidden("/about")).toEqual(ALL_FIVE);

    const own = await partsVersionsWrite(s.env.DB, "medora", ["/about"], ["problem"]);
    expect([...(own.get("/about") ?? [])].sort()).toEqual(Object.keys(PAGE).sort());
  });

  it("is not read while the home page is being rewritten", async () => {
    const s = setup(["/", "/about"]);
    modelWriting(FOUR_PARTS);
    // This model sends every part to its own calls (about eleven a version),
    // so twelve versions can pass the run's call budget: the queue's next
    // pass writes what is left.
    await orchestrate("medora", s.env as never, {});
    await orchestrate("medora", s.env as never, { onlyMissing: true });
    expect(s.hidden("/")).toEqual(FOUR);
    expect(s.hidden("/about")).toEqual(FOUR);
    s.db
      .prepare("UPDATE variants SET status = 'stale' WHERE kv_key = 'v1:variant:medora:problem:ai'")
      .run();
    await writeHideRules(s.env, "medora");
    expect(s.hidden("/")).toEqual(ALL_FIVE);
    expect(s.hidden("/about")).toEqual(ALL_FIVE);
  });
});

describe("the reasons a page is not settled", () => {
  const row = (source: string, over: Record<string, unknown> = {}) => ({
    kv_key: `v1:variant:medora:problem:${source}`,
    status: "ready",
    body_id: "0123456789abcdef",
    cost_usd: 0.001,
    error_reason: null,
    lint_flags: null,
    ...over,
  });
  const cells = (over: Record<string, unknown> = {}) => [
    row("default"),
    row("ai", over),
    row("social"),
    row("community"),
    row("organic"),
    row("paid"),
  ];
  const reason = (rows: ReturnType<typeof cells>) =>
    unsettledReason(rows as never, "medora", "/", ["problem"]);

  it("says why, and says nothing when the page is settled", () => {
    expect(reason(cells())).toBeNull();
    expect(reason(cells().slice(0, 5))).toBe("a version is not written yet");
    expect(reason(cells({ status: "stale" }))).toBe("a version waits for its rewrite");
    expect(
      reason(
        cells({
          status: "error",
          body_id: null,
          cost_usd: 0,
          error_reason: "lint: hero.body length-drift (x)",
        }),
      ),
    ).toBe("a first write waits for its early retry");
    expect(reason(cells({ body_id: null }))).toBe("a version's body cannot be read");
    expect(
      reason(cells({ status: "error", body_id: null, error_reason: "lint: x", cost_usd: 0.001 })),
    ).toBe("a version's body cannot be read");
  });

  it("a refused row that waits its six hours, and a provider failure, do not hold the page", () => {
    expect(
      reason(
        cells({
          status: "error",
          body_id: null,
          cost_usd: 0,
          error_reason: "lint: hero.body length-drift (x)",
          lint_flags: '["first-write-retried"]',
        }),
      ),
    ).toBeNull();
    expect(
      reason(
        cells({
          status: "error",
          body_id: null,
          cost_usd: 0,
          error_reason: "Timeout after 45000ms",
        }),
      ),
    ).toBeNull();
    // An older body under a refused rewrite is read like any other.
    expect(reason(cells({ status: "error", error_reason: "lint: x" }))).toBeNull();
  });

  it("a body's leaf is read as its part, however the database writes the key", () => {
    expect(partOfLeaf("$.sections.hero.headline")).toBe("hero.headline");
    expect(partOfLeaf("$.sections.hero.body_alt2")).toBe("hero.body");
    expect(partOfLeaf("$.sections.hero.cta.label")).toBe("hero.cta.label");
    // SQLite quotes a key with an underscore.
    expect(partOfLeaf('$.sections.forms."submit_label"')).toBe("forms.submit_label");
    expect(partOfLeaf('$.sections."features_core"."headline_alt"')).toBe("features_core.headline");
    expect(partOfLeaf("$.sections.hero.kind")).toBeNull();
    expect(partOfLeaf("$.sections.hero.cta.href")).toBeNull();
    expect(partOfLeaf("$.customer_id")).toBeNull();
  });

  it("a database that does not answer changes nothing: every part stays hidden", async () => {
    const broken = {
      prepare: () => {
        throw new Error("d1 down");
      },
    } as unknown as D1Database;
    expect((await partsVersionsWrite(broken, "medora", ["/"], ["problem"])).size).toBe(0);
  });
});
