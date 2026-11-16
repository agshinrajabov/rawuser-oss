import { readCarryStamp } from "./carry.ts";
import { normalizePath } from "./path.ts";

/**
 * Tracked-link parameter names, mirrored from @rawuser/shared click-id.ts.
 * Duplicated on purpose: the snippet bundles nothing from shared to stay
 * tiny, and the edge is the source of truth for the mapping. A test asserts
 * the two lists are identical. Names only ever leave the page; the values
 * (ad click tokens, email recipient ids) never do.
 */
// One string, split once: the same list in fewer bytes (the boot carries it).
export const CLICK_ID_NAMES = (
  "oppref gclid gclsrc gbraid wbraid dclid gad_source gad_campaignid " +
  "msclkid yclid s_kwcid ef_id ttclid li_fat_id sccid twclid rdt_cid epik " +
  "qclid fbclid igshid igsh mc_cid mc_eid _hsenc _hsmi mkt_tok vero_conv " +
  "vero_id ck_subscriber_id ml_subscriber ml_subscriber_hash _kx irclickid " +
  "irclid sscid awc cjevent aff_id wickedid ref via"
).split(" ");
import type { SelectResponse } from "./types.ts";

/**
 * Fetch a resolved variant from the edge /select endpoint.
 *
 * Privacy constraints (non-negotiable):
 * - credentials: 'omit'  — no cookies cross the wire to the edge
 * - cache: 'no-store'    — each visit gets a fresh selection
 * - Only utm_* params, the NAMES of click-id params (never their values),
 *   the scheme and host of document.referrer (never its path or query),
 *   or, for a referrer on this same site, only the bit `ss=1`,
 *   location.hostname, and navigator.language are read from the browser. No UA, no screen,
 *   no timezone, no device memory — nothing that could contribute
 *   to a fingerprint. The Referer reduces to host-only at the edge.
 *
 * @param customerId   The customer_id from the script tag's data attribute.
 * @param edgeOrigin   The edge worker origin (e.g. https://edge.rawuser.test).
 * @param signal       Optional AbortSignal for fetch timeout control.
 * @returns Parsed SelectResponse from the edge.
 * @throws On non-2xx response or network error (caller must catch and reveal);
 *   an answer that came back unusable (non-2xx, unreadable) carries `http: 1`.
 */
/**
 * Whether this page brings a signal of its own (UTM, a click id name, or a
 * referrer from another site). Only a page without one may be written from
 * the tab's carried copy before the edge answers (body carry, condition 6).
 */
export function ownSignal(
  loc: { search: string; hostname: string } = location,
  ref = document.referrer,
): boolean {
  // Reached from this same site: the page's parameters are the site's own
  // links, not a signal (the edge leaves them out on `ss=1`).
  if (sameSite(ref, loc.hostname)) return false;
  for (const [k] of new URLSearchParams(loc.search)) {
    if (k.startsWith("utm_") || CLICK_ID_NAMES.includes(k.toLowerCase())) return true;
  }
  if (!ref) return false;
  try {
    return new URL(ref).hostname !== loc.hostname;
  } catch {
    return false;
  }
}

/**
 * True when document.referrer is a page of this same site (its hostname is
 * location.hostname). Sent as the presence-only `ss=1`; the referrer itself
 * never leaves the page and nothing is stored.
 */
export function sameSite(ref: string, selfHost: string): boolean {
  if (!ref) return false;
  try {
    return new URL(ref).hostname === selfHost;
  } catch {
    return false;
  }
}

/**
 * The referrer as the edge needs it: `scheme://host`, nothing else (no
 * path, no query, no fragment). Not URL.origin, which is "null" for
 * android-app://<package>. Nothing for a referrer on this same hostname:
 * the edge treats it as internal navigation (parseReferrer with self_host)
 * and the fetch's own Referer header reduces to the same null, so dropping
 * it changes no result.
 */
