import type { WrapMetrics } from "./wrap.ts";
/**
 * Shared type definitions for Rawuser.
 *
 * This module is the only thing both `edge` and `generation` packages
 * may import from. Keep it dependency-free and side-effect-free:
 * pulling anything heavier in here risks leaking it into the edge bundle.
 */

import type { SitePathEntry } from "./site-map/kinds.ts";
import type { ContextDim, IntentDim, SourceDim } from "./vector/dimensions.ts";

// Re-export so callers can import dim types from a single location.
export type { IntentDim, SourceDim, ContextDim } from "./vector/dimensions.ts";

/**
 * Intent vector: the permanent foundation of the Rawuser intent model.
 *
 * Three orthogonal axes (intent, source, context) plus meta. Each value
 * is a float in [0, 1]. Multiple dims can be high simultaneously:
 * that is the whole point of going vector instead of a single label.
 *
 * V1 "snaps" to (dominant intent dim, dominant source dim) via
 * selectVariantKey(). V2/V3 compose from multiple strong dims.
 */
export interface IntentVector {
  /** Why the visitor came (6 dims, each 0 to 1). */
  intent: Record<IntentDim, number>;
  /** How they got here (6 dims, each 0 to 1). */
  source: Record<SourceDim, number>;
  /** Contextual modifiers (6 dims, each 0 to 1). */
  context: Record<ContextDim, number>;
  meta: {
    /** Confidence in the dominant intent dim (0 to 1, floored at 0.5). */
    confidence: number;
    /** Likelihood of converting to a qualified lead (0 to 1; 0 for bots). */
    lead_probability: number;
  };
}

/**
 * V1 variant selection: the result of snapping a vector to discrete dims.
 *
 * intent_dim picks the variant base (content structure).
 * source_dim modulates the tone (AI-aware, community-technical, etc.).
 * Source NEVER overrides intent: if source.ai=1.0 but intent.competitor
 * is the highest intent dim, selection is (competitor, ai).
 */
export interface VariantSelection {
  intent_dim: IntentDim;
  source_dim: SourceDim;
  /** Propagated from IntentVector.meta.confidence. */
  confidence: number;
}

/** Ambient signals extracted from a visit. No PII, no cross-session IDs. */
export interface Signals {
  /** UTM tags from the URL, normalised to lower-case. */
  utm: {
    source?: string;
    medium?: string;
    campaign?: string;
    term?: string;
    content?: string;
  };
  /**
   * The intent the ad keyword chose against this customer's lexicon
   * (docs/specs/keyword-intent.md §3.4), set by the edge, which then drops
   * `utm.term`. Request-scoped, never stored; the keyword itself never
   * reaches the classifier. Absent = no keyword, no lexicon, or no match.
   */
  keywordIntent?: IntentDim | null;
  /** Document.referrer host, or null when missing/same-origin. */
  referrerHost: string | null;
  /**
   * True when referrerHost is an Android package id from an
   * `android-app://<package>` referrer (an app opened the link in Chrome or a
   * Custom Tab), not a web host. Package ids are matched exactly, never as
   * hosts (Layer G). Request-scoped, never stored. Absent = a web referrer.
   */
  referrerIsApp?: boolean;
  /** Coarse device class: never a fingerprint. */
  device: "mobile" | "tablet" | "desktop" | "bot";
  /** BCP-47 language tag from navigator.language (first match). */
  language: string | null;
  /** ISO-3166-1 alpha-2 country code from Cloudflare CF-IPCountry. */
  country: string | null;
  /** AI-source detection: which AI tool referred this visit, if any. */
  aiSource: AiSource | null;
  /**
   * In-app browser detection (L2): the app whose webview opened the page,
   * read from the User-Agent marker the app appends. Recovers the channel
   * when the webview stripped document.referrer. Names the app, never the
   * visitor. Optional for back-compat; absent/null = normal browser.
   */
  appSource?: AppSource | null;
  /**
   * Tracked-link presence (L2): which platform built the link, read from the
   * NAME of a parameter (fbclid, gclid, oppref, mc_eid, …). The value is
   * never read. Optional for back-compat; absent/null = none present.
   */
  clickId?: ClickIdPlatform | null;
  /** Family of the tracked link above (paid-search, email, …); null with clickId. */
  linkFamily?: LinkFamily | null;
  /**
   * Normalized entry-page path (see path.ts normalizePath): e.g. "/pricing".
   * The page a visitor chose to land on is an ambient intent signal: a naked
   * direct arrival at /pricing has disclosed pricing intent even without UTM.
   * Optional for back-compat; absent/null is treated as "/" (no contribution).
   * Privacy: path only: never query, fragment, or host. See ADR 0023.
   */
  entryPath?: string | null;
  /**
   * The customer's site-map entry that covers `entryPath`
   * (docs/specs/site-shaped-intents.md §6.1), resolved by the edge from the
   * visitor bundle. Absent or null: the global path table applies, as
   * before. A kind and a weight; never the path's name or its link text.
   */
  sitePath?: SitePathEntry | null;
  /**
   * Whether the entry page has its own confirmed versions (spec §6.2, the
   * founder's decision 2): a path, from the site map or the global table,
   * opens the gate only on such a page. Absent (the dashboard's simulator,
   * an answer with no bundle): unknown, the path opens it as before.
   */
  pageHasVersions?: boolean;
  /**
   * True when the visitor is a real human who clicked a citation link in an
   * AI answer (e.g., ChatGPT-User UA). Used by lead-probability heuristic.
   * Internal: not forwarded to clients.
   */
  _isCitationClick?: boolean;
}

