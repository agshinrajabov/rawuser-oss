/**
 * Bundle parity (docs/specs/proof-engine.md, A): generation's
 * writeVisitorBundle and the edge's write-back build the same visitor
 * bundle from one database, the holdout percent `h` included.
 */
import { describe, expect, it } from "vitest";
import { writeVisitorBundle } from "../../generation/src/admin/onboard.ts";
import { makeKv, makeSqliteD1 } from "../../generation/test/admin/sqlite-d1.ts";
import { bundleFromD1 } from "../src/bundle-writeback.ts";

function seed(holdout: number | null) {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    "INSERT INTO customers (id, slug, domain, status, created_at, holdout_percent) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("acme", "acme", "acme.test", "active", 1, holdout);
  db.prepare(
    "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at) VALUES (?, ?, ?, ?, 'https://acme.test/', 1)",
  ).run(
    "acme",
    "/",
    JSON.stringify({
      "hero.headline": {
        css: ["h1"],
        text: ["Old"],
        structural: "first h1",
        metrics: { font: "x" },
      },
    }),
    1,
  );
  db.prepare(
    `INSERT INTO conversion_targets (customer_id, section_path, label, conversion_label, css_selectors, text_selectors, structural_selector, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`,
  ).run("acme", "hero.cta", "Start free", "trial_start", JSON.stringify(["a.cta"]), "[]", "a.cta");
  return d1;
}

describe("visitor bundle parity", () => {
  it.each([20, 0, 80, null])("both writers produce the same bundle at holdout %s", async (h) => {
    const d1 = seed(h);
    const kv = makeKv();
    await writeVisitorBundle({ DB: d1, VARIANTS: kv }, "acme");
    const fromGeneration = JSON.parse(kv.store.get("v1:vm:acme") ?? "null");
    const fromEdge = await bundleFromD1({ DB: d1, VARIANTS: kv }, "acme");
    expect(fromEdge).toEqual(fromGeneration);
    if (h === null) expect(fromEdge).not.toHaveProperty("h");
    else expect(fromEdge.h).toBe(Math.min(h, 50));
    expect(JSON.stringify(fromEdge)).not.toContain("metrics");
  });
});

describe("visitor bundle parity for a sensitive customer (sensitive-customers.md)", () => {
  it.each([
    ["not sensitive", 0, null],
    ["not sensitive, a list stored", 0, '["/products"]'],
    ["sensitive, no list", 1, null],
    ["sensitive with its list", 1, '["/about","/products"]'],
  ] as const)("both writers produce the same bytes: %s", async (_name, flag, list) => {
    const d1 = seed(20);
    await d1
      .prepare("UPDATE customers SET sensitive = ?, kept_sections = ? WHERE id = 'acme'")
      .bind(flag, list)
      .run();
    const kv = makeKv();
    await writeVisitorBundle({ DB: d1, VARIANTS: kv }, "acme");
    const fromGeneration = kv.store.get("v1:vm:acme") ?? "";
    const fromEdge = await bundleFromD1({ DB: d1, VARIANTS: kv }, "acme");
    // Bytes, not only values: `s` and `sk` sit in the same place either way.
    expect(JSON.stringify(fromEdge)).toBe(fromGeneration);
    if (flag === 1) {
      expect(fromEdge.s).toBe(1);
      if (list === null) expect(fromEdge).not.toHaveProperty("sk");
      else expect(fromEdge.sk).toEqual(JSON.parse(list));
    } else {
      expect(fromEdge).not.toHaveProperty("s");
      expect(fromEdge).not.toHaveProperty("sk");
    }
  });
});

describe("visitor bundle parity for ne (readiness-check.md, As approved)", () => {
  it.each([
    ["unanswered, not marked", null, 0],
    ["no, not marked", 0, 0],
    ["yes, not marked: ne", 1, 0],
    ["yes, marked: s, no ne", 1, 1],
    ["unanswered, marked (a customer created sensitive)", null, 1],
  ] as const)("both writers produce the same bytes: %s", async (_name, special, flag) => {
    const d1 = seed(20);
    await d1
      .prepare("UPDATE customers SET special_category = ?, sensitive = ? WHERE id = 'acme'")
      .bind(special, flag)
      .run();
    const kv = makeKv();
    await writeVisitorBundle({ DB: d1, VARIANTS: kv }, "acme");
    const fromGeneration = kv.store.get("v1:vm:acme") ?? "";
    const fromEdge = await bundleFromD1({ DB: d1, VARIANTS: kv }, "acme");
    expect(JSON.stringify(fromEdge)).toBe(fromGeneration);
    if (special === 1 && flag === 0) expect(fromEdge.ne).toBe(1);
    else expect(fromEdge).not.toHaveProperty("ne");
    expect(fromGeneration).not.toContain("special_category");
  });

  it("the same bytes with a group and every flag at once: g sits where generation puts it", async () => {
    const d1 = seed(20);
    await d1
      .prepare(
        "UPDATE customers SET special_category = 1, sensitive = 1, kept_sections = '[\"/products\"]' WHERE id = 'acme'",
      )
      .run();
    await d1
      .prepare(
        "INSERT INTO page_groups (customer_id, pattern, created_at) VALUES ('acme', '/products/*', 1)",
      )
      .run();
    const kv = makeKv();
    // The memory allowed on a marked site, so `rm` is in the bundle and its place is held too.
    const install = { REMEMBER_ON_SENSITIVE: "on" };
    await writeVisitorBundle({ DB: d1, VARIANTS: kv, ...install }, "acme");
    const fromEdge = await bundleFromD1({ DB: d1, VARIANTS: kv, ...install }, "acme");
    expect(JSON.stringify(fromEdge)).toBe(kv.store.get("v1:vm:acme"));
    expect(Object.keys(fromEdge)).toEqual(["v", "pages", "conv", "h", "g", "s", "sk", "rm"]);
  });
});