export function refParam(ref: string, selfHost: string): string | null {
  if (!ref) return null;
  try {
    const r = new URL(ref);
    if (!r.host || r.hostname === selfHost) return null;
    return `${r.protocol}//${r.host}`;
  } catch {
    return null;
  }
}

/**
 * The same segment's copy for the customer's other confirmed pages, asked
 * after the reveal (body carry prefetch). The request carries the customer
 * id and the two labels only: no visit, no referrer, no page parameter; the
 * edge caches it per segment.
 */
export async function fetchBodies(
  customerId: string,
  edgeOrigin: string,
  intentDim: string,
  sourceDim: string,
): Promise<Record<string, unknown>> {
  const url = new URL("/carry", edgeOrigin);
  url.searchParams.set("customer_id", customerId);
  url.searchParams.set("carry", `${intentDim}:${sourceDim}`);
  const r = await fetch(url.toString(), {
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) return {};
  const j = (await r.json()) as { bodies?: Record<string, unknown> };
  return j.bodies && typeof j.bodies === "object" ? j.bodies : {};
}

export async function fetchVariant(
  customerId: string,
  edgeOrigin: string,
  signal?: AbortSignal,
  visit?: string | null,
  noTerm = false,
): Promise<SelectResponse> {
  const url = new URL("/select", edgeOrigin);
  const q = url.searchParams;
  q.set("customer_id", customerId);
  q.set("lang", navigator.language);

  // Forward UTM params from the visitor's current page URL. Without this,
  // the edge classifier sees no UTMs and snaps every visitor to the same
  // intent dim (the default fallback). Privacy: utm_* are intent signals,
  // never PII. `noTerm` (the script's `nt: 1`): this customer's edge does not
  // read the ad keyword, so utm_term stays on the page (keyword-intent.md).
  const pageParams = new URLSearchParams(location.search);
  const clickIdNames: string[] = [];
  for (const [k, v] of pageParams) {
    if (k.startsWith("utm_")) {
      if (!noTerm || k.toLowerCase() !== "utm_term") q.set(k, v);
    }
    // Click ids (fbclid, gclid, …): forward the NAME only. The value is the
    // platform's per-click token and never leaves the page. The edge maps
    // the name to a channel (L2 source recovery).
    else if (CLICK_ID_NAMES.includes(k.toLowerCase())) clickIdNames.push(k.toLowerCase());
  }
  if (clickIdNames.length > 0) q.set("clk", clickIdNames.join(","));

  // Forward where the visitor came from, as scheme and host only (refParam).
  // Browsers may strip or truncate the Referer header on cross-origin fetch
  // depending on referrer-policy, so the snippet sends it explicitly. Never
  // the path or query: a page two after a Klaviyo landing has a referrer
  // carrying ?_kx=<recipient token>, which must not leave the page.
  const ref = refParam(document.referrer, location.hostname);
  if (ref) q.set("ref", ref);
  // From a page of this same site: one presence bit, never the referrer. The
  // edge then reads this page's utm as the site's own links (results-data §7).
  else if (sameSite(document.referrer, location.hostname)) q.set("ss", "1");

  // Forward the visitor's own hostname so the edge can correctly treat
  // referrers from the same site as internal nav (returns null in
  // parseReferrerHost selfHost arg).
  q.set("self_host", location.hostname);

  // Forward the normalized page path so the edge can select a per-path
  // element manifest + variant (A1). normalizePath strips query/fragment
  // and lowercases, so no PII (e.g. ?token=) ever reaches the edge — and
  // the edge normalizes identically, so keys never disagree.
  q.set("path", normalizePath(location.pathname));

  // Navigation type from the Performance API (navigate / reload /
  // back_forward). Lets the edge leave reloads out of the dark-social
  // estimate (L2 Layer D). One of three words; no timing values are sent.
  const nav = navigationType();
  if (nav) q.set("nav", nav);

  // The page's own language (not the visitor's browser preference, which
  // goes as `lang`). The edge keeps the original when the versions were
  // written in another language (three-decisions §1, design C).
  const plang = pageLanguage(location, document);
  if (plang) q.set("plang", plang);

  // What this tab already learned about the visitor's reason for coming,
  // for pages that carry no signal of their own (docs/specs/session-carry.md).
  const carry = readCarryStamp();
  if (carry) q.set("carry", `${carry.intent_dim}:${carry.source_dim}`);

  // The tab's random visit marker (docs/specs/visit-marker.md): one holdout
  // arm per visit, visits counted instead of rows. Not a device value.
  if (visit) q.set("visit", visit);

  // No `bc=1` since 2026-10-25 (faster-tag.md C): the boot asks before the
  // core could write the tab's copy, and the edge never read it. The event's
  // `body_carry` is the fact (body carry, condition 5).

  const response = await fetch(url.toString(), {
    credentials: "omit",
    cache: "no-store",
    // The page's own policy could send the full URL as the Referer, with
    // utm_term and click-id values; `ref` and `self_host` carry all the edge
    // needs (privacy review, keyword build review B).
    referrerPolicy: "no-referrer",
    signal,
    headers: { Accept: "application/json" },
  });

  // The edge answered, but not with a version we can read: marked `http`,
  // so the snippet-issues report tells it from a network failure
  // (docs/specs/snippet-issues.md, select_failed n=3).
  const http = () => ({ http: 1 });
  if (!response.ok) throw http();
  return (response.json() as Promise<SelectResponse>).catch(() => {
    throw http();
  });
}

/** "navigate" | "reload" | "back_forward" | "prerender", or null when unavailable. */
function navigationType(): string | null {
  try {
    const entries = performance.getEntriesByType("navigation");
    const first = entries[0] as PerformanceNavigationTiming | undefined;
    const t = first?.type;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

const LANG_SEGMENT = /^[a-z]{2}(?:-[a-z]{2,4})?$/i;

/**
 * The language of the page being viewed, as a lowercase primary subtag
 * ("az", "en"), or null when nothing on the page says. Read in this order,
 * because site builders emit URL structure deterministically while
 * `<html lang>` is missing or wrong on a large share of pages:
 *   1. first path segment that looks like a language tag (/az, /en-us)
 *   2. a two-letter subdomain that is not www (az.example.com)
 *   3. the hreflang self-link for the current path
 *   4. `<html lang>`
 * Exported for tests; takes location and document so jsdom can pass fakes.
 */
export function pageLanguage(
  loc: { pathname: string; hostname: string; href: string },
  doc: Document,
): string | null {
  const primary = (tag: string) => (tag.split("-")[0] ?? "").toLowerCase() || null;

  const seg = loc.pathname.split("/").filter(Boolean)[0] ?? "";
  if (LANG_SEGMENT.test(seg)) return primary(seg);

  const sub = loc.hostname.split(".")[0] ?? "";
  if (loc.hostname.split(".").length >= 3 && /^[a-z]{2}$/i.test(sub) && sub !== "ww")
    return primary(sub);

  try {
    const links = doc.querySelectorAll('link[rel="alternate"][hreflang]');
    for (const l of Array.from(links)) {
      const href = l.getAttribute("href") ?? "";
      const tag = l.getAttribute("hreflang") ?? "";
      if (!href || !tag || tag.toLowerCase() === "x-default") continue;
      let path = "";
      try {
        path = new URL(href, loc.href).pathname;
      } catch {
        continue;
      }
      if (path.replace(/\/$/, "") === loc.pathname.replace(/\/$/, "")) return primary(tag);
    }
  } catch {}

  const htmlLang = doc.documentElement?.getAttribute("lang") ?? "";
  if (htmlLang && LANG_SEGMENT.test(htmlLang)) return primary(htmlLang);
  return null;
}
