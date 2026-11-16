"use client";

/**
 * Two-step sign-in on the dashboard (docs/specs/security-hardening.md §1.4,
 * §1.6; mock design/mock/sales-readiness/two-step-sign-in.html, approved
 * 2026-10-06). The calls, the words the server writes, and the small pure
 * helpers the screens share. No React here, so every state is testable.
 *
 * The otpauth URI holds the secret: it is only ever handed to lib/qr.ts,
 * which draws the code in the browser (privacy review condition 7). Nothing here
 * sends it anywhere.
 */

import { API_ORIGIN } from "./api";
import { type SessionUser, clearToken, getToken, replaceToken } from "./auth";

// ---------------------------------------------------------------------------
// The server's own sentences (packages/generation/src/admin/sign-in.ts, mfa.ts)
// ---------------------------------------------------------------------------

export const WRONG_CODE = "That code did not work. Try again.";
export const SIGN_IN_AGAIN = "Sign in again.";
export const WRONG_PASSWORD = "That password is not right.";
export const START_AGAIN = "Start setting up two-step sign-in again.";
export const MUST_KEEP = "Your account must keep two-step sign-in.";
export const IP_LIMIT = "Too many sign-in attempts. Wait a minute and try again.";
export const SOMETHING_WRONG = "Something went wrong. Try again.";
export const NO_API = "Couldn't reach the API. Try again.";

export const CODE_LENGTH = 6;
export const RECOVERY_TOTAL = 10;
/** Recovery codes turn amber at this many left (mock §11, call 7). */
export const RECOVERY_AMBER_AT = 2;

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** The code field keeps digits only: a pasted "482 913" becomes "482913". */
export function normalizeCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

export function isFullCode(code: string): boolean {
  return code.length === CODE_LENGTH && /^\d+$/.test(code);
}

/** A recovery code as typed, upper-cased; the server ignores case, spaces and dashes. */
export function normalizeRecovery(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z\- ]/g, "")
    .slice(0, 24);
}

/** Continue is live once 16 letters or digits are in. */
export function isFullRecovery(value: string): boolean {
  return value.replace(/[^0-9A-Z]/gi, "").length >= 16;
}

/** The secret for typing by hand: groups of four, four groups a line. */
export function keyLines(secret: string): string[] {
  const groups = secret.replace(/\s/g, "").match(/.{1,4}/g) ?? [];
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += 4) lines.push(groups.slice(i, i + 4).join(" "));
  return lines;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "6 Oct 2026", in the reader's own time zone. */
export function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** The Download file: rawuser-recovery-codes.txt (mock §09). */
export const CODES_FILE_NAME = "rawuser-recovery-codes.txt";

