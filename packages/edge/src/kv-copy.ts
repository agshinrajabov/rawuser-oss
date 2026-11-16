/**
 * Warm /select (docs/specs/faster-tag.md §10, "Warm /select (2026-10-26)",
 * privacy review CONDITIONAL PASS of the same day): a copy of the
 * customer-level KV values `/select` reads, so a quiet site's visitor does
 * not wait for KV's cold reads (measured 100 to 270 ms after a minute or
 * more without a request at a location, 3 to 5 ms warm).
 *
 * What may be kept, and nothing else (a closed set of keys):
 * - `bundle`, `v1:vm:{customer}`, only a readable bundle (`v === 1`);
 * - `closed`, the tombstone `v1:closed:{customer}`;
 * - `carry`, the carry switch `v1:carry-off:{customer}`;
 * - `lang`, the brief language map;
 * - `body`, a version body by its KV key, only for `/` or a path equal to an
 *   entry of the same answer's bundle `pages` (the customer's own confirmed
 *   pages; the caller decides with `bodyKeepable`). A path only a visitor
 *   sent is read from KV as before and never kept.
 * Nothing from the request goes into a value or its key.
 *
 * The bound, counted from KV: every kept value carries `at` (the time its KV
 * read began) and `r` (the longest `cacheTtl` any edge route reads that key
 * with, KV_R_S below), and is served only while `now - at + r <= 300 s`. KV
 * may hand over a value its location kept for up to `r`, so no value is ever
 * older than KV's own 300 s location cache allowed before the copy. Never
 * served past the bound; no stale-while-revalidate beyond it.
 *
 * Two layers, the same `{ v, at, r }` in both: the isolate's memory, then
 * the location's Cache API under `{origin}/_kv/{key}` (the worker answers
 * `/_kv/` 404 before any cache match), stored with `max-age` no longer than
 * the value's remaining bound. A Cache API value taken into memory keeps its
 * `at`. A value older than COPY_REFRESH_MS is read again from KV in
 * `waitUntil` (a refresh reads KV only, never the Cache API), one refresh per
 * key per isolate.
 *
 * Failure: a Cache API error, a stored value that does not parse or lacks
 * `at` or `r`, or one past its bound reads KV as before. A failed KV read is
 * never kept and is thrown to the caller, as a plain `kv.get` would.
 */

/** No value is used later than this after the KV read that produced it, counting KV's own cache. */
export const COPY_BOUND_MS = 300_000;
/** A kept value older than this is read again in the background. */
export const COPY_REFRESH_MS = 30_000;

export type CopyKind = "bundle" | "closed" | "carry" | "lang" | "body";

/**
 * R per key, privacy review condition 1: the longest `cacheTtl` any edge route
 * reads that key with. Every reader of the five keys reads at 60 s (KV's
 * default; a read without `cacheTtl` is 60 s too), so R is 60 for each and
 * a kept value lives 240 s. test/kv-ttl.test.ts lists every `cacheTtl` in
 * the edge's source and fails when one of these keys is read longer than R.
 */
export const KV_R_S: Readonly<Record<CopyKind, number>> = {
  bundle: 60,
  closed: 60,
  carry: 60,
  lang: 60,
  body: 60,
};

/** The `cacheTtl` every reader of a copied key passes: its R. */
export const KV_COPY_TTL_S = 60;

/** Past this many values per KV binding the memory starts again (bodies are the bulk). */
const MEMO_MAX = 2000;

export interface Kept {
  v: unknown;
  /** When the KV read that produced the value began, ms. */
  at: number;
  /** The R of that key, s. */
  r: number;
}

/** Where the value of a read came from: this isolate, the location's Cache API, or KV. */
export type CopyFrom = "mem" | "hit" | "miss";

