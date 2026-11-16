/**
 * The free AI-traffic audit's numbers (docs/specs/ai-traffic-audit.md §3.5,
 * §5.5, §9; the founder's decisions of 2026-10-06, §15).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** At most this many audits open at once (§9). */
export const AUDIT_MAX_OPEN = 10;
/** Page and language pairs written per audit (§9): at most 90 versions. */
export const AUDIT_MAX_PAGES = 3;
/** "Rewrite everything" or "Regenerate all", once per audit (§9). */
export const AUDIT_MAX_REWRITES = 1;
/** Model spend per audit, US dollars (§9). */
export const AUDIT_MAX_SPEND = 1.0;
/** Visits for the full report; under it at day 7 the window grows to day 14 once (§3.5). */
export const AUDIT_MIN_VISITS = 300;
/** Under this, "too few to say anything" (§5.5; the Results MIN_SAMPLE). */
export const AUDIT_MIN_SAMPLE = 30;
/** Visit rows that close the window early (§3.5). */
export const AUDIT_MAX_ROWS = 100_000;
/** The first counting window, then the one extension. */
export const AUDIT_WINDOW_MS = 7 * DAY_MS;
export const AUDIT_EXTENDED_MS = 14 * DAY_MS;
/** The end date never later than this after audit_from (§3.5). */
export const AUDIT_CEILING_MS = 28 * DAY_MS;
/** The end date: this long after the release (§3.5). */
export const AUDIT_END_AFTER_RELEASE_MS = 7 * DAY_MS;
/** No go live within this of sign-up: the audit lapses (§3.5). */
export const AUDIT_LAPSE_MS = 14 * DAY_MS;
/**
 * Live this long without every first-go-live version written (a spend cap,
 * a stubborn row): the window starts anyway, so an audit never waits
 * forever. A decision of the build, written in spec §17.5.
 */
export const AUDIT_START_ANYWAY_MS = 2 * DAY_MS;
/** Data deleted this long after the report, with no pilot (§3.8, AUDIT_KEEP_DAYS). */
export const AUDIT_KEEP_MS = 60 * DAY_MS;
/** A share link lives this long after the release (§6). */
export const AUDIT_LINK_MS = 90 * DAY_MS;
/** Names and landing pages need this many visits in their group (§4.3, §5.1). */
export const AUDIT_FLOOR = 5;
/** Landing pages listed per group (§5.1). */
export const AUDIT_PAGES_PER_GROUP = 5;

/** The refusal sentences, as the mock words them. */
export const AUDIT_LINES = {
  pages_full: "Three pages in the audit. A pilot has more.",
  spend: "The audit's writing budget is used up.",
  rewrite_used: "Rewrite everything is used for this audit.",
  ended: "The audit ended. Your page shows as you built it.",
  audits_full: "Ten audits are open. One must end first.",
  // Named when the install says who runs it (OPERATOR_NAME).
  audits_full_signup: (operator: string | null) =>
    operator
      ? `Audits are full this week. Reply to ${operator} and he will write when one opens.`
      : "Audits are full this week. We will write when one opens.",
  invites_off: "Audit links are off until the sign-in protection is deployed.",
  domain_taken: (domain: string) =>
    `${domain} already has an audit or an account. Sign in instead.`,
  terms: "Tick the audit terms to send.",
  pilot_terms: "Needs signed pilot terms.",
} as const;

export const DAY = DAY_MS;
