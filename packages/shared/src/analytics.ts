/**
 * The Results page's reads (docs/specs/results-data.md): the period and its
 * comparison, visits per source with the period before (N2), pages without
 * versions (N4) and the gated claims of the lead sentence.
 *
 * Built by packages/generation/src/admin/analytics.ts from
 * analytics_aggregates, read by the dashboard. Counts per customer and
 * window only; nothing about a visitor. Every count is a visit count. Every
 * rate is a fraction (0.082 is 8.2%), every change a relative one (0.38 is
 * +38%), every time unix ms.
 *
 * N1 (`SourceBreakdownRow.names`) and N3 (`ResultsBreakdownFields.tagged`)
 * since migration 0035, privacy review conditional pass 2026-10-04;
 * absent on rows written before it.
 */

/** The window a row counts: (start, end], unix ms. */
export interface AnalyticsPeriod {
  start: number;
  end: number;
}

/**
 * The period before, same length, and whether a change against it may be
 * shown. `comparable` is false when the period before starts more than 31
 * days back: the visit marker is gone there, so its rows count one per page
 * and cannot be set against visits (the 30-day window, today).
 */
export interface AnalyticsComparison {
  previous: AnalyticsPeriod;
  comparable: boolean;
}

/**
 * One named source inside a row (N1, privacy review conditional pass
 * 2026-10-04). Only with 5 visits or more in the window; smaller counts stay
 * in the row's total.
 */
export interface SourceNameCount {
  /** A word from SOURCE_NAMES ("chatgpt", "hacker-news"), never a host. */
  name: string;
  /** How the dashboard writes it ("ChatGPT", "Hacker News"). */
  label: string;
  visits: number;
  conversions: number;
}

/** One row of "Where they came from": visits with a signal, per source. */
export interface SourceBreakdownRow {
  /** ai, social, community, paid, organic, direct. */
  source_dim: string;
  /** Visits with this source: written, held out for the test, or kept as built. */
  visits: number;
  /** Of them, visits that clicked a confirmed button. */
  conversions: number;
  /** conversions / visits; null at 0 visits. */
  rate: number | null;
  /** The period before; null when it is not comparable. */
  prev_visits: number | null;
  prev_conversions: number | null;
  /** (visits - prev) / prev; null unless comparable with 30 visits before. */
  visits_change: number | null;
  /** N1, named sources inside the row, most visits first; absent on rows before migration 0035. */
  names?: SourceNameCount[];
}

/** The Unknown row: visits that told us nothing and saw the original. */
export interface UnknownRow {
  visits: number;
  conversions: number;
  rate: number | null;
  prev_visits: number | null;
  prev_conversions: number | null;
  visits_change: number | null;
  /** Of them, visits that look like a link opened in a chat app (L2 Layer D). */
  dark_social_probable: number;
}

/**
 * The lead sentence's two claims, each null when the numbers do not carry
 * it. The dashboard words the sentence; it never makes a claim this omits.
 */
export interface ResultsLead {
  /** Visits that told us where they came from (the signal cohorts). */
  signal_visits: number;
  total_visits: number;
  /** The source with the largest positive visits change; changes need 30 visits before. */
  grower: { source_dim: string; visits_change: number } | null;
  /**
   * The group with the highest click rate, among groups with 30 visits, only
   * when it has 10 converting visits and its Wilson 95% lower bound is above
   * the next group's rate. `group` is a source_dim or "unknown". Different
   * people: who clicks, never what the versions did.
   */
  top_rate: {
    group: string;
    rate: number;
    low: number;
    high: number;
    next_group: string;
    next_rate: number;
  } | null;
}

/** One page of the site in the period (N4). */
export interface PageRow {
  /** Normalized: lowercase, no query, no trailing slash except "/". */
  page_path: string;
  /** Visits with a page view here (a visit on two pages counts on each). */
  visits: number;
  /** Of them, visits that told us where they came from. */
  signal_visits: number;
  /** Visits that saw a version here (on a page without its own, the homepage's words). */
  written_visits: number;
  /** Visits with a signal whose page was kept as built (a part not found, late, split). */
  skipped_visits: number;
  /** The page has its own confirmed manifest now, so its versions are written from it. */
  has_versions: boolean;
  /**
   * Only for a sensitive customer (docs/specs/sensitive-customers.md): the
   * row is a group of pages (`/products/:item`, `/:item`), never one page.
   * Its counts are distinct visits across the group's pages. A group has no
   * versions and carries no `lp_visits`. Absent on every other row.
   */
  group?: true;
}

