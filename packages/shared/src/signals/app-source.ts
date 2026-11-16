/**
 * In-app browser detection (L2, source recovery, Layers A and B).
 *
 * A link tapped inside a mobile app (Instagram, Facebook, LinkedIn, TikTok…)
 * opens in that app's own webview. The webview sends an empty
 * document.referrer, so the visit lands as "direct" and the channel is
 * lost. What survives:
 *
 *   Layer A, named app: most in-app browsers append the app's name to the
 *   User-Agent (table APP_UAS). High confidence.
 *   Layer B, some app: Chromium sends the low-entropy Client Hints header
 *   Sec-CH-UA on every request, and inside an Android WebView its brands
 *   list literally contains "Android WebView". Medium confidence, app
 *   unknown. Fallback: the "; wv)" token in the UA string. On iOS a
 *   WKWebView drops the "Safari/" token that Safari and
 *   SFSafariViewController keep; low confidence, because some apps
 *   (Facebook on iOS 26) render a Safari-looking UA anyway.
 *
 * This module names the APP the visitor came from, never the visitor. The
 * UA and the hint header are consumed at the edge and discarded, exactly
 * as ai-source.ts and device.ts already do.
 *
 * Privacy test (the privacy rules): does this create a personal identifier or need
 * consent? No. The output is one of about a dozen app names or "unknown",
 * shared by millions of visitors a day; the same class of signal as the
 * referrer host it stands in for. Sec-CH-UA low-entropy hints carry the
 * same three facts the UA already does.
 */

// GDPR: legitimate interest, art. 6(1)(f). App-category source signal, no
// identifier, no consent required (ePrivacy exempt: strictly necessary, no
// storage on the device).
import type { AppSource } from "../types.ts";
import { APP_UAS } from "./tables.ts";

/** iOS browsers that are not Safari but keep or drop the Safari token; never webviews. */
const IOS_BROWSER_TOKENS = ["crios/", "fxios/", "edgios/", "opt/", "ddg/", "brave/", "yabrowser/"];

/**
 * Detects the hosting app from an in-app browser User-Agent and, when the
 * app is unknown, whether the page is inside a webview at all.
 *
 * @param ua - The raw User-Agent string (or null/undefined if missing).
 * @param secChUa - The raw Sec-CH-UA header (low-entropy Client Hints), if any.
 * @returns The app, its channel and a confidence, or null for a normal browser.
 */
export function detectAppSource(
  ua: string | null | undefined,
  secChUa?: string | null,
): AppSource | null {
  const lower = ua ? ua.toLowerCase() : "";

  // Layer A: a named app in the UA.
  if (lower) {
    for (const entry of APP_UAS) {
      if (lower.includes(entry.substring)) {
        return { app: entry.app, channel: entry.channel, confidence: "high" };
      }
    }
  }

  // Layer B, Android: the Client Hints brand is the primary rule.
  if (secChUa?.toLowerCase().includes("android webview")) {
    return { app: "unknown", channel: "app", confidence: "medium" };
  }
  // Fallback: the wv token inside the platform parenthesis.
  if (lower.includes("; wv)") || lower.includes(";wv)")) {
    return { app: "unknown", channel: "app", confidence: "medium" };
  }

  // Layer B, iOS: WebKit on iPhone/iPad without the Safari token and not a
  // known third-party browser. Low confidence by design.
  if (
    lower.includes("applewebkit") &&
    (lower.includes("iphone") || lower.includes("ipad")) &&
    !lower.includes("safari/") &&
    !IOS_BROWSER_TOKENS.some((t) => lower.includes(t))
  ) {
    return { app: "unknown", channel: "app", confidence: "low" };
  }

  return null;
}
