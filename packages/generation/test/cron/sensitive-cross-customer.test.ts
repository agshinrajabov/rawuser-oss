/**
 * A sensitive customer's data enters no cross-customer count
 * (docs/specs/sensitive-customers.md, rule 3). The edge writes no learning
 * counter for one; generation is the second line:
 *
 * - the weekly source proposals leave out the week's buckets of every
 *   sensitive customer, so a row counted before the customer was marked is
 *   never proposed and never helps a value over the threshold;
 * - the filter every cross-customer read of events must use leaves the
 *   customer out.
 *
 * Real SQL on node:sqlite.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bucketOf, withoutBuckets } from "../../../../scripts/lib/sensitive-buckets.ts";
import { customerBucket as edgeBucket } from "../../../edge/src/ua-tokens.ts";
import { LEARNING_EVENTS_WHERE } from "../../src/audit/learning.ts";
import { proposalsSql, runSourceProposals } from "../../src/cron/source-proposals.ts";
import { customerBucket, sensitiveBuckets } from "../../src/lib/sensitive-guard.ts";
import { makeSqliteD1 } from "../admin/sqlite-d1.ts";

const NOW = new Date("2026-10-12T06:00:00Z");
const WEEK = "2026-W41";

let sqlite: ReturnType<typeof makeSqliteD1>;
let posted: string[];

function customer(id: string, sensitive: 0 | 1, plan = "pilot") {
  sqlite.db
    .prepare(
      "INSERT INTO customers (id, slug, domain, status, plan, created_at, sensitive) VALUES (?, ?, ?, 'active', ?, 1, ?)",
    )
    .run(id, id, `${id}.test`, plan, sensitive);
}

function counted(bucket: string, token: string, count: number, week = WEEK) {
  sqlite.db
    .prepare(
      "INSERT INTO signal_token_counts (week, customer_bucket, kind, token, count) VALUES (?, ?, 'utm_source', ?, ?)",
    )
    .run(week, bucket, token, count);
}

beforeEach(() => {
  sqlite = makeSqliteD1();
  posted = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      posted.push(String(input));
      return new Response("ok");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const env = () => ({
  DB: sqlite.d1,
  ALERT_WEBHOOK_URL: "https://api.telegram.org/botX/sendMessage?chat_id=1",
});

describe("the customer's bucket", () => {
  it("is the first byte of SHA-256(customer|week), two hex characters", async () => {
    for (const [id, week] of [
      ["medora", WEEK],
      ["acme", WEEK],
      ["medora", "2026-W42"],
    ] as const) {
      const expected = createHash("sha256").update(`${id}|${week}`).digest("hex").slice(0, 2);
      expect(await customerBucket(id, week)).toBe(expected);
    }
  });

  it("is the bucket the edge files the counters under", async () => {
    for (const id of ["medora", "acme", "lumera-school", "a_b-C9"]) {
      expect(await customerBucket(id, WEEK)).toBe(await edgeBucket(id, WEEK));
    }
  });

  it("is what the two proposal scripts leave out of their reads", async () => {
    for (const id of ["medora", "acme", "lumera-school"]) {
      expect(bucketOf(id, WEEK)).toBe(await customerBucket(id, WEEK));
    }
    expect(withoutBuckets([], WEEK)).toBe("");
    const a = bucketOf("medora", WEEK);
    const b = bucketOf("herbal", WEEK);
    const list = [...new Set([a, b])].sort().map((x) => `'${x}'`);
    expect(withoutBuckets(["medora", "herbal", "medora"], WEEK)).toBe(
      ` AND customer_bucket NOT IN (${list.join(", ")})`,
    );
  });

  it("lists the week's buckets of the sensitive customers only, each once", async () => {
    customer("medora", 1);
    customer("herbal", 1);
    customer("acme", 0);
    const expected = [await customerBucket("medora", WEEK), await customerBucket("herbal", WEEK)];
    expect(await sensitiveBuckets(sqlite.d1, WEEK)).toEqual([...new Set(expected)].sort());
    sqlite.db.prepare("UPDATE customers SET sensitive = 0").run();
    expect(await sensitiveBuckets(sqlite.d1, WEEK)).toEqual([]);
  });
});

describe("the weekly source proposals", () => {
  it("the read is the old statement when no customer is sensitive", () => {
    expect(proposalsSql(0)).toBe(
      `SELECT kind, token, COUNT(DISTINCT customer_bucket) AS buckets, SUM(count) AS sessions
     FROM signal_token_counts WHERE week = ?
     GROUP BY kind, token HAVING buckets >= ? AND sessions >= ?
     ORDER BY sessions DESC LIMIT 200`,
    );
    expect(proposalsSql(2)).toContain("AND customer_bucket NOT IN (?, ?)");
  });

  it("never propose a value that only the sensitive customer's rows carried over the threshold", async () => {
    customer("medora", 1);
    customer("acme", 0);
    const sensitive = await customerBucket("medora", WEEK);
    // Two buckets that are certainly not the sensitive one.
    const [b1, b2] = ["00", "01", "02"].filter((b) => b !== sensitive);
    if (!b1 || !b2) throw new Error("buckets");
    // Seen at two ordinary customers: proposed, as before.
    counted(b1, "partner-xyz", 40);
    counted(b2, "partner-xyz", 30);
    // Its second bucket is the sensitive customer's: one bucket is left.
    counted(b1, "liver-forum", 30);
    counted(sensitive, "liver-forum", 500);
    // Two ordinary buckets, but under fifty sessions without the sensitive one.
    counted(b1, "supplement-list", 10);
    counted(b2, "supplement-list", 10);
    counted(sensitive, "supplement-list", 500);

    const out = await runSourceProposals(env(), NOW);
    expect(out.week).toBe(WEEK);
    expect(out.proposals).toEqual([
      { kind: "utm_source", token: "partner-xyz", buckets: 2, sessions: 70 },
    ]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("1+unknown+value");

    // The same rows with no customer marked: all three would have been proposed.
    sqlite.db.prepare("UPDATE customers SET sensitive = 0").run();
    const unmarked = await runSourceProposals(env(), NOW);
    expect(unmarked.proposals.map((p) => p.token).sort()).toEqual([
      "liver-forum",
      "partner-xyz",
      "supplement-list",
    ]);
  });

  it("propose nothing and post nothing when the flag cannot be read", async () => {
    counted("00", "partner-xyz", 40);
    counted("01", "partner-xyz", 30);
    const prepare = sqlite.d1.prepare.bind(sqlite.d1);
    const failing = {
      ...sqlite.d1,
      prepare: (sql: string) => {
        if (sql.includes("WHERE sensitive = 1")) throw new Error("no such column: sensitive");
        return prepare(sql);
      },
    } as unknown as D1Database;
    await expect(runSourceProposals({ ...env(), DB: failing }, NOW)).rejects.toThrow();
    expect(posted).toEqual([]);
  });
});

describe("the filter for a cross-customer read of events", () => {
  it("leaves a sensitive customer out, whatever its plan and terms", () => {
    customer("pil", 0);
    customer("medora", 1);
    sqlite.db
      .prepare("UPDATE customers SET pilot_terms_at = 1 WHERE id IN ('pil', 'medora')")
      .run();
    const ev = sqlite.db.prepare(
      "INSERT INTO events (id, customer_id, ts, event_type, page_path) VALUES (?, ?, ?, 'variant_shown', '/')",
    );
    ev.run("e1", "pil", 10);
    ev.run("e2", "medora", 10);
    ev.run("e3", "medora", 9000);
    const rows = sqlite.db
      .prepare(`SELECT e.customer_id AS c FROM events e WHERE ${LEARNING_EVENTS_WHERE}`)
      .all();
    expect(rows).toEqual([{ c: "pil" }]);
  });
});
