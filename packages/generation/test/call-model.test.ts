/**
 * call-model: the tiers of an outage (the role's model, the fallback model
 * on the same endpoint, the spare route) and the two memos that keep an
 * outage from paying its timeouts twice.
 *
 * The memos are shared through KV (2026-10-02), so a fresh isolate (the
 * five-minute write queue runs in one each pass) goes straight to the tier
 * that answers instead of paying the timeout again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV, MODEL_ENV_WITH_FALLBACK, SPARE_MODEL_ID } from "./model-env.ts";

vi.mock("../src/generateVariant.ts", () => ({
  generateVariant: vi.fn(),
}));

const { generateVariant } = await import("../src/generateVariant.ts");
const mock = vi.mocked(generateVariant);
const { callModel, resetProviderState, PRIMARY_DOWN_KEY, ENDPOINT_DOWN_KEY, PROVIDER_DOWN } =
  await import("../src/call-model.ts");

function fakeKv() {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
  };
  return { kv: kv as unknown as KVNamespace, store, spy: kv };
}

const OK = {
  text: "{}",
  model: "model-b",
  costUsd: 0,
  promptHash: "x",
  cacheHit: false,
  cacheReadTokens: 0,
} as never;

/** The tier each call of generateVariant was made on, in order. */
const tiers = () => mock.mock.calls.map((c) => c[2] ?? "primary");

const AI = { run: vi.fn() };
const WITH_SPARE = { ...MODEL_ENV_WITH_FALLBACK, AI, WORKERS_AI_MODEL: SPARE_MODEL_ID };
const down = () => Promise.reject(new Error("Model request failed: HTTP 503"));

afterEach(() => {
  mock.mockReset();
  resetProviderState();
  vi.useRealTimers();
});

describe("the memo keys", () => {
  it("name no provider", () => {
    expect(PRIMARY_DOWN_KEY).toBe("ops:model-primary-down-until");
    expect(ENDPOINT_DOWN_KEY).toBe("ops:model-endpoint-down-until");
  });
});

