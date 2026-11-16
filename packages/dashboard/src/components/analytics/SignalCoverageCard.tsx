"use client";

import { Skeleton } from "@/components/ui/Skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/Tooltip";
import type { AnalyticsOverview } from "@/types/api";
import Link from "next/link";

interface SignalCoverageCardProps {
  overview: AnalyticsOverview | null;
  loading: boolean;
  customerId: string;
}

/**
 * Signal coverage = the share of visits Rawuser could act on (had a reason to
 * personalize). Answers the #1 sales objection: "does half my traffic just see
 * the original?" Coverage is the addressable slice; no-signal is the rest.
 *
 * Derived entirely client-side from the existing AnalyticsOverview cohorts —
 * no backend change:
 *   addressable = personalized + holdout + skipped   (all had a meaningful signal)
 *   no_signal   = the untagged remainder
 *   coverage    = addressable / total
 *
 * The entry-path signal (L1, ADR 0023) raises this number by making
 * intent-bearing direct visits (e.g. /pricing) addressable. The hint steers
 * the operator to the campaign-link generator to raise it further.
 */
export function computeCoverage(overview: AnalyticsOverview): {
  total: number;
  addressable: number;
  noSignal: number;
  coveragePct: number;
  noSignalPct: number;
  /** Untagged visits that look like an app hid the referrer (L2 Layer D). */
  darkSocial: number;
  /** Share of the untagged bucket that is probable dark social, 0-100. */
  darkSocialPct: number;
  /** Untagged visits on pages in another language than the versions. */
  languageMismatch: number;
} {
  const c = overview.cohorts;
  const addressable = c.personalized.visits + c.holdout.visits + (c.skipped?.visits ?? 0);
  const noSignal = c.no_signal.visits;
  const total = addressable + noSignal;
  const coveragePct = total === 0 ? 0 : (addressable / total) * 100;
  const noSignalPct = total === 0 ? 0 : (noSignal / total) * 100;
  const darkSocial = Math.min(c.no_signal.dark_social_probable ?? 0, noSignal);
  const darkSocialPct = noSignal === 0 ? 0 : (darkSocial / noSignal) * 100;
  const languageMismatch = Math.min(c.no_signal.language_mismatch ?? 0, noSignal);
  return {
    total,
    addressable,
    noSignal,
    coveragePct,
    noSignalPct,
    darkSocial,
    darkSocialPct,
    languageMismatch,
  };
}

export function SignalCoverageCard({ overview, loading, customerId }: SignalCoverageCardProps) {
  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-md p-4 min-h-[110px]">
        <Skeleton className="h-3 w-28 mb-3" />
        <Skeleton className="h-8 w-16 mb-2" />
        <Skeleton className="h-2 w-full" />
      </div>
    );
  }

  if (!overview) return null;

  const {
    total,
    addressable,
    noSignal,
    coveragePct,
    noSignalPct,
    darkSocial,
    darkSocialPct,
    languageMismatch,
  } = computeCoverage(overview);
  const linksHref = `/links?customer_id=${encodeURIComponent(customerId)}`;

  return (
    <TooltipProvider>
      <div className="bg-surface border border-border rounded-md p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-fg-muted font-medium">Signal coverage</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-fg-faint cursor-default">what's this?</span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[260px] text-center">
              Share of visits with a reason to personalize (UTM, referrer, AI source, or an
              intent-bearing entry path like /pricing). The rest see your original page by design.
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold text-fg mono-num">
            {total === 0 ? "-" : `${coveragePct.toFixed(0)}%`}
          </span>
          {total > 0 && (
            <span className="text-xs text-fg-faint mono-num">
              {addressable.toLocaleString()} / {total.toLocaleString()} visits
            </span>
          )}
        </div>

        {/* Coverage bar: addressable vs no-signal */}
        <div className="h-2 w-full rounded-pill overflow-hidden bg-surface-muted flex">
          <div
            className="h-full"
            style={{ width: `${coveragePct}%`, background: "var(--fg)" }}
            aria-hidden
          />
        </div>

        <div className="text-xs text-fg-faint mt-auto">
          {total === 0 ? (
            "No traffic in window yet."
          ) : (
            <>
              {noSignalPct.toFixed(0)}% untagged ({noSignal.toLocaleString()}
              {darkSocial > 0
                ? `, of which ${darkSocialPct.toFixed(0)}% look like an app that hid the referrer`
                : ""}
              {languageMismatch > 0
                ? `, ${languageMismatch.toLocaleString()} on pages in another language than your versions`
                : ""}
              ).{" "}
              <Link
                href={linksHref}
                className="text-fg underline underline-offset-2 hover:no-underline"
              >
                Tag campaign links
              </Link>{" "}
              to raise coverage.
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
