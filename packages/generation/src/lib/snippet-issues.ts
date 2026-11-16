/**
 * Snippet issues, the generation side (docs/specs/snippet-issues.md).
 *
 * The snippet sends a `snippet_issue` event when something went wrong on the
 * customer's page: `{ "issues": [{ c, s?, n? }] }`, closed codes, validated
 * at the edge, no visit marker. This module turns those rows into aggregates
 * for the hourly alert and the read endpoint. The rows are kept with the
 * other event rows for the life of the account (ADR 0037).
 *
 * A row is not a load (2026-10-12, "Leaving the page" in the spec): a load
 * sends its list a second after the reveal and `reverted` may follow alone
 * in a second row. A code is in one row of a load at most, so a count here
 * is always the rows that name one code (`COUNT(DISTINCT e.id)` per page and
 * code): never the rows of the type, and never a sum over codes.
 *
 * Privacy (privacy review conditions 5 to 7): only aggregates leave this module
 * (per page and code: a count, a share, the most frequent slot). `n` never
 * leaves it and is read for one thing only, to leave out the exits below.
 * The data is used for that customer's own pages only.
 *
 * The share's denominator is the page's loads: its exposure events
 * (variant_shown, no_signal_passthrough, personalization_skipped) plus the
 * loads that reported `select_failed`, because a load whose /select failed
 * sends no exposure event and would otherwise be missing from its own
 * denominator.
 *
 * `select_failed` with `n` 4 is not a failure (F1; privacy review Q5 in
 * docs/specs/pilot-gaps.md): the visitor left or hid the page while
 * /select was on its way. Such an entry is read as if it were not in the
 * row: in no count, no share, no denominator, no alert and no Pages card
 * line, and it is not counted apart either (condition 4: never a bounce or
 * engagement number, never joined to an exposure). The other codes of the
 * same row count as they would without it.
 *
 * The two "late" codes since the late tag rule (docs/specs/late-tag.md,
 * 2026-10-12): `late_tag` is a page painted before our script ran, which
 * now stays as built (the same loads carry the bit `lp` on their exposure,
 * a different row; this module never reads it). `reveal_cap` is an answer
 * after the cap on a page that was hidden in time; the snippet no longer
 * reports it on a late tag, so the two never name one load and neither
 * needs a split here. A late-tag load still sends exactly one exposure, so
 * the share's denominator is unchanged.
 *
 * A sensitive customer (docs/specs/sensitive-customers.md): a page is the
 * stored path (`/`, a kept section, its group, or `/:item`), applied again
 * here so a row from before the customer was marked never shows a product
 * page, and a group's row carries no `late_tag` line: a late-tag share is
 * not shown per grouped page. The code stays in the customer's totals.
 *
 * The `late_tag` line of a page is given only for a confirmed page
 * (2026-10-12): a page with no versions of its own gets no late line.
 */

import { isGroupPath, maskPath, normalizePath, storedPath } from "@rawuser/shared";
import { sensitiveSettings } from "./sensitive-pages.ts";

/** The closed set of codes (the spec's table); anything else in a row is ignored. */
export const ISSUE_CODES = [
  "select_failed",
  "reveal_cap",
  "apply_error",
  "rich_failed",
  "lines_changed",
  "swap_shift",
  "reverted",
  "late_tag",
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];
const CODE_SET: ReadonlySet<string> = new Set(ISSUE_CODES);

/** Our own manifest paths, as the edge validates them. */
const SLOT_PATH = /^[a-z_]+(\.[a-z_]+){1,3}$/;
const MAX_SLOT_LENGTH = 40;

/** The event types that mark one page load. */
export const EXPOSURE_EVENT_TYPES = [
  "variant_shown",
  "no_signal_passthrough",
  "personalization_skipped",
] as const;

/** Alert when a code is on at least this share of loads... */
export const ISSUE_ALERT_SHARE = 0.05;
/** ...and on at least this many loads. */
export const ISSUE_ALERT_MIN_COUNT = 20;

