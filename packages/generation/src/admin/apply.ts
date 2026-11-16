/**
 * Pilot apply: an invite link that collects the brief and creates the
 * customer (docs/specs/pilot-apply.md, 2026-10-01).
 *
 * Public, token-gated (routed before the session gate, like /admin/login):
 *   POST /admin/apply/invite      { t } → status of the invite
 *   POST /admin/apply/read        { t, url } → suggestions, 3 reads per token
 *   POST /admin/apply/submit      { t, url, product, icp, differentiator,
 *                                   numbers, sources[], name, email }
 *
 * Superadmin only:
 *   POST /admin/applications/invite   { name?, site?, email? } → { id, link, expires_at,
 *                                     emailed, email_error? } (docs/specs/invite-email.md)
 *   GET  /admin/applications/list     [?all=1]
 *   POST /admin/applications/archive  { id }
 *   POST /admin/applications/delete   { id } forgets the person's data
 *
 * Privacy invariants:
 *   - First-party B2B contact and company data, given by explicit action,
 *     same footing as pilot_requests (0016). Never joined to events.
 *   - The invite token is stored as its SHA-256 hex only; the raw token
 *     appears once, in the invite response. Tokens and emails are never
 *     logged.
 *   - The site read refuses private, loopback and link-local hosts on every
 *     redirect hop (lib/public-url.ts), inside the render too
 *     (lib/render-page.ts, docs/specs/install-friction.md A), and follows
 *     redirects only on the host the applicant typed (www and the apex as
 *     one); a redirect to another host answers 422 `off_host`.
 */

import type { BusinessDNA, DnaSuggestions } from "@rawuser/shared";
import { hashSessionToken } from "../auth/password.ts";
import { PageFetchError, fetchPageHtml } from "../detect-elements.ts";
import { suggestDnaFromHtml } from "../dna-suggest.ts";
import {
  EDGE_ORIGIN_MISSING,
  dashboardPointer,
  edgeOrigin,
  fetcherUserAgent,
} from "../install-config.ts";
import { sendAlert } from "../lib/alert.ts";
import { normalizeEmail, sendInviteEmail } from "../lib/invite-email.ts";
import {
  NotPublicUrlError,
  OFF_HOST_LINE,
  OffHostRedirectError,
  normalizeSiteUrl,
  publicUrlProblem,
} from "../lib/public-url.ts";
import { fetchInstallFacts, renderIfShell } from "../lib/read-page.ts";
import { tagWithheld } from "../lib/readiness.ts";
import {
  type ApplyAnswers,
  briefFromAnswers,
  normalizeSources,
  slugCandidate,
  slugFromDomain,
  trimSuggestions,
} from "./apply-brief.ts";
import { auditInviteRefusal, auditStatusFor } from "./audit.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { insertCustomer, upsertBusinessDna } from "./handlers.ts";
import { tagWithheldFor } from "./readiness.ts";
import { specialCategoryAlert } from "./special-category.ts";

export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_READS = 3;
const TOKEN_BYTES = 32;
/** The read's suggestions, kept for the submit so it does not pay twice. */
const SUGGEST_TTL_S = 14 * 24 * 60 * 60;
const MAX_SLUG_TRIES = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The tag we hand out: the customer's own script, which the edge serves at
 * /s/{id}.js (packages/edge/src/customer-script.ts) on `edgeOrigin`, the
 * install's EDGE_ORIGIN. data-cfasync="false" asks Cloudflare Rocket Loader
 * to leave it in place; every browser ignores it (founder's call 2026-10-04,
 * docs/specs/install-friction.md E3). The probe's regex accepts attributes
 * before src.
 */
export function customerTag(edgeOrigin: string, customerId: string): string {
  return `<script data-cfasync="false" src="${edgeOrigin}/s/${customerId}.js"></script>`;
}

export function applySuggestKey(applicationId: string): string {
  return `apply-suggest:${applicationId}`;
}

interface ApplicationRow {
  id: string;
  /** 'pilot' (this page) or 'audit' (docs/specs/ai-traffic-audit.md §3.1). */
  kind?: string | null;
  status: "invited" | "applied" | "archived";
  expires_at: number | null;
  invited_name: string | null;
  invited_site: string | null;
  reads: number | null;
  customer_id: string | null;
}

