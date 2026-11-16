/**
 * The visitor bundle (2026-10-01, the /select tail): what a personalised
 * /select answer carries besides the version, kept in KV so the visitor
 * path reads no database. One key per customer: every confirmed page's
 * manifest (the wrap measurement left out; generation alone reads it; and
 * without the buttons the operator has not turned on, button-rewrite.ts)
 * and the enabled conversion targets. Written by generation with the hide
 * rules; the edge falls back to D1 and writes it back when the key is
 * missing. Page facts and selectors only; nothing about a visitor.
 *
 * Measured before it (144 calls from the founder's machine, Server-Timing): the two D1
 * reads took p50 50 ms, max 236 ms on every personalised answer, the stage
 * with the widest spread.
 */

import { normalizeAuditDomain } from "./audit.ts";
import { writtenManifest } from "./button-rewrite.ts";
import type { DirectBundleFields } from "./direct.ts";
import { type KeywordLexicon, parseStoredLexicon } from "./keyword-lexicon.ts";
import { isPageGroupPattern } from "./page-groups.ts";
import {
  SITE_CONFIDENCES,
  type SitePathMap,
  type SitePathRow,
  isSiteKindOrNone,
  parseServed,
  sitePathMap,
} from "./site-map/index.ts";
import type { IntentDim, Manifest } from "./types.ts";

export interface ConversionTargetForClient {
  section_path: string;
  conversion_label: string;
  css: string[];
  text: string[];
  structural: string;
}

/**
 * The direct fields (`dp`, `mk`, `dl`; docs/specs/direct-visitors.md §6)
 * come from DirectBundleFields; like every field here, never sent to a browser.
 */
export interface VisitorBundle extends DirectBundleFields {
  v: 1;
  /**
   * page_path (as stored, normalized) → its confirmed manifest, the parts
   * Rawuser writes: a button that stays as built is not in it.
   */
  pages: Record<string, Manifest>;
  /** Every enabled conversion target, a counted button whatever its rewrite switch says. */
  conv: ConversionTargetForClient[];
  /**
   * The customer's holdout percent, 0 to 50 (docs/specs/proof-engine.md,
   * section A). Absent when customers.holdout_percent is NULL: the edge's
   * env default applies.
   */
  h?: number;
  /**
   * The customer's site map (docs/specs/site-shaped-intents.md §5): page
   * path → [kind, weight]. Paths and kinds only, never a link text. Absent
   * when the map is off or empty: the global path table alone applies.
   * The edge reads it and answers with a selection; it never reaches a
   * browser.
   */
  pm?: SitePathMap;
  /** The intents this site serves (§7), absent when all six are. */
  sd?: IntentDim[];
  /**
   * The free AI-traffic audit (docs/specs/ai-traffic-audit.md §3.4): `1` for
   * an audit customer (`customers.plan = 'audit'`), absent otherwise. With
   * `a`, the edge writes `found_by`, runs the host and end check
   * (`auditRefusal`) before every answer that leads to an event, and skips
   * every learning counter.
   */
  a?: 1;
  /**
   * The audit domain (`normalizeAuditDomain` of `customers.domain`): lower
   * case, no scheme, port, path or leading `www.`. Present only with `a`.
   * The Origin host must equal it or end with `.` plus it.
   */
  ad?: string;
  /**
   * The audit's end, unix ms (`customers.audit_ends_at`). Present only with
   * `a`, and only once set: the 28-day ceiling when the counting window
   * starts, then release plus 7 days (never past the ceiling), or the time
   * of End now, or of a lapse. From `ae` on, the record-nothing answer.
   */
  ae?: number;
  /**
   * `1` for a customer whose site is about health or another special
   * category (docs/specs/sensitive-customers.md; `customers.sensitive`),
   * absent otherwise. With `s` the edge stores a page path as `storedPath`
   * returns it and a `variant_key` as `storedVariantKey` does, counts the
   * load in page_days, and skips every cross-customer counter. For the edge
   * alone: neither `s` nor `sk` is ever copied into `/s/{id}.js`, a /select
   * answer or an event row (privacy review condition 5: the script and
   * every answer are byte for byte the same with `s` set and unset).
   */
  s?: 1;
  /**
   * The kept sections (`customers.kept_sections`, as validKeptSections
   * returns them): the paths that may stand beside a visit marker as they
   * are. Present only with `s`, absent when the list is empty. Never sent to
   * a browser, like `s`.
   */
  sk?: string[];
  /**
   * The customer's page groups (docs/specs/page-groups.md): the accepted
   * patterns (`/products/*`), sorted, absent when there are none. Read by
   * nothing on the visitor path in phase 1 (a group's counted button is a
   * `count:` target in `conv` whose page is the pattern); the door for
   * phase 2. Never copied into `/s/{id}.js` or an answer (privacy review
   * condition 7).
   */
  g?: string[];
  /**
   * "No events" (docs/specs/readiness-check.md, "As approved", privacy review
   * condition 2): `1` while the operator answered yes to the special-category
   * question (`customers.special_category = 1`) and no superadmin has marked
   * the site yet (`customers.sensitive = 0`), absent otherwise. With `ne` the
   * edge stores no event row and counts nothing for that customer, so no
   * product path gathers unmarked before the mark. For the edge alone, like
   * `s`: never in `/s/{id}.js`, a /select answer or an event (condition 4).
   */
  ne?: 1;
  /**
   * The customer's keyword lexicon (docs/specs/keyword-intent.md §4;
   * `customers.keyword_lexicon`): intent → folded phrases. Absent when the
   * customer has none, turned keyword reading off (`customers.keyword_off`),
   * is marked sensitive, or answered yes to the special-category question
   * (privacy review, section 10, conditions 8 and 10). For the edge alone: never
   * in `/s/{id}.js`, a /select answer, an event, a log or an alert.
   */
  kl?: KeywordLexicon;
  /**
   * The country off switch (ADR 0036, point 6; `customers.country_off`):
   * `1` when the customer turned country recording off, absent otherwise.
   * With `co` the edge writes no `events.country`. For the edge alone, like
   * `s`: never in `/s/{id}.js`, a /select answer or an event (test).
   */
  co?: 1;
  /**
   * The direct-insights off switch (ADR 0038, part 1;
   * `customers.direct_insights_off`): `1` when the customer turned it off,
   * absent otherwise. With `dx` the edge writes no `events.device_class` and
   * no `events.web_view`. For the edge alone, like `co`: never in
   * `/s/{id}.js`, a /select answer or an event (test).
   */
  dx?: 1;
}

