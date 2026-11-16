/**
 * Edge integration tests for /event — V2 Module 3.
 *
 * The handler always returns 202 (privacy + uniform debug surface). Tests
 * assert behavior via the D1 INSERT (recorded by mockDb), the fake rate-limit
 * binding (recorded calls) and the KV spy, which must stay silent on /event.
 */

import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_LIMIT_PER_MINUTE, resetEventGuardForTests } from "../src/event.ts";
import worker from "../src/index.ts";

beforeEach(() => {
  resetEventGuardForTests();
});

interface KvOp {
  op: "get" | "put";
  key: string;
  value?: string;
}

interface DbOp {
  sql: string;
  args: unknown[];
}

function makeKvWithCounter(
  initialCounters: Record<string, string> = {},
  ops: KvOp[] = [],
): KVNamespace {
  const store = new Map(Object.entries(initialCounters));
  return {
    async get(key: string) {
      ops.push({ op: "get", key });
      // Every customer here has a visitor bundle, as a customer with a tag
      // does: /event reads the audit and the sensitive flag from it. The
      // event without one is test/sensitive.test.ts's (the D1 read decides).
      if (key.startsWith("v1:vm:") && !store.has(key)) return { v: 1, pages: {}, conv: [] };
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      ops.push({ op: "put", key, value });
      store.set(key, value);
    },
    async delete() {},
    async list() {
      return { keys: [], list_complete: true, cursor: "" };
    },
    async getWithMetadata() {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace;
}

function makeDb(ops: DbOp[]): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              ops.push({ sql, args });
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

/** What the fake limiter does: allow, refuse, or throw. */
type LimiterMode = "allow" | "deny" | "throw";

function makeLimiter(mode: LimiterMode, keys: string[]): RateLimit {
  return {
    async limit({ key }: RateLimitOptions) {
      keys.push(key);
      if (mode === "throw") throw new Error("binding down");
      return { success: mode === "allow" };
    },
  } as RateLimit;
}

interface MockEnv {
  VARIANTS: KVNamespace;
  DB: D1Database;
  ENVIRONMENT: string;
  PREVIEW_TOKEN: string;
  EVENT_LIMITER?: RateLimit;
}

function makeEnv(
  initialCounters: Record<string, string> = {},
  limiter: LimiterMode | "missing" = "allow",
): {
  env: MockEnv;
  kvOps: KvOp[];
  dbOps: DbOp[];
  limiterKeys: string[];
} {
  const kvOps: KvOp[] = [];
  const dbOps: DbOp[] = [];
  const limiterKeys: string[] = [];
  return {
    env: {
      VARIANTS: makeKvWithCounter(initialCounters, kvOps),
      DB: makeDb(dbOps),
      ENVIRONMENT: "test",
      PREVIEW_TOKEN: "ignored-on-event",
      ...(limiter === "missing" ? {} : { EVENT_LIMITER: makeLimiter(limiter, limiterKeys) }),
    },
    kvOps,
    dbOps,
    limiterKeys,
  };
}

function makeCtx(): { ctx: ExecutionContext; waits: Promise<unknown>[] } {
  const waits: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) {
        waits.push(p);
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext,
    waits,
  };
}

function postEvent(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("/event — basic shape", () => {
  it("POST with valid variant_shown body writes one D1 INSERT and returns 202", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "variant_shown",
      page_path: "/pricing",
      variant_key: "competitor:ai",
      intent_dim: "competitor",
      source_dim: "ai",
    });

    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(202);

    await Promise.all(waits);

    const inserts = dbOps.filter((o) => o.sql.startsWith("INSERT INTO events"));
    expect(inserts).toHaveLength(1);
    const args = inserts[0]?.args ?? [];
    // Positional: id, customer_id, ts, event_type, variant_key, intent_dim, source_dim, page_path, conversion_label
    expect(args[1]).toBe("acme");
    expect(args[3]).toBe("variant_shown");
    expect(args[4]).toBe("competitor:ai");
    expect(args[5]).toBe("competitor");
    expect(args[6]).toBe("ai");
    expect(args[7]).toBe("/pricing");
    expect(args[8]).toBeNull();
  });

  it("OPTIONS returns 204 with CORS allow headers", async () => {
    const { env } = makeEnv();
    const { ctx } = makeCtx();
    const req = new Request("https://rawuser.test/event?cid=acme", { method: "OPTIONS" });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    expect(resp.headers.get("access-control-allow-methods")).toContain("POST");
    expect(resp.headers.get("access-control-allow-headers")).toContain("content-type");
  });

  it("GET on /event returns 202 (does not 405 — no method discovery)", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx } = makeCtx();
    const req = new Request("https://rawuser.test/event?cid=acme", { method: "GET" });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(202);
    expect(dbOps).toHaveLength(0);
  });
});

describe("/event — V2 Fix Pass A: personalization_skipped event type", () => {
  it("accepts event_type: 'personalization_skipped' with same payload as variant_shown", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "personalization_skipped",
      page_path: "/pricing",
      variant_key: "v1:variant:acme:pricing:default",
      intent_dim: "pricing",
      source_dim: "direct",
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(202);
    await Promise.all(waits);
    const inserts = dbOps.filter((o) => o.sql.startsWith("INSERT INTO events"));
    expect(inserts).toHaveLength(1);
    const skippedArgs = inserts[0]?.args ?? [];
    expect(skippedArgs[3]).toBe("personalization_skipped");
    expect(skippedArgs[4]).toBe("v1:variant:acme:pricing:default");
    expect(skippedArgs[5]).toBe("pricing");
    expect(skippedArgs[6]).toBe("direct");
    expect(skippedArgs[7]).toBe("/pricing");
  });
});

describe("/event — validation and silent rejection", () => {
  it("missing cid query → 202, no D1 write", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event", {
      event_type: "variant_shown",
      page_path: "/",
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(202);
    await Promise.all(waits);
    expect(dbOps).toHaveLength(0);
  });

  it("unknown event_type → 202, no write, malformed counter incremented", async () => {
    const { env, dbOps, kvOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "scroll_milestone",
      page_path: "/",
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(202);
    await Promise.all(waits);
    expect(dbOps).toHaveLength(0);
    // Malformed is counted in memory for the guard log line, never in KV.
    expect(kvOps).toHaveLength(0);
  });

  it("invalid JSON body → 202, no write, malformed counter incremented", async () => {
    const { env, dbOps, kvOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", "not-json{");
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(202);
    await Promise.all(waits);
    expect(dbOps).toHaveLength(0);
    // Malformed is counted in memory for the guard log line, never in KV.
    expect(kvOps).toHaveLength(0);
  });

  it("conversion event without conversion_label → 202, no write", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "conversion",
      page_path: "/",
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(202);
    await Promise.all(waits);
    expect(dbOps).toHaveLength(0);
  });

  it("unknown conversion_label → 202, no write", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "conversion",
      page_path: "/",
      conversion_label: "definitely_not_an_enum_value",
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(202);
    await Promise.all(waits);
    expect(dbOps).toHaveLength(0);
  });

  it("conversion event with valid conversion_label is written", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "conversion",
      page_path: "/pricing",
      variant_key: "pricing:organic",
      intent_dim: "pricing",
      source_dim: "organic",
      conversion_label: "signup",
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(202);
    await Promise.all(waits);
    const inserts = dbOps.filter((o) => o.sql.startsWith("INSERT INTO events"));
    expect(inserts).toHaveLength(1);
    const convArgs = inserts[0]?.args ?? [];
    expect(convArgs[3]).toBe("conversion");
    expect(convArgs[8]).toBe("signup");
  });
});

