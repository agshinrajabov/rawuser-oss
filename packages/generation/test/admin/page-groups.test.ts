/**
 * Page groups, phase 1 (docs/specs/page-groups.md): the three group
 * endpoints, the count pick with `group` (adds a counted button, switches
 * none off), the sensitive rule on the pattern, the bundle's `g`, the
 * export and the delete. Real SQL on node:sqlite; the pick posted through
 * the shared receive as the picker does.
 */
import {
  type PickStore,
  hideRulesKey,
  pickCountKey,
  pickTokenKey,
  receivePick,
  visitorBundleKey,
} from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness } from "../proof-harness.ts";
import { makeKv } from "./sqlite-d1.ts";

type User = { id: string; email: string; role: string; customer_id: string | null };
const ACME: User = { id: "u2", email: "c@acme.test", role: "customer", customer_id: "acme" };
const ROOT: User = { id: "u1", email: "a@rawuser.test", role: "superadmin", customer_id: null };
let sessionUser: User = ACME;

vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionUser),
}));

const { default: worker } = await import("../../src/index.ts");
const { SENSITIVE_PAGE_LINE } = await import("../../src/lib/sensitive-guard.ts");
const { foreignPages, sensitiveTargetRefusal, groupRefusalUnder } = await import(
  "../../src/lib/sensitive-guard.ts"
);
const { groupPickAriaOnly, pickGroupKey } = await import("../../src/admin/count-pick.ts");
const { markGroupTargets } = await import("../../src/lib/page-groups.ts");
const { countCustomerData, deleteCustomerData, exportLines } = await import(
  "../../src/admin/customer-data.ts"
);

const LOCK =
  "A test is running, so the buttons it counts cannot change. Stop the test first to change them.";

let h: Harness;
beforeEach(() => {
  h = harness();
  h.customer("acme");
  h.customer("other");
  sessionUser = ACME;
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
  "hero.cta.label": {
    css: ["#start"],
    text: ["Start free"],
    structural: "hero button",
    conversion_candidate: true,
  },
});

function confirmedPage(page: string, customer = "acme") {
  h.db
    .prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at) VALUES (?, ?, ?, 'https://acme.test/', 1, 5)",
    )
    .run(customer, page, MANIFEST);
}

function target(id: string, sectionPath: string, enabled: 0 | 1, customer = "acme") {
  h.db
    .prepare(
      `INSERT INTO conversion_targets (id, customer_id, section_path, label, conversion_label, enabled,
         css_selectors, text_selectors, structural_selector, created_at, updated_at)
       VALUES (?, ?, ?, 'Start free', 'trial_start', ?, '["#start"]', '["Start free"]', 'hero button', 1, 1)`,
    )
    .run(id, customer, sectionPath, enabled);
}

function testRuns() {
  h.db
    .prepare(
      "INSERT INTO holdout_tests (id, customer_id, percent, started_at, created_at) VALUES ('ht_1', 'acme', 20, 1, 1)",
    )
    .run();
}

function aggregate(perPage: unknown, customer = "acme", window = "30d") {
  h.db
    .prepare(
      `INSERT INTO analytics_aggregates (customer_id, window, computed_at, window_start, per_variant, per_intent, per_page)
       VALUES (?, ?, 1, 1, '[]', '[]', ?)`,
    )
    .run(customer, window, JSON.stringify(perPage));
}

function targets(customer = "acme") {
  return h.db
    .prepare(
      "SELECT section_path, label, conversion_label, enabled FROM conversion_targets WHERE customer_id = ? ORDER BY created_at, section_path",
    )
    .all(customer) as Array<Record<string, unknown>>;
}

function groupsStored(customer = "acme") {
  return (
    h.db
      .prepare("SELECT pattern FROM page_groups WHERE customer_id = ? ORDER BY pattern")
      .all(customer) as Array<{ pattern: string }>
  ).map((r) => r.pattern);
}

function bundle() {
  return JSON.parse(h.kv.get(visitorBundleKey("acme")) ?? "null");
}

function markSensitive(kept: string[] = ["/products"]) {
  h.db
    .prepare("UPDATE customers SET sensitive = 1, kept_sections = ? WHERE id = 'acme'")
    .run(JSON.stringify(kept));
}

const store = () => h.env.VARIANTS as unknown as PickStore;
const NAV = { css: ["nav a.contact"], text: ["Contact us"], structural: "first a in nav" };

