/**
 * Two-step sign-in management (docs/specs/security-hardening.md, 1.4).
 * Every route needs a session. `password` is the user's current password;
 * `code` a current six-digit code or a recovery code.
 *
 *   GET  /admin/mfa/status            also other_sessions (live, minus this one)
 *   POST /admin/mfa/enrol/start       { password }
 *   POST /admin/mfa/enrol/confirm     { code }
 *   POST /admin/mfa/recovery-codes    { password, code }
 *   POST /admin/mfa/disable           { password, code }
 *   POST /admin/mfa/reset             { user_id }        superadmin only
 *
 * A wrong password or code here counts toward the account's failed sign-in
 * limit, like on /admin/login. Turning two-step on rotates the session: the
 * answer carries the token to use from now on and every older session of
 * the user (the calling one too) is ended.
 */

import { accountKey } from "../auth/login-limit.ts";
import {
  activate,
  checkSecondFactor,
  getMfa,
  openRowSecret,
  recoveryCodesLeft,
  removeMfa,
  replaceRecoveryCodes,
  startEnrolment,
} from "../auth/mfa-store.ts";
import { verifyPassword } from "../auth/password.ts";
import { importBoxKey } from "../auth/secret-box.ts";
import {
  countOtherSessions,
  createSession,
  currentTokenHash,
  revokeUserSessions,
} from "../auth/session.ts";
import { base32Encode, matchTotp, otpauthUri } from "../auth/totp.ts";
import { sendOpsAlert } from "../cron/ops-heartbeat.ts";
import { type SessionUser, mfaRequiredFor } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import {
  NO_KEY_MESSAGE,
  type SignInEnv,
  WRONG_CODE_MESSAGE,
  alertRole,
  countFailure,
  lockedResponse,
} from "./sign-in.ts";

const WRONG_PASSWORD_MESSAGE = "That password is not right.";

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null;
}

/**
 * The password check of a signed-in user, behind the same account lock.
 * Returns a response to send back, or null when the password is right.
 */
async function passwordGate(
  env: SignInEnv,
  ctx: ExecutionContext | undefined,
  user: SessionUser,
  password: string | null,
  now: number,
): Promise<Response | null> {
  if (!password) return jsonWithCors({ error: "password is required" }, env, 400);
  const key = await accountKey(user.email);
  const locked = await lockedResponse(env, key, now);
  if (locked) return locked;
  const row = await env.DB.prepare("SELECT password_hash FROM superadmin_users WHERE id = ?")
    .bind(user.id)
    .first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    await countFailure(env, ctx, key, user, now);
    return jsonWithCors({ error: WRONG_PASSWORD_MESSAGE }, env, 401);
  }
  return null;
}

// ---------------------------------------------------------------------------

export async function handleMfaStatus(
  request: Request,
  env: SignInEnv,
  user: SessionUser,
): Promise<Response> {
  const mfa = await getMfa(env.DB, user.id);
  const enabled = mfa?.status === "active";
  const other_sessions = await countOtherSessions(
    env.DB,
    user.id,
    await currentTokenHash(request),
    Date.now(),
  );
  return jsonWithCors(
    {
      enabled,
      pending: mfa?.status === "pending",
      required: mfaRequiredFor(env, user.role),
      recovery_codes_left: enabled ? await recoveryCodesLeft(env.DB, user.id) : 0,
      enabled_at: enabled ? (mfa?.enabled_at ?? null) : null,
      other_sessions,
    },
    env,
    200,
  );
}

export async function handleMfaEnrolStart(
  request: Request,
  env: SignInEnv,
  user: SessionUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  const key = await importBoxKey(env.MFA_ENCRYPTION_KEY);
  if (!key) return jsonWithCors({ error: NO_KEY_MESSAGE }, env, 503);

  const now = Date.now();
  const gate = await passwordGate(env, ctx, user, str(body.password), now);
  if (gate) return gate;

  const secret = await startEnrolment(env.DB, key, user.id, now);
  if (!secret) {
    return jsonWithCors({ error: "Two-step sign-in is already on." }, env, 409);
  }
  const b32 = base32Encode(secret);
  // The URI holds the secret: the dashboard draws the QR code itself and
  // never sends it to a QR web service.
  return jsonWithCors({ secret: b32, otpauth_uri: otpauthUri(b32, user.email) }, env, 200);
}

