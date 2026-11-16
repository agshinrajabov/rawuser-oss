/**
 * The readiness check's endpoints on real SQL (docs/specs/readiness-check.md,
 * Tests, and the privacy review's four conditions):
 * - GET /admin/onboard/readiness: scope, the lines from stored facts, the
 *   guess that colours a line and writes no row (a D1 and console spy, the
 *   answer quoting no word: condition 3), check 4's stages;
 * - POST /admin/customers/special-category: the write, the bundle's `ne`,
 *   the ops line with the domain and the two words only (condition 1);
 * - the tag withheld: 409 on capture-token, pick-token and the count link
 *   while unanswered or yes unmarked before go live, nothing withheld once
 *   live or marked (condition 2);
 * - go live's 409 on a yes not marked, and the pass once marked;
 * - `goes` at the pick (contact_link, form, else NULL) and never in the
 *   bundle's `conv` (condition 4).
 */
import { type PickStore, receivePick, visitorBundleKey } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayOf } from "../../src/cron/exposure-rollup.ts";
import { type Harness, harness } from "../proof-harness.ts";

type User = { id: string; email: string; role: string; customer_id: string | null };
const SAM: User = { id: "u2", email: "sam@acme.test", role: "customer", customer_id: "acme" };
const FOUNDER: User = { id: "u1", email: "f@example.com", role: "superadmin", customer_id: null };
let sessionUser: User = SAM;

vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionUser),
}));
vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(),
  regenerateOne: vi.fn(),
}));

const { default: worker } = await import("../../src/index.ts");

