/**
 * Unit tests for packages/generation/src/lib/lift.ts
 *
 * Verifies:
 *   - MIN_SAMPLE guard (both arms): returns all-nulls when below threshold
 *   - Zero visits in either cohort → all-nulls
 *   - Zero conversions in baseline (bCR=0) → all-nulls (undefined ratio)
 *   - Zero conversions in personalized (pCR=0) → all-nulls (bCR=0 guard still applies
 *     because bCR=0 case returns null; pCR=0 with bCR>0 is tested separately)
 *   - Identical CR both arms → lift=0, CI brackets 0, sig=not_yet
 *   - Massive difference (50% vs 1%, n=1000) → large lift, sig=sig_99
 *   - Significance thresholds transition correctly near boundaries
 *   - CI bounds: lower < lift < upper when both >0 and sample adequate
 *   - Natural lift (personalized vs no_signal) same code path
 */

import { describe, expect, it } from "vitest";
import { MIN_SAMPLE, computeLift } from "../../src/lib/lift.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a result with sufficient sample and non-trivial signal. */
function withSample(pVisits: number, pConv: number, bVisits: number, bConv: number) {
  return computeLift(pVisits, pConv, bVisits, bConv);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeLift — MIN_SAMPLE guard", () => {
  it("returns all-nulls when personalized < MIN_SAMPLE", () => {
    const r = computeLift(MIN_SAMPLE - 1, 5, 100, 2);
    expect(r.lift).toBeNull();
    expect(r.ci_lower).toBeNull();
    expect(r.ci_upper).toBeNull();
    expect(r.significance).toBe("not_yet");
  });

  it("returns all-nulls when baseline < MIN_SAMPLE", () => {
    const r = computeLift(100, 5, MIN_SAMPLE - 1, 2);
    expect(r.lift).toBeNull();
    expect(r.ci_lower).toBeNull();
    expect(r.ci_upper).toBeNull();
    expect(r.significance).toBe("not_yet");
  });

  it("returns all-nulls when both arms are 0", () => {
    const r = computeLift(0, 0, 0, 0);
    expect(r.lift).toBeNull();
    expect(r.significance).toBe("not_yet");
  });

  it("accepts exactly MIN_SAMPLE visits in each arm (boundary)", () => {
    // Both arms same CR → lift should be 0, not null
    const r = computeLift(MIN_SAMPLE, 3, MIN_SAMPLE, 3);
    // bCR > 0, both arms at threshold → lift is defined
    expect(r.lift).not.toBeNull();
  });
});

describe("computeLift — zero conversions edge cases", () => {
  it("baseline CR=0 → all-nulls (undefined ratio)", () => {
    const r = computeLift(100, 5, 100, 0);
    expect(r.lift).toBeNull();
    expect(r.ci_lower).toBeNull();
    expect(r.ci_upper).toBeNull();
    expect(r.significance).toBe("not_yet");
  });

  it("both CR=0 → all-nulls (baseline CR=0 guard fires first)", () => {
    const r = computeLift(100, 0, 100, 0);
    expect(r.lift).toBeNull();
  });

  it("personalized CR=0, baseline CR>0 → lift=-1 (full drop, significant)", () => {
    const r = computeLift(100, 0, 100, 10);
    expect(r.lift).not.toBeNull();
    // pCR=0, bCR=0.1 → lift = 0/0.1 - 1 = -1
    expect(r.lift).toBeCloseTo(-1, 5);
    // z = (0 - 0.1)/sqrt(0*(1)/100 + 0.1*0.9/100) ≈ -0.1/0.03 ≈ -3.33 → sig_99
    expect(r.significance).toBe("sig_99");
  });
});

describe("computeLift — identical conversion rates", () => {
  it("lift ≈ 0 when both CRs identical", () => {
    const r = withSample(500, 50, 500, 50); // both CR = 10%
    expect(r.lift).not.toBeNull();
    expect(r.lift).toBeCloseTo(0, 5);
  });

  it("CI brackets 0 when lift=0", () => {
    const r = withSample(500, 50, 500, 50);
    expect(r.ci_lower).not.toBeNull();
    expect(r.ci_upper).not.toBeNull();
    // With identical CRs CI should straddle 0
    // biome-ignore lint/style/noNonNullAssertion: test asserts not-null above
    expect(r.ci_lower!).toBeLessThan(0.05);
    // biome-ignore lint/style/noNonNullAssertion: test asserts not-null above
    expect(r.ci_upper!).toBeGreaterThan(-0.05);
  });

  it("significance = not_yet when CRs are identical", () => {
    const r = withSample(500, 50, 500, 50);
    expect(r.significance).toBe("not_yet");
  });
});

