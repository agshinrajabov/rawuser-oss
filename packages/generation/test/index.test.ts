/**
 * Integration tests for the generation worker /regenerate and /health endpoints.
 *
 * Auth model change (D3.2): /regenerate now gates on session token via
 * getSessionUser (D1 lookup) instead of ADMIN_TOKEN string-equality.
 * getSessionUser is mocked here so tests don't need real D1 session rows.
 *
 * Deleted test: "blank ADMIN_TOKEN returns 401": ADMIN_TOKEN is no longer
 * read in any code path (retired in D3.2, secret formally revoked in D3.6).
 */

import type { OrchestrationResult } from "@rawuser/generation/src/orchestrator";
import { describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "./model-env.ts";

// ---------------------------------------------------------------------------
// Mock orchestrate so the worker makes no real D1, KV or model call
// ---------------------------------------------------------------------------

const mockResult: OrchestrationResult = {
  customer_id: "test-cust",
  generated: 30,
  errors: 0,
  cost_usd: 0.85,
  cache_hit_rate: 0.93,
  kv_keys: Array.from({ length: 30 }, (_, i) => `v1:variant:test-cust:dim${i}:default`),
  failed_tuples: [],
  aborted: false,
};

vi.mock("../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(async () => mockResult),
}));

// ---------------------------------------------------------------------------
// Mock getSessionUser: controls who is "authenticated" per test.
// Default: returns null (unauthenticated). Tests that need auth set the
// sessionUserOverride before calling worker.fetch.
// ---------------------------------------------------------------------------

const VALID_TOKEN = "valid-session-token-xxxxxxxxxxxxxxxxxxxx";
let sessionUserOverride: { id: string; email: string; role: string } | null = null;

vi.mock("../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async (request: Request) => {
    const header = request.headers.get("X-Rawuser-Admin");
    if (!header || header !== VALID_TOKEN) return null;
    return sessionUserOverride;
  }),
}));

// ---------------------------------------------------------------------------
// Import worker AFTER mocks are set up
// ---------------------------------------------------------------------------

const { default: worker } = await import("../src/index.ts");

// ---------------------------------------------------------------------------
// Helper: make a worker request
// ---------------------------------------------------------------------------

interface WorkerEnv {
  MODEL_BASE_URL: string;
  MODEL_API_KEY: string;
  MODEL_ID: string;
  VARIANTS: KVNamespace;
  DB: D1Database;
  ENVIRONMENT: string;
}

const ENV: WorkerEnv = {
  ...MODEL_ENV,
  VARIANTS: {} as KVNamespace,
  DB: {} as D1Database,
  ENVIRONMENT: "test",
};

function makeRequest(path: string, headers?: Record<string, string>): Request {
  return new Request(`https://generation.rawuser.test${path}`, {
    headers: { "content-type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/health", () => {
  it("returns 200 with status fields", async () => {
    const resp = await worker.fetch(makeRequest("/health"), ENV, {} as ExecutionContext);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; env: string; modelConfigured: boolean };
    expect(body.ok).toBe(true);
    expect(body.env).toBe("test");
    expect(body.modelConfigured).toBe(true);
  });
});

describe("/regenerate: auth", () => {
  it("returns 401 when X-Rawuser-Admin header is missing", async () => {
    sessionUserOverride = null;
    const resp = await worker.fetch(
      makeRequest("/regenerate?customer_id=test-cust"),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when X-Rawuser-Admin header has invalid/unknown token", async () => {
    sessionUserOverride = null;
    const resp = await worker.fetch(
      makeRequest("/regenerate?customer_id=test-cust", { "X-Rawuser-Admin": "wrong-token" }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 200 with orchestration summary when session is valid", async () => {
    sessionUserOverride = { id: "user-1", email: "admin@example.com", role: "superadmin" };
    const resp = await worker.fetch(
      makeRequest("/regenerate?customer_id=test-cust", {
        "X-Rawuser-Admin": VALID_TOKEN,
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as OrchestrationResult;
    expect(body.customer_id).toBe("test-cust");
    expect(body.generated).toBe(30);
    expect(body.errors).toBe(0);
  });

  it("returns 400 when customer_id is missing (session valid)", async () => {
    sessionUserOverride = { id: "user-1", email: "admin@example.com", role: "superadmin" };
    const resp = await worker.fetch(
      makeRequest("/regenerate", { "X-Rawuser-Admin": VALID_TOKEN }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });
});

describe("unknown paths", () => {
  it("returns 404 for unknown paths", async () => {
    const resp = await worker.fetch(
      makeRequest("/unknown", { "X-Rawuser-Admin": VALID_TOKEN }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(404);
  });
});
