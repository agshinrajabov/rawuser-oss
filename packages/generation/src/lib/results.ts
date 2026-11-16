/**
 * The Results page's derived numbers (docs/specs/results-data.md): pure
 * functions over counts the aggregator already holds, shared by the
 * aggregator (what it stores) and the analytics endpoints (what they say).
 *
 * Privacy: counts per customer and window only. No visitor, no marker.
 */

import {
  type PageRow,
  type ResultsLead,
  SOURCE_NAME_LABELS,
  type SourceBreakdownRow,
  type SourceNameCount,
  type TaggedLinks,
  type UnknownRow,
  isSourceName,
} from "@rawuser/shared";
import { MIN_CONVERSIONS, MIN_SAMPLE, wilsonCI } from "./lift.ts";

/**
 * How far back rows are known to carry their marker. Until ADR 0037
 * (2026-11-02) the cron NULLed it at 31 days, so rows from before that date
 * lost it; the 30-day window's period before stays not comparable until 60
 * days of kept markers exist (about 2027-01-01). Raising this before then
 * would count every old row as a visit (docs/specs/visitors-page.md).
 */
export const MARKER_LIFE_MS = 31 * 24 * 60 * 60 * 1000;

/** A page is listed only with this many visits: one-off paths stay out. */
export const PAGE_MIN_VISITS = 5;

/**
 * A source name is stored and shown only with this many visits in the
 * window (privacy review condition 4); smaller counts stay in the row's
 * total.
 */
export const SOURCE_NAME_MIN_VISITS = 5;

/** Pages listed per kind (with versions, without). */
export const PAGES_PER_KIND = 5;

/** The cohorts of a visit that told us where it came from. */
export const SIGNAL_COHORTS: readonly string[] = ["personalized", "holdout", "skipped"];

/**
 * Whether the period before (prevStart, ...] can be set against the period:
 * only while its rows still carry the visit marker, else they count one per
 * page. `now` is the real clock, not the window's end (a backfilled window's
 * rows lose their marker on the same schedule).
 */
export function previousComparable(prevStart: number, now: number): boolean {
  return prevStart >= now - MARKER_LIFE_MS;
}

/**
 * A relative change, null unless the base is large enough to say one:
 * `min` visits (MIN_SAMPLE) for visits, MIN_CONVERSIONS for conversions.
 */
export function changeOf(current: number, prev: number | null, min = MIN_SAMPLE): number | null {
  if (prev === null || prev < min || prev <= 0) return null;
  return (current - prev) / prev;
}

export function rateOf(conversions: number, visits: number): number | null {
  return visits > 0 ? conversions / visits : null;
}

/** One stored per_source entry (analytics_aggregates.per_source). */
export interface StoredSource {
  source_dim: string;
  visits: number;
  conversions: number;
  prev_visits: number | null;
  prev_conversions: number | null;
  /** N1, since migration 0035: names with SOURCE_NAME_MIN_VISITS visits, most first. */
  names?: Array<{ name: string; visits: number; conversions: number }>;
}

/** analytics_aggregates.tagged (N3, migration 0035). */
export interface StoredTagged {
  visits: number;
  conversions: number;
  prev_visits: number | null;
  prev_conversions: number | null;
}

/** The (source, name) counts the aggregator reads (SOURCE_VISITS_SQL). */
export interface NamedCount {
  source_dim: string;
  source_name: string;
  visits: number;
  conversions: number;
  tagged_visits: number;
  tagged_conversions: number;
}

/**
 * Each per_source entry with its names: only words on SOURCE_NAMES, only
 * with SOURCE_NAME_MIN_VISITS visits; the rest stays in the row's total.
 */
export function withNames(sources: StoredSource[], named: readonly NamedCount[]): StoredSource[] {
  return sources.map((s) => ({
    ...s,
    names: named
      .filter(
        (n) =>
          n.source_dim === s.source_dim &&
          isSourceName(n.source_name) &&
          n.visits >= SOURCE_NAME_MIN_VISITS,
      )
      .map((n) => ({ name: n.source_name, visits: n.visits, conversions: n.conversions }))
      .sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name)),
  }));
}

/**
 * The day's rows for source_days with the name floor applied where the
 * daily aggregate is written (privacy review condition 4): a name with
 * fewer than SOURCE_NAME_MIN_VISITS visits that day, or one off the list,
 * folds into '' (no name) for its (customer, day, source_dim). A visit has
 * one name per source, so the sums never count a visit twice.
 */
