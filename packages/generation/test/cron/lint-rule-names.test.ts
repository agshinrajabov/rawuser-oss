/**
 * A rule name sent in the ops summary comes from a closed list
 * (privacy review, 2026-10-12): a refused row's reason holds
 * excerpts of the refused copy, and a word of an excerpt must never be sent
 * as if it were a rule.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SENDABLE_RULES, rulesOfReason, sendableRule } from "../../src/lib/lint-shares.ts";

describe("rule names in the ops summary are a closed list", () => {
  it("reads the rules of a reason", () => {
    expect(
      rulesOfReason(
        "lint: hero.body length-drift (80 characters; the original has 64, write 61 to 67); features.body sentence-reuse:hero.body (Bir dam altında)",
      ),
    ).toEqual(["length-drift", "sentence-reuse"]);
  });

  it("never sends a word of an excerpt", () => {
    const names = rulesOfReason(
      "lint: hero.body number-not-in-brief (We ship in two days; medora.test delivers in 3 days; 3.5 kg per box)",
    );
    expect(names).toContain("number-not-in-brief");
    for (const n of names) expect(SENDABLE_RULES.has(n) || n === "other").toBe(true);
    expect(names).not.toContain("delivers");
    expect(names).not.toContain("kg");
  });

  it("sends an unknown name as other", () => {
    expect(sendableRule("delivers")).toBe("other");
    expect(sendableRule("banned:unlock")).toBe("banned");
    expect(sendableRule("")).toBe("other");
  });

  it("holds every rule literal of the lint", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/lint/index.ts", import.meta.url)),
      "utf8",
    );
    const literals = [...src.matchAll(/rule: ["`]([a-z][a-z0-9-]*)/g)].map((m) => m[1] as string);
    expect(literals.length).toBeGreaterThan(30);
    for (const name of new Set(literals)) expect(SENDABLE_RULES.has(name), name).toBe(true);
  });
});
