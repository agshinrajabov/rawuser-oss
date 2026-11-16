/**
 * What a customer's own session reads of its versions, and how often it may
 * have one rewritten (docs/specs/versions-for-every-customer.md).
 *
 * The endpoints were already scoped to the customer's own `customer_id`
 * (scope.ts). This module trims what they answer to a customer: no cost, no
 * model, no rule name, no prompt hash, no key, no error text as stored. A
 * superadmin's answers are untouched. And it holds the daily caps that keep
 * a rewrite from being a way to spend.
 *
 * Privacy: operator data only (the customer's own rows, bodies and two daily
 * counters in KV). Nothing about a visitor.
 */

import {
  INTENT_DIMENSIONS,
  type VariantBody,
  marketOfSource,
  normalizePath,
  variantKeyForPath,
} from "@rawuser/shared";
import { confirmedPaths } from "../audit/caps.ts";
import { PROVIDER_DOWN } from "../call-model.ts";
import { GENERATED_SOURCE_DIMS } from "../prompts/source-modifiers.ts";
import type { SessionUser } from "./auth.ts";

/** Rewrites a customer may ask for in one UTC day (the founder's number to set). */
export const CUSTOMER_REWRITES_PER_DAY = 10;
/** "Rewrite everything" a customer may start in one UTC day. */
export const CUSTOMER_REWRITE_ALLS_PER_DAY = 1;
const COUNTER_TTL_S = 2 * 24 * 3600;

export const REWRITE_CAP_LINE = `You have had ${CUSTOMER_REWRITES_PER_DAY} versions rewritten today. More tomorrow.`;
export const REWRITE_ALL_LINE = "Everything was rewritten today already. Try again tomorrow.";

/** The source names a version is written for: everyone else, then the five sources. */
export const VERSION_SOURCES: readonly string[] = ["default", ...GENERATED_SOURCE_DIMS];

export function isCustomer(user: SessionUser): boolean {
  return user.role === "customer";
}

// ---------------------------------------------------------------------------
// Trimmed answers
// ---------------------------------------------------------------------------

/** The three causes the Live screen says in its own words (dashboard lib/versions.ts). */
const CAUSES: ReadonlyArray<[RegExp, string]> = [
  [/parts could not be written|no part is left to write/, "parts could not be written"],
  [/two parts still say the same thing/, "two parts still say the same thing"],
  [/headline lost its structure/, "headline lost its structure"],
];

/** A stored reason as a customer may read it: one of the three cause phrases, else empty. */
export function customerReason(reason: string | null | undefined): string {
  const r = reason ?? "";
  for (const [re, phrase] of CAUSES) if (re.test(r)) return phrase;
  return "";
}

/** The words a write answer may carry to a customer; anything else is reduced. */
const OPEN_ERRORS = new Set(["not_served", "waiting", "nothing_to_write", "sensitive_page"]);

/** A write's `error` for a customer: a closed word or a cause phrase, never the stored text. */
export function customerError(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  if (OPEN_ERRORS.has(error)) return error;
  if (!error.startsWith("lint:") && PROVIDER_DOWN.test(error)) return "service_down";
  return customerReason(error) || "not_written";
}

interface ListItem {
  intent_dim: string;
  source_dim: string;
  page_path: string;
  generated_at: number;
  status: string;
  kv_key: string;
  parts_as_built: Array<{ path: string; rule: string }>;
  [k: string]: unknown;
}

/**
 * A list row for a customer. `kv_key` stays: the Live screen keys its rows on
 * it and never shows it; it names the customer's own cell, nothing else.
 */
export function listItemForCustomer(item: ListItem): Record<string, unknown> {
  return {
    intent_dim: item.intent_dim,
    source_dim: item.source_dim,
    page_path: item.page_path,
    generated_at: item.generated_at,
    status: item.status,
    kv_key: item.kv_key,
    parts_as_built: item.parts_as_built.map((p) => ({ path: p.path })),
    // The approval state (docs/specs/versions-approval.md); never the body id.
    pending: item.pending === true,
    pending_since: typeof item.pending_since === "number" ? item.pending_since : null,
    approval: item.approval === "waiting" ? "waiting" : "approved",
    waiting_since: typeof item.waiting_since === "number" ? item.waiting_since : null,
  };
}

/** A summary's refused rows with their reason reduced to a cause phrase. */
export function summaryForCustomer<T extends { refused_rows: Array<{ error_reason: string }> }>(
  summary: T,
): T {
  return {
    ...summary,
    refused_rows: summary.refused_rows.map((r) => ({
      ...r,
      error_reason: customerReason(r.error_reason),
    })),
  };
}

/** A version body for a customer: its own words, without the provenance fields. */
export function bodyForCustomer(body: VariantBody): Record<string, unknown> {
  const { prompt_hash: _p, profile_key: _k, body_id: _b, ...rest } = body;
  return rest;
}

interface WriteAnswer {
  customer_id: string;
  intent_dim: string;
  source_dim: string;
  ok: boolean;
  error?: string;
  body?: VariantBody;
  parts_as_built?: Array<{ path: string; rule?: string }>;
  next_try?: unknown;
  [k: string]: unknown;
}

