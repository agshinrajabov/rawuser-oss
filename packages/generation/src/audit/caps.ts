/**
 * The audit's caps (docs/specs/ai-traffic-audit.md §9): three page and
 * language pairs, one "Rewrite everything", $1.00 of model spend. They
 * refuse for an audit customer and never for anyone else. An ended audit
 * writes nothing (§3.8).
 *
 * Spend is a running sum on the customers row (`audit_spend_usd`), added at
 * the entry points that are not nested in one another: the write
 * orchestrator, the single-version regenerate, and the quickstart chain
 * (whose preview version is inside its own total).
 */

import { sendOpsAlert } from "../cron/ops-heartbeat.ts";
import { AUDIT_LINES, AUDIT_MAX_PAGES, AUDIT_MAX_REWRITES, AUDIT_MAX_SPEND } from "./constants.ts";

export interface AuditGate {
  /** customers.plan = 'audit'. */
  audit: boolean;
  /** customers.status = 'ended' (an ended audit). */
  ended: boolean;
  /** Dollars left under the cap; Infinity for any customer that is not an audit. */
  left: number;
  spent: number;
  rewrites: number;
}

const OPEN: AuditGate = {
  audit: false,
  ended: false,
  left: Number.POSITIVE_INFINITY,
  spent: 0,
  rewrites: 0,
};

/** The audit's state for the caps. A read that fails leaves the customer uncapped (never blocks a pilot). */
export async function auditGate(db: D1Database, customerId: string): Promise<AuditGate> {
  try {
    const row = await db
      .prepare("SELECT plan, status, audit_spend_usd, audit_rewrites FROM customers WHERE id = ?")
      .bind(customerId)
      .first<{
        plan?: string | null;
        status?: string | null;
        audit_spend_usd?: number | null;
        audit_rewrites?: number | null;
      }>();
    if (!row) return OPEN;
    const ended = row.status === "ended";
    if (row.plan !== "audit") return { ...OPEN, ended };
    const spent = Number(row.audit_spend_usd) || 0;
    return {
      audit: true,
      ended,
      left: Math.max(0, AUDIT_MAX_SPEND - spent),
      spent,
      rewrites: Number(row.audit_rewrites) || 0,
    };
  } catch {
    return OPEN;
  }
}

export interface SpendEnv {
  DB: D1Database;
  VARIANTS: KVNamespace;
  ALERT_WEBHOOK_URL?: string;
}

/**
 * Add a run's model spend to an audit (no-op for any other plan). When the
 * sum reaches the cap, one `audit-spend` line goes to the ops channel (the
 * customer id only), deduped for 30 days.
 */
export async function addAuditSpend(env: SpendEnv, customerId: string, usd: number): Promise<void> {
  if (!(usd > 0)) return;
  try {
    await env.DB.prepare(
      "UPDATE customers SET audit_spend_usd = COALESCE(audit_spend_usd, 0) + ? WHERE id = ? AND plan = 'audit'",
    )
      .bind(usd, customerId)
      .run();
    const gate = await auditGate(env.DB, customerId);
    if (gate.audit && gate.left <= 0) {
      await sendOpsAlert(
        env as never,
        `audit-spend:${customerId}`,
        `[rawuser ops] audit-spend: ${customerId} used its $${AUDIT_MAX_SPEND.toFixed(2)} writing budget; the write queue stops for it`,
        30 * 24 * 3600,
      ).catch(() => undefined);
    }
  } catch {
    console.error("[audit] spend not recorded (non-critical)");
  }
}

/** The 409 body of a cap refusal: a code and the mock's sentence. */
export function capBody(
  code: "audit_spend" | "audit_pages_full" | "audit_rewrite_used" | "audit_ended",
): { error: string; message: string } {
  const message =
    code === "audit_spend"
      ? AUDIT_LINES.spend
      : code === "audit_pages_full"
        ? AUDIT_LINES.pages_full
        : code === "audit_rewrite_used"
          ? AUDIT_LINES.rewrite_used
          : AUDIT_LINES.ended;
  return { error: code, message };
}

/** Confirmed page paths of a customer (each is one page and language pair). */
export async function confirmedPaths(db: D1Database, customerId: string): Promise<string[]> {
  const r = await db
    .prepare(
      "SELECT page_path FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL",
    )
    .bind(customerId)
    .all<{ page_path: string }>();
  return (r.results ?? []).map((x) => x.page_path);
}

/**
 * Would adding `pagePath` take an audit past its pages? False for an audit
 * page that is already confirmed (a re-read of a written page) and for any
 * customer that is not an audit.
 */
export async function pagesFull(
  db: D1Database,
  gate: AuditGate,
  customerId: string,
  pagePath: string,
): Promise<boolean> {
  if (!gate.audit) return false;
  const paths = await confirmedPaths(db, customerId);
  if (paths.includes(pagePath)) return false;
  return paths.length >= AUDIT_MAX_PAGES;
}

/**
 * Take the audit's one rewrite. True when it was free (and is now used) or
 * the customer is not an audit; false when it was used already.
 */
export async function takeRewrite(
  db: D1Database,
  gate: AuditGate,
  customerId: string,
): Promise<boolean> {
  if (!gate.audit) return true;
  const r = await db
    .prepare(
      "UPDATE customers SET audit_rewrites = COALESCE(audit_rewrites, 0) + 1 WHERE id = ? AND plan = 'audit' AND COALESCE(audit_rewrites, 0) < ?",
    )
    .bind(customerId, AUDIT_MAX_REWRITES)
    .run();
  return Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}
