/**
 * Tests for cron/ops-heartbeat.ts (A2).
 *
 * The heartbeat is the alarm layer over a silent-failure system, so the
 * tests assert exactly the four behaviors that matter: healthy = quiet,
 * broken = one alert, repeated = deduped, billing failure = critical
 * even at low counts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeartbeatEnv } from "../../src/cron/ops-heartbeat.ts";
import { runOpsHeartbeat } from "../../src/cron/ops-heartbeat.ts";
import { MODEL_ENV, MODEL_ENV_WITH_FALLBACK, SPARE_MODEL_ID } from "../model-env.ts";

interface WebhookCall {
  url: string;
  method: string;
  body: string | null;
}

function makeEnv(opts: {
  errorGroups?: Array<{ error_reason: string | null; n: number }>;
  edgeStatus?: number | "unreachable";
  webhookUrl?: string;
  /** HTTP status the webhook answers with (default 200). */
  webhookStatus?: number;
  /** Set to ping the writing service: the primary's HTTP status, or "hang" for a timeout. */
  primary?: number | "hang";
  /** The fallback model's answer: default 200 naming itself; a status, "hang", or { served } for a reroute. */
  fallback?: number | "hang" | { served: string };
  /** The spare route: "ok" answers, "fail" throws; absent means no binding. */
  spare?: "ok" | "fail";
  /** Model vars laid over the ones the options above choose. */
  model?: Record<string, string | undefined>;
  /** manifest_health rows with parts the live page no longer has. */
  missing?: Array<{ customer_id: string; page_path: string; missing: string }>;
  /** Per customer: all versions and the provider-shaped failures among them. */
  shares?: Array<{ customer_id: string; total: number; failed: number }>;
  /** Versions the copy checks refused ("lint: …"), with their key and body id when given. */
  refused?: Array<string | { error_reason: string; kv_key?: string; body_id?: string | null }>;
  /** KV values present before the run (variant bodies). */
  kvSeed?: Record<string, string>;
}): {
  env: HeartbeatEnv;
  webhookCalls: WebhookCall[];
  kv: Map<string, string>;
  /** Every ping of the endpoint: its address, headers and parsed body. */
  pings: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;
  /** Every run on the spare route: the model and the input. */
  spareRuns: Array<{ model: string; input: Record<string, unknown> }>;
} {
  const kv = new Map<string, string>(Object.entries(opts.kvSeed ?? {}));
  const webhookCalls: WebhookCall[] = [];
  const pings: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  const spareRuns: Array<{ model: string; input: Record<string, unknown> }> = [];

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/health")) {
      if (opts.edgeStatus === "unreachable") throw new Error("connect timeout");
      return new Response("{}", { status: opts.edgeStatus ?? 200 });
    }
    if (url.includes("models.example")) {
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      pings.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body });
      const asked = typeof body.model === "string" ? body.model : "";
      const isFallback = asked === MODEL_ENV_WITH_FALLBACK.MODEL_FALLBACK_ID;
      const mode = isFallback ? (opts.fallback ?? 200) : opts.primary;
      if (mode === "hang") {
        const e = new Error("signal timed out");
        e.name = "TimeoutError";
        throw e;
      }
      if (typeof mode === "object") {
        return new Response(JSON.stringify({ model: mode.served }), { status: 200 });
      }
      return new Response(JSON.stringify({ model: asked }), { status: mode ?? 200 });
    }
    webhookCalls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    const status = opts.webhookStatus ?? 200;
    return status === 200
      ? new Response("ok", { status })
      : new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), {
          status,
        });
  });

  const env: HeartbeatEnv = {
    DB: {
      prepare: (sql: string) => ({
        bind() {
          return this;
        },
        // The count of written rows with a part left as built: none here
        // (test/cron/lint-shares.test.ts runs the real statements).
        first: async () => null,
        all: async () => ({
          results: sql.trim().startsWith("SELECT id FROM customers")
            ? []
            : sql.includes("manifest_health")
              ? (opts.missing ?? [])
              : sql.includes("GROUP BY customer_id")
                ? (opts.shares ?? [])
                : sql.includes("error_reason LIKE 'lint:%'") && !sql.includes("NOT LIKE")
                  ? (opts.refused ?? []).map((r) =>
                      typeof r === "string" ? { error_reason: r } : r,
                    )
                  : (opts.errorGroups ?? []),
        }),
      }),
    } as unknown as D1Database,
    VARIANTS: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
      async delete(key: string) {
        kv.delete(key);
      },
    } as unknown as KVNamespace,
    ALERT_WEBHOOK_URL: opts.webhookUrl,
    // Where the edge answers: its /health is the first check.
    EDGE_ORIGIN: "https://edge.example.com",
    ...(opts.primary !== undefined ? MODEL_ENV_WITH_FALLBACK : {}),
    ...(opts.spare
      ? {
          WORKERS_AI_MODEL: SPARE_MODEL_ID,
          AI: {
            run: async (model: string, input: Record<string, unknown>) => {
              spareRuns.push({ model, input });
              if (opts.spare === "fail") throw new Error("down");
              return { choices: [{ message: { content: "ok" } }] };
            },
          },
        }
      : {}),
    ...(opts.model ?? {}),
  };

  return { env, webhookCalls, kv, pings, spareRuns };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runOpsHeartbeat", () => {
  it("healthy system → no alerts, nothing sent", async () => {
    const { env, webhookCalls } = makeEnv({ webhookUrl: "https://hooks.example.com/x" });
    const result = await runOpsHeartbeat(env);
    expect(result.alerted).toEqual([]);
    expect(webhookCalls).toHaveLength(0);
  });

  it("edge down → one edge-health alert POSTed to the webhook", async () => {
    const { env, webhookCalls } = makeEnv({
      edgeStatus: "unreachable",
      webhookUrl: "https://hooks.example.com/x",
    });
    const result = await runOpsHeartbeat(env);
    expect(result.alerted).toContain("edge-health");
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]?.method).toBe("POST");
    expect(webhookCalls[0]?.body).toContain("edge-health");
  });

  it("same failure twice → second run is deduped via KV", async () => {
    const { env, webhookCalls } = makeEnv({
      edgeStatus: 500,
      webhookUrl: "https://hooks.example.com/x",
    });
    const first = await runOpsHeartbeat(env);
    const second = await runOpsHeartbeat(env);
    expect(first.alerted).toContain("edge-health");
    expect(second.alerted).not.toContain("edge-health");
    expect(second.deduped).toContain("edge-health");
    expect(webhookCalls).toHaveLength(1);
  });

  it("billing/auth failure → CRITICAL alert even below the spike threshold", async () => {
    const { env, webhookCalls } = makeEnv({
      errorGroups: [{ error_reason: "Your credit balance is too low to access the API", n: 2 }],
      webhookUrl: "https://hooks.example.com/x",
    });
    const result = await runOpsHeartbeat(env);
    expect(result.alerted).toContain("billing-auth");
    expect(webhookCalls[0]?.body).toContain("CRITICAL");
    expect(webhookCalls[0]?.body).toContain("credit balance");
  });

  it("provider failures at a fifth of a customer's versions → one error-spike naming the customer and the reasons", async () => {
    const { env, webhookCalls } = makeEnv({
      errorGroups: [
        { error_reason: "Error: Timeout after 45000ms", n: 5 },
        { error_reason: "sections.hero.body is empty", n: 2 },
      ],
      shares: [
        { customer_id: "webflow-demo", total: 30, failed: 7 },
        { customer_id: "template-lab", total: 330, failed: 6 },
      ],
      webhookUrl: "https://hooks.example.com/x",
    });
    const result = await runOpsHeartbeat(env);
    expect(result.alerted).toContain("error-spike");
    const body = webhookCalls.map((c) => c.body).join(" ");
    expect(body).toContain("webflow-demo 7 of 30");
    // Six of 330 is under a fifth: the lab's rewrite is not a spike.
    expect(body).not.toContain("template-lab");
    expect(body).toContain("Timeout after 45000ms");
  });

  it("versions the copy checks refused → no error-spike, one summary a day with the rules", async () => {
    const { env, webhookCalls } = makeEnv({
      shares: [{ customer_id: "lumera", total: 90, failed: 0 }],
      refused: [
        "lint: hero.headline length-drift (42 characters; the original has 28, write at most 29)",
        "lint: features.body length-drift (230 characters; the original has 191, write 181 to 201)",
        "lint: features.body sentence-reuse:hero.body (We take on a small number); hero.body length-drift (x)",
      ],
      webhookUrl: "https://hooks.example.com/x",
    });
    const first = await runOpsHeartbeat(env);
    expect(first.alerted).not.toContain("error-spike");
    expect(first.alerted).toContain("lint-daily");
    const body = webhookCalls.map((c) => c.body).join(" ");
    expect(body).toContain("3 versions refused by the copy checks");
    expect(body).toContain("length-drift 3, sentence-reuse 1");
    const second = await runOpsHeartbeat(env);
    expect(second.deduped).toContain("lint-daily");
    expect(webhookCalls).toHaveLength(1);
  });

  // measure-lab, 2026-10-05: five refused rows of a new customer had no
  // earlier text, and the summary said they kept it.
  it("refused rows with no earlier body: the summary says visitors get the nearest version", async () => {
    const reason =
      "lint: hero.cta.label length-drift (16 characters; the original has 10, write at most 13)";
    const { env, webhookCalls } = makeEnv({
      refused: [1, 2, 3, 4, 5].map((i) => ({
        error_reason: reason,
        kv_key: `v1:variant:c:i${i}:s`,
      })),
      webhookUrl: "https://hooks.example.com/x",
    });
    await runOpsHeartbeat(env);
    const body = webhookCalls.map((c) => c.body).join(" ");
    expect(body).toContain(
      "5 versions refused by the copy checks have no earlier text yet, so visitors get the nearest version",
    );
    expect(body).not.toContain("keep their earlier text");
    expect(body).toContain("Most: length-drift 5.");
  });

  it("some with an earlier body, some without: both counts, then a line per customer, no dashes", async () => {
    const reason =
      "lint: hero.body length-drift (120 characters; the original has 98, write 93 to 103)";
    const { env, webhookCalls } = makeEnv({
      refused: [
        { error_reason: reason, kv_key: "v1:variant:lumera:brand:ai", body_id: "abc" },
        { error_reason: reason, kv_key: "v1:variant:lumera:brand:social", body_id: null },
        { error_reason: reason, kv_key: "v1:variant:measure-lab:brand:ai", body_id: null },
      ],
      kvSeed: { "v1:variant:lumera:brand:social": "{}" },
      webhookUrl: "https://hooks.example.com/x",
    });
    await runOpsHeartbeat(env);
    const text = (JSON.parse(webhookCalls[0]?.body ?? "{}") as { text: string }).text;
    expect(text).toContain(
      "3 versions refused by the copy checks, retried every 6 hours: 2 keep earlier text, 1 has none yet, so visitors get the nearest version.",
    );
    expect(text).not.toMatch(/[\u2014\u2013]/);
    // Since 2026-10-12 (J4): per customer, the rows refused of the rows
    // written, with the rules. Ids, counts and rule names; no path, no text.
    expect(text.split("\n")).toEqual([
      expect.stringContaining("3 versions refused by the copy checks"),
      "Most: length-drift 3.",
      "lumera: refused 2 of 2 (length-drift 2), as built 0 parts",
      "measure-lab: refused 1 of 1 (length-drift 1), as built 0 parts",
    ]);
    expect(text).not.toContain("hero.body");
    expect(text).not.toContain("120 characters");
  });

  it("telegram webhook URL → GET with text query param", async () => {
    const { env, webhookCalls } = makeEnv({
      edgeStatus: 500,
      webhookUrl: "https://api.telegram.org/bot123:abc/sendMessage?chat_id=42",
    });
    await runOpsHeartbeat(env);
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]?.method).toBe("GET");
    expect(webhookCalls[0]?.url).toContain("chat_id=42");
    expect(webhookCalls[0]?.url).toContain("text=");
  });

  // 2026-10-02: the production worker never had the secret, and every alert
  // was marked as sent while it went to the log only.
  it("no webhook configured → not delivered: failed, no dedupe key, nothing fetched", async () => {
    const { env, webhookCalls, kv } = makeEnv({ edgeStatus: 500 });
    const result = await runOpsHeartbeat(env);
    expect(result.alerted).not.toContain("edge-health");
    expect(result.failed).toContain("edge-health");
    expect([...kv.keys()].some((k) => k.includes("edge-health"))).toBe(false);
    expect(webhookCalls).toHaveLength(0);
  });

  it("writing service hangs → one writing-service alert; answering again → one recovery, then quiet", async () => {
    const down = makeEnv({ primary: "hang", webhookUrl: "https://hooks.example/x" });
    // One missed hour stays quiet (2026-10-18); the second in a row alerts.
    const r0 = await runOpsHeartbeat(down.env);
    expect(r0.alerted).toEqual([]);
    expect(down.webhookCalls).toHaveLength(0);
    const r1 = await runOpsHeartbeat(down.env);
    expect(r1.alerted).toEqual(["writing-service"]);
    expect(down.webhookCalls[0]?.body).toContain(
      "The model endpoint is not answering (no answer in 20 s)",
    );
    expect(down.kv.has("ops:alert:writing-service")).toBe(true);

    // Same outage an hour later: deduped, not sent again.
    const r2 = await runOpsHeartbeat(down.env);
    expect(r2.deduped).toEqual(["writing-service"]);

    // Back up: the recovery goes out once and the marker is gone.
    const up = makeEnv({ primary: 200, webhookUrl: "https://hooks.example/x" });
    for (const [k, v] of down.kv) up.kv.set(k, v);
    const r3 = await runOpsHeartbeat(up.env);
    expect(r3.alerted).toEqual(["writing-service:recovered"]);
    expect(up.webhookCalls[0]?.body).toContain("The model endpoint is answering again");
    expect(up.kv.has("ops:alert:writing-service")).toBe(false);
    const r4 = await runOpsHeartbeat(up.env);
    expect(r4.alerted).toEqual([]);
    expect(up.webhookCalls.length).toBe(1);
  });

  it("no edge address configured: the edge check is skipped, not failed, and nothing is asked", async () => {
    // The stub answers any /health with an error: a check that ran would alert.
    const none = makeEnv({
      edgeStatus: "unreachable",
      webhookUrl: "https://hooks.example.com/x",
      model: { EDGE_ORIGIN: undefined },
    });
    const asked: string[] = [];
    const stubbed = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(String(input));
      return stubbed(input, init);
    });
    const r = await runOpsHeartbeat(none.env);
    expect(r.alerted).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(none.webhookCalls).toHaveLength(0);
    expect(asked).toEqual([]);
    // One check fewer than an install that named its edge.
    const named = await runOpsHeartbeat(makeEnv({}).env);
    expect(r.checked).toBe(named.checked - 1);
  });

  it("the edge check asks EDGE_ORIGIN's /health, or the override when there is one", async () => {
    const asked: string[] = [];
    const watch = (env: ReturnType<typeof makeEnv>["env"]) => {
      const stubbed = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        asked.push(String(input));
        return stubbed(input, init);
      });
      return runOpsHeartbeat(env);
    };
    await watch(makeEnv({}).env);
    await watch(makeEnv({ model: { EDGE_HEALTH_URL: "https://status.example.com/health" } }).env);
    await watch(
      makeEnv({
        model: { EDGE_ORIGIN: undefined, EDGE_HEALTH_URL: "https://status.example.com/health" },
      }).env,
    );
    expect(asked).toEqual([
      "https://edge.example.com/health",
      "https://status.example.com/health",
      "https://status.example.com/health",
    ]);
  });

  it("writing service answers 5xx → alert names the status; no model configured → not pinged", async () => {
    const bad = makeEnv({ primary: 503, webhookUrl: "https://hooks.example/x" });
    await runOpsHeartbeat(bad.env);
    const r = await runOpsHeartbeat(bad.env);
    expect(r.alerted).toEqual(["writing-service"]);
    expect(bad.webhookCalls[0]?.body).toContain("The model endpoint is not answering (HTTP 503)");
    expect(r.checked).toBe(6);
    const none = makeEnv({});
    const r2 = await runOpsHeartbeat(none.env);
    expect(r2.checked).toBe(4);
    expect(none.pings).toHaveLength(0);
  });

  it("the ping is the writer's request in small: the configured address, key, model and extra body", async () => {
    const { env, pings } = makeEnv({
      primary: 200,
      model: { MODEL_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' },
    });
    await runOpsHeartbeat(env);
    expect(pings.map((p) => p.body.model)).toEqual(["model-a", "model-b"]);
    expect(pings[0]?.url).toBe("https://models.example/v1/chat/completions");
    expect(pings[0]?.headers.authorization).toBe("Bearer test-key");
    expect(pings[0]?.body).toEqual({
      max_tokens: 2,
      temperature: 0,
      stream: false,
      thinking: { type: "disabled" },
      model: "model-a",
      messages: [{ role: "user", content: "Say ok." }],
    });
  });

  it("a key that is not visible, or the binding as the writer: nothing is pinged", async () => {
    const noKey = makeEnv({ primary: 200, model: { MODEL_API_KEY: "" } });
    expect((await runOpsHeartbeat(noKey.env)).checked).toBe(4);
    expect(noKey.pings).toHaveLength(0);
    const onBinding = makeEnv({ primary: 200, spare: "ok", model: { MODEL_ROUTE: "workers-ai" } });
    expect((await runOpsHeartbeat(onBinding.env)).checked).toBe(4);
    expect(onBinding.pings).toHaveLength(0);
    expect(onBinding.spareRuns).toHaveLength(0);
  });

  it("a malformed MODEL_EXTRA_BODY is the problem the line names, never its value", async () => {
    const bad = makeEnv({
      primary: 200,
      model: { MODEL_EXTRA_BODY: "{never-echoed-value" },
      webhookUrl: "https://hooks.example/x",
    });
    await runOpsHeartbeat(bad.env);
    const r = await runOpsHeartbeat(bad.env);
    expect(r.alerted).toContain("writing-service");
    const line = bad.webhookCalls.map((c) => c.body).join(" ");
    expect(line).toContain("MODEL_EXTRA_BODY is not valid JSON");
    expect(line).not.toContain("never-echoed-value");
    expect(bad.pings).toHaveLength(0);
  });

  it("parts the live page no longer has → one parts-missing alert naming them", async () => {
    const { env, webhookCalls } = makeEnv({
      webhookUrl: "https://hooks.example/x",
      missing: [{ customer_id: "lumera", page_path: "/az", missing: '["cta.cta.label"]' }],
    });
    const r = await runOpsHeartbeat(env);
    expect(r.alerted).toEqual(["parts-missing"]);
    expect(webhookCalls[0]?.body).toContain("lumera /az: cta.cta.label");
  });
});

