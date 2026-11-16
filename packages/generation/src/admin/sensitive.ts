/**
 * The sensitive flag and the kept sections of one customer
 * (docs/specs/sensitive-customers.md, "The endpoint (as built)").
 *
 *   GET  /admin/customers/sensitive?customer_id=   superadmin
 *   POST /admin/customers/sensitive                superadmin:
 *        { customer_id, sensitive?: boolean, kept_sections?: string[] }
 *
 * The write stores `customers.sensitive` and `customers.kept_sections`, then
 * rewrites the hide rules and the visitor bundle (the call the confirm path
 * makes), so the edge has `s` and `sk` without a database read. The flag
 * cannot be on while a confirmed page or a counted picked button stands
 * outside `/` and the list (409 naming the pages). Turning it on marks the
 * customer's ready versions stale for the queue (the claims lock,
 * docs/specs/claims-lock.md; `versions_marked_stale` in the answer).
 * Turning it off, or
 * changing the list, touches no stored row: the rows of a customer marked
 * after its first visit, or stored under a list that was longer, are
 * rewritten by the founder's statements (the spec, "Existing rows"), and
 * the answer says when that is needed (`rows_to_rewrite` and a plain
 * `warning` naming what to run).
 *
 * Operator settings and the customer's own page paths; nothing about a
 * visitor. The superadmin gate lives in routes.ts.
 */

import {
  MAX_KEPT_SECTIONS,
  MAX_KEPT_SECTION_DEPTH,
  MAX_KEPT_SECTION_LENGTH,
  type SensitiveSettings,
  parseKeptSections,
  validKeptSections,
  visitorBundleKey,
} from "@rawuser/shared";
import { clearKeywordLexicon } from "../keywords/lexicon.ts";
import { type ForeignPages, foreignPages } from "../lib/sensitive-guard.ts";
import { markVersionsStale } from "../lib/version-approval.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { writeHideRules } from "./onboard.ts";

/** The one line for a list that is not valid. */
export const KEPT_SECTIONS_LINE = `kept_sections must be a list of at most ${MAX_KEPT_SECTIONS} paths like /products: plain words, at most ${MAX_KEPT_SECTION_DEPTH} deep and ${MAX_KEPT_SECTION_LENGTH} characters, no query and nothing that names one account.`;

/** The machine word of the 409 below. */
export const PAGES_OUTSIDE_CODE = "pages_outside";

/** The 409 sentence: the pages that stand outside `/` and the list. */
export function pagesOutsideLine(outside: ForeignPages): string {
  const names = [...new Set([...outside.pages, ...outside.counted])].sort();
  return `Remove these pages or add their sections to the list first: ${names.join(", ")}.`;
}

/** What both methods answer with. */
export interface SensitiveView {
  customer_id: string;
  sensitive: boolean;
  /** The stored list, as validKeptSections returns it; kept while the flag is off too. */
  kept_sections: string[];
  /**
   * Confirmed pages and counted picked buttons outside `/` and the list.
   * Always empty while the flag is on; while it is off, what must be removed
   * or listed before it can be turned on.
   */
  outside: ForeignPages;
  limits: { sections: number; length: number; depth: number };
}

/**
 * Stored rows the change leaves behind, for the founder's statements
 * (docs/ops, the spec's "Existing rows"); the endpoint rewrites none. Only
 * for a customer that already has event rows.
 * - `marked`: the flag went on; rows from before may name a page beside a
 *   marker.
 * - `shortened`: the flag stays on and sections left the list; rows stored
 *   before still name them, and their days of page_days were folded under
 *   the longer list (a read folds again, so nothing is shown meanwhile).
 * A section added to the list leaves nothing behind.
 */
export interface RowsToRewrite {
  why: "marked" | "shortened";
  /** The sections taken off the list; empty for `marked`. */
  removed: string[];
}

/**
 * The plain line beside `rows_to_rewrite`, as `warning`. The wait: the edge
 * keeps a bundle up to five minutes in the colo and the flag five minutes in
 * the isolate, so a change reaches `/event` in about ten.
 */
const THEN =
  'Wait ten minutes for the edge to take the change, then run the rewrite statements and POST /admin/proof/backfill with what: "outcomes".';

