/**
 * /s/{customer}.js: the customer's own copy of the snippet (quiet swap,
 * docs/specs/quiet-swap.md), prefixed with the configuration the tag used
 * to carry as data-* attributes plus the hide rules derived from the
 * confirmed manifests, so the elements Rawuser will rewrite are hidden
 * before first paint. The code after the config line is the boot
 * (boot-asset.ts) for every policy here, which loads the shared core
 * `/s/_core/{hash}.js` (core-script.ts, docs/specs/faster-tag.md step 4)
 * when the page needs it. Until step 6's E1 (2026-10-26) the off script, an
 * audit's, one before go live and one without a read bundle were the whole
 * snippet, as `/snippet.js`; that file treats an `async` tag as late and
 * never disables a pasted `<style data-rawuser-pre>` (the two-part tag), so
 * such a page kept its parts hidden to the paste's 1.5 s backstop. Now only
 * `/snippet.js` is the single file, and it never gets a paste. One KV batch builds the script,
 * fresh five minutes so a confirm shows up quickly, then served stale for a
 * day while the browser refreshes it (CACHE_STALE_OK); one minute and never
 * stale until the customer has a confirmed page (CACHE_BEFORE_LIVE); never
 * per visitor (browsers cache the script; /select is untouched). A script of
 * the normal policy is also kept in the location's Cache API copy and
 * answered from it (COPY_FRESH_MS, below, docs/specs/faster-tag.md A).
 */

import { hideRulesKey, richKey, visitorBundleKey } from "@rawuser/shared";
import { auditOf } from "./audit.ts";
import { isCarryOff } from "./body-carry.ts";
import { BOOT_ETAG, BOOT_JS } from "./boot-asset.ts";
import { closedInMemo, isClosed } from "./closed.ts";
import { choiceRecallFor } from "./direct.ts";
import { etagMatches } from "./etag.ts";
import { type CopyIo, KV_COPY_TTL_S } from "./kv-copy.ts";
import { mayWarm, warmSelect } from "./select-warm.ts";

interface ScriptEnv {
  VARIANTS: KVNamespace;
}

const CUSTOMER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Fresh for five minutes, so a confirm reaches a browser quickly. */
const CACHE = "public, max-age=300";
/**
 * The file from the browser's cache (docs/specs/late-tag.md, 2026-10-12): a
 * browser that has the file runs it at once and refreshes it in the
 * background, for a day past the five minutes. A tag at the end of the body
 * wins the race with the first paint more often when its file needs no
 * round trip. What a stale file may hold: the hide rules and the rich pages
 * as they were up to a day ago (a part hidden and shown as built, or a new
 * part not hidden on that one load). The version always comes from /select.
 *
 * Not on the two answers where a stale file would outlive a switch that is
 * a promise about recording, both left at five minutes as before:
 * - the off script (a deleted customer, an audit past its end);
 * - an audit customer's script, which carries the audit's end `ae` for the
 *   snippet's own check before it writes a visit marker; an end moved
 *   earlier (End now) must reach the browser as fast as today.
 * For every other switch the edge answers on /select whatever the script
 * says: carry off (`carry=` ignored, `carry_off` answered), a customer
 * deleted since (`off: 1`; a script a browser cached before the delete may
 * still run once within the day, is answered off and clears the tab).
 *
 * Stale serving is allowed only when the customer's bundle was read and is
 * not an audit's (privacy review, 2026-10-12): when the read
 * failed or there is no bundle yet, we cannot know that this is not an
 * audit, and an audit's script without its end must not live for a day.
 * Such a script lives one minute (CACHE_BEFORE_LIVE): shorter is the safer
 * side for a file that may lack an audit's end.
 */
