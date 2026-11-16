/**
 * UA token learning (L2, Layer E). Off unless UA_TOKEN_LEARNING = "on".
 *
 * The in-app browser table (APP_UAS) can only name apps we already know.
 * Apps appear and change their markers at will. This module lets the table
 * learn from our own traffic without ever storing a visit:
 *
 *   On a /select whose referrer is empty and whose app is unknown, take the
 *   User-Agent, split it into tokens, drop the tokens every browser carries
 *   (a stoplist) and any token that could describe a device rather than a
 *   product (long digit runs), and add 1 to a weekly counter per token per
 *   customer BUCKET in D1. A counter, not a row. No path, no time beyond
 *   the ISO week, no other signal joins to it. The customer is not stored:
 *   the key carries a 256-way bucket of SHA-256(customer_id + week), so a
 *   token cannot be tied to one customer's niche traffic from the table,
 *   while the Sunday script can still ask "seen in more than one bucket"
 *   (privacy review condition, ADR 0029).
 *
 *   A Sunday script (scripts/ua-token-proposals.ts) reads the counters,
 *   keeps tokens seen across at least 2 customers and 50 sessions in the
 *   week, diffs against APP_UAS and the known-browser list, and writes a
 *   proposals file. A human adds rows to APP_UAS with a source. The code
 *   stays a table; the table grows from real traffic.
 *
 * Privacy (the privacy rules): a token that fifty
 * visitors carried in a week is a product name, not a person. Tokens with a
 * digit run of six or more, tokens over 32 characters, and tokens with "@"
 * or "." (build ids, device ids, emails, hosts) are dropped before they are
 * ever counted. The precedent is holdout.ts, which already hashes the first
 * 80 UA characters per request without storing them.
 *
 * Cost: at most one D1 UPSERT per qualifying request per token (capped at
 * 6 tokens), fire-and-forget via ctx.waitUntil, never on the response path.
 */

/** Tokens every browser or OS carries; never interesting. */
const STOPLIST: ReadonlySet<string> = new Set([
  "mozilla",
  "applewebkit",
  "khtml",
  "like",
  "gecko",
  "mobile",
  "safari",
  "chrome",
  "crios",
  "fxios",
  "edgios",
  "firefox",
  "version",
  "linux",
  "android",
  "iphone",
  "ipad",
  "ipod",
  "cpu",
  "os",
  "x",
  "build",
  "wv",
  "mac",
  "macintosh",
  "intel",
  "windows",
  "win",
  "nt",
  "win64",
  "x64",
  "arm",
  "wow",
  "x11",
  "u",
  "en",
  "en-us",
  "samsungbrowser",
  "opr",
  "edg",
  "edga",
  "yabrowser",
  "ucbrowser",
  "miuibrowser",
  "huaweibrowser",
  "brave",
  "vivaldi",
  "duckduckgo",
  "ddg",
  "gsa",
  "trident",
  "rv",
]);

const MAX_TOKENS = 6;
const MAX_TOKEN_LENGTH = 32;
const MIN_TOKEN_LENGTH = 3;
const DIGIT_RUN = /\d{6,}/;

/**
 * Split a User-Agent into candidate product tokens.
 *
 * Exported for tests. Pure. Returns at most MAX_TOKENS lowercase tokens,
 * deduplicated, with the stoplist and the identifier-shaped tokens removed.
 * Version suffixes are stripped ("instagram" from "instagram/328.0", the
 * bracketed Meta blocks yield "fban", "fbav").
 */
export function uaTokens(ua: string | null | undefined): string[] {
  if (!ua) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ua.toLowerCase().split(/[\s;()\[\]/,]+/)) {
    if (!raw) continue;
    // Drop a trailing version ("chrome:124.0" style never occurs; "x_1.2" does).
    const token = raw.replace(/[_:-]?v?\d[\d._-]*$/, "");
    if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) continue;
    if (!/^[a-z][a-z0-9_-]*$/.test(token)) continue;
    if (DIGIT_RUN.test(raw)) continue;
    if (STOPLIST.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

/** ISO week label, e.g. "2026-W37". Exported for tests. */
export function isoWeek(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Count the tokens of one qualifying request. Best effort; errors are
 * swallowed with a constant log line, as writeEventRow does.
 */
export async function countUaTokens(
  db: D1Database,
  customerId: string,
  ua: string | null | undefined,
  now: Date = new Date(),
): Promise<void> {
  const tokens = uaTokens(ua);
  if (tokens.length === 0) return;
  const week = isoWeek(now);
  const bucket = await customerBucket(customerId, week);
  try {
    const stmt = db.prepare(
      `INSERT INTO ua_token_counts (week, customer_bucket, token, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(week, customer_bucket, token) DO UPDATE SET count = count + 1`,
    );
    await db.batch(tokens.map((t) => stmt.bind(week, bucket, t)));
  } catch {
    console.error("[rawuser/edge] ua token count failed (non-critical)");
  }
}

/**
 * 256-way bucket of the customer, rotating weekly. Exported for tests.
 * Two customers share a bucket with probability 1/256, which only makes the
 * "more than one bucket" check in the Sunday script slightly conservative.
 */
export async function customerBucket(customerId: string, week: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${customerId}|${week}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const first = new Uint8Array(digest)[0] ?? 0;
  return first.toString(16).padStart(2, "0");
}
