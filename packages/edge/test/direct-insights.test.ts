/**
 * What direct is made of, at /event (ADR 0038, part 1;
 * docs/specs/direct-visitors.md §1).
 *
 * - every stored row but snippet_issue gets `device_class` (mobile, tablet,
 *   desktop, other) and `web_view` (0 or 1) from the request's own
 *   User-Agent and Sec-CH-UA, by the shared `deviceClassOf` and `webViewOf`;
 * - never from the body: a browser cannot set them; the User-Agent itself
 *   is in no column;
 * - nothing with the bundle's `dx`, nothing when neither the bundle nor the
 *   database could say (fail closed); `direct_insights_off` from the
 *   database when the bundle is missing; the country switch is separate;
 * - the 202 is the same whatever the device and the switch (the answers
 *   and the script are pinned byte identical with `dx` in sensitive.test.ts).
 */
import { DEVICE_CLASSES, deviceClassOf, visitorBundleKey, webViewOf } from "@rawuser/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { resetEventGuardForTests } from "../src/event.ts";
import worker from "../src/index.ts";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
/** WebKit on an iPhone without the Safari token: an app's in-app browser (the iOS heuristic). */
const IPHONE_APP =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_WV =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const INSTAGRAM =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0.0";

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
    ua?: string | null;
    chUa?: string;
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
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      origin: "https://example.com",
      ...(o.ua === null ? {} : { "user-agent": o.ua ?? IPHONE_SAFARI }),
      ...(o.chUa ? { "sec-ch-ua": o.chUa } : {}),
    },
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

describe("deviceClassOf and webViewOf", () => {
  it("one of four words, never anything else", () => {
    expect(DEVICE_CLASSES).toEqual(["mobile", "tablet", "desktop", "other"]);
    expect(deviceClassOf(IPHONE_SAFARI)).toBe("mobile");
    expect(deviceClassOf(ANDROID_WV)).toBe("mobile");
    expect(deviceClassOf(IPAD)).toBe("tablet");
    expect(deviceClassOf(MAC_CHROME)).toBe("desktop");
    expect(deviceClassOf("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe("other");
    expect(deviceClassOf(null)).toBe("other");
    expect(deviceClassOf("")).toBe("other");
  });

  it("the in-app bit: a named app, the wv token, the WebView brand, the iOS heuristic", () => {
    expect(webViewOf(INSTAGRAM)).toBe(1);
    expect(webViewOf(ANDROID_WV)).toBe(1);
    expect(webViewOf(IPHONE_APP)).toBe(1);
    expect(webViewOf(MAC_CHROME, '"Android WebView";v="131", "Chromium";v="131"')).toBe(1);
    expect(webViewOf(IPHONE_SAFARI)).toBe(0);
    expect(webViewOf(MAC_CHROME, '"Google Chrome";v="131", "Chromium";v="131"')).toBe(0);
    expect(webViewOf(null)).toBe(0);
  });
});

describe("/event writes the device word and the in-app bit", () => {
  it("on every stored type but snippet_issue, from the request's headers", async () => {
    for (const type of Object.keys(BODIES)) {
      const { rows } = await post(type, { ua: IPHONE_APP });
      expect(rows, type).toHaveLength(1);
      const lean = type === "snippet_issue";
      expect(rows[0]?.device_class, type).toBe(lean ? null : "mobile");
      expect(rows[0]?.web_view, type).toBe(lean ? null : 1);
      // The User-Agent itself is in no column.
      expect(JSON.stringify(rows[0]), type).not.toMatch(/Mozilla|iPhone|AppleWebKit/);
    }
  });

  it("each kind of browser", async () => {
    const cases: [string | null, string | undefined, string, number][] = [
      [IPHONE_SAFARI, undefined, "mobile", 0],
      [IPAD, undefined, "tablet", 0],
      [MAC_CHROME, undefined, "desktop", 0],
      [ANDROID_WV, undefined, "mobile", 1],
      [MAC_CHROME, '"Android WebView";v="131"', "desktop", 1],
      [null, undefined, "other", 0],
    ];
    for (const [ua, chUa, device, view] of cases) {
      const { rows } = await post("no_signal_passthrough", { ua, ...(chUa ? { chUa } : {}) });
      expect(rows[0]?.device_class, String(ua)).toBe(device);
      expect(rows[0]?.web_view, String(ua)).toBe(view);
    }
  });

  it("never from the body: a browser cannot set them", async () => {
    const { rows } = await post("conversion", {
      ua: MAC_CHROME,
      body: { device_class: "mobile", web_view: 1, device: "tablet" },
    });
    expect(rows[0]?.device_class).toBe("desktop");
    expect(rows[0]?.web_view).toBe(0);
  });

  it("nothing with the bundle's dx, the row and its country still written", async () => {
    const { rows } = await post("variant_shown", { cf: { country: "DE" }, bundle: { dx: 1 } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ device_class: null, web_view: null, country: "DE" });
  });

  it("the country switch leaves them on", async () => {
    const { rows } = await post("variant_shown", { cf: { country: "DE" }, bundle: { co: 1 } });
    expect(rows[0]).toMatchObject({ device_class: "mobile", web_view: 0, country: null });
  });

  it("no bundle: direct_insights_off from the customers row decides", async () => {
    const off = await post("variant_shown", {
      bundle: null,
      customer: { sensitive: 0, special_category: 0, country_off: 0, direct_insights_off: 1 },
    });
    expect(off.rows[0]).toMatchObject({ device_class: null, web_view: null });
    const on = await post("variant_shown", {
      bundle: null,
      customer: { sensitive: 0, special_category: 0, country_off: 0, direct_insights_off: 0 },
    });
    expect(on.rows[0]).toMatchObject({ device_class: "mobile", web_view: 0 });
  });

  it("nothing known (no bundle, the database down): neither, fail closed", async () => {
    const { rows } = await post("variant_shown", { bundle: null, customer: "throw" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ device_class: null, web_view: null });
  });

  it("with a bundle, no database read", async () => {
    for (const bundle of [{}, { dx: 1 }]) {
      const { rows, reads } = await post("variant_shown", { bundle });
      expect(rows).toHaveLength(1);
      expect(reads).toEqual([]);
    }
  });

  it("the 202 is the same whatever the device and the switch", async () => {
    const plain = await post("variant_shown", { ua: IPHONE_SAFARI });
    for (const o of [
      { ua: MAC_CHROME },
      { ua: IPHONE_APP },
      { ua: IPHONE_SAFARI, bundle: { dx: 1 } },
    ]) {
      const other = await post("variant_shown", o);
      expect({ ...other, rows: [], reads: [] }).toEqual({ ...plain, rows: [], reads: [] });
    }
    expect(plain.status).toBe(202);
    expect(plain.text).toBe("");
  });
});
