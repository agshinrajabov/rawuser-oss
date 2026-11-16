/**
 * The audit's life (docs/specs/ai-traffic-audit.md §3.5, §3.8, §3.9, §6):
 * the hourly check (window start, day-7 extension, row cap, build, end,
 * lapse), release, a new share link, revoke, End now, the pilot terms, Make
 * this a pilot, and the 60-day delete. Offline only; the edge reads the
 * outcome from the visitor bundle (`a`, `ad`, `ae`).
 */

import { countCustomerData, deleteCustomerData } from "../admin/customer-data.ts";
import { writeHideRules, writeVisitorBundle } from "../admin/onboard.ts";
import { setHoldout } from "../admin/proof.ts";
import { hashSessionToken } from "../auth/password.ts";
import { sendOpsAlert } from "../cron/ops-heartbeat.ts";
import { type InstallEnv, dashboardPointer } from "../install-config.ts";
import { buildTuples } from "../orchestrator.ts";
import { loadServedIntents } from "../site-map/served-load.ts";
import {
  AUDIT_CEILING_MS,
  AUDIT_END_AFTER_RELEASE_MS,
  AUDIT_EXTENDED_MS,
  AUDIT_KEEP_MS,
  AUDIT_LAPSE_MS,
  AUDIT_LINK_MS,
  AUDIT_MAX_ROWS,
  AUDIT_MIN_VISITS,
  AUDIT_START_ANYWAY_MS,
  AUDIT_WINDOW_MS,
} from "./constants.ts";
import { type ReportDeps, buildAuditReport } from "./report.ts";

const HOUR = 60 * 60 * 1000;

export interface AuditEnv extends Pick<InstallEnv, "BOT_INFO_URL"> {
  DB: D1Database;
  VARIANTS: KVNamespace;
  ALERT_WEBHOOK_URL?: string;
  DASHBOARD_ORIGIN?: string;
}

export interface AuditCustomerRow {
  id: string;
  domain: string;
  plan: string;
  status: string;
  created_at: number;
  live_at: number | null;
  audit_from: number | null;
  audit_to: number | null;
  audit_ends_at: number | null;
  audit_terms_at: number | null;
  audit_consent_banner: number | null;
  audit_spend_usd: number | null;
  audit_rewrites: number | null;
  audit_ended_at: number | null;
  audit_delete_at: number | null;
  pilot_terms_at: number | null;
}

export const AUDIT_COLUMNS = `id, domain, plan, status, created_at, live_at, audit_from, audit_to,
  audit_ends_at, audit_terms_at, audit_consent_banner, audit_spend_usd, audit_rewrites,
  audit_ended_at, audit_delete_at, pilot_terms_at`;

export async function loadAuditCustomer(
  db: D1Database,
  customerId: string,
): Promise<AuditCustomerRow | null> {
  return db
    .prepare(`SELECT ${AUDIT_COLUMNS} FROM customers WHERE id = ?`)
    .bind(customerId)
    .first<AuditCustomerRow>();
}

/** A customer that is, or was, an audit (an upgraded pilot keeps audit_terms_at). */
export function wasAudit(c: AuditCustomerRow): boolean {
  return c.plan === "audit" || c.audit_terms_at !== null;
}

// ---------------------------------------------------------------------------
// Versions written
// ---------------------------------------------------------------------------

function pathPattern(customerId: string, path: string): { like: string; notLike: string | null } {
  return path === "/"
    ? { like: `v1:variant:${customerId}:%`, notLike: `v1:variant:${customerId}:p:%` }
    : { like: `v1:variant:${customerId}:p:${encodeURIComponent(path)}:%`, notLike: null };
}

/**
 * Ready versions of the confirmed pages against their total (served
 * intents times six sources per page), and whether every page confirmed at
 * the first go live has all of its versions (§3.5).
 */
