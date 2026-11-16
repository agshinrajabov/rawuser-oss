/**
 * The proof engine's hourly checks (docs/specs/proof-engine.md, D and E),
 * after the exposure rollup:
 *
 * - the read date is fixed once 14 whole days of a test have closed, from
 *   the test's own numbers, and never moves again;
 * - `holdout-split`: the split check fails (p below 0.001);
 * - `lift-negative`: the read date has come and the range is below zero,
 *   once per test;
 * - `rollup-missing`: a closed day with marker rows has no rollup three
 *   days after it closed;
 * - a test that go live started ends by itself (docs/specs/measure-at-go-live.md,
 *   privacy review condition 4): on its read date (`read_date`), on day 14 when
 *   the fixed read date is more than 52 weeks after its first day or no
 *   date can be fixed at all (`low_traffic`, with one `test-low-traffic`
 *   line: code, customer, link), and 365 days after it started in any case
 *   (`limit`). Through setHoldout(0), actor `system`. A test someone started
 *   by hand is never ended here, and nothing here ever starts a test.
 *
 * Every alert carries the code, the customer id and a dashboard link only
 * (privacy review condition 7). Test customers (plan 'test') never raise one.
 * The Monday run tells the channel which weekly drafts are ready.
 */

import { GO_LIVE_TEST_LIMIT_DAYS, MAX_READ_WEEKS, type TestEndReason } from "@rawuser/shared";
import { setHoldout } from "../admin/proof.ts";
import { proofAlertKey, proofAlertText } from "../lib/proof-alerts.ts";
import {
  type ReportPeriod,
  buildLiftReport,
  loadReportInput,
  periodOf,
  readDateOf,
} from "../lib/proof-report.ts";
import { weekCut } from "../lib/proof-weekly.ts";
import { testPeriods, testRanOn } from "../lib/test-days.ts";
import { DAY_MS, EXPOSURE_TYPES, MARKER_KEEP_MS, dayOf, dayStart } from "./exposure-rollup.ts";
import { sendOpsAlert } from "./ops-heartbeat.ts";

export interface ProofChecksEnv {
  DB: D1Database;
  VARIANTS: KVNamespace;
  ALERT_WEBHOOK_URL?: string;
  DASHBOARD_ORIGIN?: string;
}

export interface ProofChecksResult {
  fixed: string[];
  alerts: string[];
  /** Automatic ends of go-live tests, `reason:customer`. */
  ended: string[];
}

/** A closed day with no rollup this long after it closed raises rollup-missing. */
const ROLLUP_GRACE_DAYS = 3;
const NEGATIVE_TTL_S = 90 * 24 * 3600;
const DAY_S = 24 * 3600;

