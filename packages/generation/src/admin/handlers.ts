/**
 * Admin API handlers — one per endpoint.
 *
 * Privacy invariant: the `events` table is queried only for aggregate
 * stage-derivation in handleCustomersList (no visitor identifiers, no PII).
 * All other handlers touch operator data only (customers, business_dna, variants, KV).
 */

import type { BusinessDNA, IntentDim, SensitiveSettings, VariantBody } from "@rawuser/shared";
import { INTENT_DIMENSIONS, closedKey, normalizePath, variantKeyForPath } from "@rawuser/shared";
import { addAuditSpend, auditGate, capBody, takeRewrite } from "../audit/caps.ts";
import type { LoginRateLimit } from "../auth/login-limit.ts";
import { hashSessionToken } from "../auth/password.ts";
import { type InstallEnv, rememberOffAtCreation } from "../install-config.ts";
import { refreshKeywordLexicon } from "../keywords/lexicon.ts";
import type { InviteMailer } from "../lib/invite-email.ts";
import { lintFlagsOf, partsAsBuiltOf } from "../lib/parts-as-built.ts";
import type { BrowserBinding } from "../lib/render-page.ts";
import { sensitivePageRefusal } from "../lib/sensitive-guard.ts";
import { TRIED_TTL_MS, clearTried, nextTryAt, triedAt } from "../lib/tried-marker.ts";
import { FIRST_WRITE_RETRIED, pageKeyWhere } from "../lib/variant-rows.ts";
import { variantSummary } from "../lib/variant-summary.ts";
import { approvalFields, markVersionsStale } from "../lib/version-approval.ts";
import type { OrchestrateEnv } from "../orchestrator.ts";
import { regenerateOne } from "../orchestrator.ts";
import { loadServedIntents } from "../site-map/served-load.ts";
import type { SessionUser } from "./auth.ts";
import type { CorsEnv } from "./cors.ts";
import { jsonWithCors } from "./cors.ts";
import {
  CUSTOMER_REWRITES_PER_DAY,
  bodyForCustomer,
  countsAsRewrite,
  isCustomer,
  knownCell,
  listItemForCustomer,
  rewriteCapBody,
  rewritesLeft,
  summaryForCustomer,
  takeRewrite as takeCustomerRewrite,
  takeRewriteAll,
  writeAnswerForCustomer,
} from "./customer-versions.ts";
import { writeHideRules, writeLangMap, writeVisitorBundle } from "./onboard.ts";
import { requireCustomerScope } from "./scope.ts";
import { creationSettings, keptSectionsColumn } from "./sensitive.ts";

export interface AdminEnv extends OrchestrateEnv, CorsEnv {
  ENVIRONMENT: string;
  // ADMIN_TOKEN is no longer read in code — left in env type so
  // existing wrangler.toml [vars] declaration stays valid until D3.6.
  ADMIN_TOKEN?: string;
  /** Ops alert webhook (Telegram); the apply submit posts one line to it. */
  ALERT_WEBHOOK_URL?: string;
  /**
   * Cloudflare Browser Run ([browser] binding). Reads a page built in the
   * browser when the server read is a shell (lib/render-page.ts,
   * docs/specs/install-friction.md A). Absent: no render, as before.
   */
  BROWSER?: BrowserBinding;
  /** "off" turns the render off without a code change. */
  BROWSER_RUN?: string;
  /** Per-IP sign-in limit ([[ratelimits]] LOGIN_LIMITER). Absent: fail open. */
  LOGIN_LIMITER?: LoginRateLimit;
  /** Seals two-step secrets (32 random bytes, base64). Secret, never in [vars]. */
  MFA_ENCRYPTION_KEY?: string;
  /** Comma list of roles that must use two-step sign-in. Empty today. */
  MFA_REQUIRED_ROLES?: string;
  /**
   * "on" lets the founder mint free-audit links (docs/specs/ai-traffic-audit.md;
   * privacy review condition 8: not before security-hardening.md §1.2 and §1.3 are
   * deployed). Anything else, unset included: off.
   */
  AUDIT_INVITES?: string;
  /**
   * Cloudflare Email Sending ([[env.production.send_email]] EMAIL, allowed
   * to send as SENDER_ADDRESS only): the pilot invite email
   * (docs/specs/invite-email.md). Absent outside production: no send,
   * `email_error: "unavailable"`.
   */
  EMAIL?: InviteMailer;
}

// Re-export onboard handlers so routes.ts has a single import point.
export {
  handleCaptureStatus,
  handleCaptureToken,
  handleOnboardConfirm,
  handleOnboardDetect,
  handleOnboardManifest,
} from "./onboard.ts";

// V2 Module 3: conversion target management.
export {
  handleConversionsConfirm,
  handleConversionsCount,
  handleConversionsDelete,
  handleConversionsList,
  handleConversionsUpsert,
} from "./conversions.ts";

// ---------------------------------------------------------------------------
// POST /admin/login: public, no auth gate. Lives in sign-in.ts with the
// failed sign-in limit and the second step (security-hardening.md §1).
// ---------------------------------------------------------------------------

export { handleLogin } from "./sign-in.ts";

// ---------------------------------------------------------------------------
// POST /admin/logout — auth required
// ---------------------------------------------------------------------------

