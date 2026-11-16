/**
 * The counting side of a sensitive customer (docs/specs/sensitive-customers.md),
 * on real SQL (node:sqlite, every migration):
 *
 * - the stored-path rule in SQL gives the answers of the shared `storedPath`;
 * - the daily rollup folds page_days (a group with fewer than three distinct
 *   pages that day), once, idempotently, and names the stored path in
 *   exposure_outcomes;
 * - no read returns the current day, or a day before its fold has run;
 * - per_page shows `/`, the kept sections and groups for the marker counts,
 *   and the counter for per-page loads and the pages without versions;
 * - page_days meets nothing but a customer and a day, never a marker;
 * - a customer that is not sensitive: the statements and the stored values
 *   it always had.
 */
import { FOLD_MIN_VISITS, foldDay, maskPath, storedPath } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAnalyticsBreakdown } from "../../src/admin/analytics.ts";
import type { AdminEnv } from "../../src/admin/handlers.ts";
import {
  ACCEPTED_GROUP_COUNTS_SQL,
  GROUP_PROPOSALS_SQL,
  GROUP_VISITS_SELECT,
  GROUP_VISITS_SQL,
  PAGES_WITHOUT_VERSIONS_SQL,
  PAGE_ROWS_SQL,
  SENSITIVE_PAGES_WITHOUT_VERSIONS_SQL,
  SENSITIVE_PAGE_ROWS_SQL,
  aggregateWindow,
  aggregateWindowAt,
  groupVisits,
} from "../../src/cron/analytics-aggregator.ts";
import {
  ROLLUP_EVENT_QUERIES,
  computeDay,
  dayOf,
  dayStart,
  rebuildDay,
  runExposureRollup,
} from "../../src/cron/exposure-rollup.ts";
import { GROUP_PAGE_EVENTS_SQL } from "../../src/lib/group-page.ts";
import { OWN_PAGE_OUTCOMES_SQL } from "../../src/lib/proof-report.ts";
import {
  D1_STATEMENT_CHARS_MAX,
  PAGE_DAYS_QUERIES,
  counterDays,
  keptCteSql,
  normPathSql,
  storedPathSql,
} from "../../src/lib/sensitive-pages.ts";
import { aggregateCustomerIssues } from "../../src/lib/snippet-issues.ts";
import { DAY, HOUR, type Harness, harness, vid } from "../proof-harness.ts";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const TODAY = "2026-10-14";
const D1 = "2026-10-13";
const D2 = "2026-10-12";
const W7 = 7 * DAY;
const KEPT = ["/about", "/products"];

let h: Harness;
let n = 0;

beforeEach(() => {
  h = harness();
  h.customer("medora");
  h.customer("acme");
  h.db
    .prepare("UPDATE customers SET sensitive = 1, kept_sections = ? WHERE id = 'medora'")
    .run(JSON.stringify(KEPT));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  n = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const at = (day: string, hour = 10) => dayStart(day) + hour * HOUR;

/** One visit of `customer`: its pages as exposure rows under one marker. */
function visit(
  customer: string,
  ts: number,
  pages: string[],
  o: { type?: "variant_shown" | "personalization_skipped" | "no_signal_passthrough" } = {},
): void {
  const marker = vid(++n);
  const type = o.type ?? "variant_shown";
  const cohort =
    type === "no_signal_passthrough"
      ? "no_signal"
      : type === "personalization_skipped"
        ? "skipped"
        : "personalized";
  for (const [i, page] of pages.entries()) {
    h.ev({ customer, ts: ts + i * 1000, type, visit: marker, cohort, page });
  }
}

function loads(customer: string, day: string, path: string, count: number): void {
  h.db
    .prepare("INSERT INTO page_days (customer_id, day, page_path, loads) VALUES (?, ?, ?, ?)")
    .run(customer, day, path, count);
}

const pageDays = (customer = "medora", day?: string) =>
  h.db
    .prepare(
      `SELECT day, page_path, loads FROM page_days WHERE customer_id = ?
       ${day ? "AND day = ?" : ""} ORDER BY day, page_path`,
    )
    .all(...(day ? [customer, day] : [customer])) as Array<{
    day: string;
    page_path: string;
    loads: number;
  }>;

function perPage(customer: string, window: string) {
  const row = h.db
    .prepare(
      "SELECT per_page FROM analytics_aggregates WHERE customer_id = ? AND window = ? ORDER BY computed_at DESC LIMIT 1",
    )
    .get(customer, window) as { per_page: string };
  return JSON.parse(row.per_page);
}

function confirm(customer: string, page: string): void {
  h.db
    .prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at) VALUES (?, ?, '{}', 'https://x.test', 1, 1)",
    )
    .run(customer, page);
}

// ---------------------------------------------------------------------------

