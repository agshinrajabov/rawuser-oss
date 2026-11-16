/**
 * generateVariant: one request shape on two routes, the model and its price
 * from configuration (model-config.ts).
 *
 * Nothing here reaches a model: fetch is spied and the binding is a stub.
 * The ids name nobody ("model-a", "model-b", "@spare/model-c") and the
 * endpoint is a reserved name.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { generateVariant } from "../src/generateVariant.ts";
import { MODEL_ENV, MODEL_ENV_WITH_FALLBACK, SPARE_MODEL_ID } from "./model-env.ts";

interface Posted {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const ANSWER = {
  choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 50 },
};

/** Spies fetch: every request is recorded and answered with `answer` (or `status`). */
function endpoint(answer: unknown = ANSWER, status = 200) {
  const posted: Posted[] = [];
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      posted.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(typeof answer === "string" ? answer : JSON.stringify(answer), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
  return { posted, spy };
}

/** A binding stub that records what it was run with. */
function binding(answer: unknown = ANSWER) {
  const runs: Array<{ model: string; input: Record<string, unknown> }> = [];
  const AI = {
    run: vi.fn(async (model: string, input: Record<string, unknown>) => {
      runs.push({ model, input });
      return answer;
    }),
  };
  return { AI, runs };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateVariant, the endpoint route", () => {
  it("posts the chat completions shape to the configured address with the key as bearer", async () => {
    const { posted } = endpoint();
    const r = await generateVariant({ prompt: "hello", cachedPreamble: "sys" }, MODEL_ENV);

    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe("https://models.example/v1/chat/completions");
    expect(posted[0]?.headers.authorization).toBe("Bearer test-key");
    expect(posted[0]?.headers["content-type"]).toBe("application/json");
    expect(posted[0]?.body).toEqual({
      max_tokens: 2048,
      temperature: 0.2,
      stream: false,
      model: "model-a",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
      ],
    });
    expect(r.text).toBe('{"ok":true}');
    expect(r.model).toBe("model-a");
  });

  it("sends no system message without a preamble, and the caller's output limit", async () => {
    const { posted } = endpoint();
    await generateVariant({ prompt: "hello", maxTokens: 4096 }, MODEL_ENV);
    expect(posted[0]?.body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(posted[0]?.body.max_tokens).toBe(4096);
  });

  it("asks for a JSON object only in JSON mode", async () => {
    const { posted } = endpoint();
    await generateVariant({ prompt: "p" }, MODEL_ENV);
    await generateVariant({ prompt: "p", jsonMode: true }, MODEL_ENV);
    expect(posted[0]?.body.response_format).toBeUndefined();
    expect(posted[1]?.body.response_format).toEqual({ type: "json_object" });
  });

  it("a trailing slash on the base URL does not double", async () => {
    const { posted } = endpoint();
    await generateVariant(
      { prompt: "p" },
      { ...MODEL_ENV, MODEL_BASE_URL: "https://models.example/v1//" },
    );
    expect(posted[0]?.url).toBe("https://models.example/v1/chat/completions");
  });

  it("merges MODEL_EXTRA_BODY into the request; the model and the messages stay ours", async () => {
    const { posted } = endpoint();
    await generateVariant(
      { prompt: "p" },
      {
        ...MODEL_ENV,
        MODEL_EXTRA_BODY: JSON.stringify({
          thinking: { type: "disabled" },
          temperature: 0.7,
          model: "someone-else",
          messages: [],
        }),
      },
    );
    const body = posted[0]?.body;
    expect(body?.thinking).toEqual({ type: "disabled" });
    // A provider's own switch or another temperature is a var.
    expect(body?.temperature).toBe(0.7);
    expect(body?.model).toBe("model-a");
    expect(body?.messages).toEqual([{ role: "user", content: "p" }]);
  });

  it("MODEL_MAX_TOKENS_FIELD names the field that carries the output limit", async () => {
    const { posted } = endpoint();
    await generateVariant(
      { prompt: "p", maxTokens: 600 },
      { ...MODEL_ENV, MODEL_MAX_TOKENS_FIELD: "max_completion_tokens" },
    );
    expect(posted[0]?.body.max_completion_tokens).toBe(600);
    expect(posted[0]?.body.max_tokens).toBeUndefined();
  });

  it("an HTTP error says the status and never the body", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    endpoint("the prompt, echoed: secret page text", 503);
    await expect(generateVariant({ prompt: "p" }, MODEL_ENV)).rejects.toThrow(
      "Model request failed: HTTP 503",
    );
    await expect(generateVariant({ prompt: "p" }, MODEL_ENV)).rejects.not.toThrow(/secret/);
    expect(errors).not.toHaveBeenCalled();
  });

  it("throws on finish_reason length instead of returning a cut-off object", async () => {
    endpoint({
      choices: [{ message: { content: '{"hero":{"headline":"cut' }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    });
    await expect(generateVariant({ prompt: "p", maxTokens: 10 }, MODEL_ENV)).rejects.toThrow(
      /truncated at max_tokens=10/,
    );
  });

  it("throws before any request when the model is not configured", async () => {
    const { spy } = endpoint();
    for (const missing of ["MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_ID"] as const) {
      await expect(
        generateVariant({ prompt: "p" }, { ...MODEL_ENV, [missing]: "" }),
      ).rejects.toThrow("The model is not configured");
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("generateVariant, roles and tiers", () => {
  const ROLES = { ...MODEL_ENV, MODEL_ID_READ: "model-read", MODEL_ID_DETECT: "model-detect" };

  it("a role without a model of its own runs on MODEL_ID", async () => {
    const { posted } = endpoint();
    await generateVariant({ prompt: "p" }, MODEL_ENV);
    await generateVariant({ prompt: "p", role: "write" }, MODEL_ENV);
    await generateVariant({ prompt: "p", role: "read" }, MODEL_ENV);
    await generateVariant({ prompt: "p", role: "detect" }, MODEL_ENV);
    expect(posted.map((p) => p.body.model)).toEqual(["model-a", "model-a", "model-a", "model-a"]);
  });

  it("MODEL_ID_READ and MODEL_ID_DETECT give those roles their own model", async () => {
    const { posted } = endpoint();
    await generateVariant({ prompt: "p", role: "write" }, ROLES);
    await generateVariant({ prompt: "p", role: "read" }, ROLES);
    const detected = await generateVariant({ prompt: "p", role: "detect" }, ROLES);
    expect(posted.map((p) => p.body.model)).toEqual(["model-a", "model-read", "model-detect"]);
    expect(detected.model).toBe("model-detect");
  });

  it("the fallback tier posts the fallback id to the same endpoint", async () => {
    const { posted } = endpoint();
    const r = await generateVariant({ prompt: "p" }, MODEL_ENV_WITH_FALLBACK, "fallback");
    expect(posted[0]?.url).toBe("https://models.example/v1/chat/completions");
    expect(posted[0]?.body.model).toBe("model-b");
    expect(r.model).toBe("model-b");
  });

  it("a tier that is not configured throws before any request", async () => {
    const { spy } = endpoint();
    await expect(generateVariant({ prompt: "p" }, MODEL_ENV, "fallback")).rejects.toThrow(
      "The fallback model is not configured",
    );
    await expect(generateVariant({ prompt: "p" }, MODEL_ENV, "spare")).rejects.toThrow(
      "The spare route is not configured",
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("generateVariant, the binding route", () => {
  it("the spare tier runs the binding's model and never fetches", async () => {
    const { spy } = endpoint();
    const { AI, runs } = binding();
    const r = await generateVariant(
      { prompt: "hello", cachedPreamble: "sys", jsonMode: true, maxTokens: 900 },
      { ...MODEL_ENV, AI, WORKERS_AI_MODEL: SPARE_MODEL_ID },
      "spare",
    );
    expect(spy).not.toHaveBeenCalled();
    expect(runs).toEqual([
      {
        model: SPARE_MODEL_ID,
        input: {
          max_completion_tokens: 900,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hello" },
          ],
        },
      },
    ]);
    expect(r.model).toBe(SPARE_MODEL_ID);
    expect(r.text).toBe('{"ok":true}');
  });

  it('MODEL_ROUTE "workers-ai" makes the binding the primary, for every role', async () => {
    const { spy } = endpoint();
    const { AI, runs } = binding();
    const env = { MODEL_ROUTE: "workers-ai", AI, WORKERS_AI_MODEL: SPARE_MODEL_ID };
    await generateVariant({ prompt: "p" }, env);
    await generateVariant({ prompt: "p", role: "detect" }, { ...env, MODEL_ID_DETECT: "model-x" });
    expect(spy).not.toHaveBeenCalled();
    expect(runs.map((r) => r.model)).toEqual([SPARE_MODEL_ID, SPARE_MODEL_ID]);
    expect(runs[0]?.input.response_format).toBeUndefined();
  });

  it("merges WORKERS_AI_EXTRA_INPUT into the input; the messages stay ours", async () => {
    const { AI, runs } = binding();
    await generateVariant(
      { prompt: "p" },
      {
        MODEL_ROUTE: "workers-ai",
        AI,
        WORKERS_AI_MODEL: SPARE_MODEL_ID,
        WORKERS_AI_EXTRA_INPUT: '{"reasoning_effort":"none","messages":[]}',
      },
    );
    expect(runs[0]?.input.reasoning_effort).toBe("none");
    expect(runs[0]?.input.messages).toEqual([{ role: "user", content: "p" }]);
  });

  it("a failed run says only that it failed, never the prompt", async () => {
    const AI = {
      run: vi.fn(async () => {
        throw new TypeError("the prompt, echoed: secret page text");
      }),
    };
    const call = () =>
      generateVariant(
        { prompt: "secret page text" },
        { MODEL_ROUTE: "workers-ai", AI, WORKERS_AI_MODEL: SPARE_MODEL_ID },
      );
    await expect(call()).rejects.toThrow("Workers AI request failed: TypeError");
    await expect(call()).rejects.not.toThrow(/secret/);
  });

  it("throws on finish_reason length here too", async () => {
    const { AI } = binding({
      choices: [{ message: { content: "cut" }, finish_reason: "length" }],
    });
    await expect(
      generateVariant(
        { prompt: "p", maxTokens: 5 },
        { MODEL_ROUTE: "workers-ai", AI, WORKERS_AI_MODEL: SPARE_MODEL_ID },
      ),
    ).rejects.toThrow(/truncated at max_tokens=5/);
  });
});

describe("generateVariant, cost", () => {
  const MILLION = 1_000_000;
  const PRICES = JSON.stringify({
    "model-a": { in: 0.3, out: 1.2, cached: 0.006 },
    "model-b": { in: 1.32, out: 3.96 },
  });

  it("prices uncached input, cached input and output at the model's row", async () => {
    endpoint({
      choices: [{ message: { content: "x" } }],
      usage: {
        prompt_tokens: MILLION,
        completion_tokens: MILLION,
        prompt_cache_hit_tokens: MILLION / 2,
        prompt_cache_miss_tokens: MILLION / 2,
      },
    });
    const r = await generateVariant({ prompt: "p" }, { ...MODEL_ENV, MODEL_PRICES: PRICES });
    // 0.5M uncached at 0.30, 0.5M cached at 0.006, 1M out at 1.20.
    expect(r.costUsd).toBeCloseTo(0.15 + 0.003 + 1.2, 6);
    expect(r.cacheHit).toBe(true);
    expect(r.cacheReadTokens).toBe(MILLION / 2);
  });

  it("reads the other spelling of the cached share", async () => {
    endpoint({
      choices: [{ message: { content: "x" } }],
      usage: {
        prompt_tokens: MILLION,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: MILLION / 4 },
      },
    });
    const r = await generateVariant({ prompt: "p" }, { ...MODEL_ENV, MODEL_PRICES: PRICES });
    // 0.75M uncached at 0.30, 0.25M cached at 0.006.
    expect(r.costUsd).toBeCloseTo(0.225 + 0.0015, 6);
    expect(r.cacheReadTokens).toBe(MILLION / 4);
  });

  it("a row without `cached` charges cached input at the full input rate", async () => {
    endpoint({
      choices: [{ message: { content: "x" } }],
      usage: {
        prompt_tokens: MILLION,
        completion_tokens: MILLION,
        prompt_tokens_details: { cached_tokens: MILLION / 2 },
      },
    });
    const r = await generateVariant(
      { prompt: "p" },
      { ...MODEL_ENV_WITH_FALLBACK, MODEL_PRICES: PRICES },
      "fallback",
    );
    expect(r.costUsd).toBeCloseTo(1.32 + 3.96, 6);
  });

  it("a model without a price row costs 0, with or without a price table", async () => {
    endpoint();
    const none = await generateVariant({ prompt: "p" }, MODEL_ENV);
    const other = await generateVariant(
      { prompt: "p" },
      { ...MODEL_ENV, MODEL_PRICES: '{"model-z":{"in":1,"out":1}}' },
    );
    expect(none.costUsd).toBe(0);
    expect(other.costUsd).toBe(0);
    expect(none.cacheHit).toBe(false);
  });

  it("the spare's row prices a run on the binding", async () => {
    const { AI } = binding({
      choices: [{ message: { content: "x" } }],
      usage: { prompt_tokens: MILLION, completion_tokens: MILLION },
    });
    const r = await generateVariant(
      { prompt: "p" },
      {
        ...MODEL_ENV,
        AI,
        WORKERS_AI_MODEL: SPARE_MODEL_ID,
        MODEL_PRICES: JSON.stringify({ [SPARE_MODEL_ID]: { in: 0.44, out: 1.32, cached: 0.014 } }),
      },
      "spare",
    );
    expect(r.costUsd).toBeCloseTo(0.44 + 1.32, 6);
  });
});

describe("generateVariant, a malformed configuration var", () => {
  // Not JSON, and shaped like something a person might paste by mistake.
  const SECRET = "key=never-echoed";

  it.each(["MODEL_EXTRA_BODY", "MODEL_PRICES"] as const)(
    "%s that is not JSON stops the call before the request, naming the var and never its value",
    async (name) => {
      const { spy } = endpoint();
      const call = () => generateVariant({ prompt: "p" }, { ...MODEL_ENV, [name]: SECRET });
      await expect(call()).rejects.toThrow(`${name} is not valid JSON`);
      await expect(call()).rejects.not.toThrow(new RegExp(SECRET));
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("WORKERS_AI_EXTRA_INPUT that is not JSON stops the run on the binding the same way", async () => {
    const { AI } = binding();
    const call = () =>
      generateVariant(
        { prompt: "p" },
        {
          MODEL_ROUTE: "workers-ai",
          AI,
          WORKERS_AI_MODEL: SPARE_MODEL_ID,
          WORKERS_AI_EXTRA_INPUT: SECRET,
        },
      );
    await expect(call()).rejects.toThrow("WORKERS_AI_EXTRA_INPUT is not valid JSON");
    await expect(call()).rejects.not.toThrow(new RegExp(SECRET));
    expect(AI.run).not.toHaveBeenCalled();
  });

  it("an unknown MODEL_MAX_TOKENS_FIELD stops the call before the request", async () => {
    const { spy } = endpoint();
    await expect(
      generateVariant({ prompt: "p" }, { ...MODEL_ENV, MODEL_MAX_TOKENS_FIELD: "tokens" }),
    ).rejects.toThrow(/MODEL_MAX_TOKENS_FIELD must be/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("generateVariant, the result", () => {
  it("the prompt hash is stable for the same call and differs by prompt and by model", async () => {
    endpoint();
    const a = await generateVariant({ prompt: "same", cachedPreamble: "sys" }, MODEL_ENV);
    const b = await generateVariant({ prompt: "same", cachedPreamble: "sys" }, MODEL_ENV);
    const c = await generateVariant({ prompt: "other", cachedPreamble: "sys" }, MODEL_ENV);
    const d = await generateVariant(
      { prompt: "same", cachedPreamble: "sys" },
      { ...MODEL_ENV, MODEL_ID: "model-b" },
    );
    expect(a.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.promptHash).toBe(a.promptHash);
    expect(c.promptHash).not.toBe(a.promptHash);
    expect(d.promptHash).not.toBe(a.promptHash);
  });

  it("an answer with no content is an empty text, not a throw", async () => {
    endpoint({ choices: [{ message: { content: null } }] });
    const r = await generateVariant({ prompt: "p" }, MODEL_ENV);
    expect(r.text).toBe("");
    expect(r.costUsd).toBe(0);
  });
});
