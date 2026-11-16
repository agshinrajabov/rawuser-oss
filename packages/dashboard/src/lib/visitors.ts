/**
 * The Visitors screen's adapter (dashboard v2, section 02), built on the
 * contract in docs/specs/visitors-page.md §2 (GET /admin/analytics/visitors).
 * Every field the screen reads passes through `readVisitors` here, so a
 * field renamed in the API is one edit in this file. The types are local on
 * purpose (they mirror `VisitorsResponse` in @rawuser/shared) and every
 * optional part degrades: an answer without `filters` or `by_button` (a
 * worker from before the filters) still renders, unfiltered.
 *
 * Filters run on the server: each breakdown leaves out its own dimension,
 * so a panel keeps its other rows to click (contract §2).
 *
 * Words: buyer words only. A visit is a stay (a session); "Clicked" counts
 * visits that clicked a button that counts, once each.
 */

import {
  kindOf,
  marketKind,
  pageName,
  reasonLabel,
  regionName,
  sourceRow,
  versionShort,
} from "./kinds";
import { num } from "./proof";

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

export type VWindow = "24h" | "7d" | "30d" | "90d";
export const V_WINDOWS: readonly VWindow[] = ["24h", "7d", "30d", "90d"];
export type VKind = "version" | "original" | "as_built";

export interface VCounts {
  visits: number;
  page_views: number;
  conversions: number;
  rate: number | null;
}

export interface VSourceRow extends VCounts {
  source: string;
  names: { name: string; label: string; visits: number; conversions: number }[];
}
export interface VCountryRow extends VCounts {
  country: string | null;
}
export interface VPageRow extends VCounts {
  page_path: string;
  group: boolean;
  has_versions: boolean;
}
export interface VVersionRow extends VCounts {
  version: string;
  kind: VKind;
  intent_dim: string | null;
  source_dim: string | null;
}
export interface VButtonRow {
  label: string;
  clicks: number;
  top_source: { source: string; clicks: number } | null;
  top_country: { country: string | null; clicks: number } | null;
  top_version: { version: string; kind: VKind; clicks: number } | null;
}
export interface VCrossVersion extends VCounts {
  country: string | null;
  version: string;
  kind: VKind;
}

export interface VFilters {
  country: string | null;
  source: string | null;
  name: string | null;
  version: string | null;
  page: string | null;
  /** The direct panel's own three (ADR 0038 part 1): they narrow that panel only. */
  device: string | null;
  view: string | null;
  landing: string | null;
}
export const NO_FILTERS: VFilters = {
  country: null,
  source: null,
  name: null,
  version: null,
  page: null,
  device: null,
  view: null,
  landing: null,
};
export type VDim = keyof VFilters;
/** The page's filters: every panel follows them. */
export const MAIN_DIMS: readonly VDim[] = ["source", "name", "country", "page", "version"];
/** The direct panel's filters: every other panel ignores them (contract §2). */
export const DIRECT_DIMS: readonly VDim[] = ["device", "view", "landing"];
export const V_DIMS: readonly VDim[] = [...MAIN_DIMS, ...DIRECT_DIMS];

export type VDevice = "mobile" | "tablet" | "desktop" | "other" | null;
export type VView = "app" | "browser" | null;

/** The visits with no signal on any page (ADR 0038 part 1, contract §2 `direct`). */
export interface VDirect {
  recording: "on" | "off";
  totals: VCounts;
  byLanding: { pages: VPageRow[]; other: (Omit<VCounts, "rate"> & { pages: number }) | null };
  byCountry: VCountryRow[];
  byDevice: (VCounts & { device: VDevice })[];
  byView: (VCounts & { view: VView })[];
}

export interface VisitorsAnswer {
  window: VWindow;
  /** `source`: version rows are families (`*:ai`). */
  versionBy: "version" | "source";
  period: { start: number; end: number };
  computedAt: number;
  /** As the server applied them; null on a worker without filters. */
  filters: VFilters | null;
  countryRecording: "on" | "off";
  totals: VCounts;
  series: { bucket: "hour" | "day"; points: (VCounts & { start: number })[] };
  bySource: VSourceRow[];
  byCountry: VCountryRow[];
  byPage: { pages: VPageRow[]; other: (Omit<VCounts, "rate"> & { pages: number }) | null };
  byVersion: VVersionRow[];
  /** Null on a worker without it. */
  byButton: VButtonRow[] | null;
  countryByVersion: VCrossVersion[];
  /** Null on a worker without it. */
  direct: VDirect | null;
  /** New and returning visitors (ADR 0039); null on a worker without it. */
  people: VPeople | null;
}

