/**
 * The Visitors page's read (docs/specs/visitors-page.md): who came from
 * where, from which country, to which page, which version they saw, and who
 * clicked, for one customer over 24 hours, 7, 30 or 90 days, filtered by one
 * row of any breakdown.
 *
 * Read live from the event rows. Since ADR 0037 (2026-11-02) the visit
 * marker stays on the row, so distinct visits are counted from the rows for
 * any window, the same way as everywhere: COUNT(DISTINCT COALESCE(visit,
 * id)), each group counted distinct inside itself, never added up from
 * smaller groups (docs/specs/results-data.md, "What a number means here").
 * A row without a marker counts as one visit, and the answer says how many
 * page views did (`markerless_page_views`).
 *
 * Which row a visit belongs to (the spec's table): every source, country
 * and version its rows carry, `none` and `as_built` when it had none; a
 * page's row holds the visits that viewed it. Clicks: a visit that clicked
 * anywhere counts in its source, country and version rows; on a page, only
 * a click on that page counts. A row of a visit with no source or version
 * of its own (a page without versions after a ChatGPT landing) takes the
 * visit's, so page views add up to the total.
 *
 * Two statements, each one pass over the window's rows (MATERIALIZED, the
 * stored-path CASE once over the base column; the lesson of 2026-10-13),
 * joined to a level list (one SELECT, not a UNION: D1 refuses a compound
 * SELECT of many terms), each under D1_STATEMENT_CHARS_MAX. Every statement
 * filters on (customer_id, ts), the idx_events_customer_ts index.
 *
 * Privacy (ADR 0036, the privacy rules): counts only leave this
 * module; the marker is in no result column. Country from `events.country`
 * as stored; a value off the closed list is read as not recorded. No floor
 * on a country (the founder's decision); the page floor (PAGE_MIN_VISITS)
 * and the source-name floor (SOURCE_NAME_MIN_VISITS) stay, both on the
 * window without filters, and a filter on a page or name under its floor is
 * refused. A sensitive customer's pages are its stored paths (groups),
 * applied again here, so a row stored before the mark never names a
 * product page.
 */

import {
  INTENT_DIMENSIONS,
  SOURCE_DIMENSIONS,
  SOURCE_NAME_LABELS,
  type SensitiveSettings,
  type SourceNameCount,
  type VisitorsBucket,
  type VisitorsButtonRow,
  type VisitorsCounts,
  type VisitorsDirect,
  type VisitorsDirectFilters,
  type VisitorsFilters,
  type VisitorsPeople,
  type VisitorsResponse,
  type VisitorsVersionBy,
  type VisitorsVersionKind,
  type VisitorsWindow,
  isDeviceClass,
  isGroupPath,
  isSourceName,
  isStoredCountry,
} from "@rawuser/shared";
import { VERSIONED_PAGES_SQL, VISIT_EVENTS } from "../cron/analytics-aggregator.ts";
import { PAGE_MIN_VISITS, SIGNAL_COHORTS, SOURCE_NAME_MIN_VISITS, rateOf } from "./results.ts";
import { keptCteSql, normPathSql, storedPathSql } from "./sensitive-pages.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Each window: its bucket and how many buckets, the last one the current. */
export const VISITORS_WINDOWS: Readonly<
  Record<VisitorsWindow, { bucket: "hour" | "day"; ms: number; n: number }>
> = {
  "24h": { bucket: "hour", ms: HOUR_MS, n: 24 },
  "7d": { bucket: "day", ms: DAY_MS, n: 7 },
  "30d": { bucket: "day", ms: DAY_MS, n: 30 },
  "90d": { bucket: "day", ms: DAY_MS, n: 90 },
};

export function isVisitorsWindow(w: unknown): w is VisitorsWindow {
  return typeof w === "string" && Object.hasOwn(VISITORS_WINDOWS, w);
}

/**
 * The period of a window at `now`: from the start of the bucket n - 1
 * buckets back (a UTC hour or midnight) to `now`, both ends included. The
 * last bucket is the current, partial one.
 */
export function visitorsPeriod(
  window: VisitorsWindow,
  now: number,
): { start: number; end: number } {
  const w = VISITORS_WINDOWS[window];
  return { start: Math.floor(now / w.ms) * w.ms - (w.n - 1) * w.ms, end: now };
}

/** The value a `country` filter takes for rows with no country recorded. */
export const COUNTRY_NONE = "none";

const SIGNAL_SQL = SIGNAL_COHORTS.map((c) => `'${c}'`).join(",");

/**
 * The levels, each a group counted distinct inside itself, with the filters
 * it leaves out (its own dimensions: k country, s source and name, v
 * version, p page). Statement A: the total (a), the series (t), the single
 * breakdowns and the two floors without filters (nf names, pf pages).
 * Statement B: the crosses and the buttons (b, clicks only). A level's name
 * holds the letters of the keys it groups by (k, s, n, r, p, b, t), which
 * the statement reads with instr().
 */
