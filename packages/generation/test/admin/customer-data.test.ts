/**
 * One customer's data: export and delete (docs/specs/security-hardening.md
 * §2) on real SQL with every migration. Two customers are seeded in every
 * table and in every KV group; the export holds one and only one, and the
 * delete removes one and leaves the other byte for byte.
 */

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "../model-env.ts";
import { makeKv, makeSqliteD1 } from "./sqlite-d1.ts";

type User = { id: string; email: string; role: string; customer_id: string | null };
let sessionUser: User | null = null;
vi.mock("../../src/admin/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/admin/auth.ts")>();
  return { ...actual, getSessionUser: vi.fn(async () => sessionUser) };
});

const { default: worker } = await import("../../src/index.ts");
const {
  CUSTOMER_TABLES,
  EXCLUDED_TABLES,
  KV_GROUPS,
  REDACTED,
  DELETE_FLOOR,
  countCustomerData,
  deleteCustomerData,
} = await import("../../src/admin/customer-data.ts");

const SUPERADMIN: User = {
  id: "root",
  email: "f@example.com",
  role: "superadmin",
  customer_id: null,
};

let sqlite: ReturnType<typeof makeSqliteD1>;
let kv: ReturnType<typeof makeKv>;
let env: Record<string, unknown>;

// ---------------------------------------------------------------------------
// A generic seeder: one row per table per customer, every NOT NULL column
// filled, the customer's own id where the table scopes by it.
// ---------------------------------------------------------------------------

interface Col {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function columns(db: DatabaseSync, table: string): Col[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Col[];
}

let seq = 0;
function seedRow(db: DatabaseSync, table: string, values: Record<string, unknown>): void {
  const row: Record<string, unknown> = { ...values };
  for (const c of columns(db, table)) {
    if (c.name in row) continue;
    const needed = c.notnull === 1 && c.dflt_value === null;
    if (!needed && c.pk === 0) continue;
    if (c.pk > 0 && /INT/i.test(c.type) && columns(db, table).filter((x) => x.pk > 0).length === 1)
      continue; // INTEGER PRIMARY KEY: SQLite picks it
    seq++;
    row[c.name] = /INT|REAL|NUM/i.test(c.type) ? seq : `${table}-${c.name}-${seq}`;
  }
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...(Object.values(row) as Array<string | number | null>));
}

const OVERRIDES: Record<string, (cid: string) => Record<string, unknown>> = {
  // The counter is exported only for a day that has its rollup row.
  exposure_rollup_days: () => ({ day: "2026-10-01" }),
  page_days: () => ({ day: "2026-10-01", page_path: "/" }),
  site_paths: () => ({ path: "/pricing", kind: "price", confidence: "high", label: "Pricing" }),
  intent_profiles: (cid) => ({ id: `profile-${cid}` }),
  audit_reports: (cid) => ({ state: "full", token_hash: `audit-token-${cid}` }),
  variants: (cid) => ({ profile_id: `profile-${cid}` }),
  events: (cid) => ({
    visit: `visit-${cid}`,
    ts: 1,
    event_type: "personalization_applied",
    profile_id: `profile-${cid}`,
  }),
  superadmin_users: (cid) => ({
    id: `user-${cid}`,
    email: `owner@${cid}.test`,
    password_hash: `pbkdf2-${cid}`,
    role: "customer",
  }),
};

function seedCustomer(db: DatabaseSync, cid: string, extraEvents = 0): void {
  for (const t of [...CUSTOMER_TABLES].reverse()) {
    const own =
      t.by === "id"
        ? { id: cid, slug: cid, domain: `${cid}.test`, plan: "pilot", status: "active" }
        : t.by === "customer_id"
          ? { customer_id: cid }
          : { user_id: `user-${cid}` };
    seedRow(db, t.table, { ...(OVERRIDES[t.table]?.(cid) ?? {}), ...own });
  }
  for (let i = 0; i < extraEvents; i++) {
    seedRow(db, "events", {
      customer_id: cid,
      ts: i,
      event_type: "page_view",
      visit: null,
      profile_id: null,
    });
  }
}

