"use client";

/** /test: do the versions bring more clicks (dashboard v2, section 04). */

import { AppShell } from "@/components/shell/AppShell";
import { ScreenEmpty } from "@/components/shell/ScreenEmpty";
import { Test } from "@/components/v2/Test";
import { useScope } from "@/components/v2/parts";
import { FlaskConical } from "lucide-react";
import { Suspense } from "react";

function TestInner() {
  const { customerId, superadmin } = useScope();
  if (!customerId) {
    return (
      <ScreenEmpty
        icon={FlaskConical}
        title="Pick a customer to see their test"
        body="Choose a customer from the top bar."
      />
    );
  }
  return <Test key={customerId} customerId={customerId} superadmin={superadmin} />;
}

export default function TestPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <TestInner />
      </Suspense>
    </AppShell>
  );
}
