/**
 * The counting side of page groups (docs/specs/page-groups.md, phase 1;
 * privacy review conditions 6 and 8) and the second lift line
 * (proof-engine.md, "Visits that never met a version", option 3). Real SQL
 * on node:sqlite with every migration applied.
 *
 * - The hourly aggregator proposes a pattern, never an example path: a fixed
 *   part with at least 5 distinct masked pages exactly one segment deeper,
 *   none of them confirmed; every fixed segment screened; an accepted
 *   pattern counted under the floor; nothing stored for a customer without
 *   groups beyond what it always stored.
 * - A sensitive customer's proposals come from page_days on folded days and
 *   name a kept section's group only; `/:item` is never a pattern.
 * - The breakdown's `pages.groups` with the accepted ones marked, also when
 *   the page_groups table is missing.
 * - The second line: its class, its gate, the read date only, never interim;
 *   a group's click on page three of an armed visit counts for its arm in
 *   both lines.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAnalyticsBreakdown } from "../../src/admin/analytics.ts";
import type { SessionUser } from "../../src/admin/auth.ts";
import type { AdminEnv } from "../../src/admin/handlers.ts";
import {
  ACCEPTED_GROUP_COUNTS_SQL,
  GROUPS_FAILED_LINE,
  GROUP_PROPOSALS_SQL,
  aggregateWindow,
  armTotals,
} from "../../src/cron/analytics-aggregator.ts";
import { computeDay, dayStart, rebuildDay } from "../../src/cron/exposure-rollup.ts";
import {
  GROUP_PROPOSAL_MIN_PAGES,
  breakdownGroups,
  groupCountsFrom,
  sensitiveGroupCounts,
} from "../../src/lib/page-group-counts.ts";
import {
  LIMITS_LINE,
  type OutcomeLite,
  type OwnPageLite,
  type ReportInput,
  type TestRow,
  buildLiftReport,
  loadLiftReport,
  loadReportInput,
} from "../../src/lib/proof-report.ts";
import { PAGE_LOADS_SQL, sensitiveGroupPages } from "../../src/lib/sensitive-pages.ts";
import { DAY, HOUR, type Harness, harness, vid } from "../proof-harness.ts";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const D1 = "2026-10-13";
const W7 = 7 * DAY;
const ROOT_BODY = "aaaaaaaaaaaaaaaa";
const NO_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

let h: Harness;
let n = 0;

beforeEach(() => {
  h = harness();
  h.customer("acme");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  n = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const at = (day: string, hour = 10) => dayStart(day) + hour * HOUR;

/** One visit: its pages as exposure rows under one marker. */
function visit(customer: string, ts: number, pages: string[]): string {
  const marker = vid(++n);
  for (const [i, page] of pages.entries()) {
    h.ev({ customer, ts: ts + i * 1000, type: "variant_shown", visit: marker, page });
  }
  return marker;
}

function confirm(customer: string, page: string): void {
  h.db
    .prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at) VALUES (?, ?, '{}', 'https://x.test', 1, 1)",
    )
    .run(customer, page);
}

function accept(customer: string, pattern: string): void {
  h.db
    .prepare("INSERT INTO page_groups (customer_id, pattern, created_at) VALUES (?, ?, 1)")
    .run(customer, pattern);
}

function perPage(customer: string, window = "7d") {
  const row = h.db
    .prepare(
      "SELECT per_page FROM analytics_aggregates WHERE customer_id = ? AND window = ? ORDER BY computed_at DESC LIMIT 1",
    )
    .get(customer, window) as { per_page: string };
  return JSON.parse(row.per_page);
}

function spy(): string[] {
  const seen: string[] = [];
  const prepare = h.d1.prepare.bind(h.d1);
  (h.d1 as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    seen.push(sql);
    return prepare(sql);
  };
  return seen;
}

