/**
 * One button's "rewrite its words" switch, through the admin API on real SQL
 * (admin/buttons.ts, lib/button-rewrite.ts; the founder's decision of
 * 2026-10-12; mock design/mock/sales-readiness/pilot-gaps.html, screen 04).
 *
 *   GET  /admin/onboard/buttons   the Look screen's list
 *   POST /admin/onboard/button    one button on or off
 *
 * On: the hide rules and the bundle take the button, the page's versions go
 * stale (each needs the label). Off: the hide rules and the bundle lose it
 * and nothing is rewritten. While a test runs the counted button cannot be
 * turned on; off always works. The manifest reads and the quickstart's
 * answer carry the same list, and go live keeps the switch.
 */
import type { Manifest } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness } from "../proof-harness.ts";

vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(),
  regenerateOne: vi.fn(async () => ({ ok: false, error: "no preview in this test", cost_usd: 0 })),
}));

type User = { id: string; email: string; role: string; customer_id: string | null };
const OWNER: User = { id: "u_ev", email: "o@medora.test", role: "customer", customer_id: "medora" };
const OTHER: User = { id: "u_x", email: "x@other.test", role: "customer", customer_id: "other" };
const FOUNDER: User = { id: "u1", email: "f@example.com", role: "superadmin", customer_id: null };
let sessionUser: User = OWNER;
vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionUser),
}));

const { default: worker } = await import("../../src/index.ts");
const { TEST_LOCK_REASON } = await import("../../src/admin/conversions.ts");
const { quickstartKey, previewKey, PREVIEW_INTENT, PREVIEW_SOURCE } = await import(
  "../../src/admin/quickstart.ts"
);

const PLAIN = { icons: "none", emphasis: 0, split: false, animated_text: false } as const;
const part = (css: string, text: string) => ({
  css: [css],
  text: [text],
  structural: css,
  original_char_length: text.length,
  original_word_count: text.split(" ").length,
  inline: { ...PLAIN },
});
/** The pilot's home page: five parts, two of them buttons, as stored today. */
const MANIFEST: Manifest = {
  "hero.headline": part("section.hero h1", "Qida Əlavələri Sifarişlərdə Etibarlıq"),
  "hero.body": part(
    "section.hero p.lead",
    "Sizin brendiniz üçün qida əlavələrini istehsal edirik.",
  ),
  "hero.cta.label": part("section.hero a.btn", "Məhsullarımızla tanış olun!"),
  "features.headline": part("section.products h2", "Sağlamlığınız üçün əlavələr"),
  "forms.submit_label": part("form.contact button", "Göndər"),
};

let h: Harness;

function seed(
  manifest: Manifest = MANIFEST,
  opts: { confirmed?: boolean; counted?: boolean } = {},
) {
  h.customer("medora");
  h.customer("other");
  h.db
    .prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('medora', '/', ?, 'https://medora.test/', 1, ?, 'az')",
    )
    .run(JSON.stringify(manifest), opts.confirmed === false ? null : 1);
  if (opts.counted !== false) {
    h.db
      .prepare(
        `INSERT INTO conversion_targets (id, customer_id, section_path, label, conversion_label, enabled, css_selectors, text_selectors, structural_selector, created_at, updated_at)
         VALUES ('t1', 'medora', 'hero.cta.label', 'Hero button', 'other', 1, '[".hero-section .btn-light"]', '["Məhsullarımızla tanış olun!"]', 'hero button', 1, 1)`,
      )
      .run();
  }
}

/** Ready rows: four of the home page, two of another page. */
function seedVersions() {
  const ins = h.db.prepare(
    "INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status) SELECT ?, 'medora', id, ?, 'model-a', 'h', 1, 0.001, 'ready' FROM intent_profiles WHERE profile_key = 'intent:problem' AND customer_id IS NULL",
  );
  for (const src of ["default", "ai", "social", "community"]) {
    ins.run(`home-${src}`, `v1:variant:medora:problem:${src}`);
  }
  for (const src of ["default", "ai"]) {
    ins.run(`about-${src}`, `v1:variant:medora:p:%2Fabout:problem:${src}`);
  }
}

const statuses = () =>
  Object.fromEntries(
    (
      h.db.prepare("SELECT kv_key, status FROM variants ORDER BY kv_key").all() as Array<{
        kv_key: string;
        status: string;
      }>
    ).map((r) => [r.kv_key.replace("v1:variant:medora:", ""), r.status]),
  );
const stored = () =>
  JSON.parse(
    (
      h.db
        .prepare(
          "SELECT manifest FROM element_manifests WHERE customer_id = 'medora' AND page_path = '/'",
        )
        .get() as { manifest: string }
    ).manifest,
  ) as Record<string, Record<string, unknown>>;
