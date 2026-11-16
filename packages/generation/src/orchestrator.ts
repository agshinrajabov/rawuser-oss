/**
 * Orchestrator: the offline pipeline that fills KV with per-intent variants.
 *
 * Entry point: orchestrate(customerId, env)
 *
 * Flow:
 *   1. Load BusinessDNA from D1
 *   2. Build the cached DNA preamble (system prompt, marked ephemeral)
 *   3. For each (intent_dim, source_dim) tuple (36 a page: 6 intents × default + 5 sources):
 *      a. Build the user prompt (intent prompt + source modifier)
 *      b. Call generateVariant with the cached preamble
 *      c. Validate the JSON output against VariantBody expectations
 *      d. One retry on validation failure with a corrective prompt
 *      e. Write to KV + D1 variants on success; write error row on 2nd failure
 *   4. Return summary: { generated, errors, cost_usd, cache_hit_rate, aborted }
 *
 * Cost protection (three layers):
 *   1. Per-call AbortSignal timeout: 45s
 *   2. Per-orchestration call budget: MAX_CALLS per page (60: 36 + 24 retry budget)
 *   3. Cost ceiling: $2.00 per run: aborts with reason "cost_ceiling"
 *
 * Privacy invariant: reads only from business_dna and customers; never reads
 * from events. Writes only to KV (variant body) and D1.variants (metadata),
 * and through publishVersion to D1.version_bodies (our text, never a visitor's).
 * Generated copy is operator content, not visitor data.
 */

import type { BusinessDNA, IntentDim, Manifest, SourceDim, VariantBody } from "@rawuser/shared";
import {
  INTENT_DIMENSIONS,
  hideRulesKey,
  marketOfSource,
  normalizePath,
  parseServed,
  richKey,
  variantKeyForPath,
  visitorBundleKey,
} from "@rawuser/shared";
import {
  fillTemplate,
  templateEntries,
  templateLength,
  templateLineMisses,
  templateReadings,
  templateText,
  templateViolations,
} from "@rawuser/shared/template";
import type { WrapMetrics } from "@rawuser/shared/wrap";
import { holdScore } from "@rawuser/shared/wrap";
import { jsonrepair } from "jsonrepair";
import { writeHideRules } from "./admin/onboard.ts";
import { addAuditSpend, auditGate } from "./audit/caps.ts";
import { callModel } from "./call-model.ts";
import type { GenerateEnv, GenerateInput, GenerateResult } from "./generateVariant.ts";
import { generateVariant } from "./generateVariant.ts";
import { type InstallEnv, fetcherUserAgent } from "./install-config.ts";
import { modelConfigured, modelIdFor } from "./model-config.ts";

/** Tests only: forget that a model was down (kept here for the existing imports). */
export { resetProviderState } from "./call-model.ts";
import { type PageFetch, ensureInlineShapes, pageFetcher } from "./inline-shape-backfill.ts";
import { nothingToWrite, writtenManifest } from "./lib/button-rewrite.ts";
import { loadMarkets } from "./lib/markets.ts";
import { type PartAsBuilt, partAsBuiltFlag } from "./lib/parts-as-built.ts";
import { putPreviewBody } from "./lib/publish-version.ts";
import { loadReadyKvKeys } from "./lib/queue-due.ts";
import {
  SENSITIVE_PAGE_CODE,
  keptPagesOnly,
  loadSensitive,
  sensitivePageRefusal,
} from "./lib/sensitive-guard.ts";
import { markTried } from "./lib/tried-marker.ts";
import { type GenerationTuple, buildTuples, writeErrorRow } from "./lib/variant-rows.ts";
import { storeVersion } from "./lib/version-approval.ts";

/** Kept here for the existing imports; it lives with the tuple type now. */
export { buildTuples } from "./lib/variant-rows.ts";
import {
  CLAIMS_LOCK_FIX,
  CLAIMS_LOCK_RULES_SET,
  type ClaimsLock,
  brandOf,
} from "./lint/claims-lock.ts";
import {
  type CtaFacts,
  KEEP_OWN_ACTION,
  LABEL_SIGNATURE_MAX,
  ctaFactsOf,
  ctaObjectsOf,
  describeKinds,
  isButtonLabelPath,
  keepObjectLine,
} from "./lint/cta-action.ts";
import {
  HEADLINE_ALT2_CAP,
  type LintFlag,
  PARAGRAPH_ALT_CAP,
  PARAGRAPH_NEAR_CAP,
  SHORT_HEADLINE,
  SHORT_PARAGRAPH,
  allowedNumbersFor,
  allowedUnitsFor,
  headlineSameness,
  labelCap,
  lintVariant,
  normalizeForCompare,
  ownWordsFor,
} from "./lint/index.ts";
import { MARKET_ADDRESSED_FIX } from "./lint/market-addressed.ts";
import { SOURCE_ADDRESSED_FIX } from "./lint/source-addressed.ts";
import { pageLinksOf } from "./page-links.ts";
import { loadPageRead, samplesBesideTemplates } from "./page-samples.ts";
import { buildDnaPreamble } from "./prompts/dna.ts";
import { buildIntentPrompt } from "./prompts/intent-prompts.ts";
import { INTENT_STRUCTURES } from "./prompts/intent-structures.ts";
import { buildMarketModifier } from "./prompts/market.ts";
import { buildRevisePrompt } from "./prompts/revise.ts";
import { GENERATED_SOURCE_DIMS, buildSourceModifier } from "./prompts/source-modifiers.ts";
import { sanitizeVariantBody } from "./sanitize.ts";
import { type LinkKinds, NO_LINK_KINDS, loadLinkKinds } from "./site-map/link-kinds.ts";
import { siteRereadHook } from "./site-map/run.ts";
import { loadServedIntents } from "./site-map/served-load.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** With the install's configuration (install-config.ts): page reads carry its user agent. */
export interface OrchestrateEnv extends GenerateEnv, InstallEnv {
  DB: D1Database;
  VARIANTS: KVNamespace;
}

export interface OrchestrationResult {
  customer_id: string;
  generated: number;
  errors: number;
  cost_usd: number;
  cache_hit_rate: number;
  kv_keys: string[];
  failed_tuples: Array<{ intent_dim: string; source_dim: string; reason: string }>;
  aborted: boolean;
  abort_reason?: string;
  /** True when maxTuples stopped the run with work left. */
  capped?: boolean;
  /** Parts left as the page built them across the versions this run wrote. */
  parts_as_built?: number;
  /** Of `generated`, the versions that wait for the customer's OK (versions-approval.md). */
  waiting?: number;
}

export type { GenerationTuple } from "./lib/variant-rows.ts";

// ---------------------------------------------------------------------------
// Cost protection constants
// ---------------------------------------------------------------------------

const COST_CEILING_USD = 2.0;
// Five calls for every three versions of a page: 50 for 30 until `paid`
// joined the generated sources (2026-10-22, ads-platforms.md §3), 60 for 36.
const MAX_CALLS = Math.ceil(
  (INTENT_DIMENSIONS.length * (1 + GENERATED_SOURCE_DIMS.length) * 5) / 3,
);
// Fix Pass A widened the retry budget from 2:
// the manifest-subset validator (ADR 0019) may reject the first attempt for
// any intent whose structure plan canonically includes sections the customer's
// manifest doesn't cover. Retry path then fires a corrective prompt. Allowing
// ~one retry per variant keeps cost bounded (the COST_CEILING_USD remains the
// hard stop) while preventing call_budget aborts mid-orchestration.
// The per-call timeout (45 s) and the tiers of an outage (the fallback
// model, the spare route) live in call-model.ts, shared with the
// interactive reads.

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export interface OrchestrateOptions {
  /**
   * When true, tuples that already have a 'ready' variant row are skipped:
   * only missing / errored / stale tuples are regenerated. The 6-hourly cron
   * uses this so a multi-path customer (N paths × 30 tuples) doesn't attempt
   * all N×30 sequential LLM calls in one invocation and die at the Worker
   * request wall (~340s) partway through, leaving the tail permanently errored.
   * It also collapses steady-state cost to ~0 once everything is ready.
   * Manual full regen (dashboard "Regenerate all", paced per-tuple) does NOT
   * use this: it force-refreshes every tuple.
   */
  onlyMissing?: boolean;
  /**
   * Stop after this many tuples were attempted (written or failed). The
   * five-minute queue uses it so one cron invocation stays inside the
   * Worker's wall time and the next one continues (2026-09-15).
   */
  maxTuples?: number;
  /**
   * With onlyMissing: an errored row is left alone while its last ready
   * write or its last failed try (lib/tried-marker.ts) is younger than this,
   * so the five-minute queue does not pay for the same stubborn row every
   * five minutes; the 6-hour rhythm of the old cron is kept for retries. A
   * first write the copy checks refused is the exception, once
   * (`loadReadyKvKeys`).
   */
  skipErrorsYoungerThanMs?: number;
}

