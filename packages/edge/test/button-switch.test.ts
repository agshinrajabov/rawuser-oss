/**
 * The button switch in what a visitor's browser is given (docs/specs/
 * button-rewrite.md; pilot-gaps.md, "Left for the edge").
 *
 * A button whose rewrite the operator has not turned on is not a target on
 * /select and not in the page copy /carry hands out, whoever wrote the
 * bundle and also when KV has none; a button that is on is in both; a
 * counted button is counted whatever its switch says. /carry and /select
 * read the same bundle, so they name the same parts.
 *
 * The database is a real SQLite with every migration, so the edge's own SQL
 * runs; the KV parses JSON reads the way Workers KV does.
 */
import { visitorBundleKey } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { writeVisitorBundle } from "../../generation/src/admin/onboard.ts";
import { makeKv, makeSqliteD1 } from "../../generation/test/admin/sqlite-d1.ts";
import { BUNDLE_FALLBACK_TTL_S } from "../src/bundle-writeback.ts";
import worker from "../src/index.ts";

const part = (css: string, extra: Record<string, unknown> = {}) => ({
  css: [css],
  text: [],
  structural: css,
  ...extra,
});

/** The stored manifest of `/`: the hero button off (and counted), the closing button on. */
const STORED = {
  "hero.headline": part("h1", { metrics: { v: 1 } }),
  "hero.cta.label": part("a.hero"),
  "hero.cta.href": part("a.hero"),
  "cta.cta.label": part("a.closing", { rewrite: true }),
  "cta.cta.href": part("a.closing"),
  "forms.submit_label": part("form button", { rewrite: false }),
};
const WRITTEN = ["hero.headline", "cta.cta.label", "cta.cta.href"];

/** A version written before the switch: it still carries a label for the hero button. */
const VERSION = {
  customer_id: "acme",
  profile_key: "intent:problem",
  generated_at: 1,
  prompt_hash: "h",
  body_id: "0123456789abcdef",
  sections: {
    hero: {
      kind: "hero",
      headline: "A headline for this visit",
      cta: { label: "Tell us your problem", href: "/contact" },
    },
    cta: { kind: "cta", cta: { label: "See how it works" } },
  },
};

const COUNTED = {
  section_path: "hero.cta",
  conversion_label: "trial_start",
  css: ["a.hero"],
  text: [],
  structural: "a.hero",
};

