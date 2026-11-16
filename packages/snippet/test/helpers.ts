/**
 * Test-only helpers.
 *
 * `at(arr, i)` — index access that throws instead of returning undefined.
 * The snippet tsconfig runs with noUncheckedIndexedAccess (good for src),
 * which makes `calls[0].url` a type error in tests even right after
 * `expect(calls).toHaveLength(1)`. This helper keeps the assertion intent
 * (missing element = loud failure) without non-null assertions, which the
 * repo's biome config forbids.
 */
export function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) {
    throw new Error(`expected element at index ${i}, array has length ${arr.length}`);
  }
  return v;
}

/**
 * The tag first in head: the document is still parsing when the snippet
 * runs. jsdom has finished by the time a test boots the entry, which a real
 * browser reports only for a late tag (install-friction D, late-tag.ts).
 */
export function parsing(doc: Document): void {
  Object.defineProperty(doc, "readyState", { value: "loading", configurable: true });
}

/**
 * The boot's own core script (`/s/_core/{hash}.js`, docs/specs/faster-tag.md
 * step 4): in the split build the boot inserts it into the head on every
 * page it starts a pass on. It is our loader, not the page's content, so the
 * tests that hold the page unchanged look past it, and only past it.
 */
export function isCoreScript(n: Node): boolean {
  return n.nodeName === "SCRIPT" && /\/s\/_core\/[^/]+\.js$/.test((n as HTMLScriptElement).src);
}

/** A mutation record that only inserts or removes the boot's core script. */
export function coreScriptOnly(r: MutationRecord): boolean {
  const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
  return r.type === "childList" && nodes.length > 0 && nodes.every(isCoreScript);
}

/** The document's markup without the boot's core script. */
export function pageMarkup(doc: Document): string {
  const c = doc.documentElement.cloneNode(true) as Element;
  for (const s of Array.from(c.querySelectorAll("script"))) if (isCoreScript(s)) s.remove();
  return c.outerHTML;
}
