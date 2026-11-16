/**
 * A D1Database over node:sqlite with every migration applied, so handler
 * tests run their real SQL instead of matching SQL text (2026-10-01, pilot
 * apply). Foreign keys on, as in D1. Covers prepare/bind/first/all/run.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { d1Over, openDatabase } from "../../../server/src/d1.ts";

const MIGRATIONS = resolve(__dirname, "../../../../migrations");

/**
 * The database a test runs on is the one an install on a plain server runs
 * on (packages/server/src/d1.ts), in memory, with every migration applied.
 */
export function makeSqliteD1(): { d1: D1Database; db: DatabaseSyncType } {
  const db = openDatabase(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS, file), "utf8"));
  }
  return { d1: d1Over(db), db };
}

/**
 * In-memory KV with the calls the admin handlers use. `list` pages like
 * Workers KV: keys in lexicographic order, at most `limit` (1,000) a page,
 * `cursor` to continue; `listCalls` counts pages for budget tests.
 */
export function makeKv(): KVNamespace & { store: Map<string, string>; listCalls: number } {
  const store = new Map<string, string>();
  const kv = {
    store,
    listCalls: 0,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (opts: { prefix?: string; cursor?: string; limit?: number } = {}) => {
      kv.listCalls++;
      const prefix = opts.prefix ?? "";
      const limit = Math.min(opts.limit ?? 1000, 1000);
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const page = names.slice(start, start + limit);
      const end = start + page.length;
      const complete = end >= names.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: complete,
        ...(complete ? {} : { cursor: String(end) }),
      };
    },
  };
  return kv as unknown as KVNamespace & { store: Map<string, string>; listCalls: number };
}
