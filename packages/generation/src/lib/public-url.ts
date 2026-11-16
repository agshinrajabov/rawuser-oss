/**
 * Public-URL guard for site reads started by someone outside the team
 * (docs/specs/pilot-apply.md, 2026-10-01). The apply page lets an invited
 * customer type any URL and press "Read my site", so the worker must never
 * fetch a loopback, private, link-local or metadata address on their behalf.
 *
 * Three layers:
 *   1. Syntax: http(s) only, no credentials, default ports only, no
 *      localhost / *.localhost / *.local / *.internal / *.home.arpa, no
 *      single-label hosts, no IP literal in a non-public range (v4 and v6).
 *      The WHATWG URL parser has already canonicalised "2130706433",
 *      "0x7f.1" and "[::ffff:127.0.0.1]" by the time we look.
 *   2. Resolution: Workers have no DNS API, so the hostname is resolved
 *      over DNS-over-HTTPS (A and AAAA). A name that does not resolve, or
 *      resolves to any non-public address, is refused. When the resolver
 *      itself cannot be reached or gives no clear answer, the read is
 *      refused too: fail closed (privacy review, 2026-10-01). The
 *      applicant sees "enter your site's public address" and can retry.
 *   3. Redirects are followed by hand (redirect: "manual") and every hop
 *      goes through 1 and 2 again, so a public page cannot bounce the read
 *      to 169.254.169.254.
 *
 * Accepted residual risk (2026-10-01): DNS rebinding. The DoH lookup and
 * the fetch resolve the name separately, so a hostile name with a short
 * TTL can answer public to the check and private to the fetch. Workers
 * offer no way to pin the fetch to the checked address, so this gap cannot
 * be closed here; Workers fetch not routing to private networks is the
 * wall behind it.
 *
 * The URL is never logged here.
 */

export class NotPublicUrlError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NotPublicUrlError";
  }
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];
const MAX_REDIRECTS = 5;
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 4_000;

/**
 * What a customer typed ("northwind-app.test", "https://x.io/pricing") as a
 * URL. A bare host gets https://. Returns null when it does not parse.
 */
export function normalizeSiteUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > 2048) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/** The hostname without IPv6 brackets or a trailing root dot, lowercased. */
function bareHost(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/**
 * Why this URL may not be read, or null when its syntax is a public website.
 * Does not resolve the name; see assertPublicUrl for that.
 */
export function publicUrlProblem(url: URL): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme";
  if (url.username !== "" || url.password !== "") return "credentials";
  if (url.port !== "" && url.port !== "80" && url.port !== "443") return "port";
  const host = bareHost(url);
  if (host === "") return "host";
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return "private-host";
  }
  const v4 = parseIPv4(host);
  if (v4) return isPublicIPv4(v4) ? null : "private-ip";
  if (host.includes(":")) {
    const v6 = parseIPv6(host);
    if (!v6) return "host";
    return isPublicIPv6(v6) ? null : "private-ip";
  }
  if (!host.includes(".")) return "private-host";
  return null;
}

// ---------------------------------------------------------------------------
// IP ranges
// ---------------------------------------------------------------------------