describe("/event — privacy: server stamps id and ts, page_path sanitization", () => {
  it("page_path with query string is stripped before INSERT", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "variant_shown",
      page_path: "/pricing?utm_source=secret&token=abcd",
    });
    await worker.fetch(req, env, ctx);
    await Promise.all(waits);
    expect((dbOps[0]?.args ?? [])[7]).toBe("/pricing");
  });

  it("page_path with hash is stripped before INSERT", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "no_signal_passthrough",
      page_path: "/blog/post#section-3",
    });
    await worker.fetch(req, env, ctx);
    await Promise.all(waits);
    expect((dbOps[0]?.args ?? [])[7]).toBe("/blog/post");
  });

  it("server stamps id (UUID prefix evt_) and ts (recent epoch ms) — client cannot influence", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const before = Date.now();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "variant_shown",
      page_path: "/",
      // attacker-attempted fields ignored
      id: "evt_attacker",
      ts: 0,
    } as unknown as Record<string, unknown>);
    await worker.fetch(req, env, ctx);
    await Promise.all(waits);
    const after = Date.now();
    const id = (dbOps[0]?.args ?? [])[0] as string;
    const ts = (dbOps[0]?.args ?? [])[2] as number;
    expect(id.startsWith("evt_")).toBe(true);
    expect(id).not.toBe("evt_attacker");
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("absurdly long page_path is cut to whole segments under 512 chars", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const longPath = "/section".repeat(125); // 1000 characters
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "variant_shown",
      page_path: longPath,
    });
    await worker.fetch(req, env, ctx);
    await Promise.all(waits);
    const stored = (dbOps[0]?.args ?? [])[7] as string;
    expect(stored.length).toBeLessThanOrEqual(512);
    expect(stored).toBe("/section".repeat(64));
  });

  it("one long segment with no slash after it stores the root", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    await worker.fetch(
      postEvent("https://rawuser.test/event?cid=acme", {
        event_type: "variant_shown",
        page_path: `/${"x".repeat(1000)}`,
      }),
      env,
      ctx,
    );
    await Promise.all(waits);
    expect((dbOps[0]?.args ?? [])[7]).toBe("/");
  });
});

describe("/event: identifiers in page_path are masked (docs/specs/event-paths.md)", () => {
  async function stored(page_path: string, event_type = "no_signal_passthrough") {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    await worker.fetch(
      postEvent("https://rawuser.test/event?cid=acme", {
        event_type,
        page_path,
        ...(event_type === "snippet_issue"
          ? { properties: { issues: [{ c: "apply_error" }] } }
          : {}),
        ...(event_type === "conversion" ? { conversion_label: "signup" } : {}),
      }),
      env,
      ctx,
    );
    await Promise.all(waits);
    expect(dbOps).toHaveLength(1);
    return (dbOps[0]?.args ?? [])[7];
  }

  it("a UUID segment is stored as :id", async () => {
    expect(await stored("/admin/students/550e8400-e29b-41d4-a716-446655440000")).toBe(
      "/admin/students/:id",
    );
  });

  it("every event type is masked, snippet_issue and conversion included", async () => {
    for (const type of [
      "variant_shown",
      "no_signal_passthrough",
      "personalization_skipped",
      "personalization_partial",
      "conversion",
      "snippet_issue",
    ]) {
      expect(await stored("/agreement/48213377/sign", type), type).toBe("/agreement/:id/sign");
    }
  });

  it("an email, a token and a query are all gone", async () => {
    expect(await stored("/u/jane%40acme.com?ref=x")).toBe("/u/:id");
    expect(await stored("/certificate/verify/4f9Kq2xZ8mN1pR7tB3vW#top")).toBe(
      "/certificate/verify/:id",
    );
  });

  it("all-digit segments and mixed-case tokens are masked (§8, conditions 1 and 2)", async () => {
    expect(await stored("/students/482")).toBe("/students/:id");
    expect(await stored("/blog/2024/10")).toBe("/blog/:id/:id");
    expect(await stored("/invite/aBcDeFgHiJkLmNoPqRsTuV")).toBe("/invite/:id");
    expect(await stored("/blog/what-we-learned")).toBe("/blog/what-we-learned");
  });

  it("ordinary paths are stored as sent", async () => {
    for (const p of ["/", "/pricing", "/az/approach", "/blog/post", "/v2/start", "/Pricing/"]) {
      expect(await stored(p), p).toBe(p);
    }
  });

  it("an identifier that straddles the length cut is dropped, never stored in half", async () => {
    const head = "/section".repeat(63); // 504 characters
    const got = await stored(`${head}/550e8400-e29b-41d4-a716-446655440000`);
    expect(got).toBe(head);
    expect(String(got)).not.toMatch(/550e/);
  });
});

describe("/event: guard on the rate-limit binding (event-capacity A)", () => {
  const valid = { event_type: "variant_shown", page_path: "/" };

  it("under the limit: the row is written, the limiter is keyed on the customer id", async () => {
    const { env, dbOps, limiterKeys } = makeEnv();
    const { ctx, waits } = makeCtx();
    const resp = await worker.fetch(
      postEvent("https://rawuser.test/event?cid=acme", valid),
      env,
      ctx,
    );
    expect(resp.status).toBe(202);
    await Promise.all(waits);
    expect(dbOps).toHaveLength(1);
    expect(limiterKeys).toEqual(["acme"]);
  });

  it("over the limit: 202 as before, no row written", async () => {
    const { env, dbOps } = makeEnv({}, "deny");
    const { ctx, waits } = makeCtx();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resp = await worker.fetch(
      postEvent("https://rawuser.test/event?cid=acme", valid),
      env,
      ctx,
    );
    expect(resp.status).toBe(202);
    expect(resp.body).toBeNull();
    await Promise.all(waits);
    expect(dbOps).toHaveLength(0);
    warn.mockRestore();
  });

  it("a limiter that throws fails open: the row is written", async () => {
    const { env, dbOps } = makeEnv({}, "throw");
    const { ctx, waits } = makeCtx();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await worker.fetch(postEvent("https://rawuser.test/event?cid=acme", valid), env, ctx);
    await Promise.all(waits);
    expect(dbOps).toHaveLength(1);
    expect(err).toHaveBeenCalledWith("[rawuser/edge] event guard failed (non-critical)");
    err.mockRestore();
  });

  it("a missing binding fails open: the row is written", async () => {
    const { env, dbOps } = makeEnv({}, "missing");
    const { ctx, waits } = makeCtx();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await worker.fetch(postEvent("https://rawuser.test/event?cid=acme", valid), env, ctx);
    await Promise.all(waits);
    expect(dbOps).toHaveLength(1);
    err.mockRestore();
  });

  it("no KV write on an event; one tombstone and one bundle read per customer per isolate, then memory", async () => {
    for (const mode of ["allow", "deny"] as const) {
      const { env, kvOps } = makeEnv({}, mode);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      for (let i = 0; i < 3; i++) {
        const { ctx, waits } = makeCtx();
        await worker.fetch(postEvent("https://rawuser.test/event?cid=acme", valid), env, ctx);
        await Promise.all(waits);
      }
      expect(kvOps.filter((o) => o.op === "put")).toHaveLength(0);
      // The bundle says whether the customer is under audit (audit.ts).
      expect(kvOps).toEqual([
        { op: "get", key: "v1:closed:acme" },
        { op: "get", key: "v1:vm:acme" },
      ]);
      warn.mockRestore();
    }
  });

  it("drops every row of a deleted customer (tombstone), and writes an open one's", async () => {
    const { env, dbOps } = makeEnv({ "v1:closed:gone-co": "1" });
    for (const cid of ["gone-co", "acme"]) {
      const { ctx, waits } = makeCtx();
      const resp = await worker.fetch(
        postEvent(`https://rawuser.test/event?cid=${cid}`, valid),
        env,
        ctx,
      );
      expect(resp.status).toBe(202);
      await Promise.all(waits);
    }
    expect(dbOps).toHaveLength(1);
    expect(JSON.stringify(dbOps[0])).toContain("acme");
    expect(JSON.stringify(dbOps)).not.toContain("gone-co");
  });

  it("malformed: no row, no KV, no limiter call, counted in the guard line", async () => {
    const { env, dbOps, kvOps, limiterKeys } = makeEnv();
    const { ctx, waits } = makeCtx();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resp = await worker.fetch(
      postEvent("https://rawuser.test/event?cid=acme", "not-json{"),
      env,
      ctx,
    );
    expect(resp.status).toBe(202);
    await Promise.all(waits);
    expect(dbOps).toHaveLength(0);
    expect(kvOps).toHaveLength(0);
    expect(limiterKeys).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "[rawuser/edge] event guard dropped 0, malformed 1 (non-critical)",
    );
    warn.mockRestore();
  });

  it("drops are logged at most once a minute per isolate, with counts and no customer id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const now = vi.spyOn(Date, "now");
    let t = 1_000_000;
    now.mockImplementation(() => t);
    const send = async (cid: string): Promise<void> => {
      const { env } = makeEnv({}, "deny");
      const { ctx, waits } = makeCtx();
      await worker.fetch(postEvent(`https://rawuser.test/event?cid=${cid}`, valid), env, ctx);
      await Promise.all(waits);
    };

    await send("acme");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith(
      "[rawuser/edge] event guard dropped 1, malformed 0 (non-critical)",
    );

    t += 10_000;
    await send("acme");
    await send("globex");
    expect(warn).toHaveBeenCalledTimes(1);

    t += 50_000;
    await send("acme");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      "[rawuser/edge] event guard dropped 3, malformed 0 (non-critical)",
    );
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toMatch(/acme|globex/);
    }
    now.mockRestore();
    warn.mockRestore();
  });

  it("wrangler.toml declares the binding in both sections at EVENT_LIMIT_PER_MINUTE per 60 s", () => {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const blocks = [
      ...toml.matchAll(
        /\[\[(ratelimits|env\.production\.ratelimits)\]\]\s*\nname = "EVENT_LIMITER"\s*\nnamespace_id = "(\d+)"\s*\nsimple = \{ limit = (\d+), period = (\d+) \}/g,
      ),
    ];
    expect(blocks.map((m) => m[1])).toEqual(["ratelimits", "env.production.ratelimits"]);
    for (const m of blocks) {
      expect(Number(m[3])).toBe(EVENT_LIMIT_PER_MINUTE);
      expect(Number(m[4])).toBe(60);
    }
    expect(blocks[0]?.[2]).not.toBe(blocks[1]?.[2]);
  });
});