describe("the stored-path rule in SQL is the shared storedPath", () => {
  const sql = `WITH ${keptCteSql("?2")} SELECT ${storedPathSql(normPathSql("?1"))} AS stored`;
  const stored = (path: string | null, kept: string[]) =>
    (h.db.prepare(sql).get(path, JSON.stringify(kept)) as { stored: string }).stored;

  const PATHS = [
    "/",
    "",
    "/ginseng",
    "/products",
    "/products/",
    "/Products",
    "/PRODUCTS/Ginseng/",
    "/products/ginseng",
    "/products/ginseng/reviews",
    "/products//ginseng",
    "/products///x//y/",
    "/productsale",
    "/productsale/x",
    "/products-new",
    "/about",
    "/about/team",
    "/category/liver",
    "/products/new",
    "/products/new/omega",
    "/products/:item",
    "/:item",
    "/products/:id",
    "/blog/a/b/c/d",
    "/m%C9%99hsullar/x",
    "/a_b",
    "/a%b",
  ];
  const LISTS = [
    [],
    ["/products"],
    KEPT,
    ["/products", "/products/new"],
    ["/products/new", "/products"],
    ["/a", "/about", "/blog/a", "/blog/a/b", "/m%c9%99hsullar"],
  ];

  it("gives the same answer for every path and list of the fixture", () => {
    for (const kept of LISTS) {
      for (const p of PATHS) {
        expect(stored(p, kept), `${p} with ${JSON.stringify(kept)}`).toBe(
          storedPath(maskPath(p), kept),
        );
      }
    }
  });

  it("the privacy review's cases, in SQL", () => {
    expect(stored("/ginseng", KEPT)).toBe("/:item");
    expect(stored("/products/ginseng/reviews", ["/products"])).toBe("/products/:item");
    expect(stored("/products", ["/products"])).toBe("/products");
    expect(stored("/", ["/products"])).toBe("/");
    expect(stored("/category/liver", [])).toBe("/:item");
    expect(stored("/products/new/omega", ["/products", "/products/new"])).toBe(
      "/products/new/:item",
    );
    expect(stored(null, KEPT)).toBe("/");
  });

  it("where SQL and the function could differ, SQL keeps less, never more", () => {
    // No leading slash, a run of more than eight slashes, a letter SQLite
    // does not lowercase: none matches a kept section.
    expect(stored("products", KEPT)).toBe("/:item");
    expect(stored("//////////products", KEPT)).toBe("/:item");
    expect(stored("/ÜRÜNLER", ["/ürünler"])).toBe("/:item");
  });
});

describe("the daily fold in the rollup (condition 4)", () => {
  beforeEach(() => {
    loads("medora", D1, "/", 12);
    loads("medora", D1, "/products", 5);
    loads("medora", D1, "/products/ginseng", 3);
    loads("medora", D1, "/products/omega", 2);
    loads("medora", D1, "/ginseng", 4);
    loads("medora", D1, "/about/team", 1);
    // A day with three product pages and six visits behind them: kept as it is.
    loads("medora", D2, "/products/a", 1);
    loads("medora", D2, "/products/b", 2);
    loads("medora", D2, "/products/c", 3);
    loads("medora", D2, "/category/liver", 6);
    for (let i = 0; i < 6; i++) visit("medora", at(D2), ["/products/:item"]);
  });

  it("folds a group with fewer than three distinct pages that day, and no other row", async () => {
    await rebuildDay(h.d1, "medora", D1, NOW);
    await rebuildDay(h.d1, "medora", D2, NOW);
    expect(pageDays("medora", D1)).toEqual([
      { day: D1, page_path: "/", loads: 12 },
      { day: D1, page_path: "/:item", loads: 4 },
      { day: D1, page_path: "/about/:item", loads: 1 },
      { day: D1, page_path: "/products", loads: 5 },
      { day: D1, page_path: "/products/:item", loads: 5 },
    ]);
    expect(pageDays("medora", D2)).toEqual([
      { day: D2, page_path: "/:item", loads: 6 },
      { day: D2, page_path: "/products/a", loads: 1 },
      { day: D2, page_path: "/products/b", loads: 2 },
      { day: D2, page_path: "/products/c", loads: 3 },
    ]);
  });

  it("is what the shared foldDay gives, and loses no load", async () => {
    const before = pageDays("medora", D1).map(({ page_path, loads }) => ({ page_path, loads }));
    await rebuildDay(h.d1, "medora", D1, NOW);
    const after = pageDays("medora", D1).map(({ page_path, loads }) => ({ page_path, loads }));
    expect(after).toEqual(foldDay(before, KEPT));
    const sum = (r: { loads: number }[]) => r.reduce((t, x) => t + x.loads, 0);
    expect(sum(after)).toBe(sum(before));
  });

  it("is idempotent: a second rebuild changes nothing", async () => {
    await rebuildDay(h.d1, "medora", D1, NOW);
    const once = pageDays();
    await rebuildDay(h.d1, "medora", D1, NOW + HOUR);
    await rebuildDay(h.d1, "medora", D1, NOW + 2 * HOUR);
    expect(pageDays()).toEqual(once);
  });

  it("a load that landed after the fold joins its group at the next run", async () => {
    await rebuildDay(h.d1, "medora", D1, NOW);
    loads("medora", D1, "/products/late", 1);
    await rebuildDay(h.d1, "medora", D1, NOW + HOUR);
    expect(pageDays("medora", D1).find((r) => r.page_path === "/products/:item")?.loads).toBe(6);
    expect(pageDays("medora", D1).some((r) => r.page_path === "/products/late")).toBe(false);
  });

  it("never folds an open day: the rollup refuses it", async () => {
    loads("medora", TODAY, "/products/ginseng", 1);
    expect(await rebuildDay(h.d1, "medora", TODAY, NOW)).toEqual({
      rebuilt: false,
      reason: "open",
    });
    expect(pageDays("medora", TODAY)).toEqual([
      { day: TODAY, page_path: "/products/ginseng", loads: 1 },
    ]);
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM exposure_rollup_days WHERE day = ?").get(TODAY),
    ).toEqual({ n: 0 });
  });

  it("records the day in the batch that folds it", async () => {
    await rebuildDay(h.d1, "medora", D1, NOW);
    expect(
      h.db
        .prepare("SELECT day FROM exposure_rollup_days WHERE customer_id = 'medora' ORDER BY day")
        .all(),
    ).toEqual([{ day: D1 }]);
  });

  it("the hourly rollup folds the last three closed days, and a paused sensitive customer too", async () => {
    h.customer("paused");
    h.db.prepare("UPDATE customers SET sensitive = 1, status = 'paused' WHERE id = 'paused'").run();
    loads("paused", D1, "/products/ginseng", 2);
    const r = await runExposureRollup(h.env, NOW);
    expect(r.errors).toBe(0);
    expect(pageDays("medora", D1).some((x) => x.page_path === "/products/ginseng")).toBe(false);
    // An empty list: every page but / is in the one group.
    expect(pageDays("paused")).toEqual([{ day: D1, page_path: "/:item", loads: 2 }]);
  });

  it("a customer that is not sensitive: its rows, if it had any, are left alone", async () => {
    loads("acme", D1, "/products/ginseng", 3);
    await rebuildDay(h.d1, "acme", D1, NOW);
    expect(pageDays("acme")).toEqual([{ day: D1, page_path: "/products/ginseng", loads: 3 }]);
  });
});

