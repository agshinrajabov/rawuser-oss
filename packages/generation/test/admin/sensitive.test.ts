/**
 * The sensitive flag and the kept sections (docs/specs/sensitive-customers.md,
 * "The endpoint (as built)"): superadmin only, the list validated, the flag
 * refused while a confirmed page or a counted picked button stands outside
 * `/` and the list, the hide rules and the visitor bundle rewritten at once
 * with `s` and `sk`, the bundle of any other customer byte for byte what it
 * was, a customer marked at creation, and the export and the delete carrying
 * the counter and both columns. Real SQL on node:sqlite.
 */
import { visitorBundleKey } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness } from "../proof-harness.ts";
import { makeKv } from "./sqlite-d1.ts";

type User = { id: string; email: string; role: string; customer_id: string | null };
const SUPERADMIN: User = {
  id: "u1",
  email: "f@example.com",
  role: "superadmin",
  customer_id: null,
};
const MEDORA: User = { id: "u2", email: "c@medora.test", role: "customer", customer_id: "medora" };
let sessionUser: User = SUPERADMIN;

vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionUser),
}));
vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(),
  regenerateOne: vi.fn(),
}));

const { default: worker } = await import("../../src/index.ts");
const { writeVisitorBundle } = await import("../../src/admin/onboard.ts");
const { CUSTOMER_TABLES, countCustomerData, deleteCustomerData, exportLines, postRestoreSql } =
  await import("../../src/admin/customer-data.ts");
const { KEPT_SECTIONS_LINE } = await import("../../src/admin/sensitive.ts");

let h: Harness;
beforeEach(() => {
  h = harness();
  h.customer("medora");
  h.customer("acme");
  sessionUser = SUPERADMIN;
});
afterEach(() => {
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
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const MANIFEST = JSON.stringify({
  "hero.headline": { css: ["h1"], text: ["Old"], structural: "first h1" },
});

function page(customer: string, path: string, confirmed: boolean) {
  h.db
    .prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at) VALUES (?, ?, ?, 'https://x.test/', 1, ?)",
    )
    .run(customer, path, MANIFEST, confirmed ? 5 : null);
}

function picked(customer: string, pagePath: string, enabled: 0 | 1) {
  h.db
    .prepare(
      `INSERT INTO conversion_targets (customer_id, section_path, label, conversion_label, enabled,
         css_selectors, text_selectors, structural_selector, created_at, updated_at)
       VALUES (?, ?, 'Order', 'other', ?, '["a.order"]', '["Order"]', 'a.order', 1, 1)`,
    )
    .run(customer, `count:${pagePath}`, enabled);
}

const stored = (id: string) =>
  h.db.prepare("SELECT sensitive, kept_sections FROM customers WHERE id = ?").get(id) as {
    sensitive: number;
    kept_sections: string | null;
  };

const bundle = (id: string) => JSON.parse(h.kv.get(visitorBundleKey(id)) ?? "null");

const SET = "/admin/customers/sensitive";

describe("the endpoint's gate and validation", () => {
  it("is superadmin only, for the read and the write", async () => {
    sessionUser = MEDORA;
    expect((await call("GET", `${SET}?customer_id=medora`)).status).toBe(403);
    const w = await call("POST", SET, { customer_id: "medora", sensitive: true });
    expect(w.status).toBe(403);
    expect(stored("medora")).toEqual({ sensitive: 0, kept_sections: null });
    expect(h.kv.has(visitorBundleKey("medora"))).toBe(false);
  });

  it("asks for a customer that exists and for something to set", async () => {
    expect((await call("GET", SET)).status).toBe(400);
    expect((await call("GET", `${SET}?customer_id=nobody`)).status).toBe(404);
    expect((await call("POST", SET, { sensitive: true })).status).toBe(400);
    expect((await call("POST", SET, { customer_id: "nobody", sensitive: true })).status).toBe(404);
    const empty = await call("POST", SET, { customer_id: "medora" });
    expect(empty).toEqual({
      status: 400,
      json: { error: "Give sensitive, kept_sections or both" },
    });
    const flag = await call("POST", SET, { customer_id: "medora", sensitive: 1 });
    expect(flag).toEqual({ status: 400, json: { error: "sensitive must be true or false" } });
  });

  it.each([
    ["not a list", "/products"],
    ["a query", ["/products?x=1"]],
    ["a group's own path", ["/products/:item"]],
    ["no leading slash", ["products"]],
    ["an identifier segment", ["/orders/482"]],
    ["a dot segment", ["/a/../b"]],
    ["five segments deep", ["/a/b/c/d/e"]],
    ["fifty-one entries", Array.from({ length: 51 }, (_, i) => `/s${"x".repeat(i + 1)}`)],
  ])("refuses a list with %s and stores nothing", async (_name, list) => {
    const r = await call("POST", SET, {
      customer_id: "medora",
      sensitive: true,
      kept_sections: list,
    });
    expect(r).toEqual({ status: 400, json: { error: KEPT_SECTIONS_LINE } });
    expect(stored("medora")).toEqual({ sensitive: 0, kept_sections: null });
  });
});