describe("visitor bundle parity for rm on a marked site (REMEMBER_ON_SENSITIVE)", () => {
  async function both(value: string | undefined, sensitive: 0 | 1, rememberOff: 0 | 1) {
    const d1 = seed(20);
    await d1
      .prepare(
        "UPDATE customers SET special_category = ?, sensitive = ?, remember_off = ? WHERE id = 'acme'",
      )
      .bind(sensitive, sensitive, rememberOff)
      .run();
    const kv = makeKv();
    const install = value === undefined ? {} : { REMEMBER_ON_SENSITIVE: value };
    await writeVisitorBundle({ DB: d1, VARIANTS: kv, ...install }, "acme");
    const fromEdge = await bundleFromD1({ DB: d1, VARIANTS: kv, ...install }, "acme");
    // Both writers read the same var the same way: the same bytes.
    expect(JSON.stringify(fromEdge)).toBe(kv.store.get("v1:vm:acme"));
    return fromEdge as { rm?: 1 };
  }

  it('"on": a marked site whose switch is on carries rm, from both writers', async () => {
    expect((await both("on", 1, 0)).rm).toBe(1);
    expect(await both("on", 1, 1)).not.toHaveProperty("rm");
  });

  it.each([undefined, "", "off", "ON", "true"])(
    "%j: a marked site carries no rm, whatever its switch says",
    async (value) => {
      expect(await both(value, 1, 0)).not.toHaveProperty("rm");
      expect(await both(value, 1, 1)).not.toHaveProperty("rm");
    },
  );

  it.each([undefined, "off", "on"])(
    "%j: a site that is not marked follows its own switch",
    async (value) => {
      expect((await both(value, 0, 0)).rm).toBe(1);
      expect(await both(value, 0, 1)).not.toHaveProperty("rm");
    },
  );
});

describe("visitor bundle parity for co (ADR 0036, the country switch)", () => {
  it.each([0, 1])("both writers produce the same bytes, country_off=%s", async (off) => {
    const d1 = seed(20);
    await d1
      .prepare(
        "UPDATE customers SET country_off = ?, special_category = 1, sensitive = 0 WHERE id = 'acme'",
      )
      .bind(off)
      .run();
    const kv = makeKv();
    await writeVisitorBundle({ DB: d1, VARIANTS: kv }, "acme");
    const fromEdge = await bundleFromD1({ DB: d1, VARIANTS: kv }, "acme");
    expect(JSON.stringify(fromEdge)).toBe(kv.store.get("v1:vm:acme"));
    if (off === 1) {
      expect(fromEdge.co).toBe(1);
      // After `ne`, before `kl`: the same place in both writers.
      expect(Object.keys(fromEdge).slice(-2)).toEqual(["ne", "co"]);
    } else {
      expect(fromEdge).not.toHaveProperty("co");
    }
    expect(kv.store.get("v1:vm:acme")).not.toContain("country");
  });
});

