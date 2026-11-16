/**
 * The visitor's own choice in generation (ADR 0038 part 2;
 * docs/specs/direct-visitors.md §2): the question and its answers written
 * from the customer's brief, each pointing to an existing version of the
 * home page (no new version is written), screened, and stored by the
 * approval rule: the first question is the live one (still off until the
 * customer turns it on after the preview), a later one waits as a draft for
 * the customer's OK unless `auto_approve` is on. And the card's counts.
 *
 * Nothing about a visitor goes to the model: the brief, the versions'
 * headlines and the page's own button.
 */

import {
  CHOICE_DEFAULT,
  CHOICE_LABEL_MAX,
  CHOICE_QUESTION_MAX,
  CHOICE_SLOTS,
  type ChoiceConfig,
  type ChoiceSet,
  choiceAnchor,
  isLanguageHome,
  parseChoice,
  parseChoiceSet,
  refusesSpecialCategory,
  textHasPrice,
  variantKeyParts,
} from "@rawuser/shared";
import { jsonrepair } from "jsonrepair";
import { writeVisitorBundle } from "../admin/onboard.ts";
import { type CallEnv, callModel } from "../call-model.ts";
import type { GenerateInput, GenerateResult } from "../generateVariant.ts";
import { sanitizeString } from "../sanitize.ts";

export interface ChoiceEnv extends CallEnv {
  DB: D1Database;
  VARIANTS: KVNamespace;
}

/** The customer's question state, as the endpoints and the bundle read it. */
export interface ChoiceRow {
  choice_on: number | null;
  choice_killed: number | null;
  choice: string | null;
  choice_draft: string | null;
  auto_approve: number | null;
  special_category: number | null;
  sensitive: number | null;
  plan: string | null;
  domain: string | null;
}

export const CHOICE_ROW_SQL =
  "SELECT choice_on, choice_killed, choice, choice_draft, auto_approve, special_category, sensitive, plan, domain FROM customers WHERE id = ?";

/** A version of the home page an answer may point to: its cell and its headline. */
export interface HomeCell {
  intent: string;
  source: string;
  headline: string;
}

/** The live versions of a language home (base and source versions, never a market's), with their headlines. */
export async function homeCells(
  env: ChoiceEnv,
  customerId: string,
  home = "/",
): Promise<HomeCell[]> {
  const rows = await env.DB.prepare(
    "SELECT kv_key FROM variants WHERE customer_id = ? AND body_id IS NOT NULL ORDER BY kv_key",
  )
    .bind(customerId)
    .all<{ kv_key: string }>();
  const out: HomeCell[] = [];
  for (const { kv_key } of rows.results ?? []) {
    const p = variantKeyParts(kv_key);
    if (!p || p.pagePath !== home || p.sourceDim.startsWith("mk-") || p.sourceDim === "direct")
      continue;
    const body = (await env.VARIANTS.get(kv_key, "json").catch(() => null)) as {
      sections?: { hero?: { headline?: unknown } };
    } | null;
    const h = body?.sections?.hero?.headline;
    out.push({
      intent: p.intentDim,
      source: p.sourceDim,
      headline: typeof h === "string" ? h.replace(/\*/g, "").slice(0, 120) : "",
    });
  }
  // Base versions first: an answer is best served by its intent's own version.
  return out.sort((a, b) => Number(b.source === "default") - Number(a.source === "default"));
}

/** The hero's main button of the home page, from its confirmed manifest. */
export async function homeAnchor(
  db: D1Database,
  customerId: string,
  home = "/",
): Promise<string[] | null> {
  const row = await db
    .prepare(
      "SELECT manifest FROM element_manifests WHERE customer_id = ? AND page_path = ? AND confirmed_at IS NOT NULL",
    )
    .bind(customerId, home)
    .first<{ manifest: string }>();
  try {
    return choiceAnchor(row ? JSON.parse(row.manifest) : null);
  } catch {
    return null;
  }
}

/** Why a question or an answer may not be shown, or null. */
export function choiceTextRefusal(text: string): string | null {
  if (refusesSpecialCategory(text))
    return "It touches health, religion, politics or another special category.";
  if (textHasPrice(text))
    return "It names a price. An answer never changes a price, an offer or who may buy.";
  return null;
}

/** Screens a whole question: every text, then the shape. */
export function screenChoice(
  c: ChoiceConfig | null,
): { ok: true; c: ChoiceConfig } | { ok: false; error: string } {
  if (!c)
    return { ok: false, error: "A question, 2 to 4 answers and a version for each are required." };
  for (const t of [c.q, ...c.a.map((a) => a[1])]) {
    const why = choiceTextRefusal(t);
    if (why) return { ok: false, error: `"${t}": ${why}` };
  }
  return { ok: true, c };
}

