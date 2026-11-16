/**
 * Results with page groups (mock design/mock/sales-readiness/
 * page-groups.html, section 05, approved 2026-10-12 as drawn; contract
 * docs/specs/proof-engine.md "Visits that never met a version", as built):
 * the counted buttons under the card's title with a group's button "on N
 * pages", the second result line in both states with "Why two lines?", and
 * nothing of it when the report or the list does not carry the fields.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProofCard } from "../../src/components/analytics/ProofCard";
import {
  CARD_SUB_COUNTED,
  countedLines,
  isSiteWideTarget,
  onVersionedOf,
  secondLine,
  showsCountedList,
  showsSecondLine,
} from "../../src/lib/page-groups";
import { cardSub } from "../../src/lib/proof";
import type {
  ConversionTarget,
  LiftReport,
  OnVersioned,
  PagesBreakdown,
} from "../../src/types/api";
import { REPORTS } from "./proof-fixtures";

const HOME_BUTTON: ConversionTarget = {
  id: "ct_home",
  customer_id: "medora",
  section_path: "hero.cta.label",
  label: "Explore our products",
  conversion_label: "other",
  enabled: true,
  css_selectors: [".btn"],
  text_selectors: [],
  structural_selector: "",
  created_at: 1,
  updated_at: 1,
};

const GROUP_BUTTON: ConversionTarget = {
  ...HOME_BUTTON,
  id: "ct_group",
  section_path: "count:/products/*",
  label: "Əlaqə",
  conversion_label: "contact",
  page: "/products/*",
  group: true,
  pages: 69,
};

const PICKED: ConversionTarget = {
  ...HOME_BUTTON,
  id: "ct_pick",
  section_path: "count:/pricing",
  label: "Book a call",
};

/** The pilot's navbar link, added by hand with its selector (2026-10-13). */
const SITE_BUTTON: ConversionTarget = {
  ...HOME_BUTTON,
  id: "ct_site",
  section_path: "a[href$=contact]",
  label: "Əlaqə",
  conversion_label: "contact",
  css_selectors: ["a[href$=contact]"],
};

const PHONE_BUTTON: ConversionTarget = {
  ...SITE_BUTTON,
  id: "ct_phone",
  section_path: 'a[href^="tel:"]',
  label: "+000 70 555 01 66",
};

const SENTENCE_READ =
  "On pages that have versions: +23% (range +2% to +48%). Visits whose first page had versions of its own.";
const SENTENCE_WAIT =
  "On pages that have versions: 12 of the 212 visits in the versions group clicked Əlaqə, and 3 of the 47 in the original group. Compared on the read date.";

