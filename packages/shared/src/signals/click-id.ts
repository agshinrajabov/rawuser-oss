/**
 * Tracked-link parameter names (L2 source recovery, Layer C).
 *
 * Ad, social, email and affiliate platforms append a parameter to outbound
 * links: gclid (Google Ads), fbclid (Facebook/Instagram), oppref (an ad
 * clicked inside ChatGPT), mc_eid (a Mailchimp recipient), irclickid (an
 * Impact affiliate click). When the referrer is stripped, the NAME of the
 * parameter still says which kind of platform built the link.
 *
 * We read presence only. The value is the platform's per-click token, and
 * for the email tools it is a per-recipient identifier; it is never parsed,
 * stored, forwarded or logged. The snippet forwards the names it saw as
 * `clk=fbclid,gclid`; this module also accepts most raw parameter names on
 * the request URL so curl tests behave the same. `ref` and `via` are
 * accepted only through `clk`, because the snippet already uses `ref` on
 * the /select URL for the referrer.
 */

// GDPR: not personal data. The parameter NAME identifies the platform, not
// the visitor; the value is never processed.
import type { ClickIdPlatform, LinkFamily } from "../types.ts";

interface ClickIdEntry {
  name: string;
  platform: ClickIdPlatform;
  family: LinkFamily;
  /** Accept the raw name on the request URL (not only via clk). */
  raw: boolean;
}

/**
 * Parameter name → platform and family. Order is the tie-break when several
 * are present: an AI ad first, then paid search, paid social, social share,
 * email, affiliate. Provenance for every row:
 * docs/research/generic-source-recovery-2026.md §B.
 */
const CLICK_ID_PARAMS: readonly ClickIdEntry[] = [
  // AI ads: OpenAI's click id on ads shown inside ChatGPT.
  { name: "oppref", platform: "chatgpt-ads", family: "ai-ads", raw: true },
  // Paid search.
  { name: "gclid", platform: "google-ads", family: "paid-search", raw: true },
  // Search Ads 360 says which system made the click id (Layer G, 2026-10-03).
  { name: "gclsrc", platform: "google-ads", family: "paid-search", raw: true },
  { name: "gbraid", platform: "google-ads", family: "paid-search", raw: true },
  { name: "wbraid", platform: "google-ads", family: "paid-search", raw: true },
  { name: "dclid", platform: "google-ads", family: "paid-search", raw: true },
  { name: "gad_source", platform: "google-ads", family: "paid-search", raw: true },
  { name: "gad_campaignid", platform: "google-ads", family: "paid-search", raw: true },
  // Not srsltid: Google Merchant Center puts it on organic shopping
  // results (support.google.com/analytics/answer/11479699), so it says
  // nothing paid; the referrer decides (removed 2026-10-25).
  { name: "msclkid", platform: "microsoft-ads", family: "paid-search", raw: true },
  { name: "yclid", platform: "yandex-ads", family: "paid-search", raw: true },
  { name: "s_kwcid", platform: "adobe-ads", family: "paid-search", raw: true },
  { name: "ef_id", platform: "adobe-ads", family: "paid-search", raw: true },
  // Paid social: these ids exist only on ad clicks.
  { name: "ttclid", platform: "tiktok", family: "paid-social", raw: true },
  { name: "li_fat_id", platform: "linkedin", family: "paid-social", raw: true },
  { name: "sccid", platform: "snapchat", family: "paid-social", raw: true },
  { name: "twclid", platform: "twitter", family: "paid-social", raw: true },
  { name: "rdt_cid", platform: "reddit", family: "paid-social", raw: true },
  { name: "epik", platform: "pinterest", family: "paid-social", raw: true },
  // Quora's ad click id (Layer G; posthog-js, Segment's Quora destination).
  { name: "qclid", platform: "quora", family: "paid-social", raw: true },
  // Social share: present on organic clicks too.
  { name: "fbclid", platform: "facebook", family: "social-share", raw: true },
  { name: "igshid", platform: "instagram", family: "social-share", raw: true },
  { name: "igsh", platform: "instagram", family: "social-share", raw: true },
  // Email. The per-recipient ones (mc_eid, _hsenc, ck_subscriber_id,
  // ml_subscriber, mkt_tok) identify a person by VALUE; we read the name.
  // Downstream (events, dashboard) only the family label "email" may ever be
  // shown per visit, never the parameter name or platform (privacy review
  // note, ADR 0029): a customer must not be able to read it as a recipient.
  { name: "mc_cid", platform: "mailchimp", family: "email", raw: true },
  { name: "mc_eid", platform: "mailchimp", family: "email", raw: true },
  { name: "_hsenc", platform: "hubspot", family: "email", raw: true },
  { name: "_hsmi", platform: "hubspot", family: "email", raw: true },
  { name: "mkt_tok", platform: "marketo", family: "email", raw: true },
  { name: "vero_conv", platform: "vero", family: "email", raw: true },
  { name: "vero_id", platform: "vero", family: "email", raw: true },
  { name: "ck_subscriber_id", platform: "convertkit", family: "email", raw: true },
  { name: "ml_subscriber", platform: "mailerlite", family: "email", raw: true },
  { name: "ml_subscriber_hash", platform: "mailerlite", family: "email", raw: true },
  // Klaviyo appends _kx to links in live emails; its value names the
  // recipient, so the name only, as with mc_eid (Layer G).
  { name: "_kx", platform: "klaviyo", family: "email", raw: true },
  // Affiliate and referral programmes.
  { name: "irclickid", platform: "impact", family: "affiliate", raw: true },
  // The spelling posthog-js captures for Impact (Layer G).
  { name: "irclid", platform: "impact", family: "affiliate", raw: true },
  { name: "sscid", platform: "shareasale", family: "affiliate", raw: true },
  { name: "awc", platform: "awin", family: "affiliate", raw: true },
  { name: "cjevent", platform: "cj", family: "affiliate", raw: true },
  { name: "aff_id", platform: "affiliate-generic", family: "affiliate", raw: true },
  { name: "wickedid", platform: "wicked-reports", family: "affiliate", raw: true },
  // Generic referral markers (Product Hunt, newsletters, directories). Only
  // via clk: the snippet uses ?ref= on the /select URL for the referrer.
  { name: "ref", platform: "referral-generic", family: "affiliate", raw: false },
  { name: "via", platform: "referral-generic", family: "affiliate", raw: false },
];

