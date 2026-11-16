/**
 * Integration tests for /admin/customer-users/{create, setup}.
 *
 * Coverage:
 *   - create: superadmin only (customer role → 403)
 *   - create: validates customer exists, email shape
 *   - create + setup roundtrip: customer can claim password and receives
 *     a usable session token (subsequent /admin/me with the token works)
 *   - expired token rejected (return code intentionally generic 404)
 *   - already-consumed token rejected
 *   - double-consume of same token rejected (second call after a successful
 *     setup must fail without revealing why)
 *   - missing/short/invalid password rejected
 *
 * The D1 mock here is an in-memory store keyed by table: close enough to
 * the real query shapes for the handler's INSERTs/UPDATEs/SELECTs to
 * roundtrip correctly. The auth.ts mock from handlers.test.ts is NOT used
 * here because setup intentionally runs without auth.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "../model-env.ts";

// ---------------------------------------------------------------------------
// In-memory D1 mock: sufficient for the handler's exact SQL shapes.
//
// Tables tracked:
//   customers, superadmin_users, superadmin_sessions, customer_setup_tokens
//
// Match-and-bind is brittle but intentional: we inspect the SQL text to
// route each prepare() call, then apply bound parameters in a simple
// case statement. Any rewrite of the SQL text in customer-users.ts will
// surface here as a test failure: which is the correct safety net.
// ---------------------------------------------------------------------------

interface Tables {
  customers: Array<{ id: string }>;
  superadmin_users: Array<{
    id: string;
    email: string;
    password_hash: string;
    role: string;
    customer_id: string | null;
    created_at: number;
  }>;
  superadmin_sessions: Array<{
    token_hash: string;
    user_id: string;
    expires_at: number;
    created_at: number;
    user_agent: string | null;
    last_seen_at: number;
  }>;
  customer_setup_tokens: Array<{
    token_hash: string;
    user_id: string;
    expires_at: number;
    consumed_at: number | null;
    created_at: number;
  }>;
}

function freshTables(): Tables {
  return {
    customers: [{ id: "lumera-school" }, { id: "acme" }],
    superadmin_users: [],
    superadmin_sessions: [],
    customer_setup_tokens: [],
  };
}

function makeMockD1(tables: Tables): D1Database {
  // biome-ignore lint/suspicious/noExplicitAny: D1 mock needs flexible shape
  const prepare = vi.fn((sql: string): any => {
    let bound: unknown[] = [];
    const stmt = {
      // biome-ignore lint/suspicious/noExplicitAny: bind() returns the same chainable
      bind: vi.fn((...args: unknown[]): any => {
        bound = args;
        return stmt;
      }),
      first: vi.fn(async <T = unknown>() => {
        if (sql.includes("FROM customers WHERE id = ?")) {
          const id = bound[0] as string;
          return (tables.customers.find((c) => c.id === id) ?? null) as T;
        }
        if (sql.includes("FROM superadmin_users WHERE email = ?")) {
          const email = bound[0] as string;
          return (tables.superadmin_users.find((u) => u.email === email) ?? null) as T;
        }
        if (sql.includes("FROM superadmin_users WHERE id = ?")) {
          const id = bound[0] as string;
          return (tables.superadmin_users.find((u) => u.id === id) ?? null) as T;
        }
        if (sql.includes("FROM customer_setup_tokens WHERE token_hash = ?")) {
          const hash = bound[0] as string;
          return (tables.customer_setup_tokens.find((t) => t.token_hash === hash) ?? null) as T;
        }
        // /admin/me joined SELECT (from auth.ts): handled by exercising the
        // session token: looks up superadmin_sessions joined with superadmin_users.
        if (sql.includes("FROM superadmin_sessions s") && sql.includes("JOIN superadmin_users")) {
          const hash = bound[0] as string;
          const now = bound[1] as number;
          const sess = tables.superadmin_sessions.find(
            (s) => s.token_hash === hash && s.expires_at > now,
          );
          if (!sess) return null as T;
          const user = tables.superadmin_users.find((u) => u.id === sess.user_id);
          if (!user) return null as T;
          return {
            id: user.id,
            email: user.email,
            role: user.role,
            customer_id: user.customer_id,
          } as T;
        }
        return null as T;
      }),
      all: vi.fn(async <T = unknown>() => ({ results: [] as T[], success: true })),
      run: vi.fn(async () => {
        if (sql.startsWith("INSERT INTO superadmin_users")) {
          tables.superadmin_users.push({
            id: bound[0] as string,
            email: bound[1] as string,
            password_hash: bound[2] as string,
            role: "customer",
            customer_id: bound[3] as string | null,
            created_at: bound[4] as number,
          });
        } else if (sql.startsWith("INSERT INTO customer_setup_tokens")) {
          tables.customer_setup_tokens.push({
            token_hash: bound[0] as string,
            user_id: bound[1] as string,
            expires_at: bound[2] as number,
            consumed_at: null,
            created_at: bound[3] as number,
          });
        } else if (sql.startsWith("INSERT INTO superadmin_sessions")) {
          tables.superadmin_sessions.push({
            token_hash: bound[0] as string,
            user_id: bound[1] as string,
            expires_at: bound[2] as number,
            created_at: bound[3] as number,
            user_agent: bound[4] as string | null,
            last_seen_at: bound[5] as number,
          });
        } else if (sql.startsWith("UPDATE superadmin_users SET password_hash")) {
          const newHash = bound[0] as string;
          const id = bound[1] as string;
          const user = tables.superadmin_users.find((u) => u.id === id);
          if (user) user.password_hash = newHash;
        } else if (sql.startsWith("UPDATE customer_setup_tokens SET consumed_at")) {
          const now = bound[0] as number;
          const hash = bound[1] as string;
          const tok = tables.customer_setup_tokens.find((t) => t.token_hash === hash);
          if (tok) tok.consumed_at = now;
        } else if (sql.startsWith("UPDATE superadmin_sessions SET last_seen_at")) {
          // No-op for tests
        }
        return { success: true, meta: {} };
      }),
    };
    return stmt;
  });

  return { prepare } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Import worker AFTER any module mocks (none needed here).
// ---------------------------------------------------------------------------

const { default: worker } = await import("../../src/index.ts");

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
  const store = new Map<string, string>();
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

function mockCtx(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>) => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
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
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// Seed a logged-in superadmin into the in-memory tables and return the
// raw token to use as X-Rawuser-Admin in subsequent requests.
async function seedSuperadmin(tables: Tables): Promise<string> {
  const { generateSessionToken, hashSessionToken } = await import("../../src/auth/password.ts");
  const rawToken = generateSessionToken();
  const tokenHash = await hashSessionToken(rawToken);
  const userId = "u-super";
  const now = Date.now();
  tables.superadmin_users.push({
    id: userId,
    email: "operator@rawuser.example",
    password_hash: "stub-hash",
    role: "superadmin",
    customer_id: null,
    created_at: now,
  });
  tables.superadmin_sessions.push({
    token_hash: tokenHash,
    user_id: userId,
    expires_at: now + 60_000,
    created_at: now,
    user_agent: null,
    last_seen_at: now,
  });
  return rawToken;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /admin/customer-users/create", () => {
  let tables: Tables;
  let env: WorkerEnv;
  let superToken: string;

  beforeEach(async () => {
    tables = freshTables();
    env = {
      ...MODEL_ENV,
      VARIANTS: makeMockKV(),
      DB: makeMockD1(tables),
      ENVIRONMENT: "test",
      DASHBOARD_ORIGIN: "https://dash.example.com",
    };
    superToken = await seedSuperadmin(tables);
  });

  it("returns 400 when customer_id is missing", async () => {
    const resp = await worker.fetch(
      req(
        "POST",
        "/admin/customer-users/create",
        { "X-Rawuser-Admin": superToken },
        {
          email: "user@example.com",
        },
      ),
      env,
      mockCtx(),
    );
    expect(resp.status).toBe(400);
  });

  it("returns 400 when email is invalid", async () => {
    const resp = await worker.fetch(
      req(
        "POST",
        "/admin/customer-users/create",
        { "X-Rawuser-Admin": superToken },
        { customer_id: "lumera-school", email: "not-an-email" },
      ),
      env,
      mockCtx(),
    );
    expect(resp.status).toBe(400);
  });

  it("returns 404 when customer does not exist", async () => {
    const resp = await worker.fetch(
      req(
        "POST",
        "/admin/customer-users/create",
        { "X-Rawuser-Admin": superToken },
        { customer_id: "nonexistent", email: "user@example.com" },
      ),
      env,
      mockCtx(),
    );
    expect(resp.status).toBe(404);
  });

  it("returns 201 with user_id + setup_url for valid input", async () => {
    const resp = await worker.fetch(
      req(
        "POST",
        "/admin/customer-users/create",
        { "X-Rawuser-Admin": superToken },
        { customer_id: "lumera-school", email: "founder@lumera.test" },
      ),
      env,
      mockCtx(),
    );
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { user_id: string; setup_url: string };
    expect(typeof body.user_id).toBe("string");
    expect(body.user_id.length).toBeGreaterThan(8);
    expect(body.setup_url).toMatch(/^https:\/\/dash\.example\.com\/setup\?token=[A-Za-z0-9_-]+$/);
    // The token written to D1 must be the SHA-256 hash, NOT the raw token
    expect(tables.customer_setup_tokens.length).toBe(1);
    const raw = body.setup_url.split("token=")[1] ?? "";
    expect(tables.customer_setup_tokens[0]?.token_hash).not.toBe(raw);
  });

  it("returns 409 when email already exists", async () => {
    // First create succeeds
    await worker.fetch(
      req(
        "POST",
        "/admin/customer-users/create",
        { "X-Rawuser-Admin": superToken },
        { customer_id: "lumera-school", email: "founder@lumera.test" },
      ),
      env,
      mockCtx(),
    );
    // Second with same email rejected
    const resp = await worker.fetch(
      req(
        "POST",
        "/admin/customer-users/create",
        { "X-Rawuser-Admin": superToken },
        { customer_id: "acme", email: "founder@lumera.test" },
      ),
      env,
      mockCtx(),
    );
    expect(resp.status).toBe(409);
  });

  it("returns 403 when caller is a customer (not superadmin)", async () => {
    // Override the auth row to look like a customer
    const customerUserId = "u-cust";
    tables.superadmin_users.push({
      id: customerUserId,
      email: "cust@lumera.test",
      password_hash: "stub",
      role: "customer",
      customer_id: "lumera-school",
      created_at: Date.now(),
    });
    const { generateSessionToken, hashSessionToken } = await import("../../src/auth/password.ts");
    const custTok = generateSessionToken();
    tables.superadmin_sessions.push({
      token_hash: await hashSessionToken(custTok),
      user_id: customerUserId,
      expires_at: Date.now() + 60_000,
      created_at: Date.now(),
      user_agent: null,
      last_seen_at: Date.now(),
    });

    const resp = await worker.fetch(
      req(
        "POST",
        "/admin/customer-users/create",
        { "X-Rawuser-Admin": custTok },
        { customer_id: "lumera-school", email: "second@lumera.test" },
      ),
      env,
      mockCtx(),
    );
    expect(resp.status).toBe(403);
  });
});

describe("POST /admin/customer-users/setup", () => {
  let tables: Tables;
  let env: WorkerEnv;
  let superToken: string;

  beforeEach(async () => {
    tables = freshTables();
    env = {
      ...MODEL_ENV,
      VARIANTS: makeMockKV(),
      DB: makeMockD1(tables),
      ENVIRONMENT: "test",
      DASHBOARD_ORIGIN: "https://dash.example.com",
    };
    superToken = await seedSuperadmin(tables);
  });

  async function issueSetupUrl(): Promise<string> {
    const resp = await worker.fetch(
      req(
        "POST",
        "/admin/customer-users/create",
        { "X-Rawuser-Admin": superToken },
        { customer_id: "lumera-school", email: "founder@lumera.test" },
      ),
      env,
      mockCtx(),
    );
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { setup_url: string };
    const raw = body.setup_url.split("token=")[1] ?? "";
    expect(raw.length).toBeGreaterThan(0);
    return raw;
  }

  it("returns 400 when token is missing", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/customer-users/setup", {}, { password: "securepass1" }),
      env,
      mockCtx(),
    );
    expect(resp.status).toBe(400);
  });

  it("returns 400 when password is too short", async () => {
    const token = await issueSetupUrl();
    const resp = await worker.fetch(
      req("POST", "/admin/customer-users/setup", {}, { token, password: "short" }),
      env,
      mockCtx(),
    );
    expect(resp.status).toBe(400);
  });

  it("returns 404 for an unknown token (generic message)", async () => {
    const resp = await worker.fetch(
      req(
        "POST",
        "/admin/customer-users/setup",
        {},
        { token: "nonexistent-token-value", password: "validpass1" },
      ),
      env,
      mockCtx(),
    );
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("invalid");
  });

  it("create + setup roundtrip: customer can login with returned session", async () => {
    const token = await issueSetupUrl();
    const resp = await worker.fetch(
      req("POST", "/admin/customer-users/setup", {}, { token, password: "securepass1" }),
      env,
      mockCtx(),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      token: string;
      user: { id: string; email: string; role: string; customer_id: string | null };
    };
    expect(body.user.email).toBe("founder@lumera.test");
    expect(body.user.role).toBe("customer");
    expect(body.user.customer_id).toBe("lumera-school");
    expect(body.token.length).toBeGreaterThan(20);

    // The session token works on a subsequent /admin/me call
    const me = await worker.fetch(
      req("GET", "/admin/me", { "X-Rawuser-Admin": body.token }),
      env,
      mockCtx(),
    );
    expect(me.status).toBe(200);
    const mebody = (await me.json()) as { user: { customer_id: string | null } };
    expect(mebody.user.customer_id).toBe("lumera-school");
  });

  it("returns 404 when token is already consumed (no error reveals reason)", async () => {
    const token = await issueSetupUrl();
    // First consume: succeeds
    const ok = await worker.fetch(
      req("POST", "/admin/customer-users/setup", {}, { token, password: "securepass1" }),
      env,
      mockCtx(),
    );
    expect(ok.status).toBe(200);

    // Second consume: same generic 404 as a wrong token
    const resp = await worker.fetch(
      req("POST", "/admin/customer-users/setup", {}, { token, password: "differentpass1" }),
      env,
      mockCtx(),
    );
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string };
    // Same generic message as missing + expired tokens. Lumping the three
    // failure modes together keeps the endpoint from oracling WHY a token
    // is bad: an attacker can't distinguish "never existed" from
    // "already used" from "expired" by inspecting the body.
    expect(body.error).toBe("Invalid or expired setup token");
  });

  it("returns 404 when token is expired", async () => {
    const token = await issueSetupUrl();
    // Manually expire it
    const tok = tables.customer_setup_tokens[0];
    if (tok) tok.expires_at = Date.now() - 1000;

    const resp = await worker.fetch(
      req("POST", "/admin/customer-users/setup", {}, { token, password: "securepass1" }),
      env,
      mockCtx(),
    );
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string };
    // Message is the same generic string used for missing + consumed tokens:
    // "Invalid or expired setup token". Lumping the failure modes together
    // keeps the endpoint from oracling specifically WHY a token is bad.
    expect(body.error).toBe("Invalid or expired setup token");
  });

  it("double-consume rejection persists across many attempts", async () => {
    const token = await issueSetupUrl();
    const first = await worker.fetch(
      req("POST", "/admin/customer-users/setup", {}, { token, password: "securepass1" }),
      env,
      mockCtx(),
    );
    expect(first.status).toBe(200);
    for (let i = 0; i < 5; i++) {
      const r = await worker.fetch(
        req("POST", "/admin/customer-users/setup", {}, { token, password: "securepass1" }),
        env,
        {} as ExecutionContext,
      );
      expect(r.status).toBe(404);
    }
  });
});