/** Five product pages, one visit each, in the 7-day window. */
function fiveProducts(customer = "acme", section = "/products"): void {
  for (const slug of ["ginseng", "polimax", "vitalin", "kardio", "neuro"])
    visit(customer, at(D1), [`${section}/${slug}`]);
}

async function breakdown(customer: string): Promise<Record<string, unknown>> {
  const user: SessionUser = { id: "u", email: "a@b.c", role: "superadmin", customer_id: null };
  const resp = await handleAnalyticsBreakdown(
    new Request(`https://api.test/admin/analytics/breakdown?customer_id=${customer}&window=7d`),
    h.env as unknown as AdminEnv,
    user,
  );
  expect(resp.status).toBe(200);
  return (await resp.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe("the proposals (spec, 'Where groups come from'; privacy review condition 6)", () => {
  it("four pages under a fixed part propose nothing; five propose the pattern with pages and distinct visits", async () => {
    expect(GROUP_PROPOSAL_MIN_PAGES).toBe(5);
    for (const slug of ["a", "b", "c", "d"]) visit("acme", at(D1), [`/products/${slug}`]);
    await aggregateWindow("acme", "7d", W7, h.env);
    expect(perPage("acme").groups).toBeUndefined();

    // A fifth page, and one visit across two of them (one visit, not two).
    visit("acme", at(D1), ["/products/e", "/products/a"]);
    await aggregateWindow("acme", "7d", W7, h.env);
    expect(perPage("acme").groups).toEqual([{ pattern: "/products/*", pages: 5, visits: 5 }]);
  });

  it("a proposal names a pattern, never an example path, and only one segment deeper counts", async () => {
    fiveProducts();
    // The section itself, a page two deeper and a sibling with a longer name are not pages of /products/*.
    visit("acme", at(D1), ["/products"]);
    visit("acme", at(D1), ["/products/ginseng/reviews"]);
    visit("acme", at(D1), ["/productsale/x"]);
    await aggregateWindow("acme", "7d", W7, h.env);
    const groups = perPage("acme").groups as Array<{ pattern: string; pages: number }>;
    expect(groups).toEqual([{ pattern: "/products/*", pages: 5, visits: 5 }]);
    for (const g of groups) {
      expect(g.pattern.endsWith("/*")).toBe(true);
      expect(g.pattern).not.toMatch(/ginseng|polimax|reviews/);
    }
  });

  it("two fixed segments: /en/products/* from pages three deep, apart from /en/*", async () => {
    fiveProducts("acme", "/en/products");
    await aggregateWindow("acme", "7d", W7, h.env);
    expect(perPage("acme").groups).toEqual([{ pattern: "/en/products/*", pages: 5, visits: 5 }]);
  });

  it("a fixed segment that holds an identifier is never proposed: a uuid, digits, a masked :id, a token", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    fiveProducts("acme", `/u/${uuid}`);
    fiveProducts("acme", "/students/482");
    fiveProducts("acme", "/orders/:id");
    fiveProducts("acme", "/t/aB3dE5fG7hI9jK1lM2nO4");
    // Three segments deep: never a pattern either (two fixed at most).
    fiveProducts("acme", "/a/b/c");
    await aggregateWindow("acme", "7d", W7, h.env);
    const groups = perPage("acme").groups;
    // Only /u/:id... no: /u/<uuid>/x is three deep with a flagged middle; nothing remains.
    expect(groups).toBeUndefined();
    const sql = JSON.stringify(perPage("acme"));
    expect(sql).not.toContain(uuid);
    expect(sql).not.toContain("482");
  });

  it("a confirmed page inside the pattern is not one of its pages", async () => {
    fiveProducts();
    confirm("acme", "/products/ginseng");
    await aggregateWindow("acme", "7d", W7, h.env);
    expect(perPage("acme").groups).toBeUndefined();
    visit("acme", at(D1), ["/products/sixth"]);
    await aggregateWindow("acme", "7d", W7, h.env);
    expect(perPage("acme").groups).toEqual([{ pattern: "/products/*", pages: 5, visits: 5 }]);
  });

  it("an accepted pattern is counted under the floor, and at 0 with no visits", async () => {
    for (const slug of ["a", "b"]) visit("acme", at(D1), [`/products/${slug}`]);
    accept("acme", "/products/*");
    accept("acme", "/blog/*");
    const seen = spy();
    await aggregateWindow("acme", "7d", W7, h.env);
    expect(seen).toContain(ACCEPTED_GROUP_COUNTS_SQL);
    expect(perPage("acme").groups).toEqual([
      { pattern: "/products/*", pages: 2, visits: 2 },
      { pattern: "/blog/*", pages: 0, visits: 0 },
    ]);
  });

  it("a customer without groups: the statements it always ran plus the proposals read, and the blob it always stored", async () => {
    visit("acme", at(D1), ["/", "/products/a"]);
    const seen = spy();
    await aggregateWindow("acme", "7d", W7, h.env);
    expect(seen).toContain(GROUP_PROPOSALS_SQL);
    expect(seen).not.toContain(ACCEPTED_GROUP_COUNTS_SQL);
    for (const sql of seen) {
      expect(sql).not.toContain("page_days");
      expect(sql).not.toContain(":item");
      expect(sql).not.toContain("json_each(?");
    }
    expect(Object.keys(perPage("acme"))).toEqual(["pages", "without_versions"]);
    expect(perPage("acme").without_versions).toEqual({ pages: 2, visits: 1, signal_visits: 1 });
  });

  it("the proposals statement filters the customer first and lets only the fixed part out", () => {
    expect(GROUP_PROPOSALS_SQL).toMatch(/FROM events\s+WHERE customer_id = \?1/);
    expect(GROUP_PROPOSALS_SQL).toMatch(/SELECT fixed, COUNT\(DISTINCT page_path\)/);
    expect(GROUP_PROPOSALS_SQL).not.toMatch(/SELECT visit\b/);
  });

  it("groupCountsFrom screens every fixed part again, whatever the statement returned", () => {
    expect(
      groupCountsFrom([
        { fixed: "/products", pages: 5, visits: 9 },
        { fixed: "/u/550e8400-e29b-41d4-a716-446655440000", pages: 7, visits: 9 },
        { fixed: "/students/482", pages: 7, visits: 9 },
        { fixed: "/orders/:id", pages: 7, visits: 9 },
        { fixed: "/:item", pages: 7, visits: 9 },
        { fixed: "/", pages: 7, visits: 9 },
        { fixed: "/a/b/c", pages: 7, visits: 9 },
        { fixed: "/blog", pages: 4, visits: 40 },
      ]),
    ).toEqual([{ pattern: "/products/*", pages: 5, visits: 9 }]);
  });
});

describe("a sensitive customer proposes a kept section's group only, from page_days", () => {
  function loads(customer: string, day: string, path: string, count: number): void {
    h.db
      .prepare("INSERT INTO page_days (customer_id, day, page_path, loads) VALUES (?, ?, ?, ?)")
      .run(customer, day, path, count);
  }

  beforeEach(() => {
    h.customer("medora");
    h.db
      .prepare("UPDATE customers SET sensitive = 1, kept_sections = ? WHERE id = 'medora'")
      .run(JSON.stringify(["/products"]));
  });

  it("five named pages of /products on a folded day with five visits behind: /products/*; root pages never /:item", async () => {
    const slugs = ["ginseng", "polimax", "vitalin", "kardio", "neuro"];
    for (const s of slugs) loads("medora", D1, `/products/${s}`, 2);
    // Five pages at the root: their group is /:item, never a pattern.
    for (const s of ["a", "b", "c", "d", "e"]) loads("medora", D1, `/${s}`, 2);
    // A page two deeper is behind the group but not one of its pages.
    loads("medora", D1, "/products/ginseng/reviews", 2);
    // The visits behind the group (the fold's second floor) are counted from the rows the edge stores.
    for (const s of slugs) visit("medora", at(D1), ["/products/:item"]);
    for (const s of ["a", "b", "c", "d", "e"]) visit("medora", at(D1), ["/:item"]);
    await rebuildDay(h.d1, "medora", D1, NOW);
    const seen = spy();
    await aggregateWindow("medora", "7d", W7, h.env);
    // No statement of their own: the counter's rows, read once, name the pages.
    expect(seen.filter((s) => s === PAGE_LOADS_SQL)).toHaveLength(1);
    expect(seen).not.toContain(GROUP_PROPOSALS_SQL);
    expect(seen.some((s) => s.includes("group_pages_sensitive"))).toBe(false);
    expect(perPage("medora").groups).toEqual([{ pattern: "/products/*", pages: 5, visits: 5 }]);
  });

  it("sensitiveGroupPages: named pages one segment under a kept section only; a folded group row, /:item and a deeper page name nothing", () => {
    const kept = ["/products", "/a/b/c"];
    expect(
      sensitiveGroupPages(
        [
          { page_path: "/", loads: 9 },
          { page_path: "/products", loads: 9 },
          // The group's own row: loads of a folded day, no page named.
          { page_path: "/products/:item", loads: 40 },
          { page_path: "/products/ginseng", loads: 2 },
          { page_path: "/Products/Ginseng/", loads: 1 },
          { page_path: "/products/polimax", loads: 2 },
          { page_path: "/products/:id", loads: 2 },
          // Behind the group, not one of its pages.
          { page_path: "/products/ginseng/reviews", loads: 2 },
          // Root pages: /:item is never a group here.
          { page_path: "/x", loads: 2 },
          { page_path: "/:item", loads: 2 },
          // A section too deep for a pattern.
          { page_path: "/a/b/c/d", loads: 2 },
        ],
        kept,
      ),
    ).toEqual([{ grp: "/products/:item", pages: 3 }]);
    expect(sensitiveGroupPages([], kept)).toEqual([]);
    expect(sensitiveGroupPages([{ page_path: "/products/x", loads: 1 }], [])).toEqual([]);
  });

  it("a folded day adds loads and names no page: four named pages and a folded day under them propose nothing", async () => {
    for (const s of ["a", "b", "c", "d"]) loads("medora", D1, `/products/${s}`, 2);
    loads("medora", D1, "/products/:item", 50);
    for (let i = 0; i < 5; i++) visit("medora", at(D1), ["/products/:item"]);
    await rebuildDay(h.d1, "medora", D1, NOW);
    await aggregateWindow("medora", "7d", W7, h.env);
    expect(perPage("medora").groups).toBeUndefined();
    expect(perPage("medora").counter.total.grouped_loads).toBe(50);
  });

  it("four named pages: nothing; a day not yet folded: nothing", async () => {
    for (const s of ["a", "b", "c", "d"]) loads("medora", D1, `/products/${s}`, 2);
    for (let i = 0; i < 5; i++) visit("medora", at(D1), ["/products/:item"]);
    await aggregateWindow("medora", "7d", W7, h.env);
    expect(perPage("medora").groups).toBeUndefined();
    await rebuildDay(h.d1, "medora", D1, NOW);
    await aggregateWindow("medora", "7d", W7, h.env);
    expect(perPage("medora").groups).toBeUndefined();
  });

  it("sensitiveGroupCounts: /:item and a section too deep for a pattern are never proposed", () => {
    expect(
      sensitiveGroupCounts(
        [
          { grp: "/:item", pages: 9 },
          { grp: "/a/b/c/:item", pages: 9 },
          { grp: "/products/:item", pages: 5 },
        ],
        [
          { day: D1, grp: "/products/:item", visits: 3 },
          { day: "2026-10-12", grp: "/products/:item", visits: 4 },
          { day: D1, grp: "/:item", visits: 9 },
        ],
      ),
    ).toEqual([{ pattern: "/products/*", pages: 5, visits: 7 }]);
  });
});

describe("a proposal read never costs a window", () => {
  /** Every statement runs except the named one, which fails the way D1 did. */
  function failing(sql: string): void {
    const prepare = h.d1.prepare.bind(h.d1);
    (h.d1 as { prepare: (s: string) => unknown }).prepare = (s: string) => {
      if (s === sql) throw new Error("out of memory: SQLITE_NOMEM [code: 7500]");
      return prepare(s);
    };
  }

  it("the proposals statement fails: the window is written without groups and one line is logged", async () => {
    fiveProducts();
    accept("acme", "/work/*");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    failing(GROUP_PROPOSALS_SQL);
    await aggregateWindow("acme", "7d", W7, h.env);
    const pp = perPage("acme");
    expect(pp.groups).toBeUndefined();
    expect(pp.without_versions.visits).toBe(5);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toBe(GROUPS_FAILED_LINE);
    expect(err.mock.calls[0][1]).toMatchObject({ customer: "acme", window: "7d" });
    err.mockRestore();
  });

  it("the accepted statement fails the same way", async () => {
    fiveProducts();
    accept("acme", "/work/*");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    failing(ACCEPTED_GROUP_COUNTS_SQL);
    await aggregateWindow("acme", "7d", W7, h.env);
    expect(perPage("acme").groups).toBeUndefined();
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toBe(GROUPS_FAILED_LINE);
    err.mockRestore();
  });
});

describe("the breakdown's pages.groups (N4.1)", () => {
  it("the accepted groups marked and first, then the proposals; without_versions counts every page", async () => {
    fiveProducts();
    fiveProducts("acme", "/blog");
    for (const s of ["a", "b"]) visit("acme", at(D1), [`/work/${s}`]);
    accept("acme", "/work/*");
    await aggregateWindow("acme", "7d", W7, h.env);
    const body = await breakdown("acme");
    const pages = body.pages as {
      pages: unknown[];
      without_versions: { pages: number; visits: number };
      groups: unknown[];
    };
    expect(pages.groups).toEqual([
      { pattern: "/work/*", pages: 2, visits: 2, accepted: true },
      { pattern: "/blog/*", pages: 5, visits: 5, accepted: false },
      { pattern: "/products/*", pages: 5, visits: 5, accepted: false },
    ]);
    // All twelve pages without versions, not the five the list shows.
    expect(pages.without_versions).toEqual({ pages: 12, visits: 12, signal_visits: 12 });
    expect(pages.pages.length).toBeLessThanOrEqual(5);
  });

  it("an accepted pattern the aggregator has not counted yet is listed at 0", async () => {
    visit("acme", at(D1), ["/"]);
    await aggregateWindow("acme", "7d", W7, h.env);
    accept("acme", "/products/*");
    const body = await breakdown("acme");
    expect((body.pages as { groups: unknown[] }).groups).toEqual([
      { pattern: "/products/*", pages: 0, visits: 0, accepted: true },
    ]);
  });

  it("a missing page_groups table (migration 0043 not applied) is no groups: the aggregator writes and the breakdown answers", async () => {
    h.db.exec("DROP TABLE page_groups");
    fiveProducts();
    await aggregateWindow("acme", "7d", W7, h.env);
    expect(perPage("acme").groups).toEqual([{ pattern: "/products/*", pages: 5, visits: 5 }]);
    const body = await breakdown("acme");
    expect((body.pages as { groups: unknown[] }).groups).toEqual([
      { pattern: "/products/*", pages: 5, visits: 5, accepted: false },
    ]);
  });

  it("a customer without groups or proposals has no groups field", async () => {
    visit("acme", at(D1), ["/"]);
    await aggregateWindow("acme", "7d", W7, h.env);
    const body = await breakdown("acme");
    expect(Object.keys(body.pages as object)).toEqual(["pages", "without_versions"]);
    expect(breakdownGroups(undefined, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The second line (proof-engine.md option 3; privacy review condition 8)
// ---------------------------------------------------------------------------

describe("the second line's class, on real rows", () => {
  const T = at(D1);
  const PRODUCT = "/products/chair";

  beforeEach(() => {
    confirm("acme", "/");
    h.db
      .prepare(
        "INSERT INTO version_bodies (body_id, customer_id, page_path, intent_dim, source_dim, model, prompt_hash, body_json, live_from) VALUES (?, 'acme', '/', 'problem', 'ai', 'm', 'p', '{}', 1)",
      )
      .run(ROOT_BODY);
    h.db
      .prepare(
        "INSERT INTO holdout_tests (id, customer_id, percent, started_at, ended_at, created_at) VALUES ('ht', 'acme', 20, ?, NULL, ?)",
      )
      .run(NOW - 3 * DAY, NOW - 3 * DAY);
  });

  function armed(
    arm: "treat" | "holdout",
    page: string,
    i: number,
    type: "variant_shown" | "personalization_skipped" = "variant_shown",
  ): string {
    const v = vid(++n);
    h.ev({
      ts: T + i,
      type,
      visit: v,
      arm,
      cohort: arm === "holdout" ? "holdout" : type === "variant_shown" ? "personalized" : "skipped",
      page,
      body: ROOT_BODY,
    });
    return v;
  }

  it("a visit is in the class when its first armed exposure was on a page with versions of its own; a click on a group page counts for its arm in both lines", async () => {
    // Treat on /, then a group page three pages later where the counted button is clicked.
    const a = armed("treat", "/", 1);
    h.ev({
      ts: T + 2_000,
      type: "personalization_skipped",
      visit: a,
      arm: "treat",
      cohort: "skipped",
      page: "/products/x",
      body: ROOT_BODY,
    });
    h.ev({
      ts: T + 3_000,
      type: "personalization_skipped",
      visit: a,
      arm: "treat",
      cohort: "skipped",
      page: "/products/y",
      body: ROOT_BODY,
    });
    h.ev({ ts: T + 4_000, type: "conversion", visit: a, page: "/products/y", label: "Əlaqə" });
    // Holdout on /, clicking on a product page too.
    const b = armed("holdout", "/", 2);
    h.ev({ ts: T + 5_000, type: "conversion", visit: b, page: "/products/z", label: "Əlaqə" });
    // Treat landing on a product page (the root's body tried there), clicking on /: headline only.
    const c = armed("treat", PRODUCT, 3, "personalization_skipped");
    h.ev({
      ts: T + 6_000,
      type: "variant_shown",
      visit: c,
      arm: "treat",
      cohort: "personalized",
      page: "/",
      body: ROOT_BODY,
    });
    h.ev({ ts: T + 7_000, type: "conversion", visit: c, page: "/", label: "Əlaqə" });
    // Holdout on a product page, no click.
    armed("holdout", PRODUCT, 4);

    // The rollup keys nothing to a confirmed page: the click's page is not read.
    const { rows } = await computeDay(h.d1, "acme", D1);
    const row = (arm: string, page: string) =>
      rows.find((r) => r.arm === arm && r.page_path === page);
    expect(row("treat", "/")).toMatchObject({ visits: 1, converting_visits: 1 });
    expect(row("holdout", "/")).toMatchObject({ visits: 1, converting_visits: 1 });
    expect(row("treat", PRODUCT)).toMatchObject({ visits: 1, converting_visits: 1 });
    expect(row("holdout", PRODUCT)).toMatchObject({ visits: 1, converting_visits: 0 });
    expect(await armTotals(h.d1, "acme", T - HOUR, T + HOUR)).toEqual({
      treat: { visits: 2, conversions: 2 },
      holdout: { visits: 2, conversions: 1 },
    });

    await rebuildDay(h.d1, "acme", D1, NOW);
    const input = await loadReportInput(h.d1, "acme", NOW, true);
    // The class: the two visits whose first armed exposure was on /.
    expect(input.ownOutcomes).toEqual([
      { day: D1, arm: "holdout", visits: 1, converting_visits: 1 },
      { day: D1, arm: "treat", visits: 1, converting_visits: 1 },
    ]);
    const r = buildLiftReport(input);
    // The headline holds every armed visit; the second line the class.
    expect(r.arms).toMatchObject({
      treat: { visits: 2, converting_visits: 2 },
      holdout: { visits: 2, converting_visits: 1 },
    });
    expect(r.on_versioned).toMatchObject({
      treat: { visits: 1, converting_visits: 1, rate: null },
      holdout: { visits: 1, converting_visits: 1, rate: null },
      enough: false,
      lift: null,
      waits_for: "read_date",
    });
    expect(r.on_versioned?.sentence).toMatch(/^On pages that have versions: /);
    expect(r.on_versioned?.sentence).not.toMatch(NO_DASHES);
  });

  it("a row whose body is not the page's own, or has no body, is out of the class", async () => {
    armed("treat", PRODUCT, 1, "personalization_skipped");
    h.ev({
      ts: T + 2,
      type: "variant_shown",
      visit: vid(++n),
      arm: "treat",
      cohort: "personalized",
      page: "/",
      body: null,
    });
    await rebuildDay(h.d1, "acme", D1, NOW);
    expect((await loadReportInput(h.d1, "acme", NOW, true)).ownOutcomes).toEqual([]);
    expect((await loadLiftReport(h.d1, "acme", NOW, true)).on_versioned).toBeNull();
  });

  it("the class is read from exposure_outcomes and version_bodies only, never events, never a marker", async () => {
    const { OWN_PAGE_OUTCOMES_SQL } = await import("../../src/lib/proof-report.ts");
    expect(OWN_PAGE_OUTCOMES_SQL).not.toMatch(/\bevents\b/);
    expect(OWN_PAGE_OUTCOMES_SQL).not.toMatch(/\bvisit\b|\bmarker\b/);
    expect(OWN_PAGE_OUTCOMES_SQL).toMatch(
      /FROM exposure_outcomes o\s+JOIN version_bodies b ON b\.customer_id = o\.customer_id/,
    );
  });
});

describe("the second line's gate and read date (never interim)", () => {
  const RNOW = Date.parse("2026-11-20T12:00:00Z");
  const day = (k: number) => new Date(RNOW - k * DAY).toISOString().slice(0, 10);
  function test(over: Partial<TestRow> = {}): TestRow {
    return {
      id: "ht1",
      customer_id: "acme",
      percent: 20,
      started_at: dayStart(day(70)),
      ended_at: null,
      read_date: null,
      read_fixed_at: null,
      ...over,
    };
  }
  const READ_TEST = test({ read_date: day(0), read_fixed_at: 1 });
  const RUNNING_TEST = test({
    started_at: dayStart(day(25)),
    read_date: day(-40),
    read_fixed_at: 1,
  });
  function days(
    fromAgo: number,
    toAgo: number,
    d: { tv: number; tc: number; hv: number; hc: number },
  ) {
    const out: OutcomeLite[] = [];
    const own: OwnPageLite[] = [];
    for (let k = fromAgo; k >= toAgo; k--) {
      const base = { day: day(k), source_dim: "ai", signal: 1 };
      out.push({
        ...base,
        arm: "treat",
        visits: d.tv,
        converting_visits: d.tc,
        applied_visits: d.tv,
        applied_converting_visits: d.tc,
      });
      out.push({
        ...base,
        arm: "holdout",
        visits: d.hv,
        converting_visits: d.hc,
        applied_visits: 0,
        applied_converting_visits: 0,
      });
      // A third of each arm is the class, with every click: the dilution of option 3's note.
      own.push({
        day: day(k),
        arm: "treat",
        visits: Math.round(d.tv / 3),
        converting_visits: d.tc,
      });
      own.push({
        day: day(k),
        arm: "holdout",
        visits: Math.round(d.hv / 3),
        converting_visits: d.hc,
      });
    }
    return { out, own };
  }
  function input(over: Partial<ReportInput> = {}): ReportInput {
    return {
      customerId: "acme",
      now: RNOW,
      superadmin: false,
      tests: [READ_TEST],
      outcomes: [],
      mixedByDay: {},
      labels: ["Start free"],
      ...over,
    };
  }
  const CLEAR = { tv: 160, tc: 16, hv: 40, hc: 3 };

  it("before the read date: counts and 'Compared on the read date', no lift, however clear the numbers", () => {
    const { out, own } = days(25, 1, CLEAR);
    const r = buildLiftReport(input({ tests: [RUNNING_TEST], outcomes: out, ownOutcomes: own }));
    expect(r.state).toBe("interim");
    expect(r.lift?.interim).toBe(true);
    expect(r.on_versioned).toMatchObject({ enough: true, lift: null, waits_for: "read_date" });
    expect(r.on_versioned?.sentence).toContain("Compared on the read date.");
    expect(JSON.stringify(r.on_versioned)).not.toMatch(/interim|directional/);
  });

  it("on the read date: its own lift, past its own gate, and the headline does not move", () => {
    const { out, own } = days(70, 1, CLEAR);
    const withLine = buildLiftReport(input({ outcomes: out, ownOutcomes: own }));
    const without = buildLiftReport(input({ outcomes: out }));
    expect(withLine.state).toBe("result");
    expect(withLine.on_versioned?.lift).not.toBeNull();
    expect(withLine.on_versioned?.waits_for).toBeNull();
    // The class's own rates: every click over a third of the visits.
    expect(withLine.on_versioned?.treat.rate).toBeCloseTo(16 / 53, 6);
    expect(withLine.on_versioned?.holdout.rate).toBeCloseTo(3 / 13, 6);
    expect(withLine.on_versioned?.lift?.value).toBeCloseTo(16 / 53 / (3 / 13) - 1, 6);
    expect(withLine.on_versioned?.sentence).toMatch(
      /^On pages that have versions: [+-]\d+% \(range /,
    );
    expect(without.on_versioned).toBeNull();
    expect(withLine.arms).toEqual(without.arms);
    expect(withLine.lift).toEqual(without.lift);
    expect(withLine.verdict).toBe(without.verdict);
    expect(withLine.sentence).toBe(without.sentence);
  });

  it("on the read date under the gate: counts only, 'clicks'", () => {
    const { out } = days(70, 1, CLEAR);
    const own: OwnPageLite[] = [
      { day: day(1), arm: "treat", visits: 200, converting_visits: 9 },
      { day: day(1), arm: "holdout", visits: 50, converting_visits: 10 },
    ];
    const r = buildLiftReport(input({ outcomes: out, ownOutcomes: own }));
    expect(r.on_versioned).toMatchObject({
      enough: false,
      lift: null,
      waits_for: "clicks",
      treat: { rate: null },
    });
    expect(r.on_versioned?.sentence).toContain(
      "A range needs 30 visits and 10 clicks in each group.",
    );
  });

  it("held back, ended early and no test: no lift on the line either", () => {
    const { out, own } = days(70, 1, CLEAR);
    const early = buildLiftReport(
      input({ tests: [test({ ended_at: RNOW - 10 * DAY })], outcomes: out, ownOutcomes: own }),
    );
    expect(early.state).toBe("ended_early");
    expect(early.on_versioned).toMatchObject({ lift: null, waits_for: "ended_early" });
    expect(buildLiftReport(input({ tests: [], ownOutcomes: own })).on_versioned).toBeNull();
  });

  it("the limits line says what the headline covers as built", () => {
    expect(LIMITS_LINE).not.toContain("a written version");
    expect(LIMITS_LINE).toContain("on pages without versions of their own too");
    expect(LIMITS_LINE).not.toMatch(NO_DASHES);
    expect(buildLiftReport(input()).limits).toBe(LIMITS_LINE);
  });
});