/** Mint a group link, then post the button as the picker does through the edge. */
async function groupPick(
  group: string,
  page: string,
  button = NAV,
  pickedOn = page,
): Promise<{ token: string; status: number }> {
  const mint = await call("POST", "/admin/conversions/pick-token", {
    customer_id: "acme",
    group,
    page_path: page,
  });
  expect(mint.status).toBe(200);
  const token = mint.json.token as string;
  const posted = await receivePick({ token, button, page_path: pickedOn }, store());
  return { token, status: posted.status };
}

const PER_PAGE = {
  pages: [
    { page_path: "/", visits: 50 },
    { page_path: "/products/a", visits: 9 },
    { page_path: "/products/b", visits: 7 },
    { page_path: "/products/:id", visits: 3 },
  ],
  without_versions: { pages: 3, visits: 19, signal_visits: 2 },
  groups: [
    { pattern: "/products/*", pages: 3, visits: 19 },
    { pattern: "/blog/*", pages: 5, visits: 12 },
    { pattern: "/:id/*", pages: 9, visits: 9 },
  ],
};

// ---------------------------------------------------------------------------

describe("GET /admin/pages/groups", () => {
  it("answers no groups and no proposals without an aggregate", async () => {
    const r = await call("GET", "/admin/pages/groups?customer_id=acme");
    expect(r).toEqual({ status: 200, json: { groups: [], proposals: [], max: 5 } });
  });

  it("lists the accepted groups with their counts and button, the rest as proposals", async () => {
    aggregate(PER_PAGE);
    aggregate({ groups: [{ pattern: "/products/*", pages: 99, visits: 99 }] }, "other");
    expect(
      (await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: "/products/*" }))
        .status,
    ).toBe(200);
    target("g1", "count:/products/*", 1);
    const r = await call("GET", "/admin/pages/groups?customer_id=acme");
    expect(r.status).toBe(200);
    expect(r.json.max).toBe(5);
    expect(r.json.groups).toEqual([
      {
        pattern: "/products/*",
        pages: 3,
        visits: 19,
        counted: expect.objectContaining({
          id: "g1",
          section_path: "count:/products/*",
          enabled: true,
        }),
      },
    ]);
    // A proposal names a pattern, never a path; a bad one from the aggregate is skipped.
    expect(r.json.proposals).toEqual([{ pattern: "/blog/*", pages: 5, visits: 12 }]);
  });

  it("a group the aggregator has not counted has null counts; a bad per_page is empty", async () => {
    await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: "/docs/*" });
    const r = await call("GET", "/admin/pages/groups?customer_id=acme");
    expect(r.json.groups).toEqual([
      { pattern: "/docs/*", pages: null, visits: null, counted: null },
    ]);
    aggregate("not json");
    expect((await call("GET", "/admin/pages/groups?customer_id=acme")).json.proposals).toEqual([]);
  });

  it("is customer-scoped", async () => {
    expect((await call("GET", "/admin/pages/groups?customer_id=other")).status).toBe(403);
    expect((await call("GET", "/admin/pages/groups")).status).toBe(400);
  });
});

