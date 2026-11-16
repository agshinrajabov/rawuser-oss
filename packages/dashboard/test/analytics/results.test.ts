import "../identity/example";
import { describe, expect, it } from "vitest";
import {
  TAG_SHARE,
  changeText,
  clickedLabel,
  comparisonLabel,
  groupRows,
  headlineFor,
  leadLine,
  limitsShort,
  nextSteps,
  numbersLine,
  parseWindow,
  periodLabel,
  seesFor,
  seriesFor,
  shareBar,
  showsChange,
  testPeriodLine,
  windowsFor,
} from "../../src/lib/results";
import { ABOUT, SHARE_PLACES, buildLink, homeUrl, taggedLink } from "../../src/lib/tagged-link";
import type { ResultsLead, UnknownRow } from "../../src/types/api";
import { REPORTS } from "./proof-fixtures";
import {
  BREAKDOWN_7D,
  BREAKDOWN_30D,
  MANIFESTS,
  OVERVIEW_7D,
  OVERVIEW_30D,
  TIMESERIES,
} from "./results-fixtures";

const R = REPORTS;
const LINKEDIN = SHARE_PLACES.find((p) => p.id === "linkedin") as (typeof SHARE_PLACES)[number];

describe("the period switch", () => {
  it("customers pick 7 or 30 days; superadmins also get hours", () => {
    expect(windowsFor(false).map((w) => w.label)).toEqual(["7 days", "30 days"]);
    expect(windowsFor(true).map((w) => w.label)).toEqual([
      "1 hour",
      "24 hours",
      "7 days",
      "30 days",
    ]);
  });
  it("30 days by default, and a customer cannot open an hour from the URL", () => {
    expect(parseWindow(null, false)).toBe("30d");
    expect(parseWindow("1h", false)).toBe("30d");
    expect(parseWindow("1h", true)).toBe("1h");
    expect(parseWindow("7d", false)).toBe("7d");
  });
  it("names the period, and the comparison only when there is one", () => {
    expect(periodLabel("30d", OVERVIEW_30D.period, null)).toBe(
      "Last 30 days · Wed 2 Sep to Fri 2 Oct",
    );
    expect(periodLabel("24h", OVERVIEW_30D.period, null)).toBe("Last 24 hours");
    expect(comparisonLabel("30d", OVERVIEW_30D.comparison)).toBeNull();
    expect(comparisonLabel("7d", OVERVIEW_7D.comparison)).toBe("against the 7 days before");
    expect(showsChange(OVERVIEW_30D.comparison)).toBe(false);
    expect(showsChange(OVERVIEW_7D.comparison)).toBe(true);
    expect(showsChange(undefined)).toBe(false);
  });
  it("a change the API does not give is never shown", () => {
    expect(changeText(null)).toBeNull();
    expect(changeText(undefined)).toBeNull();
    expect(changeText(0.38)).toBe("+38%");
    expect(changeText(-0.12)).toBe("-12%");
  });
});

describe("the headline", () => {
  it("says visits, never people, in every state", () => {
    for (const r of Object.values(R)) {
      const h = headlineFor(r);
      expect(`${h.lead} ${h.tail ?? ""}`).not.toMatch(/people/i);
      expect(`${h.lead} ${h.tail ?? ""}`).not.toMatch(/[–—]/);
    }
  });
  it("grey until the read date, ink on it", () => {
    for (const s of ["off", "not_enough", "interim", "held_back", "ended_early"] as const) {
      expect(headlineFor(R[s]).final).toBe(false);
    }
    for (const s of ["positive", "no_difference", "negative", "ended"] as const) {
      expect(headlineFor(R[s]).final).toBe(true);
    }
  });
  // measure-setup mock: with no test the headline is the steps' title, in
  // ink, and how long a test takes is step 3's line (measure.test.ts).
  it("off: the title over the three steps, never a result", () => {
    const off = R.off;
    for (const r of [off, { ...off, metric: { ...off.metric, labels: [] } }]) {
      expect(headlineFor(r)).toEqual({
        lead: "Measure what Rawuser brings.",
        tail: null,
        final: false,
        title: true,
      });
    }
  });
  it("interim gives the number so far and no estimate of extra clicks", () => {
    const h = headlineFor(R.interim);
    expect(h.lead).toBe("Visits with a version clicked Start free 19% more so far.");
    expect(h.tail).toBe("Final on Mon 16 Nov.");
    expect(h.lead).not.toMatch(/extra/);
  });
  it("the result states", () => {
    expect(headlineFor(R.positive)).toMatchObject({
      lead: "The versions brought about 210 extra clicks on Start free.",
      tail: "+25%, likely +8% to +44%.",
    });
    expect(headlineFor(R.no_difference)).toMatchObject({
      lead: "No difference found.",
      tail: "Clicks moved between -8% and +21%.",
    });
    expect(headlineFor(R.negative).lead).toBe("Visits with a version clicked Start free 15% less.");
    expect(headlineFor(R.ended).lead).toBe("The test ended on 16 Nov.");
    expect(headlineFor(R.ended_early).tail).toBe("No clear answer.");
  });
  it("is short: one line each, at most 16 words", () => {
    for (const r of Object.values(R)) {
      const h = headlineFor(r);
      expect(`${h.lead} ${h.tail ?? ""}`.trim().split(/\s+/).length).toBeLessThanOrEqual(16);
    }
  });
  it("the test's own period, under the headline", () => {
    expect(testPeriodLine(R.interim)).toBe("Test period · Mon 7 Sep to today");
    expect(testPeriodLine(R.positive)).toBe("Test period · Mon 7 Sep to Sun 15 Nov");
    expect(testPeriodLine(R.off)).toBeNull();
  });
});

