/**
 * The keyword lexicon on real SQL (docs/specs/keyword-intent.md §4; the
 * the privacy review's conditions 7 to 10 of section 10):
 * - the model's input holds the product, audience, differentiators, named
 *   competitors, languages and served intents, never proof points, a
 *   testimonial, captured page text or anything from a visitor;
 * - a sensitive, special-category or off customer gets no call, no lexicon
 *   and no `kl`; marking a customer sensitive clears both;
 * - a malformed or failed answer stores nothing; the screen refuses a
 *   special-category phrase; a language the table does not cover is
 *   screened by a second call, and left out when that call fails;
 * - the triggers (a brief saved, the served set changed, go live's helper),
 *   the six-hour sweep and the off switch.
 *
 * `refusesSpecialCategory` is stubbed here with a small fixed list so the
 * tests do not depend on the shared table's contents (its own tests cover it).
 */
import { visitorBundleKey } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "../model-env.ts";
import { type Harness, harness } from "../proof-harness.ts";

vi.mock("@rawuser/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    refusesSpecialCategory: (phrase: string) =>
      /\b(diabetes|church|diabetiker|kirche)\b/.test(phrase),
  };
});

type User = { id: string; email: string; role: string; customer_id: string | null };
const SAM: User = { id: "u2", email: "sam@acme.test", role: "customer", customer_id: "acme" };
const FOUNDER: User = { id: "u1", email: "f@example.com", role: "superadmin", customer_id: null };
let sessionUser: User = SAM;

vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionUser),
}));
vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(),
  regenerateOne: vi.fn(),
}));

/** What the route-level model call answers; the unit tests inject their own. */
type Answer = { ok: true; text: string } | { ok: false; error: string };
let routeAnswers: Answer[] = [];
const routeCalls: Array<{ prompt: string; cachedPreamble?: string }> = [];
vi.mock("../../src/call-model.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/call-model.ts")>();
  return {
    ...actual,
    callModel: vi.fn(async (input: { prompt: string; cachedPreamble?: string }) => {
      routeCalls.push(input);
      const a = routeAnswers.shift() ?? { ok: false, error: "no answer queued" };
      return a.ok ? { ok: true, value: result(a.text) } : a;
    }),
  };
});

const { default: worker } = await import("../../src/index.ts");
const {
  buildKeywordLexicon,
  buildKeywordPrompt,
  loadKeywordInput,
  parseKeywordAnswer,
  runKeywordLexiconSweep,
  LEXICON_PREAMBLE,
  PHRASES_PER_LANGUAGE,
} = await import("../../src/keywords/lexicon.ts");
const { recomputeServed } = await import("../../src/site-map/store.ts");

function result(text: string) {
  return {
    text,
    model: "model-a" as const,
    costUsd: 0.0004,
    promptHash: "h",
    cacheHit: false,
    cacheReadTokens: 0,
  };
}

type CallInput = { prompt: string; cachedPreamble?: string; role?: string; jsonMode?: boolean };
function scripted(answers: Answer[]) {
  const calls: CallInput[] = [];
  const call = vi.fn(async (input: CallInput) => {
    calls.push(input);
    const a = answers.shift() ?? { ok: false as const, error: "no answer queued" };
    return a.ok ? { ok: true as const, value: result(a.text) } : a;
  });
  return { call: call as never, calls };
}

let h: Harness;
let waits: Promise<unknown>[] = [];
let env: Harness["env"] & typeof MODEL_ENV;

