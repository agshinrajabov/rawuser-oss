/**
 * Versions for every customer (docs/specs/versions-for-every-customer.md):
 * a customer's own session reads and rewrites its own versions only, never
 * sees a cost, model, rule name, prompt hash, key or stored error text, and
 * has one rewrite of a written version at a time inside a daily cap. A
 * superadmin's answers are as before. Real SQL on node:sqlite; the model is
 * stubbed.
 */
import { variantKeyForPath } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness } from "../proof-harness.ts";

const BODY = {
  customer_id: "acme",
  profile_key: "intent:problem",
  sections: { hero: { kind: "hero", headline: "New words", body: "More words" } },
  generated_at: 5,
  prompt_hash: "ph-secret",
  body_id: "0123456789abcdef",
};

let nextResult: Record<string, unknown> = {};
const regenerateOne = vi.fn(
  async (customer: string, intent: string, source: string, _env: unknown, page = "/") => ({
    customer_id: customer,
    intent_dim: intent,
    source_dim: source,
    kv_key: variantKeyForPath(customer, page, intent, source),
    cost_usd: 0.0007,
    ok: true,
    body: BODY,
    parts_as_built: [{ path: "hero.body", rule: "length-drift" }],
    provenance: {
      model: "model-a",
      prompt_hash: "ph-secret",
      cost_usd: 0.0007,
      lint_flags: ["length-drift"],
    },
    ...nextResult,
  }),
);
vi.mock("../../src/orchestrator.ts", async (orig) => ({
  ...(await orig<typeof import("../../src/orchestrator.ts")>()),
  regenerateOne: (...args: unknown[]) =>
    regenerateOne(...(args as [string, string, string, unknown])),
}));

type User = { id: string; email: string; role: string; customer_id: string | null };
const ACME: User = { id: "u2", email: "c@acme.test", role: "customer", customer_id: "acme" };
const SUPERADMIN: User = {
  id: "u1",
  email: "f@example.com",
  role: "superadmin",
  customer_id: null,
};
let sessionUser: User = ACME;
vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionUser),
}));

const { default: worker } = await import("../../src/index.ts");
const { CUSTOMER_REWRITES_PER_DAY, REWRITE_CAP_LINE, customerError } = await import(
  "../../src/admin/customer-versions.ts"
);

