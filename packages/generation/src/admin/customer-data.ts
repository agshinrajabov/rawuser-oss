/**
 * One customer's data: what Rawuser holds, its export and its delete
 * (docs/specs/security-hardening.md, section 2).
 *
 *   GET  /admin/customers/export?customer_id=...     superadmin only
 *   POST /admin/customers/delete { customer_id, dry_run? | confirm }  superadmin only
 *
 * CUSTOMER_TABLES and EXCLUDED_TABLES together name every D1 table; a test
 * applies every migration and fails when a table is in neither, so a new
 * migration cannot slip past the export and the delete.
 *
 * The delete is run by hand, by a person: export first, dry run second,
 * then the confirm.
 */

import { CLOSED_TTL_S, closedKey } from "@rawuser/shared";
import { exportPageDays } from "../lib/sensitive-pages.ts";
import { triedPrefix } from "../lib/tried-marker.ts";
import { corsHeaders, jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/** How a table's rows of one customer are found. */
export type RowScope =
  /** customers.id = ? */
  | "id"
  /** customer_id = ? */
  | "customer_id"
  /** user_id of one of the customer's users */
  | "user";

export interface CustomerTable {
  table: string;
  by: RowScope;
  /** Columns replaced by "[redacted]" in the export. */
  redact?: readonly string[];
}

/**
 * Every table holding a customer's rows, in delete order: the large child
 * tables first, then the users' rows, the users, the applications, and the
 * customers row last (a cut-off run is finished by calling again).
 */
export const CUSTOMER_TABLES: readonly CustomerTable[] = [
  // The visit marker is for counting only (the privacy rules): it
  // leaves us in no export until privacy review rules otherwise (spec §6.4).
  // The country neither (ADR 0036; the privacy review's ruling of 2026-11-02,
  // condition 4): beside a conversion's hour it would point at the person.
  { table: "events", by: "customer_id", redact: ["visit", "country"] },
  { table: "exposure_outcomes", by: "customer_id" },
  { table: "variants", by: "customer_id" },
  { table: "version_bodies", by: "customer_id" },
  { table: "analytics_aggregates", by: "customer_id" },
  { table: "source_days", by: "customer_id" },
  { table: "exposure_rollup_days", by: "customer_id" },
  // The daily counter of a sensitive customer (docs/specs/sensitive-customers.md,
  // condition 4): loads per day and page, no marker. customers.sensitive and
  // customers.kept_sections ride in the customers row. Exported folded and
  // only for days whose fold has run (exportLines); deleted whole.
  { table: "page_days", by: "customer_id" },
  // The learned default's odds (docs/specs/direct-visitors.md §3): weights
  // and the aggregate counts behind them, no visitor data.
  { table: "learned_weights", by: "customer_id" },
  { table: "manifest_health", by: "customer_id" },
  { table: "site_paths", by: "customer_id" },
  { table: "element_manifests", by: "customer_id" },
  { table: "conversion_targets", by: "customer_id" },
  // The page groups (docs/specs/page-groups.md): the customer's own path
  // patterns, no visitor data. Exported with the customer, deleted whole.
  { table: "page_groups", by: "customer_id" },
  { table: "holdout_tests", by: "customer_id" },
  // The frozen audit report (docs/specs/ai-traffic-audit.md §12): counts and
  // the customer's own copy; the share token is a hash.
  { table: "audit_reports", by: "customer_id", redact: ["token_hash"] },
  { table: "intent_profiles", by: "customer_id" },
  { table: "business_dna_i18n", by: "customer_id" },
  { table: "business_dna", by: "customer_id" },
  { table: "snippet_status", by: "customer_id" },
  { table: "superadmin_sessions", by: "user", redact: ["token_hash"] },
  { table: "customer_setup_tokens", by: "user", redact: ["token_hash"] },
  { table: "mfa_challenges", by: "user", redact: ["token_hash"] },
  { table: "mfa_recovery_codes", by: "user", redact: ["code_hash"] },
  { table: "user_mfa", by: "user", redact: ["secret_enc"] },
  { table: "superadmin_users", by: "customer_id", redact: ["password_hash"] },
  { table: "pilot_applications", by: "customer_id", redact: ["token_hash"] },
  { table: "customers", by: "id" },
];

/** Tables that are not one customer's, with the reason. */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  pilot_requests: "a website form with no customer id (gaps-internal item 15)",
  ua_token_counts: "weekly counts under a one-byte bucket of a hash, not one customer's",
  signal_token_counts: "weekly counts under a one-byte bucket of a hash, not one customer's",
  auth_failures: "a hash of an email, deleted within hours",
  d1_migrations: "Cloudflare's migration log",
  _cf_KV: "Cloudflare's internal table",
};