describe("POST /admin/pages/groups", () => {
  it("accepts a typed pattern, normalized, idempotent, and writes g into the bundle", async () => {
    const r = await call("POST", "/admin/pages/groups", {
      customer_id: "acme",
      pattern: "/Products/*/",
    });
    expect(r.status).toBe(200);
    expect(r.json.group).toEqual({
      pattern: "/products/*",
      pages: null,
      visits: null,
      counted: null,
    });
    expect(groupsStored()).toEqual(["/products/*"]);
    expect(bundle().g).toEqual(["/products/*"]);
    const again = await call("POST", "/admin/pages/groups", {
      customer_id: "acme",
      pattern: "/products/*",
    });
    expect(again.status).toBe(200);
    expect(groupsStored()).toEqual(["/products/*"]);
    await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: "/blog/*" });
    expect(bundle().g).toEqual(["/blog/*", "/products/*"]);
    // Never in the hide rules the customer script is built from.
    expect(h.kv.get(hideRulesKey("acme")) ?? "").not.toContain("/*");
  });

  it("400 on a pattern that is not one, /* and an identifier segment", async () => {
    for (const pattern of ["/*", "/products", "/a/b/c/*", "/:id/*", "/482/*", "", 7, null]) {
      const r = await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern });
      expect(r.status, String(pattern)).toBe(400);
      expect(r.json.error).toBe(
        "Write the pattern as /section/* or /section/part/*, with one * at the end.",
      );
    }
    expect(groupsStored()).toEqual([]);
    expect(bundle()).toBeNull();
  });

  it("409 on a sixth group", async () => {
    for (const p of ["/a/*", "/b/*", "/c/*", "/d/*", "/e/*"]) {
      expect(
        (await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: p })).status,
      ).toBe(200);
    }
    const r = await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: "/f/*" });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("group_limit");
    expect(groupsStored()).toHaveLength(5);
  });

  it("409 when every page it matches is a confirmed page; passes with another page with visits", async () => {
    confirmedPage("/products/a");
    const r = await call("POST", "/admin/pages/groups", {
      customer_id: "acme",
      pattern: "/products/*",
    });
    expect(r).toMatchObject({ status: 409, json: { code: "group_confirmed_only" } });
    aggregate(PER_PAGE);
    expect(
      (await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: "/products/*" }))
        .status,
    ).toBe(200);
    // A confirmed page elsewhere does not stand in the way.
    confirmedPage("/docs");
    expect(
      (await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: "/docs/*" }))
        .status,
    ).toBe(200);
  });

  it("a sensitive customer: 409 sensitive_page unless the fixed part is a kept section", async () => {
    markSensitive(["/products"]);
    const refused = await call("POST", "/admin/pages/groups", {
      customer_id: "acme",
      pattern: "/blog/*",
    });
    expect(refused).toEqual({
      status: 409,
      json: { error: SENSITIVE_PAGE_LINE, code: "sensitive_page", page_path: "/blog/*" },
    });
    const ok = await call("POST", "/admin/pages/groups", {
      customer_id: "acme",
      pattern: "/products/*",
    });
    expect(ok.status).toBe(200);
    expect(groupsStored()).toEqual(["/products/*"]);
  });

  it("scope and unknown customer", async () => {
    expect(
      (await call("POST", "/admin/pages/groups", { customer_id: "other", pattern: "/x/*" })).status,
    ).toBe(403);
    sessionUser = ROOT;
    expect(
      (await call("POST", "/admin/pages/groups", { customer_id: "nobody", pattern: "/x/*" }))
        .status,
    ).toBe(404);
    expect((await call("POST", "/admin/pages/groups", {})).status).toBe(400);
  });
});

describe("POST /admin/pages/groups/delete", () => {
  it("removes the group and its counted button, rewrites the bundle", async () => {
    await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: "/products/*" });
    target("t_home", "count:/", 1);
    target("g1", "count:/products/*", 1);
    const r = await call("POST", "/admin/pages/groups/delete", {
      customer_id: "acme",
      pattern: "/products/*",
    });
    expect(r).toEqual({
      status: 200,
      json: { ok: true, pattern: "/products/*", target_removed: true },
    });
    expect(groupsStored()).toEqual([]);
    expect(targets().map((t) => t.section_path)).toEqual(["count:/"]);
    expect(bundle().g).toBeUndefined();
    expect(bundle().conv.map((c: { section_path: string }) => c.section_path)).toEqual(["count:/"]);
  });

  it("409 with the test lock while its button is counted and a test runs; passes when the button is off", async () => {
    await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: "/products/*" });
    target("g1", "count:/products/*", 1);
    testRuns();
    const r = await call("POST", "/admin/pages/groups/delete", {
      customer_id: "acme",
      pattern: "/products/*",
    });
    expect(r).toEqual({ status: 409, json: { error: LOCK } });
    expect(groupsStored()).toEqual(["/products/*"]);
    h.db.prepare("UPDATE conversion_targets SET enabled = 0 WHERE id = 'g1'").run();
    expect(
      (
        await call("POST", "/admin/pages/groups/delete", {
          customer_id: "acme",
          pattern: "/products/*",
        })
      ).status,
    ).toBe(200);
    expect(targets()).toEqual([]);
  });

  it("404 for a group not on the list, 400 for no pattern", async () => {
    expect(
      (await call("POST", "/admin/pages/groups/delete", { customer_id: "acme", pattern: "/x/*" }))
        .status,
    ).toBe(404);
    expect((await call("POST", "/admin/pages/groups/delete", { customer_id: "acme" })).status).toBe(
      400,
    );
  });
});

// ---------------------------------------------------------------------------

