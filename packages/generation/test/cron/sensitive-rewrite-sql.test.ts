/**
 * The existing rows of a customer marked sensitive later
 * (docs/specs/sensitive-customers.md, "Existing rows", condition 6): the dry
 * run and the rewrite as the script writes them, run on node:sqlite with
 * every migration over one fixture, and held against the shared rule: the
 * stored path and key of every row are what `storedPath` and
 * `storedVariantKey` give, the seeded counter is what `foldDay` gives.
 */
import {
  PAGE_DAY_EVENT_TYPES,
  type PageDayCount,
  foldDay,
  maskPath,
  pageDayOf,
  pageDayPath,
  storedPath,
  storedVariantKey,
  validKeptSections,
  variantKey,
  variantKeyForPath,
} from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateWindow } from "../../src/cron/analytics-aggregator.ts";
import { backfillExposureOutcomes, rebuildDay } from "../../src/cron/exposure-rollup.ts";
import {
  dryRunFile,
  dryRunSql,
  rewriteFile,
  rewriteStatements,
} from "../../src/lib/sensitive-rewrite-sql.ts";
import { DAY, HOUR, type Harness, harness, vid } from "../proof-harness.ts";

/** The step that calls the generation worker names the install's own origin. */
const API_ORIGIN = "https://api.example.com";

/** The proposed list, as the operator sets it by the endpoint. */
const LIST = ["/products", "/about", "/contact", "/blog", "/verify"];
const KEPT = validKeptSections(LIST) as string[];

/** The two files the script writes, as text. */
const DRY_FILE = dryRunFile("medora", LIST, "2026-10-12", API_ORIGIN);
const REWRITE_FILE = rewriteFile("medora", LIST, "2026-10-12", API_ORIGIN);

// The statements read SQLite's own clock (date('now')), so the fixture
// stands on the real one.
const NOW = Date.now();
const TODAY = pageDayOf(NOW);
const SWITCH = NOW - HOUR;

let h: Harness;
let n = 0;

interface Row {
  id: string;
  customer_id: string;
  ts: number;
  event_type: string;
  page_path: string | null;
  variant_key: string | null;
  /** Read in the test only, to count the visits the fold's second floor asks for. */
  visit: string | null;
}