export async function orchestrate(
  customerId: string,
  env: OrchestrateEnv,
  opts: OrchestrateOptions = {},
): Promise<OrchestrationResult> {
  // 0. The audit's caps (docs/specs/ai-traffic-audit.md §3.8, §9): an ended
  //    customer writes nothing, an audit writes only inside its spend.
  const audit = await auditGate(env.DB, customerId);
  if (audit.ended || (audit.audit && audit.left <= 0)) {
    return {
      customer_id: customerId,
      generated: 0,
      errors: 0,
      cost_usd: 0,
      cache_hit_rate: 0,
      kv_keys: [],
      failed_tuples: [],
      aborted: true,
      abort_reason: audit.ended ? "audit_ended" : "audit_spend",
    };
  }

  // 1. Load the primary BusinessDNA
  const dna = await loadBusinessDNA(customerId, env.DB);
  const primaryDna = dna;

  // 1a. In onlyMissing mode, load the set of kv_keys that already have a 'ready'
  // variant so we can skip them below. One query up front; a 'stale' or 'error'
  // row is NOT in this set, so those still regenerate.
  const readyKeys = opts.onlyMissing
    ? await loadReadyKvKeys(customerId, env.DB, opts.skipErrorsYoungerThanMs, env.VARIANTS)
    : new Set<string>();

  // 1b. Load every CONFIRMED element manifest (A1 per-path). Each confirmed
  // page_path is generated independently: its variants are keyed by
  // variantKeyForPath so the edge can serve a /start visitor a variant whose
  // leaf paths resolve on /start's DOM (not the '/' page's). A customer with no
  // confirmed manifest still gets one path-agnostic set against a null manifest
  // (legacy behavior) so nothing regresses. This is what closes the skip-rate
  // gap: paths visitors actually land on (e.g. /start) get their own variants.
  const everyConfirmedPath = await loadConfirmedPaths(
    customerId,
    env.DB,
    pageFetcher(fetcherUserAgent(env)),
    siteRereadHook(env, customerId),
  );
  // A sensitive customer has versions only on `/` and its kept sections
  // (docs/specs/sensitive-customers.md, condition 2 and rule 4). The admin
  // endpoints refuse any other page with a 409; this is the backstop, so a
  // page confirmed some other way is still never written for.
  const confirmedPaths = await keptPagesOnly(env.DB, customerId, everyConfirmedPath);
  if (everyConfirmedPath.length > 0 && confirmedPaths.length === 0) {
    return {
      customer_id: customerId,
      generated: 0,
      errors: 0,
      cost_usd: 0,
      cache_hit_rate: 0,
      kv_keys: [],
      failed_tuples: [],
      aborted: true,
      abort_reason: SENSITIVE_PAGE_CODE,
    };
  }
  // Customers confirmed before the quiet swap (2026-09-12) have no hide
  // rules in KV, so their script ships `h: {}` and the original flashes.
  // Write them once here (a Lovable test site, found in the 2026-09-14 rehearsal).
  if (confirmedPaths.length > 0) await ensureHideRules(customerId, env);
  const counted = await loadCountedPaths(customerId, env.DB);
  const domain = await loadCustomerDomain(customerId, env.DB);
  // What the site map says of a button's link, for a link whose own words
  // say nothing (the first outside pilot, A1.3).
  const linkKinds = await loadLinkKinds(customerId, domain, env.DB);
  // A button is written only when the operator turned it on
  // (lib/button-rewrite.ts): `manifest` is what a version writes, `full` the
  // page as confirmed, kept for what must still know an off button (the
  // counted button's own words, which no other button may show). A page whose
  // every part is an off button has nothing to write and is left out.
  const targets: Array<{
    pagePath: string;
    manifest: Manifest | null;
    full: Manifest | null;
    language: string | null;
  }> =
    confirmedPaths.length > 0
      ? confirmedPaths
          .filter((p) => !nothingToWrite(p.manifest))
          .map((p) => ({ ...p, full: p.manifest, manifest: writtenManifest(p.manifest) }))
      : [{ pagePath: "/", manifest: null, full: null, language: null }];

  // 2. Build the tuples: the served intents (docs/specs/site-shaped-intents.md
  //    §7.3; all six when the map is off or never read) × default + 5 sources.
  //    Then one `brand` cell per market (docs/specs/direct-visitors.md §5).
  const tuples = buildTuples(
    await loadServedIntents(customerId, env.DB),
    await loadMarkets(customerId, env.DB),
  );

  // 3. Build cached preamble (used as system prompt for all calls). The
  // customer's own sentences ride in it as the style anchor
  // (docs/specs/generation-quality.md); numbers in the brief and samples
  // are the only numbers the copy may use.
  const read = await loadPageRead(customerId, domain, env);
  const samples = read.samples;
  // The claims lock of a customer whose site is about health
  // (docs/specs/claims-lock.md): one block in the preamble, three hard
  // rules in the lint. Off, nothing below changes by a byte.
  const lock = (await loadSensitive(env.DB, customerId)).sensitive;
  // Per language (docs/specs/per-language.md): each path is written from
  // the brief in ITS language, with its own preamble and allowed numbers.
  const briefs = new Map<
    string,
    {
      dna: BusinessDNA;
      cachedPreamble: string;
      allowedNumbers: Set<string>;
      allowedUnits: Map<string, Set<string>>;
      ownWords: string;
    }
  >();
  const briefFor = async (language: string | null) => {
    const key = (language ?? primaryDna.target_language).toLowerCase();
    const hit = briefs.get(key);
    if (hit) return hit;
    const d = language ? await loadBusinessDNA(customerId, env.DB, language) : primaryDna;
    const entry = {
      dna: d,
      cachedPreamble: buildDnaPreamble(
        d,
        samplesBesideTemplates(
          samples,
          targets.map((t) => t.manifest),
        ),
        { href: targets.some((t) => asksHref(t.manifest)), claimsLock: lock },
      ),
      allowedNumbers: allowedNumbersFor(d, samples),
      allowedUnits: allowedUnitsFor(d, samples),
      // What the customer says of itself: a subject found there is the
      // product's own, never the visitor's source (lint/source-addressed.ts).
      ownWords: ownWordsFor(d, samples),
    };
    briefs.set(key, entry);
    return entry;
  };
  const runHeadlines: string[] = [];

  // 4. Run generation per (path, tuple)
  const result: OrchestrationResult = {
    customer_id: customerId,
    generated: 0,
    errors: 0,
    cost_usd: 0,
    cache_hit_rate: 0,
    kv_keys: [],
    failed_tuples: [],
    aborted: false,
  };

  let callCount = 0;
  let cacheHits = 0;
  let totalCalls = 0;

  // Budgets scale with the path count so a multi-path customer keeps the same
  // per-path economics (30 variants + retry headroom, ~$2 ceiling each) instead
  // of starving later paths under a single global cap.
  const costCeiling = COST_CEILING_USD * targets.length;
  const maxCalls = MAX_CALLS * targets.length;

  let attempted = 0;
  pathLoop: for (const { pagePath, manifest, full, language } of targets) {
    const { dna, cachedPreamble, allowedNumbers, allowedUnits, ownWords } =
      await briefFor(language);
    const ctas = ctasOf(full, pageLinksOf(customerId, pagePath), counted, linkKinds);
    for (const tuple of tuples) {
      if (opts.maxTuples !== undefined && attempted >= opts.maxTuples) {
        result.capped = true;
        break pathLoop;
      }
      // The audit's spend cap: what is left when the run began.
      if (audit.audit && result.cost_usd >= audit.left) {
        result.aborted = true;
        result.abort_reason = "audit_spend";
        break pathLoop;
      }

      // Cost ceiling check
      if (result.cost_usd >= costCeiling) {
        result.aborted = true;
        result.abort_reason = "cost_ceiling";
        break pathLoop;
      }

      // Call budget check
      if (callCount >= maxCalls) {
        result.aborted = true;
        result.abort_reason = "call_budget";
        break pathLoop;
      }

      const kvKey = variantKeyForPath(customerId, pagePath, tuple.intent_dim, tuple.source_dim);

      // onlyMissing: this tuple already has a ready variant: skip it. Keeps the
      // cron's per-invocation work bounded to what actually needs regenerating.
      if (opts.onlyMissing && readyKeys.has(kvKey)) {
        continue;
      }

      const userPrompt = buildUserPrompt(tuple, dna, customerId, manifest, ctas);
      const model = writeModelId(env);
      attempted++;

      // First attempt
      callCount++;
      totalCalls++;
      const firstResult = await callModel(
        { prompt: userPrompt, cachedPreamble, role: "write" },
        env,
      );

      if (!firstResult.ok) {
        // Timeout or a failed request on the first call
        result.errors++;
        result.failed_tuples.push({
          intent_dim: tuple.intent_dim,
          source_dim: tuple.source_dim,
          reason: firstResult.error,
        });
        await failRow(customerId, tuple, kvKey, firstResult.error, env, pagePath, model);
        continue;
      }

      result.cost_usd += firstResult.value.costUsd;
      if (firstResult.value.cacheHit) cacheHits++;

      // Validate the JSON output. Defensive try/catch: if validation itself
      // throws on a malformed model response, isolate to this tuple rather
      // than crashing the whole orchestration.
      const validation = safeValidate(
        firstResult.value.text,
        tuple.intent_dim,
        customerId,
        manifest,
      );

      let finalBody: VariantBody | null = null;
      let finalResult: GenerateResult = firstResult.value;

      if (validation.ok) {
        finalBody = validation.body;
        if (validation.pruned?.length) {
          console.warn(
            `[generate] pruned ${validation.pruned.length} off-manifest leaf(s) from ${kvKey}: ${validation.pruned.join(", ")}`,
          );
        }
      } else {
        // One retry with corrective prompt
        if (callCount < maxCalls) {
          callCount++;
          totalCalls++;
          const correctivePrompt = buildCorrectivePrompt(userPrompt, validation.reason);
          const retryResult = await callModel(
            { prompt: correctivePrompt, cachedPreamble, role: "write" },
            env,
          );

          if (retryResult.ok) {
            result.cost_usd += retryResult.value.costUsd;
            if (retryResult.value.cacheHit) cacheHits++;
            finalResult = retryResult.value;

            const retryValidation = safeValidate(
              retryResult.value.text,
              tuple.intent_dim,
              customerId,
              manifest,
            );
            if (retryValidation.ok) {
              finalBody = retryValidation.body;
            }
          }
        }

        if (!finalBody) {
          // Both attempts failed validation
          result.errors++;
          result.failed_tuples.push({
            intent_dim: tuple.intent_dim,
            source_dim: tuple.source_dim,
            reason: validation.reason,
          });
          await failRow(customerId, tuple, kvKey, validation.reason, env, pagePath, model);
          continue;
        }
      }

      // Lint, one revise pass, re-lint (docs/specs/generation-quality.md).
      const polished = await polish(
        finalBody,
        finalResult,
        {
          language: dna.target_language,
          allowedNumbers,
          allowedUnits,
          ownWords,
          emphasisSlots: emphasisSlotsOf(manifest),
          originalLengths: originalLengthsOf(manifest),
          originalTexts: originalTextsOf(full),
          templates: templatesOf(manifest),
          simulated: measuredOf(manifest),
          ctas,
          claimsLock: claimsLockFor(lock, read.text, full, domain),
          ...marketOf(tuple),
        },
        { cachedPreamble, env, intentDim: tuple.intent_dim, customerId, manifest },
        () => {
          if (callCount >= maxCalls) return false;
          callCount++;
          totalCalls++;
          return true;
        },
      );
      result.cost_usd += polished.extraCost;
      if (polished.cacheHit) cacheHits++;
      if (polished.hard.length > 0) {
        const reason = refusalReason(polished);
        result.errors++;
        result.failed_tuples.push({
          intent_dim: tuple.intent_dim,
          source_dim: tuple.source_dim,
          reason,
        });
        await failRow(customerId, tuple, kvKey, reason, env, pagePath, model);
        continue;
      }

      // Sanitize (strip em and en dashes, see sanitize.ts), then publish: the
      // immutable body, the live key with its id, the previous body retired
      // (docs/specs/proof-engine.md, C).
      // After go live a new body waits for the customer's OK unless the
      // customer turned that off (docs/specs/versions-approval.md).
      const sanitized = sanitizeVariantBody(polished.body);
      const stored = await storeVersion(
        env,
        {
          customerId,
          pagePath,
          intentDim: tuple.intent_dim,
          sourceDim: tuple.source_dim,
          language,
        },
        sanitized,
        { ...polished.result, lintFlags: rowLintFlags(polished) },
      );
      result.parts_as_built = (result.parts_as_built ?? 0) + (polished.asBuilt?.length ?? 0);
      const h = (sanitized.sections as Record<string, { headline?: unknown }>).hero?.headline;
      if (typeof h === "string") runHeadlines.push(h);

      result.generated++;
      result.kv_keys.push(kvKey);
      if (stored.state === "waiting") result.waiting = (result.waiting ?? 0) + 1;
    }
  }

  const sameness = headlineSameness(runHeadlines);
  if (sameness > 0.3) {
    console.warn(
      `[generate] ${Math.round(sameness * 100)}% of hero headline pairs are near-duplicates for ${customerId}`,
    );
  }

  result.cache_hit_rate = totalCalls > 0 ? cacheHits / totalCalls : 0;
  if (audit.audit) await addAuditSpend(env, customerId, result.cost_usd);
  // What is hidden follows what the versions write (lib/hidden-parts.ts): a
  // run that tried a version may have settled a page, or written a part no
  // version wrote before.
  if (attempted > 0) await refreshHideRules(env, customerId);

  return result;
}

/** The hide rules again after versions changed. Never a run's failure. */
async function refreshHideRules(env: OrchestrateEnv, customerId: string): Promise<void> {
  try {
    await writeHideRules(env, customerId);
  } catch (e) {
    console.error(
      `[generate] hide rules not rebuilt for ${customerId}:`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

// ---------------------------------------------------------------------------
// Single-tuple regeneration (used by /admin/variant/regenerate endpoint)
// ---------------------------------------------------------------------------

/** The answer of a regenerate on a page whose every part is a button that stays as built. */
export const NOTHING_TO_WRITE = "nothing_to_write";

export interface RegenerateOneResult {
  customer_id: string;
  intent_dim: string;
  source_dim: string;
  kv_key: string;
  cost_usd: number;
  ok: boolean;
  error?: string;
  /**
   * True when the written body waits for the customer's OK and visitors keep
   * the live one (docs/specs/versions-approval.md). Absent when it went live.
   */
  pending?: boolean;
  /** The written body (success only). */
  body?: VariantBody;
  /**
   * Parts the version leaves as the page built them (success only; empty
   * when none): each failed a hard rule after its own call, so the body does
   * not carry it (docs/specs/refused-versions.md).
   */
  parts_as_built?: PartAsBuilt[];
  /** What a D1 variants row needs, so a preview can be promoted at go-live. */
  provenance?: VariantProvenance;
}

export interface VariantProvenance {
  /** The id of the model that wrote it. */
  model: string;
  prompt_hash: string;
  cost_usd: number;
  lint_flags: string[];
}

/**
 * Regenerates a single (customerId, intentDim, sourceDim) variant.
 * Called by the admin API; same generation logic as the main orchestrator loop
 * but scoped to one tuple.
 */
export interface RegenerateOneOptions {
  /**
   * Preview mode (script-first onboarding): validate against this manifest
   * instead of the confirmed one, write the body under `kvKey` (never a
   * live variant key) and skip the D1 variants row. The caller promotes the
   * body at go-live with `publishVersion`.
   */
  preview?: { manifest: Manifest; kvKey: string; ttlSeconds: number; language?: string | null };
}

export async function regenerateOne(
  customerId: string,
  intentDim: IntentDim,
  sourceDim: string,
  env: OrchestrateEnv,
  pagePath = "/",
  options: RegenerateOneOptions = {},
): Promise<RegenerateOneResult> {
  const out = await regenerateCell(customerId, intentDim, sourceDim, env, pagePath, options);
  // A version of a live page was written or refused: the hide rules follow
  // (lib/hidden-parts.ts). A preview is no version, and nothing changed when
  // there was nothing to write.
  if (!options.preview && out.error !== NOTHING_TO_WRITE && out.error !== SENSITIVE_PAGE_CODE) {
    await refreshHideRules(env, customerId);
  }
  return out;
}

async function regenerateCell(
  customerId: string,
  intentDim: IntentDim,
  sourceDim: string,
  env: OrchestrateEnv,
  pagePath: string,
  options: RegenerateOneOptions,
): Promise<RegenerateOneResult> {
  const normalizedPath = normalizePath(pagePath);
  // The backstop behind the endpoints' 409 (docs/specs/sensitive-customers.md,
  // condition 2 and rule 4): no version, preview or live, for a page of a
  // sensitive customer outside `/` and its kept sections. Nothing is spent
  // and no error row is written.
  if (await sensitivePageRefusal(env.DB, customerId, normalizedPath)) {
    return {
      customer_id: customerId,
      intent_dim: intentDim,
      source_dim: sourceDim,
      kv_key:
        options.preview?.kvKey ??
        variantKeyForPath(customerId, normalizedPath, intentDim, sourceDim),
      cost_usd: 0,
      ok: false,
      error: SENSITIVE_PAGE_CODE,
    };
  }
  // The path's own language (docs/specs/per-language.md), preview or confirmed.
  const language =
    options.preview?.language ?? (await loadPathLanguage(customerId, env.DB, normalizedPath));
  const dna = await loadBusinessDNA(customerId, env.DB, language);
  // Load the manifest for THIS path (A1): the '/start' variant must validate
  // and prune against /start's own manifest, not the homepage's.
  const full =
    options.preview?.manifest ??
    (await loadConfirmedManifest(
      customerId,
      env.DB,
      pageFetcher(fetcherUserAgent(env)),
      normalizedPath,
      siteRereadHook(env, customerId),
    ));
  // What a version writes: the page's parts without the buttons that stay as
  // built (lib/button-rewrite.ts). `full` keeps them for the button facts.
  const manifest = full ? writtenManifest(full) : null;
  const domain = await loadCustomerDomain(customerId, env.DB);
  const read = await loadPageRead(customerId, domain, env);
  const samples = read.samples;
  const lock = (await loadSensitive(env.DB, customerId)).sensitive;
  const cachedPreamble = buildDnaPreamble(dna, samplesBesideTemplates(samples, [manifest]), {
    href: asksHref(manifest),
    claimsLock: lock,
  });
  const allowedNumbers = allowedNumbersFor(dna, samples);
  const allowedUnits = allowedUnitsFor(dna, samples);
  const tuple: GenerationTuple = { intent_dim: intentDim, source_dim: sourceDim as SourceDim };
  const ctas = ctasOf(
    full,
    pageLinksOf(customerId, normalizedPath),
    await loadCountedPaths(customerId, env.DB),
    await loadLinkKinds(customerId, domain, env.DB),
  );
  const kvKey =
    options.preview?.kvKey ?? variantKeyForPath(customerId, normalizedPath, intentDim, sourceDim);
  // Every part of this page is a button that stays as built: nothing to
  // write, nothing spent, and no error row (nothing failed).
  if (nothingToWrite(full)) {
    return {
      customer_id: customerId,
      intent_dim: intentDim,
      source_dim: sourceDim,
      kv_key: kvKey,
      cost_usd: 0,
      ok: false,
      error: NOTHING_TO_WRITE,
    };
  }
  const userPrompt = buildUserPrompt(tuple, dna, customerId, manifest, ctas);
  const model = writeModelId(env);
  const preview = options.preview;
  // Error rows are the dashboard's "why did this fail" trail; a preview has
  // no row, so failures surface in the quickstart response instead.
  const writeError = (reason: string) =>
    preview
      ? Promise.resolve()
      : failRow(customerId, tuple, kvKey, reason, env, normalizedPath, model);

  const firstResult = await callModel({ prompt: userPrompt, cachedPreamble, role: "write" }, env);

  if (!firstResult.ok) {
    await writeError(firstResult.error);
    return {
      customer_id: customerId,
      intent_dim: intentDim,
      source_dim: sourceDim,
      kv_key: kvKey,
      cost_usd: 0,
      ok: false,
      error: firstResult.error,
    };
  }

  const validation = safeValidate(firstResult.value.text, intentDim, customerId, manifest);

  let finalBody: VariantBody | null = null;
  let finalResult = firstResult.value;

  if (validation.ok) {
    finalBody = validation.body;
    if (validation.pruned?.length) {
      console.warn(
        `[regenerateOne] pruned ${validation.pruned.length} off-manifest leaf(s) from ${kvKey}: ${validation.pruned.join(", ")}`,
      );
    }
  } else {
    // One retry
    const correctivePrompt = buildCorrectivePrompt(userPrompt, validation.reason);
    const retryResult = await callModel(
      { prompt: correctivePrompt, cachedPreamble, role: "write" },
      env,
    );
    if (retryResult.ok) {
      finalResult = retryResult.value;
      const retryValidation = safeValidate(retryResult.value.text, intentDim, customerId, manifest);
      if (retryValidation.ok) {
        finalBody = retryValidation.body;
      }
    }
  }

  if (!finalBody) {
    const reason = validation.ok ? "retry failed" : validation.reason;
    await writeError(reason);
    return {
      customer_id: customerId,
      intent_dim: intentDim,
      source_dim: sourceDim,
      kv_key: kvKey,
      cost_usd: firstResult.value.costUsd,
      ok: false,
      error: reason,
    };
  }

  const polished = await polish(
    finalBody,
    finalResult,
    {
      language: dna.target_language,
      allowedNumbers,
      allowedUnits,
      ownWords: ownWordsFor(dna, samples),
      emphasisSlots: emphasisSlotsOf(manifest),
      originalLengths: originalLengthsOf(manifest),
      originalTexts: originalTextsOf(full),
      templates: templatesOf(manifest),
      simulated: measuredOf(manifest),
      ctas,
      claimsLock: claimsLockFor(lock, read.text, full, domain),
      ...marketOf(tuple),
    },
    { cachedPreamble, env, intentDim, customerId, manifest },
    () => true,
  );
  if (polished.hard.length > 0) {
    const reason = refusalReason(polished);
    await writeError(reason);
    return {
      customer_id: customerId,
      intent_dim: intentDim,
      source_dim: sourceDim,
      kv_key: kvKey,
      cost_usd: finalResult.costUsd + polished.extraCost,
      ok: false,
      error: reason,
    };
  }

  // Sanitize (strip em and en dashes, see sanitize.ts), then the preview key,
  // or publish (docs/specs/proof-engine.md, C).
  const sanitized = sanitizeVariantBody(polished.body);
  const lintFlags = rowLintFlags(polished);
  let served: VariantBody = sanitized;
  let waiting = false;
  if (preview) {
    await putPreviewBody(env, preview.kvKey, sanitized, preview.ttlSeconds);
  } else {
    // Live, or waiting for the customer's OK (docs/specs/versions-approval.md).
    const stored = await storeVersion(
      env,
      { customerId, pagePath: normalizedPath, intentDim, sourceDim: tuple.source_dim, language },
      sanitized,
      { ...polished.result, lintFlags },
    );
    served = stored.body;
    waiting = stored.state === "waiting";
  }

  return {
    customer_id: customerId,
    intent_dim: intentDim,
    source_dim: sourceDim,
    kv_key: kvKey,
    cost_usd: finalResult.costUsd + polished.extraCost,
    ok: true,
    ...(waiting ? { pending: true } : {}),
    body: served,
    parts_as_built: polished.asBuilt ?? [],
    provenance: {
      model: polished.result.model,
      prompt_hash: polished.result.promptHash,
      cost_usd: finalResult.costUsd + polished.extraCost,
      lint_flags: lintFlags,
    },
  };
}

/**
 * A try that failed: the error row, and the time of the try for the write
 * queue (lib/tried-marker.ts). Every failure is recorded, a refusal by the
 * copy checks and a provider that did not answer alike: the queue's rule is
 * six hours between tries of one row, whatever stopped it.
 */
async function failRow(
  customerId: string,
  tuple: GenerationTuple,
  kvKey: string,
  reason: string,
  env: OrchestrateEnv,
  pagePath: string,
  model: string,
): Promise<void> {
  await writeErrorRow(customerId, tuple, kvKey, reason, env.DB, pagePath, model);
  await markTried(env.VARIANTS, kvKey);
}

// ---------------------------------------------------------------------------
/**
 * Hide rules for the per-customer script, written when the KV key is missing.
 * The rich key (2026-09-30) is checked too: a customer confirmed before it
 * gets it on the write queue's next pass for them, not six hours later.
 */
async function ensureHideRules(customerId: string, env: OrchestrateEnv): Promise<void> {
  try {
    const [hide, rich, bundle] = await Promise.all([
      env.VARIANTS.get(hideRulesKey(customerId)),
      env.VARIANTS.get(richKey(customerId)),
      env.VARIANTS.get(visitorBundleKey(customerId)),
    ]);
    if (hide !== null && rich !== null && bundle !== null) return;
    await writeHideRules(env, customerId);
  } catch {
    // Best effort: the next run tries again; the script keeps working without rules.
  }
}

/** The original's text signature per slot, for the same-as-original lint. */
export function originalTextsOf(manifest: Manifest | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!manifest) return out;
  for (const [path, e] of Object.entries(manifest)) {
    const sig = e.text[0];
    if (typeof sig === "string" && sig.length > 0) out.set(path, sig);
  }
  return out;
}

/**
 * The claims lock of a sensitive customer (docs/specs/claims-lock.md): the
 * page's own text and the originals of the page being written. Undefined
 * for any other customer, and then the lint reads none of it.
 */
export function claimsLockFor(
  sensitive: boolean,
  pageText: string,
  full: Manifest | null | undefined,
  domain?: string | null,
): ClaimsLock | undefined {
  if (!sensitive) return undefined;
  return {
    pageWords: [pageText, ...originalTextsOf(full).values()].join("\n"),
    brand: brandOf(domain),
  };
}

/** The original's visible character count per slot, for the length-drift lint. */
export function originalLengthsOf(manifest: Manifest | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!manifest) return out;
  for (const [path, e] of Object.entries(manifest)) {
    if (typeof e.original_char_length === "number") out.set(path, e.original_char_length);
  }
  return out;
}

/** The page's template per slot built word by word (docs/specs/template-writing.md §3). */
const LENGTH_SUFFIXES = ["", "_alt", "_alt2"] as const;

/** The object holding a manifest path's last key inside `sections`, or null. */
function holderOf(
  sections: Record<string, unknown>,
  path: string,
): { holder: Record<string, unknown>; key: string } | null {
  const parts = path.split(".");
  const key = parts.pop();
  let node: unknown = sections;
  for (const p of parts) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[p];
  }
  if (!key || typeof node !== "object" || node === null || Array.isArray(node)) return null;
  return { holder: node as Record<string, unknown>, key };
}

