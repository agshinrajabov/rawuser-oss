/**
 * The time of a row's last failed try (J5 of docs/specs/pilot-gaps.md;
 * docs/specs/refused-versions.md, "A refused row is not paid for on every
 * pass").
 *
 * `writeErrorRow` never moves `generated_at`: it stays the time of the last
 * ready write, which other reads take as such. So once six hours had passed
 * since that write, a row that still failed was tried on every five-minute
 * pass, each try paying for a whole version. The last try needs its own
 * time, and the row has no column for it: one KV value per row,
 * `gen:tried:{the version's key}`, holding the time, written on every failed
 * try and gone by itself after six hours.
 *
 * The prefix is the write queue's own (`gen:lock:` is its neighbour). No
 * visitor path reads it: the edge reads `v1:` keys by their exact names, and
 * a version's key is only the tail of this one, never its beginning.
 */

/** As long as the queue leaves an errored row alone (`QUEUE_ERROR_RETRY_MS`). */
export const TRIED_TTL_S = 6 * 60 * 60;

/** The same, in milliseconds. */
export const TRIED_TTL_MS = TRIED_TTL_S * 1000;

/** The write queue runs every five minutes (its cron in wrangler.toml). */
export const QUEUE_PASS_MS = 5 * 60_000;

const PREFIX = "gen:tried:";

/** `gen:tried:v1:variant:{customer}:...`: the marker of one version key. */
export function triedKey(versionKey: string): string {
  return `${PREFIX}${versionKey}`;
}

/** The prefix of every marker of a customer's versions, for a delete or an export. */
export function triedPrefix(customerId: string): string {
  return `${PREFIX}v1:variant:${customerId}:`;
}

/**
 * Records that this row was tried now and failed. Best effort: without the
 * marker the queue falls back to the row's `generated_at`, as before.
 */
export async function markTried(kv: KVNamespace, versionKey: string): Promise<void> {
  try {
    await kv.put(triedKey(versionKey), String(Date.now()), { expirationTtl: TRIED_TTL_S });
  } catch {
    // The row is tried again sooner than it should be; nothing else breaks.
  }
}

/**
 * True when the row's last failed try is younger than `withinMs`. The time is
 * read from the value, so the answer does not hang on the minute KV drops the
 * key. A read that fails says no: the row is tried, as it was before.
 */
export async function triedWithin(
  kv: KVNamespace,
  versionKey: string,
  withinMs: number,
): Promise<boolean> {
  try {
    const at = Number(await kv.get(triedKey(versionKey)));
    return Number.isFinite(at) && at > 0 && at > Date.now() - withinMs;
  } catch {
    return false;
  }
}

/**
 * The time of the row's last failed try, or null without a marker. A read
 * that fails says null too: the caller then acts as if nothing was tried.
 */
export async function triedAt(kv: KVNamespace, versionKey: string): Promise<number | null> {
  try {
    const at = Number(await kv.get(triedKey(versionKey)));
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

/** The clocks of an error row, as the queue reads them (lib/queue-due.ts). */
export interface RowClocks {
  /** The row's last ready write, or the first failure of a row never ready. */
  generatedAt: number;
  /** The row's last failed try, from the marker; null without one. */
  triedAt: number | null;
  /**
   * A first write the copy checks refused and not yet tried again: the queue
   * tries it on its next pass whatever the clocks say (refused-versions.md,
   * "A first write tries again at once").
   */
  firstWriteDue: boolean;
}

/**
 * When the queue will next try an error row (J8 and J9 of
 * docs/specs/pilot-gaps.md): the first pass at or after six hours
 * from the later of its two clocks, or the next pass when that time has
 * passed or the first write's early retry is due. A pass is a five-minute
 * boundary of the clock.
 */
export function nextTryAt(clocks: RowClocks, now = Date.now(), waitMs = TRIED_TTL_MS): number {
  const nextPassAfter = (t: number) => (Math.floor(t / QUEUE_PASS_MS) + 1) * QUEUE_PASS_MS;
  const firstPassAtOrAfter = (t: number) => Math.ceil(t / QUEUE_PASS_MS) * QUEUE_PASS_MS;
  if (clocks.firstWriteDue) return nextPassAfter(now);
  const due = Math.max(clocks.generatedAt, clocks.triedAt ?? 0) + waitMs;
  return due <= now ? nextPassAfter(now) : firstPassAtOrAfter(due);
}

/** Forgets the markers of these rows, so the queue's next pass may try them. */
export async function clearTried(kv: KVNamespace, versionKeys: readonly string[]): Promise<void> {
  await Promise.all(
    versionKeys.map(async (k) => {
      try {
        await kv.delete(triedKey(k));
      } catch {
        // It expires by itself.
      }
    }),
  );
}
