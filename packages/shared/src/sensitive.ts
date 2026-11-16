/**
 * A customer whose site is about health or another special category
 * (docs/specs/sensitive-customers.md; the privacy review's ruling of
 * 2026-10-12, seven conditions). The contract the edge, the generation
 * worker and the counting side share, so they cannot drift:
 *
 * - `storedPath`: what a page path is stored as beside a visit marker: `/`,
 *   a kept section, that section's group (`/products/:item`), or `/:item`
 *   (condition 1). The same rule for every event type.
 * - `storedVariantKey`: a `variant_key` is stored only when its page is `/`
 *   or a kept section, else NULL.
 * - `isKeptPage`: the pages a sensitive customer may add or confirm
 *   (condition 2: any other page answers 409).
 * - `validKeptSections`: the list as a superadmin may set it.
 * - `foldDay`: the daily counter's fold (condition 4): a group with fewer
 *   than three distinct pages on a day, or fewer than five distinct visits
 *   behind it, becomes one row under the group.
 *
 * Pure string work, no storage, no network. Nothing here is about a
 * visitor: paths of the customer's own site and counts.
 */

import { variantKeyParts } from "./kv-keys.ts";
import { normalizePath } from "./path.ts";
import { segmentHoldsIdentifier } from "./pick.ts";
import { INTENT_DIMENSIONS, SOURCE_DIMENSIONS } from "./vector/dimensions.ts";
import type { VisitorBundle } from "./visitor-bundle.ts";

/** Plain code-unit order: the same on every runtime, whatever its locale. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The segment that stands for "one page of this section". */
export const ITEM_SEGMENT = ":item";

/** What a group's path ends with: `/products/:item`, `/:item`. */
export const GROUP_SUFFIX = `/${ITEM_SEGMENT}`;

/**
 * The path stored when nothing is known about the customer: the edge could
 * read neither the bundle nor the database (condition 3, fail closed). Also
 * what every page but `/` is stored as with an empty list.
 */
export const FAIL_CLOSED_PATH = GROUP_SUFFIX;

/** A group with fewer distinct pages than this on a day is folded (condition 4). */
export const FOLD_MIN_PATHS = 3;

/**
 * A group whose marker rows of the day hold fewer distinct visits than this
 * is folded too (condition 4, corrected on the build's review): three pages
 * do not hide one visit. One visit that opened three product pages leaves
 * three rows stored under the group with one marker, and the counter beside
 * them would name all three.
 */
export const FOLD_MIN_VISITS = 5;

/** The most kept sections a customer may have. */
export const MAX_KEPT_SECTIONS = 50;
/** The longest kept section, in characters. */
export const MAX_KEPT_SECTION_LENGTH = 200;
/** The deepest kept section, in segments (`/a/b/c/d`). */
export const MAX_KEPT_SECTION_DEPTH = 4;

/** One segment of a kept section: unreserved URL characters and percent escapes. */
const PLAIN_SEGMENT = /^[A-Za-z0-9._~%-]+$/;

/** The kept list as given, normalized; an entry that is not a string or is `/` is left out. */
function keptOf(kept: readonly unknown[] | null | undefined): string[] {
  const out: string[] = [];
  for (const k of kept ?? []) {
    if (typeof k !== "string" || k === "") continue;
    const p = normalizePath(k);
    if (p !== "/") out.push(p);
  }
  return out;
}

/**
 * The path stored beside a visit marker for a sensitive customer.
 *
 * `maskedPath` is `maskPath`'s output (identifiers already `:id`; the mask
 * reads case, so it runs first). It is normalized here the way the manifests
 * and every read are (`normalizePath`: lowercase, repeated slashes collapsed,
 * no trailing slash), so the result is always one of a closed set:
 *
 * 1. `/` when it is `/`;
 * 2. itself when it is on the list;
 * 3. the longest listed prefix plus `/:item` when a listed section is a
 *    whole-segment prefix of it (`/products` is a prefix of `/products/x`
 *    and of `/products/x/reviews`, never of `/productsale`);
 * 4. `/:item` otherwise.
 *
 * A group's own path maps to itself, so applying it twice changes nothing.
 * With an empty or unreadable list every page but `/` is `/:item`.
 */
export function storedPath(maskedPath: string, kept: readonly string[] | null | undefined): string {
  const path = normalizePath(maskedPath);
  if (path === "/") return "/";
  const list = keptOf(kept);
  if (list.includes(path)) return path;
  let best = "";
  for (const k of list) {
    if (k.length > best.length && path.startsWith(`${k}/`)) best = k;
  }
  return `${best}${GROUP_SUFFIX}`;
}

/** `/` or a kept section: a page whose path may stand beside a marker as it is. */
export function isKeptPage(path: string, kept: readonly string[] | null | undefined): boolean {
  const p = normalizePath(path);
  return p === "/" || keptOf(kept).includes(p);
}

