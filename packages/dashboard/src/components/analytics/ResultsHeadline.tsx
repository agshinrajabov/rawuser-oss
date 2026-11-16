"use client";

import { Skeleton } from "@/components/ui/Skeleton";
import { headlineFor, testPeriodLine } from "@/lib/results";
import { cn } from "@/lib/utils";
import type { LiftReport } from "@/types/api";
import { Clock } from "lucide-react";

/**
 * "Is it working?" (results-page mock, sections 01 and 02): one short
 * answer built from the card's own numbers, grey until the read date, ink
 * on it, never green. With no test yet it is the title over the three steps
 * ("Measure what Rawuser brings.", measure-setup mock). The test's own
 * period sits under it, so the period switch further down is never read as
 * changing it.
 */
export function ResultsHeadline({
  report,
  loading,
  small = false,
}: {
  report: LiftReport | null;
  loading: boolean;
  /** The one line under "Who comes" when traffic is too little (mock 06 D). */
  small?: boolean;
}) {
  if (loading && !report) {
    return (
      <div className="mt-3 space-y-2" aria-hidden>
        <Skeleton className="h-7 w-full max-w-[560px]" />
        <Skeleton className="h-3 w-48" />
      </div>
    );
  }
  if (!report) return null;
  const h = headlineFor(report);
  const period = small ? null : testPeriodLine(report);
  return (
    <>
      <p
        className={cn(
          "mt-3 max-w-[30em] text-balance font-medium leading-[1.32] tracking-[-0.018em]",
          small
            ? "text-[19px] sm:text-[21px]"
            : "text-[21px] sm:text-[27px] sm:leading-[1.28] sm:tracking-[-0.022em]",
        )}
        data-final={h.final ? "true" : "false"}
      >
        <span className={cn(h.final || h.title ? "text-fg" : "text-[#52525b]")}>{h.lead}</span>
        {h.tail && <span className="font-normal text-fg-muted"> {h.tail}</span>}
      </p>
      {period && (
        <p className="mt-2.5 flex items-center gap-1.5 font-mono text-[11.5px] text-fg-muted">
          <Clock size={13} className="shrink-0 text-fg-faint" aria-hidden />
          {period}
        </p>
      )}
    </>
  );
}
