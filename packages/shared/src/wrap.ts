/**
 * Wrap simulation (docs/specs/interactive-text.md §3.4, phase 4). The model
 * cannot count characters, and a character count cannot promise a line
 * count; the page can tell us how it wraps. The picker measures, once, in
 * the operator's browser: a width table of the headline's font at 100 px,
 * and for 1280, 768 and 390 px the font size, letter-spacing, the box width,
 * the width of each image in the headline, a calibration factor and the
 * page's own line counts. Generation then wraps every candidate here, at
 * every width, and keeps the three that hold the page's lines. Page facts
 * only: nothing here is about a visitor.
 */

import { parseTemplate } from "./template.ts";

export interface WrapWidth {
  /** The viewport width measured: 1280, 768 or 390. */
  w: number;
  /** Font size in px at that width. */
  size: number;
  /** The width the words wrap in, px. */
  box: number;
  /** Letter-spacing in px. */
  ls: number;
  /** The page's real no-wrap width of its own text ÷ ours: kerning, groups in another style. */
  k: number;
  /** Width of each {gN} image, px, in template order. */
  glyphs?: number[];
  /** The page's own line count: the whole headline, or the number of lines it cut. */
  lines: number;
  /** A template's line count per {br} line. */
  tl?: number[];
  /** A template's lines, each laid out on one line, their real widths in px. */
  lw?: number[];
  /** The rotating word the page showed while measured. */
  ra?: number;
}

export interface WrapMetrics {
  v: 1;
  /** How the snippet writes the part: plain text, a template, or poured into the page's lines. */
  kind: "plain" | "template" | "lines";
  /** The page upper-cases the text (text-transform). */
  upper?: boolean;
  /** Advance width of each character at 100 px. */
  chars: Record<string, number>;
  widths: WrapWidth[];
}

const averages = new WeakMap<object, number>();

function average(chars: Record<string, number>): number {
  let a = averages.get(chars);
  if (a === undefined) {
    const vals = Object.entries(chars)
      .filter(([c]) => /\S/.test(c))
      .map(([, v]) => v);
    a = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 55;
    averages.set(chars, a);
  }
  return a;
}

/** The width of a run of text at one measured width, px. */
export function textWidth(text: string, m: WrapMetrics, at: WrapWidth): number {
  const t = m.upper ? text.toUpperCase() : text;
  let sum = 0;
  let n = 0;
  for (const ch of t) {
    sum += m.chars[ch] ?? average(m.chars);
    n++;
  }
  return ((sum * at.size) / 100 + at.ls * n) * (at.k || 1);
}

interface Piece {
  w: number;
  /** A space stands before it: a line may break there. */
  gap: boolean;
}

/** One line of a template (or plain text) as unbreakable pieces, with one rotating word chosen. */
function piecesOf(
  tokens: ReturnType<typeof parseTemplate>,
  m: WrapMetrics,
  at: WrapWidth,
  alt: number,
): Piece[] {
  const out: Piece[] = [];
  let gap = false;
  const push = (w: number) => {
    const last = out[out.length - 1];
    if (last && !gap) last.w += w;
    else out.push({ w, gap: out.length > 0 && gap });
    gap = false;
  };
  const text = (s: string) => {
    for (const part of s.split(/(\s+)/)) {
      if (part === "") continue;
      if (/^\s+$/.test(part)) gap = true;
      else push(textWidth(part, m, at));
    }
  };
  for (const tok of tokens) {
    if (tok.t === "text") text(tok.text);
    else if (tok.t === "glyph") push(at.glyphs?.[tok.n - 1] ?? 0);
    else if (tok.t === "rot") text(tok.alts[alt] ?? tok.alts[0] ?? "");
  }
  return out;
}

/** Greedy wrap, as a browser fills a line: the count of lines. */
export function wrapCount(pieces: readonly Piece[], space: number, box: number): number {
  if (pieces.length === 0) return 0;
  let lines = 1;
  let cur = 0;
  for (const p of pieces) {
    const add = (cur > 0 && p.gap ? space : 0) + p.w;
    if (cur > 0 && cur + add > box + 0.5) {
      lines++;
      cur = p.w;
    } else cur += add;
  }
  return lines;
}

function splitLines(version: string): Array<ReturnType<typeof parseTemplate>> {
  const lines: Array<ReturnType<typeof parseTemplate>> = [[]];
  for (const t of parseTemplate(version)) {
    if (t.t === "br") lines.push([]);
    else lines[lines.length - 1]?.push(t);
  }
  return lines;
}

/** A line's width laid out on one line. */
function oneLine(pieces: readonly Piece[], space: number): number {
  return pieces.reduce((w, p, i) => w + p.w + (i > 0 && p.gap ? space : 0), 0);
}

/**
 * How much wider each template line is on the page than our table says:
 * its real one-line width over ours for the page's own line (groups in
 * another face, an image's margins, the rotating word's box). 1 without
 * the page's template or its widths.
 */
function lineFactors(m: WrapMetrics, at: WrapWidth, page: string | undefined): number[] {
  if (!page || !at.lw) return [];
  const space = textWidth(" ", m, at);
  return splitLines(page).map((line, i) => {
    const ours = oneLine(piecesOf(line, m, at, at.ra ?? 0), space);
    const real = at.lw?.[i];
    return real && ours > 0 ? Math.min(2.5, Math.max(0.5, real / ours)) : 1;
  });
}

/**
 * Line count per {br} line of a template (one entry for plain text) at one
 * width, the worst over the rotating words. With the page's own template,
 * each line is calibrated against the page's real line widths.
 */
export function lineCounts(
  version: string,
  m: WrapMetrics,
  at: WrapWidth,
  page?: string,
): number[] {
  const factors = lineFactors(m, at, page);
  const space = textWidth(" ", m, at);
  return splitLines(version).map((line, i) => {
    const f = factors[i] ?? 1;
    const rot = line.find((t) => t.t === "rot");
    const n = rot && rot.t === "rot" ? rot.alts.length : 1;
    let worst = 0;
    for (let a = 0; a < n; a++) {
      const pieces = piecesOf(line, m, at, a).map((p) => ({ w: p.w * f, gap: p.gap }));
      worst = Math.max(worst, wrapCount(pieces, space * f, at.box));
    }
    return worst;
  });
}

/**
 * How far a candidate is from holding the page's lines, summed over the
 * measured widths: 0 holds everywhere. Plain text and templates must take
 * the page's count on every line; text poured into the page's lines must
 * fit in their number and have a word for each.
 */
export function holdScore(version: string, m: WrapMetrics, page?: string): number {
  let score = 0;
  for (const at of m.widths) {
    const got = lineCounts(version, m, at, page);
    if (m.kind === "lines") {
      const total = got.reduce((s, n) => s + n, 0);
      const words = version.split(/\s+/).filter(Boolean).length;
      score += Math.max(0, total - at.lines) + Math.max(0, at.lines - words);
      continue;
    }
    // A template is compared with the page's own template simulated the same
    // way, each line at its worst rotating word: the page itself changes line
    // as its words rotate, and the snippet reserves the tallest.
    const want =
      page && m.kind === "template"
        ? lineCounts(page, m, at, page)
        : at.tl && at.tl.length === got.length
          ? at.tl
          : [at.lines];
    const have = want.length === got.length ? got : [got.reduce((s, n) => s + n, 0)];
    have.forEach((n, i) => {
      score += Math.abs(n - (want[i] ?? n));
    });
  }
  return score;
}
