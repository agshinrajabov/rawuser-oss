/**
 * Source vocabulary (docs/specs/source-recovery.md, Layer F).
 *
 * One place that says which utm_source values, utm_medium values and
 * referrer hosts mean which channel. Exact tables first (the value a
 * platform itself writes), then patterns for the free-form values operators
 * invent ("linkedin_newsletter", "fb-ads", "chatgpt-ios"). A value nothing
 * here recognises is counted in aggregate by the edge (signal-tokens.ts)
 * and surfaces in the weekly proposals so the vocabulary grows from real
 * traffic, always through a human adding a row, never by itself.
 *
 * Privacy: these are labels platforms put on links and hostnames of the
 * page before, never a person. Evidence for the AI rows:
 * docs/research/ai-click-attribution-2026.md.
 */

import type { AiSource, Signals } from "../types.ts";
import { isPaidClickId, isSocialClickId } from "./click-id.ts";

export type Channel = "ai" | "social" | "paid" | "organic" | "community" | "email";

export interface SourceMatch {
  channel: Channel;
  /** Platform name when known ("chatgpt", "linkedin", "google"); null for a bare channel. */
  source: string | null;
  /** "exact" from a table, "pattern" from a regex; the classifier may weigh them differently. */
  by: "exact" | "pattern";
}

// ---------------------------------------------------------------------------
// Source names (N1, docs/specs/results-data.md §7; privacy review
// conditional pass 2026-10-04)
// ---------------------------------------------------------------------------

/**
 * The closed list of platform names a visit may be stored with
 * (events.source_name). A name is always one of these fixed words: it comes
 * from a table in this file (a host, an app, a click-id parameter name, an
 * exact or pattern utm_source match), never cut from a host or a utm value.
 * Anything else is stored as NULL: an unknown host or package, an
 * unrecognised utm_source, a paid or email match without a platform, an
 * unnamed webview. Email platforms (Mailchimp, Klaviyo...) and affiliate
 * networks never get a name (ADR 0029: per visit only the family "email").
 *
 * No sensitive sources (condition 5): a named source is a general platform;
 * a host or app whose audience reveals a special category (health,
 * religion, sexuality, politics, union) never gets a name and stays NULL.
 * Adding a name needs a line in the spec and a look from privacy review.
 */
export const SOURCE_NAMES = [
  // AI assistants (the AiSource values).
  "chatgpt",
  "claude",
  "perplexity",
  "gemini",
  "copilot",
  "you",
  "phind",
  "grok",
  "meta",
  "deepseek",
  "mistral",
  "duckai",
  "poe",
  "kimi",
  "qwen",
  "ernie",
  "tongyi",
  "apple",
  "amazon",
  "bytedance",
  "notebooklm",
  "characterai",
  "chatglm",
  "iask",
  "genspark",
  "felo",
  "t3chat",
  "venice",
  "lumo",
  "manus",
  "doubao",
  "yuanbao",
  "gigachat",
  // Social apps.
  "twitter",
  "linkedin",
  "instagram",
  "threads",
  "tiktok",
  "facebook",
  "youtube",
  "pinterest",
  "snapchat",
  "telegram",
  "whatsapp",
  "bluesky",
  "mastodon",
  "vk",
  "line",
  // Communities.
  "reddit",
  "hacker-news",
  "lobsters",
  "discord",
  "slack",
  "indie-hackers",
  "dev-to",
  "hashnode",
  "medium",
  "substack",
  "quora",
  "stack-overflow",
  "github",
  // Search.
  "google",
  "bing",
  "duckduckgo",
  "yahoo",
  "brave",
  "yandex",
  "ecosia",
  "kagi",
  "startpage",
  "baidu",
  "naver",
  "seznam",
  "qwant",
  // Ads (from a click-id parameter name).
  "google-ads",
  "microsoft-ads",
  "yandex-ads",
  "adobe-ads",
  "chatgpt-ads",
] as const;

export type SourceName = (typeof SOURCE_NAMES)[number];

const SOURCE_NAME_SET: ReadonlySet<string> = new Set<string>(SOURCE_NAMES);