const DAY = 86_400_000;
let h: Harness;
beforeEach(() => {
  h = harness();
  h.customer("acme");
  h.customer("other");
  sessionUser = SAM;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`https://api.example.com${path}`, {
      method,
      headers: { "x-rawuser-admin": "session", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    h.env as never,
    { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as never,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

type Check = {
  id: string;
  state: string;
  line: string;
  action: { label: string; href: string } | null;
  known: string;
  blocks: boolean;
  superadmin_only: boolean;
};

async function readiness(customer = "acme") {
  const r = await call("GET", `/admin/onboard/readiness?customer_id=${customer}`);
  expect(r.status).toBe(200);
  return r.json as unknown as {
    ok: true;
    customer_id: string;
    blocks_go_live: boolean;
    checks: Check[];
    special_category: boolean | null;
    tag_withheld: boolean;
  };
}

const byId = (checks: Check[], id: string) => checks.find((c) => c.id === id);

function set(sql: string, ...params: unknown[]) {
  h.db.prepare(sql).run(...(params as never[]));
}

function answer(customer: string, v: 0 | 1 | null) {
  set(
    "UPDATE customers SET special_category = ?, special_category_at = ? WHERE id = ?",
    v,
    v === null ? null : 7,
    customer,
  );
}

function manifest(page = "/", confirmed = true, withButton = false) {
  const m: Record<string, unknown> = {
    "hero.headline": { css: ["h1"], text: ["Forms people finish."], structural: "first h1" },
  };
  if (withButton) {
    m["hero.cta.label"] = { css: ["#cta"], text: ["Start free"], structural: "hero link" };
  }
  set(
    "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at) VALUES ('acme', ?, ?, 'https://acme.test/', 1, ?)",
    page,
    JSON.stringify(m),
    confirmed ? 5 : null,
  );
}

function target(sectionPath: string, label: string, goes: string | null, enabled = 1) {
  set(
    `INSERT INTO conversion_targets (customer_id, section_path, label, conversion_label, enabled,
       css_selectors, text_selectors, structural_selector, goes, created_at, updated_at)
     VALUES ('acme', ?, 'Button', ?, ?, '["#b"]', '["Button"]', 'first a in section', ?, 1, 1)`,
    sectionPath,
    label,
    enabled,
    goes,
  );
}

function probe(position: string | null, flags: string[] = [], form: string | null = "script") {
  set(
    "INSERT INTO snippet_status (customer_id, status, tag_position, tag_flags, tag_form) VALUES ('acme', 'active', ?, ?, ?)",
    position,
    JSON.stringify(flags),
    form,
  );
}

/** Closed days of eligible traffic before today, with a late share. */
function traffic(days: number, visitsPerDay: number, lpPerDay = 0) {
  const now = Date.now();
  for (let d = days; d >= 1; d--) {
    set(
      `INSERT INTO exposure_outcomes (customer_id, day, arm, page_path, intent_dim, source_dim,
         visits, converting_visits, lp_visits, computed_at)
       VALUES ('acme', ?, 'none', '/', 'problem', 'ai', ?, 0, ?, 1)
       ON CONFLICT DO NOTHING`,
      dayOf(now - d * DAY),
      visitsPerDay,
      lpPerDay,
    );
  }
}

const bundle = (id = "acme") => JSON.parse(h.kv.get(visitorBundleKey(id)) ?? "null");

const WITHHELD_UNANSWERED = "Answer the special-category question first.";
const WITHHELD_YES =
  "We need to set this site up for a sensitive topic first. We have been told and will write to you.";
const BLOCK = "Your site is in a special category. We finish its setup by hand before go live.";

describe("GET /admin/onboard/readiness", () => {
  it("is customer-scoped and answers 404 for a customer that is not there", async () => {
    expect((await call("GET", "/admin/onboard/readiness?customer_id=other")).status).toBe(403);
    expect((await call("GET", "/admin/onboard/readiness")).status).toBe(403);
    sessionUser = FOUNDER;
    expect((await call("GET", "/admin/onboard/readiness")).status).toBe(400);
    expect((await call("GET", "/admin/onboard/readiness?customer_id=nobody")).status).toBe(404);
  });

  it("a new customer: the tag unseen, nothing counted, answered No, traffic unknown", async () => {
    const r = await readiness();
    expect(r).toMatchObject({
      ok: true,
      customer_id: "acme",
      blocks_go_live: false,
      special_category: false,
      tag_withheld: false,
    });
    expect(r.checks.map((c) => [c.id, c.state, c.line])).toEqual([
      ["tag", "red", "We do not see the tag yet."],
      ["counted", "red", "No button is counted yet."],
      ["category", "green", "Not a special-category site."],
      ["traffic", "grey", "Not known yet. We see your traffic from day 3 after go live."],
    ]);
    for (const c of r.checks) {
      expect(c).toMatchObject({ known: "now", blocks: false, superadmin_only: false });
    }
  });

  it("a customer session never receives terms; the superadmin does, red without them", async () => {
    expect(byId((await readiness()).checks, "terms")).toBeUndefined();
    sessionUser = FOUNDER;
    expect(byId((await readiness()).checks, "terms")).toMatchObject({
      state: "red",
      line: "No pilot terms on record.",
      action: { label: "Record the terms", href: "/customers" },
      superadmin_only: true,
    });
    set("UPDATE customers SET pilot_terms_at = 5 WHERE id = 'acme'");
    expect(byId((await readiness()).checks, "terms")).toMatchObject({
      state: "green",
      line: "Terms on record.",
    });
  });

  it("reads the probe, the counted rows, the languages, the manifests and the record", async () => {
    probe("body_late");
    target("hero.cta.label", "other", "same_site");
    set(
      "UPDATE customers SET languages = ? WHERE id = 'acme'",
      JSON.stringify([
        { lang: "az", status: "primary", path: "/", enabled: true },
        { lang: "en", status: "same_address", path: null, enabled: false },
      ]),
    );
    manifest("/", false, true);
    h.kv.set(
      "v1:quickstart:acme:/",
      JSON.stringify({
        preview: { headline: "A", body: "B", cta: "C" },
        current: { headline: "Forms people finish.", body: null, cta: "Start free" },
        measure_contact_link: true,
      }),
    );
    const r = await readiness();
    expect(r.checks.map((c) => [c.id, c.state, c.line, c.action?.label ?? null])).toEqual([
      [
        "tag",
        "red",
        "The tag is in the body. About one load in four paints before it and stays as built.",
        "Move it first in the head",
      ],
      [
        "counted",
        "amber",
        "The counted button opens another page of your site, so a visit can count without an action.",
        "Count the contact, signup or purchase button instead",
      ],
      [
        "contact_hint",
        "amber",
        "Your page has a phone or email link that is not counted.",
        "Count it on every page",
      ],
      ["category", "green", "Not a special-category site.", "Change"],
      ["traffic", "grey", "Not known yet. We see your traffic from day 3 after go live.", null],
      [
        "language",
        "amber",
        "Your site also has English on the same address. Versions are written for Azerbaijani only.",
        null,
      ],
      [
        "buttons",
        "grey",
        "Your buttons keep their words. Turn rewriting on if you want them written.",
        "Parts of the page",
      ],
      ["versions", "green", "1 version written. The other 35 are written after you go live.", null],
    ]);
  });

  it("check 2: a start page is green, a tel: link with no contact row hints, a site: row satisfies", async () => {
    target("hero.cta.label", "other", "start_page");
    h.kv.set("v1:quickstart:acme:/", JSON.stringify({ measure_contact_link: true }));
    let r = await readiness();
    expect(byId(r.checks, "counted")).toMatchObject({
      state: "green",
      line: "Counted: the button, on the homepage.",
    });
    expect(byId(r.checks, "contact_hint")).toBeDefined();
    target("site:phone", "contact", "contact_link");
    r = await readiness();
    expect(byId(r.checks, "contact_hint")).toBeUndefined();
    expect(byId(r.checks, "counted")?.line).toBe(
      "Counted: the button on the homepage, the contact link on every page.",
    );
  });

  it("check 4: under 7 days grey; 7 days of real traffic green; a trickle amber; the audit path", async () => {
    traffic(3, 500);
    expect(byId((await readiness()).checks, "traffic")?.state).toBe("grey");
    traffic(7, 500);
    expect(byId((await readiness()).checks, "traffic")).toMatchObject({
      state: "green",
      line: expect.stringMatching(/^A 20% test would read in about \d+ weeks\.$/),
    });
    set("DELETE FROM exposure_outcomes WHERE customer_id = 'acme'");
    traffic(7, 2);
    expect(byId((await readiness()).checks, "traffic")).toMatchObject({
      state: "amber",
      line: "At this traffic a test shows a direction, not a proof.",
    });
    // The audit path: no rows, the report's visits over its window.
    set("DELETE FROM exposure_outcomes WHERE customer_id = 'acme'");
    const start = Date.now() - 10 * DAY;
    set(
      "INSERT INTO audit_reports (customer_id, window_start, window_end, state, report, built_at) VALUES ('acme', ?, ?, 'full', ?, 1)",
      start,
      start + 7 * DAY,
      JSON.stringify({ v: 1, visits: 3500 }),
    );
    expect(byId((await readiness()).checks, "traffic")?.state).toBe("green");
  });

  it("day 3 flips the traffic line and the tag line to the measured ones", async () => {
    set("UPDATE customers SET live_at = ? WHERE id = 'acme'", Date.now() - 4 * DAY);
    traffic(7, 500, 125);
    probe("head_first");
    const r = await readiness();
    expect(byId(r.checks, "traffic")).toMatchObject({
      state: "green",
      line: expect.stringMatching(
        /^About 500 visits a day with a test\. A result in about \d+ weeks\.$/,
      ),
      known: "after_day_3",
    });
    expect(byId(r.checks, "tag")).toMatchObject({
      state: "red",
      line: "On about 1 in 4 visits your page painted before the tag.",
      known: "after_day_3",
    });
    // Live: no buttons line, no preview line; a refused version is named.
    expect(byId(r.checks, "buttons")).toBeUndefined();
    expect(byId(r.checks, "versions")).toBeUndefined();
    // A profile the migrations seeded (variants.profile_id references it).
    const profile = (h.db.prepare("SELECT id FROM intent_profiles LIMIT 1").get() as { id: string })
      .id;
    set(
      "INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status, error_reason) VALUES ('v1', 'acme', ?, 'v1:variant:acme:problem:ai', 'm', 'h', 1, 0, 'error', 'lint:number-not-in-brief')",
      profile,
    );
    set(
      "INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status) VALUES ('v2', 'acme', ?, 'v1:variant:acme:problem:social', 'm', 'h', 1, 0, 'ready')",
      profile,
    );
    expect(byId((await readiness()).checks, "versions")).toMatchObject({
      state: "grey",
      line: "1 of 2 versions refused, tried again within six hours.",
    });
  });
});

describe("check 3: the question, the guess and the block", () => {
  it("unanswered is amber and the tag is withheld before go live", async () => {
    answer("acme", null);
    const r = await readiness();
    expect(r).toMatchObject({ special_category: null, tag_withheld: true, blocks_go_live: false });
    expect(byId(r.checks, "category")).toMatchObject({
      state: "amber",
      line: "Tell us whether your site is about health, religion, sexuality, politics or union membership.",
      action: { label: "Answer", href: "/start" },
    });
  });

  it("the guess: three health words in the brief colour the line, write no row, log nothing, quote nothing", async () => {
    answer("acme", null);
    set(
      "INSERT INTO business_dna (customer_id, product, icp, updated_at) VALUES ('acme', 'A clinic for patients with chronic pain', 'Doctors and pharmacies in the capital', 1)",
    );
    const writes: string[] = [];
    const realPrepare = h.env.DB.prepare.bind(h.env.DB);
    vi.spyOn(h.env.DB, "prepare").mockImplementation((sql: string) => {
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) writes.push(sql);
      return realPrepare(sql);
    });
    const logs: string[] = [];
    for (const m of ["log", "error", "warn", "info"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
      });
    }
    const kvBefore = new Map(h.kv);
    const r = await readiness();
    expect(byId(r.checks, "category")).toMatchObject({
      state: "amber",
      line: "Your page reads like a health site. Tell us if it is.",
    });
    expect(writes).toEqual([]);
    expect(logs).toEqual([]);
    expect(h.kv).toEqual(kvBefore);
    expect(JSON.stringify(r)).not.toMatch(/clinic|patient|doctor|pharmac|pain|capital/i);
    expect(h.alerts).toEqual([]);
  });

  it("two words are not a hit", async () => {
    answer("acme", null);
    set(
      "INSERT INTO business_dna (customer_id, product, icp, updated_at) VALUES ('acme', 'A clinic', 'Doctors', 1)",
    );
    expect(byId((await readiness()).checks, "category")?.line).toMatch(/^Tell us whether/);
  });

  it("a yes not marked is red, blocks, withholds the tag; marked is green and nothing is withheld", async () => {
    answer("acme", 1);
    let r = await readiness();
    expect(r).toMatchObject({ blocks_go_live: true, tag_withheld: true, special_category: true });
    expect(byId(r.checks, "category")).toMatchObject({
      state: "red",
      line: BLOCK,
      action: null,
      blocks: true,
    });
    sessionUser = FOUNDER;
    expect(byId((await readiness()).checks, "category")?.action).toEqual({
      label: "Mark it",
      href: "/analytics",
    });
    set("UPDATE customers SET sensitive = 1 WHERE id = 'acme'");
    r = await readiness();
    expect(r).toMatchObject({ blocks_go_live: false, tag_withheld: false });
    expect(byId(r.checks, "category")).toMatchObject({
      state: "green",
      line: "Set up as a special-category site: product pages are counted as a group and versions make no claims.",
    });
  });

  it("a customer already live with no answer has nothing withheld", async () => {
    answer("acme", null);
    set("UPDATE customers SET live_at = 5 WHERE id = 'acme'");
    const r = await readiness();
    expect(r.tag_withheld).toBe(false);
    expect(byId(r.checks, "category")?.state).toBe("amber");
  });
});

describe("POST /admin/customers/special-category", () => {
  const SET = "/admin/customers/special-category";

  it("validates and is customer-scoped", async () => {
    expect((await call("POST", SET, { answer: true })).status).toBe(400);
    expect((await call("POST", SET, { customer_id: "acme" })).status).toBe(400);
    expect((await call("POST", SET, { customer_id: "acme", answer: "yes" })).status).toBe(400);
    expect((await call("POST", SET, { customer_id: "other", answer: true })).status).toBe(403);
    sessionUser = FOUNDER;
    expect((await call("POST", SET, { customer_id: "nobody", answer: true })).status).toBe(404);
  });

  it("a yes writes both columns, puts ne in the bundle, sends the domain and the two words only", async () => {
    answer("acme", null);
    const r = await call("POST", SET, { customer_id: "acme", answer: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      customer_id: "acme",
      special_category: true,
      changed: true,
      tag_withheld: true,
    });
    expect(typeof r.json.special_category_at).toBe("number");
    const row = h.db
      .prepare("SELECT special_category, special_category_at FROM customers WHERE id = 'acme'")
      .get() as { special_category: number; special_category_at: number };
    expect(row.special_category).toBe(1);
    expect(row.special_category_at).toBe(r.json.special_category_at);
    expect(bundle()).toMatchObject({ v: 1, ne: 1 });
    expect(h.alerts).toEqual(["Special category: acme.test"]);
    // Condition 1: no email, no page words, no category name in the line.
    expect(h.alerts[0]).not.toMatch(/@|health|religion|sexual|politic|union|sam/i);
  });

  it("a no writes 0, removes ne, sends nothing; the same answer again changes no row", async () => {
    answer("acme", 1);
    await call("POST", SET, { customer_id: "acme", answer: true });
    expect(bundle().ne).toBe(1);
    expect(h.alerts).toEqual([]);
    const no = await call("POST", SET, { customer_id: "acme", answer: false });
    expect(no.json).toMatchObject({ special_category: false, changed: true, tag_withheld: false });
    expect(bundle()).not.toHaveProperty("ne");
    expect(h.alerts).toEqual([]);
    const again = await call("POST", SET, { customer_id: "acme", answer: false });
    expect(again.json.changed).toBe(false);
  });

  it("a yes on a site already marked sends no line and puts no ne", async () => {
    set("UPDATE customers SET sensitive = 1 WHERE id = 'acme'");
    answer("acme", null);
    const r = await call("POST", SET, { customer_id: "acme", answer: true });
    expect(r.json).toMatchObject({ special_category: true, tag_withheld: false });
    expect(h.alerts).toEqual([]);
    expect(bundle()).toMatchObject({ s: 1 });
    expect(bundle()).not.toHaveProperty("ne");
  });

  it("the bundle of any other customer is byte for byte what it was (no ne key)", async () => {
    // Page one's `dp` and the memory's `rm` (direct-visitors.md §6, §2) are not this test's subject.
    set("UPDATE customers SET page_one_off = 1, remember_off = 1 WHERE id = 'acme'");
    const { writeVisitorBundle } = await import("../../src/admin/onboard.ts");
    await writeVisitorBundle(h.env, "acme");
    expect(h.kv.get(visitorBundleKey("acme"))).toBe('{"v":1,"pages":{},"conv":[]}');
    answer("acme", null);
    await writeVisitorBundle(h.env, "acme");
    expect(h.kv.get(visitorBundleKey("acme"))).toBe('{"v":1,"pages":{},"conv":[]}');
  });
});

describe("the tag withheld on the doors (condition 2)", () => {
  const capture = () =>
    call("POST", "/admin/onboard/capture-token", {
      customer_id: "acme",
      source_url: "https://acme.test/",
    });
  const pick = () => call("POST", "/admin/onboard/pick-token", { customer_id: "acme" });
  const count = () => call("POST", "/admin/conversions/pick-token", { customer_id: "acme" });

  it("unanswered before go live: 409 with the line on all three; answered No: 200", async () => {
    answer("acme", null);
    for (const door of [capture, pick, count]) {
      const r = await door();
      expect(r).toEqual({
        status: 409,
        json: { error: WITHHELD_UNANSWERED, code: "tag_withheld" },
      });
    }
    answer("acme", 0);
    for (const door of [capture, pick, count]) expect((await door()).status).toBe(200);
  });

  it("a yes not marked: 409 with the note; marked: 200; already live: 200", async () => {
    answer("acme", 1);
    expect(await capture()).toEqual({
      status: 409,
      json: { error: WITHHELD_YES, code: "tag_withheld" },
    });
    set("UPDATE customers SET sensitive = 1 WHERE id = 'acme'");
    expect((await capture()).status).toBe(200);
    set("UPDATE customers SET sensitive = 0, live_at = 5 WHERE id = 'acme'");
    expect((await capture()).status).toBe(200);
  });
});

describe("go live", () => {
  const goLive = () =>
    call("POST", "/admin/onboard/go-live", {
      customer_id: "acme",
      page_path: "/",
      dna: { product: "Forms", icp: "Founders", value_props: ["Fast"] },
    });

  it("answers 409 with the blocking line on a yes not marked, and passes once marked", async () => {
    manifest("/", false);
    answer("acme", 1);
    expect(await goLive()).toEqual({
      status: 409,
      json: { error: BLOCK, code: "special_category" },
    });
    set("UPDATE customers SET sensitive = 1 WHERE id = 'acme'");
    expect((await goLive()).status).toBe(200);
  });

  it("marking a customer answers the question for it", async () => {
    answer("acme", null);
    sessionUser = FOUNDER;
    const r = await call("POST", "/admin/customers/sensitive", {
      customer_id: "acme",
      sensitive: true,
    });
    expect(r.status).toBe(200);
    const row = h.db
      .prepare("SELECT special_category, special_category_at FROM customers WHERE id = 'acme'")
      .get() as { special_category: number; special_category_at: number };
    expect(row.special_category).toBe(1);
    expect(typeof row.special_category_at).toBe("number");
    expect(bundle()).not.toHaveProperty("ne");
  });
});

describe("goes at the pick", () => {
  const store = () => h.env.VARIANTS as unknown as PickStore;

  async function picked(
    button: { css: string[]; text: string[]; structural: string },
    scope?: "site",
  ) {
    const mint = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      page_path: "/",
      ...(scope ? { scope } : {}),
    });
    expect(mint.status).toBe(200);
    const posted = await receivePick(
      { token: mint.json.token as string, button, page_path: "/" },
      store(),
    );
    expect(posted.status).toBe(200);
    const status = await call(
      "GET",
      `/admin/conversions/pick-status?customer_id=acme&page_path=/${scope ? "&scope=site" : ""}`,
    );
    expect(status.status).toBe(200);
    return h.db
      .prepare(
        "SELECT section_path, goes FROM conversion_targets WHERE customer_id = 'acme' ORDER BY created_at",
      )
      .all() as Array<{ section_path: string; goes: string | null }>;
  }

  it("a form's Send button is form; a tel: link is contact_link; a nav link is not known", async () => {
    expect(
      await picked({ css: ["#send"], text: ["Göndər"], structural: "first button in form" }),
    ).toEqual([{ section_path: "count:/", goes: "form" }]);
    set("DELETE FROM conversion_targets WHERE customer_id = 'acme'");
    expect(
      await picked(
        { css: ["a[href^='tel:']"], text: ["+000 50 123 45 67"], structural: "first a in nav" },
        "site",
      ),
    ).toEqual([{ section_path: "site:phone", goes: "contact_link" }]);
    set("DELETE FROM conversion_targets WHERE customer_id = 'acme'");
    expect(
      await picked({ css: ["nav a.products"], text: ["Products"], structural: "first a in nav" }),
    ).toEqual([{ section_path: "count:/", goes: null }]);
  });

  it("goes is never in the bundle's conv (condition 4)", async () => {
    await picked({ css: ["#send"], text: ["Göndər"], structural: "first button in form" });
    const b = bundle();
    expect(b.conv).toHaveLength(1);
    expect(b.conv[0]).not.toHaveProperty("goes");
    expect(h.kv.get(visitorBundleKey("acme"))).not.toMatch(/goes|special_category/);
  });
});
