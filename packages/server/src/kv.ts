/**
 * Workers KV over a SQLite file (docs/specs/run-anywhere.md): the calls the
 * workers make, and no more. A value is text; a key may expire.
 */

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

/** Workers KV gives at most this many keys a page. */
const PAGE = 1000;

export interface ServerKv extends KVNamespace {
  /** Removes what has expired; returns how many keys went. */
  sweep(now?: number): number;
}

export function kvOver(db: DatabaseSyncType, clock: () => number = Date.now): ServerKv {
  db.exec(
    "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER) WITHOUT ROWID;",
  );
  const read = db.prepare("SELECT value, expires_at FROM kv WHERE key = ?");
  const write = db.prepare(
    "INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
  );
  const remove = db.prepare("DELETE FROM kv WHERE key = ?");
  const expired = db.prepare("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?");

  const live = (key: string): string | null => {
    const row = read.get(key) as { value: string; expires_at: number | null } | undefined;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= clock()) {
      remove.run(key);
      return null;
    }
    return row.value;
  };

  const kv = {
    get: async (key: string, how?: string | { type?: string }) => {
      const value = live(key);
      if (value === null) return null;
      const type = typeof how === "string" ? how : (how?.type ?? "text");
      if (type === "json") return JSON.parse(value);
      if (type === "text") return value;
      throw new Error(`kv.get: type "${type}" is not supported on a server`);
    },
    put: async (
      key: string,
      value: unknown,
      options?: { expirationTtl?: number; expiration?: number },
    ) => {
      if (typeof value !== "string") throw new Error("kv.put: only text values are stored");
      const at = options?.expirationTtl
        ? clock() + options.expirationTtl * 1000
        : options?.expiration
          ? options.expiration * 1000
          : null;
      write.run(key, value, at);
    },
    delete: async (key: string) => {
      remove.run(key);
    },
    list: async (options: { prefix?: string; cursor?: string; limit?: number } = {}) => {
      const prefix = options.prefix ?? "";
      const limit = Math.min(options.limit ?? PAGE, PAGE);
      // Keys after the cursor, in order, that start with the prefix and are alive.
      const rows = db
        .prepare(
          "SELECT key, expires_at FROM kv WHERE key > ? AND substr(key, 1, ?) = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?",
        )
        .all(options.cursor ?? "", prefix.length, prefix, clock(), limit + 1) as {
        key: string;
        expires_at: number | null;
      }[];
      const page = rows.slice(0, limit);
      const complete = rows.length <= limit;
      return {
        keys: page.map((r) => ({
          name: r.key,
          ...(r.expires_at !== null ? { expiration: Math.floor(r.expires_at / 1000) } : {}),
        })),
        list_complete: complete,
        ...(complete ? {} : { cursor: (page.at(-1) as { key: string }).key }),
        cacheStatus: null,
      };
    },
    sweep: (now: number = clock()) => Number(expired.run(now).changes),
  };
  return kv as unknown as ServerKv;
}
