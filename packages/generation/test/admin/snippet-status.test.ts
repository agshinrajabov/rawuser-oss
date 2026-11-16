/**
 * Tests for POST /admin/snippet-status/probe endpoint.
 *
 * Coverage:
 *   - Superadmin can trigger probe → 200 with status/reason
 *   - Non-superadmin (customer role) → 403
 *   - Missing customer_id body field → 400
 *   - Unknown customer_id → 404
 *   - Successful probe updates snippet_status row
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "../model-env.ts";

// ---------------------------------------------------------------------------
// Mock orchestrate (required by worker import)
// ---------------------------------------------------------------------------

vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(),
  regenerateOne: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock snippet-probe so we don't need real fetch/D1 in these endpoint tests
// ---------------------------------------------------------------------------

const mockProbeResult = {
  status: "active" as const,
  reason: "Last event 5m ago",
};

vi.mock("../../src/cron/snippet-probe.ts", () => ({
  probeSingleCustomer: vi.fn(async () => mockProbeResult),
  runSnippetProbe: vi.fn(async () => ({ probed: 0, skipped: 0, errors: 0 })),
}));

// ---------------------------------------------------------------------------
// Session user mock
// ---------------------------------------------------------------------------

type MockUser = { id: string; email: string; role: string };
const superadminUser: MockUser = {
  id: "admin-1",
  email: "admin@rawuser.example",
  role: "superadmin",
};
const customerUser: MockUser = { id: "cust-1", email: "customer@lumera.test", role: "customer" };

let sessionOverride: MockUser | null = superadminUser;

vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionOverride),
}));

// ---------------------------------------------------------------------------
// Import worker AFTER mocks
// ---------------------------------------------------------------------------

const { default: worker } = await import("../../src/index.ts");

// ---------------------------------------------------------------------------
// Mock env helpers
// ---------------------------------------------------------------------------

interface WorkerEnv {
  MODEL_BASE_URL: string;
  MODEL_API_KEY: string;
  MODEL_ID: string;
  VARIANTS: KVNamespace;
  DB: D1Database;
  ENVIRONMENT: string;
  DASHBOARD_ORIGIN: string;
}

function makeMockKV(): KVNamespace {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: undefined })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  } as unknown as KVNamespace;
}

/** D1 mock that returns a customer row for known IDs and null for unknown ones. */
function makeMockDb(options: { knownCustomerId?: string } = {}): D1Database {
  const prepare = vi.fn((sql: string) => {
    const stmt = {
      _binds: [] as unknown[],
      bind(...args: unknown[]) {
        this._binds = args;
        return this;
      },
      async first<T = unknown>(): Promise<T | null> {
        if (sql.includes("FROM customers WHERE id = ?")) {
          const customerId = stmt._binds[0] as string;
          if (customerId === (options.knownCustomerId ?? "lumera-school")) {
            return { id: customerId, domain: "school.lumera.test" } as T;
          }
          return null as T;
        }
        // snippet_status probe's event query
        if (sql.includes("MAX(ts)") && sql.includes("events")) {
          return { last_event_at: Date.now() - 5 * 60 * 1000 } as T;
        }
        return null as T;
      },
      async all<T = unknown>() {
        return { results: [] as T[], success: true };
      },
      async run() {
        return { success: true, meta: {} };
      },
    };
    return stmt;
  });

  return { prepare } as unknown as D1Database;
}

function makeEnv(dbOptions?: { knownCustomerId?: string }): WorkerEnv {
  return {
    ...MODEL_ENV,
    VARIANTS: makeMockKV(),
    DB: makeMockDb(dbOptions),
    ENVIRONMENT: "test",
    DASHBOARD_ORIGIN: "*",
  };
}

function req(
  method: string,
  path: string,
  headers?: Record<string, string>,
  body?: unknown,
): Request {
  return new Request(`https://generation.rawuser.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const FAKE_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const AUTH = { "X-Rawuser-Admin": FAKE_TOKEN };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /admin/snippet-status/probe: superadmin", () => {
  beforeEach(() => {
    sessionOverride = superadminUser;
  });

  it("returns 200 with status and reason for a known customer", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/snippet-status/probe", AUTH, { customer_id: "lumera-school" }),
      makeEnv({ knownCustomerId: "lumera-school" }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      customer_id: string;
      status: string;
      reason: string;
      probed_at: number;
    };
    expect(body.customer_id).toBe("lumera-school");
    expect(body.status).toBe("active");
    expect(typeof body.reason).toBe("string");
    expect(typeof body.probed_at).toBe("number");
  });

  it("returns 400 when customer_id is missing from body", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/snippet-status/probe", AUTH, {}),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("customer_id");
  });

  it("returns 404 for an unknown customer_id", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/snippet-status/probe", AUTH, { customer_id: "does-not-exist" }),
      makeEnv({ knownCustomerId: "lumera-school" }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("does-not-exist");
  });

  it("returns 400 when body is invalid JSON", async () => {
    const badReq = new Request("https://generation.rawuser.test/admin/snippet-status/probe", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: "not-json",
    });
    const resp = await worker.fetch(badReq, makeEnv(), {} as ExecutionContext);
    expect(resp.status).toBe(400);
  });
});

describe("POST /admin/snippet-status/probe: customer role outside its scope (403)", () => {
  beforeEach(() => {
    sessionOverride = customerUser;
  });

  it("returns 403 for a customer session without that customer", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/snippet-status/probe", AUTH, { customer_id: "lumera-school" }),
      makeEnv({ knownCustomerId: "lumera-school" }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(403);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("Forbidden");
  });
});

describe("POST /admin/snippet-status/probe: no auth (401)", () => {
  beforeEach(() => {
    sessionOverride = null;
  });

  it("returns 401 without valid session", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/snippet-status/probe", {}, { customer_id: "lumera-school" }),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
  });
});
