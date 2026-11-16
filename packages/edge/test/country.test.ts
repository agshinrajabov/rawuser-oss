/**
 * The visitor's country at /event (ADR 0036, docs/specs/visitors-page.md).
 *
 * - every stored row but snippet_issue gets Cloudflare's `cf.country` as
 *   `countryOf` returns it: a code on the closed ISO list, else `other`;
 * - never from the body: a browser cannot set it;
 * - nothing with the bundle's `co`, nothing when neither the bundle nor the
 *   database could say (fail closed); `country_off` from the database when
 *   the bundle is missing;
 * - the 202 is the same whatever the country (the answers and the script
 *   are pinned byte identical with `co` in sensitive.test.ts).
 */
import { ISO_COUNTRIES, OTHER_COUNTRY, countryOf, visitorBundleKey } from "@rawuser/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { resetEventGuardForTests } from "../src/event.ts";
import worker from "../src/index.ts";

const ID = "acme";
const VISIT = "0123456789abcdef0123456789abcdef";

interface Stmt {
  sql: string;
  args: unknown[];
}

function kvWith(data: Record<string, unknown>) {
  return {
    async get(key: string, o?: string | { type?: string }) {
      const v = data[key];
      if (v === undefined) return null;
      const type = typeof o === "string" ? o : o?.type;
      return type === "json" ? v : JSON.stringify(v);
    },
    async put() {},
    async delete() {},
  } as unknown as KVNamespace;
}

/** A D1 that records every statement; `customer` answers the customers row read. */
function dbSpy(customer: Record<string, unknown> | null | "throw" = null) {
  const stmts: Stmt[] = [];
  const reads: string[] = [];
  const db = {
    prepare(sql: string) {
      const make = (args: unknown[]) => ({
        sql,
        args,
        bind: (...a: unknown[]) => make(a),
        first: async () => {
          reads.push(sql);
          if (customer === "throw") throw new Error("d1 down");
          return customer;
        },
        all: async () => {
          reads.push(sql);
          return { results: [] };
        },
        run: async () => {
          stmts.push({ sql, args });
          return { meta: {} };
        },
      });
      return make([]);
    },
    batch: async (list: Stmt[]) => {
      for (const s of list) stmts.push({ sql: s.sql, args: s.args });
      return [];
    },
  } as unknown as D1Database;
  return { db, stmts, reads };
}

/** The row as column to bound value, read from the statement's own column list. */
function rowOf(stmt: Stmt | undefined): Record<string, unknown> {
  if (!stmt) throw new Error("no event row");
  const cols = (/\(([^)]*)\)\s*VALUES/.exec(stmt.sql)?.[1] ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c !== "profile_id");
  expect(cols).toHaveLength(stmt.args.length);
  return Object.fromEntries(cols.map((c, i) => [c, stmt.args[i]]));
}

const BODIES: Record<string, Record<string, unknown>> = {
  variant_shown: {
    cohort: "personalized",
    intent_dim: "problem",
    source_dim: "ai",
    visit: VISIT,
  },
  personalization_skipped: {
    cohort: "skipped",
    intent_dim: "problem",
    source_dim: "ai",
    visit: VISIT,
  },
  no_signal_passthrough: { cohort: "no_signal", visit: VISIT },
  conversion: { cohort: "personalized", conversion_label: "signup", visit: VISIT },
  personalization_partial: { cohort: "personalized", paths: ["hero.headline"], visit: VISIT },
  snippet_issue: { properties: { issues: [{ c: "late_tag" }] } },
};

async function post(
  type: string,
  o: {
    cf?: unknown;
    bundle?: Record<string, unknown> | null;
    customer?: Record<string, unknown> | null | "throw";
    body?: Record<string, unknown>;
  } = {},
) {
  const spy = dbSpy(o.customer === undefined ? null : o.customer);
  const data: Record<string, unknown> =
    o.bundle === null ? {} : { [visitorBundleKey(ID)]: { v: 1, pages: {}, conv: [], ...o.bundle } };
  const req = new Request(`https://edge.test/event?cid=${ID}`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://example.com" },
    body: JSON.stringify({ event_type: type, page_path: "/", ...BODIES[type], ...o.body }),
  });
  if (o.cf !== undefined) Object.defineProperty(req, "cf", { value: o.cf });
  const waits: Promise<unknown>[] = [];
  const res = await worker.fetch(
    req,
    {
      VARIANTS: kvWith(data),
      DB: spy.db,
      ENVIRONMENT: "test",
      PREVIEW_TOKEN: "",
      EVENT_LIMITER: { limit: async () => ({ success: true }) },
    } as never,
    {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  );
  await Promise.all(waits);
  const rows = spy.stmts.filter((s) => s.sql.includes("INSERT INTO events")).map(rowOf);
  return {
    status: res.status,
    text: await res.text(),
    headers: [...res.headers],
    rows,
    reads: spy.reads,
  };
}

