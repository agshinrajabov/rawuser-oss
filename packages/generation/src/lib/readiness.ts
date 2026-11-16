/**
 * The readiness check before go live (docs/specs/readiness-check.md): seven
 * checks over what the product already holds, each a dot, one sentence and
 * at most one action. Pure: the facts are loaded in admin/readiness.ts and
 * handed in; nothing here reads or writes. The sentences are the spec's and
 * the approved mock's (design/mock/sales-readiness/readiness-check.html,
 * section 08 for the lines that are the mock's own).
 *
 * Only one line closes Go live: a special-category yes that no superadmin
 * has marked (check 3). Every other red or amber line warns.
 *
 * Nothing here is about a visitor. The health guess arrives as a yes or no
 * (`healthHit`); no word of the page is in any line (privacy review condition 3).
 */

import {
  type Goes,
  MAX_READ_WEEKS,
  type ReadinessCheck,
  type ReadinessCheckId,
  type ReadinessState,
  countTargetPage,
  isSiteWideTarget,
} from "@rawuser/shared";
import type { ConversionLabel } from "./measure-proposal.ts";
import type { TagFlag, TagPosition } from "./tag-position.ts";

/** Day 3 after go live: the measured lines replace the probe's and the estimate's. */
export const DAY_THREE_MS = 3 * 24 * 60 * 60 * 1000;

/** The tag line turns red from this share of visits that painted before the tag. */
const LATE_SHARE_RED = 0.1;

/** The flags of our own tag that delay it (check 1, amber). */
const DELAYING_FLAGS: readonly string[] = [
  "async",
  "defer",
  "rocket_loader",
  "gtm",
  "blocking_script_before",
];

/** The dashboard routes the actions open; the dashboard may route them its own way. */
export const READINESS_HREFS = {
  connect: "/start",
  look: "/start",
  conversions: "/conversions",
  results: "/analytics",
  customers: "/customers",
} as const;

/** The "ask us" action's mail link, to the install's support address. */
export function askHref(supportAddress: string): string {
  return `mailto:${supportAddress}?subject=Direction%20test`;
}

export interface CountedRow {
  section_path: string;
  conversion_label: string;
  goes: Goes | null;
}

export interface ReadinessFacts {
  now: number;
  superadmin: boolean;
  /** Where "ask us" points (SUPPORT_ADDRESS); null, no such action is offered. */
  supportAddress: string | null;
  plan: string | null;
  liveAt: number | null;
  /** customers.sensitive = 1. */
  sensitive: boolean;
  /** customers.special_category: null unanswered. */
  specialCategory: boolean | null;
  pilotTermsAt: number | null;
  /** snippet_status, or null before the first probe. */
  tag: { position: TagPosition | null; flags: readonly string[]; form: string | null } | null;
  /** From day 3: visits and, of them, visits whose first page painted before the tag. */
  late: { visits: number; lp_visits: number } | null;
  /** Enabled conversion targets. */
  counted: readonly CountedRow[];
  /** The quickstart's read found a phone, email, WhatsApp or Telegram link; null when not read. */
  contactLinkOnPage: boolean | null;
  /** The health words table hit three distinct words in the page text in hand. */
  healthHit: boolean;
  /** Before day 3: closed days of rows and the 20% estimate from them (goLiveBaseline). */
  baseline: { baseline_days: number; estimate_weeks: number | null };
  /** Before day 3, for a customer that came through an audit: the 20% estimate from its report. */
  auditWeeks: number | null;
  /** From day 3: the lift report's start.estimate (armed visits a day, weeks). */
  dayThree: { per_day: number; weeks: number | null } | null;
  testRunning: boolean;
  /** The primary page's language (a subtag), null when unknown. */
  primaryLanguage: string | null;
  /** Languages the site also has on the same address (subtags). */
  sameAddress: readonly string[];
  /** A manifest holds a button slot (before go live: the buttons line). */
  buttonSlots: boolean;
  /** Before go live: the preview is written, and how many versions one page gets. */
  preview: { written: boolean; total: number };
  /** After go live: versions by status. */
  versions: { total: number; refused: number };
}

const NAMES: Readonly<Record<string, string>> = {
  en: "English",
  az: "Azerbaijani",
  ru: "Russian",
  tr: "Turkish",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  pl: "Polish",
  uk: "Ukrainian",
  ar: "Arabic",
  fa: "Persian",
  he: "Hebrew",
  hi: "Hindi",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  ka: "Georgian",
  kk: "Kazakh",
  uz: "Uzbek",
};

