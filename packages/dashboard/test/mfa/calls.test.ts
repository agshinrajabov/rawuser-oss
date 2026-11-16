/**
 * Two-step sign-in, the calls and the token handling (lib/mfa.ts, lib/auth.ts,
 * lib/api.ts; docs/specs/security-hardening.md §1.4; mock
 * design/mock/sales-readiness/two-step-sign-in.html). The worker is a
 * stubbed fetch; the tab is a stubbed window with its own sessionStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      m.set(k, String(v));
    },
  };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[];
let win: { sessionStorage: Storage; location: { href: string } };

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The next answers, in order. */
function worker(...answers: Response[]) {
  const queue = [...answers];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = queue.shift();
      if (!next) throw new TypeError("network down");
      return next;
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  calls = [];
  win = { sessionStorage: memoryStorage(), location: { href: "" } };
  vi.stubGlobal("window", win);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER = { id: "u1", email: "sam@brisk.test", role: "customer", customer_id: "brisk" };

describe("the login answer", () => {
  it("reads a second step, a required set-up, a plain sign-in, or nothing usable", async () => {
    const { readLoginAnswer, homeFor } = await import("../../src/lib/mfa");
    expect(readLoginAnswer({ mfa_required: true, challenge: "ch", expires_in: 300 })).toEqual({
      kind: "second-step",
      challenge: "ch",
    });
    expect(readLoginAnswer({ token: "t", user: USER, mfa_enrolment_required: true })).toEqual({
      kind: "enrol",
      token: "t",
      user: USER,
    });
    expect(readLoginAnswer({ token: "t", user: USER })).toEqual({
      kind: "done",
      token: "t",
      user: USER,
    });
    // The old page stored an undefined token here; now it is refused.
    expect(readLoginAnswer({ mfa_required: true })).toEqual({ kind: "error" });
    expect(homeFor(USER)).toBe("/");
    expect(homeFor({ ...USER, role: "superadmin", customer_id: null })).toBe("/customers");
  });
});

describe("the second step", () => {
  it("sends the code as `code`, a recovery code as `recovery_code`, with no session header", async () => {
    worker(answer(200, { token: "full", user: USER }), answer(200, { token: "full", user: USER }));
    const { sendSecondStep } = await import("../../src/lib/mfa");
    win.sessionStorage.setItem("rawuser_admin_token", "stale");
    await sendSecondStep("ch", "code", "482913");
    await sendSecondStep("ch", "recovery", "HQ8D-5HFR-SWVK-182V");
    expect(calls[0]?.url).toBe("http://localhost:8787/admin/login/mfa");
    expect(calls[0]?.body).toEqual({ challenge: "ch", code: "482913" });
    expect(calls[1]?.body).toEqual({ challenge: "ch", recovery_code: "HQ8D-5HFR-SWVK-182V" });
    expect(calls[0]?.headers["X-Rawuser-Admin"]).toBeUndefined();
  });

  it("names every refusal: wrong code, step expired, locked, the server's 503, no API", async () => {
    worker(
      answer(401, { error: "That code did not work. Try again." }),
      answer(401, { error: "Sign in again." }),
      answer(
        429,
        { error: "Too many failed sign-ins. Try again in 14 minutes." },
        { "retry-after": "840" },
      ),
      answer(503, { error: "Two-step sign-in is not set up on the server yet." }),
    );
    const { sendSecondStep } = await import("../../src/lib/mfa");
    expect(await sendSecondStep("ch", "code", "000000")).toEqual({
      ok: false,
      kind: "wrong-code",
      message: "That code did not work. Try again.",
    });
    expect(await sendSecondStep("ch", "code", "000000")).toEqual({
      ok: false,
      kind: "expired",
      message: "Sign in again.",
    });
    expect(await sendSecondStep("ch", "code", "000000")).toEqual({
      ok: false,
      kind: "locked",
      message: "Too many failed sign-ins. Try again in 14 minutes.",
    });
    expect(await sendSecondStep("ch", "code", "000000")).toEqual({
      ok: false,
      kind: "error",
      message: "Two-step sign-in is not set up on the server yet.",
    });
    expect(await sendSecondStep("ch", "code", "000000")).toMatchObject({
      ok: false,
      kind: "error",
      message: "Couldn't reach the API. Try again.",
    });
  });

  it("a field name from the server never reaches the screen", async () => {
    const { classify } = await import("../../src/lib/mfa");
    expect(classify({ status: 400, body: { error: "code is required" } }, "sign-in")).toMatchObject(
      {
        message: "Something went wrong. Try again.",
      },
    );
  });
});

describe("token handling", () => {
  it("Turn on stores the confirm answer's token in place of the old one", async () => {
    worker(answer(200, { enabled: true, recovery_codes: ["A", "B"], token: "new-token" }));
    const auth = await import("../../src/lib/auth");
    const { confirmEnrolment } = await import("../../src/lib/mfa");
    auth.setToken("old-token");
    const out = await confirmEnrolment("482913");
    expect(out.ok).toBe(true);
    // The request went with the old session; the tab now holds the new one.
    expect(calls[0]?.headers["X-Rawuser-Admin"]).toBe("old-token");
    expect(calls[0]?.body).toEqual({ code: "482913" });
    expect(auth.getToken()).toBe("new-token");
    expect(win.sessionStorage.getItem("rawuser_admin_token")).toBe("new-token");
  });

  it("a refused confirm leaves the token alone", async () => {
    worker(
      answer(401, { error: "That code did not work. Try again." }),
      answer(409, { error: "Start setting up two-step sign-in again." }),
    );
    const auth = await import("../../src/lib/auth");
    const { confirmEnrolment } = await import("../../src/lib/mfa");
    auth.setToken("old-token");
    expect(await confirmEnrolment("000000")).toMatchObject({ ok: false, kind: "wrong-code" });
    expect(await confirmEnrolment("000000")).toMatchObject({
      ok: false,
      kind: "expired",
      message: "Start setting up two-step sign-in again.",
    });
    expect(auth.getToken()).toBe("old-token");
  });

  it("a 200 without a token is an error and keeps the old token", async () => {
    worker(answer(200, { enabled: true, recovery_codes: [] }));
    const auth = await import("../../src/lib/auth");
    const { confirmEnrolment } = await import("../../src/lib/mfa");
    auth.setToken("old-token");
    expect(await confirmEnrolment("482913")).toMatchObject({ ok: false, kind: "error" });
    expect(auth.getToken()).toBe("old-token");
  });

  it("an enrol-only session is known from /admin/me and ends with the new token", async () => {
    worker(answer(200, { user: USER, mfa_enrolment_required: true }));
    const auth = await import("../../src/lib/auth");
    auth.setToken("enrol-token");
    expect(await auth.getCurrentSession()).toEqual({ user: USER, enrolOnly: true });
    auth.replaceToken("full-token");
    expect(await auth.getCurrentSession()).toEqual({ user: USER, enrolOnly: false });
    expect(auth.getToken()).toBe("full-token");
  });

  it("setSession can mark the session enrol-only; a full sign-in does not", async () => {
    const auth = await import("../../src/lib/auth");
    auth.setSession({ token: "t", user: USER, enrolOnly: true });
    expect((await auth.getCurrentSession())?.enrolOnly).toBe(true);
    auth.setSession({ token: "t2", user: USER });
    expect((await auth.getCurrentSession())?.enrolOnly).toBe(false);
  });

  it("any route that answers mfa_enrolment_required sends the tab to /login/two-step", async () => {
    worker(
      answer(403, { error: "Set up two-step sign-in first.", code: "mfa_enrolment_required" }),
    );
    const { apiFetch, ENROL_PATH } = await import("../../src/lib/api");
    await expect(apiFetch("/admin/customers/list")).rejects.toMatchObject({ status: 403 });
    expect(win.location.href).toBe(ENROL_PATH);
    expect(ENROL_PATH).toBe("/login/two-step/");
  });

  it("another 403 does not", async () => {
    worker(answer(403, { error: "Forbidden: superadmin role required" }));
    const { apiFetch } = await import("../../src/lib/api");
    await expect(apiFetch("/admin/customers/list")).rejects.toMatchObject({ status: 403 });
    expect(win.location.href).toBe("");
  });
});

describe("signed-in calls", () => {
  it("status, with and without A1's other_sessions", async () => {
    const base = {
      enabled: true,
      pending: false,
      required: false,
      recovery_codes_left: 10,
      enabled_at: 1,
    };
    worker(answer(200, { ...base, other_sessions: 2 }), answer(200, base));
    const { getStatus } = await import("../../src/lib/mfa");
    expect(await getStatus()).toEqual({ ok: true, data: { ...base, other_sessions: 2 } });
    const older = await getStatus();
    expect(older.ok && older.data.other_sessions).toBeUndefined();
  });

  it("a wrong password and a wrong code are told apart; a dead session is its own kind", async () => {
    worker(
      answer(401, { error: "That password is not right." }),
      answer(401, { error: "That code did not work. Try again." }),
      answer(401, { error: "Unauthorized" }),
      answer(403, { error: "Your account must keep two-step sign-in." }),
    );
    const { turnOff } = await import("../../src/lib/mfa");
    expect(await turnOff("x", "1")).toMatchObject({ kind: "wrong-password" });
    expect(await turnOff("x", "1")).toMatchObject({ kind: "wrong-code" });
    expect(await turnOff("x", "1")).toMatchObject({ kind: "session" });
    expect(await turnOff("x", "1")).toMatchObject({
      kind: "required",
      message: "Your account must keep two-step sign-in.",
    });
    // None of them sends the tab away by itself (apiFetch would on a 401).
    expect(win.location.href).toBe("");
  });

  it("sign out everywhere else keeps this session", async () => {
    worker(answer(200, { ok: true, revoked: 2 }));
    const { signOutOthers } = await import("../../src/lib/mfa");
    expect(await signOutOthers()).toEqual({ ok: true, data: { ok: true, revoked: 2 } });
    expect(calls[0]?.url).toBe("http://localhost:8787/admin/sessions/revoke-all");
    expect(calls[0]?.body).toEqual({ keep_current: true });
  });

  it("A2: the users list, and null while the worker has no route", async () => {
    const users = [
      { id: "u1", email: "sam@brisk.test", two_step: true },
      { id: "u2", email: "dev@brisk.test", two_step: false },
    ];
    worker(answer(200, { users }), answer(404, { error: "Not found" }));
    const { listCustomerUsers } = await import("../../src/lib/mfa");
    expect(await listCustomerUsers("brisk")).toEqual(users);
    expect(calls[0]?.url).toBe("http://localhost:8787/admin/customer-users?customer_id=brisk");
    expect(await listCustomerUsers("brisk")).toBeNull();
  });

  it("reset sends the user id; the API's refusal comes back as its sentence", async () => {
    worker(
      answer(200, { ok: true, had_two_step: true, revoked: 1 }),
      answer(400, { error: "Only a customer user can be reset here." }),
    );
    const { resetTwoStep } = await import("../../src/lib/mfa");
    expect(await resetTwoStep("u1")).toEqual({
      ok: true,
      data: { ok: true, had_two_step: true, revoked: 1 },
    });
    expect(calls[0]?.body).toEqual({ user_id: "u1" });
    expect(await resetTwoStep("admin")).toEqual({
      ok: false,
      kind: "error",
      message: "Only a customer user can be reset here.",
    });
  });
});

describe("the recovery notice, once per tab", () => {
  it("is read once and then gone", async () => {
    const { stashRecoveryNotice, takeRecoveryNotice } = await import("../../src/lib/mfa");
    expect(takeRecoveryNotice()).toBeNull();
    stashRecoveryNotice(7);
    expect(takeRecoveryNotice()).toBe(7);
    expect(takeRecoveryNotice()).toBeNull();
    stashRecoveryNotice(0);
    expect(takeRecoveryNotice()).toBe(0);
  });
});