export function foldSmallNames<T extends NamedCount>(rows: readonly T[]): NamedCount[] {
  const out = new Map<string, NamedCount>();
  for (const r of rows) {
    const keep = isSourceName(r.source_name) && r.visits >= SOURCE_NAME_MIN_VISITS;
    const name = keep ? r.source_name : "";
    const key = `${r.source_dim}\u0000${name}`;
    const e = out.get(key);
    if (e) {
      e.visits += r.visits;
      e.conversions += r.conversions;
      e.tagged_visits += r.tagged_visits;
      e.tagged_conversions += r.tagged_conversions;
    } else {
      out.set(key, {
        source_dim: r.source_dim,
        source_name: name,
        visits: r.visits,
        conversions: r.conversions,
        tagged_visits: r.tagged_visits,
        tagged_conversions: r.tagged_conversions,
      });
    }
  }
  return [...out.values()];
}

/** The visits on the customer's own tagged links, this period and the one before. */
export function taggedTotals(
  named: readonly NamedCount[],
  prev: readonly NamedCount[] | null,
): StoredTagged {
  const sum = (rows: readonly NamedCount[], k: "tagged_visits" | "tagged_conversions") =>
    rows.reduce((t, r) => t + r[k], 0);
  return {
    visits: sum(named, "tagged_visits"),
    conversions: sum(named, "tagged_conversions"),
    prev_visits: prev ? sum(prev, "tagged_visits") : null,
    prev_conversions: prev ? sum(prev, "tagged_conversions") : null,
  };
}

/** The API's names for one row: the floor again, with the label the dashboard writes. */
export function namesOf(s: StoredSource): SourceNameCount[] | undefined {
  if (!Array.isArray(s.names)) return undefined;
  return s.names
    .filter((n) => isSourceName(n.name) && n.visits >= SOURCE_NAME_MIN_VISITS)
    .map((n) => ({
      name: n.name,
      label: SOURCE_NAME_LABELS[n.name as keyof typeof SOURCE_NAME_LABELS],
      visits: n.visits,
      conversions: n.conversions,
    }));
}

/** The API's tagged row (N3), absent on rows written before migration 0035. */
export function taggedRow(t: StoredTagged | null, comparable: boolean): TaggedLinks | undefined {
  if (!t || typeof t.visits !== "number") return undefined;
  const prevVisits = comparable ? t.prev_visits : null;
  return {
    visits: t.visits,
    conversions: t.conversions,
    rate: rateOf(t.conversions, t.visits),
    prev_visits: prevVisits,
    prev_conversions: comparable ? t.prev_conversions : null,
    visits_change: changeOf(t.visits, prevVisits),
  };
}

/**
 * A source's count. The aggregator passes one row per source with no
 * cohort, already distinct across the signal cohorts (VISIT_GROUPS_SQL,
 * level "source"); a row with a cohort outside SIGNAL_COHORTS is in no source.
 */
interface CohortRow {
  cohort?: string | null;
  source_dim: string | null;
  visits: number;
  conversions: number;
}

function sumBySource(
  rows: readonly CohortRow[],
): Map<string, { visits: number; conversions: number }> {
  const out = new Map<string, { visits: number; conversions: number }>();
  for (const r of rows) {
    if ((r.cohort != null && !SIGNAL_COHORTS.includes(r.cohort)) || !r.source_dim) continue;
    const e = out.get(r.source_dim) ?? { visits: 0, conversions: 0 };
    e.visits += Number(r.visits) || 0;
    e.conversions += Number(r.conversions) || 0;
    out.set(r.source_dim, e);
  }
  return out;
}

/**
 * Visits with a signal per source, this period and the one before (null when
 * not comparable). Each source counts a visit once across the signal cohorts
 * (2026-10-06; before, the cells of a source were added up and a visit that
 * touched two intents counted twice). A visit that came from two sources is
 * in both rows, so the rows can add up to a little more than the distinct
 * signal visits. A source seen
 * only in the period before keeps a row with 0 visits (a fall to nothing is a
 * change too). Largest first, then by name.
 */
export function buildPerSource(
  rows: readonly CohortRow[],
  prevRows: readonly CohortRow[] | null,
): StoredSource[] {
  const cur = sumBySource(rows);
  const prev = prevRows ? sumBySource(prevRows) : null;
  const dims = new Set([...cur.keys(), ...(prev ? prev.keys() : [])]);
  return [...dims]
    .map((source_dim) => {
      const c = cur.get(source_dim) ?? { visits: 0, conversions: 0 };
      const p = prev ? (prev.get(source_dim) ?? { visits: 0, conversions: 0 }) : null;
      return {
        source_dim,
        visits: c.visits,
        conversions: c.conversions,
        prev_visits: p ? p.visits : null,
        prev_conversions: p ? p.conversions : null,
      };
    })
    .sort((a, b) => b.visits - a.visits || a.source_dim.localeCompare(b.source_dim));
}