/**
 * Every length of a part built word by word, written by the model as a list
 * of words per run, becomes the page's template filled with them. A base
 * list that does not fit becomes an empty string, so the part fails its
 * checks instead of shipping half a structure; another length that does not
 * fit is left out.
 */
export function fillTemplates(sections: Record<string, unknown>, manifest: Manifest | null): void {
  for (const [path, page] of templatesOf(manifest)) {
    const at = holderOf(sections, path);
    if (!at) continue;
    fillLengths(at, page);
    const metrics = manifest?.[path]?.metrics;
    // A measured page decides by its wrap; otherwise the last-line cap holds
    // a page's fixed lines and rotating word, and a headline with neither (a
    // word split into letters) wraps as plain text.
    if (metrics) selectByWrap(at, metrics, templateLength(page), page);
    else if (hasFixedLines(page)) fitLengths(at, page);
  }
  // Any other part that came back as a list of strings is one sentence: the
  // model, shown a template beside it, answered a plain part in its form
  // (the lab's framer-letters, 2026-09-29: nine versions failed on an empty body).
  for (const path of Object.keys(manifest ?? {})) {
    const at = holderOf(sections, path);
    if (!at) continue;
    for (const suffix of LENGTH_SUFFIXES) {
      const k = `${at.key}${suffix}`;
      const v = at.holder[k];
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) at.holder[k] = v.join(" ");
    }
    const entry = manifest?.[path];
    if (entry?.metrics && !entry.inline?.template)
      selectByWrap(at, entry.metrics, entry.original_char_length ?? 0);
    // Never shipped: the extra candidates only feed the choice.
    delete at.holder[`${at.key}_more`];
  }
}

interface Reading {
  path: string;
  /** The length it came from; "spare" for a candidate kept aside. */
  suffix: (typeof LENGTH_SUFFIXES)[number] | "spare";
  /** The candidate (a template) this sentence is one reading of. */
  cand: string;
  text: string;
}

/**
 * Every sentence a visitor will read in a part with a rotating word, one
 * per word per length, judged in one cheap call (docs/specs/interactive-text.md
 * §3.5): the last line before the rotating word read badly in about a
 * quarter of the lab's versions ("and greets them read"). Returns the
 * readings judged bad and the call's cost; null when there is nothing to
 * judge or the call failed.
 */
export async function judgeReadings(
  body: VariantBody,
  call: Parameters<typeof polishLint>[3],
  language: string,
  budget: () => boolean = () => true,
): Promise<{ bad: Reading[]; cost: number } | null> {
  const sections = body.sections as unknown as Record<string, unknown>;
  const items: Reading[] = [];
  for (const [path, page] of templatesOf(call.manifest)) {
    if (!page.includes("{rot:")) continue;
    const at = holderOf(sections, path);
    if (!at) continue;
    for (const suffix of LENGTH_SUFFIXES) {
      const v = at.holder[`${at.key}${suffix}`];
      if (typeof v !== "string" || !v.includes("{rot:")) continue;
      for (const text of templateReadings(v)) items.push({ path, suffix, cand: v, text });
    }
    for (const v of sparesOf(body, path)) {
      if (!v.includes("{rot:")) continue;
      for (const text of templateReadings(v)) items.push({ path, suffix: "spare", cand: v, text });
    }
  }
  // Only a call that has something to judge counts against the run's calls.
  if (items.length === 0 || !budget()) return null;
  const prompt = `Language: ${language}. Each numbered line is a headline a visitor reads on a website; the
last word before the full stop changes as the page rotates it. For each line, decide whether it
is a grammatical sentence a native speaker could write. Plain or unusual wording is fine; mark
only lines that break grammar or make no sense. Reply with JSON only:
{"bad": [the numbers of the lines that are not grammatical]}.

${items.map((x, i) => `${i + 1}. ${x.text}`).join("\n")}`;
  // A yes or no per line, no copy: the read role.
  const res = await callModel({ prompt, role: "read", maxTokens: 300, jsonMode: true }, call.env);
  if (!res.ok) return null;
  let nums: unknown = [];
  try {
    const t = res.value.text;
    nums = (
      JSON.parse(jsonrepair(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1))) as { bad?: unknown }
    ).bad;
  } catch {
    return { bad: [], cost: res.value.costUsd };
  }
  const bad = (Array.isArray(nums) ? nums : [])
    .map((n) => items[Number(n) - 1])
    .filter((x): x is Reading => x !== undefined);
  return { bad, cost: res.value.costUsd };
}

/**
 * The candidates of each rotating part put in order again after a grammar
 * verdict: those with no bad reading, best first (the first length, the
 * other two, then the spares), the first of them that also passes the lint
 * as the first length. Returns the parts left with no good candidate.
 */
function regroup(
  body: VariantBody,
  bad: readonly Reading[],
  lintCtx: Parameters<typeof polishLint>[2],
  manifest: Manifest | null,
): string[] {
  const failing: string[] = [];
  const badCands = new Set(bad.map((r) => r.cand));
  const sections = body.sections as unknown as Record<string, unknown>;
  for (const path of new Set(bad.map((r) => r.path))) {
    const at = holderOf(sections, path);
    if (!at) continue;
    const cands = [
      ...LENGTH_SUFFIXES.map((sfx) => at.holder[`${at.key}${sfx}`]).filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      ),
      ...sparesOf(body, path),
    ];
    const good = [...new Set(cands)].filter((t) => !badCands.has(t));
    if (good.length === 0) {
      failing.push(path);
      continue;
    }
    const passes = (t: string) => {
      at.holder[at.key] = t;
      return !lintVariant(body, lintCtx).hard.some((f) => f.path === path);
    };
    const first = good.find(passes) ?? (good[0] as string);
    at.holder[at.key] = first;
    const rest = good.filter((t) => t !== first);
    for (const [k, t] of [
      ["_alt", rest[0]],
      ["_alt2", rest[1]],
    ] as const) {
      if (t) at.holder[`${at.key}${k}`] = t;
      else delete at.holder[`${at.key}${k}`];
    }
    const sp = spares.get(at.holder);
    if (sp) sp.list = rest.slice(2);
  }
  void manifest;
  return failing;
}

/**
 * The grammar check in the polish: every reading of every candidate (the
 * three kept and the spares) judged in one call; the candidates that read
 * well are put in order; a part with none gets one revise pass told which
 * sentence, judged again, and fails if still none reads well.
 */
export async function checkGrammar(
  out: PolishOutcome,
  lintCtx: Parameters<typeof polishLint>[2],
  call: Parameters<typeof polishLint>[3],
  budget: () => boolean,
): Promise<PolishOutcome> {
  const first = await judgeReadings(out.body, call, lintCtx.language, budget);
  if (!first) return out;
  let cost = out.extraCost + first.cost;
  if (first.bad.length === 0) return { ...out, extraCost: cost };
  let body = out.body;
  let soft = out.soft;
  let failing = regroup(body, first.bad, lintCtx, call.manifest);
  if (failing.length > 0 && budget()) {
    const flags: LintFlag[] = first.bad
      .filter((r) => failing.includes(r.path) && r.suffix === "")
      .map((r) => ({
        path: r.path,
        rule: "rotator-grammar",
        excerpt: `"${r.text}" does not read as a sentence; rewrite the words around the rotating word so it reads naturally with every word it rotates`,
        severity: "hard",
      }));
    const revised = await callModel(
      {
        prompt: buildRevisePrompt(JSON.stringify(withTemplateEntries(body, call.manifest)), flags),
        cachedPreamble: call.cachedPreamble,
        role: "write",
      },
      call.env,
    );
    if (revised.ok) {
      cost += revised.value.costUsd;
      const v = safeValidate(revised.value.text, call.intentDim, call.customerId, call.manifest);
      if (v.ok) {
        keepBuiltTemplates(body, v.body, call.manifest);
        const lint = lintVariant(v.body, lintCtx);
        if (lint.hard.length === 0) {
          const again = await judgeReadings(v.body, call, lintCtx.language, budget);
          if (again) {
            cost += again.cost;
            body = v.body;
            soft = lint.soft;
            failing = regroup(body, again.bad, lintCtx, call.manifest);
          }
        }
      }
    }
  }
  const hard: LintFlag[] = failing.map((path) => ({
    path,
    rule: "rotator-grammar",
    excerpt: `"${first.bad.find((r) => r.path === path)?.text ?? ""}" does not read as a sentence`,
    severity: "hard",
  }));
  return { ...out, body, soft, hard, extraCost: cost };
}

/** Headlines the page measured (their lengths chosen by the wrap simulation). */
export function measuredOf(manifest: Manifest | null): Set<string> {
  return new Set(
    Object.entries(manifest ?? {})
      .filter(([, e]) => e.metrics && !e.skip)
      .map(([path]) => path),
  );
}

/**
 * The three that hold the page's lines (docs/specs/interactive-text.md §3.4):
 * every candidate the model wrote (the first, its two other lengths and the
 * `_more` list) wrapped at 1280, 768 and 390 px with the page's own font,
 * ranked by how far it is from the page's line counts, then by how close
 * its length is to the page's; the best becomes the first, the next two
 * the other lengths. Copies and broken templates are left out.
 */
