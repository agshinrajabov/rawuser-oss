/**
 * selector-health — server-side validation of detected CSS selectors (T1c,
 * element-detection-v2).
 *
 * The LLM can hallucinate selectors, or emit ones that match zero or many
 * elements. Nothing caught that before the operator confirmed and visitors
 * started skipping. This module replays every detected CSS selector against
 * the SAME HTML the detection saw (node-html-parser — pure JS, Workers-safe)
 * and reports a per-selector status the dashboard can surface as warnings.
 *
 * Advisory by design: statuses never block detection or confirmation — the
 * operator stays the decision-maker, and the parser's CSS support is a
 * subset of a real browser's (unsupported syntax is reported as such, not
 * treated as broken).
 */

import type { Manifest } from "@rawuser/shared";
import { parse } from "node-html-parser";

export type SelectorStatus =
  /** Exactly one match — what a good selector looks like. */
  | "ok"
  /** Matches 2+ elements — the snippet would swap all of them. */
  | "multiple"
  /** Matches nothing in the source HTML — likely hallucinated or dynamic. */
  | "none"
  /** node-html-parser couldn't evaluate the selector — no verdict. */
  | "unsupported";

export interface SelectorCheck {
  selector: string;
  status: SelectorStatus;
}

/** Dot-path → per-CSS-selector checks, in manifest order. */
export type SelectorHealth = Record<string, SelectorCheck[]>;

export function validateSelectors(html: string, manifest: Manifest): SelectorHealth {
  const health: SelectorHealth = {};

  let root: ReturnType<typeof parse>;
  try {
    root = parse(html);
  } catch {
    // Unparseable HTML → no verdicts at all; report everything unsupported
    // rather than pretending the selectors are broken.
    for (const [dotPath, targets] of Object.entries(manifest)) {
      health[dotPath] = targets.css.map((selector) => ({
        selector,
        status: "unsupported" as const,
      }));
    }
    return health;
  }

  for (const [dotPath, targets] of Object.entries(manifest)) {
    health[dotPath] = targets.css.map((selector) => {
      try {
        const matches = root.querySelectorAll(selector);
        if (matches.length === 1) return { selector, status: "ok" as const };
        if (matches.length === 0) return { selector, status: "none" as const };
        return { selector, status: "multiple" as const };
      } catch {
        return { selector, status: "unsupported" as const };
      }
    });
  }

  return health;
}

/**
 * True when every element has at least one "ok" selector — the summary the
 * dashboard uses to decide whether to show a warning banner at all.
 */
export function allElementsHealthy(health: SelectorHealth): boolean {
  return Object.values(health).every((checks) => checks.some((c) => c.status === "ok"));
}
