/**
 * `POST /admin/variants/stale-all` with a page marks that page's rows only
 * (J6 of docs/specs/pilot-gaps.md).
 *
 * The variants table has no page column: the page is in the key. The home
 * page's keys are the customer's prefix with no `p:` segment, so matching the
 * prefix alone took every page with it: "Regenerate, this page only" on the
 * homepage marked the whole site stale and the queue rewrote all of it. And a
 * path's `%2F` is a LIKE wildcard: `/pricing` also matched `/az/pricing`.
 *
 * SQLite with every migration, the handler's own statement.
 */
import { describe, expect, it } from "vitest";
import { handleVariantsStaleAll } from "../src/admin/handlers.ts";
import { triedKey } from "../src/lib/tried-marker.ts";
import { pageKeyWhere } from "../src/lib/variant-rows.ts";
import { makeKv, makeSqliteD1 } from "./admin/sqlite-d1.ts";

const USER = { id: "u", email: "a@b.c", role: "superadmin", customer_id: null };

const PAGES = ["/", "/pricing", "/az/pricing"] as const;
const CELLS = ["problem:default", "problem:ai", "pricing:ai"] as const;

function keyOf(customer: string, page: string, cell: string): string {
  return page === "/"
    ? `v1:variant:${customer}:${cell}`
    : `v1:variant:${customer}:p:${encodeURIComponent(page)}:${cell}`;
}

function setup(served: string[] | null = null) {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    "INSERT INTO intent_profiles (id, customer_id, profile_key, label, trigger_signals, dimensions, structure_plan, lead_prob_base) VALUES ('p', NULL, 'x', 'x', '[]', '{}', '{}', 0.1)",
  ).run();
  const ins = db.prepare(
    "INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status) VALUES (?, ?, 'p', ?, 'm', 'h', 1, 0, 'ready')",
  );
  // `acme` is the one asked for; `acme2` shares its prefix as text and
  // `ac_e` would match `acme` if the id's underscore were a wildcard.
  for (const customer of ["acme", "acme2", "ac_e"]) {
    db.prepare(
      "INSERT INTO customers (id, slug, domain, status, created_at, served_intents) VALUES (?, ?, ?, 'active', 1, ?)",
    ).run(
      customer,
      customer,
      `${customer.replace("_", "-")}.test`,
      served ? JSON.stringify(served) : null,
    );
    for (const page of PAGES) {
      for (const cell of CELLS) {
        const key = keyOf(customer, page, cell);
        ins.run(key, customer, key);
      }
    }
  }
  const kv = makeKv();
  const env = {
    DB: d1,
    VARIANTS: kv,
    ENVIRONMENT: "test",
    ALLOWED_ORIGINS: "https://app.test",
  } as never;
  const stale = () =>
    (
      db.prepare("SELECT kv_key FROM variants WHERE status = 'stale' ORDER BY kv_key").all() as {
        kv_key: string;
      }[]
    ).map((r) => r.kv_key);
  const call = async (body: unknown) => {
    const r = await handleVariantsStaleAll(
      new Request("https://gen.test/admin/variants/stale-all", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      env,
      USER,
    );
    return (await r.json()) as { ok: boolean; count: number };
  };
  return { db, kv, stale, call };
}

const keysOf = (customer: string, page: string) =>
  CELLS.map((c) => keyOf(customer, page, c)).sort();

describe("stale-all with a page", () => {
  it("the home page: its own rows, not the other pages' (J6)", async () => {
    const s = setup();
    const r = await s.call({ customer_id: "acme", page_path: "/" });
    // Before: 9, every page of the customer.
    expect(r).toEqual({ ok: true, count: 3 });
    expect(s.stale()).toEqual(keysOf("acme", "/"));
  });

  it("a path: its own rows, not a longer path that ends the same", async () => {
    const s = setup();
    const r = await s.call({ customer_id: "acme", page_path: "/pricing" });
    // Before: 6. `%2Fpricing` as a pattern also matched `%2Faz%2Fpricing`.
    expect(r).toEqual({ ok: true, count: 3 });
    expect(s.stale()).toEqual(keysOf("acme", "/pricing"));
  });

  it("the longer path: its own rows", async () => {
    const s = setup();
    expect(await s.call({ customer_id: "acme", page_path: "/az/pricing" })).toEqual({
      ok: true,
      count: 3,
    });
    expect(s.stale()).toEqual(keysOf("acme", "/az/pricing"));
  });

  it("each page in turn, as the dashboard's 'Every page' sends them: all nine, each once", async () => {
    const s = setup();
    const counts: number[] = [];
    for (const page of PAGES) {
      counts.push((await s.call({ customer_id: "acme", page_path: page })).count);
    }
    expect(counts).toEqual([3, 3, 3]);
    expect(s.stale()).toHaveLength(9);
    expect(s.stale().every((k) => k.startsWith("v1:variant:acme:"))).toBe(true);
  });

  it("without a page: every page of that customer, as before", async () => {
    const s = setup();
    expect((await s.call({ customer_id: "acme" })).count).toBe(9);
    expect(s.stale().every((k) => k.startsWith("v1:variant:acme:"))).toBe(true);
  });

  it("a customer whose id has an underscore: only its own home page", async () => {
    const s = setup();
    expect((await s.call({ customer_id: "ac_e", page_path: "/" })).count).toBe(3);
    expect(s.stale()).toEqual(keysOf("ac_e", "/"));
  });

  it("the home page of a site that folds an intent: the served rows of the home page only", async () => {
    const s = setup(["evaluation", "feature", "problem", "brand"]);
    const r = await s.call({ customer_id: "acme", page_path: "/" });
    expect(r.count).toBe(2);
    expect(s.stale()).toEqual(["v1:variant:acme:problem:ai", "v1:variant:acme:problem:default"]);
  });

  it("the markers of refused rows: the home page forgets its own, a path its own", async () => {
    const s = setup();
    s.db.prepare("UPDATE variants SET status = 'error' WHERE kv_key LIKE '%problem:ai'").run();
    const marked = PAGES.map((p) => keyOf("acme", p, "problem:ai"));
    for (const k of marked) await s.kv.put(triedKey(k), "1");
    await s.call({ customer_id: "acme", page_path: "/" });
    expect([...s.kv.store.keys()].filter((k) => k.startsWith("gen:tried:")).sort()).toEqual(
      [triedKey(marked[1] as string), triedKey(marked[2] as string)].sort(),
    );
    await s.call({ customer_id: "acme", page_path: "/pricing" });
    expect([...s.kv.store.keys()].filter((k) => k.startsWith("gen:tried:"))).toEqual([
      triedKey(marked[2] as string),
    ]);
  });
});

describe("pageKeyWhere", () => {
  it("the home page excludes path keys; a path's wildcards are escaped", () => {
    expect(pageKeyWhere("acme", "/")).toEqual({
      sql: "kv_key LIKE ? ESCAPE '\\' AND kv_key NOT LIKE ? ESCAPE '\\'",
      binds: ["v1:variant:acme:%", "v1:variant:acme:p:%"],
    });
    expect(pageKeyWhere("ac_e", "/az/pricing", "v.kv_key")).toEqual({
      sql: "v.kv_key LIKE ? ESCAPE '\\'",
      binds: ["v1:variant:ac\\_e:p:\\%2Faz\\%2Fpricing:%"],
    });
  });
});