describe("the card's numbers line", () => {
  it("replaces the card's sentence where there are rates", () => {
    expect(numbersLine(R.interim)).toBe("Versions 9.4%, original 7.8%, range -5% to +50%");
    expect(numbersLine(R.positive)).toBe("Versions 9.6%, original 7.7%, likely +8% to +44%");
    expect(numbersLine(R.off)).toBeNull();
    expect(numbersLine(R.not_enough)).toBeNull();
    expect(numbersLine(R.held_back)).toBeNull();
  });
  it("keeps the first limit under the card", () => {
    expect(limitsShort(R.interim.limits)).toBe(
      "Counts clicks on your confirmed buttons, not signups or revenue.",
    );
  });
});

describe("who comes", () => {
  it("the lead line makes no click-rate claim without top_rate", () => {
    const l = leadLine(BREAKDOWN_30D.lead as ResultsLead, R.interim);
    expect(l).toBe("53% of visits told us where they came from.");
    expect(l).not.toMatch(/most often/);
  });
  it("with the gate passed, the grower and the top rate", () => {
    expect(leadLine(BREAKDOWN_7D.lead as ResultsLead, R.interim)).toBe(
      "53% of visits told us where they came from. AI assistants grew most, +38%, and clicked Start free most often, 13.2%.",
    );
  });
  it("the share bar adds up", () => {
    const b = shareBar(BREAKDOWN_30D.by_source ?? [], BREAKDOWN_30D.unknown as UnknownRow);
    expect(b.known.reduce((s, r) => s + r.visits, 0) + b.dark + b.rest).toBe(12080);
    expect(b.dark).toBe(1410);
    expect(Math.round(b.knownShare * 100)).toBe(53);
  });
  it("what each source sees, the two biggest", () => {
    expect(seesFor(BREAKDOWN_30D.by_tuple, "ai").map((s) => s.name)).toEqual([
      "Comparison",
      "Problem first",
    ]);
    expect(seesFor(BREAKDOWN_30D.by_tuple, "nowhere")).toEqual([]);
  });
  it("labels the goal", () => {
    expect(clickedLabel(R.interim)).toBe("Clicked Start free");
    expect(clickedLabel(null)).toBe("Clicked a goal");
  });
});

describe("what to do next", () => {
  const base = {
    report: R.interim,
    total: 12080,
    unknownVisits: 5640,
    pages: BREAKDOWN_30D.pages,
    manifests: MANIFESTS,
  };
  it("tag, the page without versions, the lost part, biggest first", () => {
    const s = nextSteps(base);
    expect(s.map((x) => x.id)).toEqual(["tag", "page", "part"]);
    expect(s[0]?.fact).toBe("5,640 visits (47%) told us nothing and saw your original.");
    expect(s[1]?.title).toBe("Give /docs its versions.");
    expect(s[2]?.fact).toBe("Your homepage changed, so that part keeps your own words.");
  });
  it("no tag step under 30% unknown", () => {
    const s = nextSteps({ ...base, unknownVisits: Math.floor(12080 * TAG_SHARE) - 1 });
    expect(s.map((x) => x.id)).not.toContain("tag");
  });
  it("never offers a test: the three steps above do, and nobody is asked", () => {
    for (const r of Object.values(R)) {
      const s = nextSteps({ ...base, report: r });
      expect(s.map((x) => x.id)).not.toContain("test");
      for (const x of s) expect(`${x.title} ${x.fact} ${x.button}`).not.toMatch(/\bSam\b/);
    }
  });
  it("at most three", () => {
    expect(nextSteps({ ...base, report: R.off }).length).toBe(3);
  });
});

describe("advanced", () => {
  it("plain group labels, the total from the overview", () => {
    const g = groupRows(OVERVIEW_30D);
    expect(g.map((r) => r.label)).toEqual([
      "Saw a version",
      "Saw your original, for the test",
      "Had a source, page kept as built",
      "Told us nothing, saw your original",
      "All visits",
    ]);
    expect(g.at(-1)).toMatchObject({ visits: 12080, conversions: 989 });
  });
  it("the daily chart follows the period; hours have none", () => {
    expect(seriesFor(TIMESERIES.series, "30d")).toHaveLength(30);
    expect(seriesFor(TIMESERIES.series, "7d")).toHaveLength(7);
    expect(seriesFor(TIMESERIES.series, "24h")).toHaveLength(0);
  });
});

describe("tagged links", () => {
  it("every place and topic reads back as the version it promises", () => {
    for (const place of SHARE_PLACES) {
      for (const a of ABOUT) {
        const l = taggedLink("https://brisk.test/", place, a.intent);
        expect(l, `${place.id}/${a.intent}`).not.toBeNull();
        expect(l?.source, `${place.id}/${a.intent}`).toBe(place.source);
        expect(l?.intent, `${place.id}/${a.intent}`).toBe(a.intent);
      }
    }
  });
  it("uses the Campaign links generator", () => {
    const l = taggedLink("https://brisk.test/", LINKEDIN, "problem");
    const b = buildLink({
      baseUrl: "https://brisk.test/",
      intentTarget: "problem",
      sourceTarget: "social",
      campaignOverride: "",
      sourceOverride: "linkedin",
    });
    expect(l?.url).toBe(b?.url);
    expect(l?.url).toBe(
      "https://brisk.test/?utm_campaign=how-it-works&utm_source=linkedin&utm_medium=social",
    );
  });
  it("a page that is not a URL makes no link; the home URL drops a scheme and path", () => {
    expect(taggedLink("brisk", LINKEDIN, "problem")).toBeNull();
    expect(homeUrl("https://brisk.test/app")).toBe("https://brisk.test/");
  });
});
