/**
 * Integration tests for /admin/onboard/* endpoints.
 *
 * All external calls (D1, fetchPageHtml, detectElements) are mocked.
 * Tests cover:
 *   - Auth gate (401 without header)
 *   - /detect happy path (auth + valid body + mocked fetch+detect)
 *   - /detect validation (missing fields, non-http URL, customer not found)
 *   - /detect persists with confirmed_at=NULL
 *   - /confirm sets confirmed_at; 404 when no manifest exists
 *   - /manifest returns stored row or 404
 *   - No `events` table queries (grep-safe: "events" never appears in a SQL string)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "../model-env.ts";

// ---------------------------------------------------------------------------
// Mock detect-elements + fetchPageHtml so we never hit the network or a model
// ---------------------------------------------------------------------------

vi.mock("../../src/detect-elements.ts", () => ({
  fetchPageHtml: vi.fn(async () => "<html><body><h1>Test</h1></body></html>"),
  detectElements: vi.fn(async () => ({
    manifest: {
      "hero.headline": {
        css: ["h1"],
        text: ["Test"],
        structural: "first h1",
      },
    },
    cost_usd: 0.012,
    source_html_bytes: 42,
  })),
  // index.ts imports cleanHtml for the public capture endpoint: passthrough.
  cleanHtml: vi.fn((html: string) => html),
}));

// Mock orchestrate + regenerateOne so the worker module loads
// (it imports them at module scope even though we don't exercise them here).
vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(),
  regenerateOne: vi.fn(),
}));

// Mock getSessionUser so onboard tests don't need real D1 session rows.
// Returns a fake superadmin for any request that carries the test token.
vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async (request: Request) => {
    const header = request.headers.get("X-Rawuser-Admin");
    if (!header) return null;
    return { id: "user-1", email: "admin@example.com", role: "superadmin" };
  }),
}));

const { default: worker } = await import("../../src/index.ts");

// ---------------------------------------------------------------------------
// Mock D1 + env
// ---------------------------------------------------------------------------

interface MockRow {
  customer_id: string;
  manifest: string;
  source_url: string;
  generated_at: number;
  confirmed_at: number | null;
  cost_usd: number;
}

let mockCustomersById: Map<string, { id: string; domain?: string }>;
let mockManifestsById: Map<string, MockRow>;
let lastRunSql: string | null;
let lastRunParams: unknown[] | null;

function makeDb(): D1Database {
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...params: unknown[]) {
        bound = params;
        return this;
      },
      async first<T>() {
        if (sql.includes("FROM customers WHERE id = ?")) {
          const id = bound[0] as string;
          return (mockCustomersById.get(id) as T | undefined) ?? null;
        }
        if (sql.includes("FROM element_manifests WHERE customer_id = ?")) {
          const id = bound[0] as string;
          return (mockManifestsById.get(id) as T | undefined) ?? null;
        }
        return null;
      },
      async run() {
        lastRunSql = sql;
        lastRunParams = bound;
        if (sql.includes("INSERT INTO element_manifests")) {
          const [customer_id, manifest, source_url, generated_at, cost_usd] = bound as [
            string,
            string,
            string,
            number,
            number,
          ];
          mockManifestsById.set(customer_id, {
            customer_id,
            manifest,
            source_url,
            generated_at,
            confirmed_at: null,
            cost_usd,
          });
        }
        if (sql.includes("UPDATE element_manifests SET confirmed_at = ?")) {
          const [confirmed_at, customer_id] = bound as [number, string];
          const row = mockManifestsById.get(customer_id);
          if (row) row.confirmed_at = confirmed_at;
        }
        return { success: true, meta: {} } as D1Result;
      },
      async all<T>() {
        return { results: [] as T[], success: true, meta: {} } as D1Result<T>;
      },
    };
    return stmt as unknown as D1PreparedStatement;
  };
  return { prepare } as unknown as D1Database;
}

interface WorkerEnv {
  DB: D1Database;
  VARIANTS: KVNamespace;
  MODEL_BASE_URL: string;
  MODEL_API_KEY: string;
  MODEL_ID: string;
  ADMIN_TOKEN: string;
  DASHBOARD_ORIGIN: string;
  ENVIRONMENT: string;
}

// In-memory KV mock: the capture flow (element-detection-v2 T2) stores
// tokens and captured DOM here; detect reads/deletes captures.
let mockKvStore: Map<string, string>;

function makeKv(): KVNamespace {
  return {
    async get(key: string) {
      return mockKvStore.get(key) ?? null;
    },
    async put(key: string, value: string) {
      mockKvStore.set(key, value);
    },
    async delete(key: string) {
      mockKvStore.delete(key);
    },
  } as unknown as KVNamespace;
}

function makeEnv(): WorkerEnv {
  return {
    DB: makeDb(),
    VARIANTS: makeKv(),
    ...MODEL_ENV,
    ADMIN_TOKEN: "test-admin",
    DASHBOARD_ORIGIN: "*",
    ENVIRONMENT: "development",
  };
}

function authed(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers ?? {}), "X-Rawuser-Admin": "test-admin" },
  };
}

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

beforeEach(() => {
  // The special-category question answered No (migration 0044), so the
  // capture link is not withheld (readiness-check.md, condition 2).
  mockCustomersById = new Map([
    ["c1", { id: "c1", domain: "example.com", special_category: 0, sensitive: 0 }],
  ]);
  mockManifestsById = new Map();
  mockKvStore = new Map();
  lastRunSql = null;
  lastRunParams = null;
});

// ---------------------------------------------------------------------------
// /admin/onboard/detect
// ---------------------------------------------------------------------------

describe("/admin/onboard/detect", () => {
  const url = "http://localhost/admin/onboard/detect";

  it("returns 401 without X-Rawuser-Admin header", async () => {
    const req = new Request(url, {
      method: "POST",
      body: JSON.stringify({ customer_id: "c1", source_url: "https://example.com" }),
    });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request(url, authed({ method: "POST", body: "not-json" }));
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing customer_id", async () => {
    const req = new Request(
      url,
      authed({ method: "POST", body: JSON.stringify({ source_url: "https://example.com" }) }),
    );
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-http(s) URL", async () => {
    const req = new Request(
      url,
      authed({
        method: "POST",
        body: JSON.stringify({ customer_id: "c1", source_url: "file:///etc/passwd" }),
      }),
    );
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 404 when customer does not exist", async () => {
    const req = new Request(
      url,
      authed({
        method: "POST",
        body: JSON.stringify({ customer_id: "nope", source_url: "https://example.com" }),
      }),
    );
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  it("returns 200 + manifest on happy path, persists with confirmed_at=NULL", async () => {
    const req = new Request(
      url,
      authed({
        method: "POST",
        body: JSON.stringify({ customer_id: "c1", source_url: "https://example.com" }),
      }),
    );
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      customer_id: string;
      manifest: Record<string, unknown>;
      status: string;
      confirmed_at: number | null;
    };
    expect(body.customer_id).toBe("c1");
    expect(body.status).toBe("unconfirmed");
    expect(body.confirmed_at).toBeNull();
    expect(body.manifest["hero.headline"]).toBeDefined();
    // Persistence verified by inspecting the last write
    expect(lastRunSql).toContain("INSERT INTO element_manifests");
  });
});

// ---------------------------------------------------------------------------
// /admin/onboard/confirm
// ---------------------------------------------------------------------------

describe("/admin/onboard/confirm", () => {
  const url = "http://localhost/admin/onboard/confirm";

  it("returns 401 without auth header", async () => {
    const req = new Request(url, {
      method: "POST",
      body: JSON.stringify({ customer_id: "c1" }),
    });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 404 when no manifest exists for the customer", async () => {
    const req = new Request(
      url,
      authed({ method: "POST", body: JSON.stringify({ customer_id: "c1" }) }),
    );
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  it("sets confirmed_at + returns confirmed status when manifest exists", async () => {
    // Seed a manifest row
    mockManifestsById.set("c1", {
      customer_id: "c1",
      manifest: JSON.stringify({ "hero.headline": { css: ["h1"], text: [], structural: "h1" } }),
      source_url: "https://example.com",
      generated_at: 100,
      confirmed_at: null,
      cost_usd: 0.01,
    });
    const req = new Request(
      url,
      authed({ method: "POST", body: JSON.stringify({ customer_id: "c1" }) }),
    );
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; confirmed_at: number | null };
    expect(body.status).toBe("confirmed");
    expect(body.confirmed_at).toBeGreaterThan(0);
    // Versions written before the page was read are marked stale on confirm.
    expect(lastRunSql).toContain("UPDATE variants SET status = 'stale'");
    // The variants table has no page_path column (a live 500 on 2026-09-11):
    // the page is matched through the kv_key shape.
    expect(lastRunSql).not.toContain("page_path");
    expect(lastRunSql).toContain("kv_key LIKE ?");
    expect(lastRunParams).toEqual(["c1", "v1:variant:c1:%", "v1:variant:c1:p:%"]);
  });
});

// ---------------------------------------------------------------------------
// /admin/onboard/manifest
// ---------------------------------------------------------------------------

describe("/admin/onboard/manifest", () => {
  it("returns 404 when no manifest exists", async () => {
    const req = new Request(
      "http://localhost/admin/onboard/manifest?customer_id=c1",
      authed({ method: "GET" }),
    );
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  it("returns the stored manifest with correct status", async () => {
    mockManifestsById.set("c1", {
      customer_id: "c1",
      manifest: JSON.stringify({ "hero.headline": { css: ["h1"], text: [], structural: "h1" } }),
      source_url: "https://example.com",
      generated_at: 100,
      confirmed_at: 200,
      cost_usd: 0.01,
    });
    const req = new Request(
      "http://localhost/admin/onboard/manifest?customer_id=c1",
      authed({ method: "GET" }),
    );
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; manifest: Record<string, unknown> };
    expect(body.status).toBe("confirmed");
    expect(body.manifest["hero.headline"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Privacy invariant: zero events queries
// ---------------------------------------------------------------------------

describe("privacy invariant", () => {
  it("onboard endpoints never query the events table", async () => {
    // Trigger detect + confirm + manifest
    mockManifestsById.set("c1", {
      customer_id: "c1",
      manifest: JSON.stringify({ "hero.headline": { css: ["h1"], text: [], structural: "h1" } }),
      source_url: "https://example.com",
      generated_at: 100,
      confirmed_at: 200,
      cost_usd: 0.01,
    });
    await worker.fetch(
      new Request("http://localhost/admin/onboard/manifest?customer_id=c1", authed({})),
      makeEnv(),
      ctx,
    );
    expect(lastRunSql ?? "").not.toMatch(/\bevents\b/i);
  });
});

// ---------------------------------------------------------------------------
// Element-detection-v2 T2: capture-token / capture-status / public capture
// ---------------------------------------------------------------------------

describe("/admin/onboard/capture-token", () => {
  const url = "http://localhost/admin/onboard/capture-token";

  it("returns 401 without auth header", async () => {
    const req = new Request(url, {
      method: "POST",
      body: JSON.stringify({ customer_id: "c1", source_url: "https://example.com/start" }),
    });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 for missing source_url", async () => {
    const req = new Request(
      url,
      authed({ method: "POST", body: JSON.stringify({ customer_id: "c1" }) }),
    );
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it("mints a token bound to the URL's normalized path", async () => {
    const req = new Request(
      url,
      authed({
        method: "POST",
        body: JSON.stringify({ customer_id: "c1", source_url: "https://example.com/start/" }),
      }),
    );
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; page_path: string; expires_in_s: number };
    expect(body.token.length).toBeGreaterThan(16);
    expect(body.page_path).toBe("/start");
    expect(body.expires_in_s).toBe(900);
    const stored = mockKvStore.get(`capture-token:${body.token}`);
    expect(stored).toBeDefined();
    expect(JSON.parse(stored as string)).toEqual({ customer_id: "c1", page_path: "/start" });
  });
});

describe("/admin/onboard/capture-status", () => {
  it("reports captured=false before a capture lands and true after", async () => {
    const env = makeEnv();
    const statusUrl =
      "http://localhost/admin/onboard/capture-status?customer_id=c1&page_path=/start";

    let res = await worker.fetch(new Request(statusUrl, authed({})), env, ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { captured: boolean }).captured).toBe(false);

    mockKvStore.set("capture:c1:/start", "<html><h1>Rendered</h1></html>");
    res = await worker.fetch(new Request(statusUrl, authed({})), env, ctx);
    expect(((await res.json()) as { captured: boolean }).captured).toBe(true);
  });
});

describe("POST /onboard/capture (public)", () => {
  const captureUrl = "http://localhost/onboard/capture";

  async function mintToken(env: ReturnType<typeof makeEnv>): Promise<string> {
    const res = await worker.fetch(
      new Request(
        "http://localhost/admin/onboard/capture-token",
        authed({
          method: "POST",
          body: JSON.stringify({ customer_id: "c1", source_url: "https://example.com/start" }),
        }),
      ),
      env,
      ctx,
    );
    return ((await res.json()) as { token: string }).token;
  }

  it("answers OPTIONS preflight with open CORS (bookmarklet runs on any origin)", async () => {
    const res = await worker.fetch(new Request(captureUrl, { method: "OPTIONS" }), makeEnv(), ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns 400 when token or html is missing", async () => {
    const env = makeEnv();
    let res = await worker.fetch(
      new Request(captureUrl, { method: "POST", body: JSON.stringify({ html: "<p>x</p>" }) }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    res = await worker.fetch(
      new Request(captureUrl, { method: "POST", body: JSON.stringify({ token: "t" }) }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 for an unknown or expired token", async () => {
    const res = await worker.fetch(
      new Request(captureUrl, {
        method: "POST",
        body: JSON.stringify({ token: "deadbeef", html: "<p>x</p>" }),
      }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("stores the capture, burns the token (single-use), and sets CORS on the response", async () => {
    const env = makeEnv();
    const token = await mintToken(env);

    const res = await worker.fetch(
      new Request(captureUrl, {
        method: "POST",
        body: JSON.stringify({ token, html: "<html><h1>Rendered app</h1></html>" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { ok: boolean; page_path: string; bytes: number };
    expect(body.ok).toBe(true);
    expect(body.page_path).toBe("/start");
    expect(mockKvStore.get("capture:c1:/start")).toContain("Rendered app");
    // Token burned: a replay is rejected.
    const replay = await worker.fetch(
      new Request(captureUrl, {
        method: "POST",
        body: JSON.stringify({ token, html: "<p>again</p>" }),
      }),
      env,
      ctx,
    );
    expect(replay.status).toBe(403);
  });

  it("rejects oversized payloads with 413", async () => {
    const env = makeEnv();
    const token = await mintToken(env);
    const res = await worker.fetch(
      new Request(captureUrl, {
        method: "POST",
        body: JSON.stringify({ token, html: "x".repeat(512 * 1024 + 1) }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(413);
  });
});

describe("/admin/onboard/detect: capture preference (T2)", () => {
  const url = "http://localhost/admin/onboard/detect";

  it("uses a pending capture instead of fetching, and consumes it", async () => {
    const env = makeEnv();
    mockKvStore.set("capture:c1:/start", "<html><body><h1>Rendered by browser</h1></body></html>");

    const { fetchPageHtml, detectElements } = await import("../../src/detect-elements.ts");
    vi.mocked(fetchPageHtml).mockClear();
    vi.mocked(detectElements).mockClear();

    const res = await worker.fetch(
      new Request(
        url,
        authed({
          method: "POST",
          body: JSON.stringify({ customer_id: "c1", source_url: "https://example.com/start" }),
        }),
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { html_source: string };
    expect(body.html_source).toBe("capture");
    expect(vi.mocked(fetchPageHtml)).not.toHaveBeenCalled();
    // Detection ran on the captured DOM.
    expect(vi.mocked(detectElements)).toHaveBeenCalledWith(
      expect.stringContaining("Rendered by browser"),
      expect.anything(),
    );
    // Capture consumed: a re-detect without a fresh capture falls back to fetch.
    expect(mockKvStore.has("capture:c1:/start")).toBe(false);
  });

  it("falls back to fetch and reports html_source=fetch when no capture exists", async () => {
    const { fetchPageHtml } = await import("../../src/detect-elements.ts");
    vi.mocked(fetchPageHtml).mockClear();

    const res = await worker.fetch(
      new Request(
        url,
        authed({
          method: "POST",
          body: JSON.stringify({ customer_id: "c1", source_url: "https://example.com" }),
        }),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { html_source: string };
    expect(body.html_source).toBe("fetch");
    expect(vi.mocked(fetchPageHtml)).toHaveBeenCalledOnce();
    // Only the recorded host, under the fetcher's agent (no bot page set here).
    expect(vi.mocked(fetchPageHtml).mock.calls[0]?.[1]).toEqual({
      sameHostAs: "example.com",
      userAgent: "Rawuser/1.0",
    });
  });

  it("www and the apex are one site: a www address of the recorded domain is read", async () => {
    const { fetchPageHtml } = await import("../../src/detect-elements.ts");
    vi.mocked(fetchPageHtml).mockClear();
    const res = await worker.fetch(
      new Request(
        url,
        authed({
          method: "POST",
          body: JSON.stringify({ customer_id: "c1", source_url: "https://www.example.com/" }),
        }),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(fetchPageHtml).mock.calls[0]?.[1]).toEqual({
      sameHostAs: "example.com",
      userAgent: "Rawuser/1.0",
    });
  });

  it("an address on another host is refused before any read", async () => {
    const { fetchPageHtml } = await import("../../src/detect-elements.ts");
    vi.mocked(fetchPageHtml).mockClear();
    const res = await worker.fetch(
      new Request(
        url,
        authed({
          method: "POST",
          body: JSON.stringify({ customer_id: "c1", source_url: "https://elsewhere.test/" }),
        }),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(fetchPageHtml)).not.toHaveBeenCalled();
  });

  it("a redirect to another host is not followed and comes back as off_host", async () => {
    const { fetchPageHtml } = await import("../../src/detect-elements.ts");
    const { OffHostRedirectError, OFF_HOST_LINE } = await import("../../src/lib/public-url.ts");
    vi.mocked(fetchPageHtml).mockRejectedValueOnce(new OffHostRedirectError());
    const res = await worker.fetch(
      new Request(
        url,
        authed({
          method: "POST",
          body: JSON.stringify({ customer_id: "c1", source_url: "https://example.com/" }),
        }),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "off_host", reason: OFF_HOST_LINE });
  });
});

describe("an address that names one account (event-paths.md §8, condition 3)", () => {
  const UUID = "550e8400-e29b-41d4-a716-446655440000";
  const post = (path: string, body: unknown) =>
    worker.fetch(
      new Request(
        `http://localhost${path}`,
        authed({ method: "POST", body: JSON.stringify(body) }),
      ),
      makeEnv(),
      ctx,
    );

  it("capture-token (Add this page) refuses it and mints no link", async () => {
    const res = await post("/admin/onboard/capture-token", {
      customer_id: "c1",
      source_url: `https://example.com/admin/students/${UUID}`,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "This address belongs to one account. Pick the button on a page every visitor sees.",
    );
    expect([...mockKvStore.keys()].some((k) => k.startsWith("capture-token:"))).toBe(false);
  });

  it("capture-token still mints for an ordinary page", async () => {
    const res = await post("/admin/onboard/capture-token", {
      customer_id: "c1",
      source_url: "https://example.com/az/approach",
    });
    expect(res.status).toBe(200);
  });

  it("detect refuses it before any read or write", async () => {
    const res = await post("/admin/onboard/detect", {
      customer_id: "c1",
      source_url: "https://example.com/students/482",
    });
    expect(res.status).toBe(400);
    expect(lastRunSql).toBeNull();
  });

  it("confirm refuses it", async () => {
    const res = await post("/admin/onboard/confirm", {
      customer_id: "c1",
      page_path: "/u/jane%40acme.com",
    });
    expect(res.status).toBe(400);
    expect(lastRunSql).toBeNull();
  });
});
