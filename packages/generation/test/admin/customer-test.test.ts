/**
 * The customer's own test (docs/specs/proof-engine.md, "The customer's own
 * test"; mock measure-setup.html notes A1 to A3):
 *   - POST /admin/proof/test: start sets 20% only, through the superadmin
 *     control's write path (test period, customer row, bundle `h`); refused
 *     with a plain 409 without a counted button, past a year, or while a test
 *     at another percent runs; stop sets 0 on any test; start again works;
 *   - the counted buttons do not move while a test runs (upsert, confirm,
 *     delete, count all 409 a change; a no-change write passes);
 *   - POST /admin/conversions/count: one enabled target, the rest disabled,
 *     the bundle rewritten.
 * Real SQL on node:sqlite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayOf } from "../../src/cron/exposure-rollup.ts";
import { type Harness, harness } from "../proof-harness.ts";

type User = { id: string; email: string; role: string; customer_id: string | null };
const SUPERADMIN: User = {
  id: "u1",
  email: "f@example.com",
  role: "superadmin",
  customer_id: null,
};
const ACME: User = { id: "u2", email: "c@acme.test", role: "customer", customer_id: "acme" };
let sessionUser: User = ACME;

vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionUser),
}));

const { default: worker } = await import("../../src/index.ts");

const DAY = 86_400_000;
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

const MANIFEST = {
  "hero.cta.label": {
    css: ["#start"],
    text: ["Start free"],
    structural: "hero button",
    conversion_candidate: true,
  },
  "footer.cta.label": {
    css: ["#call"],
    text: ["Book a call"],
    structural: "footer button",
    conversion_candidate: true,
  },
};

function manifest(customer = "acme") {
  h.db
    .prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at) VALUES (?, '/', ?, 'https://acme.test/', 1, 1)",
    )
    .run(customer, JSON.stringify(MANIFEST));
}

/** A conversion target as the confirm flow writes it. */
function target(id: string, sectionPath: string, label: string, enabled: 0 | 1, customer = "acme") {
  const entry = MANIFEST[sectionPath as keyof typeof MANIFEST];
  h.db
    .prepare(
      `INSERT INTO conversion_targets (id, customer_id, section_path, label, conversion_label, enabled,
         css_selectors, text_selectors, structural_selector, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'signup', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      customer,
      sectionPath,
      label,
      enabled,
      JSON.stringify(entry.css),
      JSON.stringify(entry.text),
      entry.structural,
      id === "t1" ? 1 : 2,
      1,
    );
}

/** Eligible traffic per closed day for the last 30 days, no clicks (the 3% default rate). */
function traffic(visitsPerDay: number) {
  const now = Date.now();
  for (let d = 30; d >= 1; d--) {
    h.db
      .prepare(
        `INSERT INTO exposure_outcomes (customer_id, day, arm, page_path, intent_dim, source_dim,
           visits, converting_visits, computed_at)
         VALUES ('acme', ?, 'none', '/', 'problem', 'ai', ?, 0, 1)`,
      )
      .run(dayOf(now - d * DAY), visitsPerDay);
  }
}

const tests = () =>
  h.db
    .prepare(
      "SELECT percent, ended_at FROM holdout_tests WHERE customer_id = 'acme' ORDER BY started_at",
    )
    .all() as Array<{ percent: number; ended_at: number | null }>;
const bundle = () => JSON.parse(h.kv.get("v1:vm:acme") ?? "null") as Record<string, unknown> | null;
const enabledIds = () =>
  (
    h.db
      .prepare(
        "SELECT id FROM conversion_targets WHERE customer_id = 'acme' AND enabled = 1 ORDER BY id",
      )
      .all() as Array<{ id: string }>
  ).map((r) => r.id);

describe("the report tells the setup steps what they need", () => {
  it("no counted button: start blocked, with the count and the estimate", async () => {
    traffic(200);
    const r = await call("GET", "/admin/analytics/lift?customer_id=acme");
    expect(r.json.start).toMatchObject({
      counted_buttons: 0,
      can_start: false,
      blocked: "no_button",
    });
    const start = r.json.start as { estimate: { percent: number; weeks: number } };
    expect(start.estimate.percent).toBe(20);
    expect(start.estimate.weeks).toBeGreaterThan(0);
  });

  it("two counted buttons: counted_buttons 2, the start allowed, a read date", async () => {
    traffic(200);
    target("t1", "hero.cta.label", "Start free", 1);
    target("t2", "footer.cta.label", "Book a call", 1);
    const r = await call("GET", "/admin/analytics/lift?customer_id=acme");
    expect(r.json.start).toMatchObject({ counted_buttons: 2, can_start: true, blocked: null });
    expect((r.json.start as { read_date: string }).read_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((r.json.metric as { labels: string[] }).labels).toEqual(["Start free", "Book a call"]);
  });
});

describe("POST /admin/proof/test, start", () => {
  it("a customer starts a 20% test through the control's write path; the read date is the one promised", async () => {
    traffic(200);
    target("t1", "hero.cta.label", "Start free", 1);
    const promised = (await call("GET", "/admin/analytics/lift?customer_id=acme")).json.start as {
      read_date: string;
    };
    const before = Date.now();
    const r = await call("POST", "/admin/proof/test", { customer_id: "acme", action: "start" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      customer_id: "acme",
      percent: 20,
      ended_test_id: null,
    });
    expect((r.json.since as number) - before).toBeGreaterThanOrEqual(10 * 60_000);
    expect(tests()).toEqual([{ percent: 20, ended_at: null }]);
    expect(h.db.prepare("SELECT holdout_percent FROM customers WHERE id = 'acme'").get()).toEqual({
      holdout_percent: 20,
    });
    expect(bundle()?.h).toBe(20);
    const report = r.json.report as {
      state: string;
      test: { read_date: string; percent: number };
      start: { blocked: string; can_start: boolean; read_date: string | null };
    };
    expect(report.state).toBe("starting");
    expect(report.test.read_date).toBe(promised.read_date);
    expect(report.start).toMatchObject({ blocked: "running", can_start: false, read_date: null });
    expect(report).not.toHaveProperty("checks");
  });

  it("refuses without a counted button: 409, a plain sentence, nothing written", async () => {
    traffic(200);
    target("t1", "hero.cta.label", "Start free", 0);
    const r = await call("POST", "/admin/proof/test", { customer_id: "acme", action: "start" });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: "Choose the button to count first.", reason: "no_button" });
    expect(tests()).toEqual([]);
    expect(h.kv.get("v1:vm:acme")).toBeUndefined();
  });

  it("refuses when a 20% test would take more than a year to read", async () => {
    traffic(1);
    target("t1", "hero.cta.label", "Start free", 1);
    const report = (await call("GET", "/admin/analytics/lift?customer_id=acme")).json;
    expect((report.start as { estimate: { weeks: number } }).estimate.weeks).toBeGreaterThan(52);
    expect(report.start).toMatchObject({ can_start: false, blocked: "too_little_traffic" });
    const r = await call("POST", "/admin/proof/test", { customer_id: "acme", action: "start" });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({
      error: "Too little traffic to read within a year.",
      reason: "too_little_traffic",
    });
    expect(tests()).toEqual([]);
  });

  it("with no eligible traffic yet, a start is allowed and its read date waits for its own numbers", async () => {
    target("t1", "hero.cta.label", "Start free", 1);
    const report = (await call("GET", "/admin/analytics/lift?customer_id=acme")).json;
    expect(report.start).toMatchObject({ can_start: true, blocked: null, read_date: null });
    expect((report.start as { estimate: { weeks: number | null } }).estimate.weeks).toBeNull();
    const r = await call("POST", "/admin/proof/test", { customer_id: "acme", action: "start" });
    expect(r.status).toBe(200);
    expect(tests()).toEqual([{ percent: 20, ended_at: null }]);
  });

  it("start twice is no change; a superadmin's other percent refuses the customer's start", async () => {
    traffic(200);
    target("t1", "hero.cta.label", "Start free", 1);
    const a = await call("POST", "/admin/proof/test", { customer_id: "acme", action: "start" });
    const b = await call("POST", "/admin/proof/test", { customer_id: "acme", action: "start" });
    expect(b.status).toBe(200);
    expect(b.json.test_id).toBe(a.json.test_id);
    expect(tests()).toHaveLength(1);

    sessionUser = SUPERADMIN;
    await call("POST", "/admin/customers/holdout", { customer_id: "acme", percent: 50 });
    sessionUser = ACME;
    const c = await call("POST", "/admin/proof/test", { customer_id: "acme", action: "start" });
    expect(c.status).toBe(409);
    expect(c.json).toEqual({ error: "A test is already running.", reason: "running" });
    expect(tests().map((t) => t.percent)).toEqual([20, 50]);
  });

  it("takes no percent from the body: start is 20 whatever is sent", async () => {
    traffic(200);
    target("t1", "hero.cta.label", "Start free", 1);
    const r = await call("POST", "/admin/proof/test", {
      customer_id: "acme",
      action: "start",
      percent: 50,
    });
    expect(r.json.percent).toBe(20);
    expect(tests()).toEqual([{ percent: 20, ended_at: null }]);
  });

  it("refuses another customer, a missing customer and an unknown action", async () => {
    target("t1", "hero.cta.label", "Start free", 1);
    expect(
      (await call("POST", "/admin/proof/test", { customer_id: "other", action: "start" })).status,
    ).toBe(403);
    expect((await call("POST", "/admin/proof/test", { action: "start" })).status).toBe(403);
    expect(
      (await call("POST", "/admin/proof/test", { customer_id: "acme", action: "pause" })).status,
    ).toBe(400);
    sessionUser = SUPERADMIN;
    expect(
      (await call("POST", "/admin/proof/test", { customer_id: "nope", action: "stop" })).status,
    ).toBe(404);
    expect(tests()).toEqual([]);
  });

  it("a superadmin session gets the checks row in the answer's report", async () => {
    sessionUser = SUPERADMIN;
    traffic(200);
    target("t1", "hero.cta.label", "Start free", 1);
    const r = await call("POST", "/admin/proof/test", { customer_id: "acme", action: "start" });
    expect(r.status).toBe(200);
    expect(r.json.report).toHaveProperty("checks");
  });
});

describe("POST /admin/proof/test, stop and start again", () => {
  it("stop ends any running test, the superadmin's 50% included, and writes 0", async () => {
    target("t1", "hero.cta.label", "Start free", 1);
    sessionUser = SUPERADMIN;
    const set = await call("POST", "/admin/customers/holdout", {
      customer_id: "acme",
      percent: 50,
    });
    sessionUser = ACME;
    const r = await call("POST", "/admin/proof/test", { customer_id: "acme", action: "stop" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ percent: 0, since: null, test_id: null });
    expect(r.json.ended_test_id).toBe(set.json.test_id);
    expect(tests()[0]?.ended_at).not.toBeNull();
    expect(bundle()?.h).toBe(0);
    expect(["ended", "ended_early"]).toContain((r.json.report as { state: string }).state);
  });

  it("stop with nothing running changes nothing but the explicit 0", async () => {
    const r = await call("POST", "/admin/proof/test", { customer_id: "acme", action: "stop" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ percent: 0, test_id: null, ended_test_id: null });
    expect(tests()).toEqual([]);
  });

  it("after a test ends the customer may start again: a new period, from the next whole day", async () => {
    traffic(200);
    target("t1", "hero.cta.label", "Start free", 1);
    await call("POST", "/admin/proof/test", { customer_id: "acme", action: "start" });
    const stopped = await call("POST", "/admin/proof/test", {
      customer_id: "acme",
      action: "stop",
    });
    const after = stopped.json.report as {
      start: { can_start: boolean; read_date: string };
    };
    expect(after.start.can_start).toBe(true);
    const again = await call("POST", "/admin/proof/test", { customer_id: "acme", action: "start" });
    expect(again.status).toBe(200);
    expect(tests().map((t) => [t.percent, t.ended_at === null])).toEqual([
      [20, false],
      [20, true],
    ]);
    const report = again.json.report as { test: { first_day: string; read_date: string } };
    // The stopped test ran into today, so the new one reads from tomorrow.
    expect(report.test.first_day).toBe(dayOf(Date.now() + DAY));
    expect(report.test.read_date).toBe(after.start.read_date);
  });
});

describe("the counted buttons do not move while a test runs", () => {
  async function running() {
    manifest();
    traffic(200);
    target("t1", "hero.cta.label", "Start free", 1);
    target("t2", "footer.cta.label", "Book a call", 0);
    const r = await call("POST", "/admin/proof/test", { customer_id: "acme", action: "start" });
    expect(r.status).toBe(200);
  }

  it("upsert refuses to disable, rename or retarget the counted button", async () => {
    await running();
    for (const change of [
      { enabled: false },
      { label: "Start now" },
      { css_selectors: ["#other"] },
      { conversion_label: "trial_start" },
    ]) {
      const r = await call("POST", "/admin/conversions/upsert", {
        customer_id: "acme",
        section_path: "hero.cta.label",
        label: "Start free",
        conversion_label: "signup",
        ...change,
      });
      expect(r.status).toBe(409);
      expect(r.json).toEqual({ error: LOCK });
    }
    expect(enabledIds()).toEqual(["t1"]);
    expect(
      h.db.prepare("SELECT label, css_selectors FROM conversion_targets WHERE id = 't1'").get(),
    ).toEqual({ label: "Start free", css_selectors: '["#start"]' });
  });

  it("upsert refuses to count a second button, and to add a new counted one", async () => {
    await running();
    const enable = await call("POST", "/admin/conversions/upsert", {
      customer_id: "acme",
      section_path: "footer.cta.label",
      label: "Book a call",
      conversion_label: "signup",
    });
    expect(enable.status).toBe(409);
    const fresh = await call("POST", "/admin/conversions/upsert", {
      customer_id: "acme",
      section_path: "nav.signup",
      label: "Sign up",
      css_selectors: ["#nav-signup"],
      structural_selector: "nav button",
    });
    expect(fresh.status).toBe(409);
    expect(enabledIds()).toEqual(["t1"]);
  });

  it("upsert passes the same values again, and a change to a button that stays off", async () => {
    await running();
    const same = await call("POST", "/admin/conversions/upsert", {
      customer_id: "acme",
      section_path: "hero.cta.label",
      label: "Start free",
      conversion_label: "signup",
    });
    expect(same.status).toBe(200);
    const off = await call("POST", "/admin/conversions/upsert", {
      customer_id: "acme",
      section_path: "footer.cta.label",
      label: "Book a demo",
      conversion_label: "demo_request",
      enabled: false,
    });
    expect(off.status).toBe(200);
    expect(enabledIds()).toEqual(["t1"]);
  });

  it("confirm refuses the whole request before writing anything", async () => {
    await running();
    const r = await call("POST", "/admin/conversions/confirm", {
      customer_id: "acme",
      targets: [
        { section_path: "footer.cta.label", label: "Book a demo", enabled: false },
        { section_path: "hero.cta.label", label: "Start free", enabled: false },
      ],
    });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: LOCK });
    expect(h.db.prepare("SELECT label FROM conversion_targets WHERE id = 't2'").get()).toEqual({
      label: "Book a call",
    });
    expect(enabledIds()).toEqual(["t1"]);
  });

  it("delete refuses the counted button and passes one that is off", async () => {
    await running();
    expect((await call("POST", "/admin/conversions/delete", { id: "t1" })).status).toBe(409);
    expect((await call("POST", "/admin/conversions/delete", { id: "t2" })).status).toBe(200);
    expect(enabledIds()).toEqual(["t1"]);
  });

  it("count refuses a change and passes the button already counted", async () => {
    await running();
    const other = await call("POST", "/admin/conversions/count", { customer_id: "acme", id: "t2" });
    expect(other.status).toBe(409);
    expect(other.json).toEqual({ error: LOCK });
    const same = await call("POST", "/admin/conversions/count", { customer_id: "acme", id: "t1" });
    expect(same.status).toBe(200);
    expect(enabledIds()).toEqual(["t1"]);
  });

  it("after stop the buttons change again", async () => {
    await running();
    await call("POST", "/admin/proof/test", { customer_id: "acme", action: "stop" });
    const r = await call("POST", "/admin/conversions/count", { customer_id: "acme", id: "t2" });
    expect(r.status).toBe(200);
    expect(enabledIds()).toEqual(["t2"]);
  });
});

describe("POST /admin/conversions/count", () => {
  it("counts the chosen button only and rewrites the bundle", async () => {
    target("t1", "hero.cta.label", "Start free", 1);
    target("t2", "footer.cta.label", "Book a call", 1);
    const r = await call("POST", "/admin/conversions/count", { customer_id: "acme", id: "t2" });
    expect(r.status).toBe(200);
    const items = r.json.items as Array<{ id: string; enabled: boolean }>;
    expect(items.map((i) => [i.id, i.enabled])).toEqual([
      ["t1", false],
      ["t2", true],
    ]);
    expect(enabledIds()).toEqual(["t2"]);
    const kv = h.kv.get("v1:vm:acme") ?? "";
    expect(kv).toContain("#call");
    expect(kv).not.toContain("#start");
    const report = (await call("GET", "/admin/analytics/lift?customer_id=acme")).json;
    expect((report.metric as { labels: string[] }).labels).toEqual(["Book a call"]);
    expect((report.start as { counted_buttons: number }).counted_buttons).toBe(1);
  });

  it("refuses another customer's id and an unknown id, and touches nothing", async () => {
    target("t1", "hero.cta.label", "Start free", 1);
    target("o1", "hero.cta.label", "Start free", 0, "other");
    expect(
      (await call("POST", "/admin/conversions/count", { customer_id: "acme", id: "o1" })).status,
    ).toBe(404);
    expect(
      (await call("POST", "/admin/conversions/count", { customer_id: "other", id: "o1" })).status,
    ).toBe(403);
    expect(
      (await call("POST", "/admin/conversions/count", { customer_id: "acme", id: "" })).status,
    ).toBe(400);
    expect(enabledIds()).toEqual(["t1"]);
    expect(h.db.prepare("SELECT enabled FROM conversion_targets WHERE id = 'o1'").get()).toEqual({
      enabled: 0,
    });
  });
});
