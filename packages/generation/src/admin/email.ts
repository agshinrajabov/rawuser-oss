/**
 * POST /admin/email/test { email } (superadmin only,
 * docs/specs/invite-email.md §4): the pilot invite email with a dummy link,
 * for a deliverability check (the founder's own inbox, mail-tester.com).
 * Counts against the same 20 a day as real invites. The address is used for
 * the one send and stored nowhere.
 */

import { normalizeEmail, sendInviteEmail } from "../lib/invite-email.ts";
import { INVITE_TTL_MS } from "./apply.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";

/** Opens the apply page's "invalid link" screen; never a real token. */
export const TEST_LINK_PATH = "/apply/#t=test-link-not-valid";

export async function handleEmailTest(
  request: Request,
  env: AdminEnv,
  account: { id: string },
): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await request.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // An empty or broken body reads as no address.
  }
  const email = normalizeEmail(body.email);
  if (email === null) {
    return jsonWithCors({ error: "email must be one valid address" }, env, 400);
  }
  const origin =
    env.DASHBOARD_ORIGIN && env.DASHBOARD_ORIGIN !== "*"
      ? env.DASHBOARD_ORIGIN
      : "http://localhost:3000";
  const sent = await sendInviteEmail(env, account.id, email, {
    link: `${origin}${TEST_LINK_PATH}`,
    expiresAt: Date.now() + INVITE_TTL_MS,
    site: null,
  });
  return jsonWithCors(sent, env);
}
