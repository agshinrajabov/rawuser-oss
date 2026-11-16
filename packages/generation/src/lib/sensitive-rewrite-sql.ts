/**
 * The statements that bring the rows a customer already has under the
 * sensitive rule (docs/specs/sensitive-customers.md, "Existing rows",
 * privacy review condition 6): a dry run (one SELECT) and the rewrite the
 * founder runs by hand. This module only builds text; it runs nothing.
 *
 * One rule, three places: the edge and the rollups use the shared
 * `storedPath` and `foldDay`; these statements use the same rule in SQL
 * (`storedPathSql`, lib/sensitive-pages.ts). A test runs both over one
 * fixture and compares.
 *
 * The rewrite reads the list from the customers row, the one the edge uses,
 * so the old rows are grouped exactly as the new ones are. Every statement
 * of it does nothing unless the customer is marked sensitive. The dry run
 * carries the list it expects at its top and says whether the row holds the
 * same one.
 *
 * The seed of page_days counts rows of the exposure types only, by type,
 * time and path. For the fold's second floor the marker is counted per day
 * and group (the aggregator's GROUP_VISITS_SELECT, a number only): it is in
 * no result line and is written into no row.
 */

import {
  FOLD_MIN_PATHS,
  FOLD_MIN_VISITS,
  PAGE_DAY_EVENT_TYPES,
  validKeptSections,
} from "@rawuser/shared";
import { INTENT_DIMENSIONS, SOURCE_DIMENSIONS } from "@rawuser/shared";
import { GROUP_VISITS_SELECT } from "../cron/analytics-aggregator.ts";
import { isGroupSql, normPathSql, storedPathSql } from "./sensitive-pages.ts";

/** A customer id as it may stand in these files: no quote, no space. */
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function idOf(customerId: string): string {
  if (!SAFE_ID.test(customerId)) throw new Error("customer id is not a plain id");
  return customerId;
}

const EXPOSURES = PAGE_DAY_EVENT_TYPES.map((t) => `'${t}'`).join(", ");

/** `kept(p)` from the customers row: the list the edge uses. */
function keptFromRow(id: string): string {
  return `kept(p) AS (SELECT value FROM json_each(COALESCE((SELECT kept_sections FROM customers WHERE id = '${id}'), '[]')))`;
}

/** `kept(p)` from a list written into the statement. */
function keptLiteral(kept: readonly string[]): string {
  return kept.length === 0
    ? "kept(p) AS (SELECT NULL WHERE 0)"
    : `kept(p) AS (VALUES ${kept.map((k) => `('${k}')`).join(", ")})`;
}

/** The customer is marked: every write below is void without it. */
const marked = (id: string) => `(SELECT sensitive FROM customers WHERE id = '${id}') = 1`;

const stored = (col: string) => storedPathSql(normPathSql(col));
/**
 * A page outside the list, over a normalized path: its stored path is a
 * group it is one page of.
 */
const outside = (path: string) => `${storedPathSql(path)} <> ${path}`;
/** `(SELECT <normalized> AS path FROM <table> WHERE customer_id = id)`: one place per read. */
const paths = (table: string, id: string, col = "page_path") =>
  `(SELECT ${normPathSql(col)} AS path FROM ${table} WHERE customer_id = '${id}')`;

/**
 * When the edge began to store this customer's paths as groups: the first
 * event row whose path is a group's. Loads of `/` and of the kept sections
 * after it are in page_days already; before it they are only in the event
 * rows. A row that names a page outside the list is always from before.
 */
function cutCte(id: string): string {
  return `cut(ts) AS (
  SELECT COALESCE(MIN(ts), 9000000000000000) FROM events
  WHERE customer_id = '${id}' AND ${isGroupSql("page_path")}
)`;
}

/**
 * A closed day's group is folded under either floor: fewer than three pages
 * that day, or fewer than five distinct visits behind it (`gv`, the
 * aggregator's own count per day and group, the customer's id written in).
 */
const UNDER_A_FLOOR = `(n.paths < ${FOLD_MIN_PATHS} OR COALESCE(gv.visits, 0) < ${FOLD_MIN_VISITS})`;
const NAMED = `c.grp <> c.path AND ${isGroupSql("c.grp")}`;
const FLOORS_JOIN = `LEFT JOIN n ON n.day = c.day AND n.grp = c.grp
       LEFT JOIN gv ON gv.day = c.day AND gv.grp = c.grp`;