export function selectByWrap(
  at: { holder: Record<string, unknown>; key: string },
  metrics: WrapMetrics,
  original: number,
  page?: string,
): void {
  const raw: unknown[] = LENGTH_SUFFIXES.map((s) => at.holder[`${at.key}${s}`]);
  const more = at.holder[`${at.key}_more`];
  if (Array.isArray(more)) raw.push(...more);
  delete at.holder[`${at.key}_more`];
  const seen = new Set<string>();
  const cands: string[] = [];
  for (const v of raw) {
    let text: string | null = null;
    if (typeof v === "string") text = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string"))
      text = page ? fillTemplate(page, v as string[]) : (v as string[]).join(" ");
    if (!text?.trim()) continue;
    if (page && templateViolations(page, text).length > 0) continue;
    const key = (page ? templateText(text) : text).replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cands.push(text);
  }
  if (cands.length === 0) return;
  const len = (t: string) => (page ? templateLength(t) : t.length);
  const ranked = cands
    .map((t, i) => ({ t, i, s: holdScore(t, metrics, page) }))
    .sort(
      (a, b) =>
        a.s - b.s || Math.abs(len(a.t) - original) - Math.abs(len(b.t) - original) || a.i - b.i,
    );
  // One of the three is safely short (docs/decisions/0031): the snippet
  // brings a length under the page's to its own line count at any width,
  // while the simulation sees three widths only, measured once (the
  // Webflow test page's box had grown from 832 to 920 px since).
  const short = (r: { t: string }) => len(r.t) <= original * SHORT_HEADLINE;
  if (!ranked.slice(0, 2).some(short)) {
    const s = ranked.findIndex((r, i) => i >= 2 && short(r));
    if (s > 2) ranked.splice(2, 0, ...ranked.splice(s, 1));
  }
  at.holder[at.key] = ranked[0]?.t ?? "";
  for (const [k, r] of [
    ["_alt", ranked[1]],
    ["_alt2", ranked[2]],
  ] as const) {
    if (r) at.holder[`${at.key}${k}`] = r.t;
    else delete at.holder[`${at.key}${k}`];
  }
  // The rest wait beside the part, never shipped: when a check turns the
  // first down, one of these takes its place before any revise call (the lab
  // rewrite, 2026-09-29: the grammar check failed half the versions while
  // three unread candidates had been thrown away).
  spares.set(at.holder, { key: at.key, list: ranked.slice(3).map((r) => r.t) });
}

/** Candidates the wrap simulation ranked below the three kept, by the part's holder. */
const spares = new WeakMap<object, { key: string; list: string[] }>();

/** The spares of a part in a body, best first. */
function sparesOf(body: VariantBody, path: string): string[] {
  const at = holderOf(body.sections as unknown as Record<string, unknown>, path);
  const s = at ? spares.get(at.holder) : undefined;
  return s && at && s.key === at.key ? s.list : [];
}

/**
 * A first length the lint turned down is replaced, before any revise call,
 * by the best other length or spare that passes: the model wrote six, the
 * simulation ranked them, and a lint verdict on one should not cost two
 * more calls while five others wait.
 */
export function promotePassing(
  body: VariantBody,
  lintCtx: Parameters<typeof polishLint>[2],
  manifest: Manifest | null,
): ReturnType<typeof lintVariant> {
  let result = lintVariant(body, lintCtx);
  const sections = body.sections as unknown as Record<string, unknown>;
  for (const path of measuredOf(manifest)) {
    const at = holderOf(sections, path);
    if (!at) continue;
    const pool = sparesOf(body, path).slice();
    const fails = (slot: string) => result.hard.some((f) => f.path === slot);
    // Try a text in a slot; keep it when the slot then passes.
    const tryIn = (key: string, text: string): boolean => {
      const before = at.holder[key];
      at.holder[key] = text;
      const next = lintVariant(body, lintCtx);
      if (!next.hard.some((f) => f.path === `${path}${key.slice(at.key.length)}`)) {
        result = next;
        return true;
      }
      at.holder[key] = before;
      return false;
    };
    if (fails(path)) {
      // An other length that passes moves up; its slot is left for a spare.
      const moved = (["_alt", "_alt2"] as const).find((sfx) => {
        const v = at.holder[`${at.key}${sfx}`];
        if (typeof v !== "string" || fails(`${path}${sfx}`)) return false;
        if (!tryIn(at.key, v)) return false;
        delete at.holder[`${at.key}${sfx}`];
        result = lintVariant(body, lintCtx);
        return true;
      });
      if (!moved) {
        const k = pool.findIndex((t) => tryIn(at.key, t));
        if (k >= 0) pool.splice(k, 1);
      }
    }
    for (const sfx of ["_alt", "_alt2"] as const) {
      const key = `${at.key}${sfx}`;
      if (typeof at.holder[key] === "string" && !fails(`${path}${sfx}`)) continue;
      const k = pool.findIndex((t) => tryIn(key, t));
      if (k >= 0) pool.splice(k, 1);
      else if (fails(`${path}${sfx}`)) {
        delete at.holder[key];
        result = lintVariant(body, lintCtx);
      }
    }
    const s = spares.get(at.holder);
    if (s) s.list = pool;
  }
  return result;
}

/** A template with lines the page fixed or a word it rotates. */
export function hasFixedLines(template: string): boolean {
  return /\{br\}|\{rot:/.test(template);
}

/**
 * The lengths against the page's lines (docs/specs/template-writing.md,
 * 2026-09-28): another length whose last line is longer than the page's
 * would flip a line as the words rotate, so it is left out; a base whose
 * last line is over gives its place to another length whose last line fits.
 */
function fitLengths(at: { holder: Record<string, unknown>; key: string }, page: string): void {
  const good = (v: unknown): v is string =>
    typeof v === "string" && templateViolations(page, v).length === 0;
  for (const suffix of ["_alt", "_alt2"] as const) {
    const k = `${at.key}${suffix}`;
    const v = at.holder[k];
    if (good(v) && templateLineMisses(page, v).some((m) => m.last && m.n > m.hi))
      delete at.holder[k];
  }
  const over = (v: string) => templateLineMisses(page, v).some((m) => m.last && m.n > m.hi);
  const base = at.holder[at.key];
  if (!good(base) || !over(base)) return;
  for (const suffix of ["_alt", "_alt2"] as const) {
    const k = `${at.key}${suffix}`;
    const v = at.holder[k];
    if (good(v) && !over(v)) {
      at.holder[k] = base;
      at.holder[at.key] = v;
      return;
    }
  }
}

/** Each length's word list built into the page's template. */
function fillLengths(at: { holder: Record<string, unknown>; key: string }, page: string): void {
  for (const suffix of LENGTH_SUFFIXES) {
    const k = `${at.key}${suffix}`;
    const v = at.holder[k];
    // Another length that arrives as a broken template is left out; the
    // base carries the part (the lab rewrite, 2026-09-28: one _alt as a
    // plain sentence failed a whole version).
    if (typeof v === "string" && suffix !== "" && templateViolations(page, v).length > 0) {
      delete at.holder[k];
      continue;
    }
    if (!Array.isArray(v)) continue;
    const filled = fillTemplate(page, v);
    // A base that does not fit fails its checks; another length is optional.
    if (filled !== null) at.holder[k] = filled;
    else if (suffix === "") at.holder[k] = "";
    else delete at.holder[k];
  }
}

/**
 * The body as the revise pass sees it: a part built word by word back as its
 * word lists, so the model edits words and never tokens.
 */
export function withTemplateEntries(body: VariantBody, manifest: Manifest | null): VariantBody {
  const templates = templatesOf(manifest);
  if (templates.size === 0) return body;
  const copy = JSON.parse(JSON.stringify(body)) as VariantBody;
  const sections = copy.sections as unknown as Record<string, unknown>;
  for (const [path, page] of templates) {
    const at = holderOf(sections, path);
    if (!at) continue;
    for (const suffix of LENGTH_SUFFIXES) {
      const k = `${at.key}${suffix}`;
      const v = at.holder[k];
      if (typeof v !== "string") continue;
      const entries = templateEntries(page, v);
      if (entries) at.holder[k] = entries;
    }
  }
  return copy;
}

/**
 * A revise pass that broke a part built word by word (the lab trial,
 * 2026-09-28: asked to fix one length, it returned the headline as a plain
 * sentence) gives that part back its last good value, length by length.
 */
export function keepBuiltTemplates(
  before: VariantBody,
  after: VariantBody,
  manifest: Manifest | null,
): void {
  const prev = before.sections as unknown as Record<string, unknown>;
  const next = after.sections as unknown as Record<string, unknown>;
  for (const [path, page] of templatesOf(manifest)) {
    const was = holderOf(prev, path);
    const now = holderOf(next, path);
    if (!was || !now) continue;
    for (const suffix of LENGTH_SUFFIXES) {
      const k = `${was.key}${suffix}`;
      const v = now.holder[k];
      const good = (x: unknown): x is string =>
        typeof x === "string" && templateViolations(page, x).length === 0;
      if (v === undefined || good(v)) continue;
      const old = was.holder[k];
      if (good(old)) now.holder[k] = old;
      else if (suffix !== "") delete now.holder[k];
    }
  }
}

export function templatesOf(manifest: Manifest | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!manifest) return out;
  for (const [path, e] of Object.entries(manifest)) {
    const t = e.inline?.template;
    if (typeof t === "string" && t.length > 0 && !e.skip) out.set(path, t);
  }
  return out;
}

/** Slots whose original emphasises a phrase (docs/specs/design-preserving-rewrite.md §2). */
export function emphasisSlotsOf(manifest: Manifest | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!manifest) return out;
  for (const [path, e] of Object.entries(manifest)) {
    if ((e.inline?.emphasis ?? 0) >= 1 && !e.skip) out.add(path);
  }
  return out;
}

// Lint + one revise pass
// ---------------------------------------------------------------------------

interface PolishOutcome {
  body: VariantBody;
  result: GenerateResult;
  hard: LintFlag[];
  soft: LintFlag[];
  extraCost: number;
  cacheHit: boolean;
  /** Parts left as the page built them (docs/specs/refused-versions.md, step 3). */
  asBuilt?: PartAsBuilt[];
  /** The parts the version wrote before any was left as built. */
  partsWritten?: number;
  /** Why the row is refused although parts could be left as built (step 4). */
  refusal?: string;
}

/** What a row stores in `lint_flags`: the soft rules, then the parts left as built. */
export function rowLintFlags(p: Pick<PolishOutcome, "soft" | "asBuilt">): string[] {
  return [...p.soft.map((f) => f.rule), ...(p.asBuilt ?? []).map(partAsBuiltFlag)];
}

/**
 * The `error_reason` of a refused row. "lint:" first, so the ops summary and
 * the queue read it as a verdict of the copy checks and not as an outage.
 */
export function refusalReason(p: Pick<PolishOutcome, "hard" | "refusal">): string {
  const flags = p.hard.map((f) => `${f.path} ${f.rule} (${f.excerpt})`).join("; ");
  return `lint: ${p.refusal ? `${p.refusal}; ` : ""}${flags}`;
}

/**
 * The lint pass, then new other lengths for a part built word by word
 * whose lengths came back as the same text (the lab, 2026-09-28: three keys
 * with three identical lengths left the fit check nothing to choose from).
 */
async function polish(
  body: VariantBody,
  result: GenerateResult,
  lintCtx: Parameters<typeof polishLint>[2],
  call: Parameters<typeof polishLint>[3],
  budget: () => boolean,
): Promise<PolishOutcome> {
  const out = await polishLengths(body, result, lintCtx, call, budget);
  if (out.hard.length > 0) return out;
  const short = await shortenMissing(out, lintCtx, call, budget);
  if (short.hard.length > 0) return short;
  return keepAsBuilt(await markEmphasis(short, lintCtx, call, budget), lintCtx);
}

/**
 * One call per part that still has no safely short length after the revise
 * pass (docs/decisions/0031): the model is shown the part's own text and
 * asked for the same idea in at most N characters, twice at most, the
 * second told how long the first came back. Kept only when it is that
 * short and the version still passes the lint; otherwise the part keeps
 * its lengths. The Webflow rewrite, 2026-09-30: four of 30 versions kept a
 * paragraph whose three lengths were 151 to 156 against the page's 153,
 * and at 360 px each took a line more.
 */
export async function shortenMissing(
  out: PolishOutcome,
  lintCtx: Parameters<typeof polishLint>[2],
  call: Parameters<typeof polishLint>[3],
  budget: () => boolean,
): Promise<PolishOutcome> {
  const flags = out.soft.filter((f) => f.rule === "short-missing");
  if (flags.length === 0) return out;
  const templates = call.manifest ? templatesOf(call.manifest) : new Map();
  const sections = out.body.sections as unknown as Record<string, unknown>;
  let cost = 0;
  for (const f of flags) {
    const path = f.path.replace(/_alt2?$/, "");
    if (templates.has(path)) continue;
    const original = lintCtx.originalLengths?.get(path);
    const at = holderOf(sections, f.path);
    const base = at && holderOf(sections, path);
    const text = base?.holder[base.key];
    if (!at || !original || typeof text !== "string") continue;
    const head = path.endsWith(".headline");
    const max = Math.floor(original * (head ? HEADLINE_ALT2_CAP : PARAGRAPH_ALT_CAP));
    // Asked for 85% (90%), kept at the lint's own line, 88% (92%).
    const keep = Math.floor(original * (head ? SHORT_HEADLINE : SHORT_PARAGRAPH));
    const phrase = /\*([^*]+)\*/.exec(text)?.[1];
    let feedback = "";
    // Three tries, each told what the last one missed (a pilot site, 2026-09-30:
    // the short English headline came back without its asterisks and the
    // lint turned it down; the Azerbaijani one stopped at 28 for 25).
    for (let attempt = 0; attempt < 3 && budget(); attempt++) {
      const prompt = `This ${head ? "headline" : "paragraph"} is on a web page:
${JSON.stringify(text)}
Write the same idea in at most ${max} characters, counting spaces: drop a clause or a word, never a fact, a number or a name, same language and voice${phrase ? ", and keep the phrase between asterisks, with its asterisks, *like this*" : ""}. A complete ${head ? "sentence" : "text"}, not the one above cut off.${feedback}
Output JSON only: {"text": "..."}`;
      const r = await callModel(
        { prompt, cachedPreamble: call.cachedPreamble, role: "write" },
        call.env,
      );
      if (!r.ok) break;
      cost += r.value.costUsd;
      let short = "";
      try {
        const t = r.value.text;
        const parsed = JSON.parse(jsonrepair(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)));
        short = typeof parsed.text === "string" ? parsed.text.trim() : "";
      } catch {
        continue;
      }
      // The emphasised phrase kept word for word but its asterisks dropped:
      // code puts them back.
      if (phrase && !short.includes("*") && short.includes(phrase))
        short = short.replace(phrase, `*${phrase}*`);
      const n = short.replace(/\*/g, "").length;
      if (!short || n > keep) {
        feedback = `\nLast time it came back at ${n} characters; at most ${max}.`;
        continue;
      }
      const before = at.holder[at.key];
      at.holder[at.key] = short;
      const hard = lintVariant(out.body, lintCtx).hard.filter((h) => h.path === f.path);
      if (hard.length === 0) break;
      at.holder[at.key] = before;
      feedback = `\nLast time: ${hard.map((h) => `${h.rule} (${h.excerpt})`).join("; ")}.`;
    }
  }
  if (cost === 0) return out;
  const again = lintVariant(out.body, lintCtx);
  return { ...out, soft: again.soft, extraCost: out.extraCost + cost };
}

/** The label rules a call for the label alone can mend. */
const LABEL_RULES: ReadonlySet<string> = new Set([
  "length-drift",
  "cta-action-changed",
  "cta-object-changed",
  "cta-duplicates-counted",
]);