/**
 * The floor follows the customer's traffic (the first outside pilot, 2026-10-12,
 * docs/specs/pilot-gaps.md F4.1). The pilot has about 70 loads a day and
 * about one load in ten failed `/select`, six to ten a day: at any rate a
 * site that size never reaches 20 loads of one code in 24 hours, so the
 * alert never fired. A customer under this many loads a day is looked at
 * over 72 hours with a floor of 8 loads of one code; the share is the same.
 */
export const ISSUE_SMALL_SITE_LOADS_PER_DAY = 200;
export const ISSUE_SMALL_SITE_HOURS = 72;
export const ISSUE_SMALL_SITE_MIN_COUNT = 8;

/** The read endpoint's window: default and ceiling (condition 6). */
export const ISSUE_HOURS_DEFAULT = 24;
export const ISSUE_HOURS_MAX = 744;

const HOUR_MS = 60 * 60 * 1000;

export interface IssueStat {
  code: IssueCode;
  /** Page loads whose issues contain this code. */
  count: number;
  /** count / loads, 0 to 1. */
  share: number;
  /** The slot this code named most often on these loads; null when it names none. */
  slot: string | null;
}

export interface PageIssues {
  page_path: string;
  /** Exposure events plus the loads whose /select failed on this page (never an exit). */
  loads: number;
  issues: IssueStat[];
}

export interface CodeTotal extends IssueStat {
  /** All loads of the customer in the window. */
  loads: number;
  /** The page with the most loads carrying this code. */
  page_path: string;
}

export interface CustomerIssues {
  loads: number;
  pages: PageIssues[];
  totals: CodeTotal[];
}

/** count / loads, never over 1, 0 when there are no loads. */
export function issueShare(count: number, loads: number): number {
  if (!(loads > 0) || !(count > 0)) return 0;
  return Math.min(1, count / loads);
}

/**
 * The spec's threshold: at least 5% of loads and at least `minCount` loads
 * (20; 8 for a small site over its longer window).
 */
export function issueAlertDue(
  count: number,
  share: number,
  minCount: number = ISSUE_ALERT_MIN_COUNT,
): boolean {
  return count >= minCount && share >= ISSUE_ALERT_SHARE;
}

/**
 * True when the customer's traffic is under the small-site line: fewer than
 * 200 loads in the last 24 hours and fewer than 200 a day over the last 72.
 * Both, so a site that went live yesterday with 300 loads is not small, and
 * a busy site on one quiet day is not either.
 */
export function isSmallSite(loads24h: number, loads72h: number): boolean {
  return (
    loads24h < ISSUE_SMALL_SITE_LOADS_PER_DAY &&
    loads72h / (ISSUE_SMALL_SITE_HOURS / 24) < ISSUE_SMALL_SITE_LOADS_PER_DAY
  );
}

/**
 * Parses the endpoint's `hours`: absent means 24, a positive integer is
 * capped at 744, anything else is null (the caller answers 400).
 */
export function parseIssueHours(raw: string | null): number | null {
  if (raw === null) return ISSUE_HOURS_DEFAULT;
  if (!/^\d+$/.test(raw)) return null;
  const h = Number(raw);
  if (h < 1) return null;
  return Math.min(h, ISSUE_HOURS_MAX);
}

/** Highest count first, then the name, so ties are stable. */
function topKey(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && k < best)) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/**
 * A stored page path as the manifests key it, with any identifier masked
 * (docs/specs/event-paths.md): rows written before the edge masked are
 * folded into `:id` here, so no identifier reaches the dashboard or an alert.
 */
function plainPageOf(p: string | null): string {
  // Masked before lowercasing: a mixed-case token stays visible to the rule.
  return p ? normalizePath(maskPath(p)) : "/";
}

function bump(m: Map<string, number>, k: string, by: number): void {
  m.set(k, (m.get(k) ?? 0) + by);
}