function seedKv(store: Map<string, string>, cid: string): void {
  for (const g of KV_GROUPS) {
    const key = g.key(cid);
    if (g.group === "alert_markers") {
      store.set(`ops:alert:lift-negative:${cid}`, "1");
      store.set(`ops:alert:holdout-split:${cid}:t1`, "1");
    } else if (g.exact) store.set(key, `${g.group}-${cid}`);
    else {
      store.set(`${key}a`, `${g.group}-${cid}-a`);
      store.set(`${key}p:%2Fpricing:feature:ai`, `${g.group}-${cid}-b`);
    }
  }
}

function snapshot(db: DatabaseSync, cid: string): string {
  const parts: string[] = [];
  for (const t of CUSTOMER_TABLES) {
    const cond =
      t.by === "id"
        ? "id = ?"
        : t.by === "customer_id"
          ? "customer_id = ?"
          : "user_id IN (SELECT id FROM superadmin_users WHERE customer_id = ?)";
    parts.push(
      JSON.stringify(db.prepare(`SELECT * FROM ${t.table} WHERE ${cond} ORDER BY rowid`).all(cid)),
    );
  }
  return parts.join("\n");
}

const count = (sql: string) => Number((sqlite.db.prepare(sql).get() as { n: number }).n);

const kvOf = (cid: string) =>
  [...kv.store.entries()]
    .filter(([k]) => k.split(":").includes(cid))
    .sort(([a], [b]) => a.localeCompare(b));

beforeEach(() => {
  sessionUser = SUPERADMIN;
  sqlite = makeSqliteD1();
  kv = makeKv();
  env = {
    DB: sqlite.d1,
    VARIANTS: kv,
    ENVIRONMENT: "test",
    DASHBOARD_ORIGIN: "https://app.test",
    ...MODEL_ENV,
  };
  seq = 0;
  seedCustomer(sqlite.db, "acme");
  seedCustomer(sqlite.db, "acme-2");
  seedKv(kv.store, "acme");
  seedKv(kv.store, "acme-2");
  // apply suggestions are keyed by application id.
  for (const cid of ["acme", "acme-2"]) {
    const app = sqlite.db
      .prepare("SELECT id FROM pilot_applications WHERE customer_id = ?")
      .get(cid) as { id: string };
    kv.store.set(`apply-suggest:${app.id}`, `suggest-${cid}`);
  }
  // A global profile (customer_id NULL) and someone else's alert are never one customer's.
  kv.store.set("ops:alert:render-cap", "1");
  kv.store.set("capture-token:abc", "acme");
});

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", "X-Rawuser-Admin": "t" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
}

// ---------------------------------------------------------------------------