const LEVELS = {
  a: "",
  t: "",
  k: "k",
  s: "s",
  n: "s",
  nf: "ksvp",
  r: "v",
  p: "p",
  pf: "ksvp",
  kr: "kv",
  ks: "ks",
  kp: "kp",
  b: "",
  bs: "s",
  bk: "k",
  br: "v",
} as const;
type Level = keyof typeof LEVELS;
const LEVELS_A: readonly Level[] = ["a", "t", "k", "s", "n", "nf", "r", "p", "pf"];
const LEVELS_B: readonly Level[] = ["kr", "ks", "kp", "b", "bs", "bk", "br"];

/**
 * Parameters: ?1 customer, ?2 start, ?3 end (both included), the filters
 * ?4 country, ?5 source, ?6 name, ?7 version, ?8 page (NULL when not set),
 * ?9 the bucket length (ms), ?10 the version key (`source` for `*:ai`, else
 * `intent:source`), ?11 the kept list (a sensitive customer only).
 *
 * o: the window's rows, the path normalized once. e: one row per event, its
 * keys (k country, s0 source, n name, r0 version, p page, b button) and c
 * for a click. w: per
 * visit, the source and version it takes for its rows without one, whether
 * it clicked (anywhere, wc; on the filtered page, wp) and whether it is in
 * each filter's row (fk, fs, fn, fv, fp). l: the levels, with the filters
 * each leaves out. Whitespace is collapsed (no literal in it holds a run of
 * spaces), which keeps the sensitive statements under D1_STATEMENT_CHARS_MAX.
 */
function visitorsSql(
  levels: readonly Level[],
  page: (col: string) => string,
  withKept: boolean,
): string {
  const key = (letter: string) => `instr(l.l,'${letter}')`;
  const values = levels
    .map((l) => {
      const own: string = LEVELS[l];
      return `('${l}',${["k", "s", "v", "p"].map((d) => (own.includes(d) ? 1 : 0)).join(",")})`;
    })
    .join(",");
  return `/* visitors_${levels[0]}${withKept ? "_sensitive" : ""} */
WITH ${withKept ? `${keptCteSql("?11")},\n` : ""}o AS MATERIALIZED (
 SELECT COALESCE(visit,id) v,visit IS NULL m,ts,event_type='conversion' c,COALESCE(country,'${COUNTRY_NONE}') k,
  ${normPathSql("page_path")} np,conversion_label b,source_dim sd,source_name sn,intent_dim i,
  COALESCE(cohort,'personalized') IN (${SIGNAL_SQL}) g,COALESCE(cohort,'personalized') h
 FROM events
 WHERE customer_id=?1 AND ts>=?2 AND ts<=?3 AND event_type IN (${VISIT_EVENTS},'conversion')
),
e AS MATERIALIZED (
 SELECT v,m,ts,c,k,b,${page("np")} p,IIF(g,sd,NULL) s0,IIF(g,sn,NULL) n,
  CASE h WHEN 'holdout' THEN 'original' WHEN 'personalized' THEN IIF(?10='source','*',i)||':'||sd END r0
 FROM o
),
w AS MATERIALIZED (
 SELECT v,MAX(s0) ws,MAX(r0) wr,MAX(c) wc,MAX(c AND p=?8) wp,MAX(k=?4) fk,
  IIF(?5='none',MAX(s0) IS NULL,MAX(s0=?5)) fs,MAX(n=?6) fn,
  IIF(?7='as_built',MAX(r0) IS NULL,MAX(r0=?7)) fv,MAX(p=?8 AND NOT c) fp
 FROM e GROUP BY v
),
l(l,dk,ds,dv,dp) AS (VALUES ${values})
SELECT l.l lv,IIF(${key("k")},e.k,NULL) k,
 CASE WHEN ${key("s")} THEN COALESCE(e.s0,w.ws,'none') WHEN ${key("n")} THEN e.s0 END s,
 IIF(${key("n")},e.n,NULL) n,IIF(${key("r")},COALESCE(e.r0,w.wr,'as_built'),NULL) r,
 IIF(${key("p")},e.p,NULL) p,IIF(${key("b")},e.b,NULL) b,IIF(l.l='t',e.ts-e.ts%?9,NULL) t,
 COUNT(DISTINCT e.v) FILTER (WHERE NOT e.c AND (l.dp OR ?8 IS NULL OR e.p=?8)) visits,
 SUM(NOT e.c AND (l.dp OR ?8 IS NULL OR e.p=?8)) page_views,
 COUNT(DISTINCT e.v) FILTER (WHERE IIF(l.dp OR l.l='t' OR ${key("b")},e.c AND (l.dp OR ?8 IS NULL OR e.p=?8),
  IIF(?8 IS NULL,w.wc,w.wp))) conversions,
 SUM(NOT e.c AND e.m AND (?8 IS NULL OR e.p=?8)) markerless
FROM e JOIN w USING (v) JOIN l ON (l.dk OR ?4 IS NULL OR w.fk) AND (l.ds OR (?5 IS NULL OR w.fs)
 AND (?6 IS NULL OR w.fn)) AND (l.dv OR ?7 IS NULL OR w.fv) AND (l.dp OR ?8 IS NULL OR w.fp)
 AND (${key("b")}=0 OR e.c)
GROUP BY 1,2,3,4,5,6,7,8`
    .replace(/\s+/g, " ")
    .trim();
}

