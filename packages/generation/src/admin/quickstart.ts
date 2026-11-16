/**
 * Script-first onboarding (docs/specs/script-first-onboarding.md).
 *
 *   POST /admin/onboard/quickstart  { customer_id, page_path? }
 *     Reads the operator's rendered-DOM capture (single use), then in one
 *     pass: page language → KV, element detection → unconfirmed manifest,
 *     brief draft from the page → business_dna with draft = 1, one preview
 *     version under a preview key (never a live key). Returns before/after
 *     hero texts, the draft, the uncertain selectors and the language, and
 *     keeps the result in KV for 24 hours so the confirm screen survives a
 *     refresh.
 *
 *   GET  /admin/onboard/quickstart?customer_id=X&page_path=Y
 *     The stored result, or 404.
 *
 *   POST /admin/onboard/go-live  { customer_id, page_path, dna, manifest?, count?, test? }
 *     Confirms the manifest (with the operator's selector edits), writes the
 *     brief with draft = 0, promotes the preview to its live key with a
 *     variants row, writes the counted button and, on an explicit
 *     `test: true` at a true first go live, starts a 20% test
 *     (docs/specs/measure-at-go-live.md), stamps live_at. The dashboard then
 *     writes the other versions through the existing regenerate loop.
 *
 * Privacy: every call is operator-authenticated and scoped; the input is
 * the operator's own public page; nothing here runs in the visitor path.
 */

import type {
  BusinessDNA,
  DnaSuggestions,
  IntentDim,
  Manifest,
  MeasureProposal,
  SiteLanguage,
  VariantBody,
} from "@rawuser/shared";
import {
  type SitePathRow,
  captureKey,
  discoverLanguages,
  normalizePath,
  pagePathRefusal,
  ruleKind,
  siteEntryFor,
  sitePathMap,
  variantKeyForPath,
} from "@rawuser/shared";
import { siteOrigin } from "@rawuser/shared";
import { addAuditSpend, auditGate, capBody, pagesFull } from "../audit/caps.ts";
import { cleanHtml, detectElements, fetchPageHtml } from "../detect-elements.ts";
import { suggestDnaFromHtml } from "../dna-suggest.ts";
import { attachInlineShapes, markEmphasis } from "../inline-shape-html.ts";
import { fetcherUserAgent } from "../install-config.ts";
import { refreshKeywordLexicon } from "../keywords/lexicon.ts";
import {
  type ButtonRow,
  buttonsOf,
  carryRewrite,
  loadCountedTargets,
  unwrittenButtons,
} from "../lib/button-rewrite.ts";
import { sameAddressLanguages } from "../lib/language-switch.ts";
import { type PageKindOf, onceSelectors } from "../lib/measure-proposal.ts";
import { modelFailure } from "../lib/model-failure.ts";
import { OFF_HOST_LINE, OffHostRedirectError, siteHost } from "../lib/public-url.ts";
import { publishVersion } from "../lib/publish-version.ts";
import { type RenderBudget, renderIfShell } from "../lib/read-page.ts";
import { loadSensitive, pageRefusalUnder, sensitiveTargetRefusal } from "../lib/sensitive-guard.ts";
import { recordFirstSet } from "../lib/version-approval.ts";
import type { VariantProvenance } from "../orchestrator.ts";
import { regenerateOne } from "../orchestrator.ts";
import { rememberPageLinks } from "../page-links.ts";
import type { SelectorHealth } from "../selector-health.ts";
import { validateSelectors } from "../selector-health.ts";
import { LINK_KINDS_SQL } from "../site-map/link-kinds.ts";
import { type SitePage, runSiteRead } from "../site-map/run.ts";
import { loadServedIntents } from "../site-map/served-load.ts";
import { loadApplicationBrief, mergeApplicationBrief } from "./apply.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import { suggestCacheKey } from "./dna-suggest.ts";
import {
  type MeasureGoes,
  type MeasureSelectors,
  goLiveMeasure,
  measureGoesOf,
  measureProposal,
} from "./go-live-measure.ts";
import type { AdminEnv } from "./handlers.ts";
import { upsertBusinessDna } from "./handlers.ts";
import {
  storeUnconfirmedManifest,
  storedManifestOf,
  writeHideRules,
  writeLangMap,
} from "./onboard.ts";
import { goLiveRefusal as specialCategoryRefusal } from "./readiness.ts";
import { requireCustomerScope } from "./scope.ts";

/** The version shown as "after": a visitor weighing their options. */
export const PREVIEW_INTENT: IntentDim = "evaluation";
export const PREVIEW_SOURCE = "default";
const RECORD_TTL_S = 24 * 60 * 60;

export function quickstartKey(customerId: string, pagePath: string): string {
  return `v1:quickstart:${customerId}:${pagePath}`;
}

export function previewKey(customerId: string, pagePath: string): string {
  return `v1:preview:${customerId}:${pagePath}:${PREVIEW_INTENT}:${PREVIEW_SOURCE}`;
}

export interface HeroTexts {
  headline: string | null;
  body: string | null;
  cta: string | null;
}

