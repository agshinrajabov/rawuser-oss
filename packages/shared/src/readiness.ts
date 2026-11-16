/**
 * The readiness check before go live (docs/specs/readiness-check.md): the
 * contract the generation worker answers and the dashboard reads, and the
 * closed words of `conversion_targets.goes` (migration 0044). Types and
 * tables only; the checks themselves are computed in generation
 * (lib/readiness.ts). Nothing here is about a visitor.
 */

/**
 * Where a counted button leads, as one closed word, never an href
 * (the privacy review's ruling, "goes stores where the customer's own
 * button leads as one closed word"):
 * - form: a submit button inside a form;
 * - contact_link: tel:, mailto:, wa.me, t.me, whatsapp;
 * - same_site: another page of the customer's site whose kind is not start;
 * - start_page: a page of the site the site map calls `start` (a signup or
 *   trial page: an action, so no warning);
 * - leaves_site: another host;
 * - anchor: a same-page `#` link;
 * - none: no link, or a javascript: one.
 * The spec's list has six words; `start_page` is the seventh, so the read
 * can tell a link to a `start` page from any other same-site link without
 * keeping the target path.
 */
export const GOES_WORDS = [
  "form",
  "contact_link",
  "same_site",
  "start_page",
  "leaves_site",
  "anchor",
  "none",
] as const;
export type Goes = (typeof GOES_WORDS)[number];

export function isGoes(v: unknown): v is Goes {
  return typeof v === "string" && (GOES_WORDS as readonly string[]).includes(v);
}

/** The checks, in the order the answer lists them (spec, "The API"). */
export const READINESS_CHECK_IDS = [
  "tag",
  "counted",
  "contact_hint",
  "category",
  "traffic",
  "language",
  "terms",
  "buttons",
  "versions",
] as const;
export type ReadinessCheckId = (typeof READINESS_CHECK_IDS)[number];

export type ReadinessState = "green" | "amber" | "red" | "grey";

/** One line of the list: a dot, a sentence, at most one action. */
export interface ReadinessCheck {
  id: ReadinessCheckId;
  state: ReadinessState;
  line: string;
  action: { label: string; href: string } | null;
  /** When the product can know it: now, or from day 3 after go live. */
  known: "now" | "after_day_3";
  /** True only on the one line that closes Go live (check 3, a yes not marked). */
  blocks: boolean;
  /** A customer session never receives such a line. */
  superadmin_only: boolean;
}

/** GET /admin/onboard/readiness?customer_id= */
export interface ReadinessAnswer {
  ok: true;
  customer_id: string;
  blocks_go_live: boolean;
  checks: ReadinessCheck[];
  /** The operator's answer: null unanswered. */
  special_category: boolean | null;
  /**
   * The tag is withheld (privacy review condition 2): no `live_at` yet and the
   * answer is null, or yes with `sensitive = 0`. The dashboard shows no tag
   * on any door while true; the endpoints that hand out the tag or a
   * capture link answer 409 for the same state.
   */
  tag_withheld: boolean;
}

/** The machine word of the 409 on a withheld tag. */
export const TAG_WITHHELD_CODE = "tag_withheld";

/** The machine word of the 409 that closes go live (check 3). */
export const SPECIAL_CATEGORY_CODE = "special_category";
