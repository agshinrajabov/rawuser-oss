/**
 * Wrap simulation (docs/specs/interactive-text.md §3.4). A synthetic font:
 * every character 50 at 100 px, the space 25; at 20 px a character is 10 px
 * and a space 5 px, so the numbers below are easy to follow.
 */
import { describe, expect, it } from "vitest";
import { templateReadings } from "../src/template.ts";
import { type WrapMetrics, holdScore, lineCounts, textWidth } from "../src/wrap.ts";

const chars: Record<string, number> = { " ": 25 };
for (const c of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,") chars[c] = 50;

const at = (w: number, box: number, extra: Partial<WrapMetrics["widths"][number]> = {}) => ({
  w,
  size: 20,
  box,
  ls: 0,
  k: 1,
  lines: 1,
  ...extra,
});

describe("textWidth and lineCounts", () => {
  const m: WrapMetrics = { v: 1, kind: "plain", chars, widths: [at(1280, 100)] };

  it("adds the table's widths at the font size, letter-spacing and the calibration", () => {
    const one = m.widths[0] as WrapMetrics["widths"][number];
    expect(textWidth("abc", m, one)).toBe(30);
    expect(textWidth("abc", m, { ...one, ls: 1 })).toBe(33);
    expect(textWidth("abc", m, { ...one, k: 2 })).toBe(60);
    expect(textWidth("ABC", { ...m, upper: true }, one)).toBe(30);
  });

  it("wraps greedily at the box: 'aaaa bbbb cccc' is 140 px on one line, two lines in 100", () => {
    const one = m.widths[0] as WrapMetrics["widths"][number];
    expect(lineCounts("aaaa bbbb cccc", m, one)).toEqual([2]);
    expect(lineCounts("aaaa bbbb", m, one)).toEqual([1]);
  });

  it("counts a template line by line, an image by its width, the worst rotating word", () => {
    const one = { ...(m.widths[0] as WrapMetrics["widths"][number]), glyphs: [60] };
    // Line 1: "ab" + image 60 = 20 + 5 + 60 = 85, one line. Line 2 "you compare." is
    // 30 + 5 + 80 = 115: two lines; "you buy." is 75: one. The worst counts.
    expect(lineCounts("ab {g1}{br}you {rot:buy|compare}.", m, one)).toEqual([1, 2]);
  });

  it("calibrates each template line with its real one-line width on the page", () => {
    const page = "aaaa bbbb{br}cc";
    // Our table says line 1 is 85 px; the page measured 180 (another face in a group).
    const one = { ...(m.widths[0] as WrapMetrics["widths"][number]), lw: [180, 20] };
    expect(lineCounts(page, m, one)).toEqual([1, 1]);
    expect(lineCounts(page, m, one, page)).toEqual([2, 1]);
  });
});

describe("holdScore", () => {
  it("is 0 for a plain candidate taking the page's lines at every width, and counts misses", () => {
    const m: WrapMetrics = {
      v: 1,
      kind: "plain",
      chars,
      widths: [at(1280, 200, { lines: 1 }), at(390, 100, { lines: 2 })],
    };
    expect(holdScore("aaaa bbbb cccc", m)).toBe(0);
    // Too short for the phone's two lines, and too long for the wide screen's one.
    expect(holdScore("aaaa", m)).toBe(1);
    expect(holdScore("aaaa bbbb cccc dddd eeee ffff", m)).toBe(2);
  });

  it("lets poured lines hold when they fit the page's count and have a word each", () => {
    const m: WrapMetrics = { v: 1, kind: "lines", chars, widths: [at(1280, 100, { lines: 3 })] };
    expect(holdScore("aaaa bbbb cccc", m)).toBe(0);
    expect(holdScore("aaaa", m)).toBe(2);
    expect(holdScore("aaaa bbbb cccc dddd eeee ffff gggg", m)).toBe(1);
  });

  it("compares a template with the page's own template simulated the same way", () => {
    const page = "Choose what they can {rot:read|compare}.";
    const m: WrapMetrics = {
      v: 1,
      kind: "template",
      chars,
      widths: [at(1280, 200, { lines: 1, tl: [1] })],
    };
    // The page itself flips to two lines on "compare"; a version that does the same holds.
    expect(lineCounts(page, m, m.widths[0] as WrapMetrics["widths"][number], page)).toEqual([2]);
    expect(holdScore(page, m, page)).toBe(0);
    expect(holdScore("Go {rot:read|compare}.", m, page)).toBe(1);
  });
});

describe("templateReadings", () => {
  it("gives one sentence per rotating word, lines joined, images and groups out", () => {
    expect(templateReadings("{s1}Your{/s1} {g1}visitors{br}can {rot:read|buy}.")).toEqual([
      "Your visitors can read.",
      "Your visitors can buy.",
    ]);
    expect(templateReadings("No rotator here")).toEqual(["No rotator here"]);
  });
});
