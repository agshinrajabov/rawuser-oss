/**
 * AI-source detection.
 *
 * Determines whether the visit originates from an AI tool, and whether the
 * visitor is a bot crawler or a real human who clicked a citation link.
 *
 * Priority order:
 * 1. Bot UA match → isBot: true (overrides everything, cloaking-safe).
 * 2. User-driven AI UA match → isBot: false, isCitationClick: true.
 * 3. AI app package id (exact) or referrer host suffix match → isBot: false.
 * 4. utm_source / utm_medium naming an AI product (ChatGPT tags its own
 *    links with utm_source=chatgpt.com; it survives the app where the
 *    referrer is dropped) → isBot: false.
 *
 * Inputs must NOT be persisted — UA is consumed here and discarded.
 */

import type { AiSource, Signals } from "../types.ts";
import { matchAppPackage, matchUtmMedium, matchUtmSource } from "./source-vocabulary.ts";
import { AI_BOT_UAS, AI_REFERRER_HOSTS, AI_USER_UAS } from "./tables.ts";

export interface AiSourceResult {
  aiSource: AiSource | null;
  isBot: boolean;
  /** True when the visitor is a real human who clicked a citation link in an AI answer. */
  isCitationClick: boolean;
}

/**
 * Detects AI source from the User-Agent and referrer host.
 *
 * @param ua - The raw User-Agent string (or null/undefined if missing).
 * @param referrerHost - The already-reduced referrer host (host only, no path).
 *   Pass the output of parseReferrerHost — never the raw Referer header.
 * @param referrerIsApp - true when referrerHost is an Android package id
 *   (`android-app://com.openai.chatgpt`): matched exactly, never as a host.
 */
export function detectAiSource(
  ua: string | null | undefined,
  referrerHost: string | null,
  utm?: Signals["utm"] | null,
  referrerIsApp = false,
): AiSourceResult {
  const lowerUa = ua ? ua.toLowerCase() : "";

  // 1. Bot UA — takes precedence over all other signals.
  for (const entry of AI_BOT_UAS) {
    if (lowerUa.includes(entry.substring)) {
      return { aiSource: entry.source, isBot: true, isCitationClick: false };
    }
  }

  // 2. User-driven AI UA (citation click — real person, high-intent).
  for (const entry of AI_USER_UAS) {
    if (lowerUa.includes(entry.substring)) {
      return { aiSource: entry.source, isBot: false, isCitationClick: true };
    }
  }

  // 3a. An AI app's package id (android-app://com.openai.chatgpt), exact
  // match only (Layer G).
  if (referrerHost) {
    const pkg = matchAppPackage(referrerHost);
    if (pkg?.channel === "ai") {
      return { aiSource: pkg.source as AiSource, isBot: false, isCitationClick: false };
    }
  }

  // 3b. Referrer host suffix match (human in normal browser arriving from AI tool).
  // Never for a package id: those are matched exactly above or not at all.
  if (referrerHost && !referrerIsApp) {
    const lowerReferrer = referrerHost.toLowerCase();
    for (const entry of AI_REFERRER_HOSTS) {
      // Suffix match: "www.chatgpt.com" matches "chatgpt.com".
      if (lowerReferrer === entry.host || lowerReferrer.endsWith(`.${entry.host}`)) {
        return { aiSource: entry.source, isBot: false, isCitationClick: false };
      }
    }
  }

  // 4. The link itself says so (utm_source=chatgpt.com and friends).
  if (utm) {
    const bySource = matchUtmSource(utm.source);
    if (bySource?.channel === "ai") {
      return {
        aiSource: (bySource.source as AiSource | null) ?? "chatgpt",
        isBot: false,
        isCitationClick: false,
      };
    }
    const byMedium = matchUtmMedium(utm.medium);
    if (byMedium?.channel === "ai") {
      // A bare "ai" medium names the channel, not the product; the source
      // dimension still fires (source.ai), the product stays unnamed.
      return {
        aiSource: (bySource?.source as AiSource | null) ?? "chatgpt",
        isBot: false,
        isCitationClick: false,
      };
    }
  }

  return { aiSource: null, isBot: false, isCitationClick: false };
}