/** The issues array of a row, parsed inside SQLite; a malformed row yields nothing. */
const ISSUES_OF = `json_each(CASE WHEN json_valid(e.properties) THEN e.properties ELSE '{}' END, '$.issues')`;

/** `select_failed` with this `n`: the page was left or hidden while we asked. */
export const SELECT_FAILED_EXIT = 4;

/**
 * True for every entry but an exit (`select_failed` with `n` 4). `IS NOT`,
 * so an entry without `n` (most codes carry none) stays in: with `!=` a NULL
 * would drop it.
 */
const COUNTED_ENTRY = `(json_extract(j.value, '$.c') IS NOT 'select_failed' OR json_extract(j.value, '$.n') IS NOT ${SELECT_FAILED_EXIT})`;

/**
 * Aggregates one customer's snippet issues since `sinceMs`. Three queries,
 * each on idx_events_customer_type_ts (customer_id, event_type, ts); the
 * per-row JSON is unpacked and counted inside D1, so no row comes back.
 */
export async function aggregateCustomerIssues(
  db: D1Database,
  customerId: string,
  sinceMs: number,
  opts: { ownPagesOnly?: boolean } = {},
): Promise<CustomerIssues> {
  // Loads per (page, code): a row that names a code twice counts once, and a
  // code is in one row of a load at most, so rows per code are loads. An
  // exit is no entry at all (COUNTED_ENTRY).
  const byCode = await db
    .prepare(
      `SELECT e.page_path AS page_path, json_extract(j.value, '$.c') AS code,
              COUNT(DISTINCT e.id) AS loads
       FROM events e, ${ISSUES_OF} j
       WHERE e.customer_id = ? AND e.event_type = 'snippet_issue' AND e.ts >= ?
         AND ${COUNTED_ENTRY}
       GROUP BY e.page_path, code`,
    )
    .bind(customerId, sinceMs)
    .all<{ page_path: string | null; code: unknown; loads: number }>();

  const codeRows = (byCode.results ?? []).filter(
    (r): r is { page_path: string | null; code: IssueCode; loads: number } =>
      typeof r.code === "string" && CODE_SET.has(r.code),
  );
  if (codeRows.length === 0) return { loads: 0, pages: [], totals: [] };

  // Read only once there is a row to show, so a customer with no issue still
  // costs one lookup. For a sensitive customer every path below is the
  // stored one.
  const sensitive = await sensitiveSettings(db, customerId);
  // The customer's pages with versions of their own, for the late line.
  const confirmed = await confirmedPages(db, customerId);
  const pageOf = (p: string | null): string =>
    sensitive.sensitive ? storedPath(maskPath(p || "/"), sensitive.kept) : plainPageOf(p);
  /** A page with versions of its own; a sensitive customer's group never is. */
  const ownPage = (page: string): boolean =>
    confirmed.has(page) && !(sensitive.sensitive && isGroupPath(page));
  // The totals count only such pages when asked (the hourly alert): on any
  // other page nothing is hidden or written, so a failure there changes
  // nothing a visitor sees (the pilot, 2026-10-18: 30 of 36 failed selects were
  // on product pages without versions, and the line read 5% where the pages
  // with versions had 3 in 121). A customer with no such page keeps every
  // page, as the snippet treats every page as its own then.
  const inTotals = (page: string): boolean =>
    !opts.ownPagesOnly || confirmed.size === 0 || ownPage(page);

  // Mentions per (page, code, slot), for the most frequent slot.
  const bySlot = await db
    .prepare(
      `SELECT e.page_path AS page_path, json_extract(j.value, '$.c') AS code,
              json_extract(j.value, '$.s') AS slot, COUNT(*) AS mentions
       FROM events e, ${ISSUES_OF} j
       WHERE e.customer_id = ? AND e.event_type = 'snippet_issue' AND e.ts >= ?
         AND ${COUNTED_ENTRY}
         AND json_extract(j.value, '$.s') IS NOT NULL
       GROUP BY e.page_path, code, slot`,
    )
    .bind(customerId, sinceMs)
    .all<{ page_path: string | null; code: unknown; slot: unknown; mentions: number }>();

  // Exposure events per page: the denominator.
  const exposures = await db
    .prepare(
      `SELECT page_path, COUNT(*) AS n FROM events
       WHERE customer_id = ? AND event_type IN (${EXPOSURE_EVENT_TYPES.map(() => "?").join(", ")})
         AND ts >= ?
       GROUP BY page_path`,
    )
    .bind(customerId, ...EXPOSURE_EVENT_TYPES, sinceMs)
    .all<{ page_path: string | null; n: number }>();

  // The edge stores page_path as sent (query and fragment cut); fold the
  // spellings of one route ("/az/" and "/az") into the normalized path the
  // manifests use.
  const pageLoads = new Map<string, number>();
  for (const r of exposures.results ?? []) {
    bump(pageLoads, pageOf(r.page_path), Number(r.n) || 0);
  }

  const counts = new Map<string, Map<IssueCode, number>>();
  for (const r of codeRows) {
    const page = pageOf(r.page_path);
    let m = counts.get(page);
    if (!m) {
      m = new Map();
      counts.set(page, m);
    }
    m.set(r.code, (m.get(r.code) ?? 0) + (Number(r.loads) || 0));
    // Failed selects only: an exit never reaches this loop, so a load that
    // was left adds nothing to the page's loads.
    if (r.code === "select_failed") bump(pageLoads, page, Number(r.loads) || 0);
  }

  const slots = new Map<string, Map<string, number>>(); // `${page}\n${code}` -> slot -> mentions
  const slotsByCode = new Map<IssueCode, Map<string, number>>();
  for (const r of bySlot.results ?? []) {
    if (typeof r.code !== "string" || !CODE_SET.has(r.code)) continue;
    if (typeof r.slot !== "string" || r.slot.length > MAX_SLOT_LENGTH || !SLOT_PATH.test(r.slot))
      continue;
    const code = r.code as IssueCode;
    const key = `${pageOf(r.page_path)}\n${code}`;
    let m = slots.get(key);
    if (!m) {
      m = new Map();
      slots.set(key, m);
    }
    bump(m, r.slot, Number(r.mentions) || 0);
    let c = slotsByCode.get(code);
    if (!c) {
      c = new Map();
      slotsByCode.set(code, c);
    }
    bump(c, r.slot, Number(r.mentions) || 0);
  }

  const pages: PageIssues[] = [];
  const codeCount = new Map<IssueCode, number>();
  const codePages = new Map<IssueCode, Map<string, number>>();
  for (const [page, m] of counts) {
    const loads = pageLoads.get(page) ?? 0;
    const issues: IssueStat[] = [];
    for (const [code, count] of m) {
      issues.push({
        code,
        count,
        share: issueShare(count, loads),
        slot: topKey(slots.get(`${page}\n${code}`) ?? new Map()),
      });
      if (!inTotals(page)) continue;
      codeCount.set(code, (codeCount.get(code) ?? 0) + count);
      let p = codePages.get(code);
      if (!p) {
        p = new Map();
        codePages.set(code, p);
      }
      bump(p, page, count);
    }
    issues.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
    // A late line only on a page with versions of its own: a page without
    // them is left as built whatever the tag does, so "the version came
    // late" is not true of it (docs/specs/late-tag.md; such a load sends no
    // `late_tag` any more, this drops the rows from before). A sensitive
    // customer's group is never such a page. The totals above keep the code.
    // A page left with no line is not listed.
    const lateLine = ownPage(page);
    const shown = lateLine ? issues : issues.filter((i) => i.code !== "late_tag");
    if (shown.length === 0) continue;
    pages.push({ page_path: page, loads, issues: shown });
  }
  pages.sort((a, b) => b.loads - a.loads || a.page_path.localeCompare(b.page_path));

  let totalLoads = 0;
  for (const [page, n] of pageLoads) if (inTotals(page)) totalLoads += n;

  const totals: CodeTotal[] = [];
  for (const [code, count] of codeCount) {
    totals.push({
      code,
      count,
      loads: totalLoads,
      share: issueShare(count, totalLoads),
      slot: topKey(slotsByCode.get(code) ?? new Map()),
      page_path: topKey(codePages.get(code) ?? new Map()) ?? "/",
    });
  }
  totals.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  return { loads: totalLoads, pages, totals };
}

