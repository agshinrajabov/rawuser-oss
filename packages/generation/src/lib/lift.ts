/**
 * Wilson-score lift computation.
 *
 * Computes a causal lift estimate (personalized CR / baseline CR - 1) with a
 * 95% confidence interval derived from the Wilson score interval on each
 * proportion separately, combined via the delta method (log-ratio CI).
 *
 * References:
 *   Wilson, E. B. (1927). Probable inference, the law of succession, and
 *   statistical inference. JASA 22(158), 209-212.
 *
 * Privacy invariant: operates only on aggregate counts (visits, conversions).
 * No visitor identifiers or raw events are touched.
 *
 * Used by: analytics-aggregator.ts (offline cron — never in visitor path).
 */

import { MIN_CONVERSIONS } from "@rawuser/shared";

/** Minimum visits per cohort before we report any lift number. */
export const MIN_SAMPLE = 30;

/**
 * Converting visits each arm needs before any interval is shown
 * (docs/specs/proof-engine.md, D): at a 3% rate, 30 visits is about one
 * conversion, and an interval on one conversion is noise with a number on it.
 */
export { MIN_CONVERSIONS };

/**
 * z-scores for significance thresholds (two-tailed).
 *   90% → z = 1.645
 *   95% → z = 1.960
 *   99% → z = 2.576
 */
const Z_90 = 1.645;
const Z_95 = 1.96;
const Z_99 = 2.576;

/** z = 1.96 for the Wilson 95% CI interval formula. */
const WILSON_Z = Z_95;

export type Significance = "not_yet" | "sig_90" | "sig_95" | "sig_99";

export interface LiftResult {
  /** (personalizedCR / baselineCR) - 1; null if either cohort < MIN_SAMPLE. */
  lift: number | null;
  /** Wilson 95% CI lower bound on the lift ratio (i.e. lower bound of pCR/bCR - 1). */
  ci_lower: number | null;
  /** Wilson 95% CI upper bound on the lift ratio. */
  ci_upper: number | null;
  /**
   * Two-proportion z-test result:
   *   not_yet  → |z| < 1.645 OR either cohort < MIN_SAMPLE
   *   sig_90   → 1.645 ≤ |z| < 1.96
   *   sig_95   → 1.96  ≤ |z| < 2.576
   *   sig_99   → |z| ≥ 2.576
   */
  significance: Significance;
}

// ---------------------------------------------------------------------------
// Wilson score interval for a single proportion
// ---------------------------------------------------------------------------

/**
 * Returns the Wilson 95% CI for a proportion p = k/n.
 * Returns [0, 0] when n = 0 (degenerate case — caller must handle).
 *
 * Formula:
 *   center = (k + z²/2) / (n + z²)
 *   margin = (z / (n + z²)) * sqrt(k(n-k)/n + z²/4)
 *   [center - margin, center + margin]
 */
