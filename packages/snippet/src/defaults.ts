/**
 * Convention-based CSS selectors for zero-config personalization (Tier 2).
 *
 * These are best-effort fallbacks used when [data-rawuser] attributes are
 * absent. For quality results, customers should add data-rawuser attributes
 * to the specific elements they want personalized. These selectors work on
 * generic landing pages (including Lovable/v0 output) without any markup.
 *
 * Extend this map as new section kinds are defined in the generation pipeline.
 */
export const DEFAULT_SELECTORS: Record<string, string> = {
  "hero.headline": "h1:first-of-type",
  "hero.body": "h1:first-of-type + p",
  "hero.cta.label": 'a.cta, button.cta, a[href="#enroll"], a[href="#start"]',
  "cta.cta.label": 'footer a.cta, [data-cta="primary"]',
};
