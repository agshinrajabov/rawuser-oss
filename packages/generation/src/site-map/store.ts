/**
 * The site map in D1 (docs/specs/site-shaped-intents.md §5, §9): the
 * `site_paths` rows, the served set on `customers`, and the rules that keep
 * them honest. Operator data only, nothing about a visitor. Never logs a
 * path or a link text (privacy review condition 6): counts only.
 *
 * - A read upserts the rows it mapped; an operator's kind and label are
 *   never changed by a read. An operator's row that came from the menus
 *   still goes missing and ends 30 days later (privacy review §13.3).
 * - A rules or model `none` is never stored (condition 2); a model `none`
 *   removes a row the rules or the model had stored for that path.
 * - A row whose link a complete re-read of its page no longer finds gets
 *   `missing_since`; it keeps working and is removed 30 days later.
 * - The served set follows the rows, the briefs and the pages a price was
 *   seen on. On a live site a growth waits for the operator's Write and is
 *   written by itself after 7 days (the mock's call 6); a shrink applies at
 *   once. Before go live, and on the operator's own change, it applies.
 */

import {
  ALWAYS_SERVED,
  INTENT_DIMENSIONS,
  type IntentDim,
  SITE_PATHS_PER_CUSTOMER,
  type ServedBrief,
  type ServedReasons,
  type SiteConfidence,
  type SiteKindOrNone,
  isSiteKindOrNone,
  parseServed,
  servedIntents,
} from "@rawuser/shared";
import { writeVisitorBundle } from "../admin/onboard.ts";
import { markKeywordLexiconDue } from "../keywords/lexicon.ts";

export const DAY_MS = 24 * 60 * 60_000;
/** A row whose link is gone is removed after this long (§9). */
export const MISSING_TTL_MS = 30 * DAY_MS;
/** A growth of the served set is written by itself after this long unanswered (mock call 6). */
export const PENDING_AUTO_MS = 7 * DAY_MS;

export interface SiteRow {
  path: string;
  lang: string | null;
  kind: SiteKindOrNone;
  confidence: SiteConfidence;
  label: string | null;
  found_on: string;
  first_seen_at: number;
  last_seen_at: number;
  missing_since: number | null;
}

/** A growth of the served set waiting for the operator's Write. */
export interface PendingGrowth {
  intents: IntentDim[];
  since: number;
  /** The mapped pages that brought it (operator scope only). */
  paths: string[];
}

/** customers.served_reasons as stored. */
export interface StoredReasons extends ServedReasons {
  /** Pages on which the last read saw a price (§7.1). */
  price_pages?: string[];
  pending?: PendingGrowth;
  /** The served set grew on a live site: the five-minute queue writes the new versions. */
  write_at?: number;
}

export interface SiteState {
  off: boolean;
  live: boolean;
  rows: SiteRow[];
  /** null = all six. */
  served: IntentDim[] | null;
  reasons: StoredReasons | null;
}

function parseReasons(raw: string | null | undefined): StoredReasons | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StoredReasons;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export async function loadSiteState(db: D1Database, customerId: string): Promise<SiteState> {
  const [c, r] = await Promise.all([
    db
      .prepare(
        "SELECT served_intents, served_reasons, site_map_off, live_at FROM customers WHERE id = ?",
      )
      .bind(customerId)
      .first<{
        served_intents: string | null;
        served_reasons: string | null;
        site_map_off: number | null;
        live_at: number | null;
      }>(),
    db
      .prepare(
        `SELECT path, lang, kind, confidence, label, found_on, first_seen_at, last_seen_at, missing_since
         FROM site_paths WHERE customer_id = ? ORDER BY path`,
      )
      .bind(customerId)
      .all<SiteRow>(),
  ]);
  return {
    off: c?.site_map_off === 1,
    live: c?.live_at != null,
    rows: (r.results ?? []).filter((row) => isSiteKindOrNone(row.kind)),
    served: parseServed(c?.served_intents ?? null),
    reasons: parseReasons(c?.served_reasons),
  };
}

/** One link of a read, after the rules and the model. */
export interface MappedLink {
  path: string;
  lang: string | null;
  /** null: neither the rules nor the model gave a kind (the row, if any, is left as it is). */
  kind: SiteKindOrNone | null;
  confidence: Exclude<SiteConfidence, "operator"> | null;
  label: string | null;
}

export interface PageRead {
  /** The page the links were read on. */
  foundOn: string;
  /** The whole page was read; only then are absent links marked missing. */
  complete: boolean;
  links: MappedLink[];
  /** A price shows on this page (§7.1). */
  priceOnPage: boolean;
}