/**
 * One page in the daily counter of a sensitive customer: loads, not visits
 * (the counter holds no visit marker, so two loads of one visit are two).
 */
export interface PageLoadRow {
  /** A page of the site, or a group's path where a day was folded. */
  page_path: string;
  /** Page loads on the counted days. */
  loads: number;
  has_versions: boolean;
  /**
   * The row is a group (`/products/:item`): loads of days on which the
   * group was under a floor (fewer than three of its pages opened, or fewer
   * than five distinct visits behind it), kept without the page.
   */
  group?: true;
}

/**
 * The daily counter of a sensitive customer over a period
 * (docs/specs/sensitive-customers.md, condition 4). Loads per page with no
 * visit marker, source, intent, arm or time of day. Whole UTC days only: the
 * closed days that end inside the period, each only once its fold has run,
 * never the current day. A period shorter than a day has none.
 */
export interface PageLoads {
  /** The first and last UTC day asked for, 'YYYY-MM-DD'; null for a period shorter than a day. */
  from: string | null;
  to: string | null;
  /** How many of those days hold counted loads. 0: nothing to show yet. */
  days: number;
  /** Up to twenty rows, most loads first. No floor: the site's owner sees its own pages. */
  pages: PageLoadRow[];
  /** Every counted row: named pages, all loads, and the loads kept only under a group. */
  total: { pages: number; loads: number; grouped_loads: number };
  /** The same for pages without versions of their own (a group never has any). */
  without_versions: { pages: number; loads: number; grouped_loads: number };
}

/**
 * One page group (docs/specs/page-groups.md, phase 1) as the aggregator
 * counts it: a pattern of the customer's own site, `/products/*`, never an
 * example path. `pages`: distinct masked paths one segment under the fixed
 * part with a visit in the period, not confirmed pages. `visits`: distinct
 * visits across them (for a sensitive customer, the visits behind the kept
 * section's group on the counter's folded days). A pattern is proposed with
 * 5 pages; an accepted pattern is listed whatever its count.
 */
export interface PageGroupRow {
  pattern: string;
  pages: number;
  visits: number;
  /** On the breakdown only: the pattern is in `page_groups`. Else it is a proposal. */
  accepted?: boolean;
}

export interface PagesBreakdown {
  /** Up to five pages without versions and five with, by signal_visits; at least 5 visits each. */
  pages: PageRow[];
  /**
   * Every page without its own versions: how many, and distinct visits
   * across them. For a sensitive customer `pages` is read from the daily
   * counter (`counter.without_versions.pages`: named pages on the counted
   * days, 0 while `counter.days` is 0) and the two visit counts stay what
   * they are for everyone, read from the stored paths.
   */
  without_versions: { pages: number; visits: number; signal_visits: number };
  /** Only for a sensitive customer: per-page loads from the daily counter. */
  counter?: PageLoads;
  /**
   * N4.1 (docs/specs/page-groups.md): the accepted groups and the proposed
   * ones, accepted first, then by visits. Absent when there is none.
   */
  groups?: PageGroupRow[];
}

/**
 * N3, visits on the customer's own tagged links (any utm_* parameter except
 * a platform's own auto-tag, such as ChatGPT's utm_source=chatgpt.com).
 * Already counted in the source rows. Absent on rows before migration 0035.
 */
export interface TaggedLinks {
  visits: number;
  conversions: number;
  rate: number | null;
  prev_visits: number | null;
  prev_conversions: number | null;
  visits_change: number | null;
}

/** What the previous period held, like-for-like with the overview's totals. */
export interface PreviousTotals {
  total_visits: number;
  total_conversions: number;
  /** Personalized, holdout and skipped cohorts. */
  signal_visits: number;
  signal_conversions: number;
  no_signal_visits: number;
  no_signal_conversions: number;
}

