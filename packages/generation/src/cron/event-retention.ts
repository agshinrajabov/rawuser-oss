/**
 * Raw event retention (docs/specs/security-hardening.md §2.5, privacy review
 * condition 5): event rows older than RAW_EVENT_RETENTION_DAYS are deleted
 * in the 6-hour branch; the daily rollups (exposure_outcomes, source_days,
 * exposure_rollup_days, analytics_aggregates, and a sensitive customer's
 * page_days) stay for the account's life. page_days holds no marker and no
 * time, so this sweep has nothing to take
 * from it; it goes with the customer (the catalog in admin/customer-data.ts).
 *
 * Off until the founder sets the variable: unset, empty or not a whole
 * number means nothing is deleted. Under 61 days is refused (off, one log
 * line), because the aggregator reads 60 days of raw rows (the 30-day
 * window and the period before it). The decided value is 90.
 *
 * Per customer on the (customer_id, ts) index, 5,000 rows per statement, at
 * most MAX_STATEMENTS statements a run; what is left goes in the next run.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
/** The aggregator's widest read (30-day window plus the period before). */
export const MIN_RETENTION_DAYS = 61;
export const RETENTION_CHUNK = 5000;
export const MAX_STATEMENTS = 50;

export interface RetentionEnv {
  DB: D1Database;
  RAW_EVENT_RETENTION_DAYS?: string;
}

/** The retention in days, or null when the sweep is off. */
export function retentionDays(env: { RAW_EVENT_RETENTION_DAYS?: string }): number | null {
  const raw = (env.RAW_EVENT_RETENTION_DAYS ?? "").trim();
  if (raw === "") return null;
  if (!/^\d+$/.test(raw)) {
    console.error("[generation/6h] RAW_EVENT_RETENTION_DAYS is not a whole number: retention off");
    return null;
  }
  const days = Number(raw);
  if (days < MIN_RETENTION_DAYS) {
    console.error(
      `[generation/6h] RAW_EVENT_RETENTION_DAYS under ${MIN_RETENTION_DAYS}: retention off`,
    );
    return null;
  }
  return days;
}

export interface RetentionResult {
  /** null when the sweep is off. */
  days: number | null;
  deleted: number;
  /** True when the statement cap stopped the run with rows left. */
  capped: boolean;
}

export async function runEventRetention(
  env: RetentionEnv,
  now: number,
  opts: { chunk?: number; maxStatements?: number } = {},
): Promise<RetentionResult> {
  const days = retentionDays(env);
  if (days === null) return { days: null, deleted: 0, capped: false };
  const chunk = opts.chunk ?? RETENTION_CHUNK;
  let left = opts.maxStatements ?? MAX_STATEMENTS;
  const cutoff = now - days * DAY_MS;

  const { results } = await env.DB.prepare("SELECT id FROM customers ORDER BY id").all<{
    id: string;
  }>();
  let deleted = 0;
  for (const { id } of results ?? []) {
    for (;;) {
      if (left <= 0) return { days, deleted, capped: true };
      left--;
      const r = await env.DB.prepare(
        `DELETE FROM events WHERE rowid IN (
           SELECT rowid FROM events WHERE customer_id = ? AND ts < ? LIMIT ?)`,
      )
        .bind(id, cutoff, chunk)
        .run();
      const n = Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0);
      deleted += n;
      if (n < chunk) break;
    }
  }
  return { days, deleted, capped: false };
}

/**
 * A shorter life for named customers' event rows (docs/specs/demo-page.md,
 * privacy review condition 2): the public demo's rows are deleted after
 * SHORT_RETENTION_DAYS, in the same 6-hour branch. SHORT_RETENTION_CUSTOMERS
 * is a comma list of customer ids; unset or empty means nothing is deleted.
 * Only those ids are ever touched. Daily rollups stay, as above.
 */
export const SHORT_RETENTION_DAYS = 31;
const CUSTOMER_ID = /^[a-z0-9-]{1,50}$/;

export interface ShortRetentionEnv {
  DB: D1Database;
  SHORT_RETENTION_CUSTOMERS?: string;
}

/** The ids whose rows live SHORT_RETENTION_DAYS; anything not id-shaped is dropped. */
export function shortRetentionCustomers(env: { SHORT_RETENTION_CUSTOMERS?: string }): string[] {
  return (env.SHORT_RETENTION_CUSTOMERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => CUSTOMER_ID.test(s));
}

export async function runShortRetention(
  env: ShortRetentionEnv,
  now: number,
  opts: { chunk?: number; maxStatements?: number } = {},
): Promise<{ ids: string[]; deleted: number; capped: boolean }> {
  const ids = shortRetentionCustomers(env);
  const chunk = opts.chunk ?? RETENTION_CHUNK;
  let left = opts.maxStatements ?? MAX_STATEMENTS;
  const cutoff = now - SHORT_RETENTION_DAYS * DAY_MS;
  let deleted = 0;
  for (const id of ids) {
    for (;;) {
      if (left <= 0) return { ids, deleted, capped: true };
      left--;
      const r = await env.DB.prepare(
        `DELETE FROM events WHERE rowid IN (
           SELECT rowid FROM events WHERE customer_id = ? AND ts < ? LIMIT ?)`,
      )
        .bind(id, cutoff, chunk)
        .run();
      const n = Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0);
      deleted += n;
      if (n < chunk) break;
    }
  }
  return { ids, deleted, capped: false };
}