export interface QuickstartRecord {
  customer_id: string;
  page_path: string;
  source_url: string;
  generated_at: number;
  language: string;
  /** Where the language came from, so the confirm screen can say. */
  language_source: "html-lang" | "page-read" | "fallback";
  current: HeroTexts;
  preview: HeroTexts | null;
  preview_error: string | null;
  brief: BusinessDNA;
  /** Brief fields the page did not answer; the confirm screen asks for them. */
  brief_gaps: string[];
  manifest: Manifest;
  selector_health: SelectorHealth;
  /** Dot-paths whose selectors did not match exactly once. */
  uncertain_paths: string[];
  cost_usd: number;
  provenance: VariantProvenance | null;
  /** Where the HTML came from: the operator's capture or a server fetch. */
  html_source?: "capture" | "fetch";
  /** Every language the site publishes, read from the page (docs/specs/per-language.md). */
  languages: LanguagePage[];
  /**
   * Languages the site also has on the same address, found through its
   * language switch. Kept apart from `languages`, which lists pages that can
   * be ticked and written: nothing is written for these. Absent on records
   * from before 2026-10-12 and on an extra page.
   */
  same_address?: SameAddressLanguage[];
  /**
   * The button to count (docs/specs/measure-at-go-live.md §4, §12). Null
   * for an extra page after go live. Absent on records from before.
   */
  measure?: MeasureProposal | null;
  /**
   * For go live only: per page path and count slot, the CSS selectors that
   * matched exactly once on that page when it was read. Not for display.
   */
  measure_selectors?: MeasureSelectors;
  /**
   * For go live and the readiness check: per page path and count slot,
   * where the button goes as a closed word (`conversion_targets.goes`).
   * Never a link. Not for display. Absent on records from before.
   */
  measure_goes?: MeasureGoes;
  /**
   * The primary page shows a phone, email, WhatsApp or Telegram link (the
   * readiness check's hint, check 2). Absent on records from before.
   */
  measure_contact_link?: boolean;
}

/** One language of the site, as discovered and prepared by the chain. */
export interface LanguagePage extends SiteLanguage {
  /** "primary" is the page the operator opened; others were fetched by URL. */
  status: "primary" | "ready" | "unreachable";
  /** Elements found on that language's page. */
  parts: number;
  /** A brief in that language was drafted from its own page. */
  brief_drafted: boolean;
  /** The customer's consent: versions are written for enabled languages. */
  enabled: boolean;
}

/**
 * A language the site serves on the same address as another one
 * (docs/specs/per-language.md, "A language on the same address"): found
 * through the site's language switch (`/language/en`, `?lang=en`, a select
 * of locales), it has no path of its own. It is recorded so the Look screen
 * can say it exists; nothing is read, written or served for it. Never
 * enabled: go live skips it, and neither the path to language map nor
 * generation reads this list (both read the confirmed manifests).
 */
export interface SameAddressLanguage {
  lang: string;
  /** No path of its own: the site's session decides, the address stays. */
  path: null;
  source: "switch";
  status: "same_address";
  parts: 0;
  brief_drafted: false;
  enabled: false;
}

/** An entry of the customer's `languages` JSON. */
export type StoredLanguage = LanguagePage | SameAddressLanguage;

/** True for an entry that has no page of its own to confirm, write or map. */
export function isSameAddress(l: StoredLanguage): l is SameAddressLanguage {
  return l.status === "same_address" || l.path === null;
}

/** At most this many secondary languages are read in one quickstart. */
const MAX_SECONDARY_LANGUAGES = 5;
/** Renders a chain may spend on the other languages' pages (docs/specs/install-friction.md A). */
const MAX_SECONDARY_RENDERS = 2;

