/**
 * Weekly source-vocabulary proposals (L2 Layer F).
 *
 * Reads signal_token_counts for the last full ISO week, keeps tokens seen
 * across at least MIN_BUCKETS customer buckets and MIN_SESSIONS sessions,
 * drops what the vocabulary already knows (a row may have been added since
 * it was counted), and tells the ops channel HOW MANY values wait for
 * review. The values themselves never leave our systems automatically: a
 * human runs `pnpm source:proposals`, reads them, adds rows or purges
 * (privacy review condition, ADR 0030). Also deletes rows older than 8
 * weeks. Aggregate in, a number out.
 *
 * A sensitive customer's data enters no cross-customer count
 * (docs/specs/sensitive-customers.md, rule 3). The edge writes no counter
 * for one (bundle `s: 1`); as a second line the read here leaves out the
 * week's buckets of every sensitive customer, so rows counted before a
 * customer was marked, or by an edge that did not know yet, are never
 * proposed. When the flag cannot be read nothing is proposed that week.
 */

import {
  matchAppPackage,
  matchReferrerHost,
  matchUtmMedium,
  matchUtmSource,
} from "@rawuser/shared/signals/source-vocabulary";
import { sensitiveBuckets } from "../lib/sensitive-guard.ts";

export interface ProposalsEnv {
  DB: D1Database;
  ALERT_WEBHOOK_URL?: string;
}

export const MIN_BUCKETS = 2;
export const MIN_SESSIONS = 50;
const KEEP_WEEKS = 8;

export interface ProposalRow {
  kind: string;
  token: string;
  buckets: number;
  sessions: number;
}

/** ISO week label for a date, e.g. "2026-W37". */
export function isoWeek(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function lastFullWeek(now = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 7);
  return isoWeek(d);
}

/** Still unknown after the vocabulary of the running code is applied. */
export function stillUnknown(row: ProposalRow): boolean {
  if (row.kind === "utm_source") return matchUtmSource(row.token) === null;
  if (row.kind === "utm_medium") return matchUtmMedium(row.token) === null;
  if (row.kind === "referrer_host") return matchReferrerHost(row.token) === null;
  // A package id is checked against the exact package table only; as a host
  // com.google.earth would read as Google and hide (Layer G).
  if (row.kind === "app_package") return matchAppPackage(row.token) === null;
  return false;
}

/** The ops message: a count and the command, never the values. */
export function formatProposals(week: string, rows: ProposalRow[]): string {
  if (rows.length === 0) return `[rawuser sources] ${week}: nothing new above the threshold.`;
  const kinds = new Map<string, number>();
  for (const r of rows) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
  const byKind = Array.from(kinds.entries())
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  return `[rawuser sources] ${week}: ${rows.length} unknown value${rows.length === 1 ? "" : "s"} wait for review (${byKind}). Run pnpm source:proposals ${week} to see them.`;
}

/**
 * The week's tokens above the threshold, without the buckets of the
 * sensitive customers (`skipped` of them, bound after the week). At most 256
 * buckets exist, so the list is short.
 */
export function proposalsSql(skipped: number): string {
  const without =
    skipped > 0 ? ` AND customer_bucket NOT IN (${Array(skipped).fill("?").join(", ")})` : "";
  return `SELECT kind, token, COUNT(DISTINCT customer_bucket) AS buckets, SUM(count) AS sessions
     FROM signal_token_counts WHERE week = ?${without}
     GROUP BY kind, token HAVING buckets >= ? AND sessions >= ?
     ORDER BY sessions DESC LIMIT 200`;
}

export async function runSourceProposals(
  env: ProposalsEnv,
  now = new Date(),
): Promise<{ week: string; proposals: ProposalRow[] }> {
  const week = lastFullWeek(now);
  // Not caught: without the flag the read below could count a sensitive
  // customer's rows, so a failure here ends the run before it.
  const skipped = await sensitiveBuckets(env.DB, week);
  const result = await env.DB.prepare(proposalsSql(skipped.length))
    .bind(week, ...skipped, MIN_BUCKETS, MIN_SESSIONS)
    .all<ProposalRow>();
  const proposals = (result.results ?? []).filter(stillUnknown);

  // Retention: eight weeks of counters is plenty for a trend.
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - KEEP_WEEKS * 7);
  await env.DB.prepare("DELETE FROM signal_token_counts WHERE week < ?")
    .bind(isoWeek(cutoff))
    .run();

  const text = formatProposals(week, proposals);
  console.log(text);
  if (env.ALERT_WEBHOOK_URL && proposals.length > 0) {
    try {
      const url = new URL(env.ALERT_WEBHOOK_URL);
      if (url.hostname === "api.telegram.org") {
        url.searchParams.set("text", text);
        await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
      } else {
        await fetch(env.ALERT_WEBHOOK_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, content: text }),
          signal: AbortSignal.timeout(10_000),
        });
      }
    } catch {
      console.error("[source-proposals] webhook send failed (non-critical)");
    }
  }
  return { week, proposals };
}