/** True only for a word on the closed list. */
export function isSourceName(v: unknown): v is SourceName {
  return typeof v === "string" && SOURCE_NAME_SET.has(v);
}

/** How the dashboard writes each name. */
export const SOURCE_NAME_LABELS: Readonly<Record<SourceName, string>> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  perplexity: "Perplexity",
  gemini: "Gemini",
  copilot: "Copilot",
  you: "You.com",
  phind: "Phind",
  grok: "Grok",
  meta: "Meta AI",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  duckai: "Duck.ai",
  poe: "Poe",
  kimi: "Kimi",
  qwen: "Qwen",
  ernie: "ERNIE",
  tongyi: "Tongyi",
  apple: "Apple Intelligence",
  amazon: "Amazon",
  bytedance: "ByteDance",
  notebooklm: "NotebookLM",
  characterai: "Character.AI",
  chatglm: "ChatGLM",
  iask: "iAsk",
  genspark: "Genspark",
  felo: "Felo",
  t3chat: "T3 Chat",
  venice: "Venice",
  lumo: "Lumo",
  manus: "Manus",
  doubao: "Doubao",
  yuanbao: "Yuanbao",
  gigachat: "GigaChat",
  twitter: "X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  threads: "Threads",
  tiktok: "TikTok",
  facebook: "Facebook",
  youtube: "YouTube",
  pinterest: "Pinterest",
  snapchat: "Snapchat",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  vk: "VK",
  line: "LINE",
  reddit: "Reddit",
  "hacker-news": "Hacker News",
  lobsters: "Lobsters",
  discord: "Discord",
  slack: "Slack",
  "indie-hackers": "Indie Hackers",
  "dev-to": "DEV",
  hashnode: "Hashnode",
  medium: "Medium",
  substack: "Substack",
  quora: "Quora",
  "stack-overflow": "Stack Overflow",
  github: "GitHub",
  google: "Google",
  bing: "Bing",
  duckduckgo: "DuckDuckGo",
  yahoo: "Yahoo",
  brave: "Brave Search",
  yandex: "Yandex",
  ecosia: "Ecosia",
  kagi: "Kagi",
  startpage: "Startpage",
  baidu: "Baidu",
  naver: "Naver",
  seznam: "Seznam",
  qwant: "Qwant",
  "google-ads": "Google Ads",
  "microsoft-ads": "Microsoft Ads",
  "yandex-ads": "Yandex Ads",
  "adobe-ads": "Adobe Ads",
  "chatgpt-ads": "ChatGPT ads",
};

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

/**
 * utm_source values AI products or their users write. ChatGPT is the only
 * product that auto-tags its links (`utm_source=chatgpt.com`, OpenAI
 * publisher docs); the rest are the values operators and analytics
 * vendors have been seen using.
 */
export const AI_UTM_SOURCES: Readonly<Record<string, AiSource>> = {
  "chatgpt.com": "chatgpt",
  chatgpt: "chatgpt",
  "chat.openai.com": "chatgpt",
  openai: "chatgpt",
  "atlas.openai.com": "chatgpt",
  "perplexity.ai": "perplexity",
  perplexity: "perplexity",
  "claude.ai": "claude",
  claude: "claude",
  anthropic: "claude",
  "gemini.google.com": "gemini",
  gemini: "gemini",
  bard: "gemini",
  "copilot.microsoft.com": "copilot",
  copilot: "copilot",
  "bing-copilot": "copilot",
  "grok.com": "grok",
  grok: "grok",
  xai: "grok",
  "meta.ai": "meta",
  metaai: "meta",
  "chat.deepseek.com": "deepseek",
  deepseek: "deepseek",
  "chat.mistral.ai": "mistral",
  mistral: "mistral",
  lechat: "mistral",
  "duck.ai": "duckai",
  duckai: "duckai",
  "poe.com": "poe",
  poe: "poe",
  "you.com": "you",
  "phind.com": "phind",
  phind: "phind",
  "kimi.com": "kimi",
  kimi: "kimi",
  "chat.qwen.ai": "qwen",
  qwen: "qwen",
};