export const REDACTED = "[redacted]";

function where(t: CustomerTable): string {
  switch (t.by) {
    case "id":
      return "id = ?";
    case "customer_id":
      return "customer_id = ?";
    case "user":
      return "user_id IN (SELECT id FROM superadmin_users WHERE customer_id = ?)";
  }
}

/** KV, the shared VARIANTS namespace: a group is one prefix or one exact key. */
export interface KvGroup {
  group: string;
  /** A key prefix (ending in ":") or an exact key. */
  key: (id: string) => string;
  exact: boolean;
  /** Extra filter on the listed names. */
  match?: (name: string, id: string) => boolean;
}

export const KV_GROUPS: readonly KvGroup[] = [
  { group: "versions", key: (id) => `v1:variant:${id}:`, exact: false },
  { group: "visitor_bundle", key: (id) => `v1:vm:${id}`, exact: true },
  { group: "hide_rules", key: (id) => `v1:hide:${id}`, exact: true },
  { group: "rich_pages", key: (id) => `v1:rich:${id}`, exact: true },
  { group: "language", key: (id) => `v1:customer:${id}:lang`, exact: true },
  { group: "carry_off", key: (id) => `v1:carry-off:${id}`, exact: true },
  { group: "legacy_manifest", key: (id) => `v1:manifest:${id}`, exact: true },
  { group: "preview", key: (id) => `v1:preview:${id}:`, exact: false },
  { group: "quickstart", key: (id) => `v1:quickstart:${id}:`, exact: false },
  { group: "capture", key: (id) => `capture:${id}:`, exact: false },
  { group: "pick", key: (id) => `pick:${id}:`, exact: false },
  { group: "pick_count", key: (id) => `pick-count:${id}:`, exact: false },
  { group: "dna_suggest", key: (id) => `dna-suggest:${id}`, exact: true },
  { group: "site_map_read", key: (id) => `v1:sitemap:read:${id}`, exact: true },
  { group: "site_map_reread", key: (id) => `v1:sitemap:reread:${id}:`, exact: false },
  { group: "write_lock", key: (id) => `gen:lock:${id}`, exact: true },
  // The time of a row's last failed try (lib/tried-marker.ts), six hours at most.
  { group: "write_tried", key: (id) => triedPrefix(id), exact: false },
  {
    group: "alert_markers",
    key: () => "ops:alert:",
    exact: false,
    // ops:alert:{code}:{customer}[:scope]: the id as a whole segment only.
    match: (name, id) => name.slice("ops:alert:".length).split(":").includes(id),
  },
];

/** Apply suggestions are keyed by application id, found through D1. */
export const APPLY_SUGGEST_GROUP = "apply_suggestions";
const applySuggestKey = (applicationId: string) => `apply-suggest:${applicationId}`;

export const CUSTOMER_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

// ---------------------------------------------------------------------------
// KV listing with a call budget
// ---------------------------------------------------------------------------

/** Counts D1 statements and KV calls; a Worker request may make 1,000. */
export class Budget {
  used = 0;
  constructor(readonly max: number) {}
  get left(): number {
    return this.max - this.used;
  }
  take(n = 1): boolean {
    if (this.used + n > this.max) return false;
    this.used += n;
    return true;
  }
}