/** Verified AI referral source. Identifies the SOURCE, not the person. */
export type AiSource =
  | "chatgpt"
  | "claude"
  | "perplexity"
  | "gemini"
  | "copilot"
  | "you"
  | "phind"
  | "grok"
  | "meta"
  | "deepseek"
  | "mistral"
  | "duckai"
  | "poe"
  | "kimi"
  | "qwen"
  | "ernie"
  | "tongyi"
  | "apple"
  | "amazon"
  | "bytedance"
  // Layer G (2026-10-03): AI products whose hosts joined the vocabulary.
  | "notebooklm"
  | "characterai"
  | "chatglm"
  | "iask"
  | "genspark"
  | "felo"
  | "t3chat"
  | "venice"
  | "lumo"
  | "manus"
  | "doubao"
  | "yuanbao"
  | "gigachat";

/** The app whose in-app browser opened the page. Identifies the APP, not the person. */
export interface AppSource {
  /** Named app from the UA table, or "unknown" when only a webview was detected. */
  app: import("./signals/tables.ts").AppName;
  /** social / ai for a named app; "app" for an unnamed webview. */
  channel: import("./signals/tables.ts").AppChannel;
  /** high = named app; medium = Android webview (Client Hints or wv); low = iOS webkit heuristic. */
  confidence: "high" | "medium" | "low";
}

/** Platform named by a tracked-link parameter's NAME. The value is never read. */
export type ClickIdPlatform =
  | "chatgpt-ads"
  | "google-ads"
  | "microsoft-ads"
  | "yandex-ads"
  | "adobe-ads"
  | "facebook"
  | "instagram"
  | "twitter"
  | "linkedin"
  | "tiktok"
  | "snapchat"
  | "reddit"
  | "pinterest"
  | "quora"
  | "mailchimp"
  | "hubspot"
  | "marketo"
  | "vero"
  | "convertkit"
  | "mailerlite"
  | "klaviyo"
  | "impact"
  | "shareasale"
  | "awin"
  | "cj"
  | "affiliate-generic"
  | "wicked-reports"
  | "referral-generic";

/** What kind of link the platform built. */
export type LinkFamily =
  | "ai-ads"
  | "paid-search"
  | "paid-social"
  | "social-share"
  | "email"
  | "affiliate";

/** Dimensions of an intent: 0-1 normalised scores. */
export interface Dimensions {
  price_sensitivity: number;
  team_interest: number;
  technical_depth: number;
  urgency: number;
  trust_need: number;
}

/** Section type emitted in a structure plan. Extend deliberately. */
export type SectionKind =
  | "hero"
  | "social_proof"
  | "features"
  | "comparison"
  | "pricing"
  | "faq"
  | "cta";

