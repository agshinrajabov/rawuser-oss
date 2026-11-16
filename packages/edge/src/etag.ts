/**
 * `If-None-Match` against the etag of a file the edge serves, compared
 * weakly as RFC 9110 asks for this header (13.1.2, with the weak comparison
 * of 8.8.3.2): two tags match when their opaque parts are the same, whether
 * or not either carries `W/`.
 *
 * Why it matters here (the lab recheck of 2026-10-12, task B9): our scripts
 * leave the worker with a strong etag, Cloudflare compresses them on the way
 * out and marks the etag weak, and a browser sends back what it was given.
 * Chrome's background refresh of a stale `/s/{id}.js` asked with
 * `W/"..."`, the edge compared the two strings as written and answered 200
 * with the whole 14.5 KB file every time.
 *
 * The header may be `*` (any current file; ours always exists) or a list of
 * tags separated by commas. A tag is quoted; a bare word is not a tag and
 * matches nothing. The etag the edge sends is not changed by this.
 */

/** A quoted entity tag with its optional weak mark; the group is the opaque part. */
const TAG = /(?:W\/)?"([^"]*)"/g;

/** The opaque part of one tag (`"abc"` or `W/"abc"`), or null when it is not a tag. */
function opaque(tag: string): string | null {
  const m = /^(?:W\/)?"([^"]*)"$/.exec(tag.trim());
  return m ? (m[1] as string) : null;
}

/** True when the request's `If-None-Match` names this etag: answer 304. */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const header = ifNoneMatch.trim();
  if (header === "*") return true;
  const own = opaque(etag);
  if (own === null) return false;
  for (const m of header.matchAll(TAG)) {
    if (m[1] === own) return true;
  }
  return false;
}