beforeEach(() => {
  h = harness();
  h.customer("medora");
  h.customer("acme");
  n = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const noStatementComments = (file: string) =>
  file
    .split("\n")
    .filter((l) => !l.startsWith("--"))
    .join("\n");

function load(
  customer: string,
  ts: number,
  page: string,
  o: { type?: string; key?: string | null; times?: number; marker?: string } = {},
): void {
  for (let i = 0; i < (o.times ?? 1); i++) {
    const type = o.type ?? "no_signal_passthrough";
    h.ev({
      customer,
      ts: ts + i,
      type: type as never,
      visit: type === "snippet_issue" ? null : (o.marker ?? vid(++n)),
      page,
      ...(type === "snippet_issue" ? { intent: null, source: null, body: null } : {}),
    });
    if (o.key !== undefined) {
      h.db
        .prepare("UPDATE events SET variant_key = ? WHERE rowid = (SELECT MAX(rowid) FROM events)")
        .run(o.key);
    }
  }
}

/** pilot-like rows from before the customer was marked, on three closed days and today. */
function rowsBefore(customer: string): void {
  const d3 = NOW - 3 * DAY;
  const d2 = NOW - 2 * DAY;
  // Three days ago: two product pages (a group of two), one top-level page.
  load(customer, d3, "/", { times: 3, key: variantKey(customer, "problem", "ai") });
  load(customer, d3, "/products", { times: 2, type: "variant_shown" });
  load(customer, d3, "/products/ginseng", {
    times: 2,
    type: "personalization_skipped",
    key: variantKeyForPath(customer, "/products/ginseng", "problem", "ai"),
  });
  load(customer, d3, "/products/omega", { key: "" });
  load(customer, d3, "/about", { key: variantKeyForPath(customer, "/about", "brand", "default") });
  load(customer, d3, "/ginseng", { key: "ginseng" });
  // Not loads: a click and a snippet issue on product pages.
  load(customer, d3, "/products/ginseng", { type: "conversion" });
  load(customer, d3, "/products/omega", { type: "snippet_issue" });
  // Two days ago: three product pages (one spelled two ways), one blog post.
  load(customer, d2, "/products/a", { times: 5, type: "variant_shown" });
  load(customer, d2, "/Products/A/");
  load(customer, d2, "/products/b");
  load(customer, d2, "/products/c/reviews");
  load(customer, d2, "/blog/post-1");
  load(customer, d2, "/");
  // Yesterday: one visit that opened three product pages (the visit floor).
  const one = vid(++n);
  for (const p of ["/products/p1", "/products/p2", "/products/p3"]) {
    load(customer, NOW - DAY, p, { marker: one });
  }
  // Today, before the switch.
  load(customer, NOW - 3 * HOUR, "/products/x");
  load(customer, NOW - 3 * HOUR, "/");
}

/** What the edge does once the customer is marked: grouped rows, and the counter. */
function afterSwitch(): void {
  load("medora", SWITCH, "/products/:item", { times: 2 });
  load("medora", SWITCH + 60_000, "/");
  const count = h.db.prepare(
    "INSERT INTO page_days (customer_id, day, page_path, loads) VALUES ('medora', ?, ?, ?)",
  );
  count.run(pageDayOf(SWITCH), "/products/y", 2);
  count.run(pageDayOf(SWITCH + 60_000), "/", 1);
}

function mark(): void {
  h.db
    .prepare("UPDATE customers SET sensitive = 1, kept_sections = ? WHERE id = 'medora'")
    .run(JSON.stringify(KEPT));
}

const events = (customer: string) =>
  h.db
    .prepare(
      "SELECT id, customer_id, ts, event_type, page_path, variant_key, visit FROM events WHERE customer_id = ? ORDER BY rowid",
    )
    .all(customer) as unknown as Row[];

const counter = (customer = "medora") =>
  h.db
    .prepare(
      "SELECT day, page_path, loads FROM page_days WHERE customer_id = ? ORDER BY day, page_path",
    )
    .all(customer) as Array<{ day: string; page_path: string; loads: number }>;

function dump(customer: string): string {
  return JSON.stringify(
    [
      "events",
      "exposure_outcomes",
      "exposure_rollup_days",
      "analytics_aggregates",
      "page_days",
      "source_days",
    ].map((t) =>
      h.db.prepare(`SELECT * FROM ${t} WHERE customer_id = ? ORDER BY rowid`).all(customer),
    ),
  );
}

interface DryLine {
  ord: number;
  line: string;
  day: string;
  page: string;
  n: number;
  loads: number | null;
  pages: number | null;
  /** Distinct visits with a load on that stored path that day: a count. */
  visits: number | null;
  folds: number | null;
  note: string;
}
const dryRun = () => h.db.prepare(noStatementComments(DRY_FILE)).all() as unknown as DryLine[];
const rewrite = () => h.db.exec(REWRITE_FILE);

/** The distinct visits behind each group on a day, counted as the fold counts them. */
function visitsBehind(rows: readonly Row[], day: string): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!PAGE_DAY_EVENT_TYPES.includes(r.event_type) || pageDayOf(r.ts) !== day) continue;
    const group = storedPath(maskPath(r.page_path ?? "/"), KEPT);
    const set = seen.get(group) ?? new Set<string>();
    set.add(r.visit ?? r.id);
    seen.set(group, set);
  }
  return new Map([...seen].map(([g, v]) => [g, v.size]));
}

