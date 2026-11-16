/**
 * KV key conventions.
 *
 * One helper per logical key family so the edge and generation workers
 * never disagree on the shape. Bump the version prefix to invalidate
 * the cache cleanly when the body schema changes.
 *
 * V1 key shape (post intent-vector refactor):
 *   v1:variant:{customer_id}:{intent_dim}:{source_dim}
 *
 * 6 intent dims × 6 source dims = 36 possible keys per customer.
 * Generation fills these per-customer in KV; V1 ships with the keys
 * defined but KV empty in production.
 *
 * Fallback sentinel: source_dim = "default" is the V1 sentinel for
 * intent-only variants while generation has not yet produced per-source
 * variants for a customer:
 *   v1:variant:{customer_id}:{intent_dim}:default
 */

const VERSION = "v1";

/**
 * Variant body keyed by (customer_id, intent_dim, source_dim).
 *
 * Pass the literal string "default" as source_dim for the V1 sentinel
 * intent-only key (fallback step 2 in the edge KV cascade).
 *
 * Path-agnostic shape — retained for the root '/' manifest and for any
 * caller that doesn't care about per-path variants. Equivalent to
 * variantKeyForPath(customerId, '/', intentDim, sourceDim).
 */
export function variantKey(customerId: string, intentDim: string, sourceDim: string): string {
  return `${VERSION}:variant:${customerId}:${intentDim}:${sourceDim}`;
}

/**
 * Path-segment encoding for the variant key. The root '/' keeps the
 * historical path-agnostic key shape (no path segment) so existing KV
 * entries and the '/' manifest never move. Non-root paths get a
 * URL-encoded `:p:<encoded>` segment.
 *
 *   '/'      → ""            (path-agnostic, back-compatible)
 *   '/start' → ":p:%2Fstart" (URL-encoded so ':' and '/' can't collide
 *                             with the key delimiter)
 *
 * The caller MUST pass an already-normalized path (see normalizePath).
 */
function pathSegment(normalizedPath: string): string {
  if (normalizedPath === "/") return "";
  return `:p:${encodeURIComponent(normalizedPath)}`;
}

/**
 * Variant body keyed by (customer_id, page_path, intent_dim, source_dim).
 *
 * For page_path '/', produces the identical key to variantKey() — so the
 * root manifest's variants stay exactly where they are and the edge KV
 * cascade can fall back from a non-root path to '/' transparently.
 *
 * KV shape:
 *   '/'      → v1:variant:{cid}:{intent}:{source}
 *   '/start' → v1:variant:{cid}:p:%2Fstart:{intent}:{source}
 *
 * Pass an already-normalized path (normalizePath).
 */
export function variantKeyForPath(
  customerId: string,
  normalizedPath: string,
  intentDim: string,
  sourceDim: string,
): string {
  return `${VERSION}:variant:${customerId}${pathSegment(normalizedPath)}:${intentDim}:${sourceDim}`;
}

/** What a variant key says: the reverse of variantKeyForPath. */
export interface VariantKeyParts {
  customerId: string;
  /** "/" for the path-agnostic shape, else the decoded `:p:` segment. */
  pagePath: string;
  intentDim: string;
  sourceDim: string;
}

/**
 * Reads a variant key back into its parts, or null when the string is not
 * exactly what variantKeyForPath builds. A key carries its page in one
 * place: the optional `:p:<encodeURIComponent(path)>` segment between the
 * customer id and the intent; without it the page is "/".
 *
 *   v1:variant:acme:brand:direct              → page "/"
 *   v1:variant:acme:p:%2Fstart:brand:paid     → page "/start"
 *
 * Strict on purpose (the edge stores a client's `variant_key`, and
 * docs/specs/sensitive-customers.md reads the page out of it): the parts
 * must build the same string again, so a second encoding of the same page,
 * a "/" written in the `:p:` form or a stray segment is not a key.
 * Customer ids hold no ":" (CUSTOMER_ID_RE), so the split is unambiguous.
 */
export function variantKeyParts(key: string): VariantKeyParts | null {
  const prefix = `${VERSION}:variant:`;
  if (typeof key !== "string" || !key.startsWith(prefix)) return null;
  const parts = key.slice(prefix.length).split(":");
  let customerId: string | undefined;
  let pagePath = "/";
  let intentDim: string | undefined;
  let sourceDim: string | undefined;
  if (parts.length === 3) {
    [customerId, intentDim, sourceDim] = parts;
  } else if (parts.length === 5 && parts[1] === "p") {
    customerId = parts[0];
    intentDim = parts[3];
    sourceDim = parts[4];
    try {
      pagePath = decodeURIComponent(parts[2] ?? "");
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (!customerId || !intentDim || !sourceDim || !pagePath.startsWith("/")) return null;
  if (variantKeyForPath(customerId, pagePath, intentDim, sourceDim) !== key) return null;
  return { customerId, pagePath, intentDim, sourceDim };
}

/** Per-customer "ready" manifest — list of intent+source pairs with current variants. */
export function manifestKey(customerId: string): string {
  return `${VERSION}:manifest:${customerId}`;
}

/**
 * The customer's brief language, written by the DNA upsert and read by the
 * edge's language gate: `v1:customer:{customer_id}:lang` → BCP-47 tag.
 * One KV read per /select that carries a page language; never per-visitor.
 */
export function customerLangKey(customerId: string): string {
  return `v1:customer:${customerId}:lang`;
}

/**
 * The tombstone of a deleted customer (docs/specs/security-hardening.md §6,
 * condition 1): value "1", kept 13 months. While it exists a forgotten tag
 * records nothing: `/s/{id}.js` serves the off script, `/select` the
 * record-nothing answer, `/event` drops the row, nothing is written back.
 * Never part of an export or a customer's KV groups; an id with a tombstone
 * is never given to a new customer.
 */
export function closedKey(customerId: string): string {
  return `v1:closed:${customerId}`;
}

/** 13 months: longer than any browser keeps a cached script or a tab its storage. */
export const CLOSED_TTL_S = 395 * 24 * 60 * 60;