export const REWRITE_WARNINGS = {
  marked: `This customer already has visits, and their rows may name a page. ${THEN}`,
  shortened: `Rows stored before this change still name the removed sections. ${THEN}`,
} as const;

const LIMITS = {
  sections: MAX_KEPT_SECTIONS,
  length: MAX_KEPT_SECTION_LENGTH,
  depth: MAX_KEPT_SECTION_DEPTH,
};

interface StoredRow {
  sensitive: number | null;
  kept_sections: string | null;
}

async function storedRow(db: D1Database, customerId: string): Promise<StoredRow | null> {
  return db
    .prepare("SELECT sensitive, kept_sections FROM customers WHERE id = ?")
    .bind(customerId)
    .first<StoredRow>();
}

async function viewOf(db: D1Database, customerId: string, row: StoredRow): Promise<SensitiveView> {
  const kept = parseKeptSections(row.kept_sections);
  return {
    customer_id: customerId,
    sensitive: Number(row.sensitive) === 1,
    kept_sections: kept,
    outside: await foreignPages(db, customerId, kept),
    limits: LIMITS,
  };
}

export async function handleSensitiveGet(request: Request, env: AdminEnv): Promise<Response> {
  const customerId = new URL(request.url).searchParams.get("customer_id");
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const row = await storedRow(env.DB, customerId);
  if (!row) return jsonWithCors({ error: "Customer not found" }, env, 404);
  return jsonWithCors(await viewOf(env.DB, customerId, row), env, 200);
}

/** `customers.kept_sections` for a list: NULL is the empty list. */
export function keptSectionsColumn(kept: readonly string[]): string | null {
  return kept.length > 0 ? JSON.stringify(kept) : null;
}

/**
 * A creation's `sensitive` and `kept_sections` (POST /admin/customers/create,
 * superadmin): the settings to store, null when the body asks for none, or
 * the 400 line. The list is taken only with `sensitive: true`: a customer is
 * marked before its tag is handed out, and a list without the flag would
 * read as a mark that is not there.
 */
export function creationSettings(body: {
  sensitive?: unknown;
  kept_sections?: unknown;
}): { ok: true; settings: SensitiveSettings | null } | { ok: false; error: string } {
  if (body.sensitive !== undefined && typeof body.sensitive !== "boolean") {
    return { ok: false, error: "sensitive must be true or false" };
  }
  if (body.sensitive !== true) {
    if (body.kept_sections !== undefined) {
      return { ok: false, error: "kept_sections needs sensitive: true" };
    }
    return { ok: true, settings: null };
  }
  const kept = body.kept_sections === undefined ? [] : validKeptSections(body.kept_sections);
  if (kept === null) return { ok: false, error: KEPT_SECTIONS_LINE };
  return { ok: true, settings: { sensitive: true, kept } };
}

