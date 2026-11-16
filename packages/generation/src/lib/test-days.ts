/**
 * Which days a holdout test ran on, per customer.
 *
 * `rollup-missing` matters only for a day a test ran on: that is the only
 * day whose arms the long read needs. Before 2026-10-06 the alert fired for
 * every unrolled day, so two of our own sites raised it daily for their
 * September days, which predate the proof engine and had no test (the
 * founder's question, 2026-10-06). A day counts when any part of it falls
 * inside a test period [started_at, ended_at or now).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TestPeriod {
  started_at: number;
  ended_at: number | null;
}

export async function testPeriods(db: D1Database, customerId: string): Promise<TestPeriod[]> {
  const rows = await db
    .prepare("SELECT started_at, ended_at FROM holdout_tests WHERE customer_id = ?")
    .bind(customerId)
    .all<TestPeriod>();
  return rows.results ?? [];
}

/** True when a test ran during any part of the UTC day `day` (YYYY-MM-DD). */
export function testRanOn(day: string, periods: TestPeriod[], now: number): boolean {
  const start = Date.parse(`${day}T00:00:00Z`);
  const end = start + DAY_MS;
  return periods.some((p) => p.started_at < end && (p.ended_at ?? now) > start);
}
