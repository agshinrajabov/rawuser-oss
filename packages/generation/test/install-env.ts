/**
 * The install configuration the tests run with (src/install-config.ts):
 * reserved hosts and addresses that belong to nobody. A test that needs an
 * install with nothing set leaves it out of its env.
 */

export const EDGE = "https://edge.example.com";
/** An older origin a tag may still load from. */
export const EDGE_OLD = "https://edge-old.example.com";
/** Every origin a tag of this install may load from, the current one first. */
export const EDGE_ORIGINS = [EDGE, EDGE_OLD] as const;
/** The fetcher's user agent under this configuration. */
export const FETCHER_UA = "Rawuser/1.0 (+https://example.com/bot)";

export const INSTALL_ENV = {
  EDGE_ORIGIN: EDGE,
  EDGE_ORIGIN_ALIASES: EDGE_OLD,
  API_ORIGIN: "https://api.example.com",
  OWN_HOSTS: "edge.example.com,edge-old.example.com,api.example.com,api-old.example.com",
  BOT_INFO_URL: "https://example.com/bot",
  SENDER_ADDRESS: "pilots@example.com",
  REPLY_TO_ADDRESS: "hello@example.com",
  PRIVACY_ADDRESS: "privacy@example.com",
  SUPPORT_ADDRESS: "hello@example.com",
  OPERATOR_NAME: "Sam",
  REMEMBER_DEFAULT: "on",
  REMEMBER_ON_SENSITIVE: "on",
} as const;