function prompt(brief: Record<string, unknown>, cells: HomeCell[], language: string): string {
  const list = cells
    .slice(0, 14)
    .map((c) => `- ${c.intent}:${c.source}  "${c.headline}"`)
    .join("\n");
  return `Write one optional question for the home page of this business and ${CHOICE_DEFAULT} short answers a visitor can tap.

The business, in its own words:
${JSON.stringify(brief)}

Rules:
- Language: ${language}. Plain words, no dashes, no emoji, no exclamation marks.
- The question asks why the visitor came, at most ${CHOICE_QUESTION_MAX} characters, for example "What brings you here?".
- Each answer is the visitor speaking about their role or their task, at most ${CHOICE_LABEL_MAX} characters, for example "I'm a broker", "I run a PE fund", "I'm selling my company". Take the roles and tasks from the brief; invent none.
- Never about health, religion, politics, sexuality, union membership, ethnicity or money trouble. Never a price, an offer, a discount, or who may buy.
- Each answer points to one of these existing versions of the page (its headline in quotes); pick the one whose headline suits that visitor best, each version at most once:
${list}

Return JSON only: {"question": "...", "answers": [{"label": "...", "version": "intent:source"}]}`;
}

export interface WriteChoiceResult {
  ok: boolean;
  /** Where it went: the live question, or the draft that waits. */
  state?: "live" | "draft";
  error?: string;
  cost_usd?: number;
}

/** A language home of the customer: `/` in the brief's language, and each confirmed `/az`-style page in its own. */
export interface LanguageHome {
  path: string;
  lang: string;
}

/** The customer's language homes, `/` first (docs/specs/direct-visitors.md §2, "A question per language"). */
export async function languageHomes(db: D1Database, customerId: string): Promise<LanguageHome[]> {
  const dna = await db
    .prepare("SELECT target_language FROM business_dna WHERE customer_id = ?")
    .bind(customerId)
    .first<{ target_language: string | null }>();
  const primary = (dna?.target_language ?? "").trim().slice(0, 2).toLowerCase() || "en";
  const rows = await db
    .prepare(
      "SELECT page_path, language FROM element_manifests WHERE customer_id = ? AND confirmed_at IS NOT NULL ORDER BY page_path",
    )
    .bind(customerId)
    .all<{ page_path: string; language: string | null }>();
  const out: LanguageHome[] = [{ path: "/", lang: primary }];
  for (const r of rows.results ?? []) {
    const lang = (r.language ?? "").trim().slice(0, 2).toLowerCase();
    if (r.page_path !== "/" && isLanguageHome(r.page_path) && lang && lang !== primary)
      out.push({ path: r.page_path, lang });
  }
  return out;
}

/** The brief in a language: its own translation when the site has one, else the primary brief. */
async function briefIn(
  db: D1Database,
  customerId: string,
  lang: string,
): Promise<Record<string, unknown> | null> {
  const cols = "product, icp, value_props, target_market";
  const own = await db
    .prepare(`SELECT ${cols} FROM business_dna_i18n WHERE customer_id = ? AND language = ?`)
    .bind(customerId, lang)
    .first<Record<string, unknown>>()
    .catch(() => null);
  if (own) return own;
  return db
    .prepare(`SELECT ${cols}, per_intent_hints FROM business_dna WHERE customer_id = ?`)
    .bind(customerId)
    .first<Record<string, unknown>>();
}

/** Why a model's question is not one, in words the model can act on; null when it is. */
function whyNot(q: string, a: unknown[][]): string | null {
  if (!q) return "The question is missing.";
  if (q.length > CHOICE_QUESTION_MAX)
    return `The question has ${q.length} characters; write it in at most ${CHOICE_QUESTION_MAX}.`;
  const long = a.find((x) => String(x[1]).length > CHOICE_LABEL_MAX);
  if (long)
    return `The answer "${long[1]}" has ${String(long[1]).length} characters; every answer at most ${CHOICE_LABEL_MAX}.`;
  if (a.length < 2)
    return "Fewer than two answers point to a version from the list; use the list's exact intent:source.";
  return null;
}

/**
 * Writes the question of one language home with one model call (and one
 * more, told what was wrong, when the first is not a question), and stores
 * it by the approval rule. `call` is injectable for tests.
 */
