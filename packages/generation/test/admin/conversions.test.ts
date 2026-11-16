/**
 * Tests for the /admin/conversions/* handlers: V2 Module 3.
 *
 * Self-contained mocks (separate from handlers.test.ts) because these
 * handlers do two-step D1 access (manifest lookup → conversion_targets
 * upsert + readback) that doesn't fit the single-table mock pattern.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "../model-env.ts";

vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(),
  regenerateOne: vi.fn(),
}));

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

const { default: worker } = await import("../../src/index.ts");

// ---------------------------------------------------------------------------
// Mock D1 that supports a small in-memory table for conversion_targets and a
// static manifest read.
// ---------------------------------------------------------------------------

interface ConversionRow {
  id: string;
  customer_id: string;
  section_path: string;
  label: string;
  conversion_label: string;
  enabled: number;
  css_selectors: string;
  text_selectors: string;
  structural_selector: string;
  created_at: number;
  updated_at: number;
}

interface MockState {
  conversions: ConversionRow[];
  manifestJson: string | null;
  manifestConfirmed: boolean;
}

let state: MockState;

function makeDb(): D1Database {
  const prepare = (sql: string) => {
    const stmt = {
      _binds: [] as unknown[],
      bind(...args: unknown[]) {
        this._binds = args;
        return this;
      },
      async first<T = unknown>(): Promise<T | null> {
        if (sql.includes("FROM element_manifests")) {
          if (state.manifestJson === null) return null;
          if (sql.includes("confirmed_at IS NOT NULL") && !state.manifestConfirmed) return null;
          return { manifest: state.manifestJson } as unknown as T;
        }
        if (sql.includes("FROM conversion_targets")) {
          // Two single-row reads supported:
          //   1) SELECT customer_id FROM conversion_targets WHERE id = ?  (delete-scope pre-check)
          //   2) SELECT ... WHERE customer_id = ? AND section_path = ?    (upsert readback)
          if (sql.includes("WHERE id = ?")) {
            const [id] = this._binds as [string];
            const row = state.conversions.find((r) => r.id === id) ?? null;
            return row as unknown as T;
          }
          const [customerId, sectionPath] = this._binds as [string, string];
          const row =
            state.conversions.find(
              (r) => r.customer_id === customerId && r.section_path === sectionPath,
            ) ?? null;
          return row as unknown as T;
        }
        return null;
      },
      async all<T = unknown>(): Promise<{ results: T[]; success: boolean }> {
        if (sql.includes("FROM conversion_targets")) {
          const [customerId] = this._binds as [string];
          const rows = state.conversions.filter((r) => r.customer_id === customerId);
          return { results: rows as unknown as T[], success: true };
        }
        return { results: [] as T[], success: true };
      },
      async run() {
        if (sql.startsWith("INSERT INTO conversion_targets")) {
          // Bound positional args:
          // (customer_id, section_path, label, conversion_label, enabled,
          //  css_selectors, text_selectors, structural_selector,
          //  created_at, updated_at)
          const [
            customer_id,
            section_path,
            label,
            conversion_label,
            enabled,
            css_selectors,
            text_selectors,
            structural_selector,
            created_at,
            updated_at,
          ] = this._binds as [
            string,
            string,
            string,
            string,
            number,
            string,
            string,
            string,
            number,
            number,
          ];
          const idx = state.conversions.findIndex(
            (r) => r.customer_id === customer_id && r.section_path === section_path,
          );
          const row: ConversionRow = {
            id: idx >= 0 ? state.conversions[idx].id : `ct_${Math.random().toString(36).slice(2)}`,
            customer_id,
            section_path,
            label,
            conversion_label,
            enabled,
            css_selectors,
            text_selectors,
            structural_selector,
            created_at: idx >= 0 ? state.conversions[idx].created_at : created_at,
            updated_at,
          };
          if (idx >= 0) state.conversions[idx] = row;
          else state.conversions.push(row);
          return { success: true, meta: {} };
        }
        if (sql.startsWith("DELETE FROM conversion_targets")) {
          const [id] = this._binds as [string];
          state.conversions = state.conversions.filter((r) => r.id !== id);
          return { success: true, meta: {} };
        }
        return { success: true, meta: {} };
      },
    };
    return stmt as unknown as D1PreparedStatement;
  };
  return { prepare } as unknown as D1Database;
}

const ENV = {
  ...MODEL_ENV,
  VARIANTS: {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace,
  DB: makeDb(),
  ENVIRONMENT: "test",
  DASHBOARD_ORIGIN: "*",
};

const FAKE_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const AUTH = { "X-Rawuser-Admin": FAKE_TOKEN };

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://generation.rawuser.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...AUTH },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const MANIFEST_WITH_CTA = JSON.stringify({
  "hero.headline": {
    css: ["h1"],
    text: [],
    structural: "first h1",
    conversion_candidate: false,
  },
  "hero.cta.label": {
    css: ["#hero-cta", ".btn-primary"],
    text: ["Get started"],
    structural: "primary CTA in hero",
    conversion_candidate: true,
  },
  "pricing.cta.label": {
    css: [".pricing .btn"],
    text: ["Start Pro"],
    structural: "primary CTA in pricing",
    conversion_candidate: true,
  },
});

beforeEach(() => {
  sessionOverride = mockSessionUser;
  state = { conversions: [], manifestJson: null, manifestConfirmed: false };
});

describe("auth gate: /admin/conversions/* require session", () => {
  const PROTECTED = [
    ["GET", "/admin/conversions/list?customer_id=c1"],
    ["POST", "/admin/conversions/upsert"],
    ["POST", "/admin/conversions/confirm"],
    ["POST", "/admin/conversions/delete"],
  ] as const;
  for (const [method, path] of PROTECTED) {
    it(`${method} ${path} → 401 without session`, async () => {
      sessionOverride = null;
      const r = new Request(`https://generation.rawuser.test${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      const resp = await worker.fetch(r, ENV, {} as ExecutionContext);
      expect(resp.status).toBe(401);
    });
  }
});

describe("GET /admin/conversions/list", () => {
  it("returns empty items array when no targets exist for the customer", async () => {
    const resp = await worker.fetch(
      req("GET", "/admin/conversions/list?customer_id=c1"),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("400 when customer_id missing", async () => {
    const resp = await worker.fetch(
      req("GET", "/admin/conversions/list"),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("returns previously upserted rows with parsed selectors and enabled as boolean", async () => {
    state.manifestJson = MANIFEST_WITH_CTA;
    state.manifestConfirmed = true;
    // seed via the upsert endpoint
    await worker.fetch(
      req("POST", "/admin/conversions/upsert", {
        customer_id: "c1",
        section_path: "hero.cta.label",
        label: "Get started",
        conversion_label: "signup",
      }),
      ENV,
      {} as ExecutionContext,
    );

    const resp = await worker.fetch(
      req("GET", "/admin/conversions/list?customer_id=c1"),
      ENV,
      {} as ExecutionContext,
    );
    const body = (await resp.json()) as {
      items: Array<{
        section_path: string;
        enabled: boolean;
        css_selectors: string[];
        conversion_label: string;
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].section_path).toBe("hero.cta.label");
    expect(body.items[0].enabled).toBe(true);
    expect(body.items[0].conversion_label).toBe("signup");
    expect(body.items[0].css_selectors).toEqual(["#hero-cta", ".btn-primary"]);
  });
});

describe("POST /admin/conversions/upsert", () => {
  beforeEach(() => {
    state.manifestJson = MANIFEST_WITH_CTA;
    state.manifestConfirmed = true;
  });

  it("400 on missing customer_id / section_path / label", async () => {
    const cases = [
      { section_path: "x", label: "y" },
      { customer_id: "c1", label: "y" },
      { customer_id: "c1", section_path: "x" },
    ];
    for (const body of cases) {
      const resp = await worker.fetch(
        req("POST", "/admin/conversions/upsert", body),
        ENV,
        {} as ExecutionContext,
      );
      expect(resp.status).toBe(400);
    }
  });

  it("400 on invalid conversion_label", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/conversions/upsert", {
        customer_id: "c1",
        section_path: "hero.cta.label",
        label: "x",
        conversion_label: "not-an-enum",
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("derives selectors from the manifest when not supplied in the body", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/conversions/upsert", {
        customer_id: "c1",
        section_path: "hero.cta.label",
        label: "Get started",
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      css_selectors: string[];
      structural_selector: string;
      conversion_label: string;
      enabled: boolean;
    };
    expect(body.css_selectors).toEqual(["#hero-cta", ".btn-primary"]);
    expect(body.structural_selector).toBe("primary CTA in hero");
    expect(body.conversion_label).toBe("other"); // default
    expect(body.enabled).toBe(true); // default
  });

  it("body-supplied selectors override the manifest", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/conversions/upsert", {
        customer_id: "c1",
        section_path: "custom.path",
        label: "Manual target",
        css_selectors: ["#custom-button"],
        structural_selector: "custom button",
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { css_selectors: string[] };
    expect(body.css_selectors).toEqual(["#custom-button"]);
  });
});

describe("POST /admin/conversions/confirm: bulk seed from review", () => {
  it("400 when no confirmed manifest exists", async () => {
    state.manifestConfirmed = false;
    const resp = await worker.fetch(
      req("POST", "/admin/conversions/confirm", {
        customer_id: "c1",
        targets: [],
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("accepts manifest-present targets, rejects unknown section_path", async () => {
    state.manifestJson = MANIFEST_WITH_CTA;
    state.manifestConfirmed = true;
    const resp = await worker.fetch(
      req("POST", "/admin/conversions/confirm", {
        customer_id: "c1",
        targets: [
          { section_path: "hero.cta.label", label: "Get started", conversion_label: "signup" },
          {
            section_path: "pricing.cta.label",
            label: "Start Pro",
            conversion_label: "signup",
          },
          { section_path: "ghost.path", label: "ghost", conversion_label: "signup" },
        ],
      }),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      accepted: Array<{ section_path: string }>;
      rejected: Array<{ section_path: string; reason: string }>;
    };
    expect(body.accepted).toHaveLength(2);
    expect(body.accepted.map((a) => a.section_path).sort()).toEqual([
      "hero.cta.label",
      "pricing.cta.label",
    ]);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0].section_path).toBe("ghost.path");
  });

  it("copies denormalized selectors from manifest at confirm time", async () => {
    state.manifestJson = MANIFEST_WITH_CTA;
    state.manifestConfirmed = true;
    await worker.fetch(
      req("POST", "/admin/conversions/confirm", {
        customer_id: "c1",
        targets: [
          { section_path: "hero.cta.label", label: "Get started", conversion_label: "signup" },
        ],
      }),
      ENV,
      {} as ExecutionContext,
    );
    const listResp = await worker.fetch(
      req("GET", "/admin/conversions/list?customer_id=c1"),
      ENV,
      {} as ExecutionContext,
    );
    const listBody = (await listResp.json()) as {
      items: Array<{
        css_selectors: string[];
        text_selectors: string[];
        structural_selector: string;
      }>;
    };
    expect(listBody.items[0].css_selectors).toEqual(["#hero-cta", ".btn-primary"]);
    expect(listBody.items[0].text_selectors).toEqual(["Get started"]);
    expect(listBody.items[0].structural_selector).toBe("primary CTA in hero");
  });
});

describe("POST /admin/conversions/delete", () => {
  it("400 on missing id", async () => {
    const resp = await worker.fetch(
      req("POST", "/admin/conversions/delete", {}),
      ENV,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("removes the row and returns { deleted: true, id }", async () => {
    state.manifestJson = MANIFEST_WITH_CTA;
    state.manifestConfirmed = true;
    // Seed one row via upsert
    const upsertResp = await worker.fetch(
      req("POST", "/admin/conversions/upsert", {
        customer_id: "c1",
        section_path: "hero.cta.label",
        label: "Get started",
      }),
      ENV,
      {} as ExecutionContext,
    );
    const upserted = (await upsertResp.json()) as { id: string };

    const delResp = await worker.fetch(
      req("POST", "/admin/conversions/delete", { id: upserted.id }),
      ENV,
      {} as ExecutionContext,
    );
    expect(delResp.status).toBe(200);
    const delBody = (await delResp.json()) as { deleted: boolean; id: string };
    expect(delBody.deleted).toBe(true);
    expect(delBody.id).toBe(upserted.id);

    const listResp = await worker.fetch(
      req("GET", "/admin/conversions/list?customer_id=c1"),
      ENV,
      {} as ExecutionContext,
    );
    const listBody = (await listResp.json()) as { items: unknown[] };
    expect(listBody.items).toEqual([]);
  });
});