/** A live customer with a brief that holds every field, the forbidden ones marked. */
function liveCustomer(
  id: string,
  extra: { special_category?: 0 | 1 | null; sensitive?: 0 | 1; off?: 0 | 1; lang?: string } = {},
) {
  h.customer(id, {
    special_category: "special_category" in extra ? (extra.special_category ?? null) : 0,
  });
  h.db
    .prepare("UPDATE customers SET live_at = ?, sensitive = ?, keyword_off = ? WHERE id = ?")
    .run(1000, extra.sensitive ?? 0, extra.off ?? 0, id);
  h.db
    .prepare(
      `INSERT INTO business_dna (customer_id, product, icp, brand_voice, value_props,
         differentiators, proof_points, target_market, target_language, per_intent_hints, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      "A CRM for small agencies",
      "Agency owners with five to twenty people",
      "warm, direct",
      JSON.stringify(["VALUEPROP-SECRET one view of every client"]),
      JSON.stringify(["Built for retainers", "Client portal included"]),
      JSON.stringify([
        "PROOFPOINT-SECRET 400 agencies",
        "TESTIMONIAL-SECRET 'Best tool ever' says Jane",
      ]),
      "Agencies in Europe",
      extra.lang ?? "en",
      JSON.stringify({ competitor: "HubSpot and Pipedrive", pricing: "HINT-SECRET pricing note" }),
      2000,
    );
}

const GOOD = JSON.stringify({
  en: {
    pricing: ["CRM Pricing", "free crm", "cost"],
    competitor: ["hubspot alternative", "pipedrive", "vs"],
    evaluation: ["best crm for agencies", "review"],
    feature: ["api", "zapier integration", "diabetes tracker"],
    problem: ["how to track leads", "lost clients"],
    brand: ["acme"],
  },
});

function stored(id: string) {
  return h.db
    .prepare("SELECT keyword_lexicon, keyword_lexicon_at, keyword_off FROM customers WHERE id = ?")
    .get(id) as {
    keyword_lexicon: string | null;
    keyword_lexicon_at: number | null;
    keyword_off: number;
  };
}

function bundle(id: string): Record<string, unknown> | null {
  const raw = h.kv.get(visitorBundleKey(id));
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

async function call(
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`https://api.example.com${path}`, {
      method: "POST",
      headers: { "x-rawuser-admin": "session", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env as never,
    {
      waitUntil: (p: Promise<unknown>) => {
        waits.push(p);
      },
      passThroughOnException: () => {},
    } as never,
  );
  await Promise.all(waits);
  waits = [];
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  h = harness();
  env = { ...h.env, ...MODEL_ENV };
  sessionUser = SAM;
  routeAnswers = [];
  routeCalls.length = 0;
  waits = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the model's input (condition 9)", () => {
  it("holds the product, audience, differentiators, named competitors, languages and served intents, and nothing else", async () => {
    liveCustomer("acme");
    // A capture of the customer's page and a visitor's event sit in the stores.
    h.kv.set("capture:acme:/", "<h1>CAPTURED-SECRET page text</h1>");
    h.ev({ customer: "acme", ts: 5, type: "variant_shown", page: "/visitor-secret" });
    const { call: model, calls } = scripted([{ ok: true, text: GOOD }]);
    const r = await buildKeywordLexicon("acme", env, { call: model });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const sent = `${calls[0]?.cachedPreamble}\n${calls[0]?.prompt}`;
    expect(calls[0]?.jsonMode).toBe(true);
    expect(calls[0]?.cachedPreamble).toBe(LEXICON_PREAMBLE);
    for (const word of [
      "A CRM for small agencies",
      "Agency owners",
      "Agencies in Europe",
      "Built for retainers",
      "HubSpot and Pipedrive",
    ]) {
      expect(sent).toContain(word);
    }
    expect(sent).toContain("Languages: en");
    for (const forbidden of [
      "PROOFPOINT-SECRET",
      "TESTIMONIAL-SECRET",
      "VALUEPROP-SECRET",
      "HINT-SECRET",
      "CAPTURED-SECRET",
      "visitor-secret",
      "warm, direct",
    ]) {
      expect(sent).not.toContain(forbidden);
    }
    // brand is never an intent the model is asked for.
    expect(calls[0]?.prompt).not.toMatch(/- brand/);
  });

  it("asks only for the served intents, and names no competitors when competitor is not served", async () => {
    liveCustomer("acme");
    h.db
      .prepare("UPDATE customers SET served_intents = ? WHERE id = 'acme'")
      .run(JSON.stringify(["problem", "feature", "evaluation", "brand"]));
    const input = await loadKeywordInput(h.d1, "acme");
    if (typeof input === "string") throw new Error(input);
    expect([...input.intents].sort()).toEqual(["evaluation", "feature", "problem"]);
    expect(input.competitors).toBe("");
    const prompt = buildKeywordPrompt(input);
    expect(prompt).not.toContain("HubSpot");
    expect(prompt).not.toMatch(/- pricing|- competitor/);
  });

  it("takes the site's languages from the brief and the confirmed pages, the brief's first, at most three", async () => {
    liveCustomer("acme", { lang: "az-AZ" });
    const insert = h.db.prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('acme', ?, '{}', 'https://acme.test', 1, ?, ?)",
    );
    insert.run("/", 1, "az");
    insert.run("/en", 1, "en");
    insert.run("/ru", 1, "ru");
    insert.run("/de", 1, "de");
    insert.run("/tr", null, "tr");
    const input = await loadKeywordInput(h.d1, "acme");
    if (typeof input === "string") throw new Error(input);
    expect(input.languages[0]).toBe("az");
    expect(input.languages).toHaveLength(3);
    expect(input.languages).not.toContain("tr");
  });
});

