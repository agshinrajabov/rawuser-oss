/**
 * The free AI-traffic audit at the edge (docs/specs/ai-traffic-audit.md §3.4,
 * §4.2; privacy review conditions 1 and 2 of 2026-10-06):
 *
 * - an audit customer's /select answer, on its own host, is a pilot's answer
 *   plus `found_by`; another host, no Origin, `null`, or a time at or after
 *   `ae` gets the record-nothing answer on every path that leads to an
 *   event, with no KV read of its own and nothing written back;
 * - the learning counters run after the bundle and never for an audit or a
 *   deleted customer;
 * - /s/{id}.js carries `ad` and `ae`, and the off script after the end;
 * - /event drops an audit customer's row from another host or after the end,
 *   stores `found_by` only for an audit customer and only on the list.
 */

import { hideRulesKey, variantKeyForPath, visitorBundleKey } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_MEMO_MS, auditFieldsFor, originHost, refusedByAudit } from "../src/audit.ts";
import { resetEventGuardForTests } from "../src/event.ts";
import worker from "../src/index.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetEventGuardForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

const VARIANT = {
  customer_id: "x",
  profile_key: "intent:problem:ai",
  sections: { hero: { kind: "hero", headline: "New" } },
  generated_at: 1,
  prompt_hash: "h",
  body_id: "0123456789abcdef",
};
const MANIFEST = { "hero.headline": { css: ["h1"], text: ["Old"], structural: "first h1" } };
const CONV = [
  {
    section_path: "hero.cta",
    conversion_label: "signup",
    css: ["a.cta"],
    text: [],
    structural: "",
  },
];

function bundle(extra: Record<string, unknown> = {}) {
  return { v: 1, pages: { "/": MANIFEST }, conv: CONV, ...extra };
}
const AUDIT = { a: 1, ad: "example.com", ae: NOW + 7 * DAY };

function kvWith(data: Record<string, unknown>) {
  const gets: string[] = [];
  const puts: string[] = [];
  const kv = {
    async get(key: string, opts?: string | { type?: string }) {
      gets.push(key);
      const v = data[key];
      if (v === undefined) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "json" ? v : typeof v === "string" ? v : JSON.stringify(v);
    },
    async put(key: string) {
      puts.push(key);
    },
    async delete() {},
  } as unknown as KVNamespace;
  return { kv, gets, puts };
}

function dbSpy() {
  const sql: string[] = [];
  const rows: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare(q: string) {
      sql.push(q);
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => {
          args = a;
          return stmt;
        },
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => {
          rows.push({ sql: q, args });
          return { meta: {} };
        },
      };
      return stmt;
    },
    batch: async () => [],
  } as unknown as D1Database;
  return { db, sql, rows };
}

function ctxCollect() {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    ctx: {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  };
}

/** A customer's KV: its bundle and the problem:ai version on `/`. */
function store(id: string, b: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    [visitorBundleKey(id)]: b,
    [variantKeyForPath(id, "/", "problem", "ai")]: VARIANT,
    ...extra,
  };
}

const CHATGPT = "&utm_source=chatgpt.com&ref=https%3A%2F%2Fchatgpt.com";

async function select(
  data: Record<string, unknown>,
  id: string,
  opts: {
    query?: string;
    origin?: string | null;
    env?: Record<string, string>;
    ua?: string;
  } = {},
) {
  const { kv, gets, puts } = kvWith(data);
  const { db, sql } = dbSpy();
  const { ctx, waits } = ctxCollect();
  const headers: Record<string, string> = {
    "user-agent": opts.ua ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/129.0",
  };
  const origin = opts.origin === undefined ? "https://example.com" : opts.origin;
  if (origin !== null) headers.origin = origin;
  const res = await worker.fetch(
    new Request(
      `https://edge.test/select?customer_id=${id}&path=%2F&self_host=example.com${opts.query ?? ""}`,
      { headers },
    ),
    {
      VARIANTS: kv,
      DB: db,
      ENVIRONMENT: "test",
      PREVIEW_TOKEN: "",
      HOLDOUT_PERCENT: "0",
      ...opts.env,
    } as never,
    ctx,
  );
  await Promise.all(waits);
  return { body: (await res.json()) as Record<string, unknown>, gets, puts, sql };
}

const REFUSED = { source: "fallback-canonical-bot", variant_key: "", variant: null, off: 1 };

