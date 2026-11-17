/**
 * /pilot-request: first-party pilot-lead capture from the operator's own
 * site.
 *
 * This is the operator's own form, not the customer snippet path, so
 * unlike /event it returns honest status codes: the person filling the form
 * deserves real feedback (201 created / 400 invalid / 429 rate limited).
 *
 * The route exists only for an install that names the origins its form
 * posts from (PILOT_FORM_ORIGINS, a comma list). Unset, it answers 404 like
 * any unknown path and sets no CORS header for anyone.
 *
 * Privacy invariants (rules/privacy.md; privacy review 2026-10-25, ruling
 * 3 on docs/sales/site-privacy.md):
 * - Consent by explicit action: a row exists only because someone typed
 *   their email into our pilot form and pressed send.
 * - No visitor identifier, IP, geo, or UA is stored in D1.
 * - The rate limit's per-client counter is a KV key for one hour. Its name
 *   holds an HMAC-SHA-256 of the connecting IP under a random 32-byte key
 *   drawn on first use each UTC day (KV, `pilot:ratekey:{day}`, 48 h TTL),
 *   never derived from anything about a visitor and never a deploy secret.
 *   Migration 0016's comment says "no IP"; read it as "no IP and no plain
 *   hash of one": until 2026-10-25 the key was an unsalted SHA-256 of the
 *   IP, which trying every IPv4 address reverses. With the daily key gone
 *   after 48 hours, an old counter name can no longer be tied to an IP.
 * - The ops line carries no form data (no email, site, domain or note):
 *   only that a request arrived and how many are open.
 * - Rows are deleted 12 months after their last status change
 *   (`status_at`, migration 0046) by the generation worker's 6-hour cron.
 * - Never joined to the events table.
 *
 * Abuse guards: hidden honeypot field (bots that fill it get a fake 201 and
 * no write), per-client 5/h and global 60/h KV caps protecting D1 quota.
 */

import { type PilotReplyEnv, sendPilotReply } from "./pilot-reply.ts";

const MAX_PER_CLIENT_PER_HOUR = 5;
const MAX_GLOBAL_PER_HOUR = 60;

export interface PilotEnv extends PilotReplyEnv {
  DB: D1Database;
  VARIANTS: KVNamespace;
  /**
   * Origins allowed to POST the form, a comma list; the first is the one
   * named to a caller from anywhere else. Unset: the route answers 404.
   */
  PILOT_FORM_ORIGINS?: string;
  /** The dashboard's origin, for the link in the ops line; unset, no link. */
  APP_ORIGIN?: string;
  /**
   * Optional webhook for instant new-lead notifications. Same contract as
   * the generation worker's ops-heartbeat: an api.telegram.org sendMessage
   * URL is called with GET + &text=, anything else gets POST {text, content}
   * (Slack/Discord/generic). Absent → no notification.
   */
  ALERT_WEBHOOK_URL?: string;
}

/** The origins the form may post from, in the order the install lists them. */
export function pilotOrigins(env: Pick<PilotEnv, "PILOT_FORM_ORIGINS">): string[] {
  return (env.PILOT_FORM_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter((o) => o !== "");
}

/** What the route answers on an install without a form: the same as any unknown path. */
function noRoute(): Response {
  return new Response("not found", { status: 404 });
}

function corsHeaders(request: Request, origins: readonly string[]): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  return {
    "access-control-allow-origin": origins.includes(origin) ? origin : (origins[0] as string),
    "cache-control": "private, no-store",
  };
}

export function pilotPreflight(request: Request, env: PilotEnv): Response {
  const origins = pilotOrigins(env);
  if (origins.length === 0) return noRoute();
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request, origins),
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
}

function respondTo(
  request: Request,
  origins: readonly string[],
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request, origins), "content-type": "application/json" },
  });
}

