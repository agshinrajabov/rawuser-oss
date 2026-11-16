/**
 * The Monday line about a tag low in the page (docs/specs/late-tag.md).
 *
 * `late_tag` is not a fault of ours and not an incident: the customer's tag
 * sits low in the page, so some loads paint before our script runs and stay
 * as built. The Pages card and Connect already tell the customer. Until
 * 2026-10-13 the hourly heartbeat sent it as a daily line like a failure
 * (the founder got the same line about one customer two days running). Now it is one
 * line a week per customer, in the Monday ops message beside the source
 * proposals and the draft notices, with the Pages card's own number
 * (`lateTagShare`: the last 7 days, confirmed pages, by visit) when it is
 * over the issue threshold and has enough visits to be shown. Counts only.
 */

import { ISSUE_ALERT_SHARE } from "../lib/snippet-issues.ts";
import { type LateTagShare, lateTagShare } from "./analytics-aggregator.ts";
import { type HeartbeatEnv, sendOpsAlert } from "./ops-heartbeat.ts";

export type LateTagWeeklyEnv = Pick<HeartbeatEnv, "DB" | "VARIANTS" | "ALERT_WEBHOOK_URL">;

/** One line a week: the dedupe key outlives a second run of the same Monday. */
const LATE_TAG_WEEKLY_TTL_S = 6 * 24 * 3600;

/** Over the issue threshold, with the visits the Pages card needs to show a share. */
export function lateTagWeeklyDue(late: LateTagShare): boolean {
  return late.enough && late.share !== null && late.share >= ISSUE_ALERT_SHARE;
}

/** The line: the share, the counts, and what it means in four words. */
export function lateTagWeeklyLine(customerId: string, late: LateTagShare): string {
  const pct = Math.round((late.share ?? 0) * 100);
  return `[rawuser ops] late-tag · ${customerId} · tag low in the page: ${pct}% of visits, ${late.late_exposures} of ${late.exposures} · 7 d`;
}

export async function runLateTagWeekly(
  env: LateTagWeeklyEnv,
  now = Date.now(),
): Promise<{ sent: string[]; failed: string[] }> {
  const sent: string[] = [];
  const failed: string[] = [];
  const customers = await env.DB.prepare(
    "SELECT id FROM customers WHERE plan != 'test' AND status != 'ended'",
  ).all<{ id: string }>();
  for (const { id } of customers.results ?? []) {
    try {
      const late = await lateTagShare(env.DB, id, now);
      if (!lateTagWeeklyDue(late)) continue;
      const r = await sendOpsAlert(
        env,
        `late-tag:${id}`,
        lateTagWeeklyLine(id, late),
        LATE_TAG_WEEKLY_TTL_S,
      );
      if (r === "sent") sent.push(id);
      else if (r === "failed") failed.push(id);
    } catch (e) {
      console.error(
        "[late-tag-weekly] one customer failed:",
        e instanceof Error ? e.message : String(e),
      );
      failed.push(id);
    }
  }
  return { sent, failed };
}