describe("the catalog", () => {
  it("names every table of every migration, as the customer's or excluded with a reason", () => {
    const tables = (
      sqlite.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    const listed = new Set(CUSTOMER_TABLES.map((t) => t.table));
    const missing = tables.filter((t) => !listed.has(t) && !(t in EXCLUDED_TABLES));
    expect(missing).toEqual([]);
    for (const t of tables) {
      const cols = columns(sqlite.db, t).map((c) => c.name);
      if (cols.includes("customer_id") || cols.includes("user_id")) {
        expect(listed.has(t) || t in EXCLUDED_TABLES, t).toBe(true);
      }
    }
  });

  it("scopes each listed table by a column it has, and redacts only columns it has", () => {
    for (const t of CUSTOMER_TABLES) {
      const cols = columns(sqlite.db, t.table).map((c) => c.name);
      const col = t.by === "id" ? "id" : t.by === "customer_id" ? "customer_id" : "user_id";
      expect(cols, t.table).toContain(col);
      for (const r of t.redact ?? []) expect(cols, `${t.table}.${r}`).toContain(r);
    }
  });
});

describe("GET /admin/customers/export", () => {
  async function exportLines(cid: string) {
    const res = await call("GET", `/admin/customers/export?customer_id=${cid}`);
    expect(res.status).toBe(200);
    return {
      res,
      lines: (await res.text())
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
    };
  }

  it("streams meta, every row and key of the customer and none of another, then end", async () => {
    const { res, lines } = await exportLines("acme");
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="rawuser-export-acme-\d{4}-\d{2}-\d{2}\.ndjson"$/,
    );
    expect(lines[0]).toMatchObject({
      type: "meta",
      format: "rawuser-customer-export/1",
      customer_id: "acme",
    });
    const end = lines[lines.length - 1];
    expect(end.type).toBe("end");

    const rows = lines.filter((l) => l.type === "row");
    for (const t of CUSTOMER_TABLES) {
      expect(
        rows.filter((r) => r.table === t.table),
        t.table,
      ).toHaveLength(1);
      expect(end.rows[t.table]).toBe(1);
    }
    expect(JSON.stringify(rows)).not.toContain("acme-2");

    const keys = lines.filter((l) => l.type === "kv").map((l) => l.key);
    expect(end.kv_keys).toBe(keys.length);
    // Every seeded key of acme (its application's suggestion too), none of acme-2's.
    const expected = kvOf("acme").map(([k]) => k);
    expect(keys.filter((k) => !k.startsWith("apply-suggest:")).sort()).toEqual(expected);
    expect(keys.filter((k) => k.startsWith("apply-suggest:"))).toHaveLength(1);
    expect(keys.join(" ")).not.toContain("acme-2");
    expect(keys).not.toContain("ops:alert:render-cap");
    expect(keys).not.toContain("capture-token:abc");
  });

  it("redacts secrets, hashes and the visit marker, and says so in meta", async () => {
    const { lines } = await exportLines("acme");
    const byTable = (t: string) => lines.find((l) => l.type === "row" && l.table === t)?.row;
    expect(byTable("superadmin_users").password_hash).toBe(REDACTED);
    expect(byTable("superadmin_users").email).toBe("owner@acme.test");
    expect(byTable("superadmin_sessions").token_hash).toBe(REDACTED);
    expect(byTable("customer_setup_tokens").token_hash).toBe(REDACTED);
    expect(byTable("user_mfa").secret_enc).toBe(REDACTED);
    expect(byTable("mfa_recovery_codes").code_hash).toBe(REDACTED);
    expect(byTable("mfa_challenges").token_hash).toBe(REDACTED);
    expect(byTable("pilot_applications").token_hash).toBe(REDACTED);
    expect(byTable("events").visit).toBe(REDACTED);
    expect(byTable("events").__rowid).toBeUndefined();
    expect(lines[0].redacted).toEqual(
      expect.arrayContaining([
        "events.visit",
        "superadmin_users.password_hash",
        "user_mfa.secret_enc",
      ]),
    );
    expect(JSON.stringify(lines)).not.toContain("pbkdf2-acme");
    expect(JSON.stringify(lines)).not.toContain("visit-acme");
  });

  it("a conversion row's time leaves to the hour; other events as stored; meta says so (E1.1, Q3 condition 4)", async () => {
    const db = sqlite.db;
    db.prepare("DELETE FROM events WHERE customer_id = 'acme'").run();
    const at = Date.UTC(2026, 9, 12, 14, 37, 21, 456);
    const insert = db.prepare(
      "INSERT INTO events (id, customer_id, ts, event_type, conversion_label, page_path) VALUES (?, 'acme', ?, ?, ?, '/')",
    );
    insert.run("c1", at, "conversion", "contact");
    insert.run("c2", at + 1, "conversion", "signup");
    insert.run("v1", at, "variant_shown", null);
    insert.run("n1", at + 2, "no_signal_passthrough", null);
    const { lines } = await exportLines("acme");
    const rows = lines.filter((l) => l.type === "row" && l.table === "events").map((l) => l.row);
    const hour = Date.UTC(2026, 9, 12, 14);
    expect(rows.map((r) => [r.id, r.ts])).toEqual([
      ["c1", hour],
      ["c2", hour],
      ["v1", at],
      ["n1", at + 2],
    ]);
    expect(lines[0].rounded).toEqual(["events.ts (conversion rows, down to the hour)"]);
    // The row is otherwise as stored.
    expect(rows[0]).toMatchObject({ event_type: "conversion", conversion_label: "contact" });
  });

  it("page_days leaves folded, and only the days whose fold has run; the delete still takes every row", async () => {
    const db = sqlite.db;
    db.prepare(
      "UPDATE customers SET sensitive = 1, kept_sections = '[\"/products\"]' WHERE id = 'acme'",
    ).run();
    db.prepare("DELETE FROM page_days WHERE customer_id = 'acme'").run();
    const count = db.prepare(
      "INSERT INTO page_days (customer_id, day, page_path, loads) VALUES ('acme', ?, ?, ?)",
    );
    const rolled = db.prepare(
      "INSERT INTO exposure_rollup_days (customer_id, day, computed_at, mixed_visits) VALUES ('acme', ?, 1, 0)",
    );
    // 2026-10-01 has its rollup row (the seeder's). Three product pages were
    // left named by its fold; /zz-section was a kept section then and is not now.
    count.run("2026-10-01", "/", 4);
    count.run("2026-10-01", "/products", 3);
    count.run("2026-10-01", "/products/a", 1);
    count.run("2026-10-01", "/products/b", 2);
    count.run("2026-10-01", "/products/c", 3);
    count.run("2026-10-01", "/zz-section", 2);
    count.run("2026-10-01", "/zz-top", 1);
    // 2026-10-02, rolled up: a group's own row, and a load that landed after the fold.
    rolled.run("2026-10-02");
    count.run("2026-10-02", "/products/:item", 2);
    count.run("2026-10-02", "/products/zz-late", 5);
    // 2026-10-03: not folded yet. And today.
    count.run("2026-10-03", "/products/zz-unfolded", 9);
    count.run(new Date().toISOString().slice(0, 10), "/products/zz-open", 7);

    const { lines } = await exportLines("acme");
    const rows = lines.filter((l) => l.type === "row" && l.table === "page_days").map((l) => l.row);
    expect(rows).toEqual([
      { customer_id: "acme", day: "2026-10-01", page_path: "/", loads: 4 },
      { customer_id: "acme", day: "2026-10-01", page_path: "/:item", loads: 3 },
      { customer_id: "acme", day: "2026-10-01", page_path: "/products", loads: 3 },
      { customer_id: "acme", day: "2026-10-01", page_path: "/products/a", loads: 1 },
      { customer_id: "acme", day: "2026-10-01", page_path: "/products/b", loads: 2 },
      { customer_id: "acme", day: "2026-10-01", page_path: "/products/c", loads: 3 },
      { customer_id: "acme", day: "2026-10-02", page_path: "/products/:item", loads: 7 },
    ]);
    expect(lines[lines.length - 1].rows.page_days).toBe(7);
    expect(lines[0].folded).toEqual(["page_days"]);
    const text = JSON.stringify(lines);
    for (const gone of ["zz-unfolded", "zz-open", "zz-late", "zz-top", "zz-section"]) {
      expect(text, gone).not.toContain(gone);
    }
    // The stored rows are as they were: the export wrote nothing.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM page_days WHERE customer_id = 'acme'").get(),
    ).toEqual({
      n: 11,
    });

    // The delete removes every row, the unfolded day and today too.
    const res = await call("POST", "/admin/customers/delete", {
      customer_id: "acme",
      confirm: "delete acme",
    });
    expect(
      ((await res.json()) as { deleted: { d1: Record<string, number> } }).deleted.d1.page_days,
    ).toBe(11);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM page_days WHERE customer_id = 'acme'").get(),
    ).toEqual({
      n: 0,
    });
  });

  it("page_days pages through a long counter without losing or repeating a row", async () => {
    const db = sqlite.db;
    db.prepare("UPDATE customers SET sensitive = 1 WHERE id = 'acme'").run();
    db.prepare("DELETE FROM page_days WHERE customer_id = 'acme'").run();
    db.prepare("DELETE FROM exposure_rollup_days WHERE customer_id = 'acme'").run();
    const count = db.prepare(
      "INSERT INTO page_days (customer_id, day, page_path, loads) VALUES ('acme', ?, '/', ?)",
    );
    const rolled = db.prepare(
      "INSERT INTO exposure_rollup_days (customer_id, day, computed_at, mixed_visits) VALUES ('acme', ?, 1, 0)",
    );
    for (let i = 0; i < 1203; i++) {
      const day = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
      count.run(day, i + 1);
      rolled.run(day);
    }
    const { lines } = await exportLines("acme");
    const rows = lines.filter((l) => l.type === "row" && l.table === "page_days").map((l) => l.row);
    expect(rows).toHaveLength(1203);
    expect(new Set(rows.map((r) => r.day)).size).toBe(1203);
    expect(rows.reduce((t, r) => t + r.loads, 0)).toBe((1203 * 1204) / 2);
  });

  it("pages large tables by rowid without losing or repeating a row", async () => {
    seedCustomer(sqlite.db, "big", 1203);
    const { lines } = await exportLines("big");
    const events = lines.filter((l) => l.type === "row" && l.table === "events");
    expect(events).toHaveLength(1204);
    expect(new Set(events.map((e) => e.row.id)).size).toBe(1204);
  });

  it("answers 400 for a bad id, 404 for an unknown one, 403 for a customer user", async () => {
    expect((await call("GET", "/admin/customers/export?customer_id=a%3Ab")).status).toBe(400);
    expect((await call("GET", "/admin/customers/export?customer_id=nobody")).status).toBe(404);
    sessionUser = { id: "user-acme", email: "o@a", role: "customer", customer_id: "acme" };
    expect((await call("GET", "/admin/customers/export?customer_id=acme")).status).toBe(403);
  });
});

