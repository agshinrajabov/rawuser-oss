/**
 * The readiness checks from facts (docs/specs/readiness-check.md, Tests:
 * every state from fixtures, the exact sentence, the action). The sentences
 * are the spec's and the approved mock's (section 08).
 */
import { describe, expect, it } from "vitest";
import {
  DAY_THREE_MS,
  type ReadinessFacts,
  SPECIAL_CATEGORY_BLOCK_LINE,
  blockingLine,
  buttonsCheck,
  categoryCheck,
  countedChecks,
  countedNouns,
  languageCheck,
  readinessChecks,
  tagCheck,
  tagWithheld,
  termsCheck,
  trafficCheck,
  versionsCheck,
} from "../../src/lib/readiness.ts";

const NOW = Date.parse("2026-10-14T10:00:00Z");

function facts(over: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    now: NOW,
    superadmin: false,
    supportAddress: "hello@example.com",
    plan: "pilot",
    liveAt: null,
    sensitive: false,
    specialCategory: false,
    pilotTermsAt: 1,
    tag: { position: "head_first", flags: [], form: "script" },
    late: null,
    counted: [{ section_path: "forms.submit_label", conversion_label: "contact", goes: "form" }],
    contactLinkOnPage: false,
    healthHit: false,
    baseline: { baseline_days: 7, estimate_weeks: 6 },
    auditWeeks: null,
    dayThree: null,
    testRunning: false,
    primaryLanguage: "az",
    sameAddress: [],
    buttonSlots: false,
    preview: { written: true, total: 20 },
    versions: { total: 0, refused: 0 },
    ...over,
  };
}

const MOVE = { label: "Move it first in the head", href: "/start" };

describe("1. the tag", () => {
  it("head_first is green", () => {
    expect(tagCheck(facts())).toMatchObject({
      id: "tag",
      state: "green",
      line: "The tag is first in the head. Versions show before the page paints.",
      action: null,
      known: "now",
      blocks: false,
    });
  });

  it.each([
    ["head_late", ["blocking_script_before"]],
    ["head_first", ["async"]],
    ["head_first", ["defer"]],
    ["head_first", ["rocket_loader"]],
    ["head_first", ["gtm"]],
  ])("%s with %j is amber", (position, flags) => {
    const c = tagCheck(facts({ tag: { position: position as never, flags, form: "script" } }));
    expect(c.state).toBe("amber");
    expect(c.line).toBe(
      "The tag runs after other scripts. Some visitors see the original for a moment.",
    );
    expect(c.action).toEqual(MOVE);
  });

  it("a head_late row with no blocking script (inline scripts only, probed before 2026-10-25) is green", () => {
    const c = tagCheck(facts({ tag: { position: "head_late", flags: [], form: "script" } }));
    expect(c.state).toBe("green");
  });

  it.each([
    ["body_top", "script"],
    ["body_late", "script"],
    ["head_first", "generic"],
  ])("%s / %s is red, in the body", (position, form) => {
    const c = tagCheck(facts({ tag: { position: position as never, flags: [], form } }));
    expect(c.state).toBe("red");
    expect(c.line).toBe(
      "The tag is in the body. About one load in four paints before it and stays as built.",
    );
    expect(c.action).toEqual(MOVE);
  });

  it("not found, or never probed, is red", () => {
    const notFound = tagCheck(facts({ tag: { position: "not_found", flags: [], form: null } }));
    expect(notFound).toMatchObject({
      state: "red",
      line: "We do not see the tag yet.",
      action: MOVE,
    });
    expect(tagCheck(facts({ tag: null })).line).toBe("We do not see the tag yet.");
  });

  it("from day 3 the measured share replaces the probe", () => {
    const live = NOW - DAY_THREE_MS;
    const c = tagCheck(facts({ liveAt: live, late: { visits: 100, lp_visits: 25 } }));
    expect(c).toMatchObject({
      state: "red",
      line: "On about 1 in 4 visits your page painted before the tag.",
      action: MOVE,
      known: "after_day_3",
    });
    expect(tagCheck(facts({ liveAt: live, late: { visits: 100, lp_visits: 5 } }))).toMatchObject({
      state: "amber",
      line: "On about 1 in 20 visits your page painted before the tag.",
    });
    // No late visit: the probe's line stands. Before day 3: the probe's line.
    expect(tagCheck(facts({ liveAt: live, late: { visits: 100, lp_visits: 0 } })).state).toBe(
      "green",
    );
    expect(
      tagCheck(facts({ liveAt: NOW - DAY_THREE_MS + 1000, late: { visits: 100, lp_visits: 25 } }))
        .known,
    ).toBe("now");
  });
});

