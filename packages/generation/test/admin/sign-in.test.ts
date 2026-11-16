/**
 * Signing in, end to end through the worker on real SQL
 * (docs/specs/security-hardening.md §1): the failed sign-in limit, session
 * lifetimes and rotation, sign out everywhere, and two-step sign-in from
 * enrolment to recovery codes. No auth mock: getSessionUser runs for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, hashSessionToken } from "../../src/auth/password.ts";
import { base32Decode, totpAt } from "../../src/auth/totp.ts";
import { MODEL_ENV } from "../model-env.ts";
import { makeKv, makeSqliteD1 } from "./sqlite-d1.ts";

const { default: worker } = await import("../../src/index.ts");

const T0 = Date.UTC(2026, 9, 6, 9, 0, 7);
const KEY_B64 = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
const PASSWORD = "correct horse battery";

let sqlite: ReturnType<typeof makeSqliteD1>;
let kv: ReturnType<typeof makeKv>;
let env: Record<string, unknown>;
let waits: Promise<unknown>[];
let alerts: string[];

function ctx(): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
  const res = await worker.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { "X-Rawuser-Admin": token } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env as never,
    ctx(),
  );
  await Promise.all(waits.splice(0));
  const text = await res.clone().text();
  return { status: res.status, json: text ? JSON.parse(text) : {}, res };
}

const login = (email: string, password = PASSWORD, headers?: Record<string, string>) =>
  call("POST", "/admin/login", { email, password }, undefined, headers);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  sqlite = makeSqliteD1();
  kv = makeKv();
  waits = [];
  alerts = [];
  env = {
    DB: sqlite.d1,
    VARIANTS: kv,
    ENVIRONMENT: "test",
    DASHBOARD_ORIGIN: "https://app.test",
    ...MODEL_ENV,
    ALERT_WEBHOOK_URL: "https://alerts.test/hook",
    MFA_ENCRYPTION_KEY: KEY_B64,
    MFA_REQUIRED_ROLES: "",
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.startsWith("https://alerts.test/")) {
      alerts.push(JSON.parse(String(init?.body)).text);
      return new Response("ok");
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const hash = await hashPassword(PASSWORD);
  sqlite.db.exec(
    "INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES ('acme', 'acme', 'acme.test', 'pilot', 'active', 0)",
  );
  sqlite.db
    .prepare(
      "INSERT INTO superadmin_users (id, email, password_hash, role, customer_id, created_at) VALUES (?, ?, ?, ?, ?, 0)",
    )
    .run("u-admin", "founder@example.com", hash, "superadmin", null);
  sqlite.db
    .prepare(
      "INSERT INTO superadmin_users (id, email, password_hash, role, customer_id, created_at) VALUES (?, ?, ?, ?, ?, 0)",
    )
    .run("u-cust", "owner@acme.test", hash, "customer", "acme");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const count = (sql: string, ...params: Array<string | number>) =>
  Number((sqlite.db.prepare(sql).get(...params) as { n: number }).n);

// ---------------------------------------------------------------------------

describe("the failed sign-in limit", () => {
  it("lets six wrong passwords and a right one through, and clears the count", async () => {
    for (let i = 0; i < 6; i++) {
      expect((await login("founder@example.com", "wrong")).status).toBe(401);
    }
    const ok = await login("founder@example.com");
    expect(ok.status).toBe(200);
    expect(typeof ok.json.token).toBe("string");
    expect(count("SELECT COUNT(*) AS n FROM auth_failures")).toBe(0);
  });

  it("locks an account after ten failures, even for the right password, with the minutes and one alert", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await login("founder@example.com", "wrong");
      expect(r.status).toBe(401);
      expect(r.json.error).toBe("Invalid email or password");
    }
    const locked = await login("founder@example.com");
    expect(locked.status).toBe(429);
    expect(String(locked.json.error)).toMatch(
      /^Too many failed sign-ins\. Try again in \d+ minutes\.$/,
    );
    expect(Number(locked.res.headers.get("retry-after"))).toBeGreaterThan(15 * 60);
    expect(locked.res.headers.get("access-control-expose-headers")).toBe("Retry-After");
    // One login-lock alert, naming the role, never the email.
    const lockAlerts = alerts.filter((a) => a.includes("login-lock"));
    expect(lockAlerts).toEqual([
      "[rawuser ops] login-lock: an account reached the failed sign-in limit (superadmin)",
    ]);
    expect(alerts.join(" ")).not.toContain("founder@");
    // The other account is not locked.
    expect((await login("owner@acme.test")).status).toBe(200);
    // Lifts by itself.
    vi.setSystemTime(T0 + 31 * 60 * 1000);
    expect((await login("founder@example.com")).status).toBe(200);
  });

  it("counts an unknown email exactly like a known one", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await login("nobody@example.com", "x")).status).toBe(401);
    }
    const r = await login("nobody@example.com", "x");
    expect(r.status).toBe(429);
    expect(alerts.some((a) => a.includes("(no such account)"))).toBe(true);
  });

  it("names the customer id in a customer user's lock alert", async () => {
    for (let i = 0; i < 10; i++) await login("owner@acme.test", "wrong");
    expect(alerts.some((a) => a.endsWith("(customer acme)"))).toBe(true);
  });

  it("raises one login-burst alert at 30 failures across accounts", async () => {
    for (let i = 0; i < 31; i++) await login(`user${i}@test.dev`, "x");
    expect(alerts.filter((a) => a.includes("login-burst"))).toHaveLength(1);
  });

  it("refuses an IP over its limit before any password check", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    env.LOGIN_LIMITER = { limit };
    const r = await login("founder@example.com", PASSWORD, { "CF-Connecting-IP": "198.51.100.7" });
    expect(r.status).toBe(429);
    expect(r.json.error).toBe("Too many sign-in attempts. Wait a minute and try again.");
    expect(r.res.headers.get("retry-after")).toBe("60");
    expect(limit).toHaveBeenCalledWith({ key: "ip:198.51.100.7" });
    expect(count("SELECT COUNT(*) AS n FROM auth_failures")).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("sessions", () => {
  it("are 7 days at most, whatever expires_at says", async () => {
    const { json } = await login("founder@example.com");
    const token = String(json.token);
    const hash = await hashSessionToken(token);
    const row = sqlite.db
      .prepare("SELECT expires_at, scope FROM superadmin_sessions WHERE token_hash = ?")
      .get(hash) as { expires_at: number; scope: string };
    expect(row.expires_at).toBe(T0 + 7 * 24 * 3600 * 1000);
    expect(row.scope).toBe("full");
    // A session from before the change, 30 days long, ends at 7 days of age.
    sqlite.db
      .prepare("UPDATE superadmin_sessions SET expires_at = ? WHERE token_hash = ?")
      .run(T0 + 30 * 24 * 3600 * 1000, hash);
    // Used every 11 hours (inside the idle timeout) up to the last minute.
    for (let t = T0 + 11 * 3600e3; t < T0 + 7 * 24 * 3600e3; t += 11 * 3600e3) {
      vi.setSystemTime(t);
      expect((await call("GET", "/admin/me", undefined, token)).status).toBe(200);
    }
    vi.setSystemTime(T0 + 7 * 24 * 3600e3 - 60_000);
    expect((await call("GET", "/admin/me", undefined, token)).status).toBe(200);
    vi.setSystemTime(T0 + 7 * 24 * 3600 * 1000 + 1);
    expect((await call("GET", "/admin/me", undefined, token)).status).toBe(401);
  });

  it("end after 12 hours without a request, and write last_seen_at at most every 5 minutes", async () => {
    const token = String((await login("founder@example.com")).json.token);
    const hash = await hashSessionToken(token);
    const lastSeen = () =>
      (
        sqlite.db
          .prepare("SELECT last_seen_at FROM superadmin_sessions WHERE token_hash = ?")
          .get(hash) as { last_seen_at: number }
      ).last_seen_at;
    vi.setSystemTime(T0 + 60_000);
    await call("GET", "/admin/me", undefined, token);
    expect(lastSeen()).toBe(T0);
    vi.setSystemTime(T0 + 6 * 60_000);
    await call("GET", "/admin/me", undefined, token);
    expect(lastSeen()).toBe(T0 + 6 * 60_000);
    vi.setSystemTime(T0 + 6 * 60_000 + 12 * 3600 * 1000 - 1);
    expect((await call("GET", "/admin/me", undefined, token)).status).toBe(200);
    vi.setSystemTime(lastSeen() + 12 * 3600 * 1000 + 1);
    expect((await call("GET", "/admin/me", undefined, token)).status).toBe(401);
  });

  it("sign out everywhere ends the others, or all of them", async () => {
    const a = String((await login("founder@example.com")).json.token);
    const b = String((await login("founder@example.com")).json.token);
    const c = String((await login("founder@example.com")).json.token);
    const r = await call("POST", "/admin/sessions/revoke-all", {}, a);
    expect(r.json).toEqual({ ok: true, revoked: 2 });
    expect((await call("GET", "/admin/me", undefined, a)).status).toBe(200);
    expect((await call("GET", "/admin/me", undefined, b)).status).toBe(401);
    expect((await call("GET", "/admin/me", undefined, c)).status).toBe(401);
    const all = await call("POST", "/admin/sessions/revoke-all", { keep_current: false }, a);
    expect(all.json).toEqual({ ok: true, revoked: 1 });
    expect((await call("GET", "/admin/me", undefined, a)).status).toBe(401);
  });

  it("logout ends this session only", async () => {
    const a = String((await login("founder@example.com")).json.token);
    const b = String((await login("founder@example.com")).json.token);
    expect((await call("POST", "/admin/logout", {}, a)).status).toBe(200);
    expect((await call("GET", "/admin/me", undefined, a)).status).toBe(401);
    expect((await call("GET", "/admin/me", undefined, b)).status).toBe(200);
  });

  it("a password set through a setup link ends every other session of the user", async () => {
    const old = String((await login("owner@acme.test")).json.token);
    const raw = "setup-token-raw";
    sqlite.db
      .prepare(
        "INSERT INTO customer_setup_tokens (token_hash, user_id, expires_at, consumed_at, created_at) VALUES (?, 'u-cust', ?, NULL, ?)",
      )
      .run(await hashSessionToken(raw), T0 + 3600_000, T0);
    const r = await call("POST", "/admin/customer-users/setup", {
      token: raw,
      password: "a brand new password",
    });
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ id: "u-cust", role: "customer", customer_id: "acme" });
    expect((await call("GET", "/admin/me", undefined, old)).status).toBe(401);
    expect((await call("GET", "/admin/me", undefined, String(r.json.token))).status).toBe(200);
  });

  it("the 6-hour sweep removes aged, idle and expired sessions and old failure windows", async () => {
    const live = String((await login("founder@example.com")).json.token);
    sqlite.db.exec(`
      INSERT INTO superadmin_sessions (token_hash, user_id, expires_at, created_at, user_agent, last_seen_at)
      VALUES ('aged', 'u-admin', ${T0 + 1e10}, ${T0 - 8 * 86400e3}, NULL, ${T0}),
             ('idle', 'u-admin', ${T0 + 1e10}, ${T0 - 86400e3}, NULL, ${T0 - 13 * 3600e3}),
             ('expired', 'u-admin', ${T0 - 1}, ${T0 - 3600e3}, NULL, ${T0 - 3600e3});
      INSERT INTO auth_failures (key, window_start, failures) VALUES ('acct:old', ${T0 - 2 * 86400e3}, 3);
    `);
    await worker.scheduled(
      { cron: "0 */6 * * *", scheduledTime: T0, noRetry: () => {} } as never,
      { ...env, MODEL_API_KEY: "" } as never,
      ctx(),
    );
    await Promise.allSettled(waits.splice(0));
    const left = sqlite.db.prepare("SELECT token_hash FROM superadmin_sessions").all();
    expect(left).toEqual([{ token_hash: await hashSessionToken(live) }]);
    expect(count("SELECT COUNT(*) AS n FROM auth_failures")).toBe(0);
  });
});

