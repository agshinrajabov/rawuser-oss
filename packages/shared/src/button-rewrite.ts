/**
 * Buttons stay as built until the operator turns one on (the founder's
 * decision of 2026-10-12, docs/specs/button-rewrite.md).
 *
 * The switch is one field in the manifest entry of the button itself:
 * `rewrite: true`. Absent, or anything else, is off. It has no meaning on a
 * part that is not a button.
 *
 * This file is the rule both workers stand on for what a visitor's browser
 * is given: the visitor bundle (`visitorBundleFrom`, built by generation at
 * every confirm and sweep and by the edge when KV has none) and the edge's
 * own answers when it reads a manifest from the database. An off button is
 * treated exactly like a part the manifest does not have: not a target, so
 * the snippet never writes a label an older version still carries.
 *
 * Whether a button's clicks are counted is another table
 * (`conversion_targets`) and another question: a counted button is in the
 * bundle's `conv` whatever this switch says.
 *
 * Generation has the same four functions in
 * packages/generation/src/lib/button-rewrite.ts and lint/cta-action.ts,
 * written first; packages/edge/test/button-rewrite-parity.test.ts holds the
 * two to the same answers until generation imports these.
 *
 * `writtenSections` is the same rule on a version's words (2026-10-12, the
 * lab recheck, H9): a version written before the button was turned off
 * still carries its label, and the snippet writes a part the page tags
 * itself (`data-rawuser="hero.cta.label"`) whatever the targets say. So the
 * words of a button that is not a part of the page's written manifest are
 * left out of what a browser is given.
 */

import type { ElementTargets, Manifest } from "./types.ts";

/** A button label path: `hero.cta.label`, `cta.cta.label`, `forms.submit_label`. */
export function isButtonLabelPath(path: string): boolean {
  return /\.(?:label|submit_label)$/.test(path);
}

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
 * changed by this. Applying it twice changes nothing, as long as the switch
 * is still on the entries (so before `manifestForVisitors`, never after).
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

/** A plain object, never an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lists(written: Readonly<Record<string, unknown>>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(written, path);
}

/** Deeper than any version goes; past it an object is left as it is. */
const MAX_SECTION_DEPTH = 6;

/**
 * `obj` without the words of the buttons `written` does not list, or null
 * when nothing under it had to go (the caller keeps the object it has).
 */
function withoutOffButtons(
  obj: Readonly<Record<string, unknown>>,
  prefix: string,
  written: Readonly<Record<string, unknown>>,
  depth: number,
): Record<string, unknown> | null {
  let out: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    let drop = false;
    let next: unknown = value;
    if (typeof value === "string") {
      if (key === "href") {
        // The link beside a button's label goes with the label, unless the
        // manifest lists the link as a part of its own (`writtenManifest`
        // keeps an href whose label the manifest never had).
        drop = !lists(written, path) && !lists(written, `${prefix}.label`);
      } else {
        // A second or third length rides with its base (`label_alt`).
        const base = path.replace(/_alt2?$/, "");
        drop = isButtonLabelPath(base) && !lists(written, base);
      }
    } else if (isRecord(value) && depth < MAX_SECTION_DEPTH) {
      const child = withoutOffButtons(value, path, written, depth + 1);
      if (child) {
        next = child;
        // A holder left with nothing to write (empty, or its `kind` alone)
        // goes too, as generation leaves it out of a body it writes today.
        drop = Object.keys(child).every((k) => k === "kind");
      }
    }
    if (drop || next !== value) {
      out ??= { ...obj };
      if (drop) delete out[key];
      else out[key] = next;
    }
  }
  return out;
}

/**
 * A version's `sections` as a browser is given them on a page that has a
 * manifest: without the label of a button that is not a part of `written`,
 * its other lengths (`label_alt`, `label_alt2`) and the link beside it
 * (`hero.cta.href` beside `hero.cta.label`).
 *
 * `written` is the manifest of the parts Rawuser writes on the page
 * (`writtenManifest` of the stored one, or the page's entry in the visitor
 * bundle, which is that). A button it does not list is off, or was never a
 * part of the page: the same thing ("What off means", button-rewrite.md).
 * A button it lists is on and keeps every word. Nothing else is touched:
 * headlines, paragraphs, `kind`, and the link of a button that is on.
 *
 * The stored body is never changed: when something has to go the answer is
 * a copy along that path, and when nothing has to go it is `sections`
 * itself. A page without a manifest has no switch and is not asked here
 * (the caller sends its body as stored).
 */
export function writtenSections<T>(sections: T, written: Readonly<Record<string, unknown>>): T {
  if (!isRecord(sections)) return sections;
  return (withoutOffButtons(sections, "", written, 0) ?? sections) as T;
}