type Ctx = Pick<ExecutionContext, "waitUntil"> | undefined;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

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

/**
 * The invite of a token, of one kind only: a pilot token never opens the
 * audit sign-up and an audit token never opens the apply page (each reads
 * as an invalid link on the other).
 */
export async function findByToken(
  env: Pick<AdminEnv, "DB">,
  token: unknown,
  kind: "pilot" | "audit" = "pilot",
): Promise<ApplicationRow | null> {
  if (typeof token !== "string" || token === "" || token.length > 200) return null;
  const hash = await hashSessionToken(token);
  const row = await env.DB.prepare(
    `SELECT id, kind, status, expires_at, invited_name, invited_site, reads, customer_id
       FROM pilot_applications WHERE token_hash = ?`,
  )
    .bind(hash)
    .first<ApplicationRow>();
  if (!row) return null;
  return (row.kind ?? "pilot") === kind ? row : null;
}

/** An archived invite is withdrawn; to the applicant it reads as expired. */
export function isExpired(row: ApplicationRow, now: number): boolean {
  return row.status === "archived" || (row.expires_at ?? 0) <= now;
}

/** 404 / 409 / 410 for a token that cannot be used, or null when it can. */
function tokenGate(row: ApplicationRow | null, env: AdminEnv, now: number): Response | null {
  if (!row) return jsonWithCors({ ok: false, error: "Invalid invite link" }, env, 404);
  if (row.status === "applied") {
    return jsonWithCors({ ok: false, error: "This invite has already been used" }, env, 409);
  }
  if (isExpired(row, now)) {
    return jsonWithCors({ ok: false, error: "This invite has expired" }, env, 410);
  }
  return null;
}

/** Trimmed string field, or null when it is not a string. */
function field(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  return typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : null;
}

// ---------------------------------------------------------------------------
// POST /admin/apply/invite with { t }
//
// POST, not GET: the token never sits in a query string, where access logs
// and Referer headers keep it (privacy review, 2026-10-01). The link puts
// it in the fragment, which the browser never sends.
// ---------------------------------------------------------------------------

export async function handleApplyInvite(request: Request, env: AdminEnv): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonWithCors({ ok: false, error: "Invalid JSON body" }, env, 400);
  const row = await findByToken(env, body.t);
  if (!row) return jsonWithCors({ ok: false, error: "Invalid invite link" }, env, 404);
  const status =
    row.status === "applied" ? "applied" : isExpired(row, Date.now()) ? "expired" : "invited";
  // An applied invite opened again: whether the tag is still withheld
  // (readiness-check.md, condition 2), by the readiness read's rule.
  const withheld =
    status === "applied" && typeof row.customer_id === "string"
      ? await tagWithheldFor(env.DB, row.customer_id)
      : null;
  return jsonWithCors(
    {
      ok: true,
      status,
      invited_name: row.invited_name,
      invited_site: row.invited_site,
      ...(status === "applied" ? { customer_id: row.customer_id } : {}),
      ...(withheld !== null ? { tag_withheld: withheld } : {}),
    },
    env,
  );
}

// ---------------------------------------------------------------------------
// POST /admin/apply/read
// ---------------------------------------------------------------------------