function setup() {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    "INSERT INTO customers (id, slug, domain, status, created_at) VALUES ('acme', 'acme', 'acme.test', 'active', 1)",
  ).run();
  const manifest = db.prepare(
    "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at) VALUES ('acme', ?, ?, 1, 'https://acme.test/', 1)",
  );
  manifest.run("/", JSON.stringify(STORED));
  manifest.run(
    "/pricing",
    JSON.stringify({
      "hero.headline": part("h1"),
      "pricing.cta.label": part("a.buy", { rewrite: true }),
    }),
  );
  db.prepare(
    `INSERT INTO conversion_targets (customer_id, section_path, label, conversion_label, css_selectors, text_selectors, structural_selector, enabled, created_at, updated_at)
     VALUES ('acme', 'hero.cta', 'Start free', 'trial_start', ?, '[]', 'a.hero', 1, 1, 1)`,
  ).run(JSON.stringify(["a.hero"]));

  const sqls: string[] = [];
  const DB = {
    prepare(sql: string) {
      sqls.push(sql);
      return d1.prepare(sql);
    },
  } as unknown as D1Database;

  const store = new Map<string, string>();
  const puts: Array<{ key: string; ttl: number | undefined }> = [];
  const VARIANTS = {
    async get(key: string, opts?: string | { type?: string }) {
      const raw = key.startsWith("v1:variant:acme")
        ? JSON.stringify(VERSION)
        : (store.get(key) ?? null);
      if (raw === null) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      puts.push({ key, ttl: opts?.expirationTtl });
      store.set(key, value);
    },
    async delete() {},
  } as unknown as KVNamespace;

  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => waits.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const env = { VARIANTS, DB, ENVIRONMENT: "test", PREVIEW_TOKEN: "", HOLDOUT_PERCENT: "0" };

  async function select(path = "/") {
    const res = await worker.fetch(
      new Request(
        `https://edge.test/select?customer_id=acme&path=${encodeURIComponent(path)}&utm_source=chatgpt.com`,
        { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140" } },
      ),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    const text = await res.text();
    return { text, body: JSON.parse(text) as Record<string, unknown> & { targets?: object } };
  }

  async function carry() {
    const res = await worker.fetch(
      new Request("https://edge.test/carry?customer_id=acme&carry=problem:ai"),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    const text = await res.text();
    const bodies = (JSON.parse(text) as { bodies: Record<string, { targets: object }> }).bodies;
    return { text, bodies, cache: res.headers.get("cache-control") };
  }

  /** The bundle as generation's writeVisitorBundle writes it today, into this KV. */
  async function generationWrites() {
    const kv = makeKv();
    await writeVisitorBundle({ DB: d1, VARIANTS: kv }, "acme");
    store.set(visitorBundleKey("acme"), kv.store.get(visitorBundleKey("acme")) ?? "");
  }

  const storedBundle = () => JSON.parse(store.get(visitorBundleKey("acme")) ?? "null");
  const storedManifest = () =>
    JSON.parse(
      (
        db
          .prepare(
            "SELECT manifest FROM element_manifests WHERE customer_id = 'acme' AND page_path = '/'",
          )
          .get() as { manifest: string }
      ).manifest,
    );

  return { select, carry, generationWrites, store, puts, sqls, storedBundle, storedManifest, db };
}

describe("/select: a button that is off is not a target", () => {
  it("from the bundle generation writes: the on button and the headline, nothing else", async () => {
    const t = setup();
    await t.generationWrites();
    const { body, text } = await t.select();
    expect(body.source).toBe("kv");
    expect(Object.keys(body.targets ?? {})).toEqual(WRITTEN);
    // The switch is an operator setting, the measurement generation's: neither is sent.
    expect(text).not.toContain("rewrite");
    expect(text).not.toContain("metrics");
    // The counted button is off and still counted.
    expect(body.conversion_targets).toEqual([COUNTED]);
    // The visitor path read no database.
    expect(t.sqls).toEqual([]);
  });

  it("from a bundle the generation worker live today wrote (rewrite: true still on the entry): the switch is not sent", async () => {
    const t = setup();
    t.store.set(
      visitorBundleKey("acme"),
      JSON.stringify({
        v: 1,
        pages: {
          "/": {
            "hero.headline": part("h1"),
            "cta.cta.label": part("a.closing", { rewrite: true }),
            "cta.cta.href": part("a.closing"),
          },
        },
        conv: [COUNTED],
      }),
    );
    const { body, text } = await t.select();
    expect(Object.keys(body.targets ?? {})).toEqual(WRITTEN);
    expect((body.targets as Record<string, unknown>)["cta.cta.label"]).toEqual(part("a.closing"));
    expect(text).not.toContain("rewrite");
    expect(t.sqls).toEqual([]);
  });

  it("with no bundle in KV: the database answers with the same parts, and the bundle written back has no off button", async () => {
    const t = setup();
    const { body, text } = await t.select();
    expect(body.source).toBe("kv");
    expect(Object.keys(body.targets ?? {})).toEqual(WRITTEN);
    expect(text).not.toContain("rewrite");
    expect(text).not.toContain("metrics");
    expect(body.conversion_targets).toEqual([COUNTED]);

    // Written back for the next visit, for a day, as the shared builder builds it.
    expect(t.puts).toEqual([{ key: visitorBundleKey("acme"), ttl: BUNDLE_FALLBACK_TTL_S }]);
    const written = t.storedBundle();
    expect(Object.keys(written.pages["/"])).toEqual(WRITTEN);
    expect(Object.keys(written.pages["/pricing"])).toEqual(["hero.headline", "pricing.cta.label"]);
    expect(written.conv).toEqual([COUNTED]);
    expect(JSON.stringify(written)).not.toContain("rewrite");

    // And it is the bundle generation would have written.
    const edgeWrote = t.store.get(visitorBundleKey("acme"));
    await t.generationWrites();
    expect(JSON.parse(t.store.get(visitorBundleKey("acme")) ?? "null")).toEqual(
      JSON.parse(edgeWrote ?? "null"),
    );

    // The next visit answers from it, the same parts, no database.
    t.sqls.length = 0;
    const next = await t.select();
    expect(next.body.targets).toEqual(body.targets);
    expect(t.sqls).toEqual([]);

    // The stored manifest was read, never changed.
    expect(t.storedManifest()).toEqual(STORED);
  });

  it("a page that borrows the root's manifest borrows it without the off button too", async () => {
    const t = setup();
    const { body } = await t.select("/about");
    expect(Object.keys(body.targets ?? {})).toEqual(WRITTEN);
    expect(body.carryable).toBeUndefined();
  });

  it("turned on, the button is a target on the next bundle", async () => {
    const t = setup();
    t.db
      .prepare(
        `UPDATE element_manifests SET manifest = json_set(manifest, '$."hero.cta.label".rewrite', json('true')) WHERE customer_id = 'acme' AND page_path = '/'`,
      )
      .run();
    const { body } = await t.select();
    expect(Object.keys(body.targets ?? {})).toEqual([
      "hero.headline",
      "hero.cta.label",
      "hero.cta.href",
      "cta.cta.label",
      "cta.cta.href",
    ]);
  });
});

describe("/carry reads the bundle /select reads", () => {
  it("an off button is not in the page copy's targets, an on button is, and no database is read", async () => {
    const t = setup();
    await t.generationWrites();
    const { bodies, text, cache } = await t.carry();
    expect(Object.keys(bodies).sort()).toEqual(["/", "/pricing"]);
    expect(Object.keys(bodies["/"]?.targets ?? {})).toEqual(WRITTEN);
    expect(Object.keys(bodies["/pricing"]?.targets ?? {})).toEqual([
      "hero.headline",
      "pricing.cta.label",
    ]);
    expect(text).not.toContain("rewrite");
    expect(text).not.toContain("metrics");
    expect(cache).toBe("public, max-age=300");
    // Until 2026-10-12 this was a read of element_manifests on every answer.
    expect(t.sqls).toEqual([]);
    expect(t.puts).toEqual([]);
  });

  it("names the same parts as /select for the page, key for key", async () => {
    const t = setup();
    await t.generationWrites();
    const selected = await t.select();
    const carried = await t.carry();
    expect(carried.bodies["/"]?.targets).toEqual(selected.body.targets);
    const priced = await t.select("/pricing");
    expect(carried.bodies["/pricing"]?.targets).toEqual(priced.body.targets);
  });

  it("follows the bundle when the database says otherwise (a button turned off in the bundle first)", async () => {
    // What made a carried return keep a button's original label on
    // 2026-10-12: the bundle had the button off, the database still on, and
    // /carry read the database.
    const t = setup();
    await t.generationWrites();
    const bundle = t.storedBundle();
    const { "cta.cta.label": _label, "cta.cta.href": _href, ...rest } = bundle.pages["/"];
    t.store.set(visitorBundleKey("acme"), JSON.stringify({ ...bundle, pages: { "/": rest } }));
    expect(t.storedManifest()["cta.cta.label"].rewrite).toBe(true);

    const selected = await t.select();
    const carried = await t.carry();
    expect(Object.keys(selected.body.targets ?? {})).toEqual(["hero.headline"]);
    expect(carried.bodies["/"]?.targets).toEqual(selected.body.targets);
    // Only the pages the bundle lists are handed out.
    expect(Object.keys(carried.bodies)).toEqual(["/"]);
    expect(t.sqls).toEqual([]);
  });

  it("with no bundle in KV: built from the database with the same rule, and written back", async () => {
    const t = setup();
    const { bodies, text } = await t.carry();
    expect(Object.keys(bodies["/"]?.targets ?? {})).toEqual(WRITTEN);
    expect(text).not.toContain("rewrite");
    expect(t.sqls.length).toBeGreaterThan(0);
    expect(t.puts).toEqual([{ key: visitorBundleKey("acme"), ttl: BUNDLE_FALLBACK_TTL_S }]);
    expect(Object.keys(t.storedBundle().pages["/"])).toEqual(WRITTEN);
    // The next one finds the bundle and reads no database.
    t.sqls.length = 0;
    const again = await t.carry();
    expect(again.bodies).toEqual(bodies);
    expect(t.sqls).toEqual([]);
  });

  it("a bundle page that is not a manifest is skipped, the others stand", async () => {
    const t = setup();
    await t.generationWrites();
    const bundle = t.storedBundle();
    t.store.set(
      visitorBundleKey("acme"),
      JSON.stringify({ ...bundle, pages: { ...bundle.pages, "/pricing": null, "/x": 7 } }),
    );
    const { bodies } = await t.carry();
    expect(Object.keys(bodies["/"]?.targets ?? {})).toEqual(WRITTEN);
    expect(bodies["/pricing"]).toBeUndefined();
    expect(bodies["/x"]).toBeUndefined();
    // A bundle with no pages at all hands out nothing and does not throw.
    t.store.set(visitorBundleKey("acme"), JSON.stringify({ v: 1, conv: [] }));
    expect((await t.carry()).bodies).toEqual({});
  });

  // The words themselves: until 2026-10-12 the version went out as stored
  // and only the targets said what is written. A page that tags its own
  // button was then written whatever the targets said (the lab, 9 of 9
  // loads), so the words of an off button are left out too:
  // test/off-button-words.test.ts.
});