export async function writtenCounts(
  db: D1Database,
  customerId: string,
  liveAt: number | null,
): Promise<{ written: number; total: number; firstReady: boolean }> {
  const pages = await db
    .prepare(
      "SELECT page_path, confirmed_at FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL",
    )
    .bind(customerId)
    .all<{ page_path: string; confirmed_at: number }>();
  const per = buildTuples(await loadServedIntents(customerId, db)).length;
  let written = 0;
  let total = 0;
  const all = pages.results ?? [];
  const first = liveAt === null ? [] : all.filter((p) => p.confirmed_at <= liveAt);
  const firstPaths = new Set((first.length > 0 ? first : all).map((p) => p.page_path));
  let firstReady = all.length > 0;
  for (const p of all) {
    const pat = pathPattern(customerId, p.page_path);
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM variants WHERE customer_id = ? AND status = 'ready' AND kv_key LIKE ?${pat.notLike ? " AND kv_key NOT LIKE ?" : ""}`,
      )
      .bind(customerId, pat.like, ...(pat.notLike ? [pat.notLike] : []))
      .first<{ n: number }>();
    const n = Math.min(per, Number(row?.n ?? 0));
    written += n;
    total += per;
    if (firstPaths.has(p.page_path) && n < per) firstReady = false;
  }
  return { written, total, firstReady };
}

/** Visits and rows in [start, end). */
export async function windowCounts(
  db: D1Database,
  customerId: string,
  start: number,
  end: number,
): Promise<{ visits: number; rows: number }> {
  const r = await db
    .prepare(
      `SELECT COUNT(DISTINCT COALESCE(visit, id)) AS visits, COUNT(*) AS rows
       FROM events
       WHERE customer_id = ? AND ts >= ? AND ts < ?
         AND event_type IN ('variant_shown', 'select', 'no_signal_passthrough', 'personalization_skipped')`,
    )
    .bind(customerId, start, end)
    .first<{ visits: number; rows: number }>();
  return { visits: Number(r?.visits ?? 0), rows: Number(r?.rows ?? 0) };
}

export async function reportRow(
  db: D1Database,
  customerId: string,
): Promise<{
  window_start: number;
  window_end: number;
  state: string;
  report: string;
  built_at: number;
  released_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
} | null> {
  return db
    .prepare(
      `SELECT window_start, window_end, state, report, built_at, released_at, expires_at, revoked_at
       FROM audit_reports WHERE customer_id = ? ORDER BY window_start DESC LIMIT 1`,
    )
    .bind(customerId)
    .first();
}

// ---------------------------------------------------------------------------
// The end (§3.8)
// ---------------------------------------------------------------------------

export type EndCause = "end_date" | "end_now" | "lapse";

/**
 * End an audit: status 'ended', `ae` at the end, the running test ended with
 * audit_end, the script without hide rules (writeHideRules writes none for
 * an ended customer) and the bundle with `ae`. The delete date: 60 days
 * after the report (its release, else its build), after sign-up for a
 * lapse, else after the end.
 */
export async function endAudit(
  env: AuditEnv,
  customerId: string,
  now: number,
  cause: EndCause,
): Promise<{ ended_at: number; delete_at: number } | null> {
  const c = await loadAuditCustomer(env.DB, customerId);
  if (!c || c.plan !== "audit" || c.status === "ended") return null;
  const rep = await reportRow(env.DB, customerId);
  const from = cause === "lapse" ? c.created_at : (rep?.released_at ?? rep?.built_at ?? now);
  const deleteAt = from + AUDIT_KEEP_MS;
  const endsAt = c.audit_ends_at !== null && c.audit_ends_at <= now ? c.audit_ends_at : now;
  await env.DB.prepare(
    `UPDATE customers SET status = 'ended', audit_ended_at = ?, audit_ends_at = ?, audit_delete_at = ?
     WHERE id = ? AND plan = 'audit' AND status != 'ended'`,
  )
    .bind(now, endsAt, deleteAt, customerId)
    .run();
  // A running test ends with the audit (§3.7; ADR 0022 amended).
  const running = await env.DB.prepare(
    "SELECT id FROM holdout_tests WHERE customer_id = ? AND ended_at IS NULL LIMIT 1",
  )
    .bind(customerId)
    .first<{ id: string }>();
  if (running) {
    await setHoldout(env, customerId, 0, now, {
      by: "system",
      actor: "system",
      endReason: "audit_end",
    });
  }
  await writeHideRules(env, customerId);
  await writeVisitorBundle(env, customerId);
  return { ended_at: now, delete_at: deleteAt };
}

// ---------------------------------------------------------------------------
// The hourly check (§3.5)
// ---------------------------------------------------------------------------

export interface AuditCheckResult {
  started: string[];
  extended: string[];
  built: string[];
  ended: string[];
  lapsed: string[];
  /** Ended audits whose late rows (written after `ae`) were deleted this run. */
  cleaned: string[];
  failed: string[];
}

/**
 * Nothing kept after the end (the privacy review's pre-deploy review, fix 2):
 * End now and a lapse set `ae` to now, but the edge reads the bundle
 * through a 300 s cache and `/event` adds a five-minute memo, so rows up to
 * about ten minutes late can still be written. Every hourly run deletes an
 * ended audit's event rows from `ae` on. Indexed on (customer_id, ts); an
 * ended audit with no late rows costs one statement.
 */
export async function purgeAfterEnd(env: AuditEnv): Promise<string[]> {
  const ended = await env.DB.prepare(
    `SELECT id, audit_ends_at FROM customers
     WHERE plan = 'audit' AND status = 'ended' AND audit_ends_at IS NOT NULL`,
  ).all<{ id: string; audit_ends_at: number }>();
  const cleaned: string[] = [];
  for (const c of ended.results ?? []) {
    const r = await env.DB.prepare("DELETE FROM events WHERE customer_id = ? AND ts >= ?")
      .bind(c.id, c.audit_ends_at)
      .run();
    if (Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0) cleaned.push(c.id);
  }
  return cleaned;
}

async function setWindow(
  env: AuditEnv,
  customerId: string,
  fields: {
    audit_from?: number;
    audit_to?: number;
    audit_ends_at?: number;
    audit_start_written?: number;
    audit_start_total?: number;
  },
): Promise<void> {
  const sets = Object.keys(fields).map((k) => `${k} = ?`);
  await env.DB.prepare(`UPDATE customers SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...Object.values(fields), customerId)
    .run();
}