/** Stores one page's read. Returns how many rows it wrote or removed. */
export async function storeRead(
  db: D1Database,
  customerId: string,
  state: SiteState,
  read: PageRead,
  now: number,
): Promise<{ written: number; removed: number; missing: number }> {
  const byPath = new Map(state.rows.map((r) => [r.path, r]));
  let count = state.rows.length;
  const stmts: D1PreparedStatement[] = [];
  let written = 0;
  let removed = 0;
  let missing = 0;
  const seen = new Set<string>();
  for (const l of read.links) {
    seen.add(l.path);
    const existing = byPath.get(l.path);
    if (existing?.confidence === "operator") {
      // Never its kind or its label; only that its link is there again
      // (privacy review §13.3: a Remove kept as the operator's none must still end).
      if (existing.found_on !== "" && existing.missing_since !== null) {
        stmts.push(
          db
            .prepare(
              "UPDATE site_paths SET missing_since = NULL WHERE customer_id = ? AND path = ?",
            )
            .bind(customerId, l.path),
        );
      }
      continue;
    }
    if (l.kind === null || l.confidence === null) {
      // Unmapped this time: an earlier row stands and is seen again.
      if (existing) {
        stmts.push(
          db
            .prepare(
              "UPDATE site_paths SET last_seen_at = ?, missing_since = NULL WHERE customer_id = ? AND path = ? AND confidence != 'operator'",
            )
            .bind(now, customerId, l.path),
        );
      }
      continue;
    }
    if (l.kind === "none") {
      if (existing) {
        stmts.push(
          db
            .prepare(
              "DELETE FROM site_paths WHERE customer_id = ? AND path = ? AND confidence != 'operator'",
            )
            .bind(customerId, l.path),
        );
        removed++;
        count--;
      }
      continue;
    }
    if (!existing && count >= SITE_PATHS_PER_CUSTOMER) continue;
    if (!existing) count++;
    stmts.push(
      db
        .prepare(
          `INSERT INTO site_paths
             (customer_id, path, lang, kind, confidence, label, found_on, first_seen_at, last_seen_at, missing_since)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(customer_id, path) DO UPDATE SET
             lang = excluded.lang, kind = excluded.kind, confidence = excluded.confidence,
             label = excluded.label, found_on = excluded.found_on,
             last_seen_at = excluded.last_seen_at, missing_since = NULL
           WHERE site_paths.confidence != 'operator'`,
        )
        .bind(customerId, l.path, l.lang, l.kind, l.confidence, l.label, read.foundOn, now, now),
    );
    written++;
  }
  if (read.complete) {
    for (const r of state.rows) {
      // An operator's row read from the menus (found_on set) goes missing too,
      // its kind and label untouched; one the operator added never does.
      if (
        r.found_on === read.foundOn &&
        r.found_on !== "" &&
        r.missing_since === null &&
        !seen.has(r.path)
      ) {
        stmts.push(
          db
            .prepare(
              "UPDATE site_paths SET missing_since = ? WHERE customer_id = ? AND path = ? AND missing_since IS NULL AND found_on != ''",
            )
            .bind(now, customerId, r.path),
        );
        missing++;
      }
    }
  }
  if (stmts.length > 0) await db.batch(stmts);
  return { written, removed, missing };
}

/**
 * Removes rows missing for 30 days: read rows, and operator rows that came
 * from the menus (a Remove kept as `none`, a changed kind), never a row the
 * operator added (privacy review §13.3).
 */
export async function purgeMissing(
  db: D1Database,
  customerId: string,
  now: number,
): Promise<number> {
  const r = await db
    .prepare(
      "DELETE FROM site_paths WHERE customer_id = ? AND (confidence != 'operator' OR found_on != '') AND missing_since IS NOT NULL AND missing_since < ?",
    )
    .bind(customerId, now - MISSING_TTL_MS)
    .run();
  return Number(r.meta?.changes ?? 0);
}