const CACHE_STALE_OK = `${CACHE}, stale-while-revalidate=86400`;
/**
 * Before go live (the lab recheck of 2026-10-12, task B11): the customer's
 * bundle was read and lists no confirmed page, so this script has nothing to
 * hide yet. It lives one minute and is never served stale.
 *
 * Why: right after go live the operator opens the page to see a version. A
 * browser that still runs the script it fetched before go live has no hide
 * rules, so the parts are not hidden and the words change in view on that
 * load; with stale serving, a browser that came back within the day ran the
 * old file once more before the refresh reached it.
 *
 * The cost, on a site that has the tag and is not live: a visitor's browser
 * asks for the file again on a page view more than a minute after the last
 * (a 304 of a few hundred bytes since the weak etag comparison, but one
 * round trip in front of a tag that sits first in the head), where it used
 * to ask after five minutes, or not at all while stale serving covered it.
 * No version is served there, so no swap is lost to it.
 *
 * From the first script that sees a page in the bundle, the normal policy.
 *
 * What an operator can still see in the first minute after go live:
 * - a browser that fetched the script in the minute before go live runs it
 *   once more as it is: the parts show as built and then change in view;
 * - the edge location's own copy of the hide rules is up to a minute old (a
 *   KV write takes up to a minute to reach every location, and a read is
 *   kept a minute there), so a script fetched in that minute may still come
 *   without rules, and the browser keeps it for one more minute. Two
 *   minutes after go live at the outside; a reload after that is hidden
 *   before the first paint;
 * - the bundle read is kept five minutes at a location, so the script can
 *   go on saying one minute for five minutes after go live. That only
 *   shortens its life; the rules in it are the new ones.
 *
 * The same minute for a script whose bundle was not read (none yet: the
 * very first load of a new tag, before any /select wrote one back; or the
 * read failed): it has no rules to trust either, and the privacy review allowed
 * the shorter life there (2026-10-12, on `861eef9`). The cost is one
 * revalidation a minute, a 304, while that lasts.
 */
const CACHE_BEFORE_LIVE = "public, max-age=60";

/** The bundle lists at least one confirmed page. A KV value is whatever was written. */
function listsPage(bundle: unknown): boolean {
  const pages = (bundle as { pages?: unknown } | null)?.pages;
  return (
    pages !== null &&
    typeof pages === "object" &&
    !Array.isArray(pages) &&
    Object.keys(pages).length > 0
  );
}

/**
 * Every confirmed page's path, also one with nothing to hide (its parts are
 * buttons left off, or have no css selector): the snippet leaves any other
 * page as built (docs/specs/quiet-swap.md §2b). `h` cannot say this, it
 * lists a page only when it has rules.
 */
function confirmedPaths(bundle: unknown): string[] {
  if (!listsPage(bundle)) return [];
  return Object.keys((bundle as { pages: object }).pages).filter((k) => k.startsWith("/"));
}

/** The bundle carries a keyword lexicon (`kl`): an object with at least one intent. */
function hasLexicon(bundle: unknown): boolean {
  const kl = (bundle as { kl?: unknown } | null)?.kl;
  return kl !== null && typeof kl === "object" && !Array.isArray(kl) && Object.keys(kl).length > 0;
}

export function customerScriptId(pathname: string): string | null {
  const m = /^\/s\/([^/]+)\.js$/.exec(pathname);
  const id = m?.[1] ?? null;
  return id && CUSTOMER_ID_RE.test(id) ? id : null;
}

/**
 * The location's copy of the assembled script (docs/specs/faster-tag.md,
 * option A, built 2026-10-25). A quiet site's first visitor at a Cloudflare
 * location used to wait for five cold KV reads (305 to 361 ms to first byte
 * against 45 to 62 warm); the copy is answered at once from the location's
 * Cache API and rebuilt from KV in `waitUntil` for the next request.
 *
 * - Kept only for the normal policy (CACHE_STALE_OK: a bundle that was read,
 *   lists a confirmed page and is not an audit's). Never the off script,
 *   never an audit's script, never a script before go live or without a read
 *   bundle: those are built from KV on every request, as before.
 * - Fresh for COPY_FRESH_MS: answered with no KV read. Older, up to
 *   COPY_MAX_AGE_MS: answered at once and rebuilt in the background; the
 *   rebuild replaces the copy, or deletes it when the new script is one of
 *   the kinds above that are never kept. Older than that: rebuilt first.
 * - The answer carries `Age`, so a browser counts its five fresh minutes and
 *   its day of stale serving from when the copy was built, not from when it
 *   was handed out: the oldest content a browser can run stays a day and
 *   five minutes, as before the copy.
 * - Keyed by the edge's own origin (the `e` in the script), the customer and
 *   the snippet build: a deploy starts new copies. Nothing per visitor is in
 *   the key or the body; the request's only other input is `If-None-Match`,
 *   which decides 200 or 304 and is never stored.
 * - KV writes cannot purge another location's Cache API, so a change in the
 *   bundle or the hide rules reaches a location's copy through the rebuild:
 *   on an active location within about a minute (the fresh window), on a
 *   quiet one on the request after the first.
 */
export const COPY_FRESH_MS = 60_000;
export const COPY_MAX_AGE_MS = 86_400_000;
/** The Cache API keeps the copy as long as it may be served. */
const COPY_STORE_CACHE = `public, max-age=${COPY_MAX_AGE_MS / 1000}`;
/**
 * KV's location cache for the rich pages on this route (not a key `/select`
 * reads, so not under the copy's R). The bundle, the tombstone and the carry
 * switch are read at R, 60 s (kv-copy.ts, privacy review condition 1 of
 * 2026-10-26: before, the bundle and the carry switch were read at 300 s
 * here).
 */
