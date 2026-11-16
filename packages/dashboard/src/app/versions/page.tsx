"use client";

/**
 * /versions: what each kind of visitor reads (dashboard v2, section 03). A
 * customer reads its own; a superadmin the customer picked in the top bar.
 */

import { AppShell } from "@/components/shell/AppShell";
import { ScreenEmpty } from "@/components/shell/ScreenEmpty";
import { Versions } from "@/components/v2/Versions";
import { useScope } from "@/components/v2/parts";
import { Layers } from "lucide-react";
import { Suspense } from "react";

function VersionsInner() {
  const { customerId, superadmin } = useScope();
  if (!customerId) {
    return (
      <ScreenEmpty
        icon={Layers}
        title="Pick a customer to read their versions"
        body="Choose a customer from the top bar."
      />
    );
  }
  return <Versions key={customerId} customerId={customerId} superadmin={superadmin} />;
}

export default function VersionsPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <VersionsInner />
      </Suspense>
    </AppShell>
  );
}