/**
 * The loads the event rows hold and page_days does not, per day and page,
 * with the group each page belongs to, how many pages its group has that
 * day and how many distinct visits stand behind it. `kept` and `cut` must
 * be in scope.
 */
function seedCtes(id: string): string {
  return `seen AS (
  SELECT ts, ${normPathSql("page_path")} AS path
  FROM events
  WHERE customer_id = '${id}' AND event_type IN (${EXPOSURES})
),
src AS (
  SELECT date(seen.ts / 1000, 'unixepoch') AS day, seen.path AS path
  FROM seen, cut
  WHERE seen.ts < cut.ts OR ${outside("seen.path")}
),
c AS (
  SELECT day, path, COUNT(*) AS loads, ${storedPathSql("path")} AS grp
  FROM src GROUP BY day, path
),
n AS (
  SELECT day, grp, COUNT(*) AS paths FROM c
  WHERE grp <> path AND ${isGroupSql("grp")}
  GROUP BY day, grp
),
gv AS (
${GROUP_VISITS_SELECT.replace("?1", `'${id}'`)}
GROUP BY 1, 2
),
f AS (
  SELECT c.day AS day,
         CASE WHEN c.day < date('now') AND ${NAMED} AND ${UNDER_A_FLOOR}
              THEN c.grp ELSE c.path END AS page_path,
         c.loads AS loads
  FROM c ${FLOORS_JOIN}
)`;
}

export interface DryRunOptions {
  /**
   * False before migration 0042 is applied: the statement then names
   * neither the two new columns nor page_days, and only sizes the job.
   */
  migrated?: boolean;
}

/**
 * The dry run: one SELECT, counts only. Lines, in order:
 *
 * - `list`: whether the customer is marked and whether the list on its row
 *   is the list at the top of this statement;
 * - `events`: per day and stored path, the event rows of every type (`n`),
 *   the loads the seed would add (`loads`), the distinct pages they are on
 *   (`pages`), the distinct visits with a load there (`visits`, a count) and
 *   whether the seed folds them into the group (`folds`);
 * - `page_days`: the counter as it is, per day and stored path;
 * - last, `rows naming a page outside the list`: over events,
 *   exposure_outcomes and analytics_aggregates.per_page. The size of the job
 *   before the rewrite, 0 after it.
 */
