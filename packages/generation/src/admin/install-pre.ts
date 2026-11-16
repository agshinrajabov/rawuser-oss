/**
 * The two-part tag for a live customer (docs/specs/faster-tag.md step 6,
 * "API contract (generation)"):
 *
 *   GET  /admin/install/pre?customer_id=…        from the last read of the page
 *   POST /admin/install/pre/check {customer_id}  reads the homepage now (the
 *        probe, as the Connect screen's check), then answers the same, with
 *        the exact CSP lines
 *
 * Customer-scoped; a superadmin may view any customer. The paste is built
 * from the confirmed manifests on every call (lib/pre-paste.ts); the state is
 * the probe's stored word and hash, compared with the current paste's hash
 * here, so a paste that changed since the read is stale at once. Nothing is
 * stored by GET; the check stores what the probe stores (condition 2: the
 * state word, the hash, the policy word; never HTML, never pasted text).
 */

import { probeSingleCustomer } from "../cron/snippet-probe.ts";
import { EDGE_ORIGIN_MISSING, edgeOrigin } from "../install-config.ts";
import { PRE_POLICIES, type PrePolicy } from "../lib/csp.ts";
import { validatePlatform } from "../lib/install-facts.ts";
import type { Platform } from "../lib/platform.ts";
import { type CurrentPaste, PRE_STATES, type PreState, currentPaste } from "../lib/pre-paste.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { requireCustomerScope } from "./scope.ts";

/** The install forms that take the two-part tag today (the founder, 2026-10-26). */
export const PRE_FORMS = ["html", "webflow", "framer"] as const;
export type PreForm = (typeof PRE_FORMS)[number];

/** Where each form goes, as words the dashboard turns into its own steps. */
export const PRE_PLATFORMS = [
  { id: "html", status: "ready", where: ["head_first"] },
  // Paid plans: Site settings, Custom code, Head code. Free plan: a Code
  // Embed at the very top of the body, above the hero (as the tag today).
  { id: "webflow", status: "ready", where: ["head_code", "body_embed_top"] },
  // Site settings, General, Custom code, Start of <head>.
  { id: "framer", status: "ready", where: ["start_of_head"] },
  { id: "lovable", status: "not_yet", where: [] },
  { id: "nextjs", status: "not_yet", where: [] },
] as const;

/** The detected platform's form; null when that platform does not take it yet. */
export function preFormFor(platform: Platform | null): PreForm | null {
  if (platform === "webflow") return "webflow";
  if (platform === "framer") return "framer";
  if (platform === "other") return "html";
  return null;
}

export type PreBlocked = "not_live" | "audit" | "inactive" | "no_parts";

interface CustomerRow {
  id: string;
  domain: string;
  plan: string | null;
  status: string | null;
  live_at: number | null;
}

interface PreRow {
  last_probed_at: number | null;
  platform: string | null;
  pre_state: string | null;
  pre_hash: string | null;
  pre_policy: string | null;
}

export interface PreAnswer {
  customer_id: string;
  available: boolean;
  blocked: PreBlocked | null;
  paste: Pick<CurrentPaste, "css" | "style" | "script" | "html"> | null;
  csp: {
    hash: string;
    needed: boolean | null;
    policy: PrePolicy | null;
    refused: boolean;
    lines: string[];
    lines_read: boolean;
  } | null;
  state: PreState | null;
  stale: boolean;
  probed_at: number | null;
  platform: { detected: Platform | null; form: PreForm | null; ready: boolean | null };
  platforms: typeof PRE_PLATFORMS;
}

/** The state against the current paste: a hash that is not the current one is stale. */
export function preStateNow(
  storedState: string | null,
  storedHash: string | null,
  currentHash: string | null,
): PreState | null {
  if (!storedState || !(PRE_STATES as readonly string[]).includes(storedState)) return null;
  if (storedState === "none") return "none";
  return currentHash && storedHash === currentHash ? "current" : "stale";
}

/** Whether the site's policy needs the paste's line; null before any read. */
export function preLineNeeded(
  policy: PrePolicy | null,
  storedHash: string | null,
  currentHash: string,
): boolean | null {
  if (policy === null) return null;
  if (policy === "needs_hash") return true;
  if (policy === "listed") return storedHash !== currentHash;
  return false;
}

export function buildPreAnswer(
  customer: CustomerRow,
  paste: CurrentPaste | null,
  row: PreRow | null,
  read: { lines: string[] } | null,
): PreAnswer {
  const detected = validatePlatform(row?.platform);
  const form = preFormFor(detected);
  const platform = {
    detected,
    form,
    ready: detected === null ? null : form !== null,
  };
  const blocked: PreBlocked | null =
    customer.plan === "audit"
      ? "audit"
      : customer.status !== "active"
        ? "inactive"
        : customer.live_at === null
          ? "not_live"
          : paste === null
            ? "no_parts"
            : null;
  const base = {
    customer_id: customer.id,
    probed_at: row?.last_probed_at ?? null,
    platform,
    platforms: PRE_PLATFORMS,
  };
  if (blocked || !paste) {
    return {
      ...base,
      available: false,
      blocked: blocked ?? "no_parts",
      paste: null,
      csp: null,
      state: null,
      stale: false,
    };
  }
  const state = preStateNow(row?.pre_state ?? null, row?.pre_hash ?? null, paste.hash);
  const policy =
    row?.pre_policy && (PRE_POLICIES as readonly string[]).includes(row.pre_policy)
      ? (row.pre_policy as PrePolicy)
      : null;
  const needed = preLineNeeded(policy, row?.pre_hash ?? null, paste.hash);
  return {
    ...base,
    available: true,
    blocked: null,
    paste: { css: paste.css, style: paste.style, script: paste.script, html: paste.html },
    csp: {
      hash: paste.hash,
      needed,
      policy,
      refused: state !== null && state !== "none" && policy === "needs_hash",
      lines: read && needed ? read.lines : [],
      lines_read: read !== null,
    },
    state,
    stale: state === "stale",
  };
}

async function answer(env: AdminEnv, customerId: string, check: boolean): Promise<Response> {
  // The paste's second line names the edge: without its origin there is no paste to hand out.
  const origin = edgeOrigin(env);
  if (!origin) return jsonWithCors({ error: EDGE_ORIGIN_MISSING }, env, 503);
  const customer = await env.DB.prepare(
    "SELECT id, domain, plan, status, live_at FROM customers WHERE id = ?",
  )
    .bind(customerId)
    .first<CustomerRow>();
  if (!customer) return jsonWithCors({ error: `Customer '${customerId}' not found` }, env, 404);

  let read: { lines: string[] } | null = null;
  if (
    check &&
    customer.plan !== "audit" &&
    customer.status === "active" &&
    customer.live_at !== null
  ) {
    const result = await probeSingleCustomer({ id: customer.id, domain: customer.domain }, env);
    read = result.pre ? { lines: result.pre.lines } : null;
  }
  const paste = await currentPaste(env.DB, customerId, origin);
  const row = await env.DB.prepare(
    `SELECT last_probed_at, platform, pre_state, pre_hash, pre_policy
       FROM snippet_status WHERE customer_id = ?`,
  )
    .bind(customerId)
    .first<PreRow>();
  return jsonWithCors(buildPreAnswer(customer, paste, row, read), env, 200);
}

export async function handleInstallPreGet(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const customerId = new URL(request.url).searchParams.get("customer_id");
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  return answer(env, customerId, false);
}

export async function handleInstallPreCheck(
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
  const customerId = (body as { customer_id?: unknown })?.customer_id;
  if (typeof customerId !== "string" || !customerId) {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  return answer(env, customerId, true);
}
