/**
 * The keyword lexicon, built offline (docs/specs/keyword-intent.md §4;
 * the privacy review's rulings, sections 9 and 10).
 *
 * One model call per build turns a customer's brief into short search
 * phrases per served intent and site language; the shared validator folds,
 * limits and screens them; the result is stored on the customers row and
 * copied into the visitor bundle as `kl`, where the edge matches an ad
 * keyword (`utm_term`) against it in memory. The visitor path never calls a
 * model and never sees this module.
 *
 * What the model sees (condition 9): the product, the audience (icp and
 * target market), the differentiators, what the brief says about
 * competitors, the site's languages and the served intents. Never proof
 * points, testimonials, captured page text, or anything from a visitor.
 *
 * Who gets one (condition 8): a customer that did not answer yes to the
 * special-category question, is not marked sensitive and did not turn
 * keyword reading off. The store re-checks all three in its own UPDATE, so
 * a mark that lands during the model call wins.
 *
 * The screen (condition 7): `refusesSpecialCategory` for en, az, ru and tr,
 * and on every phrase in any language; for any other site language a second
 * offline model call screens that language's phrases, a yes refuses, and a
 * failed call leaves that language out.
 *
 * Logs carry counts and reason words only, never a phrase (condition 10).
 */

import {
  type IntentDim,
  KEYWORD_INTENTS,
  type KeywordLexicon,
  refusesSpecialCategory,
  validateLexicon,
} from "@rawuser/shared";
import { jsonrepair } from "jsonrepair";
import { writeVisitorBundle } from "../admin/onboard.ts";
import { type CallEnv, type CallTimeouts, callModel } from "../call-model.ts";
import type { GenerateInput, GenerateResult } from "../generateVariant.ts";
import { modelConfigured } from "../model-config.ts";
import { loadServedIntents } from "../site-map/served-load.ts";

/** Phrases the model may give per intent per language (the spec's 40). */
export const PHRASES_PER_LANGUAGE = 40;
/** Languages one lexicon covers (the shared cap: 120 per intent, 40 each). */
export const LEXICON_LANGUAGES_MAX = 3;
/** Languages the shared table screens; any other gets the model screen. */
export const TABLE_SCREENED_LANGUAGES: readonly string[] = ["en", "az", "ru", "tr"];
/** Customers one six-hour sweep builds for, at most one build each. */
export const KEYWORD_SWEEP_MAX = 5;

/** A build from an admin request: inside the request's waitUntil budget. */
export const REQUEST_TIMEOUTS: CallTimeouts = { firstMs: 20_000, fallbackMs: 8_000 };
/** A build from the six-hour sweep: offline, room for a slow answer. */
export const SWEEP_TIMEOUTS: CallTimeouts = { firstMs: 60_000, fallbackMs: 60_000 };

/** The call, injectable for tests. */
export type KeywordModelCall = (
  input: GenerateInput,
  env: CallEnv,
  timeouts?: CallTimeouts,
) => Promise<{ ok: true; value: GenerateResult } | { ok: false; error: string }>;

export type KeywordEnv = CallEnv & {
  DB: D1Database;
  VARIANTS: KVNamespace;
};

/** What the model is given, and nothing else (condition 9). */
export interface KeywordInput {
  product: string;
  /** The brief's icp and target market. */
  audience: string;
  differentiators: string[];
  /** What the brief says about competitors (its competitor hint); "" when none or not served. */
  competitors: string;
  /** Primary subtags, the brief's language first, at most LEXICON_LANGUAGES_MAX. */
  languages: string[];
  /** Served intents other than brand. */
  intents: IntentDim[];
}

/** Why no lexicon was built; a word for the log, never a phrase. */
export type KeywordSkip =
  | "not_found"
  | "special_category"
  | "sensitive"
  | "off"
  | "no_brief"
  | "no_intents"
  | "no_model"
  | "model_failed"
  | "malformed"
  | "marked_meanwhile";

export type KeywordBuildResult =
  | {
      ok: true;
      /** False when the answer was valid but the validator kept no phrase (NULL stored). */
      kept: boolean;
      intents: number;
      phrases: number;
      /** Languages a failed model screen left out. */
      languages_dropped: number;
      cost_usd: number;
    }
  | { ok: false; reason: KeywordSkip };

