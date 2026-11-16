// Task F9 (docs/specs/pilot-gaps.md): on a pilot site a carried visit to
// `/az/work` answered a language mismatch (the unlisted path read as the
// root's English), and once that reads right the cascade must still never
// offer the root's English version to an Azerbaijani page.
import { variantKeyForPath } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";

const STUB = {
  customer_id: "demo",
  profile_key: "x",
  sections: { hero: { kind: "hero", headline: "H" } },
  generated_at: 0,
  prompt_hash: "p",
};
const MAP = JSON.stringify({ "/": "en", "/approach": "en", "/az": "az" });
const ROOT_KEY = "v1:variant:demo:evaluation:social";

function kvWith(data: Record<string, unknown>) {
  return {
    async get(key: string, type?: string | { type?: string }) {
      const v = data[key];
      if (v === undefined) return null;
      const t = typeof type === "string" ? type : type?.type;
      return t === "json" ? v : typeof v === "string" ? v : JSON.stringify(v);
    },
    async put() {},
    async delete() {},
  } as unknown as KVNamespace;
}
const db = {
  prepare: () => ({
    bind: () => ({
      run: async () => ({}),
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
  }),
} as unknown as D1Database;
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function envWith(kv: Record<string, unknown>) {
  return {
    VARIANTS: kvWith(kv),
    DB: db,
    ENVIRONMENT: "test",
    PREVIEW_TOKEN: "",
    HOLDOUT_PERCENT: "0",
  };
}

async function select(kv: Record<string, unknown>, path: string, query: string) {
  const res = await worker.fetch(
    new Request(
      `https://edge.test/select?customer_id=demo&path=${encodeURIComponent(path)}&carry=evaluation:social&${query}`,
      { headers: { "user-agent": "Mozilla/5.0 (F9)" } },
    ),
    envWith(kv),
    ctx,
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("/select, the root's versions and the page's language (F9)", () => {
  it("/az/work (unlisted, under /az) is no mismatch and is never offered the root's English", async () => {
    const body = await select(
      { "v1:customer:demo:lang": MAP, [ROOT_KEY]: STUB },
      "/az/work",
      "plang=az",
    );
    expect(body.language_mismatch).toBeUndefined();
    expect(body.source).toBe("original");
    expect(body.variant).toBeNull();
    expect(body.not_ready).toBe(true);
    expect(body.cohort).toBe("no_signal");
  });

  it("/az (listed, no versions of its own yet) is never offered the root's English", async () => {
    const body = await select(
      { "v1:customer:demo:lang": MAP, [ROOT_KEY]: STUB },
      "/az",
      "plang=az",
    );
    expect(body.language_mismatch).toBeUndefined();
    expect(body.source).toBe("original");
    expect(body.not_ready).toBe(true);
  });

  it("/az/work with versions of its own is served them", async () => {
    const own = variantKeyForPath("demo", "/az/work", "evaluation", "social");
    const body = await select(
      { "v1:customer:demo:lang": MAP, [ROOT_KEY]: STUB, [own]: { ...STUB, profile_key: "own" } },
      "/az/work",
      "plang=az",
    );
    expect(body.source).toBe("kv");
    expect(body.variant_key).toBe(own);
    expect(body.carried).toBe(true);
  });

  it("/work (unlisted, the root's English) keeps today's answer: the root's version, carried", async () => {
    const body = await select(
      { "v1:customer:demo:lang": MAP, [ROOT_KEY]: STUB },
      "/work",
      "plang=en",
    );
    expect(body.source).toBe("kv");
    expect(body.variant_key).toBe(ROOT_KEY);
    expect(body.carried).toBe(true);
  });

  it("/azure is not under /az: the root's English, as before", async () => {
    const body = await select(
      { "v1:customer:demo:lang": MAP, [ROOT_KEY]: STUB },
      "/azure",
      "plang=en",
    );
    expect(body.source).toBe("kv");
    expect(body.variant_key).toBe(ROOT_KEY);
  });

  it("a wrong page language on an unlisted path is still a mismatch", async () => {
    const body = await select(
      { "v1:customer:demo:lang": MAP, [ROOT_KEY]: STUB },
      "/az/work",
      "plang=en",
    );
    expect(body.language_mismatch).toBe(true);
    expect(body.variant).toBeNull();
  });

  it("no plang (an older tag), or no language value: the cascade as before", async () => {
    const noPlang = await select(
      { "v1:customer:demo:lang": MAP, [ROOT_KEY]: STUB },
      "/az/work",
      "x=1",
    );
    expect(noPlang.source).toBe("kv");
    expect(noPlang.variant_key).toBe(ROOT_KEY);
    const noValue = await select({ [ROOT_KEY]: STUB }, "/az/work", "plang=az");
    expect(noValue.source).toBe("kv");
    expect(noValue.variant_key).toBe(ROOT_KEY);
  });

  it("a bare tag from before the map: one language everywhere, the root offered", async () => {
    const body = await select(
      { "v1:customer:demo:lang": "az", [ROOT_KEY]: STUB },
      "/az/work",
      "plang=az",
    );
    expect(body.source).toBe("kv");
    expect(body.variant_key).toBe(ROOT_KEY);
  });
});
