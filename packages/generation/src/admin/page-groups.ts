/**
 * Page groups, phase 1 (docs/specs/page-groups.md): a path pattern of the
 * customer's own site (`/products/*`) that names many pages sharing one
 * layout, so one button can be counted across them. No versions, nothing
 * rewritten.
 *
 *   GET  /admin/pages/groups?customer_id=
 *     { groups: [{ pattern, pages, visits, counted }], proposals: [{ pattern,
 *     pages, visits }], max }. `counted` is the group's conversion target
 *     (`section_path` "count:{pattern}") or null. `pages` and `visits` come
 *     from the newest aggregate row's `per_page.groups` (null when it has not
 *     counted the pattern); the proposals are that list less the accepted.
 *
 *   POST /admin/pages/groups  { customer_id, pattern }
 *     Accepts a proposal or a typed pattern. 400 on a pattern that is not
 *     one (or `/*`); 409 past five groups, when every page it matches is a
 *     confirmed page, or `sensitive_page` for a sensitive customer whose
 *     fixed part is not a kept section. Idempotent. Rewrites the bundle (`g`).
 *
 *   POST /admin/pages/groups/delete  { customer_id, pattern }
 *     Removes the group and its counted button. 409 with the test lock while
 *     a test runs and the button is counted.
 *
 * Customer-scoped and session-gated like the count pick's endpoints. The
 * customer's own site structure; nothing about a visitor (privacy review
 * conditions 1, 4 and 6).
 */

import {
  GROUP_PATTERN_REFUSAL,
  MAX_PAGE_GROUPS,
  countTargetPath,
  pageGroupMatches,
  validPageGroupPattern,
} from "@rawuser/shared";
import { type GroupCount, acceptedGroups, groupAggregate } from "../lib/page-groups.ts";
import { sensitiveGroupRefusal } from "../lib/sensitive-guard.ts";
import type { SessionUser } from "./auth.ts";
import { TEST_LOCK_REASON, listTargetResponses, testRunning } from "./conversions.ts";
import { jsonWithCors } from "./cors.ts";
import type { CountPickEnv } from "./count-pick.ts";
import { writeVisitorBundle } from "./onboard.ts";
import { requireCustomerScope } from "./scope.ts";

/** The 409 lines, one plain sentence each. */
export const GROUP_LIMIT_LINE = `You can have at most ${MAX_PAGE_GROUPS} page groups. Remove one first.`;
export const GROUP_CONFIRMED_ONLY_LINE =
  "Every page this pattern matches already has its own versions and buttons.";
export const GROUP_UNKNOWN_LINE = "This page group is not on your list. Add it first.";

/** The machine words beside the lines. */
export const GROUP_LIMIT_CODE = "group_limit";
export const GROUP_CONFIRMED_ONLY_CODE = "group_confirmed_only";
export const GROUP_UNKNOWN_CODE = "group_unknown";

export interface GroupView {
  pattern: string;
  /** Distinct pages with visits the aggregator counted; null when it has not. */
  pages: number | null;
  visits: number | null;
  /** The group's counted button, as /admin/conversions/list answers it, or null. */
  counted: Record<string, unknown> | null;
}

function countsOf(
  counts: readonly GroupCount[],
  pattern: string,
): Pick<GroupView, "pages" | "visits"> {
  const c = counts.find((g) => g.pattern === pattern);
  return c ? { pages: c.pages, visits: c.visits } : { pages: null, visits: null };
}

async function groupViews(db: D1Database, customerId: string): Promise<GroupView[]> {
  const [accepted, aggregate, targets] = await Promise.all([
    acceptedGroups(db, customerId),
    groupAggregate(db, customerId),
    listTargetResponses(db, customerId),
  ]);
  return accepted.map((pattern) => ({
    pattern,
    ...countsOf(aggregate.groups, pattern),
    counted:
      (targets.find((t) => t.section_path === countTargetPath(pattern)) as
        | Record<string, unknown>
        | undefined) ?? null,
  }));
}

/** The pages a customer confirmed, as stored. */
async function confirmedPages(db: D1Database, customerId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      "SELECT page_path FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL",
    )
    .bind(customerId)
    .all<{ page_path: string }>();
  return (rows.results ?? []).map((r) => String(r.page_path));
}

async function readBody(
  request: Request,
): Promise<{ customer_id?: unknown; pattern?: unknown } | null> {
  try {
    return ((await request.json()) ?? {}) as { customer_id?: unknown; pattern?: unknown };
  } catch {
    return null;
  }
}

