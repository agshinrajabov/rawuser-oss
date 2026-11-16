/**
 * The Results mock's traffic for a prospect's site (design/mock/sales-readiness/
 * results-page.html): 12,080 visits in 30 days, 53% with a source, as the
 * overview, breakdown, timeseries and manifest answers. Used by
 * results.test.ts and by the browser check of /analytics. The 7-day answers
 * are the comparable period, with a change on every row; the 30-day ones
 * have none (the period before is not comparable, results-data.md §2).
 */

import type {
  AnalyticsBreakdown,
  AnalyticsOverview,
  AnalyticsTimeseries,
  ManifestResponse,
  SourceBreakdownRow,
} from "../../src/types/api";

const NOW = Date.parse("2026-10-02T15:00:00Z");
const DAY = 86_400_000;

function row(
  source_dim: string,
  visits: number,
  conversions: number,
  visits_change: number | null,
  names?: [string, number][],
): SourceBreakdownRow {
  return {
    source_dim,
    visits,
    conversions,
    rate: visits ? conversions / visits : null,
    prev_visits: visits_change === null ? null : Math.round(visits / (1 + visits_change)),
    prev_conversions: visits_change === null ? null : conversions,
    visits_change,
    ...(names
      ? {
          names: names.map(([label, v]) => ({
            name: label.toLowerCase().replace(/ /g, "-"),
            label,
            visits: v,
            conversions: Math.round(v * (conversions / visits)),
          })),
        }
      : {}),
  };
}

export const OVERVIEW_30D: AnalyticsOverview = {
  customer_id: "brisk",
  window: "30d",
  computed_at: NOW - 12 * 60_000,
  period: { start: NOW - 30 * DAY, end: NOW },
  comparison: { previous: { start: NOW - 60 * DAY, end: NOW - 30 * DAY }, comparable: false },
  previous: null,
  cohorts: {
    personalized: { visits: 4984, conversions: 468, cr: 468 / 4984 },
    holdout: { visits: 1046, conversions: 82, cr: 82 / 1046 },
    no_signal: { visits: 5640, conversions: 406, cr: 406 / 5640, dark_social_probable: 1410 },
    skipped: { visits: 410, conversions: 33, cr: 33 / 410 },
  },
  hero: {
    holdout_lift: { value: 0.19, ci_lower: -0.05, ci_upper: 0.5, significance: "not_yet" },
    natural_lift: { value: 0.31, ci_lower: 0.18, ci_upper: 0.45, significance: "sig_99" },
    total_visits: 12080,
    total_conversions: 989,
  },
  delta: { vs_previous_period_visits_pct: null, vs_previous_period_conversions_pct: null },
};

export const OVERVIEW_7D: AnalyticsOverview = {
  ...OVERVIEW_30D,
  window: "7d",
  period: { start: NOW - 7 * DAY, end: NOW },
  comparison: { previous: { start: NOW - 14 * DAY, end: NOW - 7 * DAY }, comparable: true },
  previous: {
    total_visits: 2480,
    total_conversions: 200,
    signal_visits: 1310,
    signal_conversions: 120,
    no_signal_visits: 1170,
    no_signal_conversions: 80,
  },
  cohorts: {
    personalized: { visits: 1170, conversions: 110, cr: 110 / 1170 },
    holdout: { visits: 246, conversions: 19, cr: 19 / 246 },
    no_signal: { visits: 1320, conversions: 95, cr: 95 / 1320, dark_social_probable: 330 },
    skipped: { visits: 96, conversions: 8, cr: 8 / 96 },
  },
  hero: {
    ...OVERVIEW_30D.hero,
    natural_lift: { value: null, ci_lower: null, ci_upper: null, significance: "not_yet" },
    total_visits: 2832,
    total_conversions: 232,
  },
  delta: { vs_previous_period_visits_pct: 0.12, vs_previous_period_conversions_pct: 0.16 },
};

const BY_TUPLE = [
  ["problem", "organic", 1340, 103],
  ["feature", "organic", 554, 46],
  ["brand", "organic", 416, 33],
  ["brand", "social", 794, 56],
  ["problem", "social", 502, 40],
  ["feature", "social", 324, 27],
  ["competitor", "ai", 344, 48],
  ["problem", "ai", 311, 37],
  ["evaluation", "ai", 185, 21],
  ["pricing", "direct", 430, 56],
  ["feature", "direct", 250, 26],
  ["feature", "community", 433, 41],
  ["problem", "community", 110, 10],
  ["brand", "community", 67, 5],
  ["pricing", "paid", 209, 19],
  ["competitor", "paid", 114, 10],
  ["feature", "paid", 57, 5],
].map(([intent_dim, source_dim, visits, conversions]) => ({
  intent_dim: intent_dim as string,
  source_dim: source_dim as string,
  visits: visits as number,
  conversions: conversions as number,
}));