/** Fields GET /admin/analytics/overview adds for the Results page. */
export interface ResultsOverviewFields {
  period: AnalyticsPeriod;
  comparison: AnalyticsComparison;
  /** Null when the period before is not comparable, or on a row written before 2026-10-04. */
  previous: PreviousTotals | null;
}

/** Fields GET /admin/analytics/breakdown adds for the Results page. */
export interface ResultsBreakdownFields {
  period: AnalyticsPeriod;
  comparison: AnalyticsComparison;
  /** By visits, largest first. Empty on a row written before migration 0034. */
  by_source: SourceBreakdownRow[];
  unknown: UnknownRow;
  lead: ResultsLead;
  /** Null on a row written before migration 0034. */
  pages: PagesBreakdown | null;
  /** N3. Absent on rows written before migration 0035. */
  tagged?: TaggedLinks;
}

// ---------------------------------------------------------------------------
// The free AI-traffic audit (docs/specs/ai-traffic-audit.md §5, §12, §17)
// ---------------------------------------------------------------------------

/**
 * A count in the frozen report: 0 ("None seen"), a number of 5 or more, or
 * "<5" ("fewer than 5"). Only the header's total is always a number.
 */
export type AuditCount = number | "<5";

/** A share of the window's visits: full state only, and only for a count of 5 or more. */
export interface AuditShare {
  /** Whole percent, rounded; 0 when `under_one`. */
  pct: number;
  /** Under 1%: "under 1%". */
  under_one: boolean;
  /** The Wilson 95% range in whole percents, rounded outward ("How sure"). */
  low: number;
  high: number;
}

/** The report's groups, in the order of the table (§4.3). */
export type AuditGroupKey =
  | "ai"
  | "social"
  | "community"
  | "search"
  | "ads"
  | "other"
  | "none"
  | "language";

/** A platform name inside a group, 5 visits or more. `label` is the display word. */
export interface AuditName {
  name: string;
  label: string;
  visits: number;
}

export interface AuditGroup {
  key: AuditGroupKey;
  visits: AuditCount;
  share: AuditShare | null;
  /** Names over the floor, most first; the rest is `other`. */
  names: AuditName[];
  /** The group's visits under no listed name; null when no name is listed. */
  other: AuditCount | null;
  /** `none` only: visits whose first page looked like a link from a phone app ("probably"). */
  probably?: AuditCount;
}

export interface AuditLandingList {
  visits: AuditCount;
  /** Up to five masked paths with 5 visits or more in this list's group. */
  pages: Array<{ path: string; visits: number }>;
  /** The rest of the group's visits. */
  other: AuditCount;
}

export interface AuditAnswers {
  /** "AI assistants sent about N% of your visits." */
  ai: {
    visits: AuditCount;
    share: AuditShare | null;
    names: AuditName[];
    other: AuditCount | null;
  };
  /** "Links opened inside apps": social and chat visits found through an app, plus "probably". */
  in_app: { visits: AuditCount; share: AuditShare | null; named: AuditCount; probably: AuditCount };
  /** "N visits came from inside an app with no referrer and no tags" (found_by app_marker). */
  no_referrer: { visits: AuditCount; share: AuditShare | null };
}

/** One part of the sample: the page's own words and the version's, `*phrase*` marking emphasis. */
export interface AuditSamplePart {
  page: string | null;
  version: string | null;
  /** The page's word-split template (inline.template), for the template renderer; else absent. */
  template?: string;
}

export interface AuditSample {
  /** "saw": served in the window; "would_see": nothing was, the ChatGPT link to the homepage. */
  form: "saw" | "would_see";
  /** Whose visitors: a platform name, or a group when no name passed the floor. */
  source: { kind: "name"; name: string; label: string } | { kind: "group"; group: AuditGroupKey };
  page_path: string;
  body_id: string | null;
  /** Where the page's own words came from: the page's HTML, or the manifest's text signatures. */
  page_from: "page" | "signature";
  /** "One of N versions written for your site." */
  versions_total: number;
  headline: AuditSamplePart;
  body: AuditSamplePart;
  cta: AuditSamplePart;
}

