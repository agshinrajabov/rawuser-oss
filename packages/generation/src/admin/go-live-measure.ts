/**
 * Measure at go live (docs/specs/measure-at-go-live.md, sections 4 to 6 and
 * 12; privacy review CONDITIONAL PASS 2026-10-05, conditions 1, 3 and 4).
 *
 * - The quickstart's `measure`: the proposed button, the other candidates,
 *   which language pages carry it, and the traffic before go live.
 * - Go live's two steps: the counted button (one enabled target, its CSS
 *   selectors the union over the primary and the ticked language pages),
 *   then a 20% test, started only on an explicit `test: true` at a true
 *   first go live (live_at NULL before the request, no holdout_tests row
 *   ever), never for a test customer, never past a year to read.
 *
 * Operator data only: a slot name, the button's own words, selectors, and
 * daily counts. Nothing about a visitor.
 */

import {
  CUSTOMER_TEST_PERCENT,
  type GoLiveMeasure,
  type GoLiveTestReason,
  type Goes,
  MAX_READ_WEEKS,
  type Manifest,
  type MeasureProposal,
  countTargetPage,
  countTargetPath,
} from "@rawuser/shared";
import { DAY_MS, dayOf } from "../cron/exposure-rollup.ts";
import {
  COUNT_SLOTS,
  type PageKindOf,
  conversionLabelFor,
  pageHasContactLink,
  rankButtons,
} from "../lib/measure-proposal.ts";
import { baselineOf, estimateFor, loadOutcomes } from "../lib/proof-report.ts";
import type { SessionUser } from "./auth.ts";
import { countOnlyTarget } from "./conversions.ts";
import type { AdminEnv } from "./handlers.ts";
import { actorOf, setHoldout } from "./proof.ts";

/** Page path → count slot → the CSS selectors that matched once on that page. */
export type MeasureSelectors = Record<string, Record<string, string[]>>;

/**
 * Page path → count slot → where its button goes (the closed word, never a
 * link), read with the selectors above and written to `goes` at go live.
 */
export type MeasureGoes = Record<string, Record<string, Goes>>;

/** A go-live estimate needs this many closed days of rows before it (spec §5). */
export const BASELINE_MIN_DAYS = 7;
/** At most this many CSS selectors on the counted target (spec §6). */
const MAX_TARGET_CSS = 6;
const MAX_TARGET_TEXT = 6;

/** The traffic before go live: closed days with rows, and a 20% estimate from 7 of them. */
export async function goLiveBaseline(
  db: D1Database,
  customerId: string,
  now: number,
): Promise<{ baseline_days: number; estimate_weeks: number | null; low_traffic: boolean }> {
  const today = dayOf(now);
  const from = dayOf(Date.parse(`${today}T00:00:00Z`) - 30 * DAY_MS);
  const to = dayOf(Date.parse(`${today}T00:00:00Z`) - DAY_MS);
  const rows = await loadOutcomes(db, customerId, from, to);
  const days = new Set(rows.map((r) => r.day)).size;
  if (days < BASELINE_MIN_DAYS)
    return { baseline_days: days, estimate_weeks: null, low_traffic: false };
  const est = estimateFor(baselineOf(rows, from, to), CUSTOMER_TEST_PERCENT);
  return {
    baseline_days: days,
    estimate_weeks: est.weeks,
    low_traffic: est.weeks !== null && est.weeks > MAX_READ_WEEKS,
  };
}

