import { PICK_TTL_S, pickCountKey, pickKey, pickTokenKey } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";

function makeKv(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  const puts: { key: string; ttl?: number }[] = [];
  const kv = {
    async get(key: string) {
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
  return { kv, data, puts };
}

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const TOKEN = "abcdef1234567890abcdef1234567890";
const SEED = { "hero.headline": { css: ["h1"], text: ["Salam"], structural: "first h1 in main" } };

function env(kv: KVNamespace) {
  return { VARIANTS: kv, DB: {} as D1Database, ENVIRONMENT: "test", PREVIEW_TOKEN: "" };
}

describe("/picker.js", () => {
  it("serves the picker module with an etag and open CORS", async () => {
    const { kv } = makeKv({});
    const res = await worker.fetch(new Request("https://edge.test/picker.js"), env(kv), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.text();
    expect(body).toContain("rawuser-picker");
    const etag = res.headers.get("etag") ?? "";
    const again = await worker.fetch(
      new Request("https://edge.test/picker.js", { headers: { "if-none-match": etag } }),
      env(kv),
      ctx,
    );
    expect(again.status).toBe(304);
  });
});

describe("/onboard/pick", () => {
  it("GET returns the seed for a live token and keeps the token", async () => {
    const { kv, data } = makeKv({
      [pickTokenKey(TOKEN)]: JSON.stringify({
        customer_id: "lumera",
        page_path: "/",
        manifest: SEED,
      }),
    });
    const res = await worker.fetch(
      new Request(`https://edge.test/onboard/pick?token=${TOKEN}`),
      env(kv),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manifest: unknown; slots: { path: string }[] };
    expect(body.manifest).toEqual(SEED);
    expect(body.slots.length).toBe(8);
    expect(data.has(pickTokenKey(TOKEN))).toBe(true);
  });

  it("POST stores the picked manifest for thirty minutes and burns the token", async () => {
    const { kv, data, puts } = makeKv({
      [pickTokenKey(TOKEN)]: JSON.stringify({
        customer_id: "lumera",
        page_path: "/",
        manifest: {},
      }),
    });
    const res = await worker.fetch(
      new Request("https://edge.test/onboard/pick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: TOKEN,
          manifest: {
            "hero.headline": {
              css: ["#hero-title"],
              text: ["Dizaynı sıfırdan"],
              structural: "first h1 in main",
              original_char_length: 24,
              original_word_count: 3,
              conversion_candidate: false,
            },
          },
        }),
      }),
      env(kv),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(data.get(pickKey("lumera", "/")) ?? "{}")).toHaveProperty("hero.headline");
    expect(puts.find((p) => p.key === pickKey("lumera", "/"))?.ttl).toBe(PICK_TTL_S);
    expect(data.has(pickTokenKey(TOKEN))).toBe(false);
  });

  it("rejects an unknown token on both verbs", async () => {
    const { kv } = makeKv({});
    const get = await worker.fetch(
      new Request(`https://edge.test/onboard/pick?token=${TOKEN}`),
      env(kv),
      ctx,
    );
    expect(get.status).toBe(403);
    const post = await worker.fetch(
      new Request("https://edge.test/onboard/pick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN, manifest: SEED }),
      }),
      env(kv),
      ctx,
    );
    expect(post.status).toBe(403);
  });
});

describe("/onboard/pick on a count link (visual-picker.md §9)", () => {
  const META = JSON.stringify({
    customer_id: "lumera",
    page_path: "/",
    manifest: {},
    mode: "count",
  });

  it("GET offers one slot and the mode; POST stores the button, never a manifest", async () => {
    const { kv, data } = makeKv({ [pickTokenKey(TOKEN)]: META });
    const seed = await worker.fetch(
      new Request(`https://edge.test/onboard/pick?token=${TOKEN}`),
      env(kv),
      ctx,
    );
    const body = (await seed.json()) as { mode?: string; slots: { path: string }[] };
    expect(body.mode).toBe("count");
    expect(body.slots.map((s) => s.path)).toEqual(["count.button"]);

    const res = await worker.fetch(
      new Request("https://edge.test/onboard/pick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: TOKEN,
          page_path: "/",
          button: { css: ["nav a.signup"], text: ["Sign up"], structural: "first a in nav" },
        }),
      }),
      env(kv),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(JSON.parse(data.get(pickCountKey("lumera", "/")) ?? "{}")).toEqual({
      page_path: "/",
      css: ["nav a.signup"],
      text: ["Sign up"],
      structural: "first a in nav",
    });
    expect(data.has(pickKey("lumera", "/"))).toBe(false);
    expect(data.has(pickTokenKey(TOKEN))).toBe(false);
  });

  it("a malformed button is a 400 and the token lives on", async () => {
    const { kv, data } = makeKv({ [pickTokenKey(TOKEN)]: META });
    const res = await worker.fetch(
      new Request("https://edge.test/onboard/pick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN, page_path: "/", button: { css: [] } }),
      }),
      env(kv),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(data.has(pickTokenKey(TOKEN))).toBe(true);
  });
});
