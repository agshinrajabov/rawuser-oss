/**
 * Keyword intent at the edge (docs/specs/keyword-intent.md §3.4;
 * privacy review, section 9 condition 1 and section 10 condition 10).
 *
 * - `utm_term` reaches the edge and is gone from the signals before the
 *   classifier runs, whatever the bundle says.
 * - With the customer's lexicon (`kl`) the classifier gets only the intent
 *   word it chose; without one (none, off, sensitive, `ne`: the writers
 *   leave `kl` out) nothing about the keyword reaches it.
 * - The keyword is in no D1 statement, KV write, console line or answer;
 *   `kl` is in no /select answer and no /s/{id}.js.
 * - The edge's bundle write-back sets `kl` with the shared helper, last,
 *   and tolerates a database before migration 0045.
 */

import {
  INTENT_DIMENSIONS,
  SOURCE_DIMENSIONS,
  type Signals,
  hideRulesKey,
  variantKey,
  visitorBundleKey,
} from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeVisitorBundle } from "../../generation/src/admin/onboard.ts";
import { makeKv, makeSqliteD1 } from "../../generation/test/admin/sqlite-d1.ts";
import { bundleFromD1 } from "../src/bundle-writeback.ts";
import { resetEventGuardForTests } from "../src/event.ts";
import worker from "../src/index.ts";

/** What the classifier and the extractor saw, per call. */
const seen = vi.hoisted(() => ({
  classified: [] as Signals[],
  extractedTerms: [] as Array<string | undefined>,
}));

vi.mock("@rawuser/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rawuser/shared")>();
  return {
    ...actual,
    extractSignals: (...args: Parameters<typeof actual.extractSignals>) => {
      const s = actual.extractSignals(...args);
      seen.extractedTerms.push(s.utm.term);
      return s;
    },
    classify: (...args: Parameters<typeof actual.classify>) => {
      seen.classified.push(structuredClone(args[0]));
      return actual.classify(...args);
    },
  };
});

/** A word that appears only in the ad keyword: any trace of it is a leak. */
const SECRET = "qzxvsecret";
/** A phrase that appears only in the lexicon: any trace of it in a browser's answer is a leak. */
const KL_ONLY = "klonlyphrase";
const KEYWORD = `pricing for ${SECRET} agencies`;
const LEXICON = { pricing: ["pricing", KL_ONLY], competitor: ["hubspot"] };
const AD = `utm_source=google&utm_medium=cpc&utm_term=${encodeURIComponent(KEYWORD)}&clk=gclid`;
const AD_NO_TERM = "utm_source=google&utm_medium=cpc&clk=gclid";

const STUB = {
  customer_id: "demo",
  profile_key: "x",
  sections: { hero: { kind: "hero", headline: "H" } },
  generated_at: 0,
  prompt_hash: "p",
};

/** Every cell has a version, so the selection alone decides the answer. */
function versions(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const i of INTENT_DIMENSIONS) {
    for (const s of [...SOURCE_DIMENSIONS, "default"]) out[variantKey("demo", i, s)] = STUB;
  }
  return out;
}

interface Recorded {
  sql: string[];
  binds: unknown[][];
  puts: Array<{ key: string; value: string }>;
  waits: Promise<unknown>[];
  logs: string[];
}

function harness(bundle: unknown, flags: Record<string, string> = {}) {
  const rec: Recorded = { sql: [], binds: [], puts: [], waits: [], logs: [] };
  const data: Record<string, unknown> = { ...versions() };
  if (bundle !== undefined) data[visitorBundleKey("demo")] = bundle;
  const kv = {
    async get(key: string, opts?: unknown) {
      const v = data[key];
      if (v === undefined) return null;
      const type = typeof opts === "string" ? opts : (opts as { type?: string } | undefined)?.type;
      return type === "json" ? v : typeof v === "string" ? v : JSON.stringify(v);
    },
    async put(key: string, value: string) {
      rec.puts.push({ key, value: String(value) });
    },
    async delete() {},
  } as unknown as KVNamespace;
  const stmt = (sql: string) => ({
    bind: (...args: unknown[]) => {
      rec.binds.push(args);
      return {
        run: async () => ({ success: true, meta: {} }),
        first: async () => null,
        all: async () => ({ results: [] }),
      };
    },
  });
  const db = {
    prepare: (sql: string) => {
      rec.sql.push(sql);
      return stmt(sql);
    },
    batch: async (s: unknown[]) => s.map(() => ({ success: true })),
  } as unknown as D1Database;
  const env = {
    VARIANTS: kv,
    DB: db,
    ENVIRONMENT: "test",
    PREVIEW_TOKEN: "",
    HOLDOUT_PERCENT: "0",
    ...flags,
  };
  const ctx = {
    waitUntil: (p: Promise<unknown>) => rec.waits.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { env, ctx, rec };
}

const PLAIN = { v: 1, pages: {}, conv: [], h: 0 };
const WITH_KL = { ...PLAIN, kl: LEXICON };

async function select(query: string, bundle: unknown, flags: Record<string, string> = {}) {
  const h = harness(bundle, flags);
  const res = await worker.fetch(
    new Request(`https://edge.test/select?customer_id=demo&path=%2F&${query}`, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15" },
    }),
    h.env as never,
    h.ctx,
  );
  const text = await res.text();
  await Promise.all(h.rec.waits);
  return { body: JSON.parse(text) as Record<string, unknown>, text, rec: h.rec, h };
}

