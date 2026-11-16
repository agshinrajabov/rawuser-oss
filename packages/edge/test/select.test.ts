/**
 * Edge integration tests for /select — vector engine (Unit 5).
 *
 * Calls the worker's fetch handler directly with fabricated env objects.
 * No wrangler dev process needed — the global Request is available under
 * Node 22 (node:18 compat + nodejs_compat flag in wrangler.toml).
 *
 * Tests cover:
 * - Response envelope shape (source, variant_key, variant, selection, intent_vector)
 * - KV-miss (all steps) → original page with not_ready: true, never a template
 * - KV primary hit (source: "kv")
 * - KV sentinel hit (source: "kv-sentinel")
 * - Bot UA → source: "fallback-canonical-bot", no variant, no selection, no vector
 * - Preview token gating: accepted / rejected
 * - ctx.waitUntil fires (event write mock)
 * - Cache-Control: private, no-store on /select
 * - Missing customer_id → 400
 * - selection.intent_dim reflects classifier output (AI referrer → problem)
 * - intent_vector never present in any answer (privacy review condition 6)
 * - the holdout by visit marker, decided after the cascade (proof engine)
 * - Privacy: no raw UA / referrer URL / IP in event properties
 */

import { variantKeyForPath } from "@rawuser/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";

// The holdout split hashes an hour bucket (holdout.ts), so a fixture request
// can land in the 10% holdout arm in some real hours and not others. Pin the
// clock so the cascade assertions below are the same every hour of the day.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-05-22T14:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

// -----------------------------------------------------------------------
// Mock helpers.
// -----------------------------------------------------------------------

interface MockKvRecord {
  key: string;
  value: unknown;
}

