/**
 * /s/_core/{hash}.js: the shared core of the snippet (docs/specs/faster-tag.md
 * step 4, C). A customer's `/s/{id}.js` is a small boot that hides the
 * page's parts, asks `/select` and then inserts this file; the core takes
 * the pass over. The same code is `/snippet.js` (snippet-asset.ts).
 *
 * - The address names the build: the boot asks for the hash it was made
 *   with, so a boot a browser kept from before a deploy finds its own core.
 *   The edge keeps the builds of the last days (core-assets.ts); a known
 *   hash is cached for a year, immutable.
 * - A hash the edge does not keep (older than that, or made up) gets the
 *   current core, cached five minutes, as `/rich.js` does for another `v`.
 *   The core checks the boot's handoff version before it takes anything
 *   over, and shows the page as built when the versions differ.
 * - Precompressed at build time, brotli at quality 11 and gzip at level 9,
 *   and sent as they are (`encodeBody: "manual"`): Cloudflare's own
 *   compression of a dynamic answer gave Chrome zstd at 15,796 B where
 *   brotli 11 is about 13,600 (faster-tag.md B). Identity for a client that
 *   takes neither.
 * - Static: no visitor data, no cookie, no parameter but the hash in the
 *   path. Under `/s/`, so a policy that allows the edge's host, or one
 *   narrowed to its `/s/` path, covers it. `_core` is never a customer
 *   id (customer-script.ts, CUSTOMER_ID_RE starts with a letter or digit).
 */

import { CORE_BUILDS, type CoreBuild } from "./core-assets.ts";
import { etagMatches } from "./etag.ts";
import { SNIPPET_ETAG, SNIPPET_JS } from "./snippet-asset.ts";

const CORE_RE = /^\/s\/_core\/([0-9a-f]{16})\.js$/;
const IMMUTABLE = "public, max-age=31536000, immutable";
const BRIEF = "public, max-age=300";

/** The build hash a `/s/_core/{hash}.js` path names, else null. */
export function coreHash(pathname: string): string | null {
  return CORE_RE.exec(pathname)?.[1] ?? null;
}

/** The current core's hash: the snippet build's own. */
export const CURRENT_CORE = SNIPPET_ETAG.replace(/"/g, "");

/** Base64 to bytes, once per build and encoding per isolate. */
const decoded = new Map<string, Uint8Array>();
function bytes(b: CoreBuild, enc: "br" | "gz"): Uint8Array {
  const key = `${b.h}:${enc}`;
  let out = decoded.get(key);
  if (!out) {
    const bin = atob(b[enc]);
    out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    decoded.set(key, out);
  }
  return out;
}

/**
 * The encodings a request takes, from `Accept-Encoding`: a coding with
 * `q=0` is refused, `*` takes any. Lower case, no weights kept.
 */
export function accepted(header: string | null): Set<string> {
  const out = new Set<string>();
  for (const part of (header ?? "").split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (q && Number(q.slice(2)) === 0) continue;
    out.add(name);
  }
  return out;
}

export function handleCore(
  request: Request,
  hash: string,
  builds: readonly CoreBuild[] = CORE_BUILDS,
  currentHash: string = CURRENT_CORE,
  currentJs: string = SNIPPET_JS,
): Response {
  const known = builds.find((b) => b.h === hash);
  const build = known ?? builds.find((b) => b.h === currentHash);
  const cache = known ? IMMUTABLE : BRIEF;
  const take = accepted(request.headers.get("accept-encoding"));
  const enc =
    build && (take.has("br") || take.has("*")) ? "br" : build && take.has("gzip") ? "gzip" : null;
  // Identity has only the current text: an older build goes out as the
  // current one, briefly cached (the handoff version guards the rest).
  const served = enc ? (build as CoreBuild).h : currentHash;
  const etag = `"${served}"`;
  const headers: Record<string, string> = {
    etag,
    "cache-control": enc || served === hash ? cache : BRIEF,
    vary: "accept-encoding",
    "timing-allow-origin": "*",
  };
  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers["content-type"] = "application/javascript; charset=utf-8";
  headers["access-control-allow-origin"] = "*";
  if (!enc) return new Response(currentJs, { headers });
  headers["content-encoding"] = enc;
  return new Response(bytes(build as CoreBuild, enc === "br" ? "br" : "gz"), {
    headers,
    // The bytes are already compressed: sent as they are, never again.
    encodeBody: "manual",
  });
}
