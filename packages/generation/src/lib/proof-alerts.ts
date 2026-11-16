/**
 * The proof engine's ops alerts (docs/specs/proof-engine.md, D and E;
 * privacy review condition 7). Telegram is not a listed subprocessor and
 * its bot chats are not end-to-end encrypted, so these lines carry the
 * code, the customer id and a dashboard link (when the install has a
 * dashboard origin), and nothing else: never a
 * count, a rate, a lift, an interval or a verdict. The numbers stay in the
 * customer-scoped dashboard.
 */

import { dashboardOrigin } from "../install-config.ts";

export type ProofAlertCode =
  | "lift-negative"
  | "holdout-split"
  | "rollup-missing"
  | "weekly-draft"
  /** A go-live test ended on day 14 for too little traffic: a notice, not an alarm. */
  | "test-low-traffic";

/**
 * The customer's analytics page on the dashboard (DASHBOARD_ORIGIN); null
 * when the install names no dashboard, or only the dev wildcard.
 */
export function dashboardLink(origin: string | undefined, customerId: string): string | null {
  const base = dashboardOrigin({ DASHBOARD_ORIGIN: origin });
  return base ? `${base}/analytics?customer_id=${encodeURIComponent(customerId)}` : null;
}

/** The whole alert line: code, customer, and the link when there is one. */
export function proofAlertText(
  code: ProofAlertCode,
  customerId: string,
  origin: string | undefined,
): string {
  const link = dashboardLink(origin, customerId);
  return `[rawuser ops] ${code} · ${customerId}${link ? ` · ${link}` : ""}`;
}

/** The dedupe key: per customer, and per test where a test is the subject. */
export function proofAlertKey(code: ProofAlertCode, customerId: string, scope?: string): string {
  return scope ? `${code}:${customerId}:${scope}` : `${code}:${customerId}`;
}
