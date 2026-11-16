/**
 * Visitors (dashboard v2 mock, section 02; contract docs/specs/visitors-page.md):
 * the adapter reads the contract's answer, the filters go to the server,
 * the sentence answers "UK: visits, clicks, most on which version", and the
 * view renders the click-a-row filter.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/visitors",
}));

import {
  VisitorsView,
  countryRows,
  pageRows,
  sourceRows,
  versionRows,
} from "../../src/components/v2/Visitors";
import {
  NO_FILTERS,
  chartBuckets,
  countryMatrix,
  countryName,
  filtersFromQuery,
  readVisitors,
  summaryFor,
  toggle,
  versionLabel,
  visitorsPath,
} from "../../src/lib/visitors";

const c = (visits: number, conversions: number, page_views = visits * 2) => ({
  visits,
  page_views,
  conversions,
  rate: visits ? conversions / visits : null,
});

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 4);

/** A contract answer (version_by=source), unfiltered. */
const RAW = {
  customer_id: "lark",
  window: "30d",
  period: { start: START, end: START + 30 * DAY - 1 },
  computed_at: Date.now() - 9 * 60_000,
  filters: { country: null, source: null, name: null, version: null, page: null },
  version_by: "source",
  country_recording: "on",
  totals: c(2140, 61),
  markerless_page_views: 0,
  series: {
    bucket: "day",
    points: Array.from({ length: 30 }, (_, i) => ({ start: START + i * DAY, ...c(70, 2) })),
  },
  by_source: [
    { source: "none", ...c(812, 15) },
    {
      source: "organic",
      ...c(524, 15),
      names: [{ name: "google", label: "Google", visits: 486, conversions: 14 }],
    },
    {
      source: "social",
      ...c(374, 12),
      names: [{ name: "linkedin", label: "LinkedIn", visits: 352, conversions: 11 }],
    },
    {
      source: "ai",
      ...c(217, 10),
      names: [{ name: "chatgpt", label: "ChatGPT", visits: 176, conversions: 8 }],
    },
  ],
  by_country: [
    { country: "GB", ...c(578, 20) },
    { country: "US", ...c(470, 12) },
    { country: null, ...c(30, 0) },
  ],
  by_page: {
    pages: [
      { page_path: "/", group: false, has_versions: true, ...c(900, 20) },
      { page_path: "/contact", group: false, has_versions: false, ...c(200, 25) },
    ],
    other: { pages: 4, visits: 11, page_views: 13, conversions: 0 },
  },
  by_version: [
    { version: "as_built", kind: "as_built", intent_dim: null, source_dim: null, ...c(900, 16) },
    {
      version: "*:organic",
      kind: "version",
      intent_dim: null,
      source_dim: "organic",
      ...c(400, 12),
    },
    { version: "*:social", kind: "version", intent_dim: null, source_dim: "social", ...c(290, 13) },
    { version: "original", kind: "original", intent_dim: null, source_dim: null, ...c(230, 6) },
  ],
  by_button: [
    {
      label: "Book a call",
      clicks: 40,
      top_source: { source: "organic", clicks: 12 },
      top_country: { country: "GB", clicks: 15 },
      top_version: { version: "*:social", kind: "version", clicks: 11 },
    },
  ],
  country_by_version: [
    { country: "GB", version: "*:social", kind: "version", ...c(120, 7) },
    { country: "GB", version: "*:organic", kind: "version", ...c(100, 3) },
    { country: "GB", version: "original", kind: "original", ...c(50, 1) },
    { country: "US", version: "*:organic", kind: "version", ...c(90, 2) },
  ],
  country_by_source: [],
  country_by_page: [],
};

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("the adapter", () => {
  const a = readVisitors(RAW);

  it("reads the contract's answer", () => {
    expect(a?.totals.visits).toBe(2140);
    expect(a?.versionBy).toBe("source");
    expect(a?.byButton?.[0]?.top_version?.version).toBe("*:social");
    expect(a?.bySource[1]?.names[0]?.label).toBe("Google");
    expect(a?.countryRecording).toBe("on");
  });

  it("degrades: no filters and no by_button from an older worker; not an answer is null", () => {
    const old = readVisitors({ ...RAW, filters: undefined, by_button: undefined });
    expect(old?.filters).toBeNull();
    expect(old?.byButton).toBeNull();
    expect(readVisitors({ error: "x" })).toBeNull();
    expect(readVisitors(null)).toBeNull();
  });

  it("asks for version families and sends only the filters that are set", () => {
    expect(visitorsPath("lark", "30d", NO_FILTERS)).toBe(
      "/admin/analytics/visitors?customer_id=lark&window=30d&version_by=source",
    );
    expect(visitorsPath("lark", "7d", { ...NO_FILTERS, country: "GB", version: "*:ai" })).toBe(
      "/admin/analytics/visitors?customer_id=lark&window=7d&version_by=source&country=GB&version=*%3Aai",
    );
  });

  it("the address carries the period and the filters (a link lands filtered)", () => {
    const q = new URLSearchParams("window=90d&country=GB&page=%2Fcontact");
    expect(filtersFromQuery(q)).toEqual({
      window: "90d",
      filters: { ...NO_FILTERS, country: "GB", page: "/contact" },
    });
    expect(filtersFromQuery(new URLSearchParams("window=1y")).window).toBe("30d");
  });

  it("a click sets a row, a second click clears it; a source and a platform name exclude each other", () => {
    const f = toggle(NO_FILTERS, "country", "GB");
    expect(f.country).toBe("GB");
    expect(toggle(f, "country", "GB").country).toBeNull();
    const n = toggle({ ...NO_FILTERS, source: "ai" }, "name", "chatgpt");
    expect(n).toEqual({ ...NO_FILTERS, name: "chatgpt" });
    expect(toggle(n, "source", "social")).toEqual({ ...NO_FILTERS, source: "social" });
  });

  it("words: country from the code, versions by where their visitors came from", () => {
    expect(countryName("GB")).toBe("United Kingdom");
    expect(countryName(null)).toBe("Not recorded");
    expect(countryName("other")).toBe("Other or unknown");
    expect(versionLabel({ version: "*:ai", kind: "version", source_dim: "ai" })).toBe(
      "AI chat version",
    );
    expect(versionLabel({ version: "problem:ai", kind: "version" })).toBe(
      "AI chat version, has a problem",
    );
    expect(versionLabel({ version: "original", kind: "original" })).toBe(
      "Your page, kept for the test",
    );
  });
});

