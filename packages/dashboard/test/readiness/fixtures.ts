/**
 * The readiness answers the mock draws (design/mock/sales-readiness/
 * readiness-check.html): the pilot before go live as A4 and A18 read it, and
 * a site with everything green (A2). Every sentence is the spec's own
 * (docs/specs/readiness-check.md, "The checks"); the dashboard renders
 * them as written and never rebuilds one. In the API's order.
 */
import type {
  ReadinessAction,
  ReadinessCheck,
  ReadinessResponse,
  ReadinessState,
} from "../../src/lib/readiness";

export function check(
  id: string,
  state: ReadinessState,
  line: string,
  action: ReadinessAction | null = null,
  over: Partial<ReadinessCheck> = {},
): ReadinessCheck {
  return { id, state, line, action, known: "now", blocks: false, superadmin_only: false, ...over };
}

export function ANSWER(
  checks: ReadinessCheck[],
  over: Partial<ReadinessResponse> = {},
): ReadinessResponse {
  return {
    ok: true,
    blocks_go_live: checks.some((c) => c.blocks),
    special_category: false,
    tag_withheld: false,
    checks,
    ...over,
  };
}

export const MOVE_IT: ReadinessAction = { label: "Move it first in the head", href: "/start" };
export const COUNT_INSTEAD: ReadinessAction = {
  label: "Count the contact, signup or purchase button instead",
  href: "/conversions",
};
export const COUNT_EVERY: ReadinessAction = {
  label: "Count it on every page",
  href: "/conversions",
};
export const PARTS: ReadinessAction = { label: "Parts of the page", href: "/start" };
export const ASK_US: ReadinessAction = {
  label: "Ask us to start a direction test",
  href: "mailto:help@example.com?subject=Direction%20test",
};
export const START_20: ReadinessAction = {
  label: "Start at 20% as a direction",
  href: "/analytics",
};
export const RECORD_TERMS: ReadinessAction = { label: "Record the terms", href: "/customers" };
export const MARK_IT: ReadinessAction = { label: "Mark it", href: "/analytics" };
export const CHANGE: ReadinessAction = { label: "Change", href: "/start" };
export const PICK_IT: ReadinessAction = { label: "Pick it on your page", href: "/conversions" };

export const TAG_BODY =
  "The tag is in the body. About one load in four paints before it and stays as built.";
export const TAG_LATE =
  "The tag runs after other scripts. Some visitors see the original for a moment.";
export const TAG_NONE = "We do not see the tag yet.";
export const TAG_FIRST = "The tag is first in the head. Versions show before the page paints.";
export const TAG_DAY3 = "On about 1 in 4 visits your page painted before the tag.";
export const COUNTED_SAME_SITE =
  "The counted button opens another page of your site, so a visit can count without an action.";
export const CONTACT_HINT = "Your page has a phone or email link that is not counted.";
export const COUNTED_FORM = "Counted: the contact form, on the homepage.";
export const NO_BUTTON = "No button is counted yet.";
export const LANGUAGE_EN =
  "Your site also has English on the same address. Versions are written for Azerbaijani only.";
export const CATEGORY_NO = "Not a special-category site.";
export const CATEGORY_MARKED =
  "Set up as a special-category site: product pages are counted as a group and versions make no claims.";
export const CATEGORY_YES =
  "Your site is in a special category. We finish its setup by hand before go live.";
export const TRAFFIC_GREY = "Not known yet. We see your traffic from day 3 after go live.";
export const TRAFFIC_DAY3_OK = "About 60 visits a day with a test. A result in about 5 weeks.";
export const TRAFFIC_DAY3_DIRECTION =
  "About 70 visits a day. At this traffic the test shows a direction, not a proof.";
export const TERMS_NONE = "No pilot terms on record.";
export const TERMS_OK = "Terms on record.";
export const BUTTONS_GREY =
  "Your buttons keep their words. Turn rewriting on if you want them written.";
export const VERSIONS_REFUSED = "2 of 20 versions refused, tried again within six hours.";
export const VERSIONS_ONE = "1 version written. The other 19 are written after you go live.";
export const LANGUAGE_OK = "Written in Azerbaijani, your page's language.";

/** A18: the pilot on day 3, the superadmin's full list, in the API's order. */
export const MEDORA: ReadinessCheck[] = [
  check("tag", "red", TAG_DAY3, MOVE_IT, { known: "after_day_3" }),
  check("counted", "amber", COUNTED_SAME_SITE, COUNT_INSTEAD),
  check("contact_hint", "amber", CONTACT_HINT, COUNT_EVERY),
  check("category", "green", CATEGORY_MARKED),
  check("traffic", "amber", TRAFFIC_DAY3_DIRECTION, START_20, { known: "after_day_3" }),
  check("language", "amber", LANGUAGE_EN),
  check("terms", "red", TERMS_NONE, RECORD_TERMS, { superadmin_only: true }),
  check("buttons", "grey", BUTTONS_GREY, PARTS),
  check("versions", "grey", VERSIONS_REFUSED, null, { known: "after_day_3" }),
];

/** A4: the pilot before go live, as it would have read on 11 Oct (the customer's view). */
export const MEDORA_LOOK: ReadinessCheck[] = [
  check("tag", "red", TAG_BODY, MOVE_IT),
  check("counted", "amber", COUNTED_SAME_SITE, COUNT_INSTEAD),
  check("contact_hint", "amber", CONTACT_HINT, COUNT_EVERY),
  check("category", "green", CATEGORY_MARKED),
  check("traffic", "grey", TRAFFIC_GREY),
  check("language", "amber", LANGUAGE_EN),
  check("buttons", "grey", BUTTONS_GREY, PARTS),
];

/** A2: everything green. */
export const READY: ReadinessCheck[] = [
  check("tag", "green", TAG_FIRST),
  check("counted", "green", COUNTED_FORM),
  check("category", "green", CATEGORY_NO, CHANGE),
  check("language", "green", LANGUAGE_OK),
  check("versions", "green", VERSIONS_ONE),
];

/** A13, A20: a Yes given and not yet marked. */
export const YES_UNMARKED: ReadinessCheck[] = [
  check("category", "red", CATEGORY_YES, null, { blocks: true }),
  check("terms", "green", TERMS_OK, null, { superadmin_only: true }),
];