const TAG_KV_TTL_S = 300;

export interface ScriptOptions {
  /** For the background rebuild and the copy's writes; without it nothing is kept. */
  ctx?: ExecutionContext;
  /** The location cache; `undefined` reads `caches.default`, `null` turns the copy off. */
  cache?: Cache | null;
  /** The clock, for tests. */
  now?: number;
  /** Warm on the tag (select-warm.ts); false turns it off (`SELECT_COPY = "off"`). Default on. */
  warm?: boolean;
  /** `/select`'s copy's location cache; `undefined` reads `caches.default`, `null`: memory only. */
  selectCache?: Cache | null;
}

/** The script as KV makes it: its text, its etag and its browser policy. */
interface Built {
  prefix: string;
  etag: string;
  policy: string;
  /** The normal policy: a location may keep this script. */
  keep: boolean;
  kvMs: number;
  /** For warm on the tag only: the bundle read, its `at`, and whether `/select` may be warmed. */
  warm?: { bundle: unknown; at: number };
}

/** A copy read back from the location cache. */
interface Copy {
  body: string;
  etag: string;
  policy: string;
  built: number;
}

/**
 * The copy's cache key: the edge's origin, the customer and the boot build
 * (a copy is only ever the normal policy, which is the boot; the boot names
 * its core, so a new core is a new boot build too).
 */