// 2026-10-02: the first snippet-issue alert wrote its dedupe key although
// Telegram never delivered it, so it vanished for 24 h.
describe("a refused webhook", () => {
  it("writes no dedupe key, reports the failure, and the next hour tries again", async () => {
    const { env, webhookCalls, kv } = makeEnv({
      edgeStatus: 503,
      webhookUrl: "https://api.telegram.org/botTEST/sendMessage?chat_id=1",
      webhookStatus: 400,
    });
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    const first = await runOpsHeartbeat(env);
    expect(first.alerted).not.toContain("edge-health");
    expect(first.failed).toContain("edge-health");
    expect([...kv.keys()].some((k) => k.includes("edge-health"))).toBe(false);
    expect(
      errors.some((e) => e.includes("webhook refused: HTTP 400 Bad Request: chat not found")),
    ).toBe(true);
    // The token in the URL is never logged.
    expect(errors.some((e) => e.includes("botTEST"))).toBe(false);

    const second = await runOpsHeartbeat(env);
    expect(second.failed).toContain("edge-health");
    expect(webhookCalls.length).toBe(2);
    spy.mockRestore();
  });

  it("a delivered alert still writes its key once", async () => {
    const { env, kv } = makeEnv({
      edgeStatus: 503,
      webhookUrl: "https://api.telegram.org/botTEST/sendMessage?chat_id=1",
    });
    const first = await runOpsHeartbeat(env);
    expect(first.alerted).toContain("edge-health");
    expect(first.failed).toEqual([]);
    expect([...kv.keys()].some((k) => k.includes("edge-health"))).toBe(true);
  });
});

