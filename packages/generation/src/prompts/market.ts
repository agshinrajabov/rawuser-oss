/**
 * The MARKET block of a market version's prompt (ADR 0038 part 5;
 * docs/specs/direct-visitors.md §5). Appended like a source modifier: the
 * structure plan and the page's language stay; the wording addresses the
 * market, never the reader.
 */

/** The country's English name for the prompt; the code when the runtime has no names. */
export function countryName(cc: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(cc) ?? cc;
  } catch {
    return cc;
  }
}

export function buildMarketModifier(cc: string): string {
  const name = countryName(cc);
  return `---
MARKET MODIFIER: visitors in ${name} (${cc})

This version is shown to visitors whose connection or browser language region is
${name}, when nothing else says why they came. It is written for that market.

- Write in the page's own language, in the spelling, punctuation and number and date
  formats used in ${name} for that language (for example British spelling for the
  United Kingdom). Never switch to another language.
- Use proof and facts that concern ${name} only when the brief or the page states
  them (customers, offices, laws, certifications, support hours). Invent nothing.
- You may name ${name} as a market the product serves only when the brief or the
  page says it serves it.
- Never say or imply where the reader lives, is from or is right now, and never
  their nationality or origin: no "your country", "from ${name}", "as a ... founder",
  "visitors from", "local to you".
- Never change a price, a currency, an offer, a discount, a plan, availability or
  who may buy. Every number as the brief gives it.

Do NOT change: the structure plan, section order, or the parts written.`;
}
