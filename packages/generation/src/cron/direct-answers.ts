/**
 * The 6-hour sweep of ADR 0038 parts 3 and 5 (docs/specs/direct-visitors.md
 * §3, §5): each live customer's markets from its visits by country, and (part
 * 3) the learned default's weights. Aggregate counts only; nothing about a
 * visitor leaves the database, and nothing is logged but numbers.
 */

import {
  type ArmCount,
  type ArmWeights,
  BUNDLE_DIRECT_SQL,
  BUNDLE_LEARNED_SQL,
  type BundleDirectRow,
  INTENT_DIMENSIONS,
  type LearnedRow,
  ORIGINAL_ARM,
  type Rng,
  chooseMarkets,
  directAllowed,
  learnedBundle,
  parseChoiceSet,
  parseMarkets,
  pooledPrior,
  thompsonWeights,
  variantKeyParts,
  weightsMoved,
} from "@rawuser/shared";
import { writeVisitorBundle } from "../admin/onboard.ts";
import { type ChoiceEnv, homeCells, languageHomes, writeChoice } from "../lib/choice.ts";
import { EXPOSURE_TYPES } from "./exposure-rollup.ts";

export interface DirectSweepEnv {
  DB: D1Database;
  VARIANTS: KVNamespace;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The window a customer's markets are counted over. */
export const MARKET_WINDOW_DAYS = 30;

/** Visits by country over the window, distinct visits as the Visitors read counts them. */
export const MARKET_COUNTS_SQL = `SELECT country, COUNT(DISTINCT COALESCE(visit, id)) AS visits
  FROM events
  WHERE customer_id = ? AND ts >= ? AND country IS NOT NULL AND event_type IN ${EXPOSURE_TYPES}
  GROUP BY country`;

/** The customers the sweep looks at: live ones. */
const LIVE_SQL = "SELECT id FROM customers WHERE live_at IS NOT NULL ORDER BY id";

/** The markets a customer gets now: none unless allowed, switched on and recording countries. */
export async function marketsFor(
  db: D1Database,
  customerId: string,
  row: (BundleDirectRow & { country_off?: number | null }) | null,
  now: number,
): Promise<string[]> {
  if (!row || !directAllowed(row)) return [];
  if (Number(row.market_versions_off) === 1 || Number(row.country_off) === 1) return [];
  const counts = await db
    .prepare(MARKET_COUNTS_SQL)
    .bind(customerId, now - MARKET_WINDOW_DAYS * DAY_MS)
    .all<{ country: string; visits: number }>();
  return chooseMarkets(counts.results ?? []);
}

export interface MarketSweepResult {
  customers: number;
  changed: number;
  errors: number;
}

/**
 * Every live customer's markets, stored in `customers.markets` when they
 * changed, and the visitor bundle rewritten then. One customer's failure
 * never stops the rest.
 */
export async function runMarketSweep(
  env: DirectSweepEnv,
  now = Date.now(),
): Promise<MarketSweepResult> {
  const out: MarketSweepResult = { customers: 0, changed: 0, errors: 0 };
  const live = await env.DB.prepare(LIVE_SQL).all<{ id: string }>();
  for (const { id } of live.results ?? []) {
    out.customers++;
    try {
      const row = await env.DB.prepare(
        BUNDLE_DIRECT_SQL.replace(" FROM customers", ", country_off FROM customers"),
      )
        .bind(id)
        .first<BundleDirectRow & { country_off?: number | null }>();
      const next = await marketsFor(env.DB, id, row, now);
      const prev = parseMarkets(row?.markets ?? null);
      if (JSON.stringify(next) === JSON.stringify(prev)) continue;
      await env.DB.prepare("UPDATE customers SET markets = ? WHERE id = ?")
        .bind(next.length > 0 ? JSON.stringify(next) : null, id)
        .run();
      await writeVisitorBundle(env, id);
      out.changed++;
    } catch {
      out.errors++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Part 3: the learned best default (docs/specs/direct-visitors.md §3)
// ---------------------------------------------------------------------------

/** The window the learned default counts over. */
export const LEARNED_WINDOW_DAYS = 28;
/** Below this many pooled exposures an arm kind's prior is the pool of every arm. */
export const POOL_MIN_EXPOSURES = 100;

/** The arm of a row: `none` for the page as built, else the version's intent. */
const ARM_SQL =
  "CASE WHEN cohort = 'no_signal' OR event_type = 'no_signal_passthrough' THEN 'none' ELSE intent_dim END";

/**
 * Exposures and clicks per (page, arm), rows counted, no visit marker, from
 * the rows whose `nd` says the learned default chose them (`/event` stores
 * it in `properties.nd`).
 */
export const LEARNED_COUNTS_ND_SQL = `SELECT page_path, ${ARM_SQL} AS arm_of,
    SUM(event_type <> 'conversion') AS n, SUM(event_type = 'conversion') AS k
  FROM events
  WHERE customer_id = ?1 AND ts >= ?2
    AND event_type IN ('variant_shown', 'no_signal_passthrough', 'conversion')
    AND json_extract(properties, '$.nd') LIKE 'l:%'
  GROUP BY page_path, arm_of`;

/**
 * The same, before any row holds `nd`: the page as built for visits with no
 * signal, and the versions shown to visits with no source of their own (not
 * carried, not tagged, no platform name, not a market version).
 */
export const LEARNED_COUNTS_SQL = `SELECT page_path, ${ARM_SQL} AS arm_of,
    SUM(event_type <> 'conversion') AS n, SUM(event_type = 'conversion') AS k
  FROM events
  WHERE customer_id = ?1 AND ts >= ?2 AND (
    (event_type = 'no_signal_passthrough' AND COALESCE(language_mismatch, 0) = 0)
    OR (event_type = 'conversion' AND cohort = 'no_signal')
    OR (event_type IN ('variant_shown', 'conversion') AND cohort = 'personalized'
        AND source_dim = 'direct' AND COALESCE(carried, 0) = 0 AND COALESCE(tagged, 0) = 0
        AND source_name IS NULL AND COALESCE(variant_key, '') NOT LIKE '%:mk-%'))
  GROUP BY page_path, arm_of`;

const ND_ROWS_SQL = `SELECT COUNT(*) AS n FROM events
  WHERE customer_id = ?1 AND ts >= ?2 AND json_extract(properties, '$.nd') LIKE 'l:%'`;

/** Every live body of a cell `{intent}:default`: the version arms. */
const ARMS_SQL =
  "SELECT kv_key FROM variants WHERE customer_id = ? AND body_id IS NOT NULL AND kv_key LIKE '%:default'";

const CONFIRMED_SQL =
  "SELECT page_path FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL";

type Counts = Map<string, Map<string, { n: number; k: number }>>;

/** One customer's counts per page and arm over the window. */
export async function learnedCounts(
  db: D1Database,
  customerId: string,
  now: number,
): Promise<Counts> {
  const since = now - LEARNED_WINDOW_DAYS * DAY_MS;
  const nd = await db.prepare(ND_ROWS_SQL).bind(customerId, since).first<{ n: number }>();
  const sql = Number(nd?.n) > 0 ? LEARNED_COUNTS_ND_SQL : LEARNED_COUNTS_SQL;
  const rows = await db
    .prepare(sql)
    .bind(customerId, since)
    .all<{ page_path: string; arm_of: string | null; n: number; k: number }>();
  const out: Counts = new Map();
  for (const r of rows.results ?? []) {
    if (!r.arm_of) continue;
    const page = out.get(r.page_path) ?? new Map();
    page.set(r.arm_of, { n: Number(r.n) || 0, k: Number(r.k) || 0 });
    out.set(r.page_path, page);
  }
  return out;
}

/** The arms of each confirmed page: `none` and every intent with a live base version, in order. */
export async function learnedArms(
  db: D1Database,
  customerId: string,
): Promise<Map<string, string[]>> {
  const [keys, pages] = await Promise.all([
    db.prepare(ARMS_SQL).bind(customerId).all<{ kv_key: string }>(),
    db.prepare(CONFIRMED_SQL).bind(customerId).all<{ page_path: string }>(),
  ]);
  const confirmed = new Set((pages.results ?? []).map((p) => p.page_path));
  const byPage = new Map<string, Set<string>>();
  for (const { kv_key } of keys.results ?? []) {
    const parts = variantKeyParts(kv_key);
    if (!parts || parts.customerId !== customerId || parts.sourceDim !== "default") continue;
    if (!confirmed.has(parts.pagePath)) continue;
    const set = byPage.get(parts.pagePath) ?? new Set<string>();
    set.add(parts.intentDim);
    byPage.set(parts.pagePath, set);
  }
  const out = new Map<string, string[]>();
  for (const [page, set] of byPage) {
    const intents = INTENT_DIMENSIONS.filter((d) => set.has(d));
    if (intents.length > 0) out.set(page, [ORIGINAL_ARM, ...intents]);
  }
  return out;
}

export interface LearnedSweepResult {
  customers: number;
  changed: number;
  errors: number;
}

/**
 * Every eligible customer's weights (§3): a prior pooled across customers
 * from noised totals per arm kind, Thompson weights per page, a new set
 * stored and the bundle rewritten when an arm changed or a weight moved by
 * 25 thousandths. `rng` is injectable for tests; nothing of a visitor is
 * read, only counts.
 */
export async function runLearnedSweep(
  env: DirectSweepEnv,
  now = Date.now(),
  rng: Rng = Math.random,
): Promise<LearnedSweepResult> {
  const out: LearnedSweepResult = { customers: 0, changed: 0, errors: 0 };
  const live = await env.DB.prepare(LIVE_SQL).all<{ id: string }>();
  const eligible: Array<{ id: string; counts: Counts; arms: Map<string, string[]> }> = [];
  for (const { id } of live.results ?? []) {
    try {
      const row = await env.DB.prepare(BUNDLE_DIRECT_SQL).bind(id).first<BundleDirectRow>();
      if (!directAllowed(row) || Number(row?.learned_default_off) === 1) continue;
      eligible.push({
        id,
        counts: await learnedCounts(env.DB, id, now),
        arms: await learnedArms(env.DB, id),
      });
    } catch {
      out.errors++;
    }
  }
  // The pool: totals per arm kind across the eligible customers (not
  // sensitive, not an audit, an explicit "no", learned default on), each
  // noised before it is used. Counts only.
  const totals = new Map<string, { n: number; k: number }>();
  for (const c of eligible) {
    for (const page of c.counts.values()) {
      for (const [arm, v] of page) {
        const t = totals.get(arm) ?? { n: 0, k: 0 };
        totals.set(arm, { n: t.n + v.n, k: t.k + Math.min(v.k, v.n) });
      }
    }
  }
  // An arm kind the pool has seen too little of takes the pool of every
  // arm, so an unseen version starts at the network's rate, not at 50%.
  const all = { n: 0, k: 0 };
  for (const t of totals.values()) {
    all.n += t.n;
    all.k += t.k;
  }
  const priors = new Map<string, { a: number; b: number }>();
  const prior = (arm: string) => {
    let p = priors.get(arm);
    if (!p) {
      const own = totals.get(arm);
      p = pooledPrior(own && own.n >= POOL_MIN_EXPOSURES ? own : all, rng);
      priors.set(arm, p);
    }
    return p;
  };
  for (const c of eligible) {
    out.customers++;
    try {
      const current = learnedBundle(
        (await env.DB.prepare(BUNDLE_LEARNED_SQL).bind(c.id).all<LearnedRow>()).results ?? [],
      );
      const next: Array<{ page: string; weights: ArmWeights; counts: ArmCount[] }> = [];
      for (const [page, arms] of c.arms) {
        const counts = arms.map((arm) => ({
          arm,
          ...(c.counts.get(page)?.get(arm) ?? { n: 0, k: 0 }),
        }));
        next.push({ page, weights: thompsonWeights(counts, prior, rng), counts });
      }
      if (next.length === 0) continue;
      const moved =
        !current ||
        Object.keys(current.w).length !== next.length ||
        next.some((p) => weightsMoved(current.w[p.page], p.weights));
      if (!moved) continue;
      const setId = Math.floor(now / 1000).toString(36);
      for (const p of next) {
        await env.DB.prepare(
          `INSERT OR REPLACE INTO learned_weights
             (customer_id, set_id, page_path, weights, counts, computed_at, live_from)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            c.id,
            setId,
            p.page,
            JSON.stringify(p.weights),
            JSON.stringify(p.counts.map((x) => [x.arm, x.n, x.k])),
            now,
            now,
          )
          .run();
      }
      await writeVisitorBundle(env, c.id);
      out.changed++;
    } catch {
      out.errors++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Part 2: the visitor's own choice, a first question for the customer to see
// ---------------------------------------------------------------------------

/**
 * A first question for each language home of each live customer the
 * question may run for (docs/specs/direct-visitors.md §2, "A question per
 * language"): `/` in the brief's language and every `/az`-style page in its
 * own, written automatically once the page has two live versions. It stays
 * off: the customer turns it on after the preview. Runs in the five-minute
 * queue, so a new customer has its questions minutes after its versions. At
 * most CHOICE_SWEEP_MAX model writes a run; a home whose writing failed is
 * tried again after CHOICE_RETRY_S (a KV mark), one with too few versions
 * next run, at no cost.
 */
export const CHOICE_SWEEP_MAX = 2;
export const CHOICE_RETRY_S = 6 * 3600;

const choiceTriedKey = (id: string, home: string) => `choice:tried:${id}:${home}`;

export async function runChoiceSweep(
  env: ChoiceEnv,
  write: typeof writeChoice = writeChoice,
): Promise<{ written: number; failed: number }> {
  const rows = await env.DB.prepare(
    "SELECT id, choice, choice_draft FROM customers WHERE live_at IS NOT NULL AND (special_category = 0 OR COALESCE(sensitive, 0) = 1) AND COALESCE(plan, '') <> 'audit' ORDER BY id",
  ).all<{ id: string; choice: string | null; choice_draft: string | null }>();
  const out = { written: 0, failed: 0 };
  for (const r of rows.results ?? []) {
    const have = { ...parseChoiceSet(r.choice_draft), ...parseChoiceSet(r.choice) };
    for (const { path } of await languageHomes(env.DB, r.id)) {
      if (out.written + out.failed >= CHOICE_SWEEP_MAX) return out;
      if (have[path]) continue;
      if ((await homeCells(env, r.id, path)).length < 2) continue;
      if (await env.VARIANTS.get(choiceTriedKey(r.id, path))) continue;
      try {
        const w = await write(env, r.id, undefined, path);
        if (w.ok) out.written++;
        else {
          out.failed++;
          await env.VARIANTS.put(choiceTriedKey(r.id, path), "1", {
            expirationTtl: CHOICE_RETRY_S,
          });
        }
      } catch {
        out.failed++;
      }
    }
  }
  return out;
}