export async function handleMfaEnrolConfirm(
  request: Request,
  env: SignInEnv,
  user: SessionUser,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  const code = str(body.code);
  if (!code) return jsonWithCors({ error: "code is required" }, env, 400);

  const now = Date.now();
  const mfa = await getMfa(env.DB, user.id);
  if (!mfa || mfa.status !== "pending") {
    return jsonWithCors(
      {
        error:
          mfa?.status === "active"
            ? "Two-step sign-in is already on."
            : "Start setting up two-step sign-in again.",
      },
      env,
      409,
    );
  }
  const secret = await openRowSecret(env.MFA_ENCRYPTION_KEY, mfa);
  if (secret === "no-key") return jsonWithCors({ error: NO_KEY_MESSAGE }, env, 503);
  if (!secret) {
    return jsonWithCors({ error: "Start setting up two-step sign-in again." }, env, 409);
  }
  const step = await matchTotp(secret, code, now, null);
  if (step === null) return jsonWithCors({ error: WRONG_CODE_MESSAGE }, env, 401);
  if (!(await activate(env.DB, user.id, step, now))) {
    return jsonWithCors({ error: "Two-step sign-in is already on." }, env, 409);
  }

  const recovery_codes = await replaceRecoveryCodes(env.DB, user.id, now);
  // A change of what the account needs to sign in: every session ends and
  // the caller gets a new full one (an enrol-only session becomes full).
  await revokeUserSessions(env.DB, user.id);
  const token = await createSession(
    env.DB,
    user.id,
    "full",
    request.headers.get("user-agent") ?? null,
    now,
  );
  return jsonWithCors({ enabled: true, recovery_codes, token }, env, 200);
}

/** Password and a second factor; a response to send back, or null when both are right. */
async function passwordAndCode(
  request: Request,
  env: SignInEnv,
  user: SessionUser,
  ctx: ExecutionContext | undefined,
  now: number,
): Promise<Response | null> {
  const body = await readJson(request);
  if (!body) return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  const code = str(body.code);
  if (!code) return jsonWithCors({ error: "code is required" }, env, 400);
  const mfa = await getMfa(env.DB, user.id);
  if (!mfa || mfa.status !== "active") {
    return jsonWithCors({ error: "Two-step sign-in is off." }, env, 409);
  }
  const gate = await passwordGate(env, ctx, user, str(body.password), now);
  if (gate) return gate;
  const check = await checkSecondFactor(env.DB, env.MFA_ENCRYPTION_KEY, mfa, code, now);
  if (check.result === "no-key") return jsonWithCors({ error: NO_KEY_MESSAGE }, env, 503);
  if (check.result === "bad") {
    await countFailure(env, ctx, await accountKey(user.email), user, now);
    return jsonWithCors({ error: WRONG_CODE_MESSAGE }, env, 401);
  }
  return null;
}

export async function handleMfaRecoveryCodes(
  request: Request,
  env: SignInEnv,
  user: SessionUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  const now = Date.now();
  const refused = await passwordAndCode(request, env, user, ctx, now);
  if (refused) return refused;
  const recovery_codes = await replaceRecoveryCodes(env.DB, user.id, now);
  const current = await currentTokenHash(request);
  await revokeUserSessions(env.DB, user.id, current ?? undefined);
  return jsonWithCors({ recovery_codes }, env, 200);
}

export async function handleMfaDisable(
  request: Request,
  env: SignInEnv,
  user: SessionUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (mfaRequiredFor(env, user.role)) {
    return jsonWithCors({ error: "Your account must keep two-step sign-in." }, env, 403);
  }
  const now = Date.now();
  const refused = await passwordAndCode(request, env, user, ctx, now);
  if (refused) return refused;
  await removeMfa(env.DB, user.id);
  const current = await currentTokenHash(request);
  await revokeUserSessions(env.DB, user.id, current ?? undefined);
  return jsonWithCors({ enabled: false }, env, 200);
}

/**
 * A superadmin removes a customer user's two-step sign-in (a lost device).
 * Never one's own account (that is Turn off, with password and code) and
 * never another superadmin (the founder's own account is a D1 statement,
 * section 1.4 "Lost device").
 */
export async function handleMfaReset(
  request: Request,
  env: SignInEnv,
  user: SessionUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (user.role !== "superadmin") {
    return jsonWithCors({ error: "Forbidden: superadmin role required" }, env, 403);
  }
  const body = await readJson(request);
  if (!body) return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  const userId = str(body.user_id);
  if (!userId) return jsonWithCors({ error: "user_id is required" }, env, 400);
  if (userId === user.id) {
    return jsonWithCors({ error: "Use Turn off for your own account." }, env, 400);
  }
  const target = await env.DB.prepare(
    "SELECT id, role, customer_id FROM superadmin_users WHERE id = ?",
  )
    .bind(userId)
    .first<{ id: string; role: string; customer_id: string | null }>();
  if (!target) return jsonWithCors({ error: "User not found" }, env, 404);
  if (target.role !== "customer") {
    return jsonWithCors({ error: "Only a customer user can be reset here." }, env, 400);
  }
  const had = (await getMfa(env.DB, userId)) !== null;
  await removeMfa(env.DB, userId);
  const revoked = await revokeUserSessions(env.DB, userId);
  const alert = sendOpsAlert(
    env,
    "mfa-reset",
    `[rawuser ops] mfa-reset: a superadmin reset two-step sign-in (${alertRole(target)})`,
    3600,
  ).catch(() => undefined);
  if (ctx) ctx.waitUntil(alert);
  else await alert;
  return jsonWithCors({ ok: true, had_two_step: had, revoked }, env, 200);
}
