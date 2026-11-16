"use client";

/** /visitors: plain analytics with the click-a-row filter (dashboard v2, section 02). */

import { AppShell } from "@/components/shell/AppShell";
import { ScreenEmpty } from "@/components/shell/ScreenEmpty";
import { Visitors } from "@/components/v2/Visitors";
import { useScope } from "@/components/v2/parts";
import { Users } from "lucide-react";
import { Suspense } from "react";

function VisitorsInner() {
  const { customerId, superadmin } = useScope();
  if (!customerId) {
    return (
      <ScreenEmpty
        icon={Users}
        title="Pick a customer to see their visitors"
        body="Choose a customer from the top bar."
      />
    );
  }
  return <Visitors key={customerId} customerId={customerId} superadmin={superadmin} />;
}

export default function VisitorsPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <VisitorsInner />
      </Suspense>
    </AppShell>
  );
}
