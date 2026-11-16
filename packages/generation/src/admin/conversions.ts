/**
 * Admin conversion-target handlers — V2 Module 3.
 *
 * Four endpoints, all gated by the X-Rawuser-Admin session header:
 *
 *   GET  /admin/conversions/list?customer_id=X
 *     Returns the current list of conversion targets for a customer.
 *
 *   POST /admin/conversions/upsert
 *     body: { customer_id, id?, section_path, label, conversion_label?, enabled? }
 *     Upsert one row. UNIQUE (customer_id, section_path) is the idempotency key.
 *     When id is omitted: INSERT or UPDATE-by-(customer_id, section_path).
 *     When id is provided: UPDATE that specific row.
 *
 *   POST /admin/conversions/confirm
 *     body: { customer_id, targets: Array<{ section_path, label, conversion_label, enabled }> }
 *     Bulk-confirm from the operator review screen after element detection.
 *     For each target: validate the path exists in the confirmed manifest with
 *     conversion_candidate=true, then upsert with denormalized selectors copied
 *     from the manifest.
 *
 *   POST /admin/conversions/delete
 *     body: { id }
 *     Hard-delete a conversion target. (We use POST for the flat path router
 *     since there's no path-param routing in admin/routes.ts.)
 *
 *   POST /admin/conversions/count
 *     body: { customer_id, id }
 *     "Count this button": enable target `id`, disable every other target of
 *     the customer, in one statement. Answers { items } like list.
 *
 * While a test runs (a holdout_tests row with ended_at NULL) the counted
 * buttons are the test's metric and do not move: upsert, confirm, delete
 * and count refuse (409) any write that changes an enabled target or
 * enables another (docs/specs/proof-engine.md, "The customer's own test").
 *
 * Privacy invariants:
 * - No visitor data touched. Conversion targets are operator-configured CTAs
 *   on the customer's own public landing page — same status as the manifest.
 * - conversion_label is validated against a closed enum at write time so the
 *   downstream snippet receives only known event types.
 */

import { type Goes, type Manifest, isGoes, isSiteWideTarget } from "@rawuser/shared";
import type { InstallEnv } from "../install-config.ts";
import { groupAggregate, markGroupTargets } from "../lib/page-groups.ts";
import { sensitiveTargetRefusal } from "../lib/sensitive-guard.ts";
import type { SessionUser } from "./auth.ts";
import type { CorsEnv } from "./cors.ts";
import { jsonWithCors } from "./cors.ts";
import { writeVisitorBundle } from "./onboard.ts";
import { requireCustomerScope } from "./scope.ts";

export interface ConversionsEnv extends CorsEnv, Pick<InstallEnv, "REMEMBER_ON_SENSITIVE"> {
  DB: D1Database;
  /** The visitor bundle is written again after a change (2026-10-01). */
  VARIANTS?: KVNamespace;
}

