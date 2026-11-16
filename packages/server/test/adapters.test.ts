import { describe, expect, it } from "vitest";
import { SCHEDULES, fires, startCron } from "../src/cron.ts";
import { d1Over, openDatabase } from "../src/d1.ts";
import { kvOver } from "../src/kv.ts";
import { fixedWindow } from "../src/limit.ts";

function database() {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, n INTEGER)");
  return { db, d1: d1Over(db) };
}

describe("D1 over SQLite: the calls the workers make", () => {
  it("run reports what changed; first gives a row, a column or null; all gives the rows", async () => {
    const { d1 } = database();
    const r = await d1.prepare("INSERT INTO t (name, n) VALUES (?, ?)").bind("a", 1).run();
    expect(r.success).toBe(true);
    expect(r.meta.changes).toBe(1);
    expect(r.meta.last_row_id).toBe(1);
    await d1.prepare("INSERT INTO t (name, n) VALUES (?, ?)").bind("b", 2).run();

    expect(await d1.prepare("SELECT name, n FROM t WHERE id = ?").bind(1).first()).toEqual({
      name: "a",
      n: 1,
    });
    expect(await d1.prepare("SELECT n FROM t WHERE name = ?").bind("b").first("n")).toBe(2);
    expect(await d1.prepare("SELECT * FROM t WHERE id = 99").first()).toBeNull();
    const all = await d1.prepare("SELECT name FROM t ORDER BY name").all<{ name: string }>();
    expect(all.results.map((x) => x.name)).toEqual(["a", "b"]);
    expect((await d1.prepare("UPDATE t SET n = 0 WHERE id > 99").run()).meta.changes).toBe(0);
  });

  it("knows a statement that gives rows whatever it starts with: a comment, WITH, RETURNING", async () => {
    const { d1 } = database();
    await d1.prepare("INSERT INTO t (name, n) VALUES ('a', 1)").run();
    const commented = await d1.prepare("/* why */ -- and why\n SELECT name FROM t").all();
    expect(commented.results).toEqual([{ name: "a" }]);
    const cte = await d1.prepare("WITH x AS (SELECT n FROM t) SELECT n FROM x").all();
    expect(cte.results).toEqual([{ n: 1 }]);
    const back = await d1.prepare("INSERT INTO t (name, n) VALUES ('b', 2) RETURNING id").all();
    expect(back.results).toEqual([{ id: 2 }]);
  });

  it("binds what a worker passes: undefined and null as NULL, a boolean as a number", async () => {
    const { d1 } = database();
    await d1.prepare("INSERT INTO t (name, n) VALUES (?, ?)").bind("u", undefined).run();
    await d1.prepare("INSERT INTO t (name, n) VALUES (?, ?)").bind("t", true).run();
    const rows = await d1.prepare("SELECT name, n FROM t ORDER BY name").all();
    expect(rows.results).toEqual([
      { name: "t", n: 1 },
      { name: "u", n: null },
    ]);
  });

  it("a batch is one transaction: every statement, with each one's result", async () => {
    const { d1 } = database();
    const out = await d1.batch([
      d1.prepare("INSERT INTO t (name, n) VALUES ('a', 1)"),
      d1.prepare("INSERT INTO t (name, n) VALUES ('b', 2)"),
      d1.prepare("SELECT count(*) AS c FROM t"),
    ]);
    expect(out.map((r) => r.meta.changes)).toEqual([1, 1, 0]);
    expect(out[2]?.results).toEqual([{ c: 2 }]);
  });

  it("a batch that fails leaves nothing behind", async () => {
    const { d1 } = database();
    await d1.prepare("INSERT INTO t (name, n) VALUES ('a', 1)").run();
    await expect(
      d1.batch([
        d1.prepare("INSERT INTO t (name, n) VALUES ('b', 2)"),
        d1.prepare("INSERT INTO t (name, n) VALUES ('a', 3)"), // the name is taken
      ]),
    ).rejects.toThrow();
    expect(await d1.prepare("SELECT count(*) AS c FROM t").first("c")).toBe(1);
    // And the database is not left inside a transaction.
    await d1.prepare("INSERT INTO t (name, n) VALUES ('c', 4)").run();
    expect(await d1.prepare("SELECT count(*) AS c FROM t").first("c")).toBe(2);
  });

  it("foreign keys hold, as in D1", async () => {
    const db = openDatabase(":memory:");
    db.exec(
      "CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (p INTEGER REFERENCES p(id) ON DELETE CASCADE);",
    );
    const d1 = d1Over(db);
    await expect(d1.prepare("INSERT INTO c (p) VALUES (1)").run()).rejects.toThrow();
    await d1.prepare("INSERT INTO p (id) VALUES (1)").run();
    await d1.prepare("INSERT INTO c (p) VALUES (1)").run();
    await d1.prepare("DELETE FROM p").run();
    expect(await d1.prepare("SELECT count(*) AS c FROM c").first("c")).toBe(0);
  });
});

