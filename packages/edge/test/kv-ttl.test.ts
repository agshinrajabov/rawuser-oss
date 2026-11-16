/**
 * Honest R (warm /select, privacy review condition 1 of 2026-10-26): the copy of
 * kv-copy.ts serves a value while `now - at + R <= 300 s`, where R is the
 * longest `cacheTtl` any edge route reads that key with. If one route read a
 * key longer than R, KV could hand another route a location entry that read
 * filled, and a kept value would outlive the 300 s bound.
 *
 * Two checks:
 * 1. Every `cacheTtl` in the edge's source is listed here with the key it
 *    reads and its value. A new or changed one fails until it is added, and
 *    a listed one on a copied key must not exceed that key's R.
 * 2. The routes, run against a recording KV: every read of a copied key
 *    uses a `cacheTtl` (or KV's default of 60 s) no longer than its R.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { closedKey, customerLangKey, variantKeyForPath, visitorBundleKey } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { carryOffKey, handleCarry } from "../src/body-carry.ts";
import { handleCustomerScript } from "../src/customer-script.ts";
import { eventBundleFor } from "../src/event-bundle.ts";
import worker from "../src/index.ts";
import { type CopyKind, KV_COPY_TTL_S, KV_R_S } from "../src/kv-copy.ts";

/** KV's default `cacheTtl` for a read that names none. */
const KV_DEFAULT_TTL_S = 60;

/**
 * Every `cacheTtl` in packages/edge/src, by file and code line, with the key
 * it reads and the value. "rich" is not a key `/select` reads, so it is not
 * under the copy.
 */
const LISTED: Array<{
  file: string;
  line: string;
  key: CopyKind | "rich" | "copied";
  ttl: number;
}> = [
  { file: "bundle-writeback.ts", line: "cacheTtl: BUNDLE_CACHE_TTL_S,", key: "bundle", ttl: 60 },
  {
    file: "customer-script.ts",
    line: "env.VARIANTS.get(richKey(customerId), { cacheTtl: TAG_KV_TTL_S }).then(richPaths),",
    key: "rich",
    ttl: 300,
  },
  {
    file: "customer-script.ts",
    line: "cacheTtl: KV_COPY_TTL_S,",
    key: "bundle",
    ttl: KV_COPY_TTL_S,
  },
  { file: "event-bundle.ts", line: "cacheTtl: EVENT_BUNDLE_CACHE_TTL_S,", key: "bundle", ttl: 60 },
  // The copy's own read: each kind at its R.
  {
    file: "kv-copy.ts",
    line: '? await kv.get(key, { type: "json", cacheTtl: r })',
    key: "copied",
    ttl: 60,
  },
  { file: "kv-copy.ts", line: ": await kv.get(key, { cacheTtl: r });", key: "copied", ttl: 60 },
];

function codeLinesWithCacheTtl(): Array<{ file: string; line: string }> {
  const dir = join(__dirname, "..", "src");
  const out: Array<{ file: string; line: string }> = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort()) {
    for (const raw of readFileSync(join(dir, file), "utf8").split("\n")) {
      const line = raw.trim();
      if (line.startsWith("*") || line.startsWith("/*") || line.startsWith("//")) continue;
      if (/\bcacheTtl\b/.test(line)) out.push({ file, line });
    }
  }
  return out;
}

describe("every cacheTtl in the edge is listed with its key and value", () => {
  it("the source holds exactly the listed reads", () => {
    const found = codeLinesWithCacheTtl();
    expect(found).toEqual(LISTED.map(({ file, line }) => ({ file, line })));
  });

  it("no copied key is read longer than its R", () => {
    for (const row of LISTED) {
      if (row.key === "rich") continue;
      const r = row.key === "copied" ? Math.min(...Object.values(KV_R_S)) : KV_R_S[row.key];
      expect(row.ttl, `${row.file}: ${row.line}`).toBeLessThanOrEqual(r);
    }
    expect(Object.values(KV_R_S).every((r) => r === KV_COPY_TTL_S)).toBe(true);
    expect(KV_DEFAULT_TTL_S).toBeLessThanOrEqual(Math.min(...Object.values(KV_R_S)));
  });
});