let h: Harness;
beforeEach(() => {
  h = harness();
  h.customer("acme");
  h.customer("beta");
  sessionUser = ACME;
  nextResult = {};
  regenerateOne.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> & unknown[] }> {
  const res = await worker.fetch(
    new Request(`https://api.example.com${path}`, {
      method,
      headers: { "x-rawuser-admin": "session", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    h.env as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
  return { status: res.status, json: (await res.json()) as never };
}

function row(
  customer: string,
  intent: string,
  source: string,
  status: "ready" | "stale" | "error",
  extra: { page?: string; error?: string; flags?: string[] } = {},
) {
  h.db
    .prepare(
      `INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status, error_reason, lint_flags)
       SELECT ?, ?, id, ?, 'model-a', 'ph-secret', 1, 0.0007, ?, ?, ? FROM intent_profiles
       WHERE profile_key = ? AND customer_id IS NULL`,
    )
    .run(
      `${customer}-${intent}-${source}-${extra.page ?? "/"}`,
      customer,
      variantKeyForPath(customer, extra.page ?? "/", intent, source),
      status,
      extra.error ?? null,
      extra.flags ? JSON.stringify(extra.flags) : null,
      `intent:${intent}`,
    );
}

function confirmed(customer: string, path: string) {
  h.db
    .prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at) VALUES (?, ?, '{}', 'https://x.test/', 1, 5)",
    )
    .run(customer, path);
}

const ask = (extra: Record<string, unknown> = {}) => ({
  customer_id: "acme",
  intent_dim: "problem",
  source_dim: "ai",
  ...extra,
});

/** No internal field name anywhere in a customer's answer. */
function expectNoInternals(json: unknown) {
  const text = JSON.stringify(json);
  for (const word of [
    "cost_usd",
    '"model"',
    "model-a",
    "lint_flags",
    "length-drift",
    "prompt_hash",
    "ph-secret",
    "profile_key",
    "body_id",
    "provenance",
    '"rule"',
  ]) {
    expect(text).not.toContain(word);
  }
}

describe("a customer never reaches another customer's versions", () => {
  const CASES: Array<[string, "GET" | "POST", string, unknown?]> = [
    ["list", "GET", "/admin/variants/list?customer_id=beta"],
    ["list with summary", "GET", "/admin/variants/list?customer_id=beta&summary=1"],
    ["get", "GET", "/admin/variant/get?customer_id=beta&intent=problem&source=ai"],
    ["regenerate", "POST", "/admin/variant/regenerate", ask({ customer_id: "beta" })],
    ["stale-all", "POST", "/admin/variants/stale-all", { customer_id: "beta" }],
  ];
  for (const [name, method, path, body] of CASES) {
    it(`${name}: 403, nothing written, no other id in the answer`, async () => {
      row("beta", "problem", "ai", "ready");
      h.kv.set(variantKeyForPath("beta", "/", "problem", "ai"), JSON.stringify(BODY));
      const r = await call(method, path, body);
      expect(r.status).toBe(403);
      expect(String(r.json.error)).not.toContain("beta");
      expect(regenerateOne).not.toHaveBeenCalled();
      const status = h.db
        .prepare("SELECT status FROM variants WHERE customer_id = 'beta'")
        .get() as { status: string };
      expect(status.status).toBe("ready");
    });
  }
});

describe("what a customer reads", () => {
  it("the list: its own rows, no cost, model, flags or rule", async () => {
    row("acme", "problem", "ai", "ready", {
      flags: ["length-drift", "part-as-built:hero.body:length-drift"],
    });
    row("beta", "brand", "ai", "ready");
    const r = await call("GET", "/admin/variants/list?customer_id=acme");
    expect(r.status).toBe(200);
    expect(r.json).toEqual([
      {
        intent_dim: "problem",
        source_dim: "ai",
        page_path: "/",
        generated_at: 1,
        status: "ready",
        kv_key: variantKeyForPath("acme", "/", "problem", "ai"),
        parts_as_built: [{ path: "hero.body" }],
        // The approval state (versions-approval.md): nothing waits here.
        pending: false,
        pending_since: null,
        approval: "approved",
        waiting_since: null,
      },
    ]);
    expectNoInternals(r.json);
  });

  it("the summary: a refused row's reason as a cause phrase, and the rewrites left", async () => {
    row("acme", "problem", "ai", "error", {
      error: "lint: 3 of 5 parts could not be written; hero.body length-drift",
    });
    row("acme", "brand", "ai", "error", { error: "lint: hero.headline numbers-not-in-brief 800" });
    const r = await call("GET", "/admin/variants/list?customer_id=acme&summary=1");
    expect(r.status).toBe(200);
    const json = r.json as unknown as {
      summary: { refused_rows: Array<{ intent_dim: string; error_reason: string }> };
      rewrites: { left: number; per_day: number };
    };
    const reasons = Object.fromEntries(
      json.summary.refused_rows.map((x) => [x.intent_dim, x.error_reason]),
    );
    expect(reasons).toEqual({ problem: "parts could not be written", brand: "" });
    expect(json.rewrites).toEqual({
      left: CUSTOMER_REWRITES_PER_DAY,
      per_day: CUSTOMER_REWRITES_PER_DAY,
    });
    expect(JSON.stringify(json)).not.toContain("numbers-not-in-brief");
    expect(JSON.stringify(json)).not.toContain("800");
  });

  it("a superadmin's list is as before", async () => {
    sessionUser = SUPERADMIN;
    row("acme", "problem", "ai", "ready", { flags: ["length-drift"] });
    const r = await call("GET", "/admin/variants/list?customer_id=acme");
    expect(r.json[0]).toMatchObject({
      model: "model-a",
      cost_usd: 0.0007,
      lint_flags: ["length-drift"],
    });
  });

  it("a body: the words, without prompt hash, profile key or body id", async () => {
    h.kv.set(variantKeyForPath("acme", "/", "problem", "ai"), JSON.stringify(BODY));
    const r = await call("GET", "/admin/variant/get?customer_id=acme&intent=problem&source=ai");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ customer_id: "acme", sections: BODY.sections, generated_at: 5 });
    sessionUser = SUPERADMIN;
    const s = await call("GET", "/admin/variant/get?customer_id=acme&intent=problem&source=ai");
    expect(s.json).toMatchObject({ prompt_hash: "ph-secret", body_id: BODY.body_id });
  });

  it("a write's answer: the words and what is left, no key, cost or provenance", async () => {
    row("acme", "problem", "ai", "ready");
    const r = await call("POST", "/admin/variant/regenerate", ask());
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      customer_id: "acme",
      intent_dim: "problem",
      source_dim: "ai",
      ok: true,
      rewrites_left: CUSTOMER_REWRITES_PER_DAY - 1,
      body: { customer_id: "acme", sections: BODY.sections, generated_at: 5 },
      parts_as_built: [{ path: "hero.body" }],
    });
    expectNoInternals(r.json);
  });

  it("a failed write says a closed word, never the stored text", () => {
    expect(customerError("lint: hero.headline numbers-not-in-brief 800")).toBe("not_written");
    expect(customerError("Timeout after 45000ms")).toBe("service_down");
    expect(customerError("Error: Model request failed: HTTP 503")).toBe("service_down");
    expect(customerError("lint: 3 of 5 parts could not be written; x")).toBe(
      "parts could not be written",
    );
    expect(customerError("waiting")).toBe("waiting");
    expect(customerError("not_served")).toBe("not_served");
    expect(customerError(undefined)).toBeUndefined();
  });

  it("a failed write's answer carries no cost or reason text", async () => {
    row("acme", "problem", "ai", "ready");
    nextResult = {
      ok: false,
      error: "lint: hero.headline numbers-not-in-brief 800",
      body: undefined,
    };
    const r = await call("POST", "/admin/variant/regenerate", ask());
    expect(r.json).toMatchObject({ ok: false, error: "not_written" });
    expectNoInternals(r.json);
    expect(JSON.stringify(r.json)).not.toContain("800");
  });

  it("names a version is never written for: 400, nothing spent", async () => {
    const r = await call("POST", "/admin/variant/regenerate", ask({ source_dim: "anything" }));
    expect(r.status).toBe(400);
    expect(regenerateOne).not.toHaveBeenCalled();
  });
});