export function dryRunSql(
  customerId: string,
  kept: readonly string[],
  opts: DryRunOptions = {},
): string {
  const id = idOf(customerId);
  const list = validKeptSections([...kept]);
  if (list === null) throw new Error("the kept list is not valid");
  const migrated = opts.migrated !== false;
  const rowList = `json_each(COALESCE((SELECT kept_sections FROM customers WHERE id = '${id}'), '[]'))`;

  const listLine = `SELECT 0 AS ord, 'list' AS line, '' AS day, '' AS page,
       (SELECT sensitive FROM customers WHERE id = '${id}') AS n,
       NULL AS loads, (SELECT COUNT(*) FROM kept) AS pages, NULL AS visits, NULL AS folds,
       CASE WHEN NOT EXISTS (SELECT p FROM kept EXCEPT SELECT value FROM ${rowList})
             AND NOT EXISTS (SELECT value FROM ${rowList} EXCEPT SELECT p FROM kept)
            THEN 'n: the sensitive flag. The list on the customers row is this list.'
            ELSE 'n: the sensitive flag. STOP: the list on the customers row is NOT this list.' END AS note
UNION ALL
`;

  const pageDaysLine = `UNION ALL
SELECT 2, 'page_days', pd.day, ${storedPathSql("pd.path")},
       COUNT(*), SUM(pd.loads),
       SUM(CASE WHEN ${outside("pd.path")} THEN 1 ELSE 0 END), NULL, NULL,
       'n: rows of the counter. pages: pages named in it.'
FROM (SELECT day, loads, ${normPathSql("page_path")} AS path
      FROM page_days WHERE customer_id = '${id}') pd
GROUP BY 2, 3, 4
`;

  return `WITH ${keptLiteral(list)},
${cutCte(id)},
${seedCtes(id)},
ev AS (
  SELECT day, ${storedPathSql("path")} AS page, COUNT(*) AS n
  FROM (SELECT date(ts / 1000, 'unixepoch') AS day, ${normPathSql("page_path")} AS path
        FROM events WHERE customer_id = '${id}')
  GROUP BY 1, 2
),
seed AS (
  SELECT c.day AS day, c.grp AS page, SUM(c.loads) AS loads,
         SUM(CASE WHEN c.grp <> c.path THEN 1 ELSE 0 END) AS pages,
         MAX(CASE WHEN c.day < date('now') AND ${NAMED} AND ${UNDER_A_FLOOR}
                  THEN 1 ELSE 0 END) AS folds
  FROM c ${FLOORS_JOIN}
  GROUP BY c.day, c.grp
)
${migrated ? listLine : ""}SELECT 1 AS ord, 'events' AS line, ev.day AS day, ev.page AS page, ev.n AS n,
       COALESCE(seed.loads, 0) AS loads, COALESCE(seed.pages, 0) AS pages,
       gv.visits AS visits, COALESCE(seed.folds, 0) AS folds,
       'n: event rows of every type. loads, pages, folds: what the seed adds to page_days. visits: distinct visits with a load there.' AS note
FROM ev
LEFT JOIN seed ON seed.day = ev.day AND seed.page = ev.page
LEFT JOIN gv ON gv.day = ev.day AND gv.grp = ev.page
${migrated ? pageDaysLine : ""}UNION ALL
SELECT 3, 'rows naming a page outside the list', '', '',
       x.events + x.outcomes + x.per_page, NULL, NULL, NULL, NULL,
       'events ' || x.events || ', exposure_outcomes ' || x.outcomes || ', per_page ' || x.per_page
FROM (
  SELECT
    (SELECT COUNT(*) FROM ${paths("events", id)} WHERE ${outside("path")}) AS events,
    (SELECT COUNT(*) FROM ${paths("exposure_outcomes", id)} WHERE ${outside("path")}) AS outcomes,
    (SELECT COUNT(*) FROM analytics_aggregates a
      WHERE a.customer_id = '${id}' AND json_valid(a.per_page) AND EXISTS (
        SELECT 1 FROM (SELECT ${normPathSql("json_extract(j.value, '$.page_path')")} AS path
                       FROM json_each(a.per_page, '$.pages') j)
        WHERE ${outside("path")})) AS per_page
) x
ORDER BY 1, 3, 4;
`;
}

/** The keys a marked customer's rows may keep: `/` and the kept sections, every intent and source. */
function allowedKeysCtes(id: string): string {
  const intents = JSON.stringify([...INTENT_DIMENSIONS]);
  const sources = JSON.stringify([...SOURCE_DIMENSIONS, "default"]);
  return `pages(p) AS (SELECT '/' UNION ALL SELECT p FROM kept),
allowed(k) AS (
  SELECT 'v1:variant:${id}'
         || CASE WHEN pages.p = '/' THEN ''
                 ELSE ':p:' || replace(replace(pages.p, '%', '%25'), '/', '%2F') END
         || ':' || i.value || ':' || s.value
  FROM pages, json_each('${intents}') i, json_each('${sources}') s
)`;
}

/**
 * The rewrite, in the spec's order. It never sets the flag or the list, and
 * every statement is void unless the customer is marked.
 *
 * 1. Seed page_days from the exposure rows the counter has not seen, the
 *    closed days folded under both floors (pages and visits). Skipped when no event row names a page outside the
 *    list any more (the rewrite has run) or when the counter already holds a
 *    day from before the edge began to group (the seed has run).
 * 2. Rewrite page_path on every event type.
 * 3. Rewrite variant_key: NULL unless it is one of the allowed keys.
 * 4. Delete the customer's exposure_outcomes and exposure_rollup_days (the
 *    outcomes backfill builds them again from the rewritten rows).
 * 5. Empty per_page on the customer's stored aggregates (the hourly
 *    aggregator writes the newest row of each window again).
 */