export function wilsonCI(k: number, n: number): [lower: number, upper: number] {
  if (n === 0) return [0, 0];
  const z2 = WILSON_Z * WILSON_Z;
  const center = (k + z2 / 2) / (n + z2);
  const margin = (WILSON_Z / (n + z2)) * Math.sqrt((k * (n - k)) / n + z2 / 4);
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// ---------------------------------------------------------------------------
// Two-proportion z-test (unpooled — standard for lift significance testing)
// ---------------------------------------------------------------------------

/**
 * Returns the z-statistic for the difference of two proportions.
 * Uses unpooled standard error (appropriate when testing ratio, not just difference).
 *
 * z = (p1 - p2) / sqrt(p1(1-p1)/n1 + p2(1-p2)/n2)
 *
 * Returns 0 when either n is 0 or the denominator is 0 (degenerate).
 */
function twoProportionZ(k1: number, n1: number, k2: number, n2: number): number {
  if (n1 === 0 || n2 === 0) return 0;
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  if (se === 0) return 0;
  return (p1 - p2) / se;
}

// ---------------------------------------------------------------------------
// Log-ratio CI via the delta method
// ---------------------------------------------------------------------------

/**
 * Given Wilson CIs for each proportion, build a CI for the ratio p1/p2 - 1
 * using the delta method applied to log(p1/p2).
 *
 * Approach:
 *   1. Wilson CIs give us point estimate + approximate std-error for each rate.
 *   2. Map to log space: log(p1) - log(p2).
 *   3. Std-err in log space ≈ sqrt((seP1/p1)² + (seP2/p2)²) where
 *      seP ≈ (upper - lower) / (2 * 1.96) (half-width → SE).
 *   4. CI on log ratio: [logRatio ± z_95 * se_log].
 *   5. Exponentiate → CI on ratio → subtract 1 → CI on lift.
 *
 * Falls back to a simpler pessimistic CI if any proportion is 0.
 */
function liftCI(
  p1: number,
  p1Lower: number,
  p1Upper: number,
  p2: number,
  p2Lower: number,
  p2Upper: number,
): [liftLower: number, liftUpper: number] {
  // Guard: if either point is 0 we can't take a log.
  if (p1 === 0 || p2 === 0) {
    // Degenerate — just map the Wilson CI endpoints directly.
    const ratioLower = p1Lower / (p2Upper > 0 ? p2Upper : 1);
    const ratioUpper = p2Lower > 0 ? p1Upper / p2Lower : p1Upper / 0.001;
    return [ratioLower - 1, ratioUpper - 1];
  }

  const logRatio = Math.log(p1) - Math.log(p2);
  // Half-width of Wilson CI → approximate SE (Wilson CI ≈ ±1.96·SE).
  const seP1 = (p1Upper - p1Lower) / (2 * WILSON_Z);
  const seP2 = (p2Upper - p2Lower) / (2 * WILSON_Z);
  const seLog = Math.sqrt((seP1 / p1) ** 2 + (seP2 / p2) ** 2);

  const logLower = logRatio - WILSON_Z * seLog;
  const logUpper = logRatio + WILSON_Z * seLog;

  return [Math.exp(logLower) - 1, Math.exp(logUpper) - 1];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute lift of the personalized cohort vs the baseline cohort.
 *
 * @param personalizedVisits      - visits in the personalized arm
 * @param personalizedConversions - conversions in the personalized arm
 * @param baselineVisits          - visits in the baseline arm (holdout or no_signal)
 * @param baselineConversions     - conversions in the baseline arm
 *
 * Returns all-nulls + significance="not_yet" when:
 *   - either cohort has fewer than MIN_SAMPLE visits, OR
 *   - baselineCR === 0 (undefined ratio)
 */
export function computeLift(
  personalizedVisits: number,
  personalizedConversions: number,
  baselineVisits: number,
  baselineConversions: number,
): LiftResult {
  const nullResult: LiftResult = {
    lift: null,
    ci_lower: null,
    ci_upper: null,
    significance: "not_yet",
  };

  // Insufficient sample in either arm.
  if (personalizedVisits < MIN_SAMPLE || baselineVisits < MIN_SAMPLE) {
    return nullResult;
  }

  const pCR = personalizedConversions / personalizedVisits;
  const bCR = baselineConversions / baselineVisits;

  // Undefined ratio — baseline has no conversions.
  if (bCR === 0) {
    // If personalized also has 0, lift = 0 and is technically defined (0/0 → 0),
    // but signal quality is extremely low. Return nullResult for safety.
    return nullResult;
  }

  const lift = pCR / bCR - 1;

  // Wilson CIs for each proportion.
  const [p1Lower, p1Upper] = wilsonCI(personalizedConversions, personalizedVisits);
  const [p2Lower, p2Upper] = wilsonCI(baselineConversions, baselineVisits);

  // Lift CI via delta method.
  const [ci_lower, ci_upper] = liftCI(pCR, p1Lower, p1Upper, bCR, p2Lower, p2Upper);

  // Two-proportion z-test for significance.
  const z = twoProportionZ(
    personalizedConversions,
    personalizedVisits,
    baselineConversions,
    baselineVisits,
  );
  const absZ = Math.abs(z);

  let significance: Significance;
  if (absZ >= Z_99) {
    significance = "sig_99";
  } else if (absZ >= Z_95) {
    significance = "sig_95";
  } else if (absZ >= Z_90) {
    significance = "sig_90";
  } else {
    significance = "not_yet";
  }

  return { lift, ci_lower, ci_upper, significance };
}

// ---------------------------------------------------------------------------
// The proof engine's additions (docs/specs/proof-engine.md, D). computeLift
// above is unchanged; the floor of converting visits sits in the wrapper.
// ---------------------------------------------------------------------------

/**
 * computeLift with the MIN_CONVERSIONS floor: all-nulls until each arm has
 * 10 converting visits as well as 30 visits. The aggregator (rolling and
 * aggregateWindowAt alike) and the lift report use this one.
 */
export function computeGatedLift(
  personalizedVisits: number,
  personalizedConversions: number,
  baselineVisits: number,
  baselineConversions: number,
): LiftResult {
  if (personalizedConversions < MIN_CONVERSIONS || baselineConversions < MIN_CONVERSIONS) {
    return { lift: null, ci_lower: null, ci_upper: null, significance: "not_yet" };
  }
  return computeLift(
    personalizedVisits,
    personalizedConversions,
    baselineVisits,
    baselineConversions,
  );
}

/**
 * The difference of two rates, p1 - p2, with Newcombe's hybrid score
 * interval (method 10, Newcombe 1998), built from the two Wilson intervals.
 * Null when either n is 0. Worked value: 56/70 against 48/80 gives 0.2000,
 * 0.0524 to 0.3339.
 */
export function newcombeDiff(
  k1: number,
  n1: number,
  k2: number,
  n2: number,
): { diff: number; low: number; high: number } | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const [l1, u1] = wilsonCI(k1, n1);
  const [l2, u2] = wilsonCI(k2, n2);
  const diff = p1 - p2;
  return {
    diff,
    low: diff - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2),
    high: diff + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2),
  };
}

