/**
 * Which model a call runs on, and where: read from configuration.
 *
 * The code names no provider and no model. A call says what it is for (its
 * role); the worker's vars and one secret say which model id that is, on
 * which route, and what a token costs. Changing the model is a change of
 * values, never of code.
 *
 * Routes:
 *   - the OpenAI-compatible route (default): POST {MODEL_BASE_URL}/chat/completions
 *     with the bearer MODEL_API_KEY. Reaches most hosted providers and a
 *     local model server.
 *   - "workers-ai": the `AI` binding of the worker's own account, with
 *     WORKERS_AI_MODEL. Chosen with MODEL_ROUTE = "workers-ai".
 *
 * Tiers of one call (call-model.ts walks them when a model does not answer):
 *   - primary: the role's model id on the chosen route;
 *   - fallback: MODEL_FALLBACK_ID on the same endpoint, only when set;
 *   - spare: the `AI` binding with WORKERS_AI_MODEL, only when both exist
 *     and the primary is not already there.
 *
 * Vars (strings; an empty one counts as unset):
 *   MODEL_ROUTE              "workers-ai", or anything else for the endpoint
 *   MODEL_BASE_URL           the endpoint, up to and without /chat/completions
 *   MODEL_API_KEY            secret
 *   MODEL_ID                 the model every role uses unless it has its own
 *   MODEL_ID_READ            optional, the `read` role
 *   MODEL_ID_DETECT          optional, the `detect` role
 *   MODEL_FALLBACK_ID        optional, the second try on the same endpoint
 *   WORKERS_AI_MODEL         optional, the binding's model
 *   MODEL_EXTRA_BODY         optional JSON object, merged into every endpoint
 *                            request (a provider's own switches)
 *   WORKERS_AI_EXTRA_INPUT   optional JSON object, merged into the binding's input
 *   MODEL_MAX_TOKENS_FIELD   "max_tokens" (default) or "max_completion_tokens"
 *   MODEL_PRICES             optional JSON, USD per million tokens:
 *                            {"<model id>": {"in": n, "out": n, "cached": n}}
 *
 * A JSON var that does not parse stops the first call with a message that
 * names the var and never its value: the value may hold a key.
 */

/** What a call is for. `write`: versions. `read`: short structured reads. `detect`: page parts. */
export type Role = "write" | "read" | "detect";

/** Which try of a call this is (call-model.ts). */
export type Tier = "primary" | "fallback" | "spare";

/** Where a request goes: the OpenAI-compatible endpoint or the binding. */
export type Route = "endpoint" | "workers-ai";

/** The one method of the Workers AI binding we call. */
export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface ModelEnv {
  MODEL_ROUTE?: string;
  MODEL_BASE_URL?: string;
  MODEL_API_KEY?: string;
  MODEL_ID?: string;
  MODEL_ID_READ?: string;
  MODEL_ID_DETECT?: string;
  MODEL_FALLBACK_ID?: string;
  WORKERS_AI_MODEL?: string;
  MODEL_EXTRA_BODY?: string;
  WORKERS_AI_EXTRA_INPUT?: string;
  MODEL_MAX_TOKENS_FIELD?: string;
  MODEL_PRICES?: string;
  AI?: WorkersAiBinding;
}

/** USD per million tokens. `cached` is the rate of input the provider read from its cache. */
export interface ModelPrice {
  in: number;
  out: number;
  cached: number;
}

const set = (v: string | undefined): string => (typeof v === "string" ? v.trim() : "");

/** The route of the primary tier. */
export function modelRoute(env: ModelEnv): Route {
  return set(env.MODEL_ROUTE) === "workers-ai" ? "workers-ai" : "endpoint";
}

/**
 * True when a call can be made at all: the endpoint route needs its base
 * URL, key and model id visible; the binding route needs the binding and
 * its model. An isolate can run without a secret for a moment right after a
 * deploy, so callers ask before they start work they would only fail.
 */
export function modelConfigured(env: ModelEnv): boolean {
  if (modelRoute(env) === "workers-ai") return !!env.AI && set(env.WORKERS_AI_MODEL) !== "";
  return (
    set(env.MODEL_BASE_URL) !== "" && set(env.MODEL_API_KEY) !== "" && set(env.MODEL_ID) !== ""
  );
}

