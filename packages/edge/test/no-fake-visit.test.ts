/**
 * No fake visit, the edge's layer (docs/specs/install-friction.md, "What
 * the other passes need", edge 1; privacy review ruling 2026-10-03,
 * condition 3), and CORP on the script routes only (edge 2, E2).
 *
 * Browser Run, reading a customer's page during setup, must never be a
 * visit: /select answers the bot path (no version, no selection), /event
 * writes no row, /carry hands out no copy and fills no cache entry. The
 * marks come from the one constant the render's host block also lives in
 * (@rawuser/shared no-fake-visit.ts); generation's lib/own-hosts.ts
 * re-exports it, so the two layers cannot drift apart.
 */
import * as shared from "@rawuser/shared";
import { variantKeyForPath } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import * as genOwnHosts from "../../generation/src/lib/own-hosts.ts";
import worker from "../src/index.ts";

/** The exact marks the generation build saw on a target (spec, Build notes). */
const BROWSER_RUN_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SIGNATURE_AGENT = '"https://web-bot-auth.cloudflare-browser-rendering-085.workers.dev"';

/** Each mark on its own, on an otherwise ordinary Chrome request. */
const MARKS: Array<[string, Record<string, string>]> = [
  ["Cf-Brapi-Devtools", { "user-agent": CHROME_UA, "Cf-Brapi-Devtools": "1" }],
  ["another cf-brapi-* header", { "user-agent": CHROME_UA, "cf-brapi-request-id": "x" }],
  [
    "Browser Run's Signature-Agent",
    { "user-agent": CHROME_UA, "Signature-Agent": SIGNATURE_AGENT },
  ],
  ["a HeadlessChrome/ user agent", { "user-agent": BROWSER_RUN_UA }],
];

const VERSION = {
  customer_id: "acme",
  profile_key: "intent:problem",
  generated_at: 1,
  prompt_hash: "h",
  sections: { hero: { kind: "hero", headline: "Version" } },
};
const MANIFEST = JSON.stringify({ "hero.headline": { css: ["h1"], text: [], structural: "" } });

interface Seen {
  kvGets: string[];
  sqls: string[];
  runs: unknown[][];
  waits: Promise<unknown>[];
}

function setup() {
  const seen: Seen = { kvGets: [], sqls: [], runs: [], waits: [] };
  const kv: Record<string, unknown> = {
    [variantKeyForPath("acme", "/", "problem", "ai")]: VERSION,
  };
  const env = {
    VARIANTS: {
      async get(key: string | string[], type?: string | { type?: string }) {
        const keys = Array.isArray(key) ? key : [key];
        seen.kvGets.push(...keys);
        const json = (typeof type === "string" ? type : type?.type) === "json";
        const one = (k: string) => {
          const v = kv[k];
          if (v === undefined) return null;
          return json ? v : JSON.stringify(v);
        };
        if (Array.isArray(key)) return new Map(keys.map((k) => [k, one(k)]));
        return one(key);
      },
      async put() {},
      async delete() {},
    } as unknown as KVNamespace,
    DB: {
      prepare(sql: string) {
        seen.sqls.push(sql);
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                seen.runs.push(args);
                return { success: true };
              },
              async all() {
                return { results: [{ page_path: "/", manifest: MANIFEST }] };
              },
              async first() {
                return null;
              },
            };
          },
        };
      },
    } as unknown as D1Database,
    ENVIRONMENT: "test",
    PREVIEW_TOKEN: "",
    EVENT_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  };
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      seen.waits.push(p);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { env, ctx, seen };
}

function selectReq(headers: Record<string, string>): Request {
  return new Request("https://edge.test/select?customer_id=acme&path=%2F&utm_source=chatgpt.com", {
    headers,
  });
}

function eventReq(headers: Record<string, string>): Request {
  return new Request("https://edge.test/event?cid=acme", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ event_type: "variant_shown", page_path: "/", cohort: "personalized" }),
  });
}

function carryReq(headers: Record<string, string>): Request {
  return new Request("https://edge.test/carry?customer_id=acme&carry=problem:ai", { headers });
}

describe("the marks: one constant for both layers", () => {
  it("generation's own-hosts is the shared constant itself, not a copy", () => {
    expect(genOwnHosts.WORKER_NAMES).toBe(shared.WORKER_NAMES);
    expect(genOwnHosts.isOwnHost).toBe(shared.isOwnHost);
  });

  it("each mark the generation build recorded is recognised on its own", () => {
    for (const [, headers] of MARKS) {
      expect(shared.isRenderBrowser(new Headers(headers))).toBe(true);
    }
    // The full set Browser Run sends, as recorded on httpbin 2026-10-04.
    expect(
      shared.isRenderBrowser(
        new Headers({
          "user-agent": BROWSER_RUN_UA,
          "Cf-Brapi-Devtools": "1",
          Signature: "sig1=:abc:",
          "Signature-Input": 'sig1=("@authority")',
          "Signature-Agent": SIGNATURE_AGENT,
        }),
      ),
    ).toBe(true);
  });

  it("an ordinary browser, another signed agent and a bare Signature header are not marked", () => {
    const ordinary: Array<Record<string, string>> = [
      { "user-agent": CHROME_UA },
      { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" },
      { "user-agent": CHROME_UA, "Signature-Agent": '"https://chatgpt.com"' },
      { "user-agent": CHROME_UA, Signature: "sig1=:abc:", "cf-connecting-ip": "203.0.113.1" },
      {},
    ];
    for (const headers of ordinary) {
      expect(shared.isRenderBrowser(new Headers(headers))).toBe(false);
    }
  });
});

describe("/select: Browser Run takes the bot path", () => {
  it("an ordinary Chrome on the same request gets the version (the control)", async () => {
    const { env, ctx } = setup();
    const res = await worker.fetch(selectReq({ "user-agent": CHROME_UA }), env as never, ctx);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.source).toBe("kv");
    expect(body.variant).not.toBeNull();
  });

  it.each(MARKS)(
    "%s: variant null, no selection, no cohort, no targets, nothing written",
    async (_, headers) => {
      const { env, ctx, seen } = setup();
      const res = await worker.fetch(selectReq(headers), env as never, ctx);
      await Promise.all(seen.waits);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ source: "fallback-canonical-bot", variant_key: "", variant: null });
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      // No version read, no row, no learning counter.
      expect(seen.kvGets).toEqual([]);
      expect(seen.runs).toEqual([]);
    },
  );
});