/** The quickstart record's `measure` (first go live only). */
export async function measureProposal(
  db: D1Database,
  input: {
    customerId: string;
    pagePath: string;
    html: string;
    manifest: Manifest;
    uncertain: readonly string[];
    /** Each other language page read in this chain, with its once-matching selectors. */
    languagePages: Array<{ lang: string; path: string }>;
    selectors: MeasureSelectors;
    now: number;
  },
): Promise<MeasureProposal> {
  const ranked = rankButtons(input.html, input.manifest, input.uncertain, input.pagePath).map(
    (b) => ({ section_path: b.section_path, label: b.label }),
  );
  // A button the customer already picked on this page (the count-only pick,
  // visual-picker.md §9) leads: their choice beats our ranking.
  const picked = await db
    .prepare("SELECT label FROM conversion_targets WHERE customer_id = ? AND section_path = ?")
    .bind(input.customerId, countTargetPath(input.pagePath))
    .first<{ label: string }>();
  const all = picked
    ? [{ section_path: countTargetPath(input.pagePath), label: picked.label }, ...ranked]
    : ranked;
  const proposal = all[0] ?? null;
  const others = all.slice(1);
  const per_language = input.languagePages.map((p) => {
    const slots = Object.keys(input.selectors[p.path] ?? {});
    return {
      lang: p.lang,
      path: p.path,
      found: proposal !== null && slots.includes(proposal.section_path),
      slots,
    };
  });
  const baseline = await goLiveBaseline(db, input.customerId, input.now);
  return { proposal, others, per_language, ...baseline };
}

/**
 * For go live and the readiness check, read with the proposal and never
 * shown: where each count slot's button goes on this page (`goes`), and
 * whether the page shows a contact link at all (check 2's hint). Page facts
 * as closed words; the links themselves stay in `rankButtons`.
 */
export function measureGoesOf(
  html: string,
  manifest: Manifest,
  uncertain: readonly string[],
  pagePath: string,
  site: { host?: string | null; kindOf?: PageKindOf | null },
): { goes: Record<string, Goes>; contact_link: boolean } {
  const goes: Record<string, Goes> = {};
  for (const b of rankButtons(html, manifest, uncertain, pagePath, site)) {
    goes[b.section_path] = b.goes;
  }
  return { goes, contact_link: pageHasContactLink(html) };
}

async function storedManifest(
  db: D1Database,
  customerId: string,
  pagePath: string,
): Promise<Manifest | null> {
  const row = await db
    .prepare("SELECT manifest FROM element_manifests WHERE customer_id = ? AND page_path = ?")
    .bind(customerId, pagePath)
    .first<{ manifest: string }>();
  if (!row?.manifest) return null;
  try {
    return JSON.parse(row.manifest) as Manifest;
  } catch {
    return null;
  }
}

function addUnique(into: string[], items: readonly string[] | undefined, max: number) {
  for (const s of items ?? []) {
    if (typeof s !== "string" || s === "" || into.includes(s)) continue;
    if (into.length >= max) return;
    into.push(s);
  }
}

export interface GoLiveMeasureInput {
  customerId: string;
  pagePath: string;
  extraPage: boolean;
  /** customers.live_at as it was before this request. */
  liveBefore: number | null;
  plan: string | null;
  /** The body's `count`; null or absent: no button chosen. */
  count: { section_path: string } | null;
  /** The body's `test`: only `true` starts one. */
  test: boolean;
  /** The other language pages ticked at this go live. */
  languagePages: Array<{ lang: string; path: string }>;
  /** From the quickstart record; null when it expired. */
  selectors: MeasureSelectors | null;
  /** From the same record: where each slot's button goes; null when it expired or predates it. */
  goes?: MeasureGoes | null;
  user: SessionUser;
  now: number;
}

/**
 * Go live's two steps, after the manifests are confirmed and before
 * live_at is stamped (a failure here leaves the go live repeatable).
 */
export async function goLiveMeasure(
  env: AdminEnv,
  input: GoLiveMeasureInput,
): Promise<GoLiveMeasure> {
  const { customerId } = input;
  const ever = await env.DB.prepare("SELECT COUNT(*) AS n FROM holdout_tests WHERE customer_id = ?")
    .bind(customerId)
    .first<{ n: number }>();
  const testsEver = Number(ever?.n ?? 0);

  // 1. The counted button: first go live of the site only, never with a
  //    test on record (the counted set is a test's metric).
  let count: GoLiveMeasure["count"] = null;
  const slot = input.count?.section_path;
  if (!input.extraPage && testsEver === 0 && typeof slot === "string" && slot !== "") {
    count = await writeCount(env, input, slot);
  }

  // 2. The test.
  const reason = await testReason(env, input, testsEver, count !== null);
  if (reason !== "started") {
    return { count, test: { started: false, percent: 0, since: null, reason } };
  }
  const set = await setHoldout(env, customerId, CUSTOMER_TEST_PERCENT, input.now, {
    by: "go_live",
    actor: actorOf(input.user),
  });
  return {
    count,
    test: { started: true, percent: CUSTOMER_TEST_PERCENT, since: set.since, reason: "started" },
  };
}