/** New and returning visitors in the period, counts of visitor codes (contract §2 `people`). */
export interface VPeople {
  people: number;
  new: number;
  returning: number;
  returningVisits: number;
  /** Returning visits that saw their reason again, by source word; `answer` for a tapped answer. */
  givenBack: Record<string, number>;
  converted: number;
  convertedReturning: number;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[])
    : [];

function counts(r: Record<string, unknown>): VCounts {
  const visits = n(r.visits);
  const conversions = n(r.conversions);
  return {
    visits,
    page_views: n(r.page_views),
    conversions,
    rate: typeof r.rate === "number" ? r.rate : visits > 0 ? conversions / visits : null,
  };
}

function pageList(raw: unknown): VDirect["byLanding"] {
  const b = (raw ?? {}) as Record<string, unknown>;
  const other = b.other as Record<string, unknown> | null | undefined;
  return {
    pages: arr(b.pages).map((x) => ({
      page_path: s(x.page_path) ?? "/",
      group: x.group === true,
      has_versions: x.has_versions === true,
      ...counts(x),
    })),
    other: other
      ? {
          pages: n(other.pages),
          visits: n(other.visits),
          page_views: n(other.page_views),
          conversions: n(other.conversions),
        }
      : null,
  };
}

const DEVICES = ["mobile", "tablet", "desktop", "other"];

function readPeople(raw: unknown): VPeople | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.people !== "number") return null;
  const back: Record<string, number> = {};
  if (p.given_back && typeof p.given_back === "object") {
    for (const [k, v] of Object.entries(p.given_back as Record<string, unknown>)) {
      if (/^[a-z]{2,16}$/.test(k) && n(v) > 0) back[k] = n(v);
    }
  }
  return {
    people: n(p.people),
    new: n(p.new),
    returning: n(p.returning),
    returningVisits: n(p.returning_visits),
    givenBack: back,
    converted: n(p.converted),
    convertedReturning: n(p.converted_returning),
  };
}

function readDirect(raw: unknown): VDirect | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (!d.totals || typeof d.totals !== "object") return null;
  return {
    recording: d.recording === "off" ? "off" : "on",
    totals: counts(d.totals as Record<string, unknown>),
    byLanding: pageList(d.by_landing),
    byCountry: arr(d.by_country).map((x) => ({ country: s(x.country), ...counts(x) })),
    byDevice: arr(d.by_device).map((x) => ({
      device: DEVICES.includes(String(x.device)) ? (x.device as VDevice) : null,
      ...counts(x),
    })),
    byView: arr(d.by_view).map((x) => ({
      view: x.view === "app" || x.view === "browser" ? x.view : null,
      ...counts(x),
    })),
  };
}

function kindWord(v: unknown): VKind {
  return v === "original" || v === "as_built" ? v : "version";
}