// -----------------------------------------------------------------------
// Cohort field — Batch C holdout A/B (ADR 0022)
// -----------------------------------------------------------------------

describe("/event — cohort field validation (Batch C)", () => {
  it("accepts cohort='personalized' and writes it to D1", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "variant_shown",
      page_path: "/pricing",
      variant_key: "v1:variant:acme:competitor:ai",
      intent_dim: "competitor",
      source_dim: "ai",
      cohort: "personalized",
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(202);
    await Promise.all(waits);
    const inserts = dbOps.filter((o) => o.sql.startsWith("INSERT INTO events"));
    expect(inserts).toHaveLength(1);
    // cohort is positional arg index 12 (after conversion_label at 8,
    // country at 9, ADR 0036, device_class at 10 and web_view at 11, ADR 0038).
    expect((inserts[0]?.args ?? [])[12]).toBe("personalized");
  });

  it("accepts cohort='holdout' and writes it to D1", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "variant_shown",
      page_path: "/",
      variant_key: "",
      intent_dim: "problem",
      source_dim: "ai",
      cohort: "holdout",
    });
    await worker.fetch(req, env, ctx);
    await Promise.all(waits);
    const inserts = dbOps.filter((o) => o.sql.startsWith("INSERT INTO events"));
    expect(inserts).toHaveLength(1);
    expect((inserts[0]?.args ?? [])[12]).toBe("holdout");
  });

  it("accepts cohort='skipped' paired with personalization_skipped event_type", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "personalization_skipped",
      page_path: "/features",
      variant_key: "v1:variant:acme:feature:organic",
      intent_dim: "feature",
      source_dim: "organic",
      cohort: "skipped",
    });
    await worker.fetch(req, env, ctx);
    await Promise.all(waits);
    const inserts = dbOps.filter((o) => o.sql.startsWith("INSERT INTO events"));
    expect(inserts).toHaveLength(1);
    expect((inserts[0]?.args ?? [])[3]).toBe("personalization_skipped");
    expect((inserts[0]?.args ?? [])[12]).toBe("skipped");
  });

  it("accepts cohort='no_signal' paired with no_signal_passthrough event_type", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "no_signal_passthrough",
      page_path: "/",
      cohort: "no_signal",
    });
    await worker.fetch(req, env, ctx);
    await Promise.all(waits);
    const inserts = dbOps.filter((o) => o.sql.startsWith("INSERT INTO events"));
    expect(inserts).toHaveLength(1);
    expect((inserts[0]?.args ?? [])[12]).toBe("no_signal");
  });

  it("unknown cohort value rejects the event (202, no write, malformed counter)", async () => {
    const { env, dbOps, kvOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "variant_shown",
      page_path: "/",
      cohort: "totally_invalid_cohort",
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(202);
    await Promise.all(waits);
    expect(dbOps).toHaveLength(0);
    // Malformed is counted in memory for the guard log line, never in KV.
    expect(kvOps).toHaveLength(0);
  });

  it("omitting cohort is valid (backward-compat with pre-Batch-C snippets)", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const req = postEvent("https://rawuser.test/event?cid=acme", {
      event_type: "variant_shown",
      page_path: "/pricing",
      variant_key: "v1:variant:acme:pricing:direct",
      intent_dim: "pricing",
      source_dim: "direct",
    });
    await worker.fetch(req, env, ctx);
    await Promise.all(waits);
    const inserts = dbOps.filter((o) => o.sql.startsWith("INSERT INTO events"));
    expect(inserts).toHaveLength(1);
    // cohort arg should be null when not provided.
    expect((inserts[0]?.args ?? [])[12]).toBeNull();
  });
});

describe("/event — L2 Layer D dark_social flag", () => {
  it("stores dark_social = 1 on a no_signal_passthrough that carries it", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const resp = await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        event_type: "no_signal_passthrough",
        page_path: "/",
        cohort: "no_signal",
        dark_social: 1,
      }),
      env as never,
      ctx,
    );
    expect(resp.status).toBe(202);
    await Promise.all(waits);
    expect(dbOps).toHaveLength(1);
    expect(dbOps[0]?.sql).toContain("dark_social");
    // Column order ends with (..., dark_social, language_mismatch, carried, visit, properties, arm, body_id, source_name, tagged).
    expect(dbOps[0]?.args.at(-9)).toBe(1);
  });

  it("ignores dark_social on other event types and rejects non-flag values", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        event_type: "variant_shown",
        page_path: "/",
        variant_key: "k",
        cohort: "personalized",
        dark_social: 1,
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    expect(dbOps[0]?.args.at(-8)).toBe(0);

    const { env: env2, dbOps: ops2 } = makeEnv();
    const { ctx: ctx2, waits: w2 } = makeCtx();
    await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        event_type: "no_signal_passthrough",
        page_path: "/",
        cohort: "no_signal",
        dark_social: "yes",
      }),
      env2 as never,
      ctx2,
    );
    await Promise.all(w2);
    expect(ops2).toHaveLength(0);
  });
});

describe("/event — language_mismatch flag", () => {
  it("stores language_mismatch = 1 on a no_signal_passthrough that carries it", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        event_type: "no_signal_passthrough",
        page_path: "/",
        cohort: "no_signal",
        language_mismatch: 1,
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    expect(dbOps[0]?.sql).toContain("language_mismatch");
    // Column order ends with (..., dark_social, language_mismatch, carried, visit, properties, arm, body_id, source_name, tagged).
    expect(dbOps[0]?.args.at(-8)).toBe(1);
    expect(dbOps[0]?.args.at(-9)).toBe(0);
  });
});

describe("/event — carried flag", () => {
  it("stores carried = 1 on a variant_shown that carries it", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        event_type: "variant_shown",
        page_path: "/az",
        variant_key: "v1:variant:acme:brand:social",
        intent_dim: "brand",
        source_dim: "social",
        cohort: "personalized",
        carried: 1,
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    expect(dbOps[0]?.sql).toContain("carried");
    expect(dbOps[0]?.args.at(-7)).toBe(1);
  });

  it("never marks a no_signal_passthrough as carried", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        event_type: "no_signal_passthrough",
        page_path: "/",
        cohort: "no_signal",
        carried: 1,
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    expect(dbOps[0]?.args.at(-7)).toBe(0);
  });
});