export function codesFileText(email: string, codes: string[], madeAt: number): string {
  return `Rawuser recovery codes for ${email}, made ${shortDate(madeAt)}. Each works once.\n\n${codes.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Words that count
// ---------------------------------------------------------------------------

function sessions(n: number): string {
  return `${n} other session${n === 1 ? "" : "s"}`;
}

/** The sign-out confirm's question; without a count (A1 not deployed) it asks for all. */
export function signOutQuestion(count: number | null): string {
  return count === null ? "Sign out every other session?" : `Sign out ${sessions(count)}?`;
}

export function signedOutLine(revoked: number): string {
  return revoked === 0 ? "No other sessions were signed in." : `Signed out ${sessions(revoked)}.`;
}

export function resetDoneLine(revoked: number): string {
  return `Reset. ${revoked} session${revoked === 1 ? "" : "s"} ended.`;
}

export type Tone = "plain" | "warn";

export function recoveryTone(left: number): Tone {
  return left <= RECOVERY_AMBER_AT ? "warn" : "plain";
}

/** The line on the first page after a sign-in with a recovery code (mock §07). */
export function recoveryNotice(left: number): { text: string; link: string; tone: Tone } {
  if (left <= 0) {
    return { text: "That was your last recovery code.", link: "Make new codes", tone: "warn" };
  }
  return {
    text: `You signed in with a recovery code. ${left} left.`,
    link: "New recovery codes",
    tone: recoveryTone(left),
  };
}

// ---------------------------------------------------------------------------
// The recovery notice for this tab only (mock §11, call 11)
// ---------------------------------------------------------------------------

const NOTICE_KEY = "rawuser_recovery_left";

export function stashRecoveryNotice(left: number): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(NOTICE_KEY, String(Math.max(0, Math.floor(left))));
}

/** Reads the notice once: the first page after the sign-in shows it, the next does not. */
export function takeRecoveryNotice(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(NOTICE_KEY);
  if (raw === null) return null;
  window.sessionStorage.removeItem(NOTICE_KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export type MfaStatus = {
  enabled: boolean;
  pending: boolean;
  required: boolean;
  recovery_codes_left: number;
  enabled_at: number | null;
  /** A1: the caller's other live sessions. Absent on an older worker. */
  other_sessions?: number;
};

export type Failure =
  | "wrong-password"
  | "wrong-code"
  | "expired"
  | "locked"
  | "required"
  | "session"
  | "error";

export type Outcome<T> = { ok: true; data: T } | { ok: false; kind: Failure; message: string };

type Raw = { status: number; body: Record<string, unknown> | null };

/**
 * Reads a failed answer. On the sign-in's second step a 401 that is not a
 * wrong code means the challenge died ("Sign in again."); on a signed-in
 * route a bare 401 means the session itself ended.
 */
export function classify(raw: Raw, where: "sign-in" | "signed-in"): Outcome<never> {
  const error = typeof raw.body?.error === "string" ? raw.body.error : "";
  if (raw.status === 401) {
    if (error === WRONG_CODE) return { ok: false, kind: "wrong-code", message: WRONG_CODE };
    if (error === WRONG_PASSWORD) {
      return { ok: false, kind: "wrong-password", message: WRONG_PASSWORD };
    }
    if (where === "sign-in" || error === "Unauthorized") {
      return {
        ok: false,
        kind: where === "sign-in" ? "expired" : "session",
        message: SIGN_IN_AGAIN,
      };
    }
  }
  if (raw.status === 409 && error === START_AGAIN) {
    return { ok: false, kind: "expired", message: START_AGAIN };
  }
  if (raw.status === 429) return { ok: false, kind: "locked", message: error || IP_LIMIT };
  if (raw.status === 403 && error === MUST_KEEP) {
    return { ok: false, kind: "required", message: MUST_KEEP };
  }
  // The server's sentences start with a capital and end with a stop; a
  // field name like "code is required" is ours to hide.
  const sentence = /^[A-Z].*\.$/.test(error) ? error : SOMETHING_WRONG;
  return { ok: false, kind: "error", message: sentence };
}

async function send(path: string, init: RequestInit, withToken: boolean): Promise<Raw> {
  const token = withToken ? getToken() : null;
  const resp = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { "X-Rawuser-Admin": token } : {}),
    },
  });
  const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: resp.status, body };
}

async function call<T>(
  path: string,
  init: RequestInit,
  where: "sign-in" | "signed-in",
): Promise<Outcome<T>> {
  let raw: Raw;
  try {
    raw = await send(path, init, where === "signed-in");
  } catch {
    return { ok: false, kind: "error", message: NO_API };
  }
  if (raw.status >= 200 && raw.status < 300) return { ok: true, data: (raw.body ?? {}) as T };
  return classify(raw, where);
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

// Sign-in -------------------------------------------------------------------

export type LoginAnswer = {
  token?: string;
  user?: SessionUser;
  mfa_required?: boolean;
  challenge?: string;
  expires_in?: number;
  mfa_enrolment_required?: boolean;
};

export type LoginNext =
  | { kind: "done"; token: string; user: SessionUser }
  | { kind: "second-step"; challenge: string }
  | { kind: "enrol"; token: string; user: SessionUser }
  | { kind: "error" };

/** What a 200 from /admin/login (or the setup link) asks of the page. */
export function readLoginAnswer(a: LoginAnswer): LoginNext {
  if (a.mfa_required && typeof a.challenge === "string" && a.challenge !== "") {
    return { kind: "second-step", challenge: a.challenge };
  }
  if (typeof a.token === "string" && a.token !== "" && a.user) {
    return a.mfa_enrolment_required
      ? { kind: "enrol", token: a.token, user: a.user }
      : { kind: "done", token: a.token, user: a.user };
  }
  return { kind: "error" };
}

/** Where a signed-in person lands. */
export function homeFor(user: SessionUser | null): string {
  return user?.role === "customer" ? "/" : "/customers";
}

export type SecondStepAnswer = { token: string; user: SessionUser; recovery_codes_left?: number };

export function sendSecondStep(
  challenge: string,
  mode: "code" | "recovery",
  value: string,
): Promise<Outcome<SecondStepAnswer>> {
  const body = mode === "code" ? { challenge, code: value } : { challenge, recovery_code: value };
  return call<SecondStepAnswer>("/admin/login/mfa", post(body), "sign-in");
}

// Signed in -----------------------------------------------------------------

export function getStatus(): Promise<Outcome<MfaStatus>> {
  return call<MfaStatus>("/admin/mfa/status", { method: "GET" }, "signed-in");
}

export type EnrolStart = { secret: string; otpauth_uri: string };

export function startEnrolment(password: string): Promise<Outcome<EnrolStart>> {
  return call<EnrolStart>("/admin/mfa/enrol/start", post({ password }), "signed-in");
}

export type EnrolDone = { enabled: true; recovery_codes: string[]; token: string };

/**
 * Turns two-step on. The answer's token replaces the stored one at once:
 * the server has already ended every older session, this one included.
 */
export async function confirmEnrolment(code: string): Promise<Outcome<EnrolDone>> {
  const out = await call<EnrolDone>("/admin/mfa/enrol/confirm", post({ code }), "signed-in");
  if (out.ok) {
    if (typeof out.data.token !== "string" || out.data.token === "") {
      return { ok: false, kind: "error", message: SOMETHING_WRONG };
    }
    replaceToken(out.data.token);
  }
  return out;
}

export function newRecoveryCodes(
  password: string,
  code: string,
): Promise<Outcome<{ recovery_codes: string[] }>> {
  return call("/admin/mfa/recovery-codes", post({ password, code }), "signed-in");
}

export function turnOff(password: string, code: string): Promise<Outcome<{ enabled: false }>> {
  return call("/admin/mfa/disable", post({ password, code }), "signed-in");
}

export function signOutOthers(): Promise<Outcome<{ ok: true; revoked: number }>> {
  return call("/admin/sessions/revoke-all", post({ keep_current: true }), "signed-in");
}

export type CustomerUser = { id: string; email: string; two_step: boolean };

/**
 * A2: a customer's users. `null` when the worker has no such route yet (or
 * any other refusal): the Users line then stays hidden.
 */
export async function listCustomerUsers(customerId: string): Promise<CustomerUser[] | null> {
  const out = await call<{ users?: CustomerUser[] }>(
    `/admin/customer-users?customer_id=${encodeURIComponent(customerId)}`,
    { method: "GET" },
    "signed-in",
  );
  if (!out.ok || !Array.isArray(out.data.users)) return null;
  return out.data.users.filter((u) => u && typeof u.id === "string" && typeof u.email === "string");
}

export function resetTwoStep(
  userId: string,
): Promise<Outcome<{ ok: true; had_two_step: boolean; revoked: number }>> {
  return call("/admin/mfa/reset", post({ user_id: userId }), "signed-in");
}

/** A session that ended under a signed-in screen: drop it and sign in again. */
export function endSession(): void {
  clearToken();
  if (typeof window !== "undefined") window.location.href = "/login";
}
