/**
 * Ops heartbeat: the alarm system for a silent-failure architecture (A2).
 *
 * Rawuser's failure mode is invisible by design: the edge always falls back
 * gracefully, so a visitor never sees breakage: which also means nobody
 * NOTICES breakage until someone opens the dashboard. Every July-2026
 * incident (the model account's credits exhausted, cron dying mid-run) was
 * found by a human manually looking. This module runs on the hourly cron and turns
 * those silences into notifications.
 *
 * Checks:
 *   1. Edge /health reachable and ok  → "the visitor path is up"
 *   2. variants error share per customer → "generation is failing
 *      repeatedly". Only provider-shaped failures (timeouts, empty or broken
 *      answers) count; a version the copy checks refused ("lint: …") keeps
 *      its earlier text and is retried, which is the gate working, so those
 *      go into one summary a day instead (2026-09-30: a rewrite of 450
 *      versions sent eight error-spike alerts that were all the gate).
 *      Since 2026-10-12 the summary also says, per customer, the rows
 *      refused of the rows written and the parts left as built of the parts
 *      written, with the rules (lib/lint-shares.ts), and is sent for parts
 *      left as built alone when nothing is refused.
 *   3. Billing/auth failure sniff     → CRITICAL: the exact July pattern
 *      (credits exhausted) that silently blackholes ALL generation.
 *   4. The writing service answers    → the model endpoint's chat route
 *      hung for an hour on 2026-09-14 while its model list answered; every
 *      write timed out at 45 s and only the dashboard's "to retry later"
 *      said anything. One tiny completion per hour on the writer's model;
 *      an alert when it does not answer, one "answering again" when it does
 *      after an alert. Then the fallback model, and the spare route when
 *      the fallback is silent. The targets come from model-config.ts.
 *   5. Parts the live page no longer has (manifest_health).
 *   6. Snippet issues (docs/specs/snippet-issues.md): per customer and code
 *      over the last 24 h, the page loads that reported it against the
 *      loads; at 5% and 20 loads, one line per customer and code, sent
 *      again only when it is news (checkSnippetIssues). `late_tag` goes to
 *      the Monday message instead.
 *      A customer under 200 loads a day is looked at over 72 h with a floor
 *      of 8 loads, the share unchanged (2026-10-12: the pilot, 70 loads a day,
 *      failed one /select in ten and never reached 20).
 *
 * Notification: ALERT_WEBHOOK_URL (optional secret). Two forms supported:
 *   - api.telegram.org bot URL (…/sendMessage?chat_id=…) → GET with &text=
 *   - anything else (Slack/Discord/generic) → POST JSON {text, content}
 * Without a webhook the heartbeat still console.errors (Cloudflare logs) so
 * `wrangler tail` shows it.
 *
 * Dedup: one alert per type per 6h via KV TTL keys (ops:alert:<type>); the
 * daily lint-daily per 24 h; snippet-issue:<customer>:<code> by its marker.
 * Privacy: reads only operational counters and error text: no visitor data.
 */

import { type InstallEnv, edgeHealthUrl } from "../install-config.ts";
import {
  type RefusedRowLike,
  customerOfRow,
  isServedRow,
  lintShareLines,
  lintShares,
  loadServedByCustomer,
  rulesOfReason,
} from "../lib/lint-shares.ts";
import {
  DAILY_LINE_EXCLUDED,
  ISSUE_CODES,
  ISSUE_MARKER_TTL_S,
  confirmedPages,
  dueIssues,
  issueAlertLine,
  issueBackUnder,
  issueBackUnderLine,
  issueLineDecision,
  readIssueMarker,
} from "../lib/snippet-issues.ts";
import {
  type ModelEnv,
  chatUrl,
  extraBody,
  extraInput,
  fallbackIdFor,
  maxTokensField,
  modelConfigured,
  modelIdFor,
  modelRoute,
  spareId,
} from "../model-config.ts";

