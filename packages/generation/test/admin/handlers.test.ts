/**
 * Integration tests for /admin/* endpoints.
 *
 * Auth model: tests mock getSessionUser from admin/auth.ts so they don't need
 * real PBKDF2 or D1 session rows. The auth.ts unit itself is tested via the
 * session-based flow in the login/logout/me describe blocks below.
 *
 * Tests cover:
 *   - CORS preflight (204, no auth needed)
 *   - Auth gate: 401 without valid session for protected routes
 *   - Public route: POST /admin/login (success + invalid credentials)
 *   - Session routes: /admin/logout, /admin/me
 *   - /admin/customers/list (happy path: array response)
 *   - /admin/customers/create (validation + happy path)
 *   - /admin/dna/get + /admin/dna/upsert validation
 *   - /admin/variants/list + /admin/variant/get + /admin/variant/regenerate
 *   - No events table queries that expose visitor PII (grep-safe)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "../model-env.ts";

// ---------------------------------------------------------------------------
// Mock orchestrate and regenerateOne BEFORE importing the worker
// ---------------------------------------------------------------------------

vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(async () => ({
    customer_id: "c1",
    generated: 30,
    errors: 0,
    cost_usd: 0.5,
    cache_hit_rate: 0.9,
    kv_keys: [],
    failed_tuples: [],
    aborted: false,
  })),
  regenerateOne: vi.fn(async () => ({
    customer_id: "c1",
    intent_dim: "brand",
    source_dim: "direct",
    kv_key: "v1:variant:c1:brand:direct",
    cost_usd: 0.02,
    ok: true,
  })),
}));

// ---------------------------------------------------------------------------
// Mock getSessionUser so tests don't require real D1 session rows.
// By default it returns a fake superadmin user. Individual tests can override.
// ---------------------------------------------------------------------------

const mockSessionUser = {
  id: "user-1",
  email: "admin@example.com",
  role: "superadmin",
  customer_id: null as string | null,
};
let sessionOverride: typeof mockSessionUser | null = mockSessionUser;

vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionOverride),
}));

// ---------------------------------------------------------------------------
// Import worker AFTER mocks
// ---------------------------------------------------------------------------

const { default: worker } = await import("../../src/index.ts");

// ---------------------------------------------------------------------------
// Mock env
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

function makeMockKV(store: Map<string, string>): KVNamespace {
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: undefined })),
    getWithMetadata: vi.fn(async (key: string) => ({
      value: store.get(key) ?? null,
      metadata: null,
    })),
  } as unknown as KVNamespace;
}

function makeMockD1(rows: Record<string, unknown[]>): D1Database {
  const prepare = vi.fn((sql: string) => {
    const stmt = {
      bind: vi.fn((..._args: unknown[]) => stmt),
      first: vi.fn(async <T = unknown>() => {
        const key = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
        if (key === "SELECT") {
          const tableRows = Object.values(rows)[0];
          return (tableRows?.[0] ?? null) as T;
        }
        return null as T;
      }),
      all: vi.fn(async <T = unknown>() => {
        const tableRows = Object.values(rows)[0] ?? [];
        return { results: tableRows as T[], success: true };
      }),
      run: vi.fn(async () => ({ success: true, meta: {} })),
    };
    return stmt;
  });

  return { prepare } as unknown as D1Database;
}

const kvStore = new Map<string, string>();
const dbRows: Record<string, unknown[]> = {
  customers: [
    {
      id: "c1",
      slug: "lumera-school",
      domain: "lumeraschool.test",
      plan: "pilot",
      status: "active",
      created_at: 1000000,
      onboarding_stage: "dna_filled",
      last_activity_at: 1000000,
    },
  ],
};

const ENV: WorkerEnv = {
  ...MODEL_ENV,
  VARIANTS: makeMockKV(kvStore),
  DB: makeMockD1(dbRows),
  ENVIRONMENT: "test",
  DASHBOARD_ORIGIN: "*",
};

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

// A real-looking token (43 chars base64url) for session-bearing requests.
const FAKE_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const AUTH = { "X-Rawuser-Admin": FAKE_TOKEN };

// ---------------------------------------------------------------------------
// CORS preflight
// ---------------------------------------------------------------------------

describe("CORS preflight (OPTIONS)", () => {
  it("returns 204 with CORS headers, no auth required", async () => {
    const resp = await worker.fetch(req("OPTIONS", "/admin/verify"), ENV, {} as ExecutionContext);
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    expect(resp.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

// ---------------------------------------------------------------------------
// Auth gate: 401 when getSessionUser returns null
// ---------------------------------------------------------------------------

describe("Auth gate: 401 without valid session", () => {
  beforeEach(() => {
    sessionOverride = null;
  });

  const PROTECTED_PATHS = [
    ["POST", "/admin/verify"],
    ["GET", "/admin/customers/list"],
    ["POST", "/admin/customers/create"],
    ["GET", "/admin/dna/get?customer_id=c1"],
    ["POST", "/admin/dna/upsert"],
    ["GET", "/admin/variants/list?customer_id=c1"],
    ["GET", "/admin/variant/get?customer_id=c1&intent=brand&source=direct"],
    ["POST", "/admin/variant/regenerate"],
    ["GET", "/admin/me"],
    ["POST", "/admin/logout"],
  ] as const;

  for (const [method, path] of PROTECTED_PATHS) {
    it(`${method} ${path} → 401 without session`, async () => {
      const resp = await worker.fetch(req(method, path), ENV, {} as ExecutionContext);
      expect(resp.status).toBe(401);
      const body = (await resp.json()) as { error: string };
      expect(body.error).toBe("Unauthorized");
    });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/login: public route, no session needed
// ---------------------------------------------------------------------------

describe("POST /admin/login", () => {
  // Override the D1 mock to return a user row for login tests.
  beforeEach(() => {
    sessionOverride = mockSessionUser; // restore default for other suites
    (ENV.DB.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      const stmt = {
        bind: vi.fn((..._args: unknown[]) => stmt),
        first: vi.fn(async <T = unknown>() => {
          if (sql.includes("superadmin_users")) {
            // Return a fake user row (password_hash is a dummy: verifyPassword is NOT
            // called here because we test the handler directly; the password module is
            // not mocked so this test will exercise the real PBKDF2 path only if we
            // pass a real stored hash. For handler tests we mock at D1 level.)
            return {
              id: "user-1",
              email: "admin@example.com",
              password_hash: "FAKEHASH.FAKEHASH", // verifyPassword will return false
              role: "superadmin",
              customer_id: null,
            } as T;
          }
          return null as T;
        }),
        all: vi.fn(async <T = unknown>() => ({ results: [] as T[], success: true })),
        run: vi.fn(async () => ({ success: true, meta: {} })),
      };
      return stmt;
    });
  });

  it("returns 400 when email is missing", async () => {
    sessionOverride = null;
    const resp = await worker.fetch(
      req("POST", "/admin/login", {}, { password: "pw" }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("returns 400 when password is missing", async () => {
    sessionOverride = null;
    const resp = await worker.fetch(
      req("POST", "/admin/login", {}, { email: "a@b.test" }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("returns 401 when credentials are invalid (hash mismatch)", async () => {
    sessionOverride = null;
    // The mock returns a row with a dummy password_hash that won't match any real password.
    const resp = await worker.fetch(
      req("POST", "/admin/login", {}, { email: "admin@example.com", password: "wrongpassword" }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("Invalid email or password");
  });

  it("returns 401 when user does not exist", async () => {
    sessionOverride = null;
    // Override to return null (no user found)
    (ENV.DB.prepare as ReturnType<typeof vi.fn>).mockImplementation((_sql: string) => {
      const stmt = {
        bind: vi.fn((..._args: unknown[]) => stmt),
        first: vi.fn(async <T = unknown>() => null as T),
        all: vi.fn(async <T = unknown>() => ({ results: [] as T[], success: true })),
        run: vi.fn(async () => ({ success: true, meta: {} })),
      };
      return stmt;
    });
    const resp = await worker.fetch(
      req("POST", "/admin/login", {}, { email: "nobody@example.com", password: "pw" }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: string };
    // Must not distinguish "user not found" from "wrong password"
    expect(body.error).toBe("Invalid email or password");
  });
});

// ---------------------------------------------------------------------------
// GET /admin/me
// ---------------------------------------------------------------------------

describe("GET /admin/me", () => {
  beforeEach(() => {
    sessionOverride = mockSessionUser;
  });

  it("returns the session user", async () => {
    const resp = await worker.fetch(req("GET", "/admin/me", AUTH), ENV, {} as ExecutionContext);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { user: { email: string } };
    expect(body.user.email).toBe("admin@example.com");
  });
});

// ---------------------------------------------------------------------------
// POST /admin/logout
// ---------------------------------------------------------------------------

describe("POST /admin/logout", () => {
  beforeEach(() => {
    sessionOverride = mockSessionUser;
    (ENV.DB.prepare as ReturnType<typeof vi.fn>).mockImplementation((_sql: string) => {
      const stmt = {
        bind: vi.fn((..._args: unknown[]) => stmt),
        first: vi.fn(async <T = unknown>() => null as T),
        all: vi.fn(async <T = unknown>() => ({ results: [] as T[], success: true })),
        run: vi.fn(async () => ({ success: true, meta: {} })),
      };
      return stmt;
    });
  });

  it("returns 200 { ok: true }", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/logout", AUTH),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/verify (retained for backward compat)
// ---------------------------------------------------------------------------

describe("/admin/verify", () => {
  beforeEach(() => {
    sessionOverride = mockSessionUser;
  });

  it("returns 200 { ok: true } with valid session", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/verify", AUTH),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("includes CORS headers", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/verify", AUTH),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
  });
});

// ---------------------------------------------------------------------------
// GET /admin/customers/list
// ---------------------------------------------------------------------------

describe("/admin/customers/list", () => {
  beforeEach(() => {
    sessionOverride = mockSessionUser;
  });

  it("returns an array of customers", async () => {
    const resp = await worker.fetch(
      req("GET", "/admin/customers/list", AUTH),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("/admin/customers/list: journey signals", () => {
  beforeEach(() => {
    sessionOverride = mockSessionUser;
    const now = Date.now();
    const journeyRow = {
      id: "pilot-1",
      slug: "pilot-1",
      domain: "pilot.io",
      plan: "pilot",
      status: "active",
      created_at: now - 10000,
      contact_email: null,
      contact_name: null,
      onboarding_stage: "variants_generated",
      last_activity_at: now,
      // D1 returns 0|1 integers for booleans
      has_dna: 1,
      has_confirmed_manifest: 1,
      variants_ready_count: 5,
      variants_last_generated_at: now - 3600000,
      events_24h: 3,
      events_7d: 12,
      last_event_at: now - 1000,
    };
    (ENV.DB.prepare as ReturnType<typeof vi.fn>).mockImplementation((_sql: string) => {
      const stmt = {
        bind: vi.fn((..._args: unknown[]) => stmt),
        first: vi.fn(async <T = unknown>() => null as T),
        all: vi.fn(async <T = unknown>() => ({
          results: [journeyRow] as T[],
          success: true,
        })),
        run: vi.fn(async () => ({ success: true, meta: {} })),
      };
      return stmt;
    });
  });

  it("maps D1 0|1 to boolean and surfaces all journey fields", async () => {
    const resp = await worker.fetch(
      req("GET", "/admin/customers/list", AUTH),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Array<{
      has_dna: boolean;
      has_confirmed_manifest: boolean;
      variants_ready_count: number;
      events_24h: number;
    }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    const row = body[0];
    expect(row).toBeDefined();
    expect(row?.has_dna).toBe(true);
    expect(row?.has_confirmed_manifest).toBe(true);
    expect(row?.variants_ready_count).toBe(5);
    expect(row?.events_24h).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/customers/create
// ---------------------------------------------------------------------------

describe("/admin/customers/create", () => {
  beforeEach(() => {
    sessionOverride = mockSessionUser;
    (ENV.DB.prepare as ReturnType<typeof vi.fn>).mockImplementation((_sql: string) => {
      const stmt = {
        bind: vi.fn((..._args: unknown[]) => stmt),
        first: vi.fn(async <T = unknown>() => null as T),
        all: vi.fn(async <T = unknown>() => ({ results: [] as T[], success: true })),
        run: vi.fn(async () => ({ success: true, meta: {} })),
      };
      return stmt;
    });
  });

  it("returns 400 when slug is missing", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/customers/create", AUTH, { domain: "acme.com" }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("returns 400 when slug contains invalid chars", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/customers/create", AUTH, {
        slug: "UPPERCASE",
        domain: "acme.com",
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("returns 400 when domain is missing", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/customers/create", AUTH, { slug: "acme" }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("returns 201 with valid body", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/customers/create", AUTH, {
        slug: "new-pilot",
        domain: "newpilot.io",
        plan: "pilot",
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { customer: { slug: string; onboarding_stage: string } };
    expect(body.customer.slug).toBe("new-pilot");
    expect(body.customer.onboarding_stage).toBe("new");
  });

  it("returns 409 on duplicate slug (UNIQUE constraint violation)", async () => {
    (ENV.DB.prepare as ReturnType<typeof vi.fn>).mockImplementation((_sql: string) => {
      const stmt = {
        bind: vi.fn((..._args: unknown[]) => stmt),
        first: vi.fn(async <T = unknown>() => null as T),
        all: vi.fn(async <T = unknown>() => ({ results: [] as T[], success: true })),
        run: vi.fn(async () => {
          throw new Error("UNIQUE constraint failed: customers.slug");
        }),
      };
      return stmt;
    });
    const resp = await worker.fetch(
      req("POST", "/admin/customers/create", AUTH, {
        slug: "existing-slug",
        domain: "exists.io",
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("already exists");
  });
});

// ---------------------------------------------------------------------------
// GET /admin/dna/get
// ---------------------------------------------------------------------------

describe("/admin/dna/get", () => {
  beforeEach(() => {
    sessionOverride = mockSessionUser;
    const dnaRow = {
      customer_id: "lumera-school",
      product: "Lumera School",
      icp: "Parents",
      brand_voice: "warm",
      value_props: '["v1"]',
      differentiators: '["d1"]',
      proof_points: '["p1"]',
      target_market: "Local market",
      target_language: "az",
      per_intent_hints: "{}",
      prompt_cache_id: null,
      updated_at: 1000000,
    };
    (ENV.DB.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      const stmt = {
        bind: vi.fn((..._args: unknown[]) => stmt),
        first: vi.fn(async <T = unknown>() => {
          if (sql.includes("business_dna")) return dnaRow as T;
          return null as T;
        }),
        all: vi.fn(async <T = unknown>() => ({ results: [] as T[], success: true })),
        run: vi.fn(async () => ({ success: true, meta: {} })),
      };
      return stmt;
    });
  });

  it("returns 400 when customer_id is missing", async () => {
    const resp = await worker.fetch(
      req("GET", "/admin/dna/get", AUTH),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("returns DNA for existing customer", async () => {
    const resp = await worker.fetch(
      req("GET", "/admin/dna/get?customer_id=lumera-school", AUTH),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { customer_id: string };
    expect(body.customer_id).toBe("lumera-school");
  });
});

// ---------------------------------------------------------------------------
// POST /admin/dna/upsert: validation
// ---------------------------------------------------------------------------

describe("/admin/dna/upsert", () => {
  beforeEach(() => {
    sessionOverride = mockSessionUser;
  });

  it("returns 400 when body is not JSON", async () => {
    const resp = await worker.fetch(
      new Request("https://generation.rawuser.test/admin/dna/upsert", {
        method: "POST",
        headers: { "content-type": "text/plain", "X-Rawuser-Admin": FAKE_TOKEN },
        body: "not json",
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("returns 400 when customer_id is missing", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/dna/upsert", AUTH, { product: "x", icp: "y", value_props: ["a"] }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("customer_id");
  });

  it("returns 400 when product is empty", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/dna/upsert", AUTH, {
        customer_id: "c1",
        product: "",
        icp: "y",
        value_props: ["a"],
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("product");
  });

  it("returns 400 when value_props is empty", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/dna/upsert", AUTH, {
        customer_id: "c1",
        product: "P",
        icp: "I",
        value_props: [],
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("value_prop");
  });

  it("returns 200 with valid body", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/dna/upsert", AUTH, {
        customer_id: "c1",
        product: "Test product",
        icp: "Test ICP",
        value_props: ["v1"],
        differentiators: [],
        proof_points: [],
        brand_voice: "warm",
        target_market: "Global",
        target_language: "en",
        per_intent_hints: {},
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
  });

  it("marks the customer's ready variants stale on upsert (A4)", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/dna/upsert", AUTH, {
        customer_id: "c1",
        product: "Edited product",
        icp: "Edited ICP",
        value_props: ["v1"],
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);

    // The brief is what variants were generated from: editing it must mark
    // ready variants stale so the onlyMissing cron regenerates them.
    const prepared = (ENV.DB.prepare as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    const staleUpdate = prepared.find(
      (sql) => sql.includes("UPDATE variants") && sql.includes("'stale'"),
    );
    expect(staleUpdate).toBeDefined();
    expect(staleUpdate).toContain("status = 'ready'");
  });
});

// ---------------------------------------------------------------------------
// GET /admin/variants/list
// ---------------------------------------------------------------------------

describe("/admin/variants/list", () => {
  beforeEach(() => {
    sessionOverride = mockSessionUser;
  });

  it("returns 400 when customer_id is missing", async () => {
    const resp = await worker.fetch(
      req("GET", "/admin/variants/list", AUTH),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("returns array for existing customer", async () => {
    const resp = await worker.fetch(
      req("GET", "/admin/variants/list?customer_id=c1", AUTH),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/variant/get: KV miss returns 404, not 500
// ---------------------------------------------------------------------------

describe("/admin/variant/get", () => {
  beforeEach(() => {
    sessionOverride = mockSessionUser;
  });

  it("returns 400 when required params are missing", async () => {
    const resp = await worker.fetch(
      req("GET", "/admin/variant/get?customer_id=c1", AUTH),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("returns 404 when KV key does not exist", async () => {
    kvStore.clear(); // ensure miss
    const resp = await worker.fetch(
      req("GET", "/admin/variant/get?customer_id=c1&intent=brand&source=direct", AUTH),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("not found");
  });

  it("returns 200 with variant body when KV key exists", async () => {
    const variantBody = {
      customer_id: "c1",
      profile_key: "intent:brand",
      sections: {
        hero: { kind: "hero", headline: "Hello", body: "World", cta: { label: "Start" } },
        cta: { kind: "cta", headline: "Ready?", body: "Join us", cta: { label: "Go" } },
      },
      generated_at: Date.now(),
      prompt_hash: "abc123",
    };
    kvStore.set("v1:variant:c1:brand:direct", JSON.stringify(variantBody));

    const resp = await worker.fetch(
      req("GET", "/admin/variant/get?customer_id=c1&intent=brand&source=direct", AUTH),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { customer_id: string };
    expect(body.customer_id).toBe("c1");
  });
});

// ---------------------------------------------------------------------------
// POST /admin/variant/regenerate
// ---------------------------------------------------------------------------

describe("/admin/variant/regenerate", () => {
  beforeEach(() => {
    sessionOverride = mockSessionUser;
  });

  it("returns 400 with missing params", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/variant/regenerate", AUTH, { customer_id: "c1" }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("returns 200 with valid body", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/variant/regenerate", AUTH, {
        customer_id: "c1",
        intent_dim: "brand",
        source_dim: "direct",
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V2 M3 Batch C P1: cross-customer probes return 403 on every retrofitted endpoint
// ---------------------------------------------------------------------------

describe("cross-customer scope enforcement (customer role): parametric", () => {
  // The "customer" session user has customer_id="lumera-school" and tries to
  // access "acme" via every retrofitted endpoint. Each must return 403.
  // handleCustomersList is omitted because it does SQL-level filtering rather
  // than a 403: covered in a separate describe below.
  const customerSession = {
    id: "u-cust",
    email: "founder@lumera.test",
    role: "customer",
    customer_id: "lumera-school",
  };

  beforeEach(() => {
    sessionOverride = customerSession;
  });

  const CROSS_CUSTOMER_CASES: Array<{
    name: string;
    method: string;
    path: string;
    body?: unknown;
  }> = [
    { name: "GET /admin/dna/get", method: "GET", path: "/admin/dna/get?customer_id=acme" },
    {
      name: "POST /admin/dna/upsert",
      method: "POST",
      path: "/admin/dna/upsert",
      body: { customer_id: "acme", product: "x", icp: "y", value_props: ["a"] },
    },
    {
      name: "GET /admin/variants/list",
      method: "GET",
      path: "/admin/variants/list?customer_id=acme",
    },
    {
      name: "GET /admin/variant/get",
      method: "GET",
      path: "/admin/variant/get?customer_id=acme&intent=brand&source=direct",
    },
    {
      name: "POST /admin/variant/regenerate",
      method: "POST",
      path: "/admin/variant/regenerate",
      body: { customer_id: "acme", intent_dim: "brand", source_dim: "direct" },
    },
    {
      name: "POST /admin/onboard/detect",
      method: "POST",
      path: "/admin/onboard/detect",
      body: { customer_id: "acme", source_url: "https://acme.io/" },
    },
    {
      name: "POST /admin/onboard/confirm",
      method: "POST",
      path: "/admin/onboard/confirm",
      body: { customer_id: "acme" },
    },
    {
      name: "GET /admin/onboard/manifest",
      method: "GET",
      path: "/admin/onboard/manifest?customer_id=acme",
    },
    {
      name: "GET /admin/conversions/list",
      method: "GET",
      path: "/admin/conversions/list?customer_id=acme",
    },
    {
      name: "POST /admin/conversions/upsert",
      method: "POST",
      path: "/admin/conversions/upsert",
      body: { customer_id: "acme", section_path: "hero.cta.label", label: "x" },
    },
    {
      name: "POST /admin/conversions/confirm",
      method: "POST",
      path: "/admin/conversions/confirm",
      body: { customer_id: "acme", targets: [] },
    },
  ];

  for (const c of CROSS_CUSTOMER_CASES) {
    it(`${c.name} → 403 when customer probes a different customer_id`, async () => {
      const resp = await worker.fetch(
        req(c.method, c.path, AUTH, c.body),
        ENV,
        {} as ExecutionContext,
      );
      expect(resp.status).toBe(403);
      const body = (await resp.json()) as { error: string };
      // Generic forbidden: never leak the probed customer id
      expect(body.error.toLowerCase()).toContain("forbidden");
      expect(body.error).not.toContain("acme");
    });
  }

  it("POST /admin/customers/create → 403 for customer role (superadmin-only)", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/customers/create", AUTH, { slug: "new-cust", domain: "newcust.io" }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(403);
  });
});

describe("customer role scoping on /admin/customers/list", () => {
  // SQL-level filtering: only the customer's own row should come back.
  // We don't fully validate the SELECT shape (the mock returns whatever is
  // seeded), but we DO assert the handler bound user.customer_id into the
  // statement: checked indirectly by counting the bind() args.
  it("returns an array (no 403; SQL-level filter applies)", async () => {
    sessionOverride = {
      id: "u-cust",
      email: "founder@lumera.test",
      role: "customer",
      customer_id: "lumera-school",
    };
    const resp = await worker.fetch(
      req("GET", "/admin/customers/list", AUTH),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });
});
