/**
 * Warm on the tag (docs/specs/faster-tag.md §10, "Warm /select
 * (2026-10-26)", privacy review condition 3). A quiet site's visitor asks for
 * `/s/{id}.js` a few hundred ms before `/select`; when the tag had to read KV
 * (its location copy was stale or missing), the customer's `/select` values
 * are read into the copy of kv-copy.ts in `waitUntil`, so `/select` finds
 * them warm.
 *
 * - Only for an open customer with a readable bundle whose audit end `ae`
 *   has not passed: never an unknown id, a closed one or the off script
 *   (the caller decides with `mayWarm`).
 * - It reuses the bundle the tag read (kept with that read's `at` and R);
 *   the tombstone and the carry switch were read through the copy by the
 *   tag's own batch. It reads the language map and the version bodies of `/`
 *   and of every page the bundle lists, at most MAX_WARM_READS keys.
 * - Nothing of the request is used: the customer id from the tag's path is
 *   the only input. Nothing is logged, per warm or otherwise.
 * - The same reads `/select` would make a moment later, at the same
 *   `cacheTtl`, under the same 300 s bound: no promise changes.
 */

import {
  INTENT_DIMENSIONS,
  SOURCE_DIMENSIONS,
  customerLangKey,
  variantKeyForPath,
  visitorBundleKey,
} from "@rawuser/shared";
import { auditOf } from "./audit.ts";
import {
  COPY_REFRESH_MS,
  type CopyIo,
  KV_R_S,
  bodyKeepable,
  inMemory,
  keep,
  readThrough,
} from "./kv-copy.ts";

/** At most this many body keys per warm. */
export const MAX_WARM_READS = 120;

/** The tag may warm `/select`: open, a readable bundle, not past an audit's end. */
export function mayWarm(closed: boolean, bundle: unknown, now: number): boolean {
  if (closed) return false;
  if ((bundle as { v?: unknown } | null)?.v !== 1) return false;
  const audit = auditOf(bundle);
  if (audit?.ae !== undefined && now >= audit.ae) return false;
  return true;
}

/** The body keys a warm reads: `/` first, then the listed pages by path; folded intents only. */
export function warmKeys(customerId: string, bundle: unknown): string[] {
  const pages = (bundle as { pages?: unknown }).pages;
  const listed =
    pages && typeof pages === "object" && !Array.isArray(pages)
      ? Object.keys(pages)
          .filter((p) => p.startsWith("/") && p !== "/")
          .sort()
      : [];
  const sd = (bundle as { sd?: unknown }).sd;
  const intents =
    Array.isArray(sd) && sd.length > 0
      ? INTENT_DIMENSIONS.filter((d) => sd.includes(d))
      : [...INTENT_DIMENSIONS];
  const sources = ["default", ...SOURCE_DIMENSIONS];
  const out: string[] = [];
  for (const path of ["/", ...listed]) {
    if (!bodyKeepable(path, bundle)) continue;
    for (const intent of intents) {
      for (const source of sources) {
        if (out.length >= MAX_WARM_READS) return out;
        out.push(variantKeyForPath(customerId, path, intent, source));
      }
    }
  }
  return out;
}

/**
 * Keep the tag's bundle and read the rest of `/select`'s values into the
 * copy. Never throws; a failed read is simply not kept.
 */
export async function warmSelect(
  kv: KVNamespace,
  customerId: string,
  bundle: unknown,
  bundleAt: number,
  io: CopyIo,
): Promise<void> {
  if (io.off) return;
  const bundleKey = visitorBundleKey(customerId);
  // This isolate already holds a fresh copy: nothing to warm.
  const held = inMemory(kv, bundleKey, io.now);
  if (held && (io.now ?? Date.now()) - held.at <= COPY_REFRESH_MS) return;
  keep(kv, bundleKey, "bundle", { v: bundle, at: bundleAt, r: KV_R_S.bundle }, io);
  const reads = [
    readThrough(kv, customerLangKey(customerId), "lang", "text", io),
    ...warmKeys(customerId, bundle).map((k) => readThrough(kv, k, "body", "json", io)),
  ];
  await Promise.allSettled(reads);
}
