/**
 * Returning visitors, as the install decides (docs/specs/open-source-release.md
 * 6.3; privacy review 2026-11-15, condition 5):
 *
 * - REMEMBER_DEFAULT is read when a customer row is created, by BOTH
 *   inserts, and reads as off when unset: a new customer's `remember_off`
 *   is 1 unless the var is exactly "on";
 * - no other statement in the generation worker creates a customer without
 *   saying so (a scan of the source);
 * - REMEMBER_ON_SENSITIVE decides whether the memory may run on a site
 *   marked sensitive: in the bundle (`rm`), in the switches' answer, and in
 *   what the switch accepts.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { visitorBundleKey } from "@rawuser/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handleConversionsUpsert } from "../src/admin/conversions.ts";
import { handleDirectSwitches } from "../src/admin/direct-switches.ts";
import { type AdminEnv, insertCustomer } from "../src/admin/handlers.ts";
import { writeVisitorBundle } from "../src/admin/onboard.ts";
import { rememberOffAtCreation, rememberOptions } from "../src/install-config.ts";
import { type Harness, harness } from "./proof-harness.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});

const rememberOff = (id: string) =>
  (
    h.db.prepare("SELECT remember_off FROM customers WHERE id = ?").get(id) as {
      remember_off: number;
    }
  ).remember_off;

const plain = (slug: string) => ({
  slug,
  domain: `${slug}.test`,
  plan: "pilot",
  contactEmail: null,
  contactName: null,
  createdAt: 1,
});
const marked = (slug: string) => ({
  ...plain(slug),
  sensitive: { sensitive: true, kept: ["/about"] },
});

describe("REMEMBER_DEFAULT, read when a customer is created", () => {
  it("unset: both inserts write remember_off = 1", async () => {
    expect(await insertCustomer({ DB: h.d1 }, plain("plain"))).toBe(true);
    expect(await insertCustomer({ DB: h.d1 }, marked("marked"))).toBe(true);
    expect(rememberOff("plain")).toBe(1);
    expect(rememberOff("marked")).toBe(1);
  });

  it('"on": both inserts write remember_off = 0', async () => {
    const env = { DB: h.d1, REMEMBER_DEFAULT: "on" };
    await insertCustomer(env, plain("plain"));
    await insertCustomer(env, marked("marked"));
    expect(rememberOff("plain")).toBe(0);
    expect(rememberOff("marked")).toBe(0);
  });

  it.each(["", "off", "ON", "On", " on", "true", "1", "yes"])(
    "%j is not on: both inserts write 1",
    async (value) => {
      const env = { DB: h.d1, REMEMBER_DEFAULT: value };
      await insertCustomer(env, plain("plain"));
      await insertCustomer(env, marked("marked"));
      expect(rememberOff("plain")).toBe(1);
      expect(rememberOff("marked")).toBe(1);
      expect(rememberOffAtCreation(env)).toBe(1);
    },
  );

  it("the marked insert still marks the customer in the same statement", async () => {
    await insertCustomer({ DB: h.d1, REMEMBER_DEFAULT: "on" }, marked("marked"));
    expect(
      h.db
        .prepare(
          "SELECT sensitive, kept_sections, special_category, remember_off FROM customers WHERE id = 'marked'",
        )
        .get(),
    ).toEqual({ sensitive: 1, kept_sections: '["/about"]', special_category: 1, remember_off: 0 });
  });

  it("the column's own default is not what a new customer gets", async () => {
    // The schema says 0 (on); a row made by the code says what the install said.
    h.db
      .prepare(
        "INSERT INTO customers (id, slug, domain, status, created_at) VALUES ('raw', 'raw', 'raw.test', 'active', 1)",
      )
      .run();
    expect(rememberOff("raw")).toBe(0);
    await insertCustomer({ DB: h.d1 }, plain("made"));
    expect(rememberOff("made")).toBe(1);
  });
});

describe("no statement creates a customer without setting remember_off", () => {
  const SRC = resolve(__dirname, "../src");
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? sourceFiles(join(dir, e.name))
        : e.name.endsWith(".ts")
          ? [join(dir, e.name)]
          : [],
    );
  }
  /** Every statement that inserts into customers, up to the end of its VALUES list. */
  const INSERT = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+customers\b[\s\S]*?VALUES\s*\([^)]*\)/gi;

  it("every INSERT INTO customers in the worker's source names the column", () => {
    const found: Array<{ file: string; statement: string }> = [];
    for (const file of sourceFiles(SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(INSERT)) {
        found.push({ file: file.slice(SRC.length + 1), statement: m[0] });
      }
    }
    // The two this test knows: the plain insert and the marked one. A third
    // must set the column too, and is counted here so it is seen.
    expect(found.map((f) => f.file)).toEqual(["admin/handlers.ts", "admin/handlers.ts"]);
    for (const f of found) {
      expect(f.statement, f.file).toMatch(/\bremember_off\b/);
    }
  });

  it("the scan sees a statement that leaves the column out", () => {
    const bad = "INSERT OR IGNORE INTO customers (id, slug, domain) VALUES (?, ?, ?)";
    const hits = [...bad.matchAll(INSERT)];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.[0]).not.toMatch(/\bremember_off\b/);
  });
});

