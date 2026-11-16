"use client";

/**
 * /conversions — top-level Conversions management surface (V2 Module 3).
 *
 * Loads the current customer's conversion targets and provides:
 *   - List with inline edit / enable toggle / per-row delete
 *   - Add-manual-target form below the list
 *
 * Reads customer_id from useSearchParams — same pattern as every other
 * customer-scoped screen.
 */

import { useProof } from "@/components/analytics/ProofSection";
import { AddConversionForm } from "@/components/conversions/AddConversionForm";
import { SiteEntry } from "@/components/conversions/ButtonList";
import { ConversionsList } from "@/components/conversions/ConversionsList";
import { AppShell } from "@/components/shell/AppShell";
import { useCurrentUser } from "@/components/shell/CurrentUserContext";
import { useCustomerList } from "@/components/shell/CustomerListContext";
import { OldRoute } from "@/components/shell/OldRoute";
import { ScreenEmpty } from "@/components/shell/ScreenEmpty";
import { Card } from "@/components/ui/Card";
import { Separator } from "@/components/ui/Separator";
import { apiFetch } from "@/lib/api";
import { testIsOn } from "@/lib/measure";
import type { ConversionTarget, ConversionsListResponse } from "@/types/api";
import { Loader2, Target } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

function ConversionsBody() {
  const searchParams = useSearchParams();
  const customerId = searchParams.get("customer_id") ?? "";
  const { customers } = useCustomerList();
  const { user } = useCurrentUser();
  // Customer-role viewers get the read-only surface (no add form, no
  // checkbox/delete/inline-edit). Superadmin always gets the editing UI,
  // including when viewing-as a specific customer.
  const readOnly = user?.role === "customer";
  const currentCustomer = customers.find((c) => c.id === customerId) ?? null;
  // The test state decides whether the counted buttons can change (mock 08).
  const proof = useProof(customerId, user?.role === "superadmin");
  const testOn = proof.report ? testIsOn(proof.report) : false;

  const [items, setItems] = useState<ConversionTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!customerId) {
      setItems(null);
      return;
    }
    setError(null);
    try {
      const resp = await apiFetch<ConversionsListResponse>(
        `/admin/conversions/list?customer_id=${encodeURIComponent(customerId)}`,
      );
      setItems(resp.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
      setItems([]);
    }
  }, [customerId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!customerId) {
    return (
      <ScreenEmpty
        icon={Target}
        title="Pick a customer to see their goals"
        body="Choose a customer from the top bar. Goals are the actions Rawuser counts as success: signups, demos, purchases. You see which page version drives them."
      />
    );
  }

  if (items === null) {
    return (
      <p className="text-sm text-fg-muted flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading conversion targets…
      </p>
    );
  }

  const activeCount = items.filter((i) => i.enabled).length;

  return (
    <div className="space-y-4">
      {error && <p className="text-state-err text-sm">{error}</p>}

      <Card className="p-4">
        <div className="flex items-baseline justify-between mb-2">
          <p className="text-[0.9375rem] font-semibold text-fg">Active conversion targets</p>
          <p className="text-xs text-fg-muted font-mono">
            {currentCustomer?.id ?? customerId} · {activeCount} active / {items.length} total
          </p>
        </div>
        <Separator className="mb-3" />
        <ConversionsList
          customerId={customerId}
          items={items}
          onMutated={load}
          readOnly={readOnly}
        />
        {/* A button on every page (site-wide mock, sections 01 and 02): the
            pick the readiness line "Count it on every page" leads to. The
            API scopes it to the customer, so a customer session has it too. */}
        <div className="mt-3 border-t border-border pt-3">
          <SiteEntry customerId={customerId} items={items} onItems={setItems} blocked={testOn} />
        </div>
      </Card>

      {!readOnly && (
        <Card className="p-4">
          <p className="text-[0.9375rem] font-semibold text-fg mb-2">Add conversion target</p>
          <Separator className="mb-3" />
          <AddConversionForm
            customerId={customerId}
            onAdded={load}
            existingPaths={items.map((i) => i.section_path)}
          />
        </Card>
      )}
    </div>
  );
}

export default function ConversionsPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <OldRoute>
          <div className="mb-4">
            <h1 className="text-lg font-semibold text-fg">Goals</h1>
            <p className="text-sm text-fg-muted mt-1">
              The actions that count as success: a signup, a demo booking, a purchase. Rawuser
              tracks clicks on these so you can see which version drives them.
            </p>
          </div>
          <Separator className="mb-5" />
          <Suspense
            fallback={
              <p className="text-sm text-fg-muted flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </p>
            }
          >
            <ConversionsBody />
          </Suspense>
        </OldRoute>
      </Suspense>
    </AppShell>
  );
}
