/**
 * The visitor bundle from D1, written back by the edge after an answer that
 * found no bundle in KV (2026-10-01, the /select tail). Generation writes
 * the same bundle with the hide rules (writeVisitorBundle in
 * packages/generation/src/admin/onboard.ts); both build it with the shared
 * visitorBundleFrom, so the holdout percent `h` is the same either way
 * (docs/specs/proof-engine.md, section A; parity test in
 * test/bundle-parity.test.ts), and the site map's `pm` and `sd`
 * (docs/specs/site-shaped-intents.md §5), and an audit's `a`, `ad`, `ae`
 * (docs/specs/ai-traffic-audit.md §3.4). Page facts, selectors, paths and
 * kinds, operator settings; nothing about a visitor.
 *
 * A sensitive customer's `s` and `sk` (docs/specs/sensitive-customers.md)
 * are read from the customers row in the same batch and set here. A bundle
 * without them would unmark the customer at `/event` for a day, so when that
 * read fails the whole build fails and no bundle is written (fail closed):
 * `/event` then asks the database itself.
 *
 * The shared builder leaves a button the operator has not turned on out of
 * its page (docs/specs/button-rewrite.md), so a bundle written here lists
 * the same parts as generation's. The stored manifests are read whole and
 * never changed.
 *
 * The page groups' `g` (docs/specs/page-groups.md, Data: the accepted
 * patterns, sorted, absent when none) is read in the same batch, and that
 * read alone may fail: an edge deployed before migration 0043 has no
 * `page_groups` table, and the deploy order is free. Nothing on the visitor
 * path reads `g` in phase 1 (the target's own `count:` page decides the
 * match), so a bundle without it is exactly today's bundle, while a failed
 * write-back would cost every customer the KV bundle for the colo's day.
 * This is why `g` fails open where `s` fails closed: a bundle without `s`
 * would store a sensitive customer's paths raw; a bundle without `g` costs
 * nothing.
 *
 * The "no events" `ne` (docs/specs/readiness-check.md, "As approved";
 * migration 0044) is read in the same batch with the shared
 * BUNDLE_NO_EVENTS_SQL and set with the shared helper, like `s`, and fails
 * closed like `s`: a bundle without it would store a special-category
 * customer's rows for a day before the mark, so when that read fails no
 * bundle is written and `/event` asks the database itself. The migration is
 * applied before this edge is deployed (the spec's deploy order); until then
 * every write-back fails and `/select` keeps answering from D1 as before.
 *
 * The keyword lexicon's `kl` (docs/specs/keyword-intent.md §4; migration
 * 0045) is read in the same batch with the shared BUNDLE_KEYWORD_SQL and set
 * with the shared bundleKeywordLexicon, last, so the bytes match generation's
 * writer. That read alone may fail and fails open, like `g`: an edge
 * deployed before migration 0045 has no such columns. A bundle without `kl`
 * is the safe side, not a leak: `/select` then drops the ad keyword unread
 * and the script asks the snippet not to forward it (`nt`). The cost of a
 * failed read is a day without keyword intent for that customer.
 *
 * The country switch's `co` (ADR 0036, point 6; migration 0048) is read in
 * the same batch with the shared BUNDLE_COUNTRY_SQL and set with the shared
 * helper after `ne`, and fails closed like `ne`: a bundle without it would
 * record the country of a customer that turned it off for a day, so when
 * that read fails no bundle is written and `/event` asks the database.
 */

import {
  BUNDLE_COUNTRY_SQL,
  BUNDLE_CUSTOMER_SQL,
  BUNDLE_DIRECT_SQL,
  BUNDLE_KEYWORD_SQL,
  BUNDLE_LEARNED_SQL,
  BUNDLE_NO_EVENTS_SQL,
  BUNDLE_SITE_PATHS_SQL,
  type BundleCountryRow,
  type BundleCustomerRow,
  type BundleDirectRow,
  type BundleKeywordRow,
  type BundleNoEventsRow,
  type LearnedRow,
  type Manifest,
  SENSITIVE_CUSTOMER_SQL,
  type SensitiveCustomerRow,
  type VisitorBundle,
  bundleAuditFrom,
  bundleCountryFields,
  bundleDirectFields,
  bundleKeywordLexicon,
  bundleNoEventsFields,
  bundleSensitiveFields,
  bundleSiteMapFrom,
  rememberOnSensitive,
  sensitiveSettingsFrom,
  visitorBundleFrom,
  visitorBundleKey,
} from "@rawuser/shared";
import { KV_COPY_TTL_S } from "./kv-copy.ts";

