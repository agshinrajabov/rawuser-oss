/**
 * Two-step sign-in state in D1 (docs/specs/security-hardening.md, section
 * 1.4; migration 0039). Every one-use rule is a conditional UPDATE, so two
 * parallel requests with the same code or recovery code cannot both pass.
 */

import { generateSessionToken, hashSessionToken } from "./password.ts";
import { newRecoveryCodes, normalizeRecoveryCode, recoveryCodeHash } from "./recovery-codes.ts";
import { importBoxKey, openSecret, sealSecret } from "./secret-box.ts";
import { matchTotp, newTotpSecret } from "./totp.ts";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
/** A pending enrolment older than this is swept. */
export const PENDING_ENROLMENT_TTL_MS = 24 * 60 * 60 * 1000;

export type MfaStatus = "pending" | "active";

export interface MfaRow {
  user_id: string;
  secret_enc: string;
  status: MfaStatus;
  last_counter: number | null;
  created_at: number;
  enabled_at: number | null;
}

function changes(r: unknown): number {
  return Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0);
}

export async function getMfa(db: D1Database, userId: string): Promise<MfaRow | null> {
  return db
    .prepare(
      "SELECT user_id, secret_enc, status, last_counter, created_at, enabled_at FROM user_mfa WHERE user_id = ?",
    )
    .bind(userId)
    .first<MfaRow>();
}

/**
 * A fresh secret, sealed and stored as pending (replacing an earlier
 * pending one, never an active one). Null when the row is already active.
 */
export async function startEnrolment(
  db: D1Database,
  key: CryptoKey,
  userId: string,
  now: number,
): Promise<Uint8Array | null> {
  const secret = newTotpSecret();
  const sealed = await sealSecret(key, secret, userId);
  const r = await db
    .prepare(
      `INSERT INTO user_mfa (user_id, secret_enc, status, last_counter, created_at, enabled_at)
       VALUES (?, ?, 'pending', NULL, ?, NULL)
       ON CONFLICT (user_id) DO UPDATE SET
         secret_enc = excluded.secret_enc, status = 'pending', last_counter = NULL,
         created_at = excluded.created_at, enabled_at = NULL
       WHERE user_mfa.status = 'pending'`,
    )
    .bind(userId, sealed, now)
    .run();
  return changes(r) === 1 ? secret : null;
}

/** The plain secret of a row, or null when the key cannot open it. */
export async function openRowSecret(
  keySecret: string | undefined,
  row: MfaRow,
): Promise<Uint8Array | null | "no-key"> {
  const key = await importBoxKey(keySecret);
  if (!key) return "no-key";
  return openSecret(key, row.secret_enc, row.user_id);
}

/** Pending to active, with the step the first code used. False when it was not pending. */
export async function activate(
  db: D1Database,
  userId: string,
  counter: number,
  now: number,
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE user_mfa SET status = 'active', last_counter = ?, enabled_at = ?
       WHERE user_id = ? AND status = 'pending'`,
    )
    .bind(counter, now, userId)
    .run();
  return changes(r) === 1;
}

/** Records the step a code used; false when another request used it (or a later one) first. */
export async function consumeTotpStep(
  db: D1Database,
  userId: string,
  counter: number,
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE user_mfa SET last_counter = ?
       WHERE user_id = ? AND status = 'active' AND (last_counter IS NULL OR last_counter < ?)`,
    )
    .bind(counter, userId, counter)
    .run();
  return changes(r) === 1;
}

/** Ten new codes for display; every old code of the user is gone. */
export async function replaceRecoveryCodes(
  db: D1Database,
  userId: string,
  now: number,
): Promise<string[]> {
  const codes = newRecoveryCodes();
  const stmts = [db.prepare("DELETE FROM mfa_recovery_codes WHERE user_id = ?").bind(userId)];
  for (const code of codes) {
    const normalized = normalizeRecoveryCode(code) as string;
    stmts.push(
      db
        .prepare(
          "INSERT INTO mfa_recovery_codes (code_hash, user_id, created_at, used_at) VALUES (?, ?, ?, NULL)",
        )
        .bind(await recoveryCodeHash(userId, normalized), userId, now),
    );
  }
  await db.batch(stmts);
  return codes;
}

/** True when the typed code was one of the user's unused codes; it is used now. */
export async function consumeRecoveryCode(
  db: D1Database,
  userId: string,
  typed: string,
  now: number,
): Promise<boolean> {
  const normalized = normalizeRecoveryCode(typed);
  if (!normalized) return false;
  const r = await db
    .prepare(
      `UPDATE mfa_recovery_codes SET used_at = ?
       WHERE code_hash = ? AND user_id = ? AND used_at IS NULL`,
    )
    .bind(now, await recoveryCodeHash(userId, normalized), userId)
    .run();
  return changes(r) === 1;
}

export async function recoveryCodesLeft(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL")
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Two-step off: the secret, the codes and any open challenge go. */
export async function removeMfa(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM mfa_challenges WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM mfa_recovery_codes WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM user_mfa WHERE user_id = ?").bind(userId),
  ]);
}

/** A second-step challenge; the raw value goes to the client, its hash to D1. */
export async function createChallenge(
  db: D1Database,
  userId: string,
  now: number,
): Promise<string> {
  const raw = generateSessionToken();
  await db
    .prepare(
      `INSERT INTO mfa_challenges (token_hash, user_id, expires_at, attempts, created_at)
       VALUES (?, ?, ?, 0, ?)`,
    )
    .bind(await hashSessionToken(raw), userId, now + CHALLENGE_TTL_MS, now)
    .run();
  return raw;
}

export type CodeCheck = "ok" | "bad" | "no-key";

/**
 * A typed second factor for an active user: six digits are a TOTP code
 * (one use per step), anything else is tried as a recovery code.
 */
export async function checkSecondFactor(
  db: D1Database,
  keySecret: string | undefined,
  row: MfaRow,
  typed: string,
  now: number,
): Promise<{ result: CodeCheck; via?: "totp" | "recovery" }> {
  if (row.status !== "active") return { result: "bad" };
  const digits = typed.replace(/\s/g, "");
  if (/^\d{6}$/.test(digits)) {
    const secret = await openRowSecret(keySecret, row);
    if (secret === "no-key") return { result: "no-key" };
    if (!secret) return { result: "bad" };
    const step = await matchTotp(secret, digits, now, row.last_counter);
    if (step === null) return { result: "bad" };
    return (await consumeTotpStep(db, row.user_id, step))
      ? { result: "ok", via: "totp" }
      : { result: "bad" };
  }
  return (await consumeRecoveryCode(db, row.user_id, typed, now))
    ? { result: "ok", via: "recovery" }
    : { result: "bad" };
}

/** The 6-hour sweep: old failure windows, dead challenges, stale pending enrolments, dead sessions. */
export async function sweepAuth(
  db: D1Database,
  now: number,
  limits: { failureTtlMs: number; absoluteMs: number; idleMs: number },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM superadmin_sessions
         WHERE expires_at < ? OR created_at < ? OR COALESCE(last_seen_at, created_at) < ?`,
      )
      .bind(now, now - limits.absoluteMs, now - limits.idleMs),
    db.prepare("DELETE FROM auth_failures WHERE window_start < ?").bind(now - limits.failureTtlMs),
    db.prepare("DELETE FROM mfa_challenges WHERE expires_at < ?").bind(now),
    db
      .prepare("DELETE FROM user_mfa WHERE status = 'pending' AND created_at < ?")
      .bind(now - PENDING_ENROLMENT_TTL_MS),
  ]);
}
