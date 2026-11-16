/**
 * Customer-user account management — V2 M3 Batch C, Part 1.
 *
 * Two endpoints:
 *
 *   POST /admin/customer-users/create
 *     auth: superadmin only (the operator)
 *     body: { customer_id: string, email: string }
 *     response: { user_id: string, setup_url: string }
 *
 *     Creates a superadmin_users row with role='customer' and the given
 *     customer_id, leaves password_hash as a placeholder (the customer
 *     sets it later via /setup), and returns a setup_url containing a
 *     one-time token. The raw token appears ONCE in the response — never
 *     stored, never logged.
 *
 *   POST /admin/customer-users/setup
 *     auth: NONE (public; the token is the auth proof)
 *     body: { token: string, password: string }
 *     response: { token: string, user: SessionUser }
 *
 *     Hashes the provided token, looks up the customer_setup_tokens row,
 *     verifies (a) it's not expired and (b) not already consumed. On
 *     success: writes the PBKDF2 password hash, marks the setup token
 *     consumed, ends every other session of the user, and answers like
 *     /admin/login (a session token, or a second step when two-step is on).
 *
 *   GET /admin/customer-users?customer_id=X
 *     auth: superadmin only
 *     response: { users: [{ id, email, two_step: boolean }] }
 *
 *     A customer's users (role 'customer' only, never a superadmin), with
 *     whether two-step sign-in is on, for the reset in the users list
 *     (security-hardening.md §1.6 item 6, two-step mock A2). 400 for a
 *     malformed id, 404 for an unknown customer.
 *
 * Privacy invariants:
 *   - Operator-only data path. No visitor inputs, no PII fields beyond
 *     the customer-user's email (operator-supplied at invite time).
 *   - Raw setup token never persisted. Only SHA-256 hash sits in D1, so
 *     a DB leak can't be used to log in.
 *   - Setup tokens are single-use; consumed_at is checked AND set in the
 *     same transaction, then password_hash is updated. A second visit to
 *     the same /setup link fails with "token already consumed".
 *   - Errors are intentionally non-specific (404 "invalid token") so the
 *     endpoint doesn't oracle the existence of any particular token.
 */

import { accountKey } from "../auth/login-limit.ts";
import { hashPassword, hashSessionToken } from "../auth/password.ts";
import { revokeUserSessions } from "../auth/session.ts";
import type { CorsEnv } from "./cors.ts";
import { jsonWithCors } from "./cors.ts";
import { answerAfterPassword } from "./sign-in.ts";

export interface CustomerUsersEnv extends CorsEnv {
  DB: D1Database;
  /**
   * Origin of the dashboard, used to construct the setup URL the operator
   * forwards to the customer. e.g. https://rawuser-dashboard-keqdx.ondigitalocean.app
   * Falls back to a development origin when unset.
   */
  DASHBOARD_ORIGIN: string;
  /** Comma list of roles that must use two-step sign-in (security-hardening.md §1.4). */
  MFA_REQUIRED_ROLES?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SETUP_TOKEN_BYTES = 32;
// 7 days in unix ms — matches the spec in the plan.
const SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Sentinel password_hash on freshly-created rows. verifyPassword() returns
// false on a malformed hash, so this row is unable to log in until /setup
// overwrites the column with a real PBKDF2 hash.
const PLACEHOLDER_PASSWORD_HASH = "PENDING_SETUP";

/**
 * Generate a setup token: 32 bytes random → base64url string.
 * Returns the raw token (caller hands to the customer in setup_url)
 * and the SHA-256 hex hash (caller writes to D1).
 */
async function generateSetupToken(): Promise<{ raw: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(SETUP_TOKEN_BYTES));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  const raw = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const hash = await hashSessionToken(raw);
  return { raw, hash };
}

/**
 * A customer user with a placeholder password and a one-time setup token
 * (7 days, single use; only its hash stored). Null when the email is taken.
 * Used by the create endpoint and by the audit sign-up
 * (docs/specs/ai-traffic-audit.md §3.2), whose answer is the only place the
 * raw token goes (privacy review condition 8).
 */
export async function createCustomerUser(
  db: D1Database,
  customerId: string,
  email: string,
  now: number,
): Promise<{ userId: string; rawToken: string } | null> {
  const userId = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO superadmin_users (id, email, password_hash, role, customer_id, created_at)
         VALUES (?, ?, ?, 'customer', ?, ?)`,
      )
      .bind(userId, email, PLACEHOLDER_PASSWORD_HASH, customerId, now)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toUpperCase().includes("UNIQUE")) return null;
    throw e;
  }
  // Issue the setup token. Raw goes back to the caller; only the hash is persisted.
  const { raw: rawToken, hash: tokenHash } = await generateSetupToken();
  await db
    .prepare(
      `INSERT INTO customer_setup_tokens (token_hash, user_id, expires_at, consumed_at, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
    )
    .bind(tokenHash, userId, now + SETUP_TOKEN_TTL_MS, now)
    .run();
  return { userId, rawToken };
}

// ---------------------------------------------------------------------------
// POST /admin/customer-users/create — superadmin only
// ---------------------------------------------------------------------------

interface CreateBody {
  customer_id: string;
  email: string;
}