/** The window start for `hours` back from `now`. */
export function issueWindowStart(now: number, hours: number): number {
  return now - hours * HOUR_MS;
}

export interface DueIssue {
  total: CodeTotal;
  /** The window the numbers are over: 24, or 72 for a small site. */
  hours: number;
}

/**
 * The codes of one customer that are due an alert now.
 *
 * A site of 200 loads a day or more: the last 24 hours, 5% and 20 loads, as
 * before. A smaller site: the last 72 hours, 5% and 8 loads, and only a code
 * seen in the last 24 hours, so a burst that stopped does not come back on
 * the next two days. A customer with no issue row in the last 24 hours
 * costs one indexed lookup, as before. Loads, shares and the site's size
 * count only the pages with versions of their own (`ownPagesOnly`), or
 * every page for a customer with none.
 */
export async function dueIssues(
  db: D1Database,
  customerId: string,
  now: number,
): Promise<DueIssue[]> {
  const day = await aggregateCustomerIssues(
    db,
    customerId,
    issueWindowStart(now, ISSUE_HOURS_DEFAULT),
    { ownPagesOnly: true },
  );
  if (day.totals.length === 0) return [];
  const usual = (): DueIssue[] =>
    day.totals
      .filter((t) => issueAlertDue(t.count, t.share))
      .map((total) => ({ total, hours: ISSUE_HOURS_DEFAULT }));
  if (day.loads >= ISSUE_SMALL_SITE_LOADS_PER_DAY) return usual();
  const three = await aggregateCustomerIssues(
    db,
    customerId,
    issueWindowStart(now, ISSUE_SMALL_SITE_HOURS),
    { ownPagesOnly: true },
  );
  if (!isSmallSite(day.loads, three.loads)) return usual();
  const recent = new Set(day.totals.map((t) => t.code));
  return three.totals
    .filter(
      (t) => recent.has(t.code) && issueAlertDue(t.count, t.share, ISSUE_SMALL_SITE_MIN_COUNT),
    )
    .map((total) => ({ total, hours: ISSUE_SMALL_SITE_HOURS }));
}

