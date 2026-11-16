/**
 * Dashboard session lifetimes and the helpers that create and end sessions
 * (docs/specs/security-hardening.md, section 1.3).
 *
 * Both limits are enforced in the lookup (admin/auth.ts getSessionUser), so
 * a session created before this change with a 30-day expires_at ends at
 * seven days of age as well.
 */

import { generateSessionToken, hashSessionToken } from "./password.ts";

/** Absolute lifetime of a full session (was 30 days until 2026-10-06). */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
/** A session unused this long is refused. */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
/** A session that may only set up two-step sign-in. */
export const ENROL_SESSION_MS = 15 * 60 * 1000;
/** last_seen_at is written at most this often (it decides the idle timeout). */
export const LAST_SEEN_WRITE_MS = 5 * 60 * 1000;

export type SessionScope = "full" | "enrol";

/** Mint a session; returns the raw token for the client (only its hash is stored). */
export async function createSession(
  db: D1Database,
  userId: string,
  scope: SessionScope,
  userAgent: string | null,
  now: number,
): Promise<string> {
  const token = generateSessionToken();
  const tokenHash = await hashSessionToken(token);
  const expiresAt = now + (scope === "enrol" ? ENROL_SESSION_MS : SESSION_ABSOLUTE_MS);
  await db
    .prepare(
      `INSERT INTO superadmin_sessions
         (token_hash, user_id, expires_at, created_at, user_agent, last_seen_at, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(tokenHash, userId, expiresAt, now, userAgent, now, scope)
    .run();
  return token;
}

/**
 * End a user's sessions: all of them, or all but the one whose hash is
 * given. Returns how many ended.
 */
export async function revokeUserSessions(
  db: D1Database,
  userId: string,
  exceptTokenHash?: string,
): Promise<number> {
  const r = exceptTokenHash
    ? await db
        .prepare("DELETE FROM superadmin_sessions WHERE user_id = ? AND token_hash != ?")
        .bind(userId, exceptTokenHash)
        .run()
    : await db.prepare("DELETE FROM superadmin_sessions WHERE user_id = ?").bind(userId).run();
  return Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0);
}

/**
 * How many live sessions the user has besides the one whose hash is given:
 * the same three limits as the lookup (expires_at, 7 days of age, 12 hours
 * idle), so a dead row is never counted. The Account screen's "Sign out
 * everywhere else" says this number before the click (two-step mock, A1).
 */
export async function countOtherSessions(
  db: D1Database,
  userId: string,
  exceptTokenHash: string | null,
  now: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM superadmin_sessions
       WHERE user_id = ? AND token_hash != ?
         AND expires_at > ? AND created_at > ?
         AND COALESCE(last_seen_at, created_at) > ?`,
    )
    .bind(userId, exceptTokenHash ?? "", now, now - SESSION_ABSOLUTE_MS, now - SESSION_IDLE_MS)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** The SHA-256 of the session token the request carries, or null. */
export async function currentTokenHash(request: Request): Promise<string | null> {
  const provided = request.headers.get("X-Rawuser-Admin");
  return provided ? hashSessionToken(provided) : null;
}