/** One section in the per-profile page composition. */
export interface StructureSection {
  kind: SectionKind;
  /** Emphasis weight 0-1: drives copy length and visual prominence. */
  emphasis: number;
  /** Optional intent-specific note steering the generator. */
  note?: string;
}

/** Signal patterns that classify a visit into this profile. */
export interface TriggerSignals {
  utm_source?: string[];
  utm_medium?: string[];
  utm_campaign?: string[];
  referrer_host?: string[];
  ai_source?: AiSource[];
  /** Fallback patterns matched only when nothing more specific fires. */
  default_when?: "naked_direct" | "unmatched";
}

/**
 * A discrete intent profile: "why they came", not "who they are".
 *
 * @deprecated Replaced by IntentVector + VariantSelection. This type is kept
 * only for the migration period. Remove once all references are gone (Unit 4
 * cleanup). Do NOT add new usages.
 */
export interface IntentProfile {
  profile_key: string;
  label: string;
  trigger_signals: TriggerSignals;
  dimensions: Dimensions;
  structure_plan: StructureSection[];
  /** Baseline lead probability 0-1 before behaviour signals (V2). */
  lead_prob_base: number;
}

/** Business DNA: the customer-supplied product + ICP description. */
export interface BusinessDNA {
  customer_id: string;
  /** What the product/service does: 1-3 sentences. */
  product: string;
  /** Ideal customer profile: who this is for. */
  icp: string;
  /** 3-7 value propositions, ordered by importance. */
  value_props: string[];
  /** 2-5 differentiators (what makes us not interchangeable). */
  differentiators: string[];
  /** 2-8 proof points (logos, credentials, outcomes). */
  proof_points: string[];
  /** Brand voice: short descriptor, e.g. "warm, mentor-like, credible". */
  brand_voice: string;
  /** Free-text market description. */
  target_market: string;
  /** BCP-47 language tag for generated copy (e.g. "az", "en", "tr"). */
  target_language: string;
  /** Per-intent emphasis hints: customer-supplied steering per intent. */
  per_intent_hints?: Partial<Record<IntentDim, string>>;
  /** A key for a provider's prompt cache: the same value across all variant calls. */
  prompt_cache_id?: string;
  updated_at: number;
}

/** One suggested brief entry, with the words on the page that support it. */
export interface DnaSuggestion {
  text: string;
  /** Short quote from the page, checked server-side to be present in its text. */
  evidence: string;
}

/**
 * Product-brief suggestions read from the customer's own site
 * (docs/specs/dna-suggestions.md). Every list entry is backed by evidence
 * on the page; nothing here is invented. Offered as chips on /dna.
 */
export interface DnaSuggestions {
  url: string;
  generated_at: number;
  /** BCP-47 guess of the page language, e.g. "az". */
  language: string | null;
  product: string | null;
  icp: string | null;
  target_market: string | null;
  /** Three or four tone words read from the page's own register, e.g. "warm, direct, confident". */
  brand_voice: string | null;
  value_props: DnaSuggestion[];
  differentiators: DnaSuggestion[];
  proof_points: DnaSuggestion[];
}

// ---------------------------------------------------------------------------
// Element manifest: auto-detected selectors for the Tier 3 snippet finder.
// ---------------------------------------------------------------------------

/**
 * Per-element selector candidates emitted by the AI element detector.
 * The snippet walks them in priority order: css → text → structural.
 *
 * Length fields (added D6.2): when present, generation uses them as per-
 * section length constraints (±20% tolerance) so generated copy fits the
 * customer's existing layout without manual configuration. Both optional
 * for backward compatibility with manifests detected before D6.2.
 */
/**
 * The inline shape of an original element, read from the page
 * (docs/specs/design-preserving-rewrite.md §2): what the rewrite must keep.
 */