describe("POST /admin/customers/sensitive", () => {
  it("stores the flag and the list normalized, sorted, each once, and answers with them", async () => {
    const r = await call("POST", SET, {
      customer_id: "medora",
      sensitive: true,
      kept_sections: ["/Products/", "/about", "/", "/products", "/blog"],
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      customer_id: "medora",
      sensitive: true,
      kept_sections: ["/about", "/blog", "/products"],
      outside: { pages: [], counted: [] },
      limits: { sections: 50, length: 200, depth: 4 },
      changed: true,
      versions_marked_stale: 0,
      rows_to_rewrite: null,
      warning: null,
    });
    expect(stored("medora")).toEqual({
      sensitive: 1,
      kept_sections: '["/about","/blog","/products"]',
    });
    const read = await call("GET", `${SET}?customer_id=medora`);
    expect(read.status).toBe(200);
    expect(read.json).toEqual({
      customer_id: "medora",
      sensitive: true,
      kept_sections: ["/about", "/blog", "/products"],
      outside: { pages: [], counted: [] },
      limits: { sections: 50, length: 200, depth: 4 },
    });
  });

  it("writes the hide rules and the bundle at once, with s and sk", async () => {
    page("medora", "/", true);
    const r = await call("POST", SET, {
      customer_id: "medora",
      sensitive: true,
      kept_sections: ["/products"],
    });
    expect(r.status).toBe(200);
    expect(bundle("medora")).toMatchObject({ v: 1, s: 1, sk: ["/products"] });
    expect(JSON.parse(h.kv.get("v1:hide:medora") ?? "null")).toEqual({ "/": ["h1"] });
    // The list alone, later: the bundle follows at once.
    await call("POST", SET, { customer_id: "medora", kept_sections: ["/products", "/about"] });
    expect(bundle("medora").sk).toEqual(["/about", "/products"]);
    expect(stored("medora").sensitive).toBe(1);
  });

  it("an empty list is stored as NULL and the bundle carries s without sk", async () => {
    const r = await call("POST", SET, { customer_id: "medora", sensitive: true });
    expect(r.status).toBe(200);
    expect(stored("medora")).toEqual({ sensitive: 1, kept_sections: null });
    const b = bundle("medora");
    expect(b.s).toBe(1);
    expect(b).not.toHaveProperty("sk");
    const emptied = await call("POST", SET, { customer_id: "medora", kept_sections: [] });
    expect(emptied.json.kept_sections).toEqual([]);
    expect(emptied.json.changed).toBe(false);
  });

  it("the same settings again change no row and write the bundle again", async () => {
    await call("POST", SET, { customer_id: "medora", sensitive: true, kept_sections: ["/blog"] });
    h.kv.delete(visitorBundleKey("medora"));
    const again = await call("POST", SET, {
      customer_id: "medora",
      sensitive: true,
      kept_sections: ["/blog"],
    });
    expect(again.status).toBe(200);
    expect(again.json.changed).toBe(false);
    expect(bundle("medora")).toMatchObject({ s: 1, sk: ["/blog"] });
  });

  it("refuses to turn the flag on with a confirmed page outside / and the list, naming it", async () => {
    page("medora", "/", true);
    page("medora", "/pricing", true);
    page("medora", "/products/ginseng", true);
    page("medora", "/draft", false);
    page("acme", "/acme-only", true);
    const r = await call("POST", SET, {
      customer_id: "medora",
      sensitive: true,
      kept_sections: ["/products"],
    });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({
      error:
        "Remove these pages or add their sections to the list first: /pricing, /products/ginseng.",
      code: "pages_outside",
      pages: ["/pricing", "/products/ginseng"],
      counted: [],
    });
    expect(stored("medora")).toEqual({ sensitive: 0, kept_sections: null });
    expect(h.kv.has(visitorBundleKey("medora"))).toBe(false);
    // The read says what stands in the way while the flag is off.
    const read = await call("GET", `${SET}?customer_id=medora`);
    expect(read.json.outside).toEqual({
      pages: ["/pricing", "/products/ginseng"],
      counted: [],
    });
  });

  it("passes once the page is removed or its own path is listed", async () => {
    page("medora", "/", true);
    page("medora", "/pricing", true);
    const listed = await call("POST", SET, {
      customer_id: "medora",
      sensitive: true,
      kept_sections: ["/pricing"],
    });
    expect(listed.status).toBe(200);
    expect(bundle("medora")).toMatchObject({ s: 1, sk: ["/pricing"] });
  });

  it("a counted button picked on a page outside the list blocks too; one switched off does not", async () => {
    picked("medora", "/products/ginseng", 1);
    picked("medora", "/old", 0);
    const r = await call("POST", SET, { customer_id: "medora", sensitive: true });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({
      code: "pages_outside",
      pages: [],
      counted: ["/products/ginseng"],
    });
    h.db.prepare("UPDATE conversion_targets SET enabled = 0").run();
    expect((await call("POST", SET, { customer_id: "medora", sensitive: true })).status).toBe(200);
  });

  it("a list that would leave a confirmed page outside is refused while the flag is on", async () => {
    page("medora", "/about", true);
    await call("POST", SET, { customer_id: "medora", sensitive: true, kept_sections: ["/about"] });
    const r = await call("POST", SET, { customer_id: "medora", kept_sections: ["/blog"] });
    expect(r.status).toBe(409);
    expect(r.json.pages).toEqual(["/about"]);
    expect(stored("medora").kept_sections).toBe('["/about"]');
    expect(bundle("medora").sk).toEqual(["/about"]);
  });

  const THEN =
    'Wait ten minutes for the edge to take the change, then run the rewrite statements and POST /admin/proof/backfill with what: "outcomes".';

  it("warns when stored rows need the rewrite: a customer marked after its first visit", async () => {
    h.ev({ customer: "medora", ts: 10, type: "variant_shown", page: "/products/ginseng" });
    const r = await call("POST", SET, {
      customer_id: "medora",
      sensitive: true,
      kept_sections: ["/products"],
    });
    expect(r.status).toBe(200);
    expect(r.json.rows_to_rewrite).toEqual({ why: "marked", removed: [] });
    expect(r.json.warning).toBe(
      `This customer already has visits, and their rows may name a page. ${THEN}`,
    );
    // The endpoint itself rewrites no row.
    expect(h.db.prepare("SELECT page_path FROM events").all()).toEqual([
      { page_path: "/products/ginseng" },
    ]);
    // Sent again, nothing new is left behind.
    const again = await call("POST", SET, { customer_id: "medora", sensitive: true });
    expect(again.json.rows_to_rewrite).toBeNull();
    expect(again.json.warning).toBeNull();
  });

  it("warns when a section is taken off the list of a customer with rows; adding one is free", async () => {
    await call("POST", SET, {
      customer_id: "medora",
      sensitive: true,
      kept_sections: ["/about", "/blog", "/products"],
    });
    // No event row yet: a shorter list leaves nothing behind.
    const early = await call("POST", SET, {
      customer_id: "medora",
      kept_sections: ["/about", "/blog"],
    });
    expect(early.json).toMatchObject({ changed: true, rows_to_rewrite: null, warning: null });
    h.ev({ customer: "medora", ts: 10, type: "variant_shown", page: "/about" });
    const longer = await call("POST", SET, {
      customer_id: "medora",
      kept_sections: ["/about", "/blog", "/products", "/contact"],
    });
    expect(longer.json).toMatchObject({ changed: true, rows_to_rewrite: null, warning: null });
    const shorter = await call("POST", SET, {
      customer_id: "medora",
      kept_sections: ["/products", "/contact"],
    });
    expect(shorter.status).toBe(200);
    expect(shorter.json.kept_sections).toEqual(["/contact", "/products"]);
    expect(shorter.json.rows_to_rewrite).toEqual({
      why: "shortened",
      removed: ["/about", "/blog"],
    });
    expect(shorter.json.warning).toBe(
      `Rows stored before this change still name the removed sections. ${THEN}`,
    );
    // With the flag off a shorter list leaves nothing to rewrite.
    await call("POST", SET, { customer_id: "medora", sensitive: false });
    const off = await call("POST", SET, { customer_id: "medora", kept_sections: [] });
    expect(off.json).toMatchObject({ rows_to_rewrite: null, warning: null });
  });

  it("the list may be set first, with the flag off: nothing is checked and no s is written", async () => {
    page("medora", "/pricing", true);
    const r = await call("POST", SET, { customer_id: "medora", kept_sections: ["/products"] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      sensitive: false,
      kept_sections: ["/products"],
      outside: { pages: ["/pricing"], counted: [] },
    });
    expect(bundle("medora")).not.toHaveProperty("s");
    expect(bundle("medora")).not.toHaveProperty("sk");
  });

  it("turning it off is allowed, keeps the list, drops s and sk, and touches no stored row", async () => {
    await call("POST", SET, {
      customer_id: "medora",
      sensitive: true,
      kept_sections: ["/products"],
    });
    h.ev({ customer: "medora", ts: 10, type: "variant_shown", page: "/products/:item" });
    h.db
      .prepare(
        "INSERT INTO page_days (customer_id, day, page_path, loads) VALUES ('medora', '2026-10-12', '/products/ginseng', 3)",
      )
      .run();
    const events = h.db.prepare("SELECT * FROM events").all();
    const days = h.db.prepare("SELECT * FROM page_days").all();
    const off = await call("POST", SET, { customer_id: "medora", sensitive: false });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({
      sensitive: false,
      kept_sections: ["/products"],
      changed: true,
    });
    expect(stored("medora")).toEqual({ sensitive: 0, kept_sections: '["/products"]' });
    expect(bundle("medora")).not.toHaveProperty("s");
    expect(bundle("medora")).not.toHaveProperty("sk");
    expect(h.db.prepare("SELECT * FROM events").all()).toEqual(events);
    expect(h.db.prepare("SELECT * FROM page_days").all()).toEqual(days);
  });

  it("turning it on marks the ready versions stale for the claims lock, and says how many", async () => {
    // docs/specs/claims-lock.md: the versions were written without the lock.
    const ins = h.db.prepare(
      "INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status) SELECT ?, ?, id, ?, 'model-a', 'h', 1, 0.001, ? FROM intent_profiles WHERE profile_key = 'intent:problem' AND customer_id IS NULL",
    );
    ins.run("e1", "medora", "v1:variant:medora:problem:default", "ready");
    ins.run("e2", "medora", "v1:variant:medora:problem:ai", "ready");
    ins.run("e3", "medora", "v1:variant:medora:problem:social", "error");
    ins.run("a1", "acme", "v1:variant:acme:problem:default", "ready");
    const status = () =>
      Object.fromEntries(
        (
          h.db.prepare("SELECT id, status FROM variants ORDER BY id").all() as Array<{
            id: string;
            status: string;
          }>
        ).map((r) => [r.id, r.status]),
      );

    const on = await call("POST", SET, { customer_id: "medora", sensitive: true });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ changed: true, versions_marked_stale: 2 });
    expect(status()).toEqual({ a1: "ready", e1: "stale", e2: "stale", e3: "error" });

    // Staying on, or a list change, marks nothing more.
    const again = await call("POST", SET, { customer_id: "medora", kept_sections: ["/about"] });
    expect(again.json).toMatchObject({ changed: true, versions_marked_stale: 0 });
    h.db.prepare("UPDATE variants SET status = 'ready' WHERE customer_id = 'medora'").run();
    const same = await call("POST", SET, { customer_id: "medora", sensitive: true });
    expect(same.json).toMatchObject({ changed: false, versions_marked_stale: 0 });
    // Off touches no version.
    const off = await call("POST", SET, { customer_id: "medora", sensitive: false });
    expect(off.json).toMatchObject({ changed: true, versions_marked_stale: 0 });
    expect(status()).toEqual({ a1: "ready", e1: "ready", e2: "ready", e3: "ready" });
  });

  it("removes the old bundle and answers 500 when the new one cannot be written", async () => {
    await writeVisitorBundle(h.env, "medora");
    expect(bundle("medora")).not.toHaveProperty("s");
    const put = h.env.VARIANTS.put;
    h.env.VARIANTS.put = (async () => {
      throw new Error("kv down");
    }) as never;
    const r = await call("POST", SET, { customer_id: "medora", sensitive: true });
    h.env.VARIANTS.put = put;
    expect(r.status).toBe(500);
    expect(stored("medora").sensitive).toBe(1);
    // No bundle: the edge asks the database and fails closed.
    expect(h.kv.has(visitorBundleKey("medora"))).toBe(false);
    expect((await call("POST", SET, { customer_id: "medora", sensitive: true })).status).toBe(200);
    expect(bundle("medora").s).toBe(1);
  });
});

