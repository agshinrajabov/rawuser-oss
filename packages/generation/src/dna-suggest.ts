/**
 * Product-brief suggestions read from the customer's site
 * (docs/specs/dna-suggestions.md).
 *
 * The visible text of the home page goes to the model with one instruction:
 * propose entries for the brief, and for every list entry quote the words on
 * the page that support it. The worker then checks each quote against the
 * page text and drops anything the page does not say. What reaches the
 * dashboard is therefore always something the customer already claims in
 * public; the operator still picks and edits.
 *
 * Runs once per customer and is cached by the handler. Never in the visitor
 * path.
 */

import type { DnaSuggestion, DnaSuggestions } from "@rawuser/shared";
import { jsonrepair } from "jsonrepair";
import { callModel } from "./call-model.ts";
import type { GenerateEnv } from "./generateVariant.ts";

/** Interactive read: a person is waiting. */
const SUGGEST_TIMEOUTS = { firstMs: 15_000, fallbackMs: 25_000 } as const;

const TEXT_CAP_CHARS = 40_000;
const MAX_PER_LIST = 5;
const MAX_TEXT_CHARS = 160;
const MAX_EVIDENCE_CHARS = 200;

/**
 * Cleaned HTML → visible text. Keeps headings and list structure as line
 * breaks so the model sees the page's own emphasis. Exported for tests.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(br|p|div|li|h[1-6]|section|article|header|footer|tr|blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return text.length > TEXT_CAP_CHARS ? text.slice(0, TEXT_CAP_CHARS) : text;
}

/** Whitespace-insensitive, case-insensitive containment. Exported for tests. */
export function evidenceOnPage(evidence: string, pageText: string): boolean {
  // Fold case and diacritics on both sides (İ/i, ş/s, ə stays ə) so a quote
  // the model re-cased still matches the page.
  const norm = (s: string) =>
    s
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[“”«»"']/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const e = norm(evidence);
  if (e.length < 8) return false;
  return norm(pageText).includes(e);
}

export function buildSuggestPreamble(): string {
  return [
    "You read a company's home page and propose entries for its product brief.",
    "The brief has these fields:",
    "- product: one sentence, what it is and what it does.",
    "- icp: the one visitor they most want to win, a specific person, not 'everyone'.",
    "- target_market: geography or market, if the page says.",
    "- language: BCP-47 tag of the page's main language (az, en, ru, tr, ...).",
    "- brand_voice: three or four adjectives for how the page itself sounds (its register,",
    "  not what it sells), in English, e.g. 'warm, direct, confident'.",
    "- value_props: the main reasons to choose them, in their own words. Up to 5.",
    "- differentiators: what makes them not interchangeable with alternatives. Up to 5.",
    "- proof_points: names, numbers, logos, results. Up to 5.",
    "",
    "Rules:",
    "1. Use only what the page says. Never invent a number, a name, a client, a result.",
    "2. Every list entry carries `evidence`: an exact quote of 3 to 20 words copied from",
    "   the page text that supports it. If you cannot quote it, do not propose it.",
    "3. Write `text` in the page's own language, short, plain, no marketing filler.",
    "4. If a field is not answerable from the page, return null (fields) or [] (lists).",
    "5. Output one JSON object and nothing else:",
    '{"language": "az", "product": "...", "icp": "...", "target_market": "...", "brand_voice": "...",',
    ' "value_props": [{"text": "...", "evidence": "..."}],',
    ' "differentiators": [{"text": "...", "evidence": "..."}],',
    ' "proof_points": [{"text": "...", "evidence": "..."}]}',
  ].join("\n");
}

function sliceJson(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Suggestion parse failed: no JSON object found in model output");
  }
  return raw.slice(start, end + 1);
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function list(v: unknown, pageText: string): DnaSuggestion[] {
  if (!Array.isArray(v)) return [];
  const out: DnaSuggestion[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const text = str(o.text, MAX_TEXT_CHARS);
    const evidence = str(o.evidence, MAX_EVIDENCE_CHARS);
    if (!text || !evidence) continue;
    if (!evidenceOnPage(evidence, pageText)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, evidence });
    if (out.length >= MAX_PER_LIST) break;
  }
  return out;
}

/**
 * Parse and validate the model output against the page text. Exported for
 * tests. Entries without evidence on the page are dropped, never repaired.
 */
export function parseSuggestions(raw: string, pageText: string, url: string): DnaSuggestions {
  const slice = sliceJson(raw);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(slice) as Record<string, unknown>;
  } catch {
    // Same repair as the orchestrator; the evidence check below still gates
    // every list entry, so a repaired object cannot smuggle in a claim.
    parsed = JSON.parse(jsonrepair(slice)) as Record<string, unknown>;
  }
  const lang = str(parsed.language, 12);
  return {
    url,
    generated_at: Date.now(),
    language: lang ? lang.toLowerCase() : null,
    product: str(parsed.product, 240),
    icp: str(parsed.icp, 300),
    target_market: str(parsed.target_market, 120),
    brand_voice: str(parsed.brand_voice, 80),
    value_props: list(parsed.value_props, pageText),
    differentiators: list(parsed.differentiators, pageText),
    proof_points: list(parsed.proof_points, pageText),
  };
}

/** Cleaned HTML in, evidence-checked suggestions out. */
export async function suggestDnaFromHtml(
  html: string,
  url: string,
  env: GenerateEnv,
  /** BCP-47 tag of the page; when known, every `text` is written in it. */
  language?: string | null,
): Promise<DnaSuggestions> {
  const pageText = htmlToText(html);
  if (pageText.length < 80) {
    throw new Error("Page has too little text to read");
  }
  // A structured read, not copy: the read role (the founder's call on cost,
  // 2026-09-10). Same prompt, same evidence check on any model.
  // A person is waiting on this read (the apply page, the brief form), so the
  // budget is short: the primary 15 s, then the fallback 25 s. An outage of
  // the primary used to leave the apply page on "Reading your page..." with
  // no end (2026-10-02).
  const call = await callModel(
    {
      prompt: `Page URL: ${url}\n${
        language
          ? `Page language: ${language}. Write every text field in this language, even if the page mixes languages.\n`
          : ""
      }\nPage text:\n${pageText}\n\nReturn the JSON object.`,
      cachedPreamble: buildSuggestPreamble(),
      role: "read",
      maxTokens: 1500,
      jsonMode: true,
    },
    env,
    SUGGEST_TIMEOUTS,
  );
  if (!call.ok) throw new Error(`Suggestion call failed: ${call.error}`);
  const result = call.value;
  return parseSuggestions(result.text, pageText, url);
}