describe("the tombstone (privacy review condition 1)", () => {
  it("a confirmed delete writes v1:closed:{id} = 1 for 13 months, kept on a re-run, never exported or counted", async () => {
    const puts: Array<{ key: string; ttl?: number }> = [];
    const put = kv.put.bind(kv);
    (kv as unknown as { put: unknown }).put = async (
      key: string,
      value: string,
      opts?: { expirationTtl?: number },
    ) => {
      puts.push({ key, ttl: opts?.expirationTtl });
      await put(key, value);
    };
    const res = await call("POST", "/admin/customers/delete", {
      customer_id: "acme",
      confirm: "delete acme",
    });
    const body = (await res.json()) as { closed: boolean; log: string };
    expect(body.closed).toBe(true);
    expect(body.log).toMatch(/^acme \d{4}-\d{2}-\d{2}$/);
    expect(kv.store.get("v1:closed:acme")).toBe("1");
    expect(puts.filter((p) => p.key === "v1:closed:acme").map((p) => p.ttl)).toEqual([
      395 * 86400,
      395 * 86400,
    ]);
    // A re-run keeps it; the counts never see it.
    await call("POST", "/admin/customers/delete", { customer_id: "acme", confirm: "delete acme" });
    expect(kv.store.get("v1:closed:acme")).toBe("1");
    const left = await countCustomerData(env as never, "acme");
    expect(Object.values(left.kv).every((n) => n === 0)).toBe(true);
    expect(kv.store.has("v1:closed:acme-2")).toBe(false);
  });

  it("an export never carries a tombstone, and carries the cover line and the hand-off rule", async () => {
    kv.store.set("v1:closed:acme", "1");
    const res = await call("GET", "/admin/customers/export?customer_id=acme");
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.some((l) => l.type === "kv" && l.key.startsWith("v1:closed:"))).toBe(false);
    expect(lines[0].cover).toBe(
      "This file holds your account data and your sites' page-view records, without visit codes. It is personal data under your control; do not combine it with other logs to find a person.",
    );
    expect(lines[0].handoff).toContain("within 7 days");
  });

  it("a closed id is never given to a new customer", async () => {
    const { insertCustomer } = await import("../../src/admin/handlers.ts");
    kv.store.set("v1:closed:reborn", "1");
    const c = {
      domain: "r.test",
      plan: "pilot",
      contactEmail: null,
      contactName: null,
      createdAt: 1,
    };
    expect(await insertCustomer(env as never, { ...c, slug: "reborn" })).toBe(false);
    expect(await insertCustomer(env as never, { ...c, slug: "fresh" })).toBe(true);
  });
});