export async function runProofChecks(
  env: ProofChecksEnv,
  now = Date.now(),
): Promise<ProofChecksResult> {
  const out: ProofChecksResult = { fixed: [], alerts: [], ended: [] };
  const customers = await env.DB.prepare(
    "SELECT id, plan FROM customers WHERE status = 'active'",
  ).all<{ id: string; plan: string | null }>();
  for (const c of customers.results ?? []) {
    try {
      await checkCustomer(env, c.id, c.plan === "test", now, out);
    } catch (e) {
      console.error(
        `[proof-checks] failed: customer=${c.id}`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  return out;
}

async function alertOnce(
  env: ProofChecksEnv,
  out: ProofChecksResult,
  code: "holdout-split" | "lift-negative" | "rollup-missing" | "test-low-traffic",
  customerId: string,
  ttl: number,
  scope?: string,
) {
  const r = await sendOpsAlert(
    env,
    proofAlertKey(code, customerId, scope),
    proofAlertText(code, customerId, env.DASHBOARD_ORIGIN),
    ttl,
  );
  if (r === "sent") out.alerts.push(`${code}:${customerId}`);
}

async function checkCustomer(
  env: ProofChecksEnv,
  customerId: string,
  isTest: boolean,
  now: number,
  out: ProofChecksResult,
): Promise<void> {
  // rollup-missing: closed days with markers, three days past, no rollup.
  const lastDue = dayStart(dayOf(now)) - ROLLUP_GRACE_DAYS * DAY_MS;
  const [marked, rolled] = await Promise.all([
    env.DB.prepare(
      `SELECT DISTINCT date(ts / 1000, 'unixepoch') AS day FROM events
       WHERE customer_id = ? AND visit IS NOT NULL AND event_type IN ${EXPOSURE_TYPES}
         AND ts >= ? AND ts < ?`,
    )
      .bind(customerId, now - MARKER_KEEP_MS, lastDue)
      .all<{ day: string }>(),
    env.DB.prepare("SELECT day FROM exposure_rollup_days WHERE customer_id = ?")
      .bind(customerId)
      .all<{ day: string }>(),
  ]);
  const have = new Set((rolled.results ?? []).map((r) => r.day));
  // Only a day a test ran on needs its rollup (lib/test-days.ts).
  const periods = await testPeriods(env.DB, customerId);
  const missing = (marked.results ?? []).filter(
    (m) => !have.has(m.day) && testRanOn(m.day, periods, now),
  );
  if (missing.length > 0 && !isTest) {
    await alertOnce(env, out, "rollup-missing", customerId, DAY_S);
  }

  // The running test, if any.
  const input = await loadReportInput(env.DB, customerId, now, true);
  const period = periodOf(input.tests, now);
  if (!period || period.test.ended_at !== null) return;

  const read = readDateOf(period, input.outcomes);
  if (read.fixable && read.readDate) {
    const r = await env.DB.prepare(
      "UPDATE holdout_tests SET read_date = ?, read_fixed_at = ? WHERE id = ? AND read_fixed_at IS NULL",
    )
      .bind(read.readDate, now, period.test.id)
      .run();
    if ((r.meta as { changes?: number } | undefined)?.changes !== 0) out.fixed.push(customerId);
    period.test.read_date = read.readDate;
    period.test.read_fixed_at = now;
  }

  const end = goLiveEnd(period, read.fixable && read.readDate === null, now);
  if (end) {
    await setHoldout(env, customerId, 0, now, { by: "system", actor: "system", endReason: end });
    out.ended.push(`${end}:${customerId}`);
    if (end === "low_traffic" && !isTest) {
      await alertOnce(env, out, "test-low-traffic", customerId, NEGATIVE_TTL_S, period.test.id);
    }
    return;
  }

  if (isTest) return;
  const report = buildLiftReport(input);
  if (report.checks && !report.checks.split_ok) {
    await alertOnce(env, out, "holdout-split", customerId, DAY_S, period.test.id);
  }
  if (report.state === "result" && report.verdict === "negative") {
    await alertOnce(env, out, "lift-negative", customerId, NEGATIVE_TTL_S, period.test.id);
  }
}

/**
 * Whether a running go-live test ends now, and why (privacy review condition 4).
 * `noDate`: 14 days have closed and no read date could be fixed (no
 * eligible visits), which reads as never, so as too little traffic.
 * Only tests with started_by 'go_live'; every other test runs until
 * someone stops it.
 */
export function goLiveEnd(
  period: ReportPeriod,
  noDate: boolean,
  now: number,
): TestEndReason | null {
  const { test, firstDay } = period;
  if (test.started_by !== "go_live" || test.ended_at !== null) return null;
  const today = dayOf(now);
  if (test.read_date !== null && test.read_fixed_at !== null) {
    if (test.read_date <= today) return "read_date";
    const weeks = (dayStart(test.read_date) - dayStart(firstDay)) / DAY_MS / 7;
    if (weeks > MAX_READ_WEEKS) return "low_traffic";
  } else if (noDate) {
    return "low_traffic";
  }
  if (now - test.started_at >= GO_LIVE_TEST_LIMIT_DAYS * DAY_MS) return "limit";
  return null;
}

/**
 * Monday: one line per customer whose draft is ready (a test running, or
 * one that ended within the last week). The draft itself stays on the
 * dashboard; the line carries the code, the customer and the link.
 */
export async function runWeeklyDraftNotices(
  env: ProofChecksEnv,
  now = Date.now(),
): Promise<string[]> {
  const { weekEnding } = weekCut(now);
  const rows = await env.DB.prepare(
    `SELECT DISTINCT t.customer_id AS id FROM holdout_tests t
     JOIN customers c ON c.id = t.customer_id
     WHERE c.status = 'active' AND (c.plan IS NULL OR c.plan != 'test')
       AND (t.ended_at IS NULL OR t.ended_at >= ?)`,
  )
    .bind(now - 7 * DAY_MS)
    .all<{ id: string }>();
  const sent: string[] = [];
  for (const { id } of rows.results ?? []) {
    const r = await sendOpsAlert(
      env,
      proofAlertKey("weekly-draft", id, weekEnding),
      proofAlertText("weekly-draft", id, env.DASHBOARD_ORIGIN),
      7 * DAY_S,
    );
    if (r === "sent") sent.push(id);
  }
  return sent;
}
