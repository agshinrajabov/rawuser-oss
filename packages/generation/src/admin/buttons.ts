/**
 * The switch of one button: "rewrite this button's words" (the founder's
 * decision of 2026-10-12; lib/button-rewrite.ts; mock
 * design/mock/sales-readiness/pilot-gaps.html, screen 04).
 *
 *   GET  /admin/onboard/buttons?customer_id=X&page_path=/
 *     { page_path, confirmed, test_running, buttons: [{ path, label, text,
 *       rewrite, counted, form }] }
 *
 *   POST /admin/onboard/button
 *     body: { customer_id, page_path?, path, rewrite: boolean }
 *     Sets the switch of one button of that page. Answers the GET's body
 *     plus { changed, stale }. 404 without a manifest for the page, 400 when
 *     the path is not a button of it, 409 when it would turn on the counted
 *     button while a test runs.
 *
 * Both customer-scoped like every onboard endpoint. A page not yet confirmed
 * takes the switch too (the Look screen before go live): nothing reaches a
 * visitor until the confirm, and go live keeps it.
 *
 * On: the page's hide rules and visitor bundle are written again with the
 * button in them, and the page's versions are marked stale, since each needs
 * the label written; the queue rewrites them and the older bodies serve
 * meanwhile, without a label.
 *
 * Off: the hide rules and the bundle are written again without the button.
 * Nothing is rewritten: the snippet writes only a part the bundle maps, so
 * the label the older bodies carry is no longer written. One case does need
 * the rewrite: a button the page tags itself (`data-rawuser`), which the
 * snippet writes whatever the bundle says; its versions are marked stale so
 * the next ones carry no label.
 *
 * While a test runs: turning the rewrite on for the counted button is
 * refused, turning anything off never is, and a button that is not counted
 * may be turned on. The test's metric is clicks on the counted button
 * (docs/specs/proof-engine.md, "The counted buttons do not move while a test
 * runs"); new words on that very button, in the treat arm only, change what
 * the two arms are compared on in the middle of a period. A button that is
 * not counted is treatment like any other part, and versions are rewritten
 * during a test already. Off is the customer's way back to its own words and
 * must always work (the pilot's button was turned off mid-test on 2026-10-12).
 *
 * Privacy: the manifest is the customer's own page facts. Nothing about a
 * visitor is read or written.
 */

import type { Manifest } from "@rawuser/shared";
import { normalizePath, pagePathRefusal } from "@rawuser/shared";
import { type ButtonRow, buttonsOf, loadCountedTargets, rewriteOn } from "../lib/button-rewrite.ts";
import { markVersionsStale } from "../lib/version-approval.ts";
import { isButtonLabelPath } from "../lint/cta-action.ts";
import type { SessionUser } from "./auth.ts";
import { TEST_LOCK_REASON, testRunning } from "./conversions.ts";
import { jsonWithCors } from "./cors.ts";
import type { OnboardEnv } from "./onboard.ts";
import { writeHideRules } from "./onboard.ts";
import { requireCustomerScope } from "./scope.ts";

type ButtonsEnv = OnboardEnv;

interface ButtonsAnswer {
  page_path: string;
  /** The page is confirmed: its parts reach visitors. */
  confirmed: boolean;
  /** A test runs: the counted button's rewrite cannot be turned on. */
  test_running: boolean;
  buttons: ButtonRow[];
}

interface PageRow {
  manifest: string;
  confirmed_at: number | null;
}

async function loadPage(db: D1Database, customerId: string, pagePath: string) {
  const row = await db
    .prepare(
      "SELECT manifest, confirmed_at FROM element_manifests WHERE customer_id = ? AND page_path = ?",
    )
    .bind(customerId, pagePath)
    .first<PageRow>();
  if (!row) return null;
  try {
    return {
      manifest: JSON.parse(row.manifest) as Manifest,
      confirmed: row.confirmed_at !== null && row.confirmed_at !== undefined,
    };
  } catch {
    return null;
  }
}

async function answerFor(
  env: ButtonsEnv,
  customerId: string,
  pagePath: string,
  page: { manifest: Manifest; confirmed: boolean },
): Promise<ButtonsAnswer> {
  return {
    page_path: pagePath,
    confirmed: page.confirmed,
    test_running: await testRunning(env.DB, customerId),
    buttons: buttonsOf(page.manifest, pagePath, await loadCountedTargets(env.DB, customerId)),
  };
}

