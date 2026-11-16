/**
 * The write queue does nothing when the model is not configured in the
 * isolate (2026-09-30: right after a deploy a pass ran without the secret
 * and 32 rows failed on authentication).
 */
import { describe, expect, it, vi } from "vitest";
import { runRegenQueue } from "../src/cron/regen-queue.ts";
import { MODEL_ENV } from "./model-env.ts";

describe("the write queue without the model's key", () => {
  it.each([
    ["the key is not visible", { ...MODEL_ENV, MODEL_API_KEY: "" }],
    ["nothing is configured", {}],
    ["the binding route without its binding", { MODEL_ROUTE: "workers-ai", WORKERS_AI_MODEL: "m" }],
  ])("%s: skips the pass and touches no row", async (_name, model) => {
    const prepare = vi.fn();
    const orchestrate = vi.fn();
    const r = await runRegenQueue(
      { ...model, DB: { prepare }, VARIANTS: {} } as never,
      orchestrate,
    );
    expect(r).toEqual({ ran: [], locked: [], capped: [] });
    expect(prepare).not.toHaveBeenCalled();
    expect(orchestrate).not.toHaveBeenCalled();
  });
});