describe("the visitor bundle", () => {
  function seedAcme() {
    h.db.prepare("UPDATE customers SET holdout_percent = 20 WHERE id = 'acme'").run();
    page("acme", "/", true);
    h.db
      .prepare(
        `INSERT INTO conversion_targets (customer_id, section_path, label, conversion_label, enabled,
           css_selectors, text_selectors, structural_selector, created_at, updated_at)
         VALUES ('acme', 'hero.cta', 'Start', 'trial_start', 1, '["a.cta"]', '[]', 'a.cta', 1, 1)`,
      )
      .run();
  }

  /** The bundle as it was written before this change, to the byte. */
  const AS_BEFORE =
    '{"v":1,"pages":{"/":{"hero.headline":{"css":["h1"],"text":["Old"],"structural":"first h1"}}},' +
    '"conv":[{"section_path":"hero.cta","conversion_label":"trial_start","css":["a.cta"],"text":[],"structural":"a.cta"}],' +
    '"h":20}';

  it("of a customer that is not sensitive is byte for byte what it was", async () => {
    seedAcme();
    // Page one's `dp` and the memory's `rm` (direct-visitors.md §6, §2) are not this test's subject.
    h.db.prepare("UPDATE customers SET page_one_off = 1, remember_off = 1 WHERE id = 'acme'").run();
    await writeVisitorBundle(h.env, "acme");
    expect(h.kv.get(visitorBundleKey("acme"))).toBe(AS_BEFORE);
  });

  it("is the same bytes again with a list stored and the flag off", async () => {
    seedAcme();
    // Page one's `dp` and the memory's `rm` (direct-visitors.md §6, §2) are not this test's subject.
    h.db.prepare("UPDATE customers SET page_one_off = 1, remember_off = 1 WHERE id = 'acme'").run();
    h.db.prepare("UPDATE customers SET kept_sections = '[\"/products\"]' WHERE id = 'acme'").run();
    await writeVisitorBundle(h.env, "acme");
    expect(h.kv.get(visitorBundleKey("acme"))).toBe(AS_BEFORE);
  });

  it("of a sensitive customer is the same bundle with s and sk after it, from the customers row", async () => {
    seedAcme();
    h.db
      .prepare(
        "UPDATE customers SET sensitive = 1, remember_off = 1, kept_sections = '[\"/about\",\"/products\"]' WHERE id = 'acme'",
      )
      .run();
    await writeVisitorBundle(h.env, "acme");
    expect(h.kv.get(visitorBundleKey("acme"))).toBe(
      `${AS_BEFORE.slice(0, -1)},"s":1,"sk":["/about","/products"]}`,
    );
  });

  it("is not written at all when the flag cannot be read", async () => {
    seedAcme();
    await writeVisitorBundle(h.env, "acme");
    const before = h.kv.get(visitorBundleKey("acme"));
    const prepare = h.d1.prepare.bind(h.d1);
    const failing = {
      ...h.d1,
      prepare: (sql: string) => {
        if (sql.startsWith("SELECT sensitive, kept_sections")) throw new Error("no such column");
        return prepare(sql);
      },
    } as unknown as D1Database;
    await expect(
      writeVisitorBundle({ DB: failing, VARIANTS: h.env.VARIANTS }, "acme"),
    ).rejects.toThrow();
    expect(h.kv.get(visitorBundleKey("acme"))).toBe(before);
  });
});