/** A bundle the edge wrote itself lives a day; generation writes it without one. */
export const BUNDLE_FALLBACK_TTL_S = 24 * 3600;

export interface BundleEnv {
  VARIANTS: KVNamespace;
  DB: D1Database;
  /**
   * "on" lets the returning-visitor memory (`rm`) run on a site marked
   * sensitive; anything else, unset included, does not. The same var and
   * the same reading as generation's writer, so both give the same bytes.
   */
  REMEMBER_ON_SENSITIVE?: string;
}

/**
 * The accepted page group patterns, as the bundle's `g` lists them. Named
 * here until the shared bundle type carries `g` (the generation side adds
 * it to visitor-bundle.ts); the edge reads `g` through this narrow type.
 */
export const BUNDLE_PAGE_GROUPS_SQL =
  "SELECT pattern FROM page_groups WHERE customer_id = ? ORDER BY pattern";

/** The bundle with the page groups' `g` (page-groups.md, Data). */
export type VisitorBundleWithGroups = VisitorBundle & { g?: string[] };

/** The patterns from `page_groups`, or null when the table cannot be read (fail open, see the file comment). */
async function readPageGroups(env: BundleEnv, customerId: string): Promise<string[] | null> {
  try {
    const rows = await env.DB.prepare(BUNDLE_PAGE_GROUPS_SQL)
      .bind(customerId)
      .all<{ pattern: string }>();
    return (rows.results ?? [])
      .map((r) => r.pattern)
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .sort();
  } catch {
    console.error("[rawuser/edge] page groups read failed (non-critical)");
    return null;
  }
}

/**
 * The customer's keyword row (migration 0045), or null when it cannot be
 * read (fail open, see the file comment). The row is never logged.
 */
async function readKeywordRow(
  env: BundleEnv,
  customerId: string,
): Promise<BundleKeywordRow | null> {
  try {
    return await env.DB.prepare(BUNDLE_KEYWORD_SQL).bind(customerId).first<BundleKeywordRow>();
  } catch {
    console.error("[rawuser/edge] keyword lexicon read failed (non-critical)");
    return null;
  }
}

/** The customer's direct row (migration 0051), or null when it cannot be read. Never logged. */
async function readDirectRow(
  env: BundleEnv,
  customerId: string,
): Promise<{ row: BundleDirectRow | null; learned: LearnedRow[] }> {
  try {
    const row = await env.DB.prepare(BUNDLE_DIRECT_SQL).bind(customerId).first<BundleDirectRow>();
    const learned =
      (await env.DB.prepare(BUNDLE_LEARNED_SQL).bind(customerId).all<LearnedRow>()).results ?? [];
    return { row, learned };
  } catch {
    console.error("[rawuser/edge] direct fields read failed (non-critical)");
    return { row: null, learned: [] };
  }
}