/** The keys of one group, or null when the budget ran out before the list ended. */
async function listGroup(
  kv: KVNamespace,
  g: KvGroup,
  id: string,
  budget: Budget | null,
): Promise<string[] | null> {
  const key = g.key(id);
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    if (budget && !budget.take()) return null;
    const page = await kv.list({ prefix: key, ...(cursor ? { cursor } : {}) });
    for (const k of page.keys) {
      if (g.exact ? k.name !== key : g.match ? !g.match(k.name, id) : false) continue;
      names.push(k.name);
    }
    cursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
  } while (cursor);
  return names;
}

async function applicationIds(db: D1Database, id: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT id FROM pilot_applications WHERE customer_id = ?")
    .bind(id)
    .all<{ id: string }>();
  return (results ?? []).map((r) => String(r.id));
}

async function applySuggestKeys(kv: KVNamespace, appIds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const appId of appIds) {
    const k = applySuggestKey(appId);
    if ((await kv.get(k)) !== null) out.push(k);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Counts (dry run and what remains)
// ---------------------------------------------------------------------------

export interface Counts {
  d1: Record<string, number>;
  kv: Record<string, number>;
}

export async function countCustomerData(
  env: Pick<AdminEnv, "DB" | "VARIANTS">,
  id: string,
): Promise<Counts> {
  const d1: Record<string, number> = {};
  for (const t of CUSTOMER_TABLES) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t.table} WHERE ${where(t)}`)
      .bind(id)
      .first<{ n: number }>();
    d1[t.table] = Number(row?.n ?? 0);
  }
  const kv: Record<string, number> = {};
  for (const g of KV_GROUPS) {
    kv[g.group] = (await listGroup(env.VARIANTS, g, id, null))?.length ?? 0;
  }
  kv[APPLY_SUGGEST_GROUP] = (
    await applySuggestKeys(env.VARIANTS, await applicationIds(env.DB, id))
  ).length;
  return { d1, kv };
}

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/** Rows per DELETE statement. */
export const DELETE_CHUNK = 5000;
/** D1 statements and KV calls per delete request, before the closing counts. */
export const DELETE_BUDGET = 400;
/**
 * What one call spends even when nothing is left: the tombstone, one
 * statement per table, the applications read, one list per KV group. A budget at or under this
 * floor would never move past it, so a call always gets the floor plus 8.
 */
export const DELETE_FLOOR = CUSTOMER_TABLES.length + 2 + KV_GROUPS.length;

export interface DeleteRun {
  done: boolean;
  deleted: Counts;
}

/**
 * The tombstone (condition 1): written when a confirmed delete starts, so
 * the visitor path records nothing from the first call on, and again once
 * the KV sweep is done. Outside KV_GROUPS: a re-run keeps it, the export
 * and the counts never see it.
 */
async function writeTombstone(kv: KVNamespace, id: string): Promise<void> {
  await kv.put(closedKey(id), "1", { expirationTtl: CLOSED_TTL_S });
}

/**
 * Deletes as much as the budget allows, in the catalog's order, with the
 * KV sweep just before the customers row. Calling again with the same id
 * picks up where this stopped: the customers row stays until everything
 * else is gone, so a cut-off run is always found again.
 *
 * KV goes after the child tables: the edge rebuilds a missing visitor
 * bundle from D1 (packages/edge/src/bundle-writeback.ts) for any id without
 * a tombstone, and the tombstone is written first. Apply suggestions go
 * before the applications, whose ids are their keys.
 */
export async function deleteCustomerData(
  env: Pick<AdminEnv, "DB" | "VARIANTS">,
  id: string,
  opts: { budget?: number; chunk?: number } = {},
): Promise<DeleteRun> {
  const budget = new Budget(Math.max(opts.budget ?? DELETE_BUDGET, DELETE_FLOOR + 8));
  const chunk = opts.chunk ?? DELETE_CHUNK;
  const deleted: Counts = { d1: {}, kv: {} };
  const out = (done: boolean): DeleteRun => ({ done, deleted });

  budget.take();
  await writeTombstone(env.VARIANTS, id);

  // The customers row goes last, after the KV sweep (the privacy review's
  // pre-deploy review, fix 1): a run cut off anywhere before it leaves the
  // row, so the next call (the hourly audit sweep, or the superadmin
  // repeating the confirm) still finds the customer and finishes. The edge
  // writes no bundle back for a tombstoned id, so KV before the row is safe.
  let kvSwept = false;
  const sweepKv = async (): Promise<boolean> => {
    if (kvSwept) return true;
    for (const g of KV_GROUPS) {
      const names = await listGroup(env.VARIANTS, g, id, budget);
      if (names === null) return false;
      let n = deleted.kv[g.group] ?? 0;
      for (const name of names) {
        if (!budget.take()) {
          deleted.kv[g.group] = n;
          return false;
        }
        await env.VARIANTS.delete(name);
        n++;
      }
      deleted.kv[g.group] = n;
    }
    kvSwept = true;
    return true;
  };

  for (const t of CUSTOMER_TABLES) {
    if (t.table === "customers" && !(await sweepKv())) return out(false);
    if (t.table === "pilot_applications") {
      // Their apply suggestions first: the keys come from these rows.
      if (!budget.take()) return out(false);
      const appIds = await applicationIds(env.DB, id);
      let n = 0;
      for (const appId of appIds) {
        if (!budget.take()) {
          deleted.kv[APPLY_SUGGEST_GROUP] = n;
          return out(false);
        }
        await env.VARIANTS.delete(applySuggestKey(appId));
        n++;
      }
      deleted.kv[APPLY_SUGGEST_GROUP] = n;
    }
    let total = 0;
    for (;;) {
      if (!budget.take()) {
        deleted.d1[t.table] = total;
        return out(false);
      }
      const r = await env.DB.prepare(
        `DELETE FROM ${t.table} WHERE rowid IN (SELECT rowid FROM ${t.table} WHERE ${where(t)} LIMIT ?)`,
      )
        .bind(id, chunk)
        .run();
      const n = Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0);
      total += n;
      if (n < chunk) break;
    }
    deleted.d1[t.table] = total;
  }
  // A run whose customers row was already gone (a delete cut off after the
  // row by the code before this change): the KV sweep still runs.
  if (!(await sweepKv())) return out(false);
  await writeTombstone(env.VARIANTS, id);
  return out(true);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Rows per D1 read in the export. */
export const EXPORT_PAGE = 500;
export const EXPORT_FORMAT = "rawuser-customer-export/1";
/** The cover line every export carries (privacy review condition 3). */
export const EXPORT_COVER =
  "This file holds your account data and your sites' page-view records, without visit codes. It is personal data under your control; do not combine it with other logs to find a person.";
/** How the file leaves Rawuser (privacy review condition 3, spec §2.4). */
export const EXPORT_HANDOFF =
  "Send only to the DPA Annex I contact, as an encrypted archive with the password by another channel or a link that dies within 7 days. Delete Rawuser's copy within 7 days and record the date in ops/deletions.md.";

const HOUR_MS = 60 * 60 * 1000;
/** What the export rounds, named in meta. */
export const EXPORT_ROUNDED = ["events.ts (conversion rows, down to the hour)"];

function redactRow(t: CustomerTable, row: Record<string, unknown>): Record<string, unknown> {
  const { __rowid: _drop, ...rest } = row;
  for (const col of t.redact ?? []) {
    if (col in rest && rest[col] !== null) rest[col] = REDACTED;
  }
  // A conversion's time leaves to the hour (pilot-gaps.md, Q3
  // condition 4): the customer's own form record names a person to the
  // second, and the export must not line up with it. Other events as stored.
  if (t.table === "events" && rest.event_type === "conversion" && typeof rest.ts === "number") {
    rest.ts = Math.floor(rest.ts / HOUR_MS) * HOUR_MS;
  }
  return rest;
}

/** The export's lines, one JSON object each; a file without the "end" line is incomplete. */
export async function* exportLines(
  env: Pick<AdminEnv, "DB" | "VARIANTS">,
  id: string,
  now: Date,
): AsyncGenerator<string> {
  yield JSON.stringify({
    type: "meta",
    format: EXPORT_FORMAT,
    customer_id: id,
    exported_at: now.toISOString(),
    tables: CUSTOMER_TABLES.map((t) => t.table),
    redacted: CUSTOMER_TABLES.flatMap((t) => (t.redact ?? []).map((c) => `${t.table}.${c}`)),
    rounded: EXPORT_ROUNDED,
    // Tables given as daily totals the way the account shows them, not row
    // for row: page_days only for days whose fold has run, folded.
    folded: ["page_days"],
    cover: EXPORT_COVER,
    handoff: EXPORT_HANDOFF,
  });

  const rows: Record<string, number> = {};
  for (const t of CUSTOMER_TABLES) {
    let count = 0;
    let after = 0;
    // The daily counter of a sensitive customer leaves folded, and only the
    // days whose fold has run (privacy review on the build, condition 2):
    // a raw row of an open or unfolded day would name the page a marker row
    // of that day stands for. The delete below still removes every row.
    if (t.table === "page_days") {
      for (;;) {
        const page = await exportPageDays(env.DB, id, count, EXPORT_PAGE);
        for (const r of page) yield JSON.stringify({ type: "row", table: t.table, row: r });
        count += page.length;
        if (page.length < EXPORT_PAGE) break;
      }
      rows[t.table] = count;
      continue;
    }
    for (;;) {
      const { results } = await env.DB.prepare(
        `SELECT rowid AS __rowid, * FROM ${t.table}
         WHERE ${where(t)} AND rowid > ? ORDER BY rowid LIMIT ?`,
      )
        .bind(id, after, EXPORT_PAGE)
        .all<Record<string, unknown>>();
      const page = results ?? [];
      for (const r of page) {
        yield JSON.stringify({ type: "row", table: t.table, row: redactRow(t, r) });
      }
      count += page.length;
      if (page.length < EXPORT_PAGE) break;
      after = Number(page[page.length - 1]?.__rowid);
    }
    rows[t.table] = count;
  }

  let kvKeys = 0;
  const names: string[] = [];
  for (const g of KV_GROUPS) names.push(...((await listGroup(env.VARIANTS, g, id, null)) ?? []));
  names.push(...(await applySuggestKeys(env.VARIANTS, await applicationIds(env.DB, id))));
  for (const key of names) {
    const value = await env.VARIANTS.get(key);
    if (value === null) continue;
    kvKeys++;
    yield JSON.stringify({ type: "kv", key, value });
  }

  // Counts only, never content.
  console.log(
    `[generation/export] customer export: rows=${sum(rows)} tables=${Object.keys(rows).length} kv_keys=${kvKeys}`,
  );
  yield JSON.stringify({ type: "end", rows, kv_keys: kvKeys });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function customerExists(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare("SELECT id FROM customers WHERE id = ?").bind(id).first()) !== null;
}

export async function handleCustomerExport(request: Request, env: AdminEnv): Promise<Response> {
  const id = new URL(request.url).searchParams.get("customer_id") ?? "";
  if (!CUSTOMER_ID_RE.test(id)) return jsonWithCors({ error: "customer_id is invalid" }, env, 400);
  if (!(await customerExists(env.DB, id))) {
    return jsonWithCors({ error: "Customer not found" }, env, 404);
  }

  const now = new Date();
  const lines = exportLines(env, id, now);
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await lines.next();
        if (next.done) controller.close();
        else controller.enqueue(enc.encode(`${next.value}\n`));
      } catch {
        // No "end" line: the file reads as incomplete.
        console.error("[generation/export] customer export failed");
        controller.error(new Error("export failed"));
      }
    },
    async cancel() {
      await lines.return(undefined);
    },
  });
  const day = now.toISOString().slice(0, 10);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="rawuser-export-${id}-${day}.ndjson"`,
      "cache-control": "no-store",
      ...corsHeaders(env),
    },
  });
}

