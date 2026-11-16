/**
 * Verified AI-source detection tables.
 *
 * Two lists because real visitors and crawlers behave differently:
 * - Bot UAs: crawlers indexing on behalf of an AI tool (serve canonical,
 *   cloaking-safe). isBot: true.
 * - User UAs: a real person clicked a link in an AI answer. isBot: false,
 *   citation-click, high-intent.
 * - Referrer hosts: a human arrived in a normal browser from an AI tool UI.
 *   isBot: false.
 *
 * UA matching: substring against lowercased UA string.
 * Referrer matching: suffix match so "www.g2.com" matches "g2.com".
 *
 * Bot UA entries take precedence over referrer-host entries — a GPTBot UA
 * wins even if there is somehow a chatgpt.com referrer.
 */

import type { AiSource } from "../types.ts";
import { AI_HOSTS } from "./source-vocabulary.ts";

export interface AiBotEntry {
  /** Lowercase substring to match against the User-Agent. */
  substring: string;
  /** Canonical AI source name. */
  source: AiSource;
  isBot: true;
}

export interface AiUserEntry {
  /** Lowercase substring to match against the User-Agent. */
  substring: string;
  source: AiSource;
  /** Real visitor clicking an AI answer citation link. */
  isBot: false;
  isCitationClick: true;
}

export interface AiReferrerEntry {
  /** Exact host (or suffix to match with www. etc). */
  host: string;
  source: AiSource;
  isBot: false;
}

/**
 * AI crawler bot UAs — serve canonical (cloaking-safe). Every row is a
 * vendor-documented token (OpenAI, Anthropic, Perplexity, Google, Mistral,
 * Meta, DuckDuckGo, Apple, Amazon, ByteDance crawler pages); see
 * docs/research/ai-click-attribution-2026.md.
 */
export const AI_BOT_UAS: readonly AiBotEntry[] = [
  { substring: "gptbot", source: "chatgpt", isBot: true },
  { substring: "oai-searchbot", source: "chatgpt", isBot: true },
  { substring: "claudebot", source: "claude", isBot: true },
  { substring: "claude-searchbot", source: "claude", isBot: true },
  { substring: "perplexitybot", source: "perplexity", isBot: true },
  { substring: "google-extended", source: "gemini", isBot: true },
  { substring: "mistralai-crawler", source: "mistral", isBot: true },
  { substring: "meta-externalagent", source: "meta", isBot: true },
  { substring: "duckassistbot", source: "duckai", isBot: true },
  { substring: "applebot-extended", source: "apple", isBot: true },
  { substring: "amazonbot", source: "amazon", isBot: true },
  { substring: "bytespider", source: "bytedance", isBot: true },
  { substring: "youbot", source: "you", isBot: true },
];

/** AI user-driven UAs — citation click, high-intent real visitor. */
export const AI_USER_UAS: readonly AiUserEntry[] = [
  { substring: "chatgpt-user", source: "chatgpt", isBot: false, isCitationClick: true },
  { substring: "claude-user", source: "claude", isBot: false, isCitationClick: true },
  { substring: "perplexity-user", source: "perplexity", isBot: false, isCitationClick: true },
  // User-triggered fetches documented by Mistral and Meta.
  { substring: "mistralai-user", source: "mistral", isBot: false, isCitationClick: true },
  { substring: "meta-externalfetcher", source: "meta", isBot: false, isCitationClick: true },
];

/**
 * AI tool referrer hosts — human visitor in normal browser. Derived from
 * the source vocabulary so the two never disagree.
 */
export const AI_REFERRER_HOSTS: readonly AiReferrerEntry[] = Object.entries(AI_HOSTS).map(
  ([host, source]) => ({ host, source, isBot: false as const }),
);

/**
 * Comparison site referrer hosts used by the lead-probability heuristic.
 * These are visited by users actively comparing tools — higher purchase intent.
 */
export const COMPARISON_REFERRER_HOSTS: readonly string[] = [
  "g2.com",
  "capterra.com",
  "getapp.com",
  "producthunt.com",
];

/** Apps whose in-app browser marks the User-Agent. */
export type AppName =
  | "facebook"
  | "instagram"
  | "threads"
  | "linkedin"
  | "tiktok"
  | "twitter"
  | "snapchat"
  | "pinterest"
  | "telegram"
  | "whatsapp"
  | "reddit"
  /** The Google app (GSA): Discover and the search box, an organic surface. */
  | "google"
  /** A Meta app that names nothing but Meta's in-app browser marker. */
  | "meta"
  | "unknown"
  | "chatgpt"
  | "claude"
  | "perplexity"
  | "gemini"
  | "copilot";

export interface AppUaEntry {
  /** Lowercase substring to match against the User-Agent. */
  substring: string;
  app: AppName;
  /** Which source dimension the app feeds. */
  channel: "social" | "ai" | "community" | "organic";
}