/** The page as stored: every customer's normalized masked path. */
const PLAIN_PAGE = (col: string) => col;
/** A sensitive customer's: the stored path rule applied again (`kept(p)` from ?11). */
const STORED_PAGE = storedPathSql;

/** Every customer's two statements: the masked path as stored, normalized. */
export const VISITORS_A_SQL = visitorsSql(LEVELS_A, PLAIN_PAGE, false);
export const VISITORS_B_SQL = visitorsSql(LEVELS_B, PLAIN_PAGE, false);
/** A sensitive customer's: the stored path rule applied again; ?11 is the kept list. */
export const VISITORS_A_SENSITIVE_SQL = visitorsSql(LEVELS_A, STORED_PAGE, true);
export const VISITORS_B_SENSITIVE_SQL = visitorsSql(LEVELS_B, STORED_PAGE, true);

/**
 * The direct panel (ADR 0038, part 1; docs/specs/direct-visitors.md §1): the
 * visits with no signal on any page, the `none` row of `by_source` by the
 * same rule (no signal-cohort row with a source), split by landing page,
 * country, device word and in-app bit, one pass over the window's rows.
 *
 * Parameters: ?1 customer, ?2 start, ?3 end (both included), the page's
 * filters ?4 country and ?5 page, the panel's own ?6 device, ?7 view
 * (`app`, `browser`, `none`), ?8 landing (NULL when not set), ?9 the kept
 * list (a sensitive customer only). The page's source, name and version
 * filters are applied in code: `none`, nothing and `as_built` keep every
 * such visit, anything else keeps none.
 *
 * o: the window's rows. e: the page once (the stored-path rule for a
 * sensitive customer). w: per no-signal visit, its landing page (the page of
 * its first page view in the period, NULL when it has none: a click whose
 * page view fell before), whether it clicked (anywhere, wc; on the filtered
 * page, wp) and whether it is in each filter's row. l: the levels (t the
 * total, k country, d device, a in-app, g landing), each leaving out the
 * filter on its own dimension. Counting mirrors statement A's single
 * breakdowns: visits and page views on the filtered page when one is set,
 * clicks anywhere, or on that page.
 */
function directSql(page: (col: string) => string, withKept: boolean): string {
  return `/* visitors_direct${withKept ? "_sensitive" : ""} */
WITH ${withKept ? `${keptCteSql("?9")},\n` : ""}o AS MATERIALIZED (
 SELECT COALESCE(visit,id) v,ts,event_type='conversion' c,COALESCE(country,'${COUNTRY_NONE}') k,
  COALESCE(device_class,'none') d,CASE web_view WHEN 1 THEN 'app' WHEN 0 THEN 'browser' ELSE 'none' END a,
  ${normPathSql("page_path")} np,IIF(COALESCE(cohort,'personalized') IN (${SIGNAL_SQL}),source_dim,NULL) s
 FROM events
 WHERE customer_id=?1 AND ts>=?2 AND ts<=?3 AND event_type IN (${VISIT_EVENTS},'conversion')
),
e AS MATERIALIZED (SELECT v,ts,c,k,d,a,s,${page("np")} p FROM o),
w AS MATERIALIZED (
 SELECT v,MAX(c) wc,MAX(c AND p=?5) wp,substr(MIN(IIF(c,NULL,printf('%015d',ts)||p)),16) lp,
  MAX(k=?4) fk,MAX(p=?5 AND NOT c) fp,MAX(d=?6) fd,MAX(a=?7) fa
 FROM e GROUP BY v HAVING MAX(s) IS NULL
),
l(l,dk,dd,da,dg) AS (VALUES ('t',0,0,0,0),('k',1,0,0,0),('d',0,1,0,0),('a',0,0,1,0),('g',0,0,0,1))
SELECT l.l lv,IIF(l.dk,e.k,NULL) k,IIF(l.dd,e.d,NULL) d,IIF(l.da,e.a,NULL) a,IIF(l.dg,w.lp,NULL) p,
 COUNT(DISTINCT e.v) FILTER (WHERE NOT e.c AND (?5 IS NULL OR e.p=?5)) visits,
 SUM(NOT e.c AND (?5 IS NULL OR e.p=?5)) page_views,
 COUNT(DISTINCT e.v) FILTER (WHERE IIF(?5 IS NULL,w.wc,w.wp)) conversions
FROM e JOIN w USING (v) JOIN l ON (l.dk OR ?4 IS NULL OR w.fk) AND (?5 IS NULL OR w.fp)
 AND (l.dd OR ?6 IS NULL OR w.fd) AND (l.da OR ?7 IS NULL OR w.fa) AND (l.dg OR ?8 IS NULL OR w.lp=?8)
GROUP BY 1,2,3,4,5`
    .replace(/\s+/g, " ")
    .trim();
}