export function rewriteStatements(customerId: string): string[] {
  const id = idOf(customerId);
  const kept = keptFromRow(id);
  return [
    `WITH ${kept},
${cutCte(id)},
${seedCtes(id)}
INSERT INTO page_days (customer_id, day, page_path, loads)
SELECT '${id}', f.day, f.page_path, SUM(f.loads) FROM f
WHERE ${marked(id)}
  AND EXISTS (SELECT 1 FROM ${paths("events", id)} WHERE ${outside("path")})
  AND NOT EXISTS (SELECT 1 FROM page_days pd, cut
                  WHERE pd.customer_id = '${id}' AND pd.day < date(cut.ts / 1000, 'unixepoch'))
GROUP BY f.day, f.page_path
ON CONFLICT(customer_id, day, page_path) DO UPDATE SET loads = loads + excluded.loads;`,

    `WITH ${kept}
UPDATE events SET page_path = ${stored("page_path")}
WHERE customer_id = '${id}' AND ${marked(id)}
  AND page_path IS NOT NULL AND page_path <> ${stored("page_path")};`,

    `WITH ${kept},
${allowedKeysCtes(id)}
UPDATE events SET variant_key = NULL
WHERE customer_id = '${id}' AND ${marked(id)}
  AND variant_key IS NOT NULL AND variant_key NOT IN (SELECT k FROM allowed);`,

    `DELETE FROM exposure_outcomes WHERE customer_id = '${id}' AND ${marked(id)};`,

    `DELETE FROM exposure_rollup_days WHERE customer_id = '${id}' AND ${marked(id)};`,

    `UPDATE analytics_aggregates SET per_page = NULL
WHERE customer_id = '${id}' AND ${marked(id)} AND per_page IS NOT NULL;`,
  ];
}

/** `--` comment lines from plain text. */
function comment(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => (l.trim() === "" ? "--" : `-- ${l.trimEnd()}`))
    .join("\n");
}

const STEPS = (id: string, kept: readonly string[], date: string, apiOrigin: string) => `
The steps for the founder, in this order:

  1. Deploy: migration 0042 (pnpm db:migrate), then generation, then the edge.
  2. Mark ${id} sensitive and set its kept list by the superadmin endpoint:
     ${kept.join(", ") || "(empty)"}
     From here the edge stores new rows grouped and counts loads in page_days.
     Then wait ten minutes before step 3. An edge location may hold the old
     bundle for five minutes and a running worker five more, and stores
     ungrouped rows until then. A rewrite run earlier leaves those rows
     behind, and step 6 shows them.
  3. The dry run (${date}-sensitive-dry-run.sql, SELECT only). Its first
     line must say the list on the customers row is this list. Its last line
     is the size of the job.
  4. The rewrite, once.
  5. Rebuild the daily outcomes, as a superadmin, right after the rewrite:
       POST ${apiOrigin}/admin/proof/backfill
       {"customer_id": "${id}", "what": "outcomes"}
     It rebuilds every closed day that still holds its markers (31 days) from
     the rewritten rows, writes exposure_rollup_days again and folds
     page_days. Without it the hourly rollup rebuilds only the last three
     closed days, an older day stays without its outcomes, the counter shows
     nothing for it, and the hourly check may raise rollup-missing.
     per_page needs no call: the hourly aggregator (minute 0) writes the
     newest row of each window again.
  6. Dry run again: the last line must read 0.
  7. Run the dry run again after 24 hours. The last line must still read 0.

No edge rollback below 58343af while any customer is marked sensitive. An
older edge stores the rows of a marked customer ungrouped and counts no load.
`;

/**
 * The dry-run file as committed. `apiOrigin` is this worker's public origin
 * (API_ORIGIN), printed in the step that calls it; absent, the step names
 * the path alone.
 */