export async function writeChoice(
  env: ChoiceEnv,
  customerId: string,
  call: (
    input: GenerateInput,
    env: CallEnv,
  ) => Promise<{ ok: true; value: GenerateResult } | { ok: false; error: string }> = callModel,
  home = "/",
): Promise<WriteChoiceResult> {
  const row = await env.DB.prepare(CHOICE_ROW_SQL).bind(customerId).first<ChoiceRow>();
  if (!row) return { ok: false, error: "Customer not found" };
  const where = (await languageHomes(env.DB, customerId)).find((h) => h.path === home);
  if (!where) return { ok: false, error: "That page is not a language home of this site." };
  // The bar borrows the main button's look when the page has one confirmed.
  const anchor = (await homeAnchor(env.DB, customerId, home)) ?? [];
  const cells = await homeCells(env, customerId, home);
  if (cells.length < 2) return { ok: false, error: "The page needs at least two live versions." };
  const brief = await briefIn(env.DB, customerId, where.lang);
  if (!brief) return { ok: false, error: "The brief is missing." };
  const known = new Set(cells.map((c) => `${c.intent}:${c.source}`));
  let cost = 0;
  let note = "";
  let error = "A question, 2 to 4 answers and a version for each are required.";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await call(
      {
        prompt: prompt(brief, cells, where.lang) + note,
        role: "read",
        maxTokens: 600,
        jsonMode: true,
      },
      env,
    );
    if (!res.ok) return { ok: false, error: res.error, cost_usd: cost };
    cost += res.value.costUsd;
    let parsed: { question?: unknown; answers?: unknown };
    try {
      parsed = JSON.parse(jsonrepair(res.value.text)) as typeof parsed;
    } catch {
      error = "The model's answer could not be read.";
      note = "\n\nYour last answer was not valid JSON. Return JSON only.";
      continue;
    }
    const answers = Array.isArray(parsed.answers) ? parsed.answers : [];
    const a = answers
      .map((x) => x as { label?: unknown; version?: unknown })
      .filter((x) => typeof x.version === "string" && known.has(x.version))
      .slice(0, 4)
      .map((x, i) => {
        const [intent, source] = String(x.version).split(":");
        return [CHOICE_SLOTS[i], sanitizeString(String(x.label ?? "")).trim(), intent, source];
      });
    const q = sanitizeString(String(parsed.question ?? "")).trim();
    const screened = screenChoice(parseChoice({ q, a, s: anchor }));
    if (screened.ok) {
      const state = await storeChoice(env, customerId, row, screened.c, false, home);
      return { ok: true, state, cost_usd: cost };
    }
    error = whyNot(q, a) ?? screened.error;
    note = `\n\nYour last answer was refused: ${error} Write it again.`;
  }
  return { ok: false, error, cost_usd: cost };
}

/**
 * The approval rule for a question (docs/specs/versions-approval.md): the
 * customer's own edit, the first question, or `auto_approve` go live; a
 * later model question waits as the draft. The bundle is rewritten either
 * way (a live change reaches visitors within the bundle's minutes).
 */
export async function storeChoice(
  env: Pick<ChoiceEnv, "DB" | "VARIANTS">,
  customerId: string,
  row: Pick<ChoiceRow, "choice" | "choice_draft" | "auto_approve">,
  c: ChoiceConfig,
  byCustomer: boolean,
  home = "/",
): Promise<"live" | "draft"> {
  // One question per language home, kept together in the same two columns.
  const liveSet = parseChoiceSet(row.choice);
  const draftSet = parseChoiceSet(row.choice_draft);
  const live = byCustomer || !liveSet[home] || Number(row.auto_approve) === 1;
  if (live) {
    liveSet[home] = c;
    delete draftSet[home];
  } else draftSet[home] = c;
  const text = (set: ChoiceSet) => (Object.keys(set).length > 0 ? JSON.stringify(set) : null);
  await env.DB.prepare("UPDATE customers SET choice = ?, choice_draft = ? WHERE id = ?")
    .bind(text(liveSet), text(draftSet), customerId)
    .run();
  await writeVisitorBundle(env, customerId);
  return live ? "live" : "draft";
}

// ---------------------------------------------------------------------------
// The card's counts (§2): counts only, over closed days, inside one customer
// ---------------------------------------------------------------------------

export interface ChoiceCounts {
  days: number;
  /** Visits that were shown the question. */
  shown: number;
  /** Loads where it was not shown, by the fixed reason (`covered`: the hero row's, before the bar). */
  skipped: { fit: number; anchor: number; covered: number };
  /** Visits that closed the bar without an answer. */
  closed: number;
  /** Visits that tapped each answer (slot a to d). */
  answered: Record<string, number>;
  /** Visits that came back with each answer remembered by their browser (ADR 0039). */
  returned: Record<string, number>;
  /** Visitors by their own code (ADR 0039): that answered, and that came back at least once. */
  people: { answered: number; returned: number };
  /** Visits shown the question that clicked a counted button, and of those, by answer. */
  clicked: number;
  clicked_by_answer: Record<string, number>;
}

/**
 * From the `choice` rows and `nd: "c:{slot}"` exposures over the window, by
 * visit inside the one customer (the marker counts visits and attributes a
 * visit's clicks, counts only; the privacy rules). No row leaves.
 */
