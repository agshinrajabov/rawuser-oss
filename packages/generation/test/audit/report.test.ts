/**
 * The audit report on real SQL (node:sqlite, every migration;
 * docs/specs/ai-traffic-audit.md §4, §5, §14 "Generation, real SQL"): the
 * partition, the floors, the three states, the Wilson ranges, the sample
 * (the founder's call 1: the biggest AI name first), the test line, and a
 * frozen snapshot that holds counts and copy only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_VISITS_SQL,
  buildAuditReport,
  chooseSample,
  floorCount,
  heroFromHtml,
  partition,
  shareOf,
  signatureOf,
} from "../../src/audit/report.ts";
import { wilsonCI } from "../../src/lib/lift.ts";
import { makeKv, makeSqliteD1 } from "../admin/sqlite-d1.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 9, 7, 15);
const END = START + 7 * DAY;
const NOW = END + HOUR;

let sqlite: ReturnType<typeof makeSqliteD1>;
let kv: ReturnType<typeof makeKv>;
let env: { DB: D1Database; VARIANTS: KVNamespace };
let n = 0;

const HERO_HTML = `<html><body><main><h1 class="hero-title">Quotes your clients <em>sign</em>.</h1>
<p class="hero-lede">Build a clear quote in minutes, send it as one link.</p>
<a class="hero-cta" href="/signup">Start free</a></main></body></html>`;

const MANIFEST = {
  "hero.headline": {
    css: ["h1.hero-title"],
    text: ["Quotes your clients sign."],
    structural: "first h1",
    original_char_length: 25,
    inline: { emphasis_phrase: "sign" },
  },
  "hero.body": {
    css: ["p.hero-lede"],
    text: ["Build a clear quote in minutes, send it"],
    structural: "first p",
    original_char_length: 51,
  },
  // The operator turned this button's rewrite on (lib/button-rewrite.ts).
  "hero.cta.label": {
    css: ["a.hero-cta"],
    text: ["Start free"],
    structural: "first a",
    rewrite: true,
  },
};

interface Ev {
  visit?: string | null;
  ts?: number;
  type?: string;
  cohort?: string;
  source_dim?: string | null;
  source_name?: string | null;
  found_by?: string | null;
  page?: string;
  dark?: number;
  lang?: number;
  body_id?: string | null;
  customer?: string;
}

function ev(e: Ev): void {
  sqlite.db
    .prepare(
      `INSERT INTO events (id, customer_id, ts, event_type, cohort, visit, source_dim, source_name,
         found_by, page_path, dark_social, language_mismatch, body_id, intent_dim)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `e${++n}`,
      e.customer ?? "quote",
      e.ts ?? START + HOUR + n,
      e.type ?? "variant_shown",
      e.cohort ?? "personalized",
      e.visit === undefined ? `v${n}` : e.visit,
      e.source_dim ?? null,
      e.source_name ?? null,
      e.found_by ?? null,
      e.page ?? "/",
      e.dark ?? 0,
      e.lang ?? 0,
      e.body_id ?? null,
      e.source_dim ? "problem" : null,
    );
}

/** `count` one-page visits of one kind. */
function visits(count: number, e: Ev): void {
  for (let i = 0; i < count; i++)
    ev({ ...e, visit: `${e.source_name ?? e.found_by ?? "x"}-${++n}` });
}

function body(id: string, headline: string) {
  return {
    customer_id: "quote",
    profile_key: "problem:ai",
    sections: {
      hero: { kind: "hero", headline, body: `${headline} body`, cta: { label: "Make a quote" } },
    },
    generated_at: START,
    prompt_hash: "h",
    body_id: id,
  };
}

function versionBody(id: string, headline: string, page = "/"): void {
  sqlite.db
    .prepare(
      `INSERT INTO version_bodies (body_id, customer_id, page_path, intent_dim, source_dim, language,
         model, prompt_hash, lint_flags, body_json, live_from, retired_at)
       VALUES (?, 'quote', ?, 'problem', 'ai', 'en', 'model-a', 'h', NULL, ?, ?, NULL)`,
    )
    .run(id, page, JSON.stringify(body(id, headline)), START);
}