/** The customer's confirmed manifest pages, normalized. */
export async function confirmedPages(db: D1Database, customerId: string): Promise<Set<string>> {
  const rows = await db
    .prepare(
      "SELECT page_path FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL",
    )
    .bind(customerId)
    .all<{ page_path: string }>();
  return new Set((rows.results ?? []).map((r) => normalizePath(r.page_path)));
}

/**
 * The Telegram line (condition 5): customer id, code, share, count, slot,
 * and the page only when it is a confirmed manifest page. Never `n`, never
 * row data. `still` is the day of a run of lines when one is sent again
 * after a quiet week ("still, day 8").
 */
export function issueAlertLine(
  customerId: string,
  total: CodeTotal,
  confirmed: ReadonlySet<string>,
  hours = ISSUE_HOURS_DEFAULT,
  still: number | null = null,
): string {
  const pct = Math.round(total.share * 100);
  const page = confirmed.has(total.page_path) ? total.page_path : "another page";
  const where = total.slot ? `${total.slot}, ${page}` : page;
  const tail = still === null ? "" : ` · still, day ${still}`;
  return `snippet-issue · ${customerId} · ${total.code} on ${pct}% of loads, ${total.count} of ${total.loads} (${where}) · ${hours} h${tail}`;
}

// ---------------------------------------------------------------------------
// When a line is sent again (2026-10-13: the founder got the same two lines
// on two days running; a line is news or it is not sent)
// ---------------------------------------------------------------------------