export async function handleApplyRead(request: Request, env: AdminEnv): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonWithCors({ ok: false, error: "Invalid JSON body" }, env, 400);
  const now = Date.now();
  const row = await findByToken(env, body.t);
  const gate = tokenGate(row, env, now);
  if (gate || !row) return gate as Response;

  // A typo or a private host costs no read.
  const url = typeof body.url === "string" ? normalizeSiteUrl(body.url) : null;
  if (!url || publicUrlProblem(url)) {
    return jsonWithCors({ ok: false, error: "Enter your site's public address" }, env, 400);
  }

  // Count the read before the fetch, atomically, so parallel presses cannot
  // pass the limit.
  const counted = await env.DB.prepare(
    "UPDATE pilot_applications SET reads = COALESCE(reads, 0) + 1 WHERE id = ? AND COALESCE(reads, 0) < ?",
  )
    .bind(row.id, MAX_READS)
    .run();
  if ((counted.meta?.changes ?? 0) === 0) {
    return jsonWithCors({ ok: false, error: "No reads left on this invite" }, env, 429);
  }

  const giveReadBack = () =>
    env.DB.prepare(
      "UPDATE pilot_applications SET reads = MAX(COALESCE(reads, 0) - 1, 0) WHERE id = ?",
    )
      .bind(row.id)
      .run();

  let serverHtml: string;
  try {
    // The host the applicant typed, www and the apex as one: a redirect to
    // another host is never followed (the /bot page).
    serverHtml = await fetchPageHtml(url.toString(), {
      publicOnly: true,
      resolver: env.SITE_RESOLVER,
      userAgent: fetcherUserAgent(env),
    });
  } catch (e) {
    if (e instanceof NotPublicUrlError) {
      return jsonWithCors({ ok: false, error: "Enter your site's public address" }, env, 400);
    }
    // The address redirects to another host: its own code, the read given back.
    if (e instanceof OffHostRedirectError) {
      await giveReadBack();
      console.error("[rawuser/apply] read: redirect to another host, not followed");
      return jsonWithCors({ ok: false, error: "off_host", reason: OFF_HOST_LINE }, env, 422);
    }
    // The site's bot protection answered instead of the page (spec C, G3):
    // its own line, and the read is given back.
    if (e instanceof PageFetchError && e.challenge) {
      await giveReadBack();
      console.error("[rawuser/apply] read: turned away by bot protection");
      return jsonWithCors({ ok: false, error: "bot_protection" }, env, 422);
    }
    return jsonWithCors({ ok: false, error: "Could not read the site" }, env, 502);
  }

  // A page built in the browser (Vite, Lovable, v0) sends an empty shell
  // (a prospect's site, 2026-10-02: three reads burned on a 746-byte shell).
  // Browser Run renders it; still one read of the three. When the render
  // is off or fails, the read is given back and the page says so plainly:
  //   client_rendered  the render is off (BROWSER_RUN="off" or no binding)
  //   render_failed    rendered, but empty, failed or too slow
  //   bot_protection   the rendered page was a bot check (final, no solving)
  const read = await renderIfShell(serverHtml, url.toString(), env);
  if (read.render_error === "not_public") {
    return jsonWithCors({ ok: false, error: "Enter your site's public address" }, env, 400);
  }
  if (read.render_error === "off_host") {
    await giveReadBack();
    console.error("[rawuser/apply] read: the page moved to another host, not followed");
    return jsonWithCors({ ok: false, error: "off_host", reason: OFF_HOST_LINE }, env, 422);
  }
  if (read.shell) {
    await giveReadBack();
    const error =
      read.render_error === "blocked"
        ? "bot_protection"
        : read.render_error
          ? "render_failed"
          : "client_rendered";
    console.error(`[rawuser/apply] read: page built in the browser, ${error}`);
    return jsonWithCors({ ok: false, error }, env, 422);
  }
  const html = read.html;

  let suggestions: DnaSuggestions;
  try {
    suggestions = await suggestDnaFromHtml(html, url.toString(), env);
  } catch {
    console.error("[rawuser/apply] suggestion failed (non-critical)");
    return jsonWithCors({ ok: false, error: "Could not read the site" }, env, 502);
  }
  await env.VARIANTS.put(applySuggestKey(row.id), JSON.stringify(suggestions), {
    expirationTtl: SUGGEST_TTL_S,
  });
  return jsonWithCors(
    { ok: true, suggestions: trimSuggestions(suggestions), source: read.source },
    env,
  );
}

// ---------------------------------------------------------------------------
// POST /admin/apply/submit
// ---------------------------------------------------------------------------

const LIMITS = { product: 300, icp: 300, differentiator: 300, numbers: 500, name: 100 } as const;