describe("buildKeywordLexicon", () => {
  it("validates, screens and stores the lexicon, then writes `kl` into the bundle", async () => {
    liveCustomer("acme");
    const { call: model } = scripted([{ ok: true, text: GOOD }]);
    const r = await buildKeywordLexicon("acme", env, { call: model, now: 7777 });
    expect(r).toMatchObject({ ok: true, kept: true, intents: 5 });
    const row = stored("acme");
    expect(row.keyword_lexicon_at).toBe(7777);
    const lexicon = JSON.parse(row.keyword_lexicon ?? "null");
    expect(lexicon.pricing).toEqual(["crm pricing", "free crm", "cost"]);
    expect(lexicon.feature).toEqual(["api", "zapier integration"]);
    expect(lexicon.brand).toBeUndefined();
    expect(JSON.stringify(lexicon)).not.toContain("diabetes");
    expect(bundle("acme")?.kl).toEqual(lexicon);
  });

  it("keeps at most 40 phrases per intent per language", async () => {
    liveCustomer("acme");
    const many = Array.from(
      { length: 60 },
      (_, i) => `crm plan ${String.fromCharCode(97 + (i % 26))}${i}`,
    );
    const { call: model } = scripted([
      { ok: true, text: JSON.stringify({ en: { pricing: many } }) },
    ]);
    await buildKeywordLexicon("acme", env, { call: model });
    const lexicon = JSON.parse(stored("acme").keyword_lexicon ?? "null");
    expect(lexicon.pricing).toHaveLength(PHRASES_PER_LANGUAGE);
  });

  it.each([
    ["sensitive", { sensitive: 1 as const }],
    ["special_category", { special_category: 1 as const }],
    ["special_category", { special_category: null }],
    ["off", { off: 1 as const }],
  ])("a %s customer gets no call, no lexicon and no `kl`", async (reason, extra) => {
    liveCustomer("acme", extra);
    const { call: model, calls } = scripted([{ ok: true, text: GOOD }]);
    const r = await buildKeywordLexicon("acme", env, { call: model });
    expect(r).toEqual({ ok: false, reason });
    expect(calls).toHaveLength(0);
    expect(stored("acme").keyword_lexicon).toBeNull();
    expect(stored("acme").keyword_lexicon_at).toBeNull();
    expect(bundle("acme")).toBeNull();
  });

  it("a stored lexicon never reaches the bundle of a sensitive, special-category or off customer", async () => {
    for (const [id, extra] of [
      ["s1", { sensitive: 1 as const }],
      ["s2", { special_category: 1 as const }],
      ["s3", { off: 1 as const }],
    ] as const) {
      liveCustomer(id, extra);
      h.db
        .prepare("UPDATE customers SET keyword_lexicon = ?, keyword_lexicon_at = 1 WHERE id = ?")
        .run(JSON.stringify({ pricing: ["crm pricing"] }), id);
      const { writeVisitorBundle } = await import("../../src/admin/onboard.ts");
      await writeVisitorBundle(env, id);
      expect(bundle(id)).not.toBeNull();
      expect(bundle(id)?.kl).toBeUndefined();
    }
  });

  it.each([
    ["not JSON", "here are your phrases: pricing, cost"],
    ["an array", JSON.stringify([["crm pricing"]])],
    ["no asked language", JSON.stringify({ fr: { pricing: ["prix crm"] } })],
    ["a language that is not an object", JSON.stringify({ en: ["crm pricing"] })],
  ])("a malformed answer (%s) stores nothing and writes no bundle", async (_name, text) => {
    liveCustomer("acme");
    h.db
      .prepare("UPDATE customers SET keyword_lexicon = ?, keyword_lexicon_at = 3 WHERE id = 'acme'")
      .run(JSON.stringify({ pricing: ["old phrase"] }));
    const { call: model } = scripted([{ ok: true, text }]);
    const r = await buildKeywordLexicon("acme", env, { call: model });
    expect(r).toEqual({ ok: false, reason: "malformed" });
    expect(stored("acme")).toMatchObject({
      keyword_lexicon: JSON.stringify({ pricing: ["old phrase"] }),
      keyword_lexicon_at: 3,
    });
    expect(bundle("acme")).toBeNull();
  });

  it("a failed call stores nothing", async () => {
    liveCustomer("acme");
    const { call: model } = scripted([{ ok: false, error: "Timeout after 20000ms" }]);
    expect(await buildKeywordLexicon("acme", env, { call: model })).toEqual({
      ok: false,
      reason: "model_failed",
    });
    expect(stored("acme").keyword_lexicon_at).toBeNull();
    expect(bundle("acme")).toBeNull();
  });

  it("a valid answer the screen empties stores NULL with the time, and no `kl`", async () => {
    liveCustomer("acme");
    const { call: model } = scripted([
      { ok: true, text: JSON.stringify({ en: { problem: ["diabetes", "church crm", "12345"] } }) },
    ]);
    const r = await buildKeywordLexicon("acme", env, { call: model, now: 9000 });
    expect(r).toMatchObject({ ok: true, kept: false, phrases: 0 });
    expect(stored("acme")).toMatchObject({ keyword_lexicon: null, keyword_lexicon_at: 9000 });
    expect(bundle("acme")?.kl).toBeUndefined();
  });

  it.each([
    ["sensitive", "sensitive = 1"],
    ["a special-category yes", "special_category = 1"],
    ["unanswered", "special_category = NULL"],
    ["off", "keyword_off = 1"],
  ])("a change that lands during the model call wins (%s): nothing stored", async (_n, set) => {
    liveCustomer("acme");
    const model = vi.fn(async () => {
      h.db.prepare(`UPDATE customers SET ${set} WHERE id = 'acme'`).run();
      return { ok: true as const, value: result(GOOD) };
    });
    const r = await buildKeywordLexicon("acme", env, { call: model as never });
    expect(r).toEqual({ ok: false, reason: "marked_meanwhile" });
    expect(stored("acme").keyword_lexicon).toBeNull();
  });

  it("calls nothing when the model's key is not visible to this isolate", async () => {
    liveCustomer("acme");
    const { call: model, calls } = scripted([{ ok: true, text: GOOD }]);
    const r = await buildKeywordLexicon("acme", { ...env, MODEL_API_KEY: "" } as never, {
      call: model,
    });
    expect(r).toEqual({ ok: false, reason: "no_model" });
    expect(calls).toHaveLength(0);
  });
});

