/**
 * The visitor's own choice, for the dashboard (ADR 0038 part 2;
 * docs/specs/direct-visitors.md §2). Customer-scoped, a superadmin too,
 * except the kill switch (superadmin only):
 *
 *   GET  /admin/choice?customer_id            the state, the versions an answer may open, the counts
 *   POST /admin/choice                         { customer_id, on?, question?, answers?, approve_draft?, discard_draft? }
 *   POST /admin/choice/write                   { customer_id }  one model call, stored by the approval rule
 *   POST /admin/choice/preview-link            { customer_id }  a one-time link that shows the row on the
 *                                              customer's own home page, for whoever opens it, 15 minutes
 *   POST /admin/choice/kill                    { customer_id, killed }  superadmin only
 *
 * Every change rewrites the visitor bundle; visitors see it within
 * CHOICE_REACH_S (KV about 60 s, then the edge's copy, 300 s). One question
 * per language home (`path`: `/`, or `/az`); the switches are the
 * customer's, for every language at once.
 */

import {
  CHOICE_SLOTS,
  type ChoiceConfig,
  PICK_TTL_S,
  choiceAllowed,
  choiceClient,
  isLanguageHome,
  parseChoice,
  parseChoiceSet,
  pickTokenKey,
} from "@rawuser/shared";
import { siteOrigin } from "@rawuser/shared";
import {
  CHOICE_ROW_SQL,
  type ChoiceEnv,
  type ChoiceRow,
  choiceCounts,
  homeAnchor,
  homeCells,
  languageHomes,
  screenChoice,
  storeChoice,
  writeChoice,
} from "../lib/choice.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { writeVisitorBundle } from "./onboard.ts";
import { requireCustomerScope } from "./scope.ts";

/** How long a change takes to reach every visitor, at most: KV (60 s) and the edge's copy (300 s). */
export const CHOICE_REACH_S = 360;

interface Out {
  question: string;
  answers: Array<{ slot: string; label: string; intent_dim: string; source_dim: string }>;
}

function out(c: ChoiceConfig | null): Out | null {
  if (!c) return null;
  return {
    question: c.q,
    answers: c.a.map(([slot, label, intent, source]) => ({
      slot,
      label,
      intent_dim: intent,
      source_dim: source,
    })),
  };
}