export async function handleSensitiveSet(request: Request, env: AdminEnv): Promise<Response> {
  let body: { customer_id?: unknown; sensitive?: unknown; kept_sections?: unknown };
  try {
    body = ((await request.json()) ?? {}) as typeof body;
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  if (typeof body.customer_id !== "string" || body.customer_id === "") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const customerId = body.customer_id;
  if (body.sensitive === undefined && body.kept_sections === undefined) {
    return jsonWithCors({ error: "Give sensitive, kept_sections or both" }, env, 400);
  }
  if (body.sensitive !== undefined && typeof body.sensitive !== "boolean") {
    return jsonWithCors({ error: "sensitive must be true or false" }, env, 400);
  }
  let list: string[] | null = null;
  if (body.kept_sections !== undefined) {
    list = validKeptSections(body.kept_sections);
    if (list === null) return jsonWithCors({ error: KEPT_SECTIONS_LINE }, env, 400);
  }

  const before = await storedRow(env.DB, customerId);
  if (!before) return jsonWithCors({ error: "Customer not found" }, env, 404);
  const wasSensitive = Number(before.sensitive) === 1;
  const sensitive = typeof body.sensitive === "boolean" ? body.sensitive : wasSensitive;
  const kept = list ?? parseKeptSections(before.kept_sections);

  // On, or staying on with another list: nothing confirmed or counted may
  // stand outside `/` and the list as it will be (condition 2).
  if (sensitive) {
    const outside = await foreignPages(env.DB, customerId, kept);
    if (outside.pages.length + outside.counted.length > 0) {
      return jsonWithCors(
        {
          error: pagesOutsideLine(outside),
          code: PAGES_OUTSIDE_CODE,
          pages: outside.pages,
          counted: outside.counted,
        },
        env,
        409,
      );
    }
  }

  const column = keptSectionsColumn(kept);
  const changed = sensitive !== wasSensitive || column !== (before.kept_sections ?? null);
  if (changed) {
    // The mark answers the special-category question when nobody has
    // (readiness-check.md, check 3; migration 0044): a customer created as
    // sensitive, or marked before the question existed, never reads as
    // unanswered. An answer already given is left as it is.
    await env.DB.prepare(
      `UPDATE customers SET sensitive = ?, kept_sections = ?,
         special_category = CASE WHEN ? = 1 THEN COALESCE(special_category, 1) ELSE special_category END,
         special_category_at = CASE WHEN ? = 1 THEN COALESCE(special_category_at, ?) ELSE special_category_at END
       WHERE id = ?`,
    )
      .bind(sensitive ? 1 : 0, column, sensitive ? 1 : 0, sensitive ? 1 : 0, Date.now(), customerId)
      .run();
  }
  // The flag went on: every ready version was written without the claims
  // lock (docs/specs/claims-lock.md), so it is marked stale and the
  // five-minute queue rewrites it under the lock. KV bodies keep serving
  // until each new one lands. Off, or any other change, marks none.
  let versionsMarkedStale = 0;
  if (changed && sensitive && !wasSensitive) {
    // A body waiting for the customer's OK was written without the lock
    // too: it is dropped, never approvable (docs/specs/versions-approval.md).
    versionsMarkedStale = await markVersionsStale(env.DB, customerId);
  }
  // A sensitive customer has no keyword lexicon (docs/specs/keyword-intent.md;
  // privacy review, section 10, condition 8): the column is cleared whether or not
  // the flag moved, and the bundle below goes without `kl`.
  if (sensitive) {
    try {
      await clearKeywordLexicon(env.DB, customerId);
    } catch {
      console.error("[rawuser/sensitive] keyword lexicon not cleared");
      return jsonWithCors(
        { error: "Saved, but the keyword list was not cleared. Send the same request again." },
        env,
        500,
      );
    }
  }
  // The hide rules and the bundle, written again whether or not the row
  // moved: sending the same settings again heals a bundle that was lost.
  try {
    await writeHideRules(env, customerId);
  } catch {
    // A bundle from before the change would tell the edge the customer is
    // not sensitive. With none, the edge reads the flag from the database
    // and fails closed (condition 3), so the old one is removed.
    try {
      await env.VARIANTS.delete(visitorBundleKey(customerId));
    } catch {
      console.error("[rawuser/sensitive] stale bundle not removed");
    }
    console.error("[rawuser/sensitive] bundle not written after a change");
    return jsonWithCors(
      { error: "Saved, but the edge copy was not written. Send the same request again." },
      env,
      500,
    );
  }

  // What the change leaves in the stored rows. Nothing is rewritten here;
  // the answer names what must be run afterwards.
  let rowsToRewrite: RowsToRewrite | null = null;
  const removed =
    sensitive && wasSensitive
      ? parseKeptSections(before.kept_sections).filter((k) => !kept.includes(k))
      : [];
  if (sensitive && (!wasSensitive || removed.length > 0)) {
    const any = await env.DB.prepare("SELECT 1 AS n FROM events WHERE customer_id = ? LIMIT 1")
      .bind(customerId)
      .first<{ n: number }>();
    if (any) rowsToRewrite = { why: wasSensitive ? "shortened" : "marked", removed };
  }

  const after = (await storedRow(env.DB, customerId)) ?? before;
  return jsonWithCors(
    {
      ...(await viewOf(env.DB, customerId, after)),
      changed,
      versions_marked_stale: versionsMarkedStale,
      rows_to_rewrite: rowsToRewrite,
      warning: rowsToRewrite ? REWRITE_WARNINGS[rowsToRewrite.why] : null,
    },
    env,
    200,
  );
}
