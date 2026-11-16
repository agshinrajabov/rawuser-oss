/**
 * The page guard of a sensitive customer (docs/specs/sensitive-customers.md,
 * "Pages with versions"; privacy review condition 2).
 *
 * For a customer whose site is about health or another special category, a
 * page that is neither `/` nor a kept section is never added, picked,
 * confirmed, taken live or given a counted button: every endpoint that can
 * do one of those answers 409 with the one sentence below. A version on a
 * product page waits for the claims lock and its own ruling.
 *
 * Two more places hold the same rule without a request:
 * - `foreignPages`: what stands outside the list today, for the superadmin
 *   endpoint that turns the flag on or changes the list;
 * - `sensitiveBuckets`: the weekly buckets of the sensitive customers, so a
 *   cross-customer read of the learning counters leaves them out.
 *
 * Operator settings and the customer's own page paths; nothing about a
 * visitor. Offline code only, never in the visitor path.
 */

import {
  SENSITIVE_CUSTOMER_SQL,
  type SensitiveCustomerRow,
  type SensitiveSettings,
  countPageIsGroup,
  countTargetPage,
  groupFixedPart,
  isKeptPage,
  normalizePath,
  sensitiveSettingsFrom,
} from "@rawuser/shared";

/** The one sentence every refused page answers with. */
export const SENSITIVE_PAGE_LINE =
  "This site is about a sensitive topic, so only the homepage and the sections on its kept list can have versions or a counted button.";

/** The machine word beside the sentence, for the dashboard. */
export const SENSITIVE_PAGE_CODE = "sensitive_page";

/** The 409 body of a refused page. */
export interface SensitivePageRefusal {
  error: string;
  code: typeof SENSITIVE_PAGE_CODE;
  /** The page as it would have been stored. */
  page_path: string;
}

/**
 * One customer's flag and list. A read that fails throws: the caller adds
 * no page rather than one under the wrong rule. No row is not sensitive.
 */
export async function loadSensitive(
  db: D1Database,
  customerId: string,
): Promise<SensitiveSettings> {
  const row = await db
    .prepare(SENSITIVE_CUSTOMER_SQL)
    .bind(customerId)
    .first<SensitiveCustomerRow>();
  return sensitiveSettingsFrom(row);
}

/** The refusal for a page under settings already read; null when the page may stand. */
export function pageRefusalUnder(
  settings: SensitiveSettings,
  pagePath: string | null | undefined,
): SensitivePageRefusal | null {
  const page = normalizePath(pagePath);
  if (!settings.sensitive || isKeptPage(page, settings.kept)) return null;
  return { error: SENSITIVE_PAGE_LINE, code: SENSITIVE_PAGE_CODE, page_path: page };
}

/**
 * The same for a page group (docs/specs/page-groups.md): a sensitive
 * customer's group is allowed only when its fixed part is a kept section
 * (`/products/*` with `/products` kept), so a click on any of its pages is
 * stored as `/products/:item` and names no product. The refusal names the
 * pattern. A string that is not a group's page is read as a page.
 */
export function groupRefusalUnder(
  settings: SensitiveSettings,
  pattern: string,
): SensitivePageRefusal | null {
  if (!countPageIsGroup(pattern)) return pageRefusalUnder(settings, pattern);
  if (!settings.sensitive || isKeptPage(groupFixedPart(pattern), settings.kept)) return null;
  return { error: SENSITIVE_PAGE_LINE, code: SENSITIVE_PAGE_CODE, page_path: pattern };
}

/** `groupRefusalUnder` with the settings read; null for a customer that is not sensitive. */
export async function sensitiveGroupRefusal(
  db: D1Database,
  customerId: string,
  pattern: string,
): Promise<SensitivePageRefusal | null> {
  return groupRefusalUnder(await loadSensitive(db, customerId), pattern);
}

/**
 * The 409 body when `pagePath` may not be added, picked, confirmed or taken
 * live for this customer; null when it may. `/` is kept for every customer,
 * so the homepage costs no read.
 */
export async function sensitivePageRefusal(
  db: D1Database,
  customerId: string,
  pagePath: string | null | undefined,
): Promise<SensitivePageRefusal | null> {
  if (normalizePath(pagePath) === "/") return null;
  return pageRefusalUnder(await loadSensitive(db, customerId), pagePath);
}

