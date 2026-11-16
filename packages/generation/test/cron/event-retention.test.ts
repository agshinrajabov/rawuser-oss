/**
 * Raw event retention (docs/specs/security-hardening.md §2.5, privacy review
 * condition 5) on real SQL: off unless RAW_EVENT_RETENTION_DAYS is set,
 * refused under 61 days, then rows older than the window deleted per
 * customer in chunks, the daily rollups untouched.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DAY_MS,
  MIN_RETENTION_DAYS,
  retentionDays,
  runEventRetention,
} from "../../src/cron/event-retention.ts";
import { makeSqliteD1 } from "../admin/sqlite-d1.ts";

const NOW = Date.UTC(2026, 9, 6);

function seeded() {
  const s = makeSqliteD1();
  for (const id of ["a", "b"]) {
    s.db
      .prepare(
        "INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES (?, ?, ?, 'pilot', 'active', 0)",
      )
      .run(id, id, `${id}.test`);
    for (const age of [1, 59, 89, 91, 200]) {
      for (let i = 0; i < 3; i++) {
        s.db
          .prepare("INSERT INTO events (customer_id, ts, event_type) VALUES (?, ?, 'page_view')")
          .run(id, NOW - age * DAY_MS - i);
      }
    }
  }
  s.db
    .prepare(
      "INSERT INTO source_days (customer_id, day, source_dim, visits, conversions, computed_at) VALUES ('a', '2026-01-01', 'ai', 5, 1, 0)",
    )
    .run();
  return s;
}

const count = (s: ReturnType<typeof makeSqliteD1>, sql: string) =>
  Number((s.db.prepare(sql).get() as { n: number }).n);

describe("raw event retention", () => {
  it("is off when the variable is unset or empty, and deletes nothing", async () => {
    const s = seeded();
    for (const v of [undefined, "", "  "]) {
      const r = await runEventRetention({ DB: s.d1, RAW_EVENT_RETENTION_DAYS: v }, NOW);
      expect(r).toEqual({ days: null, deleted: 0, capped: false });
    }
    expect(count(s, "SELECT COUNT(*) AS n FROM events")).toBe(30);
  });

  it("refuses a value under the aggregator's 60 days, or not a whole number", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(retentionDays({ RAW_EVENT_RETENTION_DAYS: "60" })).toBeNull();
    expect(retentionDays({ RAW_EVENT_RETENTION_DAYS: "90d" })).toBeNull();
    expect(retentionDays({ RAW_EVENT_RETENTION_DAYS: "-5" })).toBeNull();
    expect(retentionDays({ RAW_EVENT_RETENTION_DAYS: String(MIN_RETENTION_DAYS) })).toBe(61);
    expect(retentionDays({ RAW_EVENT_RETENTION_DAYS: "90" })).toBe(90);
    err.mockRestore();
  });

  it("at 90 days deletes only older rows, for every customer, and keeps the rollups", async () => {
    const s = seeded();
    const r = await runEventRetention({ DB: s.d1, RAW_EVENT_RETENTION_DAYS: "90" }, NOW, {
      chunk: 2,
    });
    expect(r).toEqual({ days: 90, deleted: 12, capped: false });
    expect(count(s, `SELECT COUNT(*) AS n FROM events WHERE ts < ${NOW - 90 * DAY_MS}`)).toBe(0);
    expect(count(s, "SELECT COUNT(*) AS n FROM events")).toBe(18);
    expect(count(s, "SELECT COUNT(*) AS n FROM source_days")).toBe(1);
  });

  it("stops at its statement cap and finishes on the next run", async () => {
    const s = seeded();
    const env = { DB: s.d1, RAW_EVENT_RETENTION_DAYS: "90" };
    const first = await runEventRetention(env, NOW, { chunk: 2, maxStatements: 3 });
    expect(first.capped).toBe(true);
    const second = await runEventRetention(env, NOW, { chunk: 2, maxStatements: 50 });
    expect(first.deleted + second.deleted).toBe(12);
    expect(second.capped).toBe(false);
  });
});