describe("callModel, the fallback tier and the memo of a silent primary", () => {
  it("a silent primary writes the KV marker; a fresh isolate then skips the primary", async () => {
    vi.useFakeTimers();
    const { kv, store } = fakeKv();
    const env = { ...MODEL_ENV_WITH_FALLBACK, VARIANTS: kv };

    mock.mockImplementationOnce(() => new Promise(() => {}) as never);
    mock.mockResolvedValueOnce(OK);
    const first = callModel({ prompt: "p" }, env, { firstMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await first).ok).toBe(true);
    expect(tiers()).toEqual(["primary", "fallback"]);
    expect(Number(store.get(PRIMARY_DOWN_KEY))).toBeGreaterThan(Date.now());
    expect(store.has(ENDPOINT_DOWN_KEY)).toBe(false);

    // A new isolate: memory forgotten, KV remembers.
    resetProviderState();
    mock.mockClear();
    mock.mockResolvedValueOnce(OK);
    const second = await callModel({ prompt: "p" }, env);
    expect(second.ok).toBe(true);
    expect(tiers()).toEqual(["fallback"]);
  });

  it("the marker lives ten minutes", async () => {
    const { kv, spy } = fakeKv();
    mock.mockImplementationOnce(down).mockResolvedValueOnce(OK);
    await callModel({ prompt: "p" }, { ...MODEL_ENV_WITH_FALLBACK, VARIANTS: kv });
    expect(spy.put).toHaveBeenCalledWith(PRIMARY_DOWN_KEY, expect.any(String), {
      expirationTtl: 600,
    });
  });

  it("no marker in KV: the primary is tried; KV is read at most once per 30 s", async () => {
    const { kv, spy } = fakeKv();
    const env = { ...MODEL_ENV_WITH_FALLBACK, VARIANTS: kv };
    mock.mockResolvedValue(OK);
    await callModel({ prompt: "p" }, env);
    await callModel({ prompt: "p" }, env);
    expect(tiers()).toEqual(["primary", "primary"]);
    expect(spy.get).toHaveBeenCalledTimes(1);
  });

  it("without a KV binding it still works from memory", async () => {
    mock.mockImplementationOnce(down).mockResolvedValue(OK);
    expect((await callModel({ prompt: "p" }, MODEL_ENV_WITH_FALLBACK)).ok).toBe(true);
    expect((await callModel({ prompt: "p" }, MODEL_ENV_WITH_FALLBACK)).ok).toBe(true);
    expect(tiers()).toEqual(["primary", "fallback", "fallback"]);
  });

  it("without a fallback model a silent primary is a failure, and nothing is remembered", async () => {
    const { kv, store } = fakeKv();
    mock.mockImplementation(down);
    const r = await callModel({ prompt: "p" }, { ...MODEL_ENV, VARIANTS: kv });
    expect(r).toEqual({ ok: false, error: "Error: Model request failed: HTTP 503" });
    expect(tiers()).toEqual(["primary"]);
    expect(store.size).toBe(0);
  });

  it("each tier gets its own timeout", async () => {
    vi.useFakeTimers();
    mock.mockImplementation(() => new Promise(() => {}) as never);
    const call = callModel({ prompt: "p" }, MODEL_ENV_WITH_FALLBACK, {
      firstMs: 15_000,
      fallbackMs: 25_000,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(tiers()).toEqual(["primary", "fallback"]);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await call).toEqual({ ok: false, error: "Error: Timeout after 25000ms" });
  });

  it("a refusal of the words, not a silent model, never moves to another tier", async () => {
    mock.mockRejectedValueOnce(new Error("Model output truncated at max_tokens=10"));
    const r = await callModel({ prompt: "p" }, WITH_SPARE);
    expect(r.ok).toBe(false);
    expect(tiers()).toEqual(["primary"]);
  });
});

describe("callModel, a key that is not visible", () => {
  // Right after a deploy an isolate can run without the secret for a moment.
  it("is a failure that stands: no tier is tried and no outage is remembered", async () => {
    const { kv, store } = fakeKv();
    mock.mockRejectedValue(new Error("The model is not configured"));
    const r = await callModel({ prompt: "p" }, { ...WITH_SPARE, MODEL_API_KEY: "", VARIANTS: kv });
    expect(r).toEqual({ ok: false, error: "Error: The model is not configured" });
    expect(tiers()).toEqual(["primary"]);
    expect(store.size).toBe(0);
  });
});

describe("callModel, a role with a model of its own", () => {
  const ROLES = { ...MODEL_ENV_WITH_FALLBACK, MODEL_ID_READ: "model-read" };

  it("its silence is not remembered for the writer's model", async () => {
    const { kv, store } = fakeKv();
    const env = { ...ROLES, VARIANTS: kv };
    mock.mockImplementationOnce(down).mockResolvedValue(OK);
    expect((await callModel({ prompt: "p", role: "read" }, env)).ok).toBe(true);
    expect(tiers()).toEqual(["primary", "fallback"]);
    expect(store.has(PRIMARY_DOWN_KEY)).toBe(false);

    mock.mockClear();
    await callModel({ prompt: "p", role: "write" }, env);
    expect(tiers()).toEqual(["primary"]);
  });

  it("the writer's memo does not send it to the fallback", async () => {
    const { kv } = fakeKv();
    const env = { ...ROLES, VARIANTS: kv };
    mock.mockImplementationOnce(down).mockResolvedValue(OK);
    await callModel({ prompt: "p", role: "write" }, env);
    mock.mockClear();
    await callModel({ prompt: "p", role: "read" }, env);
    expect(tiers()).toEqual(["primary"]);
    // The writer itself goes straight to the fallback.
    mock.mockClear();
    await callModel({ prompt: "p", role: "write" }, env);
    expect(tiers()).toEqual(["fallback"]);
  });

  it("a role that shares the writer's model shares its memo", async () => {
    const { kv } = fakeKv();
    const env = { ...MODEL_ENV_WITH_FALLBACK, VARIANTS: kv };
    mock.mockImplementationOnce(down).mockResolvedValue(OK);
    await callModel({ prompt: "p", role: "write" }, env);
    mock.mockClear();
    await callModel({ prompt: "p", role: "read" }, env);
    expect(tiers()).toEqual(["fallback"]);
  });

  it("a role whose model is the fallback has no fallback tier", async () => {
    mock.mockImplementation(down);
    const env = { ...MODEL_ENV_WITH_FALLBACK, MODEL_ID_DETECT: "model-b" };
    const r = await callModel({ prompt: "p", role: "detect" }, env);
    expect(r.ok).toBe(false);
    expect(tiers()).toEqual(["primary"]);
  });
});

// 2026-10-18: when the endpoint answers neither the primary nor the
// fallback, the same call is written on the spare route.
describe("callModel, the spare route and the memo of a silent endpoint", () => {
  it("primary and fallback silent: the spare writes; the next call goes there at once", async () => {
    const { kv, store } = fakeKv();
    const env = { ...WITH_SPARE, VARIANTS: kv };
    mock.mockImplementationOnce(down).mockImplementationOnce(down).mockResolvedValueOnce(OK);
    const r = await callModel({ prompt: "p" }, env);
    expect(r.ok).toBe(true);
    expect(tiers()).toEqual(["primary", "fallback", "spare"]);
    expect(Number(store.get(PRIMARY_DOWN_KEY))).toBeGreaterThan(Date.now());
    expect(Number(store.get(ENDPOINT_DOWN_KEY))).toBeGreaterThan(Date.now());

    // A fresh isolate during the outage: no endpoint timeout paid again.
    resetProviderState();
    mock.mockClear();
    mock.mockResolvedValueOnce(OK);
    expect((await callModel({ prompt: "p" }, env)).ok).toBe(true);
    expect(tiers()).toEqual(["spare"]);
  });

  it("the remembered primary, then a silent fallback: the endpoint is marked and the spare writes", async () => {
    const { kv, store } = fakeKv();
    const env = { ...WITH_SPARE, VARIANTS: kv };
    store.set(PRIMARY_DOWN_KEY, String(Date.now() + 60_000));
    mock.mockImplementationOnce(down).mockResolvedValueOnce(OK);
    expect((await callModel({ prompt: "p" }, env)).ok).toBe(true);
    expect(tiers()).toEqual(["fallback", "spare"]);
    expect(Number(store.get(ENDPOINT_DOWN_KEY))).toBeGreaterThan(Date.now());
  });

  it("without a fallback model the spare is the second try, and no memo is written", async () => {
    const { kv, store } = fakeKv();
    const env = { ...MODEL_ENV, AI, WORKERS_AI_MODEL: SPARE_MODEL_ID, VARIANTS: kv };
    mock.mockImplementationOnce(down).mockResolvedValueOnce(OK);
    expect((await callModel({ prompt: "p" }, env)).ok).toBe(true);
    expect(tiers()).toEqual(["primary", "spare"]);
    expect(store.size).toBe(0);
  });

  it("a silent spare is the failure that stands", async () => {
    mock.mockImplementation(down);
    const r = await callModel({ prompt: "p" }, WITH_SPARE);
    expect(r).toEqual({ ok: false, error: "Error: Model request failed: HTTP 503" });
    expect(tiers()).toEqual(["primary", "fallback", "spare"]);
  });

  it("never without the binding, never without its model", async () => {
    mock.mockImplementation(down);
    await callModel({ prompt: "p" }, MODEL_ENV_WITH_FALLBACK);
    resetProviderState();
    await callModel({ prompt: "p" }, { ...MODEL_ENV_WITH_FALLBACK, AI });
    resetProviderState();
    await callModel(
      { prompt: "p" },
      { ...MODEL_ENV_WITH_FALLBACK, WORKERS_AI_MODEL: SPARE_MODEL_ID },
    );
    expect(tiers()).not.toContain("spare");
  });

  it("without a spare the endpoint memo is neither written nor read", async () => {
    const { kv, store, spy } = fakeKv();
    const env = { ...MODEL_ENV_WITH_FALLBACK, VARIANTS: kv };
    store.set(ENDPOINT_DOWN_KEY, String(Date.now() + 60_000));
    mock.mockImplementation(down);
    await callModel({ prompt: "p" }, env);
    expect(tiers()).toEqual(["primary", "fallback"]);
    expect(spy.get).not.toHaveBeenCalledWith(ENDPOINT_DOWN_KEY);
    expect(spy.put).not.toHaveBeenCalledWith(
      ENDPOINT_DOWN_KEY,
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("PROVIDER_DOWN", () => {
  it("reads a model that did not answer", () => {
    for (const text of [
      "Error: Timeout after 45000ms",
      "Error: Model request failed: HTTP 503",
      "Error: Model request failed: HTTP 401",
      "Error: Workers AI request failed: TypeError",
      "TypeError: fetch failed",
    ]) {
      expect(PROVIDER_DOWN.test(text), text).toBe(true);
    }
  });

  it("leaves words the checks refused and a broken answer alone", () => {
    for (const text of [
      "Error: Model output truncated at max_tokens=2048 (content 9000 chars)",
      "lint: number-not-in-brief: 4 weeks",
      "Invalid JSON: unexpected token",
      "Error: The model is not configured",
    ]) {
      expect(PROVIDER_DOWN.test(text), text).toBe(false);
    }
  });
});
