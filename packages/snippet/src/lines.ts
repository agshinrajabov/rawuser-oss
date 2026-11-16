/**
 * Lines on the core side (docs/specs/interactive-text.md §3.2, phase 3):
 * how many lines a text takes, words cut evenly into n lines, and a shorter
 * version cut into the page's own count (padTo, used by the fit check on
 * every headline). The writer that pours a version into the lines a page
 * made moved to lines-write.ts, loaded on demand as /rich.js (2026-09-30:
 * the core was at 14,957 of 15,360 B gzip; lines.ts minified to 4,067 B,
 * most of it that writer, which only split-lines pages need).
 */

/**
 * Words cut into at most `n` lines of as even a length as they allow: the
 * shortest longest line that still packs into `n` (a page that fits its
 * font to its lines, Grigoletti, keeps its own line count).
 */
export function balance(words: readonly string[], n: number): string[][] {
  const pack = (limit: number): string[][] => {
    const out: string[][] = [];
    let cur: string[] = [];
    for (const w of words) {
      if (cur.length > 0 && [...cur, w].join(" ").length > limit) {
        out.push(cur);
        cur = [];
      }
      cur.push(w);
    }
    if (cur.length > 0) out.push(cur);
    return out;
  };
  let lo = Math.max(0, ...words.map((w) => w.length));
  let hi = words.join(" ").length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pack(mid).length <= n) hi = mid;
    else lo = mid + 1;
  }
  return pack(lo);
}

/** How many line boxes the element's text takes at its width now. */
export function lineCount(el: Element): number {
  try {
    const r = document.createRange();
    r.selectNodeContents(el);
    const tops: number[] = [];
    for (const b of Array.from(r.getClientRects())) {
      if (b.width > 0 && b.height > 0 && !tops.some((t) => Math.abs(t - b.top) < b.height / 2))
        tops.push(b.top);
    }
    return tops.length;
  } catch {
    return 0;
  }
}

/**
 * A shorter version cut into the page's own number of lines. Before a page
 * splits it: balanced segments with a <br> between them, which the page's
 * split then keeps as its lines (GSAP SplitText does, 2026-09-30); the
 * trailing space keeps the words apart in textContent and in the label a
 * split library copies. A plain headline: the same segments with a newline
 * inside its one text node under white-space: pre-line, no markup added
 * (a pilot site; a 2-line headline held in a 4-line box left a 96 px blank,
 * 2026-09-30). False, and the words
 * back as they were, when they do not make that many lines at this width.
 */
export function padTo(el: Element, text: string, n: number, br: boolean): boolean {
  const cut = balance(text.split(/\s+/).filter(Boolean), n);
  // Short words pack into fewer lines than asked ("We build / hand-made /
  // products." for four, a pilot site at 360): the longest run is split again.
  while (cut.length < n) {
    const i = cut.reduce((m, ws, k) => (ws.length > (cut[m]?.length ?? 0) ? k : m), 0);
    const ws = cut[i] as string[];
    if (ws.length < 2) break;
    cut.splice(i, 1, ws.slice(0, ws.length >> 1), ws.slice(ws.length >> 1));
  }
  const node = !br && el.childNodes.length === 1 ? (el.firstChild as Text) : null;
  const was = node?.nodeValue;
  const style = (el as HTMLElement).style;
  if (cut.length === n && (br || node?.nodeType === 3)) {
    if (node) {
      style.whiteSpace = "pre-line";
      node.nodeValue = cut.map((ws) => ws.join(" ")).join("\n");
    } else {
      el.textContent = "";
      cut.forEach((ws, k) => {
        if (k > 0) el.appendChild(document.createElement("br"));
        el.appendChild(document.createTextNode(ws.join(" ") + (k < n - 1 ? " " : "")));
      });
    }
    if (lineCount(el) === n) return true;
  }
  // Put back only what was written: a part with more than one node and no
  // cut was not touched, and keeps its nodes (a <br> in a headline React has
  // not hydrated yet, faster-tag.md E3).
  if (node) {
    style.whiteSpace = "";
    node.nodeValue = was ?? text;
  } else if (br) el.textContent = text;
  return false;
}
