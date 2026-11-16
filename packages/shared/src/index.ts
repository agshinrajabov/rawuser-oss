export * from "./types.ts";
export * from "./kv-keys.ts";
export * from "./capture.ts";
export * from "./pick.ts";
export * from "./hide-rules.ts";
export * from "./button-rewrite.ts";
export * from "./visitor-bundle.ts";
export * from "./audit.ts";
export * from "./body-id.ts";
export * from "./proof.ts";
export * from "./analytics.ts";
export * from "./signals/source-vocabulary.ts";
export * from "./site-languages.ts";
export * from "./no-fake-visit.ts";
export * from "./sensitive.ts";
export * from "./page-groups.ts";
export * from "./readiness.ts";
export * from "./special-category/words.ts";
export * from "./special-category/health.ts";
export * from "./special-category/terms.ts";
export * from "./keyword-lexicon.ts";
export * from "./ads/templates.ts";
export * from "./country.ts";
export * from "./device-class.ts";
export * from "./direct.ts";
export * from "./choice.ts";

// Page-path normalization — shared by snippet + edge for per-path manifest
// selection (A1 / per-path manifests). Single source of truth.
export { normalizePath } from "./path.ts";

// Vector foundation — dimensions and their derived types.
export { INTENT_DIMENSIONS, SOURCE_DIMENSIONS, CONTEXT_DIMENSIONS } from "./vector/dimensions.ts";

// Vector defaults — in-bundle fallback templates + source tone hints.
export { DEFAULT_VARIANT_TEMPLATES, DEFAULT_SOURCE_MODIFIERS } from "./vector/defaults.ts";

// Classify — outputs IntentVector (V1 refactor; lead-prob folded in)
export { classify, isOffhours } from "./classify/index.ts";
export { campaignRefused, withScreenedCampaign } from "./classify/campaign.ts";

// Entry-path intent mapping (L1, ADR 0023) — path as an ambient intent signal.
export {
  PATH_INTENT_TABLE,
  globalPathKinds,
  pathCarriesIntent,
  pathDims,
  pathIntentDims,
  pathContextDims,
  siteEntryFor,
} from "./classify/path-intent.ts";
export type { PathDims } from "./classify/path-intent.ts";

// Site-shaped intents (docs/specs/site-shaped-intents.md): kinds, word
// tables, screens, the served set and the fold.
export * from "./site-map/index.ts";

// Selection — snaps IntentVector to (intent_dim, source_dim) pair
export { selectVariantKey, versionSourceDim } from "./select/index.ts";

// Signals
export { extractSignals } from "./signals/extract.ts";
export type { ExtractInput, CfProperties } from "./signals/extract.ts";
export { parseReferrerHost } from "./signals/referrer.ts";
export { parseUtm } from "./signals/utm.ts";
export { detectAiSource } from "./signals/ai-source.ts";
export type { AiSourceResult } from "./signals/ai-source.ts";
export { hasMeaningfulSignal, hasSourceSignal, pathOpensGate } from "./signals/meaningful.ts";
export { classifyDevice } from "./signals/device.ts";
export {
  AI_BOT_UAS,
  AI_USER_UAS,
  AI_REFERRER_HOSTS,
  COMPARISON_REFERRER_HOSTS,
  BOT_UA_SUBSTRINGS,
} from "./signals/tables.ts";
export type { AiBotEntry, AiUserEntry, AiReferrerEntry } from "./signals/tables.ts";
export * from "./inline-shape.ts";
export * from "./template.ts";

export { isLocalHost, siteOrigin } from "./site-address.ts";