/** One audit customer's hour. Returns what happened, or null for nothing. */
export async function checkOneAudit(
  env: AuditEnv,
  c: AuditCustomerRow,
  now: number,
  deps: ReportDeps = {},
): Promise<keyof Omit<AuditCheckResult, "failed" | "cleaned"> | null> {
  // No go live within 14 days of sign-up: the audit lapses.
  if (c.live_at === null) {
    if (now - c.created_at >= AUDIT_LAPSE_MS) {
      await endAudit(env, c.id, now, "lapse");
      return "lapsed";
    }
    return null;
  }

  // The window starts after the first go live's versions are written.
  if (c.audit_from === null) {
    const w = await writtenCounts(env.DB, c.id, c.live_at);
    if (!w.firstReady && now - c.live_at < AUDIT_START_ANYWAY_MS) return null;
    const from = Math.ceil(now / HOUR) * HOUR;
    // The versions written when counting began: the report says it, so a
    // forced start (48 hours) is never read as a complete set (the
    // the privacy review's note).
    await setWindow(env, c.id, {
      audit_from: from,
      audit_to: from + AUDIT_WINDOW_MS,
      audit_ends_at: from + AUDIT_CEILING_MS,
      audit_start_written: w.written,
      audit_start_total: w.total,
    });
    await writeVisitorBundle(env, c.id);
    return "started";
  }

  // The end date (`ae`): release plus 7 days, at most 28 after the start.
  if (c.audit_ends_at !== null && now >= c.audit_ends_at) {
    await endAudit(env, c.id, now, "end_date");
    return "ended";
  }

  const rep = await reportRow(env.DB, c.id);
  if (rep && rep.window_start === c.audit_from) return null;
  const to = c.audit_to ?? c.audit_from + AUDIT_WINDOW_MS;

  // The cap: 100,000 rows close the window at this hour.
  if (now < to && now > c.audit_from) {
    const so = await windowCounts(env.DB, c.id, c.audit_from, now);
    if (so.rows >= AUDIT_MAX_ROWS) {
      const end = Math.max(c.audit_from + HOUR, Math.floor(now / HOUR) * HOUR);
      await setWindow(env, c.id, { audit_to: end });
      await build(env, c.id, { start: c.audit_from, end }, now, deps);
      return "built";
    }
    return null;
  }
  if (now < to) return null;

  // Day 7 with under 300 visits: one week more, once.
  const counted = await windowCounts(env.DB, c.id, c.audit_from, to);
  if (to - c.audit_from < AUDIT_EXTENDED_MS && counted.visits < AUDIT_MIN_VISITS) {
    await setWindow(env, c.id, { audit_to: c.audit_from + AUDIT_EXTENDED_MS });
    return "extended";
  }
  await build(env, c.id, { start: c.audit_from, end: to }, now, deps);
  return "built";
}

async function build(
  env: AuditEnv,
  customerId: string,
  window: { start: number; end: number },
  now: number,
  deps: ReportDeps,
): Promise<void> {
  await buildAuditReport(env, customerId, window, now, deps);
  // The customer id and a link only, never a number (the report is the founder's to read).
  await sendOpsAlert(
    env as never,
    `audit-report:${customerId}`,
    `[rawuser ops] audit-report: ${customerId} is ready to review${dashboardPointer(env, "/applications")}`,
    30 * 24 * 3600,
  ).catch(() => undefined);
}

