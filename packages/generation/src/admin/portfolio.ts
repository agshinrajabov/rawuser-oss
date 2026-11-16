/**
 * Admin portfolio endpoints — P6 Batch C (superadmin only).
 *
 * Two handlers for the operator portfolio view:
 *   GET /admin/portfolio/customers  — customer cards with health badge + signals
 *   GET /admin/portfolio/attention  — customers needing operator action
 *
 * Auth: superadmin-only check is enforced in routes.ts (not in these handlers).
 *
 * Privacy invariant: reads only operator + aggregate data (customers table,
 * analytics_aggregates, snippet_status). No visitor data is touched.
 *
 * The skip rate (docs/specs/late-tag.md, 2026-10-12): "skipped-rate-high"
 * tells the operator to look at the page's parts. A page that was painted
 * before our script ran is skipped too, by design, and no part is missing
 * there, so those visits are left out of the rate: it reads the skipped
 * entry's `other_visits` (a part not found, an answer after the reveal cap).
 * A row written before the split has no such number and keeps the cohort's
 * total until the next hourly run replaces it.
 */

import { parseCohorts, skippedSplit } from "./analytics.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthBadge = "green" | "yellow" | "red";
export type AttentionSignalType =
  | "snippet-removed"
  | "snippet-stale"
  | "skipped-rate-high"
  | "lift-trend-down";

export interface PortfolioItem {
  customer_id: string;
  customer_slug: string;
  customer_domain: string;
  snippet_status: "active" | "stale" | "removed" | "never" | "unknown";
  health: HealthBadge;
  holdout_lift_7d: number | null;
  visits_24h: number;
  signals: AttentionSignalType[];
}

export interface AttentionSignal {
  customer_id: string;
  type: AttentionSignalType;
  value?: number;
  label: string;
}

// ---------------------------------------------------------------------------
// D1 row shapes
// ---------------------------------------------------------------------------

interface CustomerRow {
  id: string;
  slug: string;
  domain: string;
}

interface AggRow7d {
  customer_id: string;
  holdout_lift: number | null;
  holdout_significance: string | null;
  personalized_visits: number;
  skipped_visits: number;
  natural_lift: number | null;
  per_cohort?: string | null;
}

/**
 * The skips the skip rate is about: every skip but a late tag's. From the
 * split when the row has it, else the cohort's total.
 */
export function skipsToLookAt(row: {
  skipped_visits?: number | null;
  per_cohort?: string | null;
}): number {
  const { other_visits } = skippedSplit(parseCohorts(row.per_cohort ?? null));
  return other_visits ?? Number(row.skipped_visits ?? 0);
}

interface AggRow24h {
  customer_id: string;
  total_visits: number;
}

