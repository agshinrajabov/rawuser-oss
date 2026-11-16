/**
 * Who runs this install: its addresses and its operator, read once at build
 * time (docs/specs/open-source-release.md, 6.2). The source names no host,
 * address or person; whoever builds the dashboard sets them:
 *
 *   NEXT_PUBLIC_EDGE_ORIGIN     where the tag loads from
 *   NEXT_PUBLIC_APP_ORIGIN      this dashboard's own address
 *   NEXT_PUBLIC_OPERATOR_NAME   the person a customer hears from
 *   NEXT_PUBLIC_OPERATOR_EMAIL  where a customer writes to that person
 *   NEXT_PUBLIC_SUPPORT_EMAIL   where a signed-in customer asks for help
 *   NEXT_PUBLIC_PRIVACY_EMAIL   where a privacy request goes
 *
 * With a value unset its sentence still reads whole and no mail link is
 * drawn. The words for the unset case are written here, once per pattern,
 * never in a component.
 *
 * Each name is read by its full literal: the build replaces only those.
 */

function value(raw: string | undefined): string | null {
  const v = raw?.trim();
  return v ? v : null;
}

function origin(raw: string | undefined): string | null {
  return value(raw)?.replace(/\/+$/, "") ?? null;
}

export const EDGE_ORIGIN = origin(process.env.NEXT_PUBLIC_EDGE_ORIGIN);
export const APP_ORIGIN = origin(process.env.NEXT_PUBLIC_APP_ORIGIN);
export const OPERATOR_NAME = value(process.env.NEXT_PUBLIC_OPERATOR_NAME);
export const OPERATOR_EMAIL = value(process.env.NEXT_PUBLIC_OPERATOR_EMAIL);
export const SUPPORT_EMAIL = value(process.env.NEXT_PUBLIC_SUPPORT_EMAIL);
export const PRIVACY_EMAIL = value(process.env.NEXT_PUBLIC_PRIVACY_EMAIL);

// ---------------------------------------------------------------------------
// The edge
// ---------------------------------------------------------------------------

/** The edge without its scheme, as a sentence names it. */
export const EDGE_HOST = EDGE_ORIGIN?.replace(/^https?:\/\//, "") ?? null;

/** Where a tag would be, on a build that was given no edge address. */
export const EDGE_NOT_SET = "The edge address is not configured.";

/** The older tag's script, as a sentence names it. */
export function olderTagScript(): string {
  return EDGE_HOST ? `${EDGE_HOST}/snippet.js` : "snippet.js";
}

// ---------------------------------------------------------------------------
// This dashboard's own address
// ---------------------------------------------------------------------------

/** The address the terms print for the data processing agreement's page. */
export const DPA_URL = APP_ORIGIN ? `${APP_ORIGIN}/audit/dpa/` : null;

// ---------------------------------------------------------------------------
// The operator, in a sentence
// ---------------------------------------------------------------------------

/** Who to ask for an invite link: "Ask {inviter()} for a new one." */
export function inviter(): string {
  return OPERATOR_NAME ?? "whoever invited you";
}

/** Who a customer writes to: "Write to {operatorOrUs()} and we ..." */
export function operatorOrUs(): string {
  return OPERATOR_NAME ?? "us";
}

/**
 * The operator doing something: `named` after the name ("sets up"), `we`
 * after "we" ("set up"). `start` opens a sentence.
 */
export function operatorDoes(named: string, we: string, start = false): string {
  if (OPERATOR_NAME) return `${OPERATOR_NAME} ${named}`;
  return `${start ? "We" : "we"} ${we}`;
}

/** How a message drafted for the operator ends. */
export function signOff(): string {
  return OPERATOR_NAME ? `Thanks,\n${OPERATOR_NAME}` : "Thanks.";
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

/** Where a customer turns for help: "Trouble signing in? {helpLine()}" */
export function helpLine(): string {
  return SUPPORT_EMAIL ? `Write to ${SUPPORT_EMAIL}` : "Ask whoever runs this install";
}

// ---------------------------------------------------------------------------
// Mail links
// ---------------------------------------------------------------------------

/** A mail link to an address, or none when the address is not set. */
export function mailto(address: string | null, subject?: string): string | null {
  if (!address) return null;
  return subject ? `mailto:${address}?subject=${encodeURIComponent(subject)}` : `mailto:${address}`;
}
