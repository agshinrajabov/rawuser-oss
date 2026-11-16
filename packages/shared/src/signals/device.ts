/**
 * Device classification.
 *
 * Coarse device class from the User-Agent string. This is NOT a fingerprint —
 * we only produce one of four categories: mobile, tablet, desktop, bot.
 *
 * Privacy rules:
 * - Never combine device with other signals to re-identify a visitor.
 * - Never store the raw UA anywhere.
 * - "bot" is returned only for non-AI generic crawlers. AI bots are handled
 *   in ai-source.ts with isBot: true and take precedence in the extract layer.
 *
 * Pattern order matters: tablet must be checked before mobile because many
 * tablet UAs also contain "mobile" or "android".
 */

import type { Signals } from "../types.ts";
import { BOT_UA_SUBSTRINGS } from "./tables.ts";

type DeviceClass = Signals["device"];

/**
 * Classifies the device from the User-Agent string.
 *
 * @param ua - The raw User-Agent string (or null/undefined if absent).
 * @returns A coarse device class: "mobile" | "tablet" | "desktop" | "bot".
 */
export function classifyDevice(ua: string | null | undefined): DeviceClass {
  if (!ua) return "desktop"; // No UA → treat as desktop (most lenient).

  const lower = ua.toLowerCase();

  // Generic bots (non-AI). AI bots are detected in ai-source.ts first.
  for (const substring of BOT_UA_SUBSTRINGS) {
    if (lower.includes(substring)) return "bot";
  }

  // Tablet must come before mobile — many tablet UAs include "mobile".
  if (lower.includes("tablet") || lower.includes("ipad")) return "tablet";

  if (
    lower.includes("mobile") ||
    lower.includes("android") ||
    lower.includes("iphone") ||
    lower.includes("ipod") ||
    lower.includes("windows phone") ||
    lower.includes("blackberry")
  ) {
    return "mobile";
  }

  return "desktop";
}