describe("the fold's second floor: three pages do not hide one visit", () => {
  const product = (i: number) => `/products/p${"abcdefghij"[i]}`;
  /** `pages` product pages with one load each in the counter of D1. */
  function counted(pages: number): void {
    for (let i = 0; i < pages; i++) loads("medora", D1, product(i), 1);
  }
  /** One visit that loaded `pages` product pages, as the edge stores it. */
  const group = (pages: number) => Array.from({ length: pages }, () => "/products/:item");

  it("one visit, three product pages on a day: the day keeps only /products/:item", async () => {
    counted(3);
    visit("medora", at(D1), group(3));
    await rebuildDay(h.d1, "medora", D1, NOW);
    expect(pageDays("medora", D1)).toEqual([{ day: D1, page_path: "/products/:item", loads: 3 }]);
  });

  it("five visits over three pages stays unfolded", async () => {
    expect(FOLD_MIN_VISITS).toBe(5);
    counted(3);
    for (let i = 0; i < 5; i++) visit("medora", at(D1), group(1));
    await rebuildDay(h.d1, "medora", D1, NOW);
    expect(pageDays("medora", D1).map((r) => r.page_path)).toEqual([0, 1, 2].map(product));
  });

  it("four visits over ten pages folds", async () => {
    counted(10);
    for (let i = 0; i < 4; i++) visit("medora", at(D1), group(3));
    await rebuildDay(h.d1, "medora", D1, NOW);
    expect(pageDays("medora", D1)).toEqual([{ day: D1, page_path: "/products/:item", loads: 10 }]);
  });

  it("counts the visits of the group and day only: another day, another group or another customer does not help", async () => {
    counted(3);
    visit("medora", at(D1), group(1));
    for (let i = 0; i < 9; i++) visit("medora", at(D2), group(1));
    for (let i = 0; i < 9; i++) visit("medora", at(D1), ["/:item"]);
    for (let i = 0; i < 9; i++) visit("medora", at(D1), ["/products"]);
    for (let i = 0; i < 9; i++) visit("acme", at(D1), ["/products/:item"]);
    await rebuildDay(h.d1, "medora", D1, NOW);
    expect(pageDays("medora", D1)).toEqual([{ day: D1, page_path: "/products/:item", loads: 3 }]);
  });

  it("a row from before the customer was marked counts under its group", async () => {
    counted(3);
    // Product pages as sent, each its own visit: five visits behind the group.
    for (const p of [
      "/products/pa",
      "/Products/Pb/",
      "/products/pc",
      "/products/pa",
      "/products/x/y",
    ]) {
      visit("medora", at(D1), [p]);
    }
    expect(await groupVisits(h.d1, "medora", dayStart(D1), dayStart(D1) + DAY, KEPT)).toEqual([
      { day: D1, grp: "/products/:item", visits: 5 },
    ]);
    await rebuildDay(h.d1, "medora", D1, NOW);
    expect(pageDays("medora", D1)).toHaveLength(3);
  });

  it("a snippet issue and a click are not visits; a load without a marker is one", async () => {
    counted(3);
    for (let i = 0; i < 4; i++) visit("medora", at(D1), group(1));
    // A site with its tag at the end reports an issue on every load, without a marker.
    for (let i = 0; i < 6; i++) {
      h.ev({
        customer: "medora",
        ts: at(D1),
        type: "snippet_issue" as never,
        page: "/products/:item",
        intent: null,
        source: null,
        body: null,
        props: { issues: [{ c: "late_tag" }] },
      });
    }
    h.ev({
      customer: "medora",
      ts: at(D1),
      type: "conversion",
      visit: vid(900),
      page: "/products/:item",
    });
    const behind = () => groupVisits(h.d1, "medora", dayStart(D1), dayStart(D1) + DAY, KEPT);
    expect(await behind()).toEqual([{ day: D1, grp: "/products/:item", visits: 4 }]);
    // Storage blocked: the load has no marker and counts by itself, as everywhere.
    h.ev({
      customer: "medora",
      ts: at(D1),
      type: "no_signal_passthrough",
      visit: null,
      page: "/products/:item",
    });
    expect(await behind()).toEqual([{ day: D1, grp: "/products/:item", visits: 5 }]);
  });

  it("a fold never unfolds: once folded, more visits or lost markers change nothing", async () => {
    counted(3);
    visit("medora", at(D1), group(3));
    await rebuildDay(h.d1, "medora", D1, NOW);
    const folded = pageDays("medora", D1);
    expect(folded).toEqual([{ day: D1, page_path: "/products/:item", loads: 3 }]);
    // The markers go (31 days): every row now counts by itself.
    h.db.prepare("UPDATE events SET visit = NULL WHERE customer_id = 'medora'").run();
    for (let i = 0; i < 9; i++) visit("medora", at(D1), group(1));
    await rebuildDay(h.d1, "medora", D1, NOW + HOUR);
    expect(pageDays("medora", D1)).toEqual(folded);
    await aggregateWindow("medora", "7d", W7, h.env);
    expect(perPage("medora", "7d").counter.pages).toEqual([
      { page_path: "/products/:item", loads: 3, has_versions: false, group: true },
    ]);
  });

  it("a day too old to rebuild is left as its fold left it", async () => {
    const old = dayOf(NOW - 40 * DAY);
    loads("medora", old, "/products/:item", 3);
    expect(await rebuildDay(h.d1, "medora", old, NOW)).toEqual({
      rebuilt: false,
      reason: "too_old",
    });
    expect(pageDays("medora", old)).toEqual([{ day: old, page_path: "/products/:item", loads: 3 }]);
  });

  it("the count is all that leaves: a day, a group and a number, and no marker in page_days", async () => {
    counted(3);
    for (let i = 0; i < 5; i++) visit("medora", at(D1), group(1));
    const rows = h.db
      .prepare(GROUP_VISITS_SQL)
      .all("medora", dayStart(D1), dayStart(D1) + DAY, JSON.stringify(KEPT)) as Array<
      Record<string, unknown>
    >;
    expect(rows.map((r) => Object.keys(r))).toEqual([["day", "grp", "visits"]]);
    // The marker is named once, inside the count, and nowhere else.
    const without = GROUP_VISITS_SELECT.replace("COUNT(DISTINCT COALESCE(visit, id))", "");
    expect(without).not.toMatch(/\bvisit\b/);
    expect(GROUP_VISITS_SELECT).toMatch(/FROM events\s+WHERE customer_id = \?1/);
    expect(GROUP_VISITS_SQL).not.toContain("page_days");
    await rebuildDay(h.d1, "medora", D1, NOW);
    expect(JSON.stringify(pageDays())).not.toMatch(/[0-9a-f]{32}/);
  });

  it("the read holds both floors too: a day recorded without the visit floor is not shown by page", async () => {
    // Folded by an older rollup that knew only the page floor: three named
    // pages, the day recorded, two visits behind them.
    counted(3);
    visit("medora", at(D1), group(2));
    visit("medora", at(D1), group(1));
    h.db
      .prepare(
        "INSERT INTO exposure_rollup_days (customer_id, day, computed_at, mixed_visits) VALUES ('medora', ?, 1, 0)",
      )
      .run(D1);
    await aggregateWindow("medora", "7d", W7, h.env);
    expect(perPage("medora", "7d").counter.pages).toEqual([
      { page_path: "/products/:item", loads: 3, has_versions: false, group: true },
    ]);
    expect(perPage("medora", "7d").without_versions.pages).toBe(0);
    // Five visits behind them: the pages are named.
    for (let i = 0; i < 3; i++) visit("medora", at(D1), group(1));
    await aggregateWindow("medora", "7d", W7, h.env);
    expect(
      perPage("medora", "7d").counter.pages.map((p: { page_path: string }) => p.page_path),
    ).toEqual([0, 1, 2].map(product));
  });
});

