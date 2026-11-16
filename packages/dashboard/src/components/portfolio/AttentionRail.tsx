"use client";

import { cn } from "@/lib/utils";
import type { AttentionSignal } from "@/types/api";
import Link from "next/link";
import { HealthBadge } from "./HealthBadge";

interface AttentionRailProps {
  signals: AttentionSignal[];
  loading: boolean;
}

const SIGNAL_META: Record<AttentionSignal["type"], { title: string; description: string }> = {
  "snippet-removed": {
    title: "Snippet removed",
    description: "Script tag no longer found in the customer's HTML.",
  },
  "snippet-stale": {
    title: "Snippet stale",
    description: "No events received in the past 24 hours.",
  },
  "skipped-rate-high": {
    title: "High skip rate",
    description:
      "More than 30% of personalized visits couldn't apply a variant. Re-detect elements.",
  },
  "lift-trend-down": {
    title: "Lift declining",
    description: "7-day holdout lift has dropped by more than 20 percentage points.",
  },
};

function SignalRow({ signal }: { signal: AttentionSignal }) {
  const meta = SIGNAL_META[signal.type];
  const valueStr =
    signal.value !== undefined
      ? signal.type === "skipped-rate-high"
        ? ` (${Math.round(signal.value * 100)}%)`
        : ` (${signal.value >= 0 ? "+" : ""}${Math.round(signal.value * 100)}%)`
      : "";

  return (
    <Link
      href={`/analytics?as_customer=${encodeURIComponent(signal.customer_id)}`}
      className={cn(
        "flex flex-col gap-0.5 px-3 py-2.5 -mx-3 rounded-sm",
        "hover:bg-surface-muted transition-colors duration-fast ease-smooth",
        "group",
      )}
    >
      {/* Signal type + value */}
      <div className="flex items-baseline gap-1 min-w-0">
        <span className="w-1 h-1 rounded-full bg-state-warn shrink-0 mt-1" aria-hidden />
        <span className="text-xs font-medium text-fg truncate">
          {signal.customer_id}
          {valueStr && <span className="font-normal text-fg-muted">{valueStr}</span>}
        </span>
      </div>
      {/* Description */}
      <p className="text-xs text-fg-muted pl-3 leading-snug">
        {meta.title}. {meta.description}
      </p>
    </Link>
  );
}

export function AttentionRail({ signals, loading }: AttentionRailProps) {
  return (
    <div className="bg-surface border border-border rounded-md flex flex-col h-fit">
      {/* Rail header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-fg">Attention</span>
        {!loading && signals.length > 0 && (
          <span className="text-xs font-medium text-state-warn bg-[color-mix(in_srgb,var(--state-warn)_10%,transparent)] px-1.5 py-0.5 rounded-sm">
            {signals.length}
          </span>
        )}
      </div>

      <div className="px-3 py-2">
        {loading ? (
          /* Skeleton rows */
          <div className="space-y-2 py-1">
            {(["s1", "s2"] as const).map((k) => (
              <div key={k} className="flex flex-col gap-1">
                <div className="h-3 w-3/4 bg-surface-muted rounded animate-pulse" />
                <div className="h-3 w-full bg-surface-muted rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : signals.length === 0 ? (
          /* Empty state */
          <div className="flex items-center gap-2 py-2.5">
            <HealthBadge health="green" />
            <span className="text-xs text-fg-muted">All customers healthy</span>
          </div>
        ) : (
          /* Signal list */
          <div className="flex flex-col divide-y divide-border -mx-0">
            {signals.map((s) => (
              <SignalRow key={`${s.customer_id}:${s.type}`} signal={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
