/**
 * A deleted customer's tombstone, `v1:closed:{id}` (docs/specs/
 * security-hardening.md §6 condition 1, ai-traffic-audit.md §8 condition 2):
 * the off script, the record-nothing /select answer with nothing written
 * back, both read in the existing batch.
 */

import { hideRulesKey, visitorBundleKey } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { CLOSED_MEMO_MS, isClosed } from "../src/closed.ts";
import worker from "../src/index.ts";

function kvWith(data: Record<string, string>) {
  const gets: string[] = [];
  const puts: string[] = [];
  const kv = {
    async get(key: string, opts?: string | { type?: string }) {
      gets.push(key);
      const v = data[key];
      if (v === undefined) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string) {
      puts.push(key);
    },
    async delete() {},
  } as unknown as KVNamespace;
  return { kv, gets, puts };
}

function dbSpy() {
  const sql: string[] = [];
  const db = {
    prepare(q: string) {
      sql.push(q);
      const stmt = {
        bind: () => stmt,
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: {} }),
      };
      return stmt;
    },
    batch: async () => [],
  } as unknown as D1Database;
  return { db, sql };
}

function ctxCollect() {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    ctx: {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  };
}

const CLOSED = { "v1:closed:gone-co": "1" };

async function select(data: Record<string, string>, id: string, query = "") {
  const { kv, gets, puts } = kvWith(data);
  const { db, sql } = dbSpy();
  const { ctx, waits } = ctxCollect();
  const res = await worker.fetch(
    new Request(`https://edge.test/select?customer_id=${id}&path=%2F${query}`, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh)" },
    }),
    { VARIANTS: kv, DB: db, ENVIRONMENT: "test", PREVIEW_TOKEN: "", HOLDOUT_PERCENT: "0" } as never,
    ctx,
  );
  await Promise.all(waits);
  const timing = res.headers.get("server-timing") ?? "";
  const batches = timing.split(",").filter((p) => /^\s*kv2?;/.test(p)).length;
  return { body: (await res.json()) as Record<string, unknown>, gets, puts, sql, batches };
}

describe("/s/{id}.js for a deleted customer", () => {
  it("serves the off script: off 1, no hide rules, no carry or rich config", async () => {
    const { kv } = kvWith({
      ...CLOSED,
      [hideRulesKey("gone-co")]: JSON.stringify({ "/": ["h1"] }),
    });
    const res = await worker.fetch(
      new Request("https://edge.test/s/gone-co.js"),
      { VARIANTS: kv, DB: {} as D1Database, ENVIRONMENT: "test", PREVIEW_TOKEN: "" } as never,
      ctxCollect().ctx,
    );
    const body = await res.text();
    expect(body.startsWith('window.__rw={"c":"gone-co","e":"https://edge.test","off":1};')).toBe(
      true,
    );
    expect(body).not.toContain('"h":');
  });

  it("an open customer's script is unchanged", async () => {
    const { kv, gets } = kvWith({ [hideRulesKey("acme")]: JSON.stringify({ "/": ["h1"] }) });
    const res = await worker.fetch(
      new Request("https://edge.test/s/acme.js"),
      { VARIANTS: kv, DB: {} as D1Database, ENVIRONMENT: "test", PREVIEW_TOKEN: "" } as never,
      ctxCollect().ctx,
    );
    expect(
      (await res.text()).startsWith('window.__rw={"c":"acme","e":"https://edge.test","h":'),
    ).toBe(true);
    expect(gets).toContain("v1:closed:acme");
  });
});

describe("/select for a deleted customer", () => {
  it("no signal: the record-nothing answer, nothing written back, one batch", async () => {
    const r = await select(CLOSED, "gone-co");
    expect(r.body).toEqual({ source: "original", variant_key: "", variant: null, off: 1 });
    expect(r.batches).toBe(1);
    expect(r.gets).toEqual([visitorBundleKey("gone-co"), "v1:closed:gone-co"]);
    expect(r.puts).toEqual([]);
    expect(r.sql).toEqual([]);
  });

  it("with a signal: the same answer, no version, no arm, no targets, no writeback", async () => {
    const r = await select(
      { ...CLOSED, "v1:variant:gone-co:problem:ai": JSON.stringify({ sections: {} }) },
      "gone-co",
      "&ref=https%3A%2F%2Fchatgpt.com%2F&utm_source=chatgpt.com",
    );
    expect(r.body).toEqual({ source: "original", variant_key: "", variant: null, off: 1 });
    expect(r.batches).toBe(1);
    expect(r.gets).toContain("v1:closed:gone-co");
    expect(r.puts).toEqual([]);
    expect(r.sql).toEqual([]);
  });

  it("an open customer without a bundle still gets it written back", async () => {
    const r = await select({}, "acme");
    expect(r.body.off).toBeUndefined();
    expect(r.sql.length).toBeGreaterThan(0);
  });
});

describe("the tombstone memo", () => {
  it("reads once per customer, then answers from memory for CLOSED_MEMO_MS (300 s less R, from the read)", async () => {
    const { kv, gets } = kvWith(CLOSED);
    const t = 1_760_000_000_000;
    expect(await isClosed(kv, "gone-co", t)).toBe(true);
    expect(await isClosed(kv, "gone-co", t + CLOSED_MEMO_MS - 1)).toBe(true);
    expect(await isClosed(kv, "acme", t)).toBe(false);
    expect(gets).toEqual(["v1:closed:gone-co", "v1:closed:acme"]);
    expect(await isClosed(kv, "gone-co", t + CLOSED_MEMO_MS + 1)).toBe(true);
    expect(gets).toHaveLength(3);
  });

  it("a failed read is not a tombstone and is not remembered", async () => {
    let calls = 0;
    const kv = {
      async get() {
        calls++;
        throw new Error("down");
      },
    } as unknown as KVNamespace;
    expect(await isClosed(kv, "x")).toBe(false);
    expect(await isClosed(kv, "x")).toBe(false);
    expect(calls).toBe(2);
  });
});