/** The suggestions read for this site, or one fresh read; null when neither works. */
async function suggestionsFor(
  env: AdminEnv,
  applicationId: string,
  url: URL,
): Promise<DnaSuggestions | null> {
  const cached = await env.VARIANTS.get(applySuggestKey(applicationId));
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as DnaSuggestions;
      if (new URL(parsed.url).hostname === url.hostname) return parsed;
    } catch {
      // fall through to a fresh read
    }
  }
  try {
    const serverHtml = await fetchPageHtml(url.toString(), {
      publicOnly: true,
      resolver: env.SITE_RESOLVER,
      userAgent: fetcherUserAgent(env),
    });
    // A shell is rendered, same rules as the read (spec A); a failed render
    // leaves the shell and the brief comes from the answers.
    const read = await renderIfShell(serverHtml, url.toString(), env);
    if (read.shell) return null;
    return await suggestDnaFromHtml(read.html, url.toString(), env);
  } catch {
    console.error("[rawuser/apply] submit read failed, brief from answers only (non-critical)");
    return null;
  }
}

/** Inserts the customer under the first free slug; returns its id. */
async function createCustomer(
  env: AdminEnv,
  domain: string,
  contactName: string,
  contactEmail: string,
  now: number,
): Promise<string> {
  const base = slugFromDomain(domain);
  for (let n = 1; n <= MAX_SLUG_TRIES; n++) {
    const slug = slugCandidate(base, n);
    const inserted = await insertCustomer(env, {
      slug,
      domain,
      plan: "pilot",
      contactEmail,
      contactName,
      createdAt: now,
    });
    if (inserted) return slug;
  }
  throw new Error("No free slug");
}

