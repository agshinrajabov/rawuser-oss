/**
 * The proof engine's admin endpoints (docs/specs/proof-engine.md, G).
 *
 *   GET  /admin/analytics/lift?customer_id=      customer-scoped; `checks` only for a superadmin
 *   GET  /admin/customers/holdout?customer_id=   superadmin: the control and its dialog numbers
 *   POST /admin/customers/holdout                superadmin: { customer_id, percent: 0|10|20|50 }
 *   POST /admin/proof/test                       customer-scoped: { customer_id, action: "start"|"stop", anyway? }
 *   GET  /admin/analytics/weekly?customer_id=    superadmin: the Monday draft, never sent by code
 *   POST /admin/proof/backfill                   superadmin: { customer_id, what: "bodies"|"outcomes" }
 *
 * Reads exposure_outcomes, holdout_tests and conversion_targets of one
 * customer; never events, never a marker. The superadmin gates live in
 * routes.ts.
 */

import {
  CUSTOMER_TEST_PERCENT,
  type CustomerTestRefusal,
  type CustomerTestResult,
  HOLDOUT_CHOICES,
  type HoldoutControl,
  type HoldoutOption,
  type HoldoutSetResult,
  type TestEndReason,
  type TestStartedBy,
} from "@rawuser/shared";
import { backfillExposureOutcomes, dayOf } from "../cron/exposure-rollup.ts";
import { operatorName } from "../install-config.ts";
import { TARGET_LIFT, WEEKS_PER_MONTH, readableLift } from "../lib/lift.ts";
import {
  HOLDOUT_SETTLE_MS,
  baselineOf,
  buildLiftReport,
  estimateFor,
  loadReportInput,
} from "../lib/proof-report.ts";
import { buildWeeklyDraft, weekCut } from "../lib/proof-weekly.ts";
import { backfillBodies } from "../lib/publish-version.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { writeVisitorBundle } from "./onboard.ts";
import { requireCustomerScope } from "./scope.ts";

export { HOLDOUT_SETTLE_MS };
const DAY_MS = 24 * 60 * 60 * 1000;

async function customerExists(env: AdminEnv, customerId: string) {
  return env.DB.prepare(
    "SELECT id, domain, holdout_percent, holdout_since FROM customers WHERE id = ?",
  )
    .bind(customerId)
    .first<{
      id: string;
      domain: string;
      holdout_percent: number | null;
      holdout_since: number | null;
    }>();
}

export async function handleLiftReport(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const customerId = new URL(request.url).searchParams.get("customer_id");
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const report = buildLiftReport(
    await loadReportInput(env.DB, customerId, Date.now(), user.role === "superadmin"),
  );
  return jsonWithCors(report, env, 200);
}

export async function handleHoldoutGet(request: Request, env: AdminEnv): Promise<Response> {
  const customerId = new URL(request.url).searchParams.get("customer_id");
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const customer = await customerExists(env, customerId);
  if (!customer) return jsonWithCors({ error: "Customer not found" }, env, 404);
  const now = Date.now();
  const today = Date.parse(`${dayOf(now)}T00:00:00Z`);
  const from = dayOf(today - 30 * DAY_MS);
  const to = dayOf(today - DAY_MS);
  // The loader covers at least the last 30 closed days.
  const input = await loadReportInput(env.DB, customerId, now, true);
  const tests = input.tests;
  const report = buildLiftReport(input);
  const base = baselineOf(input.outcomes, from, to);
  const options: HoldoutOption[] = HOLDOUT_CHOICES.filter((p) => p > 0).map((percent) => {
    const est = estimateFor(base, percent);
    const givenUp = est.eligible_per_month * (percent / 100);
    return {
      percent,
      weeks: est.weeks,
      visits_given_up_per_month: Math.round(givenUp),
      clicks_given_up_per_month: Math.round(givenUp * base.rate * TARGET_LIFT),
      readable_lift_8w: readableLift(
        base.rate,
        percent / 100,
        est.eligible_per_month * (8 / WEEKS_PER_MONTH),
      ),
    };
  });
  const running = [...tests].reverse().find((t) => t.ended_at === null) ?? null;
  const body: HoldoutControl = {
    customer_id: customerId,
    stored_percent: customer.holdout_percent,
    since: customer.holdout_since,
    choices: HOLDOUT_CHOICES,
    running: running
      ? {
          id: running.id,
          percent: running.percent,
          started_at: running.started_at,
          read_date: report.test?.id === running.id ? report.test.read_date : running.read_date,
          read_date_fixed: running.read_date !== null,
          started_by: running.started_by ?? null,
          started_actor: running.started_actor ?? null,
        }
      : null,
    history: tests.map((t) => ({
      id: t.id,
      percent: t.percent,
      started_at: t.started_at,
      ended_at: t.ended_at,
      read_date: t.read_date,
      started_by: t.started_by ?? null,
      started_actor: t.started_actor ?? null,
      end_reason: t.end_reason ?? null,
      ended_actor: t.ended_actor ?? null,
    })),
    basis: {
      eligible_per_month: Math.round((base.eligible_visits / base.days) * 30),
      baseline_rate: base.rate,
      rate_source: base.rate_source,
      days: base.days,
    },
    options,
  };
  return jsonWithCors(body, env, 200);
}