interface PilotBody {
  email?: unknown;
  site_url?: unknown;
  note?: unknown;
  /** Honeypot — humans never see it, bots fill it. */
  website?: unknown;
}

export interface ValidatedPilot {
  email: string;
  site_url: string | null;
  note: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== "string") return null;
  // Stripping control characters is what this function exists for: they are
  // what a header injection or a broken paste puts in a free-text field.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitisation
  const trimmed = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, maxLen);
}

function validate(body: unknown): ValidatedPilot | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as PilotBody;
  const email = cleanText(b.email, 254);
  if (!email || !EMAIL_RE.test(email)) return null;
  return {
    email,
    site_url: cleanText(b.site_url, 300),
    note: cleanText(b.note, 500),
  };
}

/** KV name of the day's random rate-limit key. */
export function rateKeyName(day: string): string {
  return `pilot:ratekey:${day}`;
}

/** The day's key lives two days, so a counter of the day's last hour still finds it. */
export const RATE_KEY_TTL_S = 48 * 3600;

/**
 * The day's key, held in isolate memory once read from KV. A key this
 * isolate drew itself is used for its own request but not cached: if two
 * isolates drew at once, KV keeps one and every later request reads that one.
 */
let cachedRateKey: { day: string; hex: string } | null = null;

/** Test hook: forget the isolate's cached key. */
export function resetRateKeyCache(): void {
  cachedRateKey = null;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The day's 32-byte key: from memory, else from KV, else drawn and stored. */
async function dayKey(kv: KVNamespace, day: string, stored: string | null): Promise<Uint8Array> {
  if (cachedRateKey?.day === day) {
    const bytes = fromHex(cachedRateKey.hex);
    if (bytes) return bytes;
  }
  const read = stored === null ? null : fromHex(stored);
  if (read && stored !== null) {
    cachedRateKey = { day, hex: stored };
    return read;
  }
  const drawn = crypto.getRandomValues(new Uint8Array(32));
  try {
    await kv.put(rateKeyName(day), toHex(drawn), { expirationTtl: RATE_KEY_TTL_S });
  } catch {
    // KV down: this request still gets a key; the limit fails open below.
  }
  return drawn;
}

/**
 * The per-client counter's name part: HMAC-SHA-256(day key, IP), first 16
 * bytes as hex. Without the day's key it cannot be tied to an IP.
 */
export async function clientTag(key: Uint8Array, ip: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(ip));
  return toHex(new Uint8Array(mac).slice(0, 16));
}