export interface HeartbeatEnv
  extends ModelEnv,
    Pick<InstallEnv, "EDGE_HEALTH_URL" | "EDGE_ORIGIN"> {
  DB: D1Database;
  VARIANTS: KVNamespace;
  /** Optional webhook for notifications; log-only when absent. */
  ALERT_WEBHOOK_URL?: string;
  // EDGE_HEALTH_URL: the edge's health endpoint; unset, EDGE_ORIGIN + /health;
  // with neither, the edge is not checked (install-config.ts, edgeHealthUrl).
  // The model configuration (ModelEnv): the writing service is pinged only
  // on the endpoint route, the spare route only when the fallback is silent.
}

/** A tiny completion should answer well inside this; the orchestrator gives a real one 45 s. */
const WRITING_SERVICE_TIMEOUT_MS = 20_000;
const WRITING_SERVICE_ALERT = "writing-service";
/**
 * Customers on plan "test" (the lab, the Webflow test page, a Lovable test site) never
 * raise a customer alert, so a pilot's alert is not lost among them
 * (2026-10-02, the founder's call). Account-wide checks still run.
 */
/** Test customers and ended audits (ai-traffic-audit.md §3.8) raise no alert. */
const NOT_TEST =
  "customer_id NOT IN (SELECT id FROM customers WHERE plan = 'test' OR status = 'ended')";
/** The fallback model stopped being a separate model (rerouted or silent). */
const WRITING_FALLBACK_ALERT = "writing-fallback";

/**
 * Hourly checks in a row the writing service or its fallback must miss
 * before a line goes out (2026-10-18): one slow minute of the fallback
 * model sent a "fallback is down" line while the primary wrote as usual,
 * and the next hour said it was back. Two misses in a row is an outage worth a look.
 */
const WRITING_MISSES_TO_ALERT = 2;
/** A miss counts toward the next hour's only: longer than one pass, shorter than three. */
const WRITING_MISS_TTL_S = 150 * 60;

/** Alert once per type per this window (seconds). */
const DEDUP_TTL_S = 6 * 3600;

/** A customer's provider failures alert at this many rows and this share of its versions. */
const ERROR_SPIKE_MIN = 5;
const ERROR_SPIKE_SHARE = 0.2;
/** The copy checks' refusals are summarised once a day. */
const LINT_SUMMARY = "lint-daily";
const DAY_S = 24 * 3600;

/** error_reason substrings that mean "generation is dead, not flaky". */
const CRITICAL_REASON_PATTERNS = ["credit balance", "authentication", "invalid x-api-key", "401"];

/**
 * How many refused rows still serve an earlier body. A row whose last write
 * was published carries its body id; an older one (written before the body
 * ids) is looked up in KV. A new customer's refused row has neither, and the
 * edge serves the nearest version instead (measure-lab, 2026-10-05: the
 * summary said "keep their earlier text" of five rows that had none).
 */
async function countKeptBodies(
  env: HeartbeatEnv,
  rows: ReadonlyArray<{ kv_key?: string | null; body_id?: string | null }>,
): Promise<number> {
  let kept = 0;
  for (const r of rows) {
    if (r.body_id) {
      kept++;
      continue;
    }
    if (!r.kv_key) continue;
    try {
      if ((await env.VARIANTS.get(r.kv_key)) !== null) kept++;
    } catch {
      // Unknown: counted as none, the safer reading for a new customer.
    }
  }
  return kept;
}

/**
 * The daily summary of the copy checks' refusals: counts and rule names only,
 * one or two short lines, no dashes. The lines per customer that follow it
 * (lib/lint-shares.ts) add a customer id to the same shape: no path, no text.
 */
export function lintSummaryText(total: number, kept: number, most: string): string {
  const none = total - kept;
  const v = (n: number) => `${n} version${n === 1 ? "" : "s"}`;
  const tail = most ? `\nMost: ${most}.` : "";
  // Nothing refused: the summary is sent for the parts left as built alone.
  if (total === 0) return "No version is refused by the copy checks.";
  if (none === 0) {
    return `${v(total)} refused by the copy checks keep their earlier text and are retried every 6 hours. Nothing to do unless it grows.${tail}`;
  }
  if (kept === 0) {
    return `${v(total)} refused by the copy checks have no earlier text yet, so visitors get the nearest version until a retry passes (every 6 hours).${tail}`;
  }
  return `${v(total)} refused by the copy checks, retried every 6 hours: ${kept} keep${kept === 1 ? "s" : ""} earlier text, ${none} ha${none === 1 ? "s" : "ve"} none yet, so visitors get the nearest version.${tail}`;
}