/** The visitor bundle carries the enabled targets; a change rewrites it. */
async function refreshBundle(env: ConversionsEnv, customerId: string): Promise<void> {
  if (!env.VARIANTS) return;
  try {
    // With the install's var beside the bindings: the bundle's `rm` reads it.
    await writeVisitorBundle(
      {
        DB: env.DB,
        VARIANTS: env.VARIANTS,
        REMEMBER_ON_SENSITIVE: env.REMEMBER_ON_SENSITIVE,
      },
      customerId,
    );
  } catch (e) {
    console.error(
      "[conversions] visitor bundle refresh failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** The one reason every refused write gives while a test runs. */
export const TEST_LOCK_REASON =
  "A test is running, so the buttons it counts cannot change. Stop the test first to change them.";

/** True while the customer has a test period that has not ended. */
export async function testRunning(db: D1Database, customerId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM holdout_tests WHERE customer_id = ? AND ended_at IS NULL LIMIT 1")
    .bind(customerId)
    .first<{ id: string }>();
  return row !== null && row !== undefined;
}

/** What a write leaves a target as, for comparing with the stored row. */
interface TargetValues {
  label: string;
  conversion_label: string;
  enabled: number;
  css_selectors: string;
  text_selectors: string;
  structural_selector: string;
}

/**
 * During a test: a write may not touch the counted set. It passes when the
 * target stays disabled, or when it writes exactly what is stored.
 */
function movesCountedSet(existing: TargetValues | null, next: TargetValues): boolean {
  const counted = existing?.enabled === 1 || next.enabled === 1;
  if (!counted) return false;
  if (!existing) return true;
  return (
    existing.label !== next.label ||
    existing.conversion_label !== next.conversion_label ||
    existing.enabled !== next.enabled ||
    existing.css_selectors !== next.css_selectors ||
    existing.text_selectors !== next.text_selectors ||
    existing.structural_selector !== next.structural_selector
  );
}

async function storedTarget(
  db: D1Database,
  customerId: string,
  sectionPath: string,
): Promise<TargetValues | null> {
  const row = await db
    .prepare(
      `SELECT label, conversion_label, enabled, css_selectors, text_selectors, structural_selector
       FROM conversion_targets WHERE customer_id = ? AND section_path = ?`,
    )
    .bind(customerId, sectionPath)
    .first<TargetValues>();
  return row ?? null;
}

const ALLOWED_CONVERSION_LABELS = new Set([
  "signup",
  "demo_request",
  "trial_start",
  "purchase",
  "contact",
  "waitlist",
  "download",
  "other",
]);

interface ConversionTargetRow {
  id: string;
  customer_id: string;
  section_path: string;
  label: string;
  conversion_label: string;
  enabled: number; // 0 | 1
  css_selectors: string;
  text_selectors: string;
  structural_selector: string;
  created_at: number;
  updated_at: number;
}

interface ConversionTargetResponse {
  id: string;
  customer_id: string;
  section_path: string;
  label: string;
  conversion_label: string;
  enabled: boolean;
  css_selectors: string[];
  text_selectors: string[];
  structural_selector: string;
  created_at: number;
  updated_at: number;
}

function rowToResponse(row: ConversionTargetRow): ConversionTargetResponse {
  return {
    id: row.id,
    customer_id: row.customer_id,
    section_path: row.section_path,
    label: row.label,
    conversion_label: row.conversion_label,
    enabled: row.enabled === 1,
    css_selectors: JSON.parse(row.css_selectors) as string[],
    text_selectors: JSON.parse(row.text_selectors) as string[],
    structural_selector: row.structural_selector,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// GET /admin/conversions/list?customer_id=X
// ---------------------------------------------------------------------------

export async function handleConversionsList(
  request: Request,
  env: ConversionsEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  if (!customerId) {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }

  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  return jsonWithCors({ items: await markedTargetResponses(env.DB, customerId) }, env, 200);
}

/**
 * The list as the dashboard reads it. A group's button
 * (docs/specs/page-groups.md) carries its pattern as `page`, `group: true`
 * and the pages the aggregator counted, so the dashboard can say "on N
 * pages"; a button on every page (visual-picker.md §9, "A button on every
 * page": a `site:` row, or a selector typed by hand into the section path
 * before them) carries `site: true`; every other row is as it was.
 */
export async function markedTargetResponses(
  db: D1Database,
  customerId: string,
): Promise<Array<ConversionTargetResponse & { site?: true }>> {
  const items = await listTargetResponses(db, customerId);
  const withGroups = items.some(
    (t) => t.section_path.startsWith("count:") && t.section_path.endsWith("/*"),
  )
    ? markGroupTargets(items, (await groupAggregate(db, customerId)).groups)
    : items;
  return markSiteTargets(withGroups);
}

/** `site: true` on every target offered on every page that is not a slot. */
export function markSiteTargets<T extends { section_path: string }>(
  items: readonly T[],
): Array<T | (T & { site: true })> {
  return items.map((t) => (isSiteWideTarget(t.section_path) ? { ...t, site: true as const } : t));
}

// ---------------------------------------------------------------------------
// POST /admin/conversions/upsert
// ---------------------------------------------------------------------------

interface UpsertBody {
  customer_id: string;
  id?: string;
  section_path: string;
  label: string;
  conversion_label?: string;
  enabled?: boolean;
  // Selectors required only when not deriving from manifest (manual add).
  css_selectors?: string[];
  text_selectors?: string[];
  structural_selector?: string;
}

export async function handleConversionsUpsert(
  request: Request,
  env: ConversionsEnv,
  user: SessionUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }

  const p = body as Partial<UpsertBody>;
  if (!p.customer_id) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  if (!p.section_path) return jsonWithCors({ error: "section_path is required" }, env, 400);
  if (!p.label || p.label.trim() === "")
    return jsonWithCors({ error: "label is required" }, env, 400);

  const scope = requireCustomerScope(user, p.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  const convLabel = p.conversion_label ?? "other";
  if (!ALLOWED_CONVERSION_LABELS.has(convLabel)) {
    return jsonWithCors(
      {
        error:
          "conversion_label must be one of: signup, demo_request, trial_start, purchase, contact, waitlist, download, other",
      },
      env,
      400,
    );
  }

  const enabled = p.enabled === false ? 0 : 1;
  const now = Date.now();

  // A sensitive customer counts a button picked on a page ("count:{page}")
  // only on `/` and its kept sections (docs/specs/sensitive-customers.md,
  // condition 2); a manifest slot names no page and passes.
  const kept = await sensitiveTargetRefusal(env.DB, p.customer_id, p.section_path);
  if (kept) return jsonWithCors(kept, env, 409);

  // Selectors: prefer body-supplied (manual add); otherwise look up the manifest.
  let cssSelectors: string[] = p.css_selectors ?? [];
  let textSelectors: string[] = p.text_selectors ?? [];
  let structuralSelector = p.structural_selector ?? "";

  if (cssSelectors.length === 0 || structuralSelector === "") {
    // Per-path manifests (A1): conversion targets currently resolve against
    // the homepage '/' manifest. Phase 3 will make conversion targets
    // path-aware; for now pin to '/' to keep the composite-key read
    // deterministic (WHERE customer_id alone could match multiple rows).
    const manifestRow = await env.DB.prepare(
      "SELECT manifest FROM element_manifests WHERE customer_id = ? AND page_path = '/'",
    )
      .bind(p.customer_id)
      .first<{ manifest: string }>();

    if (manifestRow) {
      try {
        const manifest = JSON.parse(manifestRow.manifest) as Manifest;
        const entry = manifest[p.section_path];
        if (entry) {
          if (cssSelectors.length === 0) cssSelectors = entry.css;
          if (textSelectors.length === 0) textSelectors = entry.text;
          if (structuralSelector === "") structuralSelector = entry.structural;
        }
      } catch {
        // Manifest parse failure — fall through with the empty defaults below.
      }
    }
  }

  // Final fallback so we never INSERT NULL on NOT-NULL columns.
  if (cssSelectors.length === 0) cssSelectors = [p.section_path];
  if (structuralSelector === "") structuralSelector = p.section_path;

  if (await testRunning(env.DB, p.customer_id)) {
    const existing = await storedTarget(env.DB, p.customer_id, p.section_path);
    const next: TargetValues = {
      label: p.label,
      conversion_label: convLabel,
      enabled,
      css_selectors: JSON.stringify(cssSelectors),
      text_selectors: JSON.stringify(textSelectors),
      structural_selector: structuralSelector,
    };
    if (movesCountedSet(existing, next)) {
      return jsonWithCors({ error: TEST_LOCK_REASON }, env, 409);
    }
  }

  // Upsert by (customer_id, section_path).
  await env.DB.prepare(
    `INSERT INTO conversion_targets
       (customer_id, section_path, label, conversion_label, enabled,
        css_selectors, text_selectors, structural_selector,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(customer_id, section_path) DO UPDATE SET
       label = excluded.label,
       conversion_label = excluded.conversion_label,
       enabled = excluded.enabled,
       css_selectors = excluded.css_selectors,
       text_selectors = excluded.text_selectors,
       structural_selector = excluded.structural_selector,
       updated_at = excluded.updated_at`,
  )
    .bind(
      p.customer_id,
      p.section_path,
      p.label,
      convLabel,
      enabled,
      JSON.stringify(cssSelectors),
      JSON.stringify(textSelectors),
      structuralSelector,
      now,
      now,
    )
    .run();

  // Read back the row to return the canonical shape (including the generated id).
  const row = await env.DB.prepare(
    `SELECT id, customer_id, section_path, label, conversion_label, enabled,
            css_selectors, text_selectors, structural_selector,
            created_at, updated_at
     FROM conversion_targets
     WHERE customer_id = ? AND section_path = ?`,
  )
    .bind(p.customer_id, p.section_path)
    .first<ConversionTargetRow>();

  if (!row) {
    return jsonWithCors({ error: "Upsert succeeded but row not found" }, env, 500);
  }

  await refreshBundle(env, p.customer_id);
  return jsonWithCors(rowToResponse(row), env, 200);
}

// ---------------------------------------------------------------------------
// POST /admin/conversions/confirm
// ---------------------------------------------------------------------------

interface ConfirmBody {
  customer_id: string;
  targets: Array<{
    section_path: string;
    label: string;
    conversion_label?: string;
    enabled?: boolean;
  }>;
}

export async function handleConversionsConfirm(
  request: Request,
  env: ConversionsEnv,
  user: SessionUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }

  const p = body as Partial<ConfirmBody>;
  if (!p.customer_id) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  if (!Array.isArray(p.targets)) {
    return jsonWithCors({ error: "targets must be an array" }, env, 400);
  }

  const scope = requireCustomerScope(user, p.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  // Load the confirmed manifest once. Confirm flow requires the manifest to
  // already be confirmed — if it isn't, fail loudly so the operator goes back
  // to element confirm first.
  const manifestRow = await env.DB.prepare(
    "SELECT manifest FROM element_manifests WHERE customer_id = ? AND page_path = '/' AND confirmed_at IS NOT NULL",
  )
    .bind(p.customer_id)
    .first<{ manifest: string }>();

  if (!manifestRow) {
    return jsonWithCors(
      {
        error:
          "No confirmed manifest for this customer. Confirm elements via /admin/onboard/confirm first.",
      },
      env,
      400,
    );
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestRow.manifest) as Manifest;
  } catch {
    return jsonWithCors({ error: "Stored manifest is corrupt" }, env, 500);
  }

  // During a test, refuse the whole request before writing anything when
  // one of its targets would change the counted set.
  if (await testRunning(env.DB, p.customer_id)) {
    for (const t of p.targets) {
      if (typeof t.section_path !== "string" || typeof t.label !== "string") continue;
      const entry = manifest[t.section_path];
      if (!entry || t.label.trim() === "") continue;
      const next: TargetValues = {
        label: t.label,
        conversion_label: t.conversion_label ?? "other",
        enabled: t.enabled === false ? 0 : 1,
        css_selectors: JSON.stringify(entry.css),
        text_selectors: JSON.stringify(entry.text),
        structural_selector: entry.structural,
      };
      if (movesCountedSet(await storedTarget(env.DB, p.customer_id, t.section_path), next)) {
        return jsonWithCors({ error: TEST_LOCK_REASON }, env, 409);
      }
    }
  }

  const now = Date.now();
  const accepted: ConversionTargetResponse[] = [];
  const rejected: Array<{ section_path: string; reason: string }> = [];

  for (const t of p.targets) {
    if (typeof t.section_path !== "string" || t.section_path === "") {
      rejected.push({ section_path: String(t.section_path), reason: "missing section_path" });
      continue;
    }
    if (typeof t.label !== "string" || t.label.trim() === "") {
      rejected.push({ section_path: t.section_path, reason: "missing label" });
      continue;
    }
    const convLabel = t.conversion_label ?? "other";
    if (!ALLOWED_CONVERSION_LABELS.has(convLabel)) {
      rejected.push({ section_path: t.section_path, reason: "invalid conversion_label" });
      continue;
    }
    const entry = manifest[t.section_path];
    if (!entry) {
      rejected.push({
        section_path: t.section_path,
        reason: "section_path not present in confirmed manifest",
      });
      continue;
    }

    const enabled = t.enabled === false ? 0 : 1;

    await env.DB.prepare(
      `INSERT INTO conversion_targets
         (customer_id, section_path, label, conversion_label, enabled,
          css_selectors, text_selectors, structural_selector,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(customer_id, section_path) DO UPDATE SET
         label = excluded.label,
         conversion_label = excluded.conversion_label,
         enabled = excluded.enabled,
         css_selectors = excluded.css_selectors,
         text_selectors = excluded.text_selectors,
         structural_selector = excluded.structural_selector,
         updated_at = excluded.updated_at`,
    )
      .bind(
        p.customer_id,
        t.section_path,
        t.label,
        convLabel,
        enabled,
        JSON.stringify(entry.css),
        JSON.stringify(entry.text),
        entry.structural,
        now,
        now,
      )
      .run();

    const row = await env.DB.prepare(
      `SELECT id, customer_id, section_path, label, conversion_label, enabled,
              css_selectors, text_selectors, structural_selector,
              created_at, updated_at
       FROM conversion_targets
       WHERE customer_id = ? AND section_path = ?`,
    )
      .bind(p.customer_id, t.section_path)
      .first<ConversionTargetRow>();

    if (row) accepted.push(rowToResponse(row));
  }

  await refreshBundle(env, p.customer_id);
  return jsonWithCors({ accepted, rejected }, env, 200);
}

// ---------------------------------------------------------------------------
// POST /admin/conversions/delete
// ---------------------------------------------------------------------------

interface DeleteBody {
  id: string;
}

export async function handleConversionsDelete(
  request: Request,
  env: ConversionsEnv,
  user: SessionUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }

  const p = body as Partial<DeleteBody>;
  if (!p.id || typeof p.id !== "string") {
    return jsonWithCors({ error: "id is required" }, env, 400);
  }

  // Look up the row's customer_id first so we can scope-check before deleting.
  // For customer-role users probing arbitrary ids of other customers, the
  // 403 is the right response — never reveal "row exists" via a 404.
  const row = await env.DB.prepare(
    "SELECT customer_id, enabled FROM conversion_targets WHERE id = ?",
  )
    .bind(p.id)
    .first<{ customer_id: string; enabled: number }>();

  if (!row) {
    // For superadmin a 404 is fine. For customer role, return 403 so the
    // endpoint can't be used to enumerate which ids exist.
    if (user.role === "customer") {
      return jsonWithCors({ error: "Forbidden: cross-customer access denied" }, env, 403);
    }
    return jsonWithCors({ error: "Conversion target not found" }, env, 404);
  }

  const scope = requireCustomerScope(user, row.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);

  if (Number(row.enabled) === 1 && (await testRunning(env.DB, row.customer_id))) {
    return jsonWithCors({ error: TEST_LOCK_REASON }, env, 409);
  }

  await env.DB.prepare("DELETE FROM conversion_targets WHERE id = ?").bind(p.id).run();
  await refreshBundle(env, row.customer_id);

  return jsonWithCors({ deleted: true, id: p.id }, env, 200);
}

// ---------------------------------------------------------------------------
// POST /admin/conversions/count
// ---------------------------------------------------------------------------

/**
 * "Count this button": the chosen target is the only one enabled. One
 * UPDATE over the customer's targets, then the visitor bundle again.
 * During a test it passes only when nothing would change.
 */
export async function handleConversionsCount(
  request: Request,
  env: ConversionsEnv,
  user: SessionUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  const p = body as { customer_id?: unknown; id?: unknown };
  const customerId = typeof p.customer_id === "string" ? p.customer_id : "";
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  if (typeof p.id !== "string" || p.id === "") {
    return jsonWithCors({ error: "id is required" }, env, 400);
  }

  const rows =
    (
      await env.DB.prepare(
        `SELECT id, customer_id, section_path, label, conversion_label, enabled,
                css_selectors, text_selectors, structural_selector,
                created_at, updated_at
         FROM conversion_targets
         WHERE customer_id = ?
         ORDER BY created_at ASC`,
      )
        .bind(customerId)
        .all<ConversionTargetRow>()
    ).results ?? [];
  const chosen = rows.find((r) => r.id === p.id);
  if (!chosen) {
    return jsonWithCors({ error: "Button not found" }, env, 404);
  }
  // A button picked on a page outside the kept sections of a sensitive
  // customer (one from before it was marked) is never switched on
  // (docs/specs/sensitive-customers.md, condition 2).
  const kept = await sensitiveTargetRefusal(env.DB, customerId, chosen.section_path);
  if (kept) return jsonWithCors(kept, env, 409);
  const unchanged = rows.every((r) => (Number(r.enabled) === 1) === (r.id === p.id));
  if (!unchanged) {
    if (await testRunning(env.DB, customerId)) {
      return jsonWithCors({ error: TEST_LOCK_REASON }, env, 409);
    }
    await env.DB.prepare(
      `UPDATE conversion_targets
       SET enabled = CASE WHEN id = ?1 THEN 1 ELSE 0 END, updated_at = ?2
       WHERE customer_id = ?3 AND enabled != (CASE WHEN id = ?1 THEN 1 ELSE 0 END)`,
    )
      .bind(p.id, Date.now(), customerId)
      .run();
    await refreshBundle(env, customerId);
  }

  const after = await env.DB.prepare(
    `SELECT id, customer_id, section_path, label, conversion_label, enabled,
            css_selectors, text_selectors, structural_selector,
            created_at, updated_at
     FROM conversion_targets
     WHERE customer_id = ?
     ORDER BY created_at ASC`,
  )
    .bind(customerId)
    .all<ConversionTargetRow>();
  return jsonWithCors({ items: (after.results ?? []).map(rowToResponse) }, env, 200);
}

// ---------------------------------------------------------------------------
// Shared with the count-only pick (count-pick.ts, visual-picker.md §9)
// ---------------------------------------------------------------------------

/** The customer's targets as list answers them. */
export async function listTargetResponses(
  db: D1Database,
  customerId: string,
): Promise<ConversionTargetResponse[]> {
  const result = await db
    .prepare(
      `SELECT id, customer_id, section_path, label, conversion_label, enabled,
              css_selectors, text_selectors, structural_selector,
              created_at, updated_at
       FROM conversion_targets
       WHERE customer_id = ?
       ORDER BY created_at ASC`,
    )
    .bind(customerId)
    .all<ConversionTargetRow>();
  return (result.results ?? []).map(rowToResponse);
}

/**
 * The count path's write without its request: target `id` the only one
 * enabled, then the visitor bundle again. The caller checks the test lock.
 */
export async function countOnly(
  env: ConversionsEnv,
  customerId: string,
  id: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE conversion_targets
     SET enabled = CASE WHEN id = ?1 THEN 1 ELSE 0 END, updated_at = ?2
     WHERE customer_id = ?3 AND enabled != (CASE WHEN id = ?1 THEN 1 ELSE 0 END)`,
  )
    .bind(id, Date.now(), customerId)
    .run();
  await refreshBundle(env, customerId);
}

// ---------------------------------------------------------------------------
// The counted button at the first go live (docs/specs/measure-at-go-live.md, §6)
// ---------------------------------------------------------------------------

/** What go live writes for the button to count. */
export interface CountedTargetValues {
  label: string;
  conversion_label: string;
  css_selectors: string[];
  text_selectors: string[];
  structural_selector: string;
  /** Where the button goes (readiness-check.md, check 2); null when not known. */
  goes?: Goes | null;
}

/**
 * Make `sectionPath` the one counted button (A3), from go live. With
 * `values`, the target is written (insert or update) first; without, it must
 * already exist (a button picked on the page). Refused while a test runs
 * (A2), like every other write to the counted set. Rewrites the bundle.
 */
export async function countOnlyTarget(
  env: ConversionsEnv,
  customerId: string,
  sectionPath: string,
  values?: CountedTargetValues,
): Promise<{ ok: true; label: string } | { ok: false; reason: "locked" | "missing" }> {
  if (await testRunning(env.DB, customerId)) return { ok: false, reason: "locked" };
  const now = Date.now();
  if (values) {
    if (!ALLOWED_CONVERSION_LABELS.has(values.conversion_label)) values.conversion_label = "other";
    // `goes` is one of the closed words or NULL (migration 0044); anything
    // else is stored as not known.
    const goes = isGoes(values.goes) ? values.goes : null;
    await env.DB.prepare(
      `INSERT INTO conversion_targets
         (customer_id, section_path, label, conversion_label, enabled,
          css_selectors, text_selectors, structural_selector, goes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(customer_id, section_path) DO UPDATE SET
         label = excluded.label, conversion_label = excluded.conversion_label,
         enabled = 1, css_selectors = excluded.css_selectors,
         text_selectors = excluded.text_selectors,
         structural_selector = excluded.structural_selector, goes = excluded.goes,
         updated_at = excluded.updated_at`,
    )
      .bind(
        customerId,
        sectionPath,
        values.label,
        values.conversion_label,
        JSON.stringify(values.css_selectors),
        JSON.stringify(values.text_selectors),
        values.structural_selector,
        goes,
        now,
        now,
      )
      .run();
  }
  const row = await env.DB.prepare(
    "SELECT label FROM conversion_targets WHERE customer_id = ? AND section_path = ?",
  )
    .bind(customerId, sectionPath)
    .first<{ label: string }>();
  if (!row) return { ok: false, reason: "missing" };
  await env.DB.prepare(
    `UPDATE conversion_targets
     SET enabled = CASE WHEN section_path = ?1 THEN 1 ELSE 0 END, updated_at = ?2
     WHERE customer_id = ?3 AND enabled != (CASE WHEN section_path = ?1 THEN 1 ELSE 0 END)`,
  )
    .bind(sectionPath, now, customerId)
    .run();
  await refreshBundle(env, customerId);
  return { ok: true, label: row.label };
}