export async function handlePageGroupsGet(
  request: Request,
  env: CountPickEnv,
  user: SessionUser,
): Promise<Response> {
  const customerId = new URL(request.url).searchParams.get("customer_id");
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  const groups = await groupViews(env.DB, customerId);
  const accepted = new Set(groups.map((g) => g.pattern));
  const aggregate = await groupAggregate(env.DB, customerId);
  // A proposal names a pattern, never an example path (privacy review condition 6).
  const proposals = aggregate.groups
    .filter((g) => !accepted.has(g.pattern))
    .map((g) => ({ pattern: g.pattern, pages: g.pages, visits: g.visits }));
  return jsonWithCors({ groups, proposals, max: MAX_PAGE_GROUPS }, env, 200);
}

export async function handlePageGroupSet(
  request: Request,
  env: CountPickEnv,
  user: SessionUser,
): Promise<Response> {
  const body = await readBody(request);
  if (!body) return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  if (typeof body.customer_id !== "string" || body.customer_id === "") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const customerId = body.customer_id;
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const pattern = validPageGroupPattern(body.pattern);
  if (pattern === null) return jsonWithCors({ error: GROUP_PATTERN_REFUSAL }, env, 400);

  const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ id: string }>();
  if (!customer) return jsonWithCors({ error: "Customer not found" }, env, 404);

  const accepted = await acceptedGroups(env.DB, customerId);
  if (accepted.includes(pattern)) {
    const group = (await groupViews(env.DB, customerId)).find((g) => g.pattern === pattern);
    return jsonWithCors({ group }, env, 200);
  }
  if (accepted.length >= MAX_PAGE_GROUPS) {
    return jsonWithCors({ error: GROUP_LIMIT_LINE, code: GROUP_LIMIT_CODE }, env, 409);
  }
  // A sensitive customer's group only under a kept section (the spec,
  // "What is stored"): the refusal names the pattern.
  const kept = await sensitiveGroupRefusal(env.DB, customerId, pattern);
  if (kept) return jsonWithCors(kept, env, 409);
  // A pattern whose only matching pages are confirmed pages gives nothing: a
  // confirmed page keeps its own versions and targets (the spec, Limits).
  const confirmed = (await confirmedPages(env.DB, customerId)).filter((p) =>
    pageGroupMatches(pattern, p),
  );
  if (confirmed.length > 0) {
    const aggregate = await groupAggregate(env.DB, customerId);
    const open = aggregate.pagesWithVisits.some(
      (p) => pageGroupMatches(pattern, p) && !confirmed.includes(p),
    );
    if (!open) {
      return jsonWithCors(
        { error: GROUP_CONFIRMED_ONLY_LINE, code: GROUP_CONFIRMED_ONLY_CODE },
        env,
        409,
      );
    }
  }

  await env.DB.prepare(
    "INSERT INTO page_groups (customer_id, pattern, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  )
    .bind(customerId, pattern, Date.now())
    .run();
  await writeVisitorBundle(env, customerId);
  const group = (await groupViews(env.DB, customerId)).find((g) => g.pattern === pattern);
  return jsonWithCors({ group }, env, 200);
}

export async function handlePageGroupDelete(
  request: Request,
  env: CountPickEnv,
  user: SessionUser,
): Promise<Response> {
  const body = await readBody(request);
  if (!body) return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  if (typeof body.customer_id !== "string" || body.customer_id === "") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const customerId = body.customer_id;
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const pattern = validPageGroupPattern(body.pattern);
  if (pattern === null) return jsonWithCors({ error: GROUP_PATTERN_REFUSAL }, env, 400);

  const accepted = await acceptedGroups(env.DB, customerId);
  if (!accepted.includes(pattern)) {
    return jsonWithCors({ error: GROUP_UNKNOWN_LINE, code: GROUP_UNKNOWN_CODE }, env, 404);
  }
  const sectionPath = countTargetPath(pattern);
  const target = await env.DB.prepare(
    "SELECT id, enabled FROM conversion_targets WHERE customer_id = ? AND section_path = ?",
  )
    .bind(customerId, sectionPath)
    .first<{ id: string; enabled: number }>();
  // A counted button does not move while a test runs (the existing rule).
  if (target && Number(target.enabled) === 1 && (await testRunning(env.DB, customerId))) {
    return jsonWithCors({ error: TEST_LOCK_REASON }, env, 409);
  }
  if (target) {
    await env.DB.prepare("DELETE FROM conversion_targets WHERE id = ?").bind(target.id).run();
  }
  await env.DB.prepare("DELETE FROM page_groups WHERE customer_id = ? AND pattern = ?")
    .bind(customerId, pattern)
    .run();
  await writeVisitorBundle(env, customerId);
  return jsonWithCors({ ok: true, pattern, target_removed: target !== null }, env, 200);
}
