/**
 * model-config: which model a call runs on, where, and at what price, read
 * from the worker's vars. The code names no provider and no model; these
 * tests hold it to that with ids that name nobody.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  chatUrl,
  extraBody,
  extraInput,
  fallbackIdFor,
  maxTokensField,
  modelConfigured,
  modelIdFor,
  modelRoute,
  priceOf,
  spareId,
  tierTarget,
} from "../src/model-config.ts";
import { MODEL_ENV, MODEL_ENV_WITH_FALLBACK, SPARE_MODEL_ID } from "./model-env.ts";

const AI = { run: async () => ({}) };
const BINDING_ENV = { MODEL_ROUTE: "workers-ai", AI, WORKERS_AI_MODEL: SPARE_MODEL_ID };

describe("modelRoute and modelConfigured", () => {
  it('the endpoint is the route unless MODEL_ROUTE says "workers-ai"', () => {
    expect(modelRoute({})).toBe("endpoint");
    expect(modelRoute({ MODEL_ROUTE: "" })).toBe("endpoint");
    expect(modelRoute({ MODEL_ROUTE: "anything" })).toBe("endpoint");
    expect(modelRoute({ MODEL_ROUTE: " workers-ai " })).toBe("workers-ai");
  });

  it("the endpoint route needs its base URL, its key and a model id", () => {
    expect(modelConfigured(MODEL_ENV)).toBe(true);
    expect(modelConfigured({})).toBe(false);
    for (const name of ["MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_ID"] as const) {
      const { [name]: _, ...without } = MODEL_ENV;
      expect(modelConfigured(without), name).toBe(false);
      // An empty or blank var counts as unset.
      expect(modelConfigured({ ...MODEL_ENV, [name]: "" }), name).toBe(false);
      expect(modelConfigured({ ...MODEL_ENV, [name]: "  " }), name).toBe(false);
    }
  });

  it("a role's own model does not stand in for MODEL_ID", () => {
    const { MODEL_ID: _, ...noId } = MODEL_ENV;
    expect(modelConfigured({ ...noId, MODEL_ID_READ: "model-read" })).toBe(false);
  });

  it("the binding route needs the binding and its model, and nothing of the endpoint", () => {
    expect(modelConfigured(BINDING_ENV)).toBe(true);
    expect(modelConfigured({ MODEL_ROUTE: "workers-ai", AI })).toBe(false);
    expect(modelConfigured({ MODEL_ROUTE: "workers-ai", WORKERS_AI_MODEL: SPARE_MODEL_ID })).toBe(
      false,
    );
    // The endpoint's vars do not make the binding route work.
    expect(modelConfigured({ ...MODEL_ENV, MODEL_ROUTE: "workers-ai" })).toBe(false);
  });
});

describe("the model of a role", () => {
  it("every role defaults to MODEL_ID, and to write when no role is given", () => {
    expect(modelIdFor(MODEL_ENV)).toBe("model-a");
    expect(modelIdFor(MODEL_ENV, "write")).toBe("model-a");
    expect(modelIdFor(MODEL_ENV, "read")).toBe("model-a");
    expect(modelIdFor(MODEL_ENV, "detect")).toBe("model-a");
  });

  it("read and detect take their own id when set; write never does", () => {
    const env = { ...MODEL_ENV, MODEL_ID_READ: "model-read", MODEL_ID_DETECT: "model-detect" };
    expect(modelIdFor(env, "write")).toBe("model-a");
    expect(modelIdFor(env, "read")).toBe("model-read");
    expect(modelIdFor(env, "detect")).toBe("model-detect");
    expect(modelIdFor({ ...MODEL_ENV, MODEL_ID_READ: " " }, "read")).toBe("model-a");
  });

  it("on the binding route every role runs the binding's model", () => {
    const env = { ...BINDING_ENV, MODEL_ID: "model-a", MODEL_ID_DETECT: "model-detect" };
    expect(modelIdFor(env, "write")).toBe(SPARE_MODEL_ID);
    expect(modelIdFor(env, "detect")).toBe(SPARE_MODEL_ID);
  });

  it("nothing configured is an empty id, not a default model", () => {
    expect(modelIdFor({})).toBe("");
  });
});

describe("the tiers of a call", () => {
  it("no fallback unless MODEL_FALLBACK_ID is set", () => {
    expect(fallbackIdFor(MODEL_ENV)).toBeNull();
    expect(fallbackIdFor({ ...MODEL_ENV, MODEL_FALLBACK_ID: "" })).toBeNull();
    expect(fallbackIdFor(MODEL_ENV_WITH_FALLBACK)).toBe("model-b");
    expect(fallbackIdFor(MODEL_ENV_WITH_FALLBACK, "read")).toBe("model-b");
  });

  it("the fallback is never the role's own model: a second try on it buys nothing", () => {
    const env = { ...MODEL_ENV_WITH_FALLBACK, MODEL_ID_DETECT: "model-b" };
    expect(fallbackIdFor(env, "detect")).toBeNull();
    expect(fallbackIdFor(env, "write")).toBe("model-b");
    expect(fallbackIdFor({ ...MODEL_ENV, MODEL_FALLBACK_ID: "model-a" })).toBeNull();
  });

  it("the binding route has no fallback and no spare: it is already there", () => {
    const env = { ...BINDING_ENV, MODEL_FALLBACK_ID: "model-b" };
    expect(fallbackIdFor(env)).toBeNull();
    expect(spareId(env)).toBeNull();
  });

  it("the spare needs the binding and its model beside an endpoint primary", () => {
    expect(spareId(MODEL_ENV)).toBeNull();
    expect(spareId({ ...MODEL_ENV, AI })).toBeNull();
    expect(spareId({ ...MODEL_ENV, WORKERS_AI_MODEL: SPARE_MODEL_ID })).toBeNull();
    expect(spareId({ ...MODEL_ENV, AI, WORKERS_AI_MODEL: SPARE_MODEL_ID })).toBe(SPARE_MODEL_ID);
  });

  it("tierTarget says where each tier goes", () => {
    const env = { ...MODEL_ENV_WITH_FALLBACK, AI, WORKERS_AI_MODEL: SPARE_MODEL_ID };
    expect(tierTarget(env, "write", "primary")).toEqual({ route: "endpoint", modelId: "model-a" });
    expect(tierTarget(env, "write", "fallback")).toEqual({ route: "endpoint", modelId: "model-b" });
    expect(tierTarget(env, "write", "spare")).toEqual({
      route: "workers-ai",
      modelId: SPARE_MODEL_ID,
    });
    expect(tierTarget(BINDING_ENV, "read", "primary")).toEqual({
      route: "workers-ai",
      modelId: SPARE_MODEL_ID,
    });
  });

  it("the fallback is the primary's endpoint: without its key it is not configured either", () => {
    expect(() =>
      tierTarget({ ...MODEL_ENV_WITH_FALLBACK, MODEL_API_KEY: "" }, "write", "fallback"),
    ).toThrow("The model is not configured");
  });

  it("a tier that is not configured throws, in words that name no value", () => {
    expect(() => tierTarget({}, "write", "primary")).toThrow("The model is not configured");
    expect(() => tierTarget(MODEL_ENV, "write", "fallback")).toThrow(
      "The fallback model is not configured",
    );
    expect(() => tierTarget(MODEL_ENV, "write", "spare")).toThrow(
      "The spare route is not configured",
    );
  });
});

describe("the request's configuration", () => {
  it("the chat address is the base URL and the chat route, slashes folded", () => {
    expect(chatUrl(MODEL_ENV)).toBe("https://models.example/v1/chat/completions");
    expect(chatUrl({ MODEL_BASE_URL: "https://models.example/v1/" })).toBe(
      "https://models.example/v1/chat/completions",
    );
    expect(chatUrl({ MODEL_BASE_URL: "http://localhost:8080" })).toBe(
      "http://localhost:8080/chat/completions",
    );
  });

  it("the output limit's field is max_tokens unless the var names the other", () => {
    expect(maxTokensField({})).toBe("max_tokens");
    expect(maxTokensField({ MODEL_MAX_TOKENS_FIELD: "max_tokens" })).toBe("max_tokens");
    expect(maxTokensField({ MODEL_MAX_TOKENS_FIELD: "max_completion_tokens" })).toBe(
      "max_completion_tokens",
    );
    expect(() => maxTokensField({ MODEL_MAX_TOKENS_FIELD: "limit" })).toThrow(
      /MODEL_MAX_TOKENS_FIELD must be/,
    );
  });

  it("an unset extra body or extra input is an empty object", () => {
    expect(extraBody({})).toEqual({});
    expect(extraBody({ MODEL_EXTRA_BODY: "  " })).toEqual({});
    expect(extraInput({})).toEqual({});
  });

  it("a set one is the object it holds", () => {
    expect(extraBody({ MODEL_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' })).toEqual({
      thinking: { type: "disabled" },
    });
    expect(extraInput({ WORKERS_AI_EXTRA_INPUT: '{"reasoning_effort":"none"}' })).toEqual({
      reasoning_effort: "none",
    });
  });
});

describe("a malformed JSON var fails loudly", () => {
  // The value may hold a key pasted into the wrong var: it is never echoed.
  const VALUE = "{key: never-echoed-value";
  const cases = [
    ["MODEL_EXTRA_BODY", () => extraBody({ MODEL_EXTRA_BODY: VALUE })],
    ["WORKERS_AI_EXTRA_INPUT", () => extraInput({ WORKERS_AI_EXTRA_INPUT: VALUE })],
    ["MODEL_PRICES", () => priceOf({ MODEL_PRICES: VALUE }, "model-a")],
  ] as const;

  it.each(cases)("%s: the message names the variable and never its value", (name, read) => {
    let message = "";
    try {
      read();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toBe(`${name} is not valid JSON`);
    expect(message).not.toContain("never-echoed-value");
  });

  it("JSON that is not an object is refused the same way", () => {
    for (const value of ["[1,2]", '"text"', "7", "null"]) {
      expect(() => extraBody({ MODEL_EXTRA_BODY: value })).toThrow(
        "MODEL_EXTRA_BODY must be a JSON object",
      );
      expect(() => priceOf({ MODEL_PRICES: value }, "model-a")).toThrow(
        "MODEL_PRICES must be a JSON object",
      );
    }
  });
});

describe("priceOf", () => {
  const MODEL_PRICES = JSON.stringify({
    "model-a": { in: 0.3, out: 1.2, cached: 0.006 },
    "model-b": { in: 1.32, out: 3.96 },
    "model-free": { in: 0, out: 0, cached: 0 },
    "model-broken": { in: "0.3", out: 1.2 },
    "model-negative": { in: -1, out: 1 },
    "model-null": null,
  });

  it("a model's row, as written", () => {
    expect(priceOf({ MODEL_PRICES }, "model-a")).toEqual({ in: 0.3, out: 1.2, cached: 0.006 });
    expect(priceOf({ MODEL_PRICES }, "model-free")).toEqual({ in: 0, out: 0, cached: 0 });
  });

  it("a row without `cached` charges cached input at the input rate", () => {
    expect(priceOf({ MODEL_PRICES }, "model-b")).toEqual({ in: 1.32, out: 3.96, cached: 1.32 });
  });

  it("no table, or no row for the model: null, and the call costs 0", () => {
    expect(priceOf({}, "model-a")).toBeNull();
    expect(priceOf({ MODEL_PRICES }, "model-unknown")).toBeNull();
    // An inherited name is not a row.
    expect(priceOf({ MODEL_PRICES }, "toString")).toBeNull();
  });

  it("a row that is not numbers is refused, in words without the row", () => {
    for (const id of ["model-broken", "model-negative", "model-null"]) {
      expect(() => priceOf({ MODEL_PRICES }, id), id).toThrow(/MODEL_PRICES rows must be/);
    }
  });
});

// ---------------------------------------------------------------------------
// The source names no model provider's host
// ---------------------------------------------------------------------------

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? sourceFiles(join(dir, d.name))
      : d.name.endsWith(".ts")
        ? [join(dir, d.name)]
        : [],
  );
}

describe("no provider's host in the source", () => {
  const files = sourceFiles().map((path) => ({
    name: relative(SRC, path),
    text: readFileSync(path, "utf8"),
  }));

  it("reads the whole source tree", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((f) => f.name)).toContain("model-config.ts");
  });

  it("the chat route is written in one place, after the configured base URL", () => {
    const withRoute = files.filter((f) => f.text.includes("chat/completions")).map((f) => f.name);
    expect(withRoute).toEqual(["model-config.ts"]);
    const config = files.find((f) => f.name === "model-config.ts")?.text ?? "";
    // Never after a literal host: only after the var.
    expect(config).not.toMatch(/https?:\/\/[^\s"'`{]+\/chat\/completions/);
    expect(config).toContain("env.MODEL_BASE_URL");
  });

  it("the model layer holds no address at all", () => {
    for (const name of ["model-config.ts", "generateVariant.ts", "call-model.ts"]) {
      const text = files.find((f) => f.name === name)?.text ?? "";
      expect(text.length, name).toBeGreaterThan(0);
      expect(text, name).not.toMatch(/https?:\/\//);
    }
  });

  it("no file holds the address of a model API or a binding's model id", () => {
    // A provider's host shows as an address ending in an API route, and a
    // binding's model as "@account/maker/model". The release check holds
    // the names themselves (scripts/release-public.ts).
    const API_ADDRESS =
      /https?:\/\/[a-z0-9.-]+(?::\d+)?\/(?:v\d+[a-z]*\/)?(?:chat|completions|messages|responses|generate|models)\b/i;
    const BINDING_MODEL = /["'`]@[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9._-]+["'`]/i;
    // A module path has the same shape as a binding's model: not looked at.
    const MODULE_PATH = /\b(?:from|import)\s*\(?\s*["'][^"']+["']/g;
    for (const f of files) {
      expect(f.text.match(API_ADDRESS)?.[0], f.name).toBeUndefined();
      expect(f.text.replace(MODULE_PATH, "").match(BINDING_MODEL)?.[0], f.name).toBeUndefined();
    }
  });

  it("every model request goes to the configured address", () => {
    const text = files.find((f) => f.name === "generateVariant.ts")?.text ?? "";
    const fetches = text.match(/\bfetch\([^,]*/g) ?? [];
    expect(fetches).toEqual(["fetch(chatUrl(env)"]);
    const heartbeat = files.find((f) => f.name === join("cron", "ops-heartbeat.ts"))?.text ?? "";
    expect(heartbeat).toContain("fetch(chatUrl(env)");
  });
});
