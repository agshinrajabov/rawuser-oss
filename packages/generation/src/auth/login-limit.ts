/**
 * The failed sign-in limit (docs/specs/security-hardening.md, section 1.2).
 *
 * Two layers:
 *
 * - Per IP: the Workers rate-limit binding LOGIN_LIMITER (10 attempts per
 *   60 seconds, counted in Cloudflare's memory per location). Every attempt
 *   counts, before any password hash, so a flood costs no PBKDF2 time. We
 *   store nothing. Absent binding or no client address: fail open.
 * - Per account: a D1 counter in fixed 15-minute windows, keyed "acct:" plus
 *   the SHA-256 of the lowercased email, so an unknown email is counted
 *   exactly like a known one. Locked while the current and the previous
 *   window together hold 10 failures; the lock lifts by itself within 15 to
 *   30 minutes. D1, not KV: the upsert is atomic on one primary, so a
 *   parallel burst on one account is counted exactly.
 */

import { hashSessionToken } from "./password.ts";

export const ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
/** Failures in the current and previous window together that lock an account. */
export const ACCOUNT_FAILURE_LIMIT = 10;
/** Failures across every account in the current window that raise login-burst. */
export const BURST_FAILURE_LIMIT = 30;
/** Rows older than this are deleted by the 6-hour sweep (the lock reads 30 minutes; privacy review, 2026-10-06). */
export const FAILURE_ROW_TTL_MS = 60 * 60 * 1000;
/** Mirrors [[ratelimits]] LOGIN_LIMITER in wrangler.toml; a test holds them equal. */
export const LOGIN_LIMIT_PER_MINUTE = 10;

export const IP_LIMIT_MESSAGE = "Too many sign-in attempts. Wait a minute and try again.";

export function accountLockMessage(retryAfterS: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterS / 60));
  return `Too many failed sign-ins. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/** The counter key for an email: never the email itself. */
export async function accountKey(email: string): Promise<string> {
  return `acct:${await hashSessionToken(email.trim().toLowerCase())}`;
}

export function windowStart(now: number): number {
  return Math.floor(now / ACCOUNT_WINDOW_MS) * ACCOUNT_WINDOW_MS;
}

interface WindowCounts {
  current: number;
  previous: number;
}

async function readWindows(db: D1Database, key: string, now: number): Promise<WindowCounts> {
  const cur = windowStart(now);
  const { results } = await db
    .prepare(
      "SELECT window_start, failures FROM auth_failures WHERE key = ? AND window_start IN (?, ?)",
    )
    .bind(key, cur, cur - ACCOUNT_WINDOW_MS)
    .all<{ window_start: number; failures: number }>();
  let current = 0;
  let previous = 0;
  for (const r of results ?? []) {
    if (Number(r.window_start) === cur) current = Number(r.failures);
    else previous = Number(r.failures);
  }
  return { current, previous };
}

/**
 * Seconds until the account may try again, or 0 when it is not locked.
 * With 10 in the current window alone the lock lasts until that window is
 * no longer the previous one; otherwise until the previous window drops out.
 */
function retryAfterSeconds(counts: WindowCounts, now: number): number {
  if (counts.current + counts.previous < ACCOUNT_FAILURE_LIMIT) return 0;
  const cur = windowStart(now);
  const until =
    counts.current >= ACCOUNT_FAILURE_LIMIT ? cur + 2 * ACCOUNT_WINDOW_MS : cur + ACCOUNT_WINDOW_MS;
  return Math.max(1, Math.ceil((until - now) / 1000));
}

/** 0 when the account may try; otherwise the seconds to wait. */
export async function accountRetryAfter(db: D1Database, key: string, now: number): Promise<number> {
  return retryAfterSeconds(await readWindows(db, key, now), now);
}

export interface FailureResult {
  /** Failures in the current and previous window after this one. */
  total: number;
  /** True exactly when this failure reached the limit (alert once). */
  justLocked: boolean;
  /** Failures across all accounts in the current window. */
  burst: number;
}

/** Count one failure for an account. Atomic upsert, then one read. */
export async function recordFailure(
  db: D1Database,
  key: string,
  now: number,
): Promise<FailureResult> {
  const cur = windowStart(now);
  await db
    .prepare(
      `INSERT INTO auth_failures (key, window_start, failures) VALUES (?, ?, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET failures = failures + 1`,
    )
    .bind(key, cur)
    .run();
  const counts = await readWindows(db, key, now);
  const total = counts.current + counts.previous;
  const burstRow = await db
    .prepare("SELECT COALESCE(SUM(failures), 0) AS n FROM auth_failures WHERE window_start = ?")
    .bind(cur)
    .first<{ n: number }>();
  return {
    total,
    justLocked: total === ACCOUNT_FAILURE_LIMIT,
    burst: Number(burstRow?.n ?? 0),
  };
}

/** A full sign-in (password, and the code when two-step is on) clears the account's rows. */
export async function clearFailures(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM auth_failures WHERE key = ?").bind(key).run();
}

/** Minimal shape of the Workers rate-limit binding. */
export interface LoginRateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * True when this IP may make another attempt. Fails open: no binding, no
 * client address, or a binding error lets the attempt through (the account
 * counter still stands).
 */
export async function ipAllowed(
  limiter: LoginRateLimit | undefined,
  request: Request,
): Promise<boolean> {
  if (!limiter) return true;
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return true;
  try {
    const { success } = await limiter.limit({ key: `ip:${ip}` });
    return success;
  } catch {
    console.error("[rawuser/login] rate limiter unavailable, failing open");
    return true;
  }
}