interface SnippetStatusRow {
  customer_id: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Signal computation helpers
// ---------------------------------------------------------------------------

/**
 * Derive health badge from snippet_status + lift trend + skipped rate.
 *   red    — snippet removed
 *   yellow — snippet stale OR skipped_rate > 30% OR lift_trend_down
 *   green  — everything else
 */
function deriveHealth(
  snippetStatus: string,
  skippedRate: number,
  holdoutLift: number | null,
): HealthBadge {
  if (snippetStatus === "removed") return "red";
  if (
    snippetStatus === "stale" ||
    skippedRate > 0.3 ||
    (holdoutLift !== null && holdoutLift < -0.2)
  ) {
    return "yellow";
  }
  return "green";
}

/**
 * Compute the attention signals array for a single customer.
 */
function computeSignals(
  snippetStatus: string,
  skippedVisits: number,
  personalizedVisits: number,
  holdoutLift: number | null,
): AttentionSignalType[] {
  const signals: AttentionSignalType[] = [];

  if (snippetStatus === "removed") {
    signals.push("snippet-removed");
  } else if (snippetStatus === "stale") {
    signals.push("snippet-stale");
  }

  const total = personalizedVisits + skippedVisits;
  if (total > 0) {
    const skippedRate = skippedVisits / total;
    if (skippedRate > 0.3) {
      signals.push("skipped-rate-high");
    }
  }

  if (holdoutLift !== null && holdoutLift < -0.2) {
    signals.push("lift-trend-down");
  }

  return signals;
}

// ---------------------------------------------------------------------------
// GET /admin/portfolio/customers
// ---------------------------------------------------------------------------

export async function handlePortfolioCustomers(request: Request, env: AdminEnv): Promise<Response> {
  // Fetch all active customers.
  const customerResult = await env.DB.prepare(
    "SELECT id, slug, domain FROM customers WHERE status = 'active'",
  ).all<CustomerRow>();
  const customers = customerResult.results ?? [];

  if (customers.length === 0) {
    return jsonWithCors([], env, 200);
  }

  const customerIds = customers.map((c) => c.id);

  // Batch fetch 7d aggregate rows (for lift + skipped).
  // D1 doesn't support IN (?) with arrays, so query each or use a subselect.
  // For simplicity at pilot scale (< 50 customers) iterate.
  const agg7dMap = new Map<string, AggRow7d>();
  for (const id of customerIds) {
    const row = await env.DB.prepare(
      `SELECT customer_id, holdout_lift, holdout_significance,
              personalized_visits, skipped_visits, natural_lift, per_cohort
       FROM analytics_aggregates
       WHERE customer_id = ? AND window = '7d'
       ORDER BY window_start DESC LIMIT 1`,
    )
      .bind(id)
      .first<AggRow7d>();
    if (row) agg7dMap.set(id, row);
  }

  // Batch fetch 24h aggregate rows (for visits_24h).
  const agg24hMap = new Map<string, AggRow24h>();
  for (const id of customerIds) {
    const row = await env.DB.prepare(
      `SELECT customer_id, total_visits
       FROM analytics_aggregates
       WHERE customer_id = ? AND window = '24h'
       ORDER BY window_start DESC LIMIT 1`,
    )
      .bind(id)
      .first<AggRow24h>();
    if (row) agg24hMap.set(id, row);
  }

  // Batch fetch snippet_status.
  const snippetMap = new Map<string, SnippetStatusRow>();
  for (const id of customerIds) {
    const row = await env.DB.prepare(
      "SELECT customer_id, status FROM snippet_status WHERE customer_id = ?",
    )
      .bind(id)
      .first<SnippetStatusRow>();
    if (row) snippetMap.set(id, row);
  }

  // Build portfolio items.
  const items: PortfolioItem[] = customers.map((c) => {
    const agg7d = agg7dMap.get(c.id);
    const agg24h = agg24hMap.get(c.id);
    const snippetRow = snippetMap.get(c.id);

    const snippetStatus = (snippetRow?.status as PortfolioItem["snippet_status"]) ?? "unknown";
    const holdoutLift = agg7d?.holdout_lift ?? null;
    const personalizedVisits = agg7d?.personalized_visits ?? 0;
    const skippedVisits = agg7d ? skipsToLookAt(agg7d) : 0;
    const visits24h = agg24h?.total_visits ?? 0;

    const total = personalizedVisits + skippedVisits;
    const skippedRate = total > 0 ? skippedVisits / total : 0;

    return {
      customer_id: c.id,
      customer_slug: c.slug,
      customer_domain: c.domain,
      snippet_status: snippetStatus,
      health: deriveHealth(snippetStatus, skippedRate, holdoutLift),
      holdout_lift_7d: holdoutLift,
      visits_24h: visits24h,
      signals: computeSignals(snippetStatus, skippedVisits, personalizedVisits, holdoutLift),
    };
  });

  return jsonWithCors(items, env, 200);
}

// ---------------------------------------------------------------------------
// GET /admin/portfolio/attention
// ---------------------------------------------------------------------------

export async function handlePortfolioAttention(request: Request, env: AdminEnv): Promise<Response> {
  // Load all active customers.
  const customerResult = await env.DB.prepare(
    "SELECT id FROM customers WHERE status = 'active'",
  ).all<{ id: string }>();
  const customers = customerResult.results ?? [];

  const attentionItems: AttentionSignal[] = [];

  for (const customer of customers) {
    const snippetRow = await env.DB.prepare(
      "SELECT status FROM snippet_status WHERE customer_id = ?",
    )
      .bind(customer.id)
      .first<{ status: string }>();

    const snippetStatus = snippetRow?.status ?? "unknown";

    if (snippetStatus === "removed") {
      attentionItems.push({
        customer_id: customer.id,
        type: "snippet-removed",
        label: "Snippet tag removed from page HTML",
      });
    } else if (snippetStatus === "stale") {
      attentionItems.push({
        customer_id: customer.id,
        type: "snippet-stale",
        label: "Snippet present but no events in 24h",
      });
    }

    // Check skipped rate from 7d aggregate.
    const agg7d = await env.DB.prepare(
      `SELECT personalized_visits, skipped_visits, holdout_lift, per_cohort
       FROM analytics_aggregates
       WHERE customer_id = ? AND window = '7d'
       ORDER BY window_start DESC LIMIT 1`,
    )
      .bind(customer.id)
      .first<{
        personalized_visits: number;
        skipped_visits: number;
        holdout_lift: number | null;
        per_cohort?: string | null;
      }>();

    if (agg7d) {
      const skips = skipsToLookAt(agg7d);
      const total = agg7d.personalized_visits + skips;
      if (total > 0) {
        const skippedRate = skips / total;
        if (skippedRate > 0.3) {
          attentionItems.push({
            customer_id: customer.id,
            type: "skipped-rate-high",
            value: skippedRate,
            label: `${Math.round(skippedRate * 100)}% of visits skipped personalization (a part not found, or the answer came late)`,
          });
        }
      }

      if (agg7d.holdout_lift !== null && agg7d.holdout_lift < -0.2) {
        attentionItems.push({
          customer_id: customer.id,
          type: "lift-trend-down",
          value: agg7d.holdout_lift,
          label: `Holdout lift is ${Math.round(agg7d.holdout_lift * 100)}% (below -20% threshold)`,
        });
      }
    }
  }

  return jsonWithCors(attentionItems, env, 200);
}
