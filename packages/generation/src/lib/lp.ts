/**
 * The bit `lp` on an exposure row (docs/specs/late-tag.md, "The bit lp";
 * privacy review Q2 in docs/specs/pilot-gaps.md).
 *
 * One closed fact about a page load: the page had been painted when our
 * script started, so it stayed as built for that load. The edge stores it
 * only as 1, in events.properties, on exactly two shapes: a
 * personalization_skipped of kind `late` (the treat arm, and a visit outside
 * a test) and the holdout arm's variant_shown. Never on a conversion, a
 * passthrough or a snippet_issue.
 *
 * Read here for counting only (conditions 3 and 4): the daily rollup, the
 * aggregator's split of the skipped cohort and the Pages card's share. Never
 * by selection, classification or generation, never written to KV, never
 * returned to a browser. The key stays with the row for the life of the
 * account (ADR 0037); until 2026-11-02 the 6-hour cron removed it at 31 days.
 *
 * One kind, two cases: the skip kind `late` means "the visitor was already
 * reading the original". With `lp` the tag ran after the page appeared;
 * without it the answer came after the reveal cap. A reader that needs to
 * tell them apart reads this bit, never the kind alone.
 */

/**
 * SQL: 1 when the row's properties hold `lp` as the number 1, else 0 (never
 * NULL). Only the integer 1 counts (condition 5, the bit never grows a
 * second value): `true`, 2 or "1" read as 0, though the edge stores none of
 * them. The CASE keeps the JSON functions off a value that is not JSON, in
 * that order whatever the planner does, so one malformed row never fails a
 * statement.
 */
export function lpOf(column = "properties"): string {
  return `(CASE WHEN json_valid(${column}) THEN (json_type(${column}, '$.lp') IS 'integer' AND json_extract(${column}, '$.lp') IS 1) ELSE 0 END)`;
}

/**
 * SQL: true when the row's properties hold an `lp` key at all, whatever its
 * value (any value, not only the 1 the edge writes).
 */
export function hasLp(column = "properties"): string {
  return `(CASE WHEN json_valid(${column}) THEN json_type(${column}, '$.lp') END IS NOT NULL)`;
}
