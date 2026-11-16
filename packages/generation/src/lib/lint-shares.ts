/**
 * The shares behind the daily `lint-daily` line (docs/specs/refused-versions.md,
 * "What is counted"): per customer, the rows the copy checks refused of the
 * rows written, and the parts left as built of the parts written, each with
 * the rules that caused them.
 *
 * Privacy shape: a customer id, counts and rule names. No path, no copy
 * text, nothing about a visitor. Read from our own rows (`variants`,
 * `version_bodies`); rows of an intent the site does not serve are in no
 * count, since nothing writes them any more.
 */

import { parseServed } from "@rawuser/shared";
import { partsAsBuiltOf } from "./parts-as-built.ts";
import { parseVariantKey } from "./publish-version.ts";

export interface CustomerShare {
  customer_id: string;
  /** Rows the copy checks refused. */
  refused: number;
  /** Rows written (ready or stale) plus the refused ones: what the writes tried. */
  rows: number;
  refusedRules: Map<string, number>;
  /** Parts left as the page built them, over the written rows. */
  asBuilt: number;
  /**
   * The parts those rows set out to write: the parts their bodies carry plus
   * the ones left as built. Null when the bodies could not be counted.
   */
  parts: number | null;
  asBuiltRules: Map<string, number>;
}

/**
 * The rule names in a refused row's reason. "lint: hero.body length-drift
 * (...); features.body sentence-reuse:hero.body (...)": a rule follows a
 * dotted path; a ";" inside an excerpt has none, and the cause a refusal
 * starts with ("3 of 5 parts could not be written") has no dotted path.
 */
export function rulesOfReason(reason: string): string[] {
  return [...reason.matchAll(/(?:lint:|;)\s*[\w-]+\.[\w.-]+ ([a-z][a-z0-9-]*)/g)].map((m) =>
    sendableRule(m[1] as string),
  );
}

/**
 * Every rule name the copy checks can give (privacy review,
 * 2026-10-12). A reason also holds excerpts of the refused copy, and the
 * pattern above can read a word of an excerpt as a rule ("...; the pilot's site
 * delivers..." gave "delivers"), so a name leaves this module only when it
 * is in this list; anything else is sent as "other". A test holds the list
 * to the rule literals in the lint.
 */
export const SENDABLE_RULES: ReadonlySet<string> = new Set([
  "alt-copies",
  "alt-not-longer",
  "alt-not-shorter",
  "alt2-not-longer",
  "alt2-not-shorter",
  "banned",
  "binary-contrast",
  "bracket-missing",
  "claim-added",
  "colon-reveal",
  "cta-action-changed",
  "cta-duplicates-counted",
  "cta-object-changed",
  "cta-same-label",
  "currency-missing",
  "dash",
  "emphasis-count",
  "emphasis-missing",
  "emphasis-unbalanced",
  "emphasis-unexpected",
  "fragments",
  "headline-over-12-words",
  "health-addressed",
  "length-drift",
  "market-addressed",
  "name-changed",
  "number-not-in-brief",
  "number-unit-mismatch",
  "paragraph-over-original",
  "question-stack",
  "rotator-dangling",
  "rotator-doubled",
  "rotator-grammar",
  "rotator-repeats",
  "rotator-spread",
  "same-as-original",
  "section-subject-changed",
  "sentence-reuse",
  "short-missing",
  "slot-duplicate",
  "source-addressed",
  "template-copy",
  "template-stop",
  "turkish-in-az",
  "wrong-language",
  "wrong-script",
]);

/** A rule name as it may be sent: a name of the closed list, else "other". */
export function sendableRule(rule: string): string {
  const name = /^[a-z][a-z0-9-]*/.exec(rule)?.[0] ?? "";
  return SENDABLE_RULES.has(name) ? name : "other";
}

/** A rule name as it may be sent: its leading word, nothing after a colon. */
function ruleName(rule: string): string {
  return sendableRule(rule);
}

const NOT_TEST = (t: string) =>
  `${t}.customer_id NOT IN (SELECT id FROM customers WHERE plan = 'test' OR status = 'ended')`;

/** The intent of a key of this customer, or null when the key is not one. */
function intentOf(kvKey: unknown, customerId: string): string | null {
  return typeof kvKey === "string" ? (parseVariantKey(kvKey, customerId)?.intentDim ?? null) : null;
}

export interface RefusedRowLike {
  customer_id?: string | null;
  kv_key?: string | null;
  error_reason: string;
}

/** The customer of a refused row: its column, else the id inside its key. */
export function customerOfRow(row: RefusedRowLike): string | null {
  if (typeof row.customer_id === "string" && row.customer_id !== "") return row.customer_id;
  const m = /^v1:variant:([^:]+):/.exec(row.kv_key ?? "");
  return m?.[1] ?? null;
}

/** Per customer: which intents its site serves (null: all six). */
export async function loadServedByCustomer(
  db: D1Database,
): Promise<Map<string, readonly string[] | null>> {
  const out = new Map<string, readonly string[] | null>();
  try {
    const rows = await db
      .prepare("SELECT id, served_intents, site_map_off FROM customers")
      .all<{ id: string; served_intents: string | null; site_map_off: number | null }>();
    for (const r of rows.results ?? []) {
      if (typeof r.id !== "string") continue;
      out.set(r.id, r.site_map_off === 1 ? null : parseServed(r.served_intents));
    }
  } catch {
    // No columns, no map: every intent counts.
  }
  return out;
}

