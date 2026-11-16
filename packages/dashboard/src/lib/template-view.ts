/**
 * How the dashboard shows a template (docs/specs/template-writing.md §4.5):
 * the words a visitor reads, a small marker where the page has an image, a
 * line break where the page breaks, the styled words set apart, and the
 * rotating word with its alternatives. Never the raw tokens.
 */
import { parseTemplate } from "@rawuser/shared/template";

export type TemplatePart =
  | { kind: "text"; text: string; styled: boolean }
  | { kind: "br" }
  | { kind: "glyph"; n: number }
  | { kind: "rot"; alts: string[]; styled: boolean };

const TOKEN = /\{br\}|\{g\d+\}|\{\/?s\d+\}|\{rot:[^}]*\}/;

/** A string that carries template tokens. */
export function isTemplate(text: string | null | undefined): boolean {
  return TOKEN.test(text ?? "");
}

export function templateParts(template: string): TemplatePart[] {
  const out: TemplatePart[] = [];
  let depth = 0;
  for (const tok of parseTemplate(template)) {
    if (tok.t === "open") depth++;
    else if (tok.t === "close") depth = Math.max(0, depth - 1);
    else if (tok.t === "br") out.push({ kind: "br" });
    else if (tok.t === "glyph") out.push({ kind: "glyph", n: tok.n });
    else if (tok.t === "rot") out.push({ kind: "rot", alts: tok.alts, styled: depth > 0 });
    else if (tok.text) out.push({ kind: "text", text: tok.text, styled: depth > 0 });
  }
  return out;
}

/** The words of a template on one line, for titles and tooltips: the first alternative shown. */
export function templatePlain(template: string): string {
  return templateParts(template)
    .map((p) =>
      p.kind === "text"
        ? p.text
        : p.kind === "rot"
          ? (p.alts[0] ?? "")
          : p.kind === "br"
            ? " "
            : "",
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether Rawuser writes this part: not the operator's "leave it", not text
 * that changes by itself, not letter-split text without a decision. A part
 * built word by word carries a template and is written (its rotating word is
 * what made it look animated).
 */
export function writesPart(e: {
  skip?: boolean;
  plain?: boolean;
  inline?: { split?: boolean; animated_text?: boolean; template?: string; lines?: number };
}): boolean {
  if (e.skip) return false;
  if (e.inline?.template || e.inline?.lines) return true;
  if (e.inline?.animated_text) return false;
  if (e.inline?.split && !e.plain) return false;
  return true;
}
