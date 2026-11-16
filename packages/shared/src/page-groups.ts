/**
 * Page groups, phase 1 (docs/specs/page-groups.md): a path pattern of the
 * customer's own site, `/products/*`, that names many pages sharing one
 * layout, so one button can be counted across them. In phase 1 a group is
 * only a counted place: no versions, nothing hidden, nothing rewritten.
 *
 * The pattern: one or two fixed segments, each a plain segment under the
 * kept-section rule (never `:`, so never `:id` or `:item`; never a segment
 * `segmentHoldsIdentifier` flags), then exactly one `*` as the last segment.
 * `/*` alone is refused. A pattern matches a path with exactly one segment
 * more than its fixed part: `/products/*` matches `/products/ginseng` and
 * `/products/:id`, never `/products`, `/products/x/reviews` or
 * `/productsale`.
 *
 * The group's counted button is a `conversion_targets` row whose
 * `section_path` is `count:` plus the pattern (`countTargetPath`), so the
 * target's page part ends in `/*` and `countPageIsGroup` tells it from a
 * single page's pick. Pure string work: the customer's own site structure,
 * nothing about a visitor (privacy review condition 1 and 6).
 */

import { normalizePath } from "./path.ts";
import { segmentHoldsIdentifier } from "./pick.ts";

/** The free last segment of a pattern. */
export const GROUP_WILDCARD = "*";

/** What every pattern ends with. */
export const GROUP_PATTERN_SUFFIX = `/${GROUP_WILDCARD}`;

/** The most groups a customer may have (spec, Limits). */
export const MAX_PAGE_GROUPS = 5;

/** The most fixed segments before the `*`. */
export const MAX_GROUP_FIXED_SEGMENTS = 2;

/** The longest pattern, in characters, as typed. */
export const MAX_GROUP_PATTERN_LENGTH = 200;

/** One fixed segment: unreserved URL characters and percent escapes (the kept-section rule). */
const PLAIN_SEGMENT = /^[A-Za-z0-9._~%-]+$/;

/** The refusal line for a pattern that is not one (operator-facing, one plain line). */
export const GROUP_PATTERN_REFUSAL =
  "Write the pattern as /section/* or /section/part/*, with one * at the end.";

/**
 * A fixed segment of a pattern, as the kept-section rule reads it: plain
 * characters, not `.` or `..`, no `:`, and never a segment that names one
 * account or carries a secret. Read before lowercasing (the identifier rule
 * reads case).
 */
export function validGroupSegment(seg: string): boolean {
  if (seg === GROUP_WILDCARD || seg === "." || seg === "..") return false;
  if (!PLAIN_SEGMENT.test(seg)) return false;
  return !segmentHoldsIdentifier(seg);
}

/**
 * The pattern normalized (`/Products/*` is `/products/*`), or null when the
 * input is not a pattern: not a string, no leading `/`, a query, fragment
 * or whitespace, too long, no `*` last, a `*` anywhere else, no fixed
 * segment (`/*`) or more than two, or a fixed segment the rule refuses.
 */
export function validPageGroupPattern(input: unknown): string | null {
  if (typeof input !== "string" || !input.startsWith("/")) return null;
  if (input.length > MAX_GROUP_PATTERN_LENGTH || /[?#\s]/.test(input)) return null;
  const trimmed = input.length > 1 && input.endsWith("/") ? input.slice(0, -1) : input;
  const segments = trimmed.split("/").slice(1);
  const last = segments[segments.length - 1];
  if (last !== GROUP_WILDCARD) return null;
  const fixed = segments.slice(0, -1);
  if (fixed.length === 0 || fixed.length > MAX_GROUP_FIXED_SEGMENTS) return null;
  if (!fixed.every(validGroupSegment)) return null;
  return `${normalizePath(`/${fixed.join("/")}`)}${GROUP_PATTERN_SUFFIX}`;
}

/** A string that is a pattern, already in its normalized form. */
export function isPageGroupPattern(s: unknown): s is string {
  return typeof s === "string" && validPageGroupPattern(s) === s;
}

/**
 * The fixed part of a pattern: `/products/*` gives `/products`. For a
 * string that is not a pattern, the string with a trailing `/*` removed
 * when it has one, else itself.
 */
export function groupFixedPart(pattern: string): string {
  return pattern.endsWith(GROUP_PATTERN_SUFFIX)
    ? pattern.slice(0, -GROUP_PATTERN_SUFFIX.length) || "/"
    : pattern;
}

/**
 * The page part of a `count:` target that names a group rather than one
 * page: it ends in `/*`. The edge's match and the sensitive guard read it
 * to tell `count:/products/*` from `count:/products/ginseng`.
 */
export function countPageIsGroup(page: string | null | undefined): boolean {
  return typeof page === "string" && page.length > GROUP_PATTERN_SUFFIX.length
    ? page.endsWith(GROUP_PATTERN_SUFFIX)
    : false;
}

/**
 * Whether a normalized path is one page of the group: it starts with the
 * fixed part plus `/` and has exactly one segment more. The path should be
 * the edge's own `normalizePath(maskPath(path))`, so `/products/48213377`
 * arrives as `/products/:id` and still matches. The fixed part itself, a
 * deeper path and a longer sibling (`/productsale`) never match.
 */
export function pageGroupMatches(pattern: string, path: string): boolean {
  if (!isPageGroupPattern(pattern)) return false;
  const fixed = groupFixedPart(pattern);
  const p = normalizePath(path);
  if (!p.startsWith(`${fixed}/`)) return false;
  const rest = p.slice(fixed.length + 1);
  return rest.length > 0 && !rest.includes("/");
}

/**
 * The first pattern of the list the path belongs to, or null. Two valid
 * patterns of different depth never both match one path, and two of the
 * same depth match disjoint paths, so the order of the list does not
 * matter for a list of distinct patterns.
 */
export function pageGroupOf(patterns: readonly string[], path: string): string | null {
  for (const pattern of patterns) {
    if (pageGroupMatches(pattern, path)) return pattern;
  }
  return null;
}
