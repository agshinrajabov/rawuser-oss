/**
 * Customer-scope authorization helper.
 *
 * Every /admin/* endpoint that takes a `customer_id` parameter must guard
 * cross-customer access by calling requireCustomerScope() right after
 * getSessionUser(). Returns ok=true when the request is allowed, ok=false
 * with a reason when it must be rejected (caller wraps in 400/403 response).
 *
 * Role semantics (set in migration 0009):
 *   - superadmin: customer_id is NULL, allowed to access any customer
 *   - customer:   customer_id is non-NULL, allowed to access ONLY that one
 *
 * Privacy invariant: this function reads only operator data (the session
 * user's role + customer_id) and the requested customer_id from the
 * request URL. No visitor data is touched.
 */

import type { SessionUser } from "./auth.ts";

export type ScopeResult = { ok: true } | { ok: false; reason: string };

export function requireCustomerScope(
  user: SessionUser,
  requestedCustomerId: string | null,
): ScopeResult {
  if (user.role === "superadmin") {
    // Superadmin can access any customer, including missing customer_id
    // (some endpoints, e.g. /admin/customers/list, take no customer_id).
    return { ok: true };
  }

  if (user.role === "customer") {
    if (!requestedCustomerId) {
      // Customer must always scope by customer_id — refusing to fall back
      // to "show everything" is the safe default.
      return { ok: false, reason: "customer_id query parameter required" };
    }
    if (requestedCustomerId !== user.customer_id) {
      // Cross-customer probe — return a generic forbidden reason so the
      // response body never reveals which other customers exist.
      return { ok: false, reason: "Forbidden: cross-customer access denied" };
    }
    return { ok: true };
  }

  // Defensive default — an unknown role means we don't know what the
  // caller is allowed to see, so deny by default.
  return { ok: false, reason: "Unknown role" };
}