const BY_NAME: ReadonlyMap<string, ClickIdEntry> = new Map(CLICK_ID_PARAMS.map((p) => [p.name, p]));

/** Every name the snippet may forward. Exported so the snippet's copy can be tested for parity. */
export const CLICK_ID_PARAM_NAMES: readonly string[] = CLICK_ID_PARAMS.map((p) => p.name);

export interface ClickIdResult {
  platform: ClickIdPlatform;
  family: LinkFamily;
}

/**
 * Returns the platform and family whose parameter is present, or null.
 *
 * Reads `clk` (comma-separated names forwarded by the snippet) and the raw
 * parameter names on the URL. Values are never read.
 */
export function parseClickId(url: URL): ClickIdResult | null {
  const present = new Set<string>();

  const clk = url.searchParams.get("clk");
  if (clk) {
    for (const rawName of clk.split(",")) {
      const name = rawName.trim().toLowerCase();
      if (BY_NAME.has(name)) present.add(name);
    }
  }
  for (const key of url.searchParams.keys()) {
    const name = key.toLowerCase();
    const entry = BY_NAME.get(name);
    if (entry?.raw) present.add(name);
  }

  if (present.size === 0) return null;
  for (const entry of CLICK_ID_PARAMS) {
    if (present.has(entry.name)) return { platform: entry.platform, family: entry.family };
  }
  return null;
}

/** Paid platforms: a click id from these means the visitor clicked an ad. */
export function isPaidClickId(family: LinkFamily | null | undefined): boolean {
  return family === "paid-search" || family === "paid-social" || family === "ai-ads";
}

/** Social platforms: the link was built by a social network (organic or paid). */
export function isSocialClickId(family: LinkFamily | null | undefined): boolean {
  return family === "paid-social" || family === "social-share";
}
