"use client";

import { useCurrentUser } from "@/components/shell/CurrentUserContext";
import { useCustomerList } from "@/components/shell/CustomerListContext";
import { AuditEndedScreen, isAuditCustomer } from "./FirstRunAudit";

/**
 * After an audit ends without a pilot, its customer sees one screen and
 * nothing else (docs/specs/ai-traffic-audit.md §3.8; mock section 11). A
 * superadmin keeps the dashboard.
 */
export function AuditEndedGate({ children }: { children: React.ReactNode }) {
  const { user } = useCurrentUser();
  const { customers } = useCustomerList();
  if (user?.role === "customer") {
    const mine = customers.find((c) => c.id === user.customer_id);
    if (mine && isAuditCustomer(mine) && mine.status === "ended") {
      return <AuditEndedScreen customer={mine} />;
    }
  }
  return <>{children}</>;
}
