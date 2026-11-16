/**
 * Local copy of normalizePath, kept in the snippet to honor the
 * zero-runtime-shared-imports rule (see types.ts). MUST stay byte-for-byte
 * behaviorally identical to packages/shared/src/path.ts — the edge uses the
 * shared version to select the manifest/variant, and if the two disagree a
 * visit silently falls back to the '/' manifest.
 *
 * Parity is enforced by packages/snippet/test/path-parity.test.ts, which
 * imports BOTH implementations and asserts identical output over a fixture
 * set. If you change one, change both (the test will fail otherwise).
 */
export function normalizePath(input: string | null | undefined): string {
  if (!input) return "/";

  let path = input.split("#", 1)[0] ?? "";
  path = path.split("?", 1)[0] ?? "";

  if (path === "") return "/";
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  path = path.toLowerCase();
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path;
}
