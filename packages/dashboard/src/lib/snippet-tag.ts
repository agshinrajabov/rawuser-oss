import { EDGE_NOT_SET, EDGE_ORIGIN } from "@/lib/identity";

/**
 * The edge's address as a policy line or a tag holds it, for the green mark
 * on what a customer adds. Empty on a build without one: nothing is marked.
 */
export const EDGE_MARK = EDGE_ORIGIN ?? "";

/**
 * The customer's own script (quiet swap, docs/specs/quiet-swap.md): loaded
 * without async, first in <head>, so the elements Rawuser rewrites are hidden
 * before first paint and nothing ever flashes. The older data-attribute tag
 * keeps working but has no hide rules; the Connect screen asks for the switch.
 *
 * data-cfasync="false" asks Cloudflare Rocket Loader to leave the script in
 * place; every browser ignores it (docs/specs/install-friction.md E3). Same
 * string as the generation worker's customerTag, so every screen hands out
 * one tag.
 *
 * The edge comes from the build (lib/identity.ts) and has no fallback: a
 * build without one hands out no tag, only the line that says so.
 */
export function buildSnippet(customerId: string): string {
  if (!EDGE_ORIGIN) return EDGE_NOT_SET;
  return `<script data-cfasync="false" src="${EDGE_ORIGIN}/s/${customerId}.js"></script>`;
}

/** False for the line a build without an edge address hands out instead of a tag. */
export function isTag(tag: string): boolean {
  return tag !== EDGE_NOT_SET;
}
