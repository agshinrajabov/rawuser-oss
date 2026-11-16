/**
 * Admin onboarding handlers: element auto-detection endpoints.
 *
 * Three endpoints, all gated by the X-Rawuser-Admin header:
 *
 *   POST /admin/onboard/detect
 *     body: { customer_id: string; source_url: string }
 *     Validates customer exists, fetches HTML via fetchPageHtml, calls
 *     detectElements, stores into D1 with confirmed_at = NULL.
 *     Returns { manifest, source_url, generated_at, cost_usd, status: "unconfirmed" }.
 *
 *   POST /admin/onboard/confirm
 *     body: { customer_id: string }
 *     Sets confirmed_at to the current epoch ms.
 *     Returns { manifest, source_url, generated_at, cost_usd, confirmed_at, status: "confirmed" }.
 *
 *   GET /admin/onboard/manifest?customer_id=X
 *     Returns the stored manifest row or 404 if none exists.
 *
 * Privacy invariants:
 * - source_url is a public marketing URL (operator-supplied). fetchPageHtml
 *   logs only a URL digest on failure, never the raw URL.
 * - Full page HTML is consumed in-memory only; never persisted.
 * - The stored manifest contains CSS selectors and text signatures from
 *   public marketing copy: not visitor PII.
 * - Unconfirmed manifests (confirmed_at IS NULL) are never returned to visitors
 *   via the edge /select path. The detect/confirm gate is a fail-safe.
 * - Gated-page guard: detection is operator-initiated against a URL supplied
 *   by the operator. If the target URL requires authentication, detectElements
 *   will receive a login redirect or error page: the resulting manifest will
 *   be useless but not harmful (operator will see it before confirming).
 *   V2: add a check for HTTP 3xx to a login page pattern.
 */

import {
  CAPTURE_TTL_S,
  type ConversionTargetRow,
  captureKey,
  captureTokenKey,
  customerLangKey,
  hideRulesFromManifests,
  hideRulesKey,
  normalizePath,
  pagePathRefusal,
  receiveCapture,
  richKey,
  richPathsFromManifests,
  visitorBundleFrom,
  visitorBundleKey,
} from "@rawuser/shared";
import {
  BUNDLE_COUNTRY_SQL,
  BUNDLE_CUSTOMER_SQL,
  BUNDLE_DIRECT_SQL,
  BUNDLE_GROUPS_SQL,
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
  SENSITIVE_CUSTOMER_SQL,
  type SensitiveCustomerRow,
  bundleAuditFrom,
  bundleCountryFields,
  bundleDirectFields,
  bundleKeywordLexicon,
  bundleNoEventsFields,
  bundleSensitiveFields,
  bundleSiteMapFrom,
  sensitiveSettingsFrom,
} from "@rawuser/shared";
import type { Manifest } from "../detect-elements.ts";
import { detectElements, fetchPageHtml } from "../detect-elements.ts";
import type { GenerateEnv } from "../generateVariant.ts";
import { type InstallEnv, fetcherUserAgent, rememberOptions } from "../install-config.ts";
import {
  type ButtonRow,
  buttonsOf,
  carryRewrite,
  loadCountedTargets,
  writtenRows,
} from "../lib/button-rewrite.ts";
import { partsVersionsWrite } from "../lib/hidden-parts.ts";
import { OFF_HOST_LINE, OffHostRedirectError, sameSite, siteHost } from "../lib/public-url.ts";
import { renderIfShell } from "../lib/read-page.ts";
import { sensitivePageRefusal } from "../lib/sensitive-guard.ts";
import { markVersionsStale } from "../lib/version-approval.ts";
import type { SelectorHealth } from "../selector-health.ts";
import { validateSelectors } from "../selector-health.ts";
import { loadServedIntents } from "../site-map/served-load.ts";
import type { SessionUser } from "./auth.ts";
import type { CorsEnv } from "./cors.ts";
import { jsonWithCors } from "./cors.ts";
import { tagWithheldRefusal } from "./readiness.ts";
import { requireCustomerScope } from "./scope.ts";

export interface OnboardEnv extends GenerateEnv, CorsEnv, InstallEnv {
  DB: D1Database;
  ENVIRONMENT: string;
  /** KV: used by the rendered-DOM capture flow (element-detection-v2). */
  VARIANTS: KVNamespace;
}

