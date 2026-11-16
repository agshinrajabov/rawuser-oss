/**
 * A part left as the page built it (docs/specs/refused-versions.md).
 *
 * A version whose one part still breaks a hard rule after its own call ships
 * without that part: the page keeps its own words there. The row says so
 * with one entry in `lint_flags`, `part-as-built:{path}:{rule}`: the part's
 * path and the name of the rule, never the text that failed. This file is
 * the one place that writes and reads that entry.
 */

export const PART_AS_BUILT = "part-as-built";

export interface PartAsBuilt {
  /** The manifest path of the part, for example `hero.body`. */
  path: string;
  /** The rule it failed, for example `length-drift`. */
  rule: string;
}

/** The `lint_flags` entry of a part left as built. */
export function partAsBuiltFlag(part: PartAsBuilt): string {
  return `${PART_AS_BUILT}:${part.path}:${part.rule}`;
}

/** The stored `lint_flags` of a row as a list of strings; a broken value is no flags. */
export function lintFlagsOf(raw: unknown): string[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : [];
}

/**
 * The parts a row left as built, from its `lint_flags` (the stored JSON or
 * the list). A path has dots and no colon, so the first colon after the
 * prefix ends it.
 */
export function partsAsBuiltOf(raw: unknown): PartAsBuilt[] {
  const out: PartAsBuilt[] = [];
  for (const flag of lintFlagsOf(raw)) {
    if (!flag.startsWith(`${PART_AS_BUILT}:`)) continue;
    const rest = flag.slice(PART_AS_BUILT.length + 1);
    const cut = rest.indexOf(":");
    if (cut <= 0 || cut === rest.length - 1) continue;
    out.push({ path: rest.slice(0, cut), rule: rest.slice(cut + 1) });
  }
  return out;
}