describe("the count pick with group", () => {
  beforeEach(async () => {
    await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: "/products/*" });
  });

  it("mints a link that opens the page, carries the group, seeds the group's button", async () => {
    target("g0", "count:/products/*", 0);
    const r = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      group: "/products/*",
      page_path: "/products/Ginseng",
    });
    expect(r.status).toBe(200);
    expect(r.json.group).toBe("/products/*");
    expect(r.json.page_path).toBe("/products/ginseng");
    expect(r.json.link).toBe(`https://acme.test/products/ginseng#rawuser_pick=${r.json.token}`);
    const meta = JSON.parse(h.kv.get(pickTokenKey(r.json.token as string)) ?? "{}");
    expect(meta).toMatchObject({
      page_path: "/products/ginseng",
      mode: "count",
      group: "/products/*",
    });
    expect(meta.manifest["count.button"]).toEqual({
      css: ["#start"],
      text: ["Start free"],
      structural: "hero button",
    });
    expect(h.kv.get(pickGroupKey("acme", "/products/*"))).toBe("/products/ginseng");
  });

  it("refuses at mint: a bad pattern, an unknown group, a page outside it, an identifier page, a running test", async () => {
    const bad = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      group: "/*",
      page_path: "/x",
    });
    expect(bad.status).toBe(400);
    const unknown = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      group: "/blog/*",
      page_path: "/blog/x",
    });
    expect(unknown).toMatchObject({
      status: 409,
      json: { error: "This page group is not on your list. Add it first." },
    });
    for (const page of ["/products", "/products/a/b", "/productsale", "/"]) {
      const r = await call("POST", "/admin/conversions/pick-token", {
        customer_id: "acme",
        group: "/products/*",
        page_path: page,
      });
      expect(r, page).toMatchObject({
        status: 409,
        json: { error: "This page is not one of the group's pages." },
      });
    }
    // Privacy review condition 1: the identifier screen on the opened page, at mint.
    const id = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      group: "/products/*",
      page_path: "/products/48213377",
    });
    expect(id.status).toBe(400);
    expect(id.json.error).toBe(
      "This address belongs to one account. Pick the button on a page every visitor sees.",
    );
    expect([...h.kv.keys()].some((k) => k.startsWith("pick-token:"))).toBe(false);
    testRuns();
    const locked = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      group: "/products/*",
      page_path: "/products/a",
    });
    expect(locked).toEqual({ status: 409, json: { error: LOCK } });
  });

  it("the pick ADDS a counted button: two counted after it, nothing switched off, bundle rewritten", async () => {
    target("t_home", "count:/", 1);
    target("t_slot", "hero.cta.label", 1);
    const manifestsBefore = JSON.stringify(h.db.prepare("SELECT * FROM element_manifests").all());
    const { status } = await groupPick("/products/*", "/products/a");
    expect(status).toBe(200);
    const r = await call(
      "GET",
      "/admin/conversions/pick-status?customer_id=acme&group=/products/*",
    );
    expect(r.status).toBe(200);
    expect(r.json.landed).toBe(true);
    expect(r.json.group).toBe("/products/*");
    expect(r.json.page_path).toBe("/products/a");
    expect(r.json.target).toMatchObject({
      section_path: "count:/products/*",
      label: "Contact us",
      conversion_label: "contact",
      enabled: true,
      page: "/products/*",
      group: true,
      pages: null,
      css_selectors: ["nav a.contact"],
    });
    expect(targets()).toEqual([
      { section_path: "count:/", label: "Start free", conversion_label: "trial_start", enabled: 1 },
      {
        section_path: "hero.cta.label",
        label: "Start free",
        conversion_label: "trial_start",
        enabled: 1,
      },
      {
        section_path: "count:/products/*",
        label: "Contact us",
        conversion_label: "contact",
        enabled: 1,
      },
    ]);
    expect(JSON.stringify(h.db.prepare("SELECT * FROM element_manifests").all())).toBe(
      manifestsBefore,
    );
    const b = bundle();
    expect(b.g).toEqual(["/products/*"]);
    expect(b.conv.map((c: { section_path: string }) => c.section_path).sort()).toEqual([
      "count:/",
      "count:/products/*",
      "hero.cta.label",
    ]);
    expect(h.kv.has(pickCountKey("acme", "/products/a"))).toBe(false);
    expect(h.kv.has(pickGroupKey("acme", "/products/*"))).toBe(false);
    // The items list marks the group's button; a single page's keeps its shape.
    const items = r.json.items as Array<Record<string, unknown>>;
    expect(items.find((t) => t.section_path === "count:/")).not.toHaveProperty("group");
    // And the single-page pick still switches the others off (countOnly, unchanged).
    const mint = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      page_path: "/pricing",
    });
    await receivePick({ token: mint.json.token, button: NAV, page_path: "/pricing" }, store());
    await call("GET", "/admin/conversions/pick-status?customer_id=acme&page_path=/pricing");
    expect(targets().map((t) => [t.section_path, t.enabled])).toEqual([
      ["count:/", 0],
      ["hero.cta.label", 0],
      ["count:/products/*", 0],
      ["count:/pricing", 1],
    ]);
  });

  it("reads the opened page from the query when given, else the mint's key; not landed otherwise", async () => {
    const none = await call(
      "GET",
      "/admin/conversions/pick-status?customer_id=acme&group=/products/*",
    );
    expect(none).toEqual({
      status: 200,
      json: { landed: false, page_path: null, group: "/products/*" },
    });
    await groupPick("/products/*", "/products/a");
    const wrong = await call(
      "GET",
      "/admin/conversions/pick-status?customer_id=acme&group=/products/*&page_path=/products/b",
    );
    expect(wrong.json).toEqual({ landed: false, page_path: "/products/b", group: "/products/*" });
    const right = await call(
      "GET",
      "/admin/conversions/pick-status?customer_id=acme&group=/products/*&page_path=/products/a",
    );
    expect(right.json.landed).toBe(true);
  });

  it("refuses at Done a pick posted from a page outside the group, and a page with an identifier (condition 1)", async () => {
    const out = await groupPick("/products/*", "/products/a", NAV, "/pricing");
    expect(out.status).toBe(200);
    const r = await call(
      "GET",
      "/admin/conversions/pick-status?customer_id=acme&group=/products/*",
    );
    expect(r).toMatchObject({
      status: 409,
      json: { error: "This page is not one of the group's pages.", page_path: "/pricing" },
    });
    expect(targets()).toEqual([]);
    expect(h.kv.has(pickCountKey("acme", "/products/a"))).toBe(false);
    // The edge's receive refuses the identifier page before anything is stored.
    const id = await groupPick("/products/*", "/products/a", NAV, "/products/48213377");
    expect(id.status).toBe(400);
  });

  it("links and buttons only and the account-style words screen run unchanged on a group link (condition 2)", async () => {
    const account = await groupPick("/products/*", "/products/a", { ...NAV, text: ["Hi a@b.c"] });
    expect(account.status).toBe(400);
    const digits = await groupPick("/products/*", "/products/a", {
      ...NAV,
      css: ["a.u-4821337712"],
    });
    expect(digits.status).toBe(400);
    expect(targets()).toEqual([]);
  });

  it("refuses a header or nav pick named by aria-label alone (condition 3), server side from the posted fields", async () => {
    const ariaOnly = {
      css: ['a[aria-label="Open the contact form"]', "nav a.icon"],
      text: ["Open the contact form"],
      structural: "first a in nav",
    };
    expect(groupPickAriaOnly(ariaOnly)).toBe(true);
    // Visible words: the picker lists no aria-label selector equal to them.
    expect(groupPickAriaOnly({ ...ariaOnly, css: ["nav a.icon"] })).toBe(false);
    // In main, not the header or nav: allowed.
    expect(groupPickAriaOnly({ ...ariaOnly, structural: "first a in main" })).toBe(false);
    // No words at all: allowed, the label is the page.
    expect(groupPickAriaOnly({ ...ariaOnly, text: [] })).toBe(false);
    // A header pick whose aria-label is longer than the 40-character signature.
    expect(
      groupPickAriaOnly({
        css: ['button[aria-label="Open the contact form for this product page"]'],
        text: ["Open the contact form for this product"],
        structural: "2nd button in header",
      }),
    ).toBe(true);
    await groupPick("/products/*", "/products/a", ariaOnly);
    const r = await call(
      "GET",
      "/admin/conversions/pick-status?customer_id=acme&group=/products/*",
    );
    expect(r).toMatchObject({
      status: 409,
      json: { error: "This button has no words of its own. Pick a button with visible words." },
    });
    expect(targets()).toEqual([]);
  });

  it("while a test runs: the group's own button again passes, anything else 409", async () => {
    await groupPick("/products/*", "/products/a");
    await call("GET", "/admin/conversions/pick-status?customer_id=acme&group=/products/*");
    testRuns();
    // The mint refuses, so the pick is posted under a token minted before the test.
    h.db.prepare("DELETE FROM holdout_tests").run();
    const same = await groupPick("/products/*", "/products/b");
    expect(same.status).toBe(200);
    testRuns();
    const ok = await call(
      "GET",
      "/admin/conversions/pick-status?customer_id=acme&group=/products/*",
    );
    expect(ok.status).toBe(200);
    expect(ok.json.landed).toBe(true);
    h.db.prepare("DELETE FROM holdout_tests").run();
    await groupPick("/products/*", "/products/b", { ...NAV, css: ["nav a.other"] });
    testRuns();
    const locked = await call(
      "GET",
      "/admin/conversions/pick-status?customer_id=acme&group=/products/*",
    );
    expect(locked).toMatchObject({ status: 409, json: { error: LOCK } });
    expect(targets()).toHaveLength(1);
  });

  it("the pick-status of an unknown group and a bad pattern", async () => {
    expect(
      (await call("GET", "/admin/conversions/pick-status?customer_id=acme&group=/blog/*")).status,
    ).toBe(409);
    expect(
      (await call("GET", "/admin/conversions/pick-status?customer_id=acme&group=/*")).status,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe("the group link without a page: the server chooses", () => {
  const NOW = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const day = (ago: number) => new Date(NOW - ago * DAY).toISOString().slice(0, 10);

  function loads(
    page: string,
    n: number,
    over: { customer?: string; ts?: number; type?: string } = {},
  ) {
    for (let i = 0; i < n; i++) {
      h.ev({
        customer: over.customer ?? "acme",
        ts: over.ts ?? NOW - 1000 * (i + 1),
        type: (over.type ?? "variant_shown") as never,
        page,
      });
    }
  }
  function pageDay(d: string, page: string, n: number) {
    h.db
      .prepare(
        "INSERT INTO page_days (customer_id, day, page_path, loads) VALUES ('acme', ?, ?, ?)",
      )
      .run(d, page, n);
  }
  function folded(d: string) {
    h.db
      .prepare(
        "INSERT INTO exposure_rollup_days (customer_id, day, computed_at, mixed_visits) VALUES ('acme', ?, 1, 0)",
      )
      .run(d);
  }
  const mint = (body: Record<string, unknown> = {}) =>
    call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      group: "/products/*",
      ...body,
    });

  beforeEach(async () => {
    await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: "/products/*" });
  });

  it("an ordinary customer: the most loaded openable page from the exposure rows of 30 days", async () => {
    loads("/products/:id", 20); // masked: never opened
    loads("/products/alpha", 5);
    loads("/products/beta", 9);
    loads("/products/beta/deeper", 30); // two segments under: not the group's
    loads("/products/gamma", 12);
    confirmedPage("/products/gamma"); // a confirmed page has its own pick
    loads("/products/old", 40, { ts: NOW - 31 * DAY }); // outside the window
    loads("/products/foreign", 50, { customer: "other" });
    loads("/products/clicked", 60, { type: "conversion" }); // not a load
    const r = await mint();
    expect(r.status).toBe(200);
    expect(r.json.page_path).toBe("/products/beta");
    expect(r.json.group).toBe("/products/*");
    expect(r.json.link).toBe(`https://acme.test/products/beta#rawuser_pick=${r.json.token}`);
    expect(h.kv.get(pickGroupKey("acme", "/products/*"))).toBe("/products/beta");
    const meta = JSON.parse(h.kv.get(pickTokenKey(r.json.token as string)) ?? "{}");
    expect(meta).toMatchObject({
      page_path: "/products/beta",
      mode: "count",
      group: "/products/*",
    });
  });

  it("a sensitive customer: from page_days on folded days, a group row and an unfolded day skipped, events never read", async () => {
    markSensitive(["/products"]);
    folded(day(2));
    pageDay(day(2), "/products/:item", 100); // the folded group row names no page
    pageDay(day(2), "/products/alpha", 4);
    pageDay(day(2), "/products/beta", 7);
    pageDay(day(1), "/products/alpha", 50); // its fold not recorded: not read
    pageDay(day(40), "/products/delta", 500); // outside the window
    folded(day(40));
    loads("/products/zeta", 99); // the event rows are not the sensitive customer's source
    const prepare = vi.spyOn(h.env.DB as { prepare: (sql: string) => unknown }, "prepare");
    const r = await mint();
    const sqls = prepare.mock.calls.map((c) => String(c[0]));
    prepare.mockRestore();
    expect(r.status).toBe(200);
    expect(r.json.page_path).toBe("/products/beta");
    expect(sqls.some((s) => s.includes("page_days"))).toBe(true);
    expect(sqls.filter((s) => /\bevents\b/.test(s))).toEqual([]);
  });

  it("no openable page: 409 group_page_needed with its one line, no token written", async () => {
    loads("/products/:id", 20);
    loads("/products/taken", 9);
    confirmedPage("/products/taken");
    const r = await mint();
    expect(r).toEqual({
      status: 409,
      json: { error: "Paste the address of one of these pages.", code: "group_page_needed" },
    });
    expect([...h.kv.keys()].some((k) => k.startsWith("pick-token:"))).toBe(false);
    // The same for a sensitive customer with a counter that names no page.
    markSensitive(["/products"]);
    folded(day(2));
    pageDay(day(2), "/products/:item", 100);
    expect((await mint()).json.code).toBe("group_page_needed");
  });

  it("the chosen page passes the identifier screen as a sent one does", async () => {
    loads("/products/what-we-learned-in-2024", 9);
    const r = await mint();
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(
      "This address belongs to one account. Pick the button on a page every visitor sees.",
    );
  });

  it("a sent page is opened as before, whatever the counts say; an empty one counts as none", async () => {
    loads("/products/beta", 9);
    const sent = await mint({ page_path: "/products/Alpha" });
    expect(sent.status).toBe(200);
    expect(sent.json.page_path).toBe("/products/alpha");
    const empty = await mint({ page_path: "" });
    expect(empty.status).toBe(200);
    expect(empty.json.page_path).toBe("/products/beta");
    const outside = await mint({ page_path: "/pricing" });
    expect(outside).toMatchObject({
      status: 409,
      json: { error: "This page is not one of the group's pages." },
    });
  });
});