// ---------------------------------------------------------------------------
// Rendered-DOM capture (element-detection-v2, T2)
//
// CSR sites (the ICP's Lovable/v0 default) return skeleton HTML to a plain
// fetch, so detection sees nothing. The capture flow lets the operator's own
// browser supply the RENDERED DOM: dashboard mints a one-time token, the
// operator runs a bookmarklet on their site, the bookmarklet POSTs the DOM to
// the public /onboard/capture endpoint, and detect prefers that capture over
// fetching. Captured HTML is the operator's own public page: KV-only, 15-min
// TTL, deleted after use, never in D1.
// ---------------------------------------------------------------------------

// Constants and key helpers live in @rawuser/shared (capture.ts) so the edge
// can receive the same payload without importing this package. Re-exported
// for existing callers.
export {
  CAPTURE_MAX_RAW_BYTES,
  CAPTURE_MAX_STORED_BYTES,
  CAPTURE_TTL_S,
  captureKey,
  captureTokenKey,
} from "@rawuser/shared";

// ---------------------------------------------------------------------------
// Row type from D1
// ---------------------------------------------------------------------------

interface ManifestRow {
  customer_id: string;
  page_path: string;
  manifest: string;
  source_url: string;
  generated_at: number;
  confirmed_at: number | null;
  cost_usd: number;
}

interface ManifestResponse {
  customer_id: string;
  page_path: string;
  manifest: Manifest;
  source_url: string;
  generated_at: number;
  confirmed_at: number | null;
  cost_usd: number;
  status: "unconfirmed" | "confirmed";
  /**
   * Per-selector validation against the source HTML (T1c). Present only on
   * fresh /detect responses: advisory, never persisted, never blocking.
   */
  selector_health?: SelectorHealth;
  /** Where the detected HTML came from (fresh /detect responses only). */
  html_source?: "capture" | "fetch";
  /**
   * The page's buttons with their switch (`rewrite`) and whether their
   * clicks are counted (lib/button-rewrite.ts). On the manifest reads.
   */
  buttons?: ButtonRow[];
}

function rowToResponse(row: ManifestRow): ManifestResponse {
  return {
    customer_id: row.customer_id,
    page_path: row.page_path,
    manifest: JSON.parse(row.manifest) as Manifest,
    source_url: row.source_url,
    generated_at: row.generated_at,
    confirmed_at: row.confirmed_at,
    cost_usd: row.cost_usd,
    status: row.confirmed_at != null ? "confirmed" : "unconfirmed",
  };
}

/**
 * Derive the normalized page_path a manifest targets. Explicit page_path wins;
 * otherwise fall back to the source_url's own pathname. So onboarding
 * `https://school.lumera.test/start` targets `/start` with no extra input, and
 * the bare homepage targets `/`. (A1 / per-path manifests.)
 */
function resolvePagePath(explicit: string | undefined, sourceUrl: string): string {
  if (explicit !== undefined) return normalizePath(explicit);
  try {
    return normalizePath(new URL(sourceUrl).pathname);
  } catch {
    return "/";
  }
}

/**
 * Persist a detected manifest keyed by (customer_id, page_path), A1 per-path.
 * Re-detecting the same path overwrites and resets confirmed_at to NULL so a
 * changed page must be re-confirmed before shipping to visitors. Shared by
 * /detect and the quickstart chain. Returns generated_at.
 */
export async function storeUnconfirmedManifest(
  db: D1Database,
  row: {
    customer_id: string;
    page_path: string;
    manifest: Manifest;
    source_url: string;
    cost_usd: number;
    /** BCP-47 primary subtag of the page; generation writes this path in it. */
    language?: string | null;
  },
): Promise<number> {
  // Backstop (event-paths.md §8, condition 3): every handler refuses such a
  // page first with its own line; nothing stores one if a new caller forgets.
  if (pagePathRefusal(row.page_path)) throw new Error("page path holds an identifier");
  // The same backstop for a sensitive customer (docs/specs/sensitive-customers.md,
  // condition 2): only `/` and a kept section; every handler answers 409 first.
  if (await sensitivePageRefusal(db, row.customer_id, row.page_path)) {
    throw new Error("page is outside the kept sections");
  }
  // A page read again keeps the operator's "rewrite this button" where the
  // button is still the same one (lib/button-rewrite.ts); a slot that now
  // points at another element starts off.
  const manifest = carryRewrite(
    row.manifest,
    await storedManifestOf(db, row.customer_id, row.page_path),
  );
  const generatedAt = Date.now();
  await db
    .prepare(
      `INSERT INTO element_manifests
         (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, cost_usd, language)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(customer_id, page_path) DO UPDATE SET
         manifest = excluded.manifest,
         source_url = excluded.source_url,
         generated_at = excluded.generated_at,
         confirmed_at = NULL,
         cost_usd = excluded.cost_usd,
         language = COALESCE(excluded.language, element_manifests.language)`,
    )
    .bind(
      row.customer_id,
      row.page_path,
      JSON.stringify(manifest),
      row.source_url,
      generatedAt,
      row.cost_usd,
      row.language ?? null,
    )
    .run();
  return generatedAt;
}