export async function handleButtonsGet(
  request: Request,
  env: ButtonsEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const refusal = pagePathRefusal(url.searchParams.get("page_path"));
  if (refusal) return jsonWithCors({ error: refusal }, env, 400);
  const pagePath = normalizePath(url.searchParams.get("page_path"));
  const page = await loadPage(env.DB, customerId, pagePath);
  if (!page) return jsonWithCors({ error: "No manifest found for this path" }, env, 404);
  return jsonWithCors(await answerFor(env, customerId, pagePath, page), env, 200);
}

interface ButtonSetBody {
  customer_id: string;
  page_path?: string;
  path: string;
  rewrite: boolean;
}

/** A manifest path: letters, digits, underscores and dots, as the slots are named. */
const PATH_RE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;

export async function handleButtonSet(
  request: Request,
  env: ButtonsEnv,
  user: SessionUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  const p = body as Partial<ButtonSetBody>;
  if (!p.customer_id || typeof p.customer_id !== "string") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const scope = requireCustomerScope(user, p.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  if (typeof p.path !== "string" || !PATH_RE.test(p.path) || !isButtonLabelPath(p.path)) {
    return jsonWithCors({ error: "path must be a button of the page" }, env, 400);
  }
  if (typeof p.rewrite !== "boolean") {
    return jsonWithCors({ error: "rewrite must be true or false" }, env, 400);
  }
  const refusal = pagePathRefusal(p.page_path);
  if (refusal) return jsonWithCors({ error: refusal }, env, 400);

  const customerId = p.customer_id;
  const pagePath = normalizePath(p.page_path);
  const page = await loadPage(env.DB, customerId, pagePath);
  if (!page) return jsonWithCors({ error: "No manifest found for this path" }, env, 404);
  const entry = page.manifest[p.path];
  if (!entry) return jsonWithCors({ error: "path must be a button of the page" }, env, 400);

  if (rewriteOn(entry) === p.rewrite) {
    return jsonWithCors(
      { ...(await answerFor(env, customerId, pagePath, page)), changed: false, stale: 0 },
      env,
      200,
    );
  }

  const counted = buttonsOf(
    page.manifest,
    pagePath,
    await loadCountedTargets(env.DB, customerId),
  ).find((b) => b.path === p.path)?.counted;
  if (p.rewrite && counted && (await testRunning(env.DB, customerId))) {
    return jsonWithCors({ error: TEST_LOCK_REASON }, env, 409);
  }

  // One statement on the stored JSON: the other parts of the manifest are
  // not read and written back, so a write beside this one loses nothing.
  // The path was checked against PATH_RE above and is bound, never spliced.
  const at = `$."${p.path}".rewrite`;
  await env.DB.prepare(
    p.rewrite
      ? "UPDATE element_manifests SET manifest = json_set(manifest, ?, json('true')) WHERE customer_id = ? AND page_path = ?"
      : "UPDATE element_manifests SET manifest = json_remove(manifest, ?) WHERE customer_id = ? AND page_path = ?",
  )
    .bind(at, customerId, pagePath)
    .run();

  let stale = 0;
  if (page.confirmed) {
    // On: every version of the page needs the label. Off: only where the
    // page tags the button itself, since the snippet writes a tagged part
    // whatever the bundle says.
    const tagged = (entry.css ?? []).some((sel) => sel.includes("data-rawuser"));
    if (p.rewrite || tagged) stale = await markPageStale(env.DB, customerId, pagePath);
    await writeHideRules(env, customerId);
  }

  const after = (await loadPage(env.DB, customerId, pagePath)) ?? page;
  return jsonWithCors(
    { ...(await answerFor(env, customerId, pagePath, after)), changed: true, stale },
    env,
    200,
  );
}

/**
 * The ready versions of one page, marked stale: the queue rewrites them and
 * the bodies in KV serve until each new one lands. The page is in the key
 * (root: v1:variant:{cid}:{intent}:{source}, a path: v1:variant:{cid}:p:{enc}:…),
 * as in the confirm.
 */
export async function markPageStale(
  db: D1Database,
  customerId: string,
  pagePath: string,
): Promise<number> {
  const root = `v1:variant:${customerId}:`;
  // A body waiting for the customer's OK is dropped with its cell
  // (docs/specs/versions-approval.md).
  return pagePath === "/"
    ? markVersionsStale(db, customerId, " AND kv_key LIKE ? AND kv_key NOT LIKE ?", [
        `${root}%`,
        `${root}p:%`,
      ])
    : markVersionsStale(db, customerId, " AND kv_key LIKE ?", [
        `${root}p:${encodeURIComponent(pagePath)}:%`,
      ]);
}