describe("/select for an audit customer on its own host", () => {
  it("answers as for a pilot, plus found_by, with the same KV reads", async () => {
    const pilot = await select(store("pilot-co", bundle()), "pilot-co", { query: CHATGPT });
    const audit = await select(store("audit-co", bundle(AUDIT)), "audit-co", { query: CHATGPT });
    expect(audit.body.found_by).toBe("auto_tag");
    const { found_by: _f, ...rest } = audit.body;
    const norm = (b: Record<string, unknown>) =>
      JSON.parse(JSON.stringify(b).replaceAll("pilot-co", "audit-co"));
    expect(rest).toEqual(norm(pilot.body));
    expect(pilot.body.cohort).toBe("personalized");
    expect(audit.gets.length).toBe(pilot.gets.length);
    expect(audit.puts).toEqual([]);
  });

  it("www and other subdomains of the audit domain pass", async () => {
    for (const origin of ["https://www.example.com", "https://shop.example.com:8443"]) {
      const r = await select(store("audit-co", bundle(AUDIT)), "audit-co", {
        query: CHATGPT,
        origin,
      });
      expect(r.body.cohort).toBe("personalized");
    }
  });

  it("the holdout still decides at the bundle's percent, the same arm as a pilot's", async () => {
    let held = 0;
    for (let i = 0; i < 16; i++) {
      const visit = `&visit=${i.toString(16).padStart(2, "0").repeat(16)}`;
      const p = await select(store("same", bundle({ h: 50 })), "same", {
        query: CHATGPT + visit,
      });
      const a = await select(store("same", bundle({ ...AUDIT, h: 50 })), "same", {
        query: CHATGPT + visit,
      });
      expect(a.body.arm).toBe(p.body.arm);
      expect(a.body.cohort).toBe(p.body.cohort);
      if (a.body.arm === "holdout") {
        held++;
        // The holdout answer is one of the rows the report reads the source from.
        expect(a.body.found_by).toBe("auto_tag");
      }
    }
    expect(held).toBeGreaterThan(0);
  });

  it("found_by follows §4.2 on this request's own signals", async () => {
    const cases: [string, string, string | undefined][] = [
      ["&utm_source=newsletter&utm_medium=email", "Mozilla/5.0 (Macintosh) Chrome/129.0", "tag"],
      ["&clk=fbclid", "Mozilla/5.0 (Macintosh) Chrome/129.0", "click_id"],
      [
        "&ref=https%3A%2F%2Fnews.ycombinator.com",
        "Mozilla/5.0 (Macintosh) Chrome/129.0",
        "referrer",
      ],
      [
        "&ref=android-app%3A%2F%2Fcom.linkedin.android",
        "Mozilla/5.0 (Linux; Android 14) Chrome/129.0 Mobile",
        "app_package",
      ],
      [
        "",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0",
        "app_marker",
      ],
    ];
    for (const [query, ua, word] of cases) {
      const data = { [visitorBundleKey("audit-co")]: bundle(AUDIT) } as Record<string, unknown>;
      for (const i of ["problem", "evaluation", "feature", "brand", "competitor", "pricing"]) {
        for (const s of ["ai", "social", "community", "paid", "organic", "direct"]) {
          data[variantKeyForPath("audit-co", "/", i, s)] = VARIANT;
        }
      }
      const r = await select(data, "audit-co", { query, ua });
      expect(r.body.cohort, query || ua).toBe("personalized");
      expect(r.body.found_by, query || ua).toBe(word);
    }
  });

  it("no found_by on a carried page or a path-only page", async () => {
    const data = {
      ...store("audit-co", bundle(AUDIT)),
      [variantKeyForPath("audit-co", "/", "pricing", "ai")]: VARIANT,
      [variantKeyForPath("audit-co", "/", "pricing", "direct")]: VARIANT,
    };
    const carried = await select(data, "audit-co", { query: "&carry=problem:ai" });
    expect(carried.body.cohort).toBe("personalized");
    expect(carried.body.carried).toBe(true);
    expect(carried.body).not.toHaveProperty("found_by");
  });

  it("a customer that is not under audit never gets found_by", async () => {
    const r = await select(store("pilot-co", bundle()), "pilot-co", { query: CHATGPT });
    expect(r.body.cohort).toBe("personalized");
    expect(r.body).not.toHaveProperty("found_by");
  });
});