/** Referrer hosts of AI products' human-facing UIs (suffix match). */
export const AI_HOSTS: Readonly<Record<string, AiSource>> = {
  "chatgpt.com": "chatgpt",
  "chat.openai.com": "chatgpt",
  "atlas.openai.com": "chatgpt",
  "claude.ai": "claude",
  "perplexity.ai": "perplexity",
  "gemini.google.com": "gemini",
  "copilot.microsoft.com": "copilot",
  "you.com": "you",
  "phind.com": "phind",
  "grok.com": "grok",
  "grok.x.com": "grok",
  "meta.ai": "meta",
  "duck.ai": "duckai",
  "chat.deepseek.com": "deepseek",
  "chat.mistral.ai": "mistral",
  "poe.com": "poe",
  "kimi.com": "kimi",
  "kimi.moonshot.cn": "kimi",
  "chat.qwen.ai": "qwen",
  "yiyan.baidu.com": "ernie",
  "tongyi.aliyun.com": "tongyi",
  // Layer G (2026-10-03, docs/specs/source-recovery.md): the AI hosts track F
  // of docs/research/journey-origin-2026 found missing. Sources per row are
  // in the spec (PostHog channel_definitions.json, MIT; Matomo AIAssistants,
  // CC0; Plausible and Snowplow read as facts only).
  "copilot.cloud.microsoft": "copilot",
  "copilot.com": "copilot",
  "pplx.ai": "perplexity",
  "deepseek.com": "deepseek",
  "notebooklm.google.com": "notebooklm",
  // notebooklm.google.com redirected here on 2026-10-03.
  "notebook.google.com": "notebooklm",
  "character.ai": "characterai",
  "chatglm.cn": "chatglm",
  "iask.ai": "iask",
  "genspark.ai": "genspark",
  "felo.ai": "felo",
  "t3.chat": "t3chat",
  "venice.ai": "venice",
  "lumo.proton.me": "lumo",
  "manus.im": "manus",
  "doubao.com": "doubao",
  "yuanbao.tencent.com": "yuanbao",
  "giga.chat": "gigachat",
};

/** utm_medium values that name an AI channel. */
const AI_MEDIUM_RE =
  /^(ai|ai[-_ ]?assistant|ai[-_ ]?search|ai[-_ ]?referral|ai[-_ ]?overview[s]?|ai[-_ ]?mode|llm|chatbot|chat[-_ ]?bot|generative[-_ ]?ai|answer[-_ ]?engine|aeo)$/;

/** Free-form utm_source values that clearly name an AI product. */
const AI_SOURCE_PATTERNS: ReadonlyArray<[RegExp, AiSource]> = [
  [/chatgpt|openai/, "chatgpt"],
  [/perplexity/, "perplexity"],
  [/claude|anthropic/, "claude"],
  [/gemini|bard/, "gemini"],
  [/copilot/, "copilot"],
  [/grok|\bxai\b/, "grok"],
  [/deepseek/, "deepseek"],
  [/mistral|lechat/, "mistral"],
  [/meta[-_.]?ai\b/, "meta"],
  [/duck[-_.]?ai\b|duckassist/, "duckai"],
  [/\bpoe\b/, "poe"],
  [/\bkimi\b/, "kimi"],
  [/\bqwen\b/, "qwen"],
];

// ---------------------------------------------------------------------------
// Social, community, organic, paid, email
// ---------------------------------------------------------------------------

export const SOCIAL_UTM_SOURCES: Readonly<Record<string, string>> = {
  twitter: "twitter",
  "twitter.com": "twitter",
  x: "twitter",
  "x.com": "twitter",
  linkedin: "linkedin",
  "linkedin.com": "linkedin",
  instagram: "instagram",
  ig: "instagram",
  threads: "threads",
  tiktok: "tiktok",
  facebook: "facebook",
  fb: "facebook",
  "facebook.com": "facebook",
  // Meta's `{{site_source_name}}` (docs/specs/ads-platforms.md §2) writes
  // fb, ig, msg or an; msg is Messenger, the Messenger app's package
  // (com.facebook.orca) is facebook too.
  msg: "facebook",
  messenger: "facebook",
  youtube: "youtube",
  yt: "youtube",
  pinterest: "pinterest",
  snapchat: "snapchat",
  telegram: "telegram",
  whatsapp: "whatsapp",
  reddit: "reddit",
  discord: "discord",
  bluesky: "bluesky",
  bsky: "bluesky",
  mastodon: "mastodon",
  vk: "vk",
  "vk.com": "vk",
};