/** The manifest stored for a page, confirmed or not; null when none or unreadable. */
export async function storedManifestOf(
  db: D1Database,
  customerId: string,
  pagePath: string,
): Promise<Manifest | null> {
  try {
    const row = await db
      .prepare("SELECT manifest FROM element_manifests WHERE customer_id = ? AND page_path = ?")
      .bind(customerId, pagePath)
      .first<{ manifest: string }>();
    return row?.manifest ? (JSON.parse(row.manifest) as Manifest) : null;
  } catch {
    return null;
  }
}

/**
 * The edge's language gate reads one KV value per customer: a map of
 * confirmed path → language, so `/az` visitors get the Azerbaijani versions
 * and `/` visitors the English ones (docs/specs/per-language.md). Paths
 * without a recorded language fall back to the primary brief language.
 * Rebuilt after every confirm, go-live and brief edit.
 */
export async function writeLangMap(env: OnboardEnv, customerId: string): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT page_path, language FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL",
  )
    .bind(customerId)
    .all<{ page_path: string; language: string | null }>();
  const dna = await env.DB.prepare("SELECT target_language FROM business_dna WHERE customer_id = ?")
    .bind(customerId)
    .first<{ target_language: string }>();
  const primary = dna?.target_language?.trim() || "en";
  const map: Record<string, string> = { "/": primary };
  for (const r of rows.results ?? []) {
    if (r.language) map[r.page_path] = r.language;
  }
  await env.VARIANTS.put(customerLangKey(customerId), JSON.stringify(map));
}

/**
 * Quiet swap (docs/specs/quiet-swap.md): after any confirm, rebuild the
 * customer's hide rules from every CONFIRMED manifest and store them in KV;
 * the customer's script (`/s/{id}.js`) ships them so rewritten elements are
 * hidden before first paint. Unconfirmed manifests never reach this list.
 *
 * Also called after each run that tried a version and when versions are
 * marked stale: what is hidden follows what the versions write
 * (lib/hidden-parts.ts).
 */
