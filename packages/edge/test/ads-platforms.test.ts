/**
 * Ads platforms at the edge (docs/specs/ads-platforms.md §4 and §5;
 * privacy review CONDITIONAL PASS 2026-10-22, condition 2).
 *
 * - The cascade's keys: a search ad reads `:paid`, then `:default`; a feed
 *   ad's paid visit reads `:social`, then `:default`. The answer's
 *   selection, and so the events, keep `source_dim = paid`.
 * - A campaign name the special-category screen refuses is out of the
 *   signals before the gate and the classifier: it chooses nothing, as if
 *   it never came, and no console line, KV write or answer holds it.
 */

import {
  INTENT_DIMENSIONS,
  SOURCE_DIMENSIONS,
  type Signals,
  variantKey,
  variantKeyForPath,
  visitorBundleKey,
} from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEventGuardForTests } from "../src/event.ts";
import worker from "../src/index.ts";

/** What the classifier saw, per call. */
const seen = vi.hoisted(() => ({ classified: [] as Signals[] }));

vi.mock("@rawuser/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rawuser/shared")>();
  return {
    ...actual,
    classify: (...args: Parameters<typeof actual.classify>) => {
      seen.classified.push(structuredClone(args[0]));
      return actual.classify(...args);
    },
  };
});

const STUB = (cell: string) => ({
  customer_id: "demo",
  profile_key: cell,
  sections: { hero: { kind: "hero", headline: cell } },
  generated_at: 0,
  prompt_hash: "p",
});

/** Every cell of `/` and `/pricing` has a version, unless left out. */
function versions(without: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of ["/", "/pricing"]) {
    for (const i of INTENT_DIMENSIONS) {
      for (const s of [...SOURCE_DIMENSIONS, "default"]) {
        const key = variantKeyForPath("demo", p, i, s);
        if (!without.includes(key)) out[key] = STUB(`${p} ${i}:${s}`);
      }
    }
  }
  return out;
}

const BUNDLE = { v: 1, pages: {}, conv: [], h: 0 };

interface Recorded {
  puts: Array<{ key: string; value: string }>;
  binds: unknown[][];
  waits: Promise<unknown>[];
}

async function select(query: string, opts: { without?: string[]; path?: string } = {}) {
  const rec: Recorded = { puts: [], binds: [], waits: [] };
  const data: Record<string, unknown> = {
    ...versions(opts.without),
    [visitorBundleKey("demo")]: BUNDLE,
  };
  const kv = {
    async get(key: string, o?: unknown) {
      const v = data[key];
      if (v === undefined) return null;
      const type = typeof o === "string" ? o : (o as { type?: string } | undefined)?.type;
      return type === "json" ? v : typeof v === "string" ? v : JSON.stringify(v);
    },
    async put(key: string, value: string) {
      rec.puts.push({ key, value: String(value) });
    },
    async delete() {},
  } as unknown as KVNamespace;
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => {
        rec.binds.push(args);
        return {
          run: async () => ({ success: true, meta: {} }),
          first: async () => null,
          all: async () => ({ results: [] }),
        };
      },
    }),
    batch: async (s: unknown[]) => s.map(() => ({ success: true })),
  } as unknown as D1Database;
  const env = {
    VARIANTS: kv,
    DB: db,
    ENVIRONMENT: "test",
    PREVIEW_TOKEN: "",
    HOLDOUT_PERCENT: "0",
    SOURCE_LEARNING: "on",
  };
  const ctx = {
    waitUntil: (p: Promise<unknown>) => rec.waits.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const path = encodeURIComponent(opts.path ?? "/");
  const res = await worker.fetch(
    new Request(`https://edge.test/select?customer_id=demo&path=${path}&${query}`, {
      headers: { "user-agent": "Mozilla/5.0 (iPhone) Mobile Safari/605.1.15" },
    }),
    env as never,
    ctx,
  );
  const text = await res.text();
  await Promise.all(rec.waits);
  return { body: JSON.parse(text) as Record<string, unknown>, text, rec };
}

const sel = (b: Record<string, unknown>) =>
  b.selection as { intent_dim: string; source_dim: string } | undefined;

const META =
  "utm_source=ig&utm_medium=paid_social&utm_campaign=spring-sale&utm_content=carousel-1&clk=fbclid";
const GOOGLE = "utm_source=google&utm_medium=cpc&clk=gclid";

let logged: string[] = [];
let spies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  seen.classified.length = 0;
  logged = [];
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    }),
  );
  resetEventGuardForTests();
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
});

