/**
 * Buttons are not rewritten unless the operator turns that button on (the
 * founder's decision of 2026-10-12, docs/specs/pilot-gaps.md, "The
 * founder's approvals", 3; mock design/mock/sales-readiness/pilot-gaps.html,
 * screen 04).
 *
 * On the pilot's site 7 of 20 versions gave the hero button words that asked for
 * something else on a link that opens the product list, and after the action
 * was fixed 15 of 20 named another thing. So a button keeps the page's own
 * words by default.
 *
 * The switch lives in the manifest entry of the button itself:
 * `rewrite: true`. Absent, or anything else, is off. It has no meaning on a
 * part that is not a button. No migration and no new table: the manifest is
 * JSON, and every reader below asks this file.
 *
 * What "off" means, everywhere: the button is treated exactly like a part
 * the manifest does not have. Not in the prompt's field list, not in a body,
 * not linted, not hidden before the first paint, not a target in the visitor
 * bundle. Whether its clicks are counted is another table
 * (`conversion_targets`) and another question: a counted button is counted
 * whatever this switch says.
 *
 * The type of a manifest entry lives in packages/shared and does not name
 * the field yet, so it is read and written through this file only.
 */

import type { ElementTargets, Manifest } from "@rawuser/shared";
import { PICK_SLOTS, countTargetPage } from "@rawuser/shared";
import { isButtonLabelPath } from "../lint/cta-action.ts";
import { partsAsBuiltOf } from "./parts-as-built.ts";

/** True when the operator turned the rewrite of this button on. */
export function rewriteOn(entry: ElementTargets | undefined | null): boolean {
  return (entry as { rewrite?: unknown } | undefined | null)?.rewrite === true;
}

/** A button whose words stay as the page built them. */
export function isOffButton(path: string, entry: ElementTargets | undefined | null): boolean {
  return isButtonLabelPath(path) && !rewriteOn(entry);
}

/**
 * The manifest of the parts Rawuser writes: the stored manifest without the
 * buttons that are off, and without the link path of such a button
 * (`hero.cta.href` beside `hero.cta.label`). The stored manifest is never
 * changed by this; callers keep it for what must still know the button (the
 * counted button's own words, the list on the Look screen).
 */
export function writtenManifest(manifest: Manifest): Manifest {
  const out: Manifest = {};
  for (const [path, entry] of Object.entries(manifest)) {
    if (isOffButton(path, entry)) continue;
    if (path.endsWith(".href")) {
      const label = `${path.slice(0, -".href".length)}.label`;
      if (label in manifest && isOffButton(label, manifest[label])) continue;
    }
    out[path] = entry;
  }
  return out;
}

/** `writtenManifest` for a manifest that may be absent (a customer without one). */
export function writtenManifestOrNull(manifest: Manifest | null | undefined): Manifest | null {
  return manifest ? writtenManifest(manifest) : null;
}

/**
 * True when the page has parts and every one of them is a button that stays
 * as built: there is nothing to write there. Not the same as a customer
 * without a manifest, whose page tags its own elements.
 */
export function nothingToWrite(manifest: Manifest | null | undefined): boolean {
  if (!manifest) return false;
  return Object.keys(manifest).length > 0 && Object.keys(writtenManifest(manifest)).length === 0;
}

/** The confirmed rows as the hide rules and the visitor bundle take them. */
export function writtenRows<T extends { manifest: Manifest }>(rows: readonly T[]): T[] {
  return rows.map((r) => ({ ...r, manifest: writtenManifest(r.manifest) }));
}

/**
 * The manifest with one button's switch set. Null when the path is not a
 * button of this manifest. Off removes the field, so an off button is stored
 * as it always was.
 */
export function setRewrite(manifest: Manifest, path: string, on: boolean): Manifest | null {
  const entry = manifest[path];
  if (!entry || !isButtonLabelPath(path)) return null;
  const { rewrite: _was, ...rest } = entry as ElementTargets & { rewrite?: unknown };
  return {
    ...manifest,
    [path]: (on ? { ...rest, rewrite: true } : rest) as ElementTargets,
  };
}

/** The same element: one selector in common, or the same words on it. */
function sameButton(a: ElementTargets, b: ElementTargets): boolean {
  const css = new Set((a.css ?? []).map((s) => s.trim()).filter(Boolean));
  if ((b.css ?? []).some((s) => css.has(s.trim()))) return true;
  const ta = (a.text?.[0] ?? "").trim().toLowerCase();
  const tb = (b.text?.[0] ?? "").trim().toLowerCase();
  // A signature may be the first forty characters of a longer label.
  return ta !== "" && tb !== "" && (ta.startsWith(tb) || tb.startsWith(ta));
}