const intentOf = (b: Record<string, unknown>) =>
  (b.selection as { intent_dim?: string } | undefined)?.intent_dim;

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
let logged: string[] = [];

beforeEach(() => {
  seen.classified.length = 0;
  seen.extractedTerms.length = 0;
  logged = [];
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    }),
  );
  resetEventGuardForTests();
});
afterEach(() => {
  for (const s of consoleSpies) s.mockRestore();
});

/** Nothing the edge did holds the keyword. */
function expectNoKeyword(text: string, rec: Recorded) {
  expect(text).not.toContain(SECRET);
  expect(JSON.stringify(rec.binds)).not.toContain(SECRET);
  expect(rec.sql.join("\n")).not.toContain(SECRET);
  expect(JSON.stringify(rec.puts)).not.toContain(SECRET);
  expect(logged.join("\n")).not.toContain(SECRET);
}

describe("/select: utm_term is gone before the classifier, with or without a lexicon", () => {
  it.each([
    ["no kl", PLAIN],
    ["sensitive (the writers leave kl out)", { ...PLAIN, s: 1 }],
    ["ne (the writers leave kl out)", { ...PLAIN, ne: 1 }],
    // A writer that kept kl anyway: the edge refuses it on its own.
    ["sensitive with kl", { ...PLAIN, s: 1, kl: LEXICON }],
    ["ne with kl", { ...PLAIN, ne: 1, kl: LEXICON }],
    ["a bundle of another version", { v: 2, pages: {}, conv: [], kl: LEXICON }],
    ["no bundle at all", undefined],
  ] as const)("%s: dropped unread, the answer as without the keyword", async (_n, bundle) => {
    const withTerm = await select(AD, bundle);
    // The keyword did reach the edge: the extractor read it.
    expect(seen.extractedTerms).toContain(KEYWORD);
    expect(seen.classified.length).toBeGreaterThan(0);
    for (const s of seen.classified) {
      expect(s.utm).not.toHaveProperty("term");
      expect(s.keywordIntent ?? null).toBeNull();
    }
    expectNoKeyword(withTerm.text, withTerm.rec);
    const without = await select(AD_NO_TERM, bundle);
    expect(withTerm.body.selection).toEqual(without.body.selection);
    expect(withTerm.body.variant_key).toEqual(without.body.variant_key);
  });

  it("with kl: the classifier gets the intent word only, the term is gone", async () => {
    const r = await select(AD, WITH_KL);
    expect(seen.extractedTerms).toContain(KEYWORD);
    const last = seen.classified.at(-1);
    expect(last?.keywordIntent).toBe("pricing");
    for (const s of seen.classified) expect(s.utm).not.toHaveProperty("term");
    expect(intentOf(r.body)).toBe("pricing");
    expect(r.body.variant_key).toBe(variantKey("demo", "pricing", "paid"));
    expectNoKeyword(r.text, r.rec);
  });

  it("with kl and the same ad without a keyword: the intent the campaign gives, not pricing", async () => {
    const r = await select(AD_NO_TERM, WITH_KL);
    expect(intentOf(r.body)).not.toBe("pricing");
  });

  it("with kl and a keyword the lexicon does not hold: nothing changes", async () => {
    const other = AD.replace(encodeURIComponent(KEYWORD), encodeURIComponent(`${SECRET} shoes`));
    const r = await select(other, WITH_KL);
    const plain = await select(AD_NO_TERM, WITH_KL);
    expect(r.body.selection).toEqual(plain.body.selection);
    for (const s of seen.classified) {
      expect(s.utm).not.toHaveProperty("term");
      expect(s.keywordIntent ?? null).toBeNull();
    }
    expectNoKeyword(r.text, r.rec);
  });

  it("a malformed kl chooses nothing and the visit is still answered", async () => {
    const r = await select(AD, { ...PLAIN, kl: { pricing: [1, null, { a: 1 }] } });
    expect(r.body.variant).not.toBeNull();
    expectNoKeyword(r.text, r.rec);
  });

  it("a link tagged with utm_term alone is still a tagged link: the gate and the bit as before", async () => {
    const termOnly = `utm_term=${encodeURIComponent(`${SECRET} shoes`)}`;
    for (const bundle of [PLAIN, WITH_KL]) {
      const r = await select(termOnly, bundle);
      expect(r.body.cohort).toBe("personalized");
      expect(r.body.tagged).toBe(true);
      expectNoKeyword(r.text, r.rec);
    }
    // And the keyword alone chooses the intent when the lexicon holds it.
    const matched = await select(`utm_term=${encodeURIComponent(KEYWORD)}`, WITH_KL);
    expect(intentOf(matched.body)).toBe("pricing");
  });

  it("kl is in no /select answer", async () => {
    for (const q of [AD, AD_NO_TERM, "", `${AD}&visit=${"a".repeat(32)}`]) {
      const r = await select(q, WITH_KL);
      expect(r.text).not.toContain('"kl"');
      expect(r.text).not.toContain(KL_ONLY);
      expect(r.text).not.toContain("hubspot");
    }
    // The held-out answer too.
    for (let i = 0; i < 32; i++) {
      const visit = i.toString(16).padStart(32, "0");
      const r = await select(`${AD}&visit=${visit}`, { ...WITH_KL, h: 50 });
      expect(r.text).not.toContain(KL_ONLY);
      expect(r.text).not.toContain(SECRET);
    }
  });
});