export interface CopyIo {
  /** The location cache; null or absent: memory only. */
  cache?: Cache | null;
  /** The edge's origin, for the Cache API key. Without it: memory only. */
  origin?: string;
  /** For refreshes and Cache API writes; without it nothing is written there and no refresh runs. */
  defer?: (p: Promise<unknown>) => void;
  /** The clock, for tests. */
  now?: number;
  /** The off switch (`SELECT_COPY = "off"`): read KV every time, keep nothing. */
  off?: boolean;
  /** Told where each read came from (Server-Timing only). */
  onRead?: (from: CopyFrom) => void;
}

/** The value may be served at `now`: inside its bound, counted from KV. */
export function servable(k: Kept | null | undefined, now: number): k is Kept {
  if (!k || typeof k !== "object") return false;
  if (!Number.isFinite(k.at) || !Number.isFinite(k.r) || k.r < 0) return false;
  if (now < k.at) return false;
  return now - k.at + k.r * 1000 <= COPY_BOUND_MS;
}

/** Whole seconds left of the bound; 0 or less: not to be kept. */
export function remainingS(k: Kept, now: number): number {
  return Math.floor((COPY_BOUND_MS - (now - k.at) - k.r * 1000) / 1000);
}

const memos = new WeakMap<KVNamespace, Map<string, Kept>>();
const inflight = new WeakMap<KVNamespace, Map<string, Promise<Kept>>>();
const refreshing = new WeakMap<KVNamespace, Set<string>>();

function memoOf(kv: KVNamespace): Map<string, Kept> {
  let m = memos.get(kv);
  if (!m) {
    m = new Map();
    memos.set(kv, m);
  }
  return m;
}

function remember(kv: KVNamespace, key: string, k: Kept): void {
  const m = memoOf(kv);
  if (m.size >= MEMO_MAX && !m.has(key)) m.clear();
  m.set(key, k);
}

/** The value this isolate holds for a key, when inside its bound. No read. */
export function inMemory(kv: KVNamespace, key: string, now = Date.now()): Kept | null {
  const k = memos.get(kv)?.get(key);
  return servable(k, now) ? k : null;
}

/** The Cache API key of a KV key: a URL under `/_kv/`, which the worker never answers. */
export function copyCacheKey(origin: string, key: string): string {
  return `${new URL(origin).origin}/_kv/${encodeURIComponent(key)}`;
}

/** The kind's value may be kept: a bundle only when readable; everything else as read. */
function keepable(kind: CopyKind, v: unknown): boolean {
  if (kind === "bundle") return (v as { v?: unknown } | null)?.v === 1;
  return true;
}

async function readCache(cache: Cache, ckey: string, now: number): Promise<Kept | null> {
  try {
    const res = await cache.match(new Request(ckey));
    if (!res) return null;
    const parsed = (await res.json()) as Partial<Kept> | null;
    if (!parsed || typeof parsed !== "object" || !("v" in parsed)) return null;
    const k: Kept = { v: parsed.v, at: Number(parsed.at), r: Number(parsed.r) };
    return servable(k, now) ? k : null;
  } catch {
    return null;
  }
}

