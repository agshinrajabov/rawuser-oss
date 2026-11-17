/**
 * The public demo's event rows live 31 days (docs/specs/demo-page.md,
 * privacy review condition 2): only the ids in SHORT_RETENTION_CUSTOMERS
 * are touched, rows younger than 31 days and every other customer stay,
 * the daily rollups stay. That production names exactly `demo` is a
 * hosted test (test/hosted/short-retention.test.ts).
 */

import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  SHORT_RETENTION_DAYS,
  runShortRetention,
  shortRetentionCustomers,
} from "../../src/cron/event-retention.ts";
import { makeSqliteD1 } from "../admin/sqlite-d1.ts";

const NOW = Date.UTC(2026, 10, 17);

function seeded() {
  const s = makeSqliteD1();
  for (const id of ["demo", "pilot-a"]) {
    s.db
      .prepare(
        "INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES (?, ?, ?, 'lab', 'active', 0)",
      )
      .run(id, id, `${id}.test`);
    for (const age of [1, 30, 32, 200]) {
      s.db
        .prepare("INSERT INTO events (customer_id, ts, event_type) VALUES (?, ?, 'page_view')")
        .run(id, NOW - age * DAY_MS);
    }
  }
  s.db
    .prepare(
      "INSERT INTO source_days (customer_id, day, source_dim, visits, conversions, computed_at) VALUES ('demo', '2026-01-01', 'ai', 5, 1, 0)",
    )
    .run();
  return s;
}

const count = (s: ReturnType<typeof makeSqliteD1>, sql: string) =>
  Number((s.db.prepare(sql).get() as { n: number }).n);

describe("short retention for the demo", () => {
  it("is 31 days", () => {
    expect(SHORT_RETENTION_DAYS).toBe(31);
  });

  it("does nothing when the variable is unset, empty or not id-shaped", async () => {
    const s = seeded();
    for (const v of [undefined, "", " , ", "DROP TABLE", "a b"]) {
      const r = await runShortRetention({ DB: s.d1, SHORT_RETENTION_CUSTOMERS: v }, NOW);
      expect(r.deleted).toBe(0);
    }
    expect(count(s, "SELECT COUNT(*) AS n FROM events")).toBe(8);
  });

  it("deletes only the named customer's rows older than 31 days", async () => {
    const s = seeded();
    const r = await runShortRetention({ DB: s.d1, SHORT_RETENTION_CUSTOMERS: "demo" }, NOW);
    expect(r).toEqual({ ids: ["demo"], deleted: 2, capped: false });
    expect(count(s, "SELECT COUNT(*) AS n FROM events WHERE customer_id = 'demo'")).toBe(2);
    expect(count(s, "SELECT COUNT(*) AS n FROM events WHERE customer_id = 'pilot-a'")).toBe(4);
    expect(count(s, "SELECT COUNT(*) AS n FROM source_days")).toBe(1);
  });

  it("works in chunks and stops at the statement cap", async () => {
    const s = seeded();
    const r = await runShortRetention({ DB: s.d1, SHORT_RETENTION_CUSTOMERS: "demo" }, NOW, {
      chunk: 1,
      maxStatements: 1,
    });
    expect(r).toEqual({ ids: ["demo"], deleted: 1, capped: true });
  });

  it("parses a list", () => {
    expect(shortRetentionCustomers({ SHORT_RETENTION_CUSTOMERS: " demo , x-1 " })).toEqual([
      "demo",
      "x-1",
    ]);
  });
});
