/**
 * Signal extraction orchestrator.
 *
 * Takes a request context and returns the full Signals object.
 * All helpers are called here in the correct order:
 *   1. referrer (privacy-load-bearing, must run before ai-source)
 *   2. AI source detection (UA + referrer host)
 *   2b. In-app browser marker and click-id presence (L2 source recovery)
 *   3. UTM
 *   4. device (UA-based, after AI bot detection)
 *   5. language (Accept-Language header, or overridden by snippet query param)
 *   6. country (CF-IPCountry / request.cf — country-only, never precise)
 *
 * The UA is consumed for classification and is NEVER stored or echoed
 * in the returned Signals object or in any response.
 *
 * This module is intended to run at the edge. When the snippet ships it
 * can pass navigator.language as ?lang=<tag> which takes priority over
 * Accept-Language.
 */

import { normalizePath } from "../path.ts";
import type { Signals } from "../types.ts";
import { detectAiSource } from "./ai-source.ts";
import { detectAppSource } from "./app-source.ts";
import { parseClickId } from "./click-id.ts";
import { classifyDevice } from "./device.ts";
import { parseReferrer } from "./referrer.ts";
import { parseUtm } from "./utm.ts";

/** Minimum Cloudflare request.cf shape used for geo extraction. */
export interface CfProperties {
  country?: string | null;
}

/** Input to extractSignals — modelled on the edge request context. */
export interface ExtractInput {
  /** Already-parsed URL — caller parses once and reuses. */
  url: URL;
  /** The request headers (read-only access). */
  headers: Headers;
  /** Cloudflare request.cf properties — country-level only. */
  cf?: CfProperties;
  /**
   * The host of the current site. Used to detect same-origin referrers and
   * return null for them (internal navigation noise). Optional — if omitted,
   * all referrer hosts are treated as external.
   */
  selfHost?: string;
  /**
   * The visitor's entry-page path (e.g. from the snippet's `?path=` param).
   * Normalized here via normalizePath and surfaced as Signals.entryPath, the
   * L1 intent signal (ADR 0023). Optional — absent → "/" (no contribution).
   */
  entryPath?: string | null;
  /**
   * The snippet's presence-only `ss=1`: the visitor came from a page of this
   * same site (document.referrer's hostname equals location.hostname; the
   * referrer itself is never sent). Then this page's utm parameters and
   * click-id names are the site's own links (a hero button to
   * /start?utm_source=home), not a new landing source: they are left out, so
   * the page classifies from the tab's carry like any internal page and is
   * never counted as a tagged link (docs/specs/results-data.md §7).
   */
  sameSite?: boolean;
}

/**
 * Extracts all ambient signals from the request context.
 *
 * Privacy guarantees:
 * - referrerHost is host-only (no path/query). Same-origin → null.
 * - UA is consumed; not stored in the returned object.
 * - country is country-code only from cf.country; never derived from IP.
 * - No cookies, no fingerprinting, no cross-session ID.
 */
export function extractSignals(input: ExtractInput): Signals {
  const { url, headers, cf, selfHost, entryPath, sameSite = false } = input;

  // The snippet forwards document.referrer as `ref`: that is where the
  // visitor came from. The Referer header of its /select fetch is the
  // customer's own page, which reduces to null, and it used to win, so no
  // visitor ever got a referrer-based source in a real browser (found live
  // on template-lab, 2026-09-28: Hacker News and Google landed as
  // problem:default). `ref` first, then the header (a request that is the
  // page itself, with no `ref`). Both reduce to host-only via
  // parseReferrerHost, the same privacy contract for either.
  // An `android-app://<package>` referrer keeps the package id as its host
  // and says so (referrerIsApp), so the vocabulary matches it exactly and
  // never as a web host (Layer G).
  const referrer =
    parseReferrer(url.searchParams.get("ref"), selfHost) ??
    parseReferrer(headers.get("referer") ?? headers.get("referrer"), selfHost);
  const referrerHost = referrer?.host ?? null;
  const referrerIsApp = referrer?.isApp === true;

  const ua = headers.get("user-agent");

  // UTM first: ChatGPT tags its own links (utm_source=chatgpt.com), the one
  // trace that survives its apps dropping the referrer.
  // A page reached from this same site: its parameters are the site's own.
  const utm = sameSite ? {} : parseUtm(url);
  const aiDetected = detectAiSource(ua, referrerHost, utm, referrerIsApp);
  const { isBot: aiIsBot, isCitationClick } = aiDetected;

  // In-app browser marker (L2). When the webview stripped the referrer this
  // is the only trace of the channel. An AI app (ChatGPT app and the like)
  // also counts as an AI source; a social app feeds source.social via the
  // classifier. UA is read here and discarded like everywhere else.
  // Sec-CH-UA is the low-entropy Client Hints header Chromium sends by
  // default; read for the "Android WebView" brand and discarded like the UA.
  const secChUa = headers.get("sec-ch-ua");
  const appSource = aiIsBot ? null : detectAppSource(ua, secChUa);

  // Tracked-link presence (L2): the parameter NAME says which platform built
  // the link; the value is never read. An ad clicked inside ChatGPT (oppref)
  // is an AI source in its own right.
  const click = sameSite ? null : parseClickId(url);
  const clickId = click?.platform ?? null;
  const linkFamily = click?.family ?? null;

  const aiSource =
    aiDetected.aiSource ??
    (appSource?.channel === "ai" ? (appSource.app as Signals["aiSource"]) : null) ??
    (linkFamily === "ai-ads" ? "chatgpt" : null);

  // Device classification: if AI bot detection already flagged isBot,
  // return "bot" directly to avoid redundant UA parsing.
  const device = aiIsBot ? "bot" : classifyDevice(ua);

  // Language: prefer snippet's ?lang= query param over Accept-Language header.
  const language = extractLanguage(url, headers);

  // Country: country-level only from Cloudflare's edge enrichment.
  // Never derive precise location from IP.
  const country = cf?.country ?? null;

  return {
    utm,
    referrerHost,
    // Only present when true, so a web referrer's Signals look as before.
    ...(referrerIsApp ? { referrerIsApp: true } : {}),
    device,
    language,
    country,
    aiSource,
    appSource,
    clickId,
    linkFamily,
    // Entry-path intent signal (L1, ADR 0023). Normalized so the classifier
    // and per-path lookups agree; null when not supplied.
    entryPath: entryPath != null ? normalizePath(entryPath) : null,
    // Internal flag — not forwarded to clients; used by lead-probability heuristic.
    _isCitationClick: isCitationClick,
  };
}

function extractLanguage(url: URL, headers: Headers): string | null {
  // Prefer explicit snippet override.
  const langParam = url.searchParams.get("lang");
  if (langParam) {
    const trimmed = langParam.trim();
    return trimmed || null;
  }

  const acceptLang = headers.get("accept-language");
  if (!acceptLang) return null;

  // Parse first language tag from "en-US,en;q=0.9,fr;q=0.8".
  const first = acceptLang.split(",")[0];
  if (!first) return null;

  // Strip quality value: "en-US;q=0.9" → "en-US".
  const tag = first.split(";")[0]?.trim();
  return tag || null;
}
