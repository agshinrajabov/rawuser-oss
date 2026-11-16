/**
 * docs/privacy-rules.md names, for each line that never moves, the tests
 * that hold it. This test reads that table: every file is there and holds a
 * test of that exact name, and every one of the five lines has at least
 * one. Rename or remove a pinned test and this fails.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../", import.meta.url);

/** In the public repository the page is in docs/; in ours it waits in the overlay. */
function rules(): string {
  for (const at of ["docs/", "ops/public/overlay/docs/"]) {
    const url = new URL(`${at}privacy-rules.md`, ROOT);
    if (existsSync(url)) return readFileSync(url, "utf8");
  }
  throw new Error("docs/privacy-rules.md is not there");
}

const text = rules();
const pins = [...text.matchAll(/^\| (\d) \| `([^`]+\.test\.ts)` \| "(.+)" \|$/gm)].map((m) => ({
  line: Number(m[1]),
  file: m[2] as string,
  title: m[3] as string,
}));

describe("the privacy rules and the tests they name", () => {
  it("the five lines are stated, in order", () => {
    const stated = [...text.matchAll(/^(\d)\. \*\*(.+?)\*\*/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(stated).toEqual([
      "1 No fingerprinting.",
      "2 No cross-site identity.",
      "3 One visitor is never linked across customers.",
      "4 No special-category inference.",
      "5 Data about a single visitor is never sold or shared.",
    ]);
  });

  it("every line has a test, and the table has no row it cannot read", () => {
    expect([...new Set(pins.map((p) => p.line))].sort()).toEqual([1, 2, 3, 4, 5]);
    const rows = text.split("\n").filter((l) => /^\| \d \|/.test(l));
    expect(pins).toHaveLength(rows.length);
    expect(pins.length).toBeGreaterThanOrEqual(12);
  });

  it("each named file is there and holds a test of that name", () => {
    for (const { file, title } of pins) {
      const url = new URL(file, ROOT);
      expect(existsSync(url), file).toBe(true);
      const source = readFileSync(url, "utf8");
      const named = [`"${title}"`, `'${title}'`, `\`${title}\``].some((q) => source.includes(q));
      expect(named, `${file}: ${title}`).toBe(true);
    }
  });
});