/**
 * utm_source values that are social with no name. `an` is Meta's Audience
 * Network (`{{site_source_name}}`, ads-platforms.md §2): Meta's ads inside
 * other publishers' apps. The visitor was in some other app, not on
 * Facebook, so it is not stored as facebook (that would overcount
 * Facebook in Results); nor does it get a word of its own, which would need
 * a line in the spec and a look from privacy review. It reads as a feed
 * visit, and a paid one carries `utm_medium=paid_social`, whose name comes
 * only from a click id anyway.
 */
const UNNAMED_SOCIAL_UTM_SOURCES: ReadonlySet<string> = new Set(["an"]);

const SOCIAL_SOURCE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/facebook|\bfb\b|messenger/, "facebook"],
  [/instagram|\big\b/, "instagram"],
  [/linkedin|lnkd/, "linkedin"],
  [/tiktok/, "tiktok"],
  [/twitter|\bx\.com\b/, "twitter"],
  [/threads/, "threads"],
  [/pinterest/, "pinterest"],
  [/youtube|\byt\b/, "youtube"],
  [/telegram|\btg\b/, "telegram"],
  [/whatsapp|\bwa\b/, "whatsapp"],
  [/snapchat|\bsnap\b/, "snapchat"],
  [/reddit/, "reddit"],
  [/discord/, "discord"],
  [/bluesky|bsky/, "bluesky"],
  [/mastodon/, "mastodon"],
];

/**
 * Referrer hosts per channel, each with the platform name it stands for
 * (N1, docs/specs/results-data.md §7). Suffix match: a subdomain counts as
 * its platform (l.facebook.com is facebook). The name is the table's fixed
 * word, never cut from the host.
 */
export const SOCIAL_HOST_NAMES: Readonly<Record<string, SourceName>> = {
  "twitter.com": "twitter",
  "x.com": "twitter",
  "t.co": "twitter",
  "linkedin.com": "linkedin",
  "lnkd.in": "linkedin",
  "instagram.com": "instagram",
  "threads.net": "threads",
  "threads.com": "threads",
  "tiktok.com": "tiktok",
  "facebook.com": "facebook",
  "fb.com": "facebook",
  "fb.me": "facebook",
  "l.facebook.com": "facebook",
  "lm.facebook.com": "facebook",
  "m.facebook.com": "facebook",
  "youtube.com": "youtube",
  "youtu.be": "youtube",
  "pinterest.com": "pinterest",
  "pin.it": "pinterest",
  "snapchat.com": "snapchat",
  "t.me": "telegram",
  "telegram.me": "telegram",
  "web.telegram.org": "telegram",
  "whatsapp.com": "whatsapp",
  "bsky.app": "bluesky",
  "mastodon.social": "mastodon",
  "vk.com": "vk",
};

export const COMMUNITY_HOST_NAMES: Readonly<Record<string, SourceName>> = {
  "reddit.com": "reddit",
  "news.ycombinator.com": "hacker-news",
  "lobste.rs": "lobsters",
  "discord.com": "discord",
  "discord.gg": "discord",
  "indiehackers.com": "indie-hackers",
  "dev.to": "dev-to",
  "hashnode.com": "hashnode",
  "medium.com": "medium",
  "substack.com": "substack",
  "quora.com": "quora",
  "stackoverflow.com": "stack-overflow",
  "github.com": "github",
};

