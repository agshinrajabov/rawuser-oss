/**
 * Migration 0042 (docs/specs/sensitive-customers.md): the flag, the list and
 * the daily counter, on node:sqlite with every migration. The counter has
 * exactly four columns and no time of any kind (privacy review condition
 * 4), and the shared upsert is the one statement that writes a load.
 */
import {
  PAGE_DAYS_UPSERT_SQL,
  SENSITIVE_CUSTOMER_SQL,
  sensitiveSettingsFrom,
} from "@rawuser/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { makeSqliteD1 } from "../admin/sqlite-d1.ts";

let sqlite: ReturnType<typeof makeSqliteD1>;

interface Col {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

const columns = (table: string) =>
  sqlite.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Col[];

function customer(id: string): void {
  sqlite.db
    .prepare(
      "INSERT INTO customers (id, slug, domain, status, plan, created_at) VALUES (?, ?, ?, 'active', 'pilot', 1)",
    )
    .run(id, id, `${id}.test`);
}

beforeEach(() => {
  sqlite = makeSqliteD1();
  customer("medora");
});

describe("migration 0042", () => {
  it("page_days has exactly four columns, keyed on the first three, and no time", () => {
    const cols = columns("page_days");
    expect(cols.map((c) => c.name)).toEqual(["customer_id", "day", "page_path", "loads"]);
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
      "customer_id",
      "day",
      "page_path",
    ]);
    expect(cols.every((c) => c.notnull === 1)).toBe(true);
    for (const c of cols) expect(c.name).not.toMatch(/ts|_at$|time|visit|arm|intent|source/);
  });

  it("a customer is not sensitive until marked, with an empty list", () => {
    const byName = new Map(columns("customers").map((c) => [c.name, c]));
    expect(byName.get("sensitive")).toMatchObject({ notnull: 1, dflt_value: "0" });
    expect(byName.get("kept_sections")).toMatchObject({ notnull: 0, dflt_value: null });
    const row = sqlite.db.prepare(SENSITIVE_CUSTOMER_SQL).get("medora") as {
      sensitive: number;
      kept_sections: string | null;
    };
    expect(row).toEqual({ sensitive: 0, kept_sections: null });
    expect(sensitiveSettingsFrom(row)).toEqual({ sensitive: false, kept: [] });
  });

  it("the shared read gives the flag and the list once set", async () => {
    sqlite.db
      .prepare("UPDATE customers SET sensitive = 1, kept_sections = ? WHERE id = 'medora'")
      .run(JSON.stringify(["/about", "/products"]));
    const row = await sqlite.d1.prepare(SENSITIVE_CUSTOMER_SQL).bind("medora").first();
    expect(sensitiveSettingsFrom(row)).toEqual({ sensitive: true, kept: ["/about", "/products"] });
    expect(
      sensitiveSettingsFrom(await sqlite.d1.prepare(SENSITIVE_CUSTOMER_SQL).bind("nobody").first()),
    ).toEqual({ sensitive: false, kept: [] });
  });

  it("the shared upsert counts one load per call, one row per day and page", async () => {
    const load = (day: string, path: string) =>
      sqlite.d1.prepare(PAGE_DAYS_UPSERT_SQL).bind("medora", day, path).run();
    await load("2026-10-12", "/products/ginseng");
    await load("2026-10-12", "/products/ginseng");
    await load("2026-10-12", "/");
    await load("2026-10-13", "/products/ginseng");
    expect(sqlite.db.prepare("SELECT * FROM page_days ORDER BY day, page_path").all()).toEqual([
      { customer_id: "medora", day: "2026-10-12", page_path: "/", loads: 1 },
      { customer_id: "medora", day: "2026-10-12", page_path: "/products/ginseng", loads: 2 },
      { customer_id: "medora", day: "2026-10-13", page_path: "/products/ginseng", loads: 1 },
    ]);
  });

  it("the counter goes with the customer, and takes no row for a customer that does not exist", async () => {
    await sqlite.d1.prepare(PAGE_DAYS_UPSERT_SQL).bind("medora", "2026-10-12", "/").run();
    await expect(
      sqlite.d1.prepare(PAGE_DAYS_UPSERT_SQL).bind("nobody", "2026-10-12", "/").run(),
    ).rejects.toThrow(/FOREIGN KEY/);
    sqlite.db.prepare("DELETE FROM customers WHERE id = 'medora'").run();
    expect(sqlite.db.prepare("SELECT COUNT(*) AS n FROM page_days").get()).toEqual({ n: 0 });
  });
});
