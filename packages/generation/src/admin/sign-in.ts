/**
 * Signing in (docs/specs/security-hardening.md, sections 1.2 to 1.4).
 *
 *   POST /admin/login             { email, password }          public
 *   POST /admin/login/mfa         { challenge, code | recovery_code }  public
 *   POST /admin/sessions/revoke-all  { keep_current?: boolean }  session
 *
 * Both public routes pass the per-IP limit first (before any hash), then
 * the per-account lock, then the check. A wrong password and a wrong code
 * count toward the same account limit. The 401 never says whether an email
 * exists.
 */

import {
  BURST_FAILURE_LIMIT,
  IP_LIMIT_MESSAGE,
  type LoginRateLimit,
  accountKey,
  accountLockMessage,
  accountRetryAfter,
  clearFailures,
  ipAllowed,
  recordFailure,
} from "../auth/login-limit.ts";
import {
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_TTL_MS,
  type MfaRow,
  checkSecondFactor,
  createChallenge,
  getMfa,
  recoveryCodesLeft,
} from "../auth/mfa-store.ts";
import { hashPassword, hashSessionToken, verifyPassword } from "../auth/password.ts";
import { createSession, currentTokenHash, revokeUserSessions } from "../auth/session.ts";
import { sendOpsAlert } from "../cron/ops-heartbeat.ts";
import { type SessionUser, mfaRequiredFor } from "./auth.ts";
import { type CorsEnv, corsHeaders, jsonWithCors } from "./cors.ts";

export interface SignInEnv extends CorsEnv {
  DB: D1Database;
  VARIANTS: KVNamespace;
  ALERT_WEBHOOK_URL?: string;
  /** Workers rate-limit binding ([[ratelimits]] LOGIN_LIMITER). Absent: fail open. */
  LOGIN_LIMITER?: LoginRateLimit;
  /** 32 random bytes, base64: seals the two-step secrets. */
  MFA_ENCRYPTION_KEY?: string;
  /** Comma list of roles that must use two-step sign-in. Empty today. */
  MFA_REQUIRED_ROLES?: string;
}

/** Alerts are deduplicated one per hour per type. */
const ALERT_TTL_S = 3600;

export const WRONG_CODE_MESSAGE = "That code did not work. Try again.";
export const DEAD_CHALLENGE_MESSAGE = "Sign in again.";
export const NO_KEY_MESSAGE = "Two-step sign-in is not set up on the server yet.";

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  customer_id: string | null;
}

export function publicUser(u: {
  id: string;
  email: string;
  role: string;
  customer_id: string | null;
}): SessionUser {
  return { id: u.id, email: u.email, role: u.role, customer_id: u.customer_id };
}

/** The role named in an alert: never the email, never the IP. */
export function alertRole(u: { role: string; customer_id: string | null } | null): string {
  if (!u) return "no such account";
  return u.role === "customer" ? `customer ${u.customer_id ?? "?"}` : u.role;
}

export function tooMany(env: CorsEnv, message: string, retryAfterS: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 429,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(retryAfterS),
      "access-control-expose-headers": "Retry-After",
      ...corsHeaders(env),
    },
  });
}

/** Alerts go after the answer when a ctx is given; a failed send never fails a sign-in. */
function later(ctx: ExecutionContext | undefined, p: Promise<unknown>): Promise<void> {
  const safe = p.then(
    () => undefined,
    () => undefined,
  );
  if (ctx) {
    ctx.waitUntil(safe);
    return Promise.resolve();
  }
  return safe;
}

/**
 * One failed attempt on an account: counted, and the lock and burst alerts
 * raised when this failure crossed their line.
 */
export async function countFailure(
  env: SignInEnv,
  ctx: ExecutionContext | undefined,
  key: string,
  who: { role: string; customer_id: string | null } | null,
  now: number,
): Promise<void> {
  const r = await recordFailure(env.DB, key, now);
  if (r.justLocked) {
    await later(
      ctx,
      sendOpsAlert(
        env,
        "login-lock",
        `[rawuser ops] login-lock: an account reached the failed sign-in limit (${alertRole(who)})`,
        ALERT_TTL_S,
      ),
    );
  }
  if (r.burst >= BURST_FAILURE_LIMIT) {
    await later(
      ctx,
      sendOpsAlert(
        env,
        "login-burst",
        `[rawuser ops] login-burst: ${r.burst} failed sign-ins across all accounts in 15 minutes`,
        ALERT_TTL_S,
      ),
    );
  }
}