describe("REMEMBER_ON_SENSITIVE, the bundle generation writes", () => {
  const bundle = (id: string) => JSON.parse(h.kv.get(visitorBundleKey(id)) ?? "{}");
  const mark = (id: string) =>
    h.db
      .prepare(
        "UPDATE customers SET sensitive = 1, special_category = 1, kept_sections = '[\"/about\"]' WHERE id = ?",
      )
      .run(id);

  it('"on": a marked site whose switch is on carries rm', async () => {
    h.customer("acme");
    mark("acme");
    await writeVisitorBundle({ ...h.env, REMEMBER_ON_SENSITIVE: "on" }, "acme");
    expect(bundle("acme")).toMatchObject({ s: 1, rm: 1 });
  });

  it.each([undefined, "", "off", "ON", "true"])(
    "%j: a marked site carries no rm, and keeps its mark",
    async (value) => {
      h.customer("acme");
      mark("acme");
      await writeVisitorBundle({ ...h.env, REMEMBER_ON_SENSITIVE: value }, "acme");
      expect(bundle("acme").s).toBe(1);
      expect(bundle("acme")).not.toHaveProperty("rm");
      expect(rememberOptions({ REMEMBER_ON_SENSITIVE: value })).toEqual({ onSensitive: false });
    },
  );

  it.each([undefined, "off", "on"])("%j: a site that is not marked keeps rm", async (value) => {
    h.customer("acme");
    await writeVisitorBundle({ ...h.env, REMEMBER_ON_SENSITIVE: value }, "acme");
    expect(bundle("acme").rm).toBe(1);
  });

  it("a changed counted button rewrites the bundle with the install's var, not without it", async () => {
    // The conversions handlers hand the writer the bindings by name: the
    // var must ride along, or a marked site would lose its rm on every save.
    const user = { id: "u", email: "a@example.com", role: "superadmin", customer_id: null };
    const save = async (vars: Record<string, string>) => {
      const res = await handleConversionsUpsert(
        new Request("https://api.test/admin/conversions/upsert", {
          method: "POST",
          body: JSON.stringify({
            customer_id: "acme",
            section_path: "hero.cta",
            label: "Start free",
            conversion_label: "signup",
            css_selectors: ["a.cta"],
            structural_selector: "a.cta",
          }),
        }),
        { ...h.env, DASHBOARD_ORIGIN: "*", ...vars },
        user as never,
      );
      expect(res.status).toBe(200);
      return bundle("acme");
    };
    h.customer("acme");
    mark("acme");
    expect(await save({ REMEMBER_ON_SENSITIVE: "on" })).toMatchObject({ s: 1, rm: 1 });
    const off = await save({});
    expect(off.s).toBe(1);
    expect(off.conv).toHaveLength(1);
    expect(off).not.toHaveProperty("rm");
  });

  it("a customer created with nothing set has no rm, marked or not, even after answering no", async () => {
    await insertCustomer({ DB: h.d1 }, plain("plain"));
    await insertCustomer({ DB: h.d1 }, marked("marked"));
    h.db.prepare("UPDATE customers SET special_category = 0 WHERE id = 'plain'").run();
    for (const id of ["plain", "marked"]) {
      await writeVisitorBundle(h.env, id);
      expect(bundle(id)).not.toHaveProperty("rm");
    }
  });
});

