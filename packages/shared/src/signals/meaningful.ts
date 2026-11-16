/**
 * Product rule: "personalize only when there's a reason to."
 *
 * A meaningful signal is anything that tells us WHY a visitor came:
 *   - UTM params (campaign/source/medium/term/content) → tagged-link arrival
 *   - External referrer host → came FROM somewhere identifiable
 *   - AI source (UA or referrer host) → arrived from ChatGPT / Claude / Perplexity
 *   - In-app browser marker or click-id name (L2) → the channel that built
 *     the link, recovered when the webview stripped the referrer
 *   - An intent-bearing entry path (e.g. /pricing, /compare, /docs) → the
 *     visitor CHOSE a page that discloses why they came (L1, ADR 0023).
 *     Context-only paths (demo/trial → urgency) do NOT qualify — see
 *     pathCarriesIntent.
 *
 * Passive attributes (language, country, device class, timezone) are
 * NOT meaningful on their own — every visitor has them. They contribute
 * context to the IntentVector only when paired with a real signal. The
 * entry path is different: choosing /pricing is an active disclosure, not
 * an ambient attribute every visitor carries.
 *
 * When this returns false, the edge serves `source: "original"` with
 * `variant: null` and the snippet leaves the page untouched. This
 * preserves the customer's hand-written copy for brand-aware returning
 * visitors who would otherwise get snapped to the deterministic default
 * fallback (brand/direct → which can look wrong when there's no actual
 * "you're returning" signal — it's just the absence of anything else).
 *
 * Privacy: no new data collection. Pure read over existing extracted
 * Signals. Aligns with the privacy-zero positioning — we use less of
 * what we have, not more.
 */

import { pathCarriesIntent } from "../classify/path-intent.ts";
import type { Signals } from "../types.ts";

export function hasMeaningfulSignal(signals: Signals): boolean {
  return hasSourceSignal(signals) || pathOpensGate(signals);
}

/**
 * True when the landing path alone may personalise the visit: it raises an
 * intent (the customer's site map first, then the global table, through the
 * same helper the classifier reads), and the page has versions of its own.
 * A path on a page without them still adds to the vector when another
 * signal opened the gate, but never opens it: the cascade would write the
 * homepage's versions on another page (docs/specs/site-shaped-intents.md
 * §6.2, the founder's decision 2 of 2026-10-05, for the global table too).
 * `pageHasVersions` absent: unknown, as before.
 */
export function pathOpensGate(signals: Signals): boolean {
  return (
    signals.pageHasVersions !== false && pathCarriesIntent(signals.entryPath, signals.sitePath)
  );
}

/**
 * True when the page says WHERE the visitor came from: a utm, a referrer
 * from another site, an AI source, an in-app marker or a click-id name.
 * The entry path is left out: it says why, never from where.
 *
 * Session carry uses the difference (docs/specs/session-carry.md, "Path
 * pages keep the carried source"): a later page whose only signal is its
 * path takes its intent from the path and its source from the tab's carry,
 * so a ChatGPT visit that clicks to /pricing stays an AI visit. A real new
 * source still wins.
 */
export function hasSourceSignal(signals: Signals): boolean {
  if (signals.utm && Object.keys(signals.utm).length > 0) return true;
  if (signals.referrerHost) return true;
  if (signals.aiSource) return true;
  // L2: a webview marker or a click id says which channel built the link,
  // even though the referrer was stripped. That is a real "where from".
  // A low-confidence webview guess (iOS heuristic) is a prior, not a signal
  // (ADR 0017): it never turns personalisation on by itself.
  if (signals.appSource && signals.appSource.confidence !== "low") return true;
  if (signals.clickId) return true;
  return false;
}