/** The gate row (BUNDLE_KEYWORD_SQL's columns plus live_at). */
interface GateRow {
  sensitive: number | null;
  special_category: number | null;
  keyword_off: number | null;
  live_at: number | null;
}

/** The gate of condition 8: the reason no lexicon may be built, or null. */
export function keywordGate(row: GateRow | null): KeywordSkip | null {
  if (!row) return "not_found";
  // Condition 8, read strictly (the founder's call, 2026-10-22): only an
  // explicit "no" (0) builds; a yes or an unanswered question does not.
  if (row.special_category === null || Number(row.special_category) !== 0)
    return "special_category";
  if (Number(row.sensitive) === 1) return "sensitive";
  if (Number(row.keyword_off) === 1) return "off";
  return null;
}

async function loadGate(db: D1Database, customerId: string): Promise<GateRow | null> {
  return db
    .prepare("SELECT sensitive, special_category, keyword_off, live_at FROM customers WHERE id = ?")
    .bind(customerId)
    .first<GateRow>();
}

function listOf(raw: unknown): string[] {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function clip(text: string | null | undefined, max: number): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A BCP-47 tag's primary subtag, or null. */
export function primaryLanguage(tag: string | null | undefined): string | null {
  const p = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return /^[a-z]{2,3}$/.test(p) ? p : null;
}

/**
 * The model's input from the stored brief, the confirmed pages' languages
 * and the served set. Reads only the columns condition 9 allows: never
 * proof_points, never a capture, never an event.
 */
export async function loadKeywordInput(
  db: D1Database,
  customerId: string,
): Promise<KeywordInput | "no_brief" | "no_intents"> {
  const brief = await db
    .prepare(
      `SELECT product, icp, target_market, differentiators, per_intent_hints, target_language
         FROM business_dna WHERE customer_id = ?`,
    )
    .bind(customerId)
    .first<{
      product: string | null;
      icp: string | null;
      target_market: string | null;
      differentiators: string | null;
      per_intent_hints: string | null;
      target_language: string | null;
    }>();
  if (!brief || clip(brief.product, 600) === "") return "no_brief";

  const served = await loadServedIntents(customerId, db);
  const intents = KEYWORD_INTENTS.filter((d) => served === null || served.includes(d));
  if (intents.length === 0) return "no_intents";

  const pages = await db
    .prepare(
      `SELECT DISTINCT language FROM element_manifests
        WHERE customer_id = ? AND confirmed_at IS NOT NULL AND language IS NOT NULL`,
    )
    .bind(customerId)
    .all<{ language: string | null }>();
  const languages: string[] = [];
  for (const tag of [brief.target_language, ...(pages.results ?? []).map((r) => r.language)]) {
    const p = primaryLanguage(tag);
    if (p && !languages.includes(p)) languages.push(p);
  }
  if (languages.length === 0) languages.push("en");

  let competitors = "";
  if (intents.includes("competitor")) {
    try {
      const hints = JSON.parse(brief.per_intent_hints ?? "{}") as Record<string, unknown>;
      competitors = typeof hints.competitor === "string" ? clip(hints.competitor, 300) : "";
    } catch {
      competitors = "";
    }
  }

  return {
    product: clip(brief.product, 600),
    audience: [clip(brief.icp, 300), clip(brief.target_market, 300)]
      .filter((s) => s !== "")
      .join(" "),
    differentiators: listOf(brief.differentiators)
      .map((d) => clip(d, 200))
      .filter((d) => d !== "")
      .slice(0, 6),
    competitors,
    languages: languages.slice(0, LEXICON_LANGUAGES_MAX),
    intents,
  };
}

/** What each intent's phrases are for, in the words the model reads. */
const INTENT_LINES: Record<IntentDim, string> = {
  pricing: "pricing: the searcher wants the price, a plan, a free tier or a trial",
  competitor:
    "competitor: the searcher names a rival or looks for an alternative to one (rival names only from the brief, plus words like alternative, vs)",
  evaluation: "evaluation: the searcher compares options and reads reviews before choosing",
  feature: "feature: the searcher looks for one capability, integration or technical detail",
  problem: "problem: the searcher describes the problem the product solves, before knowing it",
  brand: "",
};

export const LEXICON_PREAMBLE = `You write the short phrases people type into a search engine before they click a business's ad.

For each intent and each language you are given, list phrases a searcher with that intent would type when looking for a product like this one. Write each language's phrases in that language and its own script, the way people really search in it.

Rules for every phrase:
- 1 to 4 words, lower case, at most 40 characters.
- Commercial words only: what the product does, costs, competes with or solves.
- Never a person's name, a place, a number alone, or a full sentence.
- Never a word about health, illness, disability, medicine, religion or belief, sexuality or sex life, politics, trade unions, race or ethnicity, genetics, biometrics, or crime.
- A phrase belongs to one intent only.

Give up to 40 phrases per intent per language, fewer when fewer are natural.

Answer with one JSON object and nothing else:
{"<language>": {"<intent>": ["phrase", "..."]}}
using exactly the language codes and intent words you were given.`;

/** The request: the allowed brief fields, the languages and the intents (condition 9). */
export function buildKeywordPrompt(input: KeywordInput): string {
  const lines = [
    `The product: ${input.product}`,
    `Who it is for: ${input.audience || "(not given)"}`,
    `What makes it different: ${input.differentiators.length > 0 ? input.differentiators.join("; ") : "(not given)"}`,
  ];
  if (input.intents.includes("competitor")) {
    lines.push(`Competitors the business names: ${input.competitors || "(none named)"}`);
  }
  lines.push(
    "",
    `Languages: ${input.languages.join(", ")}`,
    "Intents:",
    ...input.intents.map((d) => `- ${INTENT_LINES[d]}`),
    "",
    "Return the JSON object.",
  );
  return lines.join("\n");
}

/**
 * The model's answer as raw per-language objects, or null when it is not a
 * JSON object holding at least one asked language as an object. A language
 * key is matched by its primary subtag; anything not asked is ignored.
 */
export function parseKeywordAnswer(
  text: string,
  languages: readonly string[],
): Map<string, Record<string, unknown>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonrepair(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  let root = parsed as Record<string, unknown>;
  const wrapped = root.lexicon;
  if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
    root = wrapped as Record<string, unknown>;
  }
  const out = new Map<string, Record<string, unknown>>();
  for (const [key, value] of Object.entries(root)) {
    const lang = primaryLanguage(key);
    if (!lang || !languages.includes(lang) || out.has(lang)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    out.set(lang, value as Record<string, unknown>);
  }
  return out.size > 0 ? out : null;
}

/** One language's raw answer cut to PHRASES_PER_LANGUAGE per intent, then validated and table-screened. */
function validateLanguage(
  raw: Record<string, unknown>,
  intents: readonly IntentDim[],
): KeywordLexicon | null {
  const capped: Record<string, unknown> = {};
  for (const intent of intents) {
    const list = raw[intent];
    if (Array.isArray(list)) capped[intent] = list.slice(0, PHRASES_PER_LANGUAGE);
  }
  return validateLexicon(capped, intents, refusesSpecialCategory);
}

export const SCREEN_PREAMBLE = `You check short search phrases before a website uses them.

For each phrase, answer "yes" if it names or points to any of these, else "no":
a health condition, illness, disability, medicine or treatment; religion or belief; sexual orientation or sex life; political opinion or a party; trade union membership; race or ethnic origin; genetic or biometric data; a crime, offence or criminal record.
When unsure, answer "yes".

Answer with one JSON object and nothing else:
{"answers": ["yes" or "no", one per phrase, in the order given]}`;

/**
 * The model screen for a language the table does not cover (condition 7):
 * the set of phrases it keeps, or null when the call failed or its answer
 * does not give one plain "no" or "yes" per phrase (the language is then
 * left out). Anything but "no" refuses.
 */
export async function screenWithModel(
  language: string,
  phrases: readonly string[],
  env: KeywordEnv,
  call: KeywordModelCall,
  timeouts: CallTimeouts,
): Promise<{ kept: Set<string>; costUsd: number } | null> {
  if (phrases.length === 0) return { kept: new Set(), costUsd: 0 };
  const result = await call(
    {
      prompt: `Language: ${language}\nPhrases:\n${JSON.stringify(phrases)}\n\nReturn the JSON object.`,
      cachedPreamble: SCREEN_PREAMBLE,
      role: "read",
      maxTokens: Math.min(4000, 200 + phrases.length * 8),
      jsonMode: true,
    },
    env,
    timeouts,
  );
  if (!result.ok) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonrepair(result.value.text));
  } catch {
    return null;
  }
  const answers =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { answers?: unknown }).answers
      : parsed;
  if (!Array.isArray(answers) || answers.length !== phrases.length) return null;
  const kept = new Set<string>();
  for (const [i, a] of answers.entries()) {
    if (typeof a === "string" && a.trim().toLowerCase() === "no") kept.add(phrases[i] as string);
  }
  return { kept, costUsd: result.value.costUsd ?? 0 };
}