/** A write's answer for a customer: no key, cost, provenance or stored error text. */
export function writeAnswerForCustomer(
  answer: WriteAnswer,
  rewritesLeft: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    customer_id: answer.customer_id,
    intent_dim: answer.intent_dim,
    source_dim: answer.source_dim,
    ok: answer.ok,
    rewrites_left: rewritesLeft,
  };
  const error = customerError(answer.error);
  if (error !== undefined) out.error = error;
  if (typeof answer.next_try === "number") out.next_try = answer.next_try;
  // A written version that waits for the customer's OK, or a cell the loop
  // leaves because its version waits or was discarded (versions-approval.md).
  if (answer.pending === true) out.pending = true;
  if (answer.approval === "waiting" || answer.approval === "discarded") {
    out.approval = answer.approval;
  }
  if (answer.body) out.body = bodyForCustomer(answer.body);
  if (answer.parts_as_built)
    out.parts_as_built = answer.parts_as_built.map((p) => ({ path: p.path }));
  return out;
}

// ---------------------------------------------------------------------------
// The daily caps
// ---------------------------------------------------------------------------

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function rewritesKey(customerId: string, now = Date.now()): string {
  return `v1:rewrites:${customerId}:${utcDay(now)}`;
}

export function rewriteAllKey(customerId: string, now = Date.now()): string {
  return `v1:rewrite-all:${customerId}:${utcDay(now)}`;
}

async function used(kv: KVNamespace, key: string): Promise<number> {
  try {
    const v = Number(await kv.get(key));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  } catch {
    return 0;
  }
}

/** Rewrites left today for a customer. */
export async function rewritesLeft(
  kv: KVNamespace,
  customerId: string,
  now = Date.now(),
): Promise<number> {
  return Math.max(0, CUSTOMER_REWRITES_PER_DAY - (await used(kv, rewritesKey(customerId, now))));
}

/**
 * Take one from a counter. False when the day's count is reached. Not atomic
 * (KV): two calls in the same instant can both take the last one.
 */
async function take(kv: KVNamespace, key: string, max: number): Promise<boolean> {
  const n = await used(kv, key);
  if (n >= max) return false;
  await kv.put(key, String(n + 1), { expirationTtl: COUNTER_TTL_S });
  return true;
}

export function takeRewrite(
  kv: KVNamespace,
  customerId: string,
  now = Date.now(),
): Promise<boolean> {
  return take(kv, rewritesKey(customerId, now), CUSTOMER_REWRITES_PER_DAY);
}

export function takeRewriteAll(
  kv: KVNamespace,
  customerId: string,
  now = Date.now(),
): Promise<boolean> {
  return take(kv, rewriteAllKey(customerId, now), CUSTOMER_REWRITE_ALLS_PER_DAY);
}

export interface WriteAsk {
  customer_id: string;
  intent_dim: string;
  source_dim: string;
  page_path?: string;
  auto?: boolean;
}

/**
 * Whether a customer's write takes one rewrite from the day: true for a
 * written version (ready), a failed one asked for by hand (error, not auto)
 * and any version of a page with no confirmed manifest. False for a version
 * Rawuser owes: never written on a confirmed page, marked to be written
 * again (stale), or the Live loop's own retry of a failed row (auto, held to
 * one try in six hours by the tried marker).
 */
export async function countsAsRewrite(db: D1Database, ask: WriteAsk): Promise<boolean> {
  const page = normalizePath(ask.page_path);
  const kvKey = variantKeyForPath(ask.customer_id, page, ask.intent_dim, ask.source_dim);
  const row = await db
    .prepare("SELECT status FROM variants WHERE customer_id = ? AND kv_key = ?")
    .bind(ask.customer_id, kvKey)
    .first<{ status: string }>();
  if (row?.status === "stale") return false;
  if (row?.status === "error") return ask.auto !== true;
  if (row?.status === "ready") return true;
  // A version written and waiting for an OK, or one the customer discarded:
  // writing it again by hand is a rewrite (versions-approval.md).
  if (row?.status === "pending" || row?.status === "discarded") return true;
  return !(await confirmedPaths(db, ask.customer_id)).includes(page);
}

/** A customer's names must be ones a version is written for (else 400). */
export function knownCell(intent: string, source: string): boolean {
  // A market version's cell is `brand` and `mk-{cc}` (docs/specs/direct-visitors.md §5).
  if (marketOfSource(source)) return intent === "brand" && source === source.toLowerCase();
  return (
    (INTENT_DIMENSIONS as readonly string[]).includes(intent) && VERSION_SOURCES.includes(source)
  );
}

/** The 409 body of a cap refusal. */
export function rewriteCapBody(code: "rewrite_cap" | "rewrite_all_used"): {
  error: string;
  message: string;
  rewrites_left?: number;
} {
  return code === "rewrite_cap"
    ? { error: code, message: REWRITE_CAP_LINE, rewrites_left: 0 }
    : { error: code, message: REWRITE_ALL_LINE };
}