/**
 * The read both bundle writers make for `co` (migration 0048) and `dx`
 * (migration 0050): the two switches of the customers row that `/event`
 * acts on, one statement.
 */
export const BUNDLE_COUNTRY_SQL =
  "SELECT country_off, direct_insights_off FROM customers WHERE id = ?";

/** The row BUNDLE_COUNTRY_SQL returns. */
export interface BundleCountryRow {
  country_off?: number | null;
  direct_insights_off?: number | null;
}

/**
 * The bundle's `co` and `dx` for both writers: each `1` only when its switch
 * is on, else absent, so every other customer's bundle is byte for byte what
 * it was. No row reads as nothing switched off.
 */
export function bundleCountryFields(
  row: BundleCountryRow | null | undefined,
): Pick<VisitorBundle, "co" | "dx"> {
  if (!row) return {};
  return {
    ...(Number(row.country_off) === 1 ? { co: 1 as const } : {}),
    ...(Number(row.direct_insights_off) === 1 ? { dx: 1 as const } : {}),
  };
}

/** The read both bundle writers make for `ne` (migration 0044). */
export const BUNDLE_NO_EVENTS_SQL =
  "SELECT special_category, sensitive FROM customers WHERE id = ?";

/** The row BUNDLE_NO_EVENTS_SQL returns. */
export interface BundleNoEventsRow {
  special_category?: number | null;
  sensitive?: number | null;
}

/**
 * The bundle's `ne` for both writers: `{ ne: 1 }` only for a yes that is
 * not marked, else empty, so every other customer's bundle is byte for byte
 * what it was. No row reads as nothing to withhold.
 */
export function bundleNoEventsFields(
  row: BundleNoEventsRow | null | undefined,
): Pick<VisitorBundle, "ne"> {
  if (!row) return {};
  if (Number(row.special_category) === 1 && Number(row.sensitive) !== 1) return { ne: 1 };
  return {};
}

/** The audit's part of the bundle, as both writers read it from the customers row. */
export interface BundleAudit {
  plan: string | null;
  domain: string | null;
  audit_ends_at: number | null;
}

