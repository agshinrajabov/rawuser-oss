/**
 * The pilot invite (docs/specs/invite-email.md §7): the request body and the
 * one line under the link that says whether the email went out. The address
 * is sent once in the POST body and kept nowhere in the tab.
 */

import type { PilotApplicationInvite } from "@/types/api";
import { apiFetch } from "./api";

export interface InviteBody {
  name?: string;
  site?: string;
  email?: string;
}

/** Only the filled fields; `email` only when typed. */
export function inviteBody(name: string, site: string, email: string): InviteBody {
  const body: InviteBody = {};
  if (name.trim()) body.name = name.trim();
  if (site.trim()) body.site = site.trim();
  if (email.trim()) body.email = email.trim();
  return body;
}

export function makePilotInvite(body: InviteBody): Promise<PilotApplicationInvite> {
  return apiFetch<PilotApplicationInvite>("/admin/applications/invite", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export const EMAIL_HELP = "We email them the link. The address is not stored.";
export const LIMIT_LINE = "Daily email limit reached. Copy the link and send it yourself.";
export const RECIPIENT_LINE = "That address refused the email. Copy the link instead.";
export const FAILED_LINE = "The email did not go out. Copy the link and send it yourself.";

/** The line under the link, or null when no address was given. */
export function emailLine(
  invite: Pick<PilotApplicationInvite, "emailed" | "email_error">,
  email: string,
): { text: string; ok: boolean } | null {
  const to = email.trim();
  if (!to) return null;
  if (invite.emailed) return { text: `Sent to ${to}.`, ok: true };
  if (invite.email_error === "limit") return { text: LIMIT_LINE, ok: false };
  if (invite.email_error === "recipient") return { text: RECIPIENT_LINE, ok: false };
  return { text: FAILED_LINE, ok: false };
}
