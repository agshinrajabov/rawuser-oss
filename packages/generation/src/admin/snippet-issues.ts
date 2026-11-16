/**
 * GET /admin/health/issues?customer_id=…&hours=24 (customer-scoped in
 * routes.ts: a customer reads only its own pages, a superadmin any; the
 * Pages card needs it). docs/specs/snippet-issues.md, "Generation: read
 * endpoint".
 *
 * Per page and code: the page loads that reported the code, its share of
 * the page's loads and the most frequent slot. Aggregates only, never a row
 * and never `n` (privacy review conditions 5 and 6); `hours` defaults to 24, is
 * capped at 744, and anything that is not a positive integer is a 400.
 *
 * A load the visitor left while /select was on its way (`select_failed` 4)
 * is in none of these numbers, and the answer has no count of such loads,
 * for a superadmin either (privacy review Q5, condition 4: never shown or
 * used as a bounce or engagement number). lib/snippet-issues.ts leaves them
 * out before anything is counted.
 *
 * `late` (docs/specs/late-tag.md, "Contract for the dashboard"): for the
 * last 7 days, whatever `hours` says, `{exposures, late_exposures, share,
 * enough}`. Visits that met a page with a version ready, how many of them
 * met one painted before our script ran, the share, and whether there are
 * the 30 visits the card needs before it says a share. Counts of this
 * customer's own visits only; the bit itself never leaves the database.
 */

import { lateTagShare } from "../cron/analytics-aggregator.ts";
import {
  parseStoredVerdict,
  validatePlatform,
  validateTagFlags,
  validateTagPosition,
  verdictBlocks,
} from "../lib/install-facts.ts";
import {
  aggregateCustomerIssues,
  issueWindowStart,
  parseIssueHours,
} from "../lib/snippet-issues.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";

/** Four decimals: enough for a dashboard line, no false precision. */
function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

export async function handleHealthIssues(request: Request, env: AdminEnv): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  if (!customerId) {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const hours = parseIssueHours(url.searchParams.get("hours"));
  if (hours === null) {
    return jsonWithCors({ error: "hours must be a positive integer" }, env, 400);
  }

  const exists = await env.DB.prepare("SELECT id FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ id: string }>();
  if (!exists) {
    return jsonWithCors({ error: "Customer not found" }, env, 404);
  }

  const now = Date.now();
  const since = issueWindowStart(now, hours);
  const agg = await aggregateCustomerIssues(env.DB, customerId, since);
  const site = await siteInstallHealth(env.DB, customerId);
  const late = await lateTagShare(env.DB, customerId, now);

  return jsonWithCors(
    {
      customer_id: customerId,
      hours,
      since,
      loads: agg.loads,
      pages: agg.pages.map((p) => ({
        page_path: p.page_path,
        loads: p.loads,
        issues: p.issues.map((i) => ({
          code: i.code,
          count: i.count,
          share: round4(i.share),
          slot: i.slot,
        })),
      })),
      site,
      late,
    },
    env,
  );
}

interface SiteRow {
  last_probed_at: number | null;
  csp_verdict: string | null;
  csp_blocks_since: number | null;
  platform: string | null;
  tag_position: string | null;
  tag_flags: string | null;
}

/**
 * The site-wide line on the Pages card (docs/specs/install-friction.md, UI
 * item 5; amber, the founder's call 2026-10-04: the customer's side to
 * change). From the probe's stored verdict: closed enums only. The lines
 * themselves are rebuilt by POST /admin/snippet-status/probe.
 */
export async function siteInstallHealth(db: D1Database, customerId: string) {
  const row = await db
    .prepare(
      `SELECT last_probed_at, csp_verdict, csp_blocks_since, platform, tag_position, tag_flags
         FROM snippet_status WHERE customer_id = ?`,
    )
    .bind(customerId)
    .first<SiteRow>();
  const verdict = parseStoredVerdict(row?.csp_verdict);
  let flags: string[] = [];
  try {
    flags = validateTagFlags(row?.tag_flags ? JSON.parse(row.tag_flags) : []) ?? [];
  } catch {
    flags = [];
  }
  const e = verdict?.enforced;
  const ro = verdict?.report_only;
  return {
    probed_at: row?.last_probed_at ?? null,
    csp_blocks: verdictBlocks(verdict),
    csp_blocks_since: verdictBlocks(verdict) ? (row?.csp_blocks_since ?? null) : null,
    csp_degrades: Boolean(e && e.script === "ok" && e.connect === "ok" && e.style === "blocked"),
    csp_report_only_blocks: Boolean(
      ro && (ro.script !== "ok" || ro.connect !== "ok" || ro.style === "blocked"),
    ),
    platform: validatePlatform(row?.platform),
    tag_position: validateTagPosition(row?.tag_position),
    tag_flags: flags,
  };
}