export function dryRunFile(
  customerId: string,
  kept: readonly string[],
  date: string,
  apiOrigin = "",
): string {
  const list = validKeptSections([...kept]) ?? [];
  return `${comment(`
${customerId}, ${date} (docs/specs/sensitive-customers.md, Existing rows).
DRY RUN: one SELECT, counts only, nothing written. The marker is counted
per day and stored path (the column visits) and is in no line of the output.

Run it with --command, which prints the rows (from the repo root):

  npx wrangler --config packages/generation/wrangler.toml d1 execute rawuser_db \\
    --remote --env production \\
    --command "$(grep -v "^--" docs/ops/${customerId}/${date}-sensitive-dry-run.sql)"

THE KEPT LIST is in one place, the first line of the statement below:
  ${list.join(", ") || "(empty)"}
It must be the list set on the customers row by the endpoint. The first line
of the output says whether it is. To change the list, change it there and
here. The rewrite has no list of its own: it reads the customers row.

Lines of the output (generated by dryRunSql, lib/sensitive-rewrite-sql.ts):
  list       n = the sensitive flag (1 expected), pages = entries in the list.
  events     per day and stored path. n = event rows of every type.
             loads = loads the seed adds to page_days (exposure rows the
             counter has not seen). pages = distinct pages they are on.
             visits = distinct visits with a load on that stored path.
             folds = 1 where the seed keeps only the group: a closed day
             with fewer than ${FOLD_MIN_PATHS} pages in the group, or fewer than ${FOLD_MIN_VISITS} visits
             behind it.
  page_days  the counter as it is, per day and stored path.
  rows naming a page outside the list
             over events, exposure_outcomes and analytics_aggregates.per_page.
             The size of the job before the rewrite, 0 after it.
${STEPS(customerId, list, date, apiOrigin)}`)}
${dryRunSql(customerId, list)}`;
}

/** The rewrite file as committed; `apiOrigin` as in dryRunFile. */
export function rewriteFile(
  customerId: string,
  kept: readonly string[],
  date: string,
  apiOrigin = "",
): string {
  const list = validKeptSections([...kept]) ?? [];
  const [seed, paths, keys, outcomes, days, perPage] = rewriteStatements(customerId);
  return `${comment(`
${customerId}, ${date} (docs/specs/sensitive-customers.md, Existing rows,
privacy review condition 6). THE REWRITE: production writes. Run the dry
run first, and this once (from the repo root):

  npx wrangler --config packages/generation/wrangler.toml d1 execute rawuser_db \\
    --remote --env production \\
    --file docs/ops/${customerId}/${date}-sensitive-rewrite.sql

It does NOT set customers.sensitive or customers.kept_sections: the endpoint
does (step 2). Every statement below is void unless the customer is marked,
and reads the kept list from the customers row, the list the edge uses, so
the old rows are grouped exactly as the new ones. Expected list:
  ${list.join(", ") || "(empty)"}
${STEPS(customerId, list, date, apiOrigin)}
What it changes, and what it does not:
  - page_days gains the loads of the exposure rows from before the edge
    counted, per UTC day and page. A closed day keeps only the group where
    the group has fewer than ${FOLD_MIN_PATHS} pages that day, or fewer than ${FOLD_MIN_VISITS} distinct visits
    behind it. Rows of the three exposure types only. The type, the time
    and the path are read. The marker is only counted, per day and group,
    for that second floor. It is written nowhere.
  - events.page_path becomes /, a kept section, its group or /:item, on
    every event type. The page a row named is gone from the row.
  - events.variant_key becomes NULL unless it is a key of / or a kept
    section.
  - exposure_outcomes and exposure_rollup_days of the customer are deleted
    and built again by step 5.
  - analytics_aggregates.per_page of the customer is emptied on every stored
    row. The next hourly run writes the newest rows again.
  - source_days and manifest_health are left: no product path beside
    anything from a marker.
The old rows stay in D1 Time Travel for 30 days. Nothing restores them.

Limits, said plainly:
  - Loads of / and of the kept sections between step 2 and the first
    product page stored as a group may be counted by the edge and by the
    seed, twice. A handful at most, on that one day, never on a product
    page.
  - The seed runs once. If this file stops half-way, run the dry run before
    running it again: the seed is skipped when the counter already holds a
    day from before step 2, and when no event row names a page outside the
    list any more.
  - Our own two live checks of 2026-10-12 are counted as loads unless
    2026-10-12-qa-rows.sql ran before this.

Generated by rewriteStatements, lib/sensitive-rewrite-sql.ts. A test keeps
this file and the generator the same and runs both on a fixture.
`)}

-- 1. Seed the counter from the exposure rows it has not seen, folded.
${seed}

-- 2. The stored path on every event type.
${paths}

-- 3. The stored variant_key.
${keys}

-- 4. The two rollups that hold a page beside an arm, an intent and a source.
${outcomes}
${days}

-- 5. per_page on the stored aggregates.
${perPage}
`;
}