/** The answer as the screen reads it, or null when it is not one. */
export function readVisitors(raw: unknown): VisitorsAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!r.totals || typeof r.totals !== "object") return null;
  const period = (r.period ?? {}) as Record<string, unknown>;
  const series = (r.series ?? {}) as Record<string, unknown>;
  const byPage = (r.by_page ?? {}) as Record<string, unknown>;
  const other = byPage.other as Record<string, unknown> | null | undefined;
  const f = r.filters as Record<string, unknown> | undefined;
  return {
    window: (V_WINDOWS as readonly string[]).includes(String(r.window))
      ? (r.window as VWindow)
      : "7d",
    versionBy: r.version_by === "version" ? "version" : "source",
    period: { start: n(period.start), end: n(period.end) },
    computedAt: n(r.computed_at),
    filters: f
      ? {
          country: s(f.country),
          source: s(f.source),
          name: s(f.name),
          version: s(f.version),
          page: s(f.page),
          device: null,
          view: null,
          landing: null,
        }
      : null,
    countryRecording: r.country_recording === "off" ? "off" : "on",
    totals: counts(r.totals as Record<string, unknown>),
    series: {
      bucket: series.bucket === "hour" ? "hour" : "day",
      points: arr(series.points).map((p) => ({ start: n(p.start), ...counts(p) })),
    },
    bySource: arr(r.by_source).map((x) => ({
      source: s(x.source) ?? "none",
      names: arr(x.names).map((m) => ({
        name: s(m.name) ?? "",
        label: s(m.label) ?? "",
        visits: n(m.visits),
        conversions: n(m.conversions),
      })),
      ...counts(x),
    })),
    byCountry: arr(r.by_country).map((x) => ({ country: s(x.country), ...counts(x) })),
    byPage: {
      pages: arr(byPage.pages).map((x) => ({
        page_path: s(x.page_path) ?? "/",
        group: x.group === true,
        has_versions: x.has_versions === true,
        ...counts(x),
      })),
      other: other
        ? {
            pages: n(other.pages),
            visits: n(other.visits),
            page_views: n(other.page_views),
            conversions: n(other.conversions),
          }
        : null,
    },
    byVersion: arr(r.by_version).map((x) => ({
      version: s(x.version) ?? "as_built",
      kind: kindWord(x.kind),
      intent_dim: s(x.intent_dim),
      source_dim: s(x.source_dim),
      ...counts(x),
    })),
    byButton: Array.isArray(r.by_button)
      ? arr(r.by_button).map((b) => {
          const ts = b.top_source as Record<string, unknown> | null;
          const tc = b.top_country as Record<string, unknown> | null;
          const tv = b.top_version as Record<string, unknown> | null;
          return {
            label: s(b.label) ?? "",
            clicks: n(b.clicks),
            top_source: ts ? { source: s(ts.source) ?? "none", clicks: n(ts.clicks) } : null,
            top_country: tc ? { country: s(tc.country), clicks: n(tc.clicks) } : null,
            top_version: tv
              ? { version: s(tv.version) ?? "", kind: kindWord(tv.kind), clicks: n(tv.clicks) }
              : null,
          };
        })
      : null,
    countryByVersion: arr(r.country_by_version).map((x) => ({
      country: s(x.country),
      version: s(x.version) ?? "as_built",
      kind: kindWord(x.kind),
      ...counts(x),
    })),
    direct: readDirect(r.direct),
    people: readPeople(r.people),
  };
}

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

/** A country filter for rows with no country recorded is the word `none`. */
export const NO_COUNTRY = "none";

/**
 * Always `version_by=source`: a version row is a family (`*:ai`, "AI chat
 * version"), counted distinct by the server (contract §2), as the mock draws it.
 */
export function visitorsPath(customerId: string, window: VWindow, f: VFilters): string {
  const p = new URLSearchParams({ customer_id: customerId, window, version_by: "source" });
  for (const d of V_DIMS) {
    const v = f[d];
    if (v) p.set(d, v);
  }
  return `/admin/analytics/visitors?${p.toString()}`;
}

/** The filters and period from the page's own address (links from Versions land filtered). */
export function filtersFromQuery(q: URLSearchParams): { window: VWindow; filters: VFilters } {
  const w = q.get("window");
  const filters = { ...NO_FILTERS };
  for (const d of V_DIMS) {
    const v = q.get(d);
    if (v) filters[d] = v;
  }
  return {
    window: (V_WINDOWS as readonly string[]).includes(w ?? "") ? (w as VWindow) : "30d",
    filters,
  };
}

/** A row clicked: set it, or clear it when it was the one set. A source clears its name. */
export function toggle(f: VFilters, dim: VDim, value: string): VFilters {
  const next = { ...f, [dim]: f[dim] === value ? null : value };
  if (dim === "source") next.name = null;
  if (dim === "name" && next.name) next.source = null;
  return next;
}

/** The page's filters that are set (the chips at the top). */
export function activeFilters(f: VFilters): VDim[] {
  return MAIN_DIMS.filter((d) => f[d] !== null);
}

/** The direct panel's own filters that are set. */
export function directFilters(f: VFilters): VDim[] {
  return DIRECT_DIMS.filter((d) => f[d] !== null);
}

/** A filter the server refused (400): a page or platform under its floor, or a value off the list. */
export const REFUSED_LINE =
  "No numbers for this filter. A page or a platform needs 5 visits in the period before it shows.";

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** "GB" -> "United Kingdom"; `other` and null in words. */
export function countryName(code: string | null): string {
  if (code === null || code === NO_COUNTRY) return "Not recorded";
  if (code === "other") return "Other or unknown";
  return regionName(code);
}