export interface HeartbeatResult {
  checked: number;
  alerted: string[];
  deduped: string[];
  /** Alerts the channel refused or could not take; no dedupe key was written. */
  failed: string[];
}

export async function runOpsHeartbeat(env: HeartbeatEnv): Promise<HeartbeatResult> {
  const result: HeartbeatResult = { checked: 0, alerted: [], deduped: [], failed: [] };

  // 1. Edge health: the visitor path. Skipped, not failed, when the install
  // has not said where its edge answers: there is no address to ask, and
  // nobody else's is asked instead.
  const healthUrl = edgeHealthUrl(env);
  if (healthUrl) {
    result.checked++;
    try {
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) {
        await alert(env, result, "edge-health", `Edge /health returned HTTP ${resp.status}.`);
      }
    } catch {
      await alert(env, result, "edge-health", "Edge /health is unreachable (fetch failed).");
    }
  }

  // 2 + 3. Generation error state.
  result.checked++;
  try {
    const rows = await env.DB.prepare(
      `SELECT error_reason, COUNT(*) AS n FROM variants
       WHERE status = 'error' AND COALESCE(error_reason, '') NOT LIKE 'lint:%'
       GROUP BY error_reason ORDER BY n DESC LIMIT 5`,
    ).all<{ error_reason: string | null; n: number }>();
    const groups = rows.results ?? [];

    // 3. Billing/auth sniff: CRITICAL regardless of count, because one such
    // failure means every subsequent generation call is failing identically.
    const critical = groups.find((g) =>
      CRITICAL_REASON_PATTERNS.some((p) => (g.error_reason ?? "").toLowerCase().includes(p)),
    );
    if (critical) {
      await alert(
        env,
        result,
        "billing-auth",
        `CRITICAL: generation failing with billing/auth error (${critical.n}x): "${(critical.error_reason ?? "").slice(0, 160)}". All generation is likely dead until fixed.`,
      );
    }

    // 2. Spike: provider failures at a share of a customer's versions.
    const shares = await env.DB.prepare(
      `SELECT customer_id, COUNT(*) AS total,
         SUM(CASE WHEN status = 'error' AND COALESCE(error_reason, '') NOT LIKE 'lint:%' THEN 1 ELSE 0 END) AS failed
       FROM variants WHERE ${NOT_TEST} GROUP BY customer_id`,
    ).all<{ customer_id: string; total: number; failed: number }>();
    const hit = (shares.results ?? []).filter(
      (c) => c.failed >= ERROR_SPIKE_MIN && c.failed / Math.max(1, c.total) >= ERROR_SPIKE_SHARE,
    );
    if (hit.length > 0) {
      const who = hit.map((c) => `${c.customer_id} ${c.failed} of ${c.total}`).join(", ");
      const top = groups
        .map((g) => `${g.n}x ${(g.error_reason ?? "(reason not recorded)").slice(0, 100)}`)
        .join(" | ");
      await alert(env, result, "error-spike", `Versions failing to write: ${who}. Top: ${top}`);
    }

    // The copy checks' refusals: once a day, as a count and the rules, then
    // per customer the rows refused of the rows written and the parts left
    // as built of the parts written (docs/specs/refused-versions.md).
    const refused = await env.DB.prepare(
      `SELECT customer_id, error_reason, kv_key, body_id FROM variants WHERE status = 'error' AND error_reason LIKE 'lint:%' AND ${NOT_TEST}`,
    ).all<RefusedRowLike & { body_id?: string | null }>();
    const served = await loadServedByCustomer(env.DB);
    // A row of an intent the site no longer serves is never retried: not counted.
    const refusedRows = (refused.results ?? []).filter((r) => {
      const id = customerOfRow(r);
      return id === null || isServedRow(served, id, r.kv_key);
    });
    const built = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM variants WHERE status IN ('ready', 'stale') AND lint_flags LIKE '%part-as-built:%' AND ${NOT_TEST}`,
    ).first<{ n: number }>();
    if (refusedRows.length > 0 || Number(built?.n ?? 0) > 0) {
      const rules = new Map<string, number>();
      for (const r of refusedRows) {
        for (const rule of rulesOfReason(r.error_reason)) {
          rules.set(rule, (rules.get(rule) ?? 0) + 1);
        }
      }
      const most = [...rules.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([rule, n]) => `${rule} ${n}`)
        .join(", ");
      // The shares read every written row and count the parts of every body:
      // only on the hour the daily line is really sent.
      let lines = "";
      if (await alertDue(env, LINT_SUMMARY)) {
        const kept = await countKeptBodies(env, refusedRows);
        try {
          lines = lintShareLines(await lintShares(env.DB, refusedRows, served));
        } catch (e) {
          console.error(
            "[ops-heartbeat] lint shares failed:",
            e instanceof Error ? e.message : String(e),
          );
        }
        await alert(
          env,
          result,
          LINT_SUMMARY,
          `${lintSummaryText(refusedRows.length, kept, most)}${lines}`,
          DAY_S,
        );
      } else {
        result.deduped.push(LINT_SUMMARY);
      }
    }
  } catch (e) {
    // The heartbeat itself must never take the cron down.
    console.error("[ops-heartbeat] DB check failed:", e instanceof Error ? e.message : String(e));
  }

  // 5. Parts the live page no longer has (manifest_health, 0027): the
  // snippet skips such a section quietly, so somebody has to say it.
  result.checked++;
  try {
    const rows = await env.DB.prepare(
      `SELECT customer_id, page_path, missing FROM manifest_health WHERE missing != '[]' AND ${NOT_TEST}`,
    ).all<{ customer_id: string; page_path: string; missing: string }>();
    const gone = (rows.results ?? []).map(
      (r) => `${r.customer_id} ${r.page_path}: ${(JSON.parse(r.missing) as string[]).join(", ")}`,
    );
    if (gone.length > 0) {
      await alert(
        env,
        result,
        "parts-missing",
        `The live page no longer has these parts (the section is skipped until the picker fixes it): ${gone.join(" | ")}`,
      );
    }
  } catch (e) {
    console.error(
      "[ops-heartbeat] health check failed:",
      e instanceof Error ? e.message : String(e),
    );
  }

  // 6. Snippet issues: what went wrong on customers' pages (snippet-issues.md).
  result.checked++;
  try {
    await checkSnippetIssues(env, result);
  } catch (e) {
    console.error(
      "[ops-heartbeat] snippet issue check failed:",
      e instanceof Error ? e.message : String(e),
    );
  }

  // 4. The writing service: the endpoint the versions are written on. A
  // worker whose writer is the binding itself has no endpoint to ping.
  if (modelRoute(env) === "endpoint" && modelConfigured(env)) {
    result.checked++;
    const problem = await pingWritingService(env);
    const primaryMisses = await missesInARow(env, WRITING_SERVICE_ALERT, problem !== null);
    if (problem && primaryMisses >= WRITING_MISSES_TO_ALERT) {
      await alert(
        env,
        result,
        WRITING_SERVICE_ALERT,
        `The model endpoint is not answering (${problem}). Versions cannot be written until it recovers; visitors keep the versions already in KV. Rewrite loops stop after three failures in a row and the 6-hour cron retries.`,
      );
    } else if (!problem) {
      await clearAlert(
        env,
        result,
        WRITING_SERVICE_ALERT,
        "The model endpoint is answering again.",
      );
    }

    // 4b. The fallback. When the primary model goes silent the writes move
    // to the fallback model, which only helps while it is a model of its
    // own: a provider may answer one id with another model (announced for
    // ours on 2026-09-10).
    const fallbackId = fallbackIdFor(env, "write");
    if (fallbackId !== null) {
      result.checked++;
      const fb = await pingModel(env, fallbackId);
      const rerouted = fb.problem === null && fb.served !== null && fb.served !== fallbackId;
      // A silent fallback leaves the spare route (2026-10-18): the fallback
      // is down only when that is silent too.
      const spare = fb.problem ? await pingSpare(env) : null;
      const fallbackDown = fb.problem !== null && spare !== null;
      // A reroute is a fact of the provider's setup, said at once; silence waits a second hour.
      const fallbackMisses = await missesInARow(env, WRITING_FALLBACK_ALERT, fallbackDown);
      if (fb.problem && !fallbackDown) {
        // The fallback silent, the spare route answers: an outage still gets written. Quiet.
      } else if (fallbackDown && fallbackMisses < WRITING_MISSES_TO_ALERT) {
        // One miss: quiet, and no "back" line either.
      } else if (fallbackDown || rerouted) {
        await alert(
          env,
          result,
          WRITING_FALLBACK_ALERT,
          rerouted
            ? `The model endpoint now answers the fallback model ${fallbackId} with ${fb.served}. The fallback is no longer a separate model: an outage of the primary model will stop writes. Decide on another fallback (MODEL_FALLBACK_ID).`
            : `The fallback model ${fallbackId} is not answering (${fb.problem}) and the spare route ${spare === "off" ? "is off" : `is not answering (${spare})`}. The fallback for an outage of the primary model is down.`,
        );
      } else {
        await clearAlert(
          env,
          result,
          WRITING_FALLBACK_ALERT,
          `The fallback model ${fallbackId} answers as itself again.`,
        );
      }
    }
  }

  return result;
}

/**
 * Per customer: each code's page loads against all loads, over the last
 * 24 h, or the last 72 h for a site under 200 loads a day (`dueIssues`).
 * A line names the share, the count, the most frequent slot and the page
 * only when it is a confirmed manifest page (condition 5). Every query is
 * on the customer's (customer_id, event_type, ts) index; customers without
 * issue rows in the last 24 h cost one indexed lookup. A load the visitor
 * left while /select was on its way (`select_failed` 4) is not a failure
 * and is in no line (lib/snippet-issues.ts).
 *
 * A line is sent again only when it is news (2026-10-13, the founder got
 * the same two lines two days running): the marker under
 * `ops:alert:snippet-issue:{customer}:{code}` keeps the share of the last
 * line and the last pass the code was over the line; `issueLineDecision`
 * sends on a new run, a share up by half, or after seven days ("still, day
 * N"). A code under the line for a day gets one "back under" line and its
 * marker goes. `late_tag` never gets a daily line: it says where the tag
 * sits, which the Pages card already does, and the Monday message carries
 * it once a week (cron/late-tag-weekly.ts).
 */
async function checkSnippetIssues(env: HeartbeatEnv, result: HeartbeatResult): Promise<void> {
  const now = Date.now();
  const customers = await env.DB.prepare(
    "SELECT id FROM customers WHERE plan != 'test' AND status != 'ended'",
  ).all<{
    id: string;
  }>();
  for (const { id } of customers.results ?? []) {
    try {
      const due = (await dueIssues(env.DB, id, now)).filter(
        (d) => !DAILY_LINE_EXCLUDED.has(d.total.code),
      );
      const confirmed = due.length > 0 ? await confirmedPages(env.DB, id) : new Set<string>();
      const over = new Set(due.map((d) => d.total.code));
      for (const { total, hours } of due) {
        const type = `snippet-issue:${id}:${total.code}`;
        const key = `ops:alert:${type}`;
        const marker = readIssueMarker(await env.VARIANTS.get(key));
        const decision = issueLineDecision(marker, total.share, now);
        if (decision.send) {
          const text = `[rawuser ops] ${issueAlertLine(id, total, confirmed, hours, decision.still)}`;
          if (!(await send(env, text))) {
            // Not delivered: the marker stays as it was, the next hour tries again.
            result.failed.push(type);
            continue;
          }
          result.alerted.push(type);
        } else {
          result.deduped.push(type);
        }
        await env.VARIANTS.put(key, JSON.stringify(decision.marker), {
          expirationTtl: ISSUE_MARKER_TTL_S,
        });
      }
      // The codes with a run of lines that are under the line now.
      for (const code of ISSUE_CODES) {
        if (over.has(code) || DAILY_LINE_EXCLUDED.has(code)) continue;
        const type = `snippet-issue:${id}:${code}`;
        const key = `ops:alert:${type}`;
        const marker = readIssueMarker(await env.VARIANTS.get(key));
        if (!issueBackUnder(marker, now)) continue;
        if (!(await send(env, `[rawuser ops] ${issueBackUnderLine(id, code)}`))) {
          result.failed.push(`${type}:recovered`);
          continue;
        }
        await env.VARIANTS.delete(key);
        result.alerted.push(`${type}:recovered`);
      }
    } catch (e) {
      console.error(
        "[ops-heartbeat] snippet issues for one customer failed:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}

/** One tiny completion on the writer's model; null when it answers, else a short reason. */
async function pingWritingService(env: HeartbeatEnv): Promise<string | null> {
  const r = await pingModel(env, modelIdFor(env, "write"));
  return r.problem;
}

/**
 * One tiny run on the spare route (the binding call-model.ts falls back
 * to): null when it answers, else the problem ("off" when the binding or
 * its model is not configured).
 */
async function pingSpare(env: HeartbeatEnv): Promise<string | null> {
  const id = spareId(env);
  if (id === null || !env.AI) return "off";
  let input: Record<string, unknown>;
  try {
    input = {
      max_completion_tokens: 2,
      temperature: 0,
      ...extraInput(env),
      messages: [{ role: "user", content: "Say ok." }],
    };
  } catch (e) {
    // A malformed var: its message holds the var's name, never its value.
    return e instanceof Error ? e.message : "error";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), WRITING_SERVICE_TIMEOUT_MS);
  });
  try {
    const r = await Promise.race([env.AI.run(id, input), timeout]);
    return r === "timeout" ? `no answer in ${WRITING_SERVICE_TIMEOUT_MS / 1000} s` : null;
  } catch (e) {
    return e instanceof Error ? e.name : "error";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One tiny completion against one model id of the endpoint, in the shape
 * generateVariant sends. `served` is the model the answer names, so a silent
 * reroute (the fallback id answered by another model) shows.
 */
async function pingModel(
  env: HeartbeatEnv,
  model: string,
): Promise<{ problem: string | null; served: string | null }> {
  let body: string;
  try {
    body = JSON.stringify({
      [maxTokensField(env)]: 2,
      temperature: 0,
      stream: false,
      ...extraBody(env),
      model,
      messages: [{ role: "user", content: "Say ok." }],
    });
  } catch (e) {
    // A malformed var: its message holds the var's name, never its value.
    return { problem: e instanceof Error ? e.message : "error", served: null };
  }
  try {
    const resp = await fetch(chatUrl(env), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.MODEL_API_KEY}`,
      },
      body,
      signal: AbortSignal.timeout(WRITING_SERVICE_TIMEOUT_MS),
    });
    if (!resp.ok) return { problem: `HTTP ${resp.status}`, served: null };
    let served: string | null = null;
    try {
      const answer = (await resp.json()) as { model?: unknown };
      if (typeof answer.model === "string") served = answer.model;
    } catch {
      // an answer without a readable body still counts as answering
    }
    return { problem: null, served };
  } catch (e) {
    const m = e instanceof Error ? e.name : String(e);
    return {
      problem: m === "TimeoutError" ? `no answer in ${WRITING_SERVICE_TIMEOUT_MS / 1000} s` : m,
      served: null,
    };
  }
}

