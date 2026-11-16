"use client";

import { clearToken, getToken } from "./auth";

export const API_ORIGIN = process.env.NEXT_PUBLIC_ADMIN_API_ORIGIN ?? "http://localhost:8787";

/** The required set-up page (two-step mock §05). */
export const ENROL_PATH = "/login/two-step/";

/** The 403 an enrol-only session gets on any other route. */
export function isEnrolmentRefusal(body: string): boolean {
  try {
    const b = JSON.parse(body) as { code?: unknown } | null;
    return b?.code === "mfa_enrolment_required";
  } catch {
    return false;
  }
}

/** Typed API error thrown when a request fails. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Typed fetch wrapper for admin API calls.
 *
 * - Prepends the admin API origin.
 * - Injects X-Rawuser-Admin token from sessionStorage.
 * - Throws ApiError on non-2xx responses.
 * - Redirects to /login on 401 (token expired or wrong password).
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const url = `${API_ORIGIN}${path}`;

  const resp = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { "X-Rawuser-Admin": token } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (resp.status === 401) {
    clearToken();
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new ApiError(401, "Unauthorized. Redirecting to login");
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    // A session that may only set up two-step sign-in reaches nothing else
    // (docs/specs/security-hardening.md §1.4): its page is /login/two-step.
    if (resp.status === 403 && isEnrolmentRefusal(text) && typeof window !== "undefined") {
      window.location.href = ENROL_PATH;
    }
    throw new ApiError(resp.status, `API error ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<T>;
}