/**
 * Channel of an AppSource: a named social, AI, community (Reddit) or
 * organic (the Google app) app, or "app" for an unnamed webview.
 */
export type AppChannel = "social" | "ai" | "community" | "organic" | "app";

/**
 * In-app browser UA markers (L2 source recovery, see app-source.ts).
 *
 * Only markers seen in real UA strings go here; a guess is a false
 * positive at scale. Order matters: first match wins, so Messenger's
 * FB_IAB line precedes FBAN and both stay "facebook".
 *
 * Provenance per row is in docs/research/in-app-browser-ua-2026.md. The
 * 2025 Rawuser (rawuser_backend, branch reborn) carried the same idea with
 * looser patterns; see docs/research/old-rawuser-source-detection.md.
 */
export const APP_UAS: readonly AppUaEntry[] = [
  // Meta family. FB_IAB = Facebook in-app browser (also Messenger), FBAN/FBAV = app name/version.
  // Some Facebook builds on iOS render the webview with no FBAN/FBAV token
  // and a Safari-looking UA (verified 2026-09); they end in "MetaIAB
  // Facebook" (inapp-spy fixture, Facebook iOS 18.6.2, Layer G 2026-10-03).
  { substring: "fb_iab", app: "facebook", channel: "social" },
  { substring: "fban/", app: "facebook", channel: "social" },
  { substring: "fbav/", app: "facebook", channel: "social" },
  { substring: "fbios", app: "facebook", channel: "social" },
  { substring: "metaiab facebook", app: "facebook", channel: "social" },
  { substring: "instagram", app: "instagram", channel: "social" },
  // Threads ships under Meta's internal codename in the UA.
  { substring: "barcelona", app: "threads", channel: "social" },
  { substring: "linkedinapp", app: "linkedin", channel: "social" },
  // TikTok: musical_ly is the app id, BytedanceWebview the webview.
  { substring: "musical_ly", app: "tiktok", channel: "social" },
  { substring: "bytedancewebview", app: "tiktok", channel: "social" },
  { substring: "trill_", app: "tiktok", channel: "social" },
  { substring: "twitterandroid", app: "twitter", channel: "social" },
  { substring: "twitter for i", app: "twitter", channel: "social" },
  { substring: "snapchat", app: "snapchat", channel: "social" },
  { substring: "pinterest/", app: "pinterest", channel: "social" },
  // Telegram's Android in-app view stamps the UA; the iOS one sends plain Safari.
  { substring: "telegram", app: "telegram", channel: "social" },
  // Layer G (2026-10-03), markers from inapp-spy's fixtures (MIT,
  // src/tests/mobile.ts): WhatsApp iOS "[WAiOS/2.25.31]" and Android
  // "[WA4A/2.25.32.75;]" (no "wv", so Layer B missed it too).
  { substring: "[waios/", app: "whatsapp", channel: "social" },
  { substring: "[wa4a/", app: "whatsapp", channel: "social" },
  // Reddit Android: "Reddit/Version 2026.23.0/Build 2623040/Android 15".
  // Community, like a reddit.com referrer.
  { substring: "reddit/version", app: "reddit", channel: "community" },
  // AI apps (ChatGPT, Claude, Perplexity, Gemini, Copilot): no source shows
  // their in-app view stamping the UA as of 2026-09; the "ChatGPT/1.2024.x"
  // string is the app's native client, not the webview. Rows are added only
  // after a real-device capture. See the research file above.
  // Gemini iOS app webview; the one AI in-app UA quoted in the wild
  // (docs/research/ai-click-attribution-2026.md). Other AI apps still
  // need a device capture.
  { substring: "geminiios/", app: "gemini", channel: "ai" },
  // The Google app, "GSA/334.0.674067880": Discover and search, organic like
  // a google.com referrer, never social. After the AI rows, so a Google AI
  // app that also carried GSA/ would still read as AI.
  { substring: "gsa/", app: "google", channel: "organic" },
  // Meta's in-app browser marker, seen next to the Instagram and Facebook
  // tokens in the fixtures ("IABMV/1"). Last on purpose: a fallback for a
  // Meta app whose UA names nothing else.
  { substring: "iabmv/", app: "meta", channel: "social" },
];

/** Generic bot UA substrings (non-AI) for device classification. */
export const BOT_UA_SUBSTRINGS: readonly string[] = [
  "bot",
  "spider",
  "crawler",
  "slurp",
  "mediapartners",
  "facebookexternalhit",
  "linkedinbot",
  "twitterbot",
  "whatsapp",
  "semrushbot",
  "ahrefsbot",
  "mj12bot",
  "bingbot",
  "googlebot",
  // Search Console's URL Inspection live test and Google's other fetchers
  // carry no "bot" in their names (2026-10-25): without them the live test
  // could be answered with a version on a path-intent page.
  "google-inspectiontool",
  "googleother",
  "baiduspider",
  "yandexbot",
  "duckduckbot",
];