export async function writeHideRules(
  env: Pick<OnboardEnv, "DB" | "VARIANTS">,
  customerId: string,
): Promise<void> {
  const result = await env.DB.prepare(
    "SELECT page_path, manifest FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL",
  )
    .bind(customerId)
    .all<{ page_path: string; manifest: string }>();
  // Only the parts Rawuser writes: a button that stays as built is neither
  // hidden nor a target (lib/button-rewrite.ts).
  const rows = writtenRows(
    (result.results ?? []).flatMap((r) => {
      try {
        return [{ page_path: r.page_path, manifest: JSON.parse(r.manifest) as Manifest }];
      } catch {
        return [];
      }
    }),
  );
  // An ended audit (docs/specs/ai-traffic-audit.md §3.8): the script ships
  // no hide rules and no rich pages, so nothing is held back while the edge
  // answers with the record-nothing answer from `ae` on.
  const ended = await env.DB.prepare("SELECT status FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ status: string | null }>();
  if (ended?.status === "ended") {
    await env.VARIANTS.put(hideRulesKey(customerId), JSON.stringify(hideRulesFromManifests([])));
    await env.VARIANTS.put(richKey(customerId), JSON.stringify(richPathsFromManifests([])));
    await writeVisitorBundle(env, customerId, rows);
    return;
  }
  // A part no version writes is not hidden (lib/hidden-parts.ts, A14): on a
  // page whose versions are all written or refused, only the parts that the
  // body of some version writes. Any other page keeps every part hidden, so
  // nothing is read in its own words and then changed. The bundle below
  // keeps every part: a target without words is not written.
  const written = await partsVersionsWrite(
    env.DB,
    customerId,
    rows.map((r) => r.page_path),
    await loadServedIntents(customerId, env.DB),
  );
  const hidden = rows.map((r) => {
    const parts = written.get(r.page_path);
    if (!parts) return r;
    return {
      ...r,
      manifest: Object.fromEntries(Object.entries(r.manifest).filter(([path]) => parts.has(path))),
    };
  });
  await env.VARIANTS.put(hideRulesKey(customerId), JSON.stringify(hideRulesFromManifests(hidden)));
  // Rich writers on demand (2026-09-30): the pages whose parts need the
  // template or lines writers, so the customer script tells the snippet to
  // load `/rich.js` there in parallel with /select. Same confirmed rows.
  await env.VARIANTS.put(richKey(customerId), JSON.stringify(richPathsFromManifests(rows)));
  await writeVisitorBundle(env, customerId, rows);
}

/**
 * The visitor bundle (2026-10-01): every confirmed page's manifest, the
 * enabled conversion targets and the holdout percent in one KV key, so
 * /select reads no database (the two D1 reads were the widest stage of its
 * time). Written with the hide rules, after a conversion target changes,
 * after the holdout changes and after the sensitive flag or its kept
 * sections change. For a sensitive customer it carries `s: 1` and `sk`
 * (docs/specs/sensitive-customers.md); a write that cannot read the flag
 * writes nothing.
 *
 * A page's manifest goes in without the buttons that stay as built
 * (lib/button-rewrite.ts): the snippet writes only a part the manifest maps,
 * so a label an older version still carries is not written. The conversion
 * targets are their own rows and their own selectors: a counted button is in
 * `conv` whatever its switch says.
 *
 * `rm`, the returning-visitor memory, also depends on the install:
 * REMEMBER_ON_SENSITIVE is read from `env`, so every caller hands on the
 * worker's own env, never a copy that holds only the bindings.
 */
export async function writeVisitorBundle(
  env: Pick<OnboardEnv, "DB" | "VARIANTS" | "REMEMBER_ON_SENSITIVE">,
  customerId: string,
  confirmed?: { page_path: string; manifest: Manifest }[],
): Promise<void> {
  let rows = confirmed;
  if (!rows) {
    const result = await env.DB.prepare(
      "SELECT page_path, manifest FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL",
    )
      .bind(customerId)
      .all<{ page_path: string; manifest: string }>();
    rows = (result.results ?? []).flatMap((r) => {
      try {
        return [{ page_path: r.page_path, manifest: JSON.parse(r.manifest) as Manifest }];
      } catch {
        return [];
      }
    });
  }
  // Applied to rows a caller passed too: filtering twice changes nothing.
  rows = writtenRows(rows);
  const conv = await env.DB.prepare(
    `SELECT section_path, conversion_label, css_selectors, text_selectors, structural_selector
     FROM conversion_targets WHERE customer_id = ? AND enabled = 1`,
  )
    .bind(customerId)
    .all<ConversionTargetRow>();
  // The holdout percent rides in the bundle as `h` (docs/specs/proof-engine.md,
  // A): the edge decides the arm without a database read. NULL: no `h`, the
  // edge's env default.
  const holdout = await env.DB.prepare(BUNDLE_CUSTOMER_SQL)
    .bind(customerId)
    .first<BundleCustomerRow>();
  // The site map's `pm` and `sd` (docs/specs/site-shaped-intents.md §5):
  // paths and kinds only; off drops both (privacy review condition 5).
  const sitePaths = await env.DB.prepare(BUNDLE_SITE_PATHS_SQL)
    .bind(customerId)
    .all<{ path: string; kind: string; confidence: string }>();
  // The sensitive flag and the kept sections (docs/specs/sensitive-customers.md;
  // migration 0042). Not caught: a bundle without `s` would unmark the
  // customer at the edge, so a failed read writes no bundle at all, and the
  // edge then asks the database itself (condition 3, fail closed).
  const sensitive = await env.DB.prepare(SENSITIVE_CUSTOMER_SQL)
    .bind(customerId)
    .first<SensitiveCustomerRow>();
  // The page groups' `g` (docs/specs/page-groups.md): the accepted
  // patterns, absent when there are none.
  const groups = await env.DB.prepare(BUNDLE_GROUPS_SQL)
    .bind(customerId)
    .all<{ pattern: string }>();
  const built = visitorBundleFrom(
    rows,
    conv.results ?? [],
    holdout?.holdout_percent ?? null,
    bundleSiteMapFrom(sitePaths.results ?? [], holdout ?? null),
    // The audit's `a`, `ad`, `ae` (docs/specs/ai-traffic-audit.md §3.4).
    bundleAuditFrom(holdout),
    (groups.results ?? []).map((r) => String(r.pattern)),
  );
  // `ne` (docs/specs/readiness-check.md, "As approved"; migration 0044): a
  // special-category yes that no superadmin has marked yet stores no event
  // row at the edge. Not caught, like the flag above: a bundle without `ne`
  // would record an unmarked site, so a failed read writes no bundle.
  const noEvents = await env.DB.prepare(BUNDLE_NO_EVENTS_SQL)
    .bind(customerId)
    .first<BundleNoEventsRow>();
  // `co`, the country switch (ADR 0036, point 6; migration 0048). Not
  // caught, like `ne`: a bundle without it would record the country of a
  // customer that turned it off, so a failed read writes no bundle.
  const country = await env.DB.prepare(BUNDLE_COUNTRY_SQL)
    .bind(customerId)
    .first<BundleCountryRow>();
  // `kl`, the keyword lexicon (docs/specs/keyword-intent.md §4; migration
  // 0045): only for a customer not off, not sensitive and not a
  // special-category yes (privacy review, section 10, conditions 8 and 10). Caught:
  // a failed read leaves `kl` out, which turns keyword reading off, the
  // closed side.
  let keyword: BundleKeywordRow | null = null;
  try {
    keyword = await env.DB.prepare(BUNDLE_KEYWORD_SQL).bind(customerId).first<BundleKeywordRow>();
  } catch {
    keyword = null;
  }
  const kl = bundleKeywordLexicon(keyword);
  // The direct fields (docs/specs/direct-visitors.md §6; migration 0051).
  // Caught: a failed read leaves them out, which is the page as built for
  // visits with no signal, the closed side.
  let direct: BundleDirectRow | null = null;
  let learned: LearnedRow[] = [];
  try {
    direct = await env.DB.prepare(BUNDLE_DIRECT_SQL).bind(customerId).first<BundleDirectRow>();
    learned =
      (await env.DB.prepare(BUNDLE_LEARNED_SQL).bind(customerId).all<LearnedRow>()).results ?? [];
  } catch {
    direct = null;
  }
  await env.VARIANTS.put(
    visitorBundleKey(customerId),
    // `s`, `sk`, `ne` and `kl` last, with the shared helpers the edge's
    // write-back uses (packages/edge/src/bundle-writeback.ts), so both
    // writers give the same bytes; nothing for a customer that is neither
    // sensitive nor waiting to be marked and has no lexicon, whose bundle is
    // what it was.
    JSON.stringify({
      ...built,
      ...bundleSensitiveFields(sensitiveSettingsFrom(sensitive)),
      ...bundleNoEventsFields(noEvents),
      ...bundleCountryFields(country),
      ...bundleDirectFields(direct, learned, rememberOptions(env)),
      ...(kl ? { kl } : {}),
    }),
  );
}

export interface HideRulesSweepResult {
  written: string[];
  failed: string[];
}

/**
 * Rewrite the hide rules and the rich key of every customer with a confirmed
 * manifest (2026-09-30). The rich key is new, so customers confirmed before
 * it have none; the 6-hour cron runs this sweep so they get it without a
 * manual production write, and any later drift heals the same way. One
 * customer's failure never stops the others.
 */
export async function sweepHideRules(
  env: Pick<OnboardEnv, "DB" | "VARIANTS">,
): Promise<HideRulesSweepResult> {
  const out: HideRulesSweepResult = { written: [], failed: [] };
  const rows = await env.DB.prepare(
    "SELECT DISTINCT customer_id FROM element_manifests WHERE confirmed_at IS NOT NULL",
  ).all<{ customer_id: string }>();
  for (const { customer_id: id } of rows.results ?? []) {
    try {
      await writeHideRules(env, id);
      out.written.push(id);
    } catch (e) {
      out.failed.push(id);
      console.error(
        `[generation/hide-rules] sweep ${id}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// POST /admin/onboard/detect
// ---------------------------------------------------------------------------

interface DetectBody {
  customer_id: string;
  source_url: string;
  /** Optional explicit path; defaults to the source_url's pathname (A1). */
  page_path?: string;
}

export async function handleOnboardDetect(
  request: Request,
  env: OnboardEnv,
  user: SessionUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }

  const params = body as Partial<DetectBody>;
  if (!params.customer_id || typeof params.customer_id !== "string") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  if (!params.source_url || typeof params.source_url !== "string") {
    return jsonWithCors({ error: "source_url is required" }, env, 400);
  }

  const scope = requireCustomerScope(user, params.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  // Validate URL format early (fetchPageHtml also validates, but give a nicer error here).
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.source_url);
  } catch {
    return jsonWithCors({ error: "source_url is not a valid URL" }, env, 400);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return jsonWithCors({ error: "source_url must use http or https" }, env, 400);
  }

  // A page whose address names one account is never added (event-paths.md
  // §8, condition 3), read before the path is lowercased.
  const detectRefusal = pagePathRefusal(params.page_path) ?? pagePathRefusal(parsedUrl.pathname);
  if (detectRefusal) return jsonWithCors({ error: detectRefusal }, env, 400);

  // A sensitive customer adds only `/` and its kept sections (condition 2).
  const detectKept = await sensitivePageRefusal(
    env.DB,
    params.customer_id,
    resolvePagePath(params.page_path, params.source_url),
  );
  if (detectKept) return jsonWithCors(detectKept, env, 409);

  // Verify the customer exists.
  const customerRow = await env.DB.prepare("SELECT id, domain FROM customers WHERE id = ?")
    .bind(params.customer_id)
    .first<{ id: string; domain?: string | null }>();

  if (!customerRow) {
    return jsonWithCors({ error: "Customer not found" }, env, 404);
  }
  // Only the customer's recorded host is read (www and the apex are one
  // site); a redirect to another host is never followed (the /bot page).
  const recordedHost =
    typeof customerRow.domain === "string" && customerRow.domain.trim() !== ""
      ? siteHost(customerRow.domain)
      : parsedUrl.hostname;

  // Rendered-DOM capture beats fetch (element-detection-v2): if the operator
  // captured this page from their browser, that HTML is the real rendered DOM
  // (CSR-safe): use it and burn it. Otherwise fetch as before.
  const earlyPagePath = resolvePagePath(params.page_path, params.source_url);
  const capturedHtml = await env.VARIANTS.get(captureKey(params.customer_id, earlyPagePath));

  let html: string;
  let htmlSource: "capture" | "fetch" = "fetch";
  if (capturedHtml !== null) {
    html = capturedHtml;
    htmlSource = "capture";
    // Single-use: a stale capture must not silently shadow future re-detects.
    await env.VARIANTS.delete(captureKey(params.customer_id, earlyPagePath));
  } else {
    if (!sameSite(parsedUrl.hostname, recordedHost)) {
      return jsonWithCors(
        { error: `source_url must be on the customer's site (${recordedHost})` },
        env,
        400,
      );
    }
    try {
      // A shell is rendered with Browser Run (docs/specs/install-friction.md A).
      html = (
        await renderIfShell(
          await fetchPageHtml(params.source_url, {
            sameHostAs: recordedHost,
            userAgent: fetcherUserAgent(env),
          }),
          params.source_url,
          env,
        )
      ).html;
    } catch (e) {
      if (e instanceof OffHostRedirectError) {
        return jsonWithCors({ error: "off_host", reason: OFF_HOST_LINE }, env, 502);
      }
      const isDev = env.ENVIRONMENT === "development";
      const msg = e instanceof Error ? e.message : "fetch failed";
      return jsonWithCors(
        isDev
          ? { error: "Failed to fetch source URL", detail: msg }
          : { error: "Failed to fetch source URL" },
        env,
        502,
      );
    }
  }

  // Run AI detection.
  let detectResult: Awaited<ReturnType<typeof detectElements>>;
  try {
    detectResult = await detectElements(html, env);
  } catch (e) {
    const isDev = env.ENVIRONMENT === "development";
    const msg = e instanceof Error ? e.message : "detection failed";
    // Log the failure reason (privacy-safe: the model's or the parser's error
    // text only, never the page HTML or URL). Without this a production 500,
    // an exhausted credit balance for one, is undiagnosable from the tail.
    console.error(`[rawuser/onboard] detection failed customer=${params.customer_id}: ${msg}`);
    return jsonWithCors(
      isDev
        ? { error: "Element detection failed", detail: msg }
        : { error: "Element detection failed" },
      env,
      500,
    );
  }

  const pagePath = resolvePagePath(params.page_path, params.source_url);
  const generatedAt = await storeUnconfirmedManifest(env.DB, {
    customer_id: params.customer_id,
    page_path: pagePath,
    manifest: detectResult.manifest,
    source_url: params.source_url,
    cost_usd: detectResult.cost_usd,
  });

  const response: ManifestResponse = {
    customer_id: params.customer_id,
    page_path: pagePath,
    manifest: detectResult.manifest,
    source_url: params.source_url,
    generated_at: generatedAt,
    confirmed_at: null,
    cost_usd: detectResult.cost_usd,
    status: "unconfirmed",
    // T1c: replay every detected CSS selector against the same HTML the
    // model saw, so the operator reviews with warnings instead of blind.
    selector_health: validateSelectors(html, detectResult.manifest),
    html_source: htmlSource,
  };

  return jsonWithCors(response, env, 200);
}

// ---------------------------------------------------------------------------
// POST /admin/onboard/confirm
// ---------------------------------------------------------------------------

interface ConfirmBody {
  customer_id: string;
  /** Optional path to confirm; defaults to '/' (A1). */
  page_path?: string;
}

export async function handleOnboardConfirm(
  request: Request,
  env: OnboardEnv,
  user: SessionUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }

  const params = body as Partial<ConfirmBody>;
  if (!params.customer_id || typeof params.customer_id !== "string") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }

  const scope = requireCustomerScope(user, params.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  const confirmRefusal = pagePathRefusal(params.page_path);
  if (confirmRefusal) return jsonWithCors({ error: confirmRefusal }, env, 400);

  const confirmedAt = Date.now();
  const pagePath = normalizePath(params.page_path);

  // A sensitive customer confirms only `/` and its kept sections (condition 2).
  const confirmKept = await sensitivePageRefusal(env.DB, params.customer_id, pagePath);
  if (confirmKept) return jsonWithCors(confirmKept, env, 409);

  const result = await env.DB.prepare(
    "UPDATE element_manifests SET confirmed_at = ? WHERE customer_id = ? AND page_path = ?",
  )
    .bind(confirmedAt, params.customer_id, pagePath)
    .run();

  // A confirmed manifest changes what generation should write for this page
  // (which sections exist, how long each is). Versions written before it can
  // carry sections the page cannot host, which the snippet then skips whole
  // (observed on a pilot site, 2026-09-11). Mark them stale so the dashboard
  // asks for a rewrite instead of serving copy the page cannot show. KV
  // bodies stay in place, so live visitors are not affected until then.
  // The variants table has no page_path column; the page lives in the key
  // (root: v1:variant:{cid}:{intent}:{source}, path: v1:variant:{cid}:p:{enc}:…).
  const rootPrefix = `v1:variant:${params.customer_id}:`;
  // A body waiting for the customer's OK is dropped with its cell
  // (docs/specs/versions-approval.md).
  if (pagePath === "/") {
    await markVersionsStale(
      env.DB,
      params.customer_id,
      " AND kv_key LIKE ? AND kv_key NOT LIKE ?",
      [`${rootPrefix}%`, `${rootPrefix}p:%`],
    );
  } else {
    await markVersionsStale(env.DB, params.customer_id, " AND kv_key LIKE ?", [
      `${rootPrefix}p:${encodeURIComponent(pagePath)}:%`,
    ]);
  }

  await writeHideRules(env, params.customer_id);
  await writeLangMap(env, params.customer_id);

  // D1 run() doesn't give us rows_affected in a cross-platform way; fetch the row to verify.
  const row = await env.DB.prepare(
    "SELECT customer_id, page_path, manifest, source_url, generated_at, confirmed_at, cost_usd FROM element_manifests WHERE customer_id = ? AND page_path = ?",
  )
    .bind(params.customer_id, pagePath)
    .first<ManifestRow>();

  if (!row) {
    // The UPDATE matched nothing: no manifest exists yet for this path.
    return jsonWithCors(
      { error: "No manifest found for this path. Run /admin/onboard/detect first" },
      env,
      404,
    );
  }

  // Satisfy TypeScript that result was used
  void result;

  return jsonWithCors(rowToResponse(row), env, 200);
}