/** Weeks in a 30.4-day month. */
export const WEEKS_PER_MONTH = 365.25 / 12 / 7;

/** The relative lift a test is sized for: 20%. */
export const TARGET_LIFT = 0.2;

/**
 * Eligible visits in all a test needs to read a relative lift `rel` at base
 * rate `p` with holdout share `h`, 95% confidence and 80% power: Kohavi's
 * 16·p(1-p)/Δ² per arm for equal arms, generalised to unequal arms as
 * 8·p(1-p)/(Δ²·h·(1-h)), Δ = rel·p. Reproduces the spec's tables
 * (3%, 20% holdout: 40,417).
 */
export function sampleSizeTotal(p: number, h: number, rel = TARGET_LIFT): number | null {
  if (!(p > 0 && p < 1) || !(h > 0 && h < 1) || !(rel > 0)) return null;
  const delta = rel * p;
  return Math.ceil((8 * p * (1 - p)) / (delta * delta * h * (1 - h)));
}

/** Weeks to read `rel` at `eligiblePerMonth` visits with a signal and a version. */
export function weeksToRead(
  p: number,
  h: number,
  eligiblePerMonth: number,
  rel = TARGET_LIFT,
): number | null {
  const n = sampleSizeTotal(p, h, rel);
  if (n === null || !(eligiblePerMonth > 0)) return null;
  return (n / eligiblePerMonth) * WEEKS_PER_MONTH;
}

/** The smallest relative lift `eligibleVisits` can tell from none at `p` and `h`. */
export function readableLift(p: number, h: number, eligibleVisits: number): number | null {
  if (!(p > 0 && p < 1) || !(h > 0 && h < 1) || !(eligibleVisits > 0)) return null;
  const delta = Math.sqrt((8 * p * (1 - p)) / (eligibleVisits * h * (1 - h)));
  return delta / p;
}

/** Complementary error function (Numerical Recipes erfcc, relative error under 1.2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/**
 * The split check (Kohavi, Tang and Xu, ch. 21): `holdout` of `total` armed
 * visits against the set share `h`, chi-square with one degree of freedom.
 * Null below 5 expected visits in an arm, where the test does not hold.
 */
export function splitCheck(
  holdout: number,
  total: number,
  h: number,
): { seen: number; chi2: number; p: number } | null {
  if (!(total > 0) || !(h > 0 && h < 1)) return null;
  const e1 = total * h;
  const e2 = total * (1 - h);
  if (e1 < 5 || e2 < 5) return null;
  const chi2 = (holdout - e1) ** 2 / e1 + (total - holdout - e2) ** 2 / e2;
  return { seen: holdout / total, chi2, p: erfc(Math.sqrt(chi2 / 2)) };
}

/** Below this p the split looks off and the result is held back. */
export const SPLIT_P_THRESHOLD = 0.001;