/** True when every hard flag is one a call for the label alone can mend. */
function onlyLabelFlags(hard: readonly LintFlag[]): boolean {
  return hard.length > 0 && hard.every((f) => isButtonLabelPath(f.path) && LABEL_RULES.has(f.rule));
}

/**
 * A version refused only for its button labels is mended label by label
 * instead (the measure-lab QA, 2026-10-05): four of its five refused rows
 * were hero.cta.label at 16 characters against a cap of 13, and a new
 * customer has no earlier body, so visitors got the nearest version instead.
 * One call per label, the label alone: at most N characters, the same
 * action, never another button's words; twice at most, the second told what
 * the first missed. A new label is kept only when its own flags are gone and
 * it brings no new hard flag. A row with any other hard flag is not taken
 * here: its parts get their calls in `leavePartsAsBuilt`.
 */
export async function fixLabels(
  out: PolishOutcome,
  lintCtx: Parameters<typeof polishLint>[2],
  call: Parameters<typeof polishLint>[3],
  budget: () => boolean,
): Promise<PolishOutcome> {
  if (!onlyLabelFlags(out.hard)) return out;
  let cost = 0;
  for (const path of new Set(out.hard.map((f) => f.path))) {
    cost += await mendLabel(out.body, path, lintCtx, call, budget, 2);
  }
  if (cost === 0) return out;
  const again = lintVariant(out.body, lintCtx);
  return { ...out, hard: again.hard, soft: again.soft, extraCost: out.extraCost + cost };
}

/**
 * The call for one button label alone, `attempts` times at most, each told
 * what the one before missed. The new label stays only when the label has no
 * hard flag left and no new one appeared anywhere. Returns what it cost.
 */
async function mendLabel(
  body: VariantBody,
  path: string,
  lintCtx: Parameters<typeof polishLint>[2],
  call: Parameters<typeof polishLint>[3],
  budget: () => boolean,
  attempts: number,
): Promise<number> {
  const sections = body.sections as unknown as Record<string, unknown>;
  const flagKeys = () => new Set(lintVariant(body, lintCtx).hard.map((h) => `${h.path}|${h.rule}`));
  const at = holderOf(sections, path);
  const text = at?.holder[at.key];
  if (!at || typeof text !== "string") return 0;
  const original = lintCtx.originalLengths?.get(path);
  const cap = original === undefined ? undefined : labelCap(path, original);
  const facts = lintCtx.ctas?.get(path);
  const own = lintCtx.originalTexts?.get(path);
  // The words the other buttons show: never this one's too.
  const avoid = [...(lintCtx.ctas?.keys() ?? [])]
    .filter((p) => p !== path)
    .map((p) => {
      const o = holderOf(sections, p);
      const v = o?.holder[o.key];
      return typeof v === "string" ? v : lintCtx.originalTexts?.get(p);
    })
    .filter((v): v is string => typeof v === "string" && v.trim() !== "");
  const action =
    facts && facts.kinds.size > 0
      ? `, and the same action: ${describeKinds(facts.kinds)}`
      : facts?.unread
        ? `, and the same action: ${KEEP_OWN_ACTION}`
        : "";
  // What the page's own label names (the first outside pilot, A1.6): the label
  // keeps it. Read from that label alone, as the lint reads it.
  const lang = lintCtx.language.split("-")[0]?.toLowerCase() ?? lintCtx.language;
  const objects = own && own.length < LABEL_SIGNATURE_MAX ? ctaObjectsOf(own, lang) : [];
  const object = objects.length > 0 ? `, and the same thing: ${keepObjectLine(objects)}` : "";
  let cost = 0;
  let feedback = "";
  for (let attempt = 0; attempt < attempts && budget(); attempt++) {
    const before = flagKeys();
    const prompt = `This button label is on a web page: ${JSON.stringify(text)}${own ? `. The page's own button says ${JSON.stringify(own)}` : ""}.
Write the label again for the same visitor${cap ? ` in at most ${cap} characters, counting spaces` : ""}, in the same language and voice${action}${object}. A short button label, no full stop${avoid.length > 0 ? `, and not ${avoid.map((a) => JSON.stringify(a)).join(" or ")}: another button of the page says that` : ""}.${feedback}
Output JSON only: {"label": "..."}`;
    const r = await callModel(
      { prompt, cachedPreamble: call.cachedPreamble, role: "write" },
      call.env,
    );
    if (!r.ok) break;
    cost += r.value.costUsd;
    let label = "";
    try {
      const raw = r.value.text;
      const parsed = JSON.parse(
        jsonrepair(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)),
      ) as { label?: unknown };
      label = typeof parsed.label === "string" ? parsed.label.trim() : "";
    } catch {
      feedback = `\nLast time the answer was not JSON with a "label" field.`;
      continue;
    }
    if (label === "") {
      feedback = "\nLast time the label was empty.";
      continue;
    }
    const was = at.holder[at.key];
    at.holder[at.key] = label;
    const fresh = lintVariant(body, lintCtx).hard.filter(
      (h) => h.path === path || !before.has(`${h.path}|${h.rule}`),
    );
    if (fresh.length === 0) break;
    at.holder[at.key] = was;
    feedback = `\nLast time: ${JSON.stringify(label)}, ${fresh.map((h) => `${h.rule} (${h.excerpt})`).join("; ")}.`;
  }
  return cost;
}

// ---------------------------------------------------------------------------
// One part must not cost the version (docs/specs/refused-versions.md)
// ---------------------------------------------------------------------------

/** At most this many parts of a row get a call of their own (step 1). */
export const PART_CALLS_PER_ROW = 3;

/**
 * Hard rules about two parts together (a sentence used twice, two parts
 * with the same words). No part is left as built for one of these: when it
 * still holds among the parts that are left, the row is refused (step 4).
 */
function togetherRule(rule: string): boolean {
  return rule.startsWith("slot-duplicate:") || rule.startsWith("sentence-reuse:");
}

/** The rules that say a part built word by word lost the page's structure. */
const STRUCTURE_RULES: ReadonlySet<string> = new Set([
  "template-markers",
  "template-glyphs",
  "template-lines",
  "template-rotator",
  "template-groups",
  "template-words",
]);

/** The part a flag's path belongs to: another length reads as its base. */
function partOf(path: string): string {
  return path.replace(/_alt2?$/, "");
}

/** Every part a body writes: its leaf paths, without kind, href and the other lengths. */
export function writtenParts(
  sections: Record<string, unknown>,
  prefix = "",
  out: string[] = [],
): string[] {
  for (const [key, value] of Object.entries(sections)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      if (key !== "kind" && key !== "href" && !/_alt2?$/.test(key)) out.push(path);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      writtenParts(value as Record<string, unknown>, path, out);
    }
  }
  return out;
}

/** A section or button object left with nothing to render goes with its last part. */
function dropEmptySections(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const child = value as Record<string, unknown>;
    dropEmptySections(child);
    const renderable = Object.keys(child).filter((k) => k !== "kind" && k !== "href");
    if (renderable.length === 0) delete obj[key];
  }
}

/**
 * Take a part out of a body with its companions: its other lengths, the
 * candidates kept aside, and a label's href. The page then keeps its own
 * words there; the snippet writes only the parts a body has. True when the
 * body carried the part.
 */
export function removePart(sections: Record<string, unknown>, path: string): boolean {
  const at = holderOf(sections, path);
  if (!at) return false;
  let had = false;
  for (const suffix of LENGTH_SUFFIXES) {
    const k = `${at.key}${suffix}`;
    if (!(k in at.holder)) continue;
    delete at.holder[k];
    had = true;
  }
  delete at.holder[`${at.key}_more`];
  // A label takes its link with it: the page's button keeps its own.
  if (at.key === "label") Reflect.deleteProperty(at.holder, "href");
  if (spares.get(at.holder)?.key === at.key) spares.delete(at.holder);
  dropEmptySections(sections);
  return had;
}

/** The instruction of each rule a part failed, for its own call. */
function partInstructions(
  path: string,
  flags: readonly LintFlag[],
  lintCtx: Parameters<typeof polishLint>[2],
  sections: Record<string, unknown>,
): string[] {
  const out = new Set<string>();
  const wanted = lintCtx.emphasisSlots?.has(path) ?? false;
  for (const f of flags) {
    const cut = f.rule.indexOf(":");
    const rule = cut < 0 ? f.rule : f.rule.slice(0, cut);
    if (rule === "length-drift") {
      const original = lintCtx.originalLengths?.get(path);
      if (original !== undefined) {
        const cap = path.endsWith("headline")
          ? labelCap(path, original)
          : Math.round(original * PARAGRAPH_NEAR_CAP);
        out.add(`at most ${cap} characters, counting spaces`);
      }
    } else if (rule === "number-not-in-brief") {
      out.add(`no number the brief does not have (${f.excerpt} is not in it)`);
    } else if (rule === "number-unit-mismatch") {
      out.add("that number only as the brief gives it, or not at all");
    } else if (rule === "currency-missing") {
      out.add("the price with its currency, as the brief writes it");
    } else if (rule === "wrong-script" || rule === "turkish-in-az" || rule === "wrong-language") {
      out.add(`in the page's language only (${lintCtx.language})`);
    } else if (rule === "source-addressed") {
      out.add(`${SOURCE_ADDRESSED_FIX} ("${f.excerpt}" does)`);
    } else if (rule === "market-addressed") {
      out.add(`${MARKET_ADDRESSED_FIX} ("${f.excerpt}" does)`);
    } else if (CLAIMS_LOCK_RULES_SET.has(rule)) {
      out.add(`${CLAIMS_LOCK_FIX[rule]} ("${f.excerpt}")`);
    } else if (rule.startsWith("emphasis-")) {
      out.add(
        wanted ? "exactly one short phrase between asterisks, *like this*" : "no asterisks at all",
      );
    } else if (rule === "slot-duplicate" || rule === "sentence-reuse") {
      const other = f.rule.slice(cut + 1);
      const o = holderOf(sections, other);
      const said = o?.holder[o.key];
      out.add(
        `its own words, nothing ${other} says${typeof said === "string" ? ` (${JSON.stringify(said)})` : ""}`,
      );
    }
  }
  return [...out];
}

/**
 * One call for one part alone (step 1), with the instruction of the rule it
 * failed. The answer stays only when the part then has no hard flag and no
 * new one appeared anywhere (step 2). A part built word by word is asked for
 * as its list of words and built by code, like the first write. Returns
 * what the call cost.
 */
async function mendPart(
  body: VariantBody,
  path: string,
  flags: readonly LintFlag[],
  lintCtx: Parameters<typeof polishLint>[2],
  call: Parameters<typeof polishLint>[3],
): Promise<number> {
  const sections = body.sections as unknown as Record<string, unknown>;
  const at = holderOf(sections, path);
  const text = at?.holder[at.key];
  if (!at || typeof text !== "string") return 0;
  const before = new Set(lintVariant(body, lintCtx).hard.map((h) => `${h.path}|${h.rule}`));
  const why = flags.map((f) => `- ${f.rule}${f.excerpt ? `: ${f.excerpt}` : ""}`).join("\n");
  const page = call.manifest ? templatesOf(call.manifest).get(path) : undefined;
  let prompt: string;
  let read: (parsed: Record<string, unknown>) => string | null;
  if (page !== undefined) {
    // Without the page's structure there is no list of words to hand back.
    const entries = templateEntries(page, text);
    if (!entries) return 0;
    prompt = `A headline on this page is built word by word; the page places its images, line breaks, styles and rotating word itself. This version's words, one string per run:
${JSON.stringify(entries)}
It cannot go on the page as it is:
${why}
Write it again for the same visitor, in the same language and voice: one string per run, ${entries.length} strings, in the same order, the rotating word not in them. No asterisks, no braces.
Output JSON only: {"words": [...]}`;
    read = (parsed) => {
      const filled = fillTemplate(page, parsed.words);
      return filled && templateViolations(page, filled).length === 0 ? filled : null;
    };
  } else {
    const head = path.endsWith(".headline");
    const kind = head ? "headline" : path.endsWith(".body") ? "paragraph" : "text";
    const how = partInstructions(path, flags, lintCtx, sections);
    const keeps =
      (lintCtx.emphasisSlots?.has(path) ?? false) && !flags.some((f) => f.rule.startsWith("emph"))
        ? " Keep one short phrase between asterisks, *like this*."
        : "";
    prompt = `This ${kind} was written for a web page: ${JSON.stringify(text)}
It cannot go on the page as it is:
${why}
Write it again for the same visitor, in the same language and voice${how.length > 0 ? `: ${how.join("; ")}` : ""}. A complete ${head ? "headline" : "sentence"}, not the one above cut off.${keeps}
Output JSON only: {"text": "..."}`;
    read = (parsed) =>
      typeof parsed.text === "string" && parsed.text.trim() !== "" ? parsed.text.trim() : null;
  }
  const r = await callModel(
    { prompt, cachedPreamble: call.cachedPreamble, role: "write" },
    call.env,
  );
  if (!r.ok) return 0;
  let next: string | null = null;
  try {
    const raw = r.value.text;
    next = read(
      JSON.parse(jsonrepair(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1))) as Record<
        string,
        unknown
      >,
    );
  } catch {
    next = null;
  }
  if (next === null) return r.value.costUsd;
  at.holder[at.key] = next;
  const fresh = lintVariant(body, lintCtx).hard.filter(
    (h) => h.path === path || !before.has(`${h.path}|${h.rule}`),
  );
  if (fresh.length > 0) at.holder[at.key] = text;
  return r.value.costUsd;
}

/**
 * One part must not cost the version (docs/specs/refused-versions.md). After
 * the revise passes a row with a hard flag was refused whole: on a first
 * write that key had no version, on a rewrite the older body kept serving
 * (the pilot: 5 of 20 at go live, 2 of 20 on the rewrite of 2026-10-12, a
 * paragraph of 80 characters for the page's 64 and a section heading of 38
 * for 27).
 *
 *   1. Each part that still carries a hard flag gets one call for that part
 *      alone, with the rule's own instruction: the first three parts of the
 *      row; the others go to step 3 without one. A label fixLabels already
 *      called for (`tried`) had its call there.
 *   2. The part is linted again; a part that passes is in.
 *   3. A part that still fails is taken out of the body with its companions.
 *      The page keeps its own words there, and the row carries
 *      `part-as-built` with the path and the rule. The failing text goes
 *      nowhere: not to KV, not to version_bodies.
 *   4. The row is still refused when no part is left, when more than half
 *      of the parts it wrote were left as built, when a rule about the parts
 *      together still holds among the parts that are left, or when a part
 *      built word by word lost its structure and is the page's only headline.
 *
 * Another length (`_alt`, `_alt2`) with a hard flag of its own is left out
 * alone: the part keeps its other lengths, as a broken other length of a
 * template already was.
 */
