/**
 * The free AI-traffic audit's endpoints (docs/specs/ai-traffic-audit.md §3,
 * §6, §11, §17.4; privacy review CONDITIONAL PASS).
 *
 * Public, token in the body, `Cache-Control: no-store` (privacy review condition
 * 3: never a token in a query string):
 *   POST /admin/audit/open            { t }  the invite's state
 *   POST /admin/audit/submit          { t, url, name, email, banner, terms }
 *   POST /admin/audit/report/public   { t }  the released snapshot only
 *
 * Signed in, the customer's own or a superadmin:
 *   GET  /admin/audit?customer_id=          the Audit page (no number by source)
 *   GET  /admin/audit/report?customer_id=   the report through the session
 *   POST /admin/audit/share-link            { customer_id }  a new link replaces the old
 *
 * Superadmin:
 *   GET  /admin/audit/summary               open audits, the cap, the invite switch
 *   GET  /admin/audit/review?customer_id=   facts, checks, the snapshot
 *   POST /admin/audit/build | release | revoke | end | pilot-terms | make-pilot
 *
 * The invite itself is POST /admin/applications/invite with kind 'audit'.
 */

import { normalizeAuditDomain } from "@rawuser/shared";
import type { AuditStatus } from "@rawuser/shared";
import {
  AUDIT_CEILING_MS,
  AUDIT_LAPSE_MS,
  AUDIT_LINES,
  AUDIT_MAX_OPEN,
  AUDIT_MAX_PAGES,
  AUDIT_MAX_REWRITES,
  AUDIT_MAX_SPEND,
  AUDIT_WINDOW_MS,
  DAY,
} from "../audit/constants.ts";
import {
  type AuditCustomerRow,
  endAudit,
  loadAuditCustomer,
  makePilot,
  mintShareLink,
  recordPilotTerms,
  releaseReport,
  reportByToken,
  reportLink,
  reportRow,
  revokeReport,
  wasAudit,
  windowCounts,
  writtenCounts,
} from "../audit/lifecycle.ts";
import { ReportReleasedError, buildAuditReport, parseSnapshot } from "../audit/report.ts";
import {
  EDGE_ORIGIN_MISSING,
  dashboardPointer,
  edgeOrigin,
  operatorName,
  privacyAddress,
} from "../install-config.ts";
import { sendAlert } from "../lib/alert.ts";
import { normalizeSiteUrl, publicUrlProblem } from "../lib/public-url.ts";
import { slugCandidate, slugFromDomain } from "./apply-brief.ts";
import { customerTag, findByToken, isExpired } from "./apply.ts";
import type { SessionUser } from "./auth.ts";
import { corsHeaders, jsonWithCors } from "./cors.ts";
import { createCustomerUser } from "./customer-users.ts";
import type { AdminEnv } from "./handlers.ts";
import { insertCustomer } from "./handlers.ts";
import { writeVisitorBundle } from "./onboard.ts";
import { requireCustomerScope } from "./scope.ts";

/**
 * The Art. 13 line under Send (privacy review, condition 7). It ends with
 * whom to ask when the install names a privacy address (PRIVACY_ADDRESS).
 */
export function auditPrivacyLine(address: string | null): string {
  const line =
    "We use your name and email to run your audit and send your report, and delete them 60 days after the report unless you start a pilot.";
  return address ? `${line} Questions: ${address}.` : line;
}

/** AdminEnv carries AUDIT_INVITES ("on" lets the founder mint audit links, condition 8). */
export type AuditAdminEnv = AdminEnv;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SLUG_TRIES = 50;

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A token-bearing or report answer: never cached anywhere (condition 3). */
function noStore(payload: unknown, env: AdminEnv, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(env),
    },
  });
}

