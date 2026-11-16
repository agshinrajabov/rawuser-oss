import { describe, expect, it } from "vitest";
import worker, { parseCarry } from "../src/index.ts";
import { forgetCopy } from "../src/kv-copy.ts";

const STUB = {
  customer_id: "demo",
  profile_key: "x",
  sections: { hero: { kind: "hero", headline: "H" } },
  generated_at: 0,
  prompt_hash: "p",
};
function kvWith(data: Record<string, unknown>) {
  return {
    async get(key: string, type?: string) {
      const v = data[key];
      if (v === undefined) return null;
      return type === "json" ? v : JSON.stringify(v);
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

describe("parseCarry", () => {
  it("accepts only known dimensions", () => {
    expect(parseCarry("evaluation:social")).toEqual({
      intent_dim: "evaluation",
      source_dim: "social",
    });
    expect(parseCarry("nope:social")).toBeNull();
    expect(parseCarry("evaluation:ai;drop")).toBeNull();
    expect(parseCarry(null)).toBeNull();
  });
});

describe("/select with a carry and no signal of its own", () => {
  it("serves the carried selection and says so; without a carry the original", async () => {
    const env = {
      VARIANTS: kvWith({ "v1:variant:demo:evaluation:social": STUB }),
      DB: db,
      ENVIRONMENT: "test",
      PREVIEW_TOKEN: "",
    };
    let body: Record<string, unknown> | null = null;
    for (let i = 0; i < 200; i++) {
      const res = await worker.fetch(
        new Request("https://edge.test/select?customer_id=demo&path=%2F&carry=evaluation:social", {
          headers: { "user-agent": `Mozilla/5.0 (Carry-${i})` },
        }),
        env,
        ctx,
      );
      const b = (await res.json()) as Record<string, unknown>;
      if (b.source !== "holdout") {
        body = b;
        break;
      }
    }
    expect(body?.source).toBe("kv");
    expect(body?.carried).toBe(true);
    expect((body?.selection as Record<string, unknown>).intent_dim).toBe("evaluation");

    const plain = await worker.fetch(
      new Request("https://edge.test/select?customer_id=demo&path=%2F", {
        headers: { "user-agent": "Mozilla/5.0" },
      }),
      env,
      ctx,
    );
    expect(((await plain.json()) as Record<string, unknown>).source).toBe("original");
  });

  it("a page with its own signal ignores the carry", async () => {
    const env = {
      VARIANTS: kvWith({
        "v1:variant:demo:problem:ai": STUB,
        "v1:variant:demo:evaluation:social": STUB,
      }),
      DB: db,
      ENVIRONMENT: "test",
      PREVIEW_TOKEN: "",
    };
    let body: Record<string, unknown> | null = null;
    for (let i = 0; i < 200; i++) {
      const res = await worker.fetch(
        new Request("https://edge.test/select?customer_id=demo&path=%2F&carry=evaluation:social", {
          headers: { "user-agent": `Mozilla/5.0 (Own-${i})`, referer: "https://chatgpt.com/c/x" },
        }),
        env,
        ctx,
      );
      const b = (await res.json()) as Record<string, unknown>;
      if (b.source !== "holdout") {
        body = b;
        break;
      }
    }
    expect((body?.selection as Record<string, unknown>).source_dim).toBe("ai");
    expect(body?.carried).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Path pages keep the carried source (docs/specs/session-carry.md, measure-lab
// 2026-10-05): a ChatGPT visit that clicked to /pricing was re-classified
// pricing:direct and carried that to every later page.
// ---------------------------------------------------------------------------

/** Every version exists, so the selection alone decides what is served. */
const anyVersion = {
  async get(key: string, type?: unknown) {
    if (!key.startsWith("v1:variant:demo")) return null;
    return type === "json" || (type as { type?: string } | undefined)?.type === "json"
      ? STUB
      : JSON.stringify(STUB);
  },
  async put() {},
  async delete() {},
} as unknown as KVNamespace;
const anyEnv = { VARIANTS: anyVersion, DB: db, ENVIRONMENT: "test", PREVIEW_TOKEN: "" };

type Answer = {
  source: string;
  carried?: boolean;
  selection: { intent_dim: string; source_dim: string };
};

/** One /select, past any holdout draw. */
async function select(query: string, headers: Record<string, string> = {}): Promise<Answer> {
  for (let i = 0; i < 200; i++) {
    const res = await worker.fetch(
      new Request(`https://edge.test/select?customer_id=demo&self_host=site.test&${query}`, {
        headers: { "user-agent": `Mozilla/5.0 (Path-${i})`, ...headers },
      }),
      anyEnv,
      ctx,
    );
    const b = (await res.json()) as Answer;
    if (b.source !== "holdout") return b;
  }
  throw new Error("every draw was a holdout");
}
const pair = (a: Answer) => `${a.selection.intent_dim}:${a.selection.source_dim}`;

describe("/select on a page whose only signal is its path", () => {
  it("ChatGPT, then /pricing: the path moves the intent, the source stays ai", async () => {
    const b = await select("path=%2Fpricing&ss=1&carry=problem:ai");
    expect(pair(b)).toBe("pricing:ai");
    expect(b.carried).toBe(true);
  });

  it("the site's own utm on a same-site link to /pricing changes nothing (ss=1)", async () => {
    const b = await select("path=%2Fpricing&ss=1&utm_source=home&carry=problem:ai");
    expect(pair(b)).toBe("pricing:ai");
    expect(b.carried).toBe(true);
  });

  it("a path with no carry is classified on its own, as before", async () => {
    const b = await select("path=%2Fpricing");
    expect(pair(b)).toBe("pricing:direct");
    expect(b.carried).toBeUndefined();
  });

  it("a context-only path (/demo) is no signal: the carried pair, whole", async () => {
    const b = await select("path=%2Fdemo&ss=1&carry=problem:ai");
    expect(pair(b)).toBe("problem:ai");
    expect(b.carried).toBe(true);
  });

  it("a new utm on page two still wins", async () => {
    const b = await select("path=%2Fpricing&utm_source=linkedin&carry=problem:ai");
    expect(b.selection.source_dim).toBe("social");
    expect(b.carried).toBeUndefined();
  });

  it("a referrer from another site on page two still wins", async () => {
    const b = await select(
      `path=%2Fpricing&ref=${encodeURIComponent("https://news.ycombinator.com")}&carry=problem:ai`,
    );
    expect(b.selection.source_dim).toBe("community");
    expect(b.carried).toBeUndefined();
  });

  it("a click-id name on page two still wins", async () => {
    const b = await select("path=%2Fpricing&clk=gclid&carry=problem:ai");
    expect(b.selection.source_dim).toBe("paid");
    expect(b.carried).toBeUndefined();
  });

  it("the whole visit: ChatGPT on /, then /pricing, then / again keeps the landing's pair", async () => {
    // The snippet's rule (index.ts): it writes the carry only from an answer
    // that is not itself carried.
    let carry: string | null = null;
    const visit = async (query: string) => {
      const b = await select(carry ? `${query}&carry=${carry}` : query);
      if (b.source !== "original" && b.selection.intent_dim !== "none" && !b.carried) {
        carry = pair(b);
      }
      return b;
    };
    const landing = await visit("path=%2F&utm_source=chatgpt.com");
    expect(landing.selection.source_dim).toBe("ai");
    const landed = pair(landing);

    const pricing = await visit("path=%2Fpricing&ss=1");
    expect(pair(pricing)).toBe("pricing:ai");
    expect(carry).toBe(landed);

    const home = await visit("path=%2F&ss=1");
    expect(pair(home)).toBe(landed);
    expect(home.carried).toBe(true);

    // A later page with no signal carries the landing's source, never direct.
    const about = await visit("path=%2Fabout&ss=1");
    expect(pair(about)).toBe(landed);
  });
});

// The customer's "carry: off" holds at the edge too: a tab on a cached
// /s/{id}.js from before the switch still sends carry=, and is not carried
// (the privacy review's note, 2026-10-05).
describe("/select ignores carry= when the customer turned the carry off", () => {
  /** Each read with the batch it started in (reads in flight together share one). */
  const reads: Array<{ key: string; batch: number }> = [];
  let inFlight = 0;
  let batch = 0;
  const offKv = {
    async get(key: string, type?: unknown) {
      if (inFlight === 0) batch++;
      inFlight++;
      reads.push({ key, batch });
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
      if (key === "v1:carry-off:demo") return "1";
      if (!key.startsWith("v1:variant:demo")) return null;
      return type === "json" || (type as { type?: string } | undefined)?.type === "json"
        ? STUB
        : JSON.stringify(STUB);
    },
    async put() {},
    async delete() {},
  } as unknown as KVNamespace;
  const offEnv = { VARIANTS: offKv, DB: db, ENVIRONMENT: "test", PREVIEW_TOKEN: "" };
  const ask = async (query: string) => {
    const res = await worker.fetch(
      new Request(`https://edge.test/select?customer_id=demo&self_host=site.test&${query}`, {
        headers: { "user-agent": "Mozilla/5.0 (Off)" },
      }),
      offEnv,
      ctx,
    );
    return (await res.json()) as Answer & { carry_off?: boolean };
  };

  it("a page with no signal of its own shows the original and says carry_off", async () => {
    const b = await ask("path=%2F&ss=1&carry=problem:ai");
    expect(b.source).toBe("original");
    expect(b.carried).toBeUndefined();
    expect(b.carry_off).toBe(true);
    expect(b.selection.intent_dim).toBe("none");
  });

  it("a path page is classified on its own, without the carried source", async () => {
    const b = await ask("path=%2Fpricing&ss=1&carry=problem:ai");
    expect(pair(b)).toBe("pricing:direct");
    expect(b.carried).toBeUndefined();
    expect(b.carry_off).toBe(true);
  });

  it("the switch costs no second round trip: one batch reads both selections", async () => {
    // The earlier asks left the switch in this isolate's copy (kv-copy.ts):
    // start from KV, as a cold location does.
    forgetCopy(offKv);
    reads.length = 0;
    await ask("path=%2Fpricing&ss=1&carry=problem:ai");
    // The switch, the carried versions and the page's own versions are read
    // in flight together, and nothing is read after them.
    const off = reads.find((r) => r.key === "v1:carry-off:demo");
    const carriedRead = reads.find((r) => r.key.endsWith(":pricing:ai"));
    const ownRead = reads.find((r) => r.key.endsWith(":pricing:default"));
    expect(off).toBeDefined();
    expect(carriedRead?.batch).toBe(off?.batch);
    expect(ownRead?.batch).toBe(off?.batch);
    expect(reads.every((r) => r.batch === off?.batch)).toBe(true);
  });
});
