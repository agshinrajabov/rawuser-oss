/**
 * The visitor's own choice at the edge (docs/specs/direct-visitors.md §2):
 * the question on the home page for a visit with no signal and no carry,
 * the test's coin first (the comparison group is never asked); an answer in
 * the tab's carry served as its version on every page with versions, with
 * `nd: "c:{slot}"`; nothing when the question is off or killed (no `qc`);
 * the first-paint reserve in the customer's script only with `qc`; the
 * preview link's seed is one-time and stores nothing.
 */
import {
  customerLangKey,
  pickTokenKey,
  readPickSeed,
  receivePick,
  rememberJs,
  variantKeyForPath,
  visitorBundleKey,
} from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { BOOT_JS } from "../src/boot-asset.ts";
import { decideArm } from "../src/holdout.ts";
import worker from "../src/index.ts";

const BODY = (headline: string, id: string) => ({
  customer_id: "demo",
  profile_key: "x",
  sections: { hero: { kind: "hero", headline } },
  generated_at: 0,
  prompt_hash: "p",
  body_id: id,
});
const MANIFEST = {
  "hero.headline": { css: ["h1"], text: ["Old"], structural: "h1" },
  "hero.cta.label": { css: ["a.cta"], text: ["Start"], structural: "a" },
};
const QC = {
  q: "What brings you here?",
  a: [
    ["a", "I'm a broker", "problem", "social"],
    ["b", "I run a PE fund", "evaluation", "default"],
    ["c", "I'm selling my company", "feature", "default"],
  ],
  s: ["a.cta"],
};
const BROKER = variantKeyForPath("demo", "/", "problem", "social");
const ABOUT_BROKER = variantKeyForPath("demo", "/about", "problem", "default");

function kvWith(data: Record<string, unknown>) {
  return {
    async get(k: string, opts?: string | { type?: string }) {
      const v = data[k];
      if (v === undefined) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "json" ? v : typeof v === "string" ? v : JSON.stringify(v);
    },
    async put() {},
    async delete() {},
  } as unknown as KVNamespace;
}
const db = {
  prepare: () => ({
    bind: () => ({
      run: async () => ({}),
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
  }),
} as unknown as D1Database;
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const bundle = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  pages: { "/": MANIFEST, "/about": MANIFEST },
  conv: [],
  qc: QC,
  ...extra,
});
const data = (extra: Record<string, unknown> = {}) => ({
  [visitorBundleKey("demo")]: bundle(extra),
  [BROKER]: BODY("For brokers", "bbbbbbbbbbbbbbbb"),
  [ABOUT_BROKER]: BODY("About, for brokers", "cccccccccccccccc"),
});

async function select(d: Record<string, unknown>, query: string) {
  const res = await worker.fetch(
    new Request(`https://edge.test/select?customer_id=demo&${query}`, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh)" },
    }),
    { VARIANTS: kvWith(d), DB: db, ENVIRONMENT: "test", PREVIEW_TOKEN: "", HOLDOUT_PERCENT: "0" },
    ctx,
  );
  return (await res.json()) as Record<string, unknown>;
}

async function markers() {
  const v: Record<string, string> = {};
  for (let i = 0; Object.keys(v).length < 2 && i < 200; i++) {
    const m = i.toString(16).padStart(32, "0");
    v[(await decideArm("demo", m, 50)) ?? "none"] ??= m;
  }
  return v as { holdout: string; treat: string };
}