/** The bundle as D1 has it now. Throws when a read fails: no bundle is better than a partial one. */
export async function bundleFromD1(
  env: BundleEnv,
  customerId: string,
): Promise<VisitorBundleWithGroups> {
  const [m, c, h, sp, sens, groups, noEvents, keyword, country, direct] = await Promise.all([
    env.DB.prepare(
      "SELECT page_path, manifest FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL",
    )
      .bind(customerId)
      .all<{ page_path: string; manifest: string }>(),
    env.DB.prepare(
      `SELECT section_path, conversion_label, css_selectors, text_selectors, structural_selector
       FROM conversion_targets WHERE customer_id = ? AND enabled = 1`,
    )
      .bind(customerId)
      .all<{
        section_path: string;
        conversion_label: string;
        css_selectors: string;
        text_selectors: string;
        structural_selector: string;
      }>(),
    env.DB.prepare(BUNDLE_CUSTOMER_SQL).bind(customerId).first<BundleCustomerRow>(),
    env.DB.prepare(BUNDLE_SITE_PATHS_SQL)
      .bind(customerId)
      .all<{ path: string; kind: string; confidence: string }>(),
    // The sensitive flag and the kept sections (migration 0042), in the
    // same batch. Not caught: see the file comment.
    env.DB.prepare(SENSITIVE_CUSTOMER_SQL)
      .bind(customerId)
      .first<SensitiveCustomerRow>(),
    // The page groups' `g` (migration 0043). Caught inside: see the file comment.
    readPageGroups(env, customerId),
    // The "no events" `ne` (migration 0044), in the same batch. Not caught,
    // like the sensitive flag: see the file comment.
    env.DB.prepare(BUNDLE_NO_EVENTS_SQL)
      .bind(customerId)
      .first<BundleNoEventsRow>(),
    // The keyword lexicon's `kl` (migration 0045). Caught inside: see the file comment.
    readKeywordRow(env, customerId),
    // The country switch's `co` (migration 0048). Not caught, like `ne`.
    env.DB.prepare(BUNDLE_COUNTRY_SQL)
      .bind(customerId)
      .first<BundleCountryRow>(),
    // The direct fields (docs/specs/direct-visitors.md §6; migration 0051).
    // Caught inside: none of them is the page as built, the closed side.
    readDirectRow(env, customerId),
  ]);
  const manifests = (m.results ?? []).flatMap((r) => {
    try {
      return [{ page_path: r.page_path, manifest: JSON.parse(r.manifest) as Manifest }];
    } catch {
      return [];
    }
  });
  const built = visitorBundleFrom(
    manifests,
    c.results ?? [],
    h?.holdout_percent ?? null,
    bundleSiteMapFrom(sp.results ?? [], h ?? null),
    // The audit's `a`, `ad` and `ae` (ai-traffic-audit.md §3.4), so a bundle
    // the edge writes itself holds the host and end check too.
    bundleAuditFrom(h),
    // `g` through the shared builder, where generation puts it, so the two
    // writers give the same bytes in the same order; null (no group, or a
    // table the edge cannot read yet) gives exactly the bundle before it.
    groups,
  );
  // `s`, `sk` and `ne` last, set with the shared helpers both writers use
  // (generation's writeVisitorBundle spreads them in this order); nothing
  // for a customer that is neither sensitive nor waiting to be marked, whose
  // bundle is what it was. Then `kl`, the very last key, only when the
  // shared helper gives one (not off, not sensitive, no special-category
  // yes, a lexicon that parses).
  const kl = bundleKeywordLexicon(keyword);
  return {
    ...built,
    ...bundleSensitiveFields(sensitiveSettingsFrom(sens)),
    ...bundleNoEventsFields(noEvents),
    ...bundleCountryFields(country),
    ...bundleDirectFields(direct.row, direct.learned, {
      onSensitive: rememberOnSensitive(env.REMEMBER_ON_SENSITIVE),
    }),
    ...(kl ? { kl } : {}),
  };
}

/** Store a bundle the edge built itself, for a day. Never throws. */
async function putBundle(env: BundleEnv, customerId: string, bundle: VisitorBundle): Promise<void> {
  try {
    await env.VARIANTS.put(visitorBundleKey(customerId), JSON.stringify(bundle), {
      expirationTtl: BUNDLE_FALLBACK_TTL_S,
    });
  } catch {
    console.error("[rawuser/edge] visitor bundle write failed (non-critical)");
  }
}

/** Write the bundle back for the next visit. Never throws. */
export async function writeBundleFromD1(env: BundleEnv, customerId: string): Promise<void> {
  try {
    await putBundle(env, customerId, await bundleFromD1(env, customerId));
  } catch {
    console.error("[rawuser/edge] visitor bundle write failed (non-critical)");
  }
}

/**
 * How long a colo keeps the bundle it served: R, the same 60 s every reader
 * of the bundle uses (kv-copy.ts, privacy review condition 1 of 2026-10-26).
 */
const BUNDLE_CACHE_TTL_S = KV_COPY_TTL_S;

/**
 * The bundle for an answer outside /select (`/carry`): the one KV has, the
 * very value /select answers from, read with the same colo cache. Only when
 * KV has none is it built from D1, with the same builder, and written back
 * (`defer`) for the next read; that is /select's own fallback, on the same
 * rare day. Null when neither can be read. Never throws.
 */
export async function bundleForAnswer(
  env: BundleEnv,
  customerId: string,
  defer: (write: Promise<void>) => void,
): Promise<VisitorBundle | null> {
  try {
    const stored = await env.VARIANTS.get<VisitorBundle>(visitorBundleKey(customerId), {
      type: "json",
      cacheTtl: BUNDLE_CACHE_TTL_S,
    });
    if (stored?.v === 1) return stored;
  } catch {
    // A failed KV read is answered from the database, like a missing key.
  }
  try {
    const built = await bundleFromD1(env, customerId);
    defer(putBundle(env, customerId, built));
    return built;
  } catch {
    console.error("[rawuser/edge] visitor bundle read failed (non-critical)");
    return null;
  }
}