/** "AI chat version", "Your page, kept for the test", "Your page, no version". */
export function versionLabel(v: {
  version: string;
  kind: VKind;
  intent_dim?: string | null;
  source_dim?: string | null;
}): string {
  if (v.kind === "original") return "Your page, kept for the test";
  if (v.kind === "as_built") return "Your page, no version";
  const [intent, source] = v.version.split(":");
  const market = marketKind(v.source_dim ?? source ?? null);
  if (market) return market.label;
  const k = kindOf(v.source_dim ?? source ?? null);
  const name = `${k ? k.short : "Other"} version`;
  // A single version (version_by=version, a link from Versions) names why they came too.
  const why = v.intent_dim ?? (intent && intent !== "*" ? intent : null);
  return why ? `${name}, ${reasonLabel(why).toLowerCase()}` : name;
}

/** A row with no device or view recorded is the filter word `none`. */
export const NOT_RECORDED = "none";

export function deviceName(d: string | null): string {
  switch (d) {
    case "mobile":
      return "Phone";
    case "tablet":
      return "Tablet";
    case "desktop":
      return "Computer";
    case "other":
      return "Other";
    default:
      return "Not recorded";
  }
}

export function viewName(v: string | null): string {
  if (v === "app") return "Inside an app";
  if (v === "browser") return "A browser";
  return "Not recorded";
}

export function versionSub(kind: VKind): string | null {
  if (kind === "original") return "1 in 5, to compare";
  if (kind === "as_built") return "Nothing to go on, or a page without versions";
  return null;
}

/** The label of one filter's value, for the chip and the sentence. */
export function filterLabel(dim: VDim, value: string, a: VisitorsAnswer | null): string {
  switch (dim) {
    case "source":
      return sourceRow(value).label;
    case "name":
      return (
        a?.bySource.flatMap((x) => x.names).find((m) => m.name === value)?.label ??
        value.charAt(0).toUpperCase() + value.slice(1)
      );
    case "country":
      return countryName(value);
    case "page":
      return pageName(value);
    case "landing":
      return `Landed on ${pageName(value)}`;
    case "device":
      return deviceName(value === NOT_RECORDED ? null : value);
    case "view":
      return viewName(value === NOT_RECORDED ? null : value);
    case "version": {
      const row = a?.byVersion.find((v) => v.version === value);
      return versionLabel(
        row ?? {
          version: value,
          kind: value === "original" || value === "as_built" ? value : "version",
        },
      );
    }
  }
}

export function pctText(c: number, v: number): string {
  return v > 0 ? `${((c / v) * 100).toFixed(1)}%` : "0%";
}

const PERIOD_WORDS: Record<VWindow, string> = {
  "24h": "In the last 24 hours",
  "7d": "In the last 7 days",
  "30d": "In the last 30 days",
  "90d": "In the last 90 days",
};

export interface Summary {
  lead: string;
  tail: string | null;
}

/** The sentence at the top (mock: "UK: visits, clicks, most on which version"). */
export function summaryFor(a: VisitorsAnswer, f: VFilters, window: VWindow): Summary {
  const t = a.totals;
  const dims = activeFilters(f);
  if (dims.length === 0) {
    const floor = window === "24h" ? 5 : 30;
    const best = a.bySource
      .filter((x) => x.source !== "none" && x.visits >= floor && x.conversions > 0)
      .sort((x, y) => y.conversions / y.visits - x.conversions / x.visits)[0];
    return {
      lead: `${PERIOD_WORDS[window]}, ${num(t.visits)} ${t.visits === 1 ? "visit" : "visits"} and ${num(t.conversions)} clicked a button that counts.`,
      tail: best
        ? `Visitors from ${sourceRow(best.source).label} clicked most often, ${pctText(best.conversions, best.visits)}.`
        : null,
    };
  }
  const parts: string[] = [];
  const from = f.name ?? f.source;
  if (from) parts.push(`From ${filterLabel(f.name ? "name" : "source", from, a)}`);
  if (f.country) parts.push(`${parts.length ? "in" : "In"} ${countryName(f.country)}`);
  if (f.page) parts.push(`${parts.length ? "on" : "On"} ${pageName(f.page)}`);
  if (f.version) {
    const row = a.byVersion.find((v) => v.version === f.version);
    const kind =
      row?.kind ?? (f.version === "original" || f.version === "as_built" ? f.version : "version");
    const what =
      kind === "original"
        ? "your page, kept for the test"
        : kind === "as_built"
          ? "your page, no version"
          : `the ${versionLabel(row ?? { version: f.version, kind })}`;
    parts.push(`${parts.length ? "who saw" : "Saw"} ${what}`);
  }
  let tail = "";
  if (!f.version) {
    const top = a.byVersion
      .filter((v) => v.kind === "version" && v.conversions > 0)
      .sort((x, y) => y.conversions - x.conversions || y.visits - x.visits)[0];
    if (top) tail = `, most on the ${versionLabel(top)}`;
  } else if (!from && t.conversions > 0) {
    const top = a.bySource
      .filter((x) => x.source !== "none" && x.conversions > 0)
      .sort((x, y) => y.conversions - x.conversions)[0];
    if (top) tail = `, most from ${sourceRow(top.source).label}`;
  }
  return {
    lead: `${parts.join(" ")}: ${num(t.visits)} ${t.visits === 1 ? "visit" : "visits"}, ${num(t.conversions)} clicked${tail}.`,
    tail: `${pctText(t.conversions, t.visits)} click rate.`,
  };
}

