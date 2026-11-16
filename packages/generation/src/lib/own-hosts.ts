/**
 * The install's own hosts, one list (docs/specs/install-friction.md, A;
 * privacy review 2026-10-03, condition 3).
 *
 * The render (lib/render-page.ts) opens a customer's page in a browser.
 * When the page already carries the tag, that browser would call /select
 * and /event like a visitor and the edge would count a visit that never
 * happened. Every request to these hosts is aborted inside the render.
 *
 * The custom domains are configuration: `OWN_HOSTS`, plus the hosts of
 * `EDGE_ORIGIN`, its aliases and `API_ORIGIN`, so an install that set its
 * origins is covered without a second list. The workers.dev names are a
 * constant in @rawuser/shared (no-fake-visit.ts), next to the edge's second
 * layer. A test (test/lib/own-hosts.test.ts) ties both to the routes and
 * worker names in packages/edge/wrangler.toml and
 * packages/generation/wrangler.toml, so a route cannot be added there
 * without being blocked here.
 */

import { type InstallEnv, apiOrigin, commaList, edgeOrigins } from "../install-config.ts";

export { WORKER_NAMES, isOwnHost } from "@rawuser/shared/no-fake-visit";

export type OwnHostsEnv = Pick<
  InstallEnv,
  "OWN_HOSTS" | "EDGE_ORIGIN" | "EDGE_ORIGIN_ALIASES" | "API_ORIGIN"
>;

/** A list entry as a bare hostname: lower case, no scheme, port, path or trailing dot. */
function hostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/:].*$/, "")
    .replace(/\.$/, "");
}

/**
 * Every custom hostname that reaches one of the install's workers, lower
 * case, each once: the second argument of `isOwnHost`.
 */
export function ownHosts(env: OwnHostsEnv): string[] {
  const api = apiOrigin(env);
  const origins = [...edgeOrigins(env), ...(api ? [api] : [])];
  const hosts = [...commaList(env.OWN_HOSTS), ...origins].map(hostname).filter((h) => h !== "");
  return [...new Set(hosts)];
}