export async function handleLogout(request: Request, env: AdminEnv): Promise<Response> {
  const provided = request.headers.get("X-Rawuser-Admin");
  if (provided) {
    const tokenHash = await hashSessionToken(provided);
    await env.DB.prepare("DELETE FROM superadmin_sessions WHERE token_hash = ?")
      .bind(tokenHash)
      .run();
  }
  return jsonWithCors({ ok: true }, env, 200);
}

// ---------------------------------------------------------------------------
// GET /admin/me — auth required
// ---------------------------------------------------------------------------

export async function handleMe(
  _request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const { scope, ...rest } = user;
  return jsonWithCors(
    scope === "enrol" ? { user: rest, mfa_enrolment_required: true } : { user: rest },
    env,
    200,
  );
}

// ---------------------------------------------------------------------------
// POST /admin/verify — token check (retained for backward compat; delegates to session)
// ---------------------------------------------------------------------------

export async function handleVerify(_request: Request, env: AdminEnv): Promise<Response> {
  return jsonWithCors({ ok: true }, env, 200);
}

// ---------------------------------------------------------------------------
// GET /admin/customers/list — upgraded with onboarding_stage + last_activity_at
// ---------------------------------------------------------------------------

interface CustomerListRow {
  id: string;
  slug: string;
  domain: string;
  plan: string;
  status: string;
  created_at: number;
  contact_email: string | null;
  contact_name: string | null;
  onboarding_stage: string;
  last_activity_at: number | null;
  // journey signals — raw 0|1 integers from D1
  has_dna: number;
  has_confirmed_manifest: number;
  tag_seen_at: number | null;
  preview_seen_at: number | null;
  live_at: number | null;
  languages: string | null;
  variants_ready_count: number;
  variants_last_generated_at: number | null;
  events_24h: number;
  events_7d: number;
  last_event_at: number | null;
  // snippet liveness (F17) — nullable until the probe has run at least once
  snippet_status: string | null;
  snippet_last_probed_at: number | null;
  snippet_last_event_at: number | null;
}

