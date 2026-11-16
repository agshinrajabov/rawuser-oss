/**
 * How the page wraps each headline at 1280, 768 and 390 px
 * (docs/specs/interactive-text.md §3.4, phase 4), measured once when the
 * operator presses Done: the page loads in a hidden same-origin frame at
 * each width (named so the snippet inside does nothing), and for each
 * headline we read its font, its box, the width of each image in it, how
 * many lines the page takes, and a width table of its font at 100 px.
 * Generation wraps its candidates with these and keeps those that hold the
 * page's lines. Page facts, measured in the operator's own browser; the edge
 * never sends them to a visitor. The shape mirrors @rawuser/shared wrap.ts.
 */

import { lineSet, readElementTemplate, segmentsOf, templateText, treeOf } from "../template.ts";

export interface WrapWidth {
  w: number;
  size: number;
  box: number;
  ls: number;
  k: number;
  glyphs?: number[];
  lines: number;
  tl?: number[];
  /** A template's lines, each on one line, their real widths in px. */
  lw?: number[];
  /** The rotating word the page showed while measured. */
  ra?: number;
}

export interface WrapMetrics {
  v: 1;
  kind: "plain" | "template" | "lines";
  upper?: boolean;
  chars: Record<string, number>;
  widths: WrapWidth[];
}

export const MEASURE_WIDTHS = [1280, 768, 390] as const;
const FRAME_NAME = "rawuser-measure";
const LOAD_TIMEOUT_MS = 12000;
/** Past a split that runs on load (Webflow's GSAP at up to 4.3 s is rare; most split in 1 s). */
const SETTLE_MS = 1200;

const BASE =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?'\"’“”-–—()&%/+$€£₼";
const EXTRA: Record<string, string> = {
  az: "əğıöşçüƏĞİÖŞÇÜ",
  tr: "ğıöşçüĞİÖŞÇÜ",
  de: "äöüßÄÖÜ",
  fr: "àâçéèêëîïôûùœÀÂÇÉÈÊÎÔÛ",
  es: "áéíñóúüÁÉÍÑÓÚ¿¡",
  ru: "абвгдеёжзийклмнопрстуфхцчшщъыьэюяАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ",
};

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Shown to a reader: not inside a rotator's other words (faded out and
 * moved below the line: the lab counted one line too many on each rotating
 * line) and not hidden. Opacity alone says nothing: split letters wait at
 * 0.001 for their entrance.
 */
function shown(node: Node, stop: Element, win: Window, others: ReadonlySet<Element>): boolean {
  for (
    let e = node.nodeType === 1 ? (node as Element) : node.parentElement;
    e;
    e = e.parentElement
  ) {
    if (others.has(e)) return false;
    const st = win.getComputedStyle(e);
    if (st.visibility === "hidden" || st.display === "none") return false;
    if (e === stop) break;
  }
  return true;
}

/**
 * Lines the given nodes take: the boxes of their visible text and images,
 * grouped by their top. Words a rotator keeps faded out below the line
 * are not a line (the lab counted one too many on each rotating line).
 */
function countLines(
  nodes: readonly Node[],
  stop: Element,
  win: Window,
  lineHeight: number,
  others: ReadonlySet<Element> = new Set(),
): number {
  const doc = stop.ownerDocument;
  const tops: number[] = [];
  const visit = (n: Node) => {
    if (n.nodeType === 3) {
      if (!/\S/.test(n.nodeValue ?? "") || !shown(n, stop, win, others)) return;
      const r = doc.createRange();
      r.selectNodeContents(n);
      for (const b of Array.from(r.getClientRects()))
        if (b.width > 0 && b.height > 0) tops.push(b.top);
      return;
    }
    if (n.nodeType !== 1) return;
    const e = n as Element;
    if (!/\S/.test(e.textContent ?? "")) {
      if (!shown(e, stop, win, others)) return;
      const b = e.getBoundingClientRect();
      if (b.width > 0 && b.height > 0) tops.push(b.top);
      return;
    }
    for (const c of Array.from(e.childNodes)) visit(c);
  };
  for (const n of nodes) visit(n);
  tops.sort((a, b) => a - b);
  let count = 0;
  let at = Number.NEGATIVE_INFINITY;
  for (const t of tops) {
    if (t - at > lineHeight * 0.5) {
      count++;
      at = t;
    }
  }
  return Math.max(1, count);
}

