/**
 * The visitor's country on event rows (ADR 0036, 2026-11-02;
 * docs/specs/visitors-page.md).
 *
 * `events.country` holds a code from the closed list below, the 249
 * officially assigned ISO 3166-1 alpha-2 codes, or `other` for anything else
 * Cloudflare's `cf.country` may give (`XX` for unknown, `T1` for Tor, the
 * user-assigned `XK`, an empty or missing value). Never a region, city,
 * postal code or coordinates, and nothing else derived from the IP.
 *
 * Read only at `/event`, after the answer, from the request Cloudflare
 * already enriched: nothing is read from the visitor's device and nothing
 * goes back to the browser. Never used to choose a version, never joined
 * across customers, never in an export, an alert or a model prompt.
 */

/** ISO 3166-1 alpha-2, officially assigned codes (249). */
// biome-ignore format: one row per first letter
export const ISO_COUNTRIES: readonly string[] = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS",
  "BT", "BV", "BW", "BY", "BZ",
  "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW",
  "CX", "CY", "CZ",
  "DE", "DJ", "DK", "DM", "DO", "DZ",
  "EC", "EE", "EG", "EH", "ER", "ES", "ET",
  "FI", "FJ", "FK", "FM", "FO", "FR",
  "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT",
  "GU", "GW", "GY",
  "HK", "HM", "HN", "HR", "HT", "HU",
  "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT",
  "JE", "JM", "JO", "JP",
  "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ",
  "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY",
  "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS",
  "MT", "MU", "MV", "MW", "MX", "MY", "MZ",
  "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ",
  "OM",
  "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY",
  "QA",
  "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS",
  "ST", "SV", "SX", "SY", "SZ",
  "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ",
  "UA", "UG", "UM", "US", "UY", "UZ",
  "VA", "VC", "VE", "VG", "VI", "VN", "VU",
  "WF", "WS",
  "YE", "YT",
  "ZA", "ZM", "ZW",
];

/** What a value off the list is stored as. */
export const OTHER_COUNTRY = "other";

const COUNTRIES: ReadonlySet<string> = new Set(ISO_COUNTRIES);

/** True for a code on the list (upper case, exactly two letters). */
export function isIsoCountry(v: unknown): v is string {
  return typeof v === "string" && COUNTRIES.has(v);
}

/**
 * The value `events.country` stores for a `cf.country`: the code when it is
 * on the list (Cloudflare sends upper case; lower case is read as the same
 * code), else `other`. Never anything else.
 */
export function countryOf(raw: unknown): string {
  if (typeof raw !== "string") return OTHER_COUNTRY;
  const code = raw.trim().toUpperCase();
  return COUNTRIES.has(code) ? code : OTHER_COUNTRY;
}

/** A stored value the reads accept: a listed code or `other`; anything else is not counted as a country. */
export function isStoredCountry(v: unknown): v is string {
  return v === OTHER_COUNTRY || isIsoCountry(v);
}