// ---------------------------------------------------------------------------
// The chart's buckets
// ---------------------------------------------------------------------------

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function bucketLabel(start: number, bucket: "hour" | "day"): string {
  const d = new Date(start);
  if (bucket === "hour") return `${String(d.getUTCHours()).padStart(2, "0")}:00`;
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/** 90 days of days read better as weeks: summed by 7, the last bucket partial. */
export function chartBuckets(
  a: VisitorsAnswer,
): { label: string; visits: number; conversions: number }[] {
  const pts = a.series.points;
  if (a.window !== "90d") {
    return pts.map((p) => ({
      label: bucketLabel(p.start, a.series.bucket),
      visits: p.visits,
      conversions: p.conversions,
    }));
  }
  const out: { label: string; visits: number; conversions: number }[] = [];
  for (let i = 0; i < pts.length; i += 7) {
    const week = pts.slice(i, i + 7);
    const first = week[0];
    if (!first) continue;
    // Distinct visits per day summed over a week: a visit across midnight counts twice.
    out.push({
      label: bucketLabel(first.start, "day"),
      visits: week.reduce((t, p) => t + p.visits, 0),
      conversions: week.reduce((t, p) => t + p.conversions, 0),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Country by version
// ---------------------------------------------------------------------------

export interface MatrixColumn {
  key: string;
  label: string;
}
export interface MatrixCell {
  visits: number;
  conversions: number;
  /** The one version word behind the cell, when there is only one (a click filters by it). */
  version: string | null;
}
export interface MatrixRow {
  country: string | null;
  cells: Record<string, MatrixCell | undefined>;
  /** The column with most clicks, never "No version". */
  best: string | null;
}

/**
 * Version families by where their visitors came from (the mock's columns,
 * `version_by=source`, counted distinct by the server), then the test's
 * original and "No version". A `intent:source` row from an older answer is
 * summed into its family.
 */
export function countryMatrix(
  a: VisitorsAnswer,
  maxCountries = 9,
  keep: string | null = null,
): { columns: MatrixColumn[]; rows: MatrixRow[] } {
  const colKey = (c: VCrossVersion) =>
    c.kind === "version" ? `k:${c.version.split(":")[1] ?? "other"}` : c.kind;
  const kinds = [...new Set(a.countryByVersion.filter((c) => c.kind === "version").map(colKey))];
  const order = (k: string) => {
    const src = k.slice(2);
    const i = ["ai", "social", "organic", "paid", "community", "direct"].indexOf(src);
    return i < 0 ? 99 : i;
  };
  kinds.sort((x, y) => order(x) - order(y));
  const columns: MatrixColumn[] = [
    ...kinds.map((k) => ({ key: k, label: versionShort("version", k.slice(2)) })),
    { key: "original", label: versionShort("original") },
    { key: "as_built", label: versionShort("as_built") },
  ];
  const countries = a.byCountry.slice(0, maxCountries).map((c) => c.country);
  if (keep !== null && !countries.includes(keep === NO_COUNTRY ? null : keep)) {
    countries.push(keep === NO_COUNTRY ? null : keep);
  }
  const rows: MatrixRow[] = countries.map((country) => {
    const cells: Record<string, MatrixCell> = {};
    for (const c of a.countryByVersion.filter((x) => x.country === country)) {
      const k = colKey(c);
      const cell = cells[k] ?? { visits: 0, conversions: 0, version: c.version };
      if (cell.version !== c.version) cell.version = null;
      cell.visits += c.visits;
      cell.conversions += c.conversions;
      cells[k] = cell;
    }
    let best: string | null = null;
    for (const col of columns) {
      if (col.key === "as_built") continue;
      const c = cells[col.key];
      if (c && c.conversions > 0 && (!best || c.conversions > (cells[best]?.conversions ?? 0))) {
        best = col.key;
      }
    }
    return { country, cells, best };
  });
  return { columns, rows };
}