export async function handleApplySubmit(
  request: Request,
  env: AdminEnv,
  ctx?: Ctx,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonWithCors({ ok: false, error: "Invalid JSON body" }, env, 400);
  // The answer carries the tag. Without the edge's origin there is none to
  // print, so nothing is created and the invite is not used.
  const tagOrigin = edgeOrigin(env);
  if (!tagOrigin) return jsonWithCors({ ok: false, error: EDGE_ORIGIN_MISSING }, env, 503);
  const now = Date.now();
  const row = await findByToken(env, body.t);
  const gate = tokenGate(row, env, now);
  if (gate || !row) return gate as Response;

  const product = field(body, "product");
  const icp = field(body, "icp");
  const differentiator = field(body, "differentiator");
  const numbers = field(body, "numbers");
  const name = field(body, "name");
  const email = field(body, "email");
  const rawUrl = field(body, "url");
  const sources = normalizeSources(body.sources);
  // The special-category question (readiness-check.md, check 3), asked on
  // the form before the tag. Absent on an older form: unanswered, stored as
  // NULL, and the dashboard asks again on Connect.
  const specialCategory = body.special_category;
  // The field travels back so the page can mark it; the log names the field
  // only, never what was typed (2026-10-02: an applicant saw "something is
  // missing" with no field marked and could not finish).
  const bad = (error: string, f: string) => {
    console.error(`[rawuser/apply] submit refused: ${f}`);
    return jsonWithCors({ ok: false, error, field: f }, env, 400);
  };
  if (specialCategory !== undefined && typeof specialCategory !== "boolean") {
    return bad("special_category must be true or false", "special_category");
  }

  if (!product) return bad("product is required", "product");
  if (!icp) return bad("icp is required", "icp");
  if (!name) return bad("name is required", "name");
  if (!email) return bad("email is required", "email");
  if (!rawUrl) return bad("url is required", "url");
  if (differentiator === null) return bad("Invalid field", "differentiator");
  if (numbers === null) return bad("Invalid field", "numbers");
  if (product.length > LIMITS.product)
    return bad(`product must be ≤ ${LIMITS.product} chars`, "product");
  if (icp.length > LIMITS.icp) return bad(`icp must be ≤ ${LIMITS.icp} chars`, "icp");
  if (differentiator.length > LIMITS.differentiator) {
    return bad(`differentiator must be ≤ ${LIMITS.differentiator} chars`, "differentiator");
  }
  if (numbers.length > LIMITS.numbers)
    return bad(`numbers must be ≤ ${LIMITS.numbers} chars`, "numbers");
  if (name.length > LIMITS.name) return bad(`name must be ≤ ${LIMITS.name} chars`, "name");
  if (email.length > 320 || !EMAIL_RE.test(email))
    return bad("email must be a valid address", "email");
  if (!sources) return bad("sources must be up to 10 of the listed sources", "sources");
  const url = normalizeSiteUrl(rawUrl);
  if (!url || publicUrlProblem(url)) return bad("Enter your site's public address", "url");

  // Claim the invite first, conditionally, so two submits racing cannot
  // both create a customer. Released again if anything below fails.
  const claimed = await env.DB.prepare(
    `UPDATE pilot_applications SET status = 'applied', submitted_at = ?
      WHERE id = ? AND status = 'invited' AND expires_at > ?`,
  )
    .bind(now, row.id, now)
    .run();
  if ((claimed.meta?.changes ?? 0) === 0) {
    return jsonWithCors({ ok: false, error: "This invite has already been used" }, env, 409);
  }

  const answers: ApplyAnswers = { product, icp, differentiator, numbers, sources };
  const domain = url.hostname.toLowerCase().replace(/\.$/, "");
  let customerId: string | null = null;
  try {
    const suggestions = await suggestionsFor(env, row.id, url);
    customerId = await createCustomer(env, domain, name, email, now);
    if (typeof specialCategory === "boolean") {
      await env.DB.prepare(
        "UPDATE customers SET special_category = ?, special_category_at = ? WHERE id = ?",
      )
        .bind(specialCategory ? 1 : 0, now, customerId)
        .run();
    }
    const brief: BusinessDNA = briefFromAnswers(customerId, answers, suggestions, now);
    await upsertBusinessDna(env, brief, { draft: true });
    await env.DB.prepare(
      `UPDATE pilot_applications
          SET customer_id = ?, contact_name = ?, contact_email = ?, site_url = ?, answers = ?
        WHERE id = ?`,
    )
      .bind(customerId, name, email, url.toString(), JSON.stringify(answers), row.id)
      .run();
  } catch (e) {
    console.error(
      `[rawuser/apply] submit failed, invite released: ${e instanceof Error ? e.name : "unknown"}`,
    );
    // Undo a half-made customer so a retry gets the same slug, then give
    // the invite back.
    if (customerId) {
      await env.DB.prepare("DELETE FROM business_dna WHERE customer_id = ?").bind(customerId).run();
      await env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(customerId).run();
    }
    await env.DB.prepare(
      "UPDATE pilot_applications SET status = 'invited', submitted_at = NULL, customer_id = NULL WHERE id = ?",
    )
      .bind(row.id)
      .run();
    return jsonWithCors({ ok: false, error: "Could not create your account, try again" }, env, 500);
  }
  await env.VARIANTS.delete(applySuggestKey(row.id));

  // One line to the founder, fire-and-forget: the domain and where to look.
  // No name, no email; Telegram is a third party (privacy review,
  // 2026-10-01).
  const alert = sendAlert(
    env.ALERT_WEBHOOK_URL,
    `New pilot application: ${domain}${dashboardPointer(env, "/applications")}`,
  );
  if (ctx) ctx.waitUntil(alert);
  else void alert;
  // A yes: one more line, the domain and the words "special category" only
  // (readiness-check.md, privacy review condition 1). The founder marks the site.
  if (specialCategory === true) {
    const note = sendAlert(env.ALERT_WEBHOOK_URL, specialCategoryAlert(customerId, domain));
    if (ctx) ctx.waitUntil(note);
    else void note;
  }

  // The done screen names the platform and, when the policy would block the
  // tag, shows the lines (spec G6). Rebuilt from the site's public headers,
  // never stored. Null when the page cannot be read: the plain steps show.
  const install = await fetchInstallFacts(url, customerId, env);

  // The tag is withheld (readiness-check.md, condition 2) while the answer
  // is a yes nobody has marked, or missing: the dashboard holds it on the
  // done screen and on Connect. The tag itself still rides in the answer
  // for a form from before the question, which cannot send a yes.
  const withheld = tagWithheld({
    liveAt: null,
    sensitive: false,
    specialCategory: typeof specialCategory === "boolean" ? specialCategory : null,
  });
  return jsonWithCors(
    {
      ok: true,
      customer_id: customerId,
      tag: customerTag(tagOrigin, customerId),
      tag_withheld: withheld,
      install,
    },
    env,
  );
}