/** Clears the stored lexicon (a customer marked sensitive, or a special-category yes). */
export async function clearKeywordLexicon(db: D1Database, customerId: string): Promise<void> {
  await db
    .prepare("UPDATE customers SET keyword_lexicon = NULL, keyword_lexicon_at = NULL WHERE id = ?")
    .bind(customerId)
    .run();
}

/**
 * Marks a stored lexicon due again (the served intents changed): the
 * six-hour sweep builds it again; the bundle keeps the old one until then,
 * and the edge folds an intent the site no longer serves. A customer
 * without a lexicon is already due.
 */
export async function markKeywordLexiconDue(db: D1Database, customerId: string): Promise<void> {
  // Best effort: a served-set write never fails on this line.
  try {
    await db
      .prepare(
        "UPDATE customers SET keyword_lexicon_at = 0 WHERE id = ? AND keyword_lexicon_at IS NOT NULL",
      )
      .bind(customerId)
      .run();
  } catch {
    console.error("[rawuser/keywords] lexicon not marked due");
  }
}

/**
 * Builds, validates, stores and publishes one customer's lexicon. Stores
 * nothing when the gate refuses, the model fails or its answer is
 * malformed. A valid answer the validator empties stores NULL with the
 * time, so the sweep does not ask again until the brief changes.
 */
