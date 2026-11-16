/**
 * Turn an engine section path (e.g. "hero.cta.label") into a plain-language
 * element name (e.g. "Hero button") for the Goals screen (ADR 0024). The raw
 * path is still the stored/API value; this is display only.
 */
import { COUNTS_ON_EVERY_PAGE, isSiteWideTarget, siteSelectorOf } from "@/lib/site-wide";
import type { ConversionTarget } from "@/types/api";
import { COUNT_TARGET_PREFIX } from "@rawuser/shared";

const SECTION_LABELS: Record<string, string> = {
  hero: "Hero",
  cta: "Final CTA",
  features: "Features",
  features_core: "Features",
  pricing: "Pricing",
  social_proof: "Social proof",
  comparison: "Comparison",
  faq: "FAQ",
  forms: "Form",
};

/** The Element cell on the Conversions screen: its name and, for a hand-typed selector, the selector as a small detail. */
export interface ElementCell {
  name: string;
  detail: string | null;
}

/**
 * A slot row shows its element ("Hero button"); a picked row its page; a
 * site-wide row (a navbar link added by its CSS selector, or marked `site`
 * by the API) "Counts on every page" with the selector as its detail, never
 * as its name.
 */
export function elementCell(t: Pick<ConversionTarget, "section_path" | "site">): ElementCell {
  if (!t.section_path.startsWith(COUNT_TARGET_PREFIX) && isSiteWideTarget(t)) {
    return { name: COUNTS_ON_EVERY_PAGE, detail: siteSelectorOf(t.section_path) };
  }
  return { name: humanizeSectionPath(t.section_path), detail: null };
}

export function humanizeSectionPath(path: string): string {
  if (!path) return "";
  // A button picked with the count link counts on its own page only
  // (docs/specs/visual-picker.md section 9.5): say which page.
  if (path.startsWith("count:")) return `Picked on ${path.slice("count:".length) || "/"}`;
  const parts = path.split(".");
  const section = SECTION_LABELS[parts[0] ?? ""] ?? parts[0] ?? path;
  // A button/CTA element.
  if (path.endsWith("cta.label") || path.endsWith(".cta") || parts.includes("cta")) {
    return `${section} button`;
  }
  // A form submit element (e.g. forms.submit_label → "Form submit button").
  if (path.endsWith("submit_label") || parts.includes("submit")) {
    return `${section} submit button`;
  }
  if (parts.includes("headline")) return `${section} headline`;
  if (parts.includes("body")) return `${section} text`;
  if (path.endsWith("label")) return `${section} button`;
  return section;
}