async function state(env: AdminEnv, customerId: string, row: ChoiceRow, now: number, home = "/") {
  const homes = await languageHomes(env.DB, customerId);
  return {
    customer_id: customerId,
    on: Number(row.choice_on) === 1,
    killed: Number(row.choice_killed) === 1,
    allowed: choiceAllowed(row),
    // One question per language home; the card shows the one of `path`.
    path: home,
    homes: homes.map((h) => ({ ...h, has_question: !!parseChoiceSet(row.choice)[h.path] })),
    live: out(parseChoiceSet(row.choice)[home] ?? null),
    draft: out(parseChoiceSet(row.choice_draft)[home] ?? null),
    // The bar needs no main button (it borrows one's look when there is one).
    has_anchor: true,
    versions: (await homeCells(env as unknown as ChoiceEnv, customerId, home)).map((c) => ({
      intent_dim: c.intent,
      source_dim: c.source,
      headline: c.headline,
    })),
    counts: await choiceCounts(env.DB, customerId, now),
    reaches_visitors_within_s: CHOICE_REACH_S,
  };
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function handleChoice(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
  action: "" | "write" | "preview-link" | "kill",
  now = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const b = request.method === "POST" ? await body(request) : {};
  if (b === null) return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  const customerId =
    request.method === "POST"
      ? typeof b.customer_id === "string"
        ? b.customer_id
        : ""
      : (url.searchParams.get("customer_id") ?? "");
  if (action === "kill" && user.role !== "superadmin") {
    return jsonWithCors({ error: "superadmin only" }, env, 403);
  }
  const scope = requireCustomerScope(user, customerId || null);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const first = await env.DB.prepare(CHOICE_ROW_SQL).bind(customerId).first<ChoiceRow>();
  if (!first) return jsonWithCors({ error: "Customer not found" }, env, 404);
  let row: ChoiceRow = first;
  // The language home the call is about (`/`, or `/az`): a body's `path`, else the query's.
  const asked =
    request.method === "POST"
      ? typeof b.path === "string"
        ? b.path
        : "/"
      : (url.searchParams.get("path") ?? "/");
  const home = isLanguageHome(asked) ? asked : "/";
  const reread = async (): Promise<ChoiceRow> =>
    (await env.DB.prepare(CHOICE_ROW_SQL).bind(customerId).first<ChoiceRow>()) ?? row;

  if (request.method === "GET" && action === "") {
    return jsonWithCors(await state(env, customerId, row, now, home), env, 200);
  }
  if (request.method !== "POST") return jsonWithCors({ error: "POST" }, env, 405);

  if (action === "kill") {
    if (typeof b.killed !== "boolean")
      return jsonWithCors({ error: "killed must be true or false" }, env, 400);
    await env.DB.prepare("UPDATE customers SET choice_killed = ? WHERE id = ?")
      .bind(b.killed ? 1 : 0, customerId)
      .run();
    await writeVisitorBundle(env, customerId);
    return jsonWithCors(await state(env, customerId, await reread(), now, home), env, 200);
  }

  if (action === "write") {
    if (!choiceAllowed(row)) return jsonWithCors({ error: "Not for this site." }, env, 409);
    const r = await writeChoice(env as unknown as ChoiceEnv, customerId, undefined, home);
    if (!r.ok) return jsonWithCors({ error: r.error }, env, 422);
    return jsonWithCors(
      { ...(await state(env, customerId, await reread(), now, home)), written: r.state },
      env,
      200,
    );
  }

  if (action === "preview-link") {
    const c = parseChoiceSet(row.choice_draft)[home] ?? parseChoiceSet(row.choice)[home];
    if (!c) return jsonWithCors({ error: "There is no question yet." }, env, 409);
    const token = crypto.randomUUID().replace(/-/g, "");
    await env.VARIANTS.put(
      pickTokenKey(token),
      JSON.stringify({
        customer_id: customerId,
        page_path: home,
        manifest: {},
        mode: "choice",
        choice: choiceClient(c, true),
      }),
      { expirationTtl: PICK_TTL_S },
    );
    return jsonWithCors(
      {
        token,
        link: `${siteOrigin(row.domain ?? "")}${home}#rawuser_pick=${token}`,
        expires_in_s: PICK_TTL_S,
      },
      env,
      200,
    );
  }

  // POST /admin/choice: the customer's own edits are its approval.
  if (b.discard_draft === true) {
    const drafts = parseChoiceSet(row.choice_draft);
    delete drafts[home];
    await env.DB.prepare("UPDATE customers SET choice_draft = ? WHERE id = ?")
      .bind(Object.keys(drafts).length > 0 ? JSON.stringify(drafts) : null, customerId)
      .run();
    row = await reread();
  }
  if (b.approve_draft === true) {
    const draft = parseChoiceSet(row.choice_draft)[home];
    if (!draft) return jsonWithCors({ error: "Nothing waits." }, env, 404);
    await storeChoice(env, customerId, row, draft, true, home);
    row = await reread();
  }
  if (b.question !== undefined || b.answers !== undefined) {
    const base = parseChoiceSet(row.choice)[home] ?? parseChoiceSet(row.choice_draft)[home];
    const anchor = base?.s ?? (await homeAnchor(env.DB, customerId, home)) ?? [];
    const answers = Array.isArray(b.answers)
      ? (b.answers as Array<Record<string, unknown>>).map((a, i) => [
          CHOICE_SLOTS[i],
          a?.label,
          a?.intent_dim,
          a?.source_dim,
        ])
      : base?.a;
    const cells = new Set(
      (await homeCells(env as unknown as ChoiceEnv, customerId, home)).map(
        (c) => `${c.intent}:${c.source}`,
      ),
    );
    const parsed = parseChoice({ q: b.question ?? base?.q, a: answers, s: anchor });
    const screened = screenChoice(parsed);
    if (!screened.ok) return jsonWithCors({ error: screened.error }, env, 400);
    const missing = screened.c.a.find(([, , i, s]) => !cells.has(`${i}:${s}`));
    if (missing)
      return jsonWithCors(
        { error: `"${missing[1]}" points to a version this page does not have.` },
        env,
        400,
      );
    await storeChoice(env, customerId, row, screened.c, true, home);
    row = await reread();
  }
  if (b.on !== undefined) {
    if (typeof b.on !== "boolean")
      return jsonWithCors({ error: "on must be true or false" }, env, 400);
    if (b.on && Object.keys(parseChoiceSet(row.choice)).length === 0)
      return jsonWithCors({ error: "There is no question yet." }, env, 409);
    if (b.on && !choiceAllowed(row)) return jsonWithCors({ error: "Not for this site." }, env, 409);
    await env.DB.prepare("UPDATE customers SET choice_on = ? WHERE id = ?")
      .bind(b.on ? 1 : 0, customerId)
      .run();
    await writeVisitorBundle(env, customerId);
    row = await reread();
  }
  return jsonWithCors(await state(env, customerId, row, now, home), env, 200);
}