function parseLanguages(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function handleCustomersList(
  _request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const now = Date.now();
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  // Customer-role users see only their own row; superadmin sees all.
  // This is the only "list everything" endpoint, so scope enforcement is an
  // SQL filter (returning the user's one row) rather than a 403.
  const scopeWhere = user.role === "customer" ? "WHERE c.id = ?" : "";

  // Single query with CASE to derive onboarding stage without a new column.
  // Stage priority: live > snippet_installed > variants_generated > dna_filled > new.
  // events table uses `ts` (not created_at) for its timestamp column.
  // events_24h and events_7d are shown as visits: a `snippet_issue` row is a
  // fault report of a load, sometimes two of one load, and since 2026-10-12
  // one may be sent by a load the visitor left (docs/specs/snippet-issues.md,
  // "Leaving the page"), so those rows are taken out. Two counts, each on its
  // own index, instead of a filter that would read every row. The stage and
  // the last-event times below still take any row: they ask whether the tag
  // runs, not how many came.
  // LEFT JOIN snippet_status for F17 liveness fields (nullable until probe runs).
  const stmt = env.DB.prepare(
    `SELECT
       c.id,
       c.slug,
       c.domain,
       c.plan,
       c.status,
       c.created_at,
       c.contact_email,
       c.contact_name,
       EXISTS (SELECT 1 FROM business_dna d WHERE d.customer_id = c.id AND d.draft = 0) AS has_dna,
       c.tag_seen_at,
       c.preview_seen_at,
       c.live_at,
       c.languages,
       (
         SELECT CASE WHEN EXISTS (
           SELECT 1 FROM element_manifests em
           WHERE em.customer_id = c.id AND em.confirmed_at IS NOT NULL
         ) THEN 1 ELSE 0 END
       ) AS has_confirmed_manifest,
       (SELECT COUNT(*) FROM variants v WHERE v.customer_id = c.id AND v.status = 'ready') AS variants_ready_count,
       (SELECT MAX(generated_at) FROM variants v WHERE v.customer_id = c.id) AS variants_last_generated_at,
       (SELECT COUNT(*) FROM events e WHERE e.customer_id = c.id AND e.ts > ?)
         - (SELECT COUNT(*) FROM events e WHERE e.customer_id = c.id AND e.event_type = 'snippet_issue' AND e.ts > ?) AS events_24h,
       (SELECT COUNT(*) FROM events e WHERE e.customer_id = c.id AND e.ts > ?)
         - (SELECT COUNT(*) FROM events e WHERE e.customer_id = c.id AND e.event_type = 'snippet_issue' AND e.ts > ?) AS events_7d,
       (SELECT MAX(ts) FROM events e WHERE e.customer_id = c.id) AS last_event_at,
       CASE
         WHEN (SELECT COUNT(*) FROM events e WHERE e.customer_id = c.id AND e.ts > ?) > 0
           THEN 'live'
         WHEN EXISTS (SELECT 1 FROM element_manifests em WHERE em.customer_id = c.id AND em.confirmed_at IS NOT NULL)
           THEN 'snippet_installed'
         WHEN (SELECT COUNT(*) FROM variants v WHERE v.customer_id = c.id AND v.status = 'ready') > 0
           THEN 'variants_generated'
         WHEN EXISTS (SELECT 1 FROM business_dna d WHERE d.customer_id = c.id AND d.draft = 0)
           THEN 'dna_filled'
         ELSE 'new'
       END AS onboarding_stage,
       (
         SELECT MAX(ts) FROM (
           SELECT MAX(updated_at) AS ts FROM business_dna WHERE customer_id = c.id
           UNION ALL SELECT MAX(generated_at) AS ts FROM variants WHERE customer_id = c.id
           UNION ALL SELECT MAX(ts) AS ts FROM events WHERE customer_id = c.id
           UNION ALL SELECT c.created_at AS ts
         )
       ) AS last_activity_at,
       ss.status        AS snippet_status,
       ss.last_probed_at AS snippet_last_probed_at,
       ss.last_event_at  AS snippet_last_event_at
     FROM customers c
     LEFT JOIN snippet_status ss ON ss.customer_id = c.id
     ${scopeWhere}
     ORDER BY c.created_at DESC`,
  );

  // events_24h (all rows, issue rows), events_7d (the same two), the stage.
  const windows = [
    twentyFourHoursAgo,
    twentyFourHoursAgo,
    sevenDaysAgo,
    sevenDaysAgo,
    sevenDaysAgo,
  ];
  const result =
    user.role === "customer" && user.customer_id
      ? await stmt.bind(...windows, user.customer_id).all<CustomerListRow>()
      : await stmt.bind(...windows).all<CustomerListRow>();

  return jsonWithCors(
    (result.results ?? []).map((row) => ({
      id: row.id,
      slug: row.slug,
      domain: row.domain,
      plan: row.plan,
      status: row.status,
      created_at: row.created_at,
      contact_email: row.contact_email,
      contact_name: row.contact_name,
      onboarding_stage: row.onboarding_stage,
      last_activity_at: row.last_activity_at,
      has_dna: row.has_dna === 1,
      has_confirmed_manifest: row.has_confirmed_manifest === 1,
      tag_seen_at: row.tag_seen_at ?? null,
      preview_seen_at: row.preview_seen_at ?? null,
      live_at: row.live_at ?? null,
      languages: parseLanguages(row.languages),
      variants_ready_count: row.variants_ready_count,
      variants_last_generated_at: row.variants_last_generated_at,
      events_24h: row.events_24h,
      events_7d: row.events_7d,
      last_event_at: row.last_event_at,
      snippet_status: row.snippet_status ?? null,
      snippet_status_probed_at: row.snippet_last_probed_at ?? null,
      snippet_status_last_event_at: row.snippet_last_event_at ?? null,
    })),
    env,
    200,
  );
}

// ---------------------------------------------------------------------------
// Customer row, shared by /admin/customers/create and the apply page's
// submit (docs/specs/pilot-apply.md, 2026-10-01).
// ---------------------------------------------------------------------------

/** A customer id is its slug: lowercase letters, digits and hyphens, at most 50. */
export const CUSTOMER_SLUG_RE = /^[a-z0-9-]+$/;
export const CUSTOMER_SLUG_MAX = 50;

export interface NewCustomer {
  slug: string;
  domain: string;
  plan: string;
  contactEmail: string | null;
  contactName: string | null;
  createdAt: number;
  /**
   * Marked sensitive at creation (docs/specs/sensitive-customers.md: a
   * customer is marked before its tag is handed out). Only the superadmin's
   * create passes it; absent, the row is written exactly as before.
   */
  sensitive?: SensitiveSettings | null;
}

/**
 * Inserts the customers row (id = slug, status active). Returns false when
 * the slug is taken; D1 surfaces the unique-constraint violation as a
 * message containing "UNIQUE". Any other error is rethrown.
 *
 * The id of a deleted customer counts as taken while its tombstone lives
 * (security-hardening.md §6, condition 1): a forgotten tag on the old site
 * would otherwise start recording into the new customer's rows.
 *
 * Both statements set `remember_off` themselves, from REMEMBER_DEFAULT
 * (install-config.ts): the column's default is not what decides whether a
 * new customer's visitors get a code in their browser. Unset reads as off.
 */
export async function insertCustomer(
  env: { DB: D1Database; VARIANTS?: KVNamespace } & Pick<InstallEnv, "REMEMBER_DEFAULT">,
  c: NewCustomer,
): Promise<boolean> {
  if (env.VARIANTS && (await env.VARIANTS.get(closedKey(c.slug))) !== null) return false;
  const rememberOff = rememberOffAtCreation(env);
  try {
    if (c.sensitive?.sensitive) {
      // One statement, so the customer never exists unmarked. The mark
      // answers the special-category question too (readiness-check.md,
      // check 3): such a customer never reads as unanswered.
      await env.DB.prepare(
        `INSERT INTO customers (id, slug, domain, plan, status, created_at, contact_email, contact_name,
           sensitive, kept_sections, special_category, special_category_at, remember_off)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 1, ?, 1, ?, ?)`,
      )
        .bind(
          c.slug,
          c.slug,
          c.domain,
          c.plan,
          c.createdAt,
          c.contactEmail,
          c.contactName,
          keptSectionsColumn(c.sensitive.kept),
          c.createdAt,
          rememberOff,
        )
        .run();
      return true;
    }
    await env.DB.prepare(
      `INSERT INTO customers (id, slug, domain, plan, status, created_at, contact_email, contact_name,
         remember_off)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
      .bind(
        c.slug,
        c.slug,
        c.domain,
        c.plan,
        c.createdAt,
        c.contactEmail,
        c.contactName,
        rememberOff,
      )
      .run();
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toUpperCase().includes("UNIQUE")) return false;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// POST /admin/customers/create — auth required
// ---------------------------------------------------------------------------

interface CreateCustomerBody {
  slug: string;
  domain: string;
  plan?: string;
  contact_email?: string;
  contact_name?: string;
  /** `true` marks the customer sensitive from its first row (sensitive-customers.md). */
  sensitive?: boolean;
  /** The kept sections, only with `sensitive: true`; as validKeptSections takes them. */
  kept_sections?: string[];
}

// RFC 5322 simplified — good enough for "is this plausibly an email" gating.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handleCustomersCreate(request: Request, env: AdminEnv): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }

  const params = body as Partial<CreateCustomerBody>;

  // Validate slug: lowercase letters, digits, hyphens; 1–50 chars.
  if (
    !params.slug ||
    typeof params.slug !== "string" ||
    !CUSTOMER_SLUG_RE.test(params.slug) ||
    params.slug.length > CUSTOMER_SLUG_MAX
  ) {
    return jsonWithCors(
      { error: "slug must be 1-50 chars, lowercase letters, digits, and hyphens only" },
      env,
      400,
    );
  }

  if (
    !params.domain ||
    typeof params.domain !== "string" ||
    params.domain.trim() === "" ||
    params.domain.length > 253
  ) {
    return jsonWithCors({ error: "domain is required and must be ≤ 253 chars" }, env, 400);
  }

  const slug = params.slug;
  const domain = params.domain.trim();
  const plan =
    typeof params.plan === "string" && params.plan.trim() !== "" ? params.plan.trim() : "pilot";

  let contactEmail: string | null = null;
  if (typeof params.contact_email === "string" && params.contact_email.trim() !== "") {
    const trimmed = params.contact_email.trim();
    if (trimmed.length > 320 || !EMAIL_RE.test(trimmed)) {
      return jsonWithCors({ error: "contact_email must be a valid email address" }, env, 400);
    }
    contactEmail = trimmed;
  }

  let contactName: string | null = null;
  if (typeof params.contact_name === "string" && params.contact_name.trim() !== "") {
    const trimmed = params.contact_name.trim();
    if (trimmed.length > 200) {
      return jsonWithCors({ error: "contact_name must be ≤ 200 chars" }, env, 400);
    }
    contactName = trimmed;
  }

  // A customer whose site is about health or another special category is
  // marked here, before its tag is handed out (sensitive-customers.md).
  const marked = creationSettings(params);
  if (!marked.ok) return jsonWithCors({ error: marked.error }, env, 400);

  const now = Date.now();

  const inserted = await insertCustomer(env, {
    slug,
    domain,
    plan,
    contactEmail,
    contactName,
    createdAt: now,
    sensitive: marked.settings,
  });
  if (!inserted) {
    return jsonWithCors({ error: "Customer with that slug already exists" }, env, 409);
  }
  if (marked.settings) {
    // The bundle with `s` and `sk` before the tag is on, so the edge knows
    // from the first visit. Without it the edge reads the flag from the
    // database and fails closed, so a failed write here is not fatal.
    try {
      await writeVisitorBundle(env, slug);
    } catch {
      console.error("[rawuser/admin] bundle not written for a new sensitive customer");
    }
  }

  return jsonWithCors(
    {
      customer: {
        id: slug,
        slug,
        domain,
        plan,
        status: "active",
        created_at: now,
        onboarding_stage: "new",
        last_activity_at: now,
        contact_email: contactEmail,
        contact_name: contactName,
        ...(marked.settings ? { sensitive: true, kept_sections: marked.settings.kept } : {}),
      },
    },
    env,
    201,
  );
}

// ---------------------------------------------------------------------------
// GET /admin/dna/get?customer_id=X
// ---------------------------------------------------------------------------

interface DnaRow {
  customer_id: string;
  product: string;
  icp: string;
  brand_voice: string;
  value_props: string;
  differentiators: string;
  proof_points: string;
  target_market: string | null;
  target_language: string;
  per_intent_hints: string;
  prompt_cache_id: string | null;
  updated_at: number;
}

export async function handleDnaGet(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  if (!customerId) {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }

  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  const row = await env.DB.prepare(
    `SELECT customer_id, product, icp, brand_voice, value_props, differentiators,
            proof_points, target_market, target_language, per_intent_hints,
            prompt_cache_id, updated_at
     FROM business_dna WHERE customer_id = ?`,
  )
    .bind(customerId)
    .first<DnaRow>();

  if (!row) {
    return jsonWithCors({ error: "Not found" }, env, 404);
  }

  const dna: BusinessDNA = {
    customer_id: row.customer_id,
    product: row.product,
    icp: row.icp,
    brand_voice: row.brand_voice,
    value_props: JSON.parse(row.value_props) as string[],
    differentiators: JSON.parse(row.differentiators) as string[],
    proof_points: JSON.parse(row.proof_points) as string[],
    target_market: row.target_market ?? "",
    target_language: row.target_language,
    per_intent_hints: JSON.parse(row.per_intent_hints) as Partial<Record<IntentDim, string>>,
    prompt_cache_id: row.prompt_cache_id ?? undefined,
    updated_at: row.updated_at,
  };

  return jsonWithCors(dna, env, 200);
}

// ---------------------------------------------------------------------------
// POST /admin/dna/upsert
// ---------------------------------------------------------------------------

export async function handleDnaUpsert(
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

  // Validate required fields
  const dna = body as Partial<BusinessDNA>;
  if (!dna.customer_id || typeof dna.customer_id !== "string") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }

  const scope = requireCustomerScope(user, dna.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  if (!dna.product || typeof dna.product !== "string" || dna.product.trim() === "") {
    return jsonWithCors({ error: "product is required" }, env, 400);
  }
  if (!dna.icp || typeof dna.icp !== "string" || dna.icp.trim() === "") {
    return jsonWithCors({ error: "icp is required" }, env, 400);
  }

  const valuePropsList = Array.isArray(dna.value_props) ? dna.value_props : [];
  if (valuePropsList.length < 1) {
    return jsonWithCors({ error: "at least one value_prop is required" }, env, 400);
  }

  await upsertBusinessDna(env, dna as BusinessDNA, { draft: false });
  // The brief changed: a live customer's keyword lexicon is built again in
  // the background (docs/specs/keyword-intent.md §4); the six-hour sweep
  // catches a build that does not finish (the lexicon is older than the brief).
  await refreshKeywordLexicon(env, dna.customer_id, ctx);

  return jsonWithCors({ ok: true }, env, 200);
}

/**
 * Writes the brief, marks ready variants stale (the brief is what every
 * variant was generated from), and keeps the edge's language key in step.
 * `draft: true` is the quickstart chain's auto-drafted brief, which the
 * customers list does not count as a brief until go-live flips it.
 */
export async function upsertBusinessDna(
  env: AdminEnv,
  dna: BusinessDNA,
  options: { draft: boolean },
): Promise<void> {
  const valuePropsList = Array.isArray(dna.value_props) ? dna.value_props : [];
  await env.DB.prepare(
    `INSERT INTO business_dna
       (customer_id, product, icp, brand_voice, value_props, differentiators,
        proof_points, target_market, target_language, per_intent_hints, updated_at, draft)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET
       product = excluded.product,
       icp = excluded.icp,
       brand_voice = excluded.brand_voice,
       value_props = excluded.value_props,
       differentiators = excluded.differentiators,
       proof_points = excluded.proof_points,
       target_market = excluded.target_market,
       target_language = excluded.target_language,
       per_intent_hints = excluded.per_intent_hints,
       updated_at = excluded.updated_at,
       draft = excluded.draft`,
  )
    .bind(
      dna.customer_id,
      dna.product.trim(),
      dna.icp.trim(),
      typeof dna.brand_voice === "string" ? dna.brand_voice.trim() : "",
      JSON.stringify(valuePropsList),
      JSON.stringify(Array.isArray(dna.differentiators) ? dna.differentiators : []),
      JSON.stringify(Array.isArray(dna.proof_points) ? dna.proof_points : []),
      typeof dna.target_market === "string" ? dna.target_market.trim() : null,
      typeof dna.target_language === "string" ? dna.target_language.trim() : "en",
      JSON.stringify(
        dna.per_intent_hints && typeof dna.per_intent_hints === "object"
          ? dna.per_intent_hints
          : {},
      ),
      Date.now(),
      options.draft ? 1 : 0,
    )
    .run();

  // A4: the brief is the source every variant was generated FROM, so editing
  // it makes existing variants outdated. Mark ready rows stale; the
  // onlyMissing cron only skips 'ready' rows, so stale ones regenerate on the
  // next 6-hourly run automatically (or immediately via "Regenerate all").
  // KV keeps serving the old variant until the new one lands.
  // A body waiting for the customer's OK was written from the old brief: it
  // is dropped, never approvable (docs/specs/versions-approval.md).
  await markVersionsStale(env.DB, dna.customer_id);

  // The edge's language gate reads the brief language from KV (one read,
  // never D1 in the visitor path). Keep it in step with the brief.
  await writeLangMap(env, dna.customer_id);
  // The versions are about to be rewritten: every part is hidden again
  // until they are (lib/hidden-parts.ts).
  await rehide(env, dna.customer_id);
}

/** The hide rules again after versions were marked stale. Best effort. */
async function rehide(env: AdminEnv, customerId: string): Promise<void> {
  try {
    await writeHideRules(env, customerId);
  } catch (e) {
    console.error(
      "[rawuser/admin] hide rules not rebuilt:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

// ---------------------------------------------------------------------------
// GET /admin/variants/list?customer_id=X
// ---------------------------------------------------------------------------

interface VariantListRow {
  kv_key: string;
  model: string;
  generated_at: number;
  cost_usd: number;
  status: string;
  lint_flags: string | null;
  pending_body_id: string | null;
  pending_at: number | null;
}

/**
 * The versions of a customer: an array of its ready and stale rows, as
 * before, each now with `lint_flags` (the rule names stored on the row) and
 * `parts_as_built` (`{ path, rule }` per part the version leaves as the page
 * built it, empty when none; docs/specs/refused-versions.md).
 *
 * With `summary=1` the answer is `{ items, summary }`: the same array and
 * the customer's counts (`written`, `with_parts_as_built`, `refused`,
 * `failed`) with `refused_rows`, each saying what a visitor sees meanwhile
 * (`serving`: "older", "nearest" or "original"). Without it the answer is
 * the array alone, so a caller from before reads it unchanged.
 */

export async function handleVariantsList(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  if (!customerId) {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }

  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  // All ready AND stale variants across every page_path (A1/A4). Stale rows
  // (brief edited since generation) must stay visible so the dashboard shows
  // "stale" badges instead of variants silently vanishing after a brief edit;
  // KV still serves their last-good body, so previews keep working. The
  // dashboard groups by page_path via a path switcher (R1c b).
  // And every row with a body waiting for the customer's OK
  // (docs/specs/versions-approval.md): status 'pending' where no body serves
  // yet, else the live row's own status with `pending` true.
  const result = await env.DB.prepare(
    `SELECT kv_key, model, generated_at, cost_usd, status, lint_flags, pending_body_id, pending_at
     FROM variants
     WHERE customer_id = ? AND (status IN ('ready', 'stale', 'pending') OR pending_body_id IS NOT NULL)
     ORDER BY generated_at DESC`,
  )
    .bind(customerId)
    .all<VariantListRow>();

  const rows = result.results ?? [];

  // Parse page_path, intent_dim, source_dim from the kv_key. Two shapes:
  //   root:  v1:variant:{cid}:{intent}:{source}
  //   path:  v1:variant:{cid}:p:{encodedPath}:{intent}:{source}
  // The path segment is URL-encoded, so ':' never appears inside it.
  const items = rows.map((row) => {
    const parts = row.kv_key.split(":");
    let page_path = "/";
    let intent_dim = parts[3] ?? "";
    let source_dim = parts[4] ?? "";
    if (parts[3] === "p") {
      page_path = decodeURIComponent(parts[4] ?? "");
      intent_dim = parts[5] ?? "";
      source_dim = parts[6] ?? "";
    }
    return {
      intent_dim,
      source_dim,
      page_path,
      model: row.model,
      generated_at: row.generated_at,
      cost_usd: row.cost_usd,
      status: row.status,
      kv_key: row.kv_key,
      lint_flags: lintFlagsOf(row.lint_flags),
      parts_as_built: partsAsBuiltOf(row.lint_flags),
      ...approvalFields(row),
      pending_body_id: row.pending_body_id ?? null,
    };
  });

  // A customer's own session reads its versions without cost, model, rule
  // names or stored error text (docs/specs/versions-for-every-customer.md).
  const customer = isCustomer(user);
  const shown = customer ? items.map(listItemForCustomer) : items;
  if (url.searchParams.get("summary") !== "1") return jsonWithCors(shown, env, 200);
  const summary = await variantSummary(
    env,
    customerId,
    await loadServedIntents(customerId, env.DB),
  );
  if (!customer) return jsonWithCors({ items, summary }, env, 200);
  return jsonWithCors(
    {
      items: shown,
      summary: summaryForCustomer(summary),
      rewrites: {
        left: await rewritesLeft(env.VARIANTS, customerId),
        per_day: CUSTOMER_REWRITES_PER_DAY,
      },
    },
    env,
    200,
  );
}

// ---------------------------------------------------------------------------
// GET /admin/variant/get?customer_id=X&intent=Y&source=Z
// ---------------------------------------------------------------------------

export async function handleVariantGet(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  const intent = url.searchParams.get("intent");
  const source = url.searchParams.get("source");
  // Optional page_path (A1) — defaults to '/'. variantKeyForPath('/') === the
  // historical path-agnostic key, so existing callers are unaffected.
  const pagePath = normalizePath(url.searchParams.get("page_path"));

  if (!customerId || !intent || !source) {
    return jsonWithCors({ error: "customer_id, intent, and source are required" }, env, 400);
  }

  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  const key = variantKeyForPath(customerId, pagePath, intent, source);
  const value = await env.VARIANTS.get(key);

  if (value === null) {
    return jsonWithCors({ error: "Variant not found" }, env, 404);
  }

  let body: VariantBody;
  try {
    body = JSON.parse(value) as VariantBody;
  } catch {
    return jsonWithCors({ error: "Variant data is corrupted" }, env, 500);
  }

  return jsonWithCors(isCustomer(user) ? bodyForCustomer(body) : body, env, 200);
}

// ---------------------------------------------------------------------------
// POST /admin/variants/stale-all
// ---------------------------------------------------------------------------

/**
 * Marks every version of a customer (or one page) stale so the five-minute
 * queue rewrites them even when the dashboard's loop stops with the laptop
 * (2026-09-15). KV bodies keep serving until each new one lands.
 */
export async function handleVariantsStaleAll(
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
  const params = body as { customer_id?: string; page_path?: string };
  if (!params.customer_id) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const scope = requireCustomerScope(user, params.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  // The audit's caps (docs/specs/ai-traffic-audit.md §9): "Rewrite
  // everything" and "Regenerate all" both start here, once per audit.
  const gate = await auditGate(env.DB, params.customer_id);
  if (gate.ended) return jsonWithCors(capBody("audit_ended"), env, 409);
  if (gate.audit && gate.left <= 0) return jsonWithCors(capBody("audit_spend"), env, 409);
  if (!(await takeRewrite(env.DB, gate, params.customer_id))) {
    return jsonWithCors(capBody("audit_rewrite_used"), env, 409);
  }
  // A customer's own "Rewrite everything": once a UTC day
  // (docs/specs/versions-for-every-customer.md). A superadmin has no cap.
  if (isCustomer(user) && !(await takeRewriteAll(env.VARIANTS, params.customer_id))) {
    return jsonWithCors(rewriteCapBody("rewrite_all_used"), env, 409);
  }
  // Only the intents the site serves (docs/specs/site-shaped-intents.md
  // §7.3): a folded intent's versions stay in KV, unused, and are not
  // rewritten (the founder's decision 5).
  const served = await loadServedIntents(params.customer_id, env.DB);
  const folded = served
    ? INTENT_DIMENSIONS.filter((d) => !served.includes(d)).map((d) => `%:${d}:%`)
    : [];
  const notFolded = folded.map(() => " AND kv_key NOT LIKE ?").join("");
  // One page: its own keys only. The home page's keys are the customer's
  // prefix without `p:`, so the prefix alone took every page with it (J6).
  const page = params.page_path ? pageKeyWhere(params.customer_id, params.page_path) : null;
  // A body waiting for an OK in those cells is dropped with them
  // (docs/specs/versions-approval.md): the rewrite writes a new one.
  const changed = page
    ? await markVersionsStale(env.DB, params.customer_id, ` AND ${page.sql}${notFolded}`, [
        ...page.binds,
        ...folded,
      ])
    : await markVersionsStale(env.DB, params.customer_id, notFolded, folded);
  // The operator asked for everything again: a row the queue is leaving alone
  // after a failed try (lib/tried-marker.ts) gets its try on the next pass.
  // Its own six hours since `generated_at` still apply, as before.
  await clearTried(env.VARIANTS, await erroredKeys(env.DB, params.customer_id, params.page_path));
  // Before the queue writes the first new body: every part hidden again.
  await rehide(env, params.customer_id);
  return jsonWithCors({ ok: true, count: changed }, env, 200);
}

/** The version keys of a customer's error rows, of one page when a path is given. */
async function erroredKeys(
  db: D1Database,
  customerId: string,
  pagePath: string | undefined,
): Promise<string[]> {
  try {
    const rows = await db
      .prepare("SELECT kv_key FROM variants WHERE customer_id = ? AND status = 'error' LIMIT 400")
      .bind(customerId)
      .all<{ kv_key: string }>();
    const keys = (rows.results ?? [])
      .map((x) => x.kv_key)
      .filter((k): k is string => typeof k === "string");
    if (!pagePath) return keys;
    const paged = `v1:variant:${customerId}:p:`;
    return keys.filter((k) =>
      pagePath === "/"
        ? !k.startsWith(paged)
        : k.startsWith(`${paged}${encodeURIComponent(pagePath)}:`),
    );
  } catch {
    return [];
  }
}

// POST /admin/variant/regenerate
// ---------------------------------------------------------------------------

interface RegenerateOneBody {
  customer_id: string;
  intent_dim: string;
  source_dim: string;
  /** Optional page path (A1 per-path). Defaults to '/' when omitted. */
  page_path?: string;
  /**
   * The Live screen's own loop, not an operator's click (J9 of
   * docs/specs/pilot-gaps.md): a row the queue is leaving alone after
   * a failed try (lib/tried-marker.ts) is not written again; the answer says
   * when it will be. Default false: an explicit Regenerate writes at once.
   */
  auto?: boolean;
}

/** The answer of an automatic call for a row that waits out its six hours. */
export const WAITING = "waiting";

/**
 * For the loop's automatic call: the row's last failed try is younger than
 * six hours, so the queue is leaving it alone and so does this call. Answers
 * the body to send, with `next_try`, or null when the row is to be written.
 */
async function autoWaiting(
  env: AdminEnv,
  params: RegenerateOneBody,
): Promise<Record<string, unknown> | null> {
  const kvKey = variantKeyForPath(
    params.customer_id,
    normalizePath(params.page_path),
    params.intent_dim,
    params.source_dim,
  );
  const now = Date.now();
  const tried = await triedAt(env.VARIANTS, kvKey);
  if (tried === null || tried <= now - TRIED_TTL_MS) return null;
  let row: {
    generated_at: number;
    cost_usd: number;
    error_reason: string | null;
    lint_flags: string | null;
    body_id: string | null;
  } | null = null;
  try {
    row = await env.DB.prepare(
      "SELECT generated_at, cost_usd, error_reason, lint_flags, body_id FROM variants WHERE customer_id = ? AND kv_key = ?",
    )
      .bind(params.customer_id, kvKey)
      .first();
  } catch {
    row = null;
  }
  // The queue's own early retry of a first write (refused-versions.md).
  const firstWriteDue =
    row !== null &&
    row.body_id === null &&
    Number(row.cost_usd) === 0 &&
    (row.error_reason ?? "").startsWith("lint:") &&
    !(row.lint_flags ?? "").includes(FIRST_WRITE_RETRIED);
  return {
    customer_id: params.customer_id,
    intent_dim: params.intent_dim,
    source_dim: params.source_dim,
    kv_key: kvKey,
    ok: false,
    error: WAITING,
    next_try: nextTryAt(
      { generatedAt: Number(row?.generated_at) || tried, triedAt: tried, firstWriteDue },
      now,
    ),
    cost_usd: 0,
  };
}

/**
 * For the loop's automatic call: a cell with no live body whose version
 * waits for the customer's OK, or was discarded by the customer
 * (docs/specs/versions-approval.md), is not written again by itself. The
 * answer is the loop's `waiting`, nothing spent, with `approval` saying
 * which. Null when the cell is to be written.
 */
async function awaitingApproval(
  env: AdminEnv,
  params: RegenerateOneBody,
): Promise<Record<string, unknown> | null> {
  const kvKey = variantKeyForPath(
    params.customer_id,
    normalizePath(params.page_path),
    params.intent_dim,
    params.source_dim,
  );
  let row: { status: string } | null = null;
  try {
    row = await env.DB.prepare("SELECT status FROM variants WHERE customer_id = ? AND kv_key = ?")
      .bind(params.customer_id, kvKey)
      .first<{ status: string }>();
  } catch {
    row = null;
  }
  if (row?.status !== "pending" && row?.status !== "discarded") return null;
  return {
    customer_id: params.customer_id,
    intent_dim: params.intent_dim,
    source_dim: params.source_dim,
    kv_key: kvKey,
    ok: false,
    error: WAITING,
    approval: row.status === "pending" ? "waiting" : "discarded",
    cost_usd: 0,
  };
}

export async function handleVariantRegenerate(
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

  const params = body as Partial<RegenerateOneBody>;
  if (!params.customer_id || !params.intent_dim || !params.source_dim) {
    return jsonWithCors(
      { error: "customer_id, intent_dim, and source_dim are required" },
      env,
      400,
    );
  }

  const scope = requireCustomerScope(user, params.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  // A customer's session: only the cells a version is written for, and its
  // answers trimmed to what a customer reads
  // (docs/specs/versions-for-every-customer.md).
  const customer = isCustomer(user);
  if (customer && !knownCell(params.intent_dim, params.source_dim)) {
    return jsonWithCors({ error: "unknown intent_dim or source_dim" }, env, 400);
  }
  const answer = async (out: Record<string, unknown>) =>
    customer
      ? writeAnswerForCustomer(
          out as Parameters<typeof writeAnswerForCustomer>[0],
          await rewritesLeft(env.VARIANTS, params.customer_id as string),
        )
      : out;

  // An intent the site does not serve is not written (site-shaped intents
  // §7.3): its visitors see the evaluation version. Nothing is spent.
  const served = await loadServedIntents(params.customer_id, env.DB);
  if (served && !(served as string[]).includes(params.intent_dim)) {
    return jsonWithCors(
      await answer({
        customer_id: params.customer_id,
        intent_dim: params.intent_dim,
        source_dim: params.source_dim,
        ok: false,
        error: "not_served",
        cost_usd: 0,
      }),
      env,
      200,
    );
  }

  // A sensitive customer has versions only on `/` and its kept sections
  // (docs/specs/sensitive-customers.md, condition 2 and rule 4).
  const kept = await sensitivePageRefusal(env.DB, params.customer_id, params.page_path);
  if (kept) return jsonWithCors(kept, env, 409);

  // The screen's own loop asks on every page load; a row that waits out its
  // six hours is not paid for again (J9). Nothing spent, no model call.
  if (params.auto === true) {
    const held = await awaitingApproval(env, params as RegenerateOneBody);
    if (held) return jsonWithCors(await answer(held), env, 200);
    const waiting = await autoWaiting(env, params as RegenerateOneBody);
    if (waiting) return jsonWithCors(await answer(waiting), env, 200);
  }

  // The audit's caps (docs/specs/ai-traffic-audit.md §9): one version at a
  // time works as for anyone, inside the spend; nothing after the end.
  const gate = await auditGate(env.DB, params.customer_id);
  if (gate.ended) return jsonWithCors(capBody("audit_ended"), env, 409);
  if (gate.audit && gate.left <= 0) return jsonWithCors(capBody("audit_spend"), env, 409);

  // A customer's rewrite of a written version takes one of the day's; a
  // version Rawuser owes (never written, stale, the loop's own retry) does
  // not. Taken before the model call, so a failed write counts too.
  if (
    customer &&
    (await countsAsRewrite(env.DB, params as RegenerateOneBody)) &&
    !(await takeCustomerRewrite(env.VARIANTS, params.customer_id))
  ) {
    return jsonWithCors(rewriteCapBody("rewrite_cap"), env, 409);
  }

  try {
    const result = await regenerateOne(
      params.customer_id,
      params.intent_dim as IntentDim,
      params.source_dim,
      env,
      params.page_path,
    );
    if (gate.audit) await addAuditSpend(env, params.customer_id, result.cost_usd);
    return jsonWithCors(await answer(result as unknown as Record<string, unknown>), env, 200);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const isDev = env.ENVIRONMENT === "development";
    return jsonWithCors(
      isDev ? { error: "regeneration failed", detail: message } : { error: "regeneration failed" },
      env,
      500,
    );
  }
}
