/**
 * The pilot invite email (docs/specs/invite-email.md, 2026-10-26).
 *
 * One plain message per invite, sent through Cloudflare Email Sending's
 * Workers binding (`[[env.production.send_email]] name = "EMAIL"`, restricted
 * to the install's one sender, SENDER_ADDRESS). Who sends, where a reply
 * goes and whom to ask about privacy are the install's (install-config.ts):
 * without a sender no mail goes out, without the others the message reads
 * without them. The recipient's address is used once, in memory, for the
 * `to` of one `send()` call. It is never written to D1 or KV, never logged,
 * never put in an alert, never returned. The only thing kept is a count of
 * sends per signed-in account per UTC day (KV, no address), for the limit.
 *
 * No images, no tracking pixel, no tracked link: the invite link appears
 * once, as itself.
 */

import { type InstallEnv, mailSender, privacyAddress, replyToAddress } from "../install-config.ts";

/** The name the message speaks under when the install gives its sender none. */
const DEFAULT_NAME = "Rawuser";

/** "Your Rawuser pilot": the subject, under the sender's own name. */
export function inviteSubject(name: string = DEFAULT_NAME): string {
  return `Your ${name} pilot`;
}

/** Sends a day per signed-in account (superadmin only), invites and tests together. */
export const EMAIL_DAILY_LIMIT = 20;
/** The day's counter outlives its day by one, then KV drops it. */
const COUNTER_TTL_S = 2 * 24 * 60 * 60;

/**
 * The closed set of `email_error` words. Never the provider's message (it can
 * carry the address).
 */
export type EmailError =
  | "limit" // our 20 a day for this account is used
  | "unavailable" // no binding (local dev, the non-production worker)
  | "sender" // no sender configured, or the sending domain or account is not ready
  | "recipient" // the address was refused or is on the suppression list
  | "quota" // Cloudflare's own rate or daily quota
  | "failed"; // anything else

/** The structured builder of `env.EMAIL.send()` (Email Sending Workers API). */
export interface InviteMailMessage {
  to: string;
  from: { email: string; name: string };
  /** Left out when the install names none: a reply then goes to the sender. */
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
}

/** The part of Cloudflare's `SendEmail` binding this module uses. */
export interface InviteMailer {
  send(message: InviteMailMessage): Promise<{ messageId: string }>;
}

export interface InviteEmailEnv
  extends Pick<
    InstallEnv,
    "SENDER_ADDRESS" | "SENDER_NAME" | "REPLY_TO_ADDRESS" | "PRIVACY_ADDRESS"
  > {
  EMAIL?: InviteMailer;
  VARIANTS: KVNamespace;
}

export type SendResult = { emailed: true } | { emailed: false; email_error: EmailError };

const MAX_ADDRESS = 254;
const ADDRESS_RE = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]{2,}$/;

/**
 * A single plain address, or null. Refuses lists, display names, quotes and
 * line breaks, so nothing typed can add a recipient or a header.
 */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.length === 0 || v.length > MAX_ADDRESS) return null;
  if (!ADDRESS_RE.test(v)) return null;
  return v;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "9 November 2026", UTC, the same in every runtime. */