async function upsertI18nBrief(
  env: AdminEnv,
  customerId: string,
  language: string,
  brief: BusinessDNA,
  draft: boolean,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO business_dna_i18n
       (customer_id, language, product, icp, value_props, differentiators, proof_points,
        brand_voice, target_market, draft, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(customer_id, language) DO UPDATE SET
       product = excluded.product, icp = excluded.icp, value_props = excluded.value_props,
       differentiators = excluded.differentiators, proof_points = excluded.proof_points,
       brand_voice = excluded.brand_voice, target_market = excluded.target_market,
       draft = excluded.draft, updated_at = excluded.updated_at`,
  )
    .bind(
      customerId,
      language,
      brief.product,
      brief.icp,
      JSON.stringify(brief.value_props),
      JSON.stringify(brief.differentiators),
      JSON.stringify(brief.proof_points),
      brief.brand_voice,
      brief.target_market || null,
      draft ? 1 : 0,
      Date.now(),
    )
    .run();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `<html lang="az-Latn">` → "az"; null when absent. */
export function htmlLang(html: string): string | null {
  const m = /<html\b[^>]*\blang\s*=\s*["']?\s*([A-Za-z]{2,3})(?:[-_][A-Za-z0-9]+)*\s*["']?/i.exec(
    html,
  );
  return m?.[1] ? m[1].toLowerCase() : null;
}

function metaDescription(html: string): string | null {
  const m =
    /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*["']([^"']{10,300})["']/i.exec(
      html,
    ) ??
    /<meta\b[^>]*\bcontent\s*=\s*["']([^"']{10,300})["'][^>]*\bname\s*=\s*["']description["']/i.exec(
      html,
    );
  return m?.[1]?.trim() ?? null;
}

function pageTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]{3,200})<\/title>/i.exec(html);
  return m?.[1]?.trim() ?? null;
}

/** The page's own hero words, from the manifest's text signatures. */
export function currentHero(manifest: Manifest): HeroTexts {
  const first = (path: string) =>
    markEmphasis(manifest[path]?.text[0] ?? null, manifest[path]?.inline?.emphasis_phrase);
  return {
    headline: first("hero.headline"),
    body: first("hero.body"),
    cta: first("hero.cta.label"),
  };
}

/**
 * The hero as a visitor of the preview version sees it: the version's words,
 * and the page's own (`current`) for a part the version leaves as built: a
 * button that is not rewritten (lib/button-rewrite.ts), a part that did not
 * fit (docs/specs/refused-versions.md). Without `current` a part the version
 * does not write is null, as before.
 */
export function previewHero(body: VariantBody, current?: HeroTexts): HeroTexts {
  const hero = body.sections.hero;
  return {
    headline: hero?.headline ?? current?.headline ?? null,
    body: hero?.body ?? current?.body ?? null,
    cta: hero?.cta?.label ?? current?.cta ?? null,
  };
}

/** Dot-paths with health data and no selector that matched exactly once. */
export function uncertainPaths(health: SelectorHealth): string[] {
  return Object.entries(health)
    .filter(([, checks]) => {
      if (checks.length === 0) return false;
      if (checks.some((c) => c.status === "ok")) return false;
      if (checks.every((c) => c.status === "unsupported")) return false;
      return true;
    })
    .map(([path]) => path);
}

/**
 * A brief from the page's own words. Fields the page did not answer get a
 * neutral placeholder and are listed in `gaps` so the operator fills them
 * on the confirm screen; nothing invented reaches generation unlabelled.
 */
export function draftBrief(
  customerId: string,
  domain: string,
  language: string,
  suggestions: DnaSuggestions | null,
  html: string,
): { brief: BusinessDNA; gaps: string[] } {
  const gaps: string[] = [];
  const product = suggestions?.product ?? metaDescription(html) ?? pageTitle(html);
  if (!product) gaps.push("product");
  const icp = suggestions?.icp;
  if (!icp) gaps.push("icp");
  const valueProps = (suggestions?.value_props ?? []).map((v) => v.text);
  if (valueProps.length === 0) gaps.push("value_props");
  const brief: BusinessDNA = {
    customer_id: customerId,
    product: product ?? `What ${domain} offers`,
    icp: icp ?? `People who come to ${domain} to decide whether it is for them`,
    value_props: valueProps.length > 0 ? valueProps : [`What ${domain} says on its home page`],
    differentiators: (suggestions?.differentiators ?? []).map((v) => v.text),
    proof_points: (suggestions?.proof_points ?? []).map((v) => v.text),
    brand_voice: suggestions?.brand_voice ?? "",
    target_market: suggestions?.target_market ?? "",
    target_language: language,
    per_intent_hints: {},
    updated_at: Date.now(),
  };
  return { brief, gaps };
}

/**
 * The customer's finished brief, or null while it is still a draft or
 * missing. An extra page read after go-live reuses it (first-run.md §6).
 */
async function loadFinishedBrief(env: AdminEnv, customerId: string): Promise<BusinessDNA | null> {
  const row = await env.DB.prepare(
    `SELECT customer_id, product, icp, brand_voice, value_props, differentiators,
            proof_points, target_market, target_language, per_intent_hints
     FROM business_dna WHERE customer_id = ? AND draft = 0`,
  )
    .bind(customerId)
    .first<Record<string, string>>();
  if (!row) return null;
  try {
    return {
      customer_id: row.customer_id,
      product: row.product,
      icp: row.icp,
      brand_voice: row.brand_voice,
      value_props: JSON.parse(row.value_props ?? "[]") as string[],
      differentiators: JSON.parse(row.differentiators ?? "[]") as string[],
      proof_points: JSON.parse(row.proof_points ?? "[]") as string[],
      target_market: row.target_market,
      target_language: row.target_language,
      per_intent_hints: JSON.parse(row.per_intent_hints ?? "{}") as BusinessDNA["per_intent_hints"],
    } as BusinessDNA;
  } catch {
    return null;
  }
}

/**
 * The kind of a page of the customer's own site, for where a button goes
 * (readiness-check.md, check 2): the site map's stored rows first (the rules'
 * and the operator's, never the model's, as the lint reads them), then the
 * same rules on the path and the link's text, since at the first quickstart
 * the map is written after the proposal. Only a kind leaves.
 */
async function pageKindLookup(
  db: D1Database,
  customerId: string,
  lang: string | null,
): Promise<PageKindOf> {
  let rows: SitePathRow[] = [];
  try {
    const r = await db.prepare(LINK_KINDS_SQL).bind(customerId).all<SitePathRow>();
    rows = (r.results ?? []).filter((x) => typeof x?.path === "string" && x.confidence !== "model");
  } catch {
    rows = [];
  }
  const pm = sitePathMap(rows);
  return (path, text) => {
    const stored = siteEntryFor(pm, normalizePath(path));
    if (stored) return stored.kind;
    return ruleKind({ path, text, lang }).kind;
  };
}

async function loadCustomer(
  env: AdminEnv,
  customerId: string,
): Promise<{ id: string; domain: string } | null> {
  const row = await env.DB.prepare("SELECT id, domain FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ id: string; domain: string }>();
  if (!row) return null;
  return {
    id: row.id,
    domain: row.domain
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, ""),
  };
}

// ---------------------------------------------------------------------------
// POST /admin/onboard/quickstart
// ---------------------------------------------------------------------------

interface QuickstartBody {
  customer_id: string;
  page_path?: string;
  /** Read the page from its URL when no capture is waiting (re-runs). */
  allow_fetch?: boolean;
}

export async function handleQuickstart(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  const params = body as Partial<QuickstartBody>;
  if (!params.customer_id || typeof params.customer_id !== "string") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const scope = requireCustomerScope(user, params.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  const refusal = pagePathRefusal(params.page_path);
  if (refusal) return jsonWithCors({ error: refusal }, env, 400);

  const customer = await loadCustomer(env, params.customer_id);
  if (!customer) return jsonWithCors({ error: "Customer not found" }, env, 404);

  const pagePath = normalizePath(params.page_path);
  const sourceUrl = `${siteOrigin(customer.domain)}${pagePath === "/" ? "/" : pagePath}`;

  // A sensitive customer reads only `/` and its kept sections
  // (docs/specs/sensitive-customers.md, condition 2), before anything is
  // read or spent.
  const sensitive = await loadSensitive(env.DB, customer.id);
  const kept = pageRefusalUnder(sensitive, pagePath);
  if (kept) return jsonWithCors(kept, env, 409);

  // The audit's caps (docs/specs/ai-traffic-audit.md §9): nothing after the
  // end, nothing past the spend, no fourth page.
  const gate = await auditGate(env.DB, customer.id);
  if (gate.ended) return jsonWithCors(capBody("audit_ended"), env, 409);
  if (gate.audit && gate.left <= 0) return jsonWithCors(capBody("audit_spend"), env, 409);
  if (await pagesFull(env.DB, gate, customer.id, pagePath)) {
    return jsonWithCors(capBody("audit_pages_full"), env, 409);
  }

  // 1. The capture, read once and deleted (the same delete-on-use rule as
  //    /detect). Without one, and only when the caller says so, read the
  //    page from its URL (server-rendered sites; "Read the page again").
  const key = captureKey(customer.id, pagePath);
  let html = await env.VARIANTS.get(key);
  let htmlSource: "capture" | "fetch" = "capture";
  if (html !== null) {
    await env.VARIANTS.delete(key);
  } else if (params.allow_fetch === true) {
    try {
      // A page built in the browser sends a shell: Browser Run reads it
      // (docs/specs/install-friction.md A). A server-rendered page costs
      // nothing new; a failed render leaves the shell, as before.
      // Only the customer's recorded host: a redirect to another host is
      // never followed and comes back as its own line (the /bot page).
      const read = await renderIfShell(
        await fetchPageHtml(sourceUrl, {
          sameHostAs: customer.domain,
          userAgent: fetcherUserAgent(env),
        }),
        sourceUrl,
        env,
      );
      html = read.html;
      htmlSource = "fetch";
    } catch (e) {
      if (e instanceof OffHostRedirectError) {
        return jsonWithCors({ error: "off_host", reason: OFF_HOST_LINE }, env, 502);
      }
      return jsonWithCors({ error: "fetch_failed" }, env, 502);
    }
  } else {
    return jsonWithCors({ error: "no_capture" }, env, 409);
  }

  const isDev = env.ENVIRONMENT === "development";
  let costUsd = 0;

  // 2. Elements.
  let manifest: Manifest;
  try {
    const detected = await detectElements(html, env);
    manifest = detected.manifest;
    costUsd += detected.cost_usd;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "detection failed";
    console.error(`[rawuser/quickstart] detection failed customer=${customer.id}: ${msg}`);
    // Whoever runs the install is told which kind of model fault it was, so
    // they can fix a setting; a customer is told only that the read failed.
    const reason = user.role === "superadmin" ? modelFailure(msg) : null;
    return jsonWithCors(
      {
        error: "Element detection failed",
        ...(reason ? { reason } : {}),
        ...(isDev ? { detail: msg } : {}),
      },
      env,
      500,
    );
  }
  // What the rewrite must keep per part (docs/specs/design-preserving-rewrite.md).
  manifest = attachInlineShapes(html, manifest);
  const health = validateSelectors(html, manifest);
  await storeUnconfirmedManifest(env.DB, {
    customer_id: customer.id,
    page_path: pagePath,
    manifest,
    source_url: sourceUrl,
    cost_usd: costUsd,
    language: htmlLang(html),
  });

  const declared = htmlLang(html);
  // An extra page after go-live (docs/specs/first-run.md §6): the finished
  // brief is reused, languages are not rediscovered, nothing on the
  // customers row moves. Only the page's elements and one preview are read.
  const finished = pagePath === "/" ? null : await loadFinishedBrief(env, customer.id);
  let suggestions: DnaSuggestions | null = null;
  let language: string;
  let languageSource: QuickstartRecord["language_source"];
  let brief: BusinessDNA;
  let gaps: string[] = [];
  const languages: LanguagePage[] = [];
  const sameAddress: SameAddressLanguage[] = [];
  let measure: MeasureProposal | null = null;
  const measureSelectors: MeasureSelectors = {};
  const measureGoes: MeasureGoes = {};
  let measureContactLink = false;
  // The site map (docs/specs/site-shaped-intents.md §4.1): the links of
  // every page this chain already holds, no new fetch for it.
  const sitePages: SitePage[] = [];
  if (finished) {
    language = declared ?? finished.target_language ?? "en";
    languageSource = declared ? "html-lang" : "fallback";
    brief = finished;
  } else {
    // 3. Brief draft from the page, in the page's declared language when it
    //    has one (a mixed-language page otherwise yields proof points in one
    //    language and copy in another, and the number-unit lint rejects the
    //    copy; seen on a pilot site, 2026-09-12). Non-fatal: the operator can type it.
    try {
      suggestions = await suggestDnaFromHtml(cleanHtml(html), sourceUrl, env, declared);
      await env.VARIANTS.put(suggestCacheKey(customer.id), JSON.stringify(suggestions), {
        expirationTtl: RECORD_TTL_S,
      });
    } catch {
      console.error("[rawuser/quickstart] brief draft failed (non-critical)");
    }

    // 4. Language: the page's own declaration first, the read second.
    language = declared ?? suggestions?.language ?? "en";
    languageSource = declared ? "html-lang" : suggestions?.language ? "page-read" : "fallback";

    const drafted = draftBrief(customer.id, customer.domain, language, suggestions, html);
    brief = drafted.brief;
    gaps = drafted.gaps;
    // A customer who came through the apply page (docs/specs/pilot-apply.md,
    // 2026-10-01) already wrote product, audience, difference and numbers;
    // the page read fills only what they left empty.
    const applied = await loadApplicationBrief(env, customer.id);
    if (applied) {
      const merged = mergeApplicationBrief(brief, gaps, applied);
      brief = merged.brief;
      gaps = merged.gaps;
    }
    await upsertBusinessDna(env, brief, { draft: true });

    // 4b. The site's other languages (docs/specs/per-language.md): read each
    //     one's own page by URL, detect its elements, draft its brief in its
    //     language. Told to the operator on the Look screen, written for at
    //     go-live. Server-rendered pages only; a page we cannot read is listed
    //     as unreachable, never guessed.
    const discovered = discoverLanguages(html, sourceUrl);
    const primaryEntry = discovered.find((d) => d.path === pagePath) ?? {
      lang: language,
      path: pagePath,
      source: "html-lang" as const,
    };
    languages.push({
      ...primaryEntry,
      lang: language,
      status: "primary",
      parts: Object.keys(manifest).length,
      brief_drafted: true,
      enabled: true,
    });
    // For a sensitive customer a language's page is read only when it is a
    // kept section (condition 2): any other is not read, listed or stored.
    const secondary = discovered
      .filter((d) => d.path !== pagePath && d.lang !== language)
      .filter((d) => pageRefusalUnder(sensitive, d.path) === null)
      .slice(0, MAX_SECONDARY_LANGUAGES);
    // At most two renders for the other languages' pages per chain (spec A).
    const renderBudget: RenderBudget = { left: MAX_SECONDARY_RENDERS };
    for (const page of secondary) {
      const pageUrl = `${siteOrigin(customer.domain)}${page.path}`;
      let pageHtml: string;
      try {
        pageHtml = (
          await renderIfShell(
            await fetchPageHtml(pageUrl, {
              sameHostAs: customer.domain,
              userAgent: fetcherUserAgent(env),
            }),
            pageUrl,
            env,
            { budget: renderBudget },
          )
        ).html;
      } catch {
        languages.push({
          ...page,
          status: "unreachable",
          parts: 0,
          brief_drafted: false,
          enabled: false,
        });
        continue;
      }
      let parts = 0;
      try {
        const detected = await detectElements(pageHtml, env);
        costUsd += detected.cost_usd;
        parts = Object.keys(detected.manifest).length;
        sitePages.push({
          pagePath: page.path,
          pageUrl,
          html: pageHtml,
          manifest: detected.manifest,
          lang: page.lang,
          source: "fetch",
        });
        measureSelectors[page.path] = onceSelectors(pageHtml, detected.manifest);
        await storeUnconfirmedManifest(env.DB, {
          customer_id: customer.id,
          page_path: page.path,
          manifest: detected.manifest,
          source_url: pageUrl,
          cost_usd: detected.cost_usd,
          language: page.lang,
        });
      } catch {
        languages.push({
          ...page,
          status: "unreachable",
          parts: 0,
          brief_drafted: false,
          enabled: false,
        });
        continue;
      }
      let briefDrafted = false;
      try {
        const pageSuggestions = await suggestDnaFromHtml(
          cleanHtml(pageHtml),
          pageUrl,
          env,
          page.lang,
        );
        const draft = draftBrief(
          customer.id,
          customer.domain,
          page.lang,
          pageSuggestions,
          pageHtml,
        );
        await upsertI18nBrief(env, customer.id, page.lang, draft.brief, true);
        briefDrafted = true;
      } catch {
        console.error("[rawuser/quickstart] secondary brief draft failed (non-critical)");
      }
      languages.push({
        ...page,
        status: "ready",
        parts,
        brief_drafted: briefDrafted,
        enabled: true,
      });
    }
    // A language on the same address (the first outside pilot, I1): the site's
    // switch does not change the path (`/language/en` sets the session and
    // returns), so the discovery above cannot see it. Recorded with no path,
    // never enabled; nothing is fetched or written for it.
    for (const lang of sameAddressLanguages(
      html,
      sourceUrl,
      language,
      discovered.map((d) => d.lang),
    )) {
      sameAddress.push({
        lang,
        path: null,
        source: "switch",
        status: "same_address",
        parts: 0,
        brief_drafted: false,
        enabled: false,
      });
    }
    const stored: StoredLanguage[] = [...languages, ...sameAddress];
    await env.DB.prepare("UPDATE customers SET languages = ? WHERE id = ?")
      .bind(JSON.stringify(stored), customer.id)
      .run();

    // 4c. The button to count (docs/specs/measure-at-go-live.md §4): from
    //     the capture in hand, no model call. The links it reads stay here.
    measureSelectors[pagePath] = onceSelectors(html, manifest);
    // Where each button goes (readiness-check.md, check 2): the site map's
    // kind for a same-site target, by the stored rows and the same rules,
    // resolved here so the record keeps the word and never the path.
    const kindOf = await pageKindLookup(env.DB, customer.id, language);
    const read = measureGoesOf(html, manifest, uncertainPaths(health), pagePath, {
      host: siteHost(customer.domain),
      kindOf,
    });
    measureGoes[pagePath] = read.goes;
    measureContactLink = read.contact_link;
    measure = await measureProposal(env.DB, {
      customerId: customer.id,
      pagePath,
      html,
      manifest,
      uncertain: uncertainPaths(health),
      languagePages: languages
        .filter((l) => l.status === "ready")
        .map((l) => ({ lang: l.lang, path: l.path })),
      selectors: measureSelectors,
      now: Date.now(),
    });
  }

  // 4d. The site's own links (site-shaped intents §4): rules, one model
  //     call for the rest, stored, the served set and the bundle. Runs
  //     beside the preview, never fatal, nothing when the map is off.
  sitePages.unshift({
    pagePath,
    pageUrl: sourceUrl,
    html,
    manifest,
    lang: language,
    source: htmlSource,
  });
  const siteRead = runSiteRead(env, customer.id, sitePages, { product: brief.product });

  // 5. One preview version, under a preview key only. Where each button
  //    goes is read from the page in hand first, for the lint's action check
  //    (page-links.ts): kept in this isolate, never stored. Before, a preview
  //    was written with no link at all (the first outside pilot, A1).
  rememberPageLinks(customer.id, pagePath, html, manifest);
  let preview: HeroTexts | null = null;
  let previewError: string | null = null;
  let provenance: VariantProvenance | null = null;
  const result = await regenerateOne(customer.id, PREVIEW_INTENT, PREVIEW_SOURCE, env, pagePath, {
    preview: {
      manifest,
      kvKey: previewKey(customer.id, pagePath),
      ttlSeconds: RECORD_TTL_S,
      language,
    },
  });
  costUsd += result.cost_usd;
  if (result.ok && result.body) {
    preview = previewHero(result.body, currentHero(manifest));
    provenance = result.provenance ?? null;
  } else {
    previewError = result.error ?? "preview failed";
  }
  costUsd += (await siteRead).cost_usd;
  if (gate.audit) await addAuditSpend(env, customer.id, costUsd);

  const record: QuickstartRecord = {
    customer_id: customer.id,
    page_path: pagePath,
    source_url: sourceUrl,
    generated_at: Date.now(),
    language,
    language_source: languageSource,
    current: currentHero(manifest),
    preview,
    preview_error: previewError,
    brief,
    brief_gaps: gaps,
    manifest,
    selector_health: health,
    uncertain_paths: uncertainPaths(health),
    cost_usd: costUsd,
    provenance,
    html_source: htmlSource,
    languages,
    same_address: sameAddress,
    measure,
    measure_selectors: measureSelectors,
    measure_goes: measureGoes,
    measure_contact_link: measureContactLink,
  };
  await env.VARIANTS.put(quickstartKey(customer.id, pagePath), JSON.stringify(record), {
    expirationTtl: RECORD_TTL_S,
  });
  if (!finished) {
    await env.DB.prepare(
      "UPDATE customers SET preview_seen_at = COALESCE(preview_seen_at, ?) WHERE id = ?",
    )
      .bind(record.generated_at, customer.id)
      .run();
  }

  return jsonWithCors(await withButtons(env, record), env, 200);
}

/** A button of the Look screen's list, with the proposal of the row above it. */
export interface QuickstartButton extends ButtonRow {
  /** The button the "button to count" row proposes (not counted until go live). */
  proposed: boolean;
}

/**
 * The record as the Look screen reads it: with `buttons`, each button of the
 * page with its switch as stored now (the record's own manifest is a
 * snapshot of the read; `POST /admin/onboard/button` writes the stored one),
 * whether its clicks are counted, and whether it is the proposed one.
 */
async function withButtons(
  env: AdminEnv,
  record: QuickstartRecord,
): Promise<QuickstartRecord & { buttons: QuickstartButton[] }> {
  const stored = await storedManifestOf(env.DB, record.customer_id, record.page_path);
  const proposed = record.measure?.proposal?.section_path ?? null;
  const buttons = buttonsOf(
    stored ?? record.manifest,
    record.page_path,
    await loadCountedTargets(env.DB, record.customer_id),
  ).map((b) => ({ ...b, proposed: b.path === proposed }));
  return { ...record, buttons };
}

// ---------------------------------------------------------------------------
// GET /admin/onboard/quickstart?customer_id=X&page_path=Y
// ---------------------------------------------------------------------------

export async function handleQuickstartGet(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const pagePath = normalizePath(url.searchParams.get("page_path"));
  const raw = await env.VARIANTS.get(quickstartKey(customerId, pagePath));
  if (raw === null) return jsonWithCors({ error: "No quickstart result for this path" }, env, 404);
  return jsonWithCors(await withButtons(env, JSON.parse(raw) as QuickstartRecord), env, 200);
}

// ---------------------------------------------------------------------------
// POST /admin/onboard/go-live
// ---------------------------------------------------------------------------

interface GoLiveBody {
  customer_id: string;
  page_path?: string;
  dna: Partial<BusinessDNA>;
  /** The manifest with the operator's selector edits; omitted = as detected. */
  manifest?: Manifest;
  /** Languages the customer agreed to (primary subtags); omitted = every ready one. */
  languages?: string[];
  /** The button to count (docs/specs/measure-at-go-live.md §12); null or omitted: none. */
  count?: { section_path?: unknown } | null;
  /** Only `true` starts a test; omitted means no test. */
  test?: unknown;
}

export async function handleGoLive(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  const params = body as Partial<GoLiveBody>;
  if (!params.customer_id || typeof params.customer_id !== "string") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const scope = requireCustomerScope(user, params.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  const dna = params.dna;
  if (!dna || typeof dna !== "object") return jsonWithCors({ error: "dna is required" }, env, 400);
  if (typeof dna.product !== "string" || dna.product.trim() === "") {
    return jsonWithCors({ error: "product is required" }, env, 400);
  }
  if (typeof dna.icp !== "string" || dna.icp.trim() === "") {
    return jsonWithCors({ error: "icp is required" }, env, 400);
  }
  if (!Array.isArray(dna.value_props) || dna.value_props.length < 1) {
    return jsonWithCors({ error: "at least one value_prop is required" }, env, 400);
  }

  const goLiveRefusal = pagePathRefusal(params.page_path);
  if (goLiveRefusal) return jsonWithCors({ error: goLiveRefusal }, env, 400);

  const customerId = params.customer_id;
  const pagePath = normalizePath(params.page_path);
  const now = Date.now();
  // The readiness check's one stop (docs/specs/readiness-check.md, "What
  // blocks go live"): a special-category yes nobody has marked. The same
  // check the list runs, answered before anything is written.
  const blocked = await specialCategoryRefusal(env.DB, customerId);
  if (blocked) return jsonWithCors(blocked, env, 409);
  // A sensitive customer goes live only with `/` and its kept sections, and
  // counts a picked button only there (docs/specs/sensitive-customers.md,
  // condition 2). Refused before anything is written.
  const sensitive = await loadSensitive(env.DB, customerId);
  const goLiveKept =
    pageRefusalUnder(sensitive, pagePath) ??
    (await sensitiveTargetRefusal(
      env.DB,
      customerId,
      params.count &&
        typeof params.count === "object" &&
        typeof params.count.section_path === "string"
        ? params.count.section_path
        : null,
    ));
  if (goLiveKept) return jsonWithCors(goLiveKept, env, 409);
  // The audit's caps (docs/specs/ai-traffic-audit.md §9): no go live after
  // the end, no fourth page and language pair.
  const gate = await auditGate(env.DB, customerId);
  if (gate.ended) return jsonWithCors(capBody("audit_ended"), env, 409);
  if (await pagesFull(env.DB, gate, customerId, pagePath)) {
    return jsonWithCors(capBody("audit_pages_full"), env, 409);
  }
  // As it was before this request: a test starts only at a true first go
  // live (privacy review condition 3), never for a test customer.
  const before = await env.DB.prepare("SELECT live_at, plan FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ live_at?: number | null; plan?: string | null }>();

  // 1. Manifest: the operator's edits, then confirmed.
  if (params.manifest && typeof params.manifest === "object") {
    // The request's copy of the manifest may be older than a button's switch
    // (lib/button-rewrite.ts): an entry that does not say `rewrite` keeps the
    // stored word; one that says it, true or false, decides.
    const edited = carryRewrite(
      params.manifest,
      await storedManifestOf(env.DB, customerId, pagePath),
    );
    await env.DB.prepare(
      "UPDATE element_manifests SET manifest = ? WHERE customer_id = ? AND page_path = ?",
    )
      .bind(JSON.stringify(edited), customerId, pagePath)
      .run();
  }
  await env.DB.prepare(
    "UPDATE element_manifests SET confirmed_at = ? WHERE customer_id = ? AND page_path = ?",
  )
    .bind(now, customerId, pagePath)
    .run();
  const confirmed = await env.DB.prepare(
    "SELECT confirmed_at FROM element_manifests WHERE customer_id = ? AND page_path = ?",
  )
    .bind(customerId, pagePath)
    .first<{ confirmed_at: number | null }>();
  if (!confirmed) {
    return jsonWithCors({ error: "No manifest found for this path" }, env, 404);
  }

  // An extra page after the first go-live (docs/specs/first-run.md §6): the
  // brief is finished and must not be written again, because writing it
  // marks every version of every page stale and the Live screen rewrites
  // them all (seen on a pilot site, 2026-09-14: adding /approach restarted 90
  // versions). Languages were settled at the first go-live too.
  const extraPage = pagePath !== "/" && (await loadFinishedBrief(env, customerId)) !== null;

  // 1b. The other languages the customer agreed to: confirm their pages,
  //     finalise their briefs, remember the choice (docs/specs/per-language.md).
  const langRow = await env.DB.prepare("SELECT languages FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ languages: string | null }>();
  let languages: StoredLanguage[] = [];
  try {
    languages = langRow?.languages ? (JSON.parse(langRow.languages) as StoredLanguage[]) : [];
  } catch {
    languages = [];
  }
  const wanted = Array.isArray(params.languages)
    ? new Set(params.languages.map((l) => String(l).toLowerCase()))
    : null;
  const languagesRefused: Array<{ lang: string; path: string }> = [];
  for (const page of extraPage ? [] : languages) {
    // A language on the same address has no page to confirm: whatever the
    // request ticks, it is never enabled and never becomes a path to write.
    if (isSameAddress(page)) {
      (page as { enabled: boolean }).enabled = false;
      continue;
    }
    if (page.status === "primary") {
      page.enabled = true;
      continue;
    }
    page.enabled = page.status === "ready" && (wanted === null || wanted.has(page.lang));
    // An audit writes three page and language pairs at most (§9): a
    // language past the cap stays off, as if it had not been ticked.
    if (page.enabled && (await pagesFull(env.DB, gate, customerId, page.path))) {
      page.enabled = false;
    }
    // A language's page outside the kept sections of a sensitive customer
    // is never confirmed (condition 2): it stays off, as if not ticked, and
    // the answer names it in `languages_refused`.
    if (page.enabled && pageRefusalUnder(sensitive, page.path) !== null) {
      page.enabled = false;
      languagesRefused.push({ lang: page.lang, path: page.path });
    }
    if (!page.enabled) continue;
    await env.DB.prepare(
      "UPDATE element_manifests SET confirmed_at = ? WHERE customer_id = ? AND page_path = ?",
    )
      .bind(now, customerId, page.path)
      .run();
    await env.DB.prepare(
      "UPDATE business_dna_i18n SET draft = 0 WHERE customer_id = ? AND language = ?",
    )
      .bind(customerId, page.lang)
      .run();
  }
  if (languages.length > 0 && !extraPage) {
    await env.DB.prepare("UPDATE customers SET languages = ? WHERE id = ?")
      .bind(JSON.stringify(languages), customerId)
      .run();
  }

  // 2. The brief, confirmed (first go-live only; an extra page reuses it).
  if (!extraPage) {
    await upsertBusinessDna(env, { ...dna, customer_id: customerId } as BusinessDNA, {
      draft: false,
    });
  }
  await writeHideRules(env, customerId);
  await writeLangMap(env, customerId);

  // 3. Promote the preview, if it exists, so the first live version costs
  //    nothing extra and matches what the operator just saw.
  let promoted = false;
  const rawRecord = await env.VARIANTS.get(quickstartKey(customerId, pagePath));
  const previewBody = await env.VARIANTS.get(previewKey(customerId, pagePath));
  if (rawRecord && previewBody) {
    try {
      const record = JSON.parse(rawRecord) as QuickstartRecord;
      if (record.provenance) {
        // The one way to go live (docs/specs/proof-engine.md, C): the body
        // gets its id, its immutable row and the live key.
        await publishVersion(
          env,
          { customerId, pagePath, intentDim: PREVIEW_INTENT, sourceDim: PREVIEW_SOURCE },
          JSON.parse(previewBody) as VariantBody,
          {
            model: record.provenance.model,
            promptHash: record.provenance.prompt_hash,
            costUsd: record.provenance.cost_usd,
            lintFlags: record.provenance.lint_flags,
          },
        );
        promoted = true;
        // The preview was written before the operator turned a button on:
        // it has no words for it. Stale, so the queue writes the label; the
        // preview serves meanwhile with the button as built.
        const live = await storedManifestOf(env.DB, customerId, pagePath);
        if (
          live &&
          unwrittenButtons(
            live,
            JSON.parse(previewBody) as VariantBody,
            record.provenance.lint_flags,
          ).length > 0
        ) {
          await env.DB.prepare(
            "UPDATE variants SET status = 'stale' WHERE customer_id = ? AND kv_key = ? AND status = 'ready'",
          )
            .bind(
              customerId,
              variantKeyForPath(customerId, pagePath, PREVIEW_INTENT, PREVIEW_SOURCE),
            )
            .run();
        }
      }
    } catch {
      console.error("[rawuser/go-live] preview promotion skipped (non-critical)");
    }
  }
  // 4. The button to count and the test (docs/specs/measure-at-go-live.md
  //    §12), before live_at so a failure leaves the go live repeatable.
  let selectors: MeasureSelectors | null = null;
  let goes: MeasureGoes | null = null;
  if (rawRecord) {
    try {
      const stored = JSON.parse(rawRecord) as QuickstartRecord;
      selectors = stored.measure_selectors ?? null;
      goes = stored.measure_goes ?? null;
    } catch {
      selectors = null;
      goes = null;
    }
  }
  const countSlot =
    params.count &&
    typeof params.count === "object" &&
    typeof params.count.section_path === "string"
      ? { section_path: params.count.section_path }
      : null;
  const measured = await goLiveMeasure(env, {
    customerId,
    pagePath,
    extraPage,
    liveBefore: before?.live_at ?? null,
    plan: before?.plan ?? null,
    count: countSlot,
    test: params.test === true,
    languagePages: extraPage
      ? []
      : languages
          .filter((l): l is LanguagePage => !isSameAddress(l))
          .filter((l) => l.enabled && l.status !== "primary" && l.path !== pagePath)
          .map((l) => ({ lang: l.lang, path: l.path })),
    selectors,
    goes,
    user,
    now,
  });

  await env.VARIANTS.delete(previewKey(customerId, pagePath));
  await env.VARIANTS.delete(quickstartKey(customerId, pagePath));

  // The first set (docs/specs/versions-approval.md): at a true first go live,
  // the cells whose first body goes live at once, as before. Every other new
  // body after this waits for the customer's OK. Written before live_at, so
  // no write sees the customer live without it.
  if (!before?.live_at) {
    await recordFirstSet(env.DB, customerId, {
      at: now,
      pages: [
        pagePath,
        ...(extraPage
          ? []
          : languages
              .filter((l): l is LanguagePage => !isSameAddress(l))
              .filter((l) => l.enabled)
              .map((l) => l.path)),
      ],
      intents: await loadServedIntents(customerId, env.DB),
    });
  }
  await env.DB.prepare("UPDATE customers SET live_at = COALESCE(live_at, ?) WHERE id = ?")
    .bind(now, customerId)
    .run();
  // The keyword lexicon at a true first go live (docs/specs/keyword-intent.md
  // §4), in the background; the brief and the languages are settled now. A
  // build that does not finish is the six-hour sweep's.
  if (!before?.live_at) await refreshKeywordLexicon(env, customerId, ctx);

  return jsonWithCors(
    {
      ok: true,
      page_path: pagePath,
      confirmed_at: now,
      promoted,
      languages: languages
        .filter((l): l is LanguagePage => !isSameAddress(l) && l.enabled)
        .map((l) => ({ lang: l.lang, path: l.path })),
      count: measured.count,
      test: measured.test,
      // Only for a sensitive customer, and only when a language was left off.
      ...(languagesRefused.length > 0 ? { languages_refused: languagesRefused } : {}),
    },
    env,
    200,
  );
}
