/**
 * The site map's endpoints (docs/specs/site-shaped-intents.md §8, §16 API
 * contract): what the Look row, the Change dialog, the Pages card's
 * re-read line and the Versions screen's folded line read and write.
 * Operator-authenticated and customer-scoped; paths and link texts go only
 * to that customer's own dashboard (privacy review condition 6).
 *
 *   GET  /admin/site-map?customer_id=X
 *   POST /admin/site-map         { customer_id, on?, paths?, delete? }
 *   POST /admin/site-map/write   { customer_id }
 */

import {
  FOLD_TO,
  INTENT_DIMENSIONS,
  type IntentDim,
  SITE_PATHS_PER_CUSTOMER,
  SITE_PATH_MAX,
  type SiteKindOrNone,
  isSiteKindOrNone,
  normalizePath,
  pagePathRefusal,
} from "@rawuser/shared";
import { refreshKeywordLexicon } from "../keywords/lexicon.ts";
import { GENERATED_SOURCE_DIMS } from "../prompts/source-modifiers.ts";
import {
  PENDING_AUTO_MS,
  applyPending,
  loadSiteState,
  recomputeServed,
  setOperatorRows,
  setSiteMapOff,
  writeSiteBundle,
} from "../site-map/store.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { requireCustomerScope } from "./scope.ts";

/** Versions per page per served intent: the default plus the generated sources. */
export const VERSIONS_PER_INTENT = 1 + GENERATED_SOURCE_DIMS.length;

export interface SiteMapPath {
  path: string;
  lang: string | null;
  kind: SiteKindOrNone;
  /** The link text, only when it named the kind in a capture (condition 2); else null. */
  label: string | null;
  confidence: "high" | "medium" | "model" | "operator";
  /** The page it was read on; "" for a row the operator added. */
  found_on: string;
  /** A re-read no longer finds the link; it keeps working and goes 30 days later. */
  missing: boolean;
}

export interface SiteMapView {
  customer_id: string;
  on: boolean;
  paths: SiteMapPath[];
  /** The languages the rows were read in, most rows first. */
  languages: string[];
  served: IntentDim[];
  folded: Array<{ intent: IntentDim; to: IntentDim; reason: string }>;
  reasons: { pricing: string; competitor: string } | null;
  versions_per_page: number;
  /** Confirmed pages (each gets versions_per_page versions). */
  pages: number;
  pending: {
    intents: IntentDim[];
    paths: Array<{ path: string; kind: SiteKindOrNone }>;
    since: number;
    auto_at: number;
    /** New versions the Write button starts, over every confirmed page. */
    versions: number;
  } | null;
}

export async function siteMapView(db: D1Database, customerId: string): Promise<SiteMapView> {
  const [state, pagesRow] = await Promise.all([
    loadSiteState(db, customerId),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL",
      )
      .bind(customerId)
      .first<{ n: number }>(),
  ]);
  const pages = Number(pagesRow?.n ?? 0);
  const served = state.off ? [...INTENT_DIMENSIONS] : (state.served ?? [...INTENT_DIMENSIONS]);
  const reasons = state.off ? null : state.reasons;
  const langCount = new Map<string, number>();
  for (const r of state.rows) {
    if (r.lang) langCount.set(r.lang, (langCount.get(r.lang) ?? 0) + 1);
  }
  const pending = !state.off && reasons?.pending ? reasons.pending : null;
  const kindOf = new Map(state.rows.map((r) => [r.path, r.kind]));
  return {
    customer_id: customerId,
    on: !state.off,
    paths: state.rows.map((r) => ({
      path: r.path,
      lang: r.lang,
      kind: r.kind,
      label: r.label,
      confidence: r.confidence,
      found_on: r.found_on,
      missing: r.missing_since !== null,
    })),
    languages: [...langCount.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l),
    served,
    folded: INTENT_DIMENSIONS.filter((d) => !served.includes(d)).map((d) => ({
      intent: d,
      to: FOLD_TO[d] ?? "evaluation",
      reason:
        (d === "pricing" ? reasons?.pricing : d === "competitor" ? reasons?.competitor : null) ??
        "none",
    })),
    reasons: reasons ? { pricing: reasons.pricing, competitor: reasons.competitor } : null,
    versions_per_page: served.length * VERSIONS_PER_INTENT,
    pages,
    pending: pending
      ? {
          intents: pending.intents,
          paths: pending.paths.map((p) => ({ path: p, kind: kindOf.get(p) ?? "none" })),
          since: pending.since,
          auto_at: pending.since + PENDING_AUTO_MS,
          versions: pending.intents.length * VERSIONS_PER_INTENT * pages,
        }
      : null,
  };
}

