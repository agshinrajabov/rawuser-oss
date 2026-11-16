/**
 * The proof engine's admin endpoints (docs/specs/proof-engine.md, G):
 * the lift report is customer-scoped with the checks row for a superadmin
 * only; the holdout control, the weekly draft and the backfills are
 * superadmin only; setting the holdout writes the customer, the test
 * period and the bundle's `h`. Real SQL on node:sqlite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness } from "../proof-harness.ts";

type User = { id: string; email: string; role: string; customer_id: string | null };
const SUPERADMIN: User = {
  id: "u1",
  email: "f@example.com",
  role: "superadmin",
  customer_id: null,
};
const ACME: User = { id: "u2", email: "c@acme.test", role: "customer", customer_id: "acme" };
let sessionUser: User = SUPERADMIN;

vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionUser),
}));

const { default: worker } = await import("../../src/index.ts");

let h: Harness;
beforeEach(() => {
  h = harness();
  h.customer("acme");
  h.customer("other");
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

describe("GET /admin/analytics/lift", () => {
  it("a customer reads its own report, without the checks row", async () => {
    sessionUser = ACME;
    const r = await call("GET", "/admin/analytics/lift?customer_id=acme");
    expect(r.status).toBe(200);
    expect(r.json.title).toBe("What the versions did");
    expect(r.json.state).toBe("off");
    expect(r.json).not.toHaveProperty("checks");
  });

  it("a customer cannot read another customer's report", async () => {
    sessionUser = ACME;
    expect((await call("GET", "/admin/analytics/lift?customer_id=other")).status).toBe(403);
  });

  it("a superadmin gets the checks row once a test runs", async () => {
    await call("POST", "/admin/customers/holdout", { customer_id: "acme", percent: 20 });
    h.db.prepare("UPDATE holdout_tests SET started_at = ?").run(Date.now() - 20 * 86_400_000);
    const r = await call("GET", "/admin/analytics/lift?customer_id=acme");
    expect(r.status).toBe(200);
    expect(r.json.checks).toMatchObject({ split_set: 0.2 });
  });
});

describe("the holdout control is superadmin only", () => {
  it("a customer gets 403 on every control and draft endpoint", async () => {
    sessionUser = ACME;
    expect((await call("GET", "/admin/customers/holdout?customer_id=acme")).status).toBe(403);
    expect(
      (await call("POST", "/admin/customers/holdout", { customer_id: "acme", percent: 20 })).status,
    ).toBe(403);
    expect((await call("GET", "/admin/analytics/weekly?customer_id=acme")).status).toBe(403);
    expect(
      (await call("POST", "/admin/proof/backfill", { customer_id: "acme", what: "outcomes" }))
        .status,
    ).toBe(403);
    const row = h.db.prepare("SELECT holdout_percent FROM customers WHERE id = 'acme'").get();
    expect(row).toEqual({ holdout_percent: null });
  });

  it("GET answers the dialog's numbers for 10, 20 and 50", async () => {
    const r = await call("GET", "/admin/customers/holdout?customer_id=acme");
    expect(r.status).toBe(200);
    expect(r.json.choices).toEqual([0, 10, 20, 50]);
    expect((r.json.options as Array<{ percent: number }>).map((o) => o.percent)).toEqual([
      10, 20, 50,
    ]);
    expect(r.json.basis).toMatchObject({ rate_source: "default", baseline_rate: 0.03 });
  });
});

describe("POST /admin/customers/holdout", () => {
  const bundle = () => JSON.parse(h.kv.get("v1:vm:acme") ?? "null") as { h?: number } | null;

  it("starts a test: the customer row, a test period from ten minutes on, and h in the bundle", async () => {
    const before = Date.now();
    const r = await call("POST", "/admin/customers/holdout", { customer_id: "acme", percent: 20 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, percent: 20, ended_test_id: null });
    const since = r.json.since as number;
    expect(since - before).toBeGreaterThanOrEqual(10 * 60_000);
    expect(since - before).toBeLessThan(10 * 60_000 + 5_000);
    expect(
      h.db.prepare("SELECT holdout_percent, holdout_since FROM customers WHERE id = 'acme'").get(),
    ).toEqual({
      holdout_percent: 20,
      holdout_since: since,
    });
    expect(h.db.prepare("SELECT percent, started_at, ended_at FROM holdout_tests").all()).toEqual([
      { percent: 20, started_at: since, ended_at: null },
    ]);
    expect(bundle()?.h).toBe(20);
  });

  it("the same percent again changes nothing; another percent starts a new period", async () => {
    const first = await call("POST", "/admin/customers/holdout", {
      customer_id: "acme",
      percent: 20,
    });
    const again = await call("POST", "/admin/customers/holdout", {
      customer_id: "acme",
      percent: 20,
    });
    expect(again.json.test_id).toBe(first.json.test_id);
    const ten = await call("POST", "/admin/customers/holdout", {
      customer_id: "acme",
      percent: 10,
    });
    expect(ten.json.ended_test_id).toBe(first.json.test_id);
    const rows = h.db
      .prepare("SELECT percent, ended_at FROM holdout_tests ORDER BY started_at")
      .all() as Array<{
      percent: number;
      ended_at: number | null;
    }>;
    expect(rows.map((r) => r.percent)).toEqual([20, 10]);
    expect(rows[0]?.ended_at).not.toBeNull();
    expect(rows[1]?.ended_at).toBeNull();
    expect(bundle()?.h).toBe(10);
  });

  it("Off ends the test and writes 0, never NULL", async () => {
    await call("POST", "/admin/customers/holdout", { customer_id: "acme", percent: 50 });
    const off = await call("POST", "/admin/customers/holdout", { customer_id: "acme", percent: 0 });
    expect(off.json).toMatchObject({ percent: 0, since: null, test_id: null });
    expect(
      h.db.prepare("SELECT holdout_percent, holdout_since FROM customers WHERE id = 'acme'").get(),
    ).toEqual({
      holdout_percent: 0,
      holdout_since: null,
    });
    expect(bundle()?.h).toBe(0);
    const r = await call("GET", "/admin/analytics/lift?customer_id=acme");
    expect(["ended", "ended_early"]).toContain(r.json.state);
  });

  it("refuses any other percent and an unknown customer", async () => {
    for (const percent of [5, 30, 100, "20", null]) {
      expect(
        (await call("POST", "/admin/customers/holdout", { customer_id: "acme", percent })).status,
      ).toBe(400);
    }
    expect(
      (await call("POST", "/admin/customers/holdout", { customer_id: "nope", percent: 20 })).status,
    ).toBe(404);
  });
});

describe("GET /admin/analytics/weekly", () => {
  it("answers a draft, never sends anything", async () => {
    const r = await call("GET", "/admin/analytics/weekly?customer_id=acme");
    expect(r.status).toBe(200);
    expect(r.json.send).toBe("draft");
    expect(typeof r.json.subject).toBe("string");
    expect(h.alerts).toEqual([]);
  });
});

describe("POST /admin/proof/backfill", () => {
  it("rolls up the closed days still holding markers, idempotently", async () => {
    h.ev({
      ts: Date.now() - 2 * 86_400_000,
      type: "variant_shown",
      visit: "a".repeat(32),
      arm: "treat",
    });
    const r1 = await call("POST", "/admin/proof/backfill", {
      customer_id: "acme",
      what: "outcomes",
    });
    expect(r1.json).toMatchObject({ ok: true, days: 31 });
    const rows = () => h.db.prepare("SELECT arm, visits FROM exposure_outcomes").all();
    const first = rows();
    expect(first).toEqual([{ arm: "treat", visits: 1 }]);
    await call("POST", "/admin/proof/backfill", { customer_id: "acme", what: "outcomes" });
    expect(rows()).toEqual(first);
    expect(
      (await call("POST", "/admin/proof/backfill", { customer_id: "acme", what: "x" })).status,
    ).toBe(400);
  });
});