export async function handleCustomerUsersCreate(
  request: Request,
  env: CustomerUsersEnv,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }

  const params = body as Partial<CreateBody>;
  if (!params.customer_id || typeof params.customer_id !== "string") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  if (!params.email || typeof params.email !== "string" || !EMAIL_RE.test(params.email)) {
    return jsonWithCors({ error: "valid email is required" }, env, 400);
  }

  const email = params.email.trim();
  const customerId = params.customer_id;

  // Verify the customer exists. Without this, we'd create an orphaned user
  // row that nothing can ever map to a real tenant.
  const customerRow = await env.DB.prepare("SELECT id FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ id: string }>();
  if (!customerRow) {
    return jsonWithCors({ error: "Customer not found" }, env, 404);
  }

  // Refuse duplicate email at the application layer so the response is a
  // clean 409 — UNIQUE constraint also catches it at D1 if we race.
  const existing = await env.DB.prepare("SELECT id FROM superadmin_users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (existing) {
    return jsonWithCors({ error: "A user with that email already exists" }, env, 409);
  }

  const made = await createCustomerUser(env.DB, customerId, email, Date.now());
  if (!made) return jsonWithCors({ error: "A user with that email already exists" }, env, 409);
  const { userId, rawToken } = made;

  // Setup URL uses the configured dashboard origin. Falls back to localhost
  // for local dev where DASHBOARD_ORIGIN is "*".
  const origin =
    env.DASHBOARD_ORIGIN && env.DASHBOARD_ORIGIN !== "*"
      ? env.DASHBOARD_ORIGIN
      : "http://localhost:3000";
  const setupUrl = `${origin}/setup?token=${rawToken}`;

  return jsonWithCors(
    {
      user_id: userId,
      setup_url: setupUrl,
    },
    env,
    201,
  );
}

// ---------------------------------------------------------------------------
// POST /admin/customer-users/setup — PUBLIC (token IS the auth proof)
// ---------------------------------------------------------------------------

interface SetupBody {
  token: string;
  password: string;
}

interface SetupTokenRow {
  token_hash: string;
  user_id: string;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}

interface UserRow {
  id: string;
  email: string;
  role: string;
  customer_id: string | null;
}

export async function handleCustomerUsersSetup(
  request: Request,
  env: CustomerUsersEnv,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }

  const params = body as Partial<SetupBody>;
  if (!params.token || typeof params.token !== "string") {
    return jsonWithCors({ error: "token is required" }, env, 400);
  }
  // Minimum password length — keep it modest at V1 (operator-issued via
  // out-of-band channel, single-tenant SaaS, low-risk surface). Tighten
  // when self-serve signup arrives in a later wave.
  if (
    !params.password ||
    typeof params.password !== "string" ||
    params.password.length < 8 ||
    params.password.length > 200
  ) {
    return jsonWithCors({ error: "password must be 8 to 200 characters" }, env, 400);
  }

  const tokenHash = await hashSessionToken(params.token);
  const now = Date.now();

  const tokenRow = await env.DB.prepare(
    `SELECT token_hash, user_id, expires_at, consumed_at, created_at
     FROM customer_setup_tokens WHERE token_hash = ?`,
  )
    .bind(tokenHash)
    .first<SetupTokenRow>();

  // Generic 404 message — never reveals WHY the token is invalid (missing,
  // expired, consumed). This is intentional: the response shape is the same
  // for a typo'd token as for a replayed one.
  if (!tokenRow) {
    return jsonWithCors({ error: "Invalid or expired setup token" }, env, 404);
  }
  if (tokenRow.expires_at < now) {
    return jsonWithCors({ error: "Invalid or expired setup token" }, env, 404);
  }
  if (tokenRow.consumed_at != null) {
    return jsonWithCors({ error: "Invalid or expired setup token" }, env, 404);
  }

  // Compute the real PBKDF2 hash and write to the user row.
  const newHash = await hashPassword(params.password);

  await env.DB.prepare("UPDATE superadmin_users SET password_hash = ? WHERE id = ?")
    .bind(newHash, tokenRow.user_id)
    .run();

  // Mark token consumed atomically — a re-play after this point hits the
  // consumed_at != null branch above.
  await env.DB.prepare("UPDATE customer_setup_tokens SET consumed_at = ? WHERE token_hash = ?")
    .bind(now, tokenHash)
    .run();

  // Pull the freshly-set user row to populate the session response.
  const userRow = await env.DB.prepare(
    "SELECT id, email, role, customer_id FROM superadmin_users WHERE id = ?",
  )
    .bind(tokenRow.user_id)
    .first<UserRow>();

  if (!userRow) {
    // Defensive: row was just verified to exist, but if the FK was wiped
    // mid-flight return a clean 500 instead of letting the response crash.
    return jsonWithCors({ error: "User no longer exists" }, env, 500);
  }

  // A password set through a setup link ends every session the user had
  // (security-hardening.md §1.3), then signs in the way /admin/login does:
  // a second step if two-step is on, an enrol-only session if the role
  // requires it, a full session otherwise.
  await revokeUserSessions(env.DB, userRow.id);
  return answerAfterPassword(env, request, userRow, await accountKey(userRow.email), now);
}

// ---------------------------------------------------------------------------
// GET /admin/customer-users?customer_id=X — superadmin only
// ---------------------------------------------------------------------------

const CUSTOMER_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export async function handleCustomerUsersList(
  request: Request,
  env: CustomerUsersEnv,
): Promise<Response> {
  const customerId = new URL(request.url).searchParams.get("customer_id") ?? "";
  if (!CUSTOMER_ID_RE.test(customerId)) {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ id: string }>();
  if (!customer) return jsonWithCors({ error: "Customer not found" }, env, 404);

  const rows = await env.DB.prepare(
    `SELECT u.id AS id, u.email AS email, m.status AS mfa_status
     FROM superadmin_users u
     LEFT JOIN user_mfa m ON m.user_id = u.id
     WHERE u.customer_id = ? AND u.role = 'customer'
     ORDER BY u.created_at, u.email`,
  )
    .bind(customerId)
    .all<{ id: string; email: string; mfa_status: string | null }>();
  const users = (rows.results ?? []).map((r) => ({
    id: r.id,
    email: r.email,
    two_step: r.mfa_status === "active",
  }));
  return jsonWithCors({ users }, env, 200);
}
