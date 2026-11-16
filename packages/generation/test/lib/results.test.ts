/**
 * The Results page's gates (docs/specs/results-data.md §2, §3, §4): when a
 * change may be shown, which claims the lead sentence may make, which pages
 * are listed. Pure functions over counts.
 */
import { normalizePath } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import {
  MARKER_LIFE_MS,
  buildPerSource,
  changeOf,
  pickLead,
  previousComparable,
  selectPages,
  sourceRow,
} from "../../src/lib/results.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-14T12:00:00Z");

describe("previousComparable", () => {
  it("1h, 24h and 7d compare; 30d does not (the marker lives 31 days)", () => {
    for (const w of [DAY / 24, DAY, 7 * DAY])
      expect(previousComparable(NOW - 2 * w, NOW)).toBe(true);
    expect(previousComparable(NOW - 60 * DAY, NOW)).toBe(false);
    expect(previousComparable(NOW - MARKER_LIFE_MS, NOW)).toBe(true);
    expect(previousComparable(NOW - MARKER_LIFE_MS - 1, NOW)).toBe(false);
  });
});

describe("changeOf", () => {
  it("needs 30 visits before (10 for conversions) and never divides by zero", () => {
    expect(changeOf(40, 30)).toBeCloseTo(1 / 3, 10);
    expect(changeOf(40, 29)).toBeNull();
    expect(changeOf(3, 1)).toBeNull(); // never "+200%" on three visits
    expect(changeOf(5, null)).toBeNull();
    expect(changeOf(12, 10, 10)).toBeCloseTo(0.2, 10);
    expect(changeOf(12, 9, 10)).toBeNull();
    expect(changeOf(0, 0, 0)).toBeNull();
  });
});

describe("buildPerSource", () => {
  const rows = [
    { cohort: "personalized", source_dim: "ai", visits: 10, conversions: 2 },
    { cohort: "holdout", source_dim: "ai", visits: 3, conversions: 1 },
    { cohort: "skipped", source_dim: "ai", visits: 2, conversions: 0 },
    { cohort: "no_signal", source_dim: null, visits: 50, conversions: 4 },
    { cohort: "personalized", source_dim: null, visits: 1, conversions: 0 },
    { cohort: "personalized", source_dim: "organic", visits: 15, conversions: 1 },
  ];

  it("sums the signal cohorts per source; no_signal and sourceless rows are in no source", () => {
    expect(buildPerSource(rows, null)).toEqual([
      { source_dim: "ai", visits: 15, conversions: 3, prev_visits: null, prev_conversions: null },
      {
        source_dim: "organic",
        visits: 15,
        conversions: 1,
        prev_visits: null,
        prev_conversions: null,
      },
    ]);
  });

  it("a source only in the period before keeps a row at 0", () => {
    const out = buildPerSource(rows, [
      { cohort: "personalized", source_dim: "paid", visits: 4, conversions: 0 },
    ]);
    expect(out.find((r) => r.source_dim === "paid")).toEqual({
      source_dim: "paid",
      visits: 0,
      conversions: 0,
      prev_visits: 4,
      prev_conversions: 0,
    });
    expect(out.find((r) => r.source_dim === "ai")?.prev_visits).toBe(0);
  });
});

describe("pickLead", () => {
  const row = (source_dim: string, visits: number, conversions: number, prev: number | null) =>
    sourceRow({
      source_dim,
      visits,
      conversions,
      prev_visits: prev,
      prev_conversions: prev === null ? null : 0,
    });

  it("the mock's own numbers do not carry 'more often than any other group'", () => {
    // AI 106 of 840 (12.6%) against Came straight 82 of 680 (12.1%):
    // AI's Wilson lower bound (about 10.5%) is under 12.1%.
    const lead = pickLead(
      [
        row("organic", 2310, 182, 2180),
        row("social", 1620, 123, 1460),
        row("ai", 840, 106, 609),
        row("direct", 680, 82, 624),
        row("community", 610, 56, 693),
        row("paid", 380, 34, 373),
      ],
      { visits: 5640, conversions: 406 },
      12080,
    );
    expect(lead.top_rate).toBeNull();
    expect(lead.grower?.source_dim).toBe("ai");
    expect(lead.grower?.visits_change).toBeCloseTo(840 / 609 - 1, 10);
    expect(lead.signal_visits).toBe(6440);
  });

  it("a clear leader is named with its range and the group behind it", () => {
    const lead = pickLead(
      [row("ai", 400, 80, null), row("organic", 1000, 70, null)],
      { visits: 2000, conversions: 120 },
      3400,
    );
    expect(lead.top_rate).toMatchObject({
      group: "ai",
      rate: 0.2,
      next_group: "organic",
      next_rate: 0.07,
    });
    expect(lead.top_rate?.low).toBeGreaterThan(0.07);
    expect(lead.grower).toBeNull(); // no comparable period
  });

  it("no rate claim under 10 converting visits, nor against groups under 30 visits", () => {
    const few = pickLead(
      [row("ai", 40, 9, null), row("organic", 300, 3, null)],
      { visits: 0, conversions: 0 },
      340,
    );
    expect(few.top_rate).toBeNull();
    // the only other group has 29 visits: nothing to compare with
    const alone = pickLead(
      [row("ai", 400, 80, null), row("organic", 29, 0, null)],
      { visits: 0, conversions: 0 },
      429,
    );
    expect(alone.top_rate).toBeNull();
  });

  it("Unknown can lead too, and a fall is never the grower", () => {
    const lead = pickLead(
      [row("ai", 200, 2, 300), row("organic", 200, 4, 250)],
      { visits: 500, conversions: 100 },
      900,
    );
    expect(lead.top_rate?.group).toBe("unknown");
    expect(lead.grower).toBeNull();
  });
});

describe("selectPages", () => {
  const page = (page_path: string, visits: number, signal_visits: number) => ({
    page_path,
    visits,
    signal_visits,
    written_visits: 0,
    skipped_visits: signal_visits,
  });

  it("five of each kind at most, by signal visits, from 5 visits up", () => {
    const counted = [
      ...Array.from({ length: 7 }, (_, i) => page(`/no-${i}`, 50, 40 - i)),
      ...Array.from({ length: 7 }, (_, i) => page(`/yes-${i}`, 50, 30 - i)),
      page("/tiny", 4, 4),
    ];
    const versioned = new Set(Array.from({ length: 7 }, (_, i) => `/yes-${i}`));
    const out = selectPages(counted, versioned, normalizePath);
    expect(out.filter((p) => !p.has_versions).map((p) => p.page_path)).toEqual([
      "/no-0",
      "/no-1",
      "/no-2",
      "/no-3",
      "/no-4",
    ]);
    expect(out.filter((p) => p.has_versions)).toHaveLength(5);
    expect(out.some((p) => p.page_path === "/tiny")).toBe(false);
  });

  it("spellings of one page are one page", () => {
    const out = selectPages([page("//docs", 3, 1), page("/docs", 3, 2)], new Set(), normalizePath);
    expect(out).toEqual([
      {
        page_path: "/docs",
        visits: 6,
        signal_visits: 3,
        written_visits: 0,
        skipped_visits: 3,
        has_versions: false,
      },
    ]);
  });
});
