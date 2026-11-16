/**
 * Snippet liveness probe — F17 fix.
 *
 * Runs offline (cron-initiated or operator-triggered). Never in the visitor path.
 *
 * For each active customer the probe:
 *   1. Fetches the customer's public landing page (server-to-server).
 *   2. Checks whether the Rawuser snippet tag is present in the HTML.
 *   3. Reads MAX(events.ts) from D1 to know when the last real visit fired.
 *   4. Derives a discrete status and UPSERTs snippet_status.
 *
 * Status derivation:
 *   !snippet_in_html              → "removed"
 *   snippet_in_html, no events    → "never"
 *   snippet_in_html, event <24h   → "active"
 *   snippet_in_html, event >=24h  → "stale"
 *
 * Privacy invariants:
 *   - Probe is server-to-server against a public URL supplied by the operator.
 *   - HTML body is read only to substring-search for the snippet tag; never
 *     written to D1, KV, or any log. The two-part tag's pasted style is
 *     hashed where it is found and dropped: only a state word, that hash and
 *     a policy word are stored (faster-tag.md step 6, privacy review condition 2).
 *   - On failure, only a constant error string + 8-char SHA-1 prefix of the
 *     URL is logged — enough to correlate incidents without leaking the URL.
 *     See the identical pattern in packages/generation/src/detect-elements.ts.
 *   - No visitor data involved at any point.
 *
 * Host rule:
 *   The read follows redirects only on the customer's recorded host (www and
 *   the apex count as one site). A redirect to another host is never
 *   followed: the status is "unknown", read "off_host", with a plain reason.
 *
 * Rhythm (runSnippetProbe, called from the hourly cron in index.ts; the
 * rule is written in migrations/0038_probe_rhythm.sql and on the /bot page):
 *   - every 6 hours while the check found the tag in the last 7 days, or the
 *     customer was added in the last 7 days;
 *   - otherwise once a week (a removed tag, a tag never installed, a site
 *     that turns the read away). A reinstall shows within a week, and at
 *     once when the customer presses the check on the Connect screen
 *     (probeSingleCustomer always runs and records the find).
 */

import { siteOrigin } from "@rawuser/shared";
import { type InstallEnv, edgeOrigins, fetcherUserAgent } from "../install-config.ts";
import { sendAlert } from "../lib/alert.ts";
import { type PrePolicy, prePolicy } from "../lib/csp.ts";
import {
  type InstallFacts,
  installFacts,
  parseStoredVerdict,
  storedInstallFacts,
  verdictBlocks,
} from "../lib/install-facts.ts";
import {
  type PreState,
  currentPasteStyle,
  findPrePaste,
  preStateOf,
  storedPreFacts,
} from "../lib/pre-paste.ts";
import { OFF_HOST_LINE, OffHostRedirectError, fetchOnHost, siteHost } from "../lib/public-url.ts";
import { looksLikeChallenge } from "../lib/render-page.ts";
import { tagPatterns } from "../lib/tag-position.ts";

/** With the edge origins (the tags to look for) and the fetcher's user agent. */
export interface ProbeEnv
  extends Pick<InstallEnv, "EDGE_ORIGIN" | "EDGE_ORIGIN_ALIASES" | "BOT_INFO_URL"> {
  DB: D1Database;
  ENVIRONMENT?: string;
  /** Ops channel for the csp-blocks alert; log-only when absent. */
  ALERT_WEBHOOK_URL?: string;
}

export type SnippetStatus = "active" | "stale" | "removed" | "never" | "unknown";

/**
 * How the page read went: read, turned away by bot protection (spec C),
 * redirected to another host (never followed), or failed.
 */
export type ProbeRead = "ok" | "bot_protection" | "off_host" | "failed";

export interface ProbeResult {
  status: SnippetStatus;
  reason: string;
  /** Which tag form was found; null when none or the fetch failed. */
  tag_form?: TagForm;
  read?: ProbeRead;
  /** The path that was probed ("/" for the cron). */
  page_path?: string;
  /**
   * Platform, hosting, tag position and the CSP verdict with its lines
   * (docs/specs/install-friction.md, B and D); null when the page could not
   * be read. The lines are rebuilt on every probe and never stored.
   */
  install?: InstallFacts | null;
  /** The tag has run on this site: a capture landed or an event arrived (the probe is a hint, this is proof). */
  tag_runs?: boolean;
  /**
   * The two-part tag's pasted style on the page (docs/specs/faster-tag.md
   * step 6); null when the page could not be read. `lines` carry the site's
   * own sources and are rebuilt on every read, never stored; only `state`,
   * the found paste's hash and `policy` are (condition 2).
   */
  pre?: { state: PreState; policy: PrePolicy; lines: string[] } | null;
}

