/**
 * /onboard/capture on the edge (script-first onboarding).
 *
 * - token-gated: unknown token → 403, nothing written
 * - happy path: cleaned HTML stored under capture:{customer}:{path} with a
 *   15-minute TTL, token deleted, customers.tag_seen_at flipped off-path
 * - CORS: * (the snippet runs on the customer's origin), preflight 204
 * - the visitor path never reads capture:* keys (the /select handler's KV
 *   reads are pinned to variant/lang prefixes)
 */

import { CAPTURE_TTL_S, captureKey, captureTokenKey } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";

function makeKv(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  const puts: { key: string; ttl?: number }[] = [];
  const reads: string[] = [];
  const kv = {
    async get(key: string) {
      reads.push(key);
      return data.get(key) ?? null;
    },
    async put(key: string, value: string, o?: { expirationTtl?: number }) {
      data.set(key, value);
      puts.push({ key, ttl: o?.expirationTtl });
    },
    async delete(key: string) {
      data.delete(key);
    },
  } as unknown as KVNamespace;
  return { kv, data, puts, reads };
}

function makeDb(writes: { sql: string; args: unknown[] }[]) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              writes.push({ sql, args });
              return { success: true };
            },
            async first() {
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function makeCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => promises.push(p),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
    promises,
  };
}

const TOKEN = "abcdef1234567890abcdef1234567890";

describe("POST /onboard/capture", () => {
  it("stores the cleaned DOM for fifteen minutes, burns the token, stamps tag_seen_at", async () => {
    const { kv, data, puts } = makeKv({
      [captureTokenKey(TOKEN)]: JSON.stringify({ customer_id: "lumera", page_path: "/" }),
    });
    const writes: { sql: string; args: unknown[] }[] = [];
    const { ctx, promises } = makeCtx();
    const env = { VARIANTS: kv, DB: makeDb(writes), ENVIRONMENT: "test", PREVIEW_TOKEN: "" };

    const res = await worker.fetch(
      new Request("https://edge.test/onboard/capture", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://lumera.test" },
        body: JSON.stringify({
          token: TOKEN,
          url: "https://lumera.test/",
          html: "<html><head><script>x()</script></head><body><h1>Salam</h1></body></html>",
        }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { ok: boolean; page_path: string };
    expect(body.ok).toBe(true);
    expect(body.page_path).toBe("/");

    const stored = data.get(captureKey("lumera", "/"));
    expect(stored).toContain("<h1>Salam</h1>");
    expect(stored).not.toContain("<script");
    expect(puts.find((p) => p.key === captureKey("lumera", "/"))?.ttl).toBe(CAPTURE_TTL_S);
    expect(data.has(captureTokenKey(TOKEN))).toBe(false);

    await Promise.all(promises);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql).toContain("tag_seen_at = COALESCE(tag_seen_at, ?)");
    expect(writes[0]?.args[1]).toBe("lumera");
  });

  it("rejects an unknown token and writes nothing", async () => {
    const { kv, data } = makeKv({});
    const writes: { sql: string; args: unknown[] }[] = [];
    const { ctx } = makeCtx();
    const env = { VARIANTS: kv, DB: makeDb(writes), ENVIRONMENT: "test", PREVIEW_TOKEN: "" };
    const res = await worker.fetch(
      new Request("https://edge.test/onboard/capture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN, html: "<p>x</p>" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
    expect(data.size).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it("answers preflight with 204 and no auth", async () => {
    const { kv } = makeKv({});
    const { ctx } = makeCtx();
    const env = { VARIANTS: kv, DB: makeDb([]), ENVIRONMENT: "test", PREVIEW_TOKEN: "" };
    const res = await worker.fetch(
      new Request("https://edge.test/onboard/capture", { method: "OPTIONS" }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("visitor path never reads capture keys", () => {
  it("/select reads only variant and customer-lang keys", async () => {
    const { kv, reads } = makeKv({});
    const { ctx } = makeCtx();
    const env = { VARIANTS: kv, DB: makeDb([]), ENVIRONMENT: "test", PREVIEW_TOKEN: "" };
    await worker.fetch(
      new Request(
        "https://edge.test/select?customer_id=lumera&utm_source=facebook&utm_medium=social&path=%2F&plang=az",
        { headers: { "user-agent": "Mozilla/5.0" } },
      ),
      env,
      ctx,
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const key of reads) {
      expect(key.startsWith("capture")).toBe(false);
      expect(key.startsWith("v1:quickstart")).toBe(false);
      expect(key.startsWith("v1:preview")).toBe(false);
      expect(key.startsWith("pick")).toBe(false);
    }
  });
});
