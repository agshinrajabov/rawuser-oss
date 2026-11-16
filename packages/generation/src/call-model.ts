/**
 * One model call under a timeout, with the tiers of an outage: the role's
 * model, then the fallback model on the same endpoint, then the spare route.
 * Which tiers exist is configuration (model-config.ts).
 *
 * Moved out of orchestrator.ts on 2026-10-02 so the interactive reads (the
 * apply page's "Read my site", the brief suggestions) get the same guard as
 * the write queue. Before that they called generateVariant directly, with no
 * timeout, and an outage of the primary model left the apply page on
 * "Reading your page..." for as long as the browser waited.
 */

import type { GenerateEnv, GenerateInput, GenerateResult } from "./generateVariant.ts";
import { generateVariant } from "./generateVariant.ts";
import { fallbackIdFor, modelIdFor, spareId } from "./model-config.ts";

/** Default per-call timeout for the offline write queue. */
export const CALL_TIMEOUT_MS = 45_000;

/** Timeouts for one call: the first model, then each later tier. */
export interface CallTimeouts {
  firstMs?: number;
  fallbackMs?: number;
}

export interface TimedOk<T> {
  ok: true;
  value: T;
}

export interface TimedErr {
  ok: false;
  error: string;
}

/** Error text that means the model did not answer, not that the words were wrong. */
export const PROVIDER_DOWN = /Timeout after|HTTP 5\d\d|request failed|fetch failed|network/i;

/**
 * One model call under the timeout. A call the primary model did not answer
 * is made once more on the fallback model when one is configured, and once
 * more on the spare route when that exists and the endpoint answered
 * neither. The row then records the id of the model that answered, and its
 * price.
 */
export async function callModel(
  input: GenerateInput,
  env: CallEnv,
  timeouts: CallTimeouts = {},
): Promise<TimedOk<GenerateResult> | TimedErr> {
  const firstMs = timeouts.firstMs ?? CALL_TIMEOUT_MS;
  const fallbackMs = timeouts.fallbackMs ?? CALL_TIMEOUT_MS;
  const role = input.role ?? "write";
  const canFallBack = fallbackIdFor(env, role) !== null;
  // The memo of a silent primary is about the model every role shares. A
  // role with a model of its own neither reads it nor writes it: its
  // silence says nothing about the writer's model, and the reverse.
  const sharesPrimary = modelIdFor(env, role) === modelIdFor(env, "write");
  // The endpoint answered neither model a moment ago: straight to the spare
  // route for a while, so an outage pass does not pay two timeouts per version.
  if (spareId(env) !== null && (await endpointIsDown(env))) {
    return onSpare(
      input,
      env,
      { ok: false, error: "Model endpoint down (remembered)" },
      fallbackMs,
    );
  }
  // The primary answered nothing a moment ago: go straight to the fallback
  // for a while instead of paying the 45 s timeout on every call of the run.
  if (canFallBack && sharesPrimary && (await primaryIsDown(env))) {
    const second = await callWithTimeout(() => generateVariant(input, env, "fallback"), fallbackMs);
    if (second.ok || !PROVIDER_DOWN.test(second.error)) return second;
    await markEndpointDown(env);
    return onSpare(input, env, second, fallbackMs);
  }
  const first = await callWithTimeout(() => generateVariant(input, env), firstMs);
  if (first.ok || !PROVIDER_DOWN.test(first.error)) return first;
  if (!canFallBack) return onSpare(input, env, first, fallbackMs);
  if (sharesPrimary) await markPrimaryDown(env);
  console.warn(
    `[generate] the primary model did not answer (${first.error}); the fallback model for the next ${PRIMARY_BACKOFF_MS / 60_000} minutes`,
  );
  const second = await callWithTimeout(() => generateVariant(input, env, "fallback"), fallbackMs);
  if (second.ok || !PROVIDER_DOWN.test(second.error)) return second;
  await markEndpointDown(env);
  return onSpare(input, env, second, fallbackMs);
}

/**
 * The endpoint answered neither model: the same call on the spare route
 * (2026-10-18), other servers than the endpoint's. Only when the spare is
 * configured; without one the failure stands. Its row records the spare's
 * model id and price.
 */