describe("the daily cap on rewrites", () => {
  it(`a written version: ${CUSTOMER_REWRITES_PER_DAY} a day, then 409 and nothing spent`, async () => {
    row("acme", "problem", "ai", "ready");
    for (let i = 0; i < CUSTOMER_REWRITES_PER_DAY; i++) {
      const r = await call("POST", "/admin/variant/regenerate", ask());
      expect(r.status).toBe(200);
      expect(r.json.rewrites_left).toBe(CUSTOMER_REWRITES_PER_DAY - 1 - i);
    }
    const over = await call("POST", "/admin/variant/regenerate", ask());
    expect(over.status).toBe(409);
    expect(over.json).toEqual({
      error: "rewrite_cap",
      message: REWRITE_CAP_LINE,
      rewrites_left: 0,
    });
    expect(regenerateOne).toHaveBeenCalledTimes(CUSTOMER_REWRITES_PER_DAY);
  });

  it("the cap is the customer's own: another customer's day is untouched", async () => {
    row("acme", "problem", "ai", "ready");
    await call("POST", "/admin/variant/regenerate", ask());
    sessionUser = { ...ACME, customer_id: "beta", email: "b@beta.test" };
    const r = await call("GET", "/admin/variants/list?customer_id=beta&summary=1");
    expect((r.json as unknown as { rewrites: { left: number } }).rewrites.left).toBe(
      CUSTOMER_REWRITES_PER_DAY,
    );
  });

  it("versions Rawuser owes are free: never written on a confirmed page, stale, the loop's own retry", async () => {
    confirmed("acme", "/");
    row("acme", "brand", "ai", "stale");
    row("acme", "feature", "ai", "error", { error: "Timeout after 45000ms" });
    const fresh = await call("POST", "/admin/variant/regenerate", ask());
    const stale = await call("POST", "/admin/variant/regenerate", ask({ intent_dim: "brand" }));
    const retry = await call(
      "POST",
      "/admin/variant/regenerate",
      ask({ intent_dim: "feature", auto: true }),
    );
    for (const r of [fresh, stale, retry]) {
      expect(r.status).toBe(200);
      expect(r.json.rewrites_left).toBe(CUSTOMER_REWRITES_PER_DAY);
    }
  });

  it("a failed version asked for by hand, or a page with no confirmed manifest, takes one", async () => {
    row("acme", "feature", "ai", "error", { error: "lint: x" });
    const byHand = await call("POST", "/admin/variant/regenerate", ask({ intent_dim: "feature" }));
    expect(byHand.json.rewrites_left).toBe(CUSTOMER_REWRITES_PER_DAY - 1);
    const stray = await call("POST", "/admin/variant/regenerate", ask({ page_path: "/nowhere" }));
    expect(stray.json.rewrites_left).toBe(CUSTOMER_REWRITES_PER_DAY - 2);
  });

  it("a superadmin has no cap", async () => {
    sessionUser = SUPERADMIN;
    row("acme", "problem", "ai", "ready");
    for (let i = 0; i < CUSTOMER_REWRITES_PER_DAY + 2; i++) {
      const r = await call("POST", "/admin/variant/regenerate", ask());
      expect(r.status).toBe(200);
      expect(r.json).toHaveProperty("cost_usd");
    }
  });

  it("Rewrite everything: once a day for a customer, any number for a superadmin", async () => {
    row("acme", "problem", "ai", "ready");
    const first = await call("POST", "/admin/variants/stale-all", { customer_id: "acme" });
    expect(first.json).toMatchObject({ ok: true, count: 1 });
    const second = await call("POST", "/admin/variants/stale-all", { customer_id: "acme" });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("rewrite_all_used");
    sessionUser = SUPERADMIN;
    const third = await call("POST", "/admin/variants/stale-all", { customer_id: "acme" });
    expect(third.status).toBe(200);
  });
});