/**
 * Codes the daily line never carries. `late_tag` is where the customer's
 * tag sits, not a fault and not an incident: the Pages card and Connect
 * already say it, and the Monday message carries one line a week per
 * customer over the threshold (cron/late-tag-weekly.ts).
 */
export const DAILY_LINE_EXCLUDED: ReadonlySet<IssueCode> = new Set<IssueCode>(["late_tag"]);

/** A line is sent again when the share is at least this many times the last sent one. */
export const ISSUE_REPEAT_RISE = 1.5;
/** ...or when this long has passed since the last line. */
export const ISSUE_REPEAT_MS = 7 * 24 * HOUR_MS;
/** A code under the threshold for more than this long ends its run of lines. */
export const ISSUE_QUIET_MS = 24 * HOUR_MS;
/** The marker outlives a missed pass or two; refreshed every pass the code is over the line. */
export const ISSUE_MARKER_TTL_S = 2 * 24 * 3600;

/** The KV value behind `ops:alert:snippet-issue:{customer}:{code}`. */
export interface IssueAlertMarker {
  /** When this run of lines began (the first line sent). */
  first: number;
  /** The last line sent. */
  last: number;
  /** Its share; null for a marker from before the shares were kept. */
  share: number | null;
  /** The last hourly pass on which the code was over the threshold. */
  seen: number;
}

/** A marker as stored; the old form (a bare timestamp) reads as a line sent then. */
export function readIssueMarker(raw: string | null): IssueAlertMarker | null {
  if (raw === null) return null;
  if (/^\d+$/.test(raw)) {
    const t = Number(raw);
    return { first: t, last: t, share: null, seen: t };
  }
  try {
    const m = JSON.parse(raw) as Partial<IssueAlertMarker>;
    if (typeof m.first !== "number" || typeof m.last !== "number" || typeof m.seen !== "number")
      return null;
    return {
      first: m.first,
      last: m.last,
      share: typeof m.share === "number" ? m.share : null,
      seen: m.seen,
    };
  } catch {
    return null;
  }
}

export interface IssueLineDecision {
  /** Send the line now. */
  send: boolean;
  /** The day of the run when the line is sent after a quiet week, else null. */
  still: number | null;
  /** The marker to store after this pass. */
  marker: IssueAlertMarker;
}

/**
 * Whether a code over the threshold gets a line on this pass. News is: no
 * line in this run yet (none, or the code was under the threshold for a
 * day), the share risen by at least half since the last line, or seven
 * days since the last line (then the line says "still, day N"). Otherwise
 * the marker only records that the code is still over the line.
 */
export function issueLineDecision(
  marker: IssueAlertMarker | null,
  share: number,
  now: number,
): IssueLineDecision {
  if (marker === null || now - marker.seen > ISSUE_QUIET_MS) {
    return { send: true, still: null, marker: { first: now, last: now, share, seen: now } };
  }
  const sent = { ...marker, last: now, share, seen: now };
  if (marker.share !== null && marker.share > 0 && share >= marker.share * ISSUE_REPEAT_RISE) {
    return { send: true, still: null, marker: sent };
  }
  if (now - marker.last >= ISSUE_REPEAT_MS) {
    const day = Math.floor((now - marker.first) / (24 * HOUR_MS)) + 1;
    return { send: true, still: day, marker: sent };
  }
  return { send: false, still: null, marker: { ...marker, seen: now } };
}

/** True when a code with a marker has been under the threshold for a day: one "back under" line, then the marker goes. */
export function issueBackUnder(marker: IssueAlertMarker | null, now: number): boolean {
  return marker !== null && now - marker.seen > ISSUE_QUIET_MS;
}

/** The quiet line after a run: no numbers, sent once. */
export function issueBackUnderLine(customerId: string, code: IssueCode): string {
  return `snippet-issue · ${customerId} · ${code} back under the threshold`;
}