describe("/select refuses an audit customer's request from another host or after the end", () => {
  const paths: [string, Record<string, unknown>, string][] = [
    ["no signal", {}, ""],
    ["carried", {}, "&carry=problem:ai"],
    ["personalised", {}, CHATGPT],
    ["holdout", { h: 50 }, `${CHATGPT}&visit=${"0".repeat(32)}`],
    ["language mismatch", { "v1:lang:audit-co": "az" }, `${CHATGPT}&plang=en`],
  ];

  for (const [label, extra, query] of paths) {
    it(`a copied tag on another host: the record-nothing answer (${label})`, async () => {
      const { h, ...kvExtra } = extra as { h?: number };
      const b = bundle({ ...AUDIT, ...(h ? { h } : {}) });
      for (const origin of [
        "https://copycat.test",
        "https://badexample.com",
        "https://example.com.evil.test",
        "null",
        null,
      ]) {
        const r = await select(store("audit-co", b, kvExtra), "audit-co", { query, origin });
        expect(r.body, `${label} ${origin}`).toEqual(REFUSED);
        expect(r.puts).toEqual([]);
        expect(r.sql).toEqual([]);
      }
    });

    it(`after the end: the record-nothing answer on its own host (${label})`, async () => {
      const { h, ...kvExtra } = extra as { h?: number };
      const b = bundle({ ...AUDIT, ae: NOW, ...(h ? { h } : {}) });
      const r = await select(store("audit-co", b, kvExtra), "audit-co", { query });
      expect(r.body).toEqual(REFUSED);
      expect(r.puts).toEqual([]);
      expect(r.sql).toEqual([]);
    });
  }

  it("not ready (no version yet): refused on another host, answered on its own", async () => {
    const data = { [visitorBundleKey("audit-co")]: bundle(AUDIT) };
    const own = await select(data, "audit-co", { query: CHATGPT });
    expect(own.body.not_ready).toBe(true);
    const copied = await select(data, "audit-co", { query: CHATGPT, origin: "https://x.test" });
    expect(copied.body).toEqual(REFUSED);
  });

  it("the page's own self_host claim does not open another host", async () => {
    const r = await select(store("audit-co", bundle(AUDIT)), "audit-co", {
      query: CHATGPT,
      origin: "https://copycat.test",
    });
    expect(r.body).toEqual(REFUSED);
  });

  it("an audit bundle without a domain refuses every host", async () => {
    const r = await select(store("audit-co", bundle({ a: 1 })), "audit-co", { query: CHATGPT });
    expect(r.body).toEqual(REFUSED);
  });

  it("the check reads no KV of its own: the same keys as a pilot", async () => {
    const pilot = await select(store("c", bundle()), "c", { query: CHATGPT });
    const refused = await select(store("c", bundle({ ...AUDIT, ae: NOW })), "c", {
      query: CHATGPT,
    });
    expect(refused.gets).toEqual(pilot.gets);
    const nsPilot = await select(store("c", bundle()), "c");
    const nsRefused = await select(store("c", bundle(AUDIT)), "c", { origin: "https://x.test" });
    expect(nsRefused.gets).toEqual(nsPilot.gets);
  });

  it("a pilot is never refused, whatever the Origin", async () => {
    const r = await select(store("pilot-co", bundle()), "pilot-co", {
      query: CHATGPT,
      origin: null,
    });
    expect(r.body.cohort).toBe("personalized");
  });
});

describe("the learning counters run after the bundle, never for an audit or a closed id", () => {
  const ON = { UA_TOKEN_LEARNING: "on", SOURCE_LEARNING: "on" };
  const counted = (sql: string[]) =>
    sql.filter((q) => q.includes("ua_token_counts") || q.includes("signal_token_counts"));
  const query = "&utm_source=partner-xyz";
  const ua =
    "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36 BrandNewApp/3.1";

  it("a pilot counts (control)", async () => {
    const r = await select(store("pilot-co", bundle()), "pilot-co", { query, ua, env: ON });
    expect(counted(r.sql).length).toBeGreaterThan(0);
    const ns = await select(store("pilot-co", bundle()), "pilot-co", { ua, env: ON });
    expect(counted(ns.sql).length).toBeGreaterThan(0);
  });

  it("an audit customer counts nothing, on its own host or another", async () => {
    for (const origin of ["https://example.com", "https://x.test"]) {
      for (const q of [query, ""]) {
        const r = await select(store("audit-co", bundle(AUDIT)), "audit-co", {
          query: q,
          ua,
          env: ON,
          origin,
        });
        expect(counted(r.sql)).toEqual([]);
      }
    }
  });

  it("a deleted customer counts nothing", async () => {
    for (const q of [query, ""]) {
      const r = await select({ "v1:closed:gone-co": "1" }, "gone-co", { query: q, ua, env: ON });
      expect(r.body.off).toBe(1);
      expect(counted(r.sql)).toEqual([]);
    }
  });
});

