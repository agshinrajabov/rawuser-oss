/**
 * Measure at go live (docs/specs/measure-at-go-live.md §12, §15; privacy review
 * CONDITIONAL PASS 2026-10-05, conditions 1, 3 and 4), on real SQL:
 *
 * - quickstart: the record's `measure` (the hero button proposed, the other
 *   candidates, the language pages that carry it, the traffic before), no
 *   link anywhere in the record; an extra page has none;
 * - go live: `test: true` with a button starts 20% (`go_live`, the
 *   session's account id, bundle `h`); the counted target is the union of
 *   once-matching selectors over the ticked language pages, the only one
 *   enabled; omitted `test`, no button, an extra page, a second go live,
 *   an earlier test, a test customer and too little traffic start nothing;
 *   no other percent can be set this way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayOf } from "../../src/cron/exposure-rollup.ts";
import { type Harness, harness } from "../proof-harness.ts";

const EN_HTML = `<html lang="en"><head>
<link rel="alternate" hreflang="az" href="https://acme.test/az">
<link rel="alternate" hreflang="ru" href="https://acme.test/ru">
</head><body>
<section class="hero"><h1>Forms people finish.</h1>
<a id="hero-cta" class="btn" href="/signup?ref=hero">Start free</a>
<a class="btn" href="#how">See how it works</a></section>
<form action="/join"><button id="submit">Get the template</button></form>
<a id="pricing-cta" href="/pricing">See plans</a>
</body></html>`;

const AZ_HTML = `<html lang="az"><body>
<section class="hero"><h1>Formlar.</h1>
<a id="hero-cta" class="start-az" href="/az/qeydiyyat">Pulsuz başla</a></section>
</body></html>`;

const RU_HTML = `<html lang="ru"><body><h1>Формы.</h1></body></html>`;

const EN_MANIFEST = {
  "hero.headline": { css: ["h1"], text: ["Forms people finish."], structural: "first h1" },
  "hero.cta.label": {
    css: ["#hero-cta", ".btn"],
    text: ["Start free"],
    structural: "hero link",
    conversion_candidate: true,
  },
  "forms.submit_label": {
    css: ["#submit"],
    text: ["Get the template"],
    structural: "form button",
    conversion_candidate: true,
  },
  "pricing.cta.label": {
    css: ["#pricing-cta"],
    text: ["See plans"],
    structural: "pricing link",
    conversion_candidate: true,
  },
};
const AZ_MANIFEST = {
  "hero.headline": { css: ["h1"], text: ["Formlar."], structural: "first h1" },
  "hero.cta.label": {
    css: ["#hero-cta", "a.start-az", "a.nowhere"],
    text: ["Pulsuz başla"],
    structural: "hero link",
    conversion_candidate: true,
  },
};
const RU_MANIFEST = {
  "hero.headline": { css: ["h1"], text: ["Формы."], structural: "first h1" },
};

vi.mock("../../src/detect-elements.ts", () => ({
  fetchPageHtml: vi.fn(async (url: string) =>
    url.endsWith("/az") ? AZ_HTML : url.endsWith("/ru") ? RU_HTML : EN_HTML,
  ),
  cleanHtml: vi.fn((html: string) => html),
  detectElements: vi.fn(async (html: string) => ({
    manifest: html.includes('<html lang="az"')
      ? AZ_MANIFEST
      : html.includes('<html lang="ru"')
        ? RU_MANIFEST
        : EN_MANIFEST,
    cost_usd: 0,
    source_html_bytes: html.length,
  })),
}));

vi.mock("../../src/dna-suggest.ts", () => ({
  suggestDnaFromHtml: vi.fn(async (_h: string, url: string, _e: unknown, lang: string | null) => ({
    url,
    generated_at: 1,
    language: lang ?? "en",
    product: "Form builder",
    icp: "Indie founders",
    target_market: "",
    brand_voice: "plain",
    value_props: [{ text: "Forms in minutes", evidence: "Forms in minutes" }],
    differentiators: [],
    proof_points: [],
  })),
}));

vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(),
  regenerateOne: vi.fn(async () => ({ ok: false, error: "no preview in this test", cost_usd: 0 })),
}));

type User = { id: string; email: string; role: string; customer_id: string | null };
const SAM: User = { id: "u_sam", email: "sam@acme.test", role: "customer", customer_id: "acme" };
const FOUNDER: User = { id: "u1", email: "f@example.com", role: "superadmin", customer_id: null };
let sessionUser: User = SAM;
vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionUser),
}));

const { default: worker } = await import("../../src/index.ts");

const DAY = 86_400_000;
let h: Harness;

beforeEach(() => {
  h = harness();
  h.customer("acme");
  sessionUser = SAM;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function call(
  path: string,
  body: unknown,
  method: "GET" | "POST" = "POST",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`https://api.example.com${path}`, {
      method,
      headers: { "x-rawuser-admin": "session", "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }),
    h.env as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function quickstart(pagePath = "/") {
  h.kv.set(`capture:acme:${pagePath}`, EN_HTML);
  const r = await call("/admin/onboard/quickstart", { customer_id: "acme", page_path: pagePath });
  expect(r.status).toBe(200);
  return r.json;
}

const DNA = { product: "Form builder", icp: "Indie founders", value_props: ["Forms in minutes"] };

function goLive(extra: Record<string, unknown> = {}, pagePath = "/") {
  return call("/admin/onboard/go-live", {
    customer_id: "acme",
    page_path: pagePath,
    dna: DNA,
    languages: ["en", "az", "ru"],
    ...extra,
  });
}

const testRows = () =>
  h.db
    .prepare(
      "SELECT percent, ended_at, started_by, started_actor, end_reason, ended_actor FROM holdout_tests WHERE customer_id = 'acme'",
    )
    .all() as Array<Record<string, unknown>>;
const targets = () =>
  (
    h.db
      .prepare(
        "SELECT section_path, label, conversion_label, enabled, css_selectors, text_selectors FROM conversion_targets WHERE customer_id = 'acme' ORDER BY section_path",
      )
      .all() as Array<Record<string, unknown>>
  ).map((t) => ({
    ...t,
    css_selectors: JSON.parse(t.css_selectors as string),
    text_selectors: JSON.parse(t.text_selectors as string),
  }));
const bundle = () => JSON.parse(h.kv.get("v1:vm:acme") ?? "null") as Record<string, unknown> | null;

/** Closed days of eligible traffic before today. */
function traffic(days: number, visitsPerDay: number) {
  const now = Date.now();
  for (let d = days; d >= 1; d--) {
    h.db
      .prepare(
        `INSERT INTO exposure_outcomes (customer_id, day, arm, page_path, intent_dim, source_dim,
           visits, converting_visits, computed_at)
         VALUES ('acme', ?, 'none', '/', 'problem', 'ai', ?, 0, 1)
         ON CONFLICT DO NOTHING`,
      )
      .run(dayOf(now - d * DAY), visitsPerDay);
  }
}

