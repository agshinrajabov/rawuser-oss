/**
 * Where this install lives and who runs it: read from configuration.
 *
 * The code names no host, no address and no person. The worker's vars say
 * where the edge answers, where this worker answers, who sends mail and who
 * signs it. With a var unset the feature that needs it says so or goes
 * without: nothing falls back to somebody else's host, so an install never
 * calls a server it was not pointed at.
 *
 * Vars (strings; an empty one counts as unset):
 *   EDGE_ORIGIN            the edge worker's public origin: the tag this
 *                          worker prints, the policy lines, the two-part
 *                          paste, the tag the probe looks for. Unset: an
 *                          endpoint that must print a tag answers
 *                          EDGE_ORIGIN_MISSING.
 *   EDGE_ORIGIN_ALIASES    comma list of older origins a site's tag may
 *                          still load from; the probe finds those tags too
 *   API_ORIGIN             this worker's own public origin, for texts that
 *                          print it
 *   OWN_HOSTS              comma list of hostnames that reach the install's
 *                          workers; the render never calls them
 *                          (lib/own-hosts.ts adds the hosts of the origins)
 *   BOT_INFO_URL           the page that explains the fetcher, carried in
 *                          its user agent; unset, the agent has no address
 *   DASHBOARD_ORIGIN       the dashboard (also the CORS origin); "*" or
 *                          unset, an alert carries no link
 *   SENDER_ADDRESS         the address mail is sent from; unset, none is sent
 *   SENDER_NAME            the name beside it, default "Rawuser"
 *   REPLY_TO_ADDRESS       where a reply goes; unset, to the sender
 *   PRIVACY_ADDRESS        named where a text says whom to ask about data
 *   SUPPORT_ADDRESS        where "ask us" links point; unset, no link
 *   OPERATOR_NAME          who signs a message; unset, nobody
 *   EDGE_HEALTH_URL        the heartbeat's health address; default
 *                          EDGE_ORIGIN + /health; with neither, no check
 *   REMEMBER_DEFAULT       "on": a new customer starts with "Remember
 *                          returning visitors" on. Anything else, unset
 *                          included: off.
 *   REMEMBER_ON_SENSITIVE  "on": that memory may run on a site marked
 *                          sensitive. Anything else, unset included: not.
 */

import { type RememberOptions, rememberOnSensitive } from "@rawuser/shared";
import type { SiteResolver } from "./lib/public-url.ts";

export interface InstallEnv {
  /**
   * The machine's own DNS resolver, handed in by an install on a plain
   * server (packages/server). A Worker has none and asks one over HTTPS.
   */
  SITE_RESOLVER?: SiteResolver;
  EDGE_ORIGIN?: string;
  EDGE_ORIGIN_ALIASES?: string;
  API_ORIGIN?: string;
  OWN_HOSTS?: string;
  BOT_INFO_URL?: string;
  SENDER_ADDRESS?: string;
  SENDER_NAME?: string;
  REPLY_TO_ADDRESS?: string;
  PRIVACY_ADDRESS?: string;
  SUPPORT_ADDRESS?: string;
  OPERATOR_NAME?: string;
  EDGE_HEALTH_URL?: string;
  REMEMBER_DEFAULT?: string;
  REMEMBER_ON_SENSITIVE?: string;
}

/**
 * The dashboard's origin, apart from InstallEnv: the admin handlers require
 * it (it is their CORS origin), the crons take it when it is there.
 */
export interface DashboardEnv {
  DASHBOARD_ORIGIN?: string;
}

const set = (v: string | undefined): string => (typeof v === "string" ? v.trim() : "");

