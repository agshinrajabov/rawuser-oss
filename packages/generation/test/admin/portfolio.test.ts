/**
 * Tests for /admin/portfolio/* endpoints.
 *
 * Coverage:
 *   - Superadmin can list portfolio customers (200)
 *   - Customer-role blocked from portfolio endpoints (403)
 *   - /attention correctly derives snippet-removed signal
 *   - /attention correctly derives skipped-rate-high signal
 *   - Health badge correctly computed: green/yellow/red
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "../model-env.ts";

// ---------------------------------------------------------------------------
// Auth mock
// ---------------------------------------------------------------------------

const mockSuperadmin = {
  id: "u-admin",
  email: "admin@rawuser.example",
  role: "superadmin" as const,
  customer_id: null as string | null,
};

const mockCustomerUser = {
  id: "u-cust",
  email: "cust@example.org",
  role: "customer" as const,
  customer_id: "cust-1",
};

let activeUser: typeof mockSuperadmin | typeof mockCustomerUser = mockSuperadmin;

vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => activeUser),
}));

vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(async () => ({ customer_id: "x", generated: 0, errors: 0 })),
  regenerateOne: vi.fn(async () => ({ ok: true })),
}));

const { default: worker } = await import("../../src/index.ts");

// ---------------------------------------------------------------------------
// D1 mock factory
// ---------------------------------------------------------------------------

/** Per-test override for DB query responses. */
let dbResponses: {
  customers?: { id: string; slug: string; domain: string }[];
  agg7d?: Record<string, unknown> | null;
  agg24h?: Record<string, unknown> | null;
  snippetStatus?: Record<string, unknown> | null;
} = {};

function makeMockDb(): D1Database {
  return {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        _binds: [] as unknown[],
        bind(...args: unknown[]) {
          this._binds = [...args];
          return this;
        },
        async first<T>() {
          if (sql.includes("superadmin_sessions")) {
            return {
              id: activeUser.id,
              email: activeUser.email,
              role: activeUser.role,
              customer_id: (activeUser as typeof mockCustomerUser).customer_id ?? null,
            } as T;
          }
          if (sql.includes("snippet_status")) {
            return (dbResponses.snippetStatus ?? null) as T;
          }
          if (sql.includes("analytics_aggregates")) {
            if (sql.includes("24h") || (sql.includes("?") && sql.includes("24h"))) {
              return (dbResponses.agg24h ?? null) as T;
            }
            return (dbResponses.agg7d ?? null) as T;
          }
          return null as T;
        },
        async all<T>() {
          if (sql.includes("FROM customers")) {
            return { results: (dbResponses.customers ?? []) as T[], success: true };
          }
          return { results: [] as T[], success: true };
        },
        async run() {
          return { success: true, meta: {} };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    }),
  } as unknown as D1Database;
}

function makeEnv() {
  return {
    ...MODEL_ENV,
    VARIANTS: {} as KVNamespace,
    DB: makeMockDb(),
    ENVIRONMENT: "test",
    DASHBOARD_ORIGIN: "*",
  };
}

function req(path: string): Request {
  return new Request(`https://generation.rawuser.test${path}`, {
    method: "GET",
    headers: { "X-Rawuser-Admin": "tok" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/admin/portfolio/customers: auth", () => {
  beforeEach(() => {
    dbResponses = {
      customers: [{ id: "cust-1", slug: "c1", domain: "c1.example.com" }],
      snippetStatus: { customer_id: "cust-1", status: "active" },
      agg7d: {
        customer_id: "cust-1",
        holdout_lift: 0.15,
        holdout_significance: "sig_95",
        personalized_visits: 500,
        skipped_visits: 20,
        natural_lift: 0.3,
      },
      agg24h: { customer_id: "cust-1", total_visits: 200 },
    };
  });

  it("superadmin can list portfolio customers (200)", async () => {
    activeUser = mockSuperadmin;
    const resp = await worker.fetch(
      req("/admin/portfolio/customers"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
  });

  it("customer-role blocked (403)", async () => {
    activeUser = mockCustomerUser;
    const resp = await worker.fetch(
      req("/admin/portfolio/customers"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(403);
  });
});

describe("/admin/portfolio/customers: portfolio item shape", () => {
  beforeEach(() => {
    activeUser = mockSuperadmin;
    dbResponses = {
      customers: [{ id: "cust-1", slug: "c1", domain: "c1.example.com" }],
      snippetStatus: { customer_id: "cust-1", status: "active" },
      agg7d: {
        customer_id: "cust-1",
        holdout_lift: 0.15,
        holdout_significance: "sig_95",
        personalized_visits: 500,
        skipped_visits: 20,
        natural_lift: 0.3,
      },
      agg24h: { customer_id: "cust-1", total_visits: 200 },
    };
  });

  it("returns array of portfolio items with expected fields", async () => {
    const resp = await worker.fetch(
      req("/admin/portfolio/customers"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const items = (await resp.json()) as Array<{
      customer_id: string;
      health: string;
      snippet_status: string;
      holdout_lift_7d: number | null;
      visits_24h: number;
      signals: string[];
    }>;
    expect(Array.isArray(items)).toBe(true);
    const item = items[0];
    expect(item.customer_id).toBe("cust-1");
    expect(["green", "yellow", "red"]).toContain(item.health);
    expect(item.snippet_status).toBe("active");
    expect(item.holdout_lift_7d).toBe(0.15);
    expect(item.visits_24h).toBe(200);
    expect(Array.isArray(item.signals)).toBe(true);
  });

  it("health=red when snippet_status=removed", async () => {
    dbResponses.snippetStatus = { customer_id: "cust-1", status: "removed" };
    const resp = await worker.fetch(
      req("/admin/portfolio/customers"),
      makeEnv(),
      {} as ExecutionContext,
    );
    const items = (await resp.json()) as Array<{ health: string; signals: string[] }>;
    expect(items[0].health).toBe("red");
    expect(items[0].signals).toContain("snippet-removed");
  });
});

describe("/admin/portfolio/attention: signal derivation", () => {
  beforeEach(() => {
    activeUser = mockSuperadmin;
  });

  it("snippet-removed signal when status=removed", async () => {
    dbResponses = {
      customers: [{ id: "cust-1", slug: "c1", domain: "c1.example.com" }],
      snippetStatus: { status: "removed" },
      agg7d: { personalized_visits: 100, skipped_visits: 5, holdout_lift: 0.1 },
    };
    const resp = await worker.fetch(
      req("/admin/portfolio/attention"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const items = (await resp.json()) as Array<{ type: string; customer_id: string }>;
    const signal = items.find((i) => i.type === "snippet-removed");
    expect(signal).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: signal existence asserted above
    expect(signal!.customer_id).toBe("cust-1");
  });

  it("skipped-rate-high signal when skipped > 30%", async () => {
    dbResponses = {
      customers: [{ id: "cust-2", slug: "c2", domain: "c2.example.com" }],
      snippetStatus: { status: "active" },
      agg7d: {
        personalized_visits: 60,
        skipped_visits: 40, // 40% skipped → above 30% threshold
        holdout_lift: 0.05,
      },
    };
    const resp = await worker.fetch(
      req("/admin/portfolio/attention"),
      makeEnv(),
      {} as ExecutionContext,
    );
    const items = (await resp.json()) as Array<{ type: string }>;
    expect(items.some((i) => i.type === "skipped-rate-high")).toBe(true);
  });

  it("customer-role blocked from attention (403)", async () => {
    activeUser = mockCustomerUser;
    const resp = await worker.fetch(
      req("/admin/portfolio/attention"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(403);
  });
});