/** The template's nodes cut at its line breaks. */
function templateLineNodes(el: Element): Node[][] {
  const cut = segmentsOf(treeOf(el));
  if (!cut) return [];
  const lines: Node[][] = [[]];
  for (const s of cut.segments) {
    const cur = lines[lines.length - 1] as Node[];
    if (s.t === "br") lines.push([]);
    else if (s.t === "text") for (const u of s.units) cur.push(u.ref as Node);
    else if ((s.t === "glyph" || s.t === "rot") && s.ref) cur.push(s.ref as Node);
  }
  return lines.filter((l) => l.length > 0);
}

interface Reading {
  kind: WrapMetrics["kind"];
  upper: boolean;
  font: string;
  text: string;
  at: WrapWidth;
}

/** One headline in one frame. */
function readAt(el: Element, win: Window, w: number, chars: Record<string, number>): Reading {
  const cs = win.getComputedStyle(el);
  const size = Number.parseFloat(cs.fontSize) || 16;
  const ls = Number.parseFloat(cs.letterSpacing) || 0;
  const lh = Number.parseFloat(cs.lineHeight) || size * 1.2;
  const tree = treeOf(el);
  const lines = lineSet(tree);
  const tpl = lines ? null : readElementTemplate(el);
  const kind: WrapMetrics["kind"] = lines ? "lines" : tpl ? "template" : "plain";
  const padding =
    (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0);
  const box = lines
    ? ((lines[0]?.ref as Element | undefined)?.clientWidth ?? el.clientWidth)
    : el.clientWidth - padding;
  const at: WrapWidth = { w, size: round(size), box: round(box), ls: round(ls), k: 1, lines: 1 };
  let text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (lines) {
    at.lines = lines.length;
    text = lines.map((l) => ((l.ref as Element).textContent ?? "").trim()).join(" ");
  } else if (tpl) {
    text = templateText(tpl.template).replace(/\n/g, " ");
    const cut = segmentsOf(tree);
    at.glyphs = (cut?.segments ?? [])
      .filter((s) => s.t === "glyph")
      .map((s) => round((s.ref as Element).getBoundingClientRect?.().width ?? 0));
    // The rotating word shown now (its state class, else the one not faded); the others left out.
    const rot = cut?.segments.find((s) => s.t === "rot");
    const others = new Set<Element>();
    if (rot && rot.t === "rot") {
      const alts = rot.altRefs as Element[];
      let on = alts.findIndex((a) =>
        /(^|\s)(on|active|current|is-active|is-current|visible|is-visible|show|shown|selected)(\s|$)/.test(
          a.className,
        ),
      );
      if (on < 0)
        on = alts.findIndex((a) => Number.parseFloat(win.getComputedStyle(a).opacity) > 0.5);
      alts.forEach((a, i) => {
        if (i !== on) others.add(a);
      });
      if (on >= 0) at.ra = on;
    }
    const tl = templateLineNodes(el).map((ns) => countLines(ns, el, win, lh, others));
    at.tl = tl;
    at.lines = tl.reduce((s, n) => s + n, 0);
    // Each line's own width on one line, as the page styles it (groups in
    // another face, an image's margins, the rotating word's box): a copy of
    // the headline beside it that never wraps. Generation calibrates each
    // line of its simulation with it.
    const clone = el.cloneNode(true) as HTMLElement;
    clone.style.cssText +=
      ";position:absolute;visibility:hidden;white-space:nowrap;width:max-content;left:0;top:0";
    el.parentNode?.insertBefore(clone, el.nextSibling);
    at.lw = templateLineNodes(clone).map((ns) => {
      const r = el.ownerDocument.createRange();
      r.setStartBefore(ns[0] as Node);
      r.setEndAfter(ns[ns.length - 1] as Node);
      return round(r.getBoundingClientRect().width);
    });
    clone.remove();
  } else {
    at.lines = countLines(Array.from(el.childNodes), el, win, lh);
  }
  // Calibration: the page's own words in a no-wrap span in its font, against our table.
  const doc = el.ownerDocument;
  const span = doc.createElement("span");
  span.textContent = text;
  const st = span.style;
  st.font = cs.font;
  st.letterSpacing = cs.letterSpacing;
  st.textTransform = cs.textTransform;
  st.whiteSpace = "nowrap";
  st.position = "absolute";
  st.visibility = "hidden";
  doc.body.appendChild(span);
  const real = span.getBoundingClientRect().width;
  span.remove();
  const upper = cs.textTransform === "uppercase";
  let sum = 0;
  let n = 0;
  for (const ch of upper ? text.toUpperCase() : text) {
    sum += chars[ch] ?? 55;
    n++;
  }
  const ours = (sum * size) / 100 + ls * n;
  if (real > 0 && ours > 0)
    at.k = Math.round(Math.min(2, Math.max(0.5, real / ours)) * 1000) / 1000;
  return { kind, upper, font: `${cs.fontStyle} ${cs.fontWeight} 100px ${cs.fontFamily}`, text, at };
}

