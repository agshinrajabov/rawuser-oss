/**
 * Unit tests for requireCustomerScope — the authorization gate that
 * every /admin/* endpoint takes a customer_id parameter must call right
 * after getSessionUser.
 *
 * Coverage:
 *   - Superadmin can access any customer (including missing id)
 *   - Customer can access only their own customer_id
 *   - Customer cross-customer probe is rejected with a generic reason
 *     that does NOT leak the existence of other customers
 *   - Customer missing customer_id query param → 400-style "required" reason
 *   - Unknown role defensively denied
 */

import { describe, expect, it } from "vitest";
import type { SessionUser } from "../../src/admin/auth.ts";
import { requireCustomerScope } from "../../src/admin/scope.ts";

function superadmin(): SessionUser {
  return {
    id: "u-super",
    email: "operator@rawuser.example",
    role: "superadmin",
    customer_id: null,
  };
}

function customer(customerId: string): SessionUser {
  return {
    id: `u-cust-${customerId}`,
    email: `${customerId}@example.com`,
    role: "customer",
    customer_id: customerId,
  };
}

function unknownRole(): SessionUser {
  return {
    id: "u-unknown",
    email: "x@y.z",
    role: "moderator", // anything not in the closed enum
    customer_id: null,
  };
}

describe("requireCustomerScope", () => {
  describe("role=superadmin", () => {
    it("allows access when customer_id matches", () => {
      const res = requireCustomerScope(superadmin(), "lumera-school");
      expect(res.ok).toBe(true);
    });

    it("allows access when customer_id is missing (e.g. /customers/list)", () => {
      const res = requireCustomerScope(superadmin(), null);
      expect(res.ok).toBe(true);
    });

    it("allows access when targeting any non-empty customer_id", () => {
      const res = requireCustomerScope(superadmin(), "any-customer");
      expect(res.ok).toBe(true);
    });
  });

  describe("role=customer", () => {
    it("allows access to own customer_id", () => {
      const res = requireCustomerScope(customer("lumera-school"), "lumera-school");
      expect(res.ok).toBe(true);
    });

    it("rejects cross-customer access with a generic 'forbidden' reason", () => {
      const res = requireCustomerScope(customer("lumera-school"), "acme");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        // Reason must NOT name the other customer or confirm it exists
        expect(res.reason.toLowerCase()).toContain("forbidden");
        expect(res.reason).not.toContain("acme");
        expect(res.reason).not.toContain("lumera-school");
      }
    });

    it("rejects when customer_id query param is missing", () => {
      const res = requireCustomerScope(customer("lumera-school"), null);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toContain("customer_id");
        expect(res.reason).toContain("required");
      }
    });

    it("rejects when customer_id is empty string (treated as missing)", () => {
      const res = requireCustomerScope(customer("lumera-school"), "");
      expect(res.ok).toBe(false);
    });
  });

  describe("unknown role", () => {
    it("denies by default", () => {
      const res = requireCustomerScope(unknownRole(), "lumera-school");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toContain("Unknown role");
      }
    });

    it("denies even with no customer_id", () => {
      const res = requireCustomerScope(unknownRole(), null);
      expect(res.ok).toBe(false);
    });
  });
});
