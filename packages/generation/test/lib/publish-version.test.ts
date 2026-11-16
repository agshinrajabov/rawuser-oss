/**
 * Version provenance (docs/specs/proof-engine.md, section C): one way to go
 * live, immutable bodies, the id inside the KV value, retirement, backfill,
 * and the static test that no other source file writes a live variant key.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { type VariantBody, canonicalJson, computeBodyId } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import {
  backfillBodies,
  parseVariantKey,
  publishVersion,
  putPreviewBody,
} from "../../src/lib/publish-version.ts";
import { writeErrorRow } from "../../src/lib/variant-rows.ts";
import { makeKv, makeSqliteD1 } from "../admin/sqlite-d1.ts";

function setup() {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    "INSERT INTO customers (id, slug, domain, status, created_at) VALUES ('acme', 'acme', 'acme.test', 'active', 1)",
  ).run();
  db.prepare(
    "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('acme', '/', '{}', 'https://acme.test/', 1, 1, 'az')",
  ).run();
  const kv = makeKv();
  return { env: { DB: d1, VARIANTS: kv }, db, kv };
}

const body = (headline: string): VariantBody => ({
  customer_id: "acme",
  profile_key: "intent:problem:ai",
  sections: { hero: { kind: "hero", headline, body: "Body words" } },
  generated_at: 123,
  prompt_hash: "ph",
});
const cell = {
  customerId: "acme",
  pagePath: "/",
  intentDim: "problem" as const,
  sourceDim: "ai" as const,
};
const prov = { model: "model-a" as const, promptHash: "ph", costUsd: 0.001, lintFlags: [] };

describe("computeBodyId", () => {
  it("is 16 hex and stable under key order", async () => {
    const a = await computeBodyId(
      { customer_id: "acme", page_path: "/", intent_dim: "problem", source_dim: "ai" },
      { hero: { kind: "hero", headline: "H", body: "B" } },
    );
    const b = await computeBodyId(
      { source_dim: "ai", intent_dim: "problem", page_path: "/", customer_id: "acme" },
      { hero: { body: "B", headline: "H", kind: "hero" } },
    );
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toBe(a);
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  it("differs by cell and by words, not by generated_at or prompt_hash", async () => {
    const c = { customer_id: "acme", page_path: "/", intent_dim: "problem", source_dim: "ai" };
    const id = await computeBodyId(c, body("H").sections);
    expect(await computeBodyId({ ...c, source_dim: "social" }, body("H").sections)).not.toBe(id);
    expect(await computeBodyId(c, body("Other").sections)).not.toBe(id);
  });
});

describe("publishVersion", () => {
  it("writes the body row, the live key with its id, and points variants.body_id at it", async () => {
    const { env, db, kv } = setup();
    const out = await publishVersion(env, cell, body("First"), prov, 1000);
    expect(out.body_id).toMatch(/^[0-9a-f]{16}$/);
    const live = JSON.parse(kv.store.get("v1:variant:acme:problem:ai") ?? "{}");
    expect(live.body_id).toBe(out.body_id);
    expect(live.sections.hero.headline).toBe("First");
    const row = db
      .prepare("SELECT * FROM version_bodies WHERE body_id = ?")
      .get(out.body_id) as Record<string, unknown>;
    expect(row).toMatchObject({
      customer_id: "acme",
      page_path: "/",
      intent_dim: "problem",
      source_dim: "ai",
      language: "az",
      live_from: 1000,
      retired_at: null,
    });
    expect(JSON.parse(String(row.body_json)).body_id).toBe(out.body_id);
    const v = db
      .prepare("SELECT body_id, status FROM variants WHERE customer_id = 'acme'")
      .get() as {
      body_id: string;
      status: string;
    };
    expect(v).toEqual({ body_id: out.body_id, status: "ready" });
  });

  it("the same body twice is one row", async () => {
    const { env, db } = setup();
    const a = await publishVersion(env, cell, body("Same"), prov, 1000);
    const b = await publishVersion(env, cell, { ...body("Same"), generated_at: 999 }, prov, 2000);
    expect(b.body_id).toBe(a.body_id);
    const n = db.prepare("SELECT COUNT(*) AS n FROM version_bodies").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("a rewrite retires the previous body and points variants.body_id at the new one", async () => {
    const { env, db } = setup();
    const a = await publishVersion(env, cell, body("Old"), prov, 1000);
    const b = await publishVersion(env, cell, body("New"), prov, 2000);
    const rows = db
      .prepare("SELECT body_id, live_from, retired_at FROM version_bodies ORDER BY live_from")
      .all() as Array<{ body_id: string; live_from: number; retired_at: number | null }>;
    expect(rows).toEqual([
      { body_id: a.body_id, live_from: 1000, retired_at: 2000 },
      { body_id: b.body_id, live_from: 2000, retired_at: null },
    ]);
    const v = db.prepare("SELECT body_id FROM variants").get() as { body_id: string };
    expect(v.body_id).toBe(b.body_id);
  });

  it("retires only the same cell", async () => {
    const { env, db } = setup();
    await publishVersion(env, cell, body("A"), prov, 1000);
    await publishVersion(env, { ...cell, sourceDim: "social" }, body("B"), prov, 2000);
    const retired = db
      .prepare("SELECT COUNT(*) AS n FROM version_bodies WHERE retired_at IS NOT NULL")
      .get() as {
      n: number;
    };
    expect(retired.n).toBe(0);
  });

  it("an errored rewrite leaves the live body, its row and its id alone", async () => {
    const { env, db, kv } = setup();
    const a = await publishVersion(env, cell, body("Live"), prov, 1000);
    const before = kv.store.get("v1:variant:acme:problem:ai");
    await writeErrorRow(
      "acme",
      { intent_dim: "problem", source_dim: "ai" },
      "v1:variant:acme:problem:ai",
      "timeout",
      env.DB,
      "/",
      "model-a",
    );
    expect(kv.store.get("v1:variant:acme:problem:ai")).toBe(before);
    const v = db.prepare("SELECT body_id, status FROM variants").get() as {
      body_id: string;
      status: string;
    };
    expect(v).toEqual({ body_id: a.body_id, status: "error" });
    const live = db
      .prepare("SELECT retired_at FROM version_bodies WHERE body_id = ?")
      .get(a.body_id) as {
      retired_at: number | null;
    };
    expect(live.retired_at).toBeNull();
  });

  it("a preview never lands on a live key", async () => {
    const { env } = setup();
    await expect(
      putPreviewBody(env, "v1:variant:acme:problem:ai", body("x"), 60),
    ).rejects.toThrow();
    await putPreviewBody(env, "v1:preview:acme:/:evaluation:default", body("x"), 60);
  });
});

describe("parseVariantKey", () => {
  it("reads root and path keys of the customer only", () => {
    expect(parseVariantKey("v1:variant:acme:problem:ai", "acme")).toEqual({
      pagePath: "/",
      intentDim: "problem",
      sourceDim: "ai",
    });
    expect(parseVariantKey("v1:variant:acme:p:%2Fpricing:pricing:default", "acme")).toEqual({
      pagePath: "/pricing",
      intentDim: "pricing",
      sourceDim: "default",
    });
    expect(parseVariantKey("v1:variant:other:problem:ai", "acme")).toBeNull();
  });
});

describe("backfillBodies", () => {
  it("gives every live body its id once, and a second run writes nothing", async () => {
    const { env, db, kv } = setup();
    // A body written before the proof engine: no body_id in KV or D1.
    kv.store.set("v1:variant:acme:problem:ai", JSON.stringify(body("Before")));
    const profile = db
      .prepare(
        "SELECT id FROM intent_profiles WHERE profile_key = 'intent:problem' AND customer_id IS NULL",
      )
      .get() as {
      id: string;
    };
    db.prepare(
      `INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status)
       VALUES ('gen:acme:problem:ai', 'acme', ?, 'v1:variant:acme:problem:ai', 'model-a', 'ph', 777, 0, 'ready')`,
    ).run(profile.id);

    const first = await backfillBodies(env, "acme");
    expect(first).toEqual({ scanned: 1, written: 1, skipped: 0 });
    const live = JSON.parse(kv.store.get("v1:variant:acme:problem:ai") ?? "{}");
    expect(live.body_id).toMatch(/^[0-9a-f]{16}$/);
    const row = db
      .prepare("SELECT live_from, retired_at FROM version_bodies WHERE body_id = ?")
      .get(live.body_id) as { live_from: number; retired_at: null };
    expect(row).toEqual({ live_from: 777, retired_at: null });
    const v = db.prepare("SELECT body_id FROM variants").get() as { body_id: string };
    expect(v.body_id).toBe(live.body_id);

    const snapshot = kv.store.get("v1:variant:acme:problem:ai");
    const second = await backfillBodies(env, "acme");
    expect(second).toEqual({ scanned: 1, written: 0, skipped: 0 });
    expect(kv.store.get("v1:variant:acme:problem:ai")).toBe(snapshot);
    const n = db.prepare("SELECT COUNT(*) AS n FROM version_bodies").get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe("static: no live-key write outside publishVersion", () => {
  const ROOT = resolve(__dirname, "../../../..");
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === "node_modules" ? [] : files(p);
      return p.endsWith(".ts") ? [p] : [];
    });
  }

  it("every KV put whose key is a variant key sits in lib/publish-version.ts", () => {
    const dirs = ["packages/generation/src", "packages/edge/src", "scripts"].map((d) =>
      join(ROOT, d),
    );
    const offenders: string[] = [];
    let seen = 0;
    for (const file of dirs.flatMap(files)) {
      const rel = relative(ROOT, file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\.put\(\s*([^,]+),/g)) {
        seen++;
        const key = m[1] ?? "";
        if (
          /kvKey|liveKey|variantKey|v1:variant/.test(key) &&
          rel !== "packages/generation/src/lib/publish-version.ts"
        ) {
          offenders.push(`${rel}: put(${key.trim()}, ...)`);
        }
      }
    }
    expect(seen).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