// ---------------------------------------------------------------------------

/** Turns two-step on for a user and returns the secret, the codes and the new token. */
async function enrol(email: string) {
  const token = String((await login(email)).json.token);
  const start = await call("POST", "/admin/mfa/enrol/start", { password: PASSWORD }, token);
  expect(start.status).toBe(200);
  const secret = base32Decode(String(start.json.secret)) as Uint8Array;
  const confirm = await call(
    "POST",
    "/admin/mfa/enrol/confirm",
    { code: await totpAt(secret, Date.now()) },
    token,
  );
  expect(confirm.status).toBe(200);
  return {
    secret,
    codes: confirm.json.recovery_codes as string[],
    token: String(confirm.json.token),
    oldToken: token,
  };
}

/** The next 30-second step, so a fresh code is not the one just used. */
const nextStep = () => vi.setSystemTime(Date.now() + 30_000);

describe("two-step sign-in", () => {
  it("enrols: password, secret, a code; rotates the session; stores the secret sealed", async () => {
    const token = String((await login("founder@example.com")).json.token);
    const other = String((await login("founder@example.com")).json.token);
    const wrong = await call("POST", "/admin/mfa/enrol/start", { password: "nope" }, token);
    expect(wrong.status).toBe(401);
    expect(count("SELECT COUNT(*) AS n FROM auth_failures")).toBe(1);

    const start = await call("POST", "/admin/mfa/enrol/start", { password: PASSWORD }, token);
    expect(start.status).toBe(200);
    expect(String(start.json.otpauth_uri)).toMatch(
      /^otpauth:\/\/totp\/Rawuser:founder%40example\.com\?secret=[A-Z2-7]{32}&issuer=Rawuser/,
    );
    const stored = sqlite.db.prepare("SELECT * FROM user_mfa").get() as Record<string, unknown>;
    expect(stored.status).toBe("pending");
    expect(String(stored.secret_enc)).toMatch(/^v1\./);
    expect(String(stored.secret_enc)).not.toContain(String(start.json.secret));

    const secret = base32Decode(String(start.json.secret)) as Uint8Array;
    const bad = await call("POST", "/admin/mfa/enrol/confirm", { code: "000000" }, token);
    expect(bad.status).toBe(401);
    const ok = await call(
      "POST",
      "/admin/mfa/enrol/confirm",
      { code: await totpAt(secret, Date.now()) },
      token,
    );
    expect(ok.status).toBe(200);
    expect(ok.json.enabled).toBe(true);
    expect(ok.json.recovery_codes).toHaveLength(10);
    // Every older session ended, the caller's too; the new token works.
    expect((await call("GET", "/admin/me", undefined, token)).status).toBe(401);
    expect((await call("GET", "/admin/me", undefined, other)).status).toBe(401);
    const status = await call("GET", "/admin/mfa/status", undefined, String(ok.json.token));
    expect(status.json).toMatchObject({
      enabled: true,
      pending: false,
      required: false,
      recovery_codes_left: 10,
      enabled_at: T0,
    });
    // Only hashes of the codes are stored.
    const hashes = sqlite.db.prepare("SELECT code_hash FROM mfa_recovery_codes").all();
    expect(hashes).toHaveLength(10);
    for (const c of ok.json.recovery_codes as string[]) {
      expect(JSON.stringify(hashes)).not.toContain(c.replace(/-/g, ""));
    }
    // Twice is refused.
    const again = await call(
      "POST",
      "/admin/mfa/enrol/start",
      { password: PASSWORD },
      String(ok.json.token),
    );
    expect(again.status).toBe(409);
  });

  it("answers 503 without the server key", async () => {
    env.MFA_ENCRYPTION_KEY = undefined;
    const token = String((await login("founder@example.com")).json.token);
    const r = await call("POST", "/admin/mfa/enrol/start", { password: PASSWORD }, token);
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("Two-step sign-in is not set up on the server yet.");
  });

  it("asks for the second step, takes a code once, and never gives a session for the password alone", async () => {
    const { secret } = await enrol("founder@example.com");
    nextStep();
    const first = await login("founder@example.com");
    expect(first.status).toBe(200);
    expect(first.json).toEqual({
      mfa_required: true,
      challenge: expect.any(String),
      expires_in: 300,
    });
    expect(first.json.token).toBeUndefined();
    const code = await totpAt(secret, Date.now());
    const ok = await call("POST", "/admin/login/mfa", { challenge: first.json.challenge, code });
    expect(ok.status).toBe(200);
    expect(ok.json.user).toMatchObject({ id: "u-admin", role: "superadmin" });
    expect((await call("GET", "/admin/me", undefined, String(ok.json.token))).status).toBe(200);
    // The challenge is spent.
    const replay = await call("POST", "/admin/login/mfa", {
      challenge: first.json.challenge,
      code,
    });
    expect(replay.json.error).toBe("Sign in again.");
    // The same code on a new challenge is refused (one use per step).
    const second = await login("founder@example.com");
    const reuse = await call("POST", "/admin/login/mfa", {
      challenge: second.json.challenge,
      code,
    });
    expect(reuse.status).toBe(401);
    expect(reuse.json.error).toBe("That code did not work. Try again.");
  });

  it("kills a challenge after five wrong codes, and an expired one", async () => {
    await enrol("founder@example.com");
    const { json } = await login("founder@example.com");
    for (let i = 0; i < 5; i++) {
      const r = await call("POST", "/admin/login/mfa", {
        challenge: json.challenge,
        code: "000000",
      });
      expect(r.json.error).toBe("That code did not work. Try again.");
    }
    const dead = await call("POST", "/admin/login/mfa", {
      challenge: json.challenge,
      code: "000000",
    });
    expect(dead.json.error).toBe("Sign in again.");
    expect(count("SELECT COUNT(*) AS n FROM mfa_challenges")).toBe(0);

    const late = await login("founder@example.com");
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    const r = await call("POST", "/admin/login/mfa", {
      challenge: late.json.challenge,
      code: "000000",
    });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("Sign in again.");
  });

  it("wrong codes count toward the account lock", async () => {
    await enrol("founder@example.com");
    for (let round = 0; round < 2; round++) {
      const { json } = await login("founder@example.com");
      for (let i = 0; i < 5; i++) {
        await call("POST", "/admin/login/mfa", { challenge: json.challenge, code: "000000" });
      }
    }
    expect((await login("founder@example.com")).status).toBe(429);
  });

  it("signs in with a recovery code once, says how many are left, and alerts", async () => {
    const { codes } = await enrol("owner@acme.test");
    const a = await login("owner@acme.test");
    const typed = (codes[0] as string).toLowerCase().replace(/-/g, " ");
    const ok = await call("POST", "/admin/login/mfa", {
      challenge: a.json.challenge,
      recovery_code: typed,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.recovery_codes_left).toBe(9);
    expect(alerts).toContain(
      "[rawuser ops] mfa-recovery-used: a recovery code signed in (customer acme)",
    );
    const b = await login("owner@acme.test");
    const again = await call("POST", "/admin/login/mfa", {
      challenge: b.json.challenge,
      recovery_code: codes[0],
    });
    expect(again.status).toBe(401);
    // A recovery code in the code field is refused (the field decides).
    const c = await call("POST", "/admin/login/mfa", {
      challenge: b.json.challenge,
      code: codes[1],
    });
    expect(c.status).toBe(401);
  });

  it("new recovery codes need the password and a code, and kill the old ones", async () => {
    const { secret, codes, token } = await enrol("founder@example.com");
    nextStep();
    const noPw = await call(
      "POST",
      "/admin/mfa/recovery-codes",
      { password: "nope", code: await totpAt(secret, Date.now()) },
      token,
    );
    expect(noPw.status).toBe(401);
    const r = await call(
      "POST",
      "/admin/mfa/recovery-codes",
      { password: PASSWORD, code: await totpAt(secret, Date.now()) },
      token,
    );
    expect(r.status).toBe(200);
    expect(r.json.recovery_codes).toHaveLength(10);
    const ch = await login("founder@example.com");
    const old = await call("POST", "/admin/login/mfa", {
      challenge: ch.json.challenge,
      recovery_code: codes[1],
    });
    expect(old.status).toBe(401);
  });

  it("turns off with password and code, ending the other sessions; refused when the role requires it", async () => {
    const { secret, token } = await enrol("owner@acme.test");
    const ch = await login("owner@acme.test");
    nextStep();
    const second = String(
      (
        await call("POST", "/admin/login/mfa", {
          challenge: ch.json.challenge,
          code: await totpAt(secret, Date.now()),
        })
      ).json.token,
    );
    nextStep();
    env.MFA_REQUIRED_ROLES = "customer";
    const refused = await call(
      "POST",
      "/admin/mfa/disable",
      { password: PASSWORD, code: await totpAt(secret, Date.now()) },
      token,
    );
    expect(refused.status).toBe(403);
    env.MFA_REQUIRED_ROLES = "";
    const off = await call(
      "POST",
      "/admin/mfa/disable",
      { password: PASSWORD, code: await totpAt(secret, Date.now()) },
      token,
    );
    expect(off.json).toEqual({ enabled: false });
    expect(count("SELECT COUNT(*) AS n FROM user_mfa")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM mfa_recovery_codes")).toBe(0);
    expect((await call("GET", "/admin/me", undefined, second)).status).toBe(401);
    expect((await login("owner@acme.test")).json.token).toEqual(expect.any(String));
  });

  it("a required role without two-step gets an enrol-only session until it turns it on", async () => {
    env.MFA_REQUIRED_ROLES = "superadmin";
    const r = await login("founder@example.com");
    expect(r.json.mfa_enrolment_required).toBe(true);
    const token = String(r.json.token);
    const hash = await hashSessionToken(token);
    const row = sqlite.db
      .prepare("SELECT scope, expires_at FROM superadmin_sessions WHERE token_hash = ?")
      .get(hash) as { scope: string; expires_at: number };
    expect(row).toEqual({ scope: "enrol", expires_at: T0 + 15 * 60_000 });

    const blocked = await call("GET", "/admin/customers/list", undefined, token);
    expect(blocked.status).toBe(403);
    expect(blocked.json).toEqual({
      error: "Set up two-step sign-in first.",
      code: "mfa_enrolment_required",
    });
    const me = await call("GET", "/admin/me", undefined, token);
    expect(me.json).toEqual({
      user: { id: "u-admin", email: "founder@example.com", role: "superadmin", customer_id: null },
      mfa_enrolment_required: true,
    });
    expect((await call("GET", "/admin/mfa/status", undefined, token)).json.required).toBe(true);

    const start = await call("POST", "/admin/mfa/enrol/start", { password: PASSWORD }, token);
    const secret = base32Decode(String(start.json.secret)) as Uint8Array;
    const confirm = await call(
      "POST",
      "/admin/mfa/enrol/confirm",
      { code: await totpAt(secret, Date.now()) },
      token,
    );
    const full = String(confirm.json.token);
    expect((await call("GET", "/admin/customers/list", undefined, full)).status).toBe(200);
    expect((await call("GET", "/admin/me", undefined, token)).status).toBe(401);
  });

  it("a full session made before the requirement is held to enrolment too", async () => {
    const token = String((await login("founder@example.com")).json.token);
    env.MFA_REQUIRED_ROLES = "superadmin";
    expect((await call("GET", "/admin/customers/list", undefined, token)).status).toBe(403);
  });

  it("a superadmin resets a customer user's two-step sign-in, never its own or another superadmin's", async () => {
    await enrol("owner@acme.test");
    const custToken = String(
      (
        await call("POST", "/admin/login/mfa", {
          challenge: (await login("owner@acme.test")).json.challenge,
          recovery_code: "will-not-work",
        })
      ).json.token ?? "",
    );
    expect(custToken).toBe("");
    const admin = String((await login("founder@example.com")).json.token);
    expect((await call("POST", "/admin/mfa/reset", { user_id: "u-admin" }, admin)).json.error).toBe(
      "Use Turn off for your own account.",
    );
    const r = await call("POST", "/admin/mfa/reset", { user_id: "u-cust" }, admin);
    expect(r.json).toMatchObject({ ok: true, had_two_step: true });
    expect(count("SELECT COUNT(*) AS n FROM user_mfa WHERE user_id = 'u-cust'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM superadmin_sessions WHERE user_id = 'u-cust'")).toBe(0);
    expect(alerts).toContain(
      "[rawuser ops] mfa-reset: a superadmin reset two-step sign-in (customer acme)",
    );
    // The customer signs in with the password again.
    const cust = await login("owner@acme.test");
    expect(cust.json.token).toEqual(expect.any(String));
    const forbidden = await call(
      "POST",
      "/admin/mfa/reset",
      { user_id: "u-admin" },
      String(cust.json.token),
    );
    expect(forbidden.status).toBe(403);
  });
});

describe("the Account and users reads (two-step mock, A1 and A2)", () => {
  it("mfa/status counts the caller's other live sessions, never dead ones or another user's", async () => {
    const mine = String((await login("founder@example.com")).json.token);
    let st = await call("GET", "/admin/mfa/status", undefined, mine);
    expect(st.json.other_sessions).toBe(0);

    await login("founder@example.com");
    await login("founder@example.com");
    await login("owner@acme.test");
    st = await call("GET", "/admin/mfa/status", undefined, mine);
    expect(st.json.other_sessions).toBe(2);

    // An aged, an idle and an expired row are not live and are not counted.
    const ins = sqlite.db.prepare(
      `INSERT INTO superadmin_sessions (token_hash, user_id, expires_at, created_at, user_agent, last_seen_at, scope)
       VALUES (?, 'u-admin', ?, ?, NULL, ?, 'full')`,
    );
    ins.run("aged", T0 + 86_400_000, T0 - 8 * 86_400_000, T0);
    ins.run("idle", T0 + 86_400_000, T0 - 86_400_000, T0 - 13 * 3_600_000);
    ins.run("expired", T0 - 1, T0 - 3_600_000, T0 - 60_000);
    st = await call("GET", "/admin/mfa/status", undefined, mine);
    expect(st.json.other_sessions).toBe(2);

    // The number matches what sign out everywhere ends (the live ones).
    const r = await call("POST", "/admin/sessions/revoke-all", {}, mine);
    expect(r.status).toBe(200);
    st = await call("GET", "/admin/mfa/status", undefined, mine);
    expect(st.json.other_sessions).toBe(0);
  });

  it("lists a customer's users with their two-step state, superadmin only", async () => {
    sqlite.db
      .prepare(
        "INSERT INTO superadmin_users (id, email, password_hash, role, customer_id, created_at) VALUES (?, ?, 'x', 'customer', ?, 1)",
      )
      .run("u-cust-2", "second@acme.test", "acme");
    sqlite.db.exec(
      "INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES ('other', 'other', 'other.test', 'pilot', 'active', 0)",
    );
    sqlite.db
      .prepare(
        "INSERT INTO superadmin_users (id, email, password_hash, role, customer_id, created_at) VALUES (?, ?, 'x', 'customer', ?, 1)",
      )
      .run("u-other", "someone@other.test", "other");
    await enrol("owner@acme.test");

    const admin = String((await login("founder@example.com")).json.token);
    const list = await call("GET", "/admin/customer-users?customer_id=acme", undefined, admin);
    expect(list.status).toBe(200);
    expect(list.json).toEqual({
      users: [
        { id: "u-cust", email: "owner@acme.test", two_step: true },
        { id: "u-cust-2", email: "second@acme.test", two_step: false },
      ],
    });
    // Nothing but the three fields: no hash, no secret, no session.
    for (const u of list.json.users as Array<Record<string, unknown>>) {
      expect(Object.keys(u).sort()).toEqual(["email", "id", "two_step"]);
    }

    expect(
      (await call("GET", "/admin/customer-users?customer_id=nope", undefined, admin)).status,
    ).toBe(404);
    expect((await call("GET", "/admin/customer-users", undefined, admin)).status).toBe(400);
    expect(
      (await call("GET", "/admin/customer-users?customer_id=a%20b", undefined, admin)).status,
    ).toBe(400);

    // A customer user cannot list anyone, its own customer included.
    sqlite.db
      .prepare("UPDATE superadmin_users SET password_hash = ? WHERE id = 'u-other'")
      .run(await hashPassword(PASSWORD));
    const otherToken = String((await login("someone@other.test")).json.token);
    expect(
      (await call("GET", "/admin/customer-users?customer_id=other", undefined, otherToken)).status,
    ).toBe(403);
  });
});
