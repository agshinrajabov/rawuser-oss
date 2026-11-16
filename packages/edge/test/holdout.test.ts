/**
 * packages/edge/src/holdout.ts: the arm by visit marker only
 * (docs/specs/proof-engine.md, section A; privacy review condition 5).
 *
 * - constant for one marker, uniform over 10,000 random markers at 20%
 *   (chi-square, p > 0.001), and at 10% and 50%;
 * - no marker or percent 0: no arm;
 * - the bundle's `h` wins over the env; no bundle gives no holdout; `h`
 *   above 50 is read as 50;
 * - the source reads no user agent and no clock.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bundleHoldout, decideArm, holdoutPercent } from "../src/holdout.ts";

function randomVisit(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Chi-square statistic, one degree of freedom, for k holdouts in n at share h. */
function chi2(k: number, n: number, h: number): number {
  const e1 = n * h;
  const e2 = n * (1 - h);
  return (k - e1) ** 2 / e1 + (n - k - e2) ** 2 / e2;
}
/** p = 0.001 for one degree of freedom. */
const CHI2_P001 = 10.828;

describe("decideArm", () => {
  it("no marker, or a percent of 0, gives no arm", async () => {
    expect(await decideArm("acme", null, 20)).toBeNull();
    expect(await decideArm("acme", "", 20)).toBeNull();
    expect(await decideArm("acme", randomVisit(), 0)).toBeNull();
    expect(await decideArm("acme", randomVisit(), Number.NaN)).toBeNull();
  });

  it("is constant for one marker", async () => {
    const v = randomVisit();
    const first = await decideArm("acme", v, 20);
    for (let i = 0; i < 20; i++) expect(await decideArm("acme", v, 20)).toBe(first);
  });

  it.each([10, 20, 50])(
    "is uniform over 10,000 random markers at %i%% (chi-square p > 0.001)",
    async (pct) => {
      const n = 10_000;
      let k = 0;
      for (let i = 0; i < n; i++)
        if ((await decideArm("acme", randomVisit(), pct)) === "holdout") k++;
      expect(chi2(k, n, pct / 100)).toBeLessThan(CHI2_P001);
    },
  );

  it("is never the first byte mod 100 (that held out 23.4% at a set 20%)", async () => {
    // A marker whose hash starts 0x10 0xff...: first byte 16 → bucket 16 under
    // the old rule. The new rule depends on four bytes; over many markers the
    // two rules must disagree somewhere.
    let disagree = false;
    for (let i = 0; i < 500 && !disagree; i++) {
      const v = randomVisit();
      const d = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`acme|${v}`)),
      );
      const old = (d[0] ?? 0) % 100 < 20 ? "holdout" : "treat";
      disagree = old !== (await decideArm("acme", v, 20));
    }
    expect(disagree).toBe(true);
  });

  it("differs between customers for the same marker for some markers", async () => {
    let differ = false;
    for (let i = 0; i < 200 && !differ; i++) {
      const v = randomVisit();
      differ = (await decideArm("a", v, 20)) !== (await decideArm("b", v, 20));
    }
    expect(differ).toBe(true);
  });

  it("caps the percent at 50", async () => {
    const n = 4000;
    let k = 0;
    for (let i = 0; i < n; i++)
      if ((await decideArm("acme", randomVisit(), 100)) === "holdout") k++;
    expect(chi2(k, n, 0.5)).toBeLessThan(CHI2_P001);
  });
});

describe("the percent for an answer", () => {
  const bundle = (h?: number) => ({
    v: 1 as const,
    pages: {},
    conv: [],
    ...(h === undefined ? {} : { h }),
  });

  it("the bundle's h wins over the env", () => {
    expect(bundleHoldout(bundle(20), "0")).toBe(20);
    expect(bundleHoldout(bundle(0), "10")).toBe(0);
  });

  it("a bundle without h takes the env default", () => {
    expect(bundleHoldout(bundle(), "0")).toBe(0);
    expect(bundleHoldout(bundle(), undefined)).toBe(10);
  });

  it("no bundle means no holdout", () => {
    expect(bundleHoldout(null, "10")).toBe(0);
    expect(bundleHoldout(undefined, "10")).toBe(0);
  });

  it("h above 50 is read as 50", () => {
    expect(bundleHoldout(bundle(80), "0")).toBe(50);
    expect(holdoutPercent("80")).toBe(50);
  });

  it("holdoutPercent reads the env var and falls back to the default", () => {
    expect(holdoutPercent(undefined)).toBe(10);
    expect(holdoutPercent("")).toBe(10);
    expect(holdoutPercent("0")).toBe(0);
    expect(holdoutPercent("25")).toBe(25);
    expect(holdoutPercent("101")).toBe(10);
    expect(holdoutPercent("abc")).toBe(10);
    expect(holdoutPercent("2.5")).toBe(10);
  });
});

describe("no user agent, no clock (privacy review condition 5)", () => {
  it("holdout.ts reads no header and no time", () => {
    const src = readFileSync(new URL("../src/holdout.ts", import.meta.url), "utf8")
      // comments may name what is gone
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/user-agent|headers|Date\.now|new Date|Request/i);
  });
});