export async function handleCustomerDelete(request: Request, env: AdminEnv): Promise<Response> {
  let body: { customer_id?: unknown; dry_run?: unknown; confirm?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  const id = typeof body.customer_id === "string" ? body.customer_id : "";
  if (!CUSTOMER_ID_RE.test(id)) return jsonWithCors({ error: "customer_id is invalid" }, env, 400);
  const confirmText = `delete ${id}`;

  // Anything but the exact confirm sentence is a dry run.
  if (body.dry_run === true || body.confirm !== confirmText) {
    if (!(await customerExists(env.DB, id))) {
      return jsonWithCors({ error: "Customer not found" }, env, 404);
    }
    const counts = await countCustomerData(env, id);
    return jsonWithCors(
      {
        dry_run: true,
        d1: counts.d1,
        kv: counts.kv,
        total_rows: sum(counts.d1),
        total_keys: sum(counts.kv),
        confirm: confirmText,
      },
      env,
      200,
    );
  }

  const run = await deleteCustomerData(env, id);
  const remaining = await countCustomerData(env, id);
  const done = run.done && sum(remaining.d1) === 0 && sum(remaining.kv) === 0;
  console.log(
    `[generation/delete] customer delete: rows=${sum(run.deleted.d1)} kv_keys=${sum(run.deleted.kv)} done=${done}`,
  );
  // `closed`: the tombstone is written (condition 1). `log`: the line the
  // founder adds to ops/deletions.md, outside Cloudflare (condition 2).
  return jsonWithCors(
    {
      dry_run: false,
      done,
      closed: true,
      deleted: run.deleted,
      remaining,
      ...(done ? { log: `${id} ${new Date().toISOString().slice(0, 10)}` } : {}),
    },
    env,
    200,
  );
}

// ---------------------------------------------------------------------------
// After a restore (privacy review condition 2)
// ---------------------------------------------------------------------------

/** One line of ops/deletions.md: `- {customer id} {yyyy-mm-dd}`. */
const DELETION_LINE = /^-\s+([A-Za-z0-9_-]{1,100})\s+(\d{4}-\d{2}-\d{2})\s*$/;

/** The customer ids in the deletion log, in order, each once. */
export function parseDeletionLog(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split("\n")) {
    const m = DELETION_LINE.exec(line.trim());
    if (m?.[1] && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

export interface PostRestoreOptions {
  now: number;
  /** Sign-in state: failure rows, session lifetimes. */
  failureTtlMs: number;
  sessionAbsoluteMs: number;
  sessionIdleMs: number;
  /** Raw event retention in days; null when it is not on yet. */
  retentionDays: number | null;
}

const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The statements a restored database runs before the edge points at it:
 * every logged customer deleted again (the catalog's order), then the
 * sign-in sweep and, when on, event retention. No marker purge: event data
 * is kept for the life of the account (ADR 0037). Plain SQL
 * with no transaction words, for `wrangler d1 execute --file`.
 */
export function postRestoreSql(ids: readonly string[], o: PostRestoreOptions): string {
  const out: string[] = [];
  for (const id of ids) {
    if (!CUSTOMER_ID_RE.test(id)) continue;
    for (const t of CUSTOMER_TABLES) {
      out.push(`DELETE FROM ${t.table} WHERE ${where(t).replace("?", sqlText(id))};`);
    }
  }
  out.push(
    `DELETE FROM superadmin_sessions WHERE expires_at < ${o.now} OR created_at < ${o.now - o.sessionAbsoluteMs} OR COALESCE(last_seen_at, created_at) < ${o.now - o.sessionIdleMs};`,
    `DELETE FROM auth_failures WHERE window_start < ${o.now - o.failureTtlMs};`,
    `DELETE FROM mfa_challenges WHERE expires_at < ${o.now};`,
  );
  if (o.retentionDays !== null) {
    out.push(`DELETE FROM events WHERE ts < ${o.now - o.retentionDays * 24 * 60 * 60 * 1000};`);
  }
  return `${out.join("\n")}\n`;
}