describe("a sensitive customer and a group", () => {
  it("the link is checked on the pattern, never the page: a product page passes for the group, is refused as a page", async () => {
    markSensitive(["/products"]);
    await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: "/products/*" });
    const asPage = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      page_path: "/products/polimax",
    });
    expect(asPage).toEqual({
      status: 409,
      json: { error: SENSITIVE_PAGE_LINE, code: "sensitive_page", page_path: "/products/polimax" },
    });
    const { status } = await groupPick("/products/*", "/products/polimax");
    expect(status).toBe(200);
    const r = await call(
      "GET",
      "/admin/conversions/pick-status?customer_id=acme&group=/products/*",
    );
    expect(r.status).toBe(200);
    expect(targets()).toEqual([
      {
        section_path: "count:/products/*",
        label: "Contact us",
        conversion_label: "contact",
        enabled: 1,
      },
    ]);
    expect(bundle()).toMatchObject({ s: 1, sk: ["/products"], g: ["/products/*"] });
  });

  it("a group under a section not kept is refused at the link and at Done, naming the pattern", async () => {
    await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: "/blog/*" });
    await groupPick("/products/*", "/blog/post").catch(() => {});
    markSensitive(["/products"]);
    const mint = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      group: "/blog/*",
      page_path: "/blog/post",
    });
    expect(mint).toEqual({
      status: 409,
      json: { error: SENSITIVE_PAGE_LINE, code: "sensitive_page", page_path: "/blog/*" },
    });
    // A pick minted before the mark is dropped unread.
    h.kv.set(pickGroupKey("acme", "/blog/*"), "/blog/post");
    h.kv.set(
      pickCountKey("acme", "/blog/post"),
      JSON.stringify({ ...NAV, page_path: "/blog/post" }),
    );
    const done = await call("GET", "/admin/conversions/pick-status?customer_id=acme&group=/blog/*");
    expect(done.status).toBe(409);
    expect(done.json.page_path).toBe("/blog/*");
    expect(targets()).toEqual([]);
  });

  it("the guard's four places: sensitiveTargetRefusal, foreignPages, upsert and count", async () => {
    markSensitive(["/products"]);
    expect(await sensitiveTargetRefusal(h.d1, "acme", "count:/products/*")).toBeNull();
    expect(await sensitiveTargetRefusal(h.d1, "acme", "count:/blog/*")).toMatchObject({
      page_path: "/blog/*",
    });
    expect(await sensitiveTargetRefusal(h.d1, "acme", "count:/products/polimax")).toMatchObject({
      page_path: "/products/polimax",
    });
    expect(groupRefusalUnder({ sensitive: true, kept: [] }, "/products/*")).toMatchObject({
      page_path: "/products/*",
    });
    expect(groupRefusalUnder({ sensitive: false, kept: [] }, "/blog/*")).toBeNull();
    target("g_ok", "count:/products/*", 1);
    target("g_no", "count:/blog/*", 1);
    target("p_no", "count:/products/polimax", 1);
    expect(await foreignPages(h.d1, "acme", ["/products"])).toEqual({
      pages: [],
      counted: ["/blog/*", "/products/polimax"],
    });
    const up = await call("POST", "/admin/conversions/upsert", {
      customer_id: "acme",
      section_path: "count:/products/*",
      label: "Contact",
      css_selectors: ["nav a"],
      structural_selector: "first a in nav",
    });
    expect(up.status).toBe(200);
    const upNo = await call("POST", "/admin/conversions/upsert", {
      customer_id: "acme",
      section_path: "count:/blog/*",
      label: "Contact",
      css_selectors: ["nav a"],
      structural_selector: "first a in nav",
    });
    expect(upNo.status).toBe(409);
    expect(
      (await call("POST", "/admin/conversions/count", { customer_id: "acme", id: "g_ok" })).status,
    ).toBe(200);
    expect(
      (await call("POST", "/admin/conversions/count", { customer_id: "acme", id: "g_no" })).status,
    ).toBe(409);
  });

  it("the flag cannot go on over a group outside the list, and can with the group under a kept section", async () => {
    sessionUser = ROOT;
    target("g1", "count:/blog/*", 1);
    const no = await call("POST", "/admin/customers/sensitive", {
      customer_id: "acme",
      sensitive: true,
      kept_sections: ["/products"],
    });
    expect(no.status).toBe(409);
    expect(no.json.counted).toEqual(["/blog/*"]);
    const yes = await call("POST", "/admin/customers/sensitive", {
      customer_id: "acme",
      sensitive: true,
      kept_sections: ["/blog"],
    });
    expect(yes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe("conversions/list, the bundle, the export and the delete", () => {
  it("list marks a group's button with its pattern and the aggregate's page count", async () => {
    target("t_home", "count:/", 1);
    target("g1", "count:/products/*", 1);
    aggregate(PER_PAGE);
    const r = await call("GET", "/admin/conversions/list?customer_id=acme");
    const items = r.json.items as Array<Record<string, unknown>>;
    expect(items.find((t) => t.id === "g1")).toMatchObject({
      page: "/products/*",
      group: true,
      pages: 3,
    });
    expect(items.find((t) => t.id === "t_home")).not.toHaveProperty("group");
    expect(markGroupTargets([{ section_path: "count:/x/*" }])).toEqual([
      { section_path: "count:/x/*", page: "/x/*", group: true, pages: null },
    ]);
  });

  it("a customer without groups has the bundle it had, byte for byte", async () => {
    target("t_home", "count:/", 1);
    // Page one's `dp` and the memory's `rm` (direct-visitors.md §6, §2) are not this test's subject.
    h.db.prepare("UPDATE customers SET page_one_off = 1, remember_off = 1 WHERE id = 'acme'").run();
    const { writeVisitorBundle } = await import("../../src/admin/onboard.ts");
    await writeVisitorBundle(h.env, "acme");
    const before = h.kv.get(visitorBundleKey("acme")) ?? "";
    expect(before).not.toContain('"g"');
    await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: "/products/*" });
    expect(h.kv.get(visitorBundleKey("acme"))).toBe(before.replace(/}$/, ',"g":["/products/*"]}'));
    await call("POST", "/admin/pages/groups/delete", {
      customer_id: "acme",
      pattern: "/products/*",
    });
    expect(h.kv.get(visitorBundleKey("acme"))).toBe(before);
  });

  it("the export carries page_groups and the delete removes them", async () => {
    await call("POST", "/admin/pages/groups", { customer_id: "acme", pattern: "/products/*" });
    h.db
      .prepare(
        "INSERT INTO page_groups (customer_id, pattern, created_at) VALUES ('other', '/other/*', 1)",
      )
      .run();
    const env = { DB: h.d1, VARIANTS: makeKv() };
    const rows: Array<Record<string, unknown>> = [];
    for await (const line of exportLines(env, "acme", new Date(0))) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === "row" && parsed.table === "page_groups") rows.push(parsed);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]?.row).toMatchObject({ customer_id: "acme", pattern: "/products/*" });
    expect((await countCustomerData(env, "acme")).d1.page_groups).toBe(1);
    await deleteCustomerData(env, "acme");
    expect(groupsStored("acme")).toEqual([]);
    expect(groupsStored("other")).toEqual(["/other/*"]);
  });
});