/** The account lock as a 429, or null when the account may try. */
export async function lockedResponse(
  env: SignInEnv,
  key: string,
  now: number,
): Promise<Response | null> {
  const retry = await accountRetryAfter(env.DB, key, now);
  return retry > 0 ? tooMany(env, accountLockMessage(retry), retry) : null;
}

// A wrong email costs the same PBKDF2 time as a wrong password.
let dummyHash: Promise<string> | null = null;
function timingDummy(): Promise<string> {
  dummyHash ??= hashPassword("rawuser-timing-dummy");
  return dummyHash;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * After a right password: a second-step challenge when two-step is on,
 * an enrol-only session when the role requires it and it is off, a full
 * session otherwise.
 */
export async function answerAfterPassword(
  env: CorsEnv & { DB: D1Database; MFA_REQUIRED_ROLES?: string },
  request: Request,
  user: { id: string; email: string; role: string; customer_id: string | null },
  key: string,
  now: number,
): Promise<Response> {
  const mfa = await getMfa(env.DB, user.id);
  if (mfa?.status === "active") {
    const challenge = await createChallenge(env.DB, user.id, now);
    return jsonWithCors(
      { mfa_required: true, challenge, expires_in: CHALLENGE_TTL_MS / 1000 },
      env,
      200,
    );
  }
  await clearFailures(env.DB, key);
  const ua = request.headers.get("user-agent") ?? null;
  if (mfaRequiredFor(env, user.role)) {
    const token = await createSession(env.DB, user.id, "enrol", ua, now);
    return jsonWithCors({ token, user: publicUser(user), mfa_enrolment_required: true }, env, 200);
  }
  const token = await createSession(env.DB, user.id, "full", ua, now);
  return jsonWithCors({ token, user: publicUser(user) }, env, 200);
}

// ---------------------------------------------------------------------------
// POST /admin/login
// ---------------------------------------------------------------------------

export async function handleLogin(
  request: Request,
  env: SignInEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  const { email, password } = body;
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return jsonWithCors({ error: "email is required" }, env, 400);
  }
  if (!password || typeof password !== "string" || password.length === 0) {
    return jsonWithCors({ error: "password is required" }, env, 400);
  }

  if (!(await ipAllowed(env.LOGIN_LIMITER, request))) {
    return tooMany(env, IP_LIMIT_MESSAGE, 60);
  }

  const now = Date.now();
  const key = await accountKey(email);
  // Locked: refused before the password is checked, so the answer says
  // nothing about whether the password was right.
  const locked = await lockedResponse(env, key, now);
  if (locked) return locked;

  const userRow = await env.DB.prepare(
    "SELECT id, email, password_hash, role, customer_id FROM superadmin_users WHERE email = ?",
  )
    .bind(email)
    .first<UserRow>();

  let passwordOk = false;
  if (userRow) passwordOk = await verifyPassword(password, userRow.password_hash);
  else await verifyPassword(password, await timingDummy());

  if (!userRow || !passwordOk) {
    await countFailure(env, ctx, key, userRow, now);
    return jsonWithCors({ error: "Invalid email or password" }, env, 401);
  }

  return answerAfterPassword(env, request, userRow, key, now);
}

// ---------------------------------------------------------------------------
// POST /admin/login/mfa
// ---------------------------------------------------------------------------

interface ChallengeRow {
  token_hash: string;
  user_id: string;
  expires_at: number;
  attempts: number;
  email: string;
  role: string;
  customer_id: string | null;
}

