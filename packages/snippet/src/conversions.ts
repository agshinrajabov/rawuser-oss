/**
 * Snippet-side conversion click capture (V2 Module 3 + Fix Pass A / QA-4).
 *
 * Uses a SINGLE document-level click listener with selector matching via
 * `event.target.closest()`. This pattern is required for framework-rendered
 * sites (React/Next.js, Vue/Nuxt, Svelte/SvelteKit, Solid) where hydration
 * or any subsequent render replaces DOM nodes — listeners attached directly
 * to those nodes are lost. The customer ICP (AI-built sites from Lovable,
 * v0, Bolt, Cursor) is almost entirely framework-rendered, so direct-node
 * attachment was a non-starter (see QA Part 2 report and ADR 0020).
 *
 * `closest()` walks ancestors, so a click on a span/icon nested inside a
 * CTA anchor still resolves to the anchor — the conversion fires.
 *
 * { capture: true } means we see the click in the capture phase before
 * any framework code can call stopPropagation. Even if framework wrappers
 * eat the event during the bubble phase, the conversion event has already
 * been queued (a keepalive fetch, events.ts), best-effort fire-and-forget.
 *
 * Privacy invariants (unchanged from V2 M3.9):
 * - The handler captures no event metadata beyond the target's
 *   conversion_label, page_path, and variant attribution fields.
 * - No click coordinates, no surrounding DOM, no form field values.
 * - The body is exactly the same EventPayload the /event endpoint
 *   already validates.
 */

import { writeCarry } from "./carry.ts";
import { fireEvent, pagePath } from "./events.ts";
import type { EventPayload, Provenance } from "./types.ts";

/**
 * One confirmed conversion target from the /select response.
 * Mirrors ConversionTargetForClient in packages/edge/src/index.ts.
 */
export interface ConversionTarget {
  section_path: string;
  conversion_label: string;
  css: string[];
  text: string[];
  structural: string;
  /**
   * Page one chooses page two (docs/specs/direct-visitors.md §4): the intent
   * word a click on this button keeps in the tab's carry. Sent by the edge
   * only on a no-signal answer; nothing about the click is kept or sent.
   */
  i?: string;
}

interface InstallContext {
  edgeOrigin: string;
  customerId: string;
  /**
   * The cohort the visitor was placed in for this visit (set at /select
   * time). Threaded through so the conversion event is attributed to the
   * same cohort as the corresponding variant_shown event. Without this,
   * conversion rows land with cohort=NULL and the aggregator coerces them
   * to "personalized" via COALESCE — silently distorting holdout_lift
   * once the holdout cohort starts converting (F20).
   */
  cohort?: "personalized" | "holdout" | "skipped" | "no_signal";
  /**
   * The page's arm and version id (docs/specs/proof-engine.md, C), the cell
   * its exposure named and the tab's visit marker, so the conversion counts
   * for the same visit as its impression; spread last into the conversion.
   */
  prov?: Provenance & Pick<EventPayload, "variant_key" | "intent_dim" | "source_dim">;
}

/**
 * Try every selector configured for a target and return the first that
 * matches the click via closest(). Returns null if none match.
 *
 * Order: css[] first, then `structural` if it parses as a CSS selector.
 * Text-signature tier (.text[]) isn't usable with delegation (we can't
 * walk ancestors and test startsWith on every textContent without
 * burning CPU on every click); in practice operator-confirmed targets
 * always have a stable CSS selector — text is the manifest-detection
 * fallback, not the conversion-confirm path.
 */
function targetMatchesClick(t: ConversionTarget, click: Element): boolean {
  for (const selector of t.css) {
    try {
      if (click.closest(selector) !== null) return true;
    } catch {
      // Invalid selector — skip.
    }
  }
  if (t.structural) {
    try {
      if (click.closest(t.structural) !== null) return true;
    } catch {
      // structural may be a human-readable descriptor, not valid CSS.
    }
  }
  return false;
}

/**
 * Install a SINGLE document-level click delegate that fires a conversion
 * event the first time a click matches any of the supplied targets.
 *
 * Returns silently — no error surface to the visitor.
 *
 * Multiple targets pointing at the same element: the first matching
 * target wins (loop order). Operator-configured ordering is preserved.
 */
let current: { targets: ConversionTarget[]; ctx: InstallContext } | null = null;
let listeningOn: Document | null = null;

export function installConversionListeners(targets: ConversionTarget[], ctx: InstallContext): void {
  // One listener for the life of the page; each run (initial load or a
  // client-side navigation) swaps in its own targets and attribution.
  // A page without targets clears the previous route's attribution; the
  // document listener itself is added only once there is something to count.
  current = targets.length === 0 ? null : { targets, ctx };
  if (listeningOn === document || !current) return;
  listeningOn = document;

  document.addEventListener(
    "click",
    (e) => {
      const node = e.target;
      if (!(node instanceof Element) || !current) return;
      const { targets, ctx } = current;
      for (const target of targets) {
        if (targetMatchesClick(target, node)) {
          const payload: EventPayload = {
            event_type: "conversion",
            page_path: pagePath(),
            conversion_label: target.conversion_label,
            // An undefined field is left out of the JSON body. The cell, the
            // arm, the version's id and the visit marker ride in `prov`.
            cohort: ctx.cohort,
            ...ctx.prov,
          };
          // leaving: a keepalive text/plain fetch survives the navigation.
          fireEvent(ctx.edgeOrigin, ctx.customerId, payload, true);
          // One word for the next page, in the carry the tab already keeps.
          if (target.i) writeCarry(target.i, "direct");
          return;
        }
      }
    },
    { capture: true, passive: true },
  );
}