describe("2. what is counted", () => {
  it("no enabled row is red", () => {
    expect(countedChecks(facts({ counted: [] }))).toEqual([
      expect.objectContaining({
        id: "counted",
        state: "red",
        line: "No button is counted yet.",
        action: { label: "Pick it on your page", href: "/conversions" },
      }),
    ]);
  });

  it("every row other and same_site to a page that is not start is amber", () => {
    const [c] = countedChecks(
      facts({
        counted: [{ section_path: "hero.cta.label", conversion_label: "other", goes: "same_site" }],
      }),
    );
    expect(c).toMatchObject({
      state: "amber",
      line: "The counted button opens another page of your site, so a visit can count without an action.",
      action: {
        label: "Count the contact, signup or purchase button instead",
        href: "/conversions",
      },
    });
  });

  it("a same_site button to a start page is green; so is any row with a kind", () => {
    const start = countedChecks(
      facts({
        counted: [
          { section_path: "hero.cta.label", conversion_label: "other", goes: "start_page" },
        ],
      }),
    );
    expect(start[0]).toMatchObject({
      state: "green",
      line: "Counted: the button, on the homepage.",
    });
    expect(countedChecks(facts())[0]).toMatchObject({
      state: "green",
      line: "Counted: the contact form, on the homepage.",
    });
  });

  it("names a picked page, every page, and several rows", () => {
    const [c] = countedChecks(
      facts({
        counted: [
          { section_path: "count:/pricing", conversion_label: "purchase", goes: null },
          { section_path: "site:elaqe", conversion_label: "contact", goes: "contact_link" },
        ],
      }),
    );
    expect(c?.line).toBe(
      "Counted: the purchase button on /pricing, the contact link on every page.",
    );
  });

  it("says two rows that read the same once, with their number (Medora, 2026-10-14)", () => {
    const [c] = countedChecks(
      facts({
        counted: [
          { section_path: "count:/", conversion_label: "contact", goes: "form" },
          { section_path: "site:elaqe", conversion_label: "contact", goes: null },
          { section_path: "site:telefon", conversion_label: "contact", goes: null },
        ],
      }),
    );
    expect(c?.line).toBe(
      "Counted: the contact form on the homepage, 2 contact buttons on every page.",
    );
    expect(countedNouns("the contact link", 3)).toBe("3 contact links");
  });

  it("the hint: a contact link on the page and no contact row; a site: row satisfies it", () => {
    const hinted = countedChecks(
      facts({
        contactLinkOnPage: true,
        counted: [
          { section_path: "hero.cta.label", conversion_label: "signup", goes: "start_page" },
        ],
      }),
    );
    expect(hinted.map((c) => c.id)).toEqual(["counted", "contact_hint"]);
    expect(hinted[1]).toMatchObject({
      state: "amber",
      line: "Your page has a phone or email link that is not counted.",
      action: { label: "Count it on every page", href: "/conversions" },
    });
    const satisfied = countedChecks(
      facts({
        contactLinkOnPage: true,
        counted: [
          { section_path: "hero.cta.label", conversion_label: "signup", goes: "start_page" },
          { section_path: "site:phone", conversion_label: "contact", goes: "contact_link" },
        ],
      }),
    );
    expect(satisfied.map((c) => c.id)).toEqual(["counted"]);
    // Not read (no quickstart record): no hint.
    expect(countedChecks(facts({ contactLinkOnPage: null, counted: [] })).length).toBe(1);
  });
});