async function openAudits(db: D1Database): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM customers WHERE plan = 'audit' AND status = 'active'")
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** Why an audit link cannot be minted now, or null (the invite dialog's lines). */
export async function auditInviteRefusal(
  env: AuditAdminEnv,
): Promise<{ status: number; body: { error: string; message: string } } | null> {
  if (env.AUDIT_INVITES !== "on") {
    return { status: 403, body: { error: "audit_invites_off", message: AUDIT_LINES.invites_off } };
  }
  if ((await openAudits(env.DB)) >= AUDIT_MAX_OPEN) {
    return { status: 409, body: { error: "audits_full", message: AUDIT_LINES.audits_full } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The Audit page's state (no number by source, §6)
// ---------------------------------------------------------------------------

export async function auditStatusOf(
  db: D1Database,
  c: AuditCustomerRow,
  now: number,
): Promise<AuditStatus> {
  const rep = await reportRow(db, c.id);
  const w = await writtenCounts(db, c.id, c.live_at);
  const pages = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL",
    )
    .bind(c.id)
    .first<{ n: number }>();
  const to = c.audit_from !== null ? (c.audit_to ?? c.audit_from + AUDIT_WINDOW_MS) : null;
  const extended = c.audit_from !== null && to !== null && to - c.audit_from > AUDIT_WINDOW_MS;
  const builtForWindow = rep !== null && rep.window_start === c.audit_from;
  let stage: AuditStatus["stage"];
  if (c.plan !== "audit") stage = "pilot";
  else if (c.status === "ended") stage = c.live_at === null ? "lapsed" : "ended";
  else if (c.live_at === null) stage = "before_go_live";
  else if (c.audit_from === null) stage = "writing";
  else if (builtForWindow && rep?.released_at) stage = "ready";
  else if (builtForWindow || (to !== null && now >= to)) stage = "checking";
  else stage = "counting";

  const counting = stage === "counting" && c.audit_from !== null && to !== null;
  const visits =
    c.audit_from !== null && to !== null
      ? (await windowCounts(db, c.id, c.audit_from, Math.min(now, to))).visits
      : null;
  const spend = Number(c.audit_spend_usd) || 0;
  const pagesUsed = Number(pages?.n ?? 0);
  const rewrites = Number(c.audit_rewrites) || 0;
  return {
    customer_id: c.id,
    domain: c.domain,
    plan: c.plan,
    stage,
    signed_up_at: c.created_at,
    live_at: c.live_at,
    window_start: c.audit_from,
    window_end: to,
    extended,
    day:
      counting && c.audit_from !== null
        ? Math.max(1, Math.floor((now - c.audit_from) / DAY) + 1)
        : null,
    of_days: c.audit_from === null ? null : extended ? 14 : 7,
    visits_counted: visits,
    written: w.written,
    total: w.total,
    report_due: to,
    report_built_at: builtForWindow ? (rep?.built_at ?? null) : null,
    report_released_at: builtForWindow ? (rep?.released_at ?? null) : null,
    ends_at: c.audit_ends_at,
    ends_at_latest: c.audit_from !== null ? c.audit_from + AUDIT_CEILING_MS : null,
    ended_at: c.audit_ended_at,
    delete_at: c.audit_delete_at,
    lapse_at: c.plan === "audit" && c.live_at === null ? c.created_at + AUDIT_LAPSE_MS : null,
    consent_banner: Number(c.audit_consent_banner) === 1,
    pilot_terms_at: c.pilot_terms_at,
    caps: {
      pages_used: pagesUsed,
      pages_max: AUDIT_MAX_PAGES,
      rewrites_used: rewrites,
      rewrites_max: AUDIT_MAX_REWRITES,
      spend_usd: Math.round(spend * 10000) / 10000,
      spend_max: AUDIT_MAX_SPEND,
      spend_used_up: spend >= AUDIT_MAX_SPEND,
      pages_full: pagesUsed >= AUDIT_MAX_PAGES,
      rewrite_used_up: rewrites >= AUDIT_MAX_REWRITES,
    },
  };
}

/** The state of a customer that is or was an audit; null for any other. */
export async function auditStatusFor(
  db: D1Database,
  customerId: string,
  now: number,
): Promise<AuditStatus | null> {
  const c = await loadAuditCustomer(db, customerId);
  return c && wasAudit(c) ? auditStatusOf(db, c, now) : null;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/** POST /admin/audit/open { t }: the invite's state; after Send it opens nothing (condition 3). */
export async function handleAuditOpen(request: Request, env: AdminEnv): Promise<Response> {
  const body = await readJson(request);
  if (!body) return noStore({ ok: false, error: "Invalid JSON body" }, env, 400);
  const row = await findByToken(env, body.t, "audit");
  if (!row) return noStore({ ok: false, error: "Invalid invite link" }, env, 404);
  const status =
    row.status === "applied" ? "used" : isExpired(row, Date.now()) ? "expired" : "invited";
  return noStore(
    {
      ok: true,
      status,
      ...(status === "invited"
        ? {
            invited_name: row.invited_name,
            invited_site: row.invited_site,
            privacy_line: auditPrivacyLine(privacyAddress(env)),
          }
        : {}),
    },
    env,
  );
}

/** Does any customer already hold this domain (www and the apex as one)? */
async function domainTaken(db: D1Database, domain: string): Promise<boolean> {
  const want = normalizeAuditDomain(domain);
  const rows = await db.prepare("SELECT domain FROM customers").all<{ domain: string }>();
  return (rows.results ?? []).some((r) => normalizeAuditDomain(r.domain) === want);
}

/**
 * POST /admin/audit/submit: creates the audit customer (plan 'audit', terms
 * and banner recorded), its dashboard user with a one-time setup token
 * (returned here only, condition 8), and its visitor bundle with `a`, `ad`
 * (so the edge treats it as an audit before the tag goes on). No model
 * call, no brief: the brief is drafted on Look.
 */
export async function handleAuditSubmit(
  request: Request,
  env: AdminEnv,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return noStore({ ok: false, error: "Invalid JSON body" }, env, 400);
  // The answer carries the tag. Without the edge's origin there is none to
  // print, so nothing is created and the invite is not used.
  const tagOrigin = edgeOrigin(env);
  if (!tagOrigin) return noStore({ ok: false, error: EDGE_ORIGIN_MISSING }, env, 503);
  const now = Date.now();
  const row = await findByToken(env, body.t, "audit");
  if (!row) return noStore({ ok: false, error: "Invalid invite link" }, env, 404);
  if (row.status === "applied") return noStore({ ok: false, error: "used" }, env, 409);
  if (isExpired(row, now)) return noStore({ ok: false, error: "expired" }, env, 410);

  const bad = (error: string, field: string) => {
    console.error(`[rawuser/audit] submit refused: ${field}`);
    return noStore({ ok: false, error, field }, env, 400);
  };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!rawUrl) return bad("url is required", "url");
  const url = normalizeSiteUrl(rawUrl);
  if (!url || publicUrlProblem(url)) return bad("Enter your site's public address", "url");
  if (!name || name.length > 100) return bad("name is required, 100 characters at most", "name");
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) {
    return bad("email must be a valid address", "email");
  }
  if (body.terms !== true) return bad(AUDIT_LINES.terms, "terms");
  const banner = body.banner === true ? 1 : 0;
  const domain = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!normalizeAuditDomain(domain)) return bad("Enter your site's public address", "url");

  if (await domainTaken(env.DB, domain)) {
    return noStore(
      { ok: false, error: "domain_taken", message: AUDIT_LINES.domain_taken(domain) },
      env,
      409,
    );
  }
  if ((await openAudits(env.DB)) >= AUDIT_MAX_OPEN) {
    return noStore(
      {
        ok: false,
        error: "audits_full",
        message: AUDIT_LINES.audits_full_signup(operatorName(env)),
      },
      env,
      409,
    );
  }
  const emailTaken = await env.DB.prepare("SELECT id FROM superadmin_users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (emailTaken) {
    return noStore(
      {
        ok: false,
        error: "email_taken",
        message: "That email already has an account. Sign in instead.",
      },
      env,
      409,
    );
  }

  // Claim the invite first, conditionally: two racing sends make one customer.
  const claimed = await env.DB.prepare(
    `UPDATE pilot_applications SET status = 'applied', submitted_at = ?
      WHERE id = ? AND status = 'invited' AND expires_at > ? AND kind = 'audit'`,
  )
    .bind(now, row.id, now)
    .run();
  if ((claimed.meta?.changes ?? 0) === 0) return noStore({ ok: false, error: "used" }, env, 409);

  let customerId: string | null = null;
  let userId: string | null = null;
  let setupToken: string;
  try {
    const base = slugFromDomain(domain);
    for (let n = 1; n <= MAX_SLUG_TRIES && !customerId; n++) {
      const slug = slugCandidate(base, n);
      if (
        await insertCustomer(env, {
          slug,
          domain,
          plan: "audit",
          contactEmail: email,
          contactName: name,
          createdAt: now,
        })
      ) {
        customerId = slug;
      }
    }
    if (!customerId) throw new Error("No free slug");
    await env.DB.prepare(
      "UPDATE customers SET audit_terms_at = ?, audit_consent_banner = ? WHERE id = ?",
    )
      .bind(now, banner, customerId)
      .run();
    const made = await createCustomerUser(env.DB, customerId, email, now);
    if (!made) throw new Error("email taken");
    userId = made.userId;
    setupToken = made.rawToken;
    await env.DB.prepare(
      `UPDATE pilot_applications
          SET customer_id = ?, contact_name = ?, contact_email = ?, site_url = ?
        WHERE id = ?`,
    )
      .bind(customerId, name, email, url.toString(), row.id)
      .run();
    // The bundle with `a` and `ad` before the tag is on (the edge agent's
    // note): the host check holds from the first visit.
    await writeVisitorBundle(env, customerId);
  } catch (e) {
    console.error(
      `[rawuser/audit] submit failed, invite released: ${e instanceof Error ? e.name : "unknown"}`,
    );
    if (userId)
      await env.DB.prepare("DELETE FROM superadmin_users WHERE id = ?").bind(userId).run();
    if (customerId)
      await env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(customerId).run();
    await env.DB.prepare(
      "UPDATE pilot_applications SET status = 'invited', submitted_at = NULL, customer_id = NULL WHERE id = ?",
    )
      .bind(row.id)
      .run();
    return noStore({ ok: false, error: "Could not create your account, try again" }, env, 500);
  }

  // One line to the founder: the domain only (no name, no email).
  const alert = sendAlert(
    env.ALERT_WEBHOOK_URL,
    `New audit: ${domain}${dashboardPointer(env, "/applications")}`,
  );
  if (ctx) ctx.waitUntil(alert);
  else void alert;

  return noStore(
    {
      ok: true,
      customer_id: customerId,
      domain,
      setup_token: setupToken,
      tag: customerTag(tagOrigin, customerId),
      privacy_line: auditPrivacyLine(privacyAddress(env)),
    },
    env,
    201,
  );
}

/** POST /admin/audit/report/public { t }: the released snapshot; 404 for anything else. */
export async function handleAuditReportPublic(request: Request, env: AdminEnv): Promise<Response> {
  const body = await readJson(request);
  const row = body ? await reportByToken(env.DB, body.t, Date.now()) : null;
  const snap = row ? parseSnapshot(row.report) : null;
  if (!row || !snap) return noStore({ ok: false, error: "Not found" }, env, 404);
  return noStore(
    { ok: true, report: snap.report, released_at: row.released_at, expires_at: row.expires_at },
    env,
  );
}

// ---------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------

function customerParam(request: Request): string | null {
  const id = new URL(request.url).searchParams.get("customer_id");
  return id && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null;
}

/** GET /admin/audit?customer_id= */
export async function handleAuditStatus(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const id = customerParam(request);
  if (!id) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const scope = requireCustomerScope(user, id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const status = await auditStatusFor(env.DB, id, Date.now());
  if (!status) return jsonWithCors({ error: "not_an_audit" }, env, 404);
  return jsonWithCors(status, env);
}

/**
 * GET /admin/audit/report?customer_id=: a customer reads its released,
 * unrevoked report; a superadmin any built one. Never the review half.
 */
export async function handleAuditReport(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const id = customerParam(request);
  if (!id) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const scope = requireCustomerScope(user, id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const rep = await reportRow(env.DB, id);
  const snap = rep ? parseSnapshot(rep.report) : null;
  const visible =
    rep &&
    snap &&
    (user.role === "superadmin" || (rep.released_at !== null && rep.revoked_at === null));
  if (!visible || !rep || !snap) return noStore({ error: "Not found" }, env, 404);
  return noStore(
    {
      report: snap.report,
      built_at: rep.built_at,
      released_at: rep.released_at,
      expires_at: rep.expires_at,
      revoked_at: rep.revoked_at,
    },
    env,
  );
}

const RELEASE_ERRORS: Record<string, [number, string]> = {
  not_found: [404, "Not an audit"],
  not_built: [409, "The report is not built yet."],
  not_released: [409, "The report is not released yet."],
  revoked: [409, "The report link was revoked."],
  expired: [410, "The report link has expired."],
};

/** POST /admin/audit/share-link { customer_id }: a new link; the one sent before stops working. */
export async function handleAuditShareLink(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const body = await readJson(request);
  const id = body && typeof body.customer_id === "string" ? body.customer_id : null;
  if (!id) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const scope = requireCustomerScope(user, id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const r = await mintShareLink(env, id, Date.now());
  if (!r.ok) {
    const [status, message] = RELEASE_ERRORS[r.error] ?? [409, r.error];
    return noStore({ error: r.error, message }, env, status);
  }
  return noStore(
    {
      link: reportLink(env.DASHBOARD_ORIGIN, r.token),
      expires_at: r.expires_at,
      ends_at: r.ends_at,
    },
    env,
  );
}

// ---------------------------------------------------------------------------
// Superadmin
// ---------------------------------------------------------------------------

/** GET /admin/audit/summary: { open, max, invites_on } for the Applications header. */
export async function handleAuditSummary(env: AuditAdminEnv): Promise<Response> {
  return jsonWithCors(
    { open: await openAudits(env.DB), max: AUDIT_MAX_OPEN, invites_on: env.AUDIT_INVITES === "on" },
    env,
  );
}

/** GET /admin/audit/review?customer_id=: the founder's review page (§11.7). */
export async function handleAuditReview(request: Request, env: AdminEnv): Promise<Response> {
  const id = customerParam(request);
  if (!id) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const status = await auditStatusFor(env.DB, id, Date.now());
  if (!status) return jsonWithCors({ error: "not_an_audit" }, env, 404);
  const rep = await reportRow(env.DB, id);
  const snap = rep ? parseSnapshot(rep.report) : null;
  return noStore(
    {
      status,
      report: snap?.report ?? null,
      review: snap?.review ?? null,
      built_at: rep?.built_at ?? null,
      released_at: rep?.released_at ?? null,
      expires_at: rep?.expires_at ?? null,
      revoked_at: rep?.revoked_at ?? null,
      can_make_pilot: status.plan === "audit" && status.pilot_terms_at !== null,
    },
    env,
  );
}

async function superBody(
  request: Request,
  env: AdminEnv,
): Promise<{ id: string; body: Record<string, unknown> } | Response> {
  const body = await readJson(request);
  const id = body && typeof body.customer_id === "string" ? body.customer_id : null;
  if (!body || !id) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const c = await loadAuditCustomer(env.DB, id);
  if (!c || !wasAudit(c)) return jsonWithCors({ error: "not_an_audit" }, env, 404);
  return { id, body };
}

/** POST /admin/audit/build { customer_id }: rebuild before the release; 409 after. */
export async function handleAuditBuild(request: Request, env: AdminEnv): Promise<Response> {
  const p = await superBody(request, env);
  if (p instanceof Response) return p;
  const c = await loadAuditCustomer(env.DB, p.id);
  if (!c || c.audit_from === null) {
    return jsonWithCors({ error: "no_window", message: "Counting has not started." }, env, 409);
  }
  const now = Date.now();
  const end = Math.min(now, c.audit_to ?? c.audit_from + AUDIT_WINDOW_MS);
  try {
    const built = await buildAuditReport(env, p.id, { start: c.audit_from, end }, now);
    return noStore({ ok: true, state: built.report.state, built_at: now }, env);
  } catch (e) {
    if (e instanceof ReportReleasedError) {
      return jsonWithCors(
        { error: "released", message: "A released report is never rebuilt." },
        env,
        409,
      );
    }
    throw e;
  }
}

/** POST /admin/audit/release { customer_id }: the link once, the end date set. */
export async function handleAuditRelease(request: Request, env: AdminEnv): Promise<Response> {
  const p = await superBody(request, env);
  if (p instanceof Response) return p;
  const r = await releaseReport(env, p.id, Date.now());
  if (!r.ok) {
    const [status, message] = RELEASE_ERRORS[r.error] ?? [409, r.error];
    return noStore({ error: r.error, message }, env, status);
  }
  return noStore(
    {
      link: reportLink(env.DASHBOARD_ORIGIN, r.token),
      expires_at: r.expires_at,
      ends_at: r.ends_at,
    },
    env,
  );
}

/** POST /admin/audit/revoke { customer_id } */
export async function handleAuditRevoke(request: Request, env: AdminEnv): Promise<Response> {
  const p = await superBody(request, env);
  if (p instanceof Response) return p;
  const ok = await revokeReport(env, p.id, Date.now());
  if (!ok) return jsonWithCors({ error: "not_released" }, env, 409);
  return jsonWithCors({ ok: true }, env);
}

/** POST /admin/audit/end { customer_id }: End now. */
export async function handleAuditEnd(request: Request, env: AdminEnv): Promise<Response> {
  const p = await superBody(request, env);
  if (p instanceof Response) return p;
  const r = await endAudit(env, p.id, Date.now(), "end_now");
  if (!r)
    return jsonWithCors({ error: "not_running", message: "The audit is not running." }, env, 409);
  return jsonWithCors({ ok: true, ...r }, env);
}

/** POST /admin/audit/pilot-terms { customer_id, signed_at? }: the signed pilot terms recorded. */
export async function handleAuditPilotTerms(request: Request, env: AdminEnv): Promise<Response> {
  const p = await superBody(request, env);
  if (p instanceof Response) return p;
  const now = Date.now();
  const at = p.body.signed_at;
  const signedAt =
    at === undefined || at === null
      ? now
      : typeof at === "number" && Number.isFinite(at) && at > 0 && at <= now
        ? at
        : null;
  if (signedAt === null) {
    return jsonWithCors({ error: "signed_at must be unix ms, not in the future" }, env, 400);
  }
  await recordPilotTerms(env, p.id, signedAt);
  return jsonWithCors({ ok: true, pilot_terms_at: signedAt }, env);
}

/** POST /admin/audit/make-pilot { customer_id }: refused until the pilot terms (condition 5). */
export async function handleAuditMakePilot(request: Request, env: AdminEnv): Promise<Response> {
  const p = await superBody(request, env);
  if (p instanceof Response) return p;
  const r = await makePilot(env, p.id);
  if (!r.ok) {
    if (r.error === "pilot_terms_missing") {
      return jsonWithCors({ error: r.error, message: AUDIT_LINES.pilot_terms }, env, 409);
    }
    return jsonWithCors({ error: r.error }, env, r.error === "not_found" ? 404 : 409);
  }
  return jsonWithCors({ ok: true, plan: "pilot", status: "active", was_ended: r.was_ended }, env);
}
