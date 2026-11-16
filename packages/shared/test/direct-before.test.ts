/**
 * The memory on a site marked sensitive became the install's decision
 * (`RememberOptions.onSensitive`, the workers' REMEMBER_ON_SENSITIVE). With
 * it on, the bundle's direct fields are what they were before the option
 * existed, for every kind of customer; `choiceAllowed`, the question's own
 * rule, did not move at all.
 *
 * fixtures/direct-fields-before.json was recorded once by running the tree
 * of the commit before the change.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BundleDirectRow,
  type DirectBundleFields,
  bundleDirectFields,
  choiceAllowed,
  rememberAllowed,
} from "../src/direct.ts";

interface Before {
  rows: Array<{ row: BundleDirectRow; fields: DirectBundleFields; choiceAllowed: boolean }>;
}
const before = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/direct-fields-before.json"), "utf8"),
) as Before;

describe("the direct fields, against the code before the option", () => {
  it("covers every answer, marked or not, the switch on, off or absent, audits too", () => {
    expect(before.rows).toHaveLength(72);
  });

  it("with the memory allowed on a marked site, every row gives the bytes it gave", () => {
    for (const c of before.rows) {
      const now = bundleDirectFields(c.row, [], { onSensitive: true });
      expect(JSON.stringify(now)).toBe(JSON.stringify(c.fields));
    }
  });

  it("the memory was allowed exactly where the question was", () => {
    for (const c of before.rows) {
      expect(rememberAllowed(c.row, { onSensitive: true })).toBe(c.choiceAllowed);
    }
  });

  it("the question's own rule is untouched", () => {
    for (const c of before.rows) expect(choiceAllowed(c.row)).toBe(c.choiceAllowed);
  });

  it("without it, only a marked site's rm is gone; every other row is the same", () => {
    let dropped = 0;
    for (const c of before.rows) {
      const now = bundleDirectFields(c.row);
      if (Number(c.row.sensitive) === 1 && c.fields.rm === 1) {
        dropped++;
        const { rm: _rm, ...rest } = c.fields;
        expect(now).toEqual(rest);
      } else {
        expect(JSON.stringify(now)).toBe(JSON.stringify(c.fields));
      }
    }
    expect(dropped).toBeGreaterThan(0);
  });
});
