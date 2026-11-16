/**
 * A sensitive customer at the edge (docs/specs/sensitive-customers.md;
 * the privacy review's seven conditions of 2026-10-12):
 *
 * - /event stores a page path as `/`, a kept section, its group or `/:item`,
 *   and a `variant_key` only for `/` or a kept section, on every event type
 *   (condition 1);
 * - an exposure counts one load in `page_days` under the full masked path,
 *   with the customer, the day and the path and nothing else (condition 4);
 * - with no readable bundle the D1 read decides, and a failed read stores
 *   `/:item` and no key (condition 3);
 * - a customer that is not sensitive is written exactly as before, with no
 *   read and no counter row;
 * - `/s/{id}.js` and every answer are byte for byte the same with `s` set
 *   and unset (condition 5);
 * - the cross-customer learning counters skip it;
 * - a bundle the edge writes back carries `s` and `sk`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUNDLE_NO_EVENTS_SQL,
  FAIL_CLOSED_PATH,
  PAGE_DAYS_UPSERT_SQL,
  PAGE_DAY_EVENT_TYPES,
  SENSITIVE_CUSTOMER_SQL,
  hideRulesKey,
  isKeptPage,
  variantKeyForPath,
  variantKeyParts,
  visitorBundleKey,
} from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSqliteD1 } from "../../generation/test/admin/sqlite-d1.ts";
import { bundleForAnswer, bundleFromD1, writeBundleFromD1 } from "../src/bundle-writeback.ts";
import { EVENT_BUNDLE_MEMO_MS, eventBundleFor } from "../src/event-bundle.ts";
import { resetEventGuardForTests } from "../src/event.ts";
import worker from "../src/index.ts";
import {
  EVENT_CUSTOMER_SQL,
  type EventCustomerRow,
  SENSITIVE_MEMO_MS,
  customerOfBundle,
  eventCustomerFrom,
  eventCustomerFromD1,
  mayCountAcrossCustomers,
  sensitiveOfBundle,
  storedEventPage,
} from "../src/sensitive.ts";

const NOW = Date.parse("2026-10-12T23:30:00Z");
const DAY = "2026-10-12";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetEventGuardForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEPT = ["/about", "/products"];
const VISIT = "0123456789abcdef0123456789abcdef";
const MANIFEST = { "hero.headline": { css: ["h1"], text: ["Old"], structural: "first h1" } };
const CONV = [
  {
    section_path: "hero.cta",
    conversion_label: "signup",
    css: ["a.cta"],
    text: [],
    structural: "",
  },
];
const VARIANT = {
  customer_id: "x",
  profile_key: "intent:problem:ai",
  sections: { hero: { kind: "hero", headline: "New" } },
  generated_at: 1,
  prompt_hash: "h",
  body_id: "0123456789abcdef",
};

function bundle(extra: Record<string, unknown> = {}) {
  return { v: 1, pages: { "/": MANIFEST }, conv: CONV, ...extra };
}
const SENSITIVE = { s: 1, sk: KEPT };

interface Stmt {
  sql: string;
  args: unknown[];
}

function kvWith(data: Record<string, unknown>, opts: { fail?: (key: string) => boolean } = {}) {
  const gets: string[] = [];
  const puts: { key: string; value: string }[] = [];
  const kv = {
    async get(key: string, o?: string | { type?: string }) {
      gets.push(key);
      if (opts.fail?.(key)) throw new Error("kv down");
      const v = data[key];
      if (v === undefined) return null;
      const type = typeof o === "string" ? o : o?.type;
      return type === "json" ? v : typeof v === "string" ? v : JSON.stringify(v);
    },
    async put(key: string, value: string) {
      puts.push({ key, value });
    },
    async delete() {},
  } as unknown as KVNamespace;
  return { kv, gets, puts };
}

/**
 * A D1 that records every statement by how it was sent: `run` alone, in a
 * `batch`, or as a `first` read. `customer` is what the customers row read
 * answers ("throw": the read fails).
 */
function dbSpy(opts: { customer?: EventCustomerRow | null | "throw" } = {}) {
  const prepared: string[] = [];
  const runs: Stmt[] = [];
  const batches: Stmt[][] = [];
  const firsts: Stmt[] = [];
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      const make = (args: unknown[]) => ({
        sql,
        args,
        bind: (...a: unknown[]) => make(a),
        first: async () => {
          firsts.push({ sql, args });
          if (opts.customer === "throw") throw new Error("d1 down");
          return opts.customer ?? null;
        },
        all: async () => ({ results: [] }),
        run: async () => {
          runs.push({ sql, args });
          return { meta: {} };
        },
      });
      return make([]);
    },
    batch: async (stmts: Stmt[]) => {
      batches.push(stmts.map((s) => ({ sql: s.sql, args: s.args })));
      return [];
    },
  } as unknown as D1Database;
  return { db, prepared, runs, batches, firsts };
}

function ctxCollect() {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    ctx: {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  };
}

type Spy = ReturnType<typeof dbSpy>;

/** Every `events` INSERT, however it was sent. */
function eventRows(spy: Spy): Stmt[] {
  return [...spy.runs, ...spy.batches.flat()].filter((s) => s.sql.includes("INSERT INTO events"));
}
/** Every `page_days` statement, however it was sent. */
function pageDayRows(spy: Spy): Stmt[] {
  return [...spy.runs, ...spy.batches.flat()].filter((s) => s.sql.includes("page_days"));
}

/** The row as column → bound value, read from the statement's own column list. */
function rowOf(stmt: Stmt | undefined): Record<string, unknown> {
  if (!stmt) throw new Error("no event row");
  const cols = (/\(([^)]*)\)\s*VALUES/.exec(stmt.sql)?.[1] ?? "")
    .split(",")
    .map((c) => c.trim())
    // profile_id is the literal NULL in VALUES: it has no bound value.
    .filter((c) => c !== "profile_id");
  expect(cols).toHaveLength(stmt.args.length);
  return Object.fromEntries(cols.map((c, i) => [c, stmt.args[i]]));
}

interface Target {
  kv: KVNamespace;
  spy: Spy;
  limiter?: "allow" | "deny";
}

async function post(t: Target, id: string, body: Record<string, unknown>): Promise<void> {
  const { ctx, waits } = ctxCollect();
  const res = await worker.fetch(
    new Request(`https://edge.test/event?cid=${id}`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://example.com" },
      body: JSON.stringify(body),
    }),
    {
      VARIANTS: t.kv,
      DB: t.spy.db,
      ENVIRONMENT: "test",
      PREVIEW_TOKEN: "",
      EVENT_LIMITER: { limit: async () => ({ success: t.limiter !== "deny" }) },
    } as never,
    ctx,
  );
  expect(res.status).toBe(202);
  expect(await res.text()).toBe("");
  await Promise.all(waits);
}

/** One valid body of every event type the edge accepts. */
const BODIES: Record<string, Record<string, unknown>> = {
  variant_shown: {
    cohort: "personalized",
    intent_dim: "problem",
    source_dim: "ai",
    visit: VISIT,
    arm: "treat",
    body_id: "0123456789abcdef",
    source_name: "chatgpt",
    tagged: 1,
  },
  personalization_skipped: {
    cohort: "skipped",
    kind: "missing",
    intent_dim: "problem",
    source_dim: "ai",
    visit: VISIT,
  },
  no_signal_passthrough: { cohort: "no_signal", visit: VISIT, dark_social: 1 },
  conversion: { conversion_label: "signup", cohort: "personalized", visit: VISIT, arm: "treat" },
  personalization_partial: { paths: ["hero.headline"], visit: VISIT },
  snippet_issue: { properties: { issues: [{ c: "late_tag" }] } },
  // The visitor-choice row (direct-visitors.md §2): never asked on a sensitive
  // site, its path stored like any other row's if one came.
  choice: { cohort: "no_signal", visit: VISIT, ch: "shown" },
};
const EVENT_TYPES = Object.keys(BODIES);

const ev = (type: string, page_path: string, extra: Record<string, unknown> = {}) => ({
  event_type: type,
  page_path,
  ...BODIES[type],
  ...extra,
});

/** A sensitive customer whose bundle is in KV. */
function sensitiveTarget(id: string, sk: string[] | undefined = KEPT): Target {
  const { kv } = kvWith({
    [visitorBundleKey(id)]: bundle({ s: 1, ...(sk ? { sk } : {}) }),
  });
  return { kv, spy: dbSpy() };
}

// ---------------------------------------------------------------------------
// /event: the stored path (condition 1)
// ---------------------------------------------------------------------------

