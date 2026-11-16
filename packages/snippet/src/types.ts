/**
 * Internal types for the snippet runtime.
 *
 * These extend the shared VariantBody/VariantSection shapes but are kept
 * local so the snippet has zero runtime imports from @rawuser/shared.
 * All imports from @rawuser/shared MUST be type-only; esbuild strips them.
 */

import type { Manifest, VariantBody, VariantSection } from "@rawuser/shared/types";
import type { Issue } from "./issues.ts";

export type { VariantBody, VariantSection };

/**
 * A single element's targeting candidates from the AI element detector.
 * Mirrors ElementTargets from @rawuser/shared — kept local to avoid
 * runtime shared imports in the snippet bundle.
 */
export interface ManifestEntry {
  /** CSS selectors, tried in order; first selector with ≥1 match wins. */
  css: string[];
  /** Text signatures; element textContent.trim().startsWith(sig) wins. */
  text: string[];
  /** Structural descriptor e.g. "first h1 in main" or raw CSS fallback. */
  structural: string;
  /** The original element's inline shape (docs/specs/design-preserving-rewrite.md). */
  inline?: {
    icons: "none" | "leading" | "trailing" | "both";
    emphasis: number;
    emphasis_phrase?: string;
    split: boolean;
    animated_text: boolean;
    /** A headline built word by word, as a template (docs/specs/template-writing.md). */
    template?: string;
    /** A headline the page cut into this many lines (docs/specs/interactive-text.md §3.2). */
    lines?: number;
  };
  /** Operator's "leave it": never written, never claimed by the pre-flight. */
  skip?: boolean;
  /** Operator's "replace as plain text" on a split-text element. */
  plain?: boolean;
}

/**
 * Shape of the /select response from the edge.
 * Mirrors SelectResponse in packages/edge/src/index.ts.
 *
 * `source` distinguishes "served a variant" from "leave the page alone":
 * - "original" → no meaningful signal arrived; snippet must NOT mutate
 *   the DOM, just reveal the original content.
 * - Anything else → variant is non-null and applyVariant proceeds.
 */
export interface SelectResponse {
  source:
    | "kv"
    | "kv-sentinel"
    | "fallback-template"
    | "fallback-canonical-bot"
    | "preview"
    | "original"
    | "holdout";
  /** Key used for the KV lookup; empty string when source === "original" or "holdout". */
  variant_key?: string;
  /**
   * Experimental cohort for A/B holdout analytics (Batch C).
   * - "personalized": signal present, variant was applied.
   * - "holdout":      signal present, 10% baseline arm.
   * - "no_signal":    no meaningful signal; original page served.
   * Absent on the bot path. "skipped" is derived by the snippet, never sent from edge.
   */
  cohort?: "personalized" | "holdout" | "no_signal";
  /** V1 snap: which (intent_dim, source_dim) the edge picked. Absent on bot path. */
  selection?: {
    intent_dim: string;
    source_dim: string;
    confidence: number;
  };
  /** True when the selection came from the tab's carry, not from this page's signals. */
  carried?: boolean;
  /** L2 Layer D, reporting only: untagged visit that looks like dark social. */
  dark_social_probable?: boolean;
  /** Language gate: the page is in another language than the customer's versions; original kept. */
  language_mismatch?: boolean;
  /** The path has a confirmed manifest: its copy may be carried within the visit (body carry). */
  carryable?: boolean;
  /** The customer turned the carries off: remove what the tab kept, send no carry. */
  carry_off?: boolean;
  /** The visit's arm when it is in the test (docs/specs/proof-engine.md, A). */
  arm?: Arm;
  /** The served version's id, or on a holdout answer the one the visit would have seen. */
  body_id?: string;
  /** N1: the platform the edge named from this request (a closed-list word). Echoed, never read on the device. */
  source_name?: string;
  /** N3: the link carried the customer's own campaign tags. Echoed as 1. */
  tagged?: boolean;
  /** Audits: how the edge recognised the source (a closed-list word). Echoed, never read. */
  found_by?: string;
  /** The customer's site map decided the page's intent. Echoed as 1. */
  site_path?: boolean;
  /** Null only when source === "original" (no personalization). */
  variant: VariantBody | null;
  /** Optional per-path targeting manifest (V1.5+, may be absent). */
  targets?: Manifest;
  /**
   * V2 Module 3: confirmed conversion targets to install click listeners on.
   * Absent when no enabled targets exist for this customer.
   */
  conversion_targets?: Array<{
    section_path: string;
    conversion_label: string;
    css: string[];
    text: string[];
    structural: string;
    /** Page one chooses page two: the intent word a click on this button keeps (§4). */
    i?: string;
  }>;
  /** 1 for a deleted customer: write nothing, send nothing, clear the tab. */
  off?: 1;
  /**
   * What the tab keeps in its carry for this visit (docs/specs/direct-visitors.md
   * §6): an `intent:source` pair, or "" for nothing. Absent: the old rule (the
   * selection of a personalised answer that was not carried).
   */
  kc?: string;
  /** Why a visit with no signal got this answer (`l:{set}:{p}` or `m`). Echoed on the page's events, never read. */
  nd?: string;
  /** The visitor's own choice: the question and its answers, drawn by rich.js (§2). */
  q?: unknown;
}

