/**
 * Ad link templates, one line per platform (docs/specs/ads-platforms.md §2,
 * part 1; privacy review CONDITIONAL PASS 2026-10-22, condition 1).
 *
 * The customer pastes a line into the platform's own URL parameter field.
 * Every macro is filled by the platform at click time; Rawuser reads only
 * what lands in the URL, in memory at `/select` (the source and medium say
 * which version; the campaign and the search keyword may choose an intent,
 * screened first). Nothing here is ever stored.
 *
 * Rules the tests hold every shipped line to:
 * - only the macros of AD_MACRO_ALLOWLIST, never one of AD_MACRO_NEVER
 *   (an ad set or ad group, where targeting lives; a remarketing list id;
 *   a city; a device; a Display placement; a per-click value; the
 *   visitor's own search);
 * - `utm_term` only on a search template: the edge reads it as an ad
 *   keyword (keyword-intent.md), and an audience name there would be
 *   matched against the lexicon;
 * - a reduced line (a sensitive customer, or a special-category yes) has
 *   the source and medium parts only; Meta's `{{site_source_name}}` stays,
 *   as it is the platform's surface code, not a name (privacy review, 2026-10-22).
 *
 * Wording from the approved mock (design/mock/sales-readiness/ads-platforms.html).
 */

export type AdPlatform = "google" | "microsoft" | "meta" | "tiktok" | "linkedin" | "x";

export interface AdTemplate {
  platform: AdPlatform;
  group: "search" | "social";
  label: string;
  /** Where in the ad account the line goes. */
  where: string;
  /** The full line, as in spec §2 (TikTok uses `__CID_NAME__`, the ad, never the ad group). */
  template: string;
  /** Source and medium parts only, for a sensitive or special-category customer. */
  reduced: string;
  /** One line beside the template (LinkedIn's syntax, X's own word). */
  note?: string;
  /** X: the customer types their own campaign word, appended to `template`. */
  needsWord?: boolean;
}

export const AD_TEMPLATES: readonly AdTemplate[] = [
  {
    platform: "google",
    group: "search",
    label: "Google Ads",
    where: "Final URL suffix, account level",
    template: "utm_source=google&utm_medium=cpc&utm_term={keyword}",
    reduced: "utm_source=google&utm_medium=cpc",
  },
  {
    platform: "microsoft",
    group: "search",
    label: "Microsoft Ads",
    where: "Final URL suffix, account level",
    template: "utm_source=bing&utm_medium=cpc&utm_campaign={Campaign}&utm_term={keyword}",
    reduced: "utm_source=bing&utm_medium=cpc",
  },
  {
    platform: "meta",
    group: "social",
    label: "Meta",
    where: "Each ad, URL parameters",
    template:
      "utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}",
    reduced: "utm_source={{site_source_name}}&utm_medium=paid_social",
  },
  {
    platform: "tiktok",
    group: "social",
    label: "TikTok",
    where: "Each ad, URL parameters",
    template:
      "utm_source=tiktok&utm_medium=paid_social&utm_campaign=__CAMPAIGN_NAME__&utm_content=__CID_NAME__",
    reduced: "utm_source=tiktok&utm_medium=paid_social",
  },
  {
    platform: "linkedin",
    group: "social",
    label: "LinkedIn",
    where: "Account settings, URL parameters",
    template: "utm_source=linkedin&utm_medium=paid_social&utm_campaign={CAMPAIGN_NAME}",
    reduced: "utm_source=linkedin&utm_medium=paid_social",
    note: "Check the syntax in Campaign Manager first.",
  },
  {
    platform: "x",
    group: "social",
    label: "X",
    where: "Website card URL, after a ?",
    template: "utm_source=x&utm_medium=paid_social&utm_campaign=",
    reduced: "utm_source=x&utm_medium=paid_social",
    note: "X has no campaign macro. Type your own campaign word.",
    needsWord: true,
  },
];

/**
 * The only macros a template may carry (spec §2). Written as they appear
 * in a template, delimiters included, so `adMacros` output compares as is.
 * LinkedIn's campaign name in both forms its guides show.
 */
export const AD_MACRO_ALLOWLIST: readonly string[] = [
  "{keyword}",
  "{Campaign}",
  "{{site_source_name}}",
  "{{campaign.name}}",
  "{{ad.name}}",
  "__CAMPAIGN_NAME__",
  "__CID_NAME__",
  "{CAMPAIGN_NAME}",
  "CAMPAIGN_NAME",
];

/**
 * Macros that never go in a template (spec §2, privacy review 2026-10-22): ad set
 * and ad group names (where targeting lives), remarketing list ids, city
 * level location, device, a Display placement (the site the visitor was
 * reading), per-click values (ADR 0028) and the visitor's own search.
 */
export const AD_MACRO_NEVER: readonly string[] = [
  "{AdGroup}",
  "{AdGroupId}",
  "{adgroupid}",
  "{{adset.name}}",
  "{{adset.id}}",
  "__AID_NAME__",
  "__AID__",
  "{targetid}",
  "{TargetId}",
  "{loc_physical_ms}",
  "{loc_interest_ms}",
  "{device}",
  "{devicemodel}",
  "{placement}",
  "{gclid}",
  "{msclkid}",
  "{random}",
  "__CALLBACK_PARAM__",
  "{QueryString}",
];

/**
 * Every macro in a template, in order, as written: `{{x}}`, `{x}`,
 * `__X__`, and LinkedIn's bare form (an upper-case word with an underscore
 * as a whole value, `CAMPAIGN_NAME`).
 */
export function adMacros(template: string): string[] {
  const re =
    /\{\{[^{}]+\}\}|\{[^{}]+\}|__[A-Z0-9]+(?:_[A-Z0-9]+)*__|(?<![A-Za-z0-9_{])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![A-Za-z0-9_}])/g;
  return template.match(re) ?? [];
}