describe("3. a special category", () => {
  it("a marked site: green with no action, for anyone (the dashboard's ad lines read it, ad-links.ts)", () => {
    for (const superadmin of [false, true]) {
      for (const specialCategory of [null, false, true]) {
        const c = categoryCheck(facts({ sensitive: true, specialCategory, superadmin }));
        expect(c.state).toBe("green");
        expect(c.action).toBeNull();
      }
    }
  });

  it("unanswered is amber, with the health sentence on a hit, and asks to answer", () => {
    expect(categoryCheck(facts({ specialCategory: null }))).toMatchObject({
      state: "amber",
      line: "Tell us whether your site is about health, religion, sexuality, politics or union membership.",
      action: { label: "Answer", href: "/start" },
      blocks: false,
    });
    expect(categoryCheck(facts({ specialCategory: null, healthHit: true })).line).toBe(
      "Your page reads like a health site. Tell us if it is.",
    );
  });

  it("a yes that is not marked is red and blocks; the superadmin gets Mark it", () => {
    const c = categoryCheck(facts({ specialCategory: true }));
    expect(c).toMatchObject({
      state: "red",
      line: SPECIAL_CATEGORY_BLOCK_LINE,
      action: null,
      blocks: true,
    });
    expect(c.line).toBe(
      "Your site is in a special category. We finish its setup by hand before go live.",
    );
    expect(categoryCheck(facts({ specialCategory: true, superadmin: true })).action).toEqual({
      label: "Mark it",
      href: "/analytics",
    });
    expect(blockingLine(readinessChecks(facts({ specialCategory: true })))).toBe(
      SPECIAL_CATEGORY_BLOCK_LINE,
    );
    expect(blockingLine(readinessChecks(facts()))).toBeNull();
  });

  it("yes and marked is green; marked without an answer is green too", () => {
    const line =
      "Set up as a special-category site: product pages are counted as a group and versions make no claims.";
    expect(categoryCheck(facts({ specialCategory: true, sensitive: true }))).toMatchObject({
      state: "green",
      line,
      blocks: false,
    });
    expect(categoryCheck(facts({ specialCategory: null, sensitive: true })).line).toBe(line);
  });

  it("no is green with Change", () => {
    expect(categoryCheck(facts({ specialCategory: false }))).toMatchObject({
      state: "green",
      line: "Not a special-category site.",
      action: { label: "Change", href: "/start" },
    });
  });

  it("tag withheld: before go live, unanswered or yes unmarked; never live or marked", () => {
    expect(tagWithheld({ liveAt: null, sensitive: false, specialCategory: null })).toBe(true);
    expect(tagWithheld({ liveAt: null, sensitive: false, specialCategory: true })).toBe(true);
    expect(tagWithheld({ liveAt: null, sensitive: false, specialCategory: false })).toBe(false);
    expect(tagWithheld({ liveAt: null, sensitive: true, specialCategory: null })).toBe(false);
    expect(tagWithheld({ liveAt: 5, sensitive: false, specialCategory: null })).toBe(false);
    expect(tagWithheld({ liveAt: 5, sensitive: false, specialCategory: true })).toBe(false);
  });
});

describe("4. traffic", () => {
  it("before go live: 52 weeks exactly is green, 53 amber, under 7 days grey", () => {
    expect(
      trafficCheck(facts({ baseline: { baseline_days: 7, estimate_weeks: 52 } })),
    ).toMatchObject({ state: "green", line: "A 20% test would read in about 52 weeks." });
    expect(
      trafficCheck(facts({ baseline: { baseline_days: 7, estimate_weeks: 53 } })),
    ).toMatchObject({
      state: "amber",
      line: "At this traffic a test shows a direction, not a proof.",
    });
    expect(
      trafficCheck(facts({ baseline: { baseline_days: 3, estimate_weeks: null } })),
    ).toMatchObject({
      state: "grey",
      line: "Not known yet. We see your traffic from day 3 after go live.",
      known: "now",
    });
  });

  it("the audit path: the report's visits give the estimate when the baseline has none", () => {
    expect(
      trafficCheck(facts({ baseline: { baseline_days: 0, estimate_weeks: null }, auditWeeks: 6 })),
    ).toMatchObject({ state: "green", line: "A 20% test would read in about 6 weeks." });
    expect(
      trafficCheck(facts({ baseline: { baseline_days: 0, estimate_weeks: null }, auditWeeks: 80 }))
        .state,
    ).toBe("amber");
  });

  it("from day 3, no estimate but known visits reads as a direction, not as unknown", () => {
    const live = NOW - DAY_THREE_MS;
    expect(
      trafficCheck(facts({ liveAt: live, dayThree: { per_day: 17, weeks: null } })),
    ).toMatchObject({
      state: "amber",
      line: "About 17 visits a day. At this traffic the test shows a direction, not a proof.",
      known: "after_day_3",
    });
    expect(trafficCheck(facts({ liveAt: live, dayThree: { per_day: 0, weeks: null } })).state).toBe(
      "grey",
    );
  });

  it("from day 3 the lift report's estimate speaks, with the direction action by role", () => {
    const live = NOW - DAY_THREE_MS;
    expect(
      trafficCheck(facts({ liveAt: live, dayThree: { per_day: 60, weeks: 5 } })),
    ).toMatchObject({
      state: "green",
      line: "About 60 visits a day with a test. A result in about 5 weeks.",
      action: null,
      known: "after_day_3",
    });
    const customer = trafficCheck(facts({ liveAt: live, dayThree: { per_day: 70, weeks: 60 } }));
    expect(customer).toMatchObject({
      state: "amber",
      line: "About 70 visits a day. At this traffic the test shows a direction, not a proof.",
      action: {
        label: "Ask us to start a direction test",
        href: "mailto:hello@example.com?subject=Direction%20test",
      },
    });
    // No support address on the install: nobody to ask, so no action is drawn.
    expect(
      trafficCheck(
        facts({ liveAt: live, supportAddress: null, dayThree: { per_day: 70, weeks: 60 } }),
      ),
    ).toMatchObject({
      state: "amber",
      line: "About 70 visits a day. At this traffic the test shows a direction, not a proof.",
      action: null,
    });
    expect(
      trafficCheck(facts({ liveAt: live, superadmin: true, dayThree: { per_day: 70, weeks: 60 } }))
        .action,
    ).toEqual({ label: "Start at 20% as a direction", href: "/analytics" });
    expect(
      trafficCheck(facts({ liveAt: live, testRunning: true, dayThree: { per_day: 70, weeks: 60 } }))
        .action,
    ).toBeNull();
    expect(trafficCheck(facts({ liveAt: live, dayThree: { per_day: 0, weeks: null } })).state).toBe(
      "grey",
    );
  });
});