/** "What the versions did", the state at build time (§5.3). Never a natural or an interim lift. */
export type AuditTestLine =
  | { state: "no_button" }
  | { state: "off" }
  | {
      state: "too_early";
      /** Visits with a version the first honest read needs, rounded up to a hundred. */
      visits_needed: number | null;
      /** Weeks at the window's own traffic, rounded up ("about"). */
      weeks: number | null;
    }
  | {
      state: "result";
      /** The Results sentence, word for word. */
      sentence: string;
      lift: { value: number; low: number; high: number };
      labels: string[];
    }
  | { state: "low_traffic" }
  | { state: "checking" };

/** The frozen report. Counts over floors and the customer's own copy only: no row, marker or contact. */
export interface AuditReport {
  v: 1;
  domain: string;
  /** [start, end), unix ms. */
  window: { start: number; end: number };
  built_at: number;
  /** full: 300 visits or more; counts: 30 to 299; too_few: under 30 (§5.5). */
  state: "full" | "counts" | "too_few";
  visits: number;
  /** Null when too_few. */
  answers: AuditAnswers | null;
  /** Empty when too_few; adds up to `visits` (the "language" group only when not empty). */
  groups: AuditGroup[];
  /** Null when too_few. */
  landing: { ai: AuditLandingList; no_referrer: AuditLandingList; all: AuditLandingList } | null;
  /** Always present once any version exists; null only with no version written at all. */
  sample: AuditSample | null;
  versions_did: AuditTestLine;
  /** Visits with a version made for why they came (a personalized exposure). */
  saw_version: AuditCount;
  test_running: boolean;
  /** The prospect ticked the banner box: the banner line goes in "What this cannot see". */
  consent_banner: boolean;
  /**
   * Versions written of their total when counting began. Short of the total
   * only when the window started 48 hours after go live without them all
   * (spec §17.5): then say "N of M versions were written when counting
   * began." Null on a report without the record.
   */
  versions_at_start: { written: number; total: number } | null;
}

/** One check the builder ran, for the founder's review (§11.7). */
export interface AuditCheck {
  id: "adds_up" | "floors" | "sample" | "page_read" | "no_lift";
  ok: boolean;
  line: string;
}

/** The superadmin's facts beside the snapshot; never in the public report. */
export interface AuditReview {
  /** Rows in the window without a visit marker, each counted as its own visit. */
  no_marker_rows: number;
  rows: number;
  checks: AuditCheck[];
}

/** Where an audit stands, for the Audit page and the superadmin rows. No number by source. */
export type AuditStage =
  | "before_go_live"
  | "writing"
  | "counting"
  | "checking"
  | "ready"
  | "ended"
  | "lapsed"
  | "pilot";

export interface AuditStatus {
  customer_id: string;
  domain: string;
  plan: string;
  stage: AuditStage;
  signed_up_at: number;
  live_at: number | null;
  /** Unix ms; null before the window starts. */
  window_start: number | null;
  window_end: number | null;
  extended: boolean;
  /** Day of the window (1-based) while counting; null otherwise. */
  day: number | null;
  of_days: 7 | 14 | null;
  /** Visits counted in the window so far (counting and after); null before. */
  visits_counted: number | null;
  /** Versions written of the confirmed pages, and their total. */
  written: number;
  total: number;
  /** When the report is due (window end), when it was built and released. */
  report_due: number | null;
  report_built_at: number | null;
  report_released_at: number | null;
  /** The bundle's `ae` once set; before, null. */
  ends_at: number | null;
  /** The latest the audit can end (window start plus 28 days); null before the window. */
  ends_at_latest: number | null;
  ended_at: number | null;
  /** The 60-day delete's date, set at the end. */
  delete_at: number | null;
  /** No go live by then: the audit lapses. Null once live. */
  lapse_at: number | null;
  consent_banner: boolean;
  pilot_terms_at: number | null;
  caps: {
    pages_used: number;
    pages_max: number;
    rewrites_used: number;
    rewrites_max: number;
    spend_usd: number;
    spend_max: number;
    spend_used_up: boolean;
    pages_full: boolean;
    rewrite_used_up: boolean;
  };
}