describe("the sentence", () => {
  const a = readVisitors(RAW);
  if (!a) throw new Error("fixture");

  it("unfiltered: the period, the visits, the clicks, the best source past 30 visits", () => {
    expect(summaryFor(a, NO_FILTERS, "30d")).toEqual({
      lead: "In the last 30 days, 2,140 visits and 61 clicked a button that counts.",
      tail: "Visitors from AI chats clicked most often, 4.6%.",
    });
  });

  it("filtered to the UK: visits, clicks, most on which version", () => {
    const uk = readVisitors({
      ...RAW,
      totals: c(578, 20),
      filters: { ...RAW.filters, country: "GB" },
    });
    if (!uk) throw new Error("fixture");
    expect(summaryFor(uk, { ...NO_FILTERS, country: "GB" }, "30d")).toEqual({
      lead: "In United Kingdom: 578 visits, 20 clicked, most on the Social version.",
      tail: "3.5% click rate.",
    });
  });

  it("filtered to a version: who saw it, most from which source", () => {
    const s = summaryFor(a, { ...NO_FILTERS, version: "*:social" }, "30d");
    expect(s.lead).toBe("Saw the Social version: 2,140 visits, 61 clicked, most from Search.");
  });
});

describe("the panels and the matrix", () => {
  const a = readVisitors(RAW);
  if (!a) throw new Error("fixture");

  it("countries by code; not recorded filters as `none`; folded pages are not clickable", () => {
    expect(countryRows(a).map((r) => [r.key, r.label, r.code])).toEqual([
      ["GB", "United Kingdom", "GB"],
      ["US", "United States", "US"],
      ["none", "Not recorded", null],
    ]);
    const pages = pageRows(a);
    expect(pages.map((p) => p.label)).toEqual(["Home", "/contact", "4 other pages"]);
    expect(pages[1]?.sub).toBe("No versions on this page");
    expect(pages[2]?.still).toBe(true);
    expect(versionRows(a).map((v) => v.label)).toEqual([
      "Your page, no version",
      "Search version",
      "Social version",
      "Your page, kept for the test",
    ]);
  });

  it("country by version: family columns, the dot on most clicks, a cell filters by its version", () => {
    const m = countryMatrix(a);
    expect(m.columns.map((x) => x.label)).toEqual(["Social", "Search", "Test", "No version"]);
    const gb = m.rows[0];
    expect(gb?.best).toBe("k:social");
    expect(gb?.cells["k:social"]).toEqual({ visits: 120, conversions: 7, version: "*:social" });
    expect(m.rows[2]?.country).toBeNull();
  });

  it("days for 30 days, weeks for 90", () => {
    expect(chartBuckets(a)).toHaveLength(30);
    expect(chartBuckets(a)[0]?.label).toBe("4 Oct");
    const q = readVisitors({
      ...RAW,
      window: "90d",
      series: {
        bucket: "day",
        points: Array.from({ length: 90 }, (_, i) => ({ start: START + i * DAY, ...c(1, 0) })),
      },
    });
    expect(q && chartBuckets(q)).toHaveLength(13);
  });
});

