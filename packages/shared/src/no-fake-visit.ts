/**
 * No fake visit, the one rule (docs/specs/install-friction.md, A and
 * "What the other passes need"; privacy review 2026-10-03, condition 3).
 *
 * The render (generation, lib/render-page.ts) opens a customer's page in a
 * Cloudflare Browser Run browser. When the page carries the tag, that
 * browser would call /select, /event and /carry like a visitor. Two layers
 * keep it from ever counting as a visit:
 *
 * 1. Inside the render, every request to one of the install's own hosts is
 *    aborted (`isOwnHost`). The custom domains are configuration (generation
 *    lib/own-hosts.ts reads them from the worker's vars); the workers.dev
 *    names are the constant below. A test in generation ties both to the
 *    routes and worker names in the two wrangler.toml files.
 * 2. At the edge, a request that carries Browser Run's marks
 *    (`isRenderBrowser`) takes the bot path: no version, no row, no copy.
 *
 * Both layers live here so neither can change without the other in view.
 */

/**
 * workers.dev names of the two workers, as the first label. The account
 * subdomain is not pinned: any `<name>.<anything>.workers.dev` counts.
 */
export const WORKER_NAMES: readonly string[] = [
  "rawuser-edge",
  "rawuser-edge-production",
  "rawuser-generation",
  "rawuser-generation-production",
];

/**
 * True when a request to this hostname would reach one of the install's
 * workers: a hostname in `ownHosts` (the custom domains, lower case), or a
 * workers.dev host under one of the workers' names.
 */
export function isOwnHost(hostname: string, ownHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (ownHosts.includes(host)) return true;
  if (host.endsWith(".workers.dev")) {
    const first = host.split(".")[0] ?? "";
    return WORKER_NAMES.includes(first);
  }
  return false;
}

/**
 * Browser Run's marks, as seen on a target during the generation build
 * (2026-10-04, httpbin; spec "Build notes"):
 * - `Cf-Brapi-Devtools: 1` and other non-configurable `cf-brapi-*` headers;
 * - `Signature-Agent: "https://web-bot-auth.cloudflare-browser-rendering-085.workers.dev"`
 *   (Web Bot Auth; matched on the name, the number may change);
 * - a user agent with `HeadlessChrome/`.
 * Any one of them is enough.
 */
export const BROWSER_RUN_MARKS = {
  /** Prefix of Browser Run's own request headers, lowercase. */
  headerPrefix: "cf-brapi-",
  /** Part of the Signature-Agent value Browser Run signs with, lowercase. */
  signatureAgent: "cloudflare-browser-rendering",
  /** User-agent token of a headless Chrome, lowercase. */
  userAgent: "headlesschrome/",
} as const;

/**
 * True when the request comes from Browser Run (or any headless Chrome).
 * Reads header names and two values, keeps nothing.
 */
export function isRenderBrowser(headers: Headers): boolean {
  const ua = (headers.get("user-agent") ?? "").toLowerCase();
  if (ua.includes(BROWSER_RUN_MARKS.userAgent)) return true;
  const agent = (headers.get("signature-agent") ?? "").toLowerCase();
  if (agent.includes(BROWSER_RUN_MARKS.signatureAgent)) return true;
  for (const [name] of headers) {
    if (name.toLowerCase().startsWith(BROWSER_RUN_MARKS.headerPrefix)) return true;
  }
  return false;
}