describe("exposure_outcomes names the stored path", () => {
  it("a sensitive customer's rows hold /, a kept section or a group, whatever the events hold", async () => {
    // Rows from before the customer was marked: product pages as sent.
    visit("medora", at(D1), ["/products/ginseng"]);
    visit("medora", at(D1), ["/Products/Omega/"]);
    visit("medora", at(D1), ["/products"]);
    visit("medora", at(D1), ["/ginseng"]);
    visit("medora", at(D1), ["/"]);
    await rebuildDay(h.d1, "medora", D1, NOW);
    const rows = h.db
      .prepare(
        "SELECT page_path, SUM(visits) AS visits FROM exposure_outcomes WHERE customer_id = 'medora' GROUP BY page_path ORDER BY page_path",
      )
      .all();
    expect(rows).toEqual([
      { page_path: "/", visits: 1 },
      { page_path: "/:item", visits: 1 },
      { page_path: "/products", visits: 1 },
      { page_path: "/products/:item", visits: 2 },
    ]);
  });

  it("computeDay without a list is what it was: the masked path", async () => {
    visit("acme", at(D1), ["/products/ginseng"]);
    visit("acme", at(D1), ["/Products/Omega/"]);
    const { rows } = await computeDay(h.d1, "acme", D1);
    expect(rows.map((r) => r.page_path).sort()).toEqual(["/Products/Omega/", "/products/ginseng"]);
    await rebuildDay(h.d1, "acme", D1, NOW);
    expect(
      h.db
        .prepare(
          "SELECT page_path FROM exposure_outcomes WHERE customer_id = 'acme' ORDER BY page_path",
        )
        .all(),
    ).toEqual([{ page_path: "/Products/Omega/" }, { page_path: "/products/ginseng" }]);
  });
});