/** A stored path that stands for a group of pages (`/products/:item`, `/:item`). */
export function isGroupPath(path: string): boolean {
  return path.endsWith(GROUP_SUFFIX);
}

const INTENTS: ReadonlySet<string> = new Set(INTENT_DIMENSIONS);
const SOURCES: ReadonlySet<string> = new Set([...SOURCE_DIMENSIONS, "default"]);

/**
 * The `variant_key` stored for a sensitive customer: the key when it is a
 * real variant key whose page is `/` or a kept section, else null.
 *
 * The edge stores a client's string, so the key is read strictly
 * (`variantKeyParts`): the shape variantKeyForPath builds, an intent and a
 * source from the closed dimension lists ("default" included), a normalized
 * page. Anything else, the empty string too, is null: a free string could
 * name a page in any of its parts. Pass `customerId` (the edge knows it) and
 * the key must also be that customer's, which closes the last free part.
 */
export function storedVariantKey(
  key: string | null | undefined,
  kept: readonly string[] | null | undefined,
  customerId?: string,
): string | null {
  if (typeof key !== "string" || key === "") return null;
  const parts = variantKeyParts(key);
  if (!parts) return null;
  if (customerId !== undefined && parts.customerId !== customerId) return null;
  if (!INTENTS.has(parts.intentDim) || !SOURCES.has(parts.sourceDim)) return null;
  if (normalizePath(parts.pagePath) !== parts.pagePath) return null;
  return isKeptPage(parts.pagePath, kept) ? key : null;
}

/**
 * The kept sections as a superadmin may set them, or null when the input is
 * not a valid list. Each entry is a path of plain segments:
 *
 * - starts with `/`, at most MAX_KEPT_SECTION_LENGTH characters and
 *   MAX_KEPT_SECTION_DEPTH segments;
 * - no query, no fragment, no `:` (so never `:id` or `:item`), no empty,
 *   `.` or `..` segment, only unreserved URL characters and percent escapes;
 * - no segment the count pick's rule flags (`segmentHoldsIdentifier`, read
 *   before lowercasing): a section never names one account.
 *
 * Returned normalized (`normalizePath`), without duplicates, sorted, so the
 * same list is always the same JSON. `/` is always kept and is left out. A
 * trailing slash is dropped. At most MAX_KEPT_SECTIONS entries.
 */
export function validKeptSections(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length > MAX_KEPT_SECTIONS) return null;
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string" || !raw.startsWith("/")) return null;
    if (raw.length > MAX_KEPT_SECTION_LENGTH) return null;
    if (raw === "/") continue;
    const path = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    const segments = path.split("/").slice(1);
    if (segments.length === 0 || segments.length > MAX_KEPT_SECTION_DEPTH) return null;
    for (const seg of segments) {
      if (!PLAIN_SEGMENT.test(seg) || seg === "." || seg === "..") return null;
      if (segmentHoldsIdentifier(seg)) return null;
    }
    out.add(normalizePath(path));
  }
  return [...out].sort();
}

/**
 * `customers.kept_sections` as stored (a JSON array, NULL is empty) back
 * into the list. Anything unreadable is the empty list, which is the
 * strictest one: every page but `/` is then stored as `/:item`.
 */