function withSecond(report: LiftReport, on: OnVersioned | null): LiftReport {
  return { ...report, on_versioned: on } as LiftReport;
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function card(report: LiftReport, counted = countedLines([])) {
  return renderToStaticMarkup(h(ProofCard, { report, superadmin: false, counted }));
}

describe("countedLines: the list under the title", () => {
  it("a group's button says on N pages from its own count; a page's button says its page", () => {
    expect(countedLines([HOME_BUTTON, GROUP_BUTTON, PICKED])).toEqual([
      {
        id: "ct_home",
        label: "Explore our products",
        where: "on the homepage",
        group: false,
        site: false,
      },
      { id: "ct_group", label: "Əlaqə", where: "on 69 pages", group: true, site: false },
      { id: "ct_pick", label: "Book a call", where: "on /pricing", group: false, site: false },
    ]);
  });

  it("without the target's count, the breakdown's groups; without either, 'on these pages'", () => {
    const bare = { ...GROUP_BUTTON, pages: null };
    const pages: PagesBreakdown = {
      pages: [],
      without_versions: { pages: 65, visits: 190, signal_visits: 60 },
      groups: [{ pattern: "/products/*", pages: 67, visits: 230, accepted: true }],
    };
    expect(countedLines([bare], pages)[0]?.where).toBe("on 67 pages");
    expect(countedLines([bare])[0]?.where).toBe("on these pages");
    expect(
      countedLines([bare], {
        pages: [],
        without_versions: { pages: 0, visits: 0, signal_visits: 0 },
      })[0]?.where,
    ).toBe("on these pages");
  });

  it("a group target from a worker that marks it by its path alone is still a group", () => {
    const byPath = { ...GROUP_BUTTON, page: undefined, group: undefined, pages: undefined };
    expect(countedLines([byPath])[0]).toMatchObject({ where: "on these pages", group: true });
  });

  it("a button turned off is not counted; the list shows once a group counts a button", () => {
    expect(countedLines([{ ...GROUP_BUTTON, enabled: false }, HOME_BUTTON])).toHaveLength(1);
    expect(showsCountedList(countedLines([HOME_BUTTON]))).toBe(false);
    expect(showsCountedList(countedLines([HOME_BUTTON, GROUP_BUTTON]))).toBe(true);
    expect(showsCountedList(countedLines(null))).toBe(false);
  });

  it("a button on every page says so, by the API's mark or by its selector", () => {
    // The pilot's two hand-added buttons: a navbar link and a phone link.
    expect(countedLines([SITE_BUTTON, PHONE_BUTTON])).toEqual([
      { id: "ct_site", label: "Əlaqə", where: "on every page", group: false, site: true },
      {
        id: "ct_phone",
        label: "+000 70 555 01 66",
        where: "on every page",
        group: false,
        site: true,
      },
    ]);
    // The API's own mark wins both ways.
    expect(countedLines([{ ...HOME_BUTTON, site: true }])[0]).toMatchObject({
      where: "on every page",
      site: true,
    });
    expect(countedLines([{ ...SITE_BUTTON, site: false }])[0]).toMatchObject({
      where: "on the homepage",
      site: false,
    });
    // A `site:` path is one by name; a class selector and a bare tag are selectors.
    expect(isSiteWideTarget({ section_path: "site:a[href$=contact]" })).toBe(true);
    expect(isSiteWideTarget({ section_path: ".btn-contact" })).toBe(true);
    expect(isSiteWideTarget({ section_path: "a" })).toBe(true);
    // A slot path, a count pick and a group's button are not.
    expect(isSiteWideTarget({ section_path: "hero.cta.label" })).toBe(false);
    expect(isSiteWideTarget({ section_path: "forms.submit_label" })).toBe(false);
    expect(isSiteWideTarget({ section_path: "features_core.cta.label" })).toBe(false);
    expect(isSiteWideTarget({ section_path: "count:/pricing" })).toBe(false);
    expect(isSiteWideTarget({ section_path: "count:/products/*" })).toBe(false);
    expect(countedLines([GROUP_BUTTON, PICKED]).map((l) => l.site)).toEqual([false, false]);
  });

  it("the list shows for a site-wide button or more than one button; the second line for a group or a site-wide one", () => {
    expect(showsCountedList(countedLines([SITE_BUTTON]))).toBe(true);
    expect(showsCountedList(countedLines([HOME_BUTTON, PICKED]))).toBe(true);
    expect(showsCountedList(countedLines([HOME_BUTTON, { ...SITE_BUTTON, enabled: false }]))).toBe(
      false,
    );
    expect(showsSecondLine(countedLines([SITE_BUTTON]))).toBe(true);
    expect(showsSecondLine(countedLines([HOME_BUTTON, GROUP_BUTTON]))).toBe(true);
    expect(showsSecondLine(countedLines([HOME_BUTTON, PICKED]))).toBe(false);
    expect(showsSecondLine(countedLines([HOME_BUTTON]))).toBe(false);
  });
});

describe("the card with the pilot's three counted buttons", () => {
  const pilot = countedLines([
    { ...HOME_BUTTON, section_path: "forms.submit_label", label: "Göndər" },
    SITE_BUTTON,
    PHONE_BUTTON,
  ]);

  it("one row each, the two site-wide ones on every page, never on the homepage", () => {
    const html = card(REPORTS.interim, pilot);
    expect(html).toContain('data-list="counted"');
    expect(text(html)).toContain(
      `${CARD_SUB_COUNTED} “Göndər” on the homepage “Əlaqə” on every page “+000 70 555 01 66” on every page`,
    );
    expect((text(html).match(/on the homepage/g) ?? []).length).toBe(1);
  });

  it("the second line shows with a site-wide button, since it counts on pages without versions", () => {
    const read = withSecond(REPORTS.positive, {
      enough: true,
      lift: { value: 0.23, low: 0.02, high: 0.48 },
      waits_for: null,
      sentence: SENTENCE_READ,
    });
    expect(card(read, pilot)).toContain('data-line="on-versioned"');
    // Two homepage buttons show the list but not the second line.
    expect(card(read, countedLines([HOME_BUTTON, PICKED]))).toContain('data-list="counted"');
    expect(card(read, countedLines([HOME_BUTTON, PICKED]))).not.toContain(
      'data-line="on-versioned"',
    );
  });
});

describe("A16: the card with two counted buttons", () => {
  it("one row each under the title, the group's on 69 pages, and the subline for counted buttons", () => {
    const html = card(REPORTS.interim, countedLines([HOME_BUTTON, GROUP_BUTTON]));
    expect(html).toContain('data-list="counted"');
    expect(text(html)).toContain(
      `What the versions did ${CARD_SUB_COUNTED} “Explore our products” on the homepage “Əlaqə” on 69 pages`,
    );
    expect(CARD_SUB_COUNTED).toBe("Clicks on your counted buttons, visits with a signal");
  });

  it("without a group's button the card is as it was: no list, the corrected subline", () => {
    const html = card(REPORTS.interim, countedLines([HOME_BUTTON]));
    expect(html).not.toContain('data-list="counted"');
    expect(text(html)).toContain(
      "Clicks on Start free, visits with a signal that were put in the test",
    );
    expect(cardSub(REPORTS.interim)).not.toContain("written version");
  });
});

describe("the second line", () => {
  it("reads the API's own sentence, its lead taken off for the label", () => {
    const r = withSecond(REPORTS.positive, {
      treat: { visits: 3260, converting_visits: 212, rate: 0.065 },
      holdout: { visits: 824, converting_visits: 47, rate: 0.057 },
      enough: true,
      lift: { value: 0.23, low: 0.02, high: 0.48 },
      waits_for: null,
      sentence: SENTENCE_READ,
    });
    expect(secondLine(r)).toEqual({
      text: "+23% (range +2% to +48%). Visits whose first page had versions of its own.",
      range: null,
    });
    const r2 = withSecond(REPORTS.interim, {
      treat: { visits: 212, converting_visits: 12, rate: null },
      holdout: { visits: 47, converting_visits: 3, rate: null },
      enough: false,
      lift: null,
      waits_for: "read_date",
      sentence: SENTENCE_WAIT,
    });
    expect(secondLine(r2)?.text).toBe(
      "12 of the 212 visits in the versions group clicked Əlaqə, and 3 of the 47 in the original group. Compared on the read date.",
    );
  });

  it("without a sentence: not enough visits yet, or the lift once the gate is met", () => {
    expect(secondLine(withSecond(REPORTS.interim, { enough: false, lift: null }))).toEqual({
      text: "not enough visits yet.",
      range: null,
    });
    expect(
      secondLine(
        withSecond(REPORTS.positive, {
          enough: true,
          lift: { value: 0.23, low: 0.02, high: 0.48 },
        }),
      ),
    ).toEqual({ text: "23% more, ", range: "likely +2% to +48%" });
    expect(
      secondLine(
        withSecond(REPORTS.positive, {
          enough: true,
          lift: { value: -0.1, low: -0.3, high: 0.05 },
        }),
      )?.text,
    ).toBe("10% fewer, ");
  });

  it("null when the report carries no such field, or null", () => {
    expect(secondLine(REPORTS.interim)).toBeNull();
    expect(secondLine(withSecond(REPORTS.interim, null))).toBeNull();
    expect(onVersionedOf(null)).toBeNull();
    expect(onVersionedOf({ on_versioned: "x" } as unknown as LiftReport)).toBeNull();
  });
});

describe("A17 to A19: the second line on the card", () => {
  const read = withSecond(REPORTS.positive, {
    enough: true,
    lift: { value: 0.23, low: 0.02, high: 0.48 },
    waits_for: null,
    sentence: SENTENCE_READ,
  });
  const waits = withSecond(REPORTS.interim, {
    enough: false,
    lift: null,
    waits_for: "read_date",
    sentence: SENTENCE_WAIT,
  });

  // The second line shows only once a group counts a button (sign-off note 3).
  const withGroup = countedLines([HOME_BUTTON, GROUP_BUTTON]);

  it("A17: the label in bold, the API's line, Why two lines? closed with its two lines behind it", () => {
    const html = card(read, withGroup);
    expect(html).toContain('data-line="on-versioned"');
    expect(text(html)).toContain(
      "On pages that have versions: +23% (range +2% to +48%). Visits whose first page had versions of its own. Why two lines? Hide Visits that only opened pages without versions cannot show a difference. This line leaves them out.",
    );
    expect(html).not.toContain("<details open");
  });

  it("A18: the line waits in the same place, same size", () => {
    const t = text(card(waits, withGroup));
    expect(t).toContain("On pages that have versions: 12 of the 212 visits");
    expect(t).toContain("Compared on the read date. Why two lines?");
  });

  it("the line sits under the main numbers, before the figure", () => {
    const html = card(read, withGroup);
    const at = html.indexOf('data-line="on-versioned"');
    expect(at).toBeGreaterThan(html.indexOf("Your original"));
    expect(at).toBeLessThan(html.indexOf("Lift"));
  });

  it("nothing of it when the report does not carry the field", () => {
    expect(card(REPORTS.positive, withGroup)).not.toContain('data-line="on-versioned"');
    expect(card(REPORTS.interim, withGroup)).not.toContain("Why two lines?");
  });

  it("nothing of it until a group counts a button, whatever the report carries", () => {
    // Seen live on measure-lab, 2026-10-12: the line showed with no group.
    expect(card(read)).not.toContain('data-line="on-versioned"');
    expect(card(waits, countedLines([HOME_BUTTON]))).not.toContain("Why two lines?");
  });

  it("the limits line under the card is the API's own first sentence, as it comes", () => {
    const corrected = {
      ...REPORTS.interim,
      limits:
        "Counts clicks on your confirmed buttons, not signups or revenue. Covers visits that had a signal and were put in the test, on pages without versions of their own too, not your whole site.",
    };
    expect(text(card(corrected))).toContain(
      "Counts clicks on your confirmed buttons, not signups or revenue.",
    );
  });
});