const fetchHtml = vi.fn(async () => HERO_HTML);

beforeEach(() => {
  sqlite = makeSqliteD1();
  kv = makeKv();
  env = { DB: sqlite.d1, VARIANTS: kv };
  n = 0;
  fetchHtml.mockClear();
  sqlite.db
    .prepare(
      `INSERT INTO customers (id, slug, domain, plan, status, created_at, live_at, audit_from, audit_to,
         audit_terms_at, audit_consent_banner)
       VALUES ('quote', 'quote', 'quoteloom.example', 'audit', 'active', ?, ?, ?, ?, ?, 1)`,
    )
    .run(START - 2 * DAY, START - DAY, START, END, START - 2 * DAY);
  sqlite.db
    .prepare(
      `INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at)
       VALUES ('quote', '/', ?, 'https://quoteloom.example/', ?, ?)`,
    )
    .run(JSON.stringify(MANIFEST), START - DAY, START - DAY);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function rows() {
  return (await env.DB.prepare(AUDIT_VISITS_SQL).bind("quote", START, END).all())
    .results as never[];
}

// ---------------------------------------------------------------------------

describe("one visit, one group (§4.1)", () => {
  it("a three-page visit counts once, under its landing's source", async () => {
    ev({ visit: "m1", source_dim: "ai", source_name: "chatgpt", found_by: "auto_tag", page: "/" });
    ev({ visit: "m1", source_dim: "ai", page: "/pricing" });
    ev({ visit: "m1", source_dim: "ai", page: "/vs" });
    const p = partition(await rows());
    expect(p.total).toBe(1);
    expect(p.raw.ai).toBe(1);
    expect(p.saw).toBe(1);
  });

  it("a path-only personalised visit has no source to read and saw a version", async () => {
    ev({ visit: "p1", source_dim: "direct", page: "/pricing" });
    const p = partition(await rows());
    expect(p.raw.none).toBe(1);
    expect(p.saw).toBe(1);
  });

  it("a held-out visit keeps its source and saw no version", async () => {
    ev({
      visit: "h1",
      cohort: "holdout",
      source_dim: "social",
      source_name: "instagram",
      found_by: "app_marker",
    });
    const p = partition(await rows());
    expect(p.raw.social).toBe(1);
    expect(p.saw).toBe(0);
  });

  it("a row without a marker is its own visit, once", async () => {
    ev({ visit: null, type: "no_signal_passthrough", cohort: "no_signal" });
    ev({ visit: null, type: "no_signal_passthrough", cohort: "no_signal" });
    const p = partition(await rows());
    expect(p.total).toBe(2);
    expect(p.raw.none).toBe(2);
  });

  it("every group adds up to the total, the language line included", async () => {
    visits(3, { source_dim: "ai", source_name: "chatgpt", found_by: "auto_tag" });
    visits(2, { source_dim: "organic", source_name: "google", found_by: "referrer" });
    visits(1, { source_dim: "paid", found_by: "click_id" });
    visits(1, { source_dim: "direct", found_by: "tag" });
    visits(4, { type: "no_signal_passthrough", cohort: "no_signal", dark: 1 });
    visits(2, { type: "no_signal_passthrough", cohort: "no_signal", lang: 1 });
    visits(1, {
      type: "personalization_skipped",
      cohort: "skipped",
      source_dim: "community",
      found_by: "referrer",
    });
    const p = partition(await rows());
    const sum = Object.values(p.raw).reduce((s, x) => s + x, 0);
    expect(sum).toBe(p.total);
    expect(p.total).toBe(14);
    expect(p.raw).toMatchObject({
      ai: 3,
      search: 2,
      ads: 1,
      other: 1,
      none: 4,
      language: 2,
      community: 1,
    });
  });

  it("rows outside the window and of other customers are not counted", async () => {
    sqlite.db.exec(
      "INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES ('other', 'other', 'o.example', 'pilot', 'active', 0)",
    );
    ev({ visit: "a", ts: START - 1, source_dim: "ai", found_by: "auto_tag" });
    ev({ visit: "b", ts: END, source_dim: "ai", found_by: "auto_tag" });
    ev({ visit: "c", customer: "other", source_dim: "ai", found_by: "auto_tag" });
    expect(partition(await rows()).total).toBe(0);
  });
});

describe("floors, states and ranges (§4.3, §5.5, §5.6)", () => {
  it("a count of 1 to 4 is '<5', a zero is 0", () => {
    expect([0, 1, 4, 5, 9].map(floorCount)).toEqual([0, "<5", "<5", 5, 9]);
  });

  it("a share is whole percents with Wilson rounded outward, none under the floor", () => {
    const s = shareOf(52, 1240);
    const [lo, hi] = wilsonCI(52, 1240);
    expect(s).toEqual({
      pct: 4,
      under_one: false,
      low: Math.floor(lo * 100),
      high: Math.ceil(hi * 100),
    });
    expect(shareOf(4, 1240)).toBeNull();
    expect(shareOf(6, 1240)).toMatchObject({ pct: 0, under_one: true });
  });

  it("names need 5 visits in their group; the rest is other", async () => {
    visits(6, { source_dim: "ai", source_name: "chatgpt", found_by: "auto_tag" });
    visits(3, { source_dim: "ai", source_name: "perplexity", found_by: "referrer" });
    visits(300, { type: "no_signal_passthrough", cohort: "no_signal" });
    const p = partition(await rows());
    const ai = p.groups.find((g) => g.key === "ai");
    expect(ai?.names).toEqual([{ name: "chatgpt", label: "ChatGPT", visits: 6 }]);
    expect(ai?.other).toBe("<5");
    expect(ai?.visits).toBe(9);
  });

  it("landing pages need 5 visits in their group, five at most, the rest other pages", async () => {
    for (const [page, k] of [
      ["/", 6],
      ["/pricing", 5],
      ["/a", 4],
      ["/b", 5],
      ["/c", 5],
      ["/d", 5],
      ["/e", 5],
    ] as const) {
      visits(k, { source_dim: "ai", source_name: "chatgpt", found_by: "auto_tag", page });
    }
    visits(300, { type: "no_signal_passthrough", cohort: "no_signal" });
    const p = partition(await rows());
    expect(p.landing?.ai.pages.map((x) => x.path)).toEqual(["/", "/b", "/c", "/d", "/e"]);
    expect(p.landing?.ai.pages.every((x) => x.visits >= 5)).toBe(true);
    expect(p.landing?.ai.other).toBe(9);
  });

  it("300 visits: full, with shares; 30 to 299: counts only; under 30: too few, no groups", async () => {
    visits(29, { type: "no_signal_passthrough", cohort: "no_signal" });
    let p = partition(await rows());
    expect(p.state).toBe("too_few");
    expect(p.groups).toEqual([]);
    expect(p.answers).toBeNull();
    visits(1, { source_dim: "ai", source_name: "chatgpt", found_by: "auto_tag" });
    p = partition(await rows());
    expect(p.state).toBe("counts");
    expect(p.groups.every((g) => g.share === null)).toBe(true);
    visits(270, { source_dim: "social", source_name: "instagram", found_by: "app_marker" });
    p = partition(await rows());
    expect(p.state).toBe("full");
    expect(p.answers?.no_referrer.share).not.toBeNull();
  });

  it("the three answers: AI, inside apps (named plus probably), no referrer", async () => {
    visits(10, { source_dim: "social", source_name: "instagram", found_by: "app_marker" });
    visits(7, { source_dim: "social", source_name: "whatsapp", found_by: "app_package" });
    visits(5, { source_dim: "social", source_name: "linkedin", found_by: "referrer" });
    visits(6, { type: "no_signal_passthrough", cohort: "no_signal", dark: 1 });
    visits(8, { source_dim: "ai", found_by: "app_marker" });
    visits(300, { type: "no_signal_passthrough", cohort: "no_signal" });
    const p = partition(await rows());
    expect(p.answers?.in_app).toMatchObject({ visits: 23, named: 17, probably: 6 });
    expect(p.answers?.no_referrer.visits).toBe(18);
    expect(p.groups.find((g) => g.key === "none")?.probably).toBe(6);
  });
});

describe("the sample (§5.2, call 1)", () => {
  it("the biggest AI name over the floor wins over a bigger search name, with its most served body", async () => {
    versionBody("b-ai-1", "Send quotes, get a yes back.");
    versionBody("b-ai-2", "Another one.");
    versionBody("b-google", "Search words.");
    visits(20, {
      source_dim: "organic",
      source_name: "google",
      found_by: "referrer",
      body_id: "b-google",
    });
    visits(4, {
      source_dim: "ai",
      source_name: "chatgpt",
      found_by: "auto_tag",
      body_id: "b-ai-1",
    });
    visits(2, {
      source_dim: "ai",
      source_name: "chatgpt",
      found_by: "auto_tag",
      body_id: "b-ai-2",
    });
    const built = await buildAuditReport(env, "quote", { start: START, end: END }, NOW, {
      fetchHtml,
    });
    const s = built.report.sample;
    expect(s?.form).toBe("saw");
    expect(s?.source).toEqual({ kind: "name", name: "chatgpt", label: "ChatGPT" });
    expect(s?.body_id).toBe("b-ai-1");
    expect(s?.headline.version).toBe("Send quotes, get a yes back.");
    expect(s?.cta.version).toBe("Make a quote");

    // A button that stays as built: the sample shows the page's own words
    // for it, also where the served body still carries a label.
    const { rewrite: _on, ...off } = MANIFEST["hero.cta.label"];
    sqlite.db
      .prepare("UPDATE element_manifests SET manifest = ? WHERE customer_id = 'quote'")
      .run(JSON.stringify({ ...MANIFEST, "hero.cta.label": off }));
    const again = await buildAuditReport(env, "quote", { start: START, end: END }, NOW, {
      fetchHtml,
    });
    expect(again.report.sample?.cta.version).toBeNull();
    expect(again.report.sample?.cta.page).not.toBeNull();
    expect(again.report.sample?.headline.version).toBe("Send quotes, get a yes back.");
    // The page's own hero, read by the confirmed selectors, emphasis marked.
    expect(s?.page_from).toBe("page");
    expect(s?.headline.page).toBe("Quotes your clients *sign*.");
    expect(fetchHtml).toHaveBeenCalledWith("https://quoteloom.example/", "quoteloom.example");
  });

  it("with no AI name over the floor, the biggest name", async () => {
    versionBody("b-google", "Search words.");
    visits(6, {
      source_dim: "organic",
      source_name: "google",
      found_by: "referrer",
      body_id: "b-google",
    });
    visits(3, {
      source_dim: "ai",
      source_name: "chatgpt",
      found_by: "auto_tag",
      body_id: "b-google",
    });
    const built = await buildAuditReport(env, "quote", { start: START, end: END }, NOW, {
      fetchHtml,
    });
    expect(built.report.sample?.source).toEqual({ kind: "name", name: "google", label: "Google" });
  });

  it("with no name over the floor, the biggest group with a served version", () => {
    const p = partition([
      {
        source_dim: "organic",
        source_name: null,
        found_by: "referrer",
        landing: "/",
        dark_social: 0,
        language_mismatch: 0,
        saw: 1,
        visits: 3,
      },
    ]);
    expect(
      chooseSample(p, [
        { source_dim: "organic", source_name: null, page_path: "/", body_id: "x", visits: 3 },
      ]),
    ).toEqual({ kind: "group", group: "search", page_path: "/", body_id: "x" });
  });

  it("nothing served: the 'would see' form, the version the edge picks for a ChatGPT link", async () => {
    visits(3, { type: "no_signal_passthrough", cohort: "no_signal" });
    // The edge's own cascade: (intent, ai), then (intent, default).
    const { classify, extractSignals, selectVariantKey, variantKeyForPath } = await import(
      "@rawuser/shared"
    );
    const sel = selectVariantKey(
      classify(
        extractSignals({
          url: new URL("https://edge.invalid/select?cid=quote&path=/&utm_source=chatgpt.com"),
          headers: new Headers({ "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15" }),
          selfHost: "quoteloom.example",
        }),
        NOW,
        null,
      ),
    );
    await kv.put(
      variantKeyForPath("quote", "/", sel.intent_dim, sel.source_dim),
      JSON.stringify(body("live-1", "Would see words.")),
    );
    const built = await buildAuditReport(env, "quote", { start: START, end: END }, NOW, {
      fetchHtml,
    });
    expect(built.report.sample).toMatchObject({
      form: "would_see",
      source: { kind: "name", name: "chatgpt", label: "ChatGPT" },
      page_path: "/",
      body_id: "live-1",
    });
    expect(built.report.sample?.headline.version).toBe("Would see words.");
    expect(built.report.state).toBe("too_few");
  });

  it("a page built in the browser: the manifest's signatures, '...' where cut", async () => {
    expect(heroFromHtml("<html><body><div id=app></div></body></html>", MANIFEST as never)).toEqual(
      {
        headline: null,
        body: null,
        cta: null,
      },
    );
    expect(signatureOf(MANIFEST as never, "hero.body")).toBe(
      "Build a clear quote in minutes, send it...",
    );
    expect(signatureOf(MANIFEST as never, "hero.headline")).toBe("Quotes your clients *sign*.");
    versionBody("b1", "Words.");
    visits(5, { source_dim: "ai", source_name: "chatgpt", found_by: "auto_tag", body_id: "b1" });
    const shell = vi.fn(async () => "<html><body><div id=app></div></body></html>");
    const built = await buildAuditReport(env, "quote", { start: START, end: END }, NOW, {
      fetchHtml: shell,
    });
    expect(built.report.sample?.page_from).toBe("signature");
    expect(built.review.checks.find((c) => c.id === "page_read")?.ok).toBe(false);
  });
});

describe("what the versions did (§5.3)", () => {
  async function line() {
    return (await buildAuditReport(env, "quote", { start: START, end: END }, NOW, { fetchHtml }))
      .report.versions_did;
  }
  function target() {
    sqlite.db
      .prepare(
        `INSERT INTO conversion_targets (id, customer_id, section_path, conversion_label, label, css_selectors,
           text_selectors, structural_selector, enabled, created_at, updated_at)
         VALUES ('t1', 'quote', 'hero.cta.label', 'cta', 'Start free', '["a"]', '[]', 'a', 1, 0, 0)`,
      )
      .run();
  }
  function test(endReason: string | null = null) {
    sqlite.db
      .prepare(
        `INSERT INTO holdout_tests (id, customer_id, percent, started_at, ended_at, created_at, started_by, end_reason)
         VALUES ('ht1', 'quote', 20, ?, ?, ?, 'go_live', ?)`,
      )
      .run(START, endReason ? END - DAY : null, START, endReason);
  }

  it("no button kept: no_button", async () => {
    expect(await line()).toEqual({ state: "no_button" });
  });

  it("a button but the test switched off at go live: off", async () => {
    target();
    expect(await line()).toEqual({ state: "off" });
  });

  it("running before its read date: too early, with the visits it needs and the weeks at this traffic", async () => {
    target();
    test();
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    for (let d = 0; d < 7; d++) {
      for (const [arm, v, c] of [
        ["treat", 80, 6],
        ["holdout", 20, 1],
      ] as const) {
        sqlite.db
          .prepare(
            `INSERT INTO exposure_outcomes (customer_id, day, arm, page_path, visits, converting_visits, computed_at)
             VALUES ('quote', ?, ?, '/', ?, ?, 0)`,
          )
          .run(day(START + d * DAY), arm, v, c);
      }
    }
    const l = await line();
    expect(l.state).toBe("too_early");
    if (l.state !== "too_early") return;
    expect(l.visits_needed).toBeGreaterThan(1000);
    expect((l.visits_needed as number) % 100).toBe(0);
    expect(l.weeks).toBeGreaterThan(1);
  });

  it("ended on day 14 for low traffic: low_traffic", async () => {
    target();
    test("low_traffic");
    expect(await line()).toEqual({ state: "low_traffic" });
  });

  it("never a natural or an interim lift in the snapshot", async () => {
    target();
    test();
    visits(40, { source_dim: "ai", source_name: "chatgpt", found_by: "auto_tag" });
    const built = await buildAuditReport(env, "quote", { start: START, end: END }, NOW, {
      fetchHtml,
    });
    const json = JSON.stringify(built.report);
    expect(json).not.toMatch(/natural|interim|so far/i);
    expect(built.report.test_running).toBe(true);
  });
});

describe("the frozen snapshot (§12, privacy review condition 4)", () => {
  it("built twice: one row, the same JSON; a released row is never rebuilt", async () => {
    versionBody("b1", "Words.");
    visits(6, { source_dim: "ai", source_name: "chatgpt", found_by: "auto_tag", body_id: "b1" });
    await buildAuditReport(env, "quote", { start: START, end: END }, NOW, { fetchHtml });
    const first = sqlite.db.prepare("SELECT report FROM audit_reports").all();
    await buildAuditReport(env, "quote", { start: START, end: END }, NOW, { fetchHtml });
    const second = sqlite.db.prepare("SELECT report FROM audit_reports").all();
    expect(second).toHaveLength(1);
    expect(second).toEqual(first);
    sqlite.db.exec("UPDATE audit_reports SET released_at = 1");
    await expect(
      buildAuditReport(env, "quote", { start: START, end: END }, NOW + 1, { fetchHtml }),
    ).rejects.toThrow(/released/);
  });

  it("holds no marker, row id, contact, or email; the review holds the no-marker count", async () => {
    sqlite.db.exec(
      "UPDATE customers SET contact_name = 'Rina Holt', contact_email = 'rina@quoteloom.example' WHERE id = 'quote'",
    );
    versionBody("b1", "Words.");
    visits(6, { source_dim: "ai", source_name: "chatgpt", found_by: "auto_tag", body_id: "b1" });
    ev({ visit: null, type: "no_signal_passthrough", cohort: "no_signal" });
    await buildAuditReport(env, "quote", { start: START, end: END }, NOW, { fetchHtml });
    const stored = String(
      (sqlite.db.prepare("SELECT report FROM audit_reports").get() as { report: string }).report,
    );
    expect(stored).not.toMatch(/chatgpt-\d|"e\d+"|Rina|rina@|visit"/);
    const snap = JSON.parse(stored);
    expect(snap.review).toMatchObject({ no_marker_rows: 1, rows: 7 });
    expect(snap.report.consent_banner).toBe(true);
    expect(snap.review.checks.find((c: { id: string }) => c.id === "adds_up").ok).toBe(true);
  });
});

describe("audit rows stay out of cross-customer learning (privacy review condition 5)", () => {
  it("never an audit's rows; an upgraded audit's only from its signed pilot terms", async () => {
    const { LEARNING_EVENTS_WHERE } = await import("../../src/audit/learning.ts");
    sqlite.db.exec(`
      INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES ('pil', 'pil', 'p.example', 'pilot', 'active', 0);
      INSERT INTO customers (id, slug, domain, plan, status, created_at, audit_terms_at, pilot_terms_at)
        VALUES ('up', 'up', 'u.example', 'pilot', 'active', 0, 1, 5000);
      INSERT INTO customers (id, slug, domain, plan, status, created_at, audit_terms_at)
        VALUES ('nosign', 'nosign', 'n.example', 'pilot', 'active', 0, 1);`);
    for (const [cid, ts] of [
      ["quote", 9000],
      ["pil", 10],
      ["up", 4999],
      ["up", 5000],
      ["nosign", 9000],
    ] as const) {
      ev({ customer: cid, ts, source_dim: "ai", found_by: "auto_tag" });
    }
    const rows = sqlite.db
      .prepare(
        `SELECT e.customer_id AS c, e.ts AS ts FROM events e WHERE ${LEARNING_EVENTS_WHERE} ORDER BY c, ts`,
      )
      .all();
    expect(rows).toEqual([
      { c: "pil", ts: 10 },
      { c: "up", ts: 5000 },
    ]);
  });
});