async function testReason(
  env: AdminEnv,
  input: GoLiveMeasureInput,
  testsEver: number,
  counted: boolean,
): Promise<GoLiveTestReason> {
  if (input.extraPage) return "extra_page";
  if (input.plan === "test") return "test_customer";
  if (testsEver > 0) return "already_ran";
  if (input.liveBefore !== null) return "already_live";
  if (input.test !== true) return "off";
  if (!counted) return "no_button";
  const baseline = await goLiveBaseline(env.DB, input.customerId, input.now);
  if (baseline.low_traffic) return "low_traffic";
  return "started";
}

/**
 * The target from the confirmed manifests: the slot's selectors on the
 * primary page and on each ticked language page, only those that matched
 * once where that is known, deduplicated, at most six; the primary page's
 * words as its label. A slot outside the manifests counts only when a
 * target for it already exists (a button picked on the page).
 */
async function writeCount(
  env: AdminEnv,
  input: GoLiveMeasureInput,
  slot: string,
): Promise<GoLiveMeasure["count"]> {
  const primary = await storedManifest(env.DB, input.customerId, input.pagePath);
  const entry = primary?.[slot];
  const isCountSlot = (COUNT_SLOTS as readonly string[]).includes(slot);
  if (!entry || !isCountSlot || entry.conversion_candidate === false) {
    // A button picked on the page (visual-picker.md §9) is a target already;
    // it is counted only on the page it was picked on, so every other
    // ticked page is named. Any other slot outside the manifests: no button.
    const page = countTargetPage(slot);
    if (page === null) return null;
    const existing = await countOnlyTarget(env, input.customerId, slot);
    if (!existing.ok) return null;
    const pages = [input.pagePath, ...input.languagePages.map((p) => p.path)];
    return {
      section_path: slot,
      label: existing.label,
      not_found_on: pages.filter((p) => p !== page),
    };
  }

  const once = (path: string) => input.selectors?.[path]?.[slot];
  const css: string[] = [];
  const text: string[] = [];
  // Primary: the once-matching selectors that are still in the (edited)
  // manifest; when none are known or none are left, the manifest's own.
  const primaryOnce = once(input.pagePath);
  const kept = primaryOnce ? (entry.css ?? []).filter((c) => primaryOnce.includes(c)) : [];
  addUnique(css, kept.length > 0 ? kept : entry.css, MAX_TARGET_CSS);
  addUnique(text, entry.text, MAX_TARGET_TEXT);

  const notFoundOn: string[] = [];
  for (const page of input.languagePages) {
    const other = (await storedManifest(env.DB, input.customerId, page.path))?.[slot];
    const known = once(page.path);
    const pageCss =
      other && other.conversion_candidate !== false
        ? input.selectors
          ? (other.css ?? []).filter((c) => (known ?? []).includes(c))
          : (other.css ?? [])
        : [];
    if (pageCss.length === 0) {
      notFoundOn.push(page.path);
      continue;
    }
    addUnique(css, pageCss, MAX_TARGET_CSS);
    addUnique(text, other?.text, MAX_TARGET_TEXT);
  }

  const label = (entry.text?.[0] ?? "").trim() || slot;
  const written = await countOnlyTarget(env, input.customerId, slot, {
    label,
    conversion_label: conversionLabelFor(slot, label),
    css_selectors: css,
    text_selectors: text,
    structural_selector: entry.structural ?? slot,
    // Where the primary page's button goes (readiness-check.md, check 2);
    // unknown on a record from before, and stored as NULL then.
    goes: input.goes?.[input.pagePath]?.[slot] ?? null,
  });
  return written.ok ? { section_path: slot, label, not_found_on: notFoundOn } : null;
}