describe("visitor bundle parity with the site map (site-shaped intents §5)", () => {
  it.each([0, 1])("both writers produce the same pm and sd, off=%s", async (off) => {
    const { d1, db } = makeSqliteD1();
    db.prepare(
      "INSERT INTO customers (id, slug, domain, status, created_at, served_intents, site_map_off) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "acme",
      "acme",
      "acme.test",
      "active",
      1,
      JSON.stringify(["evaluation", "feature", "problem", "brand"]),
      off,
    );
    const ins = db.prepare(
      "INSERT INTO site_paths (customer_id, path, lang, kind, confidence, label, found_on, first_seen_at, last_seen_at) VALUES (?, ?, 'en', ?, ?, ?, '/', 1, 1)",
    );
    ins.run("acme", "/work", "proof", "high", "Work");
    ins.run("acme", "/insights", "learn", "model", null);
    ins.run("acme", "/pricing", "none", "operator", null);
    const kv = makeKv();
    await writeVisitorBundle({ DB: d1, VARIANTS: kv }, "acme");
    const fromGeneration = JSON.parse(kv.store.get("v1:vm:acme") ?? "null");
    const fromEdge = await bundleFromD1({ DB: d1, VARIANTS: kv }, "acme");
    expect(fromEdge).toEqual(fromGeneration);
    if (off === 1) {
      expect(fromEdge).not.toHaveProperty("pm");
      expect(fromEdge).not.toHaveProperty("sd");
    } else {
      expect(fromEdge.pm).toEqual({
        "/insights": ["learn", 0.75],
        "/pricing": ["none", 1],
        "/work": ["proof", 1],
      });
      expect(fromEdge.sd).toEqual(["evaluation", "feature", "problem", "brand"]);
      // Paths and kinds only: never a link text.
      expect(JSON.stringify(fromEdge)).not.toContain('"Work"');
    }
  });

  it("the database refuses a rules or model none row (privacy review condition 2)", () => {
    const { db } = makeSqliteD1();
    db.prepare(
      "INSERT INTO customers (id, slug, domain, status, created_at) VALUES ('acme', 'acme', 'acme.test', 'active', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO site_paths (customer_id, path, kind, confidence, found_on, first_seen_at, last_seen_at) VALUES ('acme', '/x', 'none', 'model', '/', 1, 1)",
        )
        .run(),
    ).toThrow();
  });

  it("the rows go with the customer (the per-customer delete)", () => {
    const { db } = makeSqliteD1();
    db.prepare(
      "INSERT INTO customers (id, slug, domain, status, created_at) VALUES ('acme', 'acme', 'acme.test', 'active', 1)",
    ).run();
    db.prepare(
      "INSERT INTO site_paths (customer_id, path, kind, confidence, found_on, first_seen_at, last_seen_at) VALUES ('acme', '/work', 'proof', 'high', '/', 1, 1)",
    ).run();
    db.prepare("DELETE FROM customers WHERE id = 'acme'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM site_paths").get()).toEqual({ n: 0 });
  });
});

describe("visitor bundle parity for the direct fields (direct-visitors.md §6)", () => {
  it.each([
    ["answered no, all on", 0, 0, 0],
    ["answered no, page one off", 0, 1, 0],
    ["unanswered", null, 0, 0],
    ["sensitive", 0, 0, 1],
  ] as const)(
    "both writers produce the same bytes: %s",
    async (_n, special, pageOneOff, sensitive) => {
      const d1 = seed(20);
      await d1
        .prepare(
          "UPDATE customers SET special_category = ?, page_one_off = ?, sensitive = ? WHERE id = 'acme'",
        )
        .bind(special, pageOneOff, sensitive)
        .run();
      const kv = makeKv();
      await writeVisitorBundle({ DB: d1, VARIANTS: kv }, "acme");
      const fromEdge = await bundleFromD1({ DB: d1, VARIANTS: kv }, "acme");
      expect(JSON.stringify(fromEdge)).toBe(kv.store.get("v1:vm:acme"));
      if (special === 0 && pageOneOff === 0 && sensitive === 0) expect(fromEdge.dp).toBe(1);
      else expect(fromEdge).not.toHaveProperty("dp");
    },
  );
});

describe("visitor bundle parity for mk and dl (direct-visitors.md §3, §5)", () => {
  it.each([0, 1])("both writers produce the same bytes, learned_default_off=%s", async (off) => {
    const d1 = seed(20);
    await d1
      .prepare(
        "UPDATE customers SET special_category = 0, markets = '[\"GB\",\"DE\"]', learned_default_off = ? WHERE id = 'acme'",
      )
      .bind(off)
      .run();
    for (const [set, at, w] of [
      ["old", 1, '[["none",500],["feature",500]]'],
      ["new", 2, '[["none",300],["feature",700]]'],
    ] as const) {
      await d1
        .prepare(
          "INSERT INTO learned_weights (customer_id, set_id, page_path, weights, counts, computed_at, live_from) VALUES ('acme', ?, '/', ?, '[]', ?, ?)",
        )
        .bind(set, w, at, at)
        .run();
    }
    const kv = makeKv();
    await writeVisitorBundle({ DB: d1, VARIANTS: kv }, "acme");
    const fromEdge = await bundleFromD1({ DB: d1, VARIANTS: kv }, "acme");
    expect(JSON.stringify(fromEdge)).toBe(kv.store.get("v1:vm:acme"));
    expect(fromEdge.mk).toEqual(["GB", "DE"]);
    if (off === 1) expect(fromEdge).not.toHaveProperty("dl");
    else
      expect(fromEdge.dl).toEqual({
        s: "new",
        w: {
          "/": [
            ["none", 300],
            ["feature", 700],
          ],
        },
      });
  });
});
