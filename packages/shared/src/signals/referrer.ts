/**
 * Referrer host extraction — privacy-load-bearing helper.
 *
 * This module exists as a standalone unit because the host-only reduction
 * (dropping path and query) is a hard privacy requirement. Path and query
 * strings can carry PII (e.g., email addresses in mail-tracking links,
 * session tokens, etc.). We must never store or log the referrer path.
 *
 * Contract:
 * - Returns ONLY the host portion of the referrer.
 * - Returns null if the referrer is missing, unparseable, or same-origin.
 * - The returned string will NEVER contain "?" or "/" — only a bare host.
 *
 * Android app referrers (Layer G, docs/specs/source-recovery.md): Chromium
 * accepts a referrer from an app only as `android-app://<authority>`. The
 * authority is usually the app's package id (`com.facebook.katana`) and
 * sometimes a hostname (`m.facebook.com`, Facebook's "links open
 * externally" mode). parseReferrer says which: a package id is matched
 * exactly against the package table, a hostname like any web referrer.
 */

import { matchAppPackage } from "./source-vocabulary.ts";

export interface ReferrerInfo {
  /** Bare host, or the package id of an `android-app://` referrer. Lowercase. */
  host: string;
  /** True when `host` is an Android package id, not a web host. */
  isApp: boolean;
}

/**
 * A label that can end a hostname. Two letters (country codes) or a common
 * generic TLD. Used only on `android-app://` authorities, to tell a package
 * id from a hostname.
 */
const TLD_LIKE =
  /^(?:[a-z]{2}|com|net|org|edu|gov|mil|int|info|biz|pro|xyz|app|dev|site|online|shop|store|blog|cloud|tech|news|live|link|page|space|website|media|group|world|life|today|agency|digital|chat|social|microsoft|google)$/;

/** Reverse-DNS roots: a package id puts the TLD-like label first. */
const PACKAGE_ROOT = /^(?:com|org|net|io)\./;

/**
 * Shape rule after Adobe rum-distiller PR #137 (Apache-2.0), re-implemented:
 * `com.example.app` is a package id because its TLD-like label comes first;
 * `app.example.com` is a hostname because it comes last. An authority with
 * no TLD-like last label (`jp.naver.line.android`) is a package id too.
 * Exported for tests.
 */
export function isPackageShaped(authority: string): boolean {
  if (PACKAGE_ROOT.test(authority)) return true;
  const last = authority.slice(authority.lastIndexOf(".") + 1);
  return !TLD_LIKE.test(last);
}

/**
 * Parses the raw referrer and returns the host plus whether it is an
 * Android package id.
 *
 * @param raw - The raw referrer (may be empty/null/undefined).
 * @param selfHost - The host of the current site; same-origin returns null.
 */
export function parseReferrer(
  raw: string | null | undefined,
  selfHost?: string,
): ReferrerInfo | null {
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();

  if (!host) return null;

  // Same-origin check: if referrer is from our own site, it is internal
  // navigation and not useful for intent detection.
  if (selfHost) {
    const normSelf = selfHost.replace(/^www\./, "").toLowerCase();
    const normHost = host.replace(/^www\./, "").toLowerCase();
    if (normHost === normSelf || normHost.endsWith(`.${normSelf}`)) {
      return null;
    }
  }

  // An app referrer: a known package id, or an authority shaped like one.
  // A hostname authority (android-app://m.facebook.com) stays a web host.
  const isApp =
    parsed.protocol === "android-app:" && (matchAppPackage(host) !== null || isPackageShaped(host));

  // Return ONLY the host — no path, no query, no fragment, no port.
  // This is the privacy-critical reduction.
  return { host, isApp };
}

/**
 * Parses the raw Referer header and returns only the host.
 *
 * @param raw - The raw Referer header value (may be empty/null/undefined).
 * @param selfHost - The host of the current site. Same-origin referrers
 *   return null (not meaningful for intent detection and avoids internal
 *   navigation noise).
 * @returns The referring hostname only (or an app's package id), or null.
 */
export function parseReferrerHost(
  raw: string | null | undefined,
  selfHost?: string,
): string | null {
  return parseReferrer(raw, selfHost)?.host ?? null;
}