/**
 * Maximum bytes to read from the response body.
 * Landing pages are typically 50-200KB. We stop reading after 200KB so a
 * gigantic response (CDN mis-config, etc.) can't OOM the worker.
 */
const HTML_CAP_BYTES = 200 * 1024;

/** Probe timeout — 10s per the spec. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * The tag we look for (lib/tag-position.ts): a script whose src is the
 * snippet on the edge's origin, on an older origin the same worker still
 * serves (EDGE_ORIGIN_ALIASES), or on the workers.dev origin, carrying
 * THIS customer's id. A tag for another customer, or one whose id was
 * edited by hand, counts as not installed: the visitor path would call
 * /select for the wrong customer.
 */
export type TagCheck = "found" | "other-customer" | "missing";
/** Which tag form carried this customer's id: the per-customer script or the older generic tag. */
export type TagForm = "script" | "generic" | null;

/** Exported for tests and for the on-demand verify on the Connect screen. */
export function checkTag(html: string, customerId: string, origins: readonly string[]): TagCheck {
  return checkTagWithForm(html, customerId, origins).check;
}

/** As checkTag, and says which form carried the id (the older one has no quiet swap). */
export function checkTagWithForm(
  html: string,
  customerId: string,
  origins: readonly string[],
): { check: TagCheck; form: TagForm } {
  const patterns = tagPatterns(origins);
  let sawOurScript = false;
  for (const m of html.matchAll(patterns.customerScript)) {
    sawOurScript = true;
    if (m[1] === customerId) return { check: "found", form: "script" };
  }
  for (const m of html.matchAll(patterns.snippet)) {
    sawOurScript = true;
    const tag = m[0];
    const id = /\bdata-customer-id\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (id === customerId) return { check: "found", form: "generic" };
  }
  return { check: sawOurScript ? "other-customer" : "missing", form: null };
}

/** How long (ms) before we consider a customer "stale" (24h). */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Between two checks of a customer whose tag was found lately: a removed tag shows within 6 h. */
export const PROBE_INTERVAL_MS = 6 * HOUR_MS;
/**
 * Between two checks once the tag has not been found for FOUND_WINDOW_MS.
 * One hour under a week, so the hourly cron reads within 7 days.
 */
export const WEEKLY_INTERVAL_MS = 7 * DAY_MS - HOUR_MS;
/** How long without a find before the check drops to weekly. */
export const FOUND_WINDOW_MS = 7 * DAY_MS;

/**
 * The gap the cron keeps for one customer: 6 hours while the tag was found
 * in the last 7 days, or (never found) the customer was added in the last 7
 * days; a week otherwise. Pure, for tests and for the /bot page's claim.
 */
