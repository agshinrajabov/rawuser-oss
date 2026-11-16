/**
 * Rawuser generation worker: offline path.
 *
 * Triggered manually via /regenerate or by cron (see wrangler.toml). Never
 * called from the visitor request path. Reads business DNA from D1, runs
 * generateVariant per (intent, source) tuple, writes variant body to KV and
 * provenance metadata to D1.variants.
 *
 * Auth: /admin/* requires a valid session token in the X-Rawuser-Admin header.
 *       The token is hashed with SHA-256 and looked up in D1 superadmin_sessions.
 *       /regenerate retains the session-based auth path via the /admin layer.
 *       See ADR 0015 for the full auth model.
 *
 * Cron (0 every-6h * * *): scheduled() sweeps expired sessions from D1,
 * keeps every event row and column (ADR 0037: no 31-day purge), rewrites every
 * confirmed customer's hide rules and rich key (sweepHideRules), and builds
 * the keyword lexicons that are due (runKeywordLexiconSweep). Regeneration
 * runs in the five-minute queue.
 */

import { sweepApplications } from "./admin/apply.ts";
import { clearSwitchedOffCountries } from "./admin/country.ts";
import { clearSwitchedOffDirect } from "./admin/direct-insights.ts";
import { handlePublicCapture, sweepHideRules } from "./admin/onboard.ts";
import { deleteOldPilotRequests } from "./admin/pilot-requests.ts";
import { handleAdmin, isAdminPath } from "./admin/routes.ts";
import { runAuditCheck, sweepAuditDeletes } from "./audit/lifecycle.ts";
import { FAILURE_ROW_TTL_MS } from "./auth/login-limit.ts";
import { sweepAuth } from "./auth/mfa-store.ts";
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from "./auth/session.ts";
import { runAggregator } from "./cron/analytics-aggregator.ts";
import { runChoiceSweep, runLearnedSweep, runMarketSweep } from "./cron/direct-answers.ts";
import { runEventRetention } from "./cron/event-retention.ts";
import { runExposureRollup } from "./cron/exposure-rollup.ts";
import { runLateTagWeekly } from "./cron/late-tag-weekly.ts";
import { runOpsHeartbeat } from "./cron/ops-heartbeat.ts";
import { runProofChecks, runWeeklyDraftNotices } from "./cron/proof-checks.ts";
import { runRegenQueue } from "./cron/regen-queue.ts";
import { runSnippetProbe } from "./cron/snippet-probe.ts";
import { runSourceProposals } from "./cron/source-proposals.ts";
import type { GenerateEnv } from "./generateVariant.ts";
import type { InstallEnv } from "./install-config.ts";
import { runKeywordLexiconSweep } from "./keywords/lexicon.ts";
import { modelConfigured } from "./model-config.ts";
import { orchestrate } from "./orchestrator.ts";
import { runSiteMapSweep } from "./site-map/weekly.ts";

/** With the install's configuration (install-config.ts): hosts, addresses, defaults. */
interface Env extends GenerateEnv, InstallEnv {
  VARIANTS: KVNamespace;
  DB: D1Database;
  ENVIRONMENT: string;
  // ADMIN_TOKEN remains in the type to match wrangler.toml [vars] until D3.6
  // when the old secret is formally revoked. It is NOT read in any code path.
  ADMIN_TOKEN?: string;
  DASHBOARD_ORIGIN: string;
  /** Optional ops-alert webhook (A2); heartbeat is log-only when absent. */
  ALERT_WEBHOOK_URL?: string;
  /** Raw event retention in days; unset means off (security-hardening.md §2.5). */
  RAW_EVENT_RETENTION_DAYS?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check: public, no auth required
    if (url.pathname === "/health") {
      return json({
        ok: true,
        env: env.ENVIRONMENT,
        modelConfigured: modelConfigured(env),
      });
    }

    // Public DOM-capture endpoint (element-detection-v2 T2). Runs on the
    // OPERATOR's browser from their own page, so CORS must be *: it cannot
    // share the dashboard-origin admin preflight. Auth is the one-time
    // capture token minted via /admin/onboard/capture-token. Must be routed
    // BEFORE the generic OPTIONS gate below.
    if (url.pathname === "/onboard/capture") {
      return handlePublicCapture(request, env);
    }

    // /admin/* and OPTIONS preflight: session-based auth gate inside handleAdmin
    if (isAdminPath(url.pathname) || request.method === "OPTIONS") {
      return handleAdmin(request, env, ctx);
    }