describe("per_page for a sensitive customer", () => {
  function week(): void {
    // Marker rows as the edge stores them once the customer is marked.
    for (let i = 0; i < 6; i++) visit("medora", at(D1), ["/"]);
    for (let i = 0; i < 5; i++) visit("medora", at(D1), ["/products"]);
    // Seven visits across product pages; two of them opened two products.
    for (let i = 0; i < 5; i++) visit("medora", at(D1), ["/products/:item"]);
    visit("medora", at(D1), ["/products/:item", "/products/:item"]);
    visit("medora", at(D1), ["/products/:item", "/products/:item"], {
      type: "personalization_skipped",
    });
    for (let i = 0; i < 5; i++)
      visit("medora", at(D1), ["/:item"], { type: "no_signal_passthrough" });
    // The counter, two closed days and today.
    loads("medora", D1, "/", 6);
    loads("medora", D1, "/products", 5);
    loads("medora", D1, "/products/ginseng", 4);
    loads("medora", D1, "/products/omega", 3);
    loads("medora", D1, "/products/zinc", 2);
    loads("medora", D1, "/ginseng", 5);
    loads("medora", D2, "/products/ginseng", 7);
    loads("medora", D2, "/", 1);
    loads("medora", TODAY, "/products/today-only", 9);
  }

  it("the marker counts show /, kept sections and groups; a group says so and has no late-tag count", async () => {
    confirm("medora", "/");
    week();
    await rebuildDay(h.d1, "medora", D1, NOW);
    await aggregateWindow("medora", "7d", W7, h.env);
    const pp = perPage("medora", "7d");
    expect(pp.pages).toEqual([
      {
        page_path: "/products/:item",
        visits: 7,
        signal_visits: 7,
        written_visits: 6,
        skipped_visits: 1,
        has_versions: false,
        group: true,
      },
      {
        page_path: "/",
        visits: 6,
        signal_visits: 6,
        written_visits: 6,
        skipped_visits: 0,
        lp_visits: 0,
        has_versions: true,
      },
      {
        page_path: "/products",
        visits: 5,
        signal_visits: 5,
        written_visits: 5,
        skipped_visits: 0,
        lp_visits: 0,
        has_versions: false,
      },
      {
        page_path: "/:item",
        visits: 5,
        signal_visits: 0,
        written_visits: 0,
        skipped_visits: 0,
        has_versions: false,
        group: true,
      },
    ]);
  });

  it("groups inside the query: rows from before the customer was marked never name a page, and a visit counts once in its group", async () => {
    // Raw product paths beside markers, as the pilot's rows are before the rewrite.
    for (const p of ["ginseng", "omega", "zinc", "iron", "b12"]) {
      visit("medora", at(D1), [`/products/${p}`]);
    }
    visit("medora", at(D1), ["/products/ginseng", "/Products/Omega/", "/products/zinc"]);
    for (let i = 0; i < 5; i++) visit("medora", at(D1), ["/ginseng"]);
    await aggregateWindow("medora", "7d", W7, h.env);
    const pp = perPage("medora", "7d");
    expect(
      pp.pages.map((p: { page_path: string; visits: number }) => [p.page_path, p.visits]),
    ).toEqual([
      ["/products/:item", 6],
      ["/:item", 5],
    ]);
    expect(JSON.stringify(pp)).not.toMatch(/ginseng|omega|zinc|iron|b12/i);
    // Pages without versions, in visits: the eleven visits, each once.
    expect(pp.without_versions.visits).toBe(11);
  });

  it("the counter: closed and folded days only, never today, never a day whose fold has not run", async () => {
    confirm("medora", "/");
    week();
    // Only D1 has been rolled up: D2's rows are there and not yet folded.
    await rebuildDay(h.d1, "medora", D1, NOW);
    await aggregateWindow("medora", "7d", W7, h.env);
    let c = perPage("medora", "7d").counter;
    expect(c).toEqual({
      from: "2026-10-07",
      to: D1,
      days: 1,
      pages: [
        { page_path: "/", loads: 6, has_versions: true },
        { page_path: "/:item", loads: 5, has_versions: false, group: true },
        { page_path: "/products", loads: 5, has_versions: false },
        { page_path: "/products/ginseng", loads: 4, has_versions: false },
        { page_path: "/products/omega", loads: 3, has_versions: false },
        { page_path: "/products/zinc", loads: 2, has_versions: false },
      ],
      total: { pages: 5, loads: 25, grouped_loads: 5 },
      without_versions: { pages: 4, loads: 19, grouped_loads: 5 },
    });
    expect(JSON.stringify(c)).not.toContain("today-only");

    // D2 rolled up: its one product page is a group of one, folded.
    await rebuildDay(h.d1, "medora", D2, NOW);
    await aggregateWindow("medora", "7d", W7, h.env);
    c = perPage("medora", "7d").counter;
    expect(c.days).toBe(2);
    expect(
      c.pages.find((p: { page_path: string }) => p.page_path === "/products/ginseng").loads,
    ).toBe(4);
    expect(c.pages.find((p: { page_path: string }) => p.page_path === "/products/:item")).toEqual({
      page_path: "/products/:item",
      loads: 7,
      has_versions: false,
      group: true,
    });
    expect(c.total).toEqual({ pages: 5, loads: 33, grouped_loads: 12 });
    expect(JSON.stringify(c)).not.toContain("today-only");
  });

  it("pages with visits and no versions is read from the counter", async () => {
    confirm("medora", "/");
    week();
    await rebuildDay(h.d1, "medora", D1, NOW);
    await aggregateWindow("medora", "7d", W7, h.env);
    const pp = perPage("medora", "7d");
    // /products and three product pages, from the counter; the visits stay
    // marker counts over the stored paths (5 + 7 + 5).
    expect(pp.without_versions).toEqual({ pages: 4, visits: 17, signal_visits: 12 });
    expect(pp.without_versions.pages).toBe(pp.counter.without_versions.pages);
  });

  it("folds again when it reads: a row that landed after the fold, a section taken off the list", async () => {
    week();
    await rebuildDay(h.d1, "medora", D1, NOW);
    await rebuildDay(h.d1, "medora", D2, NOW);
    // After D2's fold a load lands under a named page: a group of one.
    loads("medora", D2, "/products/late", 1);
    // And /about leaves the list with one /about row already counted.
    loads("medora", D2, "/about", 2);
    h.db
      .prepare("UPDATE customers SET kept_sections = '[\"/products\"]' WHERE id = 'medora'")
      .run();
    await aggregateWindow("medora", "7d", W7, h.env);
    const c = perPage("medora", "7d").counter;
    const paths = c.pages.map((p: { page_path: string }) => p.page_path);
    expect(paths).not.toContain("/products/late");
    expect(paths).not.toContain("/about");
    // Stored as they landed: only the read folded.
    expect(pageDays("medora", D2).map((r) => r.page_path)).toContain("/products/late");
  });

  it("a period shorter than a day has no counter days; the 24-hour row has yesterday", async () => {
    week();
    await rebuildDay(h.d1, "medora", D1, NOW);
    await aggregateWindow("medora", "1h", HOUR, h.env);
    expect(perPage("medora", "1h").counter).toEqual({
      from: null,
      to: null,
      days: 0,
      pages: [],
      total: { pages: 0, loads: 0, grouped_loads: 0 },
      without_versions: { pages: 0, loads: 0, grouped_loads: 0 },
    });
    expect(perPage("medora", "1h").without_versions.pages).toBe(0);
    await aggregateWindow("medora", "24h", DAY, h.env);
    expect(perPage("medora", "24h").counter).toMatchObject({ from: D1, to: D1, days: 1 });
  });

  it("the backfill's window reads the same days by the same rule (the mirror)", async () => {
    week();
    await rebuildDay(h.d1, "medora", D1, NOW);
    // (2026-10-07T12:00, 2026-10-14T12:00], keyed by its start.
    await aggregateWindowAt("medora", "7d", W7, NOW - W7, h.env);
    const row = h.db
      .prepare(
        "SELECT per_page FROM analytics_aggregates WHERE customer_id = 'medora' AND window = '7d' AND window_start = ?",
      )
      .get(NOW - W7) as { per_page: string };
    await aggregateWindow("medora", "7d", W7, h.env);
    expect(JSON.parse(row.per_page)).toEqual(perPage("medora", "7d"));
  });

  it("the counter's days: closed days that end inside the period, never an open one", () => {
    expect(counterDays(HOUR, NOW - HOUR, NOW, NOW)).toBeNull();
    expect(counterDays(DAY, NOW - DAY, NOW, NOW)).toEqual({ from: D1, to: D1 });
    expect(counterDays(W7, NOW - W7, NOW, NOW)).toEqual({ from: "2026-10-07", to: D1 });
    // A backfilled window that ends in the future of the real clock stops at yesterday.
    expect(counterDays(W7, NOW - DAY, NOW + 6 * DAY, NOW)).toEqual({ from: D1, to: D1 });
    // Just after midnight nothing of a 24-hour period has closed but yesterday.
    const midnight = dayStart(TODAY) + 1;
    expect(counterDays(DAY, midnight - DAY, midnight, midnight)).toEqual({ from: D1, to: D1 });
    expect(dayOf(midnight)).toBe(TODAY);
  });

  it("the endpoint hands the block through as stored", async () => {
    week();
    await rebuildDay(h.d1, "medora", D1, NOW);
    await aggregateWindow("medora", "7d", W7, h.env);
    const env = { ...h.env, DASHBOARD_ORIGIN: "*" } as unknown as AdminEnv;
    const superadmin = { id: "u", email: "f@x.test", role: "superadmin", customer_id: null };
    const res = await handleAnalyticsBreakdown(
      new Request("https://api.test/x?customer_id=medora&window=7d"),
      env,
      superadmin as never,
    );
    const body = (await res.json()) as { pages: Record<string, unknown> };
    expect(body.pages).toEqual(perPage("medora", "7d"));
    expect(body.pages.counter).toBeDefined();
  });
});

