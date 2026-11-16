/**
 * A button on every page: a navbar "Əlaqə" or a phone link added by hand on
 * the Conversions screen with a CSS selector (`a[href$=contact]`). Such a
 * target counts clicks on every page of the site, pages without versions
 * too, so Results, the button list and the Conversions screen say so
 * instead of "on the homepage".
 *
 * Shared by lib/measure.ts and lib/page-groups.ts (which imports measure).
 */

import type { ConversionTarget } from "@/types/api";
import { COUNT_TARGET_PREFIX } from "@rawuser/shared";

/** A site-wide target's prefix, when the worker writes one. */
export const SITE_TARGET_PREFIX = "site:";
export const ON_EVERY_PAGE = "on every page";
export const COUNTS_ON_EVERY_PAGE = "Counts on every page";

/** A manifest slot path: dot-separated lowercase words, `hero.cta.label`, `forms.submit_label`. */
const SLOT_PATH = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * True when the button counts on every page. The API's `site` mark decides
 * when it is there; without it (a worker older than 2026-10-13), a
 * `section_path` that is neither a count pick nor a slot path is such a
 * selector, and one that starts with `site:` is one by name.
 */
export function isSiteWideTarget(t: Pick<ConversionTarget, "section_path" | "site">): boolean {
  if (typeof t.site === "boolean") return t.site;
  const path = t.section_path;
  if (path.startsWith(SITE_TARGET_PREFIX)) return true;
  if (path.startsWith(COUNT_TARGET_PREFIX)) return false;
  return !SLOT_PATH.test(path);
}

/** The selector behind a site-wide target, its `site:` prefix taken off; null when there is none. */
export function siteSelectorOf(sectionPath: string): string | null {
  const s = sectionPath.startsWith(SITE_TARGET_PREFIX)
    ? sectionPath.slice(SITE_TARGET_PREFIX.length)
    : sectionPath;
  return s.trim() === "" ? null : s;
}