/** The counter the seed must give, by the shared rule, from the rows as they were. */
function expectedSeed(
  rows: readonly Row[],
): Array<{ day: string; page_path: string; loads: number }> {
  const byDay = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!PAGE_DAY_EVENT_TYPES.includes(r.event_type)) continue;
    const path = pageDayPath(maskPath(r.page_path ?? "/"));
    const named = storedPath(path, KEPT) !== path;
    if (!(r.ts < SWITCH || named)) continue;
    const day = pageDayOf(r.ts);
    const m = byDay.get(day) ?? new Map<string, number>();
    m.set(path, (m.get(path) ?? 0) + 1);
    byDay.set(day, m);
  }
  const out: Array<{ day: string; page_path: string; loads: number }> = [];
  for (const [day, m] of byDay) {
    const dayRows: PageDayCount[] = [...m].map(([page_path, loads]) => ({ page_path, loads }));
    // A closed day under both floors; the open day is left to the night's rollup.
    const kept = day < TODAY ? foldDay(dayRows, KEPT, visitsBehind(rows, day)) : dayRows;
    for (const r of kept) out.push({ day, ...r });
  }
  return out;
}

function addTo(
  rows: Array<{ day: string; page_path: string; loads: number }>,
  more: Array<{ day: string; page_path: string; loads: number }>,
) {
  const m = new Map(rows.map((r) => [`${r.day}\n${r.page_path}`, { ...r }]));
  for (const r of more) {
    const k = `${r.day}\n${r.page_path}`;
    const e = m.get(k);
    if (e) e.loads += r.loads;
    else m.set(k, { ...r });
  }
  return [...m.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || (a.page_path < b.page_path ? -1 : 1),
  );
}

// ---------------------------------------------------------------------------