export async function choiceCounts(
  db: D1Database,
  customerId: string,
  now: number,
  days = 30,
): Promise<ChoiceCounts> {
  const since = now - days * 86_400_000;
  const words = await db
    .prepare(
      `SELECT json_extract(properties, '$.ch') AS ch,
              COUNT(DISTINCT COALESCE(visit, id)) AS visits, COUNT(*) AS loads
         FROM events WHERE customer_id = ?1 AND ts >= ?2 AND event_type = 'choice'
        GROUP BY ch`,
    )
    .bind(customerId, since)
    .all<{ ch: string | null; visits: number; loads: number }>();
  const out: ChoiceCounts = {
    days,
    shown: 0,
    skipped: { fit: 0, anchor: 0, covered: 0 },
    closed: 0,
    answered: {},
    returned: {},
    people: { answered: 0, returned: 0 },
    clicked: 0,
    clicked_by_answer: {},
  };
  for (const r of words.results ?? []) {
    if (r.ch === "shown") out.shown = Number(r.visits) || 0;
    else if (r.ch === "closed") out.closed = Number(r.visits) || 0;
    else if (r.ch === "fit" || r.ch === "anchor" || r.ch === "covered")
      out.skipped[r.ch] = Number(r.loads) || 0;
  }
  const answered = await db
    .prepare(
      `SELECT substr(json_extract(properties, '$.nd'), 3, 1) AS slot, COUNT(DISTINCT visit) AS visits
         FROM events WHERE customer_id = ?1 AND ts >= ?2 AND visit IS NOT NULL
          AND event_type IN ('variant_shown', 'personalization_skipped')
          AND json_extract(properties, '$.nd') LIKE 'c:%'
        GROUP BY slot`,
    )
    .bind(customerId, since)
    .all<{ slot: string; visits: number }>();
  for (const r of answered.results ?? []) {
    if (/^[a-d]$/.test(r.slot)) out.answered[r.slot] = Number(r.visits) || 0;
  }
  const returned = await db
    .prepare(
      `SELECT substr(json_extract(properties, '$.nd'), 3, 1) AS slot, COUNT(DISTINCT visit) AS visits
         FROM events WHERE customer_id = ?1 AND ts >= ?2 AND visit IS NOT NULL
          AND event_type IN ('variant_shown', 'personalization_skipped')
          AND json_extract(properties, '$.nd') LIKE 'r:%'
        GROUP BY slot`,
    )
    .bind(customerId, since)
    .all<{ slot: string; visits: number }>();
  for (const r of returned.results ?? []) {
    if (/^[a-d]$/.test(r.slot)) out.returned[r.slot] = Number(r.visits) || 0;
  }
  const people = await db
    .prepare(
      `SELECT json_extract(properties, '$.ch') AS ch, COUNT(DISTINCT json_extract(properties, '$.pid')) AS n
         FROM events WHERE customer_id = ?1 AND ts >= ?2 AND event_type = 'choice'
          AND (json_extract(properties, '$.ch') = 'answered'
               OR (json_extract(properties, '$.ch') = 'returned' AND json_extract(properties, '$.qa') IS NOT NULL))
          AND json_extract(properties, '$.pid') IS NOT NULL
        GROUP BY ch`,
    )
    .bind(customerId, since)
    .all<{ ch: string; n: number }>();
  for (const r of people.results ?? []) {
    if (r.ch === "answered" || r.ch === "returned") out.people[r.ch] = Number(r.n) || 0;
  }
  const clicked = await db
    .prepare(
      `WITH shown AS (
         SELECT DISTINCT visit FROM events WHERE customer_id = ?1 AND ts >= ?2
            AND event_type = 'choice' AND json_extract(properties, '$.ch') = 'shown' AND visit IS NOT NULL),
       chose AS (
         SELECT visit, MIN(substr(json_extract(properties, '$.nd'), 3, 1)) AS slot FROM events
          WHERE customer_id = ?1 AND ts >= ?2 AND visit IS NOT NULL
            AND json_extract(properties, '$.nd') LIKE 'c:%' GROUP BY visit),
       conv AS (
         SELECT DISTINCT visit FROM events WHERE customer_id = ?1 AND ts >= ?2
            AND event_type = 'conversion' AND visit IS NOT NULL)
       SELECT chose.slot AS slot, COUNT(*) AS visits
         FROM shown JOIN conv ON conv.visit = shown.visit
         LEFT JOIN chose ON chose.visit = shown.visit
        GROUP BY chose.slot`,
    )
    .bind(customerId, since)
    .all<{ slot: string | null; visits: number }>();
  for (const r of clicked.results ?? []) {
    const n = Number(r.visits) || 0;
    out.clicked += n;
    if (r.slot && /^[a-d]$/.test(r.slot)) out.clicked_by_answer[r.slot] = n;
  }
  return out;
}
