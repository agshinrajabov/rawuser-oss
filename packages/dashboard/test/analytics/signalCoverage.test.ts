/**
 * Unit tests for the Signal Coverage math (computeCoverage).
 *
 * Coverage = addressable / total, where addressable = personalized + holdout +
 * skipped (all had a meaningful signal) and no_signal is the untagged remainder.
 * Derived purely from the existing AnalyticsOverview cohorts (no backend change).
 */

import { describe, expect, it } from "vitest";
import { computeCoverage } from "../../src/components/analytics/SignalCoverageCard";
import type { AnalyticsOverview } from "../../src/types/api";

function overview(cohorts: {
  personalized: number;
  holdout: number;
  no_signal: number;
  skipped?: number;
}): AnalyticsOverview {
  const mk = (visits: number) => ({ visits, conversions: 0, cr: 0 });
  return {
    customer_id: "demo",
    window: "7d",
    computed_at: 0,
    cohorts: {
      personalized: mk(cohorts.personalized),
      holdout: mk(cohorts.holdout),
      no_signal: mk(cohorts.no_signal),
      ...(cohorts.skipped !== undefined ? { skipped: mk(cohorts.skipped) } : {}),
    },
    hero: {
      holdout_lift: { value: null, ci_lower: null, ci_upper: null, significance: "not_yet" },
      natural_lift: { value: null, ci_lower: null, ci_upper: null, significance: "not_yet" },
      total_visits: 0,
      total_conversions: 0,
    },
    delta: { vs_previous_period_visits_pct: null, vs_previous_period_conversions_pct: null },
  };
}

describe("computeCoverage", () => {
  it("counts personalized + holdout + skipped as addressable", () => {
    const r = computeCoverage(
      overview({ personalized: 60, holdout: 10, skipped: 10, no_signal: 20 }),
    );
    expect(r.addressable).toBe(80);
    expect(r.noSignal).toBe(20);
    expect(r.total).toBe(100);
    expect(r.coveragePct).toBe(80);
    expect(r.noSignalPct).toBe(20);
  });

  it("handles a missing skipped cohort (optional field)", () => {
    const r = computeCoverage(overview({ personalized: 30, holdout: 5, no_signal: 15 }));
    expect(r.addressable).toBe(35);
    expect(r.total).toBe(50);
    expect(r.coveragePct).toBe(70);
  });

  it("returns 0% (not NaN) when there is no traffic", () => {
    const r = computeCoverage(overview({ personalized: 0, holdout: 0, no_signal: 0 }));
    expect(r.total).toBe(0);
    expect(r.coveragePct).toBe(0);
    expect(r.noSignalPct).toBe(0);
  });

  it("100% coverage when nothing is no-signal", () => {
    const r = computeCoverage(overview({ personalized: 40, holdout: 5, skipped: 5, no_signal: 0 }));
    expect(r.coveragePct).toBe(100);
    expect(r.noSignalPct).toBe(0);
  });
});

describe("computeCoverage — dark social share of the untagged bucket (L2 Layer D)", () => {
  it("reports the flagged share when the API carries it", () => {
    const o = overview({ personalized: 50, holdout: 5, no_signal: 40 });
    o.cohorts.no_signal.dark_social_probable = 10;
    const r = computeCoverage(o);
    expect(r.darkSocial).toBe(10);
    expect(r.darkSocialPct).toBe(25);
  });

  it("is zero when the field is absent (aggregates from before the column)", () => {
    const r = computeCoverage(overview({ personalized: 50, holdout: 5, no_signal: 40 }));
    expect(r.darkSocial).toBe(0);
    expect(r.darkSocialPct).toBe(0);
  });

  it("never exceeds the untagged count", () => {
    const o = overview({ personalized: 0, holdout: 0, no_signal: 4 });
    o.cohorts.no_signal.dark_social_probable = 9;
    expect(computeCoverage(o).darkSocial).toBe(4);
  });
});

describe("computeCoverage — language mismatch (three-decisions §1)", () => {
  it("passes the count through, capped at the untagged total", () => {
    const o = overview({ personalized: 10, holdout: 1, no_signal: 20 });
    o.cohorts.no_signal.language_mismatch = 7;
    expect(computeCoverage(o).languageMismatch).toBe(7);
    o.cohorts.no_signal.language_mismatch = 99;
    expect(computeCoverage(o).languageMismatch).toBe(20);
  });
});
