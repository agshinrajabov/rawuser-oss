import { DEFAULT_SELECTORS } from "./defaults.ts";
import type { ManifestEntry } from "./types.ts";

/**
 * Find DOM elements for a given dot-path (e.g. "hero.headline").
 *
 * Three-tier resolution — tried in priority order:
 *
 * Tier 1 — data-rawuser attribute (V1 primary):
 *   querySelector('[data-rawuser="<path>"]'). Returns ALL matches so
 *   repeated elements (e.g. two CTAs with the same role) all get updated.
 *   If any match, stop here.
 *
 * Tier 2 — manifest entry from the edge (detected + confirmed, or picked
 *   on the page). Try in order:
 *   a) css[]   — first selector that matches ≥1 element wins (all returned).
 *   b) text[]  — first signature where any element textContent starts-with wins.
 *   c) structural — mini-parser for human-readable descriptors + raw-CSS fallback.
 *
 * Tier 3 — convention-based default selector (zero-config fallback):
 *   DEFAULT_SELECTORS[path]. Returns the first match only (querySelector).
 *   Only reached when the manifest has no usable entry for the path.
 *
 * @returns Array of matched elements (may be empty — callers must handle).
 */
export function findTargets(path: string, manifest?: ManifestEntry): Element[] {
  // Tier 1: data-rawuser attribute
  const byAttr = document.querySelectorAll(`[data-rawuser="${path}"]`);
  if (byAttr.length > 0) {
    return Array.from(byAttr);
  }

  // Tier 2: the manifest (detected and confirmed by the operator, or picked
  // by hand on the page). It beats the convention defaults: an operator who
  // pointed at a specific element must not lose to `h1:first-of-type`
  // (docs/specs/visual-picker.md §3).
  if (manifest) {
    // 2a. CSS selectors — first that matches ≥1 element wins; return all.
    for (const selector of manifest.css) {
      try {
        const matches = document.querySelectorAll(selector);
        if (matches.length > 0) return Array.from(matches);
      } catch {
        // Invalid CSS selector from AI output — skip safely.
      }
    }

    // 2b. Text signatures — search inside common content containers.
    for (const sig of manifest.text) {
      const scope = document.querySelector("main") ?? document.body;
      if (!scope) continue; // the head is still parsing
      const candidates = scope.querySelectorAll("*");
      // Whitespace-insensitive: signatures are collapsed at detection and
      // pick time; the live DOM carries newlines and indentation.
      const want = sig.replace(/\s+/g, " ").trim();
      for (const el of candidates) {
        const have = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (have.startsWith(want)) {
          return [el];
        }
      }
    }

    // 2c. Structural descriptor — mini-parser + raw-CSS fallback.
    const structural = resolveStructural(manifest.structural);
    if (structural.length > 0) return structural;
  }

  // Tier 3: convention-based default selector, for customers with no
  // manifest entry for this path (zero-config pages).
  const defaultSelector = DEFAULT_SELECTORS[path];
  if (defaultSelector) {
    const el = document.querySelector(defaultSelector);
    if (el) return [el];
  }

  return [];
}

/**
 * Resolve a structural descriptor to a DOM element list.
 *
 * Supported vocabulary:
 *  "first {tag} in {scope}"             → querySelector('{scope} {tag}')
 *  "primary CTA in the hero section"    → querySelector('header a, header button, .hero a, .hero button')
 *  "first {tag}"                        → querySelector('{tag}')
 *  <anything else>                      → querySelector(descriptor) as raw CSS (AI sometimes outputs CSS)
 *
 * querySelector with an invalid selector returns null (no throw in modern
 * browsers); we wrap in try/catch for older engines. Never executes JS.
 */
function resolveStructural(descriptor: string): Element[] {
  if (!descriptor) return [];

  // "primary CTA in the hero section" — named constant pattern.
  if (descriptor === "primary CTA in the hero section") {
    const el = document.querySelector("header a, header button, .hero a, .hero button");
    return el ? [el] : [];
  }

  // "first {tag} in {scope}" — e.g. "first h1 in main"
  const inMatch = /^first\s+(\S+)\s+in\s+(.+)$/i.exec(descriptor);
  if (inMatch) {
    const tag = inMatch[1] ?? "";
    const scope = (inMatch[2] ?? "").trim();
    try {
      const el = document.querySelector(`${scope} ${tag}`);
      return el ? [el] : [];
    } catch {
      return [];
    }
  }

  // "first {tag}" — e.g. "first h1"
  const firstMatch = /^first\s+(\S+)$/i.exec(descriptor);
  if (firstMatch) {
    try {
      const el = document.querySelector(firstMatch[1] ?? "");
      return el ? [el] : [];
    } catch {
      return [];
    }
  }

  // Raw CSS fallback — AI sometimes outputs a valid CSS selector string.
  try {
    const el = document.querySelector(descriptor);
    return el ? [el] : [];
  } catch {
    return [];
  }
}
