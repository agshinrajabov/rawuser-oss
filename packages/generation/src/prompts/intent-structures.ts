/**
 * Per-intent structure plans — the Generative IA data layer.
 *
 * Each intent gets a DIFFERENT page structure, not just different copy.
 * This is the differentiator: competitors copy-only personalize. We
 * change which sections appear, their order, and their relative emphasis.
 *
 * The structure plan is data-driven here and referenced by:
 *   - buildIntentPrompt() — to instruct the LLM on section shape
 *   - parseAndValidate() — to verify the output contains the right sections
 *
 * Adding a new intent is a one-file change: add the entry here.
 */

import type { IntentDim, StructureSection } from "@rawuser/shared";

export const INTENT_STRUCTURES: Record<IntentDim, StructureSection[]> = {
  /**
   * competitor — visitor is evaluating against a named rival.
   * Lead with the comparison frame immediately; proof anchors it.
   */
  competitor: [
    {
      kind: "hero",
      emphasis: 1.0,
      note: "Frame the choice. Name the alternative implicitly or explicitly. Do not open with product features. Open with the switching decision the visitor is already making.",
    },
    {
      kind: "comparison",
      emphasis: 0.9,
      note: "Honest, specific feature-by-feature comparison. Name real differentiators. Do NOT soften differentiators into vague claims.",
    },
    {
      kind: "social_proof",
      emphasis: 0.6,
      note: "Outcomes from people who evaluated alternatives and chose this product. Name real companies if available in proof_points.",
    },
    {
      kind: "cta",
      emphasis: 0.8,
      note: "Low-commitment wording for the button's own action: a start button can read 'Start your comparison'. Not 'Sign up now'. Never turn a start button into a reading link.",
    },
  ],

  /**
   * evaluation — visitor is comparing the category, no rival named.
   * They want criteria, not a sales pitch. FAQ earns trust.
   */
  evaluation: [
    {
      kind: "hero",
      emphasis: 1.0,
      note: "Acknowledge the evaluation mode. Position as the transparent, credible option for someone who is doing their homework.",
    },
    {
      kind: "features",
      emphasis: 0.8,
      note: "The criteria that actually matter for this category. Not a feature list, but an evaluation framework.",
    },
    {
      kind: "social_proof",
      emphasis: 0.6,
      note: "Reviews and outcomes from evaluators who chose this product after comparing the category.",
    },
    {
      kind: "faq",
      emphasis: 0.7,
      note: "Answer the real questions evaluators ask: pricing, implementation, data ownership, cancellation, trial limits.",
    },
    {
      kind: "cta",
      emphasis: 0.7,
      note: "Evaluation-appropriate wording for the button's own action: a start button can read 'Start a free trial', a demo button 'Book an evaluation call'. Not high-pressure.",
    },
  ],

  /**
   * feature — visitor is deep-diving on a specific capability.
   * Two features sections: core capabilities + integrations/ecosystem.
   */
  feature: [
    {
      kind: "hero",
      emphasis: 0.8,
      note: "Name the capability concretely. This visitor already knows what they want. Validate their specific interest before elaborating.",
    },
    {
      kind: "features",
      emphasis: 1.0,
      note: "Deep-dive: implementation details, limits, configuration, production scale. Technical specifics beat marketing language.",
    },
    {
      kind: "features",
      emphasis: 0.8,
      note: "Integrations and ecosystem: what this plugs into, what it replaces, what the migration path looks like.",
    },
    {
      kind: "cta",
      emphasis: 0.7,
      note: "Capability-specific wording for the button's own action: a start button can read 'Try it on your API', a reading link 'Read the docs'. Not generic 'Sign up'.",
    },
  ],

  /**
   * problem — visitor arrived with a pain they want validated.
   * Lead with empathic problem acknowledgment, not product features.
   */
  problem: [
    {
      kind: "hero",
      emphasis: 1.0,
      note: "Validate the problem in the visitor's own words. Do NOT lead with the product. This section succeeds if the visitor thinks 'yes, exactly that'. Use the per_intent_hints.problem if provided.",
    },
    {
      kind: "features",
      emphasis: 0.7,
      note: "Frame each feature as a specific solution to a specific part of the problem named in the hero. No orphan features.",
    },
    {
      kind: "social_proof",
      emphasis: 0.6,
      note: "Outcomes from people who had the same problem and solved it here. Specific outcomes beat vague testimonials.",
    },
    {
      kind: "cta",
      emphasis: 0.7,
      note: "'Start solving this' framing for a start button. Not 'Sign up' or 'Get started'. The label mirrors the problem resolution and keeps the button's own action.",
    },
  ],

  /**
   * brand — direct or returning visitor. Already knows the product.
   * Full narrative arc: hero → features → proof → pricing → cta.
   */
  brand: [
    {
      kind: "hero",
      emphasis: 1.0,
      note: "This is the canonical page. Lead with the product's core promise. Warm, aspirational. Do not assume the visitor just switched from a competitor. Treat this as the definitive first impression.",
    },
    {
      kind: "features",
      emphasis: 0.8,
      note: "Core capabilities framed as value, not specs. Ordered by the value_props priority from business DNA.",
    },
    {
      kind: "social_proof",
      emphasis: 0.7,
      note: "Named proof points. Reference real company names from proof_points. Do not genericize.",
    },
    {
      kind: "pricing",
      emphasis: 0.6,
      note: "Brief pricing orientation, not the full pricing page, just enough to answer 'how much roughly?'",
    },
    {
      kind: "cta",
      emphasis: 0.8,
      note: "Primary action: enroll, start, get access. Match the brand voice.",
    },
  ],

  /**
   * pricing — visitor arrived cost-first.
   * Lead with pricing immediately; features justify the price after.
   */
  pricing: [
    {
      kind: "hero",
      emphasis: 1.0,
      note: "Acknowledge the cost intent directly. 'Transparent pricing, no surprises' beats a product pitch. This visitor wants numbers, not a mission statement.",
    },
    {
      kind: "pricing",
      emphasis: 1.0,
      note: "Full plan breakdown: tiers, what's included, what's not. Be specific about limits and what the free tier covers if applicable.",
    },
    {
      kind: "features",
      emphasis: 0.6,
      note: "Brief: just enough to justify the pricing. Why is it worth it? Reference the top 2-3 value_props.",
    },
    {
      kind: "cta",
      emphasis: 0.8,
      note: "Low-friction wording for the button's own action: a start button 'Start free', a pricing button 'See the plans', a demo button 'Talk to sales'. Never give a pricing button the start button's words.",
    },
  ],
};

/**
 * Returns the section keys expected in a generated VariantBody for a given
 * intent. Used by parseAndValidate() to check structural completeness.
 *
 * Note: feature intent has two 'features' sections — they share the same kind
 * but the validator checks that at least one 'features' key is present.
 */
export function expectedSectionKinds(intentDim: IntentDim): string[] {
  return INTENT_STRUCTURES[intentDim].map((s) => s.kind);
}