export async function buildKeywordLexicon(
  customerId: string,
  env: KeywordEnv,
  opts: { call?: KeywordModelCall; timeouts?: CallTimeouts; now?: number } = {},
): Promise<KeywordBuildResult> {
  const call = opts.call ?? callModel;
  const timeouts = opts.timeouts ?? SWEEP_TIMEOUTS;
  const gate = keywordGate(await loadGate(env.DB, customerId));
  if (gate) return { ok: false, reason: gate };
  const input = await loadKeywordInput(env.DB, customerId);
  if (typeof input === "string") return { ok: false, reason: input };
  // The model is not configured in this isolate (seen right after a deploy):
  // nothing is called, as in the write queue.
  if (!modelConfigured(env)) return { ok: false, reason: "no_model" };

  const result = await call(
    {
      prompt: buildKeywordPrompt(input),
      cachedPreamble: LEXICON_PREAMBLE,
      role: "read",
      maxTokens: 6000,
      jsonMode: true,
    },
    env,
    timeouts,
  );
  if (!result.ok) return { ok: false, reason: "model_failed" };
  let cost = result.value.costUsd ?? 0;
  const answer = parseKeywordAnswer(result.value.text, input.languages);
  if (!answer) return { ok: false, reason: "malformed" };

  // Per language: cut, fold, limit and table-screen; then the model screen
  // for a language the table does not cover.
  const merged: Record<string, string[]> = {};
  let dropped = 0;
  for (const lang of input.languages) {
    const raw = answer.get(lang);
    if (!raw) continue;
    let lexicon = validateLanguage(raw, input.intents);
    if (!lexicon) continue;
    if (!TABLE_SCREENED_LANGUAGES.includes(lang)) {
      const phrases = Object.values(lexicon).flat();
      const screened = await screenWithModel(lang, phrases, env, call, timeouts);
      if (!screened) {
        dropped++;
        continue;
      }
      cost += screened.costUsd;
      const kept: KeywordLexicon = {};
      for (const [intent, list] of Object.entries(lexicon) as [IntentDim, string[]][]) {
        const left = list.filter((p) => screened.kept.has(p));
        if (left.length > 0) kept[intent] = left;
      }
      lexicon = kept;
    }
    for (const [intent, list] of Object.entries(lexicon) as [IntentDim, string[]][]) {
      merged[intent] = [...(merged[intent] ?? []), ...list];
    }
  }
  // One phrase in one intent across languages, the shared caps, the table
  // screen once more over every language.
  const final = validateLexicon(merged, input.intents, refusesSpecialCategory);

  const now = opts.now ?? Date.now();
  const stored = await env.DB.prepare(
    `UPDATE customers SET keyword_lexicon = ?, keyword_lexicon_at = ?
      WHERE id = ? AND COALESCE(sensitive, 0) != 1 AND special_category = 0
        AND keyword_off = 0`,
  )
    .bind(final ? JSON.stringify(final) : null, now, customerId)
    .run();
  if (Number(stored.meta?.changes ?? 0) === 0) return { ok: false, reason: "marked_meanwhile" };
  await writeVisitorBundle(env, customerId);

  const lists = final ? Object.values(final) : [];
  return {
    ok: true,
    kept: final !== null,
    intents: lists.length,
    phrases: lists.reduce((n, l) => n + (l?.length ?? 0), 0),
    languages_dropped: dropped,
    cost_usd: cost,
  };
}