export async function leavePartsAsBuilt(
  out: PolishOutcome,
  lintCtx: Parameters<typeof polishLint>[2],
  call: Parameters<typeof polishLint>[3],
  budget: () => boolean,
  opts: { tried?: ReadonlySet<string>; calls?: boolean } = {},
): Promise<PolishOutcome> {
  if (out.hard.length === 0) return out;
  const body = out.body;
  const sections = body.sections as unknown as Record<string, unknown>;
  const written = out.partsWritten ?? writtenParts(sections).length;
  const asBuilt: PartAsBuilt[] = [...(out.asBuilt ?? [])];
  /** Every flag of a part that was taken out, for the reason of a refusal. */
  const dropped: LintFlag[] = [];
  let cost = 0;

  /** The lint, each other length with a hard flag of its own left out first. */
  const relint = () => {
    for (let round = 0; round < 4; round++) {
      const r = lintVariant(body, lintCtx);
      let removed = false;
      for (const f of r.hard) {
        if (!/_alt2?$/.test(f.path)) continue;
        const at = holderOf(sections, f.path);
        if (!at || !(at.key in at.holder)) continue;
        delete at.holder[at.key];
        removed = true;
      }
      if (!removed) return r;
    }
    return lintVariant(body, lintCtx);
  };
  const holds = (path: string) => {
    const at = holderOf(sections, path);
    return at !== null && typeof at.holder[at.key] === "string";
  };

  // A verdict the lint does not give (the grammar check's): the part had its
  // own pass there, and nothing here can say it now reads.
  const asLinted = lintVariant(body, lintCtx).hard;
  const sticky = out.hard.filter(
    (f) => !asLinted.some((h) => h.path === f.path && h.rule === f.rule) && holds(partOf(f.path)),
  );
  let lint = relint();
  const stickyParts = new Set(sticky.map((f) => partOf(f.path)));

  // 1 and 2. A call of its own, the part linted again.
  if (opts.calls !== false) {
    let calls = 0;
    for (const path of new Set(lint.hard.map((f) => f.path))) {
      if (calls >= PART_CALLS_PER_ROW) break;
      if (opts.tried?.has(path) || stickyParts.has(path)) continue;
      // An earlier call may have cleared it (a sentence two parts shared).
      const flags = lintVariant(body, lintCtx).hard.filter((f) => f.path === path);
      if (flags.length === 0) continue;
      if (!budget()) break;
      calls++;
      cost += isButtonLabelPath(path)
        ? await mendLabel(body, path, lintCtx, call, () => true, 1)
        : await mendPart(body, path, flags, lintCtx, call);
    }
    lint = relint();
  }

  // 3. What still fails a rule about itself is left as the page built it.
  let refusal: string | undefined;
  const headlines = Object.entries(call.manifest ?? {})
    .filter(([p, e]) => p.endsWith(".headline") && !e.skip)
    .map(([p]) => p);
  for (let round = 0; round < 6 && refusal === undefined; round++) {
    const failing = [
      ...lint.hard.filter((f) => !togetherRule(f.rule)),
      ...sticky.filter((f) => holds(partOf(f.path))),
    ];
    if (failing.length === 0) break;
    let changed = false;
    for (const path of new Set(failing.map((f) => partOf(f.path)))) {
      const mine = failing.filter((f) => partOf(f.path) === path);
      const shape = call.manifest?.[path]?.inline;
      const structured = Boolean(shape?.template) || Boolean(shape?.lines);
      if (
        structured &&
        mine.some((f) => STRUCTURE_RULES.has(f.rule)) &&
        headlines.length === 1 &&
        headlines[0] === path
      ) {
        dropped.push(...mine);
        refusal = "the page's only headline lost its structure";
        break;
      }
      if (!removePart(sections, path)) continue;
      asBuilt.push({ path, rule: (mine[0] as LintFlag).rule });
      dropped.push(...mine);
      changed = true;
    }
    lint = relint();
    if (!changed) break;
  }

  // 4. When the row is still refused.
  if (refusal === undefined) {
    if (writtenParts(sections).length === 0) refusal = "no part is left to write";
    else if (asBuilt.length * 2 > written) {
      refusal = `${asBuilt.length} of ${written} parts could not be written`;
    } else if (lint.hard.some((f) => togetherRule(f.rule))) {
      refusal = "two parts still say the same thing";
    } else if (lint.hard.length > 0) refusal = "a part still fails its check";
  }
  const extraCost = out.extraCost + cost;
  if (refusal !== undefined) {
    const seen = new Set<string>();
    const hard = [...dropped, ...lint.hard].filter((f) => {
      const k = `${f.path}|${f.rule}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { ...out, hard, soft: lint.soft, extraCost, refusal, partsWritten: written };
  }
  return { ...out, hard: [], soft: lint.soft, extraCost, asBuilt, partsWritten: written };
}

/**
 * The last word on the parts left as built: a later pass that handed one
 * back (a revise call returns the whole body) does not put it on the page.
 */
export function keepAsBuilt(
  out: PolishOutcome,
  lintCtx: Parameters<typeof polishLint>[2],
): PolishOutcome {
  if (!out.asBuilt || out.asBuilt.length === 0) return out;
  const sections = out.body.sections as unknown as Record<string, unknown>;
  let again = false;
  for (const part of out.asBuilt) if (removePart(sections, part.path)) again = true;
  if (!again) return out;
  const lint = lintVariant(out.body, lintCtx);
  return { ...out, hard: lint.hard, soft: lint.soft };
}

/** A `*phrase*` pair, the phrase captured (the lint's MARKER, one pair). */
const EMPHASIS = /\*([^*\n]{1,80})\*/g;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The emphasised phrases of a part's other lengths, the base first. */
function emphasisedPhrases(holder: Record<string, unknown>, key: string, except: string): string[] {
  const out: string[] = [];
  for (const suffix of ["", "_alt", "_alt2"]) {
    const k = `${key}${suffix}`;
    const v = holder[k];
    if (k === except || typeof v !== "string") continue;
    for (const m of v.matchAll(EMPHASIS)) {
      const phrase = m[1];
      if (phrase?.trim() && !out.includes(phrase)) out.push(phrase);
    }
  }
  return out;
}

/**
 * Wrap the first whole-word occurrence of one of the phrases in `text`:
 * case-sensitive first, then case-insensitive on the text's own characters
 * (the phrase opened a sentence in one length and sits mid-sentence in
 * another). A match inside a longer word does not count.
 */
export function wrapKnownPhrase(text: string, phrases: string[], language: string): string | null {
  const lower = (t: string) => {
    try {
      return t.toLocaleLowerCase(language);
    } catch {
      return t.toLowerCase();
    }
  };
  const whole = (at: number, n: number) =>
    !WORD_CHAR.test(text.charAt(at - 1)) && !WORD_CHAR.test(text.charAt(at + n));
  const find = (hay: string, needle: string) => {
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
      if (whole(at, needle.length)) return at;
    }
    return -1;
  };
  for (const exact of [true, false]) {
    for (const phrase of phrases) {
      let at: number;
      if (exact) at = find(text, phrase);
      else {
        // Lowercasing may change a string's length (the dotted capital I
        // outside Turkic locales); then offsets no longer line up.
        const hay = lower(text);
        const needle = lower(phrase);
        if (hay.length !== text.length || needle.length !== phrase.length) continue;
        at = find(hay, needle);
      }
      if (at < 0) continue;
      const n = phrase.length;
      return `${text.slice(0, at)}*${text.slice(at, at + n)}*${text.slice(at + n)}`;
    }
  }
  return null;
}

/**
 * Every length of a part the page emphasises carries its `*phrase*`
 * (2026-09-30). On a pilot site 32 of 90 rows carried `emphasis-missing`: a
 * headline or paragraph length came back without the marker, and where the
 * snippet kept that length (the one at the page's height) the page's
 * italic word stood empty (six cells on /approach). First by code, a phrase
 * another length of the same part emphasises and this one repeats word for
 * word; otherwise one targeted call, twice at most, that may add the two
 * asterisks and nothing else. An answer whose text changed, or with other
 * than one pair, is refused; a mark that brings a hard flag is undone.
 */
export async function markEmphasis(
  out: PolishOutcome,
  lintCtx: Parameters<typeof polishLint>[2],
  call: Parameters<typeof polishLint>[3],
  budget: () => boolean,
): Promise<PolishOutcome> {
  const flags = out.soft.filter((f) => f.rule === "emphasis-missing");
  if (flags.length === 0) return out;
  const templates = call.manifest ? templatesOf(call.manifest) : new Map<string, string>();
  const sections = out.body.sections as unknown as Record<string, unknown>;
  const hardKeys = () =>
    new Set(lintVariant(out.body, lintCtx).hard.map((h) => `${h.path}|${h.rule}`));
  const before = hardKeys();
  /** Keep `next` at the flag's slot unless it brings a hard flag; says which. */
  const tryMark = (
    at: { holder: Record<string, unknown>; key: string },
    next: string,
  ): LintFlag[] => {
    const was = at.holder[at.key];
    at.holder[at.key] = next;
    const fresh = lintVariant(out.body, lintCtx).hard.filter(
      (h) => !before.has(`${h.path}|${h.rule}`),
    );
    if (fresh.length > 0) at.holder[at.key] = was;
    return fresh;
  };
  const unmarked = (at: { holder: Record<string, unknown>; key: string } | null) =>
    at !== null &&
    typeof at.holder[at.key] === "string" &&
    !(at.holder[at.key] as string).includes("*");
  const targets = flags.flatMap((f) => {
    const path = f.path.replace(/_alt2?$/, "");
    if (templates.has(path)) return [];
    const at = holderOf(sections, f.path);
    const base = holderOf(sections, path);
    if (!at || !base || !unmarked(at)) return [];
    return [{ flag: f, path, at, base }];
  });
  if (targets.length === 0) return out;

  let cost = 0;
  let changed = false;
  const byCode = (t: (typeof targets)[number]): boolean => {
    const text = t.at.holder[t.at.key] as string;
    const phrases = emphasisedPhrases(t.base.holder, t.base.key, t.at.key);
    const wrapped = wrapKnownPhrase(text, phrases, lintCtx.language);
    if (wrapped === null || tryMark(t.at, wrapped).length > 0) return false;
    changed = true;
    return true;
  };

  // Code first over every flag, then a call for what is left; a length
  // marked by a call lends its phrase to its siblings on their turn.
  const left = targets.filter((t) => !byCode(t));
  for (const t of left) {
    if (!unmarked(t.at) || byCode(t)) continue;
    const text = t.at.holder[t.at.key] as string;
    const examples = emphasisedPhrases(t.base.holder, t.base.key, t.at.key);
    const pagePhrase = call.manifest?.[t.path]?.inline?.emphasis_phrase;
    const kind = t.path.endsWith(".headline")
      ? "headline"
      : t.path.endsWith(".body")
        ? "paragraph"
        : "text";
    let feedback = "";
    for (let attempt = 0; attempt < 2 && budget(); attempt++) {
      const prompt = `This ${kind} is on a web page that sets one short phrase of it in italics:
${JSON.stringify(text)}${examples.length > 0 ? `\nIts other versions set these phrases in italics: ${examples.map((e) => JSON.stringify(e)).join(", ")}.` : ""}${pagePhrase ? `\nThe page's own ${kind} sets ${JSON.stringify(pagePhrase)} in italics.` : ""}
Return the same text with exactly one short phrase of it, one to four words, the one this page would set in italics${examples.length > 0 ? " like the examples" : ""}, wrapped in asterisks, *like this*. Change no other character: the same words, spaces and punctuation, only the two asterisks added.${feedback}
Output JSON only: {"text": "..."}`;
      const r = await callModel(
        { prompt, cachedPreamble: call.cachedPreamble, role: "write" },
        call.env,
      );
      if (!r.ok) break;
      cost += r.value.costUsd;
      let answer = "";
      try {
        const raw = r.value.text;
        const parsed = JSON.parse(
          jsonrepair(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)),
        );
        answer = typeof parsed.text === "string" ? parsed.text : "";
      } catch {
        feedback = `\nLast time the answer was not JSON with a "text" field.`;
        continue;
      }
      if (text === text.trim()) answer = answer.trim();
      const pairs = [...answer.matchAll(EMPHASIS)].length;
      const stars = (answer.match(/\*/g) ?? []).length;
      const bare = answer.replace(/\*/g, "");
      if (bare !== text) {
        feedback = `\nLast time the text itself changed, to ${JSON.stringify(bare)}; return it exactly as given, only the two asterisks added.`;
        continue;
      }
      if (pairs !== 1 || stars !== 2) {
        feedback = `\nLast time it had ${stars} asterisks; exactly two, around one phrase.`;
        continue;
      }
      const fresh = tryMark(t.at, answer);
      if (fresh.length === 0) {
        changed = true;
        break;
      }
      feedback = `\nLast time: ${fresh.map((h) => `${h.rule} (${h.excerpt})`).join("; ")}.`;
    }
  }
  if (!changed && cost === 0) return out;
  const again = lintVariant(out.body, lintCtx);
  return { ...out, soft: again.soft, extraCost: out.extraCost + cost };
}

/** The lint pass, the grammar check, then new other lengths for a template. */
async function polishLengths(
  body: VariantBody,
  result: GenerateResult,
  lintCtx: Parameters<typeof polishLint>[2],
  call: Parameters<typeof polishLint>[3],
  budget: () => boolean,
): Promise<PolishOutcome> {
  let linted = await polishLint(body, result, lintCtx, call, budget);
  // The labels fixLabels takes had their calls there; no second round here.
  const labelsTried = onlyLabelFlags(linted.hard)
    ? new Set(linted.hard.map((f) => f.path))
    : new Set<string>();
  if (linted.hard.length > 0) linted = await fixLabels(linted, lintCtx, call, budget);
  // One part must not cost the version (docs/specs/refused-versions.md).
  if (linted.hard.length > 0) {
    linted = await leavePartsAsBuilt(linted, lintCtx, call, budget, { tried: labelsTried });
  }
  if (linted.hard.length > 0 || !call.manifest) return linted;
  let out = await checkGrammar(linted, lintCtx, call, budget);
  // A rotating headline that still does not read had its revise pass in the
  // grammar check: it is left as built without another call.
  if (out.hard.length > 0) {
    out = await leavePartsAsBuilt(out, lintCtx, call, budget, { calls: false });
  }
  if (out.hard.length > 0) return out;
  const fresh = await diversifyLengths(out.body, call);
  if (!fresh) return out;
  const cost = out.extraCost + fresh.cost;
  let again = lintVariant(fresh.body, lintCtx);
  // A new other length that brings a hard flag is left out, not the whole
  // lot (the lab rewrite, 2026-09-28: one flagged alt threw the new lengths
  // away and the copies came back).
  const templates = templatesOf(call.manifest);
  const flaggedAlts = again.hard.filter(
    (f) => /_alt2?$/.test(f.path) && templates.has(f.path.replace(/_alt2?$/, "")),
  );
  if (flaggedAlts.length > 0 && flaggedAlts.length === again.hard.length) {
    const sections = fresh.body.sections as unknown as Record<string, unknown>;
    for (const f of flaggedAlts) {
      const at = holderOf(sections, f.path.replace(/_alt2?$/, ""));
      const suffix = /_alt2$/.test(f.path) ? "_alt2" : "_alt";
      if (at) delete at.holder[`${at.key}${suffix}`];
    }
    again = lintVariant(fresh.body, lintCtx);
  }
  // Anything else hard: the new lengths are not worth the version; keep the first.
  if (again.hard.length > 0) return { ...out, extraCost: cost };
  return { ...out, body: fresh.body, soft: again.soft, extraCost: cost };
}

/** Visible words of a length, for telling copies apart. */
function wordsOf(t: unknown): string {
  return typeof t === "string" ? normalizeForCompare(templateText(t)) : "";
}

/**
 * One more call for a part whose three lengths repeat each other: two new
 * word lists, one a word or two longer and one a word or two shorter, built
 * by code like the first and kept only when they keep the page's structure,
 * fit the last line's cap, and differ from the base and from each other.
 */
export async function diversifyLengths(
  body: VariantBody,
  call: Parameters<typeof polishLint>[3],
): Promise<{ body: VariantBody; cost: number } | null> {
  const copy = JSON.parse(JSON.stringify(body)) as VariantBody;
  const sections = copy.sections as unknown as Record<string, unknown>;
  let cost = 0;
  let changed = false;
  const SUFFIXES = ["_alt", "_alt2"] as const;
  for (const [path, page] of templatesOf(call.manifest)) {
    // A measured part already chose three of six by its wrap.
    if (call.manifest?.[path]?.metrics) continue;
    const at = holderOf(sections, path);
    if (!at) continue;
    const base = at.holder[at.key];
    if (typeof base !== "string" || templateViolations(page, base).length > 0) continue;
    const other = (suffix: (typeof SUFFIXES)[number]) =>
      at.holder[`${at.key}${suffix === "_alt" ? "_alt2" : "_alt"}`];
    // A length is wanted when it is missing or repeats the base or the other length.
    const wanted = () =>
      SUFFIXES.filter((suffix) => {
        const v = at.holder[`${at.key}${suffix}`];
        if (typeof v !== "string") return true;
        return wordsOf(v) === wordsOf(base) || wordsOf(v) === wordsOf(other(suffix));
      });
    if (wanted().length === 0) continue;
    const entries = templateEntries(page, base);
    if (!entries) continue;
    const cap = templateText(page).split("\n").pop()?.length ?? 0;
    let feedback = "";
    // Two tries: the second is told what the first missed (asked once, the
    // lab's new lists often ran the last line over the cap, 2026-09-28).
    for (let attempt = 0; attempt < 2 && wanted().length > 0; attempt++) {
      const prompt = `A headline on this page is built word by word; the page places its images, line breaks, styles and rotating word itself. This version's words, one string per run:
${JSON.stringify(entries)}
Write two more versions of the same idea for the same visitor, in other words, never the list above again:
- "alt": one or two words more across its runs;
- "alt2": one or two words fewer.
Each one string per run, ${entries.length} strings, in the same order, the rotating word not in them. The last line, counted with the page's longest rotating word, at most ${cap} characters. No asterisks, no braces.${feedback}
Output JSON only: {"alt": [...], "alt2": [...]}`;
      const r = await callModel(
        { prompt, cachedPreamble: call.cachedPreamble, role: "write" },
        call.env,
      );
      if (!r.ok) break;
      cost += r.value.costUsd;
      let parsed: Record<string, unknown> = {};
      try {
        const text = r.value.text;
        parsed = JSON.parse(jsonrepair(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
      } catch {
        continue;
      }
      const missed: string[] = [];
      for (const suffix of wanted()) {
        const name = suffix.slice(1);
        const filled = fillTemplate(page, parsed[name]);
        if (!filled || templateViolations(page, filled).length > 0) {
          missed.push(`"${name}" did not have ${entries.length} strings`);
          continue;
        }
        const over = templateLineMisses(page, filled).find((m) => m.last && m.n > m.hi);
        if (over) {
          missed.push(`"${name}"'s last line had ${over.n} characters, at most ${cap}`);
          continue;
        }
        const w = wordsOf(filled);
        if (w === wordsOf(base) || w === wordsOf(other(suffix))) {
          missed.push(`"${name}" repeated another version`);
          continue;
        }
        at.holder[`${at.key}${suffix}`] = filled;
        changed = true;
      }
      feedback = missed.length > 0 ? `\nLast time: ${missed.join("; ")}.` : "";
    }
    // A length still a copy after both tries is left out: the snippet then
    // has fewer candidates, never the same text twice.
    for (const suffix of wanted()) {
      if (typeof at.holder[`${at.key}${suffix}`] === "string") {
        delete at.holder[`${at.key}${suffix}`];
        changed = true;
      }
    }
  }
  return changed ? { body: copy, cost } : cost > 0 ? { body, cost } : null;
}