export function probeInterval(
  row: { tag_found_at: number | null; created_at: number | null },
  now: number,
): number {
  const since = row.tag_found_at ?? row.created_at;
  if (since === null || !Number.isFinite(since)) return WEEKLY_INTERVAL_MS;
  return now - since < FOUND_WINDOW_MS ? PROBE_INTERVAL_MS : WEEKLY_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// SHA-1 prefix for privacy-safe logging
// ---------------------------------------------------------------------------

/**
 * Returns the first 8 hex characters of a SHA-1 digest of the input string.
 * Correlates log entries without leaking the actual URL.
 */
async function sha1Prefix(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

// ---------------------------------------------------------------------------
// Core probe logic
// ---------------------------------------------------------------------------

/** The probe's read of the page: up to HTML_CAP_BYTES of HTML and the final response's headers. */
export interface ProbeFetch {
  html: string;
  headers: Headers | null;
  /** The URL after redirects (frames and 'self' are checked against it). */
  finalUrl: string;
}

/** The page answered, but with a bot check instead of the site (spec C). */
export class BotProtectionError extends Error {
  constructor() {
    super("Probe turned away by bot protection");
    this.name = "BotProtectionError";
  }
}

async function readCapped(resp: Response, cap: number): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    totalBytes += value.byteLength;
    if (totalBytes >= cap) {
      await reader.cancel();
      break;
    }
  }
  const all = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * Fetch a URL (with cap + timeout) and return truncated text and headers.
 * Redirects are followed by hand and only on `host` (www and the apex as
 * one); a hop to another host throws OffHostRedirectError and is never
 * fetched. Throws on HTTP errors or timeout, BotProtectionError on a
 * challenge. Logs only a SHA-1 prefix on failure.
 */
async function fetchHtmlSafe(url: string, host: string, userAgent: string): Promise<ProbeFetch> {
  const parsed = new URL(url); // throws on malformed
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs supported");
  }

  let resp: Response;
  let finalUrl = url;
  try {
    const read = await fetchOnHost(
      parsed,
      {
        headers: { "User-Agent": userAgent },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
      host,
      false,
    );
    resp = read.resp;
    finalUrl = read.finalUrl.toString();
  } catch (err) {
    const urlId = await sha1Prefix(url);
    if (err instanceof OffHostRedirectError) {
      console.error(`[rawuser/probe] redirect to another host, not followed url_id=${urlId}`);
      throw err;
    }
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      console.error(`[rawuser/probe] fetch timeout (non-critical) url_id=${urlId}`);
      throw new Error("Probe fetch timed out");
    }
    console.error(`[rawuser/probe] fetch network error (non-critical) url_id=${urlId}`);
    throw err;
  }

  const headers = (resp.headers as Headers | undefined) ?? null;
  if (!resp.ok) {
    const urlId = await sha1Prefix(url);
    const body = resp.status === 503 ? await readCapped(resp, 64 * 1024).catch(() => "") : "";
    if (looksLikeChallenge({ status: resp.status, headers, html: body })) {
      console.error(`[rawuser/probe] bot protection (non-critical) url_id=${urlId}`);
      throw new BotProtectionError();
    }
    console.error(`[rawuser/probe] HTTP ${resp.status} (non-critical) url_id=${urlId}`);
    throw new Error(`HTTP ${resp.status} from customer URL`);
  }

  const html = await readCapped(resp, HTML_CAP_BYTES);
  // A challenge page can answer 200 too (Cloudflare's managed challenge on some plans).
  if (looksLikeChallenge({ headers, html: html.slice(0, 64 * 1024) })) {
    const urlId = await sha1Prefix(url);
    console.error(`[rawuser/probe] bot protection (non-critical) url_id=${urlId}`);
    throw new BotProtectionError();
  }
  return { html, headers, finalUrl };
}

/**
 * Derive status from probe + event signal.
 * This is the single source of truth for the status machine.
 */