describe("/event for a sensitive customer: the stored path", () => {
  it("the event types here are every type the edge accepts", () => {
    const src = readFileSync(resolve(__dirname, "../src/event.ts"), "utf8");
    const block = /const ALLOWED_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\);/.exec(src)?.[1] ?? "";
    const accepted = [...block.matchAll(/^\s*"([a-z_]+)",/gm)].map((m) => m[1]);
    expect(accepted.sort()).toEqual([...EVENT_TYPES].sort());
  });

  it.each([
    ["/ginseng", "/:item"],
    ["/category/liver", "/:item"],
    ["/products/ginseng", "/products/:item"],
    ["/products/ginseng/reviews", "/products/:item"],
    ["/products", "/products"],
    ["/products/", "/products"],
    ["/about", "/about"],
    ["/", "/"],
    // A section is a whole segment: never a prefix of another word.
    ["/productsale", "/:item"],
    // The mask runs first; what it leaves is grouped like any page.
    ["/products/1234567890", "/products/:item"],
    ["/orders/3f2b8c1e-9a4d-4e2b-8c1e-9a4d4e2b8c1e", "/:item"],
    // Case and a query do not open a way around the list.
    ["/Products/Ginseng?ref=x#top", "/products/:item"],
    // A group's own path maps to itself.
    ["/products/:item", "/products/:item"],
  ])("%s is stored as %s, on every event type", async (sent, stored) => {
    for (const type of EVENT_TYPES) {
      const t = sensitiveTarget("medora");
      await post(t, "medora", ev(type, sent));
      const rows = eventRows(t.spy);
      expect(rows, type).toHaveLength(1);
      expect(rowOf(rows[0]).page_path, type).toBe(stored);
      expect(rowOf(rows[0]).event_type, type).toBe(type);
    }
  });

  it("with an empty list, or one that is not a list, every page but / is /:item", async () => {
    for (const sk of [undefined, [], "/products", [42], ["products"]] as unknown[]) {
      const { kv } = kvWith({ [visitorBundleKey("medora")]: bundle({ s: 1, sk }) });
      const t = { kv, spy: dbSpy() };
      await post(t, "medora", ev("variant_shown", "/products/ginseng"));
      await post(t, "medora", ev("variant_shown", "/products"));
      await post(t, "medora", ev("variant_shown", "/"));
      expect(
        eventRows(t.spy).map((r) => rowOf(r).page_path),
        JSON.stringify(sk),
      ).toEqual(["/:item", "/:item", "/"]);
    }
  });

  it("nothing else in the row changes: only page_path and variant_key differ from a plain customer's", async () => {
    for (const type of EVENT_TYPES) {
      const body = ev(type, "/products/ginseng", { variant_key: "k" });
      const s = sensitiveTarget("medora");
      await post(s, "medora", body);
      const { kv } = kvWith({ [visitorBundleKey("medora")]: bundle() });
      const p = { kv, spy: dbSpy() };
      await post(p, "medora", body);
      const [a, b] = [eventRows(s.spy)[0], eventRows(p.spy)[0]];
      // The same statement, so only bound values can differ.
      expect(a?.sql, type).toBe(b?.sql);
      const { id: idA, page_path: pathA, variant_key: keyA, ...restA } = rowOf(a);
      const { id: idB, page_path: pathB, variant_key: keyB, ...restB } = rowOf(b);
      expect(restA, type).toEqual(restB);
      expect([pathA, keyA], type).toEqual(["/products/:item", null]);
      expect([pathB, keyB], type).toEqual(["/products/ginseng", "k"]);
      expect(String(idA)).toMatch(/^evt_[0-9a-f]{32}$/);
      expect(String(idB)).toMatch(/^evt_[0-9a-f]{32}$/);
    }
  });

  it("no event column and no properties key holds the flag or the list", async () => {
    for (const type of EVENT_TYPES) {
      const t = sensitiveTarget("medora");
      await post(t, "medora", ev(type, "/products/ginseng", { s: 1, sk: KEPT, sensitive: 1 }));
      const stmt = eventRows(t.spy)[0];
      expect(stmt?.sql).not.toMatch(/sensitive|kept_sections/);
      const row = rowOf(stmt);
      const props = row.properties === null ? {} : JSON.parse(String(row.properties));
      expect(Object.keys(props).filter((k) => ["s", "sk", "sensitive"].includes(k))).toEqual([]);
      expect(JSON.stringify(stmt?.args)).not.toContain("/about");
    }
  });
});

// ---------------------------------------------------------------------------
// /event: the stored variant_key
// ---------------------------------------------------------------------------

