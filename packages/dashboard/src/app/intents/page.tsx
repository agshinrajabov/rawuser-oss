"use client";

import { ClassifierSimulator } from "@/components/intents/ClassifierSimulator";
import { DimTable } from "@/components/intents/DimTable";
import { NextStepsBanner } from "@/components/journey/NextStepsBanner";
import { AppShell } from "@/components/shell/AppShell";
import { OldRoute } from "@/components/shell/OldRoute";
import { Separator } from "@/components/ui/Separator";
import { apiFetch } from "@/lib/api";
import type { VariantListItem } from "@/types/api";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

function buildVariantCounts(variants: VariantListItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of variants) {
    if (v.intent_dim) {
      counts[v.intent_dim] = (counts[v.intent_dim] ?? 0) + 1;
    }
    if (v.source_dim) {
      counts[v.source_dim] = (counts[v.source_dim] ?? 0) + 1;
    }
  }
  return counts;
}

function IntentsInner() {
  const searchParams = useSearchParams();
  const customerId = searchParams.get("customer_id") ?? "";

  const [variants, setVariants] = useState<VariantListItem[]>([]);

  useEffect(() => {
    if (!customerId) return;
    apiFetch<VariantListItem[]>(`/admin/variants/list?customer_id=${customerId}`)
      .then((data) => setVariants(data))
      .catch(() => {});
  }, [customerId]);

  const variantCounts = useMemo(() => buildVariantCounts(variants), [variants]);

  return (
    <>
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-lg font-semibold text-fg">Visitor intents</h1>
      </div>
      <p className="text-sm text-fg-muted mb-3">
        The kinds of visitor Rawuser recognizes and adapts the page for, and what tips it off.
        Reference only, nothing to set up here.
      </p>
      <Separator className="mb-gap-section" />

      <NextStepsBanner screen="intents" />

      <div className="grid grid-cols-[1fr_400px] gap-gap-section items-start">
        <div>
          <DimTable variantCounts={variantCounts} />
        </div>

        <div className="sticky top-0 self-start">
          <ClassifierSimulator />
        </div>
      </div>
    </>
  );
}

export default function IntentsPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <OldRoute>
          <Suspense>
            <IntentsInner />
          </Suspense>
        </OldRoute>
      </Suspense>
    </AppShell>
  );
}
