import { manifestForVisitors, writtenSections } from "@rawuser/shared";
import type { Manifest, VariantBody } from "@rawuser/shared/types";

/**
 * The manifest as a visitor's browser receives it: without what only
 * generation needs (the wrap measurement, docs/specs/interactive-text.md
 * §3.4) and without the operator's rewrite switch of a button
 * (docs/specs/button-rewrite.md). Page facts either way, but a visitor
 * never downloads more than the snippet reads.
 *
 * One definition with the bundle's own (shared `manifestForVisitors`). It is
 * applied again to a manifest that came out of the bundle, because a bundle
 * written by a generation worker built before this change (`719cffa6`)
 * still carries `rewrite: true` on a button that is on.
 *
 * It removes fields, never parts. A manifest read from the database goes
 * through `writtenManifest` first (index.ts, the answer without a bundle).
 */
export function forVisitors(manifest: Manifest): Manifest {
  return manifestForVisitors(manifest);
}

/**
 * The one customer whose page reads the version's words itself: the
 * operator's own site, when it renders its hero from the body (a component
 * that asks /select and /select-bulk and prints `hero.cta.label`) instead of
 * running the snippet. No target list ever decided what is written on such
 * a page, so its bodies go out as stored, on both endpoints, and a toggle
 * between its versions says the same as the live one.
 *
 * An install names that customer in OWN_SITE_CUSTOMER. Unset, there is no
 * such customer: every body follows its page's manifest and /select-bulk
 * answers 404.
 */
export function ownSiteCustomer(env: { OWN_SITE_CUSTOMER?: string }): string | null {
  const id = (env.OWN_SITE_CUSTOMER ?? "").trim();
  return id === "" ? null : id;
}

/**
 * The version as a visitor's browser receives it on a page with this
 * manifest (the lab recheck of 2026-10-12, task H9): the words of a button
 * the operator has not turned on are left out, because the snippet writes a
 * part the page tags itself (`data-rawuser="hero.cta.label"`) whatever the
 * targets say, and a version written before the switch still carries the
 * label. `written` is the manifest the same answer sends as `targets`
 * (the bundle's page, or `writtenManifest` of the stored one), so no read
 * is added and the words and the targets cannot disagree.
 *
 * A page with no manifest (`written` null: a site that tags its own
 * elements and never confirmed a page) has no entry to hold a switch; the
 * tag on its button is the page author's own yes (button-rewrite.md, "Not
 * built, and why"), and its body goes out as stored.
 *
 * Only `sections` can differ. `body_id` and `prompt_hash` stay those of the
 * stored body, which is not changed: the id names the version that was
 * selected, and the same body gives the same sections on /select and
 * /carry, so the snippet's comparison of the two still holds.
 */
export function bodyForVisitors(
  customerId: string,
  variant: VariantBody,
  written: Manifest | null | undefined,
  ownSite: string | null,
): VariantBody {
  if (!written || customerId === ownSite) return variant;
  const sections = writtenSections(variant.sections, written);
  return sections === variant.sections ? variant : { ...variant, sections };
}
