/**
 * Source dimension modifiers — tone-only adjustments appended to the per-intent user prompt.
 *
 * INVARIANT: Source modifiers NEVER change the structure plan. They only
 * adjust tone and the hero opening. The "source never overrides intent"
 * rule from ADR 0006 is enforced here at generation time.
 *
 * The modifier is appended to the user prompt (not the cached preamble) so
 * the cache hit on the DNA preamble is preserved for all 30 calls.
 *
 * The "default" source has no modifier — it is the pure intent base.
 *
 * The source is never said (the founder's decision of 2026-10-12, A13 of
 * docs/specs/pilot-gaps.md). Live on the pilot's site the AI version's hero
 * paragraph read "if you asked AI, the answer is this:", and the AI
 * modifier's own example had asked for it (it opened by naming the assistant
 * the visitor came from and guessing their question). Each modifier now says how
 * such a visitor reads, and every one ends with the same rule: nothing about
 * where the reader came from or what they did before arriving. The lint
 * holds it (`source-addressed`, hard).
 */

import type { SourceDim } from "@rawuser/shared";

/**
 * Source dims for which we generate source-specialized variants in V1.
 * `paid` since 2026-10-22 (docs/specs/ads-platforms.md §3): six more
 * versions per page, one per served intent. A feed ad's paid visit reads
 * the `social` version (§4), so `paid` is written for search ads first.
 */
export const GENERATED_SOURCE_DIMS: SourceDim[] = ["ai", "social", "community", "organic", "paid"];

/**
 * The rule every modifier ends with. The paragraph above each one tells the
 * model who is reading; this says that the page never tells the reader so.
 */
export const NEVER_SAY_THE_SOURCE = `NEVER SAY WHERE THE READER CAME FROM. What is written above is for you, not for
the page. The source changes how you write, never what the page says about the reader:
- do not name or hint at an AI assistant, a chat, a search engine, a social app, a feed,
  a community, a forum, a link, a recommendation, an ad, a sponsored post or a promotion;
- do not say what the reader did before arriving: no "you asked", "you searched", "you
  saw us on", "you came from", "you were told", "you clicked", in any language or tense;
- do not write "the answer is", "as you were told" or anything else that only makes
  sense if the page knows how the reader got here.
A reader must not be able to tell from the page that anyone knows where they came from.
If the product itself is about AI, search, social media or advertising, those words stay
where they describe the product, and nowhere else.`;

/**
 * Returns the source modifier string to append to the user prompt.
 * Returns an empty string for "default" (no modifier) and unsupported dims.
 *
 * The modifier string assumes it will be appended after the base intent
 * prompt with a blank line separator.
 */
export function buildSourceModifier(sourceDim: SourceDim | "default"): string {
  if (sourceDim === "default") return "";

  const modifiers: Partial<Record<SourceDim, string>> = {
    ai: `---
SOURCE MODIFIER: AI referral visitor

This visitor just arrived from an AI tool (ChatGPT, Claude, Perplexity, or Gemini).
They followed a citation link or copied the URL from an AI-generated answer.

Adjust ONLY the hero section's opening 2-3 sentences:
- They arrive with the topic already in mind and one specific question. Write the
  opening as a plain statement that answers such a question at once: what the product
  is, for whom, and the one fact that decides it.
- Skip introductory fluff. Assume they have topic context. Get to the point faster.
- Be precise and evidence-led. AI referral visitors are in research mode.

Do NOT change: the structure plan, section order, or any section other than hero.
The intent's structure plan (sections, emphasis) remains unchanged.

${NEVER_SAY_THE_SOURCE}`,

    social: `---
SOURCE MODIFIER: Social media visitor

This visitor arrived from social media (LinkedIn, Twitter/X, Instagram, TikTok, or YouTube).
They may be in discovery mode: shorter attention span, story-first.

Adjust ONLY the hero section's opening 2-3 sentences:
- Lead with a single sharp hook: a specific outcome, a striking number from the brief,
  or a concrete result. One sentence worth stopping for; it says nothing about
  scrolling or a feed.
- Use a slightly more conversational, warm register. Social visitors expect a human
  voice, not a corporate announcement.
- Lower-commitment wording for the same action: "Try it free" instead of "Enroll now".
  A button keeps what it does: a sign-up button never becomes a reading link.

Do NOT change: the structure plan, section order, or any section other than hero.
The intent's structure plan (sections, emphasis) remains unchanged.

${NEVER_SAY_THE_SOURCE}`,

    community: `---
SOURCE MODIFIER: Community referral visitor

This visitor arrived from a developer or enthusiast community (Reddit, Hacker News,
Discord, a Slack workspace, or a forum). They are technically literate and skeptical
of marketing language.

Adjust ONLY the hero section's opening 2-3 sentences:
- No marketing voice. Open with what the product ACTUALLY does: technical specifics,
  real constraints, honest trade-offs. Earn credibility before asking for action.
- Use a peer-to-peer register: "Here's what it does and doesn't do" is more effective
  than "Transform your workflow". Communities reward honesty.
- Cite the specific, unglamourized differentiators.

Do NOT change: the structure plan, section order, or any section other than hero.
The intent's structure plan (sections, emphasis) remains unchanged.

${NEVER_SAY_THE_SOURCE}`,

    organic: `---
SOURCE MODIFIER: Organic search visitor

This visitor arrived via organic search (Google, Bing, DuckDuckGo) or a comparison
site (G2, Capterra, Product Hunt). They were searching for something specific.

Adjust ONLY the hero section's opening 2-3 sentences:
- Open with the words such a visitor uses for their need. If people look for "best UX
  courses in Azerbaijani", say "Azerbaijani UX course" in the hero, as a statement
  about the product, never about the reader's search.
- Problem-aware tone: assume they are at the research stage, not the buying stage.
  Build trust and demonstrate relevance before asking for commitment.
- Natural phrasing, not keyword-stuffed, in the words people use for this need.

Do NOT change: the structure plan, section order, or any section other than hero.
The intent's structure plan (sections, emphasis) remains unchanged.

${NEVER_SAY_THE_SOURCE}`,

    paid: `---
SOURCE MODIFIER: Paid visitor

This visitor clicked a promise a moment ago and decides in seconds whether this page
keeps it. They have not settled in to read.

Adjust ONLY the hero section's opening 2-3 sentences:
- State the one thing the page offers and the one action, in the page's own words,
  in the first sentence. No detours, no story before the offer.
- One offer, one action: the hero's button keeps what it does and says it plainly.
- Concrete and calm. Never a price, discount, offer or eligibility the other versions
  do not state: the page offers this reader exactly what it offers everyone.

Do NOT change: the structure plan, section order, or any section other than hero.
The intent's structure plan (sections, emphasis) remains unchanged.

${NEVER_SAY_THE_SOURCE}`,
  };

  return modifiers[sourceDim as SourceDim] ?? "";
}
