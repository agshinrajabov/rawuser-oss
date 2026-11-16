/**
 * One model call for the links the rules leave (docs/specs/site-shaped-intents.md
 * §4.5, privacy review condition 3): up to 40 `{path, text, lang}` from the
 * screened set and the brief's one-line product description, nothing else
 * from the page; a closed kind back. Through `callModel`, so the configured
 * model, its outage tiers and the per-customer model spec apply.
 * The model is asked for the kind of page, never for a topic. A failed call
 * is not fatal: those paths stay unmapped and the global table applies.
 */

import { SITE_KINDS, SITE_MODEL_MAX, type SiteKindOrNone, isSiteKindOrNone } from "@rawuser/shared";
import { jsonrepair } from "jsonrepair";
import { type CallEnv, type CallTimeouts, callModel } from "../call-model.ts";
import type { GenerateInput, GenerateResult } from "../generateVariant.ts";
import type { ReadLink } from "./read-links.ts";

/** The read happens while the operator waits on Look: short, like the brief suggestions. */
export const SITE_MODEL_TIMEOUTS: CallTimeouts = { firstMs: 15_000, fallbackMs: 25_000 };

/** The call, injectable for tests. */
export type SiteModelCall = (
  input: GenerateInput,
  env: CallEnv,
  timeouts?: CallTimeouts,
) => Promise<{ ok: true; value: GenerateResult } | { ok: false; error: string }>;

const PREAMBLE = `You sort a website's own menu links into kinds of page.

Kinds (use exactly these words):
- price: prices, plans, packages, what it costs
- vs: one page comparing this product with one named rival
- compare: comparing options, alternatives, reviews
- proof: work samples, case studies, customers, portfolio
- features: what the product or service does, product and service pages
- docs: documentation, API, developer pages
- how: how it works, the approach, why, solutions, use cases
- learn: blog, articles, research, reports, indexes, guides
- start: contact, demo, sign up, get started
- about: about the company, team, studio
- none: anything else

Judge only what kind of page each link opens, from its path and its words.
Never describe or classify the subject a page is about.

Answer with one JSON object: {"kinds": {"<path>": "<kind>"}}, one entry for
every path you were given, and nothing else.`;

/** The request the model receives: the screened links and one product line. */
export function buildSiteModelPrompt(links: readonly ReadLink[], product: string): string {
  const payload = links.slice(0, SITE_MODEL_MAX).map((l) => ({
    path: l.path,
    text: l.text,
    lang: l.lang ?? "",
  }));
  const line = product.replace(/\s+/g, " ").trim().slice(0, 200);
  return `The business, in one line: ${line || "(not given)"}\n\nLinks:\n${JSON.stringify(payload)}\n\nReturn the JSON object.`;
}

/** The kinds from a model answer: only the paths asked, only the closed list; anything else is none. */
export function parseSiteModelAnswer(
  text: string,
  asked: readonly string[],
): Map<string, SiteKindOrNone> {
  const out = new Map<string, SiteKindOrNone>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonrepair(text));
  } catch {
    return out;
  }
  const kinds =
    parsed && typeof parsed === "object" && "kinds" in parsed
      ? (parsed as { kinds: unknown }).kinds
      : parsed;
  if (!kinds || typeof kinds !== "object") return out;
  const map = kinds as Record<string, unknown>;
  for (const path of asked) {
    const v = typeof map[path] === "string" ? (map[path] as string).trim().toLowerCase() : "";
    out.set(path, isSiteKindOrNone(v) ? v : "none");
  }
  return out;
}

/**
 * The model's kinds for the links the rules left; an empty map when the
 * call fails (the paths then stay unmapped). Never more than one call.
 */
export async function mapLinksWithModel(
  links: readonly ReadLink[],
  product: string,
  env: CallEnv,
  call: SiteModelCall = callModel,
): Promise<{ kinds: Map<string, SiteKindOrNone>; costUsd: number }> {
  const asked = links.slice(0, SITE_MODEL_MAX);
  if (asked.length === 0) return { kinds: new Map(), costUsd: 0 };
  const result = await call(
    {
      prompt: buildSiteModelPrompt(asked, product),
      cachedPreamble: PREAMBLE,
      role: "read",
      maxTokens: 1200,
      jsonMode: true,
    },
    env,
    SITE_MODEL_TIMEOUTS,
  );
  if (!result.ok) return { kinds: new Map(), costUsd: 0 };
  return {
    kinds: parseSiteModelAnswer(
      result.value.text,
      asked.map((l) => l.path),
    ),
    costUsd: result.value.costUsd ?? 0,
  };
}

/** For tests: the closed list the prompt names. */
export const SITE_MODEL_KINDS: readonly string[] = [...SITE_KINDS, "none"];
