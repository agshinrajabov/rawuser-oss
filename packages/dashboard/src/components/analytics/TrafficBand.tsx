"use client";

import { Segmented } from "@/components/start/PlatformSteps";
import { Skeleton } from "@/components/ui/Skeleton";
import { num } from "@/lib/proof";
import {
  type ResultsWindow,
  changeText,
  clickedLabel,
  comparisonLabel,
  periodLabel,
  rateOf,
  windowsFor,
} from "@/lib/results";
import type { AnalyticsOverview, LiftReport } from "@/types/api";

/**
 * "Your traffic" (results-page mock): the period switch sits here, next to
 * the numbers it changes; everything below follows it. A change shows only
 * where the API gives one, in ink, never green or red.
 */
export function TrafficBand({
  window,
  onWindow,
  superadmin,
  overview,
  loading,
  report,
}: {
  window: ResultsWindow;
  onWindow: (w: ResultsWindow) => void;
  superadmin: boolean;
  overview: AnalyticsOverview | null;
  loading: boolean;
  report: LiftReport | null;
}) {
  const compare = comparisonLabel(window, overview?.comparison);
  const label = periodLabel(window, overview?.period, overview?.computed_at ?? null);
  return (
    <section
      aria-labelledby="traffic-k"
      className="mt-9 border-t border-border-strong pt-[18px] sm:mt-12"
    >
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h2
            id="traffic-k"
            className="font-mono text-[10.5px] font-normal uppercase tracking-[0.12em] text-fg-muted"
          >
            Your traffic
          </h2>
          <p className="mt-1 text-[13px] text-fg">
            {label}
            {compare && <span className="text-fg-muted"> · {compare}</span>}
          </p>
        </div>
        <Segmented
          label="Period"
          value={window}
          options={windowsFor(superadmin)}
          onChange={onWindow}
        />
      </div>

      {loading && !overview ? (
        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3">
          {["v", "c", "r"].map((k) => (
            <div key={k} className="bg-surface px-4 py-3">
              <Skeleton className="mb-2 h-3 w-16" />
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </div>
      ) : !overview ? (
        <p className="mt-4 rounded-md border border-border bg-surface px-4 py-3 text-[13px] text-fg-muted">
          No counts yet. They update every hour.
        </p>
      ) : (
        <Totals overview={overview} report={report} />
      )}
    </section>
  );
}

function Totals({ overview, report }: { overview: AnalyticsOverview; report: LiftReport | null }) {
  const v = overview.hero.total_visits;
  const c = overview.hero.total_conversions;
  const cells: { k: string; v: string; d: string | null }[] = [
    { k: "Visits", v: num(v), d: changeText(overview.delta.vs_previous_period_visits_pct) },
    {
      k: clickedLabel(report),
      v: num(c),
      d: changeText(overview.delta.vs_previous_period_conversions_pct),
    },
    { k: "Click rate", v: rateOf(c, v) || "0%", d: null },
  ];
  return (
    <dl className="mt-4 grid grid-cols-2 overflow-hidden rounded-md border border-border bg-surface sm:grid-cols-3">
      {cells.map((cell, i) => (
        <div
          key={cell.k}
          className={
            i === 0
              ? "flex flex-col gap-0.5 px-3.5 py-2.5 sm:px-4 sm:py-3"
              : i === 1
                ? "flex flex-col gap-0.5 border-l border-border px-3.5 py-2.5 sm:px-4 sm:py-3"
                : "col-span-2 flex flex-col gap-0.5 border-t border-border px-3.5 py-2.5 sm:col-span-1 sm:border-l sm:border-t-0 sm:px-4 sm:py-3"
          }
        >
          <dt className="text-xs font-medium text-fg-muted">{cell.k}</dt>
          <dd className="m-0 flex items-baseline gap-2">
            <span className="font-mono text-lg font-semibold tracking-[-0.01em] tabular-nums text-fg sm:text-xl">
              {cell.v}
            </span>
            {cell.d && (
              <span className="font-mono text-[11.5px] tabular-nums text-fg-muted">{cell.d}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
