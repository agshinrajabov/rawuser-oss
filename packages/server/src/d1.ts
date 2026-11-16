/**
 * D1 over a SQLite file (docs/specs/run-anywhere.md).
 *
 * The workers reach their database through Cloudflare's D1 interface and
 * nothing else: prepare, bind, first, all, run, batch. This gives them the
 * same interface over Node's own SQLite, so the same worker code runs on a
 * plain machine. It is also the database the tests run on.
 *
 * Every call here runs to its end without yielding, so a batch is one
 * transaction that no other request can step into.
 */

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Node prints "SQLite is an experimental feature" the first time the module
// loads, in the middle of whatever is on the terminal: a setup question, the
// start-up lines. It says nothing an operator can act on, so that one line
// is left out. Every other warning is passed on as it is.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.includes("SQLite is an experimental feature")) return;
  return (emitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

// Asked from Node itself: a bundler may drop the "node:" prefix, and
// "sqlite" has no bare form.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

type Param = string | number | bigint | null | Uint8Array;

function toParams(args: readonly unknown[]): Param[] {
  return args.map((a) => {
    if (a === undefined || a === null) return null;
    if (typeof a === "boolean") return Number(a);
    if (a instanceof ArrayBuffer) return new Uint8Array(a);
    return a as Param;
  });
}

/** Opens a database file (or `:memory:`) the way D1 behaves: foreign keys on. */
export function openDatabase(path: string): DatabaseSyncType {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") {
    // Readers do not wait for a writer, and a writer waits rather than fails.
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
  }
  return db;
}

/**
 * Whether a statement gives rows back, as against one that only changes
 * them. SQLite itself knows (a statement with columns gives rows); the
 * words are read only on a Node too old to ask, past any leading comment.
 */
const READS = /^(?:SELECT|WITH|PRAGMA|EXPLAIN|VALUES)\b|\bRETURNING\b/i;
function givesRows(stmt: { columns?: () => unknown[] }, sql: string): boolean {
  if (typeof stmt.columns === "function") return stmt.columns().length > 0;
  return READS.test(sql.replace(/^(?:\s+|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, ""));
}

interface Result<T> {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id: number; duration: number };
}

/** The D1 interface over one open database. */
export function d1Over(db: DatabaseSyncType): D1Database {
  /** One statement, run now. */
  const execute = <T>(sql: string, params: Param[]): Result<T> => {
    const started = Date.now();
    const stmt = db.prepare(sql);
    if (givesRows(stmt as { columns?: () => unknown[] }, sql)) {
      const rows = stmt.all(...params) as Record<string, unknown>[];
      return {
        results: rows.map((r) => ({ ...r }) as T),
        success: true,
        meta: { changes: 0, last_row_id: 0, duration: Date.now() - started },
      };
    }
    const r = stmt.run(...params);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(r.changes),
        last_row_id: Number(r.lastInsertRowid),
        duration: Date.now() - started,
      },
    };
  };

  const statement = (sql: string, params: Param[]) => ({
    /** For `batch`: this statement, run without yielding. */
    __now: <T>() => execute<T>(sql, params),
    bind: (...args: unknown[]) => statement(sql, toParams(args)),
    first: async <T>(column?: string): Promise<T | null> => {
      const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
      if (!row) return null;
      return (column ? (row[column] ?? null) : { ...row }) as T;
    },
    all: async <T>() => execute<T>(sql, params),
    run: async <T>() => execute<T>(sql, params),
    raw: async <T>() =>
      (db.prepare(sql).all(...params) as Record<string, unknown>[]).map(
        (r) => Object.values(r) as T,
      ),
  });

  const d1 = {
    prepare: (sql: string) => statement(sql, []),
    /** Every statement or none: one transaction, as D1's batch is. */
    batch: async (statements: Array<{ __now: () => Result<unknown> }>) => {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => s.__now());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return d1 as unknown as D1Database;
}