describe("a customer marked at creation (superadmin's create only)", () => {
  const CREATE = "/admin/customers/create";

  it("is sensitive from its first row, with the list, and its bundle is written", async () => {
    const r = await call("POST", CREATE, {
      slug: "herbal",
      domain: "herbal.test",
      sensitive: true,
      kept_sections: ["/shop", "/about/"],
    });
    expect(r.status).toBe(201);
    expect(r.json.customer).toMatchObject({
      id: "herbal",
      sensitive: true,
      kept_sections: ["/about", "/shop"],
    });
    expect(stored("herbal")).toEqual({ sensitive: 1, kept_sections: '["/about","/shop"]' });
    expect(bundle("herbal")).toEqual({
      v: 1,
      pages: {},
      conv: [],
      s: 1,
      sk: ["/about", "/shop"],
      // No `rm`: this install set neither REMEMBER_DEFAULT nor
      // REMEMBER_ON_SENSITIVE, so no code is kept in a visitor's browser
      // (test/remember-install.test.ts holds both values).
    });
  });

  it("without the field nothing changes: no flag, no bundle, the same answer", async () => {
    const r = await call("POST", CREATE, { slug: "plain", domain: "plain.test" });
    expect(r.status).toBe(201);
    expect(r.json.customer).not.toHaveProperty("sensitive");
    expect(r.json.customer).not.toHaveProperty("kept_sections");
    expect(stored("plain")).toEqual({ sensitive: 0, kept_sections: null });
    expect(h.kv.has(visitorBundleKey("plain"))).toBe(false);
    const off = await call("POST", CREATE, {
      slug: "plain2",
      domain: "plain2.test",
      sensitive: false,
    });
    expect(off.status).toBe(201);
    expect(stored("plain2")).toEqual({ sensitive: 0, kept_sections: null });
  });

  it("refuses a bad flag, a bad list and a list without the flag, and creates nothing", async () => {
    const bad = [
      { sensitive: "yes" },
      { sensitive: true, kept_sections: ["/orders/482"] },
      { kept_sections: ["/shop"] },
      { sensitive: false, kept_sections: ["/shop"] },
    ];
    for (const extra of bad) {
      const r = await call("POST", CREATE, { slug: "nope", domain: "nope.test", ...extra });
      expect(r.status).toBe(400);
    }
    expect(h.db.prepare("SELECT id FROM customers WHERE id = 'nope'").get()).toBeUndefined();
  });

  it("stays superadmin only", async () => {
    sessionUser = MEDORA;
    const r = await call("POST", CREATE, { slug: "x", domain: "x.test", sensitive: true });
    expect(r.status).toBe(403);
  });
});