describe("the written files", () => {
  it("the dry run is one SELECT that writes nothing, with the list once, at its top", () => {
    const sql = noStatementComments(DRY_FILE).trim();
    expect(
      sql.startsWith(
        "WITH kept(p) AS (VALUES ('/about'), ('/blog'), ('/contact'), ('/products'), ('/verify'))",
      ),
    ).toBe(true);
    expect(sql.match(/;/g)).toHaveLength(1);
    expect(sql.endsWith(";")).toBe(true);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE INTO|CREATE|DROP|ALTER)\b/);
    expect(sql.match(/'\/products'/g)).toHaveLength(1);
    expect(sql).toBe(dryRunSql("medora", LIST).trim());
  });

  it("the rewrite never sets the flag or the list, and has no list of its own", () => {
    const sql = noStatementComments(REWRITE_FILE);
    expect(sql).not.toMatch(/SET\s+(sensitive|kept_sections)/i);
    expect(sql).not.toMatch(/UPDATE\s+customers|INTO\s+customers/i);
    expect(sql).not.toContain("'/products'");
    expect(sql).not.toContain("'/about'");
    const statements = rewriteStatements("medora");
    expect(statements).toHaveLength(6);
    for (const s of statements) {
      expect(sql).toContain(s);
      expect(s).toContain("(SELECT sensitive FROM customers WHERE id = 'medora') = 1");
    }
  });

  it("no statement of either file names a marker, and page_days is seeded from three columns", () => {
    const COUNTED = "COUNT(DISTINCT COALESCE(visit, id)) AS visits";
    for (const sql of [noStatementComments(DRY_FILE), noStatementComments(REWRITE_FILE)]) {
      // The marker is counted for the fold's second floor, per day and group,
      // and stands nowhere else: in no result column, in no write.
      expect(sql.split(COUNTED).length - 1).toBe(1);
      const rest = sql.replace(COUNTED, "");
      expect(rest).not.toMatch(/\bvisit\b|\barm\b|\bbody_id\b|\bsource_name\b|\bintent_dim\b/);
    }
    const seed = rewriteStatements("medora")[0] ?? "";
    expect(seed).toContain("INSERT INTO page_days (customer_id, day, page_path, loads)");
    expect(seed).toContain(
      "event_type IN ('variant_shown', 'personalization_skipped', 'no_signal_passthrough')",
    );
  });

  it("the header says the order, and a comment holds no semicolon or quote a splitter could trip on", () => {
    for (const file of [DRY_FILE, REWRITE_FILE]) {
      const header = file.split("\n").filter((l) => l.startsWith("--"));
      const text = header.join("\n");
      const order = [
        "1. Deploy",
        "2. Mark medora sensitive",
        "3. The dry run",
        "4. The rewrite, once",
        "5. Rebuild the daily outcomes",
        "6. Dry run again",
        "7. Run the dry run again after 24 hours. The last line must still read 0.",
        "No edge rollback below 58343af while any customer is marked sensitive.",
      ].map((s) => text.indexOf(s));
      expect(order.every((i) => i > 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(text).toContain(`POST ${API_ORIGIN}/admin/proof/backfill`);
      expect(text).toContain('{"customer_id": "medora", "what": "outcomes"}');
    }
    for (const l of REWRITE_FILE.split("\n").filter((x) => x.startsWith("--"))) {
      expect(l).not.toMatch(/[;']/);
    }
    // No en or em dash anywhere in either file.
    const dashes = [0x2013, 0x2014].map((c) => String.fromCharCode(c));
    for (const file of [DRY_FILE, REWRITE_FILE]) {
      for (const d of dashes) expect(file.includes(d)).toBe(false);
    }
  });

  it("without an API origin the step names the path alone", () => {
    for (const file of [
      dryRunFile("medora", LIST, "2026-10-12"),
      rewriteFile("medora", LIST, "2026-10-12"),
    ]) {
      expect(file).toContain("--        POST /admin/proof/backfill\n");
      expect(file).not.toMatch(/https?:\/\//);
    }
  });

  it("refuses a customer id or a list that is not plain", () => {
    expect(() => rewriteStatements("medora'; DROP TABLE events; --")).toThrow();
    expect(() => dryRunSql("medora", ["/x'y"])).toThrow();
    expect(() => dryRunSql("MEDORA", [])).toThrow();
  });
});

describe("the rewrite, on a fixture", () => {
  it("does nothing while the customer is not marked", () => {
    rowsBefore("medora");
    const was = dump("medora");
    rewrite();
    expect(dump("medora")).toBe(was);
  });

  it("the dry run sizes the job and says whether the row's list is its own", async () => {
    rowsBefore("medora");
    for (const day of [3, 2, 1]) await rebuildDay(h.d1, "medora", pageDayOf(NOW - day * DAY), NOW);
    await aggregateWindow("medora", "7d", 7 * DAY, h.env);

    let lines = dryRun();
    expect(lines[0]).toMatchObject({ line: "list", n: 0, pages: 5 });
    expect(lines[0]?.note).toContain("NOT this list");

    mark();
    afterSwitch();
    lines = dryRun();
    expect(lines[0]).toMatchObject({ line: "list", n: 1, pages: 5 });
    expect(lines[0]?.note).toContain("is this list.");

    // Rows naming a page outside the list, by the shared rule.
    const outside = (p: string | null) => {
      const path = pageDayPath(maskPath(p ?? "/"));
      return storedPath(path, KEPT) !== path;
    };
    const eventRows = events("medora").filter((r) => outside(r.page_path)).length;
    const outcomeRows = (
      h.db
        .prepare("SELECT page_path FROM exposure_outcomes WHERE customer_id = 'medora'")
        .all() as Array<{ page_path: string }>
    ).filter((r) => outside(r.page_path)).length;
    const last = lines[lines.length - 1];
    expect(last?.line).toBe("rows naming a page outside the list");
    // 6 three days ago (a click and an issue among them), 9 two days ago,
    // 3 yesterday, 1 today.
    expect(eventRows).toBe(19);
    expect(outcomeRows).toBeGreaterThan(0);
    expect(last?.note).toBe(`events ${eventRows}, exposure_outcomes ${outcomeRows}, per_page 1`);
    expect(last?.n).toBe(eventRows + outcomeRows + 1);

    // Per day and stored path: the loads the seed adds, and where it folds.
    const ev = lines.filter((l) => l.line === "events");
    const seed = expectedSeed(events("medora"));
    for (const l of ev) {
      const loads = events("medora").filter(
        (r) =>
          pageDayOf(r.ts) === l.day &&
          storedPath(maskPath(r.page_path ?? "/"), KEPT) === l.page &&
          PAGE_DAY_EVENT_TYPES.includes(r.event_type) &&
          (r.ts < SWITCH || outside(r.page_path)),
      ).length;
      expect(l.loads, `${l.day} ${l.page}`).toBe(loads);
      expect(l.n, `${l.day} ${l.page}`).toBe(
        events("medora").filter(
          (r) =>
            pageDayOf(r.ts) === l.day && storedPath(maskPath(r.page_path ?? "/"), KEPT) === l.page,
        ).length,
      );
    }
    const folded = ev.filter((l) => l.folds === 1).map((l) => `${l.day} ${l.page}`);
    expect(folded.sort()).toEqual(
      [
        `${pageDayOf(NOW - 3 * DAY)} /:item`,
        `${pageDayOf(NOW - 3 * DAY)} /products/:item`,
        `${pageDayOf(NOW - 2 * DAY)} /blog/:item`,
        // Three pages, one visit behind them: the second floor.
        `${pageDayOf(NOW - DAY)} /products/:item`,
      ].sort(),
    );
    // The visits column is the count the fold reads, and nothing but a count.
    for (const l of ev) {
      expect(l.visits ?? 0, `${l.day} ${l.page}`).toBe(
        visitsBehind(events("medora"), l.day).get(l.page) ?? 0,
      );
    }
    expect(
      ev.find((l) => l.day === pageDayOf(NOW - DAY) && l.page === "/products/:item"),
    ).toMatchObject({ pages: 3, visits: 1, folds: 1, loads: 3 });
    // Two days ago: three pages and eight visits behind them, named.
    expect(
      ev.find((l) => l.day === pageDayOf(NOW - 2 * DAY) && l.page === "/products/:item"),
    ).toMatchObject({ pages: 3, visits: 8, folds: 0 });
    expect(seed.some((r) => r.page_path === "/products/:item")).toBe(true);
    // The counter as it is: the edge's two rows.
    expect(lines.filter((l) => l.line === "page_days").map((l) => [l.page, l.loads])).toEqual([
      ["/", 1],
      ["/products/:item", 2],
    ]);
    // Counts only: no marker in any line.
    expect(JSON.stringify(lines)).not.toMatch(/[0-9a-f]{32}/);
  });

  it("seeds the counter, rewrites every row, empties the rollups, and leaves another customer alone", async () => {
    rowsBefore("medora");
    rowsBefore("acme");
    for (const c of ["medora", "acme"]) {
      for (const day of [3, 2, 1]) await rebuildDay(h.d1, c, pageDayOf(NOW - day * DAY), NOW);
      await aggregateWindow(c, "7d", 7 * DAY, h.env);
    }
    mark();
    afterSwitch();
    const was = events("medora");
    const edgeRows = counter();
    const acme = dump("acme");
    const settings = h.db.prepare("SELECT sensitive, kept_sections FROM customers").all();

    rewrite();

    // 1. The counter: what foldDay gives for the rows from before, plus the edge's.
    expect(counter()).toEqual(addTo(expectedSeed(was), edgeRows));
    // No load lost or made: every seeded load is one exposure row.
    const seeded =
      counter().reduce((t, r) => t + r.loads, 0) - edgeRows.reduce((t, r) => t + r.loads, 0);
    expect(seeded).toBe(expectedSeed(was).reduce((t, r) => t + r.loads, 0));
    // 10 three days ago, 10 two days ago, 3 yesterday, 2 today before the switch.
    expect(seeded).toBe(25);
    // Yesterday's one visit over three pages left only the group.
    expect(counter().filter((r) => r.day === pageDayOf(NOW - DAY))).toEqual([
      { day: pageDayOf(NOW - DAY), page_path: "/products/:item", loads: 3 },
    ]);

    // 2 and 3. Every event row, every type: the shared rule's path and key.
    const now = events("medora");
    expect(now).toHaveLength(was.length);
    for (const [i, r] of now.entries()) {
      const old = was[i] as Row;
      expect(r.page_path, `${old.event_type} ${old.page_path}`).toBe(
        storedPath(maskPath(old.page_path ?? "/"), KEPT),
      );
      expect(r.variant_key, `${old.variant_key}`).toBe(
        storedVariantKey(old.variant_key, KEPT, "medora"),
      );
      expect([r.id, r.ts, r.event_type]).toEqual([old.id, old.ts, old.event_type]);
    }
    const types = new Set(
      was
        .filter(
          (r) => (r.page_path ?? "").includes("ginseng") || (r.page_path ?? "").includes("omega"),
        )
        .map((r) => r.event_type),
    );
    expect([...types].sort()).toEqual([
      "conversion",
      "no_signal_passthrough",
      "personalization_skipped",
      "snippet_issue",
    ]);
    expect(JSON.stringify(now)).not.toMatch(/ginseng|omega|post-1|reviews/);
    expect(
      now
        .filter((r) => r.variant_key !== null)
        .map((r) => r.variant_key)
        .sort(),
    ).toEqual(
      [
        ...Array(3).fill("v1:variant:medora:problem:ai"),
        "v1:variant:medora:p:%2Fabout:brand:default",
      ].sort(),
    );

    // 4 and 5. The rollups and the stored per_page.
    for (const t of ["exposure_outcomes", "exposure_rollup_days"]) {
      expect(
        h.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE customer_id = 'medora'`).get(),
      ).toEqual({ n: 0 });
    }
    expect(
      h.db
        .prepare(
          "SELECT COUNT(*) AS n FROM analytics_aggregates WHERE customer_id = 'medora' AND per_page IS NOT NULL",
        )
        .get(),
    ).toEqual({ n: 0 });

    // The flag and the list are the endpoint's; another customer is untouched.
    expect(h.db.prepare("SELECT sensitive, kept_sections FROM customers").all()).toEqual(settings);
    expect(dump("acme")).toBe(acme);

    // The dry run again: nothing names a page outside the list.
    const last = dryRun().at(-1);
    expect(last).toMatchObject({ n: 0, note: "events 0, exposure_outcomes 0, per_page 0" });
  });

  it("the rebuild and the aggregator keep it at 0", async () => {
    rowsBefore("medora");
    for (const day of [3, 2, 1]) await rebuildDay(h.d1, "medora", pageDayOf(NOW - day * DAY), NOW);
    mark();
    afterSwitch();
    rewrite();
    const seeded = counter();
    const r = await backfillExposureOutcomes(h.env, "medora", NOW);
    expect(r.rebuilt).toBeGreaterThanOrEqual(3);
    await aggregateWindow("medora", "7d", 7 * DAY, h.env);
    expect(dryRun().at(-1)).toMatchObject({ n: 0 });
    // The rollup's fold finds the seeded days already folded.
    expect(counter()).toEqual(seeded);
    expect(
      h.db
        .prepare(
          "SELECT DISTINCT page_path FROM exposure_outcomes WHERE customer_id = 'medora' ORDER BY 1",
        )
        .all()
        .map((x) => (x as { page_path: string }).page_path),
    ).toEqual(["/", "/:item", "/about", "/blog/:item", "/products", "/products/:item"]);
  });

  it("run twice, the second run adds nothing", () => {
    rowsBefore("medora");
    mark();
    afterSwitch();
    rewrite();
    const once = dump("medora");
    rewrite();
    expect(dump("medora")).toBe(once);
  });

  it("stopped after the seed, a second run does not seed again", () => {
    rowsBefore("medora");
    mark();
    afterSwitch();
    h.db.exec(rewriteStatements("medora")[0] ?? "");
    const seeded = counter();
    rewrite();
    expect(counter()).toEqual(seeded);
  });
});