/** The primary brief and the other languages' briefs, for the served tests. */
export async function loadServedBriefs(db: D1Database, customerId: string): Promise<ServedBrief[]> {
  const [primary, others] = await Promise.all([
    db
      .prepare(
        "SELECT value_props, differentiators, proof_points, per_intent_hints FROM business_dna WHERE customer_id = ?",
      )
      .bind(customerId)
      .first<Record<string, string | null>>(),
    db
      .prepare(
        "SELECT value_props, differentiators, proof_points FROM business_dna_i18n WHERE customer_id = ?",
      )
      .bind(customerId)
      .all<Record<string, string | null>>(),
  ]);
  const list = (raw: string | null | undefined): string[] => {
    try {
      const v = JSON.parse(raw ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  const hints = (raw: string | null | undefined): ServedBrief["per_intent_hints"] => {
    try {
      const v = JSON.parse(raw ?? "{}");
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  };
  const out: ServedBrief[] = [];
  if (primary) {
    out.push({
      value_props: list(primary.value_props),
      differentiators: list(primary.differentiators),
      proof_points: list(primary.proof_points),
      per_intent_hints: hints(primary.per_intent_hints),
    });
  }
  for (const b of others.results ?? []) {
    out.push({
      value_props: list(b.value_props),
      differentiators: list(b.differentiators),
      proof_points: list(b.proof_points),
    });
  }
  return out;
}

const ALL: readonly IntentDim[] = INTENT_DIMENSIONS;

function sameSet(a: readonly IntentDim[], b: readonly IntentDim[]): boolean {
  return a.length === b.length && a.every((d) => b.includes(d));
}

function ordered(set: Iterable<IntentDim>): IntentDim[] {
  const s = new Set(set);
  return INTENT_DIMENSIONS.filter((d) => s.has(d) || ALWAYS_SERVED.includes(d));
}

export interface ServedChange {
  served: IntentDim[];
  pending: PendingGrowth | null;
  /** The applied set changed (the bundle must be written). */
  changed: boolean;
}

/**
 * Computes the served set from the rows, the briefs and the price pages,
 * and stores it. `mode`: "auto" for a read (a growth on a live site
 * waits), "apply" for the operator's own change or Write (applies).
 */
export async function recomputeServed(
  db: D1Database,
  customerId: string,
  opts: {
    now: number;
    mode: "auto" | "apply";
    pricePages?: Map<string, boolean>;
    /**
     * The read left links without a kind (the model failed or was not
     * asked): it may grow the set but never shrink it, so a passing outage
     * never folds an intent the next read would bring back after 7 days.
     */
    noShrink?: boolean;
  },
): Promise<ServedChange> {
  const state = await loadSiteState(db, customerId);
  const current = state.served ?? [...ALL];
  const prev = state.reasons ?? null;
  if (state.off) {
    return { served: [...ALL], pending: null, changed: false };
  }
  const pricePages = new Set(prev?.price_pages ?? []);
  for (const [page, has] of opts.pricePages ?? []) {
    if (has) pricePages.add(page);
    else pricePages.delete(page);
  }
  const briefs = await loadServedBriefs(db, customerId);
  const target = servedIntents({
    paths: state.rows.map((r) => ({ path: r.path, kind: r.kind })),
    briefs,
    pricePages: [...pricePages],
  });
  const growth = target.served.filter((d) => !current.includes(d));
  const kept = opts.noShrink ? [...current] : current.filter((d) => target.served.includes(d));
  let applied: IntentDim[];
  let pending: PendingGrowth | null = null;
  let writeAt = prev?.write_at;
  if (opts.mode === "apply" || !state.live) {
    applied = ordered(opts.noShrink ? [...kept, ...target.served] : target.served);
    if (growth.length > 0 && state.live) writeAt = opts.now;
  } else {
    applied = ordered(kept);
    if (growth.length > 0) {
      const same = prev?.pending && sameSet(prev.pending.intents, growth);
      pending = {
        intents: growth,
        since: same && prev?.pending ? prev.pending.since : opts.now,
        paths: state.rows
          .filter(
            (r) =>
              (growth.includes("pricing") && r.kind === "price") ||
              (growth.includes("competitor") && (r.kind === "vs" || r.kind === "compare")),
          )
          .map((r) => r.path)
          .slice(0, 10),
      };
    }
  }
  const reasons: StoredReasons = {
    pricing: target.reasons.pricing,
    competitor: target.reasons.competitor,
    ...(pricePages.size > 0 ? { price_pages: [...pricePages].sort().slice(0, 20) } : {}),
    ...(pending ? { pending } : {}),
    ...(writeAt !== undefined ? { write_at: writeAt } : {}),
  };
  await db
    .prepare("UPDATE customers SET served_intents = ?, served_reasons = ? WHERE id = ?")
    .bind(
      applied.length === ALL.length ? null : JSON.stringify(applied),
      JSON.stringify(reasons),
      customerId,
    )
    .run();
  const changed = !sameSet(applied, current);
  // The keyword lexicon was built for the old set: due again for the
  // six-hour sweep (docs/specs/keyword-intent.md §4).
  if (changed) await markKeywordLexiconDue(db, customerId);
  return { served: applied, pending, changed };
}

/** Applies a waiting growth now (the operator's Write, or 7 days unanswered). */
export async function applyPending(
  db: D1Database,
  customerId: string,
  now: number,
): Promise<{ applied: IntentDim[] }> {
  const state = await loadSiteState(db, customerId);
  const pending = state.reasons?.pending;
  if (state.off || !pending) return { applied: [] };
  const current = state.served ?? [...ALL];
  const next = ordered([...current, ...pending.intents]);
  const { pending: _done, ...rest } = state.reasons ?? ({} as StoredReasons);
  const reasons: StoredReasons = { ...(rest as StoredReasons), write_at: now };
  await db
    .prepare("UPDATE customers SET served_intents = ?, served_reasons = ? WHERE id = ?")
    .bind(
      next.length === ALL.length ? null : JSON.stringify(next),
      JSON.stringify(reasons),
      customerId,
    )
    .run();
  const applied = pending.intents.filter((d) => !current.includes(d));
  if (applied.length > 0) await markKeywordLexiconDue(db, customerId);
  return { applied };
}

/** The bundle after any change to the rows or the served set. */
export async function writeSiteBundle(
  env: { DB: D1Database; VARIANTS: KVNamespace },
  customerId: string,
): Promise<void> {
  await writeVisitorBundle(env, customerId);
}

/**
 * Off (condition 5): the rows deleted, six intents served, the bundle
 * without `pm` and `sd`; reads, model calls and the weekly fetch stop on the
 * flag. On: the flag cleared; the next read fills the map.
 */
export async function setSiteMapOff(
  db: D1Database,
  customerId: string,
  off: boolean,
  now: number,
): Promise<void> {
  if (off) {
    const state = await loadSiteState(db, customerId);
    const grew = state.served !== null && state.live;
    await db.batch([
      db.prepare("DELETE FROM site_paths WHERE customer_id = ?").bind(customerId),
      db
        .prepare(
          "UPDATE customers SET site_map_off = 1, served_intents = NULL, served_reasons = ? WHERE id = ?",
        )
        .bind(grew ? JSON.stringify({ write_at: now }) : null, customerId),
    ]);
    if (state.served !== null) await markKeywordLexiconDue(db, customerId);
    return;
  }
  await db.prepare("UPDATE customers SET site_map_off = 0 WHERE id = ?").bind(customerId).run();
}

/**
 * The operator's rows: a kind for a path (an operator's `none` included), or
 * removed. "Not a page to use" keeps the path and the kind only: any stored
 * link text is dropped (condition 5). Remove deletes the row outright when
 * no read can bring it back (the operator added it, or its link is already
 * gone from the menus); a row still in the site's menus would come back on
 * the next read, so it becomes the operator's `none` instead, path and kind
 * only, which a read never changes.
 */
export async function setOperatorRows(
  db: D1Database,
  customerId: string,
  rows: ReadonlyArray<{ path: string; kind: SiteKindOrNone }>,
  deletes: readonly string[],
  now: number,
): Promise<{ written: number; deleted: number; setAside: number; refused: number }> {
  const state = await loadSiteState(db, customerId);
  const byPath = new Map(state.rows.map((r) => [r.path, r]));
  const have = new Set(byPath.keys());
  let count = state.rows.length;
  const stmts: D1PreparedStatement[] = [];
  let written = 0;
  let refused = 0;
  for (const r of rows) {
    if (!have.has(r.path)) {
      if (count >= SITE_PATHS_PER_CUSTOMER) {
        refused++;
        continue;
      }
      count++;
      have.add(r.path);
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO site_paths
             (customer_id, path, lang, kind, confidence, label, found_on, first_seen_at, last_seen_at, missing_since)
           VALUES (?, ?, NULL, ?, 'operator', NULL, '', ?, ?, NULL)
           ON CONFLICT(customer_id, path) DO UPDATE SET
             kind = excluded.kind, confidence = 'operator', missing_since = NULL,
             label = CASE WHEN excluded.kind = 'none' THEN NULL ELSE site_paths.label END,
             last_seen_at = excluded.last_seen_at`,
        )
        .bind(customerId, r.path, r.kind, now, now),
    );
    written++;
  }
  let deleted = 0;
  let setAside = 0;
  for (const p of deletes) {
    const row = byPath.get(p);
    if (!row) continue;
    const inMenus = row.found_on !== "" && row.missing_since === null;
    if (inMenus) {
      stmts.push(
        db
          .prepare(
            "UPDATE site_paths SET kind = 'none', confidence = 'operator', label = NULL, missing_since = NULL, last_seen_at = ? WHERE customer_id = ? AND path = ?",
          )
          .bind(now, customerId, p),
      );
      setAside++;
    } else {
      stmts.push(
        db.prepare("DELETE FROM site_paths WHERE customer_id = ? AND path = ?").bind(customerId, p),
      );
      deleted++;
    }
  }
  if (stmts.length > 0) await db.batch(stmts);
  return { written, deleted, setAside, refused };
}