/**
 * The misses in a row of one check, this one included; a pass resets it.
 * Best effort: a KV that fails counts the miss as enough, so an outage is
 * never kept quiet by a KV fault.
 */
async function missesInARow(env: HeartbeatEnv, type: string, missed: boolean): Promise<number> {
  const key = `ops:miss:${type}`;
  try {
    if (!missed) {
      await env.VARIANTS.delete(key);
      return 0;
    }
    const n = (Number(await env.VARIANTS.get(key)) || 0) + 1;
    await env.VARIANTS.put(key, String(n), { expirationTtl: WRITING_MISS_TTL_S });
    return n;
  } catch {
    return missed ? WRITING_MISSES_TO_ALERT : 0;
  }
}

/** True when no alert of this type went out inside its window (a failed read counts as due). */
async function alertDue(env: HeartbeatEnv, type: string): Promise<boolean> {
  try {
    return (await env.VARIANTS.get(`ops:alert:${type}`)) === null;
  } catch {
    return true;
  }
}

/** After an alert of this type, one recovery message when the check passes again; then the dedup key goes. */
async function clearAlert(
  env: HeartbeatEnv,
  result: HeartbeatResult,
  type: string,
  message: string,
): Promise<void> {
  const key = `ops:alert:${type}`;
  try {
    if ((await env.VARIANTS.get(key)) === null) return;
  } catch {
    return;
  }
  if (!(await send(env, `[rawuser ops] ${type}: ${message}`))) {
    // Not delivered: keep the key, the next pass sends the recovery again.
    result.failed.push(`${type}:recovered`);
    return;
  }
  try {
    await env.VARIANTS.delete(key);
  } catch {
    // Left in place, the next pass tries again.
  }
  result.alerted.push(`${type}:recovered`);
}