describe("the screen for a language the table does not cover (condition 7)", () => {
  function germanSite() {
    liveCustomer("acme", { lang: "de" });
  }
  const DE = JSON.stringify({
    de: {
      pricing: ["crm preise", "kosten"],
      problem: ["kunden verlieren", "kirche crm", "glaube crm"],
    },
  });

  it("a second call screens the language's phrases; a yes refuses", async () => {
    germanSite();
    const { call: model, calls } = scripted([
      { ok: true, text: DE },
      // kirche crm is already refused by the table; four phrases are asked.
      { ok: true, text: JSON.stringify({ answers: ["no", "no", "no", "yes"] }) },
    ]);
    const r = await buildKeywordLexicon("acme", env, { call: model });
    expect(r).toMatchObject({ ok: true, kept: true, languages_dropped: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain("Language: de");
    expect(calls[1]?.prompt).not.toContain("kirche");
    const lexicon = JSON.parse(stored("acme").keyword_lexicon ?? "null");
    expect(lexicon).toEqual({ pricing: ["crm preise", "kosten"], problem: ["kunden verlieren"] });
  });

  it.each([
    ["the call fails", { ok: false as const, error: "HTTP 503" }],
    ["the answer is short", { ok: true as const, text: JSON.stringify({ answers: ["no"] }) }],
    ["the answer is not JSON", { ok: true as const, text: "all fine" }],
  ])("when %s the language contributes nothing", async (_name, screen) => {
    germanSite();
    h.db
      .prepare(
        "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('acme', '/en', '{}', 'https://acme.test', 1, 1, 'en')",
      )
      .run();
    const both = JSON.stringify({ de: JSON.parse(DE).de, en: { pricing: ["crm pricing"] } });
    const { call: model } = scripted([{ ok: true, text: both }, screen]);
    const r = await buildKeywordLexicon("acme", env, { call: model });
    expect(r).toMatchObject({ ok: true, languages_dropped: 1 });
    expect(JSON.parse(stored("acme").keyword_lexicon ?? "null")).toEqual({
      pricing: ["crm pricing"],
    });
  });

  it("an unsure or odd answer refuses (anything but a plain no)", async () => {
    germanSite();
    const { call: model } = scripted([
      { ok: true, text: DE },
      { ok: true, text: JSON.stringify({ answers: ["No", "maybe", "", "no "] }) },
    ]);
    await buildKeywordLexicon("acme", env, { call: model });
    expect(JSON.parse(stored("acme").keyword_lexicon ?? "null")).toEqual({
      pricing: ["crm preise"],
      problem: ["glaube crm"],
    });
  });

  it("en, az, ru and tr need no second call", async () => {
    liveCustomer("acme", { lang: "az" });
    const { call: model, calls } = scripted([
      { ok: true, text: JSON.stringify({ az: { pricing: ["crm qiyməti"] } }) },
    ]);
    await buildKeywordLexicon("acme", env, { call: model });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(stored("acme").keyword_lexicon ?? "null")).toEqual({
      pricing: ["crm qiyməti"],
    });
  });
});

describe("parseKeywordAnswer", () => {
  it("accepts a lexicon wrapper and region tags, keeps only asked languages", () => {
    const m = parseKeywordAnswer(
      JSON.stringify({ lexicon: { "en-US": { pricing: ["a"] }, fr: { pricing: ["b"] } } }),
      ["en"],
    );
    expect(m && [...m.keys()]).toEqual(["en"]);
  });
});

describe("the six-hour sweep", () => {
  it("builds for a live, allowed customer whose lexicon is missing, due or older than its brief; one build each, at most the cap", async () => {
    liveCustomer("missing");
    liveCustomer("due");
    liveCustomer("older");
    liveCustomer("fresh");
    liveCustomer("sensitive", { sensitive: 1 });
    liveCustomer("special", { special_category: 1 });
    liveCustomer("off", { off: 1 });
    liveCustomer("notlive");
    h.db.prepare("UPDATE customers SET live_at = NULL WHERE id = 'notlive'").run();
    const set = h.db.prepare(
      "UPDATE customers SET keyword_lexicon = ?, keyword_lexicon_at = ? WHERE id = ?",
    );
    const lex = JSON.stringify({ pricing: ["old"] });
    set.run(lex, 0, "due");
    set.run(lex, 1500, "older"); // brief updated_at is 2000
    set.run(lex, 3000, "fresh");
    const answers: Answer[] = Array.from({ length: 10 }, () => ({ ok: true, text: GOOD }));
    const { call: model, calls } = scripted(answers);
    const r = await runKeywordLexiconSweep(env, { call: model, now: 50_000 });
    expect(r).toEqual({ built: 3, empty: 0, failed: 0 });
    expect(calls).toHaveLength(3);
    for (const id of ["missing", "due", "older"]) {
      expect(stored(id).keyword_lexicon_at).toBe(50_000);
      expect(bundle(id)?.kl).toBeDefined();
    }
    expect(stored("fresh").keyword_lexicon_at).toBe(3000);
    for (const id of ["sensitive", "special", "off", "notlive"]) {
      expect(stored(id).keyword_lexicon).toBeNull();
    }
    // A second sweep finds nothing due.
    const again = await runKeywordLexiconSweep(env, { call: model, now: 60_000 });
    expect(again).toEqual({ built: 0, empty: 0, failed: 0 });
    expect(calls).toHaveLength(3);
  });

  it("respects the cap and tries a failed build again on the next sweep", async () => {
    liveCustomer("a");
    liveCustomer("b");
    const { call: model, calls } = scripted([
      { ok: false, error: "Timeout after 90000ms" },
      { ok: true, text: GOOD },
    ]);
    expect(await runKeywordLexiconSweep(env, { call: model, max: 1 })).toEqual({
      built: 0,
      empty: 0,
      failed: 1,
    });
    expect(calls).toHaveLength(1);
    expect(await runKeywordLexiconSweep(env, { call: model, max: 1 })).toEqual({
      built: 1,
      empty: 0,
      failed: 0,
    });
  });

  it("a change of the served set marks a stored lexicon due", async () => {
    liveCustomer("acme");
    h.db
      .prepare(
        "UPDATE customers SET keyword_lexicon = ?, keyword_lexicon_at = 3000, live_at = NULL WHERE id = 'acme'",
      )
      .run(JSON.stringify({ pricing: ["crm pricing"] }));
    h.db
      .prepare("UPDATE customers SET served_intents = ? WHERE id = 'acme'")
      .run(JSON.stringify(["brand", "problem", "feature", "evaluation"]));
    // A price page appears: pricing joins the served set.
    h.db
      .prepare(
        "INSERT INTO site_paths (customer_id, path, lang, kind, confidence, label, found_on, first_seen_at, last_seen_at) VALUES ('acme', '/pricing', NULL, 'price', 'high', NULL, '/', 1, 1)",
      )
      .run();
    const r = await recomputeServed(h.d1, "acme", { now: 5000, mode: "apply" });
    expect(r.changed).toBe(true);
    expect(stored("acme").keyword_lexicon_at).toBe(0);
  });
});

describe("the endpoints", () => {
  it("POST /admin/keywords/off: customer-scoped, sets the flag, drops and restores `kl`", async () => {
    liveCustomer("acme");
    h.customer("other");
    h.db
      .prepare(
        "UPDATE customers SET keyword_lexicon = ?, keyword_lexicon_at = 3000 WHERE id = 'acme'",
      )
      .run(JSON.stringify({ pricing: ["crm pricing"] }));

    expect((await call("/admin/keywords/off", { customer_id: "other", off: true })).status).toBe(
      403,
    );
    expect((await call("/admin/keywords/off", { customer_id: "acme", off: "yes" })).status).toBe(
      400,
    );
    expect((await call("/admin/keywords/off", { customer_id: "acme" })).status).toBe(400);

    const off = await call("/admin/keywords/off", { customer_id: "acme", off: true });
    expect(off.status).toBe(200);
    expect(off.json).toEqual({ ok: true, customer_id: "acme", off: true, lexicon: true });
    expect(stored("acme").keyword_off).toBe(1);
    expect(bundle("acme")?.kl).toBeUndefined();
    // The answer never carries a phrase.
    expect(JSON.stringify(off.json)).not.toContain("crm pricing");

    const on = await call("/admin/keywords/off", { customer_id: "acme", off: false });
    expect(on.status).toBe(200);
    expect(stored("acme").keyword_off).toBe(0);
    expect(bundle("acme")?.kl).toEqual({ pricing: ["crm pricing"] });
    // A stored lexicon needs no model call to come back.
    expect(routeCalls).toHaveLength(0);
  });

  it("POST /admin/keywords/off: a superadmin may switch any customer; a missing one is 404", async () => {
    liveCustomer("acme");
    sessionUser = FOUNDER;
    expect((await call("/admin/keywords/off", { customer_id: "acme", off: true })).status).toBe(
      200,
    );
    expect(stored("acme").keyword_off).toBe(1);
    expect((await call("/admin/keywords/off", { customer_id: "nobody", off: true })).status).toBe(
      404,
    );
  });

  it("turning reading on for a live customer with no lexicon builds one in the background", async () => {
    liveCustomer("acme", { off: 1 });
    routeAnswers = [{ ok: true, text: GOOD }];
    const r = await call("/admin/keywords/off", { customer_id: "acme", off: false });
    expect(r.status).toBe(200);
    expect(routeCalls).toHaveLength(1);
    expect(bundle("acme")?.kl).toBeDefined();
  });

  it("marking a customer sensitive clears the lexicon and removes `kl` (condition 8)", async () => {
    liveCustomer("acme");
    h.db
      .prepare(
        "UPDATE customers SET keyword_lexicon = ?, keyword_lexicon_at = 3000 WHERE id = 'acme'",
      )
      .run(JSON.stringify({ pricing: ["crm pricing"] }));
    sessionUser = FOUNDER;
    const r = await call("/admin/customers/sensitive", { customer_id: "acme", sensitive: true });
    expect(r.status).toBe(200);
    expect(stored("acme")).toMatchObject({ keyword_lexicon: null, keyword_lexicon_at: null });
    expect(bundle("acme")).not.toBeNull();
    expect(bundle("acme")?.kl).toBeUndefined();
    // And the sweep never builds one again while marked.
    const { call: model, calls } = scripted([{ ok: true, text: GOOD }]);
    await runKeywordLexiconSweep(env, { call: model });
    expect(calls).toHaveLength(0);
  });

  it("a yes to the special-category question clears the lexicon and removes `kl`", async () => {
    liveCustomer("acme");
    h.db
      .prepare(
        "UPDATE customers SET keyword_lexicon = ?, keyword_lexicon_at = 3000 WHERE id = 'acme'",
      )
      .run(JSON.stringify({ pricing: ["crm pricing"] }));
    const r = await call("/admin/customers/special-category", {
      customer_id: "acme",
      answer: true,
    });
    expect(r.status).toBe(200);
    expect(stored("acme").keyword_lexicon).toBeNull();
    expect(bundle("acme")?.kl).toBeUndefined();
  });

  it("saving the brief of a live customer rebuilds the lexicon; a customer not live gets none", async () => {
    liveCustomer("acme");
    routeAnswers = [{ ok: true, text: GOOD }];
    const brief = {
      customer_id: "acme",
      product: "A CRM for small agencies, now with invoicing",
      icp: "Agency owners",
      value_props: ["One view of every client"],
      differentiators: ["Built for retainers"],
      proof_points: ["PROOFPOINT-SECRET 400 agencies"],
    };
    expect((await call("/admin/dna/upsert", brief)).status).toBe(200);
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]?.prompt).toContain("now with invoicing");
    expect(routeCalls[0]?.prompt).not.toContain("PROOFPOINT-SECRET");
    expect(stored("acme").keyword_lexicon).not.toBeNull();

    h.db
      .prepare("UPDATE customers SET live_at = NULL, keyword_lexicon = NULL WHERE id = 'acme'")
      .run();
    routeAnswers = [{ ok: true, text: GOOD }];
    expect((await call("/admin/dna/upsert", brief)).status).toBe(200);
    expect(routeCalls).toHaveLength(1);
    expect(stored("acme").keyword_lexicon).toBeNull();
  });

  it("the operator's change of the served set rebuilds the lexicon", async () => {
    liveCustomer("acme");
    routeAnswers = [{ ok: true, text: GOOD }];
    const r = await call("/admin/site-map", {
      customer_id: "acme",
      paths: [{ path: "/pricing", kind: "price" }],
    });
    expect(r.status).toBe(200);
    // Served was all six; a price page keeps it all six, so nothing moved.
    expect(routeCalls).toHaveLength(0);
    // The map off folds the set back to all six from a narrower one.
    h.db
      .prepare("UPDATE customers SET served_intents = ? WHERE id = 'acme'")
      .run(JSON.stringify(["brand", "problem", "feature"]));
    const off = await call("/admin/site-map", { customer_id: "acme", on: false });
    expect(off.status).toBe(200);
    expect(routeCalls).toHaveLength(1);
    expect(stored("acme").keyword_lexicon).not.toBeNull();
  });
});
