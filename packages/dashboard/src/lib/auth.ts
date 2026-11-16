"use client";

const TOKEN_KEY = "rawuser_admin_token";

/**
 * SessionUser shape — matches the server response from /admin/me.
 *
 * `customer_id` was added in V2 M3 Batch C P1 (multi-tenancy):
 *   - role='superadmin': null (operator, sees all customers)
 *   - role='customer':   the single customer_id this user is scoped to
 */
export type SessionUser = {
  id: string;
  email: string;
  role: string;
  customer_id: string | null;
};

let cachedUser: SessionUser | null = null;
/**
 * The session may only set up two-step sign-in (its role requires it and it
 * is off; docs/specs/security-hardening.md §1.4). Every page but
 * /login/two-step sends it there.
 */
let cachedEnrolOnly = false;

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(TOKEN_KEY);
}

// ---------------------------------------------------------------------------
// Tab handoff (the founder's call, 2026-10-05). The token lives in
// sessionStorage, which is per tab, so a link opened in a new tab (from chat,
// from an email) found no token and went to /login. A tab without a token now
// asks the open dashboard tabs of the same origin over a BroadcastChannel and
// keeps the first answer in its own sessionStorage. Nothing goes to
// persistent storage: when every tab is closed the session is gone, as
// before. A logout tells every tab to drop its copy (the old storage-event
// listener never fired, sessionStorage raises no cross-tab events).
// ---------------------------------------------------------------------------

const CHANNEL = "rawuser-auth";
const BORROW_WAIT_MS = 400;

type AuthMessage = { type: "ask" } | { type: "token"; token: string } | { type: "logout" };

let channel: BroadcastChannel | null = null;
const logoutListeners = new Set<() => void>();

function authChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  if (channel) return channel;
  const ch = new BroadcastChannel(CHANNEL);
  ch.addEventListener("message", (e: MessageEvent<AuthMessage>) => {
    const msg = e.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ask") {
      const token = getToken();
      if (token) ch.postMessage({ type: "token", token } satisfies AuthMessage);
    } else if (msg.type === "logout") {
      clearToken();
      cachedUser = null;
      cachedEnrolOnly = false;
      for (const fn of logoutListeners) fn();
    }
  });
  channel = ch;
  return ch;
}

/** Runs `fn` when another tab signs out. Returns the unsubscribe. */
export function onLogoutElsewhere(fn: () => void): () => void {
  authChannel();
  logoutListeners.add(fn);
  return () => {
    logoutListeners.delete(fn);
  };
}

/**
 * This tab's token, or one borrowed from another open dashboard tab.
 * Resolves null when no tab answers within `waitMs`.
 */
export function borrowToken(waitMs = BORROW_WAIT_MS): Promise<string | null> {
  const ch = authChannel();
  const own = getToken();
  if (own) return Promise.resolve(own);
  if (!ch) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent<AuthMessage>) => {
      const msg = e.data;
      if (msg && msg.type === "token" && typeof msg.token === "string" && msg.token !== "") {
        setToken(msg.token);
        done(msg.token);
      }
    };
    const timer = setTimeout(() => done(null), waitMs);
    function done(token: string | null) {
      ch?.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(token);
    }
    ch.addEventListener("message", onMessage);
    ch.postMessage({ type: "ask" } satisfies AuthMessage);
  });
}

export function setSession({
  token,
  user,
  enrolOnly = false,
}: { token: string; user: SessionUser; enrolOnly?: boolean }): void {
  setToken(token);
  cachedUser = user;
  cachedEnrolOnly = enrolOnly;
  // From now on this tab answers the others.
  authChannel();
}

/**
 * Turning two-step on rotates the session: the server ended every older
 * one, this tab's too, and answered with the token to use from now on. It
 * replaces the stored one at once, and the session is a full one.
 */
export function replaceToken(token: string): void {
  setToken(token);
  cachedEnrolOnly = false;
}

export type CurrentSession = { user: SessionUser; enrolOnly: boolean };

export async function getCurrentSession(): Promise<CurrentSession | null> {
  if (cachedUser) return { user: cachedUser, enrolOnly: cachedEnrolOnly };

  const token = await borrowToken();
  if (!token) return null;

  try {
    const { apiFetch } = await import("./api");
    const data = await apiFetch<{ user: SessionUser; mfa_enrolment_required?: boolean }>(
      "/admin/me",
    );
    cachedUser = data.user;
    cachedEnrolOnly = data.mfa_enrolment_required === true;
    return { user: cachedUser, enrolOnly: cachedEnrolOnly };
  } catch {
    clearToken();
    cachedUser = null;
    cachedEnrolOnly = false;
    return null;
  }
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  return (await getCurrentSession())?.user ?? null;
}

export function clearSession(): void {
  const token = getToken();
  clearToken();
  cachedUser = null;
  cachedEnrolOnly = false;
  authChannel()?.postMessage({ type: "logout" } satisfies AuthMessage);
  if (typeof window !== "undefined") {
    void fetch(
      `${process.env.NEXT_PUBLIC_ADMIN_API_ORIGIN ?? "http://localhost:8787"}/admin/logout`,
      {
        method: "POST",
        headers: token ? { "X-Rawuser-Admin": token } : {},
      },
    );
  }
}