/**
 * The request triggers (go live, a brief saved, the served set changed): a
 * build for a live customer, inside the request's waitUntil when there is
 * one. Never throws; a build that does not finish is picked up by the
 * six-hour sweep (the lexicon is still missing, older than the brief, or
 * marked due).
 */
export function refreshKeywordLexicon(
  env: KeywordEnv,
  customerId: string,
  ctx?: { waitUntil(p: Promise<unknown>): void },
  opts: { call?: KeywordModelCall } = {},
): Promise<void> {
  const job = (async () => {
    const gate = await loadGate(env.DB, customerId);
    if (!gate || gate.live_at === null || gate.live_at === undefined) return;
    const r = await buildKeywordLexicon(customerId, env, {
      call: opts.call,
      timeouts: REQUEST_TIMEOUTS,
    });
    logResult(r);
  })().catch(() => {
    console.error("[rawuser/keywords] build failed");
  });
  if (typeof ctx?.waitUntil === "function") {
    ctx.waitUntil(job);
    return Promise.resolve();
  }
  return job;
}

function logResult(r: KeywordBuildResult): void {
  if (r.ok) {
    console.log(
      `[rawuser/keywords] built intents=${r.intents} phrases=${r.phrases} dropped_languages=${r.languages_dropped}`,
    );
  } else if (r.reason === "model_failed" || r.reason === "malformed" || r.reason === "no_model") {
    console.warn(`[rawuser/keywords] not built: ${r.reason}`);
  }
}

export interface KeywordSweepResult {
  built: number;
  empty: number;
  failed: number;
}

/**
 * The six-hour sweep: a live customer allowed a lexicon (condition 8) with
 * a brief, whose lexicon is missing, marked due (0) or older than the
 * brief. At most KEYWORD_SWEEP_MAX customers, one build each, oldest first;
 * a failed build is tried again on the next sweep.
 */
export async function runKeywordLexiconSweep(
  env: KeywordEnv,
  opts: { call?: KeywordModelCall; max?: number; now?: number } = {},
): Promise<KeywordSweepResult> {
  const out: KeywordSweepResult = { built: 0, empty: 0, failed: 0 };
  const due = await env.DB.prepare(
    `SELECT c.id AS id FROM customers c
       JOIN business_dna d ON d.customer_id = c.id
      WHERE c.live_at IS NOT NULL
        AND COALESCE(c.sensitive, 0) != 1
        AND c.special_category = 0
        AND c.keyword_off = 0
        AND (c.keyword_lexicon_at IS NULL OR c.keyword_lexicon_at < d.updated_at)
      ORDER BY COALESCE(c.keyword_lexicon_at, 0), c.id
      LIMIT ?`,
  )
    .bind(opts.max ?? KEYWORD_SWEEP_MAX)
    .all<{ id: string }>();
  for (const { id } of due.results ?? []) {
    try {
      const r = await buildKeywordLexicon(id, env, {
        call: opts.call,
        timeouts: SWEEP_TIMEOUTS,
        now: opts.now,
      });
      logResult(r);
      if (r.ok && r.kept) out.built++;
      else if (r.ok) out.empty++;
      else out.failed++;
    } catch {
      out.failed++;
    }
  }
  return out;
}