/**
 * Who makes a holdout change (migration 0036, privacy review condition 1):
 * - by: what starts a new period (go_live, customer, superadmin) or, for
 *   an automatic end, "system";
 * - actor: the session's account id, "superadmin" for a superadmin
 *   session, "system" for the hourly checks;
 * - endReason: why the running period ends; by default new_test when
 *   another percent opens a period, else the stopper (customer or
 *   superadmin).
 */
export interface HoldoutChange {
  by: TestStartedBy | "system";
  actor: string;
  endReason?: TestEndReason;
}

/** The actor a session writes: its account id, or "superadmin". */
export function actorOf(user: SessionUser): string {
  return user.role === "superadmin" ? "superadmin" : user.id;
}

const SUPERADMIN_CHANGE: HoldoutChange = { by: "superadmin", actor: "superadmin" };

/**
 * Set the customer's holdout. Closes the running test period, opens a new
 * one when the percent is above 0 (reading from the change plus 10
 * minutes), writes customers.holdout_percent and holdout_since, and
 * rewrites the visitor bundle so the edge has `h` without a database read.
 * The same percent again changes nothing. Every period records who started
 * it and who ended it and why (`change`).
 */
export async function setHoldout(
  env: Pick<AdminEnv, "DB" | "VARIANTS">,
  customerId: string,
  percent: number,
  now = Date.now(),
  change: HoldoutChange = SUPERADMIN_CHANGE,
): Promise<HoldoutSetResult> {
  const running = await env.DB.prepare(
    "SELECT id, percent FROM holdout_tests WHERE customer_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
  )
    .bind(customerId)
    .first<{ id: string; percent: number }>();
  if (running && running.percent === percent) {
    // Already running at this percent: nothing to change, the test goes on.
    const c = await env.DB.prepare("SELECT holdout_since FROM customers WHERE id = ?")
      .bind(customerId)
      .first<{ holdout_since: number | null }>();
    return {
      ok: true,
      customer_id: customerId,
      percent,
      since: c?.holdout_since ?? null,
      test_id: running.id,
      ended_test_id: null,
    };
  }
  const since = percent > 0 ? now + HOLDOUT_SETTLE_MS : null;
  const testId = percent > 0 ? `ht_${crypto.randomUUID().replace(/-/g, "")}` : null;
  if (running) {
    const endReason: TestEndReason =
      change.endReason ??
      (percent > 0 ? "new_test" : change.by === "customer" ? "customer" : "superadmin");
    await env.DB.prepare(
      "UPDATE holdout_tests SET ended_at = ?, end_reason = ?, ended_actor = ? WHERE id = ?",
    )
      .bind(now, endReason, change.actor, running.id)
      .run();
  }
  if (testId && since !== null) {
    const startedBy: TestStartedBy = change.by === "system" ? "superadmin" : change.by;
    await env.DB.prepare(
      `INSERT INTO holdout_tests (id, customer_id, percent, started_at, created_at,
         started_by, started_actor) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(testId, customerId, percent, since, now, startedBy, change.actor)
      .run();
  }
  await env.DB.prepare("UPDATE customers SET holdout_percent = ?, holdout_since = ? WHERE id = ?")
    .bind(percent, since, customerId)
    .run();
  await writeVisitorBundle(env, customerId);
  return {
    ok: true,
    customer_id: customerId,
    percent,
    since,
    test_id: testId,
    ended_test_id: running?.id ?? null,
  };
}

export async function handleHoldoutSet(request: Request, env: AdminEnv): Promise<Response> {
  let body: { customer_id?: unknown; percent?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  if (typeof body.customer_id !== "string" || body.customer_id === "") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const percent = body.percent;
  if (typeof percent !== "number" || !(HOLDOUT_CHOICES as readonly number[]).includes(percent)) {
    return jsonWithCors({ error: "percent must be 0, 10, 20 or 50" }, env, 400);
  }
  if (!(await customerExists(env, body.customer_id))) {
    return jsonWithCors({ error: "Customer not found" }, env, 404);
  }
  return jsonWithCors(await setHoldout(env, body.customer_id, percent), env, 200);
}

/** The one plain sentence per refused start (docs/specs/proof-engine.md, "The customer's own test"). */
export const START_REFUSALS = {
  no_button: "Choose the button to count first.",
  too_little_traffic: "Too little traffic to read within a year.",
  running: "A test is already running.",
} as const;

/**
 * The customer's own start and stop. Start sets 20% and nothing else, and
 * only when the report's `start` says it may (a counted button, a read within
 * a year, no other test running); the same 20% again is no change. Stop sets
 * 0 on any running test. Both through setHoldout, the superadmin control's
 * write path, so the test period, the read date rules and the bundle's `h`
 * are the same.
 */
export async function handleCustomerTest(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  let body: { customer_id?: unknown; action?: unknown; anyway?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  const customerId = typeof body.customer_id === "string" ? body.customer_id : "";
  const scope = requireCustomerScope(user, customerId || null);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  if (body.action !== "start" && body.action !== "stop") {
    return jsonWithCors({ error: 'action must be "start" or "stop"' }, env, 400);
  }
  if (!(await customerExists(env, customerId))) {
    return jsonWithCors({ error: "Customer not found" }, env, 404);
  }
  const superadmin = user.role === "superadmin";
  const now = Date.now();
  if (body.action === "start") {
    const before = buildLiftReport(await loadReportInput(env.DB, customerId, now, superadmin));
    const start = before.start;
    const runningAtCustomerPercent =
      start?.blocked === "running" && before.test?.percent === CUSTOMER_TEST_PERCENT;
    // "Start anyway" (measure-at-go-live.md §7, too little traffic): the
    // customer's own choice passes the traffic block and only that one.
    const anyway = body.anyway === true && start?.blocked === "too_little_traffic";
    if (start && start.blocked !== null && !runningAtCustomerPercent && !anyway) {
      const refusal: CustomerTestRefusal = {
        error: START_REFUSALS[start.blocked],
        reason: start.blocked,
      };
      return jsonWithCors(refusal, env, 409);
    }
  }
  const set = await setHoldout(
    env,
    customerId,
    body.action === "start" ? CUSTOMER_TEST_PERCENT : 0,
    now,
    { by: superadmin ? "superadmin" : "customer", actor: actorOf(user) },
  );
  const result: CustomerTestResult = {
    ...set,
    report: buildLiftReport(await loadReportInput(env.DB, customerId, now, superadmin)),
  };
  return jsonWithCors(result, env, 200);
}

export async function handleWeeklyDraft(request: Request, env: AdminEnv): Promise<Response> {
  const customerId = new URL(request.url).searchParams.get("customer_id");
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const customer = await customerExists(env, customerId);
  if (!customer) return jsonWithCors({ error: "Customer not found" }, env, 404);
  const { asOf, weekEnding } = weekCut(Date.now());
  const report = buildLiftReport(await loadReportInput(env.DB, customerId, asOf, true));
  return jsonWithCors(
    buildWeeklyDraft(report, customer.domain, weekEnding, env.DASHBOARD_ORIGIN, operatorName(env)),
    env,
    200,
  );
}

export async function handleProofBackfill(request: Request, env: AdminEnv): Promise<Response> {
  let body: { customer_id?: unknown; what?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  if (typeof body.customer_id !== "string" || body.customer_id === "") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  if (!(await customerExists(env, body.customer_id))) {
    return jsonWithCors({ error: "Customer not found" }, env, 404);
  }
  if (body.what === "bodies") {
    return jsonWithCors({ ok: true, ...(await backfillBodies(env, body.customer_id)) }, env, 200);
  }
  if (body.what === "outcomes") {
    return jsonWithCors(
      { ok: true, ...(await backfillExposureOutcomes(env, body.customer_id)) },
      env,
      200,
    );
  }
  return jsonWithCors({ error: 'what must be "bodies" or "outcomes"' }, env, 400);
}