/** True when the row's intent is one the customer's site serves. */
export function isServedRow(
  served: ReadonlyMap<string, readonly string[] | null>,
  customerId: string,
  kvKey: unknown,
): boolean {
  const list = served.get(customerId);
  if (!list) return true;
  const intent = intentOf(kvKey, customerId);
  return intent === null || list.includes(intent);
}

/**
 * The shares of every customer with a refused row or a part left as built.
 * `refused` are the refused rows already read (and already without the
 * unserved ones).
 */
export async function lintShares(
  db: D1Database,
  refused: readonly RefusedRowLike[],
  served: ReadonlyMap<string, readonly string[] | null>,
): Promise<CustomerShare[]> {
  const shares = new Map<string, CustomerShare>();
  const of = (id: string): CustomerShare => {
    let s = shares.get(id);
    if (!s) {
      s = {
        customer_id: id,
        refused: 0,
        rows: 0,
        refusedRules: new Map(),
        asBuilt: 0,
        parts: null,
        asBuiltRules: new Map(),
      };
      shares.set(id, s);
    }
    return s;
  };
  const bump = (m: Map<string, number>, rule: string) => m.set(rule, (m.get(rule) ?? 0) + 1);

  for (const row of refused) {
    const id = customerOfRow(row);
    if (!id) continue;
    const s = of(id);
    s.refused++;
    s.rows++;
    for (const rule of rulesOfReason(row.error_reason)) bump(s.refusedRules, rule);
  }

  const written = await db
    .prepare(
      `SELECT v.customer_id AS customer_id, v.kv_key AS kv_key, v.lint_flags AS lint_flags
       FROM variants v WHERE v.status IN ('ready', 'stale') AND ${NOT_TEST("v")}`,
    )
    .all<{ customer_id: string; kv_key: string; lint_flags: string | null }>();
  // Written rows per customer first: only a customer with a refused row or
  // a part left as built is reported, with all its written rows behind it.
  const writtenRows = new Map<string, number>();
  for (const row of written.results ?? []) {
    if (typeof row.customer_id !== "string") continue;
    if (!isServedRow(served, row.customer_id, row.kv_key)) continue;
    writtenRows.set(row.customer_id, (writtenRows.get(row.customer_id) ?? 0) + 1);
    const built = partsAsBuiltOf(row.lint_flags);
    if (built.length === 0) continue;
    const s = of(row.customer_id);
    s.asBuilt += built.length;
    for (const part of built) bump(s.asBuiltRules, ruleName(part.rule));
  }
  for (const s of shares.values()) s.rows += writtenRows.get(s.customer_id) ?? 0;
  if (shares.size === 0) return [];

  // The parts the written bodies carry, counted in the database: every text
  // leaf of `sections` that is not a kind, a link or another length. Rows
  // published before bodies were kept have no body to count.
  try {
    const parts = await db
      .prepare(
        `SELECT v.customer_id AS customer_id, v.kv_key AS kv_key, COUNT(*) AS parts
         FROM variants v
         JOIN version_bodies b ON b.body_id = v.body_id AND b.customer_id = v.customer_id,
              json_tree(b.body_json, '$.sections') t
         WHERE v.status IN ('ready', 'stale') AND ${NOT_TEST("v")}
           AND t.type = 'text' AND t.key NOT IN ('kind', 'href')
           AND substr(t.key, -4) != '_alt' AND substr(t.key, -5) != '_alt2'
         GROUP BY v.customer_id, v.kv_key`,
      )
      .all<{ customer_id: string; kv_key: string; parts: number }>();
    const counted = new Set<string>();
    for (const row of parts.results ?? []) {
      const s = shares.get(row.customer_id);
      if (!s || !isServedRow(served, row.customer_id, row.kv_key)) continue;
      s.parts = (s.parts ?? 0) + Number(row.parts);
      counted.add(row.customer_id);
    }
    for (const id of counted) {
      const s = shares.get(id) as CustomerShare;
      s.parts = (s.parts ?? 0) + s.asBuilt;
    }
  } catch {
    // Without the count the line gives the number of parts alone.
  }

  return [...shares.values()].sort(
    (a, b) =>
      b.refused + b.asBuilt - (a.refused + a.asBuilt) || a.customer_id.localeCompare(b.customer_id),
  );
}

function topRules(rules: ReadonlyMap<string, number>, max = 3): string {
  const list = [...rules.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([rule, n]) => `${rule} ${n}`)
    .join(", ");
  return list ? ` (${list})` : "";
}

/** One line of a customer: "medora: refused 2 of 20 (length-drift 2), as built 3 of 96 parts (length-drift 3)". */
export function lintShareLine(s: CustomerShare): string {
  const built =
    s.parts === null
      ? `as built ${s.asBuilt} part${s.asBuilt === 1 ? "" : "s"}`
      : `as built ${s.asBuilt} of ${s.parts} parts`;
  return `${s.customer_id}: refused ${s.refused} of ${s.rows}${topRules(s.refusedRules)}, ${built}${topRules(s.asBuiltRules)}`;
}

/** The customers' lines, the most affected first, at most `max` and a count of the rest. */
export function lintShareLines(shares: readonly CustomerShare[], max = 6): string {
  if (shares.length === 0) return "";
  const lines = shares.slice(0, max).map(lintShareLine);
  if (shares.length > max) lines.push(`and ${shares.length - max} more`);
  return `\n${lines.join("\n")}`;
}