// ---------------------------------------------------------------------------
// The Visitors page (docs/specs/visitors-page.md, the API contract).
// GET /admin/analytics/visitors, read live from the event rows. Every
// `visits` is distinct visits inside its own group; every `conversions` is
// distinct visits with a counted click inside that group; `page_views` is
// rows (one per page load); every rate a fraction, null at 0 visits.
// ---------------------------------------------------------------------------

/** The windows the Visitors read answers. */
export type VisitorsWindow = "24h" | "7d" | "30d" | "90d";

/** The version key: `intent:source` (default) or `*:source`, the mock's families. */
export type VisitorsVersionBy = "version" | "source";

/** The filters as applied; null when not set (docs/specs/visitors-page.md §2). */
export interface VisitorsFilters {
  /** An ISO code, `other`, or `none` (no country recorded). */
  country: string | null;
  /** A source word or `none`. */
  source: string | null;
  /** A SOURCE_NAMES word with 5 visits or more in the window. */
  name: string | null;
  /** `intent:source` (or `*:source`), `original` or `as_built`. */
  version: string | null;
  /** A listed page_path. */
  page: string | null;
}

/** What a version word stands for. */
export type VisitorsVersionKind = "version" | "original" | "as_built";

/** The counts every row carries. */
export interface VisitorsCounts {
  visits: number;
  page_views: number;
  conversions: number;
  rate: number | null;
}

/** One bucket of the series: an hour (24h) or a UTC day (7d, 30d, 90d). */
export interface VisitorsBucket extends VisitorsCounts {
  /** The bucket's start, unix ms (UTC hour or UTC midnight). */
  start: number;
}

export interface VisitorsSourceRow extends VisitorsCounts {
  /** A source dimension word, or `none` for a visit with no signal. */
  source: string;
  /** Named platforms inside the row, 5 visits or more each in the window without filters; absent on `none`. */
  names?: SourceNameCount[];
}

export interface VisitorsCountryRow extends VisitorsCounts {
  /** ISO 3166-1 alpha-2, `other`, or null for rows with no country recorded. */
  country: string | null;
}

export interface VisitorsPageRow extends VisitorsCounts {
  /** As stored (masked); for a sensitive customer the group path. */
  page_path: string;
  /** The path is a sensitive customer's group (`/products/:item`). */
  group: boolean;
  /** The page has its own confirmed manifest now. */
  has_versions: boolean;
}

export interface VisitorsOtherPages {
  /** How many pages fell under the listing floor (5 visits in the window without filters). */
  pages: number;
  /** Their visits summed page by page (a visit on two of them counts on each). */
  visits: number;
  page_views: number;
  conversions: number;
}

export interface VisitorsVersionRow extends VisitorsCounts {
  /** `intent:source` (`*:source` with version_by=source), `original` or `as_built`. */
  version: string;
  kind: VisitorsVersionKind;
  /** Null unless kind is `version` and version_by is `version`. */
  intent_dim: string | null;
  /** Null unless kind is `version`. */
  source_dim: string | null;
}

/** One counted button: visits that clicked it, and where most of them came from. */
export interface VisitorsButtonRow {
  /** The button's conversion_label. */
  label: string;
  clicks: number;
  top_source: { source: string; clicks: number } | null;
  top_country: { country: string | null; clicks: number } | null;
  top_version: { version: string; kind: VisitorsVersionKind; clicks: number } | null;
}

export interface VisitorsCountryVersionRow extends VisitorsCounts {
  country: string | null;
  version: string;
  kind: VisitorsVersionKind;
}

export interface VisitorsCountrySourceRow extends VisitorsCounts {
  country: string | null;
  source: string;
}

export interface VisitorsCountryPageRow extends VisitorsCounts {
  country: string | null;
  page_path: string;
}

