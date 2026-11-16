/**
 * Pick on the page: token seeded from the current manifest; status stores
 * the picked manifest unconfirmed and deletes the key.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "../model-env.ts";

vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(),
  regenerateOne: vi.fn(),
}));
vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async (request: Request) =>
    request.headers.get("X-Rawuser-Admin")
      ? { id: "user-1", email: "admin@example.com", role: "superadmin" }
      : null,
  ),
}));

const { default: worker } = await import("../../src/index.ts");

let kv: Map<string, { value: string; ttl?: number }>;
let runs: { sql: string; params: unknown[] }[];
let manifestRow: { manifest: string; confirmed_at: number | null } | null;

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
          // The special-category question answered No (migration 0044), so
          // the tag and the pick link are not withheld (readiness-check.md).
          return (
            bound[0] === "c1"
              ? { id: "c1", domain: "https://lumera.test/", special_category: 0, sensitive: 0 }
              : null
          ) as T | null;
        }
        if (sql.includes("SELECT manifest FROM element_manifests")) {
          return (manifestRow ? { manifest: manifestRow.manifest } : null) as T | null;
        }
        return null;
      },
      async run() {
        runs.push({ sql, params: bound });
        if (sql.includes("INSERT INTO element_manifests")) {
          manifestRow = { manifest: bound[2] as string, confirmed_at: null };
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

function makeEnv() {
  return {
    DB: makeDb(),
    VARIANTS: {
      async get(key: string) {
        return kv.get(key)?.value ?? null;
      },
      async put(key: string, value: string, o?: { expirationTtl?: number }) {
        kv.set(key, { value, ttl: o?.expirationTtl });
      },
      async delete(key: string) {
        kv.delete(key);
      },
    } as unknown as KVNamespace,
    ...MODEL_ENV,
    ADMIN_TOKEN: "test-admin",
    DASHBOARD_ORIGIN: "*",
    ENVIRONMENT: "development",
  };
}
const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers ?? {}), "X-Rawuser-Admin": "test-admin" },
});
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

beforeEach(() => {
  kv = new Map();
  runs = [];
  manifestRow = {
    manifest: JSON.stringify({
      "hero.headline": { css: ["h1"], text: ["Salam"], structural: "first h1" },
    }),
    confirmed_at: 123,
  };
});

describe("POST /admin/onboard/pick-token", () => {
  it("mints a 15-minute token seeded with the current manifest and returns the link", async () => {
    const res = await worker.fetch(
      new Request(
        "http://localhost/admin/onboard/pick-token",
        authed({ method: "POST", body: JSON.stringify({ customer_id: "c1" }) }),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; link: string; expires_in_s: number };
    expect(body.link).toBe(`https://lumera.test/#rawuser_pick=${body.token}`);
    expect(body.expires_in_s).toBe(900);
    const stored = kv.get(`pick-token:${body.token}`);
    expect(stored?.ttl).toBe(900);
    expect(JSON.parse(stored?.value ?? "{}").manifest).toHaveProperty("hero.headline");
  });

  it("401 without a session", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/admin/onboard/pick-token", {
        method: "POST",
        body: JSON.stringify({ customer_id: "c1" }),
      }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/onboard/pick-status", () => {
  it("reports not landed when nothing was picked", async () => {
    const res = await worker.fetch(
      new Request(
        "http://localhost/admin/onboard/pick-status?customer_id=c1&page_path=/",
        authed(),
      ),
      makeEnv(),
      ctx,
    );
    expect(((await res.json()) as { landed: boolean }).landed).toBe(false);
  });

  it("stores the picked manifest unconfirmed, deletes the key, returns it", async () => {
    const picked = {
      "hero.cta.label": {
        css: ["a.btn"],
        text: ["Başla"],
        structural: "first a in section",
        conversion_candidate: true,
      },
    };
    kv.set("pick:c1:/", { value: JSON.stringify(picked) });
    const res = await worker.fetch(
      new Request(
        "http://localhost/admin/onboard/pick-status?customer_id=c1&page_path=/",
        authed(),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { landed: boolean; manifest: unknown };
    expect(body.landed).toBe(true);
    expect(body.manifest).toEqual(picked);
    expect(kv.has("pick:c1:/")).toBe(false);
    const insert = runs.find((r) => r.sql.includes("INSERT INTO element_manifests"));
    expect(insert?.params[3]).toBe("https://lumera.test/");
    expect(insert?.params[5]).toBe(0);
    expect(manifestRow?.confirmed_at).toBeNull();
  });
});

describe("an address that names one account (event-paths.md §8, condition 3)", () => {
  it("pick-token refuses it with the count pick's line and mints nothing", async () => {
    const res = await worker.fetch(
      new Request(
        "http://localhost/admin/onboard/pick-token",
        authed({
          method: "POST",
          body: JSON.stringify({ customer_id: "c1", page_path: "/admin/students/482" }),
        }),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "This address belongs to one account. Pick the button on a page every visitor sees.",
    );
    expect([...kv.keys()].some((k) => k.startsWith("pick-token:"))).toBe(false);
  });

  it("pick-status refuses it and stores no manifest", async () => {
    kv.set("pick:c1:/invite/abcdefghijklmnopqrstuv", { value: "{}" });
    const res = await worker.fetch(
      new Request(
        "http://localhost/admin/onboard/pick-status?customer_id=c1&page_path=/invite/aBcDeFgHiJkLmNoPqRsTuV",
        authed(),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(runs.some((r) => r.sql.includes("INSERT INTO element_manifests"))).toBe(false);
  });
});
