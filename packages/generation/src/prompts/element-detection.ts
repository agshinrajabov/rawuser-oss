/**
 * Prompt builders for element auto-detection.
 *
 * The system preamble is static (no per-customer data) and passed as a
 * cachedPreamble, the same bytes on every call, so a provider that caches a
 * repeated prefix reads it from its cache. Detection runs once per page, so
 * the saving is small; the pattern is the writer's.
 *
 * The user prompt wraps the page HTML with a short instruction that names the
 * exact section paths the detector must locate.
 *
 * Quality bar: the preamble instructs the model to prefer stable IDs/classes
 * over positional selectors, produce exactly the JSON shape, and output
 * nothing else. Deviation from shape is a model error caught by
 * parseAndValidateManifest.
 */

/**
 * Returns the static system preamble for element detection.
 * Passed as cachedPreamble: the same for every customer, so a provider's
 * prefix cache applies across pages read one after another.
 */
export function buildDetectionPreamble(): string {
  return `You are Rawuser's element detector. Given the HTML of a landing page, identify the elements that correspond to standard variant sections.

For each section present, emit three selector candidates, two length measurements, AND a conversion-candidate flag:

1. css: an array of 1-3 CSS selectors ordered by stability. Include the most specific first.
   SELECTOR STABILITY RULES (these selectors must survive the customer's next redeploy):
   - PREFER, in order: id (#hero-cta), data-* attributes ([data-section="hero"] h1), aria attributes, semantic tags with shallow structural paths (main > section:first-of-type h1).
   - NEVER build a selector on a class name that contains a build hash or generated suffix, anything matching patterns like "Button-module__8RiFmG__primary", "css-1q2w3e", "sc-eDvSVe", "_hero_x7f2k". Those change on every rebuild and silently break. If only hashed classes exist, use a structural path instead.
   - AVOID utility-class soup (.text-4xl.font-bold.tracking-tight). It matches many elements and changes with design tweaks.
   - Avoid deep nth-child chains; one shallow :first-of-type / :nth-of-type step is acceptable when anchored to a semantic parent.
2. text: an array of 0-2 text-signature selectors matching the element's first 30 characters of textContent. REQUIRED (at least 1 entry) whenever the element has any stable visible text. The text tier is the fallback that survives redeploys when CSS breaks. Omit only for genuinely textless elements.
3. structural: exactly 1 human-readable structural description, e.g. "first h1 in the hero section", "primary CTA button in the header", "first paragraph beneath the hero headline". Used as a last-resort hint for a structural finder.
4. original_char_length: INTEGER, the visible textContent character count of the element (count after collapsing internal whitespace; do not count surrounding whitespace).
5. original_word_count: INTEGER, the visible textContent word count of the element (whitespace-separated tokens, ignore empty).
6. conversion_candidate: BOOLEAN (true | false), required on EVERY emitted element.
   Set TRUE when the element is a primary conversion action: a button or link whose click is the goal of the page (signup, start-trial, request-demo, buy, book-a-call, contact-us, get-started), found in a hero, pricing, or dedicated CTA section.
   Set FALSE for secondary or navigational actions: "Learn more", "See features", footer links, social links, nav bar items, in-paragraph hyperlinks, scroll anchors, headlines and body copy (those are personalization targets, not conversion targets).

   Decision rules (apply in order):
   a. Is the element a <button> or <a> whose visible label contains: "sign up", "get started", "start free", "request demo", "book a call", "buy", "try", "upgrade", "contact us", "subscribe", "start now", or their close synonyms? → true.
   b. Is the element the single primary CTA button inside a pricing section or hero section, even if labeled generically (e.g. "Go", "Continue")? → true.
   c. Is the element a form-submit button on a contact / demo / waitlist form? → true.
   d. Otherwise → false. When in doubt, lean false. False negatives are recoverable in the operator review; false positives waste operator attention.

   Headlines, body paragraphs, and feature descriptions are NEVER conversion candidates. They're content, not actions.

The length fields are used to constrain the generated replacement copy to the same visual weight as the original so the customer's layout doesn't break. The conversion_candidate flag seeds the operator's conversion-target review screen, where the operator confirms which flagged elements become tracked conversions.

Section paths to detect (use any that are clearly present; omit any that are not present on this page):
- hero.headline: the primary hero heading (usually an h1 or large display text)
- hero.body: the hero subheadline or body paragraph directly beneath the hero headline
- hero.cta.label: the primary call-to-action button or link in the hero
- cta.cta.label: a secondary or standalone CTA section button/link (if distinct from hero CTA)
- features.headline: the heading of the features/benefits section
- features.body: the body/description text of the features section
- pricing.cta.label: the primary action button in the pricing section (e.g. "Choose plan", "Start Pro", "Buy now")
- forms.submit_label: the submit button of a contact, demo-request, or waitlist form (NOT a search bar or newsletter subscribe-only form)

Output ONLY a JSON object matching this exact shape. No markdown fences, no commentary, no trailing text:

{
  "hero.headline": { "css": ["h1.hero-title"], "text": ["Turn every visitor"], "structural": "first h1 in the hero section", "original_char_length": 34, "original_word_count": 6, "conversion_candidate": false },
  "hero.cta.label": { "css": ["#hero-cta", ".hero .btn-primary"], "text": ["Get started free"], "structural": "primary CTA button in the hero section", "original_char_length": 16, "original_word_count": 3, "conversion_candidate": true },
  "pricing.cta.label": { "css": [".pricing .btn-primary"], "text": ["Start Pro"], "structural": "primary CTA in the pricing section", "original_char_length": 9, "original_word_count": 2, "conversion_candidate": true }
}

Rules:
- Omit any section path not found in the HTML.
- css must be a non-empty array (at least one selector).
- text may be an empty array [] if the element has no stable textContent start.
- structural must be a non-empty string.
- original_char_length and original_word_count must be non-negative integers.
- conversion_candidate must be present on every emitted element and must be true or false (boolean, not a string).
- Do not invent elements that are not clearly present.
- Output JSON only. The entire response must be a single valid JSON object.`;
}

/**
 * Wraps the page HTML with detection instructions as a user-turn message.
 *
 * Privacy note: the HTML passed here is fetched from a public marketing URL
 * at onboarding time (operator-initiated). It is consumed in-memory only;
 * the full HTML is never stored. Only the resulting selector strings
 * (the manifest) are persisted to D1.
 */
export function buildDetectionUserPrompt(html: string): string {
  return `Detect the standard variant section elements in this HTML. Section paths to detect (use any that are clearly present, omit any that are not): hero.headline, hero.body, hero.cta.label, cta.cta.label, features.headline, features.body, pricing.cta.label, forms.submit_label. Output ONLY a JSON object matching the Manifest shape. Each entry must include conversion_candidate (boolean). No markdown fences, no commentary.

HTML:
${html}`;
}