describe("snippet issues for a sensitive customer", () => {
  function issue(customer: string, page: string, code: string): void {
    h.ev({
      customer,
      ts: NOW - HOUR,
      type: "snippet_issue" as never,
      page,
      intent: null,
      source: null,
      body: null,
      props: { issues: [{ c: code }] },
    });
  }

  it("pages are stored paths, and a group carries no late_tag line", async () => {
    confirm("medora", "/");
    for (let i = 0; i < 4; i++) visit("medora", NOW - HOUR, ["/products/ginseng"]);
    for (let i = 0; i < 4; i++) visit("medora", NOW - HOUR, ["/"]);
    issue("medora", "/products/ginseng", "late_tag");
    issue("medora", "/products/omega", "late_tag");
    issue("medora", "/products/omega", "apply_error");
    issue("medora", "/", "late_tag");
    issue("medora", "/ginseng", "late_tag");
    const agg = await aggregateCustomerIssues(h.d1, "medora", NOW - DAY);
    expect(agg.pages.map((p) => [p.page_path, p.issues.map((i) => i.code)])).toEqual([
      ["/", ["late_tag"]],
      ["/products/:item", ["apply_error"]],
    ]);
    // The customer's totals keep the code.
    expect(agg.totals.find((t) => t.code === "late_tag")?.count).toBe(4);
    expect(JSON.stringify(agg)).not.toMatch(/ginseng|omega/);
  });

  it("a customer that is not sensitive: the pages as they were", async () => {
    confirm("acme", "/products/ginseng");
    for (let i = 0; i < 4; i++) visit("acme", NOW - HOUR, ["/products/ginseng"]);
    issue("acme", "/products/ginseng", "late_tag");
    const agg = await aggregateCustomerIssues(h.d1, "acme", NOW - DAY);
    expect(agg.pages).toEqual([
      {
        page_path: "/products/ginseng",
        loads: 4,
        issues: [{ code: "late_tag", count: 1, share: 0.25, slot: null }],
      },
    ]);
  });
});

