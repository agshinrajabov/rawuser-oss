/**
 * Admin auth helper — session-based, backed by D1 superadmin_users + superadmin_sessions.
 *
 * Wire format unchanged: clients send X-Rawuser-Admin: <raw token>.
 * Server hashes the token with SHA-256 and looks it up in D1.
 * The old ADMIN_TOKEN env-var string-equality approach is retired (see ADR 0015).
 *
 * Lifetimes (docs/specs/security-hardening.md, section 1.3) are enforced in
 * the lookup itself: 7 days from creation whatever `expires_at` says (so a
 * session minted before 2026-10-06 with 30 days ends at 7 too), and 12 hours
 * since the last request.
 */

import { hashSessionToken } from "../auth/password.ts";
import {
  LAST_SEEN_WRITE_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  type SessionScope,
} from "../auth/session.ts";

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  /**
   * NULL for role='superadmin' (sees everything).
   * Non-null for role='customer' (scoped to that single customer).
   * Added in migration 0009 (V2 M3 Batch C, Part 1).
   */
  customer_id: string | null;
  /**
   * 'enrol' when the session may only set up two-step sign-in (its role
   * requires it and it is not on). Absent means 'full'.
   */
  scope?: SessionScope;
}

export interface SessionEnv {
  DB: D1Database;
  /** Comma list of roles that must use two-step sign-in ("superadmin", "customer"). */
  MFA_REQUIRED_ROLES?: string;
}

/** The roles that must use two-step sign-in, from the comma list in [vars]. */
export function mfaRequiredRoles(env: { MFA_REQUIRED_ROLES?: string }): Set<string> {
  return new Set(
    (env.MFA_REQUIRED_ROLES ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean),
  );
}

export function mfaRequiredFor(env: { MFA_REQUIRED_ROLES?: string }, role: string): boolean {
  return mfaRequiredRoles(env).has(role);
}

interface SessionRow {
  id: string;
  email: string;
  role: string;
  customer_id: string | null;
  scope?: string | null;
  last_seen_at?: number | null;
  mfa_status?: string | null;
}

/**
 * Look up the current session from the X-Rawuser-Admin header.
 * Returns null on missing, expired, idle, or invalid token.
 *
 * Writes last_seen_at in the background (at most every five minutes) when
 * ctx is provided.
 */
export async function getSessionUser(
  request: Request,
  env: SessionEnv,
  ctx?: ExecutionContext,
): Promise<SessionUser | null> {
  const provided = request.headers.get("X-Rawuser-Admin");
  if (!provided) return null;

  const tokenHash = await hashSessionToken(provided);
  const now = Date.now();

  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.customer_id,
            s.scope AS scope, s.last_seen_at AS last_seen_at, m.status AS mfa_status
     FROM superadmin_sessions s
     JOIN superadmin_users u ON s.user_id = u.id
     LEFT JOIN user_mfa m ON m.user_id = u.id
     WHERE s.token_hash = ? AND s.expires_at > ?
       AND s.created_at > ? AND COALESCE(s.last_seen_at, s.created_at) > ?`,
  )
    .bind(tokenHash, now, now - SESSION_ABSOLUTE_MS, now - SESSION_IDLE_MS)
    .first<SessionRow>();

  if (!row) return null;

  // The idle timeout reads last_seen_at, so it must move; once per five
  // minutes is enough and saves a D1 write on every dashboard request.
  const lastSeen = Number(row.last_seen_at);
  if (ctx && !(lastSeen > now - LAST_SEEN_WRITE_MS)) {
    ctx.waitUntil(
      env.DB.prepare("UPDATE superadmin_sessions SET last_seen_at = ? WHERE token_hash = ?")
        .bind(now, tokenHash)
        .run(),
    );
  }

  // A role that must use two-step and has not turned it on gets the enrol
  // scope even on a full session made before the requirement.
  const enrol =
    row.scope === "enrol" || (mfaRequiredFor(env, row.role) && row.mfa_status !== "active");

  const user: SessionUser = {
    id: row.id,
    email: row.email,
    role: row.role,
    customer_id: row.customer_id,
  };
  if (enrol) user.scope = "enrol";
  return user;
}