// 2026-10-02: the provider said the fallback's id may be answered by the
// primary's model one day; then the fallback stops being a model of its own.
describe("the writing fallback", () => {
  it("the fallback id answered by another model → one writing-fallback alert naming both", async () => {
    const { env, webhookCalls } = makeEnv({
      primary: 200,
      fallback: { served: "model-a" },
      webhookUrl: "https://hooks.example/x",
    });
    const r = await runOpsHeartbeat(env);
    expect(r.alerted).toEqual(["writing-fallback"]);
    expect(webhookCalls[0]?.body).toContain("answers the fallback model model-b with model-a");
    expect(webhookCalls[0]?.body).toContain("MODEL_FALLBACK_ID");
  });

  it("the fallback silent → writing-fallback; itself again → one recovery", async () => {
    const down = makeEnv({
      primary: 200,
      fallback: "hang",
      webhookUrl: "https://hooks.example/x",
    });
    expect((await runOpsHeartbeat(down.env)).alerted).toEqual([]);
    const r1 = await runOpsHeartbeat(down.env);
    expect(r1.alerted).toEqual(["writing-fallback"]);
    expect(down.webhookCalls[0]?.body).toContain(
      "The fallback model model-b is not answering (no answer in 20 s) and the spare route is off",
    );
    const up = makeEnv({ primary: 200, webhookUrl: "https://hooks.example/x" });
    for (const [k, v] of down.kv) up.kv.set(k, v);
    const r2 = await runOpsHeartbeat(up.env);
    expect(r2.alerted).toEqual(["writing-fallback:recovered"]);
    expect(up.webhookCalls[0]?.body).toContain(
      "The fallback model model-b answers as itself again",
    );
  });

  // 2026-10-18: the fallback missed one hourly check while the primary wrote as usual.
  it("one missed hour, then an answer: no line at all, and the count starts again", async () => {
    const down = makeEnv({
      primary: 200,
      fallback: "hang",
      webhookUrl: "https://hooks.example/x",
    });
    expect((await runOpsHeartbeat(down.env)).alerted).toEqual([]);
    expect(down.kv.get("ops:miss:writing-fallback")).toBe("1");
    const up = makeEnv({ primary: 200, webhookUrl: "https://hooks.example/x" });
    for (const [k, v] of down.kv) up.kv.set(k, v);
    expect((await runOpsHeartbeat(up.env)).alerted).toEqual([]);
    expect(up.kv.has("ops:miss:writing-fallback")).toBe(false);
    expect(down.webhookCalls).toHaveLength(0);
    expect(up.webhookCalls).toHaveLength(0);
  });

  // 2026-10-18: the spare route still writes when the fallback is silent.
  it("the fallback silent, the spare answers → no line, hour after hour; both silent → the line names both", async () => {
    const covered = makeEnv({
      primary: 200,
      fallback: "hang",
      spare: "ok",
      webhookUrl: "https://hooks.example/x",
    });
    for (let i = 0; i < 3; i++) expect((await runOpsHeartbeat(covered.env)).alerted).toEqual([]);
    expect(covered.webhookCalls).toHaveLength(0);
    // The spare is asked only when the fallback is silent, with its own model.
    expect(covered.spareRuns).toHaveLength(3);
    expect(covered.spareRuns[0]).toEqual({
      model: SPARE_MODEL_ID,
      input: {
        max_completion_tokens: 2,
        temperature: 0,
        messages: [{ role: "user", content: "Say ok." }],
      },
    });

    const bare = makeEnv({
      primary: 200,
      fallback: "hang",
      spare: "fail",
      webhookUrl: "https://hooks.example/x",
    });
    expect((await runOpsHeartbeat(bare.env)).alerted).toEqual([]);
    expect((await runOpsHeartbeat(bare.env)).alerted).toEqual(["writing-fallback"]);
    expect(bare.webhookCalls[0]?.body).toContain("the spare route is not answering (Error)");
  });

  it("WORKERS_AI_EXTRA_INPUT rides in the spare's ping; the binding without a model is off", async () => {
    const extra = makeEnv({
      primary: 200,
      fallback: "hang",
      spare: "ok",
      model: { WORKERS_AI_EXTRA_INPUT: '{"reasoning_effort":"none"}' },
    });
    await runOpsHeartbeat(extra.env);
    expect(extra.spareRuns[0]?.input.reasoning_effort).toBe("none");

    const noModel = makeEnv({
      primary: 200,
      fallback: "hang",
      spare: "ok",
      model: { WORKERS_AI_MODEL: "" },
      webhookUrl: "https://hooks.example/x",
    });
    await runOpsHeartbeat(noModel.env);
    const r = await runOpsHeartbeat(noModel.env);
    expect(r.alerted).toEqual(["writing-fallback"]);
    expect(noModel.webhookCalls[0]?.body).toContain("the spare route is off");
    expect(noModel.spareRuns).toHaveLength(0);
  });

  it("no fallback model configured → the fallback is not checked, and the spare not asked", async () => {
    const { env, pings, spareRuns } = makeEnv({
      primary: 200,
      spare: "ok",
      model: { MODEL_FALLBACK_ID: undefined },
    });
    const r = await runOpsHeartbeat(env);
    expect(r.checked).toBe(5);
    expect(r.alerted).toEqual([]);
    expect(pings.map((p) => p.body.model)).toEqual([MODEL_ENV.MODEL_ID]);
    expect(spareRuns).toHaveLength(0);
  });

  it("both answering as themselves → no alert", async () => {
    const { env } = makeEnv({ primary: 200 });
    const r = await runOpsHeartbeat(env);
    expect(r.alerted).toEqual([]);
  });
});
