/**
 * /event — visitor-fired analytics event ingest.
 *
 * Accepts events from the snippet (variant_shown, no_signal_passthrough,
 * conversion, the skip and partial reports, snippet_issue) and writes them
 * to D1 via ctx.waitUntil; never blocks the snippet's network return.
 *
 * Always returns 202 Accepted, even on malformed input. Rationale: any
 * non-202 surfaces as a network error in the snippet's console (visible to
 * customer's site visitors viewing devtools), and the snippet's behavior on
 * a 4xx is the same as on 202 — fire and forget. Treating debug signals as
 * out-of-band (a log line, never the response) keeps the response shape
 * uniform and prevents probing for endpoint internals.
 *
 * Guard (docs/specs/event-capacity.md, section A): the Workers rate-limit
 * binding EVENT_LIMITER, keyed on the customer id. An attacker who knows a
 * customer's `cid` (visible in any snippet <script>) could otherwise flood
 * this endpoint with fake rows. The binding counts per Cloudflare location
 * and is eventually consistent: a spam guard, not the count. It touches no
 * KV, so the event path makes no KV read or write at all. Over the limit
 * the row is dropped and the drop is counted in memory; a binding that is
 * missing or throws lets the write through (fail open).
 *
 * Privacy invariants (ADR 0019 / ADR 0002):
 * - Server stamps id (UUID) and ts (Date.now). Client cannot influence either.
 * - page_path is defensively stripped of `?` and `#` and every identifier
 *   segment masked to `:id` before storage (docs/specs/event-paths.md).
 * - No persistent visitor identifier is recorded. The optional `visit` field
 *   is the tab's random 32-hex marker (docs/specs/visit-marker.md): it dies
 *   with the tab; on the row it is kept for the life of the account (ADR 0037).
 * - event_type and conversion_label are validated against closed enums.
 * - `arm` (treat | holdout) and `body_id` (16 hex) are validated by shape
 *   (docs/specs/proof-engine.md, C); junk is dropped and the row kept. The
 *   arm is stored only next to a valid marker. snippet_issue stores neither.
 * - Kept lengths are refused (privacy review, 2026-10-03, condition 2):
 *   no field reads them; a `kept_lengths` in the body is ignored.
 * - `source_name` is stored only when it is a word on SOURCE_NAMES, else
 *   NULL; `tagged` is 1 only for exactly 1, else 0. Both are NULL and 0 on
 *   snippet_issue and no_signal_passthrough rows (N1, N3; privacy review
 *   2026-10-04, condition 2). intent_dim and source_dim only from their
 *   dimension lists.
 * - Audit customers (docs/specs/ai-traffic-audit.md, privacy review condition 1):
 *   a row whose browser-set `Origin` host is not the audit domain, or that
 *   arrives at or after the audit's end, is dropped; the host is never
 *   stored or logged. `found_by` is stored only for an audit customer and
 *   only when it is a word on FOUND_BY, on the same rows as `source_name`;
 *   every other customer's rows never name the column, so this code is safe
 *   before migration 0040 for them.
 * - `lp` (docs/specs/late-tag.md, privacy review Q2 conditions 2 and 3): the page
 *   had been painted when our script started. Stored only as 1, in
 *   `properties`, and only on the two exposures a painted page makes (a
 *   skip of kind `late`, the holdout exposure). Any other value or type:
 *   the field is ignored and the row kept. Never on a conversion or a
 *   snippet_issue, never in KV, never read by /select, never sent back.
 * - A sensitive customer (docs/specs/sensitive-customers.md, sensitive.ts):
 *   after the mask, `page_path` is stored as `/`, a kept section, its group
 *   (`/products/:item`) or `/:item`, and `variant_key` only when its page is
 *   `/` or a kept section, on every event type, snippet_issue included. An
 *   exposure also counts one load in `page_days` under the full masked path,
 *   a statement that is given the customer, the day and the path and nothing
 *   else. The flag comes from the bundle read above, else from D1 after the
 *   202; when neither answers the row is stored as `/:item` with no key. The
 *   flag itself is in no column and no `properties` key.
 * - "No events" (docs/specs/readiness-check.md, privacy review condition 2): a
 *   customer that answered yes to the special-category question and is not
 *   yet marked carries `ne: 1` in the same bundle (else the same customers
 *   row). For it nothing is written: no event row, no `page_days` load, no
 *   snippet_issue row, for every event type. The answer is the same 202 as
 *   for anyone, so nothing tells a browser (condition 4).
 * - `country` (ADR 0036; docs/specs/visitors-page.md): Cloudflare's
 *   `cf.country` of this request, as `countryOf` returns it (an ISO 3166-1
 *   alpha-2 code from the closed list, else `other`), on every stored row but
 *   snippet_issue. NULL when the customer's `co` switch is on, and when
 *   neither the bundle nor the database could say whether it is (fail
 *   closed). Read after the 202 from the request, never from the body: a
 *   browser cannot set it. Never sent back, never read by /select.
 * - `device_class` and `web_view` (ADR 0038, part 1; docs/specs/
 *   direct-visitors.md §1): one word (mobile, tablet, desktop, other) and one
 *   bit (an app's in-app browser) from this request's User-Agent and
 *   `Sec-CH-UA`, by the shared `deviceClassOf` and `webViewOf`, on the same
 *   rows as `country` and under the same fail-closed rule, with their own
 *   switch (`dx`). The User-Agent itself is never stored or logged. Read
 *   after the 202 from the request headers, never from the body; never sent
 *   back, never read by /select.
 */