export interface InlineShape {
  /** Where the element keeps children without words (an arrow, an svg). */
  icons: "none" | "leading" | "trailing" | "both";
  /** Inline children with words (em, strong, a coloured span): 0 to 4. */
  emphasis: number;
  /** Visible text of the first emphasised child, at most 60 characters. */
  emphasis_phrase?: string;
  /** More than four children with words: a per-word or per-letter animation. */
  split: boolean;
  /** The visible text differed between two reads: typewriter, rotating words. */
  animated_text: boolean;
  /**
   * A headline built word by word, read as a template
   * (docs/specs/template-writing.md §3.1): its words, {br}, {gN} glyphs,
   * {sN}…{/sN} style groups and {rot:a|b} rotating slot. Set only when
   * `split` is true and the split is by word, not by letter.
   */
  template?: string;
  /**
   * A headline the page cut into this many lines (2 to 8), written by
   * pouring the version's words into the page's own lines
   * (docs/specs/interactive-text.md §3.2). No template: generation writes it
   * as plain text with its three lengths.
   */
  lines?: number;
  /** The template's words are split into letters (Framer, Splitting.js). */
  letters?: boolean;
}

export interface ElementTargets {
  /** 1-3 CSS selectors, ordered by specificity. */
  css: string[];
  /** 0-2 text-signature selectors (matches innerText starts-with). */
  text: string[];
  /** 1 structural selector, human-readable ("first h1 in main"). */
  structural: string;
  /**
   * Optional: visible textContent character count of the original element.
   * Used by generation to constrain variant copy length. Absent for legacy
   * manifests detected before D6.2.
   */
  original_char_length?: number;
  /**
   * Optional: visible textContent word count of the original element.
   * Used by generation to constrain variant copy length. Absent for legacy
   * manifests detected before D6.2.
   */
  original_word_count?: number;
  /**
   * Optional: whether this element is a primary conversion action: signup,
   * demo request, buy, trial start, contact-form submit. Set by the AI
   * element detector at detection time (V2 Module 3). The operator confirms
   * which flagged elements become tracked conversions in the conversions
   * review screen; only confirmed entries reach the conversion_targets
   * table and produce snippet click listeners.
   *
   * Absent for manifests detected before migration 0008: generation and
   * snippet treat the field as defined-only and degrade gracefully.
   */
  conversion_candidate?: boolean;
  /**
   * How the page wraps this headline at 1280, 768 and 390 px, measured once
   * in the operator's browser by the picker (docs/specs/interactive-text.md
   * §3.4). Page facts; the edge never sends it to a visitor.
   */
  metrics?: WrapMetrics;
  /** The original element's inline shape; absent on manifests from before 2026-09-14. */
  inline?: InlineShape;
  /** Operator's "leave it": the snippet never writes this slot; generation still fills it. */
  skip?: boolean;
  /** Operator's "replace as plain text" on a split-text element. */
  plain?: boolean;
  /**
   * On a button only (`*.label`, `*.submit_label`): the operator turned the
   * rewrite of this button on (docs/specs/button-rewrite.md). Absent, or
   * anything but `true`, is off: the button keeps the page's own words and
   * is not a target. Read through button-rewrite.ts; never sent to a
   * browser (`manifestForVisitors`).
   */
  rewrite?: boolean;
}

/**
 * Manifest keyed by section dot-path (e.g. "hero.headline", "cta.cta.label").
 * Stored in D1.element_manifests.manifest as JSON.
 * Injected as a sibling field on the /select response envelope (not inside VariantBody).
 */
export type Manifest = Record<string, ElementTargets>;

/** A generated variant body stored in KV. D1 holds the metadata. */
export interface VariantBody {
  customer_id: string;
  profile_key: string;
  /** Section -> rendered copy (kept structural, not raw HTML). */
  sections: Record<string, VariantSection>;
  generated_at: number;
  /** Hash of the prompt that produced this body: for cache invalidation. */
  prompt_hash: string;
  /**
   * The body's id (docs/specs/proof-engine.md, section C): 16 hex, set by
   * publishVersion on the live KV value. Absent on bodies written before it.
   */
  body_id?: string;
}

export interface VariantSection {
  kind: SectionKind;
  headline?: string;
  body?: string;
  cta?: { label: string; href?: string };
}

/** Provenance row stored in D1.variants. KV holds the body. */
export interface VariantRecord {
  id: string;
  customer_id: string;
  profile_id: string;
  kv_key: string;
  model: string;
  prompt_hash: string;
  generated_at: number;
  cost_usd: number;
  status: "ready" | "stale" | "error";
}