/**
 * The same for a conversion target: a button picked on a page
 * (`section_path` "count:{page}") is refused with its page; a group's
 * button (`count:/products/*`) passes when the group's fixed part is a kept
 * section; a manifest slot names no page and passes.
 */
export async function sensitiveTargetRefusal(
  db: D1Database,
  customerId: string,
  sectionPath: string | null | undefined,
): Promise<SensitivePageRefusal | null> {
  const page = typeof sectionPath === "string" ? countTargetPage(sectionPath) : null;
  if (page === null) return null;
  if (countPageIsGroup(page)) return sensitiveGroupRefusal(db, customerId, page);
  return sensitivePageRefusal(db, customerId, page);
}

/** What stands outside `/` and a kept list. */
export interface ForeignPages {
  /** Confirmed pages, as stored. */
  pages: string[];
  /** Pages that hold the button picked to count (a target that is switched on). */
  counted: string[];
}

/**
 * The customer's confirmed pages and counted picked buttons that are neither
 * on `/` nor on `kept`. With any of them the flag cannot be on: such a page
 * would get versions, and its `variant_key` or its counted click would name
 * it beside a visit marker. A picked button that is switched off counts
 * nothing and may stay: switching it on is refused like a new pick.
 */
export async function foreignPages(
  db: D1Database,
  customerId: string,
  kept: readonly string[],
): Promise<ForeignPages> {
  const confirmed = await db
    .prepare(
      "SELECT page_path FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL ORDER BY page_path",
    )
    .bind(customerId)
    .all<{ page_path: string }>();
  const targets = await db
    .prepare(
      "SELECT section_path FROM conversion_targets WHERE customer_id = ? AND enabled = 1 ORDER BY section_path",
    )
    .bind(customerId)
    .all<{ section_path: string }>();
  const pages = (confirmed.results ?? [])
    .map((r) => String(r.page_path))
    .filter((p) => !isKeptPage(p, kept));
  const counted: string[] = [];
  for (const t of targets.results ?? []) {
    const page = countTargetPage(String(t.section_path));
    if (page === null || counted.includes(page)) continue;
    // A group's button stands outside only when its fixed part is not kept
    // (docs/specs/page-groups.md): its click is stored as the group.
    const outside = countPageIsGroup(page)
      ? !isKeptPage(groupFixedPart(page), kept)
      : !isKeptPage(page, kept);
    if (outside) counted.push(page);
  }
  return { pages, counted };
}

/**
 * The pages a customer's versions may be written for: every page for a
 * customer that is not sensitive, only `/` and the kept sections for one
 * that is. The backstop behind the 409s (the spec's rule 4: no version on a
 * product page until the claims lock exists). A list of `/` alone costs no
 * read.
 */
export async function keptPagesOnly<T extends { pagePath: string }>(
  db: D1Database,
  customerId: string,
  pages: T[],
): Promise<T[]> {
  if (pages.every((p) => normalizePath(p.pagePath) === "/")) return pages;
  const settings = await loadSensitive(db, customerId);
  return settings.sensitive ? pages.filter((p) => isKeptPage(p.pagePath, settings.kept)) : pages;
}

// ---------------------------------------------------------------------------
// Cross-customer counts (the spec's rule 3)
// ---------------------------------------------------------------------------

/**
 * The bucket the edge files a customer's learning counters under: the first
 * byte of SHA-256("{customer}|{week}") as two hex characters
 * (packages/edge/src/ua-tokens.ts `customerBucket`; ua_token_counts and
 * signal_token_counts, migrations 0017 and 0022). The same formula here, so
 * a read can name a customer's bucket without the edge's code.
 */
export async function customerBucket(customerId: string, week: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${customerId}|${week}`),
  );
  return (new Uint8Array(digest)[0] ?? 0).toString(16).padStart(2, "0");
}

/**
 * The buckets of every sensitive customer for a week, sorted, each once. A
 * cross-customer read of the counters leaves these buckets out: the second
 * line behind the edge, which writes no counter for a sensitive customer.
 * Another customer that shares a bucket (1 in 256) is left out with it,
 * which only makes the "seen across customers" test stricter. A read that
 * fails throws: the caller reports nothing rather than everything.
 */
export async function sensitiveBuckets(db: D1Database, week: string): Promise<string[]> {
  const rows = await db
    .prepare("SELECT id FROM customers WHERE sensitive = 1")
    .all<{ id: string }>();
  const out = new Set<string>();
  for (const r of rows.results ?? []) out.add(await customerBucket(String(r.id), week));
  return [...out].sort();
}