describe("5. languages", () => {
  it("a same-address language is amber; none is the mock's green line; unknown is no line", () => {
    expect(languageCheck(facts({ sameAddress: ["en"] }))).toMatchObject({
      state: "amber",
      line: "Your site also has English on the same address. Versions are written for Azerbaijani only.",
      action: null,
    });
    expect(languageCheck(facts({ sameAddress: ["en", "ru"] }))?.line).toBe(
      "Your site also has English and Russian on the same address. Versions are written for Azerbaijani only.",
    );
    expect(languageCheck(facts())).toMatchObject({
      state: "green",
      line: "Written in Azerbaijani, your page's language.",
    });
    expect(languageCheck(facts({ primaryLanguage: null }))).toBeNull();
  });
});

describe("6. terms", () => {
  it("a pilot without terms is red, superadmin only; with terms the mock's green; other plans none", () => {
    expect(termsCheck(facts({ pilotTermsAt: null }))).toMatchObject({
      state: "red",
      line: "No pilot terms on record.",
      action: { label: "Record the terms", href: "/customers" },
      superadmin_only: true,
    });
    expect(termsCheck(facts())).toMatchObject({
      state: "green",
      line: "Terms on record.",
      superadmin_only: true,
    });
    expect(termsCheck(facts({ plan: "free" }))).toBeNull();
  });

  it("a customer session never receives terms; a superadmin does", () => {
    const customer = readinessChecks(facts({ pilotTermsAt: null }));
    expect(customer.map((c) => c.id)).not.toContain("terms");
    const admin = readinessChecks(facts({ pilotTermsAt: null, superadmin: true }));
    expect(admin.map((c) => c.id)).toContain("terms");
  });
});

describe("7. buttons and versions", () => {
  it("before go live: the buttons line only with a button slot", () => {
    expect(buttonsCheck(facts({ buttonSlots: true }))).toMatchObject({
      state: "grey",
      line: "Your buttons keep their words. Turn rewriting on if you want them written.",
      action: { label: "Parts of the page", href: "/start" },
    });
    expect(buttonsCheck(facts({ buttonSlots: false }))).toBeNull();
    expect(buttonsCheck(facts({ buttonSlots: true, liveAt: 5 }))).toBeNull();
  });

  it("before go live: the preview as one version; after: refused rows only", () => {
    expect(versionsCheck(facts())).toMatchObject({
      state: "green",
      line: "1 version written. The other 19 are written after you go live.",
    });
    expect(versionsCheck(facts({ preview: { written: false, total: 20 } }))).toBeNull();
    expect(versionsCheck(facts({ liveAt: 5, versions: { total: 20, refused: 0 } }))).toBeNull();
    expect(versionsCheck(facts({ liveAt: 5, versions: { total: 20, refused: 2 } }))).toMatchObject({
      state: "grey",
      line: "2 of 20 versions refused, tried again within six hours.",
    });
  });
});

describe("the list", () => {
  it("is in the spec's order and holds no dash", () => {
    const all = readinessChecks(
      facts({ superadmin: true, buttonSlots: true, contactLinkOnPage: true, counted: [] }),
    );
    expect(all.map((c) => c.id)).toEqual([
      "tag",
      "counted",
      "contact_hint",
      "category",
      "traffic",
      "language",
      "terms",
      "buttons",
      "versions",
    ]);
    for (const c of all) expect(c.line).not.toMatch(/[–—]/);
  });
});
