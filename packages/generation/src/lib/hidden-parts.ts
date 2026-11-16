/**
 * A part no version writes is not hidden (A14 of
 * docs/specs/pilot-gaps.md; docs/specs/quiet-swap.md, "A part no
 * version writes").
 *
 * The hide rules came from the manifest alone: every confirmed part was
 * hidden before the first paint and shown at the reveal. Live on the pilot's site the
 * form's submit button was in the manifest and in no version, so on every
 * load of every page with that form it was hidden and then shown exactly as
 * built (218 ms on one measured load). Hiding is for a part whose words are
 * about to change.
 *
 * So a part is hidden only when the body of at least one version of its
 * page writes it. The order of events decides when that may be said:
 *
 * - at go live the hide rules are written at the confirm and the versions
 *   minutes later; a part with no version yet must stay hidden, or its
 *   original would be read and then change;
 * - during a rewrite a new body may write a part the old ones did not.
 *
 * A page is therefore read only once it is **settled**: every version it
 * should have exists as a row, none is waiting for a write that is about to
 * happen (stale, or a refused first write due its early retry), and the
 * body of every row can be read. Any other page keeps every part hidden, as
 * before. The rules are rebuilt after each run that tried a version, when
 * versions are marked stale, and by the six-hourly sweep, so a page moves
 * between the two states at the moments its versions do.
 *
 * Read from our own rows (`variants`, `version_bodies`): our text, nothing
 * about a visitor.
 */

import { INTENT_DIMENSIONS, type IntentDim } from "@rawuser/shared";
import { GENERATED_SOURCE_DIMS } from "../prompts/source-modifiers.ts";
import { parseVariantKey } from "./publish-version.ts";
import { FIRST_WRITE_RETRIED } from "./variant-rows.ts";

interface Row {
  kv_key: string;
  status: string;
  body_id: string | null;
  cost_usd: number | null;
  error_reason: string | null;
  lint_flags: string | null;
}

/** The cells a page should have: each served intent, its default and the generated sources. */
function expectedCells(served: readonly IntentDim[] | null): string[] {
  const out: string[] = [];
  for (const intent of INTENT_DIMENSIONS) {
    if (served && !served.includes(intent)) continue;
    for (const source of ["default", ...GENERATED_SOURCE_DIMS]) out.push(`${intent}:${source}`);
  }
  return out;
}

/**
 * Why a page's parts cannot be read from its versions yet, or null when the
 * page is settled. Rows of an intent the site does not serve are not looked
 * at: nothing writes them and the edge never serves them.
 */
export function unsettledReason(
  rows: readonly Row[],
  customerId: string,
  pagePath: string,
  served: readonly IntentDim[] | null,
): string | null {
  const expected = new Set(expectedCells(served));
  const seen = new Set<string>();
  for (const row of rows) {
    const cell = parseVariantKey(row.kv_key, customerId);
    if (!cell || cell.pagePath !== pagePath) continue;
    const key = `${cell.intentDim}:${cell.sourceDim}`;
    if (!expected.has(key)) continue;
    seen.add(key);
    if (row.status === "stale") return "a version waits for its rewrite";
    // A cell with no live body whose body waits for the customer's OK, or
    // was discarded (docs/specs/versions-approval.md): nothing of it serves,
    // so the page's parts cannot be read from it.
    if (row.status === "pending") return "a version waits for the customer's OK";
    if (row.status === "discarded") return "a version was discarded";
    const never = row.body_id === null && Number(row.cost_usd ?? 0) === 0;
    if (row.status === "error") {
      // A refused first write is tried again on the queue's next pass.
      if (
        never &&
        (row.error_reason ?? "").startsWith("lint:") &&
        !(row.lint_flags ?? "").includes(FIRST_WRITE_RETRIED)
      ) {
        return "a first write waits for its early retry";
      }
      // An older body serves from KV and has no row of its own to read.
      if (row.body_id === null && !never) return "a version's body cannot be read";
    } else if (row.body_id === null) {
      // Written before bodies were kept (2026-10-04) and not rewritten since.
      return "a version's body cannot be read";
    }
  }
  for (const key of expected) {
    if (!seen.has(key)) return "a version is not written yet";
  }
  return null;
}

/**
 * A leaf of a body as a manifest path: `$.sections.hero.body_alt2` is
 * `hero.body`. SQLite quotes a key that is not plain letters and digits
 * (`$.sections.forms."submit_label"`, `$.sections."features_core".body`);
 * a manifest path has no quote and no dot inside a key, so the quotes are
 * dropped.
 */
export function partOfLeaf(fullkey: string): string | null {
  const prefix = "$.sections.";
  const plain = fullkey.replace(/"/g, "");
  if (!plain.startsWith(prefix)) return null;
  const path = plain.slice(prefix.length);
  const leaf = path.slice(path.lastIndexOf(".") + 1);
  if (leaf === "kind" || leaf === "href" || !path.includes(".")) return null;
  return path.replace(/_alt2?$/, "");
}

/**
 * For each settled page of `pages`, the parts that the body of at least one
 * of its versions writes. A page that is not settled is not in the map: its
 * hide rules keep every part. On any failure the map is empty, which is the
 * behaviour from before this rule.
 */
export async function partsVersionsWrite(
  db: D1Database,
  customerId: string,
  pages: readonly string[],
  served: readonly IntentDim[] | null,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (pages.length === 0) return out;
  try {
    const rows = await db
      .prepare(
        "SELECT kv_key, status, body_id, cost_usd, error_reason, lint_flags FROM variants WHERE customer_id = ?",
      )
      .bind(customerId)
      .all<Row>();
    const all = rows.results ?? [];
    // The edge lends a page the home page's version when the page has none
    // for the visitor's reason (its cascade: the page's cell, the page's
    // default, then the same two of "/"). So a page other than "/" is
    // settled only when "/" is, and what the home page's bodies write counts
    // for it too.
    const hasRoot = all.some((r) => parseVariantKey(r.kv_key, customerId)?.pagePath === "/");
    const rootSettled = !hasRoot || unsettledReason(all, customerId, "/", served) === null;
    const settled = pages.filter(
      (p) => (p === "/" || rootSettled) && unsettledReason(all, customerId, p, served) === null,
    );
    if (settled.length === 0) return out;
    // The live body of every row, an older one under a refused rewrite
    // included: that body still serves. Distinct leaves, read in the database.
    const leaves = await db
      .prepare(
        `SELECT DISTINCT b.page_path AS page_path, t.fullkey AS fullkey
         FROM variants v
         JOIN version_bodies b ON b.body_id = v.body_id AND b.customer_id = v.customer_id,
              json_tree(b.body_json, '$.sections') t
         WHERE v.customer_id = ? AND t.type = 'text'`,
      )
      .bind(customerId)
      .all<{ page_path: string; fullkey: string }>();
    for (const page of settled) out.set(page, new Set());
    const root = new Set<string>();
    for (const leaf of leaves.results ?? []) {
      const part = typeof leaf.fullkey === "string" ? partOfLeaf(leaf.fullkey) : null;
      if (!part) continue;
      out.get(leaf.page_path)?.add(part);
      if (leaf.page_path === "/") root.add(part);
    }
    for (const [page, parts] of out) {
      if (page !== "/") for (const part of root) parts.add(part);
    }
    return out;
  } catch {
    return new Map();
  }
}