describe("a customer that is not sensitive: byte for byte as before", () => {
  function spy(): string[] {
    const seen: string[] = [];
    const prepare = h.d1.prepare.bind(h.d1);
    (h.d1 as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      seen.push(sql);
      return prepare(sql);
    };
    return seen;
  }

  it("the aggregator runs the statements it always ran and stores no group and no counter", async () => {
    // The list alone does nothing: only the flag marks a customer.
    h.db.prepare("UPDATE customers SET kept_sections = '[\"/products\"]' WHERE id = 'acme'").run();
    for (let i = 0; i < 5; i++) visit("acme", at(D1), ["/products/ginseng"]);
    for (let i = 0; i < 5; i++) visit("acme", at(D1), ["/"]);
    loads("acme", D1, "/products/ginseng", 5);
    await rebuildDay(h.d1, "acme", D1, NOW);
    const seen = spy();
    await aggregateWindow("acme", "7d", W7, h.env);
    expect(seen).toContain(PAGE_ROWS_SQL);
    expect(seen).toContain(PAGES_WITHOUT_VERSIONS_SQL);
    for (const sql of seen) {
      expect(sql).not.toContain("page_days");
      expect(sql).not.toContain("group_visits");
      expect(sql).not.toContain("_sensitive");
      expect(sql).not.toContain(":item");
      expect(sql).not.toContain("json_each(?");
    }
    const pp = perPage("acme", "7d");
    expect(pp).toEqual({
      pages: [
        {
          page_path: "/",
          visits: 5,
          signal_visits: 5,
          written_visits: 5,
          skipped_visits: 0,
          lp_visits: 0,
          has_versions: false,
        },
        {
          page_path: "/products/ginseng",
          visits: 5,
          signal_visits: 5,
          written_visits: 5,
          skipped_visits: 0,
          lp_visits: 0,
          has_versions: false,
        },
      ],
      without_versions: { pages: 2, visits: 10, signal_visits: 10 },
    });
    expect(Object.keys(pp)).toEqual(["pages", "without_versions"]);
  });

  it("the rollup writes nothing to page_days and names no group", async () => {
    visit("acme", at(D1), ["/products/ginseng"]);
    const seen = spy();
    await rebuildDay(h.d1, "acme", D1, NOW);
    for (const sql of seen) expect(sql).not.toContain("page_days");
    expect(pageDays("acme")).toEqual([]);
  });

  it("the two page statements of a sensitive customer are the usual ones with the path swapped", () => {
    for (const [plain, sensitive, tag, param] of [
      [PAGE_ROWS_SQL, SENSITIVE_PAGE_ROWS_SQL, "per_page", "?5"],
      [
        PAGES_WITHOUT_VERSIONS_SQL,
        SENSITIVE_PAGES_WITHOUT_VERSIONS_SQL,
        "pages_without_versions",
        "?4",
      ],
    ] as const) {
      // The usual statement, cut at its path expression.
      const from = plain.indexOf("CASE WHEN page_path IS NULL");
      const to = plain.indexOf("END", from) + "END".length;
      expect(from).toBeGreaterThan(0);
      expect(plain.indexOf("CASE WHEN page_path IS NULL", to)).toBe(-1);
      const head = plain
        .slice(0, from)
        .replace(`/* ${tag} */`, `/* ${tag}_sensitive */`)
        .replace("SELECT", `WITH kept(p) AS (SELECT value FROM json_each(${param}))\nSELECT`);
      // Everything around the path is the same text: the counted columns,
      // the floor, the order, the filter on the customer.
      expect(sensitive.startsWith(head)).toBe(true);
      expect(sensitive.endsWith(plain.slice(to))).toBe(true);
      expect(sensitive.slice(head.length, sensitive.length - plain.slice(to).length)).toContain(
        "/:item",
      );
      expect(plain).not.toContain("kept");
    }
  });
});