/** The primary model id of a role; "" when none is configured. */
export function modelIdFor(env: ModelEnv, role: Role = "write"): string {
  if (modelRoute(env) === "workers-ai") return set(env.WORKERS_AI_MODEL);
  const own =
    role === "read" ? set(env.MODEL_ID_READ) : role === "detect" ? set(env.MODEL_ID_DETECT) : "";
  return own || set(env.MODEL_ID);
}

/**
 * The fallback model id of a role, or null: only on the endpoint route, only
 * when MODEL_FALLBACK_ID is set, and never the role's own model (a second
 * try on the model that just failed buys nothing).
 */
export function fallbackIdFor(env: ModelEnv, role: Role = "write"): string | null {
  if (modelRoute(env) !== "endpoint") return null;
  const id = set(env.MODEL_FALLBACK_ID);
  return id && id !== modelIdFor(env, role) ? id : null;
}

/** The spare's model id, or null: the binding and its model, when the primary is on the endpoint. */
export function spareId(env: ModelEnv): string | null {
  if (modelRoute(env) !== "endpoint" || !env.AI) return null;
  return set(env.WORKERS_AI_MODEL) || null;
}

/** Where one tier of a role's call goes. Throws when that tier is not configured. */
export function tierTarget(
  env: ModelEnv,
  role: Role,
  tier: Tier,
): { route: Route; modelId: string } {
  if (tier === "spare") {
    const id = spareId(env);
    if (!id) throw new Error("The spare route is not configured");
    return { route: "workers-ai", modelId: id };
  }
  if (tier === "fallback") {
    const id = fallbackIdFor(env, role);
    if (!id) throw new Error("The fallback model is not configured");
    // The primary's endpoint and key. Without them nothing is sent: a
    // request with no key would come back refused, read as an outage, and
    // send the writes of the next ten minutes to the spare route.
    if (!modelConfigured(env)) throw new Error("The model is not configured");
    return { route: "endpoint", modelId: id };
  }
  if (!modelConfigured(env)) throw new Error("The model is not configured");
  return { route: modelRoute(env), modelId: modelIdFor(env, role) };
}

/** The endpoint's chat address. */
export function chatUrl(env: ModelEnv): string {
  return `${set(env.MODEL_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
}

/** The request field that carries the output limit on the endpoint route. */
export function maxTokensField(env: ModelEnv): "max_tokens" | "max_completion_tokens" {
  const v = set(env.MODEL_MAX_TOKENS_FIELD);
  if (v === "" || v === "max_tokens") return "max_tokens";
  if (v === "max_completion_tokens") return "max_completion_tokens";
  throw new Error('MODEL_MAX_TOKENS_FIELD must be "max_tokens" or "max_completion_tokens"');
}

/** A JSON object var; {} when unset. The message names the var, never its value. */
function objectVar(name: string, raw: string | undefined): Record<string, unknown> {
  const text = set(raw);
  if (text === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** MODEL_EXTRA_BODY: fields merged into every endpoint request. */
export function extraBody(env: ModelEnv): Record<string, unknown> {
  return objectVar("MODEL_EXTRA_BODY", env.MODEL_EXTRA_BODY);
}

/** WORKERS_AI_EXTRA_INPUT: fields merged into the binding's input. */
export function extraInput(env: ModelEnv): Record<string, unknown> {
  return objectVar("WORKERS_AI_EXTRA_INPUT", env.WORKERS_AI_EXTRA_INPUT);
}

const rate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * The price row of a model id from MODEL_PRICES, or null when it has none
 * (the call then costs 0). A row without `cached` charges cached input at
 * the full input rate.
 */
export function priceOf(env: ModelEnv, modelId: string): ModelPrice | null {
  const table = objectVar("MODEL_PRICES", env.MODEL_PRICES);
  if (!Object.hasOwn(table, modelId)) return null;
  const row = table[modelId] as { in?: unknown; out?: unknown; cached?: unknown } | null;
  if (
    typeof row !== "object" ||
    row === null ||
    !rate(row.in) ||
    !rate(row.out) ||
    (row.cached !== undefined && !rate(row.cached))
  ) {
    throw new Error('MODEL_PRICES rows must be {"in": n, "out": n, "cached": n} with numbers');
  }
  return { in: row.in, out: row.out, cached: rate(row.cached) ? row.cached : row.in };
}
