/**
 * DNA preamble builder: the cached system prompt for variant generation.
 *
 * This string is marked with cache_control: { type: "ephemeral" } in
 * generateVariant(). It is built ONCE per customer per orchestration run
 * and reused for all 30 variant calls. Prompt caching saves ~90% on input
 * token cost for calls 2-30.
 *
 * The preamble must be STABLE (same content = cache hit). Do not inject
 * any per-call variables (intent_dim, source_dim, timestamp) here: those
 * belong in the per-intent user prompt (buildIntentPrompt).
 *
 * Quality bar: specifics beat generics. The LLM is instructed to use named
 * proof points, real differentiators, and the exact brand voice provided.
 */

import type { BusinessDNA } from "@rawuser/shared";
import {
  CLAIMS_LOCK_RULES,
  CORE_QUALITY_RULES,
  buildSamplesBlock,
  languageLayer,
} from "./quality-rules.ts";

/**
 * Builds the cached system preamble from a customer's BusinessDNA.
 *
 * The returned string is:
 *   1. Used as the system prompt in all variant calls for this customer.
 *   2. The same bytes on every call of a run, so a provider that caches a
 *      repeated prefix reads it from its cache.
 *   3. Never modified between calls: per-intent context goes in the user prompt.
 *
 * `opts.href` false leaves the href field out of the schema: for a customer
 * whose pages we read, every button keeps the page's own link (the first outside
 * pilot, 2026-10-12: the schema's example anchor "#enroll" came back in the
 * bodies of a site that has no such anchor). Default true, the schema as it
 * was, for a page that tags its own elements.
 *
 * `opts.claimsLock` true adds the claims lock block after the writing rules
 * (docs/specs/claims-lock.md), for a customer whose site is about health.
 * Default false: the preamble byte for byte as it was.
 */
export function buildDnaPreamble(
  dna: BusinessDNA,
  samples: readonly string[] = [],
  opts: { href?: boolean; claimsLock?: boolean } = {},
): string {
  const askHref = opts.href !== false;
  const languageName = BCP47_DISPLAY_NAMES[dna.target_language] ?? dna.target_language;

  const valuePropsBlock = dna.value_props.map((vp, i) => `  ${i + 1}. ${vp}`).join("\n");

  const differentiatorsBlock = dna.differentiators.map((d, i) => `  ${i + 1}. ${d}`).join("\n");

  const proofPointsBlock = dna.proof_points.map((p, i) => `  ${i + 1}. ${p}`).join("\n");

  const languageGuidance = languageLayer(dna.target_language, languageName, dna.target_market);
  const samplesBlock = buildSamplesBlock(samples);

  return `You are Rawuser's variant generator for the product described below.
Your task: produce a VariantBody JSON object for ONE intent dimension.

OUTPUT LANGUAGE: ${languageName} (BCP-47: ${dna.target_language}).
Write ALL visible copy (headlines, body text, CTA labels) in ${languageName}.
Schema field names (kind, headline, body, cta, label, ${askHref ? "href, " : ""}sections, etc.)
remain in English. They are machine-readable keys, not visible content.

=== BUSINESS DNA ===

Product:
${dna.product}

Ideal Customer Profile (ICP):
${dna.icp}

Target Market:
${dna.target_market}

Brand Voice:
${dna.brand_voice}

Value Propositions (ordered by importance):
${valuePropsBlock}

Differentiators (what makes this product not interchangeable):
${differentiatorsBlock}

Proof Points (evidence: use SPECIFIC names, never paraphrase):
${proofPointsBlock}

${CORE_QUALITY_RULES}${opts.claimsLock ? `\n\n${CLAIMS_LOCK_RULES}` : ""}

${languageGuidance}${samplesBlock ? `\n\n${samplesBlock}` : ""}

=== OUTPUT RULES ===

1. BE SPECIFIC. Use the exact names, numbers, and claims from the brief. If
   a proof point says "Graduate at Microsoft Estonia", write "Microsoft
   Estonia", never "a leading tech company".

2. HONOR THE BRAND VOICE in every section: "${dna.brand_voice}".

3. STRUCTURE IS NOT COPY. The structure plan in the user prompt defines what
   sections to produce. Write copy that fits the section's intent; hero copy
   is not the same register as FAQ copy.

4. OUTPUT JSON ONLY. Write each string as finished, publishable copy, then
   place it in the schema. No markdown fences, no commentary before or
   after. The entire response must be a single valid JSON object.

5. NO PLACEHOLDERS. Do not output [PLACEHOLDER], [INSERT], or any unfilled
   template tokens.

=== VARIANTBODY SCHEMA ===

{
  "customer_id": string,
  "profile_key": string,          // e.g. "intent:brand"
  "sections": {
    "<section_key>": {
      "kind": SectionKind,        // "hero"|"features"|"comparison"|"pricing"|"faq"|"social_proof"|"cta"
      "headline": string,         // visible heading in ${languageName}
      "body": string,             // visible body text in ${languageName} (not required for cta)
      "cta": {                    // only on hero and cta sections
        "label": string${askHref ? "," : " "}          // button/link text in ${languageName}${
          askHref
            ? `
        "href": string            // anchor target, e.g. "#enroll"`
            : ""
        }
      }
    }
  },
  "generated_at": number,         // Unix timestamp ms
  "prompt_hash": string           // leave as empty string "", filled by the pipeline
}

Section keys for the "sections" object must match the structure plan in the
user prompt exactly. Use the section kind as the key when there is only one
section of that kind. When there are two "features" sections, use
"features_core" and "features_integrations" as keys.`;
}

/**
 * Human-readable display names for BCP-47 tags the pipeline may encounter.
 * Add entries as new customer languages are onboarded.
 */
const BCP47_DISPLAY_NAMES: Record<string, string> = {
  az: "Azerbaijani",
  en: "English",
  tr: "Turkish",
  ru: "Russian",
  de: "German",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  ar: "Arabic",
  zh: "Chinese (Simplified)",
};
