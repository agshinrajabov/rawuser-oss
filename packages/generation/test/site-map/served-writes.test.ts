/**
 * Rewrite everything and Regenerate count from the served set
 * (docs/specs/site-shaped-intents.md §7.3, the founder's decision 5): a
 * folded intent's versions stay in KV, unused, and are never rewritten.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/orchestrator.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/orchestrator.ts")>();
  return { ...actual, regenerateOne: vi.fn(async () => ({ ok: true, cost_usd: 0.001 })) };
});

import { handleVariantRegenerate, handleVariantsStaleAll } from "../../src/admin/handlers.ts";
import { regenerateOne } from "../../src/orchestrator.ts";
import { makeKv, makeSqliteD1 } from "../admin/sqlite-d1.ts";

const USER = { id: "u", email: "a@b.c", role: "superadmin", customer_id: null };

function setup(served: string[] | null) {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    "INSERT INTO customers (id, slug, domain, status, created_at, served_intents) VALUES ('lumera', 'lumera', 'lumera.test', 'active', 1, ?)",
  ).run(served ? JSON.stringify(served) : null);
  db.prepare(
    "INSERT INTO intent_profiles (id, customer_id, profile_key, label, trigger_signals, dimensions, structure_plan, lead_prob_base) VALUES ('p', NULL, 'x', 'x', '[]', '{}', '{}', 0.1)",
  ).run();
  const ins = db.prepare(
    "INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status) VALUES (?, 'lumera', 'p', ?, 'm', 'h', 1, 0, 'ready')",
  );
  for (const intent of ["pricing", "competitor", "problem", "evaluation"]) {
    ins.run(`root-${intent}`, `v1:variant:lumera:${intent}:ai`);
    ins.run(`approach-${intent}`, `v1:variant:lumera:p:%2Fapproach:${intent}:ai`);
  }
  const env = {
    DB: d1,
    VARIANTS: makeKv(),
    ENVIRONMENT: "test",
    ALLOWED_ORIGINS: "https://app.test",
  } as never;
  return { env, db };
}

const post = (body: unknown) =>
  new Request("https://gen.test/x", { method: "POST", body: JSON.stringify(body) });

describe("Rewrite everything (stale-all)", () => {
  it("marks only the served intents stale, on every page or one", async () => {
    const { env, db } = setup(["evaluation", "feature", "problem", "brand"]);
    const r = await handleVariantsStaleAll(post({ customer_id: "lumera" }), env, USER);
    expect(((await r.json()) as { count: number }).count).toBe(4);
    const stale = db
      .prepare("SELECT kv_key FROM variants WHERE status = 'stale' ORDER BY kv_key")
      .all()
      .map((x) => (x as { kv_key: string }).kv_key);
    expect(stale.some((k) => k.includes(":pricing:") || k.includes(":competitor:"))).toBe(false);
    const one = setup(["evaluation", "feature", "problem", "brand"]);
    const r2 = await handleVariantsStaleAll(
      post({ customer_id: "lumera", page_path: "/approach" }),
      one.env,
      USER,
    );
    expect(((await r2.json()) as { count: number }).count).toBe(2);
  });

  it("all six when the set is not narrowed", async () => {
    const { env } = setup(null);
    const r = await handleVariantsStaleAll(post({ customer_id: "lumera" }), env, USER);
    expect(((await r.json()) as { count: number }).count).toBe(8);
  });
});

describe("Regenerate one", () => {
  it("refuses an intent the site does not serve, spending nothing", async () => {
    const { env } = setup(["evaluation", "feature", "problem", "brand"]);
    const r = await handleVariantRegenerate(
      post({ customer_id: "lumera", intent_dim: "pricing", source_dim: "ai" }),
      env,
      USER,
    );
    expect(await r.json()).toMatchObject({ ok: false, error: "not_served", cost_usd: 0 });
    expect(regenerateOne).not.toHaveBeenCalled();
    await handleVariantRegenerate(
      post({ customer_id: "lumera", intent_dim: "problem", source_dim: "ai" }),
      env,
      USER,
    );
    expect(regenerateOne).toHaveBeenCalledTimes(1);
  });
});
