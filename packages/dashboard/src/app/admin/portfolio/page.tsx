"use client";

import { AttentionRail } from "@/components/portfolio/AttentionRail";
import { PortfolioGrid } from "@/components/portfolio/PortfolioGrid";
import { AppShell } from "@/components/shell/AppShell";
import { useCurrentUser } from "@/components/shell/CurrentUserContext";
import { Separator } from "@/components/ui/Separator";
import { apiFetch } from "@/lib/api";
import type { AttentionSignal, PortfolioItem } from "@/types/api";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

function PortfolioInner() {
  const router = useRouter();
  const { user, loading: userLoading } = useCurrentUser();

  const [customers, setCustomers] = useState<PortfolioItem[]>([]);
  const [signals, setSignals] = useState<AttentionSignal[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [loadingSignals, setLoadingSignals] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Role guard — redirect non-superadmin users to /customers
  useEffect(() => {
    if (userLoading) return;
    if (user && user.role !== "superadmin") {
      router.replace("/customers");
    }
  }, [user, userLoading, router]);

  // Fetch portfolio data once we know the user is a superadmin
  useEffect(() => {
    if (userLoading) return;
    if (!user || user.role !== "superadmin") return;

    let cancelled = false;

    async function fetchData() {
      try {
        const [customersData, signalsData] = await Promise.all([
          apiFetch<PortfolioItem[]>("/admin/portfolio/customers"),
          apiFetch<AttentionSignal[]>("/admin/portfolio/attention"),
        ]);
        if (!cancelled) {
          setCustomers(customersData);
          setSignals(signalsData);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load portfolio data");
        }
      } finally {
        if (!cancelled) {
          setLoadingCustomers(false);
          setLoadingSignals(false);
        }
      }
    }

    void fetchData();

    return () => {
      cancelled = true;
    };
  }, [user, userLoading]);

  // While user is loading, render nothing (AuthGuard handles the non-token case)
  if (userLoading) {
    return null;
  }

  // Non-superadmin: redirect has been triggered, don't render anything
  if (user && user.role !== "superadmin") {
    return null;
  }

  // Count summary for the subtitle line
  const activeCount = customers.filter((c) => c.snippet_status === "active").length;
  const attentionCount = signals.length;

  const contextParts: string[] = [];
  if (!loadingCustomers) {
    contextParts.push(`${customers.length} customer${customers.length !== 1 ? "s" : ""}`);
    if (activeCount > 0) contextParts.push(`${activeCount} active`);
    if (attentionCount > 0) contextParts.push(`${attentionCount} attention`);
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-fg">Portfolio</h1>
        {!loadingCustomers && (
          <p className="text-sm text-fg-muted mt-0.5">{contextParts.join(" · ") || "Loading…"}</p>
        )}
      </div>

      <Separator className="mb-4" />

      {error ? (
        <div className="flex flex-col items-center justify-center py-16 border border-border rounded-sm">
          <p className="text-sm text-fg-muted">{error}</p>
        </div>
      ) : (
        /*
         * Two-column layout on lg+:
         *   - Left / main area: customer card grid (grows to fill)
         *   - Right rail: attention signals (fixed-width, sticks to top)
         *
         * On mobile (< lg) the attention rail stacks above the grid.
         */
        <div className="flex flex-col lg:flex-row gap-4 items-start">
          {/* Attention rail — on mobile: full width stacked above; on lg: 240px right column */}
          <div className="w-full lg:w-60 lg:shrink-0 order-first lg:order-last">
            <AttentionRail signals={signals} loading={loadingSignals} />
          </div>

          {/* Customer grid — grows */}
          <div className="flex-1 min-w-0">
            <PortfolioGrid items={customers} loading={loadingCustomers} />
          </div>
        </div>
      )}
    </>
  );
}

export default function AdminPortfolioPage() {
  return (
    <AppShell>
      <PortfolioInner />
    </AppShell>
  );
}