import {
  INTENT_DIMENSIONS,
  PAGE_DAYS_UPSERT_SQL,
  PERSON_SHAPE,
  REMEMBERED_REASON,
  SOURCE_DIMENSIONS,
  type SensitiveSettings,
  countryOf,
  deviceClassOf,
  isChoiceWord,
  isDirectNd,
  isFoundBy,
  isRenderBrowser,
  isSourceName,
  maskPath,
  parseBodyId,
  webViewOf,
} from "@rawuser/shared";
import { auditOf, refusedByAudit } from "./audit.ts";
import { isClosed } from "./closed.ts";
import { eventBundleFor } from "./event-bundle.ts";
import { customerOfBundle, eventCustomerFromD1, storedEventPage } from "./sensitive.ts";

const INTENT_DIMS: ReadonlySet<string> = new Set(INTENT_DIMENSIONS);
const SOURCE_DIMS: ReadonlySet<string> = new Set(SOURCE_DIMENSIONS);

/**
 * A dimension name only from its list (2026-10-04, with N1): no free text
 * reaches intent_dim or source_dim. Anything else is stored as NULL and the
 * row kept.
 */
function dimOf(v: string | undefined, list: ReadonlySet<string>): string | null {
  return v !== undefined && list.has(v) ? v : null;
}

/**
 * Events per customer per 60 seconds per Cloudflare location before the
 * guard drops rows (docs/specs/event-capacity.md, section A). The binding
 * reads its limit from wrangler.toml, not from here; this constant mirrors
 * both [[ratelimits]] blocks and a test holds them equal. The snippet sends
 * one exposure event per page view, so 600 a minute is about 36,000 page
 * views an hour per location for one customer.
 */
export const EVENT_LIMIT_PER_MINUTE = 600;

/** At most one guard log line per isolate per this many milliseconds. */
const GUARD_LOG_INTERVAL_MS = 60_000;

const ALLOWED_EVENT_TYPES = new Set([
  "variant_shown",
  "conversion",
  "no_signal_passthrough",
  // V2 Fix Pass A: fired by the snippet when /select returned a valid variant
  // but applyVariant's pre-flight aborted (one or more variant section paths
  // failed to resolve on the page). Same payload shape as variant_shown; the
  // analytics aggregator counts it separately so operators see a real
  // "your manifest is incomplete for the variants generated" signal.
  "personalization_skipped",
  // Slots that still showed the original thirty seconds after a swap the
  // snippet could not redo (docs/specs/design-preserving-rewrite.md §3).
  // The slot names ride in `properties` as JSON; never a visit value.
  "personalization_partial",
  // One per page load, only when something went wrong on the customer's
  // page (docs/specs/snippet-issues.md). Closed codes and a coarse closed
  // `n` in `properties.issues`; never a visit marker (condition 1).
  "snippet_issue",
  // The visitor's own choice (docs/specs/direct-visitors.md §2): the
  // question was shown on this load, or why not, one fixed word in
  // `properties.ch`. Not a page view: the load's passthrough is.
  "choice",
]);

const SLOT_PATH = /^[a-z_]+(\.[a-z_]+){1,3}$/;

/** The event types that may carry `nd` (docs/specs/direct-visitors.md §6). */
const ND_TYPES = new Set([
  "variant_shown",
  "personalization_skipped",
  "no_signal_passthrough",
  "conversion",
]);