/** A value as an http(s) origin, without a path or a trailing slash; null when it is not one. */
export function originOf(value: string | undefined): string | null {
  const v = set(value);
  if (v === "") return null;
  try {
    const url = new URL(v);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** A comma list, trimmed, without empties. */
export function commaList(value: string | undefined): string[] {
  return set(value)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// ---------------------------------------------------------------------------
// The edge and this worker
// ---------------------------------------------------------------------------

/** What an endpoint answers when it must print a tag and has no origin for it. */
export const EDGE_ORIGIN_MISSING =
  "EDGE_ORIGIN is not set. Set it to the edge worker's public origin, then try again.";

/** The edge worker's public origin, or null. */
export function edgeOrigin(env: Pick<InstallEnv, "EDGE_ORIGIN">): string | null {
  return originOf(env.EDGE_ORIGIN);
}

/** Older origins a site's tag may still load from. */
export function edgeOriginAliases(env: Pick<InstallEnv, "EDGE_ORIGIN_ALIASES">): string[] {
  return commaList(env.EDGE_ORIGIN_ALIASES).flatMap((v) => originOf(v) ?? []);
}

/** Every origin a tag of this install may load from: the current one first, each once. */
export function edgeOrigins(
  env: Pick<InstallEnv, "EDGE_ORIGIN" | "EDGE_ORIGIN_ALIASES">,
): string[] {
  const first = edgeOrigin(env);
  return [...new Set([...(first ? [first] : []), ...edgeOriginAliases(env)])];
}

/** This worker's own public origin, or null. */
export function apiOrigin(env: Pick<InstallEnv, "API_ORIGIN">): string | null {
  return originOf(env.API_ORIGIN);
}

/** The heartbeat's health address: the override, else the edge's /health, else none. */
export function edgeHealthUrl(
  env: Pick<InstallEnv, "EDGE_HEALTH_URL" | "EDGE_ORIGIN">,
): string | null {
  const override = set(env.EDGE_HEALTH_URL);
  if (override !== "") return override;
  const origin = edgeOrigin(env);
  return origin ? `${origin}/health` : null;
}

// ---------------------------------------------------------------------------
// The fetcher
// ---------------------------------------------------------------------------

/**
 * The user agent of every page read (the setup read, the install facts, the
 * probe), so a site can recognise, allow or block it. With BOT_INFO_URL it
 * carries the page that explains the fetcher.
 */
export function fetcherUserAgent(env: Pick<InstallEnv, "BOT_INFO_URL">): string {
  const url = set(env.BOT_INFO_URL);
  return url === "" ? "Rawuser/1.0" : `Rawuser/1.0 (+${url})`;
}

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

/** The dashboard's origin without a trailing slash; null when unset or the dev wildcard. */
export function dashboardOrigin(env: DashboardEnv): string | null {
  const v = set(env.DASHBOARD_ORIGIN).replace(/\/+$/, "");
  return v === "" || v === "*" ? null : v;
}

/**
 * Where to look, for the end of an ops line: " · host/path", the dashboard
 * without its scheme. Empty when no dashboard is configured, so the line
 * ends at its own words.
 */
export function dashboardPointer(env: DashboardEnv, path: string): string {
  const origin = dashboardOrigin(env);
  return origin ? ` · ${origin.replace(/^https?:\/\//i, "")}${path}` : "";
}

// ---------------------------------------------------------------------------
// People and addresses
// ---------------------------------------------------------------------------

const orNull = (v: string | undefined): string | null => set(v) || null;

/** Who mail is sent as; null without an address: no mail is sent. */
export function mailSender(
  env: Pick<InstallEnv, "SENDER_ADDRESS" | "SENDER_NAME">,
): { email: string; name: string } | null {
  const email = set(env.SENDER_ADDRESS);
  return email === "" ? null : { email, name: set(env.SENDER_NAME) || "Rawuser" };
}

export function replyToAddress(env: Pick<InstallEnv, "REPLY_TO_ADDRESS">): string | null {
  return orNull(env.REPLY_TO_ADDRESS);
}

export function privacyAddress(env: Pick<InstallEnv, "PRIVACY_ADDRESS">): string | null {
  return orNull(env.PRIVACY_ADDRESS);
}

export function supportAddress(env: Pick<InstallEnv, "SUPPORT_ADDRESS">): string | null {
  return orNull(env.SUPPORT_ADDRESS);
}

export function operatorName(env: Pick<InstallEnv, "OPERATOR_NAME">): string | null {
  return orNull(env.OPERATOR_NAME);
}

// ---------------------------------------------------------------------------
// Returning visitors
// ---------------------------------------------------------------------------

/**
 * `customers.remember_off` for a new row: 0 only when REMEMBER_DEFAULT is
 * exactly "on". Unset reads as off, so an install that set nothing keeps no
 * code in a visitor's browser.
 */
export function rememberOffAtCreation(env: Pick<InstallEnv, "REMEMBER_DEFAULT">): 0 | 1 {
  return env.REMEMBER_DEFAULT === "on" ? 0 : 1;
}

/** What `rememberAllowed` and the bundle writer need from the vars. */
export function rememberOptions(env: Pick<InstallEnv, "REMEMBER_ON_SENSITIVE">): RememberOptions {
  return { onSensitive: rememberOnSensitive(env.REMEMBER_ON_SENSITIVE) };
}