describe("the question (§2)", () => {
  it("rides on the home page's answer for a visit with no signal: words and anchor only", async () => {
    const r = await select(data(), "path=%2F");
    expect(r.source).toBe("original");
    expect(r.q).toEqual({
      t: "What brings you here?",
      a: [
        ["a", "I'm a broker"],
        ["b", "I run a PE fund"],
        ["c", "I'm selling my company"],
      ],
      s: ["a.cta"],
    });
    expect(JSON.stringify(r.q)).not.toMatch(/problem|social|evaluation/);
  });

  it("never with a signal, a carry, on another page, or without qc", async () => {
    expect(await select(data(), "path=%2F&utm_source=x")).not.toHaveProperty("q");
    expect(await select(data(), "path=%2F&carry=none%3Adirect")).not.toHaveProperty("q");
    expect(await select(data(), "path=%2Fabout")).not.toHaveProperty("q");
    expect(await select(data({ qc: undefined }), "path=%2F")).not.toHaveProperty("q");
    // A site marked sensitive: the question alone may run (2026-11-04).
    expect(await select(data({ s: 1 }), "path=%2F")).toHaveProperty("q");
    expect(await select(data({ ne: 1 }), "path=%2F")).not.toHaveProperty("q");
  });

  it("only on a page shown in the brief's language (the same address in another language is not asked)", async () => {
    const lang = { ...data(), [customerLangKey("demo")]: "az" };
    expect(await select(lang, "path=%2F&plang=az")).toHaveProperty("q");
    expect(await select(lang, "path=%2F&plang=en")).not.toHaveProperty("q");
    // No language stored, or none sent: as before.
    expect(await select(data(), "path=%2F&plang=en")).toHaveProperty("q");
    expect(await select(lang, "path=%2F")).toHaveProperty("q");
  });

  it("each language home asks its own question, and a later page reads the answers of its language", async () => {
    const AZ = {
      q: "Sizi buraya nə gətirib?",
      a: [
        ["a", "Brokerəm", "evaluation", "default"],
        ["b", "Fond idarə edirəm", "problem", "default"],
      ],
      s: [],
    };
    const AZ_ABOUT = variantKeyForPath("demo", "/az/about", "evaluation", "default");
    const d = {
      ...data({
        pages: { "/": MANIFEST, "/az": MANIFEST, "/az/about": MANIFEST },
        ql: { "/az": AZ },
      }),
      [customerLangKey("demo")]: JSON.stringify({ "/": "en", "/az": "az" }),
      [AZ_ABOUT]: BODY("Haqqımızda, brokerlər üçün", "dddddddddddddddd"),
    };
    expect(((await select(d, "path=%2Faz&plang=az")).q as { t: string }).t).toBe(
      "Sizi buraya nə gətirib?",
    );
    expect(((await select(d, "path=%2F&plang=en")).q as { t: string }).t).toBe(
      "What brings you here?",
    );
    expect(await select(d, "path=%2Faz&plang=en")).not.toHaveProperty("q");
    // Answered "a" on /az: on /az/about the Azerbaijani answer's version.
    const r = await select(d, "path=%2Faz%2Fabout&plang=az&carry=qa%3Adirect");
    expect(r).toMatchObject({ variant_key: AZ_ABOUT, nd: "c:a" });
  });

  it("a remembered answer serves its version and is told apart from one taken in the tab", async () => {
    const taken = await select(data(), "path=%2Fabout&carry=qa%3Adirect");
    expect(taken).toMatchObject({ variant_key: ABOUT_BROKER, nd: "c:a" });
    const back = await select(data(), "path=%2Fabout&carry=ra%3Adirect");
    expect(back).toMatchObject({ variant_key: ABOUT_BROKER, nd: "r:a" });
    expect(await select(data(), "path=%2F&carry=ra%3Adirect")).not.toHaveProperty("q");
  });

  it("the test's coin first: the comparison group is never asked", async () => {
    const m = await markers();
    const h = await select(data({ h: 50 }), `path=%2F&visit=${m.holdout}`);
    expect(h).toMatchObject({ source: "holdout", arm: "holdout", kc: "" });
    expect(h).not.toHaveProperty("q");
    const t = await select(data({ h: 50 }), `path=%2F&visit=${m.treat}`);
    expect(t).toMatchObject({ arm: "treat" });
    expect(t.q).toBeTruthy();
  });

  it("rides on a market version too", async () => {
    const GB = variantKeyForPath("demo", "/", "brand", "mk-gb");
    const req = new Request("https://edge.test/select?customer_id=demo&path=%2F", {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh)" },
    });
    Object.defineProperty(req, "cf", { value: { country: "GB" } });
    const res = await worker.fetch(
      req,
      {
        VARIANTS: kvWith({ ...data({ mk: ["GB"] }), [GB]: BODY("UK", "dddddddddddddddd") }),
        DB: db,
        ENVIRONMENT: "test",
        PREVIEW_TOKEN: "",
        HOLDOUT_PERCENT: "0",
      },
      ctx,
    );
    const r = (await res.json()) as Record<string, unknown>;
    expect(r.variant_key).toBe(GB);
    expect(r.q).toBeTruthy();
  });
});