export interface VisitorsResponse {
  customer_id: string;
  window: VisitorsWindow;
  /** The period counted: [start, end], unix ms; start is a UTC hour or midnight. */
  period: AnalyticsPeriod;
  computed_at: number;
  filters: VisitorsFilters;
  version_by: VisitorsVersionBy;
  /** `off` while the customer's country switch is on: no new country is recorded. */
  country_recording: "on" | "off";
  totals: VisitorsCounts;
  /**
   * Page views in the period from rows with no visit marker: each counts as a
   * visit of its own (rows from before ADR 0037 that lost their marker at 31
   * days, or a browser that blocked tab storage).
   */
  markerless_page_views: number;
  series: { bucket: "hour" | "day"; points: VisitorsBucket[] };
  by_source: VisitorsSourceRow[];
  by_country: VisitorsCountryRow[];
  by_page: { pages: VisitorsPageRow[]; other: VisitorsOtherPages | null };
  by_version: VisitorsVersionRow[];
  by_button: VisitorsButtonRow[];
  country_by_version: VisitorsCountryVersionRow[];
  country_by_source: VisitorsCountrySourceRow[];
  country_by_page: VisitorsCountryPageRow[];
  /** The visits with no signal, split (ADR 0038, part 1; docs/specs/visitors-page.md §2). */
  direct: VisitorsDirect;
  /**
   * New and returning visitors, from the visitor memory's rows (ADR 0039):
   * counts of visitor codes, never a code. All zeros while the memory is off
   * or before its first row.
   */
  people: VisitorsPeople;
}

/** New and returning visitors in the period (ADR 0039; docs/specs/visitors-page.md §2, "people"). */
export interface VisitorsPeople {
  /** Visitors (distinct codes) with a visit in the period. */
  people: number;
  /** Codes first drawn in the period: their first visit was in it. */
  new: number;
  /** Codes that came back in the period (a visit after their first). */
  returning: number;
  /** Visits by returning visitors. */
  returning_visits: number;
  /** Returning visits that got their remembered reason back: by its source word, `answer` for a tapped answer. */
  given_back: Record<string, number>;
  /** Visitors who clicked a counted button in the period. */
  converted: number;
  /** Of those, the ones who clicked on a visit after their first. */
  converted_returning: number;
}

/**
 * The direct panel's own filters (docs/specs/visitors-page.md §2, "direct"):
 * they narrow `direct` only; every other panel ignores them.
 */
export interface VisitorsDirectFilters {
  /** `mobile`, `tablet`, `desktop`, `other`, or `none` (not recorded). */
  device: string | null;
  /** `app`, `browser`, or `none` (not recorded). */
  view: string | null;
  /** A landing page_path as `direct.by_landing.pages[].page_path` gives it. */
  landing: string | null;
}

export interface VisitorsDeviceRow extends VisitorsCounts {
  /** `mobile`, `tablet`, `desktop`, `other`, or null (not recorded). */
  device: "mobile" | "tablet" | "desktop" | "other" | null;
}

export interface VisitorsViewRow extends VisitorsCounts {
  /** `app` (an app's in-app browser), `browser`, or null (not recorded). */
  view: "app" | "browser" | null;
}

/**
 * The visits that had no signal on any page (the `none` row of
 * `by_source`), split by where they landed, country, device class and
 * in-app browser. Every number counts visits as everywhere: each group
 * distinct inside itself.
 */
export interface VisitorsDirect {
  /** `off` while the customer's direct-insights switch is on: no new device word or in-app bit. */
  recording: "on" | "off";
  filters: VisitorsDirectFilters;
  /** The no-signal visits under every filter of the page and of this panel. */
  totals: VisitorsCounts;
  /** By the first page the visit viewed in the period; pages under the listing floor fold into `other`. */
  by_landing: { pages: VisitorsPageRow[]; other: VisitorsOtherPages | null };
  by_country: VisitorsCountryRow[];
  by_device: VisitorsDeviceRow[];
  by_view: VisitorsViewRow[];
}

/** POST /admin/direct-insights/off and /on (ADR 0038, part 1). */
export interface DirectInsightsSwitchResponse {
  ok: true;
  customer_id: string;
  direct_insights: "on" | "off";
  /** Rows whose device word and in-app bit this call set to NULL (0 for on). */
  cleared: number;
  /** False when rows still hold them: the 6-hour sweep finishes them. */
  done: boolean;
}

/** POST /admin/country/off and /on (ADR 0036, point 6). */
export interface CountrySwitchResponse {
  ok: true;
  customer_id: string;
  country_recording: "on" | "off";
  /** Rows whose country this call set to NULL (0 for on). */
  cleared: number;
  /** False when rows still hold a country: the 6-hour sweep finishes them. */
  done: boolean;
}