export async function handleLoginMfa(
  request: Request,
  env: SignInEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  const { challenge, code, recovery_code } = body;
  if (!challenge || typeof challenge !== "string") {
    return jsonWithCors({ error: "challenge is required" }, env, 400);
  }
  const typed =
    typeof code === "string" && code.trim() !== ""
      ? { kind: "totp" as const, value: code }
      : typeof recovery_code === "string" && recovery_code.trim() !== ""
        ? { kind: "recovery" as const, value: recovery_code }
        : null;
  if (!typed) return jsonWithCors({ error: "code or recovery_code is required" }, env, 400);

  if (!(await ipAllowed(env.LOGIN_LIMITER, request))) {
    return tooMany(env, IP_LIMIT_MESSAGE, 60);
  }

  const now = Date.now();
  const tokenHash = await hashSessionToken(challenge);
  const row = await env.DB.prepare(
    `SELECT c.token_hash, c.user_id, c.expires_at, c.attempts, u.email, u.role, u.customer_id
     FROM mfa_challenges c JOIN superadmin_users u ON u.id = c.user_id
     WHERE c.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<ChallengeRow>();
  if (!row) return jsonWithCors({ error: DEAD_CHALLENGE_MESSAGE }, env, 401);

  const key = await accountKey(row.email);
  if (row.expires_at <= now || row.attempts >= CHALLENGE_MAX_ATTEMPTS) {
    await env.DB.prepare("DELETE FROM mfa_challenges WHERE token_hash = ?").bind(tokenHash).run();
    await countFailure(env, ctx, key, row, now);
    return jsonWithCors({ error: DEAD_CHALLENGE_MESSAGE }, env, 401);
  }

  const locked = await lockedResponse(env, key, now);
  if (locked) return locked;

  const mfa = (await getMfa(env.DB, row.user_id)) as MfaRow | null;
  if (!mfa || mfa.status !== "active") {
    // Two-step was turned off or reset between the steps: start over.
    await env.DB.prepare("DELETE FROM mfa_challenges WHERE token_hash = ?").bind(tokenHash).run();
    return jsonWithCors({ error: DEAD_CHALLENGE_MESSAGE }, env, 401);
  }

  // The field decides the kind: a recovery code typed in the code field
  // fails, so the screen's "use a recovery code" switch means what it says.
  const looksTotp = /^\d{6}$/.test(typed.value.replace(/\s/g, ""));
  const check =
    typed.kind === "totp" && !looksTotp
      ? { result: "bad" as const }
      : typed.kind === "recovery" && looksTotp
        ? { result: "bad" as const }
        : await checkSecondFactor(env.DB, env.MFA_ENCRYPTION_KEY, mfa, typed.value, now);

  if (check.result === "no-key") {
    return jsonWithCors({ error: NO_KEY_MESSAGE }, env, 503);
  }
  if (check.result === "bad") {
    const r = await env.DB.prepare(
      "UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ? RETURNING attempts",
    )
      .bind(tokenHash)
      .first<{ attempts: number }>();
    if (r && Number(r.attempts) >= CHALLENGE_MAX_ATTEMPTS) {
      await env.DB.prepare("DELETE FROM mfa_challenges WHERE token_hash = ?").bind(tokenHash).run();
    }
    await countFailure(env, ctx, key, row, now);
    return jsonWithCors({ error: WRONG_CODE_MESSAGE }, env, 401);
  }

  await env.DB.prepare("DELETE FROM mfa_challenges WHERE token_hash = ?").bind(tokenHash).run();
  await clearFailures(env.DB, key);
  const token = await createSession(
    env.DB,
    row.user_id,
    "full",
    request.headers.get("user-agent") ?? null,
    now,
  );
  const answer: Record<string, unknown> = { token, user: publicUser({ ...row, id: row.user_id }) };
  if (check.via === "recovery") {
    answer.recovery_codes_left = await recoveryCodesLeft(env.DB, row.user_id);
    await later(
      ctx,
      sendOpsAlert(
        env,
        "mfa-recovery-used",
        `[rawuser ops] mfa-recovery-used: a recovery code signed in (${alertRole(row)})`,
        ALERT_TTL_S,
      ),
    );
  }
  return jsonWithCors(answer, env, 200);
}

// ---------------------------------------------------------------------------
// POST /admin/sessions/revoke-all
// ---------------------------------------------------------------------------

export async function handleSessionsRevokeAll(
  request: Request,
  env: SignInEnv,
  user: SessionUser,
): Promise<Response> {
  let keepCurrent = true;
  try {
    const text = await request.text();
    if (text.trim() !== "") {
      const b = JSON.parse(text) as { keep_current?: unknown };
      if (b && typeof b === "object" && b.keep_current === false) keepCurrent = false;
    }
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  const current = keepCurrent ? await currentTokenHash(request) : null;
  const revoked = await revokeUserSessions(env.DB, user.id, current ?? undefined);
  return jsonWithCors({ ok: true, revoked }, env, 200);
}