// ---------------------------------------------------------------------------
// GET /admin/onboard/manifest?customer_id=X
// ---------------------------------------------------------------------------

export async function handleOnboardManifest(
  request: Request,
  env: OnboardEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  if (!customerId) {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }

  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  // `?all=true` → return every path's manifest as an array (A1; the
  // multi-path onboard UI lists these). Otherwise return the single
  // page_path-specific row (default '/'), preserving the original
  // single-object response shape for existing callers.
  if (url.searchParams.get("all") === "true") {
    const result = await env.DB.prepare(
      `SELECT customer_id, page_path, manifest, source_url, generated_at, confirmed_at, cost_usd
       FROM element_manifests WHERE customer_id = ?
       ORDER BY (page_path = '/') DESC, page_path ASC`,
    )
      .bind(customerId)
      .all<ManifestRow>();
    const rows = (result.results ?? []).map(rowToResponse);
    const counted = await loadCountedTargets(env.DB, customerId);
    for (const r of rows) r.buttons = buttonsOf(r.manifest, r.page_path, counted);
    // Parts the live page no longer has, from the last live read (0027).
    try {
      const health = await env.DB.prepare(
        "SELECT page_path, missing, checked_at FROM manifest_health WHERE customer_id = ?",
      )
        .bind(customerId)
        .all<{ page_path: string; missing: string; checked_at: number }>();
      const byPath = new Map(
        (health.results ?? []).map((h) => [
          h.page_path,
          { missing: JSON.parse(h.missing) as string[], checked_at: h.checked_at },
        ]),
      );
      for (const r of rows as unknown as Array<Record<string, unknown>>) {
        const h = byPath.get(String(r.page_path));
        if (h && h.missing.length > 0) {
          r.missing_parts = h.missing;
          r.health_checked_at = h.checked_at;
        }
      }
    } catch {
      // a missing table before the migration: the list still answers
    }
    return jsonWithCors({ manifests: rows }, env, 200);
  }

  const pagePath = normalizePath(url.searchParams.get("page_path"));
  const row = await env.DB.prepare(
    "SELECT customer_id, page_path, manifest, source_url, generated_at, confirmed_at, cost_usd FROM element_manifests WHERE customer_id = ? AND page_path = ?",
  )
    .bind(customerId, pagePath)
    .first<ManifestRow>();

  if (!row) {
    return jsonWithCors({ error: "No manifest found for this path" }, env, 404);
  }

  const answer = rowToResponse(row);
  answer.buttons = buttonsOf(
    answer.manifest,
    answer.page_path,
    await loadCountedTargets(env.DB, customerId),
  );
  return jsonWithCors(answer, env, 200);
}