describe("after a restore (privacy review condition 2)", () => {
  it("reads the deletion log's plain lines only", async () => {
    const { parseDeletionLog } = await import("../../src/admin/customer-data.ts");
    const log = [
      "# Deletion log",
      "- acme 2026-10-06",
      "- acme 2026-10-06 export copy deleted",
      "- other-co 2026-11-01",
      "- acme 2026-12-01",
      "- bad;id 2026-10-06",
    ].join("\n");
    expect(parseDeletionLog(log)).toEqual(["acme", "other-co"]);
  });

  it("deletes every logged customer again and sweeps, and keeps every event column (ADR 0037)", async () => {
    const { postRestoreSql } = await import("../../src/admin/customer-data.ts");
    const other = snapshot(sqlite.db, "acme-2");
    const now = Date.UTC(2026, 9, 6);
    sqlite.db
      .prepare(
        "UPDATE events SET visit = 'old', properties = '{\"kind\":\"late\",\"lp\":1}', ts = ? WHERE customer_id = 'acme-2'",
      )
      .run(now - 40 * 86400e3);
    const sql = postRestoreSql(["acme", "ghost"], {
      now,
      failureTtlMs: 86400e3,
      sessionAbsoluteMs: 7 * 86400e3,
      sessionIdleMs: 12 * 3600e3,
      retentionDays: null,
    });
    expect(sql).not.toMatch(/BEGIN|COMMIT|TRANSACTION/i);
    sqlite.db.exec(sql);
    expect(snapshot(sqlite.db, "acme")).toBe(Array(CUSTOMER_TABLES.length).fill("[]").join("\n"));
    // acme-2's rows stay whole: the old marker and the bit lp are kept.
    expect(
      sqlite.db.prepare("SELECT visit FROM events WHERE customer_id = 'acme-2'").get(),
    ).toEqual({
      visit: "old",
    });
    const pr = sqlite.db
      .prepare("SELECT properties FROM events WHERE customer_id = 'acme-2'")
      .get() as { properties: string | null };
    expect(pr.properties).toBe('{"kind":"late","lp":1}');
    expect(sql).not.toMatch(/UPDATE events|json_remove/);
    expect(count("SELECT COUNT(*) AS n FROM customers WHERE id = 'acme-2'")).toBe(1);
    expect(other).not.toBe("");
  });
});