beforeEach(() => resetEventGuardForTests());

describe("countryOf and the closed list", () => {
  it("holds the 249 assigned ISO 3166-1 alpha-2 codes, each once, each a named region", () => {
    expect(ISO_COUNTRIES).toHaveLength(249);
    expect(new Set(ISO_COUNTRIES).size).toBe(249);
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (const c of ISO_COUNTRIES) {
      expect(c, c).toMatch(/^[A-Z]{2}$/);
      expect(names.of(c), c).not.toBe(c);
    }
  });

  it("keeps a listed code, upper-cases a lower one, and stores anything else as other", () => {
    expect(countryOf("AZ")).toBe("AZ");
    expect(countryOf("de")).toBe("DE");
    for (const v of [
      "XX",
      "T1",
      "XK",
      "EU",
      "",
      " ",
      "USA",
      "U",
      "Lisbon",
      "40.4,49.8",
      null,
      7,
      {},
    ]) {
      expect(countryOf(v), String(v)).toBe(OTHER_COUNTRY);
    }
  });
});

describe("/event writes the country", () => {
  it("on every stored type but snippet_issue, from cf.country", async () => {
    for (const type of Object.keys(BODIES)) {
      const { rows } = await post(type, {
        cf: { country: "GB", city: "London", region: "England" },
      });
      expect(rows, type).toHaveLength(1);
      expect(rows[0]?.country, type).toBe(type === "snippet_issue" ? null : "GB");
      // Nothing else of cf reaches the row.
      expect(JSON.stringify(rows[0]), type).not.toMatch(/London|England/);
    }
  });

  it("other for a code off the list, and for a request with no cf at all", async () => {
    expect((await post("variant_shown", { cf: { country: "T1" } })).rows[0]?.country).toBe("other");
    expect((await post("variant_shown", { cf: { country: "XX" } })).rows[0]?.country).toBe("other");
    expect((await post("variant_shown")).rows[0]?.country).toBe("other");
  });

  it("never from the body: a browser cannot set it", async () => {
    const { rows } = await post("conversion", {
      cf: { country: "DE" },
      body: { country: "US", cf: { country: "US" } },
    });
    expect(rows[0]?.country).toBe("DE");
  });

  it("nothing with the bundle's co, and the row is still written", async () => {
    const { rows } = await post("variant_shown", { cf: { country: "DE" }, bundle: { co: 1 } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.country).toBeNull();
  });

  it("no bundle: country_off from the customers row decides", async () => {
    const off = await post("variant_shown", {
      cf: { country: "DE" },
      bundle: null,
      customer: { sensitive: 0, special_category: 0, country_off: 1 },
    });
    expect(off.rows[0]?.country).toBeNull();
    const on = await post("variant_shown", {
      cf: { country: "DE" },
      bundle: null,
      customer: { sensitive: 0, special_category: 0, country_off: 0 },
    });
    expect(on.rows[0]?.country).toBe("DE");
  });

  it("nothing known (no bundle, the database down): no country, fail closed", async () => {
    const { rows } = await post("variant_shown", {
      cf: { country: "DE" },
      bundle: null,
      customer: "throw",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.country).toBeNull();
  });

  it("a sensitive customer's row keeps its group path and gets the country (ADR 0036)", async () => {
    const { rows } = await post("variant_shown", {
      cf: { country: "TR" },
      bundle: { s: 1, sk: ["/products"] },
      body: { page_path: "/products/ginseng" },
    });
    expect(rows[0]).toMatchObject({ page_path: "/products/:item", country: "TR" });
  });

  it("with a bundle, no database read: the switch rides in the bundle /event already reads", async () => {
    for (const bundle of [{}, { co: 1 }]) {
      const { rows, reads } = await post("variant_shown", { cf: { country: "AZ" }, bundle });
      expect(rows).toHaveLength(1);
      expect(reads).toEqual([]);
    }
  });

  it("the 202 is the same whatever the country and the switch", async () => {
    const plain = await post("variant_shown", { cf: { country: "AZ" } });
    for (const o of [{ cf: { country: "US" } }, { cf: { country: "AZ" }, bundle: { co: 1 } }]) {
      const other = await post("variant_shown", o);
      expect({ ...other, rows: [], reads: [] }).toEqual({ ...plain, rows: [], reads: [] });
    }
    expect(plain.status).toBe(202);
    expect(plain.text).toBe("");
  });
});