const hide = () =>
  JSON.parse(h.kv.get("v1:hide:medora") ?? "null") as Record<string, string[]> | null;
const bundle = () =>
  JSON.parse(h.kv.get("v1:vm:medora") ?? "null") as {
    pages: Record<string, Record<string, unknown>>;
    conv: Array<{ section_path: string }>;
  } | null;
const startTest = () =>
  h.db
    .prepare(
      "INSERT INTO holdout_tests (id, customer_id, percent, started_at, created_at) VALUES ('ht_1', 'medora', 20, 1, 1)",
    )
    .run();

async function call(
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`https://api.example.com${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-rawuser-admin": "session", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    h.env as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const set = (path: string, rewrite: unknown, extra: Record<string, unknown> = {}) =>
  call("/admin/onboard/button", { customer_id: "medora", page_path: "/", path, rewrite, ...extra });

beforeEach(() => {
  h = harness();
  sessionUser = OWNER;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /admin/onboard/buttons", () => {
  it("lists every button of the page: off by default, the counted one marked", async () => {
    seed();
    const r = await call("/admin/onboard/buttons?customer_id=medora&page_path=/");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      page_path: "/",
      confirmed: true,
      test_running: false,
      buttons: [
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
          rewrite: false,
          counted: false,
          form: true,
        },
      ],
    });
  });

  it("404 without a manifest, 403 for another customer's account", async () => {
    seed();
    expect(
      (await call("/admin/onboard/buttons?customer_id=medora&page_path=/pricing")).status,
    ).toBe(404);
    sessionUser = OTHER;
    expect((await call("/admin/onboard/buttons?customer_id=medora&page_path=/")).status).toBe(403);
  });
});

describe("POST /admin/onboard/button, on", () => {
  it("stores the switch, takes the button into the hide rules and the bundle, marks the page's versions stale", async () => {
    seed();
    seedVersions();
    const r = await set("forms.submit_label", true);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ changed: true, stale: 4, confirmed: true });
    expect(
      (r.json.buttons as Array<{ path: string; rewrite: boolean }>).map((b) => b.rewrite),
    ).toEqual([false, true]);

    expect(stored()["forms.submit_label"]?.rewrite).toBe(true);
    // Nothing else of the manifest moved, and the page is still confirmed.
    const { rewrite: _on, ...rest } = stored()["forms.submit_label"] ?? {};
    expect(rest).toEqual(MANIFEST["forms.submit_label"]);
    expect(stored()["hero.cta.label"]).toEqual(MANIFEST["hero.cta.label"]);
    expect(
      h.db.prepare("SELECT confirmed_at FROM element_manifests WHERE customer_id = 'medora'").get(),
    ).toEqual({ confirmed_at: 1 });

    expect(hide()?.["/"]).toEqual([
      "section.hero h1",
      "section.hero p.lead",
      "section.products h2",
      "form.contact button",
    ]);
    expect(Object.keys(bundle()?.pages["/"] ?? {})).toEqual([
      "hero.headline",
      "hero.body",
      "features.headline",
      "forms.submit_label",
    ]);
    // The home page's versions need the label; another page's are not touched.
    expect(statuses()).toEqual({
      "problem:default": "stale",
      "problem:ai": "stale",
      "problem:social": "stale",
      "problem:community": "stale",
      "p:%2Fabout:problem:default": "ready",
      "p:%2Fabout:problem:ai": "ready",
    });
  });

  it("the same word again changes nothing and marks nothing", async () => {
    seed();
    seedVersions();
    await set("forms.submit_label", true);
    h.db.prepare("UPDATE variants SET status = 'ready'").run();
    const again = await set("forms.submit_label", true);
    expect(again.json).toMatchObject({ changed: false, stale: 0 });
    expect(Object.values(statuses()).every((s) => s === "ready")).toBe(true);
  });
});

describe("POST /admin/onboard/button, off", () => {
  it("removes the field, drops the button from the hide rules and the bundle, rewrites nothing", async () => {
    seed();
    seedVersions();
    await set("hero.cta.label", true);
    expect(hide()?.["/"]).toContain("section.hero a.btn");
    h.db.prepare("UPDATE variants SET status = 'ready'").run();

    const r = await set("hero.cta.label", false);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ changed: true, stale: 0 });
    // Stored as it always was.
    expect(stored()).toEqual(MANIFEST);
    expect(hide()?.["/"]).not.toContain("section.hero a.btn");
    expect(Object.keys(bundle()?.pages["/"] ?? {})).not.toContain("hero.cta.label");
    expect(Object.values(statuses()).every((s) => s === "ready")).toBe(true);
    // Counted before, during and after.
    expect(bundle()?.conv.map((c) => c.section_path)).toEqual(["hero.cta.label"]);
  });

  it("a button the page tags itself is written whatever the bundle says: its versions go stale", async () => {
    const tagged: Manifest = {
      ...MANIFEST,
      "forms.submit_label": {
        ...(MANIFEST["forms.submit_label"] as Manifest[string]),
        css: ['[data-rawuser="forms.submit_label"]'],
      },
    };
    seed(tagged);
    seedVersions();
    await set("forms.submit_label", true);
    h.db.prepare("UPDATE variants SET status = 'ready'").run();
    const r = await set("forms.submit_label", false);
    expect(r.json).toMatchObject({ changed: true, stale: 4 });
  });
});

describe("while a test runs", () => {
  it("the counted button cannot be turned on, and nothing is written", async () => {
    seed();
    seedVersions();
    startTest();
    const r = await set("hero.cta.label", true);
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: TEST_LOCK_REASON });
    expect(stored()).toEqual(MANIFEST);
    expect(hide()).toBeNull();
    expect(Object.values(statuses()).every((s) => s === "ready")).toBe(true);
    // A superadmin too, as for the counted buttons themselves.
    sessionUser = FOUNDER;
    expect((await set("hero.cta.label", true)).status).toBe(409);
    const list = await call("/admin/onboard/buttons?customer_id=medora&page_path=/");
    expect(list.json.test_running).toBe(true);
  });

  it("the counted button can always be turned off: the page's own words are the way back", async () => {
    seed();
    await set("hero.cta.label", true);
    startTest();
    const r = await set("hero.cta.label", false);
    expect(r.status).toBe(200);
    expect(stored()).toEqual(MANIFEST);
  });

  it("a button that is not counted can be turned on: it is treatment, like any other part", async () => {
    seed();
    startTest();
    const r = await set("forms.submit_label", true);
    expect(r.status).toBe(200);
    expect(stored()["forms.submit_label"]?.rewrite).toBe(true);
  });

  it("a button picked on this page is the counted one when it is the same element", async () => {
    seed(MANIFEST, { counted: false });
    h.db
      .prepare(
        `INSERT INTO conversion_targets (id, customer_id, section_path, label, conversion_label, enabled, css_selectors, text_selectors, structural_selector, created_at, updated_at)
         VALUES ('t2', 'medora', 'count:/', 'Göndər', 'contact', 1, '["form.contact button"]', '[]', 'x', 1, 1)`,
      )
      .run();
    startTest();
    expect((await set("forms.submit_label", true)).status).toBe(409);
    expect((await set("hero.cta.label", true)).status).toBe(200);
  });
});

describe("what it refuses", () => {
  it("a part that is not a button, a button the page does not have, a word that is not yes or no", async () => {
    seed();
    expect((await set("hero.headline", true)).status).toBe(400);
    expect((await set("pricing.cta.label", true)).status).toBe(400);
    expect((await set("hero.cta.label", "on")).status).toBe(400);
    expect((await set('hero"."x.label', true)).status).toBe(400);
    expect((await set("$.label", true)).status).toBe(400);
    expect(stored()).toEqual(MANIFEST);
  });

  it("a page without a manifest, an address that names one account, another customer's account", async () => {
    seed();
    expect((await set("hero.cta.label", true, { page_path: "/pricing" })).status).toBe(404);
    expect(
      (await set("hero.cta.label", true, { page_path: "/u/3f2b8c1e-9d4a-4f6b-8a2e-1c5d7e9f0a3b" }))
        .status,
    ).toBe(400);
    sessionUser = OTHER;
    expect((await set("hero.cta.label", true)).status).toBe(403);
    expect(stored()).toEqual(MANIFEST);
  });
});

describe("before go live", () => {
  it("a page not yet confirmed takes the switch and nothing reaches a visitor", async () => {
    seed(MANIFEST, { confirmed: false });
    const r = await set("hero.cta.label", true);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ changed: true, stale: 0, confirmed: false });
    expect(stored()["hero.cta.label"]?.rewrite).toBe(true);
    expect(hide()).toBeNull();
    expect(bundle()).toBeNull();
  });

  it("the quickstart's answer lists the buttons with the stored switch and the proposed one", async () => {
    seed(MANIFEST, { confirmed: false, counted: false });
    // The record is a snapshot of the read; the switch was turned on after it.
    h.kv.set(
      quickstartKey("medora", "/"),
      JSON.stringify({
        customer_id: "medora",
        page_path: "/",
        manifest: MANIFEST,
        measure: {
          proposal: { section_path: "hero.cta.label", label: "Məhsullarımızla tanış olun!" },
        },
      }),
    );
    await set("forms.submit_label", true);
    const r = await call("/admin/onboard/quickstart?customer_id=medora&page_path=/");
    expect(r.status).toBe(200);
    expect(r.json.buttons).toEqual([
      expect.objectContaining({
        path: "hero.cta.label",
        rewrite: false,
        counted: false,
        proposed: true,
      }),
      expect.objectContaining({
        path: "forms.submit_label",
        rewrite: true,
        counted: false,
        proposed: false,
        form: true,
      }),
    ]);
  });
});

describe("the manifest reads", () => {
  it("carry the same list, one page or all", async () => {
    seed();
    await set("hero.cta.label", true);
    const one = await call("/admin/onboard/manifest?customer_id=medora&page_path=/");
    expect(
      (one.json.buttons as Array<Record<string, unknown>>).map((b) => [
        b.path,
        b.rewrite,
        b.counted,
      ]),
    ).toEqual([
      ["hero.cta.label", true, true],
      ["forms.submit_label", false, false],
    ]);
    const all = await call("/admin/onboard/manifest?customer_id=medora&all=true");
    const first = (all.json.manifests as Array<Record<string, unknown>>)[0];
    expect((first?.buttons as unknown[]).length).toBe(2);
  });
});

describe("go live", () => {
  const DNA = { product: "Qida əlavələri", icp: "Brendlər", value_props: ["İstehsal"] };
  const PREVIEW = {
    customer_id: "medora",
    profile_key: "intent:evaluation",
    sections: { hero: { kind: "hero", headline: "Etibarlı istehsalçı", body: "Bir komanda." } },
    generated_at: 1,
    prompt_hash: "h",
  };
  function seedPreview() {
    h.db
      .prepare(
        `INSERT INTO business_dna (customer_id, product, icp, brand_voice, updated_at, value_props, differentiators, proof_points, target_market, target_language, per_intent_hints, draft)
         VALUES ('medora', 'Qida əlavələri', 'Brendlər', 'sakit', 1, '["İstehsal"]', '[]', '[]', 'Yerli bazar', 'az', '{}', 1)`,
      )
      .run();
    h.kv.set(
      quickstartKey("medora", "/"),
      JSON.stringify({
        customer_id: "medora",
        page_path: "/",
        manifest: MANIFEST,
        provenance: { model: "model-a", prompt_hash: "h", cost_usd: 0.001, lint_flags: [] },
      }),
    );
    h.kv.set(previewKey("medora", "/"), JSON.stringify(PREVIEW));
  }
  const liveRow = () =>
    h.db
      .prepare("SELECT status FROM variants WHERE kv_key = ?")
      .get(`v1:variant:medora:${PREVIEW_INTENT}:${PREVIEW_SOURCE}`) as
      | { status: string }
      | undefined;

  it("keeps a switch the request's own copy of the manifest does not know, and owes the preview its label", async () => {
    seed(MANIFEST, { confirmed: false, counted: false });
    seedPreview();
    await set("hero.cta.label", true);
    // The dashboard posts the manifest it read at the quickstart: no `rewrite` anywhere.
    const r = await call("/admin/onboard/go-live", {
      customer_id: "medora",
      page_path: "/",
      dna: DNA,
      manifest: MANIFEST,
    });
    expect(r.status).toBe(200);
    expect(r.json.promoted).toBe(true);
    expect(stored()["hero.cta.label"]?.rewrite).toBe(true);
    expect(hide()?.["/"]).toContain("section.hero a.btn");
    // The preview has no words for the button that is now on: the queue writes them.
    expect(liveRow()?.status).toBe("stale");
  });

  it("with every button off the promoted preview is ready as it is", async () => {
    seed(MANIFEST, { confirmed: false, counted: false });
    seedPreview();
    const r = await call("/admin/onboard/go-live", {
      customer_id: "medora",
      page_path: "/",
      dna: DNA,
      manifest: MANIFEST,
    });
    expect(r.status).toBe(200);
    expect(liveRow()?.status).toBe("ready");
    expect(hide()?.["/"]).toEqual([
      "section.hero h1",
      "section.hero p.lead",
      "section.products h2",
    ]);
  });

  it("a request that says the word itself decides", async () => {
    seed(MANIFEST, { confirmed: false, counted: false });
    seedPreview();
    await set("hero.cta.label", true);
    const posted = {
      ...MANIFEST,
      "hero.cta.label": { ...MANIFEST["hero.cta.label"], rewrite: false },
      "forms.submit_label": { ...MANIFEST["forms.submit_label"], rewrite: true },
    };
    await call("/admin/onboard/go-live", {
      customer_id: "medora",
      page_path: "/",
      dna: DNA,
      manifest: posted,
    });
    expect(stored()["hero.cta.label"]?.rewrite).toBe(false);
    expect(stored()["forms.submit_label"]?.rewrite).toBe(true);
    expect(hide()?.["/"]).toContain("form.contact button");
    expect(hide()?.["/"]).not.toContain("section.hero a.btn");
  });
});