export function parseKeptSections(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    return validKeptSections(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
}

/** The flag and the list of one customer. */
export interface SensitiveSettings {
  sensitive: boolean;
  /** As validKeptSections returns it; empty for a customer that is not sensitive. */
  kept: string[];
}

/** Not sensitive: nothing changes for such a customer. */
export const NOT_SENSITIVE: SensitiveSettings = { sensitive: false, kept: [] };

/** The read both workers use when the bundle cannot answer (migration 0042). */
export const SENSITIVE_CUSTOMER_SQL = "SELECT sensitive, kept_sections FROM customers WHERE id = ?";

/** The row SENSITIVE_CUSTOMER_SQL returns. */
export interface SensitiveCustomerRow {
  sensitive?: number | null;
  kept_sections?: string | null;
}

/** The settings from a customers row; no row is not sensitive. */
export function sensitiveSettingsFrom(
  row: SensitiveCustomerRow | null | undefined,
): SensitiveSettings {
  if (!row || Number(row.sensitive) !== 1) return NOT_SENSITIVE;
  return { sensitive: true, kept: parseKeptSections(row.kept_sections) };
}

/**
 * The bundle's `s` and `sk` for both bundle writers: empty for a customer
 * that is not sensitive, so its bundle is byte for byte what it was.
 * Neither field is ever copied into `/s/{id}.js` or an answer (condition 5).
 */
export function bundleSensitiveFields(
  settings: SensitiveSettings | null | undefined,
): Pick<VisitorBundle, "s" | "sk"> {
  if (!settings?.sensitive) return {};
  return { s: 1, ...(settings.kept.length > 0 ? { sk: settings.kept } : {}) };
}

/** The settings as the edge reads them from a bundle. */
export function bundleSensitive(
  bundle: Pick<VisitorBundle, "s" | "sk"> | null | undefined,
): SensitiveSettings {
  if (!bundle || bundle.s !== 1) return NOT_SENSITIVE;
  return { sensitive: true, kept: validKeptSections(bundle.sk ?? []) ?? [] };
}

// ---------------------------------------------------------------------------
// The daily counter, page_days (condition 4)
// ---------------------------------------------------------------------------

/**
 * The event types that are one load of a page: the three exposure shapes
 * (written or held out, kept as built, no signal). Exactly one is sent per
 * load, so a count of them is a count of loads. The edge writes page_days
 * for these only; a conversion, a partial report or a snippet issue is not a
 * load.
 */
export const PAGE_DAY_EVENT_TYPES: readonly string[] = [
  "variant_shown",
  "personalization_skipped",
  "no_signal_passthrough",
];

/**
 * The path a load is counted under in page_days: the full masked path,
 * normalized like every stored page (`maskPath` first, then this).
 */
export function pageDayPath(maskedPath: string): string {
  return normalizePath(maskedPath);
}

/** UTC 'YYYY-MM-DD' of a timestamp: the counter's day. */
export function pageDayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * One load: bind (customer_id, day, page_path). Four columns, no timestamp;
 * an upsert, so a day and page have one row.
 */
export const PAGE_DAYS_UPSERT_SQL =
  "INSERT INTO page_days (customer_id, day, page_path, loads) VALUES (?, ?, ?, 1) ON CONFLICT(customer_id, day, page_path) DO UPDATE SET loads = loads + 1";

/** One row of one customer's day in page_days. */
export interface PageDayCount {
  page_path: string;
  loads: number;
}

/** A group to fold: the pages named under it on a day when it is under a floor. */
export interface FoldGroup {
  /** The group's own path, `/products/:item`. */
  group: string;
  /** The named pages that become part of the group's row. */
  paths: string[];
}

/**
 * The distinct visits behind each group on the day: the group's path to the
 * count of `DISTINCT COALESCE(visit, id)` over the day's exposure rows stored
 * under it. A count per group, never a marker.
 */
export type GroupVisits = ReadonlyMap<string, number>;

/**
 * Which rows of one customer's day must be folded. A row is `/` or a kept
 * section (never folded), a group's own row (already folded), or a named
 * page: one whose `storedPath` is a group. A group is folded whole when it
 * has fewer than FOLD_MIN_PATHS distinct named pages that day, or when
 * fewer than FOLD_MIN_VISITS distinct visits stand behind it: beside the
 * marker rows stored under the group that day, a count on a named page
 * would say which page a visit opened.
 *
 * `visits`: the day's distinct visits per group (a group not in it has
 * none). Left out, only the page floor is read: that is for a day whose
 * visit floor was already applied when it was folded (the export), never
 * for the fold itself. A fold only merges, so it never unfolds a day.
 */
export function foldPlan(
  rows: readonly PageDayCount[],
  kept: readonly string[] | null | undefined,
  visits?: GroupVisits | null,
): FoldGroup[] {
  const named = new Map<string, Set<string>>();
  for (const r of rows) {
    const group = storedPath(r.page_path, kept);
    if (group === r.page_path || !isGroupPath(group)) continue;
    const set = named.get(group) ?? new Set<string>();
    set.add(r.page_path);
    named.set(group, set);
  }
  return [...named.entries()]
    .filter(
      ([group, paths]) =>
        paths.size < FOLD_MIN_PATHS ||
        (visits != null && (visits.get(group) ?? 0) < FOLD_MIN_VISITS),
    )
    .map(([group, paths]) => ({ group, paths: [...paths].sort() }))
    .sort((a, b) => byText(a.group, b.group));
}

/**
 * One customer's day as it may be kept and shown: every group under either
 * floor (`foldPlan`) folded into one row under the group's path, its loads
 * added up (to a row the group already has, too). `/`, the kept sections
 * and a group over both floors stay as they are. Folding a folded day
 * changes nothing. Sorted by path. `visits` as in `foldPlan`.
 */
export function foldDay(
  rows: readonly PageDayCount[],
  kept: readonly string[] | null | undefined,
  visits?: GroupVisits | null,
): PageDayCount[] {
  const into = new Map<string, string>();
  for (const g of foldPlan(rows, kept, visits)) for (const p of g.paths) into.set(p, g.group);
  const out = new Map<string, number>();
  for (const r of rows) {
    const path = into.get(r.page_path) ?? r.page_path;
    out.set(path, (out.get(path) ?? 0) + (Number(r.loads) || 0));
  }
  return [...out.entries()]
    .map(([page_path, loads]) => ({ page_path, loads }))
    .sort((a, b) => byText(a.page_path, b.page_path));
}