describe("/event: Browser Run writes no row", () => {
  it("an ordinary Chrome writes its row (the control)", async () => {
    const { env, ctx, seen } = setup();
    const res = await worker.fetch(eventReq({ "user-agent": CHROME_UA }), env as never, ctx);
    await Promise.all(seen.waits);
    expect(res.status).toBe(202);
    expect(seen.runs).toHaveLength(1);
  });

  it.each(MARKS)("%s: 202, no row, nothing scheduled", async (_, headers) => {
    const { env, ctx, seen } = setup();
    const res = await worker.fetch(eventReq(headers), env as never, ctx);
    await Promise.all(seen.waits);
    expect(res.status).toBe(202);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(seen.waits).toEqual([]);
    expect(seen.runs).toEqual([]);
  });
});

describe("/event: a bot load's snippet_issue is dropped like its other events", () => {
  // The recheck of 2026-10-12 saw a late bot load still post `late_tag`
  // (4 of 4) and no row stored. That is this drop: the bot answer on
  // /select does not stop the snippet from noting the tag was late, and
  // the edge writes nothing for a request that carries the marks, whatever
  // the event type. The post itself is the snippet's to stop.
  const issueReq = (headers: Record<string, string>): Request =>
    new Request("https://edge.test/event?cid=acme", {
      method: "POST",
      // As the snippet sends every snippet_issue: text/plain, no preflight.
      headers: { "content-type": "text/plain;charset=UTF-8", ...headers },
      body: JSON.stringify({
        event_type: "snippet_issue",
        page_path: "/",
        properties: { issues: [{ c: "late_tag" }] },
      }),
    });

  it("an ordinary Chrome's late_tag is stored (the control)", async () => {
    const { env, ctx, seen } = setup();
    const res = await worker.fetch(issueReq({ "user-agent": CHROME_UA }), env as never, ctx);
    await Promise.all(seen.waits);
    expect(res.status).toBe(202);
    expect(seen.runs).toHaveLength(1);
    expect(seen.runs[0]).toContain('{"issues":[{"c":"late_tag"}]}');
  });

  it.each(MARKS)("%s: 202, no row, nothing scheduled", async (_, headers) => {
    const { env, ctx, seen } = setup();
    const res = await worker.fetch(issueReq(headers), env as never, ctx);
    await Promise.all(seen.waits);
    expect(res.status).toBe(202);
    expect(seen.waits).toEqual([]);
    expect(seen.runs).toEqual([]);
    expect(seen.kvGets).toEqual([]);
  });
});

describe("/carry: Browser Run gets no copy", () => {
  it("an ordinary Chrome gets the segment's copy (the control)", async () => {
    const { env, ctx } = setup();
    const res = await worker.fetch(carryReq({ "user-agent": CHROME_UA }), env as never, ctx);
    const body = (await res.json()) as { bodies: Record<string, unknown> };
    expect(Object.keys(body.bodies)).toEqual(["/"]);
  });

  it.each(MARKS)("%s: empty bodies, not cacheable, no read", async (_, headers) => {
    const { env, ctx, seen } = setup();
    const res = await worker.fetch(carryReq(headers), env as never, ctx);
    const body = (await res.json()) as { bodies: Record<string, unknown> };
    expect(body.bodies).toEqual({});
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(seen.kvGets).toEqual([]);
    expect(seen.sqls).toEqual([]);
    expect(seen.waits).toEqual([]);
  });
});

describe("Cross-Origin-Resource-Policy (install-friction E2)", () => {
  it("cross-origin on the four script routes, on 200 and on 304", async () => {
    for (const path of ["/s/acme.js", "/snippet.js", "/rich.js", "/picker.js"]) {
      const { env, ctx } = setup();
      const res = await worker.fetch(new Request(`https://edge.test${path}`), env as never, ctx);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cross-origin-resource-policy"), path).toBe("cross-origin");
      const etag = res.headers.get("etag") ?? "";
      const again = await worker.fetch(
        new Request(`https://edge.test${path}`, { headers: { "if-none-match": etag } }),
        env as never,
        ctx,
      );
      expect(again.status, path).toBe(304);
      expect(again.headers.get("cross-origin-resource-policy"), path).toBe("cross-origin");
    }
  });

  it("never on /select, /event, /carry or /health", async () => {
    const { env, ctx } = setup();
    for (const req of [
      selectReq({ "user-agent": CHROME_UA }),
      selectReq({ "user-agent": BROWSER_RUN_UA }),
      new Request("https://edge.test/select?customer_id=acme"),
      eventReq({ "user-agent": CHROME_UA }),
      new Request("https://edge.test/event?cid=acme", { method: "OPTIONS" }),
      carryReq({ "user-agent": CHROME_UA }),
      new Request("https://edge.test/health"),
    ]) {
      const res = await worker.fetch(req, env as never, ctx);
      expect(res.headers.get("cross-origin-resource-policy"), req.url).toBeNull();
    }
  });
});
