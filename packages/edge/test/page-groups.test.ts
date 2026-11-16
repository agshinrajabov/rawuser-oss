/**
 * Page groups, phase 1, the edge side (docs/specs/page-groups.md):
 *
 * - the write-back bundle carries `g` (the accepted patterns, sorted,
 *   absent when none), and a `page_groups` table the edge cannot read
 *   (migration 0043 not applied) leaves the bundle exactly as today;
 * - `/select` without a bundle offers a group's `count:` target from the
 *   database on a matching page only, and writes `g` back;
 * - privacy review condition 5: a `conversion` row never writes `page_days`, and
 *   a sensitive customer's group click is stored as the group
 *   (`/products/:item`) by the existing rule.
 */
import { visitorBundleKey } from "@rawuser/shared";
import { describe, expect, it, vi } from "vitest";
import { makeSqliteD1 } from "../../generation/test/admin/sqlite-d1.ts";
import {
  BUNDLE_PAGE_GROUPS_SQL,
  bundleForAnswer,
  bundleFromD1,
  writeBundleFromD1,
} from "../src/bundle-writeback.ts";
import worker from "../src/index.ts";

const VISIT = "0123456789abcdef0123456789abcdef";
/** A version for the personalised path: the only answer the database serves targets to without a bundle. */
const VERSION = {
  customer_id: "medora",
  profile_key: "intent:problem:ai",
  sections: { hero: { kind: "hero", headline: "New" } },
  generated_at: 1,
  prompt_hash: "h",
  body_id: "0123456789abcdef",
};
const VERSION_KV = { "v1:variant:medora:problem:ai": VERSION };
const AI = { referer: "https://chatgpt.com/c/chat" };
const MANIFEST = { "hero.headline": { css: ["h1"], text: ["Old"], structural: "first h1" } };
const PATTERN = "/products/*";

function seed(opts: { groups?: string[]; sensitive?: boolean; kept?: string[] } = {}) {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    "INSERT INTO customers (id, slug, domain, status, created_at, sensitive, kept_sections) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "medora",
    "medora",
    "medora.test",
    "active",
    1,
    opts.sensitive ? 1 : 0,
    opts.kept ? JSON.stringify(opts.kept) : null,
  );
  db.prepare(
    "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at) VALUES (?, ?, ?, ?, 'https://medora.test/', 1)",
  ).run("medora", "/", JSON.stringify(MANIFEST), 1);
  const target = db.prepare(
    `INSERT INTO conversion_targets (customer_id, section_path, label, conversion_label, css_selectors, text_selectors, structural_selector, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`,
  );
  target.run("medora", "hero.cta", "Start", "signup", JSON.stringify(["a.cta"]), "[]", "");
  for (const g of opts.groups ?? []) {
    db.prepare("INSERT INTO page_groups (customer_id, pattern, created_at) VALUES (?, ?, ?)").run(
      "medora",
      g,
      1,
    );
    target.run("medora", `count:${g}`, "Əlaqə", "contact", JSON.stringify(["nav a"]), "[]", "");
  }
  return { d1, db };
}

/** The same database, with the page groups' read failing (a table the edge cannot read yet). */
function missingGroupsTable(d1: D1Database): D1Database {
  return {
    prepare(sql: string) {
      if (sql === BUNDLE_PAGE_GROUPS_SQL) {
        const stmt = {
          bind: () => stmt,
          all: async () => {
            throw new Error("no such table: page_groups");
          },
        };
        return stmt;
      }
      return d1.prepare(sql);
    },
    batch: (s: never) => d1.batch(s),
  } as unknown as D1Database;
}

