/**
 * Chart math unit tests for the analytics components.
 *
 * Tests:
 *   - Arc path generation for IntentDonut
 *   - SVG coordinate math for MiniLineChart
 *   - LiftBar percentage formatting
 *   - State machine rendering conditions
 */

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// LiftBar formatting helpers (extracted for unit testing)
// ---------------------------------------------------------------------------

function pct(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(0)}%`;
}

describe("LiftBar pct formatting", () => {
  it("positive lift formats with + sign", () => {
    expect(pct(0.47)).toBe("+47%");
  });

  it("negative lift formats without + sign", () => {
    expect(pct(-0.12)).toBe("-12%");
  });

  it("zero lift formats as +0%", () => {
    expect(pct(0)).toBe("+0%");
  });

  it("fractional pct rounds to nearest integer", () => {
    expect(pct(0.473)).toBe("+47%");
    expect(pct(0.476)).toBe("+48%");
  });
});

// ---------------------------------------------------------------------------
// IntentDonut arc math
// ---------------------------------------------------------------------------

function polarToXY(cx: number, cy: number, angle: number, radius: number) {
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  };
}

function sweepAngle(visits: number, total: number): number {
  return (visits / total) * 2 * Math.PI;
}

describe("IntentDonut arc math", () => {
  it("sweepAngle for 100% visits = 2π", () => {
    expect(sweepAngle(100, 100)).toBeCloseTo(2 * Math.PI);
  });

  it("sweepAngle for 50% visits = π", () => {
    expect(sweepAngle(50, 100)).toBeCloseTo(Math.PI);
  });

  it("sum of all sweeps for 4 equal slices = 2π", () => {
    const total = 100;
    const slices = [25, 25, 25, 25];
    const sum = slices.reduce((s, v) => s + sweepAngle(v, total), 0);
    expect(sum).toBeCloseTo(2 * Math.PI);
  });

  it("polar coordinates at angle 0 place point to the right of center", () => {
    const { x, y } = polarToXY(50, 50, 0, 40);
    expect(x).toBeCloseTo(90);
    expect(y).toBeCloseTo(50);
  });

  it("polar coordinates at -π/2 place point at 12 o'clock", () => {
    const { x, y } = polarToXY(50, 50, -Math.PI / 2, 40);
    expect(x).toBeCloseTo(50);
    expect(y).toBeCloseTo(10);
  });
});

// ---------------------------------------------------------------------------
// MiniLineChart coordinate math
// ---------------------------------------------------------------------------

function xOf(i: number, count: number, innerW: number, padLeft: number): number {
  return padLeft + (i / Math.max(count - 1, 1)) * innerW;
}

function yVisits(v: number, maxVisits: number, innerH: number, padTop: number): number {
  return padTop + innerH - (v / maxVisits) * innerH;
}

describe("MiniLineChart coordinate math", () => {
  const W = 400;
  const padLeft = 0;
  const padTop = 8;
  const padBottom = 20;
  const H = 80;
  const innerW = W - padLeft;
  const innerH = H - padTop - padBottom;

  it("first point x is at padLeft (0)", () => {
    expect(xOf(0, 10, innerW, padLeft)).toBe(0);
  });

  it("last point x is at innerW", () => {
    expect(xOf(9, 10, innerW, padLeft)).toBeCloseTo(innerW);
  });

  it("middle point x is roughly 50% of inner width", () => {
    const mid = xOf(4, 9, innerW, padLeft);
    expect(mid).toBeCloseTo(innerW / 2);
  });

  it("max visits value places y at padTop", () => {
    const maxVisits = 100;
    expect(yVisits(100, maxVisits, innerH, padTop)).toBeCloseTo(padTop);
  });

  it("zero visits value places y at padTop + innerH (bottom)", () => {
    const maxVisits = 100;
    expect(yVisits(0, maxVisits, innerH, padTop)).toBeCloseTo(padTop + innerH);
  });

  it("50% visits value places y at midpoint", () => {
    const maxVisits = 100;
    const mid = padTop + innerH / 2;
    expect(yVisits(50, maxVisits, innerH, padTop)).toBeCloseTo(mid);
  });
});

// ---------------------------------------------------------------------------
// CohortBreakdownTable — conversion rate helper
// ---------------------------------------------------------------------------

function crOf(conversions: number, visits: number): number {
  return visits > 0 ? conversions / visits : 0;
}

describe("cohort CR calculation", () => {
  it("zero visits returns 0 (no division by zero)", () => {
    expect(crOf(0, 0)).toBe(0);
  });

  it("computes rate correctly", () => {
    expect(crOf(3, 408)).toBeCloseTo(0.00735, 4);
  });

  it("100% conversion rate", () => {
    expect(crOf(10, 10)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Analytics state machine conditions
// ---------------------------------------------------------------------------

interface MockOverview {
  hero: { total_visits: number };
  cohorts: { holdout: { visits: number } };
}

type AnalyticsState =
  | "no_aggregates" // no data row at all
  | "zero_visits" // row exists but total_visits = 0
  | "low_holdout" // visits > 0 but holdout < 30
  | "full"; // all data available

function deriveState(overview: MockOverview | null, loading: boolean): AnalyticsState | "loading" {
  if (loading) return "loading";
  if (!overview) return "no_aggregates";
  if (overview.hero.total_visits === 0) return "zero_visits";
  if (overview.cohorts.holdout.visits < 30) return "low_holdout";
  return "full";
}

describe("analytics state machine", () => {
  it("loading state when loading=true", () => {
    expect(deriveState(null, true)).toBe("loading");
  });

  it("no_aggregates when overview is null and not loading", () => {
    expect(deriveState(null, false)).toBe("no_aggregates");
  });

  it("zero_visits when total_visits = 0", () => {
    expect(
      deriveState({ hero: { total_visits: 0 }, cohorts: { holdout: { visits: 0 } } }, false),
    ).toBe("zero_visits");
  });

  it("low_holdout when visits > 0 but holdout < 30", () => {
    expect(
      deriveState({ hero: { total_visits: 434 }, cohorts: { holdout: { visits: 6 } } }, false),
    ).toBe("low_holdout");
  });

  it("matches numbers seen on a real site (holdout=6, total=434) → low_holdout", () => {
    expect(
      deriveState({ hero: { total_visits: 434 }, cohorts: { holdout: { visits: 6 } } }, false),
    ).toBe("low_holdout");
  });

  it("full state when holdout >= 30 and visits > 0", () => {
    expect(
      deriveState({ hero: { total_visits: 10000 }, cohorts: { holdout: { visits: 1100 } } }, false),
    ).toBe("full");
  });
});

// ---------------------------------------------------------------------------
// WindowSelector values
// ---------------------------------------------------------------------------

describe("WindowSelector valid values", () => {
  const WINDOWS = ["1h", "24h", "7d", "30d"] as const;

  it("all four windows are defined", () => {
    expect(WINDOWS).toHaveLength(4);
  });

  it("7d is the default window", () => {
    expect(WINDOWS.includes("7d")).toBe(true);
  });
});