/** Search engines. Google's AI Overviews and AI Mode arrive as google.com too. */
export const SEARCH_HOST_NAMES: Readonly<Record<string, SourceName>> = {
  "google.com": "google",
  "google.az": "google",
  "google.ru": "google",
  "google.com.tr": "google",
  "bing.com": "bing",
  "duckduckgo.com": "duckduckgo",
  "yahoo.com": "yahoo",
  "search.brave.com": "brave",
  "yandex.com": "yandex",
  "yandex.ru": "yandex",
  "ecosia.org": "ecosia",
  "kagi.com": "kagi",
  "startpage.com": "startpage",
  "baidu.com": "baidu",
  "naver.com": "naver",
  "seznam.cz": "seznam",
  "qwant.com": "qwant",
};

export const SOCIAL_HOSTS: readonly string[] = Object.keys(SOCIAL_HOST_NAMES);
export const COMMUNITY_HOSTS: readonly string[] = Object.keys(COMMUNITY_HOST_NAMES);
export const SEARCH_HOSTS: readonly string[] = Object.keys(SEARCH_HOST_NAMES);

// `social_paid` too (ads-platforms.md §1): before 2026-10-22 it fell to the
// social pattern below and landed as social.
const PAID_MEDIUM_RE =
  /^(cpc|ppc|cpm|cpa|cpv|paid|paid[-_ ]?social|paid[-_ ]?search|paidsocial|paidsearch|social[-_ ]?paid|display|banner|retargeting|remarketing|sponsored|ad|ads|adwords|sea|sem|affiliate)$/;

/**
 * Paid search and paid social, apart (docs/specs/ads-platforms.md §4).
 * Both are `source.paid`; the selection reads which one to pick the version
 * (a search ad reader typed a need, a feed ad reader was interrupted).
 * Compared after a hyphen or a space becomes an underscore, so
 * `paid-social` is `paid_social`.
 */
export const PAID_SEARCH_MEDIUMS: ReadonlySet<string> = new Set([
  "cpc",
  "ppc",
  "paid_search",
  "sem",
]);
export const PAID_SOCIAL_MEDIUMS: ReadonlySet<string> = new Set([
  "paid_social",
  "paidsocial",
  "social_paid",
  "cpm",
]);

/** utm_source values that name a search engine (a search ad's own source). */
const SEARCH_ENGINE_UTM_RE = /^(google|bing|yandex|duckduckgo|yahoo|brave|baidu|naver)$/;

// "ads" only as its own word or with a separator, so "threads" stays social.
const PAID_SOURCE_RE =
  /(^|[-_.])ads?$|^ads?[-_]|adwords|google[-_]?ads|facebook[-_]?ads|meta[-_]?ads|tiktok[-_]?ads|linkedin[-_]?ads|bing[-_]?ads|^gads$|^fbads$/;

const EMAIL_MEDIUM_RE = /^(email|e-mail|mail|newsletter|edm|mailing)$/;
const EMAIL_SOURCE_RE =
  /newsletter|mailchimp|klaviyo|sendgrid|brevo|hubspot|substack|convertkit|beehiiv/;

const ORGANIC_MEDIUM_RE = /^(organic|seo|search)$/;
const SOCIAL_MEDIUM_RE = /social|organic[-_ ]?social/;

// ---------------------------------------------------------------------------
// Android app referrers (Layer G, 2026-10-03)
// ---------------------------------------------------------------------------

export interface AppPackage {
  channel: Channel;
  /** Platform name, as in the other tables; an AiSource for the ai rows. */
  source: string;
}

/**
 * Android package ids seen as `android-app://<package>` referrers, when an
 * app opens a link in Chrome or a Custom Tab (Chromium fills the package in
 * by itself for a bound Custom Tab). EXACT match only, never a substring or
 * a suffix: substring matching turns Gmail (com.google.android.gm) into paid
 * Google search (Adobe rum-distiller PR #137, Apache-2.0, whose rule this
 * follows in our own code). Keys are lowercase: our referrer parser
 * lowercases, and Slack's Play id is com.Slack.
 *
 * Every id was checked on its Google Play listing on 2026-10-03; most are
 * also in PostHog's channel_definitions.json (MIT). Per-row sources:
 * docs/specs/source-recovery.md, Layer G. An unknown package id is left
 * unclassified and counted by Layer F for the weekly proposals.
 */