describe("/event — visit marker (docs/specs/visit-marker.md)", () => {
  it("stores a well-formed marker as the last bound value", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const visit = "0123456789abcdef0123456789abcdef";
    await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        event_type: "variant_shown",
        page_path: "/",
        variant_key: "v1:variant:acme:brand:social",
        cohort: "personalized",
        visit,
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    expect(dbOps[0]?.sql).toContain("visit");
    expect(dbOps[0]?.args.at(-6)).toBe(visit);
  });

  it("drops a malformed marker and still writes the row", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    for (const bad of ["ABCDEF", "0123456789abcdef0123456789abcdeg", 12345, "x".repeat(32)]) {
      await worker.fetch(
        postEvent("https://edge.test/event?cid=acme", {
          event_type: "no_signal_passthrough",
          page_path: "/",
          cohort: "no_signal",
          visit: bad,
        }),
        env as never,
        ctx,
      );
    }
    await Promise.all(waits);
    expect(dbOps.length).toBe(4);
    for (const op of dbOps) expect(op.args.at(-6)).toBeNull();
  });
});

describe("/event — personalization_partial (design-preserving-rewrite §3)", () => {
  it("stores the slot list as properties JSON, filtered to slot paths", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        event_type: "personalization_partial",
        page_path: "/az",
        variant_key: "v1:variant:acme:brand:social",
        cohort: "personalized",
        paths: ["hero.headline", "features.body", "<script>", 42, "x".repeat(200)],
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    expect(dbOps.length).toBe(1);
    expect(dbOps[0]?.sql).toContain("properties");
    expect(JSON.parse(String(dbOps[0]?.args.at(-5)))).toEqual({
      paths: ["hero.headline", "features.body"],
    });
  });

  it("other event types carry null properties", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        event_type: "variant_shown",
        page_path: "/",
        variant_key: "v1:variant:acme:brand:social",
        cohort: "personalized",
        paths: ["hero.headline"],
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    expect(dbOps[0]?.args.at(-5)).toBeNull();
  });
});

describe("/event — body carry (docs/specs/interactive-text.md §3.1 b, condition 5)", () => {
  it("records body_carry in properties on a variant_shown, nothing else", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        event_type: "variant_shown",
        page_path: "/pricing",
        variant_key: "v1:variant:acme:brand:social",
        intent_dim: "brand",
        source_dim: "social",
        cohort: "personalized",
        body_carry: 1,
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    expect(dbOps[0]?.args.at(-5)).toBe(JSON.stringify({ body_carry: 1 }));
  });

  it("refuses a body_carry that is not 0 or 1", async () => {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const res = await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        event_type: "variant_shown",
        page_path: "/",
        cohort: "personalized",
        body_carry: "/pricing,/about",
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    // Beacon semantics: a malformed event is answered and never written.
    expect(res.status).toBe(202);
    expect(dbOps).toHaveLength(0);
  });
});

describe("/event — why a page was skipped (docs/specs/interactive-text.md §5)", () => {
  async function skipped(kind: unknown, event_type = "personalization_skipped") {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        event_type,
        page_path: "/",
        cohort: event_type === "personalization_skipped" ? "skipped" : "personalized",
        kind,
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    return dbOps[0]?.args.at(-5);
  }

  it("records a known kind on a skip", async () => {
    expect(await skipped("lines")).toBe(JSON.stringify({ kind: "lines" }));
    expect(await skipped("template-mismatch")).toBe(JSON.stringify({ kind: "template-mismatch" }));
  });

  it("records `late`, the answer that came after the reveal cap (quiet-swap, Late answers)", async () => {
    expect(await skipped("late")).toBe(JSON.stringify({ kind: "late" }));
    // Still one fixed word: a timing next to it, or a variation of it, is not kept.
    expect(await skipped("late:1177")).toBeNull();
    expect(await skipped("LATE")).toBeNull();
    expect(await skipped("late", "variant_shown")).toBeNull();
  });

  it("drops an unknown kind, and a kind on any other event", async () => {
    expect(await skipped("anything the browser says")).toBeNull();
    expect(await skipped("lines", "variant_shown")).toBeNull();
  });
});

describe("/event — the skip kind stays one fixed word (privacy review condition 1)", () => {
  it("stores exactly {kind} and drops a kind that is not a string, and every extra field", async () => {
    for (const [body, want] of [
      [{ kind: "lines", width: 390, height: 120 }, JSON.stringify({ kind: "lines" })],
      [{ kind: { lines: 3 } }, null],
      [{ kind: 3 }, null],
    ] as const) {
      const { env, dbOps } = makeEnv();
      const { ctx, waits } = makeCtx();
      await worker.fetch(
        postEvent("https://edge.test/event?cid=acme", {
          event_type: "personalization_skipped",
          page_path: "/",
          cohort: "skipped",
          ...body,
        }),
        env as never,
        ctx,
      );
      await Promise.all(waits);
      expect(dbOps[0]?.args.at(-5)).toBe(want);
    }
  });
});