/** Every open audit's hour (index.ts, the hourly cron). One customer's failure never stops the others. */
export async function runAuditCheck(
  env: AuditEnv,
  now: number = Date.now(),
  deps: ReportDeps = {},
): Promise<AuditCheckResult> {
  const out: AuditCheckResult = {
    started: [],
    extended: [],
    built: [],
    ended: [],
    lapsed: [],
    cleaned: [],
    failed: [],
  };
  try {
    out.cleaned = await purgeAfterEnd(env);
  } catch {
    console.error("[audit] late rows after the end not deleted; the next run tries again");
  }
  const rows = await env.DB.prepare(
    `SELECT ${AUDIT_COLUMNS} FROM customers WHERE plan = 'audit' AND status = 'active'`,
  ).all<AuditCustomerRow>();
  for (const c of rows.results ?? []) {
    try {
      const what = await checkOneAudit(env, c, now, deps);
      if (what) out[what].push(c.id);
    } catch (e) {
      out.failed.push(c.id);
      console.error(`[audit] check ${c.id}:`, e instanceof Error ? e.name : "error");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Release, share link, revoke (§6; privacy review condition 3)
// ---------------------------------------------------------------------------

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function reportLink(origin: string | undefined, token: string): string {
  const base = origin && origin !== "*" ? origin : "http://localhost:3000";
  return `${base}/audit/report/#t=${token}`;
}

export type ReleaseResult =
  | { ok: true; token: string; expires_at: number; ends_at: number | null }
  | { ok: false; error: "not_found" | "not_built" | "revoked" | "expired" | "not_released" };

/**
 * Release the built report: a share token (its hash stored), 90 days, and
 * the end date at release plus 7 days, never past the 28-day ceiling. A
 * second release (a revoked report opened again) mints a new link and moves
 * nothing else.
 */
export async function releaseReport(
  env: AuditEnv,
  customerId: string,
  now: number,
): Promise<ReleaseResult> {
  const c = await loadAuditCustomer(env.DB, customerId);
  if (!c || !wasAudit(c)) return { ok: false, error: "not_found" };
  const rep = await reportRow(env.DB, customerId);
  if (!rep) return { ok: false, error: "not_built" };
  const token = newToken();
  const hash = await hashSessionToken(token);
  const releasedAt = rep.released_at ?? now;
  const expiresAt = releasedAt + AUDIT_LINK_MS;
  await env.DB.prepare(
    `UPDATE audit_reports SET released_at = ?, token_hash = ?, expires_at = ?, revoked_at = NULL
     WHERE customer_id = ? AND window_start = ?`,
  )
    .bind(releasedAt, hash, expiresAt, customerId, rep.window_start)
    .run();
  let endsAt = c.audit_ends_at;
  if (
    rep.released_at === null &&
    c.plan === "audit" &&
    c.status === "active" &&
    c.audit_from !== null
  ) {
    const ceiling = c.audit_from + AUDIT_CEILING_MS;
    endsAt = Math.min(now + AUDIT_END_AFTER_RELEASE_MS, ceiling, c.audit_ends_at ?? ceiling);
    await setWindow(env, customerId, { audit_ends_at: endsAt });
    await writeVisitorBundle(env, customerId);
  }
  return { ok: true, token, expires_at: expiresAt, ends_at: endsAt };
}

/** A new share link for a released report; the old one stops working (condition 3). */
export async function mintShareLink(
  env: AuditEnv,
  customerId: string,
  now: number,
): Promise<ReleaseResult> {
  const rep = await reportRow(env.DB, customerId);
  if (!rep) return { ok: false, error: "not_built" };
  if (rep.released_at === null) return { ok: false, error: "not_released" };
  if (rep.revoked_at !== null) return { ok: false, error: "revoked" };
  if (rep.expires_at !== null && rep.expires_at <= now) return { ok: false, error: "expired" };
  const token = newToken();
  await env.DB.prepare(
    "UPDATE audit_reports SET token_hash = ? WHERE customer_id = ? AND window_start = ?",
  )
    .bind(await hashSessionToken(token), customerId, rep.window_start)
    .run();
  const c = await loadAuditCustomer(env.DB, customerId);
  return { ok: true, token, expires_at: rep.expires_at ?? now, ends_at: c?.audit_ends_at ?? null };
}

export async function revokeReport(
  env: AuditEnv,
  customerId: string,
  now: number,
): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE audit_reports SET revoked_at = ?, token_hash = NULL
     WHERE customer_id = ? AND released_at IS NOT NULL AND revoked_at IS NULL`,
  )
    .bind(now, customerId)
    .run();
  return Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

/**
 * The released snapshot by its share token, or null: unknown, unreleased,
 * revoked and expired all read the same (the public endpoint answers 404).
 */
export async function reportByToken(
  db: D1Database,
  token: unknown,
  now: number,
): Promise<{ report: string; released_at: number; expires_at: number } | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const row = await db
    .prepare(
      `SELECT report, released_at, expires_at FROM audit_reports
       WHERE token_hash = ? AND released_at IS NOT NULL AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(await hashSessionToken(token), now)
    .first<{ report: string; released_at: number; expires_at: number }>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Pilot terms and the upgrade (§3.9; privacy review condition 5)
// ---------------------------------------------------------------------------

export async function recordPilotTerms(
  env: AuditEnv,
  customerId: string,
  at: number,
): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE customers SET pilot_terms_at = ? WHERE id = ?")
    .bind(at, customerId)
    .run();
  return Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

export type MakePilotResult =
  | { ok: true; was_ended: boolean }
  | { ok: false; error: "not_found" | "not_an_audit" | "pilot_terms_missing" };

/**
 * "Make this a pilot": refused until the signed pilot terms are recorded.
 * plan 'pilot'; `a`, `ad` and `ae` leave the bundle; the end and delete
 * dates are cleared; audit_from, audit_to and the report stay for the
 * record. After an end, status 'active' and the script's hide rules come
 * back; a test never restarts by itself.
 */
export async function makePilot(env: AuditEnv, customerId: string): Promise<MakePilotResult> {
  const c = await loadAuditCustomer(env.DB, customerId);
  if (!c) return { ok: false, error: "not_found" };
  if (c.plan !== "audit") return { ok: false, error: "not_an_audit" };
  if (c.pilot_terms_at === null) return { ok: false, error: "pilot_terms_missing" };
  await env.DB.prepare(
    `UPDATE customers SET plan = 'pilot', status = 'active', audit_ends_at = NULL, audit_delete_at = NULL
     WHERE id = ? AND plan = 'audit' AND pilot_terms_at IS NOT NULL`,
  )
    .bind(customerId)
    .run();
  await writeHideRules(env, customerId);
  await writeVisitorBundle(env, customerId);
  return { ok: true, was_ended: c.status === "ended" };
}

// ---------------------------------------------------------------------------
// The 60-day delete (§3.8; privacy review condition 4)
// ---------------------------------------------------------------------------

/**
 * Ended audits past their delete date go through the per-customer delete
 * (which writes the tombstone first), one due audit per run. One ops line
 * when a delete finishes, with counts only (of what the finishing run found).
 * A delete cut off by its budget finishes on a later run.
 */
export async function sweepAuditDeletes(
  env: AuditEnv,
  now: number = Date.now(),
  opts: { budget?: number } = {},
): Promise<{ deleted: string[]; pending: string[] }> {
  const out = { deleted: [] as string[], pending: [] as string[] };
  // One due audit per hourly run (the privacy review's fix 1): the hourly cron
  // shares its subrequest limit with the other jobs. The customers row
  // goes last in deleteCustomerData, so a cut-off run is found again here.
  const due = await env.DB.prepare(
    `SELECT id FROM customers
     WHERE plan = 'audit' AND status = 'ended' AND audit_delete_at IS NOT NULL AND audit_delete_at <= ?
     ORDER BY audit_delete_at, id LIMIT 1`,
  )
    .bind(now)
    .all<{ id: string }>();
  for (const { id } of due.results ?? []) {
    try {
      const counts = await countCustomerData(env, id);
      const run = await deleteCustomerData(env, id, opts);
      if (!run.done) {
        out.pending.push(id);
        continue;
      }
      out.deleted.push(id);
      const rows = Object.values(counts.d1).reduce((s, n) => s + n, 0);
      const keys = Object.values(counts.kv).reduce((s, n) => s + n, 0);
      await sendOpsAlert(
        env as never,
        `audit-deleted:${id}`,
        `[rawuser ops] audit-deleted: ${id}, 60 days after the report; ${rows} rows and ${keys} keys (add "${id} ${new Date(now).toISOString().slice(0, 10)}" to ops/deletions.md)`,
        30 * 24 * 3600,
      ).catch(() => undefined);
    } catch (e) {
      out.pending.push(id);
      console.error(`[audit] delete ${id}:`, e instanceof Error ? e.name : "error");
    }
  }
  return out;
}