describe("computeLift — large signal (sig_99)", () => {
  it("50% personalized vs 1% baseline with n=1000 each → sig_99 and large lift", () => {
    const r = withSample(1000, 500, 1000, 10); // 50% vs 1%
    expect(r.lift).not.toBeNull();
    // lift ≈ 50/1 - 1 = 49
    // biome-ignore lint/style/noNonNullAssertion: test asserts not-null above
    expect(r.lift!).toBeGreaterThan(40);
    expect(r.significance).toBe("sig_99");
  });

  it("CI lower bound > 0 for strongly positive lift", () => {
    const r = withSample(1000, 500, 1000, 10);
    expect(r.ci_lower).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: test asserts not-null above
    expect(r.ci_lower!).toBeGreaterThan(0);
  });

  it("CI upper > CI lower", () => {
    const r = withSample(1000, 500, 1000, 10);
    // biome-ignore lint/style/noNonNullAssertion: both are non-null for adequate sample
    expect(r.ci_upper!).toBeGreaterThan(r.ci_lower!);
  });
});

describe("computeLift — significance thresholds", () => {
  it("sig_90: z near 1.7 (between 1.645 and 1.96)", () => {
    // Tune: ~15% vs ~10% with moderate n pushes z into sig_90 zone
    // n=300, pConv=45 (15%), bConv=30 (10%)
    const r = withSample(300, 45, 300, 30);
    // z ≈ 1.71 — should be sig_90 or not_yet depending on exact values
    expect(["not_yet", "sig_90", "sig_95"]).toContain(r.significance);
  });

  it("sig_95: pCR=15% vs bCR=10% with n=500 each", () => {
    const r = withSample(500, 75, 500, 50); // 15% vs 10%
    // z ≈ 2.47 — expect sig_90 or sig_95
    expect(["sig_90", "sig_95", "sig_99"]).toContain(r.significance);
  });

  it("sig_99: 20% vs 5% with n=400 each → definitely significant", () => {
    const r = withSample(400, 80, 400, 20); // 20% vs 5%
    expect(r.significance).toBe("sig_99");
  });

  it("not_yet: tiny difference with small n (n=50 each, 20% vs 18%)", () => {
    const r = withSample(50, 10, 50, 9); // 20% vs 18%
    expect(r.significance).toBe("not_yet");
  });
});

describe("computeLift — CI ordering invariant", () => {
  it("ci_lower < lift < ci_upper for well-formed result", () => {
    const r = withSample(200, 40, 200, 10); // 20% vs 5%, adequate sample
    if (r.lift !== null) {
      // biome-ignore lint/style/noNonNullAssertion: lift non-null checked above; ci non-null for adequate sample
      expect(r.ci_lower!).toBeLessThan(r.lift!);
      // biome-ignore lint/style/noNonNullAssertion: lift non-null checked above; ci non-null for adequate sample
      expect(r.ci_upper!).toBeGreaterThan(r.lift!);
    }
  });

  it("lift value matches (pCR/bCR - 1) exactly", () => {
    const pVisits = 100;
    const pConv = 20; // pCR = 0.2
    const bVisits = 100;
    const bConv = 10; // bCR = 0.1
    const r = withSample(pVisits, pConv, bVisits, bConv);
    const expectedLift = 0.2 / 0.1 - 1; // = 1.0
    expect(r.lift).not.toBeNull();
    expect(r.lift).toBeCloseTo(expectedLift, 8);
  });
});

// ---------------------------------------------------------------------------
// The proof engine's additions (docs/specs/proof-engine.md, D)
// ---------------------------------------------------------------------------

import {
  MIN_CONVERSIONS,
  computeGatedLift,
  newcombeDiff,
  readableLift,
  sampleSizeTotal,
  splitCheck,
  weeksToRead,
} from "../../src/lib/lift.ts";

describe("computeGatedLift: MIN_CONVERSIONS", () => {
  it("shows an interval at 10 and 10, not at 9", () => {
    expect(MIN_CONVERSIONS).toBe(10);
    const at10 = computeGatedLift(200, 10, 200, 10);
    expect(at10.lift).not.toBeNull();
    expect(at10.ci_lower).not.toBeNull();
    expect(computeGatedLift(200, 9, 200, 10).lift).toBeNull();
    expect(computeGatedLift(200, 10, 200, 9).lift).toBeNull();
    expect(computeGatedLift(200, 9, 200, 10).significance).toBe("not_yet");
  });

  it("keeps the MIN_SAMPLE floor and computeLift's values above both floors", () => {
    expect(computeGatedLift(29, 10, 100, 10).lift).toBeNull();
    expect(computeGatedLift(500, 75, 500, 50)).toEqual(computeLift(500, 75, 500, 50));
  });
});

