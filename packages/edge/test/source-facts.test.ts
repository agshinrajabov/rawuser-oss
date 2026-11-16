/**
 * N1 and N3 on /select (docs/specs/results-data.md §7; privacy review
 * condition 2): the edge derives the source name and the own-tag bit from
 * what the request already carried and returns them on the answers that
 * lead to signal rows (written and held out); never on a no-signal answer.
 */
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";

const STUB = {
  customer_id: "demo",
  profile_key: "x",
  sections: { hero: { kind: "hero", headline: "H" } },
  generated_at: 0,
  prompt_hash: "p",
};
function kvWith(data: Record<string, unknown>) {
  return {
    async get(key: string, type?: unknown) {
      const v = data[key];
      if (v === undefined) return null;
      const json = type === "json" || (type as { type?: string } | undefined)?.type === "json";
      return json ? v : JSON.stringify(v);
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

const env = (holdout = 0) => ({
  VARIANTS: kvWith({
    "v1:variant:demo:problem:social": STUB,
    "v1:variant:demo:problem:ai": STUB,
    "v1:variant:demo:brand:ai": STUB,
    "v1:variant:demo:problem:organic": STUB,
    "v1:variant:demo:brand:default": STUB,
    "v1:vm:demo": { v: 1, pages: {}, conv: [], h: holdout },
  }),
  DB: db,
  ENVIRONMENT: "test",
  PREVIEW_TOKEN: "",
});

async function select(query: string, e = env(), headers: Record<string, string> = {}) {
  const res = await worker.fetch(
    new Request(`https://edge.test/select?customer_id=demo&path=%2F&${query}`, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15", ...headers },
    }),
    e,
    ctx,
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("/select: source_name and tagged", () => {
  it("a LinkedIn link the customer tagged: the name and the bit", async () => {
    const b = await select(
      "ref=https%3A%2F%2Fwww.linkedin.com%2Ffeed&utm_source=linkedin&utm_medium=social&utm_campaign=launch",
    );
    expect(b.cohort).toBe("personalized");
    expect(b.source_name).toBe("linkedin");
    expect(b.tagged).toBe(true);
  });

  it("ChatGPT's own tag: named, not a tagged link", async () => {
    const b = await select("utm_source=chatgpt.com");
    expect(b.source_name).toBe("chatgpt");
    expect(b).not.toHaveProperty("tagged");
  });

  it("an unknown host: neither", async () => {
    const b = await select("ref=https%3A%2F%2Fsomeones-blog.example%2Fpost&utm_medium=social");
    expect(b).not.toHaveProperty("source_name");
  });

  it("the holdout answer carries them too (its rows are signal rows)", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64 && seen.size < 2; i++) {
      const visit = i.toString(16).padStart(32, "0");
      const b = await select(
        `ref=https%3A%2F%2Fwww.google.com%2F&utm_campaign=spring&visit=${visit}`,
        env(50),
      );
      seen.add(String(b.cohort));
      expect(b.source_name).toBe("google");
      expect(b.tagged).toBe(true);
    }
    expect(seen).toEqual(new Set(["personalized", "holdout"]));
  });

  it("never on a no-signal answer", async () => {
    const b = await select("");
    expect(b.cohort).toBe("no_signal");
    expect(b).not.toHaveProperty("source_name");
    expect(b).not.toHaveProperty("tagged");
  });
});

describe("/select with ss=1: the site's own tagged links (results-data §7)", () => {
  const OWN = "utm_source=home&utm_medium=hero&path=%2Fstart";

  it("keeps the landing's source from the carry and is not a tagged link", async () => {
    const b = await select(`${OWN}&ss=1&carry=problem:social`);
    expect(b.carried).toBe(true);
    expect((b.selection as Record<string, unknown>).source_dim).toBe("social");
    expect(b).not.toHaveProperty("tagged");
  });

  it("with no carry the page counts as no signal, never as a landing from 'home'", async () => {
    const b = await select(`${OWN}&ss=1`);
    expect(b.cohort).toBe("no_signal");
    expect(b).not.toHaveProperty("tagged");
  });

  it("without the bit the utm still make a tagged landing (an outside link)", async () => {
    const b = await select(`${OWN}&carry=problem:social`);
    expect(b.carried).toBeUndefined();
    expect(b.tagged).toBe(true);
  });
});
