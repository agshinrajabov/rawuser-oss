/**
 * The five-minute write queue: one customer at a time under a KV lock, a
 * few tuples per invocation, the lock released after.
 */
import { describe, expect, it, vi } from "vitest";
import { type QueueEnv, lockKey, runRegenQueue } from "../../src/cron/regen-queue.ts";
import { MODEL_ENV } from "../model-env.ts";

function makeEnv(pending: string[], kvSeed: Record<string, string> = {}) {
  const kv = new Map(Object.entries(kvSeed));
  const env = {
    DB: {
      prepare: () => ({ all: async () => ({ results: pending.map((id) => ({ id })) }) }),
    },
    VARIANTS: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
    ...MODEL_ENV,
  } as unknown as QueueEnv;
  return { env, kv };
}

describe("runRegenQueue", () => {
  it("runs each pending customer with the tuple cap under a lock and frees the lock after", async () => {
    const { env, kv } = makeEnv(["lumera", "taskboard-test"]);
    const calls: Array<{ id: string; max: number }> = [];
    const orchestrate = vi.fn(async (id: string, _e: unknown, o: { maxTuples: number }) => {
      calls.push({ id, max: o.maxTuples });
      expect(kv.has(lockKey(id))).toBe(true);
      return { capped: id === "lumera" } as never;
    });
    const r = await runRegenQueue(env, orchestrate, 12);
    expect(calls).toEqual([
      { id: "lumera", max: 12 },
      { id: "taskboard-test", max: 12 },
    ]);
    expect(r.ran).toEqual(["lumera", "taskboard-test"]);
    expect(r.capped).toEqual(["lumera"]);
    expect(kv.size).toBe(0);
  });

  it("skips a customer another invocation holds, and frees the lock when the run throws", async () => {
    const { env, kv } = makeEnv(["lumera", "other"], { [lockKey("lumera")]: "1" });
    const orchestrate = vi.fn(async (id: string) => {
      if (id === "other") throw new Error("boom");
      return {} as never;
    });
    const r = await runRegenQueue(env, orchestrate);
    expect(r.locked).toEqual(["lumera"]);
    expect(orchestrate).toHaveBeenCalledTimes(1);
    expect(kv.has(lockKey("other"))).toBe(false);
  });
});