export async function handleSiteMapGet(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const customerId = new URL(request.url).searchParams.get("customer_id");
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  return jsonWithCors(await siteMapView(env.DB, customerId), env, 200);
}

/** One operator row from the dialog, validated; a refusal line otherwise. */
export function operatorRow(v: unknown): { path: string; kind: SiteKindOrNone } | string {
  if (!v || typeof v !== "object") return "Each row needs a path and a kind";
  const { path, kind } = v as { path?: unknown; kind?: unknown };
  if (typeof path !== "string" || !path.startsWith("/")) return "A path starts with /";
  if (!isSiteKindOrNone(kind)) return "Unknown kind";
  const refusal = pagePathRefusal(path);
  if (refusal) return refusal;
  const p = normalizePath(path);
  if (p === "/") return "The homepage is not a page to map";
  if (p.length > SITE_PATH_MAX) return "That path is too long";
  return { path: p, kind };
}

export async function handleSiteMapSet(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  const b = (body ?? {}) as {
    customer_id?: unknown;
    on?: unknown;
    paths?: unknown;
    delete?: unknown;
  };
  if (typeof b.customer_id !== "string" || b.customer_id === "") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const customerId = b.customer_id;
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  if (b.on !== undefined && typeof b.on !== "boolean") {
    return jsonWithCors({ error: "on is true or false" }, env, 400);
  }
  const now = Date.now();
  const before = await loadSiteState(env.DB, customerId);

  // Off (condition 5): rows deleted, reading stopped, six intents.
  if (b.on === false) {
    if (!before.off) {
      await setSiteMapOff(env.DB, customerId, true, now);
      await writeSiteBundle(env, customerId);
      if (before.served !== null) await refreshKeywordLexicon(env, customerId, ctx);
    }
    return jsonWithCors(await siteMapView(env.DB, customerId), env, 200);
  }
  // Off means empty (privacy review re-review, §13.2 point 5): rows wait until
  // the map is on again, in this request or an earlier one.
  if (before.off && b.on !== true && (b.paths !== undefined || b.delete !== undefined)) {
    return jsonWithCors(
      { error: "Turn the map on first", ...(await siteMapView(env.DB, customerId)) },
      env,
      409,
    );
  }
  if (b.on === true && before.off) await setSiteMapOff(env.DB, customerId, false, now);

  const rows: Array<{ path: string; kind: SiteKindOrNone }> = [];
  if (b.paths !== undefined) {
    if (!Array.isArray(b.paths) || b.paths.length > SITE_PATHS_PER_CUSTOMER) {
      return jsonWithCors({ error: "paths is a list of at most 200 rows" }, env, 400);
    }
    for (const v of b.paths) {
      const r = operatorRow(v);
      if (typeof r === "string") return jsonWithCors({ error: r }, env, 400);
      rows.push(r);
    }
  }
  const deletes: string[] = [];
  if (b.delete !== undefined) {
    if (!Array.isArray(b.delete) || b.delete.length > SITE_PATHS_PER_CUSTOMER) {
      return jsonWithCors({ error: "delete is a list of paths" }, env, 400);
    }
    for (const v of b.delete) {
      if (typeof v !== "string")
        return jsonWithCors({ error: "delete is a list of paths" }, env, 400);
      deletes.push(normalizePath(v));
    }
  }
  if (rows.length > 0 || deletes.length > 0) {
    const r = await setOperatorRows(env.DB, customerId, rows, deletes, now);
    if (r.refused > 0) {
      return jsonWithCors(
        { error: "At most 200 pages", ...(await siteMapView(env.DB, customerId)) },
        env,
        409,
      );
    }
    // The operator's own choice applies at once, a growth included.
    const served = await recomputeServed(env.DB, customerId, { now, mode: "apply" });
    await writeSiteBundle(env, customerId);
    // The served set moved: the keyword lexicon follows it (keyword-intent.md §4).
    if (served.changed) await refreshKeywordLexicon(env, customerId, ctx);
  }
  return jsonWithCors(await siteMapView(env.DB, customerId), env, 200);
}

/** The Pages card's Write: the waiting growth is applied and the queue writes it. */
export async function handleSiteMapWrite(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  const customerId = (body as { customer_id?: unknown })?.customer_id;
  if (typeof customerId !== "string" || customerId === "") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const r = await applyPending(env.DB, customerId, Date.now());
  if (r.applied.length > 0) {
    await writeSiteBundle(env, customerId);
    await refreshKeywordLexicon(env, customerId, ctx);
  }
  return jsonWithCors({ applied: r.applied, ...(await siteMapView(env.DB, customerId)) }, env, 200);
}