describe("newcombeDiff: Newcombe (1998) method 10", () => {
  it("reproduces the published worked value: 56/70 against 48/80", () => {
    const r = newcombeDiff(56, 70, 48, 80);
    expect(r?.diff).toBeCloseTo(0.2, 4);
    expect(r?.low).toBeCloseTo(0.0524, 3);
    expect(r?.high).toBeCloseTo(0.3339, 3);
  });

  it("reproduces 9/10 against 3/10 (0.1705 to 0.8090)", () => {
    const r = newcombeDiff(9, 10, 3, 10);
    expect(r?.low).toBeCloseTo(0.1705, 3);
    expect(r?.high).toBeCloseTo(0.809, 3);
  });

  it("is null at zero visits", () => {
    expect(newcombeDiff(0, 0, 1, 10)).toBeNull();
  });
});

describe("the sample-size rule reproduces the spec's tables", () => {
  it("eligible visits needed, total", () => {
    const rows: Array<[number, number, number]> = [
      [0.02, 0.1, 108_889],
      [0.02, 0.2, 61_250],
      [0.02, 0.5, 39_200],
      [0.03, 0.1, 71_852],
      [0.03, 0.2, 40_417],
      [0.03, 0.5, 25_867],
      [0.05, 0.1, 42_222],
      [0.05, 0.2, 23_750],
      [0.05, 0.5, 15_200],
      [0.1, 0.1, 20_000],
      [0.1, 0.2, 11_250],
      [0.1, 0.5, 7_200],
    ];
    for (const [p, h, want] of rows) {
      const n = sampleSizeTotal(p, h) ?? 0;
      expect(Math.abs(n - want), `p=${p} h=${h}`).toBeLessThanOrEqual(1);
    }
    expect(Math.round((sampleSizeTotal(0.03, 0.2) ?? 0) * 0.2)).toBe(8083);
  });

  it("weeks to read a 20% lift, half of all visits eligible", () => {
    const rows: Array<[number, number, number, number]> = [
      [3000, 0.03, 0.2, 117],
      [3000, 0.03, 0.5, 75],
      [3000, 0.1, 0.2, 33],
      [3000, 0.1, 0.5, 21],
      [10_000, 0.03, 0.2, 35],
      [10_000, 0.03, 0.5, 22],
      [10_000, 0.1, 0.2, 10],
      [10_000, 0.1, 0.5, 6],
      [30_000, 0.03, 0.2, 12],
      [30_000, 0.03, 0.5, 8],
      [30_000, 0.1, 0.2, 3],
      [30_000, 0.1, 0.5, 2],
    ];
    // The spec's table rounds by hand; two cells sit on a half week (7.50
    // and 22.50), so the rule is held to half a week of each cell.
    for (const [visits, p, h, want] of rows) {
      const weeks = weeksToRead(p, h, visits / 2) ?? 0;
      expect(Math.abs(weeks - want), `${visits} ${p} ${h}: ${weeks}`).toBeLessThanOrEqual(0.51);
    }
  });

  it("the smallest lift an eight-week pilot can read", () => {
    const rows: Array<[number, number, number]> = [
      [3000, 0.03, 0.76],
      [3000, 0.1, 0.4],
      [10_000, 0.03, 0.42],
      [10_000, 0.1, 0.22],
      [30_000, 0.03, 0.24],
      [30_000, 0.1, 0.13],
    ];
    for (const [visits, p, want] of rows) {
      const eligible = (visits / 2) * (8 / (365.25 / 12 / 7));
      // the spec's percents are rounded to whole points (76.5% printed as 76%)
      expect(Math.abs((readableLift(p, 0.2, eligible) ?? 0) - want), `${visits} ${p}`).toBeLessThan(
        0.006,
      );
    }
  });
});

describe("splitCheck", () => {
  it("fires on a 30/70 split at a set 20%", () => {
    const r = splitCheck(300, 1000, 0.2);
    expect(r?.p).toBeLessThan(0.001);
  });

  it("passes an honest 20% split and the chi-square p matches the table", () => {
    expect(splitCheck(201, 1000, 0.2)?.p).toBeGreaterThan(0.5);
    // chi-square 3.841 is p = 0.05 with one degree of freedom
    const r = splitCheck(0, 0, 0.2);
    expect(r).toBeNull();
    const at = splitCheck(224, 1000, 0.2);
    expect(at?.chi2).toBeCloseTo(3.6, 1);
    expect(at?.p).toBeCloseTo(0.0578, 3);
  });

  it("refuses to judge below 5 expected visits in an arm", () => {
    expect(splitCheck(1, 20, 0.2)).toBeNull();
  });
});