export const APP_PACKAGES: Readonly<Record<string, AppPackage>> = {
  // Social and messaging.
  "com.facebook.katana": { channel: "social", source: "facebook" },
  "com.facebook.lite": { channel: "social", source: "facebook" },
  "com.facebook.orca": { channel: "social", source: "facebook" },
  "com.instagram.android": { channel: "social", source: "instagram" },
  "com.instagram.barcelona": { channel: "social", source: "threads" },
  "com.linkedin.android": { channel: "social", source: "linkedin" },
  "com.twitter.android": { channel: "social", source: "twitter" },
  "com.zhiliaoapp.musically": { channel: "social", source: "tiktok" },
  "com.ss.android.ugc.trill": { channel: "social", source: "tiktok" },
  "com.pinterest": { channel: "social", source: "pinterest" },
  "com.snapchat.android": { channel: "social", source: "snapchat" },
  "org.telegram.messenger": { channel: "social", source: "telegram" },
  "org.telegram.messenger.web": { channel: "social", source: "telegram" },
  "com.whatsapp": { channel: "social", source: "whatsapp" },
  "com.whatsapp.w4b": { channel: "social", source: "whatsapp" },
  "com.google.android.youtube": { channel: "social", source: "youtube" },
  "jp.naver.line.android": { channel: "social", source: "line" },
  // Community, like reddit.com and discord.com.
  "com.reddit.frontpage": { channel: "community", source: "reddit" },
  "com.discord": { channel: "community", source: "discord" },
  "com.slack": { channel: "community", source: "slack" },
  // Email, like mail.google.com.
  "com.google.android.gm": { channel: "email", source: "gmail" },
  "com.microsoft.office.outlook": { channel: "email", source: "outlook" },
  "com.yahoo.mobile.client.android.mail": { channel: "email", source: "yahoo-mail" },
  // Organic: the Google app (Discover and the search box) and Google Go.
  "com.google.android.googlequicksearchbox": { channel: "organic", source: "google" },
  "com.google.android.apps.searchlite": { channel: "organic", source: "google" },
  // AI apps.
  "com.openai.chatgpt": { channel: "ai", source: "chatgpt" },
  "com.anthropic.claude": { channel: "ai", source: "claude" },
  "ai.perplexity.app.android": { channel: "ai", source: "perplexity" },
  "com.google.android.apps.bard": { channel: "ai", source: "gemini" },
};