function deriveStatus(
  tag: TagCheck,
  lastEventAt: number | null,
  now: number,
): { status: SnippetStatus; reason: string } {
  if (tag === "missing") {
    return { status: "removed", reason: "Snippet tag not found in page HTML" };
  }
  if (tag === "other-customer") {
    return { status: "removed", reason: "Snippet tag found, but with another customer id" };
  }
  if (lastEventAt === null) {
    return { status: "never", reason: "Snippet present but no events recorded yet" };
  }
  const age = now - lastEventAt;
  if (age < STALE_THRESHOLD_MS) {
    return {
      status: "active",
      reason: `Last event ${Math.floor(age / 60_000)}m ago`,
    };
  }
  return {
    status: "stale",
    reason: `Last event ${Math.floor(age / 3_600_000)}h ago (threshold 24h)`,
  };
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/** "/pricing" style path, or "/" when absent or not a plain path. */
function probePath(input: string | undefined): string {
  if (!input || typeof input !== "string") return "/";
  const p = input.trim();
  if (!p.startsWith("/") || p.startsWith("//") || p.length > 512 || /[\s#?\\]/.test(p)) return "/";
  return p;
}

interface CustomerFacts {
  live_at: number | null;
  tag_seen_at: number | null;
  plan: string | null;
}

/**
 * Probe a single customer and return the derived status.
 * Used by the /admin/snippet-status/probe endpoint for on-demand operator debugging.
 *
 * Always runs regardless of last_probed_at (the caller is deliberately triggering it).
 * `pagePath` probes the page being connected (spec G4); the cron probes "/".
 */
export async function probeSingleCustomer(
  customer: { id: string; domain: string },
  env: ProbeEnv,
  options: { pagePath?: string } = {},
): Promise<ProbeResult> {
  const now = Date.now();
  const pagePath = probePath(options.pagePath);

  // The site's address from its recorded domain: https, or http for a site
  // on this machine or one typed with http (shared/site-address.ts).
  const base = siteOrigin(customer.domain);
  const url = pagePath === "/" ? base : `${base}${pagePath}`;

  // Query last event, the customer's funnel stamps and the previous verdict.
  const eventRow = await env.DB.prepare(
    "SELECT MAX(ts) AS last_event_at FROM events WHERE customer_id = ?",
  )
    .bind(customer.id)
    .first<{ last_event_at: number | null }>();
  const lastEventAt = eventRow?.last_event_at ?? null;
  const facts = await env.DB.prepare(
    "SELECT live_at, tag_seen_at, plan FROM customers WHERE id = ?",
  )
    .bind(customer.id)
    .first<CustomerFacts>();
  const previous = await env.DB.prepare(
    "SELECT csp_verdict, csp_blocks_since FROM snippet_status WHERE customer_id = ?",
  )
    .bind(customer.id)
    .first<{ csp_verdict: string | null; csp_blocks_since: number | null }>();
  const tagRuns = (facts?.tag_seen_at ?? null) !== null || lastEventAt !== null;

  // Fetch + check snippet tag.
  let tag: TagCheck = "missing";
  let tagForm: TagForm = null;
  let read: ProbeRead = "ok";
  let install: InstallFacts | null = null;
  let pre: { state: PreState; hash: string | null; policy: PrePolicy; lines: string[] } | null =
    null;
  // The paste the dashboard hands out now, from the confirmed manifests.
  // Only its hash is read here, so no edge origin is needed for it.
  const paste = await currentPasteStyle(env.DB, customer.id);
  const origins = edgeOrigins(env);
  try {
    const page = await fetchHtmlSafe(
      url,
      siteHost(customer.domain) || new URL(url).hostname,
      fetcherUserAgent(env),
    );
    const found = checkTagWithForm(page.html, customer.id, origins);
    tag = found.check;
    tagForm = found.form;
    let pageUrl: URL;
    try {
      pageUrl = new URL(page.finalUrl);
    } catch {
      pageUrl = new URL(url);
    }
    install = installFacts({
      html: page.html,
      headers: page.headers,
      pageUrl,
      customerId: customer.id,
      edgeOrigins: origins,
      tagRuns,
    });
    // Hashes only: the pasted text is hashed where it is found and dropped.
    const pasted = await findPrePaste(page.html);
    const seen = preStateOf(pasted, paste?.hash ?? null);
    const policy = prePolicy({
      headers: page.headers,
      html: page.html,
      foundHash: seen.hash,
      foundNonce: pasted.nonce,
      currentHash: paste?.hash ?? null,
    });
    pre = { state: seen.state, hash: seen.hash, policy: policy.policy, lines: policy.lines };
  } catch (e) {
    // Fetch failed — we still upsert with status=unknown.
    read =
      e instanceof BotProtectionError
        ? "bot_protection"
        : e instanceof OffHostRedirectError
          ? "off_host"
          : "failed";
  }
  const snippetInHtml = tag === "found";

  const { status, reason } =
    read === "ok"
      ? deriveStatus(tag, lastEventAt, now)
      : read === "bot_protection"
        ? {
            status: "unknown" as SnippetStatus,
            reason: "Probe turned away by the site's bot protection; status unknown",
          }
        : read === "off_host"
          ? { status: "unknown" as SnippetStatus, reason: OFF_HOST_LINE }
          : { status: "unknown" as SnippetStatus, reason: "Probe fetch failed; status unknown" };

  // Condition 6: only closed enums reach the row, validated here. A failed
  // read keeps the last known facts (COALESCE) instead of erasing them.
  const stored = storedInstallFacts({
    csp_verdict: install?.csp.verdict,
    platform: install?.platform,
    tag_position: install?.tag_position,
    tag_flags: install?.tag_flags,
  });
  const storedPre = storedPreFacts({ state: pre?.state, hash: pre?.hash, policy: pre?.policy });

  // Since when the policy stops the tag; a failed read keeps what we knew.
  const previousSince = previous?.csp_blocks_since ?? null;
  const blocksSince = install
    ? install.csp.blocks
      ? (previousSince ?? now)
      : null
    : previousSince;

  // UPSERT snippet_status.
  await env.DB.prepare(
    `INSERT INTO snippet_status
       (customer_id, last_probed_at, snippet_in_html, last_event_at, status, status_reason, tag_form,
        csp_verdict, platform, tag_position, tag_flags, csp_blocks_since, tag_found_at,
        pre_state, pre_hash, pre_policy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET
       last_probed_at  = excluded.last_probed_at,
       snippet_in_html = excluded.snippet_in_html,
       last_event_at   = excluded.last_event_at,
       status          = excluded.status,
       status_reason   = excluded.status_reason,
       tag_form        = excluded.tag_form,
       csp_verdict     = COALESCE(excluded.csp_verdict, snippet_status.csp_verdict),
       platform        = COALESCE(excluded.platform, snippet_status.platform),
       tag_position    = COALESCE(excluded.tag_position, snippet_status.tag_position),
       tag_flags       = COALESCE(excluded.tag_flags, snippet_status.tag_flags),
       csp_blocks_since = excluded.csp_blocks_since,
       tag_found_at    = COALESCE(excluded.tag_found_at, snippet_status.tag_found_at),
       pre_state       = CASE WHEN excluded.pre_state IS NULL THEN snippet_status.pre_state ELSE excluded.pre_state END,
       pre_hash        = CASE WHEN excluded.pre_state IS NULL THEN snippet_status.pre_hash ELSE excluded.pre_hash END,
       pre_policy      = COALESCE(excluded.pre_policy, snippet_status.pre_policy)`,
  )
    .bind(
      customer.id,
      now,
      snippetInHtml ? 1 : 0,
      lastEventAt,
      status,
      reason,
      tagForm,
      stored.csp_verdict,
      stored.platform,
      stored.tag_position,
      stored.tag_flags,
      blocksSince,
      // Only a find moves it: the rhythm counts days since the last find.
      snippetInHtml ? now : null,
      storedPre.pre_state,
      storedPre.pre_hash,
      storedPre.pre_policy,
    )
    .run();

  // csp-blocks (spec B, "Stored"): once, when a live customer's policy
  // turns blocking. The transition is the dedupe: a policy that stays
  // blocking says nothing more. Test customers never alert.
  if (
    install &&
    facts?.live_at != null &&
    facts.plan !== "test" &&
    install.csp.blocks &&
    !verdictBlocks(parseStoredVerdict(previous?.csp_verdict))
  ) {
    console.error(`[rawuser/probe] csp-blocks customer=${customer.id}`);
    await sendAlert(
      env.ALERT_WEBHOOK_URL,
      `csp-blocks: ${customer.id}: the site's security policy now blocks the tag, visitors see the page as built. The lines are on the Pages card.`,
    );
  }

  return {
    status,
    reason,
    tag_form: tagForm,
    read,
    page_path: pagePath,
    install,
    tag_runs: tagRuns,
    pre: pre ? { state: pre.state, policy: pre.policy, lines: pre.lines } : null,
  };
}

/**
 * Cron entry point (hourly, index.ts): probe every active customer whose
 * gap has passed, 6 hours or a week by probeInterval.
 *
 * Returns aggregate counters for logging.
 */
export async function runSnippetProbe(
  env: ProbeEnv,
  now: number = Date.now(),
): Promise<{ probed: number; skipped: number; errors: number }> {
  const result = await env.DB.prepare(
    `SELECT c.id, c.domain, c.created_at, ss.last_probed_at, ss.tag_found_at
     FROM customers c
     LEFT JOIN snippet_status ss ON ss.customer_id = c.id
     WHERE c.status = 'active'`,
  ).all<{
    id: string;
    domain: string;
    created_at?: number | null;
    last_probed_at: number | null;
    tag_found_at?: number | null;
  }>();

  const customers = result.results ?? [];

  let probed = 0;
  let skipped = 0;
  let errors = 0;

  for (const customer of customers) {
    const interval = probeInterval(
      { tag_found_at: customer.tag_found_at ?? null, created_at: customer.created_at ?? null },
      now,
    );
    if (customer.last_probed_at !== null && now - customer.last_probed_at < interval) {
      skipped++;
      continue;
    }

    try {
      await probeSingleCustomer({ id: customer.id, domain: customer.domain }, env);
      probed++;
    } catch {
      // Error already logged inside probeSingleCustomer (url_id only).
      errors++;
    }
  }

  return { probed, skipped, errors };
}