/**
 * Why a skipped page stayed as built: facts about the page, never the
 * visitor (docs/specs/interactive-text.md §5). Anything else is dropped.
 * Closed list of page facts. A skip kind is a fixed word and never a
 * measured value (width, height, line count, timing) or anything read from
 * the visitor's environment: the only measured value allowed in an event is
 * the bucketed n of snippet_issue (the privacy rules). A new kind
 * needs privacy review.
 */
// `late`: the version came after the snippet's reveal cap had shown the
// original, so it was not written (docs/specs/quiet-swap.md, Late answers).
const SKIP_KINDS = new Set(["missing", "split", "template-mismatch", "lines", "late"]);

/**
 * snippet_issue codes (docs/specs/snippet-issues.md, the code table). Each
 * code says whether it may carry a slot `s` and the closed integer range of
 * its `n`; `null` means the code carries no `n`. Zero is never a valid `n`
 * (lines_changed spans it but excludes it). A new code or a wider range
 * needs privacy review (condition 2).
 */
const ISSUE_CODES: ReadonlyMap<string, { slot: boolean; n: { min: number; max: number } | null }> =
  new Map([
    // 1 our timeout, 2 network, 3 an answer we could not use, 4 the page
    // was left or hidden while we asked (snippet-issues.md, "Leaving the
    // page", F1; privacy review Q5 condition 3). 4 is presence only, never
    // a time on page; 5 and up drop the event like any number out of range.
    ["select_failed", { slot: false, n: { min: 1, max: 4 } }],
    ["reveal_cap", { slot: false, n: { min: 1, max: 3 } }],
    ["apply_error", { slot: true, n: null }],
    ["rich_failed", { slot: false, n: null }],
    ["lines_changed", { slot: true, n: { min: -9, max: 9 } }],
    ["swap_shift", { slot: false, n: { min: 1, max: 4 } }],
    ["reverted", { slot: true, n: { min: 4, max: 99 } }],
    // The tag ran after the page appeared (install-friction D, privacy review
    // condition 4): no slot, no number, so an `s` or `n` drops the event.
    ["late_tag", { slot: false, n: null }],
  ]);

const MAX_ISSUES = 3;
const MAX_ISSUE_SLOT_LENGTH = 40;
const ISSUE_ITEM_KEYS = new Set(["c", "s", "n"]);