/** The direct panel's statement: every customer's, and a sensitive customer's (?9 the kept list). */
export const VISITORS_DIRECT_SQL = directSql(PLAIN_PAGE, false);
export const VISITORS_DIRECT_SENSITIVE_SQL = directSql(STORED_PAGE, true);

/** Every statement of this module that reads events, for the static tests. */
export const VISITORS_EVENT_QUERIES = [
  VISITORS_A_SQL,
  VISITORS_B_SQL,
  VISITORS_A_SENSITIVE_SQL,
  VISITORS_B_SENSITIVE_SQL,
  VISITORS_DIRECT_SQL,
  VISITORS_DIRECT_SENSITIVE_SQL,
];

interface DirectRow {
  lv: "t" | "k" | "d" | "a" | "g";
  k: string | null;
  d: string | null;
  a: string | null;
  p: string | null;
  visits: number;
  page_views: number;
  conversions: number;
}

interface GroupRow {
  lv: Level;
  k: string | null;
  s: string | null;
  n: string | null;
  r: string | null;
  p: string | null;
  b: string | null;
  t: number | null;
  visits: number;
  page_views: number;
  conversions: number;
  markerless: number;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** The query parameters of a filter, as the endpoint reads them. */
export type VisitorsFilterInput = Partial<Record<keyof VisitorsFilters, string | null>>;

const INTENTS: ReadonlySet<string> = new Set(INTENT_DIMENSIONS);
const SOURCES: ReadonlySet<string> = new Set(SOURCE_DIMENSIONS);

/** A version word of the chosen key: `intent:source` or `*:source`, `original`, `as_built`. */
export function isVersionWord(v: string, by: VisitorsVersionBy): boolean {
  if (v === "original" || v === "as_built") return true;
  const [intent, source, ...rest] = v.split(":");
  if (rest.length > 0 || !source || !SOURCES.has(source)) return false;
  return by === "source" ? intent === "*" : INTENTS.has(intent ?? "");
}

/**
 * The filters checked against their lists: the applied values, or the
 * error the endpoint answers with 400. The floors (a name or page under 5
 * visits) are checked after the read, on the window without filters.
 */
export function parseVisitorsFilters(
  q: VisitorsFilterInput,
  by: VisitorsVersionBy,
): { ok: true; filters: VisitorsFilters } | { ok: false; error: string } {
  const val = (k: keyof VisitorsFilters) => {
    const v = q[k];
    return typeof v === "string" && v !== "" ? v : null;
  };
  const filters: VisitorsFilters = {
    country: val("country"),
    source: val("source"),
    name: val("name"),
    version: val("version"),
    page: val("page"),
  };
  const { country, source, name, version, page } = filters;
  if (country !== null && country !== COUNTRY_NONE && !isStoredCountry(country)) {
    return { ok: false, error: "country must be an ISO code, other or none" };
  }
  if (source !== null && source !== "none" && !SOURCES.has(source)) {
    return { ok: false, error: "source must be a source word or none" };
  }
  if (name !== null && !isSourceName(name)) {
    return { ok: false, error: "name must be a platform name the page shows" };
  }
  if (version !== null && !isVersionWord(version, by)) {
    return {
      ok: false,
      error:
        by === "source"
          ? "version must be *:source, original or as_built"
          : "version must be intent:source, original or as_built",
    };
  }
  if (page !== null && (!page.startsWith("/") || page.length > 512)) {
    return { ok: false, error: "page must be a page path the page shows" };
  }
  return { ok: true, filters };
}

/** The query parameters of the direct panel's own filters. */
export type VisitorsDirectFilterInput = Partial<Record<keyof VisitorsDirectFilters, string | null>>;

export const NO_DIRECT_FILTERS: VisitorsDirectFilters = { device: null, view: null, landing: null };

/**
 * The direct panel's filters checked against their lists: the applied
 * values, or the error the endpoint answers with 400. A landing page under
 * the listing floor is refused after the read, like `page`.
 */
export function parseDirectFilters(
  q: VisitorsDirectFilterInput,
): { ok: true; filters: VisitorsDirectFilters } | { ok: false; error: string } {
  const val = (k: keyof VisitorsDirectFilters) => {
    const v = q[k];
    return typeof v === "string" && v !== "" ? v : null;
  };
  const filters: VisitorsDirectFilters = {
    device: val("device"),
    view: val("view"),
    landing: val("landing"),
  };
  const { device, view, landing } = filters;
  if (device !== null && device !== "none" && !isDeviceClass(device)) {
    return { ok: false, error: "device must be mobile, tablet, desktop, other or none" };
  }
  if (view !== null && view !== "app" && view !== "browser" && view !== "none") {
    return { ok: false, error: "view must be app, browser or none" };
  }
  if (landing !== null && (!landing.startsWith("/") || landing.length > 512)) {
    return { ok: false, error: "landing must be a page path the page shows" };
  }
  return { ok: true, filters };
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

function counts(r: { visits: unknown; page_views: unknown; conversions: unknown }): VisitorsCounts {
  const visits = Number(r.visits) || 0;
  const conversions = Number(r.conversions) || 0;
  return {
    visits,
    page_views: Number(r.page_views) || 0,
    conversions,
    rate: rateOf(conversions, visits),
  };
}

const ZERO = { visits: 0, page_views: 0, conversions: 0 };

/** The stored country as the API gives it: a listed code or `other`, else null (not recorded). */
function countryOut(raw: string | null): string | null {
  return isStoredCountry(raw) ? raw : null;
}

/** What a version word stands for, and its two words when it is a version. */
export function versionOf(word: string): {
  kind: VisitorsVersionKind;
  intent_dim: string | null;
  source_dim: string | null;
} {
  if (word === "original" || word === "as_built") {
    return { kind: word, intent_dim: null, source_dim: null };
  }
  const [intent, source] = word.split(":");
  return {
    kind: "version",
    intent_dim: intent && intent !== "*" ? intent : null,
    source_dim: source ?? null,
  };
}

/** Code-point order, the same in every runtime (localeCompare is not). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorts a key with no value (a country not recorded) after every other. */
const LAST = "\uffff";

/** Busiest first, then by key, so the order is stable. */
function byVisits<T extends VisitorsCounts>(key: (r: T) => string): (a: T, b: T) => number {
  return (a, b) => b.visits - a.visits || b.page_views - a.page_views || cmp(key(a), key(b));
}

/**
 * Countries merged on the way out: a value off the closed list is not a
 * country, so it joins the not-recorded row (null), never shows as itself.
 */
function mergeByKey<T extends VisitorsCounts>(rows: T[], key: (r: T) => string): T[] {
  const out = new Map<string, T>();
  for (const r of rows) {
    const k = key(r);
    const e = out.get(k);
    if (!e) {
      out.set(k, { ...r });
      continue;
    }
    // Two raw values that read as one key (not recorded, and a value the
    // edge never writes): distinct groups in SQL, so the sum may count a
    // visit twice. Only ever for rows outside the closed list.
    e.visits += r.visits;
    e.page_views += r.page_views;
    e.conversions += r.conversions;
    e.rate = rateOf(e.conversions, e.visits);
  }
  return [...out.values()];
}

/** The row with most clicks (ties: the first by key), or null. */
function topOf<T>(rows: T[], clicks: (r: T) => number, key: (r: T) => string): T | null {
  const sorted = rows
    .filter((r) => clicks(r) > 0)
    .sort((a, b) => clicks(b) - clicks(a) || cmp(key(a), key(b)));
  return sorted[0] ?? null;
}

/**
 * New and returning visitors (ADR 0039): the memory's `first` and `returned`
 * rows in the period, each holding the visitor's code and its visit marker,
 * and the period's clicks on counted buttons joined by that marker. One
 * customer, counts only; a code never leaves this statement.
 */
export const VISITORS_PEOPLE_SQL = `WITH m AS (
    SELECT visit, json_extract(properties, '$.ch') AS ch, json_extract(properties, '$.pid') AS pid
      FROM events WHERE customer_id = ?1 AND ts >= ?2 AND ts <= ?3 AND event_type = 'choice'
       AND json_extract(properties, '$.ch') IN ('first', 'returned')
       AND json_extract(properties, '$.pid') IS NOT NULL AND visit IS NOT NULL),
  c AS (
    SELECT DISTINCT visit FROM events WHERE customer_id = ?1 AND ts >= ?2 AND ts <= ?3
       AND event_type = 'conversion' AND visit IS NOT NULL)
  SELECT
    (SELECT COUNT(DISTINCT pid) FROM m) AS people,
    (SELECT COUNT(DISTINCT pid) FROM m WHERE ch = 'first') AS first_seen,
    (SELECT COUNT(DISTINCT pid) FROM m WHERE ch = 'returned') AS came_back,
    (SELECT COUNT(DISTINCT visit) FROM m WHERE ch = 'returned') AS returning_visits,
    (SELECT COUNT(DISTINCT m.pid) FROM m JOIN c ON c.visit = m.visit) AS converted,
    (SELECT COUNT(DISTINCT m.pid) FROM m JOIN c ON c.visit = m.visit WHERE m.ch = 'returned') AS converted_returning`;

/**
 * Returning visits that got their reason back, by its source word (`answer`
 * for a tapped answer). A remembered source counts only where the visit was
 * served it: a carried page view of that source in the same visit (a new link
 * of its own wins at the edge, and that visit is not counted here). So the
 * number sits inside the source's own row of `by_source`.
 */
export const VISITORS_GIVEN_BACK_SQL = `SELECT g.k AS k, COUNT(DISTINCT g.visit) AS n FROM (
    SELECT r.visit AS visit,
      CASE WHEN json_extract(r.properties, '$.qa') IS NOT NULL THEN 'answer'
           ELSE substr(json_extract(r.properties, '$.rc'), instr(json_extract(r.properties, '$.rc'), ':') + 1) END AS k
      FROM events r WHERE r.customer_id = ?1 AND r.ts >= ?2 AND r.ts <= ?3 AND r.event_type = 'choice'
       AND json_extract(r.properties, '$.ch') = 'returned' AND r.visit IS NOT NULL
       AND (json_extract(r.properties, '$.qa') IS NOT NULL OR json_extract(r.properties, '$.rc') IS NOT NULL)) g
  WHERE g.k = 'answer' OR EXISTS (
    SELECT 1 FROM events e WHERE e.customer_id = ?1 AND e.visit = g.visit AND e.carried = 1
       AND e.source_dim = g.k AND e.event_type IN (${VISIT_EVENTS}))
  GROUP BY g.k`;

/** The people block with nothing counted. */
export const NO_PEOPLE: VisitorsPeople = {
  people: 0,
  new: 0,
  returning: 0,
  returning_visits: 0,
  given_back: {},
  converted: 0,
  converted_returning: 0,
};

/** The people block from its two statements. */
export async function peopleOf(
  db: D1Database,
  customerId: string,
  start: number,
  end: number,
): Promise<VisitorsPeople> {
  const [row, back] = await Promise.all([
    db.prepare(VISITORS_PEOPLE_SQL).bind(customerId, start, end).first<Record<string, unknown>>(),
    db
      .prepare(VISITORS_GIVEN_BACK_SQL)
      .bind(customerId, start, end)
      .all<{ k: unknown; n: unknown }>(),
  ]);
  const n = (k: string) => Number(row?.[k]) || 0;
  const given_back: Record<string, number> = {};
  for (const r of back.results ?? []) {
    const k = String(r.k ?? "");
    if (k === "answer" || /^[a-z]{2,16}$/.test(k)) given_back[k] = Number(r.n) || 0;
  }
  return {
    people: n("people"),
    new: n("first_seen"),
    returning: n("came_back"),
    returning_visits: n("returning_visits"),
    given_back,
    converted: n("converted"),
    converted_returning: n("converted_returning"),
  };
}

export interface VisitorsInput {
  customerId: string;
  window: VisitorsWindow;
  now: number;
  /** The sensitive flag and kept list (lib/sensitive-pages.ts sensitiveSettings). */
  sensitive: SensitiveSettings;
  /** customers.country_off. */
  countryOff: boolean;
  /** Parsed by parseVisitorsFilters; none when absent. */
  filters?: VisitorsFilters;
  /** `version` (intent:source, the default) or `source` (`*:ai`, the mock's families). */
  versionBy?: VisitorsVersionBy;
  /** customers.direct_insights_off (ADR 0038, part 1). */
  directOff?: boolean;
  /** The direct panel's own filters, parsed by parseDirectFilters; none when absent. */
  directFilters?: VisitorsDirectFilters;
}

/** A filter on a name or page under its floor: the read is refused, nothing is sent. */
export class VisitorsFloorError extends Error {}

export const NO_FILTERS: VisitorsFilters = {
  country: null,
  source: null,
  name: null,
  version: null,
  page: null,
};

/** The whole Visitors answer for one customer, window and filter. */
export async function computeVisitors(
  db: D1Database,
  input: VisitorsInput,
): Promise<VisitorsResponse> {
  const { customerId, window, now } = input;
  const filters = input.filters ?? NO_FILTERS;
  const versionBy = input.versionBy ?? "version";
  const w = VISITORS_WINDOWS[window];
  const period = visitorsPeriod(window, now);
  const sens = input.sensitive.sensitive;
  const args = [
    customerId,
    period.start,
    period.end,
    filters.country,
    filters.source,
    filters.name,
    filters.version,
    filters.page,
    w.ms,
    versionBy,
    ...(sens ? [JSON.stringify(input.sensitive.kept)] : []),
  ];
  const directFilters = input.directFilters ?? NO_DIRECT_FILTERS;
  // The page's source, name and version filters keep every no-signal visit
  // (`none`, nothing, `as_built`) or none of them: then no statement runs.
  const directEmpty =
    (filters.source !== null && filters.source !== "none") ||
    filters.name !== null ||
    (filters.version !== null && filters.version !== "as_built");
  const [a, b, versioned, c, people] = await Promise.all([
    db
      .prepare(sens ? VISITORS_A_SENSITIVE_SQL : VISITORS_A_SQL)
      .bind(...args)
      .all<GroupRow>(),
    db
      .prepare(sens ? VISITORS_B_SENSITIVE_SQL : VISITORS_B_SQL)
      .bind(...args)
      .all<GroupRow>(),
    db.prepare(VERSIONED_PAGES_SQL).bind(customerId).all<{ page_path: string }>(),
    directEmpty
      ? Promise.resolve({ results: [] as DirectRow[] })
      : db
          .prepare(sens ? VISITORS_DIRECT_SENSITIVE_SQL : VISITORS_DIRECT_SQL)
          .bind(
            customerId,
            period.start,
            period.end,
            filters.country,
            filters.page,
            directFilters.device,
            directFilters.view,
            directFilters.landing,
            ...(sens ? [JSON.stringify(input.sensitive.kept)] : []),
          )
          .all<DirectRow>(),
    // A failed read leaves the people block at zeros; the rest still answers.
    peopleOf(db, customerId, period.start, period.end).catch(() => NO_PEOPLE),
  ]);
  const rows = [...(a.results ?? []), ...(b.results ?? [])];
  const at = (level: Level) => rows.filter((r) => r.lv === level);

  // The floors, on the window without filters.
  const shownPages = new Set(
    at("pf")
      .filter((r) => r.p !== null && (Number(r.visits) || 0) >= PAGE_MIN_VISITS)
      .map((r) => String(r.p)),
  );
  const shownNames = new Set(
    at("nf")
      .filter(
        (r) =>
          isSourceName(r.n) && r.s !== null && (Number(r.visits) || 0) >= SOURCE_NAME_MIN_VISITS,
      )
      .map((r) => `${r.s}\u0000${r.n}`),
  );
  if (filters.page !== null && !shownPages.has(filters.page)) {
    throw new VisitorsFloorError("page has fewer than 5 visits in this window");
  }
  if (filters.name !== null && ![...shownNames].some((k) => k.endsWith(`\u0000${filters.name}`))) {
    throw new VisitorsFloorError("name has fewer than 5 visits in this window");
  }
  if (directFilters.landing !== null && !shownPages.has(directFilters.landing)) {
    throw new VisitorsFloorError("landing has fewer than 5 visits in this window");
  }

  const all = at("a")[0];
  const totals = all ? counts(all) : counts(ZERO);

  // The series: every bucket of the period, empty ones as zeros.
  const got = new Map(at("t").map((r) => [Number(r.t), r]));
  const points: VisitorsBucket[] = [];
  for (let i = 0; i < w.n; i++) {
    const start = period.start + i * w.ms;
    points.push({ start, ...counts(got.get(start) ?? ZERO) });
  }

  // Sources, with the names that pass the floor inside each signal source.
  const by_source = at("s")
    .map((r) => {
      const source = String(r.s);
      const names: SourceNameCount[] | undefined =
        source === "none"
          ? undefined
          : at("n")
              .filter((x) => x.s === source && shownNames.has(`${source}\u0000${x.n}`))
              .map((x) => ({
                name: String(x.n),
                label: SOURCE_NAME_LABELS[x.n as keyof typeof SOURCE_NAME_LABELS],
                visits: Number(x.visits) || 0,
                conversions: Number(x.conversions) || 0,
              }))
              .sort((x, y) => y.visits - x.visits || cmp(x.name, y.name));
      return { source, ...counts(r), ...(names ? { names } : {}) };
    })
    .sort(byVisits((r) => r.source));

  const by_country = mergeByKey(
    at("k").map((r) => ({ country: countryOut(r.k), ...counts(r) })),
    (r) => r.country ?? "",
  ).sort(byVisits((r) => r.country ?? LAST));

  // Pages: listed when they pass the floor without filters, the rest folded.
  const versionedSet = new Set((versioned.results ?? []).map((r) => String(r.page_path)));
  const pageRows = at("p").map((r) => ({ page_path: String(r.p), ...counts(r) }));
  const listed = pageRows.filter((p) => shownPages.has(p.page_path));
  const under = pageRows.filter((p) => !shownPages.has(p.page_path));
  const by_page = {
    pages: listed
      .map((p) => ({
        ...p,
        group: sens && isGroupPath(p.page_path),
        has_versions: versionedSet.has(p.page_path),
      }))
      .sort(byVisits((r) => r.page_path)),
    other:
      under.length > 0
        ? {
            pages: under.length,
            visits: under.reduce((t, p) => t + p.visits, 0),
            page_views: under.reduce((t, p) => t + p.page_views, 0),
            conversions: under.reduce((t, p) => t + p.conversions, 0),
          }
        : null,
  };

  const by_version = at("r")
    .map((r) => ({ version: String(r.r), ...versionOf(String(r.r)), ...counts(r) }))
    .sort(byVisits((r) => r.version));

  // The buttons: clicks (visits that clicked it), and where most came from.
  // A button with no click here (a page filter keeps its row at 0) is left out.
  const by_button: VisitorsButtonRow[] = at("b")
    .filter((r) => r.b !== null && (Number(r.conversions) || 0) > 0)
    .map((r) => {
      const label = String(r.b);
      const clicks = (x: GroupRow) => Number(x.conversions) || 0;
      const src = topOf(
        at("bs").filter((x) => x.b === label),
        clicks,
        (x) => String(x.s),
      );
      const ctry = topOf(
        mergeByKey(
          at("bk")
            .filter((x) => x.b === label)
            .map((x) => ({ country: countryOut(x.k), ...counts(x) })),
          (x) => x.country ?? "",
        ),
        (x) => x.conversions,
        (x) => x.country ?? LAST,
      );
      const ver = topOf(
        at("br").filter((x) => x.b === label),
        clicks,
        (x) => String(x.r),
      );
      return {
        label,
        clicks: clicks(r),
        top_source: src ? { source: String(src.s), clicks: clicks(src) } : null,
        top_country: ctry ? { country: ctry.country, clicks: ctry.conversions } : null,
        top_version: ver
          ? { version: String(ver.r), kind: versionOf(String(ver.r)).kind, clicks: clicks(ver) }
          : null,
      };
    })
    .sort((x, y) => y.clicks - x.clicks || cmp(x.label, y.label));

  const country_by_version = mergeByKey(
    at("kr").map((r) => ({
      country: countryOut(r.k),
      version: String(r.r),
      kind: versionOf(String(r.r)).kind,
      ...counts(r),
    })),
    (r) => `${r.country ?? ""}\u0000${r.version}`,
  ).sort(byVisits((r) => `${r.country ?? LAST} ${r.version}`));

  const country_by_source = mergeByKey(
    at("ks").map((r) => ({ country: countryOut(r.k), source: String(r.s), ...counts(r) })),
    (r) => `${r.country ?? ""}\u0000${r.source}`,
  ).sort(byVisits((r) => `${r.country ?? LAST} ${r.source}`));

  // A page under the floor never leaves with a country beside it either.
  const country_by_page = mergeByKey(
    at("kp")
      .filter((r) => shownPages.has(String(r.p)))
      .map((r) => ({ country: countryOut(r.k), page_path: String(r.p), ...counts(r) })),
    (r) => `${r.country ?? ""}\u0000${r.page_path}`,
  ).sort(byVisits((r) => `${r.country ?? LAST} ${r.page_path}`));

  const direct = directOf(
    c.results ?? [],
    shownPages,
    versionedSet,
    sens,
    input.directOff === true,
    directFilters,
  );

  return {
    customer_id: customerId,
    window,
    period,
    computed_at: now,
    filters,
    version_by: versionBy,
    country_recording: input.countryOff ? "off" : "on",
    totals,
    markerless_page_views: Number(all?.markerless) || 0,
    series: { bucket: w.bucket, points },
    by_source,
    by_country,
    by_page,
    by_version,
    by_button,
    country_by_version,
    country_by_source,
    country_by_page,
    direct,
    people,
  };
}

/** The direct panel's answer from its statement's rows. */
function directOf(
  rows: DirectRow[],
  shownPages: ReadonlySet<string>,
  versionedSet: ReadonlySet<string>,
  sens: boolean,
  off: boolean,
  filters: VisitorsDirectFilters,
): VisitorsDirect {
  const at = (level: DirectRow["lv"]) => rows.filter((r) => r.lv === level);
  const all = at("t")[0];
  // A landing page under the listing floor, and a visit with no page view in
  // the period (its click's page view fell before), fold into `other`.
  const landings = at("g").map((r) => ({ p: r.p === null ? null : String(r.p), ...counts(r) }));
  const listed = landings.filter(
    (r): r is typeof r & { p: string } => r.p !== null && shownPages.has(r.p),
  );
  const under = landings.filter((r) => r.p === null || !shownPages.has(r.p));
  return {
    recording: off ? "off" : "on",
    filters,
    totals: all ? counts(all) : counts(ZERO),
    by_landing: {
      pages: listed
        .map(({ p, ...n }) => ({
          page_path: p,
          ...n,
          group: sens && isGroupPath(p),
          has_versions: versionedSet.has(p),
        }))
        .sort(byVisits((r) => r.page_path)),
      other:
        under.length > 0
          ? {
              pages: under.filter((r) => r.p !== null).length,
              visits: under.reduce((t, r) => t + r.visits, 0),
              page_views: under.reduce((t, r) => t + r.page_views, 0),
              conversions: under.reduce((t, r) => t + r.conversions, 0),
            }
          : null,
    },
    by_country: mergeByKey(
      at("k").map((r) => ({ country: countryOut(r.k), ...counts(r) })),
      (r) => r.country ?? "",
    ).sort(byVisits((r) => r.country ?? LAST)),
    by_device: mergeByKey(
      at("d").map((r) => ({ device: isDeviceClass(r.d) ? r.d : null, ...counts(r) })),
      (r) => r.device ?? "",
    ).sort(byVisits((r) => r.device ?? LAST)),
    by_view: mergeByKey(
      at("a").map((r) => ({
        view: r.a === "app" ? ("app" as const) : r.a === "browser" ? ("browser" as const) : null,
        ...counts(r),
      })),
      (r) => r.view ?? "",
    ).sort(byVisits((r) => r.view ?? LAST)),
  };
}
