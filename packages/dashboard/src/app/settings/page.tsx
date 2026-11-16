"use client";

/** /settings: Install, Product brief, Campaign links, Account (dashboard v2, section 05). */

import { AppShell } from "@/components/shell/AppShell";
import { Settings } from "@/components/v2/Settings";
import { useScope } from "@/components/v2/parts";
import { Suspense } from "react";

function SettingsInner() {
  const { customerId, superadmin, host } = useScope();
  return <Settings customerId={customerId} superadmin={superadmin} host={host} />;
}

export default function SettingsPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <SettingsInner />
      </Suspense>
    </AppShell>
  );
}