describe("/s/{id}.js for an audit customer", () => {
  async function script(data: Record<string, unknown>, id: string) {
    const { kv, gets } = kvWith(data);
    const res = await worker.fetch(
      new Request(`https://edge.test/s/${id}.js`),
      { VARIANTS: kv, DB: {} as D1Database, ENVIRONMENT: "test", PREVIEW_TOKEN: "" } as never,
      ctxCollect().ctx,
    );
    const text = await res.text();
    const cfg = JSON.parse(text.slice("window.__rw=".length, text.indexOf(";\n"))) as Record<
      string,
      unknown
    >;
    return { cfg, gets };
  }

  it("carries ad and ae with the hide rules, in the same batch", async () => {
    const { cfg, gets } = await script(
      {
        [visitorBundleKey("audit-co")]: bundle(AUDIT),
        [hideRulesKey("audit-co")]: JSON.stringify({ "/": ["h1"] }),
      },
      "audit-co",
    );
    expect(cfg).toMatchObject({
      c: "audit-co",
      ad: "example.com",
      ae: AUDIT.ae,
      h: { "/": ["h1"] },
    });
    expect(gets).toContain(visitorBundleKey("audit-co"));
  });

  it("an audit without a domain carries ad '' (matches no host)", async () => {
    const { cfg } = await script({ [visitorBundleKey("audit-co")]: bundle({ a: 1 }) }, "audit-co");
    expect(cfg.ad).toBe("");
    expect(cfg).not.toHaveProperty("ae");
  });

  it("after the end: the off script, no hide rules", async () => {
    const { cfg } = await script(
      {
        [visitorBundleKey("audit-co")]: bundle({ ...AUDIT, ae: NOW }),
        [hideRulesKey("audit-co")]: JSON.stringify({ "/": ["h1"] }),
      },
      "audit-co",
    );
    expect(cfg).toEqual({ c: "audit-co", e: "https://edge.test", off: 1 });
  });

  it("a pilot's script has no ad or ae", async () => {
    const { cfg } = await script({ [visitorBundleKey("p")]: bundle() }, "p");
    expect(cfg).not.toHaveProperty("ad");
    expect(cfg).not.toHaveProperty("ae");
    expect(cfg).not.toHaveProperty("off");
  });
});

