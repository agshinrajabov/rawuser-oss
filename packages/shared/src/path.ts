/**
 * Page-path normalization — shared by the snippet (visitor side) and the
 * edge worker (selection side) so they NEVER disagree on which manifest /
 * variant a path maps to. A mismatch here means a visit silently falls
 * back to the '/' manifest, so this util is the single source of truth.
 *
 * Per-path manifests (A1 / Option A — see docs/specs/per-path-manifests.md).
 *
 * Rules:
 *   - Lowercase (paths are matched case-insensitively; '/Start' === '/start').
 *   - Strip query string and fragment (a path is the route, not its params).
 *   - Collapse repeated slashes ('//start' → '/start').
 *   - Strip a trailing slash EXCEPT for the root ('/start/' → '/start',
 *     '/' stays '/').
 *   - Empty / missing input → '/' (treat as root).
 *
 * Privacy: a normalized path carries no PII (it is the route, already sent
 * as page_path in the /event beacon which privacy review approved). No
 * query params survive normalization, so an accidental `?token=…` never
 * reaches manifest selection.
 */
export function normalizePath(input: string | null | undefined): string {
  if (!input) return "/";

  // Drop fragment then query — order matters so a '#' before '?' is handled.
  let path = input.split("#", 1)[0] ?? "";
  path = path.split("?", 1)[0] ?? "";

  if (path === "") return "/";

  // Ensure a leading slash (defensive — location.pathname always has one,
  // but a hand-passed value might not).
  if (!path.startsWith("/")) path = `/${path}`;

  // Collapse repeated slashes.
  path = path.replace(/\/{2,}/g, "/");

  // Lowercase.
  path = path.toLowerCase();

  // Strip trailing slash except root.
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  return path;
}