/**
 * Analytics event payload sent to POST /event.
 * Mirrors the edge worker's ValidatedEvent shape.
 */
export interface EventPayload {
  event_type:
    | "variant_shown"
    | "no_signal_passthrough"
    | "conversion"
    | "personalization_skipped"
    | "personalization_partial"
    | "snippet_issue"
    | "choice";
  page_path: string;
  /** The visitor-choice row's one fixed word (docs/specs/direct-visitors.md §2). */
  ch?: "shown" | "closed" | "fit" | "anchor" | "answered";
  /** On an `answered` choice row: the answer's slot and the visitor's own code (ADR 0039). */
  qa?: string;
  pid?: string;
  variant_key?: string;
  intent_dim?: string;
  source_dim?: string;
  conversion_label?: string;
  /**
   * Experimental cohort (Batch C holdout A/B analytics).
   * - "personalized": visitor saw the variant (variant_shown, applied=true).
   * - "holdout":      visitor was in the 10% baseline arm.
   * - "skipped":      applyVariant aborted — visitor saw original (personalization_skipped).
   * - "no_signal":    no meaningful signal at all (no_signal_passthrough).
   */
  cohort?: "personalized" | "holdout" | "skipped" | "no_signal";
  /** L2 Layer D: 1 when the edge flagged the untagged visit as probable dark social. */
  dark_social?: 1;
  /** 1 when the edge kept the original because the page language differs from the versions'. */
  language_mismatch?: 1;
  /** 1 when the selection came from the tab's carry (docs/specs/session-carry.md). */
  carried?: 1;
  /** The tab's random visit marker, 32 hex (docs/specs/visit-marker.md). */
  visit?: string;
  /** personalization_partial only: the slots that still showed the original. */
  paths?: string[];
  /** 1 when the words were written from the tab's carried copy before the edge answered. */
  body_carry?: 1;
  /** personalization_skipped only: why the page was left as built (a page fact). */
  kind?: SkipKind;
  /**
   * snippet_issue only: closed codes, a manifest slot, a coarse closed
   * number (docs/specs/snippet-issues.md). Never carries `visit`.
   */
  properties?: { issues: Issue[] };
  /** The visit's arm, echoed from /select on every event of the page. */
  arm?: Arm;
  /** The version's id, echoed from /select (or from the tab's carried copy). */
  body_id?: string;
  /** N1, echoed from /select; the edge keeps it only if on its list. */
  source_name?: string;
  /** N3, echoed from /select. */
  tagged?: 1;
  /** Site-shaped intents §6.4, echoed from /select; the edge keeps only 1. */
  site_path?: 1;
  /** Audits, echoed from /select; the edge keeps it only if on FOUND_BY. */
  found_by?: string;
  /**
   * 1 when the page had been painted before our script ran, so it stayed as
   * built (docs/specs/late-tag.md). The `tagIsLate` boolean and nothing else:
   * never a time, a duration or a count, never a second value. Only on
   * `personalization_skipped` (kind `late`) and on the holdout exposure;
   * never on a conversion (it is not part of Provenance) or a snippet_issue.
   */
  lp?: 1;
}

/** What the edge's coin said for the visit. */
export type Arm = "treat" | "holdout";

/** The arm, version id, source name and tag bit an answer gave, sent with every event of its page. */
export interface Provenance {
  arm?: Arm;
  body_id?: string;
  source_name?: string;
  tagged?: 1;
  /** 1 when the edge said the customer's site map decided the page's intent. */
  site_path?: 1;
  /** Audits: how the edge recognised the source. */
  found_by?: string;
  /** Why a visit with no signal got this answer, echoed (direct-visitors.md §6). */
  nd?: string;
  /** The tab's visit marker; never on a snippet issue. */
  visit?: string;
}

/**
 * Why a version was not written: a part missing, split text we cannot read,
 * a version that does not fit it, or `late`: the visitor was already reading
 * the original when the version could have been written. Two cases, one
 * word: the answer came after the reveal cap showed the original
 * (docs/specs/quiet-swap.md, Late answers), or the page was painted before
 * our script ran (docs/specs/late-tag.md); the second also carries the bit
 * `lp`, which is how the two are told apart.
 * Closed list of fixed words. Never add a measured value (width, height,
 * line count) or anything read from the visitor's environment. `late` is
 * a yes/no fact about load order (the snippet's own reveal cap, or the
 * presence-only `tagIsLate`), never a duration, never split by which cap
 * fired (that stays in snippet_issue, without the visit code); any other
 * timing-derived kind needs a new review. A new kind needs
 * privacy review.
 */
export type SkipKind = "missing" | "split" | "template-mismatch" | "lines" | "late";
