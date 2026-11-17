/**
 * The pilot form's confirmation email (docs/specs/pilot-auto-reply.md).
 *
 * One plain message to the address a person typed, sent after their request
 * was stored. It holds nothing they typed except the address it goes to, so
 * the form cannot carry a message of someone else's choosing. At most once
 * per address in 30 days (the existing pilot_requests rows tell, nothing new
 * is kept) and at most DAILY_LIMIT in a UTC day (a KV count, no address).
 *
 * The address is used once, in memory, for the `to` of one `send()` call:
 * never logged, never put in an alert, never in KV. A failure logs one
 * closed word.
 *
 * Off unless PILOT_AUTO_REPLY = "on", the EMAIL binding is there and the
 * install names a sender. The words that name a person are the
 * install's (PILOT_REPLY_*), so the open source release names no one.
 */

import { normalizeEmail } from "@rawuser/shared";

export const DAILY_LIMIT = 20;
export const ONCE_IN_MS = 30 * 24 * 60 * 60 * 1000;
const COUNTER_TTL_S = 2 * 24 * 60 * 60;

export interface ReplyMessage {
  to: string;
  from: { email: string; name: string };
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
}

export interface ReplyMailer {
  send(message: ReplyMessage): Promise<unknown>;
}

export interface PilotReplyEnv {
  DB: D1Database;
  VARIANTS: KVNamespace;
  EMAIL?: ReplyMailer;
  /** "on" sends; anything else, nothing. */
  PILOT_AUTO_REPLY?: string;
  /** The one address mail goes from (the binding allows only it). */
  PILOT_REPLY_FROM?: string;
  /** The name it goes under; "Rawuser" when unset. */
  PILOT_REPLY_NAME?: string;
  /** Where a reply goes; unset, to the sender. */
  PILOT_REPLY_TO?: string;
  /** The sign-off, lines split by "|"; unset, the sender's name. */
  PILOT_REPLY_SIGNATURE?: string;
}

/** The closed set of words a skipped or failed send logs. */
export type ReplyOutcome =
  | "sent"
  | "off"
  | "address" // not one plain address
  | "recent" // this address asked within 30 days
  | "limit" // DAILY_LIMIT reached today
  | "failed";

/** A single plain address, or null: no list, no display name, no header. */
export const plainAddress = (value: string): string | null => normalizeEmail(value);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The fixed message. Nothing the person typed is in it, and no link: a
 * receipt that also points at a page would be advertising to an address
 * someone else may have typed (privacy review 2026-11-17, condition 1).
 */
export function replyMessage(
  env: Pick<PilotReplyEnv, "PILOT_REPLY_NAME" | "PILOT_REPLY_SIGNATURE">,
): Omit<ReplyMessage, "to" | "from" | "replyTo"> {
  const name = env.PILOT_REPLY_NAME?.trim() || "Rawuser";
  const signature = (env.PILOT_REPLY_SIGNATURE?.trim() || name)
    .split("|")
    .map((l) => l.trim())
    .filter(Boolean);
  const paras = [
    "Thanks for asking for a pilot. I read every request myself and will write back within a day, from this address, with what your own page could say to a visitor who comes from ChatGPT.",
    'If you did not ask for this, reply "not me" and we will delete the request and not write to you.',
    signature.join("\n"),
  ];
  const html = paras.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("\n");
  return {
    subject: `Your ${name} pilot request`,
    text: `${paras.join("\n\n")}\n`,
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#171717">\n${html}\n</body></html>`,
  };
}

/** Today's count key, per UTC day, no address. */
export function counterKey(now: Date): string {
  return `pilot:reply:count:${now.toISOString().slice(0, 10)}`;
}

/**
 * Sends the confirmation for the request just stored (`requestId`), or
 * says why not. Never throws; never logs the address.
 */
export async function sendPilotReply(
  env: PilotReplyEnv,
  email: string,
  requestId: string,
  now: Date,
): Promise<ReplyOutcome> {
  const from = env.PILOT_REPLY_FROM?.trim();
  if (env.PILOT_AUTO_REPLY !== "on" || !env.EMAIL || !from) return "off";
  const to = plainAddress(email);
  if (!to) return "address";
  try {
    const earlier = await env.DB.prepare(
      "SELECT 1 AS hit FROM pilot_requests WHERE lower(trim(email)) = lower(?) AND id != ? AND created_at >= ? LIMIT 1",
    )
      .bind(to, requestId, now.getTime() - ONCE_IN_MS)
      .first<{ hit: number }>();
    if (earlier) return "recent";

    const key = counterKey(now);
    const count = Number.parseInt((await env.VARIANTS.get(key)) ?? "0", 10) || 0;
    if (count >= DAILY_LIMIT) return "limit";
    await env.VARIANTS.put(key, String(count + 1), { expirationTtl: COUNTER_TTL_S });

    const name = env.PILOT_REPLY_NAME?.trim() || "Rawuser";
    const replyTo = env.PILOT_REPLY_TO?.trim();
    await env.EMAIL.send({
      to,
      from: { email: from, name },
      ...(replyTo ? { replyTo } : {}),
      ...replyMessage(env),
    });
    return "sent";
  } catch {
    return "failed";
  }
}