/**
 * Sends one deduplicated alert: skip if the same type fired within the TTL,
 * otherwise console.error + webhook (when configured).
 */
async function alert(
  env: HeartbeatEnv,
  result: HeartbeatResult,
  type: string,
  message: string,
  ttl = DEDUP_TTL_S,
): Promise<void> {
  await alertLine(env, result, type, `[rawuser ops] ${type}: ${message}`, ttl);
}

/**
 * One deduplicated line to the ops channel from outside the hourly run (the
 * proof engine's checks, the Monday drafts). Same dedupe
 * keys (ops:alert:<type>) and the same "not delivered, no key" rule.
 */
export async function sendOpsAlert(
  env: Pick<HeartbeatEnv, "VARIANTS" | "ALERT_WEBHOOK_URL">,
  type: string,
  text: string,
  ttl = DEDUP_TTL_S,
): Promise<"sent" | "deduped" | "failed"> {
  const result: HeartbeatResult = { checked: 0, alerted: [], deduped: [], failed: [] };
  await alertLine(env as HeartbeatEnv, result, type, text, ttl);
  return result.alerted.length > 0 ? "sent" : result.deduped.length > 0 ? "deduped" : "failed";
}

/** The dedupe and send behind alert(), with the whole text given. */
async function alertLine(
  env: HeartbeatEnv,
  result: HeartbeatResult,
  type: string,
  text: string,
  ttl: number,
): Promise<void> {
  const key = `ops:alert:${type}`;
  try {
    if ((await env.VARIANTS.get(key)) !== null) {
      result.deduped.push(type);
      return;
    }
  } catch {
    // KV read failure → fail open (send; worst case a duplicate).
  }

  if (!(await send(env, text))) {
    // Not delivered: no dedupe marker, so the next hour tries again.
    result.failed.push(type);
    return;
  }

  try {
    await env.VARIANTS.put(key, String(Date.now()), { expirationTtl: ttl });
  } catch {
    // Dedup-marker write failure is acceptable.
  }
  result.alerted.push(type);
}