// ---------------------------------------------------------------------------
// POST /admin/onboard/capture-token: mint a one-time capture token
// ---------------------------------------------------------------------------

interface CaptureTokenBody {
  customer_id: string;
  source_url: string;
}

export async function handleCaptureToken(
  request: Request,
  env: OnboardEnv,
  user: SessionUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }

  const params = body as Partial<CaptureTokenBody>;
  if (!params.customer_id || typeof params.customer_id !== "string") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  if (!params.source_url || typeof params.source_url !== "string") {
    return jsonWithCors({ error: "source_url is required" }, env, 400);
  }

  const scope = requireCustomerScope(user, params.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  let pagePath: string;
  try {
    const raw = new URL(params.source_url).pathname;
    // Add this page: an address that names one account is refused before
    // any link is minted (event-paths.md §8, condition 3).
    const refusal = pagePathRefusal(raw);
    if (refusal) return jsonWithCors({ error: refusal }, env, 400);
    pagePath = normalizePath(raw);
  } catch {
    return jsonWithCors({ error: "source_url is not a valid URL" }, env, 400);
  }

  // Add this page, for a sensitive customer: only `/` and its kept sections
  // (condition 2), refused before any link is minted.
  const captureKept = await sensitivePageRefusal(env.DB, params.customer_id, pagePath);
  if (captureKept) return jsonWithCors(captureKept, env, 409);
  // No capture link while the tag is withheld (readiness-check.md, the
  // the privacy review's condition 2): the question comes before the tag.
  const withheld = await tagWithheldRefusal(env.DB, params.customer_id);
  if (withheld) return jsonWithCors(withheld, env, 409);

  const token = crypto.randomUUID().replace(/-/g, "");
  await env.VARIANTS.put(
    captureTokenKey(token),
    JSON.stringify({ customer_id: params.customer_id, page_path: pagePath }),
    { expirationTtl: CAPTURE_TTL_S },
  );

  return jsonWithCors({ token, page_path: pagePath, expires_in_s: CAPTURE_TTL_S }, env, 200);
}

// ---------------------------------------------------------------------------
// GET /admin/onboard/capture-status?customer_id=X&page_path=Y
// ---------------------------------------------------------------------------

export async function handleCaptureStatus(
  request: Request,
  env: OnboardEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  if (!customerId) {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }

  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  const pagePath = normalizePath(url.searchParams.get("page_path"));
  const captured = (await env.VARIANTS.get(captureKey(customerId, pagePath))) !== null;
  return jsonWithCors({ captured, page_path: pagePath }, env, 200);
}

// ---------------------------------------------------------------------------
// PUBLIC POST /onboard/capture: receive the rendered DOM from the
// operator's browser (bookmarklet). Token-gated, CORS *, single-use.
// Routed from index.ts (no session auth: the token IS the auth).
// ---------------------------------------------------------------------------

const CAPTURE_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function captureJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CAPTURE_CORS_HEADERS },
  });
}

export async function handlePublicCapture(request: Request, env: OnboardEnv): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CAPTURE_CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return captureJson({ error: "POST only" }, 405);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return captureJson({ error: "Invalid JSON body" }, 400);
  }

  const outcome = await receiveCapture(body, env.VARIANTS);
  return captureJson(outcome.body, outcome.status);
}