interface Issue {
  c: string;
  s?: string;
  n?: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate `properties` of a snippet_issue strictly and return the JSON for
 * the properties column, built from the validated values only (never the
 * raw input), or null when anything is off: the event is then malformed.
 */
function validateIssues(raw: unknown): string | null {
  if (!isPlainObject(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "issues") return null;
  const list = raw.issues;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ISSUES) return null;
  const issues: Issue[] = [];
  for (const item of list) {
    if (!isPlainObject(item)) return null;
    for (const k of Object.keys(item)) if (!ISSUE_ITEM_KEYS.has(k)) return null;
    const c = item.c;
    if (typeof c !== "string") return null;
    const code = ISSUE_CODES.get(c);
    if (!code) return null;
    const out: Issue = { c };
    if (item.s !== undefined) {
      const s = item.s;
      if (!code.slot) return null;
      if (typeof s !== "string" || s.length > MAX_ISSUE_SLOT_LENGTH || !SLOT_PATH.test(s))
        return null;
      out.s = s;
    }
    if (code.n === null) {
      if (item.n !== undefined) return null;
    } else {
      const n = item.n;
      if (typeof n !== "number" || !Number.isInteger(n)) return null;
      if (n === 0 || n < code.n.min || n > code.n.max) return null;
      out.n = n;
    }
    issues.push(out);
  }
  return JSON.stringify({ issues });
}

const ALLOWED_CONVERSION_LABELS = new Set([
  "signup",
  "demo_request",
  "trial_start",
  "purchase",
  "contact",
  "waitlist",
  "download",
  "other",
]);

/**
 * Closed enum for the holdout cohort field (Batch C, ADR 0022).
 * - personalized: signal present, variant was applied.
 * - holdout:      signal present, intentionally NOT personalized (10% baseline).
 * - skipped:      signal present, applyVariant aborted (manifest gap).
 * - no_signal:    no meaningful signal; original page served.
 * Reject any other string to prevent data corruption in aggregates.
 */
export const ALLOWED_COHORTS = new Set(["personalized", "holdout", "skipped", "no_signal"]);

/** What the edge's coin said for the visit (docs/specs/proof-engine.md, A). */
export const ALLOWED_ARMS = new Set(["treat", "holdout"]);

export interface EventEnv {
  DB: D1Database;
  /** Holds the tombstone of a deleted customer (closed.ts). Absent: not checked. */
  VARIANTS?: KVNamespace;
  /** Workers rate-limit binding (wrangler.toml [[ratelimits]]). Optional: absent means fail open. */
  EVENT_LIMITER?: RateLimit;
}

interface EventBody {
  event_type: string;
  page_path: string;
  variant_key?: string;
  intent_dim?: string;
  source_dim?: string;
  conversion_label?: string;
  cohort?: string;
  dark_social?: number;
  language_mismatch?: number;
  /** 1 when the selection came from the tab's carry (docs/specs/session-carry.md). */
  carried?: number;
  /** The tab's random visit marker, 32 hex (docs/specs/visit-marker.md). */
  visit?: string;
  /** personalization_partial: the slot paths that stayed original. */
  paths?: unknown;
  /** 1 when the words came from the tab's carried copy (body carry, condition 5). */
  body_carry?: number;
  kind?: string;
  /** snippet_issue only: `{ issues: [{ c, s?, n? }] }` (docs/specs/snippet-issues.md). */
  properties?: unknown;
  /** The visit's arm, from the /select answer. */
  arm?: unknown;
  /** The served (or, on holdout, would-be) version's id. */
  body_id?: unknown;
  /** N1: the platform name the /select answer gave, echoed. Checked against SOURCE_NAMES. */
  source_name?: unknown;
  /** N3: 1 when the /select answer said the link carried the customer's own tags. */
  tagged?: unknown;
  /** Audits: how the /select answer said the source was recognised. Checked against FOUND_BY. */
  found_by?: unknown;
  /**
   * 1 when the /select answer said the customer's site map decided the
   * page's intent (docs/specs/site-shaped-intents.md §6.4). Only 1 is
   * stored, in `properties`, on the page's exposure event; anything else is
   * dropped (privacy review ruling, point 4).
   */
  site_path?: unknown;
  /**
   * 1 when the page had been painted before our script ran, so it stayed as
   * built (docs/specs/late-tag.md). One closed bit: only 1 is stored, in
   * `properties`, on a skip of kind `late` and on the holdout exposure;
   * anything else is ignored, never a reason to drop the row.
   */
  lp?: unknown;
  /**
   * Why a visit with no signal got its answer (docs/specs/direct-visitors.md
   * §6), echoed from /select. Stored in `properties.nd` when it has the
   * fixed shape (`isDirectNd`); anything else is dropped, the row kept.
   */
  nd?: unknown;
  /** The choice row's fixed word (`isChoiceWord`); a choice row without one is malformed. */
  ch?: unknown;
  /** On an `answered`, `returned` or `first` choice row: the visitor's own code (ADR 0039). */
  pid?: unknown;
  /** On an `answered` or `returned` choice row: the answer's slot, a to d. */
  qa?: unknown;
  /** On a `returned` choice row: the remembered reason given back (`REMEMBERED_REASON`). */
  rc?: unknown;
}

/** The visit marker's only accepted shape: 32 lowercase hex characters. */
export const VISIT_SHAPE = /^[0-9a-f]{32}$/;

/** The marker when it has the right shape, else null. Exported for /select. */
export function parseVisit(raw: unknown): string | null {
  return typeof raw === "string" && VISIT_SHAPE.test(raw) ? raw : null;
}

interface ValidatedEvent {
  event_type: string;
  page_path: string;
  variant_key: string | null;
  intent_dim: string | null;
  source_dim: string | null;
  conversion_label: string | null;
  cohort: string | null;
  /** 1 when the edge flagged an untagged visit as probable dark social (L2 Layer D). */
  dark_social: 0 | 1;
  /** 1 when the edge kept the original because the page language differs from the versions' language. */
  language_mismatch: 0 | 1;
  /** 1 when the selection came from the tab's carry rather than this page's own signals. */
  carried: 0 | 1;
  /** The visit marker, or null when absent or malformed. */
  visit: string | null;
  /** JSON for the `properties` column: the partial slot list, else null. */
  properties: string | null;
  /** treat | holdout, only with a valid marker; else null. */
  arm: string | null;
  /** 16 hex, else null. */
  body_id: string | null;
  /** A SOURCE_NAMES word, else null; null on snippet_issue and no_signal_passthrough. */
  source_name: string | null;
  /** 1 or 0; 0 on snippet_issue and no_signal_passthrough. */
  tagged: 0 | 1;
  /**
   * A FOUND_BY word, else null; null on snippet_issue and
   * no_signal_passthrough. Written only for an audit customer (handleEvent).
   */
  found_by: string | null;
}

/** The longest page path stored; longer ones lose their last segments. */
const MAX_STORED_PATH = 512;

/**
 * The page path as stored: query and fragment cut, cut to whole segments
 * under MAX_STORED_PATH (a segment cut in half would lose the shape the mask
 * reads), then every identifier segment masked to `:id`
 * (docs/specs/event-paths.md). Snippet should already cut the query; the
 * edge re-cuts and masks as a privacy guarantee, for every event type.
 */
export function sanitizePath(raw: string): string {
  if (typeof raw !== "string" || raw === "") return "/";
  let path = raw;
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);
  if (path.length > MAX_STORED_PATH) {
    path = path.slice(0, Math.max(0, path.lastIndexOf("/", MAX_STORED_PATH)));
  }
  return maskPath(path || "/");
}

