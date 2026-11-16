/**
 * generateVariant: the only place a model is called in Rawuser.
 *
 * Lives in @rawuser/generation and is never imported by the edge worker
 * (enforced by edge/biome.json restricted imports and the edge bundle
 * test). One request shape, the chat completions shape, sent on one of two
 * routes: an OpenAI-compatible endpoint or the Workers AI binding. Which
 * model, which route and what it costs come from configuration
 * (model-config.ts); callers say only what the call is for (its role).
 *
 * The preamble (the business DNA, the same across a run) goes in as the
 * system message. Providers that cache a repeated prefix do it on their
 * side and report the cached share of the input in `usage`; nothing is
 * asked of them for it.
 *
 * Cost: uncached input at the model's `in` rate, cached input at its
 * `cached` rate, output at its `out` rate, all from MODEL_PRICES. A model
 * without a price row costs 0.
 */

import {
  type ModelEnv,
  type Role,
  type Tier,
  chatUrl,
  extraBody,
  extraInput,
  maxTokensField,
  priceOf,
  tierTarget,
} from "./model-config.ts";

export type { ModelEnv, Role, Tier, WorkersAiBinding } from "./model-config.ts";

/** Low on purpose: copy that follows the brief, not a new idea on every call. */
const TEMPERATURE = 0.2;

export interface GenerateInput {
  /** The full user prompt sent to the model. */
  prompt: string;
  /**
   * Optional preamble (business DNA). When provided it is the system
   * message; when omitted no system message is sent.
   */
  cachedPreamble?: string;
  /** What the call is for; chooses the model id. Defaults to "write". */
  role?: Role;
  /** Defaults to 2048. */
  maxTokens?: number;
  /** Ask for a JSON object (`response_format`). */
  jsonMode?: boolean;
}

export interface GenerateResult {
  text: string;
  /** The id of the model that answered: a row records what wrote it. */
  model: string;
  costUsd: number;
  promptHash: string;
  cacheHit: boolean;
  /** Input tokens the provider read from its cache (0 when none). */
  cacheReadTokens: number;
}

/** Env of a model call: the configuration and, for the binding route, the binding. */
export type GenerateEnv = ModelEnv;

type Message = { role: "system" | "user"; content: string };

/** The chat completions answer both routes give. */
interface ChatAnswer {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    // Two spellings of the cached share of the input are in use.
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * One model call. `tier` is which try this is: call-model.ts asks for the
 * fallback or the spare when the primary does not answer; everything else
 * leaves it at "primary".
 */
export async function generateVariant(
  input: GenerateInput,
  env: GenerateEnv,
  tier: Tier = "primary",
): Promise<GenerateResult> {
  const { route, modelId } = tierTarget(env, input.role ?? "write", tier);
  const maxTokens = input.maxTokens ?? 2048;
  // Read before the request: a malformed price table stops the call here,
  // not after the tokens are spent.
  const price = priceOf(env, modelId);

  const messages: Message[] = [];
  if (input.cachedPreamble) messages.push({ role: "system", content: input.cachedPreamble });
  messages.push({ role: "user", content: input.prompt });

  const data =
    route === "workers-ai"
      ? await runOnBinding(input, env, modelId, messages, maxTokens)
      : await postToEndpoint(input, env, modelId, messages, maxTokens);

  const text = data.choices?.[0]?.message?.content ?? "";
  // A cut-off object is worse than no object: the caller would "repair" a
  // variant missing half its sections. Fail loudly instead.
  if (data.choices?.[0]?.finish_reason === "length") {
    throw new Error(
      `Model output truncated at max_tokens=${maxTokens} (content ${text.length} chars)`,
    );
  }
  const usage = data.usage ?? {};
  const cacheReadTokens =
    usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const missTokens = usage.prompt_cache_miss_tokens ?? (usage.prompt_tokens ?? 0) - cacheReadTokens;
  const outputTokens = usage.completion_tokens ?? 0;

  const costUsd = price
    ? (Math.max(missTokens, 0) / 1_000_000) * price.in +
      (cacheReadTokens / 1_000_000) * price.cached +
      (outputTokens / 1_000_000) * price.out
    : 0;

  const promptHash = await sha256Hex(`${modelId}::${input.cachedPreamble ?? ""}::${input.prompt}`);

  return {
    text,
    model: modelId,
    costUsd,
    promptHash,
    cacheHit: cacheReadTokens > 0,
    cacheReadTokens,
  };
}

/**
 * The OpenAI-compatible route. MODEL_EXTRA_BODY is merged last, so a
 * provider's own switch (thinking off, for one) or a different temperature
 * is a var; the model and the messages are always ours.
 */
async function postToEndpoint(
  input: GenerateInput,
  env: GenerateEnv,
  modelId: string,
  messages: Message[],
  maxTokens: number,
): Promise<ChatAnswer> {
  const body = {
    [maxTokensField(env)]: maxTokens,
    temperature: TEMPERATURE,
    stream: false,
    ...(input.jsonMode ? { response_format: { type: "json_object" } } : {}),
    ...extraBody(env),
    model: modelId,
    messages,
  };
  const resp = await fetch(chatUrl(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.MODEL_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    // Never log the body: it could echo the prompt (customer page text).
    throw new Error(`Model request failed: HTTP ${resp.status}`);
  }
  return (await resp.json()) as ChatAnswer;
}

/**
 * The same request on the Workers AI binding, whose chat answer has the
 * same shape (checked 2026-10-18: choices[0].message.content, usage with
 * prompt_tokens_details.cached_tokens, JSON mode honoured, about 2 s).
 * WORKERS_AI_EXTRA_INPUT is merged last, as on the endpoint.
 */
async function runOnBinding(
  input: GenerateInput,
  env: GenerateEnv,
  modelId: string,
  messages: Message[],
  maxTokens: number,
): Promise<ChatAnswer> {
  if (!env.AI) throw new Error("Workers AI binding is not configured");
  const request = {
    max_completion_tokens: maxTokens,
    temperature: TEMPERATURE,
    ...(input.jsonMode ? { response_format: { type: "json_object" } } : {}),
    ...extraInput(env),
    messages,
  };
  try {
    return (await env.AI.run(modelId, request)) as ChatAnswer;
  } catch (e) {
    // Never the message: it could echo the prompt. A failed run is the
    // model not answering, worded as callModel reads it.
    throw new Error(`Workers AI request failed: ${e instanceof Error ? e.name : "error"}`);
  }
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