function kvWith(data: Record<string, unknown>) {
  const puts: { key: string; value: string }[] = [];
  const kv = {
    async get(key: string, o?: string | { type?: string }) {
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
  return { kv, puts };
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

async function call(
  d1: D1Database,
  kv: KVNamespace,
  path: string,
  init: RequestInit = {},
): Promise<{ body: Record<string, unknown>; text: string }> {
  const { ctx, waits } = ctxCollect();
  const resp = await worker.fetch(
    new Request(`https://edge.test${path}`, {
      ...init,
      headers: { "user-agent": "Mozilla/5.0 Chrome/129.0", ...(init.headers ?? {}) },
    }),
    { VARIANTS: kv, DB: d1, ENVIRONMENT: "test", PREVIEW_TOKEN: "" } as never,
    ctx,
  );
  await Promise.all(waits);
  const text = await resp.text();
  return { body: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : {}, text };
}

const names = (body: Record<string, unknown>) =>
  ((body.conversion_targets as { section_path: string }[] | undefined) ?? []).map(
    (t) => t.section_path,
  );

describe("the write-back bundle carries g (page-groups.md, Data)", () => {
  it("the accepted patterns, sorted, with the group's target in conv", async () => {
    const { d1 } = seed({ groups: ["/services/*", PATTERN] });
    const built = await bundleFromD1({ DB: d1, VARIANTS: kvWith({}).kv }, "medora");
    expect(built.g).toEqual([PATTERN, "/services/*"]);
    expect(built.conv.map((t) => t.section_path).sort()).toEqual([
      "count:/products/*",
      "count:/services/*",
      "hero.cta",
    ]);
    expect(Object.keys(built).sort()).toEqual(["conv", "g", "pages", "v"]);
  });

  it("a customer without groups: no g, the bundle exactly as before", async () => {
    const { d1 } = seed();
    const built = await bundleFromD1({ DB: d1, VARIANTS: kvWith({}).kv }, "medora");
    expect(built).not.toHaveProperty("g");
    expect(Object.keys(built).sort()).toEqual(["conv", "pages", "v"]);
  });

  it("the table cannot be read (0043 not applied): the bundle is written without g, nothing else lost", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const d1 = missingGroupsTable(seed({ groups: [PATTERN] }).d1);
    const built = await bundleFromD1({ DB: d1, VARIANTS: kvWith({}).kv }, "medora");
    expect(built).not.toHaveProperty("g");
    expect(Object.keys(built).sort()).toEqual(["conv", "pages", "v"]);
    // The target is still in conv: the edge matches from it alone.
    expect(built.conv.map((t) => t.section_path)).toContain(`count:${PATTERN}`);
    const { kv, puts } = kvWith({});
    await writeBundleFromD1({ DB: d1, VARIANTS: kv }, "medora");
    expect(puts.map((p) => p.key)).toEqual([visitorBundleKey("medora")]);
    expect(JSON.parse(puts[0]?.value ?? "null")).not.toHaveProperty("g");
    const deferred: Promise<void>[] = [];
    const answered = await bundleForAnswer({ DB: d1, VARIANTS: kv }, "medora", (w) =>
      deferred.push(w),
    );
    expect(answered?.v).toBe(1);
    expect(deferred).toHaveLength(1);
    expect(err).toHaveBeenCalledWith("[rawuser/edge] page groups read failed (non-critical)");
    err.mockRestore();
  });

  it("a sensitive customer's bundle carries s, sk and g together", async () => {
    const { d1 } = seed({ groups: [PATTERN], sensitive: true, kept: ["/products"] });
    const built = await bundleFromD1({ DB: d1, VARIANTS: kvWith({}).kv }, "medora");
    expect([built.s, built.sk, built.g]).toEqual([1, ["/products"], [PATTERN]]);
  });
});

describe("/select without a bundle: the group's target from the database", () => {
  it("offered on a matching page, written back with g; absent on / and on /products", async () => {
    const { d1 } = seed({ groups: [PATTERN] });
    const { kv, puts } = kvWith(VERSION_KV);
    const on = await call(d1, kv, "/select?customer_id=medora&path=%2Fproducts%2Fginseng", {
      headers: AI,
    });
    expect(on.body.cohort).toBe("personalized");
    expect(names(on.body)).toEqual(["hero.cta", `count:${PATTERN}`]);
    expect(on.body).not.toHaveProperty("g");
    const written = JSON.parse(
      puts.find((p) => p.key === visitorBundleKey("medora"))?.value ?? "null",
    );
    expect(written.g).toEqual([PATTERN]);

    for (const path of ["/", "/products", "/products/x/reviews"]) {
      const off = await call(
        d1,
        kvWith(VERSION_KV).kv,
        `/select?customer_id=medora&path=${encodeURIComponent(path)}`,
        { headers: AI },
      );
      expect(off.body.cohort, path).toBe("personalized");
      expect(names(off.body), path).toEqual(["hero.cta"]);
      expect(off.text, path).not.toContain("products/*");
    }
  });

  it("a confirmed page under the pattern gets nothing from the group, from the database too", async () => {
    const { d1, db } = seed({ groups: [PATTERN] });
    db.prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at) VALUES (?, ?, ?, ?, 'https://medora.test/', 1)",
    ).run("medora", "/products/featured", JSON.stringify(MANIFEST), 1);
    const { body, text } = await call(
      d1,
      kvWith(VERSION_KV).kv,
      "/select?customer_id=medora&path=%2Fproducts%2Ffeatured",
      { headers: AI },
    );
    expect(body.cohort).toBe("personalized");
    expect(names(body)).toEqual(["hero.cta"]);
    expect(text).not.toContain("products/*");
  });
});

describe("a group's click (privacy review condition 5)", () => {
  const conversion = (page_path: string) => ({
    event_type: "conversion",
    page_path,
    conversion_label: "contact",
    cohort: "no_signal",
    visit: VISIT,
  });

  it("a conversion row never writes page_days; a sensitive customer's is stored as the group", async () => {
    const { d1, db } = seed({ groups: [PATTERN], sensitive: true, kept: ["/products"] });
    const { kv } = kvWith({
      [visitorBundleKey("medora")]: await bundleFromD1(
        { DB: d1, VARIANTS: kvWith({}).kv },
        "medora",
      ),
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await call(d1, kv, "/event?cid=medora", {
      method: "POST",
      body: JSON.stringify(conversion("/products/ginseng")),
    });
    await call(d1, kv, "/event?cid=medora", {
      method: "POST",
      body: JSON.stringify(conversion("/products/48213377")),
    });
    err.mockRestore();
    const rows = db
      .prepare("SELECT event_type, page_path, conversion_label FROM events ORDER BY rowid")
      .all();
    expect(rows).toEqual([
      { event_type: "conversion", page_path: "/products/:item", conversion_label: "contact" },
      { event_type: "conversion", page_path: "/products/:item", conversion_label: "contact" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM page_days").get()).toEqual({ n: 0 });
  });

  it("an ordinary customer's conversion keeps the masked page and writes page_days nowhere", async () => {
    const { d1, db } = seed({ groups: [PATTERN] });
    const { kv } = kvWith({
      [visitorBundleKey("medora")]: await bundleFromD1(
        { DB: d1, VARIANTS: kvWith({}).kv },
        "medora",
      ),
    });
    await call(d1, kv, "/event?cid=medora", {
      method: "POST",
      body: JSON.stringify(conversion("/products/48213377")),
    });
    expect(db.prepare("SELECT page_path FROM events").all()).toEqual([
      { page_path: "/products/:id" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM page_days").get()).toEqual({ n: 0 });
  });
});