describe("the keyword in no D1 row, KV value or log line", () => {
  it("both learning counters on, an unknown utm_source: signal_token_counts never gets the keyword", async () => {
    const q = `utm_source=${SECRET.slice(0, 4)}newsletter&utm_medium=zzmedium&utm_term=${encodeURIComponent(KEYWORD)}`;
    for (const bundle of [PLAIN, WITH_KL]) {
      const r = await select(q, bundle, { SOURCE_LEARNING: "on", UA_TOKEN_LEARNING: "on" });
      // The counter did run (the test would prove nothing otherwise).
      expect(r.rec.sql.some((s) => s.includes("signal_token_counts"))).toBe(true);
      expectNoKeyword(r.text, r.rec);
    }
  });

  it("no bundle in KV: the write-back writes no keyword", async () => {
    const r = await select(AD, undefined);
    expect(r.rec.puts.some((p) => p.key === visitorBundleKey("demo"))).toBe(true);
    expectNoKeyword(r.text, r.rec);
  });

  it("the visit's event row holds the intent word, never the keyword", async () => {
    const r = await select(AD, WITH_KL);
    const h = harness(WITH_KL);
    const sel = r.body.selection as { intent_dim: string; source_dim: string };
    const res = await worker.fetch(
      new Request("https://edge.test/event?cid=demo", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({
          event_type: "variant_shown",
          page_path: "/",
          variant_key: r.body.variant_key,
          intent_dim: sel.intent_dim,
          source_dim: sel.source_dim,
        }),
      }),
      h.env as never,
      h.ctx,
    );
    expect(res.status).toBe(202);
    await Promise.all(h.rec.waits);
    expect(h.rec.sql.some((s) => s.startsWith("INSERT INTO events"))).toBe(true);
    expect(JSON.stringify(h.rec.binds)).toContain("pricing");
    expectNoKeyword("", h.rec);
  });
});

describe("/s/{id}.js: nt when the edge does not read the keyword, kl never", () => {
  async function script(bundle: unknown) {
    const h = harness(bundle);
    const kv = h.env.VARIANTS;
    const wrapped = {
      ...kv,
      get: (key: string, opts?: unknown) =>
        key === hideRulesKey("demo")
          ? Promise.resolve('{"/":["h1"]}')
          : (kv.get as (k: string, o?: unknown) => Promise<unknown>)(key, opts),
    } as unknown as KVNamespace;
    const res = await worker.fetch(
      new Request("https://edge.test/s/demo.js"),
      { ...h.env, VARIANTS: wrapped } as never,
      h.ctx,
    );
    const body = await res.text();
    const cfg = JSON.parse(body.slice("window.__rw=".length, body.indexOf(";\n"))) as Record<
      string,
      unknown
    >;
    return { body, cfg };
  }

  it.each([
    ["no kl", PLAIN],
    ["sensitive, no kl", { ...PLAIN, s: 1 }],
    ["ne, no kl", { ...PLAIN, ne: 1 }],
    ["an empty kl", { ...PLAIN, kl: {} }],
    ["no bundle", undefined],
  ] as const)("%s: nt 1", async (_n, bundle) => {
    const { cfg, body } = await script(bundle);
    expect(cfg.nt).toBe(1);
    expect(body).not.toContain('"kl"');
  });

  it("with kl: no nt, and nothing of the lexicon", async () => {
    const { cfg, body } = await script(WITH_KL);
    expect(cfg).not.toHaveProperty("nt");
    expect(cfg).not.toHaveProperty("kl");
    expect(body).not.toContain(KL_ONLY);
    expect(body).not.toContain("hubspot");
    expect(body).not.toContain('"kl"');
  });
});