/** `a`, `ad` and `ae` from the customers row; empty for any plan but 'audit'. */
export function bundleAuditFields(
  audit: BundleAudit | null | undefined,
): Pick<VisitorBundle, "a" | "ad" | "ae"> {
  if (!audit || audit.plan !== "audit") return {};
  const ad = normalizeAuditDomain(audit.domain);
  const ae = typeof audit.audit_ends_at === "number" ? audit.audit_ends_at : null;
  return { a: 1, ...(ad ? { ad } : {}), ...(ae !== null ? { ae } : {}) };
}

/** The site map's part of the bundle, as both writers read it from D1. */
export interface BundleSiteMap {
  /** customers.site_map_off = 1: no `pm`, no `sd`, six intents served (privacy review condition 5). */
  off: boolean;
  rows: readonly SitePathRow[];
  /** customers.served_intents, parsed; null = all six. */
  served: IntentDim[] | null;
}

/** No holdout above this: a slip of the finger never hides the versions from most visitors. */
export const HOLDOUT_CAP = 50;

/** A holdout percent as an integer 0 to HOLDOUT_CAP, or null when it is not a number. */
export function clampHoldout(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.min(HOLDOUT_CAP, Math.max(0, Math.round(raw)));
}

export function visitorBundleKey(customerId: string): string {
  return `v1:vm:${customerId}`;
}

/** A conversion_targets row as D1 returns it. */
export interface ConversionTargetRow {
  section_path: string;
  conversion_label: string;
  css_selectors: string;
  text_selectors: string;
  structural_selector: string;
}

export function conversionTargetsFromRows(
  rows: readonly ConversionTargetRow[],
): ConversionTargetForClient[] {
  const out: ConversionTargetForClient[] = [];
  for (const r of rows) {
    try {
      out.push({
        section_path: r.section_path,
        conversion_label: r.conversion_label,
        css: JSON.parse(r.css_selectors) as string[],
        text: JSON.parse(r.text_selectors) as string[],
        structural: r.structural_selector,
      });
    } catch {
      // A row with corrupt selector JSON is skipped; the others stand.
    }
  }
  return out;
}

/**
 * The manifest in the form a browser receives: without the wrap measurement
 * (generation alone reads it) and without the rewrite switch of a button
 * (an operator setting; the snippet reads neither). It removes fields, not
 * parts: which parts a browser is given is `writtenManifest`'s question,
 * asked before this, while the switch is still on the entries.
 */
export function manifestForVisitors(manifest: Manifest): Manifest {
  const out: Manifest = {};
  for (const [path, entry] of Object.entries(manifest)) {
    const { metrics: _metrics, rewrite: _rewrite, ...rest } = entry;
    out[path] = rest;
  }
  return out;
}

/**
 * The bundle from confirmed manifest rows, conversion rows and the
 * customer's holdout percent (NULL or absent: no `h`, the env default).
 * Both writers (generation's writeVisitorBundle and the edge's write-back)
 * build it here, so they cannot drift.
 *
 * The manifests are the stored ones: a button whose rewrite the operator
 * has not turned on is left out of its page here (docs/specs/
 * button-rewrite.md), so a bundle the edge writes when KV has none says the
 * same as generation's. Rows a caller already filtered pass through
 * unchanged. The conversion rows are not touched: a counted button is in
 * `conv` whatever its switch says.
 */
export function visitorBundleFrom(
  manifests: readonly { page_path: string; manifest: Manifest }[],
  conversions: readonly ConversionTargetRow[],
  holdoutPercent?: number | null,
  site?: BundleSiteMap | null,
  audit?: BundleAudit | null,
  groups?: readonly string[] | null,
): VisitorBundle {
  const pages: Record<string, Manifest> = {};
  for (const m of manifests) {
    pages[m.page_path] = manifestForVisitors(writtenManifest(m.manifest));
  }
  const h = clampHoldout(holdoutPercent);
  const pm = site && !site.off ? sitePathMap(site.rows) : {};
  const sd = site && !site.off ? site.served : null;
  const g = bundleGroups(groups);
  return {
    v: 1,
    pages,
    conv: conversionTargetsFromRows(conversions),
    ...(h !== null ? { h } : {}),
    ...(Object.keys(pm).length > 0 ? { pm } : {}),
    ...(sd && sd.length < 6 ? { sd } : {}),
    ...bundleAuditFields(audit),
    ...(g ? { g } : {}),
  };
}

/** The page_groups rows both bundle writers read (docs/specs/page-groups.md). */
export const BUNDLE_GROUPS_SQL =
  "SELECT pattern FROM page_groups WHERE customer_id = ? ORDER BY pattern";