// ---------------------------------------------------------------------------
// Superadmin
// ---------------------------------------------------------------------------

/**
 * POST /admin/applications/invite with { name?, site?, kind? }. kind
 * 'audit' mints the free audit's link (docs/specs/ai-traffic-audit.md §3.1):
 * refused while AUDIT_INVITES is not "on" (privacy review condition 8: not before
 * the sign-in protection is deployed) and while ten audits are open.
 *
 * email (pilot only, optional): the link is also sent to that address, once
 * (docs/specs/invite-email.md). The address is used in memory for the one
 * send and stored nowhere; the answer says `emailed` and, on a failure, one
 * `email_error` word. The link is returned either way.
 */
export async function handleApplicationsInvite(
  request: Request,
  env: AdminEnv,
  account: { id: string },
): Promise<Response> {
  const body = (await readJson(request)) ?? {};
  const name = field(body, "name");
  const site = field(body, "site");
  const kind = body.kind === undefined || body.kind === null ? "pilot" : body.kind;
  if (kind !== "pilot" && kind !== "audit") {
    return jsonWithCors({ error: "kind must be 'pilot' or 'audit'" }, env, 400);
  }
  const emailGiven = body.email !== undefined && body.email !== null && body.email !== "";
  const email = emailGiven ? normalizeEmail(body.email) : null;
  if (emailGiven && email === null) {
    return jsonWithCors({ error: "email must be one valid address" }, env, 400);
  }
  if (email !== null && kind !== "pilot") {
    return jsonWithCors({ error: "email is for pilot invites only" }, env, 400);
  }
  if (kind === "audit") {
    const refused = await auditInviteRefusal(env);
    if (refused) return jsonWithCors(refused.body, env, refused.status);
  }
  if (name === null || name.length > 100) {
    return jsonWithCors({ error: "name must be ≤ 100 chars" }, env, 400);
  }
  if (site === null || site.length > 300) {
    return jsonWithCors({ error: "site must be ≤ 300 chars" }, env, 400);
  }

  const token = base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const tokenHash = await hashSessionToken(token);
  const id = `app_${crypto.randomUUID()}`;
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO pilot_applications
       (id, token_hash, status, created_at, expires_at, invited_name, invited_site, reads, kind)
     VALUES (?, ?, 'invited', ?, ?, ?, ?, 0, ?)`,
  )
    .bind(id, tokenHash, now, expiresAt, name || null, site || null, kind)
    .run();

  const origin =
    env.DASHBOARD_ORIGIN && env.DASHBOARD_ORIGIN !== "*"
      ? env.DASHBOARD_ORIGIN
      : "http://localhost:3000";
  const page = kind === "audit" ? "audit" : "apply";
  const link = `${origin}/${page}/#t=${token}`;
  const sent =
    email === null
      ? { emailed: false as const }
      : await sendInviteEmail(env, account.id, email, { link, expiresAt, site: site || null });
  return jsonWithCors({ id, kind, link, expires_at: expiresAt, ...sent }, env);
}

interface ListRow {
  id: string;
  kind: string;
  status: string;
  invited_name: string | null;
  invited_site: string | null;
  created_at: number;
  expires_at: number | null;
  submitted_at: number | null;
  contact_name: string | null;
  contact_email: string | null;
  site_url: string | null;
  customer_id: string | null;
  answers: string | null;
  tag_seen_at: number | null;
  live_at: number | null;
}