async function onSpare(
  input: GenerateInput,
  env: CallEnv,
  failed: TimedErr,
  ms: number = CALL_TIMEOUT_MS,
): Promise<TimedOk<GenerateResult> | TimedErr> {
  if (spareId(env) === null) return failed;
  console.warn(
    `[generate] the model endpoint is down (${failed.error}); writing on the spare route`,
  );
  return callWithTimeout(() => generateVariant(input, env, "spare"), ms);
}

/**
 * Until when the primary model is skipped after it failed to answer. Kept in
 * this isolate and, since 2026-10-02, in KV, so every isolate of the worker
 * learns it: the five-minute write queue runs in a fresh isolate each pass
 * and used to pay the 45 s timeout again on every pass of an outage.
 * One KV write per outage, one read per isolate per 30 s at most.
 */
let primaryDownUntil = 0;
let primaryCheckedAt = 0;
const PRIMARY_BACKOFF_MS = 10 * 60_000;
const SHARED_CHECK_MS = 30_000;
export const PRIMARY_DOWN_KEY = "ops:model-primary-down-until";

/** Env for one call: the model configuration and the KV that shares the outage state. */
export type CallEnv = GenerateEnv & {
  VARIANTS?: KVNamespace;
};

async function primaryIsDown(env: CallEnv): Promise<boolean> {
  const now = Date.now();
  if (now < primaryDownUntil) return true;
  if (!env.VARIANTS || now - primaryCheckedAt < SHARED_CHECK_MS) return false;
  primaryCheckedAt = now;
  try {
    const until = Number(await env.VARIANTS.get(PRIMARY_DOWN_KEY));
    if (Number.isFinite(until) && until > now) {
      primaryDownUntil = until;
      return true;
    }
  } catch {
    // KV unreadable: try the primary, the timeout still guards the call.
  }
  return false;
}

async function markPrimaryDown(env: CallEnv): Promise<void> {
  primaryDownUntil = Date.now() + PRIMARY_BACKOFF_MS;
  if (!env.VARIANTS) return;
  try {
    await env.VARIANTS.put(PRIMARY_DOWN_KEY, String(primaryDownUntil), {
      expirationTtl: PRIMARY_BACKOFF_MS / 1000,
    });
  } catch {
    // This isolate still remembers; the others pay one timeout each.
  }
}

/**
 * The same memo for the whole endpoint (the primary and the fallback both
 * silent), so the calls of an outage go to the spare route at once
 * (2026-10-18).
 */
let endpointDownUntil = 0;
let endpointCheckedAt = 0;
export const ENDPOINT_DOWN_KEY = "ops:model-endpoint-down-until";

async function endpointIsDown(env: CallEnv): Promise<boolean> {
  const now = Date.now();
  if (now < endpointDownUntil) return true;
  if (!env.VARIANTS || now - endpointCheckedAt < SHARED_CHECK_MS) return false;
  endpointCheckedAt = now;
  try {
    const until = Number(await env.VARIANTS.get(ENDPOINT_DOWN_KEY));
    if (Number.isFinite(until) && until > now) {
      endpointDownUntil = until;
      return true;
    }
  } catch {
    // KV unreadable: ask the endpoint, the timeouts still guard the call.
  }
  return false;
}

async function markEndpointDown(env: CallEnv): Promise<void> {
  if (spareId(env) === null) return;
  endpointDownUntil = Date.now() + PRIMARY_BACKOFF_MS;
  if (!env.VARIANTS) return;
  try {
    await env.VARIANTS.put(ENDPOINT_DOWN_KEY, String(endpointDownUntil), {
      expirationTtl: PRIMARY_BACKOFF_MS / 1000,
    });
  } catch {
    // This isolate still remembers.
  }
}

/** Tests only: forget that the primary or the endpoint was down. */
export function resetProviderState(): void {
  primaryDownUntil = 0;
  primaryCheckedAt = 0;
  endpointDownUntil = 0;
  endpointCheckedAt = 0;
}

export async function callWithTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<TimedOk<T> | TimedErr> {
  // Use a ref so clearTimeout gets the correct handle regardless of Promise.race ordering.
  const timerRef: { handle: ReturnType<typeof setTimeout> | null } = { handle: null };

  const timeout = new Promise<never>((_, reject) => {
    timerRef.handle = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
  });

  try {
    const value = await Promise.race([fn(), timeout]);
    if (timerRef.handle !== null) clearTimeout(timerRef.handle);
    return { ok: true, value };
  } catch (e) {
    if (timerRef.handle !== null) clearTimeout(timerRef.handle);
    return { ok: false, error: String(e) };
  }
}