describe("KV over SQLite", () => {
  function kv() {
    let now = 1_000_000;
    const store = kvOver(openDatabase(":memory:"), () => now);
    return {
      store,
      pass: (ms: number) => {
        now += ms;
      },
    };
  }

  it("gives back what was put, as text or as JSON, and null for what is not there", async () => {
    const { store } = kv();
    await store.put("a", JSON.stringify({ x: 1 }));
    expect(await store.get("a")).toBe('{"x":1}');
    expect(await store.get("a", "json")).toEqual({ x: 1 });
    expect(await store.get("a", { type: "json", cacheTtl: 300 })).toEqual({ x: 1 });
    expect(await store.get("missing")).toBeNull();
    await store.put("a", "again");
    expect(await store.get("a")).toBe("again");
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
  });

  it("a key with a life is gone when it ends, and a later put without one stays", async () => {
    const { store, pass } = kv();
    await store.put("t", "v", { expirationTtl: 60 });
    pass(59_000);
    expect(await store.get("t")).toBe("v");
    pass(1_000);
    expect(await store.get("t")).toBeNull();
    await store.put("t", "kept");
    pass(10 * 60_000);
    expect(await store.get("t")).toBe("kept");
  });

  it("lists by prefix, in order, in pages with a cursor, and never an expired key", async () => {
    const { store, pass } = kv();
    for (const k of ["a:3", "a:1", "b:1", "a:2"]) await store.put(k, "v");
    await store.put("a:0", "v", { expirationTtl: 1 });
    pass(2_000);
    const first = await store.list({ prefix: "a:", limit: 2 });
    expect(first.keys.map((k) => k.name)).toEqual(["a:1", "a:2"]);
    expect(first.list_complete).toBe(false);
    const rest = await store.list({
      prefix: "a:",
      limit: 2,
      cursor: (first as { cursor: string }).cursor,
    });
    expect(rest.keys.map((k) => k.name)).toEqual(["a:3"]);
    expect(rest.list_complete).toBe(true);
    // A prefix with a character LIKE would read as a wildcard is taken as written.
    await store.put("x%y", "v");
    await store.put("xzy", "v");
    expect((await store.list({ prefix: "x%" })).keys.map((k) => k.name)).toEqual(["x%y"]);
  });

  it("sweep removes what has expired and nothing else", async () => {
    const { store, pass } = kv();
    await store.put("gone", "v", { expirationTtl: 1 });
    await store.put("stays", "v");
    pass(5_000);
    expect(store.sweep()).toBe(1);
    expect((await store.list()).keys.map((k) => k.name)).toEqual(["stays"]);
  });

  it("refuses what it cannot keep, so nothing is stored wrongly", async () => {
    const { store } = kv();
    await expect(store.put("k", new Uint8Array(2) as unknown as string)).rejects.toThrow("text");
  });
});

describe("the limiter", () => {
  it("lets a key through up to its limit in a window, then again in the next", async () => {
    let now = 0;
    const l = fixedWindow(3, 60, () => now);
    const go = async (key: string) => (await l.limit({ key })).success;
    expect([await go("a"), await go("a"), await go("a"), await go("a")]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    // Another key has its own count.
    expect(await go("b")).toBe(true);
    now = 60_000;
    expect(await go("a")).toBe(true);
  });
});

describe("the schedule", () => {
  const at = (iso: string) => new Date(iso);

  it("reads the four lines the generation worker runs on", () => {
    // Monday 2026-01-05 06:00 UTC: all four.
    expect(SCHEDULES.filter((c) => fires(c, at("2026-01-05T06:00:00Z")))).toEqual([...SCHEDULES]);
    // 06:05: only the five-minute queue.
    expect(SCHEDULES.filter((c) => fires(c, at("2026-01-05T06:05:00Z")))).toEqual(["*/5 * * * *"]);
    // 07:00 on a Monday: hourly and the queue.
    expect(SCHEDULES.filter((c) => fires(c, at("2026-01-05T07:00:00Z")))).toEqual([
      "0 * * * *",
      "*/5 * * * *",
    ]);
    // Tuesday 06:00: not the weekly line.
    expect(fires("0 6 * * 1", at("2026-01-06T06:00:00Z"))).toBe(false);
    expect(fires("0 */6 * * *", at("2026-01-06T12:00:00Z"))).toBe(true);
    expect(fires("0 */6 * * *", at("2026-01-06T13:00:00Z"))).toBe(false);
  });

  it("refuses a line it cannot read", () => {
    expect(() => fires("* * * *", new Date())).toThrow("five fields");
    expect(() => fires("1-5 * * * *", new Date())).toThrow("cannot read");
  });

  it("is the list in the generation worker's own config", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const root = resolve(import.meta.dirname, "../../..");
    // In the public repository the config is the template beside the worker.
    const path = [
      "ops/public/overlay/packages/generation/wrangler.toml",
      "packages/generation/wrangler.toml",
    ]
      .map((p) => resolve(root, p))
      .find((p) => existsSync(p)) as string;
    const line = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => l.startsWith("triggers = { crons = ["));
    const listed = [...(line ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...SCHEDULES].sort());
  });

  it("starts each line that fires, logs one that throws, and does not start one still running", async () => {
    const calls: string[] = [];
    const logged: string[] = [];
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const cron = startCron(
      async (line) => {
        calls.push(line);
        if (line === "0 * * * *") throw new Error("the hourly failed");
        if (line === "*/5 * * * *") await slow;
      },
      SCHEDULES,
      (l) => logged.push(l),
    );
    const first = cron.tick(at("2026-01-05T07:00:00Z"));
    // The queue is still running at 07:05: it is not started a second time.
    expect(cron.tick(at("2026-01-05T07:05:00Z"))).toHaveLength(0);
    release();
    await Promise.all(first);
    expect(calls).toEqual(["0 * * * *", "*/5 * * * *"]);
    expect(logged).toEqual(["[cron 0 * * * *] the hourly failed"]);
    expect(cron.tick(at("2026-01-05T07:10:00Z"))).toHaveLength(1);
    cron.stop();
  });
});
