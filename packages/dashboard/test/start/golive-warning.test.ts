/**
 * One warning before the test starts (mock design/mock/sales-readiness/
 * pilot-gaps.html, screen 05, states A20 to A24, approved 2026-10-12; the
 * drawing with the warning in view before the click). The rules, set for
 * this build since the mock named none: the share is said when the pages
 * with the counted button got under half of the last 7 days' visits, from
 * 30 visits; the wait is said past 12 weeks, and past 52 as "over a year".
 * Two counts the API gives, divided; nothing estimated in the browser.
 */
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ButtonToCount, GoLiveWarning } from "../../src/components/start/Measure";
import {
  COUNT_ANOTHER,
  LOW_TRAFFIC_LINE,
  SHARE_MIN_VISITS,
  countedPages,
  goLiveTest,
  goLiveWarning,
  resultWaitLine,
  shareLine,
} from "../../src/lib/golive";
import type { MeasureButton, MeasureProposal, PageRow } from "../../src/types/api";

const HERO: MeasureButton = {
  section_path: "hero.cta.label",
  label: "Məhsullarımızla tanış olun!",
};
const PICKED: MeasureButton = { section_path: "count:/contact", label: "Əlaqə" };

function measure(over: Partial<MeasureProposal> = {}): MeasureProposal {
  return {
    proposal: HERO,
    others: [],
    per_language: [],
    baseline_days: 3,
    estimate_weeks: null,
    low_traffic: false,
    ...over,
  };
}

function page(page_path: string, visits: number, has_versions = false): PageRow {
  return {
    page_path,
    visits,
    signal_visits: Math.round(visits / 3),
    written_visits: 0,
    skipped_visits: 0,
    has_versions,
  };
}

const ON = goLiveTest({ plan: "pilot", chosen: HERO, lowTraffic: false, switchOn: true });
const OFF = goLiveTest({ plan: "pilot", chosen: HERO, lowTraffic: false, switchOn: false });

// The pilot, 12 Oct: 79 of about 290 visits opened "/".
const MEDORA_ROWS = [page("/", 79), page("/products", 41), page("/about", 12)];

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("countedPages: where the chosen button is counted", () => {
  it("a slot is counted on the page on screen", () => {
    expect(countedPages(measure(), HERO, [], "/")).toEqual(["/"]);
  });

  it("and on each ticked language page that carries it", () => {
    const m = measure({
      per_language: [
        { lang: "en", path: "/en", found: true, slots: ["hero.cta.label"] },
        { lang: "ru", path: "/ru", found: false, slots: [] },
      ],
    });
    expect(countedPages(m, HERO, ["/en", "/ru"], "/")).toEqual(["/", "/en"]);
    // Not ticked: not written, not counted there.
    expect(countedPages(m, HERO, [], "/")).toEqual(["/"]);
  });

  it("a button picked on the page counts on its own page only", () => {
    expect(countedPages(measure(), PICKED, ["/en"], "/")).toEqual(["/contact"]);
  });

  it("no button, no page", () => {
    expect(countedPages(measure(), null, [], "/")).toEqual([]);
  });
});

describe("shareLine: only 1 in N visits open the page with this button", () => {
  it("A21, Medora: 79 of 290 is 1 in 4", () => {
    expect(shareLine({ pages: ["/"], rows: MEDORA_ROWS, total: 290 })).toBe(
      "Only 1 in 4 visits open the page with this button.",
    );
  });

  it("N is the two counts divided and rounded to a whole number", () => {
    expect(shareLine({ pages: ["/"], rows: [page("/", 30)], total: 100 })).toBe(
      "Only 1 in 3 visits open the page with this button.",
    );
    expect(shareLine({ pages: ["/"], rows: [page("/", 12)], total: 300 })).toBe(
      "Only 1 in 25 visits open the page with this button.",
    );
  });

  it("half or more of the visits: no line", () => {
    expect(shareLine({ pages: ["/"], rows: [page("/", 150)], total: 300 })).toBeNull();
    expect(shareLine({ pages: ["/"], rows: [page("/", 280)], total: 300 })).toBeNull();
    // Just under half.
    expect(shareLine({ pages: ["/"], rows: [page("/", 149)], total: 300 })).toBe(
      "Only 1 in 2 visits open the page with this button.",
    );
  });

  it("under 30 visits in the period: no line", () => {
    expect(SHARE_MIN_VISITS).toBe(30);
    expect(shareLine({ pages: ["/"], rows: [page("/", 5)], total: 29 })).toBeNull();
    expect(shareLine({ pages: ["/"], rows: [page("/", 5)], total: 30 })).toBe(
      "Only 1 in 6 visits open the page with this button.",
    );
  });

  it("a page that is not in the list has no number, so nothing is said", () => {
    // The list holds the busiest pages with 5 visits or more.
    expect(shareLine({ pages: ["/contact"], rows: MEDORA_ROWS, total: 290 })).toBeNull();
    expect(shareLine({ pages: ["/", "/en"], rows: MEDORA_ROWS, total: 290 })).toBeNull();
  });

  it("the button on two pages: their visits together", () => {
    expect(
      shareLine({ pages: ["/", "/en"], rows: [page("/", 40), page("/en", 20)], total: 300 }),
    ).toBe("Only 1 in 5 visits open the page with this button.");
  });

  it("paths are compared as the manifests key them", () => {
    expect(shareLine({ pages: ["/pricing"], rows: [page("/Pricing/", 20)], total: 200 })).toBe(
      "Only 1 in 10 visits open the page with this button.",
    );
  });

  it("the tag is minutes old, or the reads failed: no numbers, no line (A20)", () => {
    expect(shareLine({ pages: ["/"], rows: null, total: 290 })).toBeNull();
    expect(shareLine({ pages: ["/"], rows: MEDORA_ROWS, total: null })).toBeNull();
    expect(shareLine({ pages: ["/"], rows: [], total: 290 })).toBeNull();
    expect(shareLine({ pages: [], rows: MEDORA_ROWS, total: 290 })).toBeNull();
    expect(shareLine({ pages: ["/"], rows: undefined, total: undefined })).toBeNull();
  });
});

