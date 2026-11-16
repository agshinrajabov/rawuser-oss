/**
 * What direct is made of (ADR 0038, part 1; docs/specs/direct-visitors.md §1).
 *
 * Two coarse facts about the browser of a visit, read from the request's own
 * headers at `/event` and stored on the event row:
 *
 * - `events.device_class`: one word from DEVICE_CLASSES, from the User-Agent
 *   through `classifyDevice` (signals/device.ts). A crawler that reaches
 *   `/event` and a request with no User-Agent read `other`.
 * - `events.web_view`: 1 when the page ran inside an app's in-app browser
 *   (`detectAppSource`, signals/app-source.ts: a named app in the UA, the
 *   "Android WebView" Client Hints brand or the `; wv)` token, or the iOS
 *   WebKit heuristic), else 0.
 *
 * Never the User-Agent itself, a browser or OS name or version, a screen or
 * anything else about the device: one of four words and one bit, the same
 * for every visitor on that kind of device, so neither can single anyone
 * out. Never used to choose a version, never joined across customers, never
 * sent back to a browser, a model or an alert. Off with
 * `customers.direct_insights_off` (the bundle's `dx`).
 */

import { detectAppSource } from "./signals/app-source.ts";
import { classifyDevice } from "./signals/device.ts";

/** The words `events.device_class` holds. */
export const DEVICE_CLASSES = ["mobile", "tablet", "desktop", "other"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

const CLASSES: ReadonlySet<string> = new Set(DEVICE_CLASSES);

/** True for a word `events.device_class` may hold. */
export function isDeviceClass(v: unknown): v is DeviceClass {
  return typeof v === "string" && CLASSES.has(v);
}

/**
 * The stored device word of a User-Agent: mobile, tablet or desktop as
 * `classifyDevice` reads it; `other` for a crawler (`bot`) and for a request
 * with no User-Agent (`classifyDevice` would call that desktop).
 */
export function deviceClassOf(ua: string | null | undefined): DeviceClass {
  if (!ua) return "other";
  const d = classifyDevice(ua);
  return d === "bot" ? "other" : d;
}

/** 1 when the request came from an app's in-app browser, else 0. */
export function webViewOf(ua: string | null | undefined, secChUa?: string | null): 0 | 1 {
  return detectAppSource(ua, secChUa ?? null) ? 1 : 0;
}

/** The words the Visitors read gives `web_view` (docs/specs/visitors-page.md §2). */
export const WEB_VIEW_WORDS = ["app", "browser"] as const;
export type WebViewWord = (typeof WEB_VIEW_WORDS)[number];