describe("REMEMBER_ON_SENSITIVE, the switches endpoint", () => {
  const superadmin = { id: "u", email: "a@example.com", role: "superadmin", customer_id: null };
  const call = async (vars: Record<string, string>, body?: Record<string, unknown>) => {
    const env = { ...h.env, DASHBOARD_ORIGIN: "*", ...vars } as unknown as AdminEnv;
    const req = body
      ? new Request("https://api.test/admin/customers/direct-switches", {
          method: "POST",
          body: JSON.stringify({ customer_id: "acme", ...body }),
        })
      : new Request("https://api.test/admin/customers/direct-switches?customer_id=acme");
    const res = await handleDirectSwitches(req, env, superadmin as never);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const markAcme = (rememberOffValue: 0 | 1) =>
    h.db
      .prepare(
        "UPDATE customers SET sensitive = 1, special_category = 1, remember_off = ? WHERE id = 'acme'",
      )
      .run(rememberOffValue);
  const ON = { REMEMBER_ON_SENSITIVE: "on" };

  beforeEach(() => {
    h.customer("acme");
  });

  it('"on": a marked site is told the memory is allowed and may turn it on', async () => {
    markAcme(1);
    expect((await call(ON)).json).toMatchObject({ remember: false, remember_allowed: true });
    const on = await call(ON, { remember: true });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ remember: true, remember_allowed: true });
    expect(rememberOff("acme")).toBe(0);
    expect(JSON.parse(h.kv.get(visitorBundleKey("acme")) ?? "{}").rm).toBe(1);
  });

  it.each([{}, { REMEMBER_ON_SENSITIVE: "off" }, { REMEMBER_ON_SENSITIVE: "ON" }])(
    "%j: a marked site is told it is not allowed, and turning it on is refused",
    async (vars) => {
      markAcme(1);
      expect((await call(vars)).json).toMatchObject({ remember_allowed: false });
      const on = await call(vars, { remember: true });
      expect(on.status).toBe(409);
      expect(on.json).toEqual({ error: "Not for this site." });
      // Nothing was stored and no bundle was written for the refused request.
      expect(rememberOff("acme")).toBe(1);
      expect(h.kv.get(visitorBundleKey("acme"))).toBeUndefined();
    },
  );

  it("turning it off always works, and the other switches are not held up", async () => {
    markAcme(0);
    const off = await call({}, { remember: false, page_one: false });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ remember: false, page_one: false, remember_allowed: false });
    expect(rememberOff("acme")).toBe(1);
  });

  it("a site that is not marked is not narrowed by the var", async () => {
    for (const vars of [{}, { REMEMBER_ON_SENSITIVE: "off" }, ON]) {
      expect((await call(vars)).json).toMatchObject({ remember_allowed: true });
      expect((await call(vars, { remember: true })).status).toBe(200);
    }
  });

  it("refused wherever the memory may not run: an unanswered customer, an audit", async () => {
    for (const sql of [
      "UPDATE customers SET special_category = NULL WHERE id = 'acme'",
      "UPDATE customers SET plan = 'audit' WHERE id = 'acme'",
    ]) {
      h.db.prepare("UPDATE customers SET special_category = 0, plan = 'pilot'").run();
      h.db.prepare(sql).run();
      expect((await call(ON)).json).toMatchObject({ remember_allowed: false });
      expect((await call(ON, { remember: true })).status).toBe(409);
    }
  });
});