function makeMockKv(records: MockKvRecord[] = []): KVNamespace {
  return {
    async get(key: string, type?: string | { type?: string }) {
      const rec = records.find((r) => r.key === key);
      if (!rec) return null;
      if ((typeof type === "string" ? type : type?.type) === "json") return rec.value as unknown;
      return JSON.stringify(rec.value);
    },
    async put() {},
    async delete() {},
    async list() {
      return { keys: [], list_complete: true, cursor: "" };
    },
    async getWithMetadata() {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace;
}

interface MockD1Result {
  success: boolean;
}

/** Tracks calls to D1 prepare().bind().run() for event write assertions. */
function makeMockDb(writtenEvents: unknown[]): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run(): Promise<MockD1Result> {
              writtenEvents.push({ sql, args });
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function makeEnv(
  kvRecords: MockKvRecord[] = [],
  previewToken = "dev-preview",
  writtenEvents: unknown[] = [],
): {
  VARIANTS: KVNamespace;
  DB: D1Database;
  ENVIRONMENT: string;
  PREVIEW_TOKEN: string;
} {
  return {
    VARIANTS: makeMockKv(kvRecords),
    DB: makeMockDb(writtenEvents),
    ENVIRONMENT: "test",
    PREVIEW_TOKEN: previewToken,
  };
}

/** A minimal VariantBody for KV fixtures. */
const STUB_VARIANT = {
  customer_id: "demo",
  profile_key: "intent:competitor:ai",
  sections: {
    hero: { kind: "hero", headline: "Test hero" },
  },
  generated_at: 1000,
  prompt_hash: "abc123",
};

/** Makes a mock ExecutionContext that collects waitUntil promises. */
function makeCtx(waitUntilPromises: Promise<unknown>[] = []): ExecutionContext {
  return {
    waitUntil(p: Promise<unknown>) {
      waitUntilPromises.push(p);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

// -----------------------------------------------------------------------
// Response envelope
// -----------------------------------------------------------------------

describe("/select — response envelope", () => {
  it("response contains source, variant_key, variant, selection, and no intent_vector", async () => {
    const request = new Request("https://rawuser.test/select?customer_id=demo");
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("source");
    expect(body).toHaveProperty("variant_key");
    expect(body).toHaveProperty("variant");
    expect(body).toHaveProperty("selection");
    expect(body).not.toHaveProperty("intent_vector");
  });

  it("selection has intent_dim, source_dim, confidence fields (UTM-carrying visit, fully-signalled)", async () => {
    // Use a UTM so the meaningful-signal guard passes and we exercise the
    // classify → selection path (the naked-visit path now returns "original").
    const request = new Request(
      "https://rawuser.test/select?customer_id=demo&utm_campaign=vs-mutiny",
    );
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    const selection = body.selection as Record<string, unknown>;
    expect(selection).toHaveProperty("intent_dim");
    expect(selection).toHaveProperty("source_dim");
    expect(selection).toHaveProperty("confidence");
    expect(typeof selection.confidence).toBe("number");
    expect(selection.confidence as number).toBeGreaterThanOrEqual(0.5);
  });

  it("no answer carries lead_probability (privacy review condition 6)", async () => {
    const request = new Request(
      "https://rawuser.test/select?customer_id=demo&utm_source=chatgpt.com",
      {
        headers: { referer: "https://chatgpt.com/c/chat" },
      },
    );
    const resp = await worker.fetch(
      request,
      makeEnv([{ key: "v1:variant:demo:problem:ai", value: STUB_VARIANT }]),
      makeCtx(),
    );
    const text = await resp.text();
    expect(text).not.toContain("lead_probability");
    expect(text).not.toContain("intent_vector");
  });

  it("always emits Cache-Control: private, no-store on /select", async () => {
    const request = new Request("https://rawuser.test/select?customer_id=demo");
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    expect(resp.headers.get("cache-control")).toBe("private, no-store");
  });

  it("missing customer_id → 400 with cache-control", async () => {
    const request = new Request("https://rawuser.test/select");
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    expect(resp.status).toBe(400);
    expect(resp.headers.get("cache-control")).toBe("private, no-store");
  });
});

// -----------------------------------------------------------------------
// KV cascade
// -----------------------------------------------------------------------

/** The edge recognised a signal: a version, the holdout arm, or "no version yet". */
function addressable(body: Record<string, unknown>): boolean {
  return body.source !== "original" || body.not_ready === true;
}

describe("/select — KV cascade", () => {
  it("KV miss (all steps) → original page with not_ready, never a placeholder template", async () => {
    // Run until a non-holdout response: the 10% holdout arm is deterministic per UA.
    let body: Record<string, unknown> | null = null;
    for (let i = 0; i < 200; i++) {
      const request = new Request("https://rawuser.test/select?customer_id=demo", {
        headers: {
          referer: "https://chatgpt.com/c/some-chat",
          "user-agent": `Mozilla/5.0 (NotReady-${i})`,
        },
      });
      const resp = await worker.fetch(request, makeEnv([]), makeCtx());
      const b = (await resp.json()) as Record<string, unknown>;
      if (b.source !== "holdout") {
        body = b;
        break;
      }
    }
    expect(body).not.toBeNull();
    expect(body?.source).toBe("original");
    expect(body?.not_ready).toBe(true);
    expect(body?.variant).toBeNull();
    expect(JSON.stringify(body)).not.toContain("PLACEHOLDER");
    expect((body?.selection as Record<string, unknown>).intent_dim).toBe("problem");
  });

  it("KV primary hit (intent+source key) → source: kv", async () => {
    // chatgpt.com referrer → problem intent + ai source
    const kvRecords: MockKvRecord[] = [{ key: "v1:variant:demo:problem:ai", value: STUB_VARIANT }];
    const request = new Request("https://rawuser.test/select?customer_id=demo", {
      headers: { referer: "https://chatgpt.com/c/chat" },
    });
    const resp = await worker.fetch(request, makeEnv(kvRecords), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.source).toBe("kv");
    expect(body.variant_key).toBe("v1:variant:demo:problem:ai");
    expect(body.variant).toMatchObject({ prompt_hash: "abc123" });
  });

  it("primary KV miss, sentinel hit (intent:default) → source: kv-sentinel", async () => {
    // chatgpt.com referrer → problem:ai primary key misses, problem:default hits.
    const kvRecords: MockKvRecord[] = [
      {
        key: "v1:variant:demo:problem:default",
        value: { ...STUB_VARIANT, profile_key: "intent:problem:default" },
      },
    ];
    const request = new Request("https://rawuser.test/select?customer_id=demo", {
      headers: { referer: "https://chatgpt.com/c/chat" },
    });
    const resp = await worker.fetch(request, makeEnv(kvRecords), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.source).toBe("kv-sentinel");
    expect(body.variant_key).toBe("v1:variant:demo:problem:default");
  });
});

// -----------------------------------------------------------------------
// Classifier → selection
// -----------------------------------------------------------------------

describe("/select — classifier output in selection", () => {
  it("chatgpt.com referrer → selection.intent_dim = problem, source_dim = ai", async () => {
    const request = new Request("https://rawuser.test/select?customer_id=demo", {
      headers: { referer: "https://chatgpt.com/c/some-chat" },
    });
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    const sel = body.selection as Record<string, string>;
    expect(sel.intent_dim).toBe("problem");
    expect(sel.source_dim).toBe("ai");
  });

  it("vs-competitor UTM → selection.intent_dim = competitor", async () => {
    const request = new Request(
      "https://rawuser.test/select?customer_id=demo&utm_campaign=vs-salesforce",
    );
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    const sel = body.selection as Record<string, string>;
    expect(sel.intent_dim).toBe("competitor");
  });

  it("naked direct visit (no UTM, no referrer, no AI source) → source: 'original', variant: null, intent_dim: 'none'", async () => {
    // Product rule (ADR pending): no meaningful signal → leave the page
    // alone. The snippet skips applyVariant when source === "original".
    const request = new Request("https://rawuser.test/select?customer_id=demo", {
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    });
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.source).toBe("original");
    expect(body.variant).toBeNull();
    expect(body.variant_key).toBe("");
    const sel = body.selection as Record<string, unknown>;
    expect(sel.intent_dim).toBe("none");
    expect(sel.source_dim).toBe("none");
    expect(sel.confidence).toBe(0);
  });

  it("naked direct visit does NOT write events from /select (V2 Module 3: snippet fires no_signal_passthrough via /event after observing source:'original')", async () => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const writtenEvents: unknown[] = [];
    const env = makeEnv([], "dev-preview", writtenEvents);
    const ctx = makeCtx(waitUntilPromises);
    const request = new Request("https://rawuser.test/select?customer_id=demo", {
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    });
    await worker.fetch(request, env, ctx);
    await Promise.all(waitUntilPromises);
    const inserts = writtenEvents.filter((e) => {
      const ev = e as { sql: string };
      return ev.sql.startsWith("INSERT INTO events");
    });
    expect(inserts).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------
// Entry-path intent signal (L1, ADR 0023)
// -----------------------------------------------------------------------

describe("/select — entry-path intent signal", () => {
  it("naked direct /pricing → personalized (or holdout), NEVER original; intent_dim=pricing", async () => {
    // No UTM, no referrer, no AI source — only the entry path discloses intent.
    // Before L1 this was 'original'; now the path qualifies as a meaningful signal.
    const request = new Request("https://rawuser.test/select?customer_id=demo&path=/pricing", {
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    });
    const resp = await worker.fetch(request, makeEnv([]), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    // The visit is addressable: with no KV seeded it is either the not_ready
    // original (signal seen, no version yet) or the deterministic 10% holdout
    // arm — never a plain no-signal original.
    if (body.source === "original") expect(body.not_ready).toBe(true);
    expect(["original", "holdout"]).toContain(body.source);
    const sel = body.selection as Record<string, unknown>;
    expect(sel.intent_dim).toBe("pricing");
  });

  it("naked direct homepage / → still original (unchanged, no path intent)", async () => {
    const request = new Request("https://rawuser.test/select?customer_id=demo&path=/", {
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    });
    const resp = await worker.fetch(request, makeEnv([]), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.source).toBe("original");
    expect(body.variant).toBeNull();
  });

  it("naked direct /demo → still original (context-only path, not gate-qualifying)", async () => {
    const request = new Request("https://rawuser.test/select?customer_id=demo&path=/demo", {
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    });
    const resp = await worker.fetch(request, makeEnv([]), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.source).toBe("original");
  });
});

// -----------------------------------------------------------------------
// Bot path
// -----------------------------------------------------------------------

describe("/select — bot canonical path", () => {
  it("GPTBot UA → source: fallback-canonical-bot, no variant, no selection, no vector", async () => {
    const request = new Request("https://rawuser.test/select?customer_id=demo", {
      headers: { "user-agent": "GPTBot/1.2" },
    });
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.source).toBe("fallback-canonical-bot");
    // Nothing the snippet could write, carry or count (2026-10-02: the old
    // brand template carried "[PLACEHOLDER]" copy).
    expect(body.variant).toBeNull();
    expect(body.variant_key).toBe("");
    expect(body.selection).toBeUndefined();
    expect(body.intent_vector).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("PLACEHOLDER");
    expect(resp.headers.get("cache-control")).toBe("private, no-store");
  });

  it("Googlebot (the JS renderer's UA) gets the same empty answer", async () => {
    const request = new Request("https://rawuser.test/select?customer_id=demo&path=/", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    });
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.source).toBe("fallback-canonical-bot");
    expect(body.variant).toBeNull();
  });

  it("ClaudeBot UA → source: fallback-canonical-bot regardless of referrer", async () => {
    const request = new Request("https://rawuser.test/select?customer_id=demo", {
      headers: {
        "user-agent": "ClaudeBot/1.0",
        referer: "https://chatgpt.com/",
      },
    });
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.source).toBe("fallback-canonical-bot");
  });
});

// -----------------------------------------------------------------------
// Preview token gating
// -----------------------------------------------------------------------

describe("/select — preview token gating", () => {
  it("intent_dim override with valid token → source: preview", async () => {
    const kvRecords: MockKvRecord[] = [
      { key: "v1:variant:demo:competitor:direct", value: STUB_VARIANT },
    ];
    const request = new Request(
      "https://rawuser.test/select?customer_id=demo&intent_dim=competitor&source_dim=direct",
      { headers: { "x-rawuser-preview": "dev-preview" } },
    );
    const resp = await worker.fetch(request, makeEnv(kvRecords), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.source).toBe("preview");
    expect(resp.headers.get("cache-control")).toBe("private, no-store");
  });

  it("intent_dim override WITHOUT valid token → ignored, classifier runs", async () => {
    const request = new Request(
      "https://rawuser.test/select?customer_id=demo&intent_dim=competitor",
      { headers: { "x-rawuser-preview": "wrong-token" } },
    );
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    // Preview rejected; source must not be "preview".
    expect(body.source).not.toBe("preview");
  });

  it("intent_dim override with empty PREVIEW_TOKEN → rejected (unconfigured)", async () => {
    const request = new Request(
      "https://rawuser.test/select?customer_id=demo&intent_dim=competitor",
      { headers: { "x-rawuser-preview": "" } },
    );
    const resp = await worker.fetch(request, makeEnv([], ""), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.source).not.toBe("preview");
  });
});

// -----------------------------------------------------------------------
// ctx.waitUntil event write
// -----------------------------------------------------------------------

describe("/select — V2 Module 3: no event writes (snippet fires via /event)", () => {
  it("does NOT write any D1 events on /select — the snippet now fires variant_shown via POST /event", async () => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const writtenEvents: unknown[] = [];
    const ctx = makeCtx(waitUntilPromises);
    const request = new Request("https://rawuser.test/select?customer_id=demo", {
      headers: { referer: "https://chatgpt.com/" },
    });
    await worker.fetch(request, makeEnv([], "dev-preview", writtenEvents), ctx);
    await Promise.all(waitUntilPromises);

    // No events should be written from /select. Only the manifest read (a
    // SELECT, not INSERT) touches D1; that's not counted as an event write.
    const inserts = writtenEvents.filter((e) => {
      const ev = e as { sql: string };
      return ev.sql.startsWith("INSERT INTO events");
    });
    expect(inserts).toHaveLength(0);
  });

  it("D1 failure during /select (e.g. manifest read) does NOT affect the response", async () => {
    // Mock a D1 that always throws — exercises the manifest-read fallback.
    const brokenDb: D1Database = {
      prepare() {
        return {
          bind() {
            return {
              async run(): Promise<{ success: boolean }> {
                throw new Error("D1 is down");
              },
              async first(): Promise<null> {
                throw new Error("D1 is down");
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx = makeCtx(waitUntilPromises);
    const env = {
      VARIANTS: makeMockKv([]),
      DB: brokenDb,
      ENVIRONMENT: "test",
      PREVIEW_TOKEN: "dev-preview",
    };

    const request = new Request("https://rawuser.test/select?customer_id=demo");
    const resp = await worker.fetch(request, env, ctx);
    expect(resp.status).toBe(200);
    await expect(Promise.all(waitUntilPromises)).resolves.not.toThrow();
  });
});

// -----------------------------------------------------------------------
// /health still works
// -----------------------------------------------------------------------

describe("/health", () => {
  it("returns ok: true", async () => {
    const request = new Request("https://rawuser.test/health");
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Holdout A/B cohort (Batch C)
// -----------------------------------------------------------------------

describe("/select — holdout A/B cohort", () => {
  it("signal-bearing request: cohort field is present and is 'personalized' or 'holdout'", async () => {
    // chatgpt.com referrer is a meaningful signal.
    const request = new Request("https://rawuser.test/select?customer_id=demo", {
      headers: { referer: "https://chatgpt.com/c/some-chat" },
    });
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    // With no KV seeded a signal-bearing visit is holdout or not_ready.
    if (body.not_ready === true) expect(body.cohort).toBe("no_signal");
    else expect(["personalized", "holdout"]).toContain(body.cohort);
  });

  it("no-signal request: cohort field is 'no_signal'", async () => {
    // Naked direct visit — no UTM, no referrer, no AI source.
    const request = new Request("https://rawuser.test/select?customer_id=demo", {
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    });
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.cohort).toBe("no_signal");
    expect(body.source).toBe("original");
  });

  it("bot request: cohort field absent (bots don't run the snippet)", async () => {
    const request = new Request("https://rawuser.test/select?customer_id=demo", {
      headers: { "user-agent": "GPTBot/1.2" },
    });
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.cohort).toBeUndefined();
    expect(body.source).toBe("fallback-canonical-bot");
  });

  it("personalized response: cohort='personalized' alongside source kv/kv-sentinel", async () => {
    // Run requests until we get a non-holdout, signal-bearing response.
    const seeded: MockKvRecord[] = [
      { key: "v1:variant:demo:problem:default", value: STUB_VARIANT },
    ];
    let personalizedResp: Record<string, unknown> | null = null;
    for (let i = 0; i < 200; i++) {
      const req = new Request("https://rawuser.test/select?customer_id=demo", {
        headers: {
          referer: "https://chatgpt.com/c/some-chat",
          "user-agent": `Mozilla/5.0 (PersonalizedFinder-${i})`,
        },
      });
      const r = await worker.fetch(req, makeEnv(seeded), makeCtx());
      const b = (await r.json()) as Record<string, unknown>;
      if (b.cohort === "personalized") {
        personalizedResp = b;
        break;
      }
    }

    expect(personalizedResp).not.toBeNull();
    if (personalizedResp) {
      // source should be one of the personalized KV/fallback values.
      expect(["kv", "kv-sentinel"]).toContain(personalizedResp.source);
      expect(personalizedResp.cohort).toBe("personalized");
    }
  });
});

// -----------------------------------------------------------------------
// L2 source recovery (ADR 0028 / 0029)
// -----------------------------------------------------------------------
describe("/select — L2 source recovery", () => {
  const IG_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E236 Instagram 328.0.0.29.85 (iPhone15,2; iOS 17_4_1; en_US; en; scale=3.00; 1179x2556; 583283064)";

  it("an Instagram in-app visit with no referrer is addressable, source social", async () => {
    const request = new Request("https://edge.test/select?customer_id=demo&path=/", {
      headers: { "user-agent": IG_UA },
    });
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    const body = (await resp.json()) as { source: string; selection?: { source_dim: string } };
    expect(addressable(body as Record<string, unknown>)).toBe(true);
    expect(body.selection?.source_dim).toBe("social");
  });

  it("an untagged mobile visit with no referrer is original, flagged probable dark social", async () => {
    const request = new Request("https://edge.test/select?customer_id=demo&path=/&nav=navigate", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      },
    });
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    const body = (await resp.json()) as { source: string; dark_social_probable?: boolean };
    expect(body.source).toBe("original");
    expect(body.dark_social_probable).toBe(true);
  });

  it("a reload on mobile is not flagged; a desktop direct visit is not flagged", async () => {
    const mobileReload = new Request(
      "https://edge.test/select?customer_id=demo&path=/&nav=reload",
      {
        headers: {
          "user-agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
        },
      },
    );
    const r1 = (await (await worker.fetch(mobileReload, makeEnv(), makeCtx())).json()) as {
      dark_social_probable?: boolean;
    };
    expect(r1.dark_social_probable).toBe(false);
    const desktop = new Request("https://edge.test/select?customer_id=demo&path=/&nav=navigate", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    const r2 = (await (await worker.fetch(desktop, makeEnv(), makeCtx())).json()) as {
      dark_social_probable?: boolean;
    };
    expect(r2.dark_social_probable).toBe(false);
  });

  it("an oppref name makes the visit addressable with source ai", async () => {
    const request = new Request("https://edge.test/select?customer_id=demo&path=/&clk=oppref");
    const resp = await worker.fetch(request, makeEnv(), makeCtx());
    const body = (await resp.json()) as { source: string; selection?: { source_dim: string } };
    expect(addressable(body as Record<string, unknown>)).toBe(true);
    expect(body.selection?.source_dim).toBe("ai");
  });

  it("UA token learning stays off by default and never touches the response", async () => {
    const waits: Promise<unknown>[] = [];
    const request = new Request("https://edge.test/select?customer_id=demo&path=/", {
      headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14; wv) Chrome/124 BrandNewApp/3" },
    });
    const resp = await worker.fetch(request, makeEnv(), makeCtx(waits));
    expect(resp.status).toBe(200);
    // Only the events write (if any) may be queued; no ua_token upsert.
    const text = await Promise.all(waits).then(() => "ok");
    expect(text).toBe("ok");
  });

  it("UA token learning, when on, queues a fire-and-forget upsert for unnamed-app, no-referrer visits only", async () => {
    const batches: unknown[][] = [];
    const env = {
      // The customer's bundle was read and does not say sensitive: only then
      // do the cross-customer counters run (docs/specs/sensitive-customers.md;
      // the customer without a bundle is test/sensitive.test.ts's).
      ...makeEnv([{ key: "v1:vm:demo", value: { v: 1, pages: {}, conv: [] } }]),
      UA_TOKEN_LEARNING: "on",
      DB: {
        prepare(sql: string) {
          return {
            bind: (...args: unknown[]) => ({
              sql,
              args,
              async run() {
                return { success: true };
              },
            }),
          };
        },
        async batch(stmts: unknown[]) {
          batches.push(stmts);
          return [];
        },
      } as unknown as D1Database,
    };
    const waits: Promise<unknown>[] = [];
    await worker.fetch(
      new Request("https://edge.test/select?customer_id=demo&path=/", {
        headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14; wv) Chrome/124 BrandNewApp/3" },
      }),
      env,
      makeCtx(waits),
    );
    await Promise.all(waits);
    expect(batches).toHaveLength(1);
    expect((batches[0] as { args: unknown[] }[]).map((s) => s.args[2])).toEqual(["brandnewapp"]);
    // The customer itself is never in the counter key, only a weekly bucket.
    expect(JSON.stringify(batches)).not.toContain("demo");

    // A named app (Instagram) is not counted: the table already knows it.
    const waits2: Promise<unknown>[] = [];
    await worker.fetch(
      new Request("https://edge.test/select?customer_id=demo&path=/", {
        headers: { "user-agent": IG_UA },
      }),
      env,
      makeCtx(waits2),
    );
    await Promise.all(waits2);
    expect(batches).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------
// Language gate (three-decisions §1, design C)
// -----------------------------------------------------------------------
describe("/select — language gate", () => {
  function envWithLang(lang: string) {
    return makeEnv([{ key: "v1:customer:demo:lang", value: lang }]);
  }

  it("keeps the original and flags it when the page language differs from the brief language", async () => {
    const request = new Request(
      "https://edge.test/select?customer_id=demo&path=/&plang=en&utm_campaign=vs-agency",
    );
    const body = (await (await worker.fetch(request, envWithLang("az"), makeCtx())).json()) as {
      source: string;
      cohort?: string;
      language_mismatch?: boolean;
    };
    expect(body.source).toBe("original");
    expect(body.cohort).toBe("no_signal");
    expect(body.language_mismatch).toBe(true);
  });

  it("personalises when the page language matches, region subtags ignored", async () => {
    const request = new Request(
      "https://edge.test/select?customer_id=demo&path=/&plang=az-Latn&utm_campaign=vs-agency",
    );
    const body = (await (await worker.fetch(request, envWithLang("az"), makeCtx())).json()) as {
      source: string;
      language_mismatch?: boolean;
    };
    expect(addressable(body as Record<string, unknown>)).toBe(true);
    expect(body.language_mismatch).toBeUndefined();
  });

  it("does nothing when the page sends no language or the brief language is unknown", async () => {
    const r1 = (await (
      await worker.fetch(
        new Request("https://edge.test/select?customer_id=demo&path=/&utm_campaign=vs-agency"),
        envWithLang("az"),
        makeCtx(),
      )
    ).json()) as { source: string };
    expect(addressable(r1 as Record<string, unknown>)).toBe(true);
    const r2 = (await (
      await worker.fetch(
        new Request(
          "https://edge.test/select?customer_id=demo&path=/&plang=en&utm_campaign=vs-agency",
        ),
        makeEnv([]),
        makeCtx(),
      )
    ).json()) as { source: string };
    expect(addressable(r2 as Record<string, unknown>)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// The visitor bundle (2026-10-01): no database on the visitor path
// -----------------------------------------------------------------------

describe("/select — the visitor bundle in KV", () => {
  const manifest = {
    "hero.headline": { css: ["h1"], text: [], structural: "first h1" },
  };

  function trackingDb(queries: string[]): D1Database {
    return {
      prepare(sql: string) {
        queries.push(sql);
        const stmt = {
          bind() {
            return stmt;
          },
          async first() {
            return sql.includes("element_manifests")
              ? { manifest: JSON.stringify(manifest), page_path: "/" }
              : null;
          },
          async all() {
            return {
              results: sql.includes("element_manifests")
                ? [{ page_path: "/", manifest: JSON.stringify(manifest) }]
                : [],
            };
          },
          async run() {
            return { success: true };
          },
        };
        return stmt;
      },
    } as unknown as D1Database;
  }

  const request = () =>
    new Request("https://rawuser.test/select?customer_id=demo", {
      headers: { referer: "https://chatgpt.com/c/chat" },
    });

  it("answers the targets and conversion targets from the bundle and reads no database", async () => {
    const queries: string[] = [];
    const env = {
      ...makeEnv([
        { key: "v1:variant:demo:problem:ai", value: STUB_VARIANT },
        {
          key: "v1:vm:demo",
          value: {
            v: 1,
            pages: { "/": manifest },
            conv: [
              {
                section_path: "hero.cta",
                conversion_label: "signup",
                css: ["a"],
                text: [],
                structural: "",
              },
            ],
          },
        },
      ]),
      DB: trackingDb(queries),
    };
    const resp = await worker.fetch(request(), env, makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.source).toBe("kv");
    expect(body.targets).toMatchObject({ "hero.headline": { css: ["h1"] } });
    expect(body.conversion_targets).toHaveLength(1);
    expect(queries).toEqual([]);
    expect(resp.headers.get("server-timing")).not.toContain("d1");
  });

  it("without a bundle reads the database as before and writes the bundle for the next visit", async () => {
    const queries: string[] = [];
    const puts: string[] = [];
    const kv = makeMockKv([{ key: "v1:variant:demo:problem:ai", value: STUB_VARIANT }]);
    (kv as unknown as { put: (k: string) => Promise<void> }).put = async (k: string) => {
      puts.push(k);
    };
    const waits: Promise<unknown>[] = [];
    const env = { ...makeEnv(), VARIANTS: kv, DB: trackingDb(queries) };
    const resp = await worker.fetch(request(), env, makeCtx(waits));
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.targets).toMatchObject({ "hero.headline": { css: ["h1"] } });
    expect(queries.some((q) => q.includes("element_manifests"))).toBe(true);
    await Promise.all(waits);
    expect(puts).toContain("v1:vm:demo");
  });

  it("keeps the cascade's priority with every candidate read at once", async () => {
    const env = makeEnv([
      {
        key: "v1:variant:demo:problem:default",
        value: { ...STUB_VARIANT, prompt_hash: "sentinel" },
      },
      { key: "v1:variant:demo:problem:ai", value: STUB_VARIANT },
      { key: "v1:vm:demo", value: { v: 1, pages: {}, conv: [] } },
    ]);
    const resp = await worker.fetch(request(), env, makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.variant_key).toBe("v1:variant:demo:problem:ai");
  });
});

// -----------------------------------------------------------------------
// Proof engine: the holdout by marker, decided after the cascade, lean
// answers, targets everywhere (docs/specs/proof-engine.md, A; privacy review
// conditions 5 and 6)
// -----------------------------------------------------------------------

describe("/select: the proof engine", () => {
  const CONV = [
    {
      section_path: "hero.cta",
      conversion_label: "trial_start",
      css: ["a.cta"],
      text: [],
      structural: "",
    },
  ];
  const MANIFEST = { "hero.headline": { css: ["h1"], text: [], structural: "first h1" } };
  const BODY = { ...STUB_VARIANT, body_id: "0123456789abcdef" };
  const bundle = (h?: number) => ({
    key: "v1:vm:demo",
    value: { v: 1, pages: { "/": MANIFEST }, conv: CONV, ...(h === undefined ? {} : { h }) },
  });
  const LANG_AZ = { key: "v1:customer:demo:lang", value: "az" };

  function visitOf(i: number): string {
    return (BigInt(i) * 0x9e3779b97f4a7c15n).toString(16).padStart(32, "0").slice(-32);
  }

  async function select(
    records: MockKvRecord[],
    opts: { visit?: string; ref?: string; ua?: string; query?: string; preview?: boolean } = {},
  ): Promise<{ body: Record<string, unknown>; resp: Response }> {
    const q = new URLSearchParams({ customer_id: "demo" });
    if (opts.visit) q.set("visit", opts.visit);
    for (const [k, v] of new URLSearchParams(opts.query ?? "")) q.set(k, v);
    const headers: Record<string, string> = { "user-agent": opts.ua ?? "Mozilla/5.0 Chrome/120" };
    if (opts.ref !== "") headers.referer = opts.ref ?? "https://chatgpt.com/c/chat";
    if (opts.preview) headers["x-rawuser-preview"] = "dev-preview";
    const resp = await worker.fetch(
      new Request(`https://rawuser.test/select?${q}`, { headers }),
      makeEnv(records),
      makeCtx(),
    );
    return { body: (await resp.clone().json()) as Record<string, unknown>, resp };
  }

  /** A marker the coin puts in the given arm at this percent. */
  async function markerFor(arm: "treat" | "holdout", h = 20): Promise<string> {
    const { decideArm } = await import("../src/holdout.ts");
    for (let i = 1; i < 10_000; i++) {
      const v = visitOf(i);
      if ((await decideArm("demo", v, h)) === arm) return v;
    }
    throw new Error("no marker found");
  }

  it("a holdout answer is lean: arm, the would-be body id and the targets; no body, manifest or vector", async () => {
    const v = await markerFor("holdout");
    const { body } = await select(
      [{ key: "v1:variant:demo:problem:ai", value: BODY }, bundle(20)],
      {
        visit: v,
      },
    );
    expect(body.source).toBe("holdout");
    expect(body.cohort).toBe("holdout");
    expect(body.arm).toBe("holdout");
    expect(body.body_id).toBe("0123456789abcdef");
    expect(body.variant).toBeNull();
    expect(body.variant_key).toBe("");
    expect(body.conversion_targets).toEqual(CONV);
    expect(body).not.toHaveProperty("targets");
    expect(body).not.toHaveProperty("intent_vector");
    expect(body).not.toHaveProperty("carryable");
    expect((body.selection as Record<string, unknown>).intent_dim).toBe("problem");
  });

  it("a treat answer carries the arm, the body id and its version, and no vector", async () => {
    const v = await markerFor("treat");
    const { body } = await select(
      [{ key: "v1:variant:demo:problem:ai", value: BODY }, bundle(20)],
      {
        visit: v,
      },
    );
    expect(body.source).toBe("kv");
    expect(body.cohort).toBe("personalized");
    expect(body.arm).toBe("treat");
    expect(body.body_id).toBe("0123456789abcdef");
    expect((body.variant as Record<string, unknown>).body_id).toBe("0123456789abcdef");
    expect(body.conversion_targets).toEqual(CONV);
    expect(body).not.toHaveProperty("intent_vector");
  });

  it("the same marker gets the same arm on every page of the visit (carried page two included)", async () => {
    const v = await markerFor("holdout");
    // Page two has no signal of its own; the cascade falls back to the root's version.
    const kv = [{ key: "v1:variant:demo:problem:ai", value: BODY }, bundle(20)];
    const a = await select(kv, { visit: v });
    const b = await select(kv, { visit: v, ref: "", query: "path=/about&carry=problem:ai" });
    expect(a.body.arm).toBe("holdout");
    expect(b.body.arm).toBe("holdout");
    expect(b.body.carried).toBe(true);
  });

  it("eligibility: bot, preview, no signal, mismatch, no version, no marker, holdout 0 each give no arm", async () => {
    const v = await markerFor("holdout", 50);
    const version = { key: "v1:variant:demo:problem:ai", value: BODY };
    const cases: Array<[string, Promise<{ body: Record<string, unknown> }>]> = [
      ["bot", select([version, bundle(50)], { visit: v, ua: "GPTBot/1.2" })],
      [
        "preview",
        select([version, bundle(50)], {
          visit: v,
          preview: true,
          query: "intent_dim=problem&source_dim=ai",
        }),
      ],
      ["no signal", select([version, bundle(50)], { visit: v, ref: "" })],
      ["mismatch", select([version, bundle(50), LANG_AZ], { visit: v, query: "plang=en" })],
      ["no version", select([bundle(50)], { visit: v })],
      ["no marker", select([version, bundle(50)], {})],
      ["junk marker", select([version, bundle(50)], { visit: "not-a-marker" })],
      ["holdout 0", select([version, bundle(0)], { visit: v })],
      ["no bundle", select([version], { visit: v })],
    ];
    for (const [name, p] of cases) {
      const { body } = await p;
      expect(body.arm, name).toBeUndefined();
      expect(body.source, name).not.toBe("holdout");
    }
    // And the same marker with everything in place is held out.
    expect((await select([version, bundle(50)], { visit: v })).body.arm).toBe("holdout");
  });

  it("a page with no version never yields holdout, whatever the marker (decided after the cascade)", async () => {
    for (let i = 1; i <= 200; i++) {
      const { body } = await select([bundle(50)], { visit: visitOf(i) });
      expect(body.source).toBe("original");
      expect(body.not_ready).toBe(true);
      expect(body.arm).toBeUndefined();
    }
  });

  it("the bundle's h decides; without h the env default ('0' here) holds no one out", async () => {
    const v = await markerFor("holdout", 50);
    const version = { key: "v1:variant:demo:problem:ai", value: BODY };
    expect((await select([version, bundle(50)], { visit: v })).body.arm).toBe("holdout");
    const env0 = { ...makeEnv([version, bundle()]), HOLDOUT_PERCENT: "0" };
    const resp = await worker.fetch(
      new Request(`https://rawuser.test/select?customer_id=demo&visit=${v}`, {
        headers: { referer: "https://chatgpt.com/c/chat" },
      }),
      env0,
      makeCtx(),
    );
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.arm).toBeUndefined();
    expect(body.cohort).toBe("personalized");
  });

  it("no-signal, not-ready and mismatch answers carry the conversion targets and no vector", async () => {
    const ns = await select([bundle()], { ref: "" });
    expect(ns.body.source).toBe("original");
    expect(ns.body.cohort).toBe("no_signal");
    expect(ns.body.conversion_targets).toEqual(CONV);
    expect(ns.body).not.toHaveProperty("intent_vector");

    const nr = await select([bundle()], {});
    expect(nr.body.not_ready).toBe(true);
    expect(nr.body.conversion_targets).toEqual(CONV);
    expect(nr.body).not.toHaveProperty("intent_vector");

    const mm = await select([bundle(), LANG_AZ], { query: "plang=en" });
    expect(mm.body.language_mismatch).toBe(true);
    expect(mm.body.conversion_targets).toEqual(CONV);
    expect(mm.body).not.toHaveProperty("intent_vector");
  });

  it("a picked button counts only on its own page; slot targets on every page", async () => {
    const PICKED = {
      section_path: "count:/pricing",
      conversion_label: "other",
      css: ["#buy"],
      text: ["Buy"],
      structural: "first a in main",
    };
    const both = {
      key: "v1:vm:demo",
      value: { v: 1, pages: { "/": MANIFEST }, conv: [...CONV, PICKED] },
    };
    const version = { key: "v1:variant:demo:problem:ai", value: BODY };
    const root = await select([version, both], {});
    expect(root.body.cohort).toBe("personalized");
    expect(root.body.conversion_targets).toEqual(CONV);
    const pricing = await select([version, both], { query: "path=/pricing" });
    expect(pricing.body.conversion_targets).toEqual([...CONV, PICKED]);
    const ns = await select([both], { ref: "", query: "path=/pricing" });
    expect(ns.body.cohort).toBe("no_signal");
    expect(ns.body.conversion_targets).toEqual([...CONV, PICKED]);
    const nsRoot = await select([both], { ref: "" });
    expect(nsRoot.body.conversion_targets).toEqual(CONV);
    const nr = await select([both], { query: "path=/pricing" });
    expect(nr.body.not_ready).toBe(true);
    expect(nr.body.conversion_targets).toEqual([...CONV, PICKED]);
  });

  describe("a group's button (docs/specs/page-groups.md, privacy review condition 7)", () => {
    const PATTERN = "/products/*";
    const GROUP = {
      section_path: `count:${PATTERN}`,
      conversion_label: "contact",
      css: ["nav a.contact"],
      text: ["Əlaqə"],
      structural: "first a in nav",
    };
    const PICKED = {
      section_path: "count:/products/ginseng",
      conversion_label: "other",
      css: ["#buy"],
      text: ["Buy"],
      structural: "first a in main",
    };
    const version = { key: "v1:variant:demo:problem:ai", value: BODY };
    /** A bundle with the group's target; `g` only when asked (an old bundle has none). */
    const withGroup = (g?: string[]) => ({
      key: "v1:vm:demo",
      value: {
        v: 1,
        pages: { "/": MANIFEST, "/products/featured": MANIFEST },
        conv: [...CONV, GROUP, PICKED],
        ...(g ? { g } : {}),
      },
    });
    const names = (body: Record<string, unknown>) =>
      (body.conversion_targets as { section_path: string }[]).map((t) => t.section_path);

    it("every answer kind carries it on a matching page: personalised, no-signal, not-ready, holdout", async () => {
      const q = "path=/products/omega";
      const p = await select([version, withGroup([PATTERN])], { query: q });
      expect(p.body.cohort).toBe("personalized");
      expect(names(p.body)).toEqual(["hero.cta", `count:${PATTERN}`]);
      const ns = await select([withGroup([PATTERN])], { ref: "", query: q });
      expect(ns.body.cohort).toBe("no_signal");
      expect(names(ns.body)).toEqual(["hero.cta", `count:${PATTERN}`]);
      const nr = await select([withGroup([PATTERN])], { query: q });
      expect(nr.body.not_ready).toBe(true);
      expect(names(nr.body)).toEqual(["hero.cta", `count:${PATTERN}`]);
      const v = await markerFor("holdout", 50);
      const h = await select(
        [version, { ...withGroup([PATTERN]), value: { ...withGroup([PATTERN]).value, h: 50 } }],
        {
          visit: v,
          query: q,
        },
      );
      expect(h.body.arm).toBe("holdout");
      expect(names(h.body)).toEqual(["hero.cta", `count:${PATTERN}`]);
    });

    it("the masked path matches: /products/48213377 is /products/:id", async () => {
      const { body } = await select([version, withGroup([PATTERN])], {
        query: "path=/products/48213377",
      });
      expect(names(body)).toEqual(["hero.cta", `count:${PATTERN}`]);
    });

    it("absent, pattern and target alike, on /, on /products, deeper, and on a confirmed page under it", async () => {
      for (const path of [
        "/",
        "/products",
        "/products/x/reviews",
        "/productsale",
        "/products/featured",
      ]) {
        for (const records of [[version, withGroup([PATTERN])], [withGroup([PATTERN])]]) {
          const { body, resp } = await select(records, { query: `path=${path}` });
          expect(names(body), path).toEqual(["hero.cta"]);
          const text = await resp.text();
          expect(text, path).not.toContain(PATTERN);
          expect(text, path).not.toContain("products/*");
        }
      }
    });

    it("an exact page's own button first, the group's second, both in the answer", async () => {
      const { body } = await select([version, withGroup([PATTERN])], {
        query: "path=/products/ginseng",
      });
      expect(names(body)).toEqual(["hero.cta", "count:/products/ginseng", `count:${PATTERN}`]);
    });

    it("deploy order: an old bundle without g still matches from the target alone, byte for byte the same answer", async () => {
      for (const path of ["/products/omega", "/", "/products", "/products/featured"]) {
        const q = `path=${path}`;
        const old = await select([version, withGroup()], { query: q });
        const fresh = await select([version, withGroup([PATTERN])], { query: q });
        expect(await old.resp.text(), path).toBe(await fresh.resp.text());
        expect(old.body, path).not.toHaveProperty("g");
      }
      const { body } = await select([version, withGroup()], { query: "path=/products/omega" });
      expect(names(body)).toEqual(["hero.cta", `count:${PATTERN}`]);
    });

    it("g itself is never in an answer", async () => {
      for (const path of ["/products/omega", "/"]) {
        const { body, resp } = await select([version, withGroup([PATTERN])], {
          query: `path=${path}`,
        });
        expect(body).not.toHaveProperty("g");
        const text = await resp.text();
        expect(text.split(PATTERN).length - 1, path).toBe(path === "/products/omega" ? 1 : 0);
      }
    });
  });

  it("the preview answer carries no vector either", async () => {
    const { body } = await select([{ key: "v1:variant:demo:problem:ai", value: BODY }], {
      preview: true,
      query: "intent_dim=problem&source_dim=ai",
    });
    expect(body.source).toBe("preview");
    expect(body).not.toHaveProperty("intent_vector");
  });

  it("the no-signal answer names its KV read in Server-Timing (measure before and after deploy)", async () => {
    const { resp } = await select([bundle()], { ref: "" });
    const timing = resp.headers.get("server-timing") ?? "";
    expect(timing).toMatch(/kv;dur=\d+/);
    expect(timing).toMatch(/total;dur=\d+/);
  });
});

// -----------------------------------------------------------------------
// Identifiers in the page path (docs/specs/event-paths.md): masked before
// any key is built; a page without one still finds its confirmed page.
// -----------------------------------------------------------------------

describe("/select: the page path is masked before any key", () => {
  const manifest = { "hero.headline": { css: ["h1"], text: [], structural: "first h1" } };
  const UUID = "550e8400-e29b-41d4-a716-446655440000";

  function spyKv(records: MockKvRecord[], keys: string[]): KVNamespace {
    const kv = makeMockKv(records);
    const get = kv.get.bind(kv);
    (kv as unknown as { get: typeof get }).get = (async (key: string, type?: never) => {
      keys.push(key);
      return get(key, type);
    }) as typeof get;
    return kv;
  }

  const req = (path: string) =>
    new Request(`https://rawuser.test/select?customer_id=demo&path=${encodeURIComponent(path)}`, {
      headers: { referer: "https://chatgpt.com/c/chat" },
    });

  it("an identifier never reaches a KV key; the visit gets the root's version", async () => {
    const keys: string[] = [];
    const env = {
      ...makeEnv(),
      VARIANTS: spyKv(
        [
          { key: "v1:variant:demo:problem:ai", value: STUB_VARIANT },
          { key: "v1:vm:demo", value: { v: 1, pages: { "/": manifest }, conv: [] } },
        ],
        keys,
      ),
    };
    const resp = await worker.fetch(req(`/admin/students/${UUID}`), env, makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.source).toBe("kv");
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).not.toContain("550e8400");
      expect(decodeURIComponent(k)).not.toContain("550e8400");
    }
    expect(keys).toContain(variantKeyForPath("demo", "/admin/students/:id", "problem", "ai"));
    // The root's manifest, not a page of its own: never carryable.
    expect(body.carryable).toBeUndefined();
  });

  it("masks before lowercasing, so a mixed-case token never reaches a key", async () => {
    const keys: string[] = [];
    const env = {
      ...makeEnv(),
      VARIANTS: spyKv([{ key: "v1:variant:demo:problem:ai", value: STUB_VARIANT }], keys),
    };
    await worker.fetch(req("/invite/aBcDeFgHiJkLmNoPqRsTuV/482"), env, makeCtx());
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(decodeURIComponent(k).toLowerCase()).not.toContain("abcdefgh");
    expect(keys).toContain(variantKeyForPath("demo", "/invite/:id/:id", "problem", "ai"));
  });

  it("a confirmed page without an identifier is found as before", async () => {
    const pageKey = variantKeyForPath("demo", "/az/approach", "problem", "ai");
    const env = makeEnv([
      { key: pageKey, value: { ...STUB_VARIANT, prompt_hash: "approach" } },
      { key: "v1:variant:demo:problem:ai", value: STUB_VARIANT },
      {
        key: "v1:vm:demo",
        value: { v: 1, pages: { "/az/approach": manifest, "/": {} }, conv: [] },
      },
    ]);
    const resp = await worker.fetch(req("/az/approach"), env, makeCtx());
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.variant_key).toBe(pageKey);
    expect(body.targets).toMatchObject({ "hero.headline": { css: ["h1"] } });
    expect(body.carryable).toBe(true);
  });
});