export function parseIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** False for every IANA special-purpose IPv4 range a site cannot live in. */
export function isPublicIPv4(ip: number[]): boolean {
  const [a = 0, b = 0, c = 0] = ip;
  if (a === 0) return false; // this network
  if (a === 10) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF, TEST-NET-1
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Eight 16-bit groups, or null. Accepts "::" and a dotted IPv4 tail. */
export function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (dotted?.[1]) {
    const v4 = parseIPv4(dotted[1]);
    if (!v4) return null;
    const hi = (((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16);
    const lo = (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16);
    s = `${s.slice(0, s.length - dotted[1].length)}${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string | undefined): string[] =>
    part === undefined || part === "" ? [] : part.split(":");
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(Number.parseInt(g, 16));
  }
  return out.length === 8 ? out : null;
}

function embeddedV4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/** False for loopback, unspecified, ULA, link-local, multicast, documentation, and any embedded non-public IPv4. */
export function isPublicIPv6(h: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, , , g5 = 0, g6 = 0, g7 = 0] = h;
  const firstFiveZero = h.slice(0, 5).every((g) => g === 0);
  if (firstFiveZero && g5 === 0) {
    // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
    if (g6 === 0 && (g7 === 0 || g7 === 1)) return false;
    return isPublicIPv4(embeddedV4(g6, g7));
  }
  if (firstFiveZero && g5 === 0xffff) return isPublicIPv4(embeddedV4(g6, g7)); // IPv4-mapped
  if (g0 === 0x64 && g1 === 0xff9b) return isPublicIPv4(embeddedV4(g6, g7)); // NAT64
  if (g0 === 0x2002) return isPublicIPv4(embeddedV4(g1, g2)); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local
  if ((g0 & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x0100 && h.slice(1, 4).every((g) => g === 0)) return false; // discard
  return true;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

type Resolution = "public" | "private" | "unresolved" | "unknown";

interface DohAnswer {
  type?: number;
  data?: string;
}

async function dohQuery(
  host: string,
  type: "A" | "AAAA",
): Promise<{ status: number; ips: string[] } | null> {
  try {
    const resp = await fetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { Status?: number; Answer?: DohAnswer[] };
    const wanted = type === "A" ? 1 : 28;
    const ips = (body.Answer ?? [])
      .filter((a) => a.type === wanted && typeof a.data === "string")
      .map((a) => a.data as string);
    return { status: typeof body.Status === "number" ? body.Status : -1, ips };
  } catch {
    return null;
  }
}

/** Whether every one of these addresses is a public one. */
function classify(ips: readonly string[]): "public" | "private" {
  for (const ip of ips) {
    const v4 = parseIPv4(ip);
    if (v4 && !isPublicIPv4(v4)) return "private";
    if (!v4) {
      const v6 = parseIPv6(ip);
      if (!v6 || !isPublicIPv6(v6)) return "private";
    }
  }
  return "public";
}

/**
 * The addresses a host name resolves to: every one of them, an empty list
 * when the name does not exist, null when the resolver could not say. A
 * Worker has no resolver of its own, so the default asks one over HTTPS; an
 * install on a plain machine hands in its own (`SITE_RESOLVER` in the
 * worker's env), and then nothing is asked of anyone outside.
 */
export type SiteResolver = (host: string) => Promise<string[] | null>;

/** Resolves a hostname and classifies every address it gets. */
export async function resolveHost(host: string, resolver?: SiteResolver): Promise<Resolution> {
  if (resolver) {
    const ips = await resolver(host).catch(() => null);
    if (ips === null) return "unknown";
    return ips.length === 0 ? "unresolved" : classify(ips);
  }
  const [a, aaaa] = await Promise.all([dohQuery(host, "A"), dohQuery(host, "AAAA")]);
  if (!a && !aaaa) return "unknown";
  const ips = [...(a?.ips ?? []), ...(aaaa?.ips ?? [])];
  if (ips.length === 0) {
    // NXDOMAIN or no address records. A resolver error on one half with
    // nothing on the other is "unknown"; the caller refuses both.
    const answered = [a, aaaa].filter((r) => r !== null);
    return answered.every((r) => r.status === 0 || r.status === 3) ? "unresolved" : "unknown";
  }
  return classify(ips);
}

/** Throws NotPublicUrlError unless the URL is a public website by syntax and by resolution. */
export async function assertPublicUrl(url: URL, resolver?: SiteResolver): Promise<void> {
  const problem = publicUrlProblem(url);
  if (problem) throw new NotPublicUrlError(problem);
  const host = bareHost(url);
  if (parseIPv4(host) || host.includes(":")) return; // literal already classified
  const resolution = await resolveHost(host, resolver);
  if (resolution === "private") throw new NotPublicUrlError("resolves-private");
  // "unknown" (resolver down or ambiguous) fails closed, like "unresolved".
  if (resolution === "unresolved" || resolution === "unknown") {
    throw new NotPublicUrlError("unresolved");
  }
}

// ---------------------------------------------------------------------------
// The host rule: every server read of a customer's site stays on its host
// ---------------------------------------------------------------------------

/**
 * The one host a read may follow redirects on, from a recorded domain or a
 * typed address ("Example.com", "https://www.example.com/pricing",
 * "example.com:443"): lowercased, no scheme, path or port. Empty when
 * nothing is left.
 */
export function siteHost(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

/** The same site: one host, with `www.` and the apex counted as one. */
export function sameSite(a: string, b: string): boolean {
  const fold = (h: string) => siteHost(h).replace(/^www\./, "");
  return fold(a) !== "" && fold(a) === fold(b);
}

/**
 * A redirect, or the address itself, left the host the read was allowed on
 * (docs/specs/site-shaped-intents.md §13.2 point 4). The read stops; the
 * other host is never fetched.
 */
export class OffHostRedirectError extends Error {
  constructor() {
    super("redirect off the recorded host");
    this.name = "OffHostRedirectError";
  }
}

/** The plain line a screen shows when a page redirects off its site. */
export const OFF_HOST_LINE =
  "The page redirects to another host. Rawuser reads only the site's own addresses.";

/**
 * fetch() that follows redirects by hand, at most five, and only on
 * `sameHostAs` (`www.` and the apex are one site): a hop to any other host
 * ends the read with OffHostRedirectError before it is fetched. With
 * `checkPublic` every hop also goes through assertPublicUrl. Returns the
 * first non-redirect response and the address it came from.
 */
export async function fetchOnHost(
  url: URL,
  init: RequestInit,
  sameHostAs: string,
  checkPublic: boolean,
  resolver?: SiteResolver,
): Promise<{ resp: Response; finalUrl: URL }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!sameSite(current.hostname, sameHostAs)) throw new OffHostRedirectError();
    if (checkPublic) await assertPublicUrl(current, resolver);
    const resp = await fetch(current.toString(), { ...init, redirect: "manual" });
    if (resp.status < 300 || resp.status >= 400) return { resp, finalUrl: current };
    const location = resp.headers.get("location");
    if (!location) return { resp, finalUrl: current };
    current = new URL(location, current);
  }
  throw new Error("Too many redirects");
}

/**
 * fetchOnHost with the public-address check on by default. Without
 * `sameHostAs` the read stays on the URL's own host: no caller follows a
 * redirect to another site.
 */
export async function fetchPublic(
  url: URL,
  init: RequestInit,
  sameHostAs?: string,
  /** False: the host check only, without the public-address check (a customer's own domain). */
  checkPublic = true,
  resolver?: SiteResolver,
): Promise<Response> {
  return (await fetchOnHost(url, init, sameHostAs ?? url.hostname, checkPublic, resolver)).resp;
}
