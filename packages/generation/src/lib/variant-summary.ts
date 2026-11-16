/**
 * What a customer's versions look like after a write, for the Live screen
 * (docs/specs/refused-versions.md, "Contract for the dashboard"): how many
 * are written, how many of those keep a part as the page built it, how many
 * the copy checks refused, and for a refused one what a visitor sees in the
 * meantime. Our own rows and keys only; nothing about a visitor.
 */

import { INTENT_DIMENSIONS, variantKeyForPath } from "@rawuser/shared";
import { partsAsBuiltOf } from "./parts-as-built.ts";
import { parseVariantKey } from "./publish-version.ts";
import { nextTryAt, triedAt } from "./tried-marker.ts";
import { FIRST_WRITE_RETRIED } from "./variant-rows.ts";

/**
 * What the edge serves for a refused row's cell (packages/edge, the version
 * cascade: the page with the source, the page's default, the home page with
 * the source, the home page's default):
 *   - "older": an earlier body of the same cell still serves;
 *   - "nearest": the cell has no body, another step of the cascade has one;
 *   - "original": no step has one, the visitor sees the page as built.
 */
export type Serving = "older" | "nearest" | "original";

export interface RefusedRow {
  intent_dim: string;
  source_dim: string;
  page_path: string;
  kv_key: string;
  /** The copy checks' reason, as stored ("lint: ..."). */
  error_reason: string;
  serving: Serving;
  /**
   * When the queue will try the row next, unix ms (J8 of
   * docs/specs/pilot-gaps.md): from the row's last failed try
   * (lib/tried-marker.ts) and the queue's six-hour rule. Only on a row with
   * a marker; a row without one carries no field.
   */
  next_try?: number;
}

export interface VariantSummary {
  /** Versions with a body that is theirs: ready or stale. */
  written: number;
  /** Of those, the ones that keep at least one part as the page built it. */
  with_parts_as_built: number;
  /** Rows the copy checks refused (an error row with a "lint:" reason). */
  refused: number;
  /** Rows a provider failure left unwritten: an outage, not a verdict. */
  failed: number;
  /**
   * Versions written and waiting for the customer's OK
   * (docs/specs/versions-approval.md): visitors keep the live body, or the
   * page as built where the cell has none. Counted apart from `written`.
   */
  pending: number;
  refused_rows: RefusedRow[];
}

interface Row {
  kv_key: string;
  status: string;
  error_reason: string | null;
  lint_flags: string | null;
  body_id: string | null;
  generated_at: number;
  cost_usd: number;
  pending_body_id?: string | null;
}

/**
 * A first write the copy checks refused and not yet tried again, as the
 * queue's SQL reads it (`firstWriteRetryDueSql`): never ready (no body id and
 * no cost), a "lint:" reason, no `first-write-retried` mark.
 */
function firstWriteDue(row: Row): boolean {
  return (
    row.body_id === null &&
    Number(row.cost_usd) === 0 &&
    (row.error_reason ?? "").startsWith("lint:") &&
    !(row.lint_flags ?? "").includes(FIRST_WRITE_RETRIED)
  );
}

/** The later steps of the edge's cascade for a cell, in its order. */
function cascadeAfter(
  customerId: string,
  cell: { pagePath: string; intentDim: string; sourceDim: string },
): string[] {
  const out: string[] = [];
  const own = variantKeyForPath(customerId, cell.pagePath, cell.intentDim, cell.sourceDim);
  for (const page of cell.pagePath === "/" ? ["/"] : [cell.pagePath, "/"]) {
    for (const source of [cell.sourceDim, "default"]) {
      const key = variantKeyForPath(customerId, page, cell.intentDim, source);
      if (key !== own && !out.includes(key)) out.push(key);
    }
  }
  return out;
}

/**
 * `served`: the intents the site serves (null for all six). A folded
 * intent's rows are not written any more and are left out of every count.
 */
export async function variantSummary(
  env: { DB: D1Database; VARIANTS: KVNamespace },
  customerId: string,
  served: readonly string[] | null = null,
): Promise<VariantSummary> {
  const res = await env.DB.prepare(
    "SELECT kv_key, status, error_reason, lint_flags, body_id, generated_at, cost_usd, pending_body_id FROM variants WHERE customer_id = ?",
  )
    .bind(customerId)
    .all<Row>();
  const intents: readonly string[] = served ?? INTENT_DIMENSIONS;
  const rows = (res.results ?? []).flatMap((row) => {
    const cell = parseVariantKey(row.kv_key, customerId);
    return cell && intents.includes(cell.intentDim) ? [{ row, cell }] : [];
  });
  /** Keys whose row says a body serves there. */
  const withBody = new Set(
    rows
      .filter(({ row }) => row.status === "ready" || row.status === "stale" || row.body_id)
      .map(({ row }) => row.kv_key),
  );
  const inKv = async (key: string): Promise<boolean> => {
    if (withBody.has(key)) return true;
    try {
      return (await env.VARIANTS.get(key)) !== null;
    } catch {
      // Unknown reads as none, the safer answer for a new customer.
      return false;
    }
  };

  const out: VariantSummary = {
    written: 0,
    with_parts_as_built: 0,
    refused: 0,
    failed: 0,
    pending: 0,
    refused_rows: [],
  };
  for (const { row, cell } of rows) {
    if (row.pending_body_id) out.pending++;
    if (row.status === "ready" || row.status === "stale") {
      out.written++;
      if (partsAsBuiltOf(row.lint_flags).length > 0) out.with_parts_as_built++;
      continue;
    }
    if (row.status !== "error") continue;
    const reason = row.error_reason ?? "";
    if (!reason.startsWith("lint:")) {
      out.failed++;
      continue;
    }
    out.refused++;
    let serving: Serving = "original";
    if (await inKv(row.kv_key)) serving = "older";
    else {
      for (const key of cascadeAfter(customerId, cell)) {
        if (await inKv(key)) {
          serving = "nearest";
          break;
        }
      }
    }
    const refused: RefusedRow = {
      intent_dim: cell.intentDim,
      source_dim: cell.sourceDim,
      page_path: cell.pagePath,
      kv_key: row.kv_key,
      error_reason: reason,
      serving,
    };
    // The time of the next try, from the marker of the last failed one. A
    // row without a marker says nothing: its last try is older than six
    // hours, or was never recorded.
    const tried = await triedAt(env.VARIANTS, row.kv_key);
    if (tried !== null) {
      refused.next_try = nextTryAt({
        generatedAt: Number(row.generated_at) || 0,
        triedAt: tried,
        firstWriteDue: firstWriteDue(row),
      });
    }
    out.refused_rows.push(refused);
  }
  return out;
}