/**
 * Validate the request body. Returns the normalized event on success,
 * null on any validation failure (caller treats as malformed: 202, no row,
 * counted in memory for the guard log line).
 */
function validate(body: unknown): ValidatedEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as EventBody;

  if (!ALLOWED_EVENT_TYPES.has(b.event_type)) return null;
  if (typeof b.page_path !== "string") return null;

  // Optional fields: present means they must be strings.
  if (b.variant_key !== undefined && typeof b.variant_key !== "string") return null;
  if (b.intent_dim !== undefined && typeof b.intent_dim !== "string") return null;
  if (b.source_dim !== undefined && typeof b.source_dim !== "string") return null;
  if (b.conversion_label !== undefined) {
    if (typeof b.conversion_label !== "string") return null;
    if (!ALLOWED_CONVERSION_LABELS.has(b.conversion_label)) return null;
  }
  // cohort is optional; if present it must be one of the four allowed values.
  if (b.cohort !== undefined) {
    if (typeof b.cohort !== "string") return null;
    if (!ALLOWED_COHORTS.has(b.cohort)) return null;
  }

  // Conversion-specific: conversion_label is required only for event_type=conversion.
  if (b.event_type === "conversion" && b.conversion_label === undefined) return null;
  // dark_social is optional and only meaningful on no_signal_passthrough; a
  // flag, coerced to 0/1, never any other value.
  if (b.dark_social !== undefined && b.dark_social !== 0 && b.dark_social !== 1) return null;
  if (b.carried !== undefined && b.carried !== 0 && b.carried !== 1) return null;
  if (b.body_carry !== undefined && b.body_carry !== 0 && b.body_carry !== 1) return null;
  if (b.language_mismatch !== undefined && b.language_mismatch !== 0 && b.language_mismatch !== 1)
    return null;

  // A choice row says one fixed word or nothing is stored (§2).
  if (b.event_type === "choice" && !isChoiceWord(b.ch)) return null;

  // snippet_issue: properties must pass the strict check or the event is
  // malformed; the stored JSON is rebuilt from the validated values.
  let issueProperties: string | null = null;
  if (b.event_type === "snippet_issue") {
    issueProperties = validateIssues(b.properties);
    if (issueProperties === null) return null;
  }

  // snippet_issue keeps only page_path, variant_key and the validated issues
  // (minimisation, privacy review conditions 1 and 4): every other column is NULL
  // or its neutral 0, whatever the body sent.
  const lean = b.event_type === "snippet_issue";
  const visit = lean ? null : parseVisit(b.visit);
  // N1 and N3 belong to a visit with a signal: never on a snippet_issue or a
  // no-signal row, whatever the body sent.
  const sourced = !lean && b.event_type !== "no_signal_passthrough";

  return {
    event_type: b.event_type,
    page_path: sanitizePath(b.page_path),
    variant_key: b.variant_key ?? null,
    intent_dim: lean ? null : dimOf(b.intent_dim, INTENT_DIMS),
    source_dim: lean ? null : dimOf(b.source_dim, SOURCE_DIMS),
    conversion_label: lean ? null : (b.conversion_label ?? null),
    cohort: lean ? null : (b.cohort ?? null),
    dark_social: b.dark_social === 1 && b.event_type === "no_signal_passthrough" ? 1 : 0,
    language_mismatch:
      b.language_mismatch === 1 && b.event_type === "no_signal_passthrough" ? 1 : 0,
    carried: !lean && b.carried === 1 && b.event_type !== "no_signal_passthrough" ? 1 : 0,
    // A malformed marker is dropped, never rejected: the row still counts.
    // snippet_issue never stores one, even when sent (condition 1).
    visit,
    // The arm means something only for a visit we can count: no marker, no arm.
    arm: visit !== null && typeof b.arm === "string" && ALLOWED_ARMS.has(b.arm) ? b.arm : null,
    body_id: lean ? null : (parseBodyId(b.body_id) ?? null),
    source_name: sourced && isSourceName(b.source_name) ? b.source_name : null,
    tagged: sourced && b.tagged === 1 ? 1 : 0,
    found_by: sourced && isFoundBy(b.found_by) ? b.found_by : null,
    // snippet_issue: the validated issues; every other type as before.
    properties: issueProperties ?? exposureProperties(b),
  };
}