describe("resultWaitLine: the wait, from the API's estimate", () => {
  it("past 12 weeks it is said in weeks", () => {
    expect(resultWaitLine(13)).toBe("A result may take about 13 weeks.");
    expect(resultWaitLine(52)).toBe("A result may take about 52 weeks.");
  });

  it("past 52 weeks it is over a year", () => {
    expect(resultWaitLine(53)).toBe("A result may take over a year.");
    expect(resultWaitLine(1265)).toBe("A result may take over a year.");
  });

  it("12 weeks or fewer, or no estimate yet: nothing", () => {
    expect(resultWaitLine(12)).toBeNull();
    expect(resultWaitLine(4)).toBeNull();
    expect(resultWaitLine(null)).toBeNull();
    expect(resultWaitLine(undefined)).toBeNull();
    expect(resultWaitLine(Number.NaN)).toBeNull();
  });
});

describe("goLiveWarning: the states under Go live", () => {
  const share = "Only 1 in 4 visits open the page with this button.";
  const year = "A result may take over a year.";

  it("A20, nothing known: no warning", () => {
    expect(goLiveWarning({ test: ON, share: null, wait: null })).toBeNull();
  });

  it("A21, a small share and a long wait", () => {
    expect(goLiveWarning({ test: ON, share, wait: year })).toBe(`${share} ${year}`);
  });

  it("A22, a small share only: the first sentence alone", () => {
    expect(goLiveWarning({ test: ON, share, wait: null })).toBe(share);
  });

  it("a long wait only", () => {
    expect(
      goLiveWarning({ test: ON, share: null, wait: "A result may take about 30 weeks." }),
    ).toBe("A result may take about 30 weeks.");
  });

  it("A23, too little traffic: no test starts, so no warning", () => {
    const low = goLiveTest({ plan: "pilot", chosen: HERO, lowTraffic: true, switchOn: true });
    expect(low.line).toBe(LOW_TRAFFIC_LINE);
    expect(goLiveWarning({ test: low, share, wait: year })).toBeNull();
  });

  it("the test switched off, no button, a test account: no warning", () => {
    expect(goLiveWarning({ test: OFF, share, wait: year })).toBeNull();
    const none = goLiveTest({ plan: "pilot", chosen: null, lowTraffic: false, switchOn: true });
    expect(goLiveWarning({ test: none, share, wait: year })).toBeNull();
    const lab = goLiveTest({ plan: "test", chosen: HERO, lowTraffic: false, switchOn: true });
    expect(goLiveWarning({ test: lab, share, wait: year })).toBeNull();
  });
});

describe("GoLiveWarning: what renders", () => {
  it("one amber line with the link that opens the list of buttons", () => {
    const html = renderToStaticMarkup(
      h(GoLiveWarning, {
        line: "Only 1 in 4 visits open the page with this button. A result may take over a year.",
        onCountAnother: () => undefined,
      }),
    );
    expect(text(html)).toBe(
      "Only 1 in 4 visits open the page with this button. A result may take over a year. Count another button",
    );
    expect(COUNT_ANOTHER).toBe("Count another button");
    expect(html).toContain("state-warn");
    expect(html).toMatch(/<button[^>]*type="button"/);
    // The link stays whole when the line wraps (mock A24).
    expect(html).toMatch(/<button[^>]*whitespace-nowrap/);
  });

  it("nothing to warn about renders nothing (A20)", () => {
    expect(
      renderToStaticMarkup(h(GoLiveWarning, { line: null, onCountAnother: () => undefined })),
    ).toBe("");
  });

  it("no second button to go live: Go live itself is the anyway", () => {
    const html = renderToStaticMarkup(
      h(GoLiveWarning, { line: "A result may take over a year.", onCountAnother: () => undefined }),
    );
    expect(text(html)).not.toMatch(/anyway/i);
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("the row it opens takes the signal without changing how it first renders", () => {
    const row = (openSignal?: number) =>
      renderToStaticMarkup(
        h(ButtonToCount, {
          customerId: "medora",
          pagePath: "/",
          measure: measure(),
          chosen: HERO,
          onChoose: () => undefined,
          ticked: [],
          openSignal,
        }),
      );
    expect(row(0)).toBe(row());
    expect(text(row())).toContain("The button to count");
  });
});

describe("the Look screen", () => {
  const src = readFileSync(
    new URL("../../src/components/start/FirstRun.tsx", import.meta.url),
    "utf8",
  );

  it("draws the warning under the test line, outside the hatch", () => {
    const line = src.indexOf("<GoLiveTestLine");
    const warn = src.indexOf("<GoLiveWarning");
    const hatch = src.indexOf("<Hatch>", line);
    expect(line).toBeGreaterThan(0);
    expect(warn).toBeGreaterThan(line);
    expect(warn).toBeLessThan(hatch);
  });

  it("reads the last 7 days from the reads Results already makes, and the estimate from the lift report", () => {
    expect(src).toContain("/admin/analytics/breakdown?customer_id=${id}&window=7d");
    expect(src).toContain("/admin/analytics/overview?customer_id=${id}&window=7d");
    expect(src).toContain("r.start?.estimate?.weeks");
  });
});
