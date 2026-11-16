/**
 * V1 variant selection — snap an IntentVector to its dominant dims.
 *
 * selectVariantKey(vector): VariantSelection
 *
 * Rules:
 * - intent_dim  = argmax(vector.intent); tie-break by INTENT_DIMENSIONS tuple order (deterministic).
 * - source_dim  = argmax(vector.source); tie-break by SOURCE_DIMENSIONS tuple order (deterministic).
 * - confidence  = propagated from vector.meta.confidence.
 *
 * Invariant: source NEVER overrides intent. The intent axis picks the variant
 * content structure; the source axis modulates the tone. A visitor with
 * source.ai=1.0 and intent.competitor dominant gets the competitor variant
 * with an AI-source tone, NOT "an ai variant".
 *
 * All-zero axis: when every dim in an axis is 0 (no signal fired), the first
 * dim in the tuple wins by definition of argmax with tie-break. This is the
 * documented V1 behaviour — "brand" for intent and "ai" for source in the
 * zero case. In practice the classifier always fires at least one rule per
 * axis for a non-bot visit.
 */

import { paidAdKind } from "../signals/source-vocabulary.ts";
import type { IntentVector, Signals, VariantSelection } from "../types.ts";
import { INTENT_DIMENSIONS, SOURCE_DIMENSIONS } from "../vector/dimensions.ts";
import type { IntentDim, SourceDim } from "../vector/dimensions.ts";

// Typed first-dim constants — avoids TS tuple-indexing "possibly undefined" errors.
// These are the tie-break winners when all scores in an axis are equal (all-zero).
const FIRST_INTENT_DIM: IntentDim = "competitor";
const FIRST_SOURCE_DIM: SourceDim = "ai";

/**
 * Snaps a full intent vector to the dominant (intent_dim, source_dim) pair.
 *
 * Pure function — no side effects, no Date.now(), fully deterministic.
 */
export function selectVariantKey(vector: IntentVector): VariantSelection {
  // argmax with tuple-order tie-break: iterate in declared order, keep
  // the current winner only when strictly greater (>). First dim wins ties.
  let topIntent: IntentDim = FIRST_INTENT_DIM;
  let topIntentScore = vector.intent[FIRST_INTENT_DIM];

  for (const dim of INTENT_DIMENSIONS) {
    const score = vector.intent[dim];
    if (score > topIntentScore) {
      topIntent = dim;
      topIntentScore = score;
    }
  }

  let topSource: SourceDim = FIRST_SOURCE_DIM;
  let topSourceScore = vector.source[FIRST_SOURCE_DIM];

  for (const dim of SOURCE_DIMENSIONS) {
    const score = vector.source[dim];
    if (score > topSourceScore) {
      topSource = dim;
      topSourceScore = score;
    }
  }

  // No evidence at all is not "ai" or "competitor" by tuple order: an
  // unknown channel is direct (which the edge maps to the default sentinel)
  // and an unknown intent is brand. Seen live 2026-09-12: an unrecognised
  // utm_source scored every source dim 0 and argmax handed out the
  // AI-toned version.
  if (topSourceScore <= 0) topSource = "direct";
  if (topIntentScore <= 0) topIntent = "brand";

  return {
    intent_dim: topIntent,
    source_dim: topSource,
    confidence: vector.meta.confidence,
  };
}

/**
 * The source part of the version key for a selection
 * (docs/specs/ads-platforms.md §4). A paid visit from a feed ad (a
 * paid-social click id, or a paid-social utm_medium) reads the `social`
 * versions, written for a reader from a feed; a search ad and any other
 * paid visit read the `paid` versions. Every other source is its own.
 *
 * No new dimension: the selection, the events and the carry keep
 * `source_dim = paid`; only the key the cascade reads differs. A carried
 * page has no signals of its own, so it reads `paid`.
 */
export function versionSourceDim(
  sourceDim: SourceDim,
  signals: Pick<Signals, "linkFamily" | "utm">,
): SourceDim {
  if (sourceDim === "paid" && paidAdKind(signals) === "social") return "social";
  return sourceDim;
}
