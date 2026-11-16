"use client";

/**
 * /audit/: with `#t=` the free audit's public sign-up (no session, the quiet
 * ledger); without it the signed-in Audit page in the dashboard shell
 * (docs/specs/ai-traffic-audit.md §3.2, §6; mock sections 02 and 04).
 */

import { AuditPageScreen } from "@/components/audit/AuditPage";
import { AuditSignupFlow, AuditSignupLoading } from "@/components/audit/AuditSignup";
import { useFragmentMode } from "@/components/audit/useFragmentMode";
import { AppShell } from "@/components/shell/AppShell";
import { Suspense } from "react";

export default function AuditPage() {
  const mode = useFragmentMode();
  if (mode === null) return <div className="min-h-dvh bg-bg" />;
  if (mode === "public") {
    return (
      <Suspense fallback={<AuditSignupLoading />}>
        <AuditSignupFlow />
      </Suspense>
    );
  }
  return (
    <AppShell>
      <Suspense fallback={null}>
        <AuditPageScreen />
      </Suspense>
    </AppShell>
  );
}