export function formatExpiry(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A site as the founder typed it, shown only when it reads as a host. */
function siteLabel(site: string | null | undefined): string | null {
  if (!site) return null;
  const s = site
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return /^[a-z0-9.-]+(\/[^\s]*)?$/i.test(s) && s.length <= 100 ? s : null;
}

export interface InviteEmailInput {
  link: string;
  expiresAt: number;
  site?: string | null;
  /** Named in the footer when the install has one (PRIVACY_ADDRESS). */
  privacyAddress?: string | null;
  /**
   * Who the message says it is from: the sender's name (SENDER_NAME), so a
   * message never speaks for anyone but the install that sent it.
   */
  senderName?: string | null;
}

/** Subject, plain text and HTML of the one message. No address in it. */
export function inviteEmail(input: InviteEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const date = formatExpiry(input.expiresAt);
  const site = siteLabel(input.site);
  const name = input.senderName?.trim() || DEFAULT_NAME;
  const opener = site
    ? `Here is your link to start the ${name} pilot for ${site}.`
    : `Here is your link to start the ${name} pilot.`;
  const what = "It opens a short form about your site and works once.";
  const until = `The link works until ${date}.`;
  const reply = "If you have a question, reply to this email.";
  const privacy = input.privacyAddress ?? null;
  const sentBy = `Sent by ${name}.`;
  const footer = privacy ? `${sentBy} Privacy: ${privacy}` : sentBy;
  const privacyMail = privacy ? escapeHtml(privacy) : "";
  const footerHtml = privacy
    ? `${escapeHtml(sentBy)} Privacy: <a href="mailto:${privacyMail}" style="color:#666666">${privacyMail}</a>`
    : escapeHtml(sentBy);

  const text = [
    "Hello,",
    "",
    `${opener} ${what}`,
    "",
    input.link,
    "",
    until,
    "",
    reply,
    "",
    footer,
    "",
  ].join("\n");

  const link = escapeHtml(input.link);
  const p = 'style="margin:0 0 16px 0"';
  const html = [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(inviteSubject(name))}</title></head>`,
    '<body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;background:#ffffff">',
    `<p ${p}>Hello,</p>`,
    `<p ${p}>${escapeHtml(opener)} ${escapeHtml(what)}</p>`,
    `<p ${p}><a href="${link}">${link}</a></p>`,
    `<p ${p}>${escapeHtml(until)}</p>`,
    `<p ${p}>${escapeHtml(reply)}</p>`,
    `<p style="margin:24px 0 0 0;font-size:13px;color:#666666">${footerHtml}</p>`,
    "</body></html>",
  ].join("\n");

  return { subject: inviteSubject(name), text, html };
}

function dayKey(accountId: string, now: number): string {
  return `email-sends:${accountId}:${new Date(now).toISOString().slice(0, 10)}`;
}

/** Cloudflare's error code to our word. Unknown codes are "failed". */
export function emailErrorFor(code: unknown): EmailError {
  switch (code) {
    case "E_SENDER_NOT_VERIFIED":
    case "E_SENDER_DOMAIN_NOT_AVAILABLE":
    case "E_ACCOUNT_SUSPENDED":
      return "sender";
    case "E_VALIDATION_ERROR":
    case "E_RECIPIENT_NOT_ALLOWED":
    case "E_RECIPIENT_SUPPRESSED":
    case "E_DELIVERY_FAILED":
      return "recipient";
    case "E_RATE_LIMIT_EXCEEDED":
    case "E_DAILY_LIMIT_EXCEEDED":
      return "quota";
    default:
      return "failed";
  }
}

/** A code shaped like Cloudflare's (`E_` and capitals), else nothing. */
function safeCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E_[A-Z_]{1,40}$/.test(code) ? code : "unknown";
}

/**
 * Sends the invite to one address, once. Counts the attempt against the
 * account's day before the call (a failed send still counts: the limit is
 * on attempts). The address lives only in this call's arguments.
 */
export async function sendInviteEmail(
  env: InviteEmailEnv,
  accountId: string,
  to: string,
  input: InviteEmailInput,
  now: number = Date.now(),
): Promise<SendResult> {
  if (!env.EMAIL) return { emailed: false, email_error: "unavailable" };
  // No sender, no mail: nothing is counted and nothing is tried.
  const from = mailSender(env);
  if (!from) return { emailed: false, email_error: "sender" };
  const replyTo = replyToAddress(env);

  const key = dayKey(accountId, now);
  const used = Number((await env.VARIANTS.get(key)) ?? "0") || 0;
  if (used >= EMAIL_DAILY_LIMIT) return { emailed: false, email_error: "limit" };
  await env.VARIANTS.put(key, String(used + 1), { expirationTtl: COUNTER_TTL_S });

  const { subject, text, html } = inviteEmail({
    ...input,
    privacyAddress: privacyAddress(env),
    senderName: from.name,
  });
  try {
    await env.EMAIL.send({
      to,
      from,
      ...(replyTo ? { replyTo } : {}),
      subject,
      text,
      html,
    });
    return { emailed: true };
  } catch (e) {
    const code = safeCode(e);
    // The code only: the provider's message can quote the address.
    console.warn(`[rawuser/email] send failed: ${code}`);
    return { emailed: false, email_error: emailErrorFor(code) };
  }
}