describe("/event: snippet_issue (docs/specs/snippet-issues.md)", () => {
  const VISIT = "0123456789abcdef0123456789abcdef";

  async function send(extra: Record<string, unknown>) {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const res = await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        event_type: "snippet_issue",
        page_path: "/az",
        variant_key: "v1:variant:acme:brand:social",
        ...extra,
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    expect(res.status).toBe(202);
    return dbOps;
  }

  const issues = (...items: unknown[]) => ({ properties: { issues: items } });

  it("stores a valid payload of each code with exactly the re-serialised properties", async () => {
    for (const [item, want] of [
      [{ c: "select_failed", n: 1 }, '{"issues":[{"c":"select_failed","n":1}]}'],
      [{ n: 3, c: "select_failed" }, '{"issues":[{"c":"select_failed","n":3}]}'],
      [{ c: "select_failed", n: 2 }, '{"issues":[{"c":"select_failed","n":2}]}'],
      // 4: the page was left or hidden while we asked (F1, privacy review Q5).
      [{ c: "select_failed", n: 4 }, '{"issues":[{"c":"select_failed","n":4}]}'],
      [{ c: "reveal_cap", n: 2 }, '{"issues":[{"c":"reveal_cap","n":2}]}'],
      [{ c: "apply_error" }, '{"issues":[{"c":"apply_error"}]}'],
      [
        { s: "hero.headline", c: "apply_error" },
        '{"issues":[{"c":"apply_error","s":"hero.headline"}]}',
      ],
      [{ c: "rich_failed" }, '{"issues":[{"c":"rich_failed"}]}'],
      [
        { c: "lines_changed", s: "hero.headline", n: -2 },
        '{"issues":[{"c":"lines_changed","s":"hero.headline","n":-2}]}',
      ],
      [{ c: "lines_changed", n: 9 }, '{"issues":[{"c":"lines_changed","n":9}]}'],
      [{ c: "swap_shift", n: 4 }, '{"issues":[{"c":"swap_shift","n":4}]}'],
      [
        { c: "reverted", s: "cta.primary.label", n: 99 },
        '{"issues":[{"c":"reverted","s":"cta.primary.label","n":99}]}',
      ],
      [{ c: "reverted", s: "a.b", n: 4 }, '{"issues":[{"c":"reverted","s":"a.b","n":4}]}'],
    ] as const) {
      const dbOps = await send(issues(item));
      expect(dbOps).toHaveLength(1);
      expect(dbOps[0]?.args[3]).toBe("snippet_issue");
      expect(dbOps[0]?.args.at(-5)).toBe(want);
    }
  });

  it("late_tag (install-friction D, privacy review condition 4): stored bare, dropped with an s or an n", async () => {
    const ok = await send(issues({ c: "late_tag" }));
    expect(ok).toHaveLength(1);
    expect(ok[0]?.args.at(-5)).toBe('{"issues":[{"c":"late_tag"}]}');
    // One of the three issues of the one event, next to the others.
    const three = await send(
      issues({ c: "late_tag" }, { c: "reveal_cap", n: 1 }, { c: "rich_failed" }),
    );
    expect(three[0]?.args.at(-5)).toBe(
      '{"issues":[{"c":"late_tag"},{"c":"reveal_cap","n":1},{"c":"rich_failed"}]}',
    );
    for (const bad of [
      { c: "late_tag", s: "hero.headline" },
      { c: "late_tag", n: 1 },
      { c: "late_tag", n: 0 },
      { c: "late_tag", s: "hero.headline", n: 2 },
    ]) {
      expect(await send(issues(bad)), JSON.stringify(bad)).toHaveLength(0);
      // A bad late_tag drops the whole event, the good issues next to it too.
      expect(await send(issues({ c: "rich_failed" }, bad))).toHaveLength(0);
    }
  });

  it("stores up to three issues in the order sent", async () => {
    const dbOps = await send(
      issues(
        { c: "select_failed", n: 2 },
        { c: "reveal_cap", n: 1 },
        { c: "lines_changed", s: "features.body", n: 1 },
      ),
    );
    expect(dbOps[0]?.args.at(-5)).toBe(
      JSON.stringify({
        issues: [
          { c: "select_failed", n: 2 },
          { c: "reveal_cap", n: 1 },
          { c: "lines_changed", s: "features.body", n: 1 },
        ],
      }),
    );
  });

  it("stores visit as NULL even when the body carries a well-formed marker", async () => {
    const dbOps = await send({ ...issues({ c: "rich_failed" }), visit: VISIT });
    expect(dbOps).toHaveLength(1);
    expect(dbOps[0]?.sql).toContain("visit");
    expect(dbOps[0]?.args.at(-6)).toBeNull();
    expect(dbOps[0]?.args).not.toContain(VISIT);
  });

  it("stores only page_path, variant_key and the issues: every other column NULL or 0", async () => {
    const dbOps = await send({
      ...issues({ c: "swap_shift", n: 2 }),
      intent_dim: "pricing",
      source_dim: "ai",
      cohort: "personalized",
      conversion_label: "signup",
      carried: 1,
      dark_social: 1,
      language_mismatch: 1,
      body_carry: 1,
      kind: "lines",
      paths: ["hero.headline"],
      visit: VISIT,
      arm: "treat",
      body_id: "0123456789abcdef",
      source_name: "linkedin",
      tagged: 1,
    });
    expect(dbOps).toHaveLength(1);
    // id, customer_id, ts, event_type, variant_key, intent_dim, source_dim,
    // page_path, conversion_label, country, device_class, web_view, cohort, dark_social,
    // language_mismatch, carried, visit, properties, arm, body_id,
    // source_name, tagged
    const [, customer, , type, variantKey, ...rest] = dbOps[0]?.args ?? [];
    expect(customer).toBe("acme");
    expect(type).toBe("snippet_issue");
    expect(variantKey).toBe("v1:variant:acme:brand:social");
    expect(rest).toEqual([
      null,
      null,
      "/az",
      null,
      null,
      null,
      null,
      null,
      0,
      0,
      0,
      null,
      '{"issues":[{"c":"swap_shift","n":2}]}',
      null,
      null,
      null,
      0,
    ]);
  });

  it("drops every invalid shape: no row, counted as malformed", async () => {
    const long = `a.${"b".repeat(39)}`; // 41 characters, a valid slot shape
    const bad: Record<string, unknown>[] = [
      // properties missing or not an object
      {},
      { properties: null },
      { properties: [] },
      { properties: "issues" },
      // issues not an array of 1 to 3
      { properties: { issues: [] } },
      { properties: { issues: { c: "rich_failed" } } },
      issues(
        { c: "rich_failed" },
        { c: "apply_error" },
        { c: "reveal_cap", n: 1 },
        { c: "swap_shift", n: 1 },
      ),
      // an extra property key next to issues
      { properties: { issues: [{ c: "rich_failed" }], message: "boom" } },
      { properties: { issues: [{ c: "rich_failed" }], width: 390 } },
      // item not an object, or with an extra key
      issues("rich_failed"),
      issues(null),
      issues([{ c: "rich_failed" }]),
      issues({ c: "rich_failed", message: "https://x/?email=a@b" }),
      issues({ c: "apply_error", s: "hero.headline", stack: "at x" }),
      // unknown or missing code
      issues({ c: "unknown_code" }),
      issues({ c: "SELECT_FAILED", n: 1 }),
      issues({ n: 1 }),
      issues({ c: 1, n: 1 }),
      // bad slot
      issues({ c: "apply_error", s: "hero" }),
      issues({ c: "apply_error", s: "Hero.Headline" }),
      issues({ c: "apply_error", s: "h1.hero > span" }),
      issues({ c: "apply_error", s: "a.b.c.d.e" }),
      issues({ c: "apply_error", s: long }),
      issues({ c: "lines_changed", s: 3, n: 1 }),
      issues({ c: "reverted", s: "", n: 5 }),
      // a slot on a code without slots
      issues({ c: "select_failed", s: "hero.headline", n: 1 }),
      issues({ c: "reveal_cap", s: "hero.headline", n: 1 }),
      issues({ c: "rich_failed", s: "hero.headline" }),
      issues({ c: "swap_shift", s: "hero.headline", n: 1 }),
      // n out of range, missing, not an integer, or present where none is allowed
      issues({ c: "select_failed", n: 0 }),
      issues({ c: "select_failed", n: 5 }),
      issues({ c: "select_failed", n: 6 }),
      issues({ c: "select_failed", n: -1 }),
      issues({ c: "select_failed", n: 4.5 }),
      issues({ c: "select_failed", n: "4" }),
      issues({ c: "select_failed" }),
      issues({ c: "reveal_cap", n: 0 }),
      issues({ c: "reveal_cap", n: 4 }),
      issues({ c: "lines_changed", s: "hero.headline", n: 0 }),
      issues({ c: "lines_changed", s: "hero.headline", n: 10 }),
      issues({ c: "lines_changed", s: "hero.headline", n: -10 }),
      issues({ c: "lines_changed", s: "hero.headline", n: 1.5 }),
      issues({ c: "lines_changed", s: "hero.headline" }),
      issues({ c: "swap_shift", n: 0 }),
      issues({ c: "swap_shift", n: 5 }),
      issues({ c: "swap_shift", n: "2" }),
      issues({ c: "swap_shift", n: 0.07 }),
      issues({ c: "reverted", s: "hero.headline", n: 3 }),
      issues({ c: "reverted", s: "hero.headline", n: 100 }),
      issues({ c: "apply_error", n: 1 }),
      issues({ c: "rich_failed", n: 1 }),
      issues({ c: "apply_error", n: null }),
      // one bad item spoils the whole event
      issues({ c: "rich_failed" }, { c: "swap_shift", n: 9 }),
    ];
    for (const body of bad) {
      const dbOps = await send(body);
      expect(dbOps, JSON.stringify(body)).toHaveLength(0);
    }
  });

  describe("select_failed 4 and the two sends of one load (snippet-issues.md, Leaving the page)", () => {
    /** As the snippet sends every snippet_issue now: a keepalive fetch, text/plain, no preflight. */
    function plain(body: unknown): Request {
      return new Request("https://edge.test/event?cid=acme", {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(body),
      });
    }
    const issue = (...items: unknown[]) => ({
      event_type: "snippet_issue",
      page_path: "/az",
      variant_key: "v1:variant:acme:brand:social",
      properties: { issues: items },
    });

    it("accepts n 1 to 4 and drops 5, the key set unchanged, visit NULL (privacy review Q5 condition 3)", async () => {
      for (const n of [1, 2, 3, 4]) {
        const dbOps = await send({ ...issues({ c: "select_failed", n }), visit: VISIT });
        expect(dbOps, String(n)).toHaveLength(1);
        expect(dbOps[0]?.args.at(-5)).toBe(`{"issues":[{"c":"select_failed","n":${n}}]}`);
        // No visit marker and no arm, also on 4: never joined to an exposure.
        expect(dbOps[0]?.args.at(-6)).toBeNull();
        expect(dbOps[0]?.args).not.toContain(VISIT);
      }
      expect(await send(issues({ c: "select_failed", n: 5 }))).toHaveLength(0);
      // The key set: a 4 takes no slot and no extra key, like 1 to 3.
      expect(await send(issues({ c: "select_failed", n: 4, s: "hero.headline" }))).toHaveLength(0);
      expect(await send(issues({ c: "select_failed", n: 4, t: 1200 }))).toHaveLength(0);
      expect(await send(issues({ c: "select_failed", n: 4, hidden: true }))).toHaveLength(0);
    });

    it("a 4 no longer drops the other issues sent with it", async () => {
      // What a late-tag load left while /select was on its way sends at pagehide.
      const dbOps = await send(issues({ c: "late_tag" }, { c: "select_failed", n: 4 }));
      expect(dbOps).toHaveLength(1);
      expect(dbOps[0]?.args.at(-5)).toBe(
        '{"issues":[{"c":"late_tag"},{"c":"select_failed","n":4}]}',
      );
      // A 5 still spoils the whole event.
      expect(await send(issues({ c: "late_tag" }, { c: "select_failed", n: 5 }))).toHaveLength(0);
    });

    it("parses a snippet_issue sent as text/plain;charset=UTF-8, the timed sends too", async () => {
      const { env, dbOps } = makeEnv();
      const { ctx, waits } = makeCtx();
      const res = await worker.fetch(
        plain(issue({ c: "select_failed", n: 4 }, { c: "swap_shift", n: 1 })),
        env as never,
        ctx,
      );
      await Promise.all(waits);
      expect(res.status).toBe(202);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(dbOps).toHaveLength(1);
      expect(dbOps[0]?.args[3]).toBe("snippet_issue");
      expect(dbOps[0]?.args.at(-5)).toBe(
        '{"issues":[{"c":"select_failed","n":4},{"c":"swap_shift","n":1}]}',
      );
      // A text/plain body that is not JSON is malformed like any other: 202, no row.
      const bad = makeEnv();
      const badCtx = makeCtx();
      const r = await worker.fetch(
        new Request("https://edge.test/event?cid=acme", {
          method: "POST",
          headers: { "content-type": "text/plain;charset=UTF-8" },
          body: "issues=late_tag",
        }),
        bad.env as never,
        badCtx.ctx,
      );
      await Promise.all(badCtx.waits);
      expect(r.status).toBe(202);
      expect(bad.dbOps).toHaveLength(0);
    });

    it("a second snippet_issue of the same load holding only reverted is accepted", async () => {
      // The first goes a second after the reveal; `reverted`, the one code
      // that needs ten seconds, follows alone. The edge keeps nothing between
      // the two: each is its own row, neither with a marker.
      const { env, dbOps } = makeEnv();
      for (const body of [
        issue({ c: "lines_changed", s: "hero.headline", n: 1 }, { c: "swap_shift", n: 2 }),
        issue({ c: "reverted", s: "hero.headline", n: 7 }),
      ]) {
        const { ctx, waits } = makeCtx();
        const res = await worker.fetch(plain({ ...body, visit: VISIT }), env as never, ctx);
        await Promise.all(waits);
        expect(res.status).toBe(202);
      }
      expect(dbOps).toHaveLength(2);
      expect(dbOps[0]?.args.at(-5)).toBe(
        '{"issues":[{"c":"lines_changed","s":"hero.headline","n":1},{"c":"swap_shift","n":2}]}',
      );
      expect(dbOps[1]?.args.at(-5)).toBe('{"issues":[{"c":"reverted","s":"hero.headline","n":7}]}');
      for (const op of dbOps) {
        expect(op.args[3]).toBe("snippet_issue");
        expect(op.args[7]).toBe("/az");
        expect(op.args.at(-6)).toBeNull();
        expect(op.args).not.toContain(VISIT);
      }
      // Two rows, two ids: the edge never ties them together.
      expect(dbOps[0]?.args[0]).not.toBe(dbOps[1]?.args[0]);
    });
  });

  it("counts a dropped snippet_issue in the guard line, never logs its content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await send(issues({ c: "apply_error", s: "hero.headline", message: "https://x/?email=a@b" }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("malformed 1");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("email");
    warn.mockRestore();
  });

  it("leaves the other event types as they were", async () => {
    // A `properties` field on another type is ignored, and its visit is kept.
    let dbOps = await send({
      event_type: "variant_shown",
      cohort: "personalized",
      visit: VISIT,
      properties: { issues: [{ c: "rich_failed" }] },
    });
    expect(dbOps).toHaveLength(1);
    expect(dbOps[0]?.args.at(-6)).toBe(VISIT);
    expect(dbOps[0]?.args.at(-5)).toBeNull();

    dbOps = await send({
      event_type: "personalization_skipped",
      cohort: "skipped",
      kind: "lines",
      properties: "anything",
    });
    expect(dbOps[0]?.args.at(-5)).toBe(JSON.stringify({ kind: "lines" }));

    dbOps = await send({
      event_type: "personalization_partial",
      cohort: "personalized",
      paths: ["hero.headline"],
      visit: VISIT,
    });
    expect(dbOps[0]?.args.at(-5)).toBe(JSON.stringify({ paths: ["hero.headline"] }));
    expect(dbOps[0]?.args.at(-6)).toBe(VISIT);
  });
});