const CUSTOMER = "acme";
const MANIFEST = { "hero.headline": { css: ["h1"], text: ["Old"], structural: "h1" } };
const BUNDLE = { v: 1, pages: { "/": MANIFEST, "/pricing": MANIFEST }, conv: [] };
const STUB = {
  customer_id: CUSTOMER,
  profile_key: "x",
  sections: { hero: { kind: "hero", headline: "New" } },
  generated_at: 0,
  prompt_hash: "p",
};

function kindOf(key: string): CopyKind | null {
  if (key === visitorBundleKey(CUSTOMER)) return "bundle";
  if (key === closedKey(CUSTOMER)) return "closed";
  if (key === carryOffKey(CUSTOMER)) return "carry";
  if (key === customerLangKey(CUSTOMER)) return "lang";
  if (key.startsWith(`v1:variant:${CUSTOMER}`)) return "body";
  return null;
}

function recordingKv(data: Record<string, unknown>) {
  const reads: Array<{ key: string; ttl: number }> = [];
  const kv = {
    async get(key: string, opts?: unknown) {
      const ttl =
        opts && typeof opts === "object" && "cacheTtl" in opts
          ? Number((opts as { cacheTtl: number }).cacheTtl)
          : KV_DEFAULT_TTL_S;
      reads.push({ key, ttl });
      const v = data[key];
      if (v === undefined) return null;
      const type = typeof opts === "string" ? opts : (opts as { type?: string } | undefined)?.type;
      return type === "json" ? v : typeof v === "string" ? v : JSON.stringify(v);
    },
    async put() {},
    async delete() {},
  } as unknown as KVNamespace;
  return { kv, reads };
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

function ctxCollect() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
    async flush() {
      while (pending.length) await pending.shift();
    },
  };
}

describe("the routes read every copied key at or under its R", () => {
  it("/select, /s/{id}.js with a warm, /carry and /event's bundle and tombstone reads", async () => {
    const data: Record<string, unknown> = {
      [visitorBundleKey(CUSTOMER)]: BUNDLE,
      [customerLangKey(CUSTOMER)]: JSON.stringify({ "/": "en" }),
      [variantKeyForPath(CUSTOMER, "/", "problem", "ai")]: STUB,
      [variantKeyForPath(CUSTOMER, "/pricing", "pricing", "ai")]: STUB,
    };
    const { kv, reads } = recordingKv(data);
    const env = {
      VARIANTS: kv,
      DB: db,
      ENVIRONMENT: "test",
      PREVIEW_TOKEN: "",
      HOLDOUT_PERCENT: "0",
    };
    for (const q of [
      "path=%2F",
      "path=%2F&utm_source=chatgpt.com&plang=en",
      "path=%2Fpricing&utm_source=chatgpt.com",
      "path=%2Fpricing&ss=1&carry=problem:ai",
    ]) {
      const w = ctxCollect();
      await worker.fetch(
        new Request(`https://edge.test/select?customer_id=${CUSTOMER}&${q}`, {
          headers: { "user-agent": "Mozilla/5.0 (Macintosh)" },
        }),
        { ...env, SELECT_COPY: "off" },
        w.ctx,
      );
      await w.flush();
    }
    const t = ctxCollect();
    await handleCustomerScript(new Request(`https://edge.test/s/${CUSTOMER}.js`), env, CUSTOMER, {
      ctx: t.ctx,
      cache: null,
      selectCache: null,
    });
    await t.flush();
    const c = ctxCollect();
    await handleCarry(
      new Request(`https://edge.test/carry?customer_id=${CUSTOMER}&carry=problem:ai`),
      new URL(`https://edge.test/carry?customer_id=${CUSTOMER}&carry=problem:ai`),
      env,
      c.ctx,
    );
    await c.flush();
    await eventBundleFor(kv, CUSTOMER);
    const kinds = new Set<CopyKind>();
    for (const r of reads) {
      const kind = kindOf(r.key);
      if (!kind) continue;
      kinds.add(kind);
      expect(r.ttl, `${r.key}`).toBeLessThanOrEqual(KV_R_S[kind]);
    }
    expect([...kinds].sort()).toEqual(["body", "bundle", "carry", "closed", "lang"]);
  });
});