describe("the view", () => {
  const a = readVisitors(RAW);
  if (!a) throw new Error("fixture");
  const render = (filters = NO_FILTERS, ans = a) =>
    renderToStaticMarkup(
      h(VisitorsView, {
        a: ans,
        window: "30d",
        filters,
        onWindow: () => undefined,
        onSet: () => undefined,
        testHref: "/test",
      }),
    );

  it("the mock's order and words", () => {
    const t = text(render());
    const order = [
      "Visitors",
      "All visitors",
      "In the last 30 days",
      "Page views",
      "Click rate",
      "What these numbers mean",
      "Where visits came from, and what they did",
      "Where they came from",
      "Country",
      "Pages they viewed",
      "Version they saw",
      "Who clicked what",
      "Country by version",
    ];
    let at = 0;
    for (const w of order) {
      const i = t.indexOf(w, at);
      expect(i, w).toBeGreaterThanOrEqual(0);
      at = i;
    }
    expect(t).toContain("Book a call 40 Search 12 United Kingdom 15 Social version 11");
    expect(t).toMatch(/[–—]/.source ? /^[^–—]*$/ : /.*/);
  });

  it("the period switch, four choices, 30d pressed", () => {
    const html = render();
    for (const w of ["24h", "7d", "30d", "90d"]) expect(html).toContain(`>${w}</button>`);
    expect(html).toMatch(/aria-pressed="true"[^>]*>30d</);
  });

  it("a filter shows as a chip, its row pressed, the others dimmed", () => {
    const html = render({ ...NO_FILTERS, country: "GB" });
    const t = text(html);
    expect(t).toContain("Showing United Kingdom");
    expect(t).toContain("Clear");
    expect(html).toContain('aria-label="Remove filter United Kingdom"');
    expect(html).toMatch(/aria-pressed="true"[^>]*data-row="GB"/);
  });

  it("no Who clicked what from a worker without it; country off says so", () => {
    const old = readVisitors({ ...RAW, by_button: undefined, country_recording: "off" });
    if (!old) throw new Error("fixture");
    const t = text(render(NO_FILTERS, old));
    expect(t).not.toContain("Who clicked what");
    expect(t).toContain("Country is off for your site, so new visits have none.");
  });

  it("buyer words only", () => {
    const t = text(render()).toLowerCase();
    for (const w of ["intent", "cohort", "holdout", "manifest", "variant", "session id"]) {
      expect(t).not.toContain(w);
    }
  });
});

describe("came back under a source (ADR 0039)", () => {
  const people = {
    people: 40,
    new: 30,
    returning: 10,
    returning_visits: 14,
    given_back: { organic: 6, answer: 2 },
    converted: 4,
    converted_returning: 1,
  };
  it("names the return visits a source holds, beside its platforms", () => {
    const a = readVisitors({ ...RAW, people });
    const organic = sourceRows(a as never).find((r) => r.key === "organic");
    expect(organic?.sub).toBe("Google · 6 came back");
    expect(sourceRows(a as never).find((r) => r.key === "none")?.sub).not.toContain("came back");
  });
  it("says nothing under a filter, and nothing on a worker without the block", () => {
    const filtered = readVisitors({
      ...RAW,
      people,
      filters: { country: "AZ", source: null, name: null, version: null, page: null },
    });
    expect(sourceRows(filtered as never).find((r) => r.key === "organic")?.sub).toBe("Google");
    const old = readVisitors(RAW);
    expect(sourceRows(old as never).find((r) => r.key === "organic")?.sub).toBe("Google");
  });
});