/**
 * The bundle's `g`: the valid patterns of the list, each once, sorted;
 * null for none, so a customer without groups has the bundle it had.
 */
export function bundleGroups(groups: readonly string[] | null | undefined): string[] | null {
  if (!groups || groups.length === 0) return null;
  const out = new Set<string>();
  for (const p of groups) if (isPageGroupPattern(p)) out.add(p);
  return out.size > 0 ? [...out].sort() : null;
}

/** The site map rows both bundle writers read (site-shaped intents §5). */
export const BUNDLE_SITE_PATHS_SQL =
  "SELECT path, kind, confidence FROM site_paths WHERE customer_id = ? ORDER BY path";

/**
 * The customer's switch and served set, read with the holdout percent, and
 * the audit's plan, domain and end (ai-traffic-audit.md §3.4; the columns
 * `plan` and `domain` are from 0001, `audit_ends_at` from 0040, so 0040 is
 * applied before either worker with this read is deployed).
 */
export const BUNDLE_CUSTOMER_SQL =
  "SELECT holdout_percent, served_intents, site_map_off, plan, domain, audit_ends_at FROM customers WHERE id = ?";

/** The row BUNDLE_CUSTOMER_SQL returns. */
export interface BundleCustomerRow {
  holdout_percent: number | null;
  served_intents: string | null;
  site_map_off: number | null;
  plan?: string | null;
  domain?: string | null;
  audit_ends_at?: number | null;
}

/** The audit part of a BUNDLE_CUSTOMER_SQL row (null for no row). */
export function bundleAuditFrom(row: BundleCustomerRow | null | undefined): BundleAudit | null {
  if (!row) return null;
  return {
    plan: row.plan ?? null,
    domain: row.domain ?? null,
    audit_ends_at: typeof row.audit_ends_at === "number" ? row.audit_ends_at : null,
  };
}

/** The bundle's site map from the two reads above; unknown kinds and confidences are skipped. */
export function bundleSiteMapFrom(
  rows: readonly { path: string; kind: string; confidence: string }[],
  customer: { served_intents?: string | null; site_map_off?: number | null } | null,
): BundleSiteMap {
  const off = customer?.site_map_off === 1;
  return {
    off,
    rows: off
      ? []
      : rows.filter(
          (r): r is SitePathRow =>
            isSiteKindOrNone(r.kind) &&
            (SITE_CONFIDENCES as readonly string[]).includes(r.confidence),
        ),
    served: off ? null : parseServed(customer?.served_intents ?? null),
  };
}

/**
 * The read both bundle writers make for `kl` (docs/specs/keyword-intent.md;
 * migration 0045). One row from `customers`.
 */
export const BUNDLE_KEYWORD_SQL =
  "SELECT keyword_lexicon, keyword_off, sensitive, special_category FROM customers WHERE id = ?";

/** The row BUNDLE_KEYWORD_SQL returns. */
export interface BundleKeywordRow {
  keyword_lexicon: string | null;
  keyword_off: number | null;
  sensitive: number | null;
  special_category: number | null;
}

/**
 * The bundle's `kl`, or undefined: only when the customer did not turn
 * keyword reading off, is not marked sensitive, answered "no" to the
 * special-category question, and has a lexicon that parses (privacy review,
 * section 10, conditions 8 and 10). Both writers use this, so the edge's
 * write-back and generation's write agree byte for byte.
 */
export function bundleKeywordLexicon(
  row: BundleKeywordRow | null | undefined,
): KeywordLexicon | undefined {
  if (!row) return undefined;
  // Only an explicit "no" to the special-category question (0); a yes or an
  // unanswered one gives no `kl` (condition 8, read strictly, 2026-10-22).
  if (row.keyword_off === 1 || row.sensitive === 1 || row.special_category !== 0) return undefined;
  return parseStoredLexicon(row.keyword_lexicon) ?? undefined;
}

/**
 * The lexicon `/select` may read from a bundle, or null. The writers leave
 * `kl` out of a sensitive or `ne` bundle; the reader refuses it again rather
 * than trust the writer (privacy review, keyword build review A). Read here so the
 * edge's request path never names either flag itself.
 */
export function readableKeywordLexicon(b: VisitorBundle | null | undefined): KeywordLexicon | null {
  if (!b || b.v !== 1 || !b.kl || b.s === 1 || b.ne === 1) return null;
  return b.kl;
}