function parseCount(raw: string | null): number {
  const count = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

/** Counts one more against `key` unless `current` is already at `max`. */
async function overQuota(
  kv: KVNamespace,
  key: string,
  current: number,
  max: number,
): Promise<boolean> {
  if (current >= max) return true;
  try {
    await kv.put(key, String(current + 1), { expirationTtl: 3600 });
  } catch {
    // KV failure — fail open; this is a spam guard, not an auth gate.
  }
  return false;
}

/**
 * The hourly caps. One KV batch reads the day's key and the global counter;
 * the client counter's name needs the key, so it is the second read.
 * Any KV failure fails open.
 */
export async function rateLimited(kv: KVNamespace, ip: string, now: Date): Promise<boolean> {
  const hour = now.toISOString().slice(0, 13);
  const day = hour.slice(0, 10);
  const globalKey = `ratelimit:pilot:global:${hour}`;
  try {
    const needKey = cachedRateKey?.day !== day;
    const [stored, globalRaw] = await Promise.all([
      needKey ? kv.get(rateKeyName(day)) : Promise.resolve(null),
      kv.get(globalKey),
    ]);
    const key = await dayKey(kv, day, stored);
    const clientKey = `ratelimit:pilot:${await clientTag(key, ip)}:${hour}`;
    const clientRaw = await kv.get(clientKey);
    const clientOver = await overQuota(
      kv,
      clientKey,
      parseCount(clientRaw),
      MAX_PER_CLIENT_PER_HOUR,
    );
    const globalOver = await overQuota(kv, globalKey, parseCount(globalRaw), MAX_GLOBAL_PER_HOUR);
    return clientOver || globalOver;
  } catch {
    return false;
  }
}

/**
 * The ops line for a new request. No form data at all (privacy review,
 * 2026-10-25): never the email, the site, its domain or the note; only that
 * a request arrived, how many are open when the count could be read, and
 * where to look when the install names its dashboard (APP_ORIGIN, shown
 * without its scheme).
 */
export function leadAlertText(open: number | null, appOrigin?: string | null): string {
  const count = open !== null && Number.isInteger(open) && open > 0 ? ` (${open} open)` : "";
  const app = (appOrigin ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return `[rawuser] New pilot request${count}${app ? ` · ${app}/pilots` : ""}`;
}

/** Requests not yet handled (status 'new'), or null when D1 does not answer. */
async function openRequests(db: D1Database): Promise<number | null> {
  try {
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM pilot_requests WHERE status = 'new'")
      .first<{ n: number }>();
    return row ? Number(row.n) : null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget new-request notification (runs via ctx.waitUntil, never
 * delays the response). Carries no form data and is not logged: Telegram
 * is a third party and the dashboard already shows the request.
 */
async function notifyNewLead(env: PilotEnv): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL) return;
  const text = leadAlertText(await openRequests(env.DB), env.APP_ORIGIN);
  try {
    const url = new URL(env.ALERT_WEBHOOK_URL);
    if (url.hostname === "api.telegram.org") {
      url.searchParams.set("text", text);
      await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
    } else {
      await fetch(env.ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, content: text }),
        signal: AbortSignal.timeout(10_000),
      });
    }
  } catch (e) {
    console.error(
      "[rawuser/edge] lead webhook failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * POST /pilot-request
 * Body: { email, site_url?, note?, website? (honeypot) }
 */
export async function handlePilotRequest(
  request: Request,
  env: PilotEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const origins = pilotOrigins(env);
  if (origins.length === 0) return noRoute();
  const respond = (status: number, body: Record<string, unknown>) =>
    respondTo(request, origins, status, body);
  if (request.method !== "POST") {
    return respond(405, { ok: false, error: "method_not_allowed" });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(400, { ok: false, error: "invalid" });
  }

  // Honeypot filled → pretend success, write nothing.
  if (
    typeof body === "object" &&
    body !== null &&
    typeof (body as PilotBody).website === "string" &&
    ((body as PilotBody).website as string).trim() !== ""
  ) {
    return respond(201, { ok: true });
  }

  const validated = validate(body);
  if (!validated) {
    return respond(400, { ok: false, error: "invalid" });
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (await rateLimited(env.VARIANTS, ip, new Date())) {
    return respond(429, { ok: false, error: "rate_limited" });
  }

  const createdAt = Date.now();
  const requestId = `plt_${crypto.randomUUID().replace(/-/g, "")}`;
  try {
    await env.DB.prepare(
      `INSERT INTO pilot_requests (id, email, site_url, note, created_at, status, status_at)
       VALUES (?, ?, ?, ?, ?, 'new', ?)`,
    )
      .bind(requestId, validated.email, validated.site_url, validated.note, createdAt, createdAt)
      .run();
  } catch {
    console.error("[rawuser/edge] pilot request write failed");
    return respond(500, { ok: false, error: "server" });
  }

  ctx.waitUntil(notifyNewLead(env));
  // The confirmation (docs/specs/pilot-auto-reply.md): after the answer, one
  // closed word in the log when it does not go out, never the address.
  ctx.waitUntil(
    sendPilotReply(env, validated.email, requestId, new Date(createdAt)).then((outcome) => {
      if (outcome !== "sent" && outcome !== "off")
        console.log(`[rawuser/edge] pilot reply: ${outcome}`);
    }),
  );
  return respond(201, { ok: true });
}
