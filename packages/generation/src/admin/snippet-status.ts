/**
 * POST /admin/snippet-status/probe — any session scoped to the customer.
 *
 * Forces an immediate snippet liveness probe for one customer.
 * Useful for operator debugging when the hourly cron has not reached the
 * customer yet (6 hours, or a week once the tag has been missing 7 days),
 * or when the operator just reinstalled the snippet and wants immediate
 * confirmation that the status has flipped.
 *
 * Auth: session scoped to the customer (the Connect screen verifies the
 * tag with this; superadmins see every customer).
 *
 * Body: { customer_id: string, page_path?: string }
 *   page_path: the page being connected (docs/specs/install-friction.md, G4);
 *   "/" when absent. A customer onboarding /pricing with the tag only there
 *   used to see "Not on your site yet".
 *
 * Returns: { customer_id, status, reason, tag_form, probed_at, page_path,
 *            read, tag_runs, install }
 *   read     "ok" | "bot_protection" | "off_host" | "failed" (off_host: the
 *            page redirects to another host, never followed; reason says so)
 *   tag_runs the tag has run on this site (a capture landed or an event
 *            arrived): the probe is a hint, this is proof (spec C)
 *   install  null when the page could not be read, else
 *            { platform, hosting, tag_position, tag_flags, csp } where csp is
 *            { verdict, blocks, degrades, report_only_blocks, lines,
 *              report_only_lines, notes, where } (lib/install-facts.ts).
 *            The lines are rebuilt on each probe and never stored.
 *   pre      null when the page could not be read, else { state, policy,
 *            lines }: the two-part tag's pasted style (faster-tag.md step 6,
 *            "API contract (generation)"); lines rebuilt, never stored.
 */

import { probeSingleCustomer } from "../cron/snippet-probe.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { requireCustomerScope } from "./scope.ts";

interface ProbeBody {
  customer_id: string;
  page_path?: string;
}

export async function handleSnippetStatusProbe(
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

  const params = body as Partial<ProbeBody>;
  if (!params.customer_id || typeof params.customer_id !== "string") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }

  const customerId = params.customer_id;
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  // Look up the customer to get their domain.
  const customerRow = await env.DB.prepare("SELECT id, domain FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ id: string; domain: string }>();

  if (!customerRow) {
    return jsonWithCors({ error: `Customer '${customerId}' not found` }, env, 404);
  }

  const result = await probeSingleCustomer(
    { id: customerRow.id, domain: customerRow.domain },
    env,
    { pagePath: typeof params.page_path === "string" ? params.page_path : undefined },
  );

  return jsonWithCors(
    {
      customer_id: customerId,
      status: result.status,
      reason: result.reason,
      tag_form: result.tag_form ?? null,
      probed_at: Date.now(),
      page_path: result.page_path ?? "/",
      read: result.read ?? "failed",
      tag_runs: result.tag_runs ?? false,
      install: result.install ?? null,
      pre: result.pre ?? null,
    },
    env,
    200,
  );
}