export const BREAKDOWN_30D: AnalyticsBreakdown = {
  by_intent: [],
  by_tuple: BY_TUPLE,
  period: OVERVIEW_30D.period,
  comparison: OVERVIEW_30D.comparison,
  by_source: [
    row("organic", 2310, 182, null, [
      ["Google", 2120],
      ["Bing", 140],
      ["DuckDuckGo", 50],
    ]),
    row("social", 1620, 123, null, [
      ["LinkedIn", 760],
      ["X", 430],
      ["Instagram", 260],
      ["Facebook", 170],
    ]),
    row("ai", 840, 106, null, [
      ["ChatGPT", 590],
      ["Perplexity", 130],
      ["Claude", 70],
      ["Gemini", 35],
    ]),
    row("direct", 680, 82, null),
    row("community", 610, 56, null, [
      ["Hacker News", 280],
      ["Reddit", 210],
      ["Indie Hackers", 120],
    ]),
    row("paid", 380, 34, null, [["Google Ads", 380]]),
  ],
  unknown: {
    visits: 5640,
    conversions: 406,
    rate: 406 / 5640,
    prev_visits: null,
    prev_conversions: null,
    visits_change: null,
    dark_social_probable: 1410,
  },
  // At these numbers the top rate does not clear the next group (results-data.md §3).
  lead: { signal_visits: 6440, total_visits: 12080, grower: null, top_rate: null },
  pages: {
    pages: [
      {
        page_path: "/",
        visits: 9100,
        signal_visits: 4900,
        written_visits: 3900,
        skipped_visits: 120,
        has_versions: true,
      },
      {
        page_path: "/docs",
        visits: 610,
        signal_visits: 290,
        written_visits: 0,
        skipped_visits: 290,
        has_versions: false,
      },
      {
        page_path: "/changelog",
        visits: 240,
        signal_visits: 80,
        written_visits: 0,
        skipped_visits: 80,
        has_versions: false,
      },
    ],
    without_versions: { pages: 4, visits: 910, signal_visits: 410 },
  },
  tagged: {
    visits: 1150,
    conversions: 113,
    rate: 113 / 1150,
    prev_visits: null,
    prev_conversions: null,
    visits_change: null,
  },
};

/** The same 30 days from a row written before N1 and N3: no names, no tagged row. */
export const BREAKDOWN_30D_PLAIN: AnalyticsBreakdown = {
  ...BREAKDOWN_30D,
  by_source: (BREAKDOWN_30D.by_source ?? []).map(({ names: _n, ...r }) => r),
  tagged: undefined,
};

export const BREAKDOWN_7D: AnalyticsBreakdown = {
  by_intent: [],
  by_tuple: BY_TUPLE.map((t) => ({
    ...t,
    visits: Math.round(t.visits * 0.235),
    conversions: Math.round(t.conversions * 0.235),
  })),
  period: OVERVIEW_7D.period,
  comparison: OVERVIEW_7D.comparison,
  by_source: [
    row("organic", 542, 43, 0.06),
    row("social", 381, 29, 0.11),
    row("ai", 212, 28, 0.38),
    row("direct", 160, 19, 0.09),
    row("community", 125, 11, -0.12),
    row("paid", 92, 8, 0.02),
  ],
  unknown: {
    visits: 1320,
    conversions: 95,
    rate: 95 / 1320,
    prev_visits: 1128,
    prev_conversions: 80,
    visits_change: 0.17,
    dark_social_probable: 330,
  },
  lead: {
    signal_visits: 1512,
    total_visits: 2832,
    grower: { source_dim: "ai", visits_change: 0.38 },
    top_rate: {
      group: "ai",
      rate: 28 / 212,
      low: 0.093,
      high: 0.184,
      next_group: "direct",
      next_rate: 19 / 160,
    },
  },
  pages: null,
};

export const TIMESERIES: AnalyticsTimeseries = {
  customer_id: "brisk",
  computed_at: NOW,
  series: Array.from({ length: 30 }, (_, i) => {
    const date = new Date(NOW - (29 - i) * DAY).toISOString().slice(0, 10);
    const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    const visits = Math.round((weekend ? 270 : 420) + 40 * Math.sin(i * 1.7));
    return { date, visits, conversions: Math.round(visits * (0.075 + 0.015 * Math.cos(i))) };
  }),
};

function manifest(page_path: string, missing: string[]): ManifestResponse {
  return {
    customer_id: "brisk",
    page_path,
    manifest: {},
    source_url: `https://brisk.test${page_path}`,
    generated_at: 0,
    confirmed_at: 1,
    cost_usd: 0,
    status: "confirmed",
    missing_parts: missing,
  };
}

export const MANIFESTS: ManifestResponse[] = [
  manifest("/", ["hero.body"]),
  manifest("/pricing", []),
];
