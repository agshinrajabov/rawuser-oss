/**
 * The model configuration the tests run with: an endpoint that does not
 * exist and ids that name nobody. No test reaches a model; fetch and the
 * binding are mocked.
 */

/** The endpoint route with one model for every role, the smallest working configuration. */
export const MODEL_ENV = {
  MODEL_BASE_URL: "https://models.example/v1",
  MODEL_API_KEY: "test-key",
  MODEL_ID: "model-a",
} as const;

/** The same with the fallback model on the endpoint. */
export const MODEL_ENV_WITH_FALLBACK = {
  ...MODEL_ENV,
  MODEL_FALLBACK_ID: "model-b",
} as const;

/** The spare route's model id, for an env that also carries the `AI` binding. */
export const SPARE_MODEL_ID = "@spare/model-c";