/** "English", or the subtag itself when the table has no name for it. */
export function languageName(lang: string): string {
  const key = lang.toLowerCase().split(/[-_]/)[0] ?? lang;
  return NAMES[key] ?? lang;
}

/** "English", "English and Russian", "English, Russian and Turkish". */
function names(langs: readonly string[]): string {
  const n = langs.map(languageName);
  if (n.length <= 1) return n[0] ?? "";
  return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

function check(
  id: ReadinessCheckId,
  state: ReadinessState,
  line: string,
  action: ReadinessCheck["action"] = null,
  extra: Partial<Pick<ReadinessCheck, "known" | "blocks" | "superadmin_only">> = {},
): ReadinessCheck {
  return {
    id,
    state,
    line,
    action,
    known: extra.known ?? "now",
    blocks: extra.blocks ?? false,
    superadmin_only: extra.superadmin_only ?? false,
  };
}

/** True from the third day after go live. */
export function afterDayThree(liveAt: number | null, now: number): boolean {
  return liveAt !== null && now - liveAt >= DAY_THREE_MS;
}

// ---------------------------------------------------------------------------
// 1. Where the tag is
// ---------------------------------------------------------------------------

const MOVE_IT = { label: "Move it first in the head", href: READINESS_HREFS.connect };

export function tagCheck(f: ReadinessFacts): ReadinessCheck {
  if (afterDayThree(f.liveAt, f.now) && f.late && f.late.visits > 0 && f.late.lp_visits > 0) {
    const share = f.late.lp_visits / f.late.visits;
    const n = Math.max(2, Math.round(1 / share));
    return check(
      "tag",
      share >= LATE_SHARE_RED ? "red" : "amber",
      `On about 1 in ${n} visits your page painted before the tag.`,
      MOVE_IT,
      { known: "after_day_3" },
    );
  }
  const position = f.tag?.position ?? "not_found";
  if (position === "not_found") return check("tag", "red", "We do not see the tag yet.", MOVE_IT);
  if (position === "body_top" || position === "body_late" || f.tag?.form === "generic") {
    return check(
      "tag",
      "red",
      "The tag is in the body. About one load in four paints before it and stays as built.",
      MOVE_IT,
    );
  }
  // head_late counts only with the blocking script that makes it late: a row
  // probed before 2026-10-25 could be head_late for an inline script alone
  // (Framer), which runs at once and holds nothing up.
  const delayed = (f.tag?.flags ?? []).some((x) => DELAYING_FLAGS.includes(x));
  if (delayed) {
    return check(
      "tag",
      "amber",
      "The tag runs after other scripts. Some visitors see the original for a moment.",
      MOVE_IT,
    );
  }
  return check(
    "tag",
    "green",
    "The tag is first in the head. Versions show before the page paints.",
  );
}

// ---------------------------------------------------------------------------
// 2. What is counted
// ---------------------------------------------------------------------------

const PICK_IT = { label: "Pick it on your page", href: READINESS_HREFS.conversions };
const COUNT_INSTEAD = {
  label: "Count the contact, signup or purchase button instead",
  href: READINESS_HREFS.conversions,
};
const COUNT_EVERY_PAGE = { label: "Count it on every page", href: READINESS_HREFS.conversions };

/** The readable noun for a counted button (the mock, section 08: "the build maps the word"). */
export function countedNoun(label: string, goes: Goes | null): string {
  switch (label as ConversionLabel) {
    case "contact":
      return goes === "form"
        ? "the contact form"
        : goes === "contact_link"
          ? "the contact link"
          : "the contact button";
    case "signup":
      return "the signup button";
    case "trial_start":
      return "the free-trial button";
    case "demo_request":
      return "the demo button";
    case "waitlist":
      return "the waitlist button";
    case "purchase":
      return "the purchase button";
    case "download":
      return "the download button";
    default:
      return "the button";
  }
}

/** "the contact button" twice is "2 contact buttons"; a noun without "the" keeps its count. */
export function countedNouns(noun: string, n: number): string {
  const m = /^the (.+)$/.exec(noun);
  if (!m?.[1]) return `${noun} (${n})`;
  const rest = m[1];
  return `${n} ${/(s|x|ch|sh)$/.test(rest) ? `${rest}es` : `${rest}s`}`;
}

/** "the homepage", "/pricing", "every page". */
export function countedWhere(sectionPath: string): string {
  const page = countTargetPage(sectionPath);
  if (page !== null) return page === "/" ? "the homepage" : page;
  if (isSiteWideTarget(sectionPath)) return "every page";
  return "the homepage";
}

export function countedChecks(f: ReadinessFacts): ReadinessCheck[] {
  const out: ReadinessCheck[] = [];
  if (f.counted.length === 0) {
    out.push(check("counted", "red", "No button is counted yet.", PICK_IT));
  } else if (f.counted.every((r) => r.conversion_label === "other" && r.goes === "same_site")) {
    out.push(
      check(
        "counted",
        "amber",
        "The counted button opens another page of your site, so a visit can count without an action.",
        COUNT_INSTEAD,
      ),
    );
  } else {
    // Two rows that read the same (the contact button and the phone link,
    // both "contact" on every page) are said once, with their number.
    const groups = new Map<string, { noun: string; where: string; n: number }>();
    for (const r of f.counted) {
      const noun = countedNoun(r.conversion_label, r.goes);
      const where = countedWhere(r.section_path);
      const key = `${noun}|${where}`;
      const g = groups.get(key);
      if (g) g.n += 1;
      else groups.set(key, { noun, where, n: 1 });
    }
    const items = [...groups.values()].map(
      (g) => `${g.n > 1 ? countedNouns(g.noun, g.n) : g.noun} on ${g.where}`,
    );
    const [only] = groups.values();
    const line =
      groups.size === 1 && only && only.n === 1
        ? `Counted: ${only.noun}, on ${only.where}.`
        : `Counted: ${items.join(", ")}.`;
    out.push(check("counted", "green", line));
  }
  // The hint: the page shows a contact link and no counted row is a contact.
  // A `site:` row with the label satisfies it, like any other row.
  if (f.contactLinkOnPage === true && !f.counted.some((r) => r.conversion_label === "contact")) {
    out.push(
      check(
        "contact_hint",
        "amber",
        "Your page has a phone or email link that is not counted.",
        COUNT_EVERY_PAGE,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. A special category (D4)
// ---------------------------------------------------------------------------

/** The one sentence that closes Go live; the 409's `error`. */
export const SPECIAL_CATEGORY_BLOCK_LINE =
  "Your site is in a special category. We finish its setup by hand before go live.";

export function categoryCheck(
  f: Pick<ReadinessFacts, "sensitive" | "specialCategory" | "healthHit" | "superadmin">,
): ReadinessCheck {
  // The mark is the stronger fact: a marked site is set up whatever the
  // answer says, and a customer created as sensitive never answered.
  if (f.sensitive) {
    return check(
      "category",
      "green",
      "Set up as a special-category site: product pages are counted as a group and versions make no claims.",
    );
  }
  if (f.specialCategory === true) {
    return check(
      "category",
      "red",
      SPECIAL_CATEGORY_BLOCK_LINE,
      f.superadmin ? { label: "Mark it", href: READINESS_HREFS.results } : null,
      { blocks: true },
    );
  }
  if (f.specialCategory === false) {
    return check("category", "green", "Not a special-category site.", {
      label: "Change",
      href: READINESS_HREFS.look,
    });
  }
  return check(
    "category",
    "amber",
    f.healthHit
      ? "Your page reads like a health site. Tell us if it is."
      : "Tell us whether your site is about health, religion, sexuality, politics or union membership.",
    { label: "Answer", href: READINESS_HREFS.connect },
  );
}

// ---------------------------------------------------------------------------
// 4. Enough traffic for a test
// ---------------------------------------------------------------------------

const NOT_KNOWN_YET = "Not known yet. We see your traffic from day 3 after go live.";

export function trafficCheck(f: ReadinessFacts): ReadinessCheck {
  if (afterDayThree(f.liveAt, f.now) && f.dayThree) {
    const { per_day, weeks } = f.dayThree;
    const known = { known: "after_day_3" as const };
    // No estimate (no click yet in the baseline) but visits are known: at this
    // traffic the test can only give a direction, so say what is known.
    if (weeks === null && per_day <= 0) return check("traffic", "grey", NOT_KNOWN_YET, null, known);
    if (weeks !== null && weeks <= MAX_READ_WEEKS) {
      return check(
        "traffic",
        "green",
        `About ${per_day} visits a day with a test. A result in about ${weeks} weeks.`,
        null,
        known,
      );
    }
    const action = f.testRunning
      ? null
      : f.superadmin
        ? { label: "Start at 20% as a direction", href: READINESS_HREFS.results }
        : f.supportAddress
          ? { label: "Ask us to start a direction test", href: askHref(f.supportAddress) }
          : null;
    return check(
      "traffic",
      "amber",
      `About ${per_day} visits a day. At this traffic the test shows a direction, not a proof.`,
      action,
      known,
    );
  }
  const weeks = f.baseline.estimate_weeks ?? f.auditWeeks;
  if (weeks === null) return check("traffic", "grey", NOT_KNOWN_YET);
  if (weeks <= MAX_READ_WEEKS) {
    return check("traffic", "green", `A 20% test would read in about ${weeks} weeks.`);
  }
  return check("traffic", "amber", "At this traffic a test shows a direction, not a proof.");
}

// ---------------------------------------------------------------------------
// 5. Languages
// ---------------------------------------------------------------------------

export function languageCheck(f: ReadinessFacts): ReadinessCheck | null {
  if (f.sameAddress.length > 0) {
    const own = f.primaryLanguage ? languageName(f.primaryLanguage) : "your page's language";
    return check(
      "language",
      "amber",
      `Your site also has ${names(f.sameAddress)} on the same address. Versions are written for ${own} only.`,
    );
  }
  if (!f.primaryLanguage) return null;
  return check(
    "language",
    "green",
    `Written in ${languageName(f.primaryLanguage)}, your page's language.`,
  );
}

// ---------------------------------------------------------------------------
// 6. Terms (superadmin only)
// ---------------------------------------------------------------------------

export function termsCheck(f: ReadinessFacts): ReadinessCheck | null {
  if (f.plan !== "pilot") return null;
  const only = { superadmin_only: true };
  if (f.pilotTermsAt === null) {
    return check(
      "terms",
      "red",
      "No pilot terms on record.",
      { label: "Record the terms", href: READINESS_HREFS.customers },
      only,
    );
  }
  return check("terms", "green", "Terms on record.", null, only);
}

// ---------------------------------------------------------------------------
// 7. Buttons and versions
// ---------------------------------------------------------------------------

export function buttonsCheck(f: ReadinessFacts): ReadinessCheck | null {
  if (f.liveAt !== null || !f.buttonSlots) return null;
  return check(
    "buttons",
    "grey",
    "Your buttons keep their words. Turn rewriting on if you want them written.",
    { label: "Parts of the page", href: READINESS_HREFS.look },
  );
}

export function versionsCheck(f: ReadinessFacts): ReadinessCheck | null {
  if (f.liveAt === null) {
    if (!f.preview.written || f.preview.total < 2) return null;
    return check(
      "versions",
      "green",
      `1 version written. The other ${f.preview.total - 1} are written after you go live.`,
    );
  }
  if (f.versions.refused === 0) return null;
  return check(
    "versions",
    "grey",
    `${f.versions.refused} of ${f.versions.total} versions refused, tried again within six hours.`,
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** Every line in the spec's order; superadmin lines left out for a customer. */
export function readinessChecks(f: ReadinessFacts): ReadinessCheck[] {
  const all: Array<ReadinessCheck | null> = [
    tagCheck(f),
    ...countedChecks(f),
    categoryCheck(f),
    trafficCheck(f),
    languageCheck(f),
    termsCheck(f),
    buttonsCheck(f),
    versionsCheck(f),
  ];
  return all.filter((c): c is ReadinessCheck => c !== null && (f.superadmin || !c.superadmin_only));
}

/** The one line that closes Go live, or null. */
export function blockingLine(checks: readonly ReadinessCheck[]): string | null {
  return checks.find((c) => c.blocks)?.line ?? null;
}

/**
 * The tag is withheld (privacy review condition 2): before go live, while the
 * question is unanswered or answered yes with no mark. A marked site never
 * waits, nor does a customer that is already live.
 */
export function tagWithheld(f: {
  liveAt: number | null;
  sensitive: boolean;
  specialCategory: boolean | null;
}): boolean {
  if (f.liveAt !== null || f.sensitive) return false;
  return f.specialCategory === null || f.specialCategory === true;
}
