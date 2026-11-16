/**
 * Applies the migrations to a SQLite file, each once and in order
 * (docs/specs/run-anywhere.md). What has been applied is kept in
 * `d1_migrations`, the table wrangler keeps for D1, so a database made one
 * way can be carried to the other.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

export function migrate(db: DatabaseSyncType, dir: string): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
  );
  const done = new Set(
    (db.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const applied: string[] = [];
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (done.has(name)) continue;
    // A migration is applied whole or not at all.
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join(dir, name), "utf8"));
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    applied.push(name);
  }
  return applied;
}