describe("the export and the delete", () => {
  function seed() {
    h.db
      .prepare(
        "UPDATE customers SET sensitive = 1, kept_sections = '[\"/products\"]' WHERE id = 'medora'",
      )
      .run();
    const day = h.db.prepare(
      "INSERT INTO page_days (customer_id, day, page_path, loads) VALUES (?, ?, ?, ?)",
    );
    day.run("medora", "2026-10-11", "/products/ginseng", 4);
    day.run("medora", "2026-10-11", "/products/:item", 2);
    day.run("medora", "2026-10-12", "/", 9);
    h.db
      .prepare(
        "UPDATE customers SET sensitive = 1, kept_sections = '[\"/docs\"]' WHERE id = 'acme'",
      )
      .run();
    day.run("acme", "2026-10-12", "/docs/start", 1);
  }
  const envOf = () => ({ DB: h.d1, VARIANTS: makeKv() });

  it("the catalog lists page_days by customer, before the customers row", () => {
    const tables = CUSTOMER_TABLES.map((t) => t.table);
    expect(CUSTOMER_TABLES.find((t) => t.table === "page_days")).toEqual({
      table: "page_days",
      by: "customer_id",
    });
    expect(tables.indexOf("page_days")).toBeLessThan(tables.indexOf("customers"));
  });

  it("the export carries the counter's folded days and both columns of the customers row, of that customer only", async () => {
    seed();
    // The counter leaves only for a day whose fold has run, and folded
    // (the privacy review on the build, condition 2): 2026-10-11 has its rollup
    // row and one named product page, which goes into the group's row.
    // 2026-10-12 has none yet and is left out.
    h.db
      .prepare(
        "INSERT INTO exposure_rollup_days (customer_id, day, computed_at, mixed_visits) VALUES ('medora', '2026-10-11', 1, 0)",
      )
      .run();
    const lines: Array<Record<string, unknown>> = [];
    for await (const line of exportLines(envOf(), "medora", new Date(0))) {
      lines.push(JSON.parse(line));
    }
    expect((lines[0]?.tables as string[]).includes("page_days")).toBe(true);
    const days = lines.filter((l) => l.type === "row" && l.table === "page_days");
    expect(days.map((l) => l.row)).toEqual([
      { customer_id: "medora", day: "2026-10-11", page_path: "/products/:item", loads: 6 },
    ]);
    const customer = lines.find((l) => l.type === "row" && l.table === "customers");
    expect(customer?.row).toMatchObject({
      id: "medora",
      sensitive: 1,
      kept_sections: '["/products"]',
    });
    const end = lines[lines.length - 1] as { type: string; rows: Record<string, number> };
    expect(end.type).toBe("end");
    expect(end.rows.page_days).toBe(1);
  });

  it("the dry run counts the counter's rows", async () => {
    seed();
    sessionUser = SUPERADMIN;
    const counts = await countCustomerData(envOf(), "medora");
    expect(counts.d1.page_days).toBe(3);
    expect(counts.d1.customers).toBe(1);
  });

  it("the delete removes the counter and the row with both columns, and nothing of another customer", async () => {
    seed();
    const run = await deleteCustomerData(envOf(), "medora");
    expect(run.done).toBe(true);
    expect(run.deleted.d1.page_days).toBe(3);
    expect(run.deleted.d1.customers).toBe(1);
    expect(h.db.prepare("SELECT * FROM page_days").all()).toEqual([
      { customer_id: "acme", day: "2026-10-12", page_path: "/docs/start", loads: 1 },
    ]);
    expect(h.db.prepare("SELECT id FROM customers WHERE id = 'medora'").get()).toBeUndefined();
    expect(stored("acme")).toEqual({ sensitive: 1, kept_sections: '["/docs"]' });
  });

  it("a restored database deletes a logged customer's counter again", () => {
    const sql = postRestoreSql(["medora"], {
      now: 0,
      failureTtlMs: 0,
      sessionAbsoluteMs: 0,
      sessionIdleMs: 0,
      retentionDays: null,
    });
    expect(sql).toContain("DELETE FROM page_days WHERE customer_id = 'medora';");
    expect(sql.indexOf("DELETE FROM page_days")).toBeLessThan(
      sql.indexOf("DELETE FROM customers WHERE id = 'medora';"),
    );
  });
});