/**
 * console.error plus the webhook. True only when the channel took the
 * message; false when the send failed or no webhook is configured, so
 * the caller does not mark an alert as sent that never arrived. Until
 * 2026-10-02 a refused Telegram call (HTTP 400) still wrote the dedupe key,
 * and the first snippet-issue alert vanished without a trace.
 */
async function send(env: HeartbeatEnv, text: string): Promise<boolean> {
  console.error(text);

  if (!env.ALERT_WEBHOOK_URL) {
    // No channel means not delivered: until 2026-10-02 this returned true, and
    // the production worker, which never had the secret, marked every alert
    // as sent while they went to the log only.
    console.error("[ops-heartbeat] ALERT_WEBHOOK_URL is not set; alert not delivered");
    return false;
  }
  try {
    const url = new URL(env.ALERT_WEBHOOK_URL);
    let resp: Response;
    if (url.hostname === "api.telegram.org") {
      url.searchParams.set("text", text);
      resp = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
    } else {
      resp = await fetch(env.ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // text → Slack/generic, content → Discord; both carried.
        body: JSON.stringify({ text, content: text }),
        signal: AbortSignal.timeout(10_000),
      });
    }
    if (!resp.ok) {
      // The status and the channel's own reason, never the URL (it holds the
      // bot token) and never the text.
      let reason = "";
      try {
        const body = (await resp.json()) as { description?: unknown };
        if (typeof body.description === "string") reason = body.description.slice(0, 120);
      } catch {
        // not JSON
      }
      console.error(`[ops-heartbeat] webhook refused: HTTP ${resp.status} ${reason}`.trim());
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      "[ops-heartbeat] webhook send failed:",
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
}