/** GET /admin/applications/list[?all=1]: newest first, archived hidden by default. */
export async function handleApplicationsList(request: Request, env: AdminEnv): Promise<Response> {
  const all = new URL(request.url).searchParams.get("all") === "1";
  const result = await env.DB.prepare(
    `SELECT a.id, a.kind, a.status, a.invited_name, a.invited_site, a.created_at, a.expires_at,
            a.submitted_at, a.contact_name, a.contact_email, a.site_url, a.customer_id,
            a.answers, c.tag_seen_at, c.live_at
       FROM pilot_applications a
       LEFT JOIN customers c ON c.id = a.customer_id
      ${all ? "" : "WHERE a.status != 'archived'"}
      ORDER BY a.created_at DESC
      LIMIT 200`,
  ).all<ListRow>();
  const now = Date.now();
  const rows = [];
  for (const r of result.results ?? []) {
    let answers: unknown = null;
    try {
      answers = r.answers ? JSON.parse(r.answers) : null;
    } catch {
      answers = null;
    }
    // An audit row carries its state, caps and dates (the mock's Status and
    // Spend columns); never a number by source.
    const audit =
      r.kind === "audit" && r.customer_id ? await auditStatusFor(env.DB, r.customer_id, now) : null;
    rows.push({
      ...r,
      kind: r.kind ?? "pilot",
      answers,
      tag_seen_at: r.tag_seen_at ?? null,
      live_at: r.live_at ?? null,
      audit,
    });
  }
  return jsonWithCors(rows, env);
}

/** POST /admin/applications/archive with { id } */
export async function handleApplicationsArchive(
  request: Request,
  env: AdminEnv,
): Promise<Response> {
  const body = await readJson(request);
  const id = body && typeof body.id === "string" ? body.id : "";
  if (!id.startsWith("app_")) {
    return jsonWithCors({ error: "Expected { id: 'app_…' }" }, env, 400);
  }
  // archived_at starts the 90-day clock; archiving twice keeps the first.
  const result = await env.DB.prepare(
    "UPDATE pilot_applications SET status = 'archived', archived_at = COALESCE(archived_at, ?) WHERE id = ?",
  )
    .bind(Date.now(), id)
    .run();
  if ((result.meta?.changes ?? 0) === 0) {
    return jsonWithCors({ error: "No application with that id" }, env, 404);
  }
  return jsonWithCors({ ok: true, id, status: "archived" }, env);
}

// ---------------------------------------------------------------------------
// Deletion and retention (privacy review conditional pass, 2026-10-01)
// ---------------------------------------------------------------------------

/** An invite nobody used is deleted this long after it expired. */
export const UNUSED_INVITE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** An archived application keeps its contact and answers this long. */
export const ARCHIVED_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Removes what a person gave us on the apply page: the contact, the
 * answers, the site, the founder's label, the cached site read, and the
 * contact copied onto the customers row. The row itself stays (id,
 * status, dates, customer_id) so the funnel counts still add up.
 * Returns false when no application has that id.
 */
export async function forgetApplication(
  env: Pick<AdminEnv, "DB" | "VARIANTS">,
  id: string,
): Promise<boolean> {
  const row = await env.DB.prepare("SELECT customer_id FROM pilot_applications WHERE id = ?")
    .bind(id)
    .first<{ customer_id: string | null }>();
  if (!row) return false;
  await env.DB.prepare(
    `UPDATE pilot_applications
        SET contact_name = NULL, contact_email = NULL, answers = NULL,
            site_url = NULL, invited_name = NULL
      WHERE id = ?`,
  )
    .bind(id)
    .run();
  await env.VARIANTS.delete(applySuggestKey(id));
  if (row.customer_id) {
    await env.DB.prepare(
      "UPDATE customers SET contact_name = NULL, contact_email = NULL WHERE id = ?",
    )
      .bind(row.customer_id)
      .run();
  }
  return true;
}

/** POST /admin/applications/delete with { id } */
export async function handleApplicationsDelete(request: Request, env: AdminEnv): Promise<Response> {
  const body = await readJson(request);
  const id = body && typeof body.id === "string" ? body.id : "";
  if (!id.startsWith("app_")) {
    return jsonWithCors({ error: "Expected { id: 'app_…' }" }, env, 400);
  }
  if (!(await forgetApplication(env, id))) {
    return jsonWithCors({ error: "No application with that id" }, env, 404);
  }
  return jsonWithCors({ ok: true, id }, env);
}

/**
 * The 6-hour cron's retention pass: unused invites 30 days past expiry are
 * deleted, archived applications 90 days past archived_at are forgotten.
 */