async function writeCache(cache: Cache, ckey: string, k: Kept, now: number): Promise<void> {
  const left = remainingS(k, now);
  if (left <= 0) return;
  try {
    await cache.put(
      new Request(ckey),
      new Response(JSON.stringify({ v: k.v, at: k.at, r: k.r }), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${left}`,
        },
      }),
    );
  } catch {
    // Not kept at the location: memory still has it, and KV is read next time.
  }
}

/** Keep a value in both layers. Only a value inside its bound and of a keepable kind. */
export function keep(
  kv: KVNamespace,
  key: string,
  kind: CopyKind,
  k: Kept,
  io: CopyIo,
  now = io.now ?? Date.now(),
): void {
  if (io.off || !keepable(kind, k.v) || !servable(k, now)) return;
  remember(kv, key, k);
  if (io.cache && io.origin && io.defer)
    io.defer(writeCache(io.cache, copyCacheKey(io.origin, key), k, now));
}

/** One KV read, shared by concurrent callers of the same isolate. Never kept here. */
function kvRead(
  kv: KVNamespace,
  key: string,
  kind: CopyKind,
  type: "json" | "text",
  now: number,
): Promise<Kept> {
  let m = inflight.get(kv);
  if (!m) {
    m = new Map();
    inflight.set(kv, m);
  }
  const running = m.get(key);
  if (running) return running;
  const at = now;
  const r = KV_R_S[kind];
  const p = (async () => {
    const v =
      type === "json"
        ? await kv.get(key, { type: "json", cacheTtl: r })
        : await kv.get(key, { cacheTtl: r });
    return { v, at, r } as Kept;
  })();
  const done = () => m?.delete(key);
  p.then(done, done);
  m.set(key, p);
  return p;
}

function refresh(
  kv: KVNamespace,
  key: string,
  kind: CopyKind,
  type: "json" | "text",
  io: CopyIo,
): void {
  if (!io.defer || io.off) return;
  let set = refreshing.get(kv);
  if (!set) {
    set = new Set();
    refreshing.set(kv, set);
  }
  if (set.has(key)) return;
  set.add(key);
  const s = set;
  io.defer(
    (async () => {
      try {
        const fresh = await kvRead(kv, key, kind, type, Date.now());
        keep(kv, key, kind, fresh, io, Date.now());
      } catch {
        // A failed refresh keeps the value until its bound; then KV is read first.
      } finally {
        s.delete(key);
      }
    })(),
  );
}

export interface CopyRead {
  value: unknown;
  from: CopyFrom;
  /** The value with its `at` and `r`, for a caller that keeps it later (bodies). */
  kept: Kept;
}

/**
 * A KV value through the copy. `store: false` (bodies before the bundle is
 * known) reads and serves through the copy but does not keep what KV gave;
 * the caller keeps it with `keep` once it knows the path is allowed.
 */
export async function readThrough(
  kv: KVNamespace,
  key: string,
  kind: CopyKind,
  type: "json" | "text",
  io: CopyIo,
  opts: { store?: boolean } = {},
): Promise<CopyRead> {
  const now = io.now ?? Date.now();
  if (io.off) {
    const k = await kvRead(kv, key, kind, type, now);
    io.onRead?.("miss");
    return { value: k.v, from: "miss", kept: k };
  }
  const mem = inMemory(kv, key, now);
  if (mem) {
    if (now - mem.at > COPY_REFRESH_MS) refresh(kv, key, kind, type, io);
    io.onRead?.("mem");
    return { value: mem.v, from: "mem", kept: mem };
  }
  if (io.cache && io.origin) {
    const hit = await readCache(io.cache, copyCacheKey(io.origin, key), now);
    if (hit) {
      // Into memory with the `at` it was read with: the bound never restarts.
      remember(kv, key, hit);
      if (now - hit.at > COPY_REFRESH_MS) refresh(kv, key, kind, type, io);
      io.onRead?.("hit");
      return { value: hit.v, from: "hit", kept: hit };
    }
  }
  const k = await kvRead(kv, key, kind, type, now);
  if (opts.store !== false) keep(kv, key, kind, k, io, now);
  io.onRead?.("miss");
  return { value: k.v, from: "miss", kept: k };
}

/** A body may be kept only for `/` or a path equal to an entry of the answer's bundle `pages`. */
export function bodyKeepable(path: string, bundle: unknown): boolean {
  if (path === "/") return true;
  const pages = (bundle as { pages?: unknown } | null)?.pages;
  if (!pages || typeof pages !== "object" || Array.isArray(pages)) return false;
  return Object.prototype.hasOwnProperty.call(pages, path);
}

/** The batch's word for Server-Timing: all from memory, all from a copy, or any from KV. */
export function batchWord(froms: readonly CopyFrom[]): CopyFrom {
  if (froms.some((f) => f === "miss")) return "miss";
  if (froms.some((f) => f === "hit")) return "hit";
  return "mem";
}

/** Tests only: forget every kept value of a binding. */
export function forgetCopy(kv: KVNamespace): void {
  memos.delete(kv);
  inflight.delete(kv);
  refreshing.delete(kv);
}