describe("quickstart: the button to count", () => {
  it("proposes the hero button, lists the others, says which language pages carry it", async () => {
    const record = await quickstart();
    const measure = record.measure as Record<string, unknown>;
    expect(measure.proposal).toEqual({ section_path: "hero.cta.label", label: "Start free" });
    expect(measure.others).toEqual([
      { section_path: "forms.submit_label", label: "Get the template" },
      { section_path: "pricing.cta.label", label: "See plans" },
    ]);
    expect(measure.per_language).toEqual([
      { lang: "az", path: "/az", found: true, slots: ["hero.cta.label"] },
      { lang: "ru", path: "/ru", found: false, slots: [] },
    ]);
    expect(measure).toMatchObject({ baseline_days: 0, estimate_weeks: null, low_traffic: false });
  });

  it("a button already picked on this page leads the proposal", async () => {
    h.db
      .prepare(
        `INSERT INTO conversion_targets (customer_id, section_path, label, conversion_label, enabled,
           css_selectors, text_selectors, structural_selector, created_at, updated_at)
         VALUES ('acme', 'count:/', 'Sign up', 'signup', 1, '["nav a.signup"]', '[]', 'x', 1, 1)`,
      )
      .run();
    const measure = (await quickstart()).measure as Record<string, unknown>;
    expect(measure.proposal).toEqual({ section_path: "count:/", label: "Sign up" });
    expect((measure.others as Array<{ section_path: string }>)[0]?.section_path).toBe(
      "hero.cta.label",
    );
    expect((measure.per_language as Array<{ found: boolean }>).every((l) => !l.found)).toBe(true);
  });

  it("a slot name that is neither on the page nor picked is no button", async () => {
    await quickstart();
    const r = await goLive({ count: { section_path: "nav.cta.label" }, test: true });
    expect(r.json.count).toBeNull();
    expect((r.json.test as { reason: string }).reason).toBe("no_button");
  });

  it("keeps no link: no href, no link target anywhere in the stored record", async () => {
    await quickstart();
    const stored = h.kv.get("v1:quickstart:acme:/") ?? "";
    // ("hreflang" is the language list's own source word, not a link.)
    expect(stored).not.toMatch(/href(?!lang)|\/signup|\/join|\/pricing|qeydiyyat|#how/);
  });

  it("keeps where each button goes as a closed word, and whether the page has a contact link", async () => {
    const record = await quickstart();
    // The hero link goes to /signup, a start page by the rules; the form's
    // button submits; the pricing link opens another page of the site.
    expect(record.measure_goes).toEqual({
      "/": {
        "hero.cta.label": "start_page",
        "forms.submit_label": "form",
        "pricing.cta.label": "same_site",
      },
    });
    expect(record.measure_contact_link).toBe(false);
  });

  it("an estimate only from 7 closed days of rows; past 52 weeks it says low traffic", async () => {
    traffic(6, 1);
    let m = (await quickstart()).measure as Record<string, unknown>;
    expect(m).toMatchObject({ baseline_days: 6, estimate_weeks: null, low_traffic: false });
    traffic(10, 1); // four more days: 10 days with rows
    m = (await quickstart()).measure as Record<string, unknown>;
    expect(m.baseline_days).toBe(10);
    expect(m.estimate_weeks as number).toBeGreaterThan(52);
    expect(m.low_traffic).toBe(true);
  });

  it("an extra page after go live has no measure", async () => {
    await quickstart();
    await goLive({ test: false });
    const r = await quickstart("/pricing");
    expect(r.measure).toBeNull();
  });
});

describe("go live: the first set (docs/specs/versions-approval.md)", () => {
  const firstSet = () =>
    JSON.parse(
      (
        h.db.prepare("SELECT first_set FROM customers WHERE id = 'acme'").get() as {
          first_set: string | null;
        }
      ).first_set ?? "null",
    ) as { at: number; pages: string[]; intents: string[] | null } | null;

  it("a true first go live records the page and the ticked language pages; a later one moves nothing", async () => {
    await quickstart();
    const r = await goLive({ languages: ["en", "az"], test: false });
    expect(r.status).toBe(200);
    const set = firstSet();
    expect(set?.pages).toEqual(["/", "/az"]);
    expect(set?.at).toBe(r.json.confirmed_at);
    // The intents the site served then, as the write path reads them.
    const served = (
      h.db.prepare("SELECT served_intents FROM customers WHERE id = 'acme'").get() as {
        served_intents: string | null;
      }
    ).served_intents;
    expect(set?.intents).toEqual(served ? JSON.parse(served) : null);
    // Going live again (another page, or the same page re-confirmed) keeps it.
    const again = await goLive({ languages: ["en", "az", "ru"], test: false });
    expect(again.status).toBe(200);
    expect(firstSet()).toEqual(set);
  });
});

describe("go live: the counted button", () => {
  it("one enabled target, its selectors the once-matching union over the ticked pages; a page without it named", async () => {
    // An older target, enabled: go live leaves only the chosen one counted (A3).
    h.db
      .prepare(
        `INSERT INTO conversion_targets (customer_id, section_path, label, conversion_label, enabled,
           css_selectors, text_selectors, structural_selector, created_at, updated_at)
         VALUES ('acme', 'cta.cta.label', 'Old', 'other', 1, '["#old"]', '[]', 'x', 1, 1)`,
      )
      .run();
    await quickstart();
    const r = await goLive({ count: { section_path: "hero.cta.label" }, test: false });
    expect(r.status).toBe(200);
    expect(r.json.count).toEqual({
      section_path: "hero.cta.label",
      label: "Start free",
      not_found_on: ["/ru"],
    });
    expect(targets()).toEqual([
      expect.objectContaining({ section_path: "cta.cta.label", enabled: 0 }),
      {
        section_path: "hero.cta.label",
        label: "Start free",
        conversion_label: "trial_start",
        enabled: 1,
        // ".btn" matched twice on the English page, "a.nowhere" never on /az.
        css_selectors: ["#hero-cta", "a.start-az"],
        text_selectors: ["Start free", "Pulsuz başla"],
      },
    ]);
    const conv = (bundle()?.c ?? bundle()?.conversions ?? bundle()) as unknown;
    expect(JSON.stringify(conv)).toContain("a.start-az");
  });

  it("an unticked language page is left out of the union and not named", async () => {
    await quickstart();
    const r = await goLive({
      languages: ["en"],
      count: { section_path: "hero.cta.label" },
      test: false,
    });
    expect(r.json.count).toMatchObject({ not_found_on: [] });
    expect(targets()[0]?.css_selectors).toEqual(["#hero-cta"]);
  });

  it("writes where the counted button goes from the record, as a closed word, never in the bundle", async () => {
    await quickstart();
    await goLive({ count: { section_path: "pricing.cta.label" }, test: false });
    const row = h.db
      .prepare(
        "SELECT goes FROM conversion_targets WHERE customer_id = 'acme' AND section_path = 'pricing.cta.label'",
      )
      .get() as { goes: string | null };
    expect(row.goes).toBe("same_site");
    expect(h.kv.get("v1:vm:acme")).not.toMatch(/goes|same_site/);
  });

  it("a form's submit button is counted as a click labelled contact (E1.1)", async () => {
    await quickstart();
    const r = await goLive({ count: { section_path: "forms.submit_label" }, test: false });
    expect(r.status).toBe(200);
    expect(r.json.count).toMatchObject({
      section_path: "forms.submit_label",
      label: "Get the template",
    });
    // "Get the template" names no kind; the form's submit is a contact.
    expect(targets()).toEqual([
      expect.objectContaining({
        section_path: "forms.submit_label",
        conversion_label: "contact",
        enabled: 1,
        css_selectors: ["#submit"],
      }),
    ]);
    // The whole record is a click: nothing reads the form.
    expect(JSON.stringify(r.json)).not.toMatch(/lead|form sent|submission/i);
  });

  it("a button picked on the page (a target outside the manifest) is counted as it is", async () => {
    await quickstart();
    h.db
      .prepare(
        `INSERT INTO conversion_targets (customer_id, section_path, label, conversion_label, enabled,
           css_selectors, text_selectors, structural_selector, created_at, updated_at)
         VALUES ('acme', 'count:/', 'Sign up', 'signup', 0, '["nav a.signup"]', '[]', 'x', 1, 1)`,
      )
      .run();
    const r = await goLive({ count: { section_path: "count:/" }, test: true });
    // Counted on its own page only, so the ticked language pages are named.
    expect(r.json.count).toEqual({
      section_path: "count:/",
      label: "Sign up",
      not_found_on: ["/az", "/ru"],
    });
    expect(targets()).toEqual([expect.objectContaining({ section_path: "count:/", enabled: 1 })]);
    expect((r.json.test as { reason: string }).reason).toBe("started");
  });
});

describe("go live: the test", () => {
  it("test: true with a button starts 20% from go live, by go_live, with the session's account id", async () => {
    await quickstart();
    const before = Date.now();
    const r = await goLive({ count: { section_path: "hero.cta.label" }, test: true });
    expect(r.status).toBe(200);
    const test = r.json.test as {
      started: boolean;
      percent: number;
      since: number;
      reason: string;
    };
    expect(test).toMatchObject({ started: true, percent: 20, reason: "started" });
    expect(test.since - before).toBeGreaterThanOrEqual(10 * 60_000);
    expect(testRows()).toEqual([
      {
        percent: 20,
        ended_at: null,
        started_by: "go_live",
        started_actor: "u_sam",
        end_reason: null,
        ended_actor: null,
      },
    ]);
    expect(bundle()?.h).toBe(20);
    expect(
      h.db.prepare("SELECT holdout_percent, live_at FROM customers WHERE id = 'acme'").get(),
    ).toMatchObject({ holdout_percent: 20 });
    // The lift report tells the customer who started it.
    const lift = await call("/admin/analytics/lift?customer_id=acme", undefined, "GET");
    expect(lift.json.test).toMatchObject({ started_by: "go_live", end_reason: null });
    expect(JSON.stringify(lift.json)).not.toContain("u_sam");
  });

  it("a superadmin session records 'superadmin' as the actor", async () => {
    sessionUser = FOUNDER;
    await quickstart();
    await goLive({ count: { section_path: "hero.cta.label" }, test: true });
    expect(testRows()[0]).toMatchObject({ started_by: "go_live", started_actor: "superadmin" });
  });

  it("no other percent: a percent in the body is ignored, the test is 20", async () => {
    await quickstart();
    const r = await goLive({ count: { section_path: "hero.cta.label" }, test: true, percent: 50 });
    expect((r.json.test as { percent: number }).percent).toBe(20);
    expect(testRows()[0]?.percent).toBe(20);
    // The control that sets other percents stays the superadmin's.
    const set = await call("/admin/customers/holdout", { customer_id: "acme", percent: 50 });
    expect(set.status).toBe(403);
  });

  it.each([
    ["test omitted", {}, "off"],
    ["test false", { test: false }, "off"],
    ["test as a string", { test: "true" }, "off"],
  ])("%s: no test", async (_name, extra, reason) => {
    await quickstart();
    const r = await goLive({ count: { section_path: "hero.cta.label" }, ...extra });
    expect(r.json.test).toEqual({ started: false, percent: 0, since: null, reason });
    expect(testRows()).toEqual([]);
    expect(targets().filter((t) => t.enabled === 1)).toHaveLength(1);
  });

  it("no button: no test", async () => {
    await quickstart();
    const r = await goLive({ count: null, test: true });
    expect(r.json.count).toBeNull();
    expect((r.json.test as { reason: string }).reason).toBe("no_button");
    expect(testRows()).toEqual([]);
  });

  it("a slot that is not on the page is no button", async () => {
    await quickstart();
    const r = await goLive({ count: { section_path: "cta.cta.label" }, test: true });
    expect(r.json.count).toBeNull();
    expect((r.json.test as { reason: string }).reason).toBe("no_button");
  });

  it("7 closed days of traffic with a read past 52 weeks: low_traffic, no test", async () => {
    traffic(10, 1);
    await quickstart();
    const r = await goLive({ count: { section_path: "hero.cta.label" }, test: true });
    expect((r.json.test as { reason: string }).reason).toBe("low_traffic");
    expect(testRows()).toEqual([]);
    // The button is still counted, so Results can offer "Start anyway".
    expect(r.json.count).toMatchObject({ section_path: "hero.cta.label" });
  });

  it("a test customer never gets one (test_customer)", async () => {
    h.db.prepare("UPDATE customers SET plan = 'test' WHERE id = 'acme'").run();
    await quickstart();
    const r = await goLive({ count: { section_path: "hero.cta.label" }, test: true });
    expect((r.json.test as { reason: string }).reason).toBe("test_customer");
    expect(testRows()).toEqual([]);
    expect(h.db.prepare("SELECT holdout_percent FROM customers WHERE id = 'acme'").get()).toEqual({
      holdout_percent: null,
    });
  });

  it("a customer already live before this request gets nothing (already_live)", async () => {
    h.db.prepare("UPDATE customers SET live_at = 1 WHERE id = 'acme'").run();
    await quickstart();
    const r = await goLive({ count: { section_path: "hero.cta.label" }, test: true });
    expect((r.json.test as { reason: string }).reason).toBe("already_live");
    expect(testRows()).toEqual([]);
  });

  it("a second go live never touches the test, and never starts one again after it ended", async () => {
    await quickstart();
    await goLive({ count: { section_path: "hero.cta.label" }, test: true });
    await quickstart();
    let r = await goLive({ count: { section_path: "forms.submit_label" }, test: true });
    expect(r.json.test).toMatchObject({ started: false, reason: "already_ran" });
    // The counted button did not move either.
    expect(r.json.count).toBeNull();
    expect(
      targets()
        .filter((t) => t.enabled === 1)
        .map((t) => t.section_path),
    ).toEqual(["hero.cta.label"]);
    // Stopped by the customer: still nothing at the next go live.
    await call("/admin/proof/test", { customer_id: "acme", action: "stop" });
    await quickstart();
    r = await goLive({ count: { section_path: "hero.cta.label" }, test: true });
    expect(r.json.test).toMatchObject({ started: false, reason: "already_ran" });
    expect(testRows()).toHaveLength(1);
  });

  it("a customer with an earlier test never gets one (already_ran)", async () => {
    h.db
      .prepare(
        "INSERT INTO holdout_tests (id, customer_id, percent, started_at, ended_at, created_at) VALUES ('ht_old', 'acme', 10, 1, 2, 1)",
      )
      .run();
    await quickstart();
    const r = await goLive({ count: { section_path: "hero.cta.label" }, test: true });
    expect((r.json.test as { reason: string }).reason).toBe("already_ran");
    expect(testRows()).toHaveLength(1);
  });

  it("an extra page's go live never starts, stops or changes a test", async () => {
    await quickstart();
    await goLive({ count: { section_path: "hero.cta.label" }, test: true });
    await quickstart("/pricing");
    const r = await goLive(
      { count: { section_path: "pricing.cta.label" }, test: true },
      "/pricing",
    );
    expect(r.json.test).toMatchObject({ started: false, reason: "extra_page" });
    expect(r.json.count).toBeNull();
    expect(testRows()).toEqual([expect.objectContaining({ ended_at: null, percent: 20 })]);
    expect(
      targets()
        .filter((t) => t.enabled === 1)
        .map((t) => t.section_path),
    ).toEqual(["hero.cta.label"]);
  });
});

describe("the customer's own start and stop record who and why", () => {
  it("start anyway passes only the traffic block; stop records the customer and its account", async () => {
    traffic(10, 1);
    await quickstart();
    await goLive({ count: { section_path: "hero.cta.label" }, test: true });
    expect(testRows()).toEqual([]);
    const refused = await call("/admin/proof/test", { customer_id: "acme", action: "start" });
    expect(refused.status).toBe(409);
    expect(refused.json.reason).toBe("too_little_traffic");
    const anyway = await call("/admin/proof/test", {
      customer_id: "acme",
      action: "start",
      anyway: true,
    });
    expect(anyway.status).toBe(200);
    expect(testRows()[0]).toMatchObject({ started_by: "customer", started_actor: "u_sam" });
    const stop = await call("/admin/proof/test", { customer_id: "acme", action: "stop" });
    expect(stop.status).toBe(200);
    expect(testRows()[0]).toMatchObject({ end_reason: "customer", ended_actor: "u_sam" });
  });

  it("anyway never passes a missing button", async () => {
    traffic(10, 1);
    const r = await call("/admin/proof/test", {
      customer_id: "acme",
      action: "start",
      anyway: true,
    });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("no_button");
  });

  it("the superadmin control records superadmin, and a new percent ends the old period as new_test", async () => {
    sessionUser = FOUNDER;
    await call("/admin/customers/holdout", { customer_id: "acme", percent: 10 });
    await call("/admin/customers/holdout", { customer_id: "acme", percent: 50 });
    await call("/admin/customers/holdout", { customer_id: "acme", percent: 0 });
    const rows = h.db
      .prepare(
        "SELECT percent, started_by, started_actor, end_reason, ended_actor FROM holdout_tests WHERE customer_id = 'acme' ORDER BY created_at, percent",
      )
      .all();
    expect(rows).toEqual([
      {
        percent: 10,
        started_by: "superadmin",
        started_actor: "superadmin",
        end_reason: "new_test",
        ended_actor: "superadmin",
      },
      {
        percent: 50,
        started_by: "superadmin",
        started_actor: "superadmin",
        end_reason: "superadmin",
        ended_actor: "superadmin",
      },
    ]);
    const control = await call("/admin/customers/holdout?customer_id=acme", undefined, "GET");
    expect((control.json.history as Array<Record<string, unknown>>)[0]).toMatchObject({
      started_by: "superadmin",
      started_actor: "superadmin",
      end_reason: "new_test",
      ended_actor: "superadmin",
    });
  });
});