    // /regenerate: kept for backward compat; auth is now session-based via /admin/login.
    // Clients that previously POSTed with the shared ADMIN_TOKEN should migrate to
    // POST /admin/login first, then call /regenerate with the session token.
    if (url.pathname === "/regenerate") {
      // Re-use the same session gate as /admin/* so there is one auth code path.
      const { getSessionUser } = await import("./admin/auth.ts");
      const user = await getSessionUser(request, env, ctx);
      if (!user) {
        return json({ error: "Unauthorized" }, 401);
      }
      if (user.scope === "enrol") {
        return json({ error: "Set up two-step sign-in first." }, 403);
      }

      const customerId = url.searchParams.get("customer_id");
      if (!customerId) {
        return json({ error: "customer_id is required" }, 400);
      }

      try {
        const result = await orchestrate(customerId, env);
        return json(result, 200);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const isDev = env.ENVIRONMENT === "development";
        return json(
          isDev ? { error: "generation failed", detail: message } : { error: "generation failed" },
          500,
        );
      }
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // -------------------------------------------------------------------------
    // Dispatch table: branch on event.cron so each schedule has its own scope.
    //
    // "0 */6 * * *": session sweep + variant regeneration (existing, unchanged).
    // "0 * * * *": analytics aggregator + snippet probe (P6, new in Batch C).
    //
    // The snippet probe runs on the hourly cron. runSnippetProbe() keeps a
    // gap per customer: 6 hours while its tag was found in the last 7 days
    // (or the customer was added in the last 7 days), a week otherwise
    // (cron/snippet-probe.ts, probeInterval).
    // -------------------------------------------------------------------------

    if (event.cron === "0 */6 * * *") {
      // 6h: session sweep + variant regeneration
      const now = Date.now();

      // Sign-in state (docs/specs/security-hardening.md §1): expired, aged
      // and idle sessions, failure windows over an hour old, dead second-step
      // challenges, pending enrolments over a day old. One batch, no model.
      try {
        await sweepAuth(env.DB, now, {
          failureTtlMs: FAILURE_ROW_TTL_MS,
          absoluteMs: SESSION_ABSOLUTE_MS,
          idleMs: SESSION_IDLE_MS,
        });
      } catch {
        console.error("[generation/6h] sign-in sweep failed");
      }

      // Nothing on an event row is NULLed at 31 days any more (ADR 0037,
      // 2026-11-02): the visit marker, source_name, tagged, found_by,
      // country and the bit lp stay with the row for the life of the
      // account, and the per-customer delete removes them.
      //
      // The one exception is the customer's own switch: a customer with
      // country recording off loses the country its rows still hold (ADR
      // 0036, point 6), by customer, never by age. Counts only in the log.
      try {
        const c = await clearSwitchedOffCountries(env.DB);
        if (c.cleared > 0 || c.errors > 0) {
          console.log(`[generation/6h] country off: cleared=${c.cleared} errors=${c.errors}`);
        }
      } catch {
        console.error("[generation/6h] country off sweep failed");
      }
      // The same for the direct-insights switch (ADR 0038, part 1): the
      // device word and the in-app bit, by customer, never by age.
      try {
        const d = await clearSwitchedOffDirect(env.DB);
        if (d.cleared > 0 || d.errors > 0) {
          console.log(`[generation/6h] direct off: cleared=${d.cleared} errors=${d.errors}`);
        }
      } catch {
        console.error("[generation/6h] direct off sweep failed");
      }

      // Raw event retention (security-hardening.md §2.5, privacy review condition
      // 5): off until RAW_EVENT_RETENTION_DAYS is set. ADR 0037 keeps event
      // rows for the life of the account, so it stays unset. Counts only in
      // the log.
      try {
        const kept = await runEventRetention(env, now);
        if (kept.deleted > 0 || kept.capped) {
          console.log(
            `[generation/6h] event retention: days=${kept.days} deleted=${kept.deleted} capped=${kept.capped}`,
          );
        }
      } catch {
        console.error("[generation/6h] event retention failed");
      }

      // Snippet issue rows are kept with the other event rows (ADR 0037):
      // no 31-day delete.

      // Pilot requests from the site's form live 12 months after their last
      // status change (privacy review, 2026-10-25, ruling 3 on
      // docs/sales/site-privacy.md). Counts only in the log.
      try {
        const deleted = await deleteOldPilotRequests(env.DB, now);
        if (deleted > 0) console.log(`[generation/6h] pilot requests: deleted=${deleted}`);
      } catch {
        console.error("[generation/6h] pilot request retention failed");
      }

      // Pilot applications retention (docs/specs/pilot-apply.md, 2026-10-01):
      // unused invites 30 days past expiry deleted, archived applications
      // 90 days past archiving forgotten. Counts only in the log.
      ctx.waitUntil(
        sweepApplications(env, now)
          .then(({ deleted, forgotten }) => {
            if (deleted > 0 || forgotten > 0) {
              console.log(
                `[generation/6h] applications: deleted=${deleted} forgotten=${forgotten}`,
              );
            }
          })
          .catch(() => {
            console.error("[generation/6h] applications sweep failed");
          }),
      );

      // Hide rules and the rich key for every customer with a confirmed
      // manifest (2026-09-30): customers confirmed before the rich key
      // existed get it here, and any drift heals within six hours.
      ctx.waitUntil(
        sweepHideRules(env)
          .then(({ written, failed }) => {
            console.log(
              `[generation/6h] hide rules: written=${written.length} failed=[${failed.join(",")}]`,
            );
          })
          .catch((e) => {
            console.error(
              "[generation/6h] hide rules sweep failed:",
              e instanceof Error ? e.message : String(e),
            );
          }),
      );

      // The site map (docs/specs/site-shaped-intents.md §9): a waiting growth
      // of the served set written after 7 days, rows missing 30 days removed,
      // and the weekly cookie-less read of a live homepage. Counts only.
      ctx.waitUntil(
        runSiteMapSweep(env, now)
          .then((r) => {
            if (r.auto_written + r.purged + r.fetched + r.failed > 0) {
              console.log(
                `[generation/6h] site map: auto_written=${r.auto_written} purged=${r.purged} fetched=${r.fetched} failed=${r.failed}`,
              );
            }
          })
          .catch(() => {
            console.error("[generation/6h] site map sweep failed");
          }),
      );

      // The keyword lexicon (docs/specs/keyword-intent.md §4): a live
      // customer allowed one, with none, one marked due, or one older than
      // its brief. At most KEYWORD_SWEEP_MAX customers, one build each.
      // Counts only, never a phrase.
      ctx.waitUntil(
        runKeywordLexiconSweep(env)
          .then((r) => {
            if (r.built + r.empty + r.failed > 0) {
              console.log(
                `[generation/6h] keyword lexicon: built=${r.built} empty=${r.empty} failed=${r.failed}`,
              );
            }
          })
          .catch(() => {
            console.error("[generation/6h] keyword lexicon sweep failed");
          }),
      );

      // Visitors with no signal (ADR 0038 parts 3 and 5;
      // docs/specs/direct-visitors.md): each live customer's markets from its
      // visits by country. Counts only in the log.
      ctx.waitUntil(
        runMarketSweep(env, now)
          .then((r) => {
            if (r.changed + r.errors > 0) {
              console.log(`[generation/6h] markets: changed=${r.changed} errors=${r.errors}`);
            }
          })
          .catch(() => {
            console.error("[generation/6h] market sweep failed");
          }),
      );
      // The learned default's weights, from aggregate click counts, with a
      // prior pooled across customers (noised totals). Counts only.
      ctx.waitUntil(
        runLearnedSweep(env, now)
          .then((r) => {
            if (r.changed + r.errors > 0) {
              console.log(
                `[generation/6h] learned default: changed=${r.changed} errors=${r.errors}`,
              );
            }
          })
          .catch(() => {
            console.error("[generation/6h] learned default sweep failed");
          }),
      );

      // Regeneration moved to the five-minute queue below (2026-09-15); this
      // branch keeps the sweeps only.
    } else if (event.cron === "*/5 * * * *") {
      // The write queue: missing, stale and errored rows for every customer,
      // a few per invocation, under a per-customer lock. The dashboard's
      // loops stay the fast path; this one finishes when the tab slept.
      ctx.waitUntil(
        runRegenQueue(env, (id, e, o) => orchestrate(id, e, o))
          .then((r) => {
            if (r.ran.length > 0 || r.locked.length > 0) {
              console.log(
                `[generation/queue] ran=[${r.ran.join(",")}] capped=[${r.capped.join(",")}] locked=[${r.locked.join(",")}]`,
              );
            }
          })
          .catch((e) => {
            console.error("[generation/queue] failed:", e);
          }),
      );
      // The visitor's own choice: a question for each language home that has
      // none, off until the customer turns it on (direct-visitors.md §2).
      ctx.waitUntil(
        runChoiceSweep(env)
          .then((r) => {
            if (r.written + r.failed > 0) {
              console.log(
                `[generation/queue] visitor choice: written=${r.written} failed=${r.failed}`,
              );
            }
          })
          .catch(() => {
            console.error("[generation/queue] visitor choice sweep failed");
          }),
      );
    } else if (event.cron === "0 6 * * 1") {
      // Monday 06:00 UTC: last week's unknown source values to the ops channel.
      ctx.waitUntil(
        runSourceProposals(env).catch((e) => {
          console.error("[generation] source proposals failed:", e);
        }),
      );
      // The weekly proof drafts are ready on the dashboard; the channel gets
      // the customer id and a link only, never the numbers (condition 7).
      ctx.waitUntil(
        runWeeklyDraftNotices(env).catch((e) => {
          console.error("[generation] weekly draft notices failed:", e);
        }),
      );
      // One line per customer whose tag sits low in the page (late-tag.md).
      ctx.waitUntil(
        runLateTagWeekly(env).catch((e) => {
          console.error("[generation] late-tag weekly failed:", e);
        }),
      );
    } else if (event.cron === "0 * * * *") {
      // 1h: analytics aggregator + snippet probe
      // The daily exposure outcomes (proof engine, E), then the checks that
      // read them (read date, split, negative result, missing rollups).
      ctx.waitUntil(
        runExposureRollup(env)
          .then(async ({ rebuilt, errors }) => {
            if (errors > 0)
              console.error(`[generation/hourly] rollup: ${rebuilt} days, ${errors} errors`);
            const checks = await runProofChecks(env);
            if (checks.alerts.length > 0 || checks.fixed.length > 0 || checks.ended.length > 0) {
              console.log(
                `[generation/hourly] proof: fixed=[${checks.fixed.join(",")}] alerts=[${checks.alerts.join(",")}] ended=[${checks.ended.join(",")}]`,
              );
            }
          })
          .catch((e) => {
            console.error(
              "[generation/hourly] rollup error:",
              e instanceof Error ? e.message : String(e),
            );
          }),
      );
      ctx.waitUntil(
        runAggregator(env)
          .then(({ aggregated, errors, durationMs }) => {
            console.log(
              `[generation/hourly] aggregator: ${aggregated} rows, ${errors} errors, ${durationMs}ms`,
            );
          })
          .catch((e) => {
            console.error(
              "[generation/hourly] aggregator error:",
              e instanceof Error ? e.message : String(e),
            );
          }),
      );

      // The free audit (docs/specs/ai-traffic-audit.md §3.5, §3.8): window
      // start, day-7 extension, row cap, the frozen report, the end and the
      // lapse; then the 60-day delete. Ids and counts only in the log.
      ctx.waitUntil(
        runAuditCheck(env)
          .then(async (r) => {
            const busy = Object.entries(r).filter(([, ids]) => ids.length > 0);
            if (busy.length > 0) {
              console.log(
                `[generation/hourly] audit: ${busy.map(([k, ids]) => `${k}=[${ids.join(",")}]`).join(" ")}`,
              );
            }
            const del = await sweepAuditDeletes(env);
            if (del.deleted.length + del.pending.length > 0) {
              console.log(
                `[generation/hourly] audit deletes: done=[${del.deleted.join(",")}] pending=[${del.pending.join(",")}]`,
              );
            }
          })
          .catch(() => {
            console.error("[generation/hourly] audit check failed");
          }),
      );

      // Snippet probe: 6 h or weekly per customer, gated inside runSnippetProbe.
      ctx.waitUntil(
        runSnippetProbe(env)
          .then(({ probed, skipped, errors }) => {
            console.log(
              `[generation/hourly] snippet probe: probed=${probed} skipped=${skipped} errors=${errors}`,
            );
          })
          .catch((e) => {
            console.error(
              "[generation/hourly] snippet probe error:",
              e instanceof Error ? e.message : String(e),
            );
          }),
      );

      // Ops heartbeat (A2): edge health + generation error state, alerting
      // via ALERT_WEBHOOK_URL. Deduped to one alert per type per 6h.
      ctx.waitUntil(
        runOpsHeartbeat(env)
          .then(({ alerted, deduped, failed }) => {
            if (alerted.length > 0 || deduped.length > 0 || failed.length > 0) {
              console.log(
                `[generation/hourly] heartbeat: alerted=[${alerted.join(",")}] deduped=[${deduped.join(",")}] failed=[${failed.join(",")}]`,
              );
            }
          })
          .catch((e) => {
            console.error(
              "[generation/hourly] heartbeat error:",
              e instanceof Error ? e.message : String(e),
            );
          }),
      );
    } else {
      console.warn(`[generation] unexpected cron expression: ${event.cron}`);
    }
  },
} satisfies ExportedHandler<Env>;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