/** The API row for a stored per_source entry. */
export function sourceRow(s: StoredSource): SourceBreakdownRow {
  const names = namesOf(s);
  return {
    source_dim: s.source_dim,
    visits: s.visits,
    conversions: s.conversions,
    rate: rateOf(s.conversions, s.visits),
    prev_visits: s.prev_visits,
    prev_conversions: s.prev_conversions,
    visits_change: changeOf(s.visits, s.prev_visits),
    ...(names ? { names } : {}),
  };
}

/**
 * The lead sentence's claims. `signal_visits`: the distinct visits with a
 * signal when the row stores them (`signalVisits`, per_cohort "signal",
 * since 2026-10-06), else the sum of the source rows. `grower`: the largest positive visits change
 * (changeOf's gate). `top_rate`: among groups with MIN_SAMPLE visits (the
 * sources and Unknown), the highest rate, only with MIN_CONVERSIONS
 * converting visits and a Wilson 95% lower bound above the next group's rate.
 */
export function pickLead(
  sources: readonly SourceBreakdownRow[],
  unknown: Pick<UnknownRow, "visits" | "conversions">,
  totalVisits: number,
  signalVisits: number = sources.reduce((s, r) => s + r.visits, 0),
): ResultsLead {
  let grower: ResultsLead["grower"] = null;
  for (const r of sources) {
    if (r.visits_change === null || r.visits_change <= 0) continue;
    if (!grower || r.visits_change > grower.visits_change) {
      grower = { source_dim: r.source_dim, visits_change: r.visits_change };
    }
  }

  const groups = [
    ...sources.map((r) => ({ group: r.source_dim, visits: r.visits, conversions: r.conversions })),
    { group: "unknown", visits: unknown.visits, conversions: unknown.conversions },
  ]
    .filter((g) => g.visits >= MIN_SAMPLE)
    .map((g) => ({ ...g, rate: g.conversions / g.visits }))
    .sort((a, b) => b.rate - a.rate || b.visits - a.visits);

  let topRate: ResultsLead["top_rate"] = null;
  const [first, second] = groups;
  if (first && second && first.conversions >= MIN_CONVERSIONS) {
    const [low, high] = wilsonCI(first.conversions, first.visits);
    if (low > second.rate) {
      topRate = {
        group: first.group,
        rate: first.rate,
        low,
        high,
        next_group: second.group,
        next_rate: second.rate,
      };
    }
  }

  return { signal_visits: signalVisits, total_visits: totalVisits, grower, top_rate: topRate };
}

/** One page as the aggregator counts it, before has_versions is known. */
export interface CountedPage {
  page_path: string;
  visits: number;
  signal_visits: number;
  written_visits: number;
  skipped_visits: number;
  /**
   * Of skipped_visits: the page was painted before our script ran, so it
   * stayed as built (docs/specs/late-tag.md). Absent on rows stored before
   * 2026-10-12.
   */
  lp_visits?: number;
}

/**
 * The pages to store: up to PAGES_PER_KIND without versions and as many with,
 * each with PAGE_MIN_VISITS, by signal_visits then visits then path. Paths
 * that normalize to one page (a trailing double slash) are added together.
 */
export function selectPages(
  counted: readonly CountedPage[],
  versioned: ReadonlySet<string>,
  normalize: (p: string) => string,
): PageRow[] {
  const merged = new Map<string, CountedPage>();
  for (const c of counted) {
    const path = normalize(c.page_path);
    const e = merged.get(path);
    if (e) {
      e.visits += c.visits;
      e.signal_visits += c.signal_visits;
      e.written_visits += c.written_visits;
      e.skipped_visits += c.skipped_visits;
      if (c.lp_visits !== undefined) e.lp_visits = (e.lp_visits ?? 0) + c.lp_visits;
    } else {
      merged.set(path, { ...c, page_path: path });
    }
  }
  const ranked = [...merged.values()]
    .filter((p) => p.visits >= PAGE_MIN_VISITS)
    .sort(
      (a, b) =>
        b.signal_visits - a.signal_visits ||
        b.visits - a.visits ||
        a.page_path.localeCompare(b.page_path),
    )
    .map((p) => ({ ...p, has_versions: versioned.has(p.page_path) }));
  const without = ranked.filter((p) => !p.has_versions).slice(0, PAGES_PER_KIND);
  const withV = ranked.filter((p) => p.has_versions).slice(0, PAGES_PER_KIND);
  return ranked.filter((p) => without.includes(p) || withV.includes(p));
}