describe("/event for a sensitive customer: the stored variant_key", () => {
  const key = (page: string, id = "medora") => variantKeyForPath(id, page, "problem", "ai");

  it.each([
    ["the root page's key", key("/"), true],
    ["the root page's sentinel key", variantKeyForPath("medora", "/", "problem", "default"), true],
    ["a kept section's key", key("/products"), true],
    ["a product page's key", key("/products/ginseng"), false],
    ["a top-level product page's key", key("/ginseng"), false],
    ["another customer's key", key("/", "other-co"), false],
    ["a free string", "k", false],
    ["a free string that names a page", "/products/ginseng", false],
    ["the empty string", "", false],
    ["a key with an intent off the list", "v1:variant:medora:ginseng:ai", false],
    ["a second encoding of a kept page", "v1:variant:medora:p:%2Fproducts%2F:problem:ai", false],
  ])("%s", async (_label, sent, kept) => {
    for (const type of EVENT_TYPES) {
      const t = sensitiveTarget("medora");
      await post(t, "medora", ev(type, "/", { variant_key: sent }));
      expect(rowOf(eventRows(t.spy)[0]).variant_key, type).toBe(kept ? sent : null);
    }
  });

  it("no key at all is NULL, as before", async () => {
    const t = sensitiveTarget("medora");
    await post(t, "medora", ev("variant_shown", "/"));
    expect(rowOf(eventRows(t.spy)[0]).variant_key).toBeNull();
  });

  it("no row holds both a marker and a page outside the list, in page_path or variant_key", async () => {
    const paths = [
      "/",
      "/about",
      "/products",
      "/products/ginseng",
      "/products/ginseng/reviews",
      "/ginseng",
      "/blog/liver-health",
      "/Products/Omega-3/",
    ];
    const closed = new Set(["/", ...KEPT, ...KEPT.map((k) => `${k}/:item`), FAIL_CLOSED_PATH]);
    for (const type of EVENT_TYPES) {
      for (const page of paths) {
        for (const keyPage of ["/", "/products", "/products/ginseng", "/ginseng"]) {
          const t = sensitiveTarget("medora");
          await post(t, "medora", ev(type, page, { variant_key: key(keyPage) }));
          const row = rowOf(eventRows(t.spy)[0]);
          expect(closed.has(String(row.page_path)), `${type} ${page}`).toBe(true);
          if (row.variant_key !== null) {
            const parts = variantKeyParts(String(row.variant_key));
            expect(parts && isKeptPage(parts.pagePath, KEPT), `${type} ${keyPage}`).toBe(true);
          }
          // Neither product name is anywhere in what was bound for the row.
          expect(JSON.stringify(eventRows(t.spy)[0]?.args)).not.toMatch(/ginseng|liver|omega/i);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// /event: the daily counter (condition 4)
// ---------------------------------------------------------------------------

describe("/event for a sensitive customer: page_days", () => {
  it("an exposure counts one load under the full masked path, in one batch with the row", async () => {
    for (const type of PAGE_DAY_EVENT_TYPES) {
      const t = sensitiveTarget("medora");
      await post(t, "medora", ev(type, "/Products/Ginseng/?x=1"));
      // One batch of two statements, nothing sent alone.
      expect(t.spy.runs, type).toEqual([]);
      expect(t.spy.batches, type).toHaveLength(1);
      const [insert, counter] = t.spy.batches[0] ?? [];
      expect(rowOf(insert).page_path).toBe("/products/:item");
      expect(counter?.sql).toBe(PAGE_DAYS_UPSERT_SQL);
      // The full masked path, not the group; the customer and the UTC day.
      expect(counter?.args).toEqual(["medora", DAY, "/products/ginseng"]);
    }
  });

  it("the counter's statement is given the customer, the day and the path, and nothing else", async () => {
    const t = sensitiveTarget("medora");
    await post(
      t,
      "medora",
      ev("variant_shown", "/products/ginseng", { variant_key: "v1:variant:medora:problem:ai" }),
    );
    const counter = pageDayRows(t.spy)[0];
    expect(counter?.args).toHaveLength(3);
    const bound = JSON.stringify(counter?.args);
    // No marker, source, intent, arm, cohort, version, key or time of day.
    for (const never of [
      VISIT,
      "chatgpt",
      "problem",
      "ai",
      "treat",
      "personalized",
      "0123456789abcdef",
      "v1:variant",
      String(NOW),
    ]) {
      expect(bound).not.toContain(never);
    }
    expect(counter?.args.every((a) => typeof a === "string")).toBe(true);
    expect(counter?.args[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Four columns in the statement, and none of them a time.
    expect(PAGE_DAYS_UPSERT_SQL).toContain("(customer_id, day, page_path, loads)");
  });

  it("the day is the UTC day of the write", async () => {
    vi.setSystemTime(Date.parse("2026-10-13T00:00:01Z"));
    const t = sensitiveTarget("medora");
    await post(t, "medora", ev("variant_shown", "/products/ginseng"));
    expect(pageDayRows(t.spy)[0]?.args).toEqual(["medora", "2026-10-13", "/products/ginseng"]);
  });

  it("an identifier in the path is counted as the mask left it", async () => {
    const t = sensitiveTarget("medora");
    await post(t, "medora", ev("variant_shown", "/orders/1234567890/status"));
    expect(pageDayRows(t.spy)[0]?.args).toEqual(["medora", DAY, "/orders/:id/status"]);
    expect(rowOf(eventRows(t.spy)[0]).page_path).toBe("/:item");
  });

  it("/ and a kept section are counted too, under their own path", async () => {
    const t = sensitiveTarget("medora");
    await post(t, "medora", ev("no_signal_passthrough", "/"));
    await post(t, "medora", ev("no_signal_passthrough", "/products"));
    expect(pageDayRows(t.spy).map((r) => r.args[2])).toEqual(["/", "/products"]);
  });

  it("a conversion, a partial report and a snippet issue count no load", async () => {
    for (const type of EVENT_TYPES.filter((t) => !PAGE_DAY_EVENT_TYPES.includes(t))) {
      const t = sensitiveTarget("medora");
      await post(t, "medora", ev(type, "/products/ginseng"));
      expect(eventRows(t.spy), type).toHaveLength(1);
      expect(pageDayRows(t.spy), type).toEqual([]);
      expect(t.spy.batches, type).toEqual([]);
      expect(
        t.spy.prepared.filter((q) => q.includes("page_days")),
        type,
      ).toEqual([]);
    }
  });

  it("no row, no counter: over the limit, malformed, a deleted customer", async () => {
    const over = { ...sensitiveTarget("medora"), limiter: "deny" as const };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await post(over, "medora", ev("variant_shown", "/products/ginseng"));
    expect([...over.spy.runs, ...over.spy.batches.flat(), ...over.spy.firsts]).toEqual([]);

    const bad = sensitiveTarget("medora");
    await post(bad, "medora", { event_type: "page_view", page_path: "/products/ginseng" });
    await post(bad, "medora", ev("conversion", "/products/ginseng", { conversion_label: "x" }));
    expect([...bad.spy.runs, ...bad.spy.batches.flat(), ...bad.spy.firsts]).toEqual([]);
    warn.mockRestore();

    const { kv } = kvWith({
      [visitorBundleKey("gone-co")]: bundle(SENSITIVE),
      "v1:closed:gone-co": "1",
    });
    const gone = { kv, spy: dbSpy() };
    await post(gone, "gone-co", ev("variant_shown", "/products/ginseng"));
    expect([...gone.spy.runs, ...gone.spy.batches.flat(), ...gone.spy.firsts]).toEqual([]);
  });

  it("against the real tables: the row is grouped, the counter adds up, four columns", async () => {
    const { d1, db } = makeSqliteD1();
    db.prepare(
      "INSERT INTO customers (id, slug, domain, status, created_at, sensitive, kept_sections) VALUES (?, ?, ?, ?, ?, 1, ?)",
    ).run("medora", "medora", "medora.test", "active", 1, JSON.stringify(KEPT));
    const { kv } = kvWith({ [visitorBundleKey("medora")]: bundle(SENSITIVE) });
    const send = async (body: Record<string, unknown>) => {
      const { ctx, waits } = ctxCollect();
      await worker.fetch(
        new Request("https://edge.test/event?cid=medora", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        { VARIANTS: kv, DB: d1, ENVIRONMENT: "test", PREVIEW_TOKEN: "" } as never,
        ctx,
      );
      await Promise.all(waits);
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await send(ev("variant_shown", "/products/ginseng"));
    await send(ev("no_signal_passthrough", "/products/ginseng"));
    await send(ev("personalization_skipped", "/products/omega"));
    await send(ev("conversion", "/products/ginseng"));
    await send(ev("variant_shown", "/"));
    err.mockRestore();

    const events = db
      .prepare("SELECT event_type, page_path, visit FROM events ORDER BY rowid")
      .all() as { event_type: string; page_path: string; visit: string | null }[];
    expect(events.map((e) => e.page_path)).toEqual([
      "/products/:item",
      "/products/:item",
      "/products/:item",
      "/products/:item",
      "/",
    ]);
    expect(events.every((e) => e.visit === VISIT)).toBe(true);
    const days = db.prepare("SELECT * FROM page_days ORDER BY page_path").all();
    expect(days.map((d) => ({ ...(d as object) }))).toEqual([
      { customer_id: "medora", day: DAY, page_path: "/", loads: 1 },
      { customer_id: "medora", day: DAY, page_path: "/products/ginseng", loads: 2 },
      { customer_id: "medora", day: DAY, page_path: "/products/omega", loads: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// /event: no readable bundle (condition 3, fail closed)
// ---------------------------------------------------------------------------

describe("/event with no readable bundle: the D1 read decides", () => {
  const sensitiveRow = { sensitive: 1, kept_sections: JSON.stringify(KEPT) };
  /** The ways a bundle is not readable. */
  const UNREADABLE: [string, () => ReturnType<typeof kvWith>][] = [
    ["no bundle in KV", () => kvWith({})],
    [
      "a value that is not a bundle",
      () => kvWith({ [visitorBundleKey("medora")]: { v: 2, s: 0 } }),
    ],
    ["a string where the bundle should be", () => kvWith({ [visitorBundleKey("medora")]: "x" })],
    [
      "a failed KV read",
      () =>
        kvWith(
          { [visitorBundleKey("medora")]: bundle() },
          { fail: (k) => k === visitorBundleKey("medora") },
        ),
    ],
  ];

  it.each(UNREADABLE)("%s, D1 says sensitive: grouped, counted", async (_label, makeKv) => {
    const t = { kv: makeKv().kv, spy: dbSpy({ customer: sensitiveRow }) };
    await post(t, "medora", ev("variant_shown", "/products/ginseng/reviews", { variant_key: "k" }));
    expect(t.spy.firsts).toEqual([{ sql: EVENT_CUSTOMER_SQL, args: ["medora"] }]);
    const row = rowOf(eventRows(t.spy)[0]);
    expect([row.page_path, row.variant_key]).toEqual(["/products/:item", null]);
    expect(pageDayRows(t.spy).map((r) => r.args)).toEqual([
      ["medora", DAY, "/products/ginseng/reviews"],
    ]);
  });

  it.each(UNREADABLE)("%s, D1 says not sensitive: as sent, no counter", async (_label, makeKv) => {
    for (const customer of [{ sensitive: 0, kept_sections: null }, null]) {
      const t = { kv: makeKv().kv, spy: dbSpy({ customer }) };
      await post(t, "medora", ev("variant_shown", "/products/ginseng", { variant_key: "k" }));
      expect(t.spy.firsts).toHaveLength(1);
      const row = rowOf(eventRows(t.spy)[0]);
      expect([row.page_path, row.variant_key]).toEqual(["/products/ginseng", "k"]);
      expect(pageDayRows(t.spy)).toEqual([]);
      expect(t.spy.batches).toEqual([]);
    }
  });

  it.each(UNREADABLE)(
    "%s, and the D1 read fails: /:item, no key, no counter, on every event type",
    async (_label, makeKv) => {
      for (const type of EVENT_TYPES) {
        for (const page of ["/products/ginseng", "/products", "/about", "/"]) {
          const t = { kv: makeKv().kv, spy: dbSpy({ customer: "throw" }) };
          await post(
            t,
            "medora",
            ev(type, page, { variant_key: variantKeyForPath("medora", "/", "problem", "ai") }),
          );
          const rows = eventRows(t.spy);
          // The row is still written: the visit counts, its page does not show.
          expect(rows, `${type} ${page}`).toHaveLength(1);
          const row = rowOf(rows[0]);
          expect(row.page_path, `${type} ${page}`).toBe("/:item");
          expect(row.page_path).toBe(FAIL_CLOSED_PATH);
          expect(row.variant_key, `${type} ${page}`).toBeNull();
          expect(pageDayRows(t.spy)).toEqual([]);
          expect(t.spy.batches).toEqual([]);
        }
      }
    },
  );

  it("a sensitive row whose list cannot be read keeps only /", async () => {
    for (const kept_sections of [null, "", "not json", '{"a":1}', '["products"]']) {
      const t = {
        kv: kvWith({}).kv,
        spy: dbSpy({ customer: { sensitive: 1, kept_sections } }),
      };
      await post(t, "medora", ev("variant_shown", "/products/ginseng"));
      await post(t, "medora", ev("variant_shown", "/products"));
      await post(t, "medora", ev("variant_shown", "/"));
      expect(eventRows(t.spy).map((r) => rowOf(r).page_path)).toEqual(["/:item", "/:item", "/"]);
    }
  });

  it("the read is made after the 202 and after the guard, never before", async () => {
    const spy = dbSpy({ customer: sensitiveRow });
    const { kv, gets } = kvWith({});
    const { ctx, waits } = ctxCollect();
    const res = await worker.fetch(
      new Request("https://edge.test/event?cid=medora", {
        method: "POST",
        body: JSON.stringify(ev("variant_shown", "/products/ginseng")),
      }),
      { VARIANTS: kv, DB: spy.db, ENVIRONMENT: "test", PREVIEW_TOKEN: "" } as never,
      ctx,
    );
    // The answer is out: nothing was asked of the database to make it. (The
    // two KV reads are started inside waitUntil and wait on nothing.)
    expect(res.status).toBe(202);
    expect(spy.prepared).toEqual([]);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(gets).toEqual(["v1:closed:medora", visitorBundleKey("medora")]);
    expect(spy.firsts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// /event: what an event costs in reads
// ---------------------------------------------------------------------------

describe("/event: reads per event", () => {
  const shown = ev("variant_shown", "/Pricing/Plans/", { variant_key: "k" });

  it("a customer that is not sensitive, with a bundle: as before, no D1 read, no counter", async () => {
    const { kv, gets, puts } = kvWith({ [visitorBundleKey("acme")]: bundle() });
    const t = { kv, spy: dbSpy({ customer: "throw" }) };
    for (let i = 0; i < 5; i++) await post(t, "acme", shown);
    // One tombstone read and one bundle read for the five, then memory.
    expect(gets).toEqual(["v1:closed:acme", visitorBundleKey("acme")]);
    expect(puts).toEqual([]);
    // No read of the database at all, no batch, no counter statement.
    expect(t.spy.firsts).toEqual([]);
    expect(t.spy.batches).toEqual([]);
    expect(t.spy.prepared.every((q) => q.includes("INSERT INTO events"))).toBe(true);
    expect(t.spy.prepared).toHaveLength(5);
    expect(t.spy.runs).toHaveLength(5);
    // The path as the mask left it (not normalized) and the client's key.
    for (const r of t.spy.runs) {
      const row = rowOf(r);
      expect([row.page_path, row.variant_key]).toEqual(["/Pricing/Plans/", "k"]);
    }
  });

  it("a sensitive customer with a bundle: no D1 read, one batch per exposure", async () => {
    const { kv, gets } = kvWith({ [visitorBundleKey("medora")]: bundle(SENSITIVE) });
    const t = { kv, spy: dbSpy({ customer: "throw" }) };
    for (let i = 0; i < 5; i++) await post(t, "medora", ev("variant_shown", "/products/ginseng"));
    expect(gets).toEqual(["v1:closed:medora", visitorBundleKey("medora")]);
    expect(t.spy.firsts).toEqual([]);
    expect(t.spy.batches).toHaveLength(5);
    expect(t.spy.runs).toEqual([]);
  });

  it("no bundle: one D1 read per customer per isolate per five minutes, then memory", async () => {
    for (const customer of [{ sensitive: 0 }, { sensitive: 1, kept_sections: null }, null]) {
      const { kv, gets } = kvWith({});
      const t = { kv, spy: dbSpy({ customer }) };
      for (let i = 0; i < 5; i++) await post(t, "acme", shown);
      expect(gets).toEqual(["v1:closed:acme", visitorBundleKey("acme")]);
      expect(t.spy.firsts).toHaveLength(1);
      expect(eventRows(t.spy)).toHaveLength(5);
      // /event writes no bundle back: /select does, on the answer before it.
      vi.setSystemTime(NOW + SENSITIVE_MEMO_MS + 1);
      await post(t, "acme", shown);
      expect(t.spy.firsts).toHaveLength(2);
      vi.setSystemTime(NOW);
    }
  });

  it("no bundle and the database down: one read tried per event, never remembered", async () => {
    const { kv } = kvWith({});
    const t = { kv, spy: dbSpy({ customer: "throw" }) };
    for (let i = 0; i < 3; i++) await post(t, "acme", shown);
    expect(t.spy.firsts).toHaveLength(3);
    expect(eventRows(t.spy).map((r) => rowOf(r).page_path)).toEqual(["/:item", "/:item", "/:item"]);
  });

  it("a failed KV read is tried again on the next event; the D1 answer is kept meanwhile", async () => {
    const { kv, gets } = kvWith({}, { fail: (k) => k.startsWith("v1:vm:") });
    const t = { kv, spy: dbSpy({ customer: { sensitive: 1, kept_sections: '["/products"]' } }) };
    for (let i = 0; i < 3; i++) await post(t, "medora", ev("variant_shown", "/products/ginseng"));
    expect(gets.filter((k) => k.startsWith("v1:vm:"))).toHaveLength(3);
    expect(t.spy.firsts).toHaveLength(1);
    expect(eventRows(t.spy).map((r) => rowOf(r).page_path)).toEqual([
      "/products/:item",
      "/products/:item",
      "/products/:item",
    ]);
  });

  it("no KV binding at all: the database decides, like any unread bundle", async () => {
    const spy = dbSpy({ customer: { sensitive: 1, kept_sections: JSON.stringify(KEPT) } });
    const { ctx, waits } = ctxCollect();
    await worker.fetch(
      new Request("https://edge.test/event?cid=medora", {
        method: "POST",
        body: JSON.stringify(ev("variant_shown", "/products/ginseng")),
      }),
      { DB: spy.db, ENVIRONMENT: "test", PREVIEW_TOKEN: "" } as never,
      ctx,
    );
    await Promise.all(waits);
    expect(spy.firsts).toHaveLength(1);
    expect(rowOf(eventRows(spy)[0]).page_path).toBe("/products/:item");
  });

  it("the audit and the sensitive flag come from the same one read", async () => {
    const { kv, gets } = kvWith({
      [visitorBundleKey("both")]: bundle({ a: 1, ad: "example.com", ae: NOW + 1000, ...SENSITIVE }),
    });
    const t = { kv, spy: dbSpy() };
    await post(t, "both", ev("variant_shown", "/products/ginseng", { found_by: "auto_tag" }));
    expect(gets).toEqual(["v1:closed:both", visitorBundleKey("both")]);
    const row = rowOf(eventRows(t.spy)[0]);
    expect([row.page_path, row.found_by]).toEqual(["/products/:item", "auto_tag"]);
  });
});

// ---------------------------------------------------------------------------
// /event under `ne`: nothing stored, nothing counted (readiness-check.md,
// privacy review condition 2)
// ---------------------------------------------------------------------------

describe("/event for a customer whose bundle says ne: no row, no counter", () => {
  /** The answer as a browser sees it, and what the edge did to make it. */
  async function postSeen(t: Target, id: string, body: Record<string, unknown>) {
    const { ctx, waits } = ctxCollect();
    const res = await worker.fetch(
      new Request(`https://edge.test/event?cid=${id}`, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://example.com" },
        body: JSON.stringify(body),
      }),
      {
        VARIANTS: t.kv,
        DB: t.spy.db,
        ENVIRONMENT: "test",
        PREVIEW_TOKEN: "",
        EVENT_LIMITER: { limit: async () => ({ success: t.limiter !== "deny" }) },
      } as never,
      ctx,
    );
    await Promise.all(waits);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, text: await res.text(), headers };
  }
  const PAGES = ["/", "/about", "/products", "/products/ginseng", "/Pricing/Plans/"];
  const NE_BUNDLES: [string, Record<string, unknown>][] = [
    ["ne alone", { ne: 1 }],
    ["ne beside s and sk", { ne: 1, ...SENSITIVE }],
    ["ne beside every other flag", { ne: 1, s: 1, h: 20, g: ["/products/*"], pm: {} }],
  ];

  it.each(NE_BUNDLES)(
    "%s: every event type on every page writes no statement at all, with the same 202",
    async (_label, flags) => {
      for (const type of EVENT_TYPES) {
        for (const page of PAGES) {
          const body = ev(type, page, {
            variant_key: variantKeyForPath("acme", "/", "problem", "ai"),
          });
          const plain = {
            kv: kvWith({ [visitorBundleKey("acme")]: bundle() }).kv,
            spy: dbSpy({ customer: "throw" }),
          };
          const held = {
            kv: kvWith({ [visitorBundleKey("acme")]: bundle(flags) }).kv,
            spy: dbSpy({ customer: "throw" }),
          };
          const a = await postSeen(plain, "acme", body);
          const b = await postSeen(held, "acme", body);
          // The browser sees the same answer either way (condition 4).
          expect(b, `${type} ${page}`).toEqual(a);
          expect(b.status).toBe(202);
          expect(b.text).toBe("");
          // The plain customer's row is written; the held customer's is not,
          // and no statement of any kind is prepared for it: no event row,
          // no page_days load, no read to find out.
          expect(eventRows(plain.spy), `${type} ${page}`).toHaveLength(1);
          expect(held.spy.prepared, `${type} ${page}`).toEqual([]);
          expect(held.spy.runs).toEqual([]);
          expect(held.spy.batches).toEqual([]);
          expect(held.spy.firsts).toEqual([]);
        }
      }
    },
  );

  it("the bundle is read once per customer per isolate, the same KV reads as a plain customer", async () => {
    const plain = kvWith({ [visitorBundleKey("acme")]: bundle() });
    const held = kvWith({ [visitorBundleKey("acme")]: bundle({ ne: 1 }) });
    const tp = { kv: plain.kv, spy: dbSpy() };
    const th = { kv: held.kv, spy: dbSpy() };
    for (let i = 0; i < 5; i++) {
      await post(tp, "acme", ev("variant_shown", "/products/ginseng"));
      await post(th, "acme", ev("variant_shown", "/products/ginseng"));
    }
    expect(held.gets).toEqual(plain.gets);
    expect(held.puts).toEqual([]);
    expect(eventRows(tp.spy)).toHaveLength(5);
    expect(th.spy.prepared).toEqual([]);
  });

  it("no readable bundle: the same D1 read as the sensitive flag's decides, one column more", async () => {
    // A yes that is not marked: nothing written, the read made once, then memory.
    const held = {
      kv: kvWith({}).kv,
      spy: dbSpy({ customer: { sensitive: 0, special_category: 1 } }),
    };
    for (let i = 0; i < 3; i++) await post(held, "acme", ev("variant_shown", "/products/ginseng"));
    expect(held.spy.firsts).toEqual([{ sql: EVENT_CUSTOMER_SQL, args: ["acme"] }]);
    expect(held.spy.runs).toEqual([]);
    expect(held.spy.batches).toEqual([]);
    // The memo ends: read again, still nothing written.
    vi.setSystemTime(NOW + SENSITIVE_MEMO_MS + 1);
    await post(held, "acme", ev("variant_shown", "/products/ginseng"));
    expect(held.spy.firsts).toHaveLength(2);
    expect(eventRows(held.spy)).toEqual([]);
    vi.setSystemTime(NOW);
    // A yes that is marked: the sensitive path, grouped and counted.
    const marked = {
      kv: kvWith({}).kv,
      spy: dbSpy({
        customer: { sensitive: 1, kept_sections: JSON.stringify(KEPT), special_category: 1 },
      }),
    };
    await post(marked, "medora", ev("variant_shown", "/products/ginseng"));
    expect(rowOf(eventRows(marked.spy)[0]).page_path).toBe("/products/:item");
    expect(pageDayRows(marked.spy)).toHaveLength(1);
    // No, unanswered, or no row: as sent, as before.
    for (const customer of [
      { sensitive: 0, special_category: 0 },
      { sensitive: 0, special_category: null },
      { sensitive: 0 },
      null,
    ]) {
      const t = { kv: kvWith({}).kv, spy: dbSpy({ customer }) };
      await post(t, "acme", ev("variant_shown", "/products/ginseng", { variant_key: "k" }));
      const row = rowOf(eventRows(t.spy)[0]);
      expect([row.page_path, row.variant_key], JSON.stringify(customer)).toEqual([
        "/products/ginseng",
        "k",
      ]);
    }
    // The read fails: nothing is known, the row is stored fail closed as today.
    const down = { kv: kvWith({}).kv, spy: dbSpy({ customer: "throw" }) };
    await post(down, "acme", ev("variant_shown", "/products/ginseng", { variant_key: "k" }));
    const row = rowOf(eventRows(down.spy)[0]);
    expect([row.page_path, row.variant_key]).toEqual([FAIL_CLOSED_PATH, null]);
  });

  it("the bundle wins over the row: a bundle without ne stores, whatever the database would say", async () => {
    const t = {
      kv: kvWith({ [visitorBundleKey("acme")]: bundle() }).kv,
      spy: dbSpy({ customer: { sensitive: 0, special_category: 1 } }),
    };
    await post(t, "acme", ev("variant_shown", "/products/ginseng"));
    expect(t.spy.firsts).toEqual([]);
    expect(eventRows(t.spy)).toHaveLength(1);
  });

  it("over the limit, malformed, a deleted customer: nothing either, as for anyone", async () => {
    const held = {
      kv: kvWith({ [visitorBundleKey("acme")]: bundle({ ne: 1 }) }).kv,
      spy: dbSpy(),
      limiter: "deny" as const,
    };
    await post(held, "acme", ev("variant_shown", "/"));
    await post({ ...held, limiter: "allow" }, "acme", { event_type: "nope", page_path: "/" });
    expect(held.spy.prepared).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

describe("the bundle read and the settings", () => {
  it("keeps the six fields only, and says whether a bundle was read", async () => {
    const { kv, gets } = kvWith({
      [visitorBundleKey("a")]: bundle({ ...SENSITIVE, h: 20, pm: { "/x": ["proof", 1] } }),
      [visitorBundleKey("b")]: { v: 2, s: 1 },
      [visitorBundleKey("d")]: bundle({ ne: 1, h: 20, g: ["/products/*"] }),
    });
    const a = await eventBundleFor(kv, "a", NOW);
    expect(a).toEqual({ readable: true, fields: SENSITIVE });
    expect(await eventBundleFor(kv, "d", NOW)).toEqual({ readable: true, fields: { ne: 1 } });
    expect(sensitiveOfBundle(a)).toEqual({ sensitive: true, kept: KEPT });
    // Not a bundle: its `s` is not believed, the database is asked.
    const b = await eventBundleFor(kv, "b", NOW);
    expect(b.readable).toBe(false);
    expect(sensitiveOfBundle(b)).toBeNull();
    const none = await eventBundleFor(kv, "c", NOW);
    expect(none).toEqual({ readable: false, fields: null });
    expect(sensitiveOfBundle(none)).toBeNull();
    // Memory for five minutes, a missing key too.
    await eventBundleFor(kv, "a", NOW + EVENT_BUNDLE_MEMO_MS - 1);
    await eventBundleFor(kv, "c", NOW + EVENT_BUNDLE_MEMO_MS - 1);
    expect(gets).toHaveLength(4);
    await eventBundleFor(kv, "a", NOW + EVENT_BUNDLE_MEMO_MS + 1);
    expect(gets).toHaveLength(5);
  });

  it("a read bundle without s is not sensitive: no database read follows", () => {
    expect(sensitiveOfBundle({ readable: true, fields: {} })).toEqual({
      sensitive: false,
      kept: [],
    });
    // Only the literal 1 marks it.
    for (const s of [0, true, "1", 2, null]) {
      expect(
        sensitiveOfBundle({ readable: true, fields: { s } as never })?.sensitive,
        String(s),
      ).toBe(false);
    }
  });

  it("eventCustomerFromD1: the row decides, a failure is null and is not remembered", async () => {
    const yes = dbSpy({ customer: { sensitive: 1, kept_sections: '["/products","/about"]' } });
    const marked = {
      settings: { sensitive: true, kept: KEPT },
      ne: false,
      countryOff: false,
      directOff: false,
    };
    expect(await eventCustomerFromD1(yes.db, "x", NOW)).toEqual(marked);
    expect(await eventCustomerFromD1(yes.db, "x", NOW + SENSITIVE_MEMO_MS - 1)).toEqual(marked);
    expect(yes.firsts).toEqual([{ sql: EVENT_CUSTOMER_SQL, args: ["x"] }]);
    const down = dbSpy({ customer: "throw" });
    expect(await eventCustomerFromD1(down.db, "x", NOW)).toBeNull();
    expect(await eventCustomerFromD1(down.db, "x", NOW)).toBeNull();
    expect(down.firsts).toHaveLength(2);
  });

  it("eventCustomerFrom and customerOfBundle: ne only for a yes that is not marked", () => {
    const plain = { sensitive: false, kept: [] };
    expect(eventCustomerFrom(null)).toEqual({
      settings: plain,
      ne: false,
      countryOff: false,
      directOff: false,
    });
    expect(eventCustomerFrom({ special_category: 1, sensitive: 0 })).toEqual({
      settings: plain,
      ne: true,
      countryOff: false,
      directOff: false,
    });
    expect(eventCustomerFrom({ special_category: 1, sensitive: null })).toEqual({
      settings: plain,
      ne: true,
      countryOff: false,
      directOff: false,
    });
    // Marked: the sensitive path, never ne.
    expect(
      eventCustomerFrom({ special_category: 1, sensitive: 1, kept_sections: '["/about"]' }),
    ).toEqual({
      settings: { sensitive: true, kept: ["/about"] },
      ne: false,
      countryOff: false,
      directOff: false,
    });
    for (const special_category of [0, null, undefined, 2]) {
      expect(eventCustomerFrom({ special_category, sensitive: 0 }).ne).toBe(false);
    }
    expect(customerOfBundle({ readable: false, fields: null })).toBeNull();
    expect(customerOfBundle({ readable: true, fields: {} })).toEqual({
      settings: plain,
      ne: false,
      countryOff: false,
      directOff: false,
    });
    expect(customerOfBundle({ readable: true, fields: { ne: 1 } })).toEqual({
      settings: plain,
      ne: true,
      countryOff: false,
      directOff: false,
    });
    expect(customerOfBundle({ readable: true, fields: { ne: 1, s: 1, sk: KEPT } })).toEqual({
      settings: { sensitive: true, kept: KEPT },
      ne: true,
      countryOff: false,
      directOff: false,
    });
    // Only the literal 1 marks it.
    for (const ne of [0, true, "1", 2, null]) {
      expect(customerOfBundle({ readable: true, fields: { ne } as never })?.ne, String(ne)).toBe(
        false,
      );
    }
  });
  it("the country switch rides in the same facts: co in the bundle, country_off in the row", () => {
    const plain = { sensitive: false, kept: [] };
    expect(customerOfBundle({ readable: true, fields: { co: 1 } })).toEqual({
      settings: plain,
      ne: false,
      countryOff: true,
      directOff: false,
    });
    expect(eventCustomerFrom({ country_off: 1 })?.countryOff).toBe(true);
    for (const country_off of [0, null, undefined, 2]) {
      expect(eventCustomerFrom({ country_off }).countryOff).toBe(false);
    }
    expect(EVENT_CUSTOMER_SQL).toContain("country_off");
  });

  it("the direct-insights switch rides in the same facts: dx in the bundle, direct_insights_off in the row (ADR 0038)", () => {
    const plain = { sensitive: false, kept: [] };
    expect(customerOfBundle({ readable: true, fields: { dx: 1 } })).toEqual({
      settings: plain,
      ne: false,
      countryOff: false,
      directOff: true,
    });
    expect(eventCustomerFrom({ direct_insights_off: 1 }).directOff).toBe(true);
    expect(eventCustomerFrom({ direct_insights_off: 1 }).countryOff).toBe(false);
    for (const direct_insights_off of [0, null, undefined, 2]) {
      expect(eventCustomerFrom({ direct_insights_off }).directOff).toBe(false);
    }
    expect(EVENT_CUSTOMER_SQL).toContain("direct_insights_off");
  });

  it("storedEventPage: the three cases", () => {
    const key = variantKeyForPath("x", "/", "problem", "ai");
    expect(storedEventPage(null, "x", "variant_shown", "/", key, NOW)).toEqual({
      page_path: "/:item",
      variant_key: null,
      pageDay: null,
    });
    expect(
      storedEventPage({ sensitive: false, kept: [] }, "x", "variant_shown", "/A/b/", "k", NOW),
    ).toEqual({ page_path: "/A/b/", variant_key: "k", pageDay: null });
    expect(
      storedEventPage({ sensitive: true, kept: KEPT }, "x", "variant_shown", "/A/b/", key, NOW),
    ).toEqual({ page_path: "/:item", variant_key: key, pageDay: ["x", DAY, "/a/b"] });
    expect(
      storedEventPage({ sensitive: true, kept: KEPT }, "x", "conversion", "/about", null, NOW),
    ).toEqual({ page_path: "/about", variant_key: null, pageDay: null });
  });
});

// ---------------------------------------------------------------------------
// Nothing tells a browser (condition 5)
// ---------------------------------------------------------------------------

describe("the answers and the script are byte identical with s set and unset", () => {
  const ID = "medora";
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/129.0";
  const CHATGPT = "&utm_source=chatgpt.com&ref=https%3A%2F%2Fchatgpt.com";
  const base = (extra: Record<string, unknown> = {}) =>
    bundle({
      pages: { "/": MANIFEST, "/products": MANIFEST },
      pm: { "/approach": ["proof", 1] },
      sd: ["evaluation", "feature", "problem", "brand"],
      ...extra,
    });
  const data = (b: Record<string, unknown>) => ({
    [visitorBundleKey(ID)]: b,
    [hideRulesKey(ID)]: '{"/":["h1"],"/products":["h1"]}',
    [variantKeyForPath(ID, "/", "problem", "ai")]: VARIANT,
    [variantKeyForPath(ID, "/products", "problem", "ai")]: VARIANT,
    [variantKeyForPath(ID, "/", "evaluation", "social")]: VARIANT,
    [`v1:customer:${ID}:lang`]: "az",
  });

  /** Everything a browser can see of an answer, and what the edge did to make it. */
  async function ask(
    path: string,
    b: Record<string, unknown>,
    headers: Record<string, string> = {},
    cf?: Record<string, unknown>,
  ) {
    const { kv, gets, puts } = kvWith(data(b));
    const spy = dbSpy();
    const { ctx, waits } = ctxCollect();
    const req = new Request(`https://edge.test${path}`, {
      headers: { "user-agent": UA, ...headers },
    });
    if (cf) Object.defineProperty(req, "cf", { value: cf });
    const res = await worker.fetch(
      req,
      {
        VARIANTS: kv,
        DB: spy.db,
        ENVIRONMENT: "test",
        PREVIEW_TOKEN: "",
        HOLDOUT_PERCENT: "0",
      } as never,
      ctx,
    );
    await Promise.all(waits);
    const seen: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      // Durations of our own reads; the clock is pinned, they are equal too.
      seen[k] = v;
    });
    return {
      status: res.status,
      text: await res.text(),
      headers: seen,
      gets,
      puts: puts.map((p) => p.key),
      sql: spy.prepared,
    };
  }

  const WITH: [string, Record<string, unknown>][] = [
    ["s and sk", { s: 1, sk: KEPT }],
    ["s alone", { s: 1 }],
    ["s and a list of many", { s: 1, sk: ["/about", "/blog", "/contact", "/products", "/verify"] }],
    // The readiness check's "no events" (readiness-check.md, condition 4).
    ["ne alone", { ne: 1 }],
    ["s, sk and ne", { s: 1, sk: KEPT, ne: 1 }],
    // The country switch (ADR 0036, point 6): for the edge's /event alone.
    ["co alone", { co: 1 }],
    ["co with s, sk and ne", { co: 1, s: 1, sk: KEPT, ne: 1 }],
    // The direct-insights switch (ADR 0038, part 1): for the edge's /event alone.
    ["dx alone", { dx: 1 }],
    ["dx with co, s, sk and ne", { dx: 1, co: 1, s: 1, sk: KEPT, ne: 1 }],
  ];

  const select = (q: string) => `/select?customer_id=${ID}&self_host=example.com${q}`;
  const MARKERS = [...Array(16)].map((_, i) => i.toString(16).repeat(32));
  const SELECTS: [string, string, Record<string, unknown>][] = [
    ["no signal on /", select("&path=%2F"), {}],
    ["no signal on a product page", select("&path=%2Fproducts%2Fginseng"), {}],
    ["no signal on a kept section", select("&path=%2Fproducts"), {}],
    ["a version on /", select(`&path=%2F&visit=${VISIT}${CHATGPT}`), {}],
    ["a version on a kept section", select(`&path=%2Fproducts${CHATGPT}`), {}],
    ["a product page that borrows the root's", select(`&path=%2Fproducts%2Fginseng${CHATGPT}`), {}],
    ["no version yet", select("&path=%2F&utm_source=newsletter&utm_medium=email"), {}],
    ["another language", select(`&path=%2F&plang=en${CHATGPT}`), {}],
    ["a carried page", select("&path=%2F&carry=evaluation:social"), {}],
    ["a carried product page", select("&path=%2Fproducts%2Fginseng&carry=evaluation:social"), {}],
    ["the site map's page", select("&path=%2Fapproach"), {}],
    // Sixteen markers at 50%: both arms are among them (checked below).
    ...MARKERS.map((v): [string, string, Record<string, unknown>] => [
      `the holdout at 50%, marker ${v.slice(0, 2)}`,
      select(`&path=%2F&visit=${v}${CHATGPT}`),
      { h: 50 },
    ]),
  ];

  describe.each(WITH)("with %s", (_label, flag) => {
    it.each(SELECTS)("/select: %s", async (_name, path, extra) => {
      const plain = await ask(path, base(extra));
      const marked = await ask(path, base({ ...extra, ...flag }));
      expect(marked.text).toBe(plain.text);
      expect(marked.status).toBe(plain.status);
      expect(marked.headers).toEqual(plain.headers);
      // The same reads, no write, no database: the flag costs /select nothing.
      expect(marked.gets).toEqual(plain.gets);
      expect(marked.puts).toEqual([]);
      expect(marked.sql).toEqual([]);
      expect(plain.sql).toEqual([]);
    });

    it("/select: a bot", async () => {
      const bot = { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" };
      const plain = await ask(select("&path=%2F"), base(), bot);
      const marked = await ask(select("&path=%2F"), base(flag), bot);
      expect(marked.text).toBe(plain.text);
      expect(marked.headers).toEqual(plain.headers);
    });

    it("/s/{id}.js: the body, the etag and the cache policy", async () => {
      const plain = await ask(`/s/${ID}.js`, base());
      const marked = await ask(`/s/${ID}.js`, base(flag));
      expect(marked.text).toBe(plain.text);
      expect(marked.headers.etag).toBe(plain.headers.etag);
      expect(marked.headers).toEqual(plain.headers);
      expect(marked.gets).toEqual(plain.gets);
      // And a 304 to the other's etag, in both directions.
      const again = await ask(`/s/${ID}.js`, base(flag), {
        "if-none-match": plain.headers.etag ?? "",
      });
      expect(again.status).toBe(304);
    });

    it("/carry: the segment's copy", async () => {
      const path = `/carry?customer_id=${ID}&carry=problem:ai`;
      const plain = await ask(path, base());
      const marked = await ask(path, base(flag));
      expect(Object.keys(JSON.parse(plain.text).bodies)).toEqual(["/", "/products"]);
      expect(marked.text).toBe(plain.text);
      expect(marked.headers).toEqual(plain.headers);
      expect(marked.gets).toEqual(plain.gets);
    });
  });

  // ADR 0036: the country is never used to choose a version, and no answer
  // or script carries it. The same request from three countries and none.
  it.each(SELECTS.slice(0, 11))(
    "/select from any country, the same answer: %s",
    async (_n, path) => {
      const none = await ask(path, base());
      for (const country of ["AZ", "US", "T1", "XX"]) {
        const from = await ask(path, base(), {}, { country, timezone: "UTC" });
        expect(from.text, country).toBe(none.text);
        expect(from.headers, country).toEqual(none.headers);
        expect(from.text).not.toMatch(/country|"AZ"|"US"/);
      }
    },
  );

  it("/s/{id}.js and /carry from any country, the same body", async () => {
    for (const path of [`/s/${ID}.js`, `/carry?customer_id=${ID}&carry=problem:ai`]) {
      const none = await ask(path, base());
      const from = await ask(path, base(), {}, { country: "GB" });
      expect(from.text, path).toBe(none.text);
      expect(from.headers, path).toEqual(none.headers);
    }
  });

  it("the answers hold versions at all (the comparison is not of two empty answers)", async () => {
    const shown = JSON.parse((await ask(select(`&path=%2F${CHATGPT}`), base(SENSITIVE))).text);
    expect(shown.source).toBe("kv");
    expect(shown.targets).toBeDefined();
    const held = MARKERS.map(async (v) => {
      const a = await ask(select(`&path=%2F&visit=${v}${CHATGPT}`), base({ h: 50, ...SENSITIVE }));
      return JSON.parse(a.text).arm as string;
    });
    expect([...new Set(await Promise.all(held))].sort()).toEqual(["holdout", "treat"]);
  });

  it("no answer and no script names the flag, the list or a list entry it would not name anyway", async () => {
    const flag = { s: 1, sk: ["/about", "/zz-kept-only-here"], ne: 1, co: 1, dx: 1 };
    for (const path of [
      select(`&path=%2F${CHATGPT}`),
      select("&path=%2Fzz-kept-only-here"),
      `/s/${ID}.js`,
      `/carry?customer_id=${ID}&carry=problem:ai`,
    ]) {
      const a = await ask(path, base(flag));
      const head = a.text.slice(0, a.text.indexOf("\n") === -1 ? undefined : a.text.indexOf("\n"));
      expect(head, path).not.toContain("zz-kept-only-here");
      expect(head, path).not.toMatch(/"sk?":/);
      // Nor `ne`, nor the two readiness words it stands for (condition 4).
      expect(head, path).not.toMatch(/"ne":|goes|special_category/);
      // Nor the country switch, nor a country (ADR 0036).
      expect(head, path).not.toMatch(/"co":|country/);
      // Nor the direct-insights switch, a device word or the web-view bit (ADR 0038).
      expect(head, path).not.toMatch(/"dx":|device_class|web_view/);
      expect(JSON.stringify(a.headers), path).not.toContain("zz-kept");
      expect(JSON.stringify(a.headers), path).not.toMatch(/"ne"|goes|special_category/);
    }
  });

  it("an event a browser could see: the 202 is the same with ne set and unset", async () => {
    for (const type of EVENT_TYPES) {
      const seen = async (b: Record<string, unknown>) => {
        const { kv } = kvWith({ [visitorBundleKey(ID)]: b });
        const { ctx, waits } = ctxCollect();
        const res = await worker.fetch(
          new Request(`https://edge.test/event?cid=${ID}`, {
            method: "POST",
            headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://example.com" },
            body: JSON.stringify(ev(type, "/products/ginseng")),
          }),
          { VARIANTS: kv, DB: dbSpy().db, ENVIRONMENT: "test", PREVIEW_TOKEN: "" } as never,
          ctx,
        );
        await Promise.all(waits);
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return { status: res.status, text: await res.text(), headers };
      };
      const plain = await seen(base());
      expect(await seen(base({ ne: 1 })), type).toEqual(plain);
      expect(await seen(base({ ...SENSITIVE, ne: 1 })), type).toEqual(plain);
      expect(await seen(base({ co: 1 })), type).toEqual(plain);
      expect(await seen(base({ dx: 1 })), type).toEqual(plain);
      expect(JSON.stringify(plain)).not.toMatch(/"ne"|goes|special_category/);
    }
  });

  it("/select-bulk reads no bundle and answers the same", async () => {
    const one = async (b: Record<string, unknown>) => {
      const { kv, gets } = kvWith({
        [visitorBundleKey("own-site")]: b,
        "v1:variant:own-site:problem:ai": VARIANT,
      });
      const res = await worker.fetch(
        new Request("https://edge.test/select-bulk?customer_id=own-site"),
        {
          VARIANTS: kv,
          DB: dbSpy().db,
          ENVIRONMENT: "test",
          PREVIEW_TOKEN: "",
          OWN_SITE_CUSTOMER: "own-site",
        } as never,
        ctxCollect().ctx,
      );
      return { text: await res.text(), gets, cache: res.headers.get("cache-control") };
    };
    const plain = await one(bundle());
    const marked = await one(bundle(SENSITIVE));
    expect(JSON.parse(plain.text).variants).toHaveLength(1);
    expect(marked.text).toBe(plain.text);
    expect(marked.cache).toBe(plain.cache);
    expect(marked.gets).not.toContain(visitorBundleKey("own-site"));
    // Any other customer is refused, sensitive or not.
    const other = await worker.fetch(
      new Request(`https://edge.test/select-bulk?customer_id=${ID}`),
      {
        VARIANTS: kvWith(data(base(SENSITIVE))).kv,
        DB: dbSpy().db,
        OWN_SITE_CUSTOMER: "own-site",
      } as never,
      ctxCollect().ctx,
    );
    expect(other.status).toBe(403);
  });

  it("the three files that build what a browser gets never read the flag", () => {
    for (const file of ["customer-script.ts", "visitor-manifest.ts", "body-carry.ts"]) {
      const src = readFileSync(resolve(__dirname, "../src", file), "utf8");
      expect(src, file).not.toMatch(/sensitive|\.sk\b|\bsk:|\.s\b(?!\w)/i);
      expect(src, file).not.toMatch(/\.ne\b|\bne:|NoEvents|special_category|\bgoes\b:/);
      expect(src, file).not.toMatch(/\.co\b|\bco:|country/i);
    }
    // /select names it once, for the learning counters.
    const index = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
    expect(index.match(/mayCountAcrossCustomers\(/g)).toHaveLength(1);
    expect(index).not.toMatch(/bundleSensitive|\.sk\b|storedPath/);
    expect(index).not.toMatch(/\.ne\b|\bne:|NoEvents|special_category/);
  });
});

// ---------------------------------------------------------------------------
// /select stores nothing with a path
// ---------------------------------------------------------------------------

describe("/select for a sensitive customer stores nothing that names a page", () => {
  it("no row, no statement and no KV write on a product page, with a version or without", async () => {
    for (const q of [
      "",
      "&utm_source=chatgpt.com&ref=https%3A%2F%2Fchatgpt.com",
      "&carry=problem:ai",
    ]) {
      const { kv, puts } = kvWith({
        [visitorBundleKey("medora")]: bundle(SENSITIVE),
        [variantKeyForPath("medora", "/", "problem", "ai")]: VARIANT,
      });
      const spy = dbSpy();
      const { ctx, waits } = ctxCollect();
      const res = await worker.fetch(
        new Request(
          `https://edge.test/select?customer_id=medora&path=%2Fproducts%2Fginseng&visit=${VISIT}${q}`,
          { headers: { "user-agent": "Mozilla/5.0 Chrome/129.0" } },
        ),
        {
          VARIANTS: kv,
          DB: spy.db,
          ENVIRONMENT: "test",
          PREVIEW_TOKEN: "",
          UA_TOKEN_LEARNING: "on",
          SOURCE_LEARNING: "on",
        } as never,
        ctx,
      );
      await Promise.all(waits);
      expect(res.status).toBe(200);
      expect(spy.prepared, q).toEqual([]);
      expect(puts, q).toEqual([]);
    }
  });

  it("without a bundle the write-back's key is the customer's and its value names no visited page", async () => {
    const { kv, puts } = kvWith({});
    const spy = dbSpy({ customer: { sensitive: 1, kept_sections: JSON.stringify(KEPT) } });
    const { ctx, waits } = ctxCollect();
    await worker.fetch(
      new Request(
        `https://edge.test/select?customer_id=medora&path=%2Fproducts%2Fginseng&visit=${VISIT}`,
        { headers: { "user-agent": "Mozilla/5.0 Chrome/129.0" } },
      ),
      { VARIANTS: kv, DB: spy.db, ENVIRONMENT: "test", PREVIEW_TOKEN: "" } as never,
      ctx,
    );
    await Promise.all(waits);
    expect(puts.map((p) => p.key)).toEqual([visitorBundleKey("medora")]);
    expect(puts[0]?.value).not.toContain("ginseng");
    expect(puts[0]?.value).not.toContain(VISIT);
    // The write-back reads only, and each read is bound to the customer id
    // alone: the page of this visit is in none of them.
    expect(spy.runs).toEqual([]);
    expect(spy.batches).toEqual([]);
    expect(JSON.stringify(spy.firsts)).not.toContain("ginseng");
  });
});

// ---------------------------------------------------------------------------
// No cross-customer count
// ---------------------------------------------------------------------------

describe("the learning counters skip a sensitive customer", () => {
  const ON = { UA_TOKEN_LEARNING: "on", SOURCE_LEARNING: "on" };
  const ua =
    "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36 BrandNewApp/3.1";
  const QUERIES = [
    "",
    "&utm_source=partner-xyz",
    "&carry=problem:ai",
    "&ref=https%3A%2F%2Fnew-forum.example",
  ];

  async function counted(b: Record<string, unknown> | null, q: string, path = "%2F") {
    const { kv, gets } = kvWith({
      ...(b ? { [visitorBundleKey("co")]: b } : {}),
      [variantKeyForPath("co", "/", "problem", "ai")]: VARIANT,
    });
    const spy = dbSpy();
    const { ctx, waits } = ctxCollect();
    await worker.fetch(
      new Request(
        `https://edge.test/select?customer_id=co&path=${path}&self_host=example.com${q}`,
        {
          headers: { "user-agent": ua },
        },
      ),
      { VARIANTS: kv, DB: spy.db, ENVIRONMENT: "test", PREVIEW_TOKEN: "", ...ON } as never,
      ctx,
    );
    await Promise.all(waits);
    const rows = [...spy.runs, ...spy.batches.flat()];
    return {
      counters: rows.filter((r) => /ua_token_counts|signal_token_counts/.test(r.sql)),
      prepared: spy.prepared.filter((s) => /ua_token_counts|signal_token_counts/.test(s)),
      gets,
    };
  }

  it("a customer that is not sensitive counts (control)", async () => {
    expect((await counted(bundle(), "")).counters.length).toBeGreaterThan(0);
    const tagged = await counted(bundle(), "&utm_source=partner-xyz");
    expect(tagged.counters.some((r) => r.sql.includes("signal_token_counts"))).toBe(true);
    expect(tagged.counters.some((r) => r.sql.includes("ua_token_counts"))).toBe(true);
  });

  it("a sensitive customer counts nothing, on any page and any kind of visit", async () => {
    for (const flag of [SENSITIVE, { s: 1 }]) {
      for (const q of QUERIES) {
        for (const path of ["%2F", "%2Fproducts%2Fginseng", "%2Fproducts"]) {
          const r = await counted(bundle(flag), q, path);
          expect(r.counters, `${q} ${path}`).toEqual([]);
          expect(r.prepared, `${q} ${path}`).toEqual([]);
        }
      }
    }
  });

  it("the flag is read from the bundle in hand: the same KV reads as a plain customer", async () => {
    for (const q of QUERIES) {
      const plain = await counted(bundle(), q);
      const marked = await counted(bundle(SENSITIVE), q);
      expect(marked.gets, q).toEqual(plain.gets);
    }
  });

  it("no readable bundle: nothing is known, nothing is counted, nothing is read to find out", async () => {
    for (const b of [null, { v: 2 }]) {
      for (const q of QUERIES) {
        const r = await counted(b, q);
        expect(r.counters, q).toEqual([]);
      }
    }
  });

  it("a customer whose bundle says ne counts nothing either (readiness-check.md, condition 2)", async () => {
    for (const flag of [{ ne: 1 }, { ne: 1, ...SENSITIVE }]) {
      for (const q of QUERIES) {
        for (const path of ["%2F", "%2Fproducts%2Fginseng"]) {
          const r = await counted(bundle(flag), q, path);
          expect(r.counters, `${q} ${path}`).toEqual([]);
          expect(r.prepared, `${q} ${path}`).toEqual([]);
          expect(r.gets, `${q} ${path}`).toEqual((await counted(bundle(), q, path)).gets);
        }
      }
    }
  });

  it("mayCountAcrossCustomers: only a read bundle that says neither s nor ne", () => {
    expect(mayCountAcrossCustomers(bundle() as never)).toBe(true);
    expect(mayCountAcrossCustomers(bundle(SENSITIVE) as never)).toBe(false);
    expect(mayCountAcrossCustomers(bundle({ s: 1 }) as never)).toBe(false);
    expect(mayCountAcrossCustomers(bundle({ ne: 1 }) as never)).toBe(false);
    expect(mayCountAcrossCustomers(bundle({ ne: 0 }) as never)).toBe(true);
    expect(mayCountAcrossCustomers(null)).toBe(false);
    expect(mayCountAcrossCustomers(undefined)).toBe(false);
    expect(mayCountAcrossCustomers({ v: 2, pages: {}, conv: [] } as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The write-back bundle
// ---------------------------------------------------------------------------

describe("a bundle the edge writes back carries s and sk", () => {
  function seed(sensitive: number, kept: string | null) {
    const { d1, db } = makeSqliteD1();
    db.prepare(
      "INSERT INTO customers (id, slug, domain, status, created_at, sensitive, kept_sections) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("medora", "medora", "medora.test", "active", 1, sensitive, kept);
    db.prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at) VALUES (?, ?, ?, ?, 'https://medora.test/', 1)",
    ).run("medora", "/", JSON.stringify(MANIFEST), 1);
    return d1;
  }
  /** The same database, with the flag's read failing (a table the edge cannot read yet). */
  function failingFlagRead(d1: D1Database): D1Database {
    return {
      prepare(sql: string) {
        if (sql === SENSITIVE_CUSTOMER_SQL) {
          const stmt = {
            bind: () => stmt,
            first: async () => {
              throw new Error("no such column: sensitive");
            },
          };
          return stmt;
        }
        return d1.prepare(sql);
      },
      batch: (s: never) => d1.batch(s),
    } as unknown as D1Database;
  }

  it("a sensitive customer: s 1 and the list, sorted as stored", async () => {
    const d1 = seed(1, JSON.stringify(KEPT));
    const built = await bundleFromD1({ DB: d1, VARIANTS: kvWith({}).kv }, "medora");
    expect(built.s).toBe(1);
    expect(built.sk).toEqual(KEPT);
    expect(Object.keys(built.pages)).toEqual(["/"]);
  });

  it("a sensitive customer with no list: s 1 and no sk (every page but / is grouped)", async () => {
    for (const kept of [null, "", "not json", "[]"]) {
      const built = await bundleFromD1({ DB: seed(1, kept), VARIANTS: kvWith({}).kv }, "medora");
      expect(built.s).toBe(1);
      expect(built).not.toHaveProperty("sk");
    }
  });

  it("a customer that is not sensitive: neither field, whatever its list column holds", async () => {
    for (const kept of [null, JSON.stringify(KEPT)]) {
      const built = await bundleFromD1({ DB: seed(0, kept), VARIANTS: kvWith({}).kv }, "medora");
      expect(built).not.toHaveProperty("s");
      expect(built).not.toHaveProperty("sk");
      expect(Object.keys(built).sort()).toEqual(["conv", "pages", "v"]);
    }
  });

  it("/select without a bundle writes one back with s and sk, and /event then groups from it", async () => {
    const d1 = seed(1, JSON.stringify(KEPT));
    const store: Record<string, unknown> = {};
    const { kv, puts } = kvWith(store);
    const { ctx, waits } = ctxCollect();
    await worker.fetch(
      new Request("https://edge.test/select?customer_id=medora&path=%2Fproducts%2Fginseng", {
        headers: { "user-agent": "Mozilla/5.0 Chrome/129.0" },
      }),
      { VARIANTS: kv, DB: d1, ENVIRONMENT: "test", PREVIEW_TOKEN: "" } as never,
      ctx,
    );
    await Promise.all(waits);
    expect(puts.map((p) => p.key)).toEqual([visitorBundleKey("medora")]);
    const written = JSON.parse(puts[0]?.value ?? "null");
    expect([written.v, written.s, written.sk]).toEqual([1, 1, KEPT]);

    // The next isolate reads that bundle: no database read for the flag.
    const next = kvWith({ [visitorBundleKey("medora")]: written });
    const t = { kv: next.kv, spy: dbSpy({ customer: "throw" }) };
    await post(t, "medora", ev("variant_shown", "/products/ginseng"));
    expect(t.spy.firsts).toEqual([]);
    expect(rowOf(eventRows(t.spy)[0]).page_path).toBe("/products/:item");
  });

  it("the flag's read fails: no bundle is written at all, never one without s", async () => {
    const d1 = failingFlagRead(seed(1, JSON.stringify(KEPT)));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(bundleFromD1({ DB: d1, VARIANTS: kvWith({}).kv }, "medora")).rejects.toThrow();
    const { kv, puts } = kvWith({});
    await writeBundleFromD1({ DB: d1, VARIANTS: kv }, "medora");
    expect(puts).toEqual([]);
    // /carry's read: no bundle to answer from, and nothing written back.
    const deferred: Promise<void>[] = [];
    expect(await bundleForAnswer({ DB: d1, VARIANTS: kv }, "medora", (w) => deferred.push(w))).toBe(
      null,
    );
    expect(deferred).toEqual([]);
    expect(puts).toEqual([]);
    err.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The write-back bundle and `ne` (readiness-check.md, "As approved")
// ---------------------------------------------------------------------------

describe("a bundle the edge writes back carries ne by the shared rule", () => {
  function seed(special: number | null, sensitive: number, kept: string | null = null) {
    const { d1, db } = makeSqliteD1();
    db.prepare(
      "INSERT INTO customers (id, slug, domain, status, created_at, sensitive, kept_sections, special_category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("acme", "acme", "acme.test", "active", 1, sensitive, kept, special);
    db.prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at) VALUES (?, ?, ?, ?, 'https://acme.test/', 1)",
    ).run("acme", "/", JSON.stringify(MANIFEST), 1);
    return d1;
  }
  /** The same database, with the `ne` read failing (the column the edge cannot read yet). */
  function failingNoEventsRead(d1: D1Database): D1Database {
    return {
      prepare(sql: string) {
        if (sql === BUNDLE_NO_EVENTS_SQL) {
          const stmt = {
            bind: () => stmt,
            first: async () => {
              throw new Error("no such column: special_category");
            },
          };
          return stmt;
        }
        return d1.prepare(sql);
      },
      batch: (s: never) => d1.batch(s),
    } as unknown as D1Database;
  }
  const env = (d1: D1Database) => ({ DB: d1, VARIANTS: kvWith({}).kv });

  it("a yes that is not marked: ne 1, last, and no s", async () => {
    const built = await bundleFromD1(env(seed(1, 0)), "acme");
    expect(built.ne).toBe(1);
    expect(built).not.toHaveProperty("s");
    expect(Object.keys(built)).toEqual(["v", "pages", "conv", "ne"]);
  });

  it("a yes that is marked: s and sk, no ne (the sensitive path takes over)", async () => {
    const built = await bundleFromD1(env(seed(1, 1, JSON.stringify(KEPT))), "acme");
    expect([built.s, built.sk]).toEqual([1, KEPT]);
    expect(built).not.toHaveProperty("ne");
  });

  it("no, unanswered, or an unmarked customer with no answer: the bundle it had", async () => {
    for (const special of [0, null]) {
      const built = await bundleFromD1(env(seed(special, 0)), "acme");
      expect(built).not.toHaveProperty("ne");
      // A "no" also gets page one's `dp` and the memory's `rm` (direct-visitors.md §6, §2), never `ne`.
      expect(Object.keys(built).sort()).toEqual(
        special === 0 ? ["conv", "dp", "pages", "rm", "v"] : ["conv", "pages", "v"],
      );
    }
  });

  it("/select without a bundle writes one back with ne, and /event then stores nothing from it", async () => {
    const d1 = seed(1, 0);
    const { kv, puts } = kvWith({});
    const { ctx, waits } = ctxCollect();
    const res = await worker.fetch(
      new Request("https://edge.test/select?customer_id=acme&path=%2Fproducts%2Fginseng", {
        headers: { "user-agent": "Mozilla/5.0 Chrome/129.0" },
      }),
      { VARIANTS: kv, DB: d1, ENVIRONMENT: "test", PREVIEW_TOKEN: "" } as never,
      ctx,
    );
    await Promise.all(waits);
    // The answer is the one any customer without versions gets.
    expect(res.status).toBe(200);
    expect(await res.text()).not.toMatch(/"ne"|special_category/);
    expect(puts.map((p) => p.key)).toEqual([visitorBundleKey("acme")]);
    const written = JSON.parse(puts[0]?.value ?? "null");
    expect([written.v, written.ne]).toEqual([1, 1]);

    // The next isolate reads that bundle: no database read, no row.
    const next = kvWith({ [visitorBundleKey("acme")]: written });
    const t = { kv: next.kv, spy: dbSpy({ customer: "throw" }) };
    for (const type of EVENT_TYPES) await post(t, "acme", ev(type, "/products/ginseng"));
    expect(t.spy.prepared).toEqual([]);
  });

  it("the ne read fails: no bundle is written at all, never one without ne (fail closed, like s)", async () => {
    const d1 = failingNoEventsRead(seed(1, 0));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(bundleFromD1(env(d1), "acme")).rejects.toThrow();
    const { kv, puts } = kvWith({});
    await writeBundleFromD1({ DB: d1, VARIANTS: kv }, "acme");
    expect(puts).toEqual([]);
    const deferred: Promise<void>[] = [];
    expect(await bundleForAnswer({ DB: d1, VARIANTS: kv }, "acme", (w) => deferred.push(w))).toBe(
      null,
    );
    expect(deferred).toEqual([]);
    err.mockRestore();
  });
});