describe("/event for an audit customer", () => {
  const VISIT = "0123456789abcdef0123456789abcdef";
  const SHOWN = {
    event_type: "variant_shown",
    page_path: "/",
    variant_key: "k",
    intent_dim: "problem",
    source_dim: "ai",
    cohort: "personalized",
    visit: VISIT,
    source_name: "chatgpt",
    found_by: "auto_tag",
  };

  async function post(
    data: Record<string, unknown>,
    id: string,
    body: Record<string, unknown>,
    origin: string | null = "https://example.com",
  ) {
    const { kv, gets } = kvWith(data);
    const { db, rows } = dbSpy();
    const { ctx, waits } = ctxCollect();
    const headers: Record<string, string> = { "content-type": "text/plain;charset=UTF-8" };
    if (origin !== null) headers.origin = origin;
    const res = await worker.fetch(
      new Request(`https://edge.test/event?cid=${id}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      {
        VARIANTS: kv,
        DB: db,
        ENVIRONMENT: "test",
        PREVIEW_TOKEN: "",
        EVENT_LIMITER: { limit: async () => ({ success: true }) },
      } as never,
      ctx,
    );
    expect(res.status).toBe(202);
    await Promise.all(waits);
    return { rows, gets };
  }
  const auditData = (id: string, extra: Record<string, unknown> = {}) => ({
    [visitorBundleKey(id)]: bundle({ ...AUDIT, ...extra }),
  });
  const foundOf = (row: { sql: string; args: unknown[] } | undefined) =>
    row?.sql.includes("found_by") ? row.args.at(-1) : undefined;

  it("stores an on-list found_by from its own host, beside source_name", async () => {
    const { rows } = await post(auditData("a1"), "a1", SHOWN);
    expect(rows).toHaveLength(1);
    expect(foundOf(rows[0])).toBe("auto_tag");
    expect(rows[0]?.args).toContain("chatgpt");
  });

  it("a conversion keeps it; a no-signal or issue row never has it", async () => {
    const conv = await post(auditData("a2"), "a2", {
      ...SHOWN,
      event_type: "conversion",
      conversion_label: "signup",
    });
    expect(foundOf(conv.rows[0])).toBe("auto_tag");
    const ns = await post(auditData("a3"), "a3", {
      event_type: "no_signal_passthrough",
      page_path: "/",
      cohort: "no_signal",
      found_by: "referrer",
    });
    expect(ns.rows).toHaveLength(1);
    expect(ns.rows[0]?.sql).not.toContain("found_by");
  });

  it("an off-list found_by is dropped and the row kept", async () => {
    for (const found_by of ["AUTO_TAG", "chatgpt.com", "ua", 1, "", null]) {
      const { rows } = await post(auditData(`a-${String(found_by)}`), `a-${String(found_by)}`, {
        ...SHOWN,
        found_by,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.sql).not.toContain("found_by");
    }
  });

  it("a copied tag on another host writes nothing", async () => {
    for (const origin of ["https://copycat.test", "https://badexample.com", "null", null]) {
      const { rows } = await post(auditData("a4"), "a4", SHOWN, origin);
      expect(rows, String(origin)).toEqual([]);
    }
    // The issue rows too.
    const issue = await post(
      auditData("a5"),
      "a5",
      { event_type: "snippet_issue", page_path: "/", properties: { issues: [{ c: "late_tag" }] } },
      "https://copycat.test",
    );
    expect(issue.rows).toEqual([]);
  });

  it("an ended audit writes nothing, on its own host", async () => {
    const { rows } = await post(auditData("a6", { ae: NOW }), "a6", SHOWN);
    expect(rows).toEqual([]);
  });

  it("a pilot's row never names found_by, whatever the body or Origin", async () => {
    const { rows } = await post({ [visitorBundleKey("p1")]: bundle() }, "p1", SHOWN, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sql).not.toContain("found_by");
    expect(rows[0]?.args).toContain("chatgpt");
  });

  it("a text/plain conversion (the snippet's keepalive fetch) lands with its real Origin", async () => {
    // Under a no-referrer or same-origin policy a CORS fetch still carries the
    // page's Origin; only a no-cors beacon would have sent "null" (dropped).
    const conv = { ...SHOWN, event_type: "conversion", conversion_label: "signup" };
    const audit = await post(auditData("a7"), "a7", conv, "https://www.example.com");
    expect(audit.rows).toHaveLength(1);
    expect(foundOf(audit.rows[0])).toBe("auto_tag");
    const beaconLike = await post(auditData("a8"), "a8", conv, "null");
    expect(beaconLike.rows).toEqual([]);
    for (const origin of ["https://pilot.test", "null", null]) {
      const pilot = await post({ [visitorBundleKey("p2")]: bundle() }, "p2", conv, origin);
      expect(pilot.rows, String(origin)).toHaveLength(1);
    }
  });

  it("reads the bundle once per customer per isolate, then from memory", async () => {
    const data = auditData("memo");
    const { kv, gets } = kvWith(data);
    expect(await auditFieldsFor(kv, "memo", NOW)).toEqual(AUDIT);
    expect(await auditFieldsFor(kv, "memo", NOW + AUDIT_MEMO_MS - 1)).toEqual(AUDIT);
    expect(gets).toEqual([visitorBundleKey("memo")]);
    await auditFieldsFor(kv, "memo", NOW + AUDIT_MEMO_MS + 1);
    expect(gets).toHaveLength(2);
  });
});

describe("the Origin host", () => {
  it("reads only a real origin", () => {
    expect(originHost("https://Example.com:8443")).toBe("example.com");
    expect(originHost("null")).toBeNull();
    expect(originHost(null)).toBeNull();
    expect(originHost("not a url")).toBeNull();
  });

  it("refusedByAudit says why, and never for a customer not under audit", () => {
    const req = (origin?: string) =>
      new Request("https://edge.test/", origin ? { headers: { origin } } : {});
    expect(refusedByAudit(null, req())).toBeNull();
    expect(refusedByAudit({ a: 1, ad: "example.com" }, req("https://example.com"))).toBeNull();
    expect(refusedByAudit({ a: 1, ad: "example.com" }, req("https://x.test"))).toBe("host");
    expect(refusedByAudit({ a: 1, ad: "example.com" }, req())).toBe("host");
    expect(
      refusedByAudit({ a: 1, ad: "example.com", ae: NOW }, req("https://example.com"), NOW),
    ).toBe("ended");
  });
});