/**
 * Lint the validated body; when anything is flagged, spend one more call
 * asking the same model to change only the flagged strings, re-validate,
 * re-lint. Hard flags that survive are returned for the caller to fail the
 * variant; soft ones ship and are recorded on the row.
 */
async function polishLint(
  body: VariantBody,
  result: GenerateResult,
  lintCtx: {
    language: string;
    allowedNumbers: ReadonlySet<string>;
    allowedUnits?: ReadonlyMap<string, ReadonlySet<string>>;
    emphasisSlots?: ReadonlySet<string>;
    originalLengths?: ReadonlyMap<string, number>;
    originalTexts?: ReadonlyMap<string, string>;
    templates?: ReadonlyMap<string, string>;
    simulated?: ReadonlySet<string>;
    ctas?: ReadonlyMap<string, CtaFacts>;
    ownWords?: string;
    claimsLock?: ClaimsLock;
  },
  call: {
    cachedPreamble: string;
    env: OrchestrateEnv;
    intentDim: IntentDim;
    customerId: string;
    manifest: Manifest | null;
  },
  budget: () => boolean,
): Promise<PolishOutcome> {
  const first = promotePassing(body, lintCtx, call.manifest);
  if (first.hard.length === 0 && first.soft.length === 0) {
    return { body, result, hard: [], soft: [], extraCost: 0, cacheHit: false };
  }
  if (!budget()) {
    return { body, result, hard: first.hard, soft: first.soft, extraCost: 0, cacheHit: false };
  }
  const revisePrompt = buildRevisePrompt(JSON.stringify(withTemplateEntries(body, call.manifest)), [
    ...first.hard,
    ...first.soft,
  ]);
  const revised = await callModel(
    { prompt: revisePrompt, cachedPreamble: call.cachedPreamble, role: "write" },
    call.env,
  );
  if (!revised.ok) {
    return { body, result, hard: first.hard, soft: first.soft, extraCost: 0, cacheHit: false };
  }
  const validation = safeValidate(
    revised.value.text,
    call.intentDim,
    call.customerId,
    call.manifest,
  );
  if (!validation.ok) {
    // The revise broke the schema: keep the first body and its flags.
    return {
      body,
      result,
      hard: first.hard,
      soft: first.soft,
      extraCost: revised.value.costUsd,
      cacheHit: revised.value.cacheHit,
    };
  }
  keepBuiltTemplates(body, validation.body, call.manifest);
  const second = lintVariant(validation.body, lintCtx);
  if (second.hard.length === 0 || !budget()) {
    return {
      body: validation.body,
      result: revised.value,
      hard: second.hard,
      soft: second.soft,
      extraCost: revised.value.costUsd,
      cacheHit: revised.value.cacheHit,
    };
  }
  // A hard flag survived the first revise: one more pass on the hard flags
  // only (2026-09-15; one pass left 33 of 90 versions failing on a length the
  // model overshot by a few characters).
  const again = await callModel(
    {
      prompt: buildRevisePrompt(
        JSON.stringify(withTemplateEntries(validation.body, call.manifest)),
        second.hard,
      ),
      cachedPreamble: call.cachedPreamble,
      role: "write",
    },
    call.env,
  );
  const cost = revised.value.costUsd + (again.ok ? again.value.costUsd : 0);
  if (!again.ok) {
    return {
      body: validation.body,
      result: revised.value,
      hard: second.hard,
      soft: second.soft,
      extraCost: cost,
      cacheHit: revised.value.cacheHit,
    };
  }
  const v2 = safeValidate(again.value.text, call.intentDim, call.customerId, call.manifest);
  if (!v2.ok) {
    return {
      body: validation.body,
      result: revised.value,
      hard: second.hard,
      soft: second.soft,
      extraCost: cost,
      cacheHit: revised.value.cacheHit,
    };
  }
  keepBuiltTemplates(validation.body, v2.body, call.manifest);
  const third = lintVariant(v2.body, lintCtx);
  return {
    body: v2.body,
    result: again.value,
    hard: third.hard,
    soft: third.soft,
    extraCost: cost,
    cacheHit: revised.value.cacheHit || again.value.cacheHit,
  };
}

/**
 * The id of the model the versions are written with, for the error row.
 * Throws when the model is not configured in this isolate: right after a
 * deploy an isolate ran without the secret and 32 rows failed on
 * authentication (2026-09-30, and twice before). Nothing is called then;
 * the queue skips such a pass.
 */
function writeModelId(env: OrchestrateEnv): string {
  // Worded as before ("not visible"), so the dashboard's outage reading of
  // it does not change.
  if (!modelConfigured(env)) {
    throw new Error("The model configuration is not visible to this isolate");
  }
  return modelIdFor(env, "write");
}

/**
 * What each button of a page does, for the lint and the prompt: its own
 * words (the manifest's text signature), its link (read from the live page in
 * this isolate), what the customer's site map says of that link when its own
 * words say nothing, and whether its clicks are counted.
 *
 * Called with the page's whole manifest, the buttons that stay as built
 * included (lib/button-rewrite.ts): a version writes no words for those, so
 * nothing is checked on them, but the counted one's own words are still
 * words no other button may show.
 */
export function ctasOf(
  manifest: Manifest | null,
  links: ReadonlyMap<string, string>,
  counted: ReadonlySet<string>,
  linkKinds: LinkKinds = NO_LINK_KINDS,
): Map<string, CtaFacts> {
  const out = new Map<string, CtaFacts>();
  for (const [path, entry] of Object.entries(manifest ?? {})) {
    if (!isButtonLabelPath(path) || entry.skip) continue;
    const href = links.get(path);
    const own = entry.text?.[0];
    out.set(path, {
      ...ctaFactsOf(own, href, counted.has(path), linkKinds(href)),
      ...(own ? { own } : {}),
    });
  }
  return out;
}

/**
 * True when a version of this page may carry an href at all (the first outside
 * pilot, A2): a customer without a manifest (the page tags its own elements
 * with `data-rawuser`), or a manifest that lists an `.href` path itself. The
 * manifest does not record whether a button has a link, and the snippet
 * writes an href only on an element found for the `.href` path that has
 * none, so on any other manifest page an href in the body is never used.
 */
export function asksHref(manifest: Manifest | null | undefined): boolean {
  const keys = Object.keys(manifest ?? {});
  return keys.length === 0 || keys.some((k) => k.endsWith(".href"));
}

/** The section paths whose clicks the customer counts (conversion_targets, enabled). */
async function loadCountedPaths(customerId: string, db: D1Database): Promise<Set<string>> {
  try {
    const rows = await db
      .prepare("SELECT section_path FROM conversion_targets WHERE customer_id = ? AND enabled = 1")
      .bind(customerId)
      .all<{ section_path: string }>();
    return new Set(
      (rows.results ?? [])
        .map((r) => r.section_path)
        .filter((p): p is string => typeof p === "string"),
    );
  } catch {
    // No table or no rows in a test double: no button is counted.
    return new Set();
  }
}