// ---------------------------------------------------------------------------
// Arm and version id (docs/specs/proof-engine.md, C; privacy review conditions 2, 6)
// ---------------------------------------------------------------------------

describe("/event: arm and body_id", () => {
  const VISIT2 = "0123456789abcdef0123456789abcdef";
  async function send(body: Record<string, unknown>) {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    await worker.fetch(
      postEvent("https://edge.rawuser.test/event?cid=acme", { page_path: "/", ...body }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    return dbOps;
  }
  const armOf = (ops: DbOp[]) => ops[0]?.args.at(-4);
  const bodyOf = (ops: DbOp[]) => ops[0]?.args.at(-3);

  it("stores a valid arm and body id on every exposure and conversion type", async () => {
    for (const event_type of [
      "variant_shown",
      "personalization_skipped",
      "personalization_partial",
      "no_signal_passthrough",
    ]) {
      const ops = await send({
        event_type,
        visit: VISIT2,
        arm: "holdout",
        body_id: "0123456789abcdef",
      });
      expect(armOf(ops)).toBe("holdout");
      expect(bodyOf(ops)).toBe("0123456789abcdef");
    }
    const conv = await send({
      event_type: "conversion",
      conversion_label: "trial_start",
      visit: VISIT2,
      arm: "treat",
      body_id: "fedcba9876543210",
    });
    expect(armOf(conv)).toBe("treat");
    expect(bodyOf(conv)).toBe("fedcba9876543210");
  });

  it("drops an arm outside the closed set and a malformed body id, and keeps the row", async () => {
    for (const [arm, body_id] of [
      ["control", "0123456789ABCDEF"],
      ["TREAT", "0123456789abcde"],
      [1, "0123456789abcdef0"],
      [{ a: 1 }, 12345],
    ] as const) {
      const ops = await send({ event_type: "variant_shown", visit: VISIT2, arm, body_id });
      expect(ops).toHaveLength(1);
      expect(armOf(ops)).toBeNull();
      expect(bodyOf(ops)).toBeNull();
    }
  });

  it("stores no arm without a valid marker (an arm only counts for a visit)", async () => {
    const ops = await send({
      event_type: "variant_shown",
      arm: "treat",
      body_id: "0123456789abcdef",
    });
    expect(armOf(ops)).toBeNull();
    expect(bodyOf(ops)).toBe("0123456789abcdef");
    const junk = await send({ event_type: "variant_shown", visit: "nope", arm: "treat" });
    expect(armOf(junk)).toBeNull();
  });

  it("snippet_issue stores neither, whatever is sent", async () => {
    const ops = await send({
      event_type: "snippet_issue",
      properties: { issues: [{ c: "rich_failed" }] },
      visit: VISIT2,
      arm: "treat",
      body_id: "0123456789abcdef",
    });
    expect(ops).toHaveLength(1);
    expect(armOf(ops)).toBeNull();
    expect(bodyOf(ops)).toBeNull();
  });

  it("kept lengths are refused: a kept_lengths field is never stored (condition 2)", async () => {
    const ops = await send({
      event_type: "variant_shown",
      visit: VISIT2,
      arm: "treat",
      body_id: "0123456789abcdef",
      kept_lengths: "01-2",
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.sql).not.toMatch(/kept/);
    expect(ops[0]?.args).not.toContain("01-2");
    const src = readFileSync(new URL("../src/event.ts", import.meta.url), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(src).not.toMatch(/kept_lengths|\[0-3-\]/);
  });
});

describe("/event: source_name and tagged (N1, N3; privacy review condition 2)", () => {
  const VISIT2 = "0123456789abcdef0123456789abcdef";
  async function store(body: Record<string, unknown>) {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", { page_path: "/", ...body }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    return dbOps[0]?.args ?? [];
  }
  const nameOf = (args: unknown[]) => args.at(-2);
  const taggedOf = (args: unknown[]) => args.at(-1);
  const shown = {
    event_type: "variant_shown",
    variant_key: "k",
    intent_dim: "problem",
    source_dim: "social",
    cohort: "personalized",
    visit: VISIT2,
  };

  it("stores a name on the closed list and the tag bit", async () => {
    const args = await store({ ...shown, source_name: "linkedin", tagged: 1 });
    expect(nameOf(args)).toBe("linkedin");
    expect(taggedOf(args)).toBe(1);
  });

  it("anything else is NULL and 0, and the row is kept", async () => {
    for (const source_name of ["LinkedIn", "linkedin.com", "my-newsletter", 7, "", null]) {
      const args = await store({ ...shown, source_name, tagged: 2 });
      expect(args.length).toBeGreaterThan(0);
      expect(nameOf(args)).toBeNull();
      expect(taggedOf(args)).toBe(0);
    }
    expect(taggedOf(await store({ ...shown, tagged: "1" }))).toBe(0);
    expect(taggedOf(await store({ ...shown, tagged: true }))).toBe(0);
  });

  it("never on a no-signal row", async () => {
    const args = await store({
      event_type: "no_signal_passthrough",
      cohort: "no_signal",
      source_name: "google",
      tagged: 1,
    });
    expect(nameOf(args)).toBeNull();
    expect(taggedOf(args)).toBe(0);
  });

  it("a conversion keeps them", async () => {
    const args = await store({
      event_type: "conversion",
      conversion_label: "signup",
      cohort: "personalized",
      source_dim: "ai",
      source_name: "chatgpt",
      tagged: 0,
    });
    expect(nameOf(args)).toBe("chatgpt");
    expect(taggedOf(args)).toBe(0);
  });

  it("intent_dim and source_dim only from their lists, else NULL", async () => {
    const args = await store({ ...shown, intent_dim: "Bob's pricing", source_dim: "<b>x</b>" });
    // id, customer_id, ts, event_type, variant_key, intent_dim, source_dim, ...
    expect(args[5]).toBeNull();
    expect(args[6]).toBeNull();
    const ok = await store(shown);
    expect(ok[5]).toBe("problem");
    expect(ok[6]).toBe("social");
  });
});

describe("/event — the site-map bit (docs/specs/site-shaped-intents.md §6.4)", () => {
  async function props(body: Record<string, unknown>) {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        page_path: "/approach",
        variant_key: "v1:variant:acme:p:%2Fapproach:problem:default",
        intent_dim: "problem",
        source_dim: "direct",
        ...body,
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    return { rows: dbOps.length, props: dbOps[0]?.args.at(-5) };
  }

  it("stores 1 on a variant_shown, with the body carry bit when both are set", async () => {
    expect(
      (await props({ event_type: "variant_shown", cohort: "personalized", site_path: 1 })).props,
    ).toBe(JSON.stringify({ site_path: 1 }));
    expect(
      (
        await props({
          event_type: "variant_shown",
          cohort: "personalized",
          site_path: 1,
          body_carry: 1,
        })
      ).props,
    ).toBe(JSON.stringify({ body_carry: 1, site_path: 1 }));
    expect(
      (await props({ event_type: "variant_shown", cohort: "holdout", site_path: 1 })).props,
    ).toBe(JSON.stringify({ site_path: 1 }));
  });

  it("stores it beside the skip reason on a skipped load", async () => {
    expect(
      (
        await props({
          event_type: "personalization_skipped",
          cohort: "skipped",
          kind: "late",
          site_path: 1,
        })
      ).props,
    ).toBe(JSON.stringify({ kind: "late", site_path: 1 }));
  });

  it("drops anything but 1, and never stores it on another type", async () => {
    for (const v of [2, "1", true, "/tarifler", { kind: "price" }]) {
      const r = await props({ event_type: "variant_shown", cohort: "personalized", site_path: v });
      expect(r.rows).toBe(1);
      expect(r.props).toBeNull();
    }
    const ns = await props({
      event_type: "no_signal_passthrough",
      cohort: "no_signal",
      site_path: 1,
    });
    expect(ns.props).toBeNull();
    const conv = await props({
      event_type: "conversion",
      cohort: "personalized",
      conversion_label: "trial_start",
      site_path: 1,
    });
    expect(conv.props).toBeNull();
  });

  it("never on a snippet_issue", async () => {
    const r = await props({
      event_type: "snippet_issue",
      properties: { issues: [{ c: "select_failed" }] },
      site_path: 1,
    });
    expect(String(r.props ?? "")).not.toContain("site_path");
  });
});

// ---------------------------------------------------------------------------
// The bit `lp` (docs/specs/late-tag.md; privacy review Q2, conditions 2, 3)
// ---------------------------------------------------------------------------

describe("/event: lp, the page was painted before our script ran (late-tag.md)", () => {
  const VISIT = "0123456789abcdef0123456789abcdef";

  async function store(body: Record<string, unknown>) {
    const { env, dbOps, kvOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const res = await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", {
        page_path: "/",
        variant_key: "v1:variant:acme:problem:ai",
        intent_dim: "problem",
        source_dim: "ai",
        visit: VISIT,
        ...body,
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    expect(res.status).toBe(202);
    // 202 with no body: the bit never comes back to a browser.
    expect(await res.text()).toBe("");
    // Never in KV: an event writes none.
    expect(kvOps.filter((o) => o.op === "put")).toEqual([]);
    return { rows: dbOps.length, props: dbOps[0]?.args.at(-5), visit: dbOps[0]?.args.at(-6) };
  }

  const skippedLate = { event_type: "personalization_skipped", cohort: "skipped", kind: "late" };
  const holdout = { event_type: "variant_shown", cohort: "holdout", arm: "holdout" };

  it("personalization_skipped, kind late: stored as 1 beside the kind", async () => {
    const r = await store({ ...skippedLate, lp: 1 });
    expect(r.rows).toBe(1);
    expect(r.props).toBe('{"kind":"late","lp":1}');
    expect(r.visit).toBe(VISIT);
    // Beside the site-map bit too, the existing keys as they were.
    expect((await store({ ...skippedLate, lp: 1, site_path: 1 })).props).toBe(
      '{"kind":"late","site_path":1,"lp":1}',
    );
    // A late answer on a tag that ran in time: `late` without the bit.
    expect((await store(skippedLate)).props).toBe('{"kind":"late"}');
  });

  it("personalization_skipped of another kind, or outside the cohort skipped: the bit is ignored", async () => {
    for (const kind of ["missing", "split", "template-mismatch", "lines"]) {
      const r = await store({ ...skippedLate, kind, lp: 1 });
      expect(r.rows, kind).toBe(1);
      expect(r.props, kind).toBe(JSON.stringify({ kind }));
    }
    // No kind, an unknown kind, no cohort, another cohort.
    expect((await store({ ...skippedLate, kind: undefined, lp: 1 })).props).toBeNull();
    expect((await store({ ...skippedLate, kind: "late:900", lp: 1 })).props).toBeNull();
    expect((await store({ ...skippedLate, cohort: undefined, lp: 1 })).props).toBe(
      '{"kind":"late"}',
    );
    expect((await store({ ...skippedLate, cohort: "personalized", lp: 1 })).props).toBe(
      '{"kind":"late"}',
    );
  });

  it("variant_shown, cohort holdout (the holdout arm's exposure): stored as 1", async () => {
    const r = await store({ ...holdout, lp: 1 });
    expect(r.rows).toBe(1);
    expect(r.props).toBe('{"lp":1}');
    expect(r.visit).toBe(VISIT);
    expect((await store({ ...holdout, lp: 1, site_path: 1 })).props).toBe('{"site_path":1,"lp":1}');
    expect((await store(holdout)).props).toBeNull();
  });

  it("variant_shown, cohort personalized: nothing stored, the row kept", async () => {
    // No version is shown on a painted page, so this shape does not exist.
    const r = await store({ event_type: "variant_shown", cohort: "personalized", lp: 1 });
    expect(r.rows).toBe(1);
    expect(r.props).toBeNull();
    expect(
      (await store({ event_type: "variant_shown", cohort: "personalized", lp: 1, body_carry: 1 }))
        .props,
    ).toBe('{"body_carry":1}');
    // Without a cohort (a snippet from before Batch C) it is not the holdout exposure.
    expect((await store({ event_type: "variant_shown", lp: 1 })).props).toBeNull();
  });

  it("conversion: never, whatever arm or cohort rides on the click", async () => {
    for (const extra of [
      { cohort: "holdout", arm: "holdout" },
      { cohort: "skipped", kind: "late" },
      { cohort: "personalized" },
    ]) {
      const r = await store({
        event_type: "conversion",
        conversion_label: "trial_start",
        lp: 1,
        ...extra,
      });
      expect(r.rows, JSON.stringify(extra)).toBe(1);
      expect(r.props, JSON.stringify(extra)).toBeNull();
    }
  });

  it("no_signal_passthrough: never", async () => {
    const r = await store({ event_type: "no_signal_passthrough", cohort: "no_signal", lp: 1 });
    expect(r.rows).toBe(1);
    expect(r.props).toBeNull();
  });

  it("personalization_partial: never, the slot list as it was", async () => {
    const r = await store({
      event_type: "personalization_partial",
      cohort: "personalized",
      paths: ["hero.headline"],
      lp: 1,
    });
    expect(r.rows).toBe(1);
    expect(r.props).toBe('{"paths":["hero.headline"]}');
  });

  it("snippet_issue: never, and still no visit marker", async () => {
    const r = await store({
      event_type: "snippet_issue",
      properties: { issues: [{ c: "late_tag" }] },
      lp: 1,
    });
    expect(r.rows).toBe(1);
    expect(r.props).toBe('{"issues":[{"c":"late_tag"}]}');
    expect(r.visit).toBeNull();
    // Inside `properties` it is an extra key: the event is malformed.
    const inside = await store({
      event_type: "snippet_issue",
      properties: { issues: [{ c: "late_tag" }], lp: 1 },
    });
    expect(inside.rows).toBe(0);
  });

  it("only the literal 1: true, 2, '1' and the rest are ignored, never a reason to drop the row", async () => {
    for (const lp of [true, 2, "1", 0, -1, 1.5, null, "yes", [1], { v: 1 }, 964]) {
      for (const shape of [skippedLate, holdout]) {
        const r = await store({ ...shape, lp });
        const what = `${JSON.stringify(lp)} on ${shape.event_type}`;
        expect(r.rows, what).toBe(1);
        expect(String(r.props ?? ""), what).not.toContain("lp");
      }
    }
    expect((await store({ ...skippedLate, lp: true })).props).toBe('{"kind":"late"}');
    expect((await store({ ...holdout, lp: 2 })).props).toBeNull();
    expect((await store({ ...holdout, lp: "1" })).props).toBeNull();
  });

  it("no measured value rides in beside it: exactly the closed keys are stored", async () => {
    const r = await store({
      ...skippedLate,
      lp: 1,
      paint: 964,
      startTime: 720.5,
      first_paint_ms: 720,
      paints: 3,
    });
    expect(r.props).toBe('{"kind":"late","lp":1}');
  });

  it("is read in one place: no other edge or shared source names it (condition 3)", () => {
    // /select, /carry, the customer script, the bundle and every classifier
    // and selector live in these two trees. The three generated *-asset.ts
    // files hold the built snippet itself and are left out.
    const roots = [
      new URL("../src/", import.meta.url),
      new URL("../../shared/src/", import.meta.url),
    ];
    const named: string[] = [];
    const walk = (dir: URL) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const at = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
        if (entry.isDirectory()) walk(at);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith("-asset.ts")) {
          if (/\blp\b/.test(readFileSync(at, "utf8"))) named.push(entry.name);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(named).toEqual(["event.ts"]);
  });
});

describe("/event: nd and the choice row (docs/specs/direct-visitors.md §2, §6)", () => {
  const VISIT = "0123456789abcdef0123456789abcdef";

  async function store(body: Record<string, unknown>) {
    const { env, dbOps } = makeEnv();
    const { ctx, waits } = makeCtx();
    const res = await worker.fetch(
      postEvent("https://edge.test/event?cid=acme", { page_path: "/", visit: VISIT, ...body }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    expect(res.status).toBe(202);
    // The properties column, where the lp test reads it.
    return { rows: dbOps.length, props: dbOps[0]?.args.at(-5) };
  }

  it("stores nd of the fixed shape on exposures and clicks", async () => {
    for (const [type, nd] of [
      ["variant_shown", "l:k3x9:600"],
      ["no_signal_passthrough", "l:k3x9:400"],
      ["conversion", "m"],
      ["personalization_skipped", "c:b"],
      ["variant_shown", "l:k3x9"],
    ] as const) {
      const r = await store({
        event_type: type,
        cohort: type === "no_signal_passthrough" ? "no_signal" : "personalized",
        ...(type === "conversion" ? { conversion_label: "signup" } : {}),
        nd,
      });
      expect(r.rows, type).toBe(1);
      expect(JSON.parse(String(r.props)).nd, type).toBe(nd);
    }
  });

  it("drops an nd of another shape and keeps the row", async () => {
    for (const nd of ["l:k3x9:600:1", "m:GB", "c:e", "x", 7, "l:K3:1"]) {
      const r = await store({ event_type: "variant_shown", cohort: "personalized", nd });
      expect(r.rows).toBe(1);
      expect(r.props == null || !String(r.props).includes("nd")).toBe(true);
    }
  });

  it("a choice row stores its fixed word; without one nothing is stored", async () => {
    const shown = await store({ event_type: "choice", cohort: "no_signal", ch: "shown" });
    expect(shown.rows).toBe(1);
    expect(JSON.parse(String(shown.props))).toEqual({ ch: "shown" });
    expect((await store({ event_type: "choice", ch: "fit" })).rows).toBe(1);
    expect((await store({ event_type: "choice", ch: "345px" })).rows).toBe(0);
    expect((await store({ event_type: "choice" })).rows).toBe(0);
  });

  it("answered and returned keep the visitor's code and the slot (ADR 0039); no other row does", async () => {
    const PID = "fedcba9876543210fedcba9876543210";
    for (const ch of ["answered", "returned"]) {
      const r = await store({ event_type: "choice", cohort: "no_signal", ch, qa: "b", pid: PID });
      expect(JSON.parse(String(r.props))).toEqual({ ch, pid: PID, qa: "b" });
    }
    const shown = await store({
      event_type: "choice",
      cohort: "no_signal",
      ch: "shown",
      pid: PID,
      qa: "a",
    });
    expect(JSON.parse(String(shown.props))).toEqual({ ch: "shown" });
    const bad = await store({ event_type: "choice", ch: "answered", pid: "PID-1", qa: "e" });
    expect(JSON.parse(String(bad.props))).toEqual({ ch: "answered" });
    // The memory (ADR 0039 as amended 2026-11-05): `first` keeps the code
    // only; `returned` keeps a remembered reason of the closed shape.
    const first = await store({
      event_type: "choice",
      ch: "first",
      pid: PID,
      qa: "a",
      rc: "problem:ai",
    });
    expect(JSON.parse(String(first.props))).toEqual({ ch: "first", pid: PID });
    const reason = await store({
      event_type: "choice",
      ch: "returned",
      pid: PID,
      rc: "problem:ai",
    });
    expect(JSON.parse(String(reason.props))).toEqual({
      ch: "returned",
      pid: PID,
      rc: "problem:ai",
    });
    for (const rc of ["pricing:direct", "problem:mk-az", "https://x.test", "problem:ai:x"]) {
      const r = await store({ event_type: "choice", ch: "returned", pid: PID, rc });
      expect(JSON.parse(String(r.props))).toEqual({ ch: "returned", pid: PID });
    }
    // `r:{slot}` is a remembered answer's nd.
    const back = await store({ event_type: "variant_shown", cohort: "personalized", nd: "r:a" });
    expect(JSON.parse(String(back.props)).nd).toBe("r:a");
  });
});