/**
 * A manifest read again (a new detection, a pick, the go-live request's own
 * copy) keeps the operator's switch where the button is still the same one.
 * A slot that now points at another element starts off, the safe side. An
 * entry of `next` that says `rewrite` itself, true or false, is the newer
 * word and is kept as it says.
 */
export function carryRewrite(next: Manifest, prev: Manifest | null | undefined): Manifest {
  if (!prev) return next;
  const out: Manifest = { ...next };
  for (const [path, entry] of Object.entries(next)) {
    if (!isButtonLabelPath(path)) continue;
    if ((entry as { rewrite?: unknown }).rewrite !== undefined) continue;
    const before = prev[path];
    if (!before || !rewriteOn(before) || !sameButton(entry, before)) continue;
    out[path] = { ...entry, rewrite: true } as ElementTargets;
  }
  return out;
}

/**
 * The buttons that are on and that this body has no words for, a part left
 * as built by the copy checks aside (its flag says so and a rewrite is not
 * owed). A version written before the switch was turned on.
 */
export function unwrittenButtons(
  manifest: Manifest,
  body: { sections?: unknown },
  lintFlags: readonly string[] = [],
): string[] {
  const asBuilt = new Set(partsAsBuiltOf(lintFlags).map((p) => p.path));
  return Object.entries(manifest)
    .filter(([path, entry]) => isButtonLabelPath(path) && rewriteOn(entry) && !entry.skip)
    .map(([path]) => path)
    .filter((path) => !asBuilt.has(path) && typeof leafAt(body.sections, path) !== "string");
}

function leafAt(sections: unknown, path: string): unknown {
  let at: unknown = sections;
  for (const key of path.split(".")) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** An enabled conversion target, as much of it as "is this button counted" needs. */
export interface CountedTarget {
  section_path: string;
  css?: readonly string[];
  text?: readonly string[];
}

/**
 * True when this button's clicks are counted: an enabled target on its own
 * slot, or a button picked on this page (`count:{page}`) that is the same
 * element.
 */
export function isCounted(
  path: string,
  entry: ElementTargets,
  pagePath: string,
  targets: readonly CountedTarget[],
): boolean {
  return targets.some((t) => {
    if (t.section_path === path) return true;
    if (countTargetPage(t.section_path) !== pagePath) return false;
    return sameButton(entry, {
      css: [...(t.css ?? [])],
      text: [...(t.text ?? [])],
      structural: "",
    });
  });
}

/** One button of a page, for the Look screen's parts list. */
export interface ButtonRow {
  /** The manifest path, for example `hero.cta.label`. */
  path: string;
  /** The slot's plain name ("Hero button"), or the path for a slot without one. */
  label: string;
  /** The page's own words on it (a signature, forty characters at most). */
  text: string;
  /** The operator's switch. Off: the button stays as on the page. */
  rewrite: boolean;
  /** Its clicks are counted; true or false whatever `rewrite` says. */
  counted: boolean;
  /** A form's button: it sends the form, it opens no page. */
  form: boolean;
}

const SLOT_LABELS = new Map(PICK_SLOTS.map((s) => [s.path, s.label]));

/** Every button of a page in the manifest's own order. */
export function buttonsOf(
  manifest: Manifest,
  pagePath: string,
  targets: readonly CountedTarget[] = [],
): ButtonRow[] {
  return Object.entries(manifest)
    .filter(([path]) => isButtonLabelPath(path))
    .map(([path, entry]) => ({
      path,
      label: SLOT_LABELS.get(path) ?? path,
      text: entry.text?.[0] ?? "",
      rewrite: rewriteOn(entry),
      counted: isCounted(path, entry, pagePath, targets),
      form: path.endsWith("submit_label"),
    }));
}

/** The enabled conversion targets of a customer, parsed for `isCounted`. */
export async function loadCountedTargets(
  db: D1Database,
  customerId: string,
): Promise<CountedTarget[]> {
  try {
    const rows = await db
      .prepare(
        "SELECT section_path, css_selectors, text_selectors FROM conversion_targets WHERE customer_id = ? AND enabled = 1",
      )
      .bind(customerId)
      .all<{ section_path: string; css_selectors: string | null; text_selectors: string | null }>();
    return (rows.results ?? []).map((r) => ({
      section_path: r.section_path,
      css: strings(r.css_selectors),
      text: strings(r.text_selectors),
    }));
  } catch {
    return [];
  }
}

function strings(raw: string | null): string[] {
  try {
    const list: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}