/** The app a package id names, or null. Exact match on the lowercased id. */
export function matchAppPackage(id: string | null | undefined): AppPackage | null {
  const v = norm(id);
  if (!v) return null;
  return APP_PACKAGES[v] ?? null;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function norm(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

/** What a utm_source value says on its own. */
export function matchUtmSource(value: string | null | undefined): SourceMatch | null {
  const v = norm(value);
  if (!v) return null;
  const ai = AI_UTM_SOURCES[v];
  if (ai) return { channel: "ai", source: ai, by: "exact" };
  const social = SOCIAL_UTM_SOURCES[v];
  if (social) return { channel: "social", source: social, by: "exact" };
  if (UNNAMED_SOCIAL_UTM_SOURCES.has(v)) return { channel: "social", source: null, by: "exact" };
  if (PAID_SOURCE_RE.test(v)) return { channel: "paid", source: null, by: "pattern" };
  for (const [re, source] of AI_SOURCE_PATTERNS)
    if (re.test(v)) return { channel: "ai", source, by: "pattern" };
  for (const [re, source] of SOCIAL_SOURCE_PATTERNS) {
    if (re.test(v)) return { channel: "social", source, by: "pattern" };
  }
  if (EMAIL_SOURCE_RE.test(v)) return { channel: "email", source: null, by: "pattern" };
  if (/^(google|bing|yandex|duckduckgo|yahoo|brave)$/.test(v)) {
    return { channel: "organic", source: v, by: "exact" };
  }
  return null;
}

/** What a utm_medium value says on its own. */
export function matchUtmMedium(value: string | null | undefined): SourceMatch | null {
  const v = norm(value);
  if (!v) return null;
  if (PAID_MEDIUM_RE.test(v)) return { channel: "paid", source: null, by: "exact" };
  if (AI_MEDIUM_RE.test(v)) return { channel: "ai", source: null, by: "exact" };
  if (EMAIL_MEDIUM_RE.test(v)) return { channel: "email", source: null, by: "exact" };
  if (SOCIAL_MEDIUM_RE.test(v)) return { channel: "social", source: null, by: "pattern" };
  if (ORGANIC_MEDIUM_RE.test(v)) return { channel: "organic", source: null, by: "exact" };
  return null;
}

/**
 * Which kind of ad a paid visit came from (docs/specs/ads-platforms.md §4),
 * from what the signals already hold; null when nothing says.
 * - "search": a paid-search click id (gclid, msclkid...), or a search-set
 *   medium with a search engine as utm_source;
 * - "social": a paid-social click id (ttclid, li_fat_id, twclid...), or a
 *   social-set medium.
 * A paid-search click id wins over a medium: the platform built the link.
 * Read in memory only; it chooses which version, never a count.
 */
export function paidAdKind(s: Pick<Signals, "linkFamily" | "utm">): "search" | "social" | null {
  if (s.linkFamily === "paid-search") return "search";
  if (s.linkFamily === "paid-social") return "social";
  const medium = norm(s.utm.medium).replace(/[- ]/g, "_");
  if (PAID_SOCIAL_MEDIUMS.has(medium)) return "social";
  if (PAID_SEARCH_MEDIUMS.has(medium) && SEARCH_ENGINE_UTM_RE.test(norm(s.utm.source))) {
    return "search";
  }
  return null;
}

/** The name of the table entry the host is, or is a subdomain of; the longest entry wins. */
function hostName(host: string, table: Readonly<Record<string, SourceName>>): SourceName | null {
  let best: string | null = null;
  for (const h of Object.keys(table)) {
    if ((host === h || host.endsWith(`.${h}`)) && (best === null || h.length > best.length))
      best = h;
  }
  return best === null ? null : (table[best] ?? null);
}

/**
 * What a referrer host (host only, never a path) says on its own.
 *
 * @param isApp - true when the "host" is an Android package id from an
 *   `android-app://` referrer (Signals.referrerIsApp). A package id is looked
 *   up exactly in APP_PACKAGES and never goes through the host lists below,
 *   so an unknown one stays unclassified instead of being guessed.
 */
export function matchReferrerHost(
  host: string | null | undefined,
  isApp = false,
): SourceMatch | null {
  const h = norm(host).replace(/^www\./, "");
  if (!h) return null;
  const pkg = APP_PACKAGES[h];
  if (pkg) return { channel: pkg.channel, source: pkg.source, by: "exact" };
  if (isApp) return null;
  for (const [ai, source] of Object.entries(AI_HOSTS)) {
    if (h === ai || h.endsWith(`.${ai}`)) return { channel: "ai", source, by: "exact" };
  }
  const social = hostName(h, SOCIAL_HOST_NAMES);
  if (social) return { channel: "social", source: social, by: "exact" };
  const community = hostName(h, COMMUNITY_HOST_NAMES);
  if (community) return { channel: "community", source: community, by: "exact" };
  // Webmail before search: mail.google.com is email, not Google search.
  if (/^(mail|outlook|webmail)\./.test(h)) return { channel: "email", source: null, by: "pattern" };
  const search = hostName(h, SEARCH_HOST_NAMES);
  if (search) return { channel: "organic", source: search, by: "exact" };
  // Country-coded Google (google.co.uk, google.de) and a few universal shapes.
  if (/(^|\.)google\.[a-z.]{2,6}$/.test(h))
    return { channel: "organic", source: "google", by: "pattern" };
  return null;
}

/** True when nothing in the vocabulary recognises the value (a candidate for learning). */
export function isUnknownUtmSource(value: string | null | undefined): boolean {
  return !!norm(value) && matchUtmSource(value) === null;
}
export function isUnknownUtmMedium(value: string | null | undefined): boolean {
  return !!norm(value) && matchUtmMedium(value) === null;
}
export function isUnknownReferrerHost(host: string | null | undefined, isApp = false): boolean {
  return !!norm(host) && matchReferrerHost(host, isApp) === null;
}

// ---------------------------------------------------------------------------
// The name and the tag flag of a visit (N1, N3)
// ---------------------------------------------------------------------------

function named(v: string | null | undefined): SourceName | null {
  return isSourceName(v) ? v : null;
}

/**
 * The platform behind the source dimension the edge chose, from what the
 * request already carried; null when nothing on the closed list says it.
 * Each dimension reads the signals that feed it in the classifier, in the
 * order explicit tag, referrer, in-app marker, click-id name. `direct`
 * never has a name (email links land there; ADR 0029). The result is
 * always a SOURCE_NAMES word or null.
 */
export function sourceNameFor(s: Signals, sourceDim: string): SourceName | null {
  const ref = matchReferrerHost(s.referrerHost, s.referrerIsApp === true);
  const utm = matchUtmSource(s.utm.source);
  const app =
    s.appSource && s.appSource.app !== "unknown" && s.appSource.app !== "meta" ? s.appSource : null;
  const pick = (...c: Array<string | null | undefined>) => {
    for (const v of c) {
      const n = named(v);
      if (n) return n;
    }
    return null;
  };
  switch (sourceDim) {
    case "ai":
      return pick(s.aiSource);
    case "social":
      return pick(
        utm?.channel === "social" ? utm.source : null,
        ref?.channel === "social" ? ref.source : null,
        app?.channel === "social" ? app.app : null,
        isSocialClickId(s.linkFamily) ? s.clickId : null,
      );
    case "community":
      return pick(
        ref?.channel === "community" ? ref.source : null,
        app?.channel === "community" ? app.app : null,
      );
    case "organic":
      return pick(
        ref?.channel === "organic" ? ref.source : null,
        app?.channel === "organic" ? app.app : null,
        utm?.channel === "organic" ? utm.source : null,
      );
    case "paid":
      // An ad platform's click id; a utm "paid" match names no platform.
      return pick(isPaidClickId(s.linkFamily) ? s.clickId : null);
    default:
      return null;
  }
}

/**
 * utm_source values a platform writes on its own links, not the customer.
 * ChatGPT is the only one documented (OpenAI's publisher FAQ;
 * docs/research/ai-click-attribution-2026.md). A visit counts as the
 * customer's own tagged link (N3) only when it carries a utm parameter that
 * is not such a tag.
 */
export const AUTO_TAG_UTM_SOURCES: ReadonlySet<string> = new Set(["chatgpt.com"]);

/**
 * True when the link carried campaign tags the customer set: any utm_*
 * parameter, except a lone utm_source a platform writes itself
 * (utm_source=chatgpt.com still counts under ChatGPT, not as a tagged link).
 * One bit; the tags themselves are never kept.
 */
export function isOwnTagged(utm: Signals["utm"]): boolean {
  const keys = (Object.keys(utm) as Array<keyof Signals["utm"]>).filter((k) => !!utm[k]);
  if (keys.length === 0) return false;
  if (keys.length === 1 && keys[0] === "source" && AUTO_TAG_UTM_SOURCES.has(norm(utm.source))) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Learning guards (privacy review conditions, ADR 0030)
// ---------------------------------------------------------------------------

/**
 * Values a human identified as personal or otherwise never to be counted.
 * Add here when purging (scripts/source-purge.ts); the edge filters them
 * at source from the next deploy.
 */
export const DO_NOT_LEARN: ReadonlySet<string> = new Set<string>([]);

/**
 * A hostname that reads like a person's own domain ("jane-doe.dev",
 * "jane.doe.me", "janedoe.blog"): two short words joined by a hyphen or a
 * dot on a personal-style TLD. Crude on purpose; it errs towards not
 * learning. Such hosts are never counted.
 */
export function looksLikePersonalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  const labels = h.split(".");
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1] ?? "";
  const name = labels.slice(0, -1).join(".");
  const personalTld =
    /^(me|dev|blog|name|page|site|xyz|io|co|design|studio|art|photo|link|bio)$/.test(tld);
  const twoWords = /^[a-z]{2,12}[-.][a-z]{2,15}$/.test(name);
  return personalTld && twoWords;
}