describe("an answer in the tab's carry (§2)", () => {
  it("serves its version on the home page, carried, with nd c:a", async () => {
    const r = await select(data(), "path=%2F&carry=qa%3Adirect");
    expect(r).toMatchObject({
      source: "kv",
      cohort: "personalized",
      variant_key: BROKER,
      carried: true,
      nd: "c:a",
      body_id: "bbbbbbbbbbbbbbbb",
    });
    expect(r.selection).toMatchObject({ intent_dim: "problem", source_dim: "direct" });
    expect(r).not.toHaveProperty("q");
    expect(r).not.toHaveProperty("kc");
  });

  it("holds on later pages: the cell's own, else the base version", async () => {
    const r = await select(data(), "path=%2Fabout&carry=qa%3Adirect");
    expect(r).toMatchObject({ variant_key: ABOUT_BROKER, nd: "c:a", carried: true });
  });

  it("the question off or killed (no qc): the page as built, nothing drawn", async () => {
    const r = await select(
      data({
        qc: undefined,
        dl: {
          s: "x",
          w: {
            "/": [
              ["none", 500],
              ["feature", 500],
            ],
          },
        },
      }),
      "path=%2F&carry=qa%3Adirect",
    );
    expect(r.source).toBe("original");
    expect(r).not.toHaveProperty("nd");
  });

  it("a page that names a word does not replace the answer", async () => {
    const r = await select(data({ dp: 1 }), "path=%2Fpricing&carry=qa%3Adirect");
    expect(r).not.toHaveProperty("kc");
  });
});

describe("the customer's script and the question (§2, the bar)", () => {
  async function script(b: unknown) {
    const res = await worker.fetch(
      new Request("https://edge.test/s/demo.js"),
      {
        VARIANTS: kvWith({ [visitorBundleKey("demo")]: b }),
        DB: db,
        ENVIRONMENT: "test",
        PREVIEW_TOKEN: "",
      },
      ctx,
    );
    return res.text();
  }
  it("no reserve; the memory only while the customer keeps returning visitors (`rm`)", async () => {
    const on = await script(bundle({ rm: 1 }));
    // What the edge writes before the boot adds no reserve. The boot itself
    // names it once, to take away one that an older script left.
    expect(on.endsWith(BOOT_JS)).toBe(true);
    expect(on.slice(0, -BOOT_JS.length)).not.toContain("__rawuser-q");
    expect(on).toContain(rememberJs());
    // Whether or not a question is on: the memory is its own switch.
    expect(await script(bundle({ rm: 1, qc: undefined }))).toContain(rememberJs());
    expect(await script(bundle())).not.toContain("__rw_pick");
    expect(await script(bundle({ rm: 1, a: 1 }))).not.toContain("__rw_pick");
    expect(await script(bundle({ rm: 1, ne: 1 }))).not.toContain("__rw_pick");
  });
});

describe("the preview link's seed (§2)", () => {
  function store(seed: Record<string, string>) {
    const m = new Map(Object.entries(seed));
    return {
      m,
      get: async (k: string) => m.get(k) ?? null,
      put: async (k: string, v: string) => void m.set(k, v),
      delete: async (k: string) => void m.delete(k),
    };
  }
  it("answers once with the question, never picks or stores", async () => {
    const s = store({
      [pickTokenKey("tok12345")]: JSON.stringify({
        customer_id: "demo",
        page_path: "/",
        manifest: {},
        mode: "choice",
        choice: {
          t: "Q?",
          a: [
            ["a", "A"],
            ["b", "B"],
          ],
          s: ["a.cta"],
        },
      }),
    });
    const first = await readPickSeed("tok12345", s);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ mode: "choice", choice: { t: "Q?", p: 1 } });
    expect((await readPickSeed("tok12345", s)).status).toBe(403);
    const s2 = store({
      [pickTokenKey("tok99999")]: JSON.stringify({
        customer_id: "demo",
        page_path: "/",
        manifest: {},
        mode: "choice",
      }),
    });
    const post = await receivePick(
      {
        token: "tok99999",
        manifest: { "hero.headline": { css: ["h1"], text: ["x"], structural: "h1" } },
      },
      s2 as never,
    );
    expect(post.status).toBe(403);
  });
});