describe("the cascade's keys for a paid visit (§4)", () => {
  it("a Meta ad reads the social version; the selection says paid", async () => {
    const r = await select(META);
    const s = sel(r.body);
    expect(s?.source_dim).toBe("paid");
    expect(r.body.variant_key).toBe(variantKey("demo", s?.intent_dim ?? "", "social"));
    expect(r.body.source).toBe("kv");
  });

  it("a TikTok, LinkedIn or X ad, and a paid-social click id alone, read social", async () => {
    for (const q of [
      "utm_source=tiktok&utm_medium=paid_social&utm_campaign=spring&utm_content=ad-1",
      "utm_source=linkedin&utm_medium=paid_social&utm_campaign=spring",
      "utm_source=x&utm_medium=paid_social&utm_campaign=spring",
      "utm_source=an&utm_medium=social_paid",
    ]) {
      const r = await select(q);
      expect(sel(r.body)?.source_dim, q).toBe("paid");
      expect(String(r.body.variant_key).endsWith(":social"), q).toBe(true);
    }
    // ttclid alone: social outweighs paid in the vector already; it reads social as before.
    const tt = await select("clk=ttclid");
    expect(String(tt.body.variant_key).endsWith(":social")).toBe(true);
  });

  it("a search ad reads the paid version", async () => {
    const r = await select(GOOGLE);
    const s = sel(r.body);
    expect(s?.source_dim).toBe("paid");
    expect(r.body.variant_key).toBe(variantKey("demo", s?.intent_dim ?? "", "paid"));
  });

  it("without the cell's own version, both fall back to the intent's default", async () => {
    const intent = sel((await select(GOOGLE)).body)?.intent_dim ?? "";
    const g = await select(GOOGLE, { without: [variantKey("demo", intent, "paid")] });
    expect(g.body.variant_key).toBe(variantKey("demo", intent, "default"));
    expect(g.body.source).toBe("kv-sentinel");
    const metaIntent = sel((await select(META)).body)?.intent_dim ?? "";
    const m = await select(META, { without: [variantKey("demo", metaIntent, "social")] });
    expect(m.body.variant_key).toBe(variantKey("demo", metaIntent, "default"));
    expect(sel(m.body)?.source_dim).toBe("paid");
  });

  it("on another page the page's own key comes first, with the same source part", async () => {
    const r = await select(META, { path: "/pricing" });
    expect(r.body.variant_key).toBe(
      variantKeyForPath("demo", "/pricing", sel(r.body)?.intent_dim ?? "", "social"),
    );
  });

  it("a carried paid visit on a page with no signal of its own reads paid", async () => {
    const r = await select("carry=brand:paid");
    expect(sel(r.body)).toMatchObject({ intent_dim: "brand", source_dim: "paid" });
    expect(r.body.variant_key).toBe(variantKey("demo", "brand", "paid"));
  });
});

describe("a refused campaign name chooses nothing (§5, condition 2)", () => {
  const REFUSED = "diabetes-pricing";

  it('"diabetes-pricing" picks no pricing intent, and the classifier never sees it', async () => {
    const r = await select(`${GOOGLE}&utm_campaign=${REFUSED}`);
    expect(sel(r.body)?.intent_dim).not.toBe("pricing");
    expect(seen.classified.length).toBeGreaterThan(0);
    for (const s of seen.classified) expect(s.utm).not.toHaveProperty("campaign");
    const without = await select(GOOGLE);
    expect(r.body.selection).toEqual(without.body.selection);
    expect(r.body.variant_key).toEqual(without.body.variant_key);
  });

  it("an ordinary campaign word still chooses", async () => {
    const r = await select(`${GOOGLE}&utm_campaign=spring-pricing`);
    expect(sel(r.body)?.intent_dim).toBe("pricing");
  });

  it("a link with only a refused campaign is a page with no signal", async () => {
    const r = await select(`utm_campaign=${REFUSED}`);
    expect(r.body.cohort).toBe("no_signal");
    expect(r.body.variant).toBeNull();
  });

  it("no console line, KV write, D1 bind or answer holds the name", async () => {
    for (const q of [
      `${GOOGLE}&utm_campaign=${REFUSED}`,
      `utm_campaign=${REFUSED}`,
      `utm_source=zzunknown&utm_medium=zzmedium&utm_campaign=${REFUSED}`,
    ]) {
      const r = await select(q);
      expect(r.text).not.toContain("diabetes");
      expect(JSON.stringify(r.rec.puts)).not.toContain("diabetes");
      expect(JSON.stringify(r.rec.binds)).not.toContain("diabetes");
    }
    expect(logged.join("\n")).not.toContain("diabetes");
  });
});