export function copyKey(origin: string, customerId: string): string {
  const u = new URL(`/s/${customerId}.js`, origin);
  u.searchParams.set("build", BOOT_ETAG.replace(/"/g, ""));
  return u.toString();
}

function defaultCache(): Cache | null {
  return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
}

/** One rebuild per copy per isolate at a time. */
const rebuilding = new Map<string, Promise<void>>();

export async function handleCustomerScript(
  request: Request,
  env: ScriptEnv,
  customerId: string,
  opts: ScriptOptions = {},
): Promise<Response> {
  const started = Date.now();
  const now = opts.now ?? started;
  const origin = new URL(request.url).origin;
  const ctx = opts.ctx;
  const cache = ctx ? (opts.cache === undefined ? defaultCache() : opts.cache) : null;
  const key = copyKey(origin, customerId);
  const warmOn = opts.warm !== false;
  // The tombstone and the carry switch go through `/select`'s copy
  // (kv-copy.ts), and so does a warm: the location cache, our origin, the
  // request's waitUntil. Without ctx: memory only.
  const selectCache = opts.selectCache === undefined ? defaultCache() : opts.selectCache;
  const io: Omit<CopyIo, "now"> = {
    cache: warmOn && ctx ? selectCache : null,
    origin,
    ...(ctx ? { defer: (p: Promise<unknown>) => ctx.waitUntil(p) } : {}),
    off: !warmOn,
  };
  let expired = false;
  // A customer this isolate saw deleted is never answered from a copy.
  if (cache && ctx && !closedInMemo(env.VARIANTS, customerId, now)) {
    const copy = await readCopy(cache, key);
    if (copy) {
      const age = now - copy.built;
      if (age >= 0 && age <= COPY_MAX_AGE_MS) {
        const stale = age > COPY_FRESH_MS;
        if (stale) ctx.waitUntil(rebuildCopy(cache, key, env, customerId, origin, now, io));
        return answer(request, copy.body, copy.etag, copy.policy, {
          cache: stale ? "stale" : "hit",
          ageS: Math.floor(age / 1000),
          started,
        });
      }
      expired = true;
    }
  }
  const built = await buildScript(env, customerId, origin, now, io);
  if (ctx && warmOn && built.warm) {
    ctx.waitUntil(
      warmSelect(env.VARIANTS, customerId, built.warm.bundle, built.warm.at, { ...io, now }),
    );
  }
  if (cache && ctx) {
    if (built.keep) ctx.waitUntil(writeCopy(cache, key, built, now));
    else if (expired)
      ctx.waitUntil(
        cache.delete(key).then(
          () => undefined,
          () => undefined,
        ),
      );
  }
  return answer(request, scriptText(built), built.etag, built.policy, {
    cache: "miss",
    kvMs: built.kvMs,
    started,
  });
}

/** The five KV reads and the configuration they make (the handler before the copy). */
async function buildScript(
  env: ScriptEnv,
  customerId: string,
  origin: string,
  now: number,
  io: Omit<CopyIo, "now"> = {},
): Promise<Built> {
  const kvStart = Date.now();
  const [rules, off, rich, closed, bundle] = await Promise.all([
    // The hide rules keep KV's default minute at the location: go live must
    // reach a script within about two minutes (CACHE_BEFORE_LIVE, task B11).
    env.VARIANTS.get(hideRulesKey(customerId)).then((r) => r ?? "{}"),
    isCarryOff(env.VARIANTS, customerId, { ...io, now }),
    env.VARIANTS.get(richKey(customerId), { cacheTtl: TAG_KV_TTL_S }).then(richPaths),
    isClosed(env.VARIANTS, customerId, now, io),
    // The audit's domain and end (ai-traffic-audit.md §3.4), in the same
    // batch; read from KV at R (60 s), never from a copy, so the script
    // and a warm both start from what KV hands over now.
    env.VARIANTS.get(visitorBundleKey(customerId), {
      type: "json",
      cacheTtl: KV_COPY_TTL_S,
    }).catch(() => null),
  ]);
  const kvMs = Date.now() - kvStart;
  const audit = auditOf(bundle);
  // A deleted customer (closed.ts): the off script. No hide rules, no
  // request; the snippet removes the tab's visit, carry and body keys and
  // leaves the page as built.
  // An audit past its end gets the same (§3.8, privacy review condition 2).
  if (closed || (audit?.ae !== undefined && now >= audit.ae)) {
    return finish({ c: customerId, e: origin, off: 1 }, CACHE, kvMs);
  }
  // Warm on the tag (privacy review condition 3): only an open customer with a
  // readable bundle whose audit end has not passed, never the off script.
  const warm = mayWarm(closed, bundle, now) ? { bundle, at: now } : undefined;
  // `nc: 1`: the customer turned the carries off; the snippet removes what
  // the tab kept before anything else (body carry, condition 6).
  // `x`: the pages that need the rich writers, `/rich.js` (2026-09-30); only
  // when there are some, so a plain site's script is unchanged.
  // `p`: the confirmed pages, only from a bundle that was read and has
  // some; without it the snippet treats every page as it did before.
  const bundleRead = (bundle as { v?: unknown } | null)?.v === 1;
  const pages = bundleRead ? confirmedPaths(bundle) : [];
  // `nt: 1`: the snippet does not forward utm_term (keyword-intent.md;
  // privacy review section 9, answer 3). Whenever the bundle has no lexicon `kl`
  // (none built, a bundle not read, or one of the cases where the bundle
  // writers leave `kl` out), so the keyword leaves the page only for a
  // customer whose edge reads it. Only the presence of `kl` is looked at;
  // the lexicon itself never reaches the script.
  const keywordRead = bundleRead && hasLexicon(bundle);
  const cfg = {
    c: customerId,
    e: origin,
    h: JSON.parse(rules),
    ...(pages.length > 0 ? { p: pages } : {}),
    ...(off ? { nc: 1 } : {}),
    ...(keywordRead ? {} : { nt: 1 }),
    ...(rich.length > 0 ? { x: rich } : {}),
    // An audit customer (privacy review condition 1): the snippet compares the
    // page's host with `ad` and the clock with `ae` before it writes a visit
    // marker or sends anything. `ad` is always there for an audit, "" when
    // the bundle lacks one, so a malformed audit matches no host.
    ...(audit ? { ad: audit.ad ?? "", ...(audit.ae !== undefined ? { ae: audit.ae } : {}) } : {}),
  };
  // The policy, by what the bundle says:
  // - an audit's: five minutes, never stale;
  // - not read (missing, or the read failed), or read with no confirmed
  //   page yet (before go live): one minute, never stale;
  // - read, with a page: five minutes, then stale for a day while the
  //   browser refreshes it.
  const policy = audit
    ? CACHE
    : bundleRead && listsPage(bundle)
      ? CACHE_STALE_OK
      : CACHE_BEFORE_LIVE;
  // The visitor's own answer, remembered by its browser (docs/specs/
  // direct-visitors.md §2, ADR 0039): only while the question is on.
  const recall = bundleRead ? choiceRecallFor(bundle) : "";
  return { ...(await finish(cfg, policy, kvMs, recall)), ...(warm ? { warm } : {}) };
}

async function finish(
  cfg: Record<string, unknown>,
  policy: string,
  kvMs: number,
  recall = "",
): Promise<Built> {
  const prefix = `window.__rw=${JSON.stringify(cfg)};${recall}`;
  // Only the normal policy may be kept; the off script, an audit's and a
  // script before go live are built from KV on every request.
  const keep = policy === CACHE_STALE_OK;
  // Every policy's body is the boot (scriptText), so its build names the etag.
  const build = BOOT_ETAG.replace(/"/g, "");
  const etag = `"${build}-${await shortHash(prefix)}"`;
  return { prefix, etag, policy, keep, kvMs };
}

/**
 * The script's body: the boot, for every policy (faster-tag.md step 6, E1).
 * The boot runs the same checks as the single file did (`startBoot`: the
 * measuring frame, no configuration, `off`, an audit's host and end, pick
 * and capture) and loads the core only for a page it will pass, so for a
 * tag without a paste nothing a visitor sees, sends or keeps changes; only
 * the delivery does (the off script and an audit off its host load no core
 * at all, 4 KB where they were 15). With a paste, the boot runs the paste's
 * late-tag rule (`preLate`) and disables the paste on every way out
 * (`preDone`), so no per-customer script leaves a page's parts hidden to
 * the paste's backstop.
 */
function scriptText(b: { prefix: string }): string {
  return `${b.prefix}\n${BOOT_JS}`;
}

async function readCopy(cache: Cache, key: string): Promise<Copy | null> {
  try {
    const res = await cache.match(new Request(key));
    if (!res) return null;
    const etag = res.headers.get("x-rw-etag") ?? "";
    const policy = res.headers.get("x-rw-policy") ?? "";
    const built = Number(res.headers.get("x-rw-built"));
    // Only a copy of the normal policy is ever answered, whatever was stored.
    if (!etag || policy !== CACHE_STALE_OK || !Number.isFinite(built)) {
      await res.body?.cancel();
      return null;
    }
    return { body: await res.text(), etag, policy, built };
  } catch {
    // The cache is a speed-up only: any failure reads KV as before.
    return null;
  }
}

async function writeCopy(cache: Cache, key: string, b: Built, now: number): Promise<void> {
  try {
    await cache.put(
      new Request(key),
      new Response(scriptText(b), {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": COPY_STORE_CACHE,
          "x-rw-etag": b.etag,
          "x-rw-policy": b.policy,
          "x-rw-built": String(now),
        },
      }),
    );
  } catch {
    // Not kept: the next request reads KV.
  }
}

/** Rebuild from KV after the copy was answered; replace it, or drop it when it may no longer be kept. */
function rebuildCopy(
  cache: Cache,
  key: string,
  env: ScriptEnv,
  customerId: string,
  origin: string,
  now: number,
  io: Omit<CopyIo, "now"> = {},
): Promise<void> {
  const running = rebuilding.get(key);
  if (running) return running;
  const run = (async () => {
    try {
      const b = await buildScript(env, customerId, origin, now, io);
      if (b.warm && !io.off) {
        await warmSelect(env.VARIANTS, customerId, b.warm.bundle, b.warm.at, { ...io, now });
      }
      if (b.keep) await writeCopy(cache, key, b, now);
      else await cache.delete(new Request(key));
    } catch {
      // A failed read keeps the copy; the next stale request tries again.
    } finally {
      rebuilding.delete(key);
    }
  })();
  rebuilding.set(key, run);
  return run;
}

/**
 * The script, or 304 to its own etag. The etag is the snippet build plus a
 * hash of the configuration, so a background refresh of a stale file costs
 * a 304 when nothing changed and brings the new file when anything did; the
 * 304 carries the same cache policy as the 200 it renews. The comparison is
 * the weak one (etag.ts): a browser sends the tag back as `W/"..."`.
 *
 * Server-Timing (faster-tag.md A3): where the script came from, `cache`
 * with one of three fixed words (hit, stale, miss), the KV batch's
 * duration on a miss, and the total. Our own timings only, nothing about
 * the visitor. `Age` on an answer from the location's copy.
 */
function answer(
  request: Request,
  body: string,
  etag: string,
  cache: string,
  t: { cache: "hit" | "stale" | "miss"; kvMs?: number; ageS?: number; started: number },
): Response {
  const timing = [
    `cache;desc=${t.cache}`,
    ...(t.kvMs !== undefined ? [`kv;dur=${t.kvMs}`] : []),
    `total;dur=${Date.now() - t.started}`,
  ].join(", ");
  const common: Record<string, string> = {
    etag,
    "cache-control": cache,
    "server-timing": timing,
    "timing-allow-origin": "*",
    ...(t.ageS !== undefined ? { age: String(t.ageS) } : {}),
  };
  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: common });
  }
  return new Response(body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      ...common,
      "access-control-allow-origin": "*",
    },
  });
}

/** The stored page list: a JSON array of path strings; anything else is none. */
function richPaths(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

async function shortHash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest).slice(0, 6))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