/**
 * The two exposures of a page that was painted before our script ran
 * (docs/specs/late-tag.md, "The bit lp"; privacy review Q2 condition 2): the
 * treat arm's skip, always of kind `late` in the cohort `skipped`, and the
 * holdout arm's exposure. A version is never shown on a painted page, so a
 * personalized variant_shown is not one of them; a conversion never is.
 */
function isPaintedFirstExposure(b: EventBody): boolean {
  if (b.event_type === "personalization_skipped") {
    return b.kind === "late" && b.cohort === "skipped";
  }
  return b.event_type === "variant_shown" && b.cohort === "holdout";
}

/**
 * The `properties` JSON of every type but snippet_issue, built from
 * validated values only: the partial slot list; on variant_shown the body
 * carry bit; on personalization_skipped its reason word; on the two
 * exposure types the site-map bit (site-shaped-intents §6.4), only as 1;
 * and on a painted page's exposure the bit `lp`, only as 1.
 */
function exposureProperties(b: EventBody): string | null {
  if (b.event_type === "personalization_partial" && Array.isArray(b.paths)) {
    return JSON.stringify({
      paths: b.paths
        .filter((p): p is string => typeof p === "string" && SLOT_PATH.test(p))
        .slice(0, 12),
    });
  }
  const out: Record<string, string | number> = {};
  if (b.body_carry === 1 && b.event_type === "variant_shown") out.body_carry = 1;
  if (
    b.event_type === "personalization_skipped" &&
    typeof b.kind === "string" &&
    SKIP_KINDS.has(b.kind)
  ) {
    out.kind = b.kind;
  }
  if (
    b.site_path === 1 &&
    (b.event_type === "variant_shown" || b.event_type === "personalization_skipped")
  ) {
    out.site_path = 1;
  }
  // The literal 1 and nothing else: `true`, 2 or "1" store nothing, and the
  // row is kept either way (condition 5: the bit never grows a second value).
  if (b.lp === 1 && isPaintedFirstExposure(b)) out.lp = 1;
  // Visitors with no signal (docs/specs/direct-visitors.md §6): `nd` on the
  // page's exposures and clicks, the choice row's word.
  if (ND_TYPES.has(b.event_type) && isDirectNd(b.nd)) out.nd = b.nd;
  if (b.event_type === "choice" && isChoiceWord(b.ch)) {
    out.ch = b.ch;
    // The visitor's own code (ADR 0039) on `answered`, `returned` and `first`;
    // the answer's slot on the first two, the remembered reason on `returned`.
    if (b.ch === "answered" || b.ch === "returned" || b.ch === "first") {
      if (typeof b.pid === "string" && PERSON_SHAPE.test(b.pid)) out.pid = b.pid;
    }
    if (b.ch === "answered" || b.ch === "returned") {
      if (typeof b.qa === "string" && /^[a-d]$/.test(b.qa)) out.qa = b.qa;
    }
    if (b.ch === "returned" && typeof b.rc === "string" && REMEMBERED_REASON.test(b.rc)) {
      out.rc = b.rc;
    }
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

// Per-isolate tallies for the guard log line. Numbers only: never a
// customer id, a path or anything from the request.
let guardDropped = 0;
let guardMalformed = 0;
let guardLoggedAt = 0;
let guardMissingLogged = false;

/** Tests only: start every case from a clean isolate. */
export function resetEventGuardForTests(): void {
  guardDropped = 0;
  guardMalformed = 0;
  guardLoggedAt = 0;
  guardMissingLogged = false;
}

/**
 * Count a dropped or malformed event and, at most once per isolate per
 * minute, log the tallies as one safe-constant line, then start over. Counts
 * left when an isolate dies unlogged are lost; this is a visibility aid, not
 * the analytics.
 */
function noteGuard(kind: "dropped" | "malformed"): void {
  if (kind === "dropped") guardDropped += 1;
  else guardMalformed += 1;
  const now = Date.now();
  if (now - guardLoggedAt < GUARD_LOG_INTERVAL_MS) return;
  console.warn(
    `[rawuser/edge] event guard dropped ${guardDropped}, malformed ${guardMalformed} (non-critical)`,
  );
  guardDropped = 0;
  guardMalformed = 0;
  guardLoggedAt = now;
}

/**
 * True when the row may be written. The binding answers from the location's
 * own memory, no KV and no D1. Missing or throwing binding: fail open, the
 * same choice as the KV read failure path this replaced.
 */
async function withinGuard(limiter: RateLimit | undefined, customerId: string): Promise<boolean> {
  if (!limiter) {
    if (!guardMissingLogged) {
      guardMissingLogged = true;
      console.error("[rawuser/edge] event guard binding missing (non-critical)");
    }
    return true;
  }
  try {
    const { success } = await limiter.limit({ key: customerId });
    if (success === false) {
      noteGuard("dropped");
      return false;
    }
    return true;
  } catch {
    console.error("[rawuser/edge] event guard failed (non-critical)");
    return true;
  }
}

/** The browser facts of a stored row (ADR 0038, part 1); null when not written. */
export interface DirectFacts {
  device_class: string;
  web_view: 0 | 1;
}

/**
 * Fire-and-forget D1 INSERT. Best-effort: any failure logs a safe constant
 * and silently swallows — events are analytics, not load-bearing.
 *
 * `settings` is the customer's sensitive flag and kept list, or null when
 * neither the bundle nor the database could say (sensitive.ts). It decides
 * `page_path` and `variant_key` and nothing else in the row. A customer that
 * is not sensitive gets the statement, the values and the single `run` it
 * got before. A sensitive customer's exposure also counts one load in
 * `page_days`, in one batch with the row: the two are written together or
 * not at all, and the counter's statement is bound to the customer, the UTC
 * day and the masked path only.
 */
async function writeEventRow(
  db: D1Database,
  customerId: string,
  event: ValidatedEvent,
  settings: SensitiveSettings | null,
  country: string | null,
  direct: DirectFacts | null,
): Promise<void> {
  const id = `evt_${crypto.randomUUID().replace(/-/g, "")}`;
  const ts = Date.now();
  const page = storedEventPage(
    settings,
    customerId,
    event.event_type,
    event.page_path,
    event.variant_key,
    ts,
  );
  // `found_by` is named only on a row that has one (an audit customer's), so
  // every other row is written exactly as before migration 0040.
  const withFound = event.found_by !== null;
  try {
    const insert = db
      .prepare(
        `INSERT INTO events
           (id, customer_id, ts, profile_id, event_type,
            variant_key, intent_dim, source_dim, page_path, conversion_label, country,
            device_class, web_view, cohort, dark_social, language_mismatch, carried, visit,
            properties, arm, body_id, source_name, tagged${withFound ? ", found_by" : ""})
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${withFound ? ", ?" : ""})`,
      )
      .bind(
        id,
        customerId,
        ts,
        event.event_type,
        page.variant_key,
        event.intent_dim,
        event.source_dim,
        page.page_path,
        event.conversion_label,
        country,
        direct?.device_class ?? null,
        direct?.web_view ?? null,
        event.cohort,
        event.dark_social,
        event.language_mismatch,
        event.carried,
        event.visit,
        event.properties,
        event.arm,
        event.body_id,
        event.source_name,
        event.tagged,
        ...(withFound ? [event.found_by] : []),
      );
    if (page.pageDay) {
      await db.batch([insert, db.prepare(PAGE_DAYS_UPSERT_SQL).bind(...page.pageDay)]);
    } else {
      await insert.run();
    }
  } catch {
    console.error("[rawuser/edge] event write failed (non-critical)");
  }
}

/** Cloudflare's `cf.country` of the request, or undefined off Cloudflare. */
function cfCountryOf(request: Request): unknown {
  return (request as Request & { cf?: { country?: unknown } }).cf?.country;
}

/**
 * Return a 202 Accepted response with the visitor-path CORS headers.
 * Always returns 202 regardless of validation outcome — see file header.
 */
function accepted(): Response {
  return new Response(null, {
    status: 202,
    headers: {
      "cache-control": "private, no-store",
      "access-control-allow-origin": "*",
    },
  });
}

/**
 * CORS preflight response for POST /event.
 * Snippet is loaded cross-origin, so the browser issues an OPTIONS preflight
 * for any POST that carries Content-Type: application/json (or any custom
 * header). We allow Content-Type only — no auth headers are accepted on the
 * visitor path.
 */
export function eventPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
}

/**
 * POST /event?cid={customer_id}
 * Body: { event_type, page_path, variant_key?, intent_dim?, source_dim?, conversion_label? }
 * Response: 202 Accepted (always)
 */
export async function handleEvent(
  request: Request,
  url: URL,
  env: EventEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    // No GET — POST only. Methods endpoint should not be discoverable.
    return accepted();
  }

  // Browser Run reading the page during setup: never a visit, never a row
  // (install-friction, privacy review condition 3; @rawuser/shared no-fake-visit.ts).
  if (isRenderBrowser(request.headers)) return accepted();

  const customerId = url.searchParams.get("cid");
  if (!customerId || customerId.length === 0 || customerId.length > 64) {
    // No customer_id → silently accept (cannot attribute the write to anyone).
    return accepted();
  }

  // Parse body. JSON parse errors silently 202.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    noteGuard("malformed");
    return accepted();
  }

  const validated = validate(body);
  if (!validated) {
    noteGuard("malformed");
    return accepted();
  }

  // Guard and write after the response: the answer is 202 either way, so the
  // snippet never waits on the limiter. Over the limit, nothing is written.
  // A deleted customer's row is dropped (closed.ts, condition 1), and an
  // audit customer's from another host or after the end (audit.ts): both
  // read after the answer, in one batch, from the isolate's memory after
  // the first time. The bundle read that says "audit" also says "sensitive"
  // (event-bundle.ts): one read for both.
  const now = Date.now();
  const kv = env.VARIANTS;
  ctx.waitUntil(
    Promise.all([
      kv ? isClosed(kv, customerId, now) : Promise.resolve(false),
      kv ? eventBundleFor(kv, customerId, now) : Promise.resolve(null),
    ]).then(async ([closed, bundle]) => {
      if (closed) return;
      const audit = auditOf(bundle?.fields);
      if (refusedByAudit(audit, request, now)) return;
      // `found_by` for audit customers only, whatever the body sent.
      const row = audit ? validated : { ...validated, found_by: null };
      // Over the limit: no row, no counter, and no read to find the flag.
      if (!(await withinGuard(env.EVENT_LIMITER, customerId))) return;
      // The flag, the kept list and `ne`: from the bundle just read; with no
      // readable bundle, from D1 (privacy review condition 3, fail closed).
      // That read is here, after the 202, never on the answer's path: the
      // browser already has its answer. A customer whose bundle was read
      // makes no read here. Null when the database did not answer either.
      const known =
        (bundle ? customerOfBundle(bundle) : null) ??
        (await eventCustomerFromD1(env.DB, customerId, now));
      // "No events" (readiness-check.md, condition 2): nothing stored, nothing
      // counted. The 202 is already out, the same as for anyone.
      if (known?.ne) return;
      // The country (ADR 0036): from this request's cf, never the body; none
      // when switched off or unknown, and never on a snippet_issue row.
      const country =
        known && !known.countryOff && row.event_type !== "snippet_issue"
          ? countryOf(cfCountryOf(request))
          : null;
      // The device word and the in-app bit (ADR 0038, part 1): from this
      // request's headers, never the body; on the same rows as the country,
      // fail closed the same way, with their own switch.
      const direct: DirectFacts | null =
        known && !known.directOff && row.event_type !== "snippet_issue"
          ? {
              device_class: deviceClassOf(request.headers.get("user-agent")),
              web_view: webViewOf(
                request.headers.get("user-agent"),
                request.headers.get("sec-ch-ua"),
              ),
            }
          : null;
      await writeEventRow(env.DB, customerId, row, known?.settings ?? null, country, direct);
    }),
  );
  return accepted();
}