/** The width table of a font at 100 px, for the language's letters and the page's own. */
function charTable(
  doc: Document,
  font: string,
  text: string,
  lang: string,
): Record<string, number> {
  const ctx = doc.createElement("canvas").getContext("2d");
  const out: Record<string, number> = {};
  if (!ctx) return out;
  ctx.font = font;
  const set = new Set(Array.from(BASE + (EXTRA[lang] ?? "") + text));
  for (const ch of set) {
    if (Object.keys(out).length >= 200) break;
    out[ch] = round(ctx.measureText(ch).width);
  }
  return out;
}

/** The page in a hidden frame at one width; null when it will not load or refuses framing. */
function openFrame(doc: Document, w: number): Promise<HTMLIFrameElement | null> {
  return new Promise((resolve) => {
    const f = doc.createElement("iframe");
    f.name = FRAME_NAME;
    f.setAttribute("aria-hidden", "true");
    f.tabIndex = -1;
    f.style.cssText = `position:fixed;left:-${w + 100}px;top:0;width:${w}px;height:900px;border:0;visibility:hidden;pointer-events:none`;
    const url = doc.location.href.split("#")[0] ?? doc.location.href;
    const timer = setTimeout(() => {
      f.remove();
      resolve(null);
    }, LOAD_TIMEOUT_MS);
    f.addEventListener("load", () => {
      clearTimeout(timer);
      let inner: Document | null = null;
      try {
        inner = f.contentDocument;
      } catch {
        inner = null;
      }
      if (!inner?.body) {
        f.remove();
        resolve(null);
        return;
      }
      const fonts = (inner as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
      const settle = () => setTimeout(() => resolve(f), SETTLE_MS);
      if (fonts) fonts.ready.then(settle, settle);
      else settle();
    });
    f.src = url;
    doc.body.appendChild(f);
  });
}

function nearestWidth(w: number): number {
  return MEASURE_WIDTHS.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));
}

/**
 * The wrap measurement for each headline part, keyed by path. A frame the
 * page refuses (X-Frame-Options) leaves that width out; with none at all,
 * the operator's own window stands in for its nearest width.
 */
export async function measureMetrics(
  parts: ReadonlyArray<{ path: string; css: string }>,
  doc: Document = document,
): Promise<Record<string, WrapMetrics>> {
  const lang = (doc.documentElement.lang || "en").slice(0, 2).toLowerCase();
  const found: Record<string, WrapMetrics> = {};
  const measureIn = (d: Document, win: Window, w: number) => {
    for (const { path, css } of parts) {
      let el: Element | null = null;
      try {
        el = d.querySelector(css);
      } catch {
        el = null;
      }
      if (!el) continue;
      const cs = win.getComputedStyle(el);
      const probe = readAt(el, win, w, found[path]?.chars ?? {});
      if (!found[path]) {
        const chars = charTable(d, probe.font, probe.text, lang);
        found[path] = { v: 1, kind: probe.kind, chars, widths: [] };
        if (cs.textTransform === "uppercase") found[path].upper = true;
      }
      const m = found[path];
      if (m.widths.some((x) => x.w === w)) continue;
      // Read again now that the table exists, so the calibration uses it.
      m.widths.push(readAt(el, win, w, m.chars).at);
    }
  };
  for (const w of MEASURE_WIDTHS) {
    const f = await openFrame(doc, w);
    if (!f?.contentWindow || !f.contentDocument) continue;
    try {
      measureIn(f.contentDocument, f.contentWindow, w);
    } catch {
      // a frame the page broke: this width is left out
    }
    f.remove();
  }
  if (Object.keys(found).length === 0 && doc.defaultView) {
    measureIn(doc, doc.defaultView, nearestWidth(doc.defaultView.innerWidth));
  }
  return found;
}