describe("POST /admin/customers/delete", () => {
  it("a dry run counts and changes nothing", async () => {
    const before = snapshot(sqlite.db, "acme");
    const keys = kv.store.size;
    const res = await call("POST", "/admin/customers/delete", {
      customer_id: "acme",
      dry_run: true,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.dry_run).toBe(true);
    expect(body.confirm).toBe("delete acme");
    expect(body.total_rows).toBe(CUSTOMER_TABLES.length);
    expect((body.kv as Record<string, number>).versions).toBe(2);
    expect((body.kv as Record<string, number>).alert_markers).toBe(2);
    expect((body.kv as Record<string, number>).apply_suggestions).toBe(1);
    expect(snapshot(sqlite.db, "acme")).toBe(before);
    expect(kv.store.size).toBe(keys);
    // No confirm, or a wrong one, is a dry run too.
    const wrong = await call("POST", "/admin/customers/delete", {
      customer_id: "acme",
      confirm: "delete acme-2",
    });
    expect(((await wrong.json()) as { dry_run: boolean }).dry_run).toBe(true);
    expect(snapshot(sqlite.db, "acme")).toBe(before);
  });

  it("deletes everything of one customer and nothing of another", async () => {
    const other = snapshot(sqlite.db, "acme-2");
    const otherKv = kvOf("acme-2");
    const res = await call("POST", "/admin/customers/delete", {
      customer_id: "acme",
      confirm: "delete acme",
    });
    const body = (await res.json()) as {
      done: boolean;
      deleted: { d1: Record<string, number> };
      remaining: { d1: Record<string, number>; kv: Record<string, number> };
    };
    expect(body.done).toBe(true);
    expect(body.deleted.d1.customers).toBe(1);
    expect(Object.values(body.remaining.d1).every((n) => n === 0)).toBe(true);
    expect(Object.values(body.remaining.kv).every((n) => n === 0)).toBe(true);
    expect(snapshot(sqlite.db, "acme")).toBe(Array(CUSTOMER_TABLES.length).fill("[]").join("\n"));
    // Only the tombstone is left of acme (condition 1).
    expect(kvOf("acme")).toEqual([["v1:closed:acme", "1"]]);
    expect([...kv.store.keys()].filter((k) => k.startsWith("apply-suggest:"))).toHaveLength(1);
    expect(snapshot(sqlite.db, "acme-2")).toBe(other);
    expect(kvOf("acme-2")).toEqual(otherKv);
    expect(kv.store.has("ops:alert:render-cap")).toBe(true);
    // Again: the customer is gone, the sweep still answers done.
    const again = await call("POST", "/admin/customers/delete", {
      customer_id: "acme",
      confirm: "delete acme",
    });
    expect(((await again.json()) as { done: boolean }).done).toBe(true);
    // A dry run now: unknown.
    const dry = await call("POST", "/admin/customers/delete", { customer_id: "acme" });
    expect(dry.status).toBe(404);
  });

  it("stops at its budget and finishes when called again", async () => {
    seedCustomer(sqlite.db, "big", 250);
    seedKv(kv.store, "big");
    for (let i = 0; i < 30; i++) kv.store.set(`v1:variant:big:x${i}:ai`, "v");
    const other = snapshot(sqlite.db, "acme");
    let runs = 0;
    for (;;) {
      runs++;
      // A budget under the floor is raised to it: every call still moves.
      const r = await deleteCustomerData(env as never, "big", { budget: 1, chunk: 40 });
      if (r.done) break;
      expect(runs).toBeLessThan(100);
    }
    expect(runs).toBeGreaterThan(1);
    expect(DELETE_FLOOR).toBeLessThan(100);
    const left = await countCustomerData(env as never, "big");
    expect(Object.values(left.d1).every((n) => n === 0)).toBe(true);
    expect(Object.values(left.kv).every((n) => n === 0)).toBe(true);
    expect(snapshot(sqlite.db, "acme")).toBe(other);
  });

  it("is superadmin only and checks the id", async () => {
    expect((await call("POST", "/admin/customers/delete", { customer_id: "" })).status).toBe(400);
    sessionUser = { id: "user-acme", email: "o@a", role: "customer", customer_id: "acme" };
    const r = await call("POST", "/admin/customers/delete", {
      customer_id: "acme",
      confirm: "delete acme",
    });
    expect(r.status).toBe(403);
    expect(snapshot(sqlite.db, "acme")).not.toBe(
      Array(CUSTOMER_TABLES.length).fill("[]").join("\n"),
    );
  });
});

describe("the keyword lexicon in the export and the delete (keyword-intent.md; privacy review 10, condition 10)", () => {
  it("the customers row carries keyword_lexicon, keyword_lexicon_at and keyword_off; the delete removes them with it", async () => {
    const lexicon = JSON.stringify({ pricing: ["crm pricing"], competitor: ["hubspot"] });
    sqlite.db
      .prepare(
        "UPDATE customers SET keyword_lexicon = ?, keyword_lexicon_at = 5, keyword_off = 0 WHERE id = 'acme'",
      )
      .run(lexicon);
    const res = await call("GET", "/admin/customers/export?customer_id=acme");
    expect(res.status).toBe(200);
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const row = lines.find((l) => l.type === "row" && l.table === "customers")?.row;
    expect(row.keyword_lexicon).toBe(lexicon);
    expect(row.keyword_lexicon_at).toBe(5);
    expect(row.keyword_off).toBe(0);

    for (let runs = 0; runs < 20; runs++) {
      const r = await deleteCustomerData(env as never, "acme");
      if (r.done) break;
    }
    expect(sqlite.db.prepare("SELECT id FROM customers WHERE id = 'acme'").get()).toBeUndefined();
    const other = sqlite.db
      .prepare("SELECT keyword_off FROM customers WHERE id = 'acme-2'")
      .get() as { keyword_off: number };
    expect(other.keyword_off).toBe(0);
  });
});