async function loadCustomerDomain(customerId: string, db: D1Database): Promise<string | null> {
  try {
    const row = await db
      .prepare("SELECT domain FROM customers WHERE id = ?")
      .bind(customerId)
      .first<{ domain: string }>();
    return row?.domain ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationOk {
  ok: true;
  body: VariantBody;
  /**
   * Leaf paths that were emitted outside the confirmed manifest and pruned
   * from `body` before it was accepted (R3). Present only when pruning
   * occurred; the orchestrator logs it for observability. Absent = clean pass.
   */
  pruned?: string[];
}

interface ValidationFail {
  ok: false;
  reason: string;
}

type ValidationResult = ValidationOk | ValidationFail;

/**
 * Parses and validates the LLM text output against VariantBody expectations.
 *
 * Required:
 *   - Valid JSON object
 *   - customer_id matches expectation
 *   - profile_key is "intent:{intentDim}"
 *   - sections.hero exists
 *   - sections.cta exists
 *   - generated_at is a number
 *   - All section copy fields are non-empty strings
 *   - No [PLACEHOLDER] tokens
 *   - Section keys match the intent's structure plan
 */
export function parseAndValidate(
  text: string,
  intentDim: IntentDim,
  expectedCustomerId: string,
  manifest: Manifest | null = null,
): ValidationResult {
  // Strip markdown fences if the LLM wrapped the JSON despite instructions
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Models drop a comma, add a stray `","}` or leave a trailing comma
    // (the writer did all three on 2026-09-11). jsonrepair fixes the
    // syntax without inventing content; the schema checks below still run
    // in full, so a repaired object that lost a section is rejected there,
    // not silently shipped. Truncated outputs never reach here:
    // generateVariant throws on finish_reason "length".
    try {
      parsed = JSON.parse(jsonrepair(cleaned));
      console.warn("[generate] JSON repaired before validation");
    } catch {
      return { ok: false, reason: `Invalid JSON: ${String(e).slice(0, 200)}` };
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "Root value is not an object" };
  }

  const obj = parsed as Record<string, unknown>;

  // customer_id
  if (obj.customer_id !== expectedCustomerId) {
    return {
      ok: false,
      reason: `customer_id mismatch: got "${String(obj.customer_id)}", expected "${expectedCustomerId}"`,
    };
  }

  // profile_key
  const expectedProfileKey = `intent:${intentDim}`;
  if (obj.profile_key !== expectedProfileKey) {
    return {
      ok: false,
      reason: `profile_key mismatch: got "${String(obj.profile_key)}", expected "${expectedProfileKey}"`,
    };
  }

  // sections object
  if (typeof obj.sections !== "object" || obj.sections === null || Array.isArray(obj.sections)) {
    return { ok: false, reason: "sections is not an object" };
  }

  // Parts built word by word arrive as word lists: build their templates
  // here, before any check reads them (docs/specs/template-writing.md §4.2).
  fillTemplates(obj.sections as Record<string, unknown>, manifest);

  const sections = obj.sections as Record<string, unknown>;

  // Structure-plan validation only applies in legacy mode (no confirmed
  // manifest). When a manifest is supplied (Fix Pass A / QA-2), the manifest
  // IS the source of truth: its key set defines which sections may exist,
  // and the subset check below enforces that strictly. The advisory
  // structure plan in INTENT_STRUCTURES still seeds the prompt's section
  // emphasis, but the model is free to emit any subset of manifest keys.
  const manifestActive = manifest !== null && Object.keys(manifest).length > 0;

  if (!manifestActive) {
    // hero and cta are required in all intents (legacy contract)
    if (!sections.hero) {
      return { ok: false, reason: "sections.hero is missing" };
    }
    if (!sections.cta) {
      return { ok: false, reason: "sections.cta is missing" };
    }

    // Check that required section kinds from the structure plan are present
    const expectedKinds = INTENT_STRUCTURES[intentDim].map((s) => s.kind);
    for (const kind of expectedKinds) {
      // For feature intent with two 'features', check for features_core or features_integrations
      if (kind === "features" && intentDim === "feature") {
        if (!sections.features_core && !sections.features_integrations && !sections.features) {
          return {
            ok: false,
            reason: "feature intent requires features_core or features sections",
          };
        }
      } else if (kind !== "features") {
        // Other kinds use the kind as the key directly
        if (!sections[kind]) {
          return { ok: false, reason: `sections.${kind} is missing (required by structure plan)` };
        }
      }
    }
  }

  // Check all section copy is non-empty and no [PLACEHOLDER] tokens
  for (const [key, section] of Object.entries(sections)) {
    if (typeof section !== "object" || section === null) {
      return { ok: false, reason: `sections.${key} is not an object` };
    }
    const sec = section as Record<string, unknown>;

    // `kind` is optional in manifest mode (the manifest IS the source of truth
    // about which paths exist; `kind` is legacy structure-plan metadata).
    if (!manifestActive && typeof sec.kind !== "string") {
      return { ok: false, reason: `sections.${key}.kind is not a string` };
    }

    // headline is required on most sections
    if (sec.headline !== undefined) {
      if (typeof sec.headline !== "string" || sec.headline.trim() === "") {
        return { ok: false, reason: `sections.${key}.headline is empty` };
      }
      if (sec.headline.includes("[PLACEHOLDER]")) {
        return { ok: false, reason: `sections.${key}.headline contains [PLACEHOLDER]` };
      }
    }

    // body check
    if (sec.body !== undefined) {
      if (typeof sec.body !== "string" || sec.body.trim() === "") {
        return { ok: false, reason: `sections.${key}.body is empty` };
      }
      if (sec.body.includes("[PLACEHOLDER]")) {
        return { ok: false, reason: `sections.${key}.body contains [PLACEHOLDER]` };
      }
    }

    // cta.label check: `!= null` catches both undefined and JSON null.
    // LLMs sometimes emit `"cta": null` instead of omitting the optional field;
    // treat that as "not present" rather than throwing on .label access.
    if (sec.cta != null) {
      if (typeof sec.cta !== "object") {
        return { ok: false, reason: `sections.${key}.cta is not an object` };
      }
      const cta = sec.cta as Record<string, unknown>;
      if (typeof cta.label !== "string" || cta.label.trim() === "") {
        return { ok: false, reason: `sections.${key}.cta.label is empty` };
      }
      if (cta.label.includes("[PLACEHOLDER]")) {
        return { ok: false, reason: `sections.${key}.cta.label contains [PLACEHOLDER]` };
      }
    }
  }

  // generated_at
  if (typeof obj.generated_at !== "number") {
    return { ok: false, reason: "generated_at is not a number" };
  }

  // Fix Pass A / QA-2: when a manifest is supplied, enforce that every leaf
  // string path in variant.sections is a member of the manifest's key set.
  // This prevents the snippet's all-or-nothing pre-flight from aborting on
  // unmappable paths (e.g. variant emits sections.pricing.headline but the
  // manifest has no "pricing.headline" entry → visitor sees no
  // personalization). The retry path will fire a corrective prompt.
  //
  // Excluded from the subset rule:
  //   .kind: metadata discriminator, never rendered
  // An .href is dropped unless the manifest lists that path itself (below).
  if (manifest !== null) {
    const allowed = new Set(Object.keys(manifest));
    if (allowed.size > 0) {
      // R3: prune leaf paths outside the confirmed manifest instead of
      // hard-rejecting the whole variant. The snippet's pre-flight
      // (apply.ts) is all-or-nothing: an unmappable leaf aborts
      // personalization entirely, so the variant's leaf set MUST be a subset.
      // But rejecting cost ~30% of variants (the longer intents like brand /
      // pricing emit `pricing.headline`, a final `cta` section, etc. that the
      // narrow manifest can't cover). Those extra leaves are just copy for
      // sections the customer's page doesn't expose; dropping them keeps the
      // manifest-covered copy and lets the visitor get personalized. This is
      // the correct model: personalize exactly the confirmed elements.
      const pruned: string[] = [];
      pruneToManifest(sections, "", allowed, pruned);
      // No invented links on a page we read (the first outside pilot, A2: 19 of 20
      // bodies carried "#enroll", "#contact", "#products"). Quietly: nearly
      // every answer written from the old schema has one.
      dropHrefs(sections, "", allowed);

      // After pruning, at least one renderable leaf must remain: otherwise the
      // variant personalizes nothing and is not worth serving. (Reuse
      // collectLeafPaths with an empty allow-set: every renderable leaf is
      // reported, and by now they are all ⊆ the manifest.)
      const remaining: string[] = [];
      collectLeafPaths(sections, "", remaining, new Set());
      if (remaining.length === 0) {
        return {
          ok: false,
          reason: `Variant covered no manifest paths (all leaves were outside the confirmed manifest). Allowed paths: ${[...allowed].join(", ")}`,
        };
      }

      if (pruned.length > 0) {
        return { ok: true, body: obj as unknown as VariantBody, pruned };
      }
    }
  }

  // All checks passed: cast to VariantBody
  return { ok: true, body: obj as unknown as VariantBody };
}

/**
 * Walks a sections object and pushes any leaf string path not in `allowed`
 * onto `offending`. Excludes `.kind` (metadata) and `.href` (link metadata)
 * paths from the subset check: neither is rendered as visible copy.
 */
function collectLeafPaths(
  obj: Record<string, unknown>,
  prefix: string,
  offending: string[],
  allowed: Set<string>,
): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      if (key === "kind" || key === "href") continue;
      if (!allowed.has(path)) offending.push(path);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      collectLeafPaths(value as Record<string, unknown>, path, offending, allowed);
    }
  }
}

/**
 * Walks a sections object and DELETES any leaf string path not in `allowed`,
 * recording it in `removed`. Excludes `.kind` and `.href` (metadata, always
 * kept). After pruning a nested object, if it has no renderable leaves left
 * (only `kind`/`href` remain, or it is empty), the container itself is dropped
 * so the snippet doesn't pre-flight a section with nothing to render.
 *
 * Mutates `obj` in place. Counterpart to collectLeafPaths (R3).
 */
function pruneToManifest(
  obj: Record<string, unknown>,
  prefix: string,
  allowed: Set<string>,
  removed: string[],
): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      if (key === "kind" || key === "href") continue;
      // A second length for a headline rides with its base path (the page
      // picks the one that keeps its line count, docs/specs/NEXT.md).
      const base = /_alt2?$/.test(key) ? path.replace(/_alt2?$/, "") : path;
      if (!allowed.has(base)) {
        delete obj[key];
        removed.push(path);
      }
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const child = value as Record<string, unknown>;
      pruneToManifest(child, path, allowed, removed);
      const renderable = Object.keys(child).filter(
        (k) => k !== "kind" && k !== "href" && !/_alt2?$/.test(k),
      );
      if (renderable.length === 0) delete obj[key];
    }
  }
}

/**
 * Deletes every `href` whose path the manifest does not list itself. A
 * button keeps the page's own link: the snippet writes an href only on an
 * element found for the `.href` path (a manifest entry or the page's own
 * `data-rawuser` tag) that has none, and the manifest of a page read by the
 * detector or the picker has no such entry. A customer without a manifest
 * never reaches here and keeps its hrefs.
 */
function dropHrefs(obj: Record<string, unknown>, prefix: string, allowed: Set<string>): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (key === "href") {
      if (!allowed.has(path)) delete obj[key];
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      dropHrefs(value as Record<string, unknown>, path, allowed);
    }
  }
}

/**
 * Wraps `parseAndValidate` so any unexpected throw becomes a structured
 * `{ ok: false }`. Keeps the per-tuple isolation contract even if the
 * validator hits a malformed model response we didn't anticipate.
 *
 * When `manifest` is supplied, the validator also enforces that every leaf
 * string path in variant.sections is a member of the manifest's key set
 * (Fix Pass A / QA-2). When `manifest` is omitted (legacy callers or
 * customers without a confirmed manifest), the subset check is skipped and
 * the original structure-plan validation applies.
 */
function safeValidate(
  text: string,
  intentDim: IntentDim,
  customerId: string,
  manifest: Manifest | null,
): ValidationResult {
  try {
    return parseAndValidate(text, intentDim, customerId, manifest);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `validator threw: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUserPrompt(
  tuple: GenerationTuple,
  dna: BusinessDNA,
  customerId: string,
  manifest: Manifest | null,
  ctas?: ReadonlyMap<string, CtaFacts>,
): string {
  const basePrompt = buildIntentPrompt(
    tuple.intent_dim,
    dna,
    customerId,
    manifest ?? undefined,
    ctas,
  );

  if (tuple.source_dim === "default") {
    return basePrompt;
  }

  // A market version (docs/specs/direct-visitors.md §5): the MARKET block in
  // place of a source modifier.
  const market = marketOfSource(tuple.source_dim);
  if (market) return `${basePrompt}\n\n${buildMarketModifier(market)}`;

  const modifier = buildSourceModifier(tuple.source_dim as SourceDim);
  return modifier ? `${basePrompt}\n\n${modifier}` : basePrompt;
}

/** The lint's market for a market version's tuple, else nothing. */
function marketOf(tuple: GenerationTuple): { market?: string } {
  const market = marketOfSource(tuple.source_dim);
  return market ? { market } : {};
}

function buildCorrectivePrompt(originalPrompt: string, validationError: string): string {
  return `${originalPrompt}

---
CORRECTION REQUIRED: Your previous output was invalid.
Error: ${validationError}

Output JSON only. No markdown fences. No commentary. Start your response with { and end with }.`;
}

/**
 * The brief, in the language of the page being written. The primary brief
 * lives in business_dna; a secondary language's brief (drafted from that
 * language's own page, docs/specs/per-language.md) lives in
 * business_dna_i18n and overlays the text fields. Never translate-after:
 * if no brief exists for the language, the primary brief is used and the
 * copy is written in the primary language.
 */
async function loadBusinessDNA(
  customerId: string,
  db: D1Database,
  language?: string | null,
): Promise<BusinessDNA> {
  const primary = await loadPrimaryDNA(customerId, db);
  const lang = language?.trim().toLowerCase();
  if (!lang || lang === primary.target_language.toLowerCase()) return primary;
  const i18n = await db
    .prepare(
      `SELECT product, icp, brand_voice, value_props, differentiators, proof_points, target_market
       FROM business_dna_i18n WHERE customer_id = ? AND language = ?`,
    )
    .bind(customerId, lang)
    .first<{
      product: string;
      icp: string;
      brand_voice: string;
      value_props: string;
      differentiators: string;
      proof_points: string;
      target_market: string | null;
    }>();
  if (!i18n) return primary;
  return {
    ...primary,
    product: i18n.product,
    icp: i18n.icp,
    brand_voice: i18n.brand_voice || primary.brand_voice,
    value_props: JSON.parse(i18n.value_props) as string[],
    differentiators: JSON.parse(i18n.differentiators) as string[],
    proof_points: JSON.parse(i18n.proof_points) as string[],
    target_market: i18n.target_market ?? primary.target_market,
    target_language: lang,
  };
}

async function loadPrimaryDNA(customerId: string, db: D1Database): Promise<BusinessDNA> {
  const row = await db
    .prepare(
      `SELECT
        customer_id, product, icp, brand_voice, value_props, differentiators,
        proof_points, target_market, target_language, per_intent_hints,
        prompt_cache_id, updated_at
       FROM business_dna WHERE customer_id = ?`,
    )
    .bind(customerId)
    .first<{
      customer_id: string;
      product: string;
      icp: string;
      brand_voice: string;
      value_props: string;
      differentiators: string;
      proof_points: string;
      target_market: string | null;
      target_language: string;
      per_intent_hints: string;
      prompt_cache_id: string | null;
      updated_at: number;
    }>();

  if (!row) {
    throw new Error(`No business_dna found for customer_id="${customerId}"`);
  }

  return {
    customer_id: row.customer_id,
    product: row.product,
    icp: row.icp,
    brand_voice: row.brand_voice,
    value_props: JSON.parse(row.value_props) as string[],
    differentiators: JSON.parse(row.differentiators) as string[],
    proof_points: JSON.parse(row.proof_points) as string[],
    target_market: row.target_market ?? "",
    target_language: row.target_language,
    per_intent_hints: JSON.parse(row.per_intent_hints) as Partial<Record<IntentDim, string>>,
    prompt_cache_id: row.prompt_cache_id ?? undefined,
    updated_at: row.updated_at,
  };
}

/**
 * Loads the confirmed element manifest for a customer, or null when no
 * manifest exists or it hasn't been confirmed yet. Used by generation
 * (D6.2) to thread per-section length constraints into the user prompt.
 *
 * Returns null on any parse failure: degrades gracefully to no length
 * constraints rather than blocking the run.
 */
async function loadConfirmedManifest(
  customerId: string,
  db: D1Database,
  fetchHtml: PageFetch,
  pagePath = "/",
  onRead?: Parameters<typeof ensureInlineShapes>[6],
): Promise<Manifest | null> {
  // Per-path manifests (A1): defaults to the '/' manifest. Phase 3's
  // per-path generation loop passes each confirmed path explicitly.
  const row = await db
    .prepare(
      "SELECT manifest, language FROM element_manifests WHERE customer_id = ? AND page_path = ? AND confirmed_at IS NOT NULL",
    )
    .bind(customerId, pagePath)
    .first<{ manifest: string; language?: string | null }>();
  if (!row) return null;
  try {
    const manifest = JSON.parse(row.manifest) as Manifest;
    return await ensureInlineShapes(
      customerId,
      pagePath,
      manifest,
      db,
      fetchHtml,
      row.language ?? null,
      onRead,
    );
  } catch {
    return null;
  }
}

/**
 * Loads every CONFIRMED element manifest for a customer, one entry per
 * page_path (A1 per-path variants). Rows whose manifest JSON is malformed are
 * skipped rather than aborting the run. Returns [] when the customer has no
 * confirmed manifest: orchestrate() then falls back to a single path-agnostic
 * '/' set against a null manifest (legacy behavior).
 */
/** The language recorded for a path's manifest (confirmed or not), or null. */
async function loadPathLanguage(
  customerId: string,
  db: D1Database,
  pagePath: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT language FROM element_manifests WHERE customer_id = ? AND page_path = ?")
    .bind(customerId, pagePath)
    .first<{ language: string | null }>();
  return row?.language ?? null;
}

async function loadConfirmedPaths(
  customerId: string,
  db: D1Database,
  fetchHtml: PageFetch,
  onRead?: Parameters<typeof ensureInlineShapes>[6],
): Promise<Array<{ pagePath: string; manifest: Manifest; language: string | null }>> {
  const rows = await db
    .prepare(
      "SELECT page_path, manifest, language FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL ORDER BY (page_path = '/') DESC, page_path ASC",
    )
    .bind(customerId)
    .all<{ page_path: string; manifest: string; language: string | null }>();

  const out: Array<{ pagePath: string; manifest: Manifest; language: string | null }> = [];
  for (const row of rows.results ?? []) {
    try {
      const parsed = JSON.parse(row.manifest) as Manifest;
      out.push({
        pagePath: row.page_path,
        manifest: await ensureInlineShapes(
          customerId,
          row.page_path,
          parsed,
          db,
          fetchHtml,
          row.language ?? null,
          onRead,
        ),
        language: row.language ?? null,
      });
    } catch {
      // skip malformed manifest: don't abort the whole customer's run
    }
  }
  return out;
}