describe("page_days meets a customer and a day, and nothing else", () => {
  it("no statement over page_days reads the events table or names a marker", () => {
    expect(PAGE_DAYS_QUERIES.length).toBeGreaterThanOrEqual(5);
    for (const sql of PAGE_DAYS_QUERIES) {
      expect(sql).toContain("page_days");
      expect(sql).not.toMatch(/\bevents\b/);
      expect(sql).not.toMatch(/\bvisit\b|\bmarker\b|\barm\b|\bintent_dim\b|\bsource_dim\b|\bts\b/);
      // Its own CTEs only: the named pages, and the counts handed in as a parameter.
      for (const m of sql.matchAll(/JOIN (\w+)/g)) expect(["n", "gv"]).toContain(m[1]);
      // Another table only through customer and day.
      if (sql.includes("exposure_rollup_days")) {
        expect(sql).toMatch(/r\.customer_id = pd\.customer_id AND r\.day = pd\.day/);
      }
    }
  });

  it("the aggregator's statements over events never mention page_days", () => {
    for (const sql of [SENSITIVE_PAGE_ROWS_SQL, SENSITIVE_PAGES_WITHOUT_VERSIONS_SQL]) {
      expect(sql).not.toContain("page_days");
      expect(sql).toMatch(/FROM events\s+WHERE customer_id = \?1/);
    }
  });
});

describe("what D1 takes (node:sqlite passing is not the gate)", () => {
  // Every statement of the counting modules a sensitive customer runs or
  // that reads page_days. On 2026-10-13 a 3,207-character statement that
  // applied the stored-path CASE over a derived table holding that CASE
  // failed on production D1 with SQLITE_NOMEM (the flattener copies the
  // inner expression into every reference of the outer), and the hourly run
  // lost the pilot's 24h, 7d and 30d windows. node:sqlite ran it.
  const statements: Record<string, string> = {
    SENSITIVE_PAGE_ROWS_SQL,
    SENSITIVE_PAGES_WITHOUT_VERSIONS_SQL,
    GROUP_VISITS_SQL,
    GROUP_PROPOSALS_SQL,
    ACCEPTED_GROUP_COUNTS_SQL,
    GROUP_PAGE_EVENTS_SQL,
    OWN_PAGE_OUTCOMES_SQL,
    VISITS_SQL: ROLLUP_EVENT_QUERIES[0],
    MARKERLESS_SQL: ROLLUP_EVENT_QUERIES[1],
    ...Object.fromEntries(PAGE_DAYS_QUERIES.map((sql, i) => [`PAGE_DAYS_QUERIES[${i}]`, sql])),
  };
  /** The one text storedPathSql ends with: its count is the count of the CASE. */
  const STORED_PATH_CASE = "|| '/:item'";

  it("no statement is longer than the measured bound", () => {
    expect(D1_STATEMENT_CHARS_MAX).toBe(2500);
    for (const [name, sql] of Object.entries(statements)) {
      expect(sql.length, name).toBeLessThanOrEqual(D1_STATEMENT_CHARS_MAX);
    }
  });

  it("the stored-path CASE appears at most once per statement, never over a derived table's column", () => {
    const once = storedPathSql(normPathSql("page_path"));
    expect(once.split(STORED_PATH_CASE)).toHaveLength(2);
    for (const [name, sql] of Object.entries(statements)) {
      const at = sql.indexOf(STORED_PATH_CASE);
      expect(sql.split(STORED_PATH_CASE).length - 1, name).toBeLessThanOrEqual(1);
      if (at < 0) continue;
      // Over a base table's column (`pd.page_path`, `page_path` of events),
      // never over a CTE that computed it (`f`, `d`): the table the CASE is
      // selected from is the first FROM after it.
      const from = sql.slice(at).match(/\bFROM\s+(\w+)/);
      expect(["page_days", "events"], name).toContain(from?.[1]);
    }
  });

  it("the proposals of a sensitive customer run no statement of their own", () => {
    for (const sql of Object.values(statements)) expect(sql).not.toContain("group_pages_sensitive");
  });
});