export async function sweepApplications(
  env: Pick<AdminEnv, "DB" | "VARIANTS">,
  now: number,
): Promise<{ deleted: number; forgotten: number }> {
  const stale = await env.DB.prepare(
    "SELECT id FROM pilot_applications WHERE status = 'invited' AND expires_at < ?",
  )
    .bind(now - UNUSED_INVITE_KEEP_MS)
    .all<{ id: string }>();
  for (const { id } of stale.results ?? []) {
    await env.DB.prepare("DELETE FROM pilot_applications WHERE id = ?").bind(id).run();
    await env.VARIANTS.delete(applySuggestKey(id));
  }
  const old = await env.DB.prepare(
    `SELECT id FROM pilot_applications
      WHERE status = 'archived' AND archived_at < ?
        AND (contact_name IS NOT NULL OR contact_email IS NOT NULL OR answers IS NOT NULL
             OR site_url IS NOT NULL OR invited_name IS NOT NULL)`,
  )
    .bind(now - ARCHIVED_KEEP_MS)
    .all<{ id: string }>();
  for (const { id } of old.results ?? []) await forgetApplication(env, id);
  return { deleted: stale.results?.length ?? 0, forgotten: old.results?.length ?? 0 };
}

// ---------------------------------------------------------------------------
// The first run keeps the applicant's answers
// ---------------------------------------------------------------------------

/**
 * The brief of a customer created by the apply page, or null. The
 * quickstart chain drafts the brief from the captured page for "/"; for an
 * applied customer that would overwrite what they wrote, so it keeps these
 * answers and fills only what they left empty.
 */
export async function loadApplicationBrief(
  env: Pick<AdminEnv, "DB">,
  customerId: string,
): Promise<BusinessDNA | null> {
  const row = await env.DB.prepare(
    `SELECT b.customer_id, b.product, b.icp, b.brand_voice, b.value_props, b.differentiators,
            b.proof_points, b.target_market, b.target_language
       FROM business_dna b
      WHERE b.customer_id = ?
        AND EXISTS (SELECT 1 FROM pilot_applications a
                    WHERE a.customer_id = b.customer_id AND a.kind = 'pilot')`,
  )
    .bind(customerId)
    .first<Record<string, string | null>>();
  if (!row) return null;
  try {
    return {
      customer_id: customerId,
      product: row.product ?? "",
      icp: row.icp ?? "",
      brand_voice: row.brand_voice ?? "",
      value_props: JSON.parse(row.value_props ?? "[]") as string[],
      differentiators: JSON.parse(row.differentiators ?? "[]") as string[],
      proof_points: JSON.parse(row.proof_points ?? "[]") as string[],
      target_market: row.target_market ?? "",
      target_language: row.target_language ?? "en",
      per_intent_hints: {},
      updated_at: Date.now(),
    };
  } catch {
    return null;
  }
}

/** The drafted brief with the applicant's answers on top; gaps they answered are closed. */
export function mergeApplicationBrief(
  drafted: BusinessDNA,
  gaps: string[],
  applied: BusinessDNA,
): { brief: BusinessDNA; gaps: string[] } {
  const pick = <T>(mine: T, theirs: T, empty: (v: T) => boolean): T =>
    empty(mine) ? theirs : mine;
  const emptyStr = (v: string | undefined) => !v || v.trim() === "";
  const emptyList = (v: string[]) => v.length === 0;
  const brief: BusinessDNA = {
    ...drafted,
    product: pick(applied.product, drafted.product, emptyStr),
    icp: pick(applied.icp, drafted.icp, emptyStr),
    value_props: pick(applied.value_props, drafted.value_props, emptyList),
    differentiators: pick(applied.differentiators, drafted.differentiators, emptyList),
    proof_points: pick(applied.proof_points, drafted.proof_points, emptyList),
    brand_voice: pick(applied.brand_voice, drafted.brand_voice, emptyStr),
    target_market: pick(applied.target_market, drafted.target_market, emptyStr),
  };
  const answered = new Set(
    [
      emptyStr(applied.product) ? null : "product",
      emptyStr(applied.icp) ? null : "icp",
      emptyList(applied.value_props) ? null : "value_props",
    ].filter((g): g is string => g !== null),
  );
  return { brief, gaps: gaps.filter((g) => !answered.has(g)) };
}