// ---------------------------------------------------------------------------
// The bundle write-back (bundle-writeback.ts)
// ---------------------------------------------------------------------------

function seedSqlite(withColumns: boolean) {
  const { d1, db } = makeSqliteD1();
  const cols = (db.prepare("PRAGMA table_info(customers)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  if (withColumns) {
    if (!cols.includes("keyword_lexicon"))
      db.exec("ALTER TABLE customers ADD COLUMN keyword_lexicon TEXT");
    if (!cols.includes("keyword_lexicon_at"))
      db.exec("ALTER TABLE customers ADD COLUMN keyword_lexicon_at INTEGER");
    if (!cols.includes("keyword_off"))
      db.exec("ALTER TABLE customers ADD COLUMN keyword_off INTEGER NOT NULL DEFAULT 0");
  } else {
    // The database as it was before migration 0045.
    for (const c of ["keyword_lexicon", "keyword_lexicon_at", "keyword_off"])
      if (cols.includes(c)) db.exec(`ALTER TABLE customers DROP COLUMN ${c}`);
  }
  db.prepare(
    "INSERT INTO customers (id, slug, domain, status, created_at, holdout_percent) VALUES ('acme', 'acme', 'acme.test', 'active', 1, 20)",
  ).run();
  db.prepare(
    "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at) VALUES ('acme', '/', ?, 1, 'https://acme.test/', 1)",
  ).run(JSON.stringify({ "hero.headline": { css: ["h1"], text: ["Old"], structural: "h1" } }));
  return { d1, db };
}

describe("the edge's bundle write-back sets kl with the shared helper", () => {
  const STORED = JSON.stringify({ pricing: ["crm pricing"], brand: ["never"], nope: ["x"] });

  it("a lexicon, not off, not sensitive, no special-category yes: kl, the last key", async () => {
    const { d1, db } = seedSqlite(true);
    db.prepare(
      "UPDATE customers SET keyword_lexicon = ?, special_category = 0 WHERE id = 'acme'",
    ).run(STORED);
    const b = await bundleFromD1({ DB: d1, VARIANTS: makeKv() }, "acme");
    expect(b.kl).toEqual({ pricing: ["crm pricing"] });
    expect(Object.keys(b).at(-1)).toBe("kl");
  });

  it.each([
    ["off", "keyword_off = 1"],
    ["sensitive", "sensitive = 1"],
    ["a special-category yes", "special_category = 1"],
    ["no lexicon", "keyword_lexicon = NULL"],
    ["a lexicon that does not parse", "keyword_lexicon = 'not json'"],
  ])("%s: no kl", async (_n, set) => {
    const { d1, db } = seedSqlite(true);
    db.prepare("UPDATE customers SET keyword_lexicon = ? WHERE id = 'acme'").run(STORED);
    db.exec(`UPDATE customers SET ${set} WHERE id = 'acme'`);
    const b = await bundleFromD1({ DB: d1, VARIANTS: makeKv() }, "acme");
    expect(b).not.toHaveProperty("kl");
  });

  it.each([
    ["with a lexicon", null],
    ["off", "keyword_off = 1"],
    ["sensitive", "sensitive = 1"],
  ])("the same bytes as generation's writer: %s", async (_n, set) => {
    const { d1, db } = seedSqlite(true);
    db.prepare("UPDATE customers SET keyword_lexicon = ? WHERE id = 'acme'").run(STORED);
    if (set) db.exec(`UPDATE customers SET ${set} WHERE id = 'acme'`);
    const kv = makeKv();
    await writeVisitorBundle({ DB: d1, VARIANTS: kv }, "acme");
    const fromEdge = await bundleFromD1({ DB: d1, VARIANTS: kv }, "acme");
    expect(JSON.stringify(fromEdge)).toBe(kv.store.get("v1:vm:acme"));
  });

  it("before migration 0045 (no such columns): the bundle without kl, no error", async () => {
    const { d1 } = seedSqlite(false);
    const b = await bundleFromD1({ DB: d1, VARIANTS: makeKv() }, "acme");
    expect(b.v).toBe(1);
    expect(Object.keys(b.pages)).toEqual(["/"]);
    expect(b).not.toHaveProperty("kl");
    // The one line it logs names no customer value.
    expect(logged.join("\n")).toContain("keyword lexicon read failed");
  });
});
