"use client";

import { AppShell } from "@/components/shell/AppShell";
import { OldRoute } from "@/components/shell/OldRoute";
import { Suspense } from "react";

/**
 * Account moved into Settings (dashboard v2, section 05). This address is
 * kept for old links and the recovery-code line (`?codes=new`), which go on
 * to /settings?tab=account with the query kept.
 */
export default function AccountPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <OldRoute>{null}</OldRoute>
      </Suspense>
    </AppShell>
  );
}
