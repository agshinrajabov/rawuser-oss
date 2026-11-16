"use client";

import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/Card";
import type { PortfolioItem } from "@/types/api";
import { Globe } from "lucide-react";
import { HealthBadge } from "./HealthBadge";
import { ViewAsButton } from "./ViewAsButton";

interface PortfolioCardProps {
  item: PortfolioItem;
}

const SNIPPET_LABEL: Record<PortfolioItem["snippet_status"], string> = {
  active: "Active",
  stale: "Stale",
  removed: "Removed",
  never: "Awaiting traffic",
  unknown: "Not probed",
};

const SNIPPET_COLOR: Record<PortfolioItem["snippet_status"], string> = {
  active: "text-state-success",
  stale: "text-state-warn",
  removed: "text-state-err",
  never: "text-fg-faint",
  unknown: "text-fg-faint",
};

export function PortfolioCard({ item }: PortfolioCardProps) {
  const liftLabel =
    item.holdout_lift_7d !== null
      ? `${item.holdout_lift_7d >= 0 ? "+" : ""}${Math.round(item.holdout_lift_7d * 100)}% lift 7d`
      : "lift pending";

  const snippetColor = SNIPPET_COLOR[item.snippet_status];
  const snippetText = SNIPPET_LABEL[item.snippet_status];

  return (
    <Card className="flex flex-col">
      {/* Header */}
      <CardHeader className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-fg truncate">{item.customer_slug}</p>
            <p className="text-xs text-fg-muted mt-0.5 flex items-center gap-1 truncate">
              <Globe size={11} className="shrink-0 text-fg-faint" aria-hidden />
              {item.customer_domain}
            </p>
          </div>
          <HealthBadge health={item.health} className="shrink-0 mt-0.5" />
        </div>
      </CardHeader>

      {/* Metrics */}
      <CardContent className="px-4 pb-4 pt-0 flex-1">
        {/* Metric row */}
        <div className="grid grid-cols-3 gap-2 mt-1">
          {/* Snippet status */}
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-fg-faint">Snippet</span>
            <span className={`text-xs font-medium ${snippetColor}`}>{snippetText}</span>
          </div>

          {/* Lift */}
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-fg-faint">7d lift</span>
            <span
              className={`text-xs font-medium mono-num ${
                item.holdout_lift_7d !== null
                  ? item.holdout_lift_7d >= 0
                    ? "text-state-success"
                    : "text-state-err"
                  : "text-fg-faint"
              }`}
            >
              {liftLabel}
            </span>
          </div>

          {/* 24h visits */}
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-fg-faint">Visits 24h</span>
            <span className="text-xs font-medium text-fg mono-num">{item.visits_24h}</span>
          </div>
        </div>

        {/* Active signals — pill row */}
        {item.signals.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-3">
            {item.signals.map((sig) => (
              <span
                key={sig}
                className="inline-flex items-center h-4 px-1.5 text-[10px] font-medium rounded-sm bg-[color-mix(in_srgb,var(--state-warn)_10%,transparent)] text-state-warn border border-[color-mix(in_srgb,var(--state-warn)_20%,transparent)]"
              >
                {sig}
              </span>
            ))}
          </div>
        )}
      </CardContent>

      {/* Footer */}
      <CardFooter className="px-4 py-3 border-t border-border justify-between">
        <ViewAsButton customerId={item.customer_id} />
      </CardFooter>
    </Card>
  );
}
