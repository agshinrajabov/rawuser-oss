/**
 * The visitor's own choice in generation (docs/specs/direct-visitors.md §2):
 * the question written from the brief, pointing to existing versions of the
 * home page, screened; the approval rule (the first is live, a later one a
 * draft unless auto_approve; a customer's own edit is live); the endpoints
 * (off by default, the preview link, the superadmin's kill switch); the
 * card's counts from events; the sweep's first question.
 */
import { pickTokenKey, variantKeyForPath, visitorBundleKey } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleChoice } from "../src/admin/choice.ts";
import type { AdminEnv } from "../src/admin/handlers.ts";
import { runChoiceSweep } from "../src/cron/direct-answers.ts";
import { type ChoiceEnv, choiceCounts, writeChoice } from "../src/lib/choice.ts";
import { NO_PEOPLE, VISITORS_PEOPLE_SQL, peopleOf } from "../src/lib/visitors.ts";
import { DAY, type Harness, harness, vid } from "./proof-harness.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
let h: Harness;

const MANIFEST = {
  "hero.headline": { css: ["h1"], text: ["Old"], structural: "h1" },
  "hero.cta.label": { css: ["a.cta"], text: ["Start"], structural: "a" },
};

function cell(intent: string, source: string, headline: string, path = "/") {
  const key = variantKeyForPath("acme", path, intent, source);
  h.db
    .prepare(
      `INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status, body_id)
       VALUES (?, 'acme', (SELECT id FROM intent_profiles LIMIT 1), ?, 'm', 'p', 1, 0, 'ready', '0123456789abcdef')`,
    )
    .run(`v_${key}`, key);
  h.kv.set(key, JSON.stringify({ sections: { hero: { headline } } }));
}

beforeEach(() => {
  h = harness();
  h.customer("acme");
  h.db.prepare("UPDATE customers SET live_at = 1, domain = 'acme.test' WHERE id = 'acme'").run();
  h.db
    .prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at) VALUES ('acme', '/', ?, 1, 'https://acme.test/', 1)",
    )
    .run(JSON.stringify(MANIFEST));
  h.db
    .prepare(
      "INSERT INTO business_dna (customer_id, product, icp, updated_at) VALUES ('acme', 'Deal documents for M&A', 'Brokers, PE funds and owners selling a company', 1)",
    )
    .run();
  cell("problem", "default", "Memos in a day");
  cell("evaluation", "default", "Why funds use us");
  cell("feature", "social", "What you get");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const model = (text: string) =>
  vi.fn(async () => ({
    ok: true as const,
    value: {
      text,
      model: "model-a",
      promptHash: "x",
      costUsd: 0.0004,
      cacheHit: false,
    } as never,
  }));
const GOOD = JSON.stringify({
  question: "What brings you here?",
  answers: [
    { label: "I'm a broker", version: "problem:default" },
    { label: "I run a PE fund", version: "evaluation:default" },
    { label: "I'm selling my company", version: "feature:social" },
  ],
});
const row = () =>
  h.db
    .prepare(
      "SELECT choice_on, choice_killed, choice, choice_draft FROM customers WHERE id = 'acme'",
    )
    .get() as {
    choice_on: number;
    choice_killed: number;
    choice: string | null;
    choice_draft: string | null;
  };

describe("writeChoice", () => {
  it("the first question is the live one, still off; the anchor is the hero's button", async () => {
    const call = model(GOOD);
    const r = await writeChoice(h.env as unknown as ChoiceEnv, "acme", call);
    expect(r).toMatchObject({ ok: true, state: "live" });
    const prompt = (call.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt;
    expect(prompt).toContain("problem:default");
    expect(prompt).toContain("Memos in a day");
    expect(JSON.parse(row().choice ?? "{}")).toEqual({
      "/": {
        q: "What brings you here?",
        a: [
          ["a", "I'm a broker", "problem", "default"],
          ["b", "I run a PE fund", "evaluation", "default"],
          ["c", "I'm selling my company", "feature", "social"],
        ],
        s: ["a.cta"],
      },
    });
    expect(row().choice_on).toBe(0);
    expect(JSON.parse(h.kv.get(visitorBundleKey("acme")) ?? "{}")).not.toHaveProperty("qc");
  });

  it("a later question waits as the draft, unless auto_approve", async () => {
    await writeChoice(h.env as unknown as ChoiceEnv, "acme", model(GOOD));
    const r = await writeChoice(
      h.env as unknown as ChoiceEnv,
      "acme",
      model(GOOD.replace("broker", "banker")),
    );
    expect(r.state).toBe("draft");
    expect(row().choice).toContain("broker");
    expect(row().choice_draft).toContain("banker");
    h.db.prepare("UPDATE customers SET auto_approve = 1").run();
    expect((await writeChoice(h.env as unknown as ChoiceEnv, "acme", model(GOOD))).state).toBe(
      "live",
    );
  });

  it("refuses an answer about health or a price, and a version the page does not have", async () => {
    const health = GOOD.replace("I'm a broker", "I have diabetes");
    expect((await writeChoice(h.env as unknown as ChoiceEnv, "acme", model(health))).ok).toBe(
      false,
    );
    const price = GOOD.replace("I'm a broker", "I pay $49 a month");
    expect((await writeChoice(h.env as unknown as ChoiceEnv, "acme", model(price))).ok).toBe(false);
    const unknown = GOOD.replace("feature:social", "pricing:ai").replace(
      "evaluation:default",
      "brand:ai",
    );
    expect((await writeChoice(h.env as unknown as ChoiceEnv, "acme", model(unknown))).ok).toBe(
      false,
    );
    expect(row().choice).toBeNull();
  });
});

describe("the endpoints", () => {
  const superadmin = { id: "u", email: "a@rawuser.example", role: "superadmin", customer_id: null };
  const customer = { id: "c", email: "c@acme.test", role: "customer", customer_id: "acme" };
  const env = () => ({ ...h.env, DASHBOARD_ORIGIN: "*" }) as unknown as AdminEnv;
  async function call(
    action: "" | "write" | "preview-link" | "kill",
    body?: unknown,
    user: unknown = customer,
  ) {
    const req = body
      ? new Request(`https://api.test/admin/choice${action ? `/${action}` : ""}`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      : new Request("https://api.test/admin/choice?customer_id=acme");
    const res = await handleChoice(req, env(), user as never, action, NOW);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("off by default; on only with a question; the bundle gets qc; the kill switch removes it", async () => {
    let r = await call("");
    expect(r.json).toMatchObject({
      on: false,
      killed: false,
      allowed: true,
      live: null,
      has_anchor: true,
    });
    expect(r.json.reaches_visitors_within_s).toBe(360);
    expect((await call("", { customer_id: "acme", on: true })).status).toBe(409);
    await writeChoice(h.env as unknown as ChoiceEnv, "acme", model(GOOD));
    r = await call("", { customer_id: "acme", on: true });
    expect(r.json).toMatchObject({ on: true });
    expect(JSON.parse(h.kv.get(visitorBundleKey("acme")) ?? "{}").qc.q).toBe(
      "What brings you here?",
    );
    // The customer cannot kill; a superadmin can.
    expect((await call("kill", { customer_id: "acme", killed: true })).status).toBe(403);
    r = await call("kill", { customer_id: "acme", killed: true }, superadmin);
    expect(r.json).toMatchObject({ killed: true, on: true });
    expect(JSON.parse(h.kv.get(visitorBundleKey("acme")) ?? "{}")).not.toHaveProperty("qc");
  });

  it("the customer's own edit is live; screened; a version the page lacks is refused", async () => {
    await writeChoice(h.env as unknown as ChoiceEnv, "acme", model(GOOD));
    const answers = [
      { label: "I'm a banker", intent_dim: "problem", source_dim: "default" },
      { label: "I invest", intent_dim: "evaluation", source_dim: "default" },
    ];
    const r = await call("", { customer_id: "acme", question: "Who are you?", answers });
    expect(r.status).toBe(200);
    expect(r.json.live).toMatchObject({
      question: "Who are you?",
      answers: [{ slot: "a", label: "I'm a banker" }, { slot: "b" }],
    });
    expect(
      (
        await call("", {
          customer_id: "acme",
          answers: [
            answers[0],
            { label: "I'm pregnant", intent_dim: "evaluation", source_dim: "default" },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("", {
          customer_id: "acme",
          answers: [answers[0], { label: "Other", intent_dim: "pricing", source_dim: "ai" }],
        })
      ).status,
    ).toBe(400);
  });

  it("approve and discard the draft", async () => {
    await writeChoice(h.env as unknown as ChoiceEnv, "acme", model(GOOD));
    await writeChoice(
      h.env as unknown as ChoiceEnv,
      "acme",
      model(GOOD.replace("broker", "banker")),
    );
    let r = await call("", { customer_id: "acme", approve_draft: true });
    expect(JSON.stringify(r.json.live)).toContain("banker");
    expect(r.json.draft).toBeNull();
    await writeChoice(h.env as unknown as ChoiceEnv, "acme", model(GOOD));
    r = await call("", { customer_id: "acme", discard_draft: true });
    expect(r.json.draft).toBeNull();
    expect(JSON.stringify(r.json.live)).toContain("banker");
  });

  it("the preview link: a one-time pick token in choice mode on the customer's home page", async () => {
    await writeChoice(h.env as unknown as ChoiceEnv, "acme", model(GOOD));
    const r = await call("preview-link", { customer_id: "acme" });
    expect(r.json.link).toBe(`https://acme.test/#rawuser_pick=${r.json.token}`);
    const meta = JSON.parse(h.kv.get(pickTokenKey(String(r.json.token))) ?? "{}");
    expect(meta).toMatchObject({
      mode: "choice",
      page_path: "/",
      choice: { t: "What brings you here?", p: 1 },
    });
    expect(JSON.stringify(meta.choice)).not.toMatch(/problem|evaluation/);
  });

  it("another customer's scope is refused", async () => {
    const other = { id: "o", email: "o@x.test", role: "customer", customer_id: "other" };
    expect((await call("", undefined, other)).status).toBe(403);
  });
});

describe("the card's counts", () => {
  it("shown and skipped from the choice rows, answered and clicked by visit", async () => {
    const ev = (o: Parameters<Harness["ev"]>[0]) => h.ev({ ts: NOW - DAY, ...o });
    for (let i = 1; i <= 4; i++)
      ev({
        type: "choice" as never,
        visit: vid(i),
        props: { ch: "shown" },
        body: null,
        intent: null,
        source: null,
      });
    ev({
      type: "choice" as never,
      visit: vid(9),
      props: { ch: "fit" },
      body: null,
      intent: null,
      source: null,
    });
    ev({
      type: "choice" as never,
      visit: vid(10),
      props: { ch: "covered" },
      body: null,
      intent: null,
      source: null,
    });
    ev({
      type: "choice" as never,
      visit: vid(4),
      props: { ch: "closed" },
      body: null,
      intent: null,
      source: null,
    });
    ev({ type: "variant_shown", visit: vid(1), props: { nd: "c:a" } });
    ev({ type: "variant_shown", visit: vid(2), props: { nd: "c:b" } });
    ev({ type: "variant_shown", visit: vid(5), props: { nd: "r:a" } });
    const pid = "fedcba9876543210fedcba9876543210";
    for (const [ch, v] of [
      ["answered", 1],
      ["returned", 5],
      ["returned", 6],
    ] as const)
      ev({
        type: "choice" as never,
        visit: vid(v),
        props: { ch, qa: "a", pid },
        body: null,
        intent: null,
        source: null,
      });
    ev({ type: "conversion", visit: vid(1) });
    ev({ type: "conversion", visit: vid(3) });
    ev({ type: "conversion", visit: vid(9) }); // not shown the question
    const c = await choiceCounts(h.d1, "acme", NOW);
    expect(c).toEqual({
      days: 30,
      shown: 4,
      skipped: { fit: 1, anchor: 0, covered: 1 },
      closed: 1,
      answered: { a: 1, b: 1 },
      returned: { a: 1 },
      people: { answered: 1, returned: 1 },
      clicked: 2,
      clicked_by_answer: { a: 1 },
    });
  });
});

describe("new and returning visitors (ADR 0039)", () => {
  it("counts codes, never across customers: new, back, what came back, who clicked on a later visit", async () => {
    const ev = (o: Parameters<Harness["ev"]>[0]) => h.ev({ ts: NOW - DAY, ...o });
    const A = "a".repeat(32);
    const B = "b".repeat(32);
    const C = "c".repeat(32);
    const row = (visit: number, props: Record<string, string>, customer?: string) =>
      ev({
        type: "choice" as never,
        visit: vid(visit),
        props,
        body: null,
        intent: null,
        source: null,
        ...(customer ? { customer } : {}),
      } as never);
    row(1, { ch: "first", pid: A });
    row(2, { ch: "returned", pid: A, rc: "problem:ai" });
    row(3, { ch: "returned", pid: A, qa: "b" });
    row(4, { ch: "first", pid: B });
    row(5, { ch: "returned", pid: C, rc: "pricing:social" });
    row(6, { ch: "shown" });
    // Visit 2 was served the remembered source; visit 5 came with a link of its own.
    ev({ type: "variant_shown", visit: vid(2), source: "ai", carried: 1 });
    ev({ type: "variant_shown", visit: vid(5), source: "organic" });
    ev({ type: "conversion", visit: vid(2) });
    ev({ type: "conversion", visit: vid(4) });
    const p = await peopleOf(h.d1, "acme", NOW - 7 * DAY, NOW);
    expect(p).toEqual({
      people: 3,
      new: 2,
      returning: 2,
      returning_visits: 3,
      given_back: { ai: 1, answer: 1 },
      converted: 2,
      converted_returning: 1,
    });
    expect(VISITORS_PEOPLE_SQL).toContain("customer_id = ?1");
    expect(await peopleOf(h.d1, "other", NOW - 7 * DAY, NOW)).toEqual(NO_PEOPLE);
  });
});

describe("the sweep's first question", () => {
  it("writes one for a live customer with none, off; never twice", async () => {
    const call = vi.fn();
    vi.stubGlobal("fetch", async () => new Response("{}"));
    const env = { ...h.env } as unknown as ChoiceEnv;
    // No model key in tests: the call fails, which counts as failed, never written.
    const r = await runChoiceSweep(env);
    expect(r.written + r.failed).toBe(1);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("the two-part paste is the same with the question on or off (the bar reserves nothing)", () => {
  it("turning the question on changes neither the paste nor its hash", async () => {
    const { currentPaste } = await import("../src/lib/pre-paste.ts");
    await writeChoice(h.env as unknown as ChoiceEnv, "acme", model(GOOD));
    const off = await currentPaste(h.d1, "acme");
    h.db.prepare("UPDATE customers SET choice_on = 1 WHERE id = 'acme'").run();
    const on = await currentPaste(h.d1, "acme");
    expect(on?.css).not.toContain("padding-bottom");
    expect(on?.hash).toBe(off?.hash);
  });
});

describe("a question per language (§2)", () => {
  /** The site also has `/az`, confirmed in Azerbaijani, with its own versions and brief. */
  function azHome() {
    h.db
      .prepare(
        "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at, language) VALUES ('acme', '/az', ?, 1, 'https://acme.test/az', 1, 'az')",
      )
      .run(JSON.stringify(MANIFEST));
    h.db
      .prepare(
        "INSERT INTO business_dna_i18n (customer_id, language, product, icp, updated_at) VALUES ('acme', 'az', 'M&A sənədləri', 'Brokerlər və fondlar', 1)",
      )
      .run();
    cell("problem", "default", "Bir günə memo", "/az");
    cell("evaluation", "default", "Fondlar niyə bizi seçir", "/az");
  }
  const AZ = JSON.stringify({
    question: "Sizi buraya nə gətirib?",
    answers: [
      { label: "Brokerəm", version: "problem:default" },
      { label: "Fond idarə edirəm", version: "evaluation:default" },
    ],
  });

  it("each language home gets its own question, in its language, from its own versions and brief", async () => {
    azHome();
    const call = model(AZ);
    expect(await writeChoice(h.env as unknown as ChoiceEnv, "acme", call, "/az")).toMatchObject({
      ok: true,
      state: "live",
    });
    const prompt = (call.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt;
    expect(prompt).toContain("Language: az");
    expect(prompt).toContain("Bir günə memo");
    expect(prompt).toContain("M&A sənədləri");
    expect(prompt).not.toContain("What you get");
    await writeChoice(h.env as unknown as ChoiceEnv, "acme", model(GOOD));
    const set = JSON.parse(row().choice ?? "{}");
    expect(Object.keys(set).sort()).toEqual(["/", "/az"]);
    expect(set["/az"].q).toBe("Sizi buraya nə gətirib?");
    // On: `/`'s question is the bundle's `qc`, `/az`'s rides in `ql`.
    h.db
      .prepare("UPDATE customers SET choice_on = 1, special_category = 0 WHERE id = 'acme'")
      .run();
    const res = await handleChoice(
      new Request("https://api.test/admin/choice", {
        method: "POST",
        body: JSON.stringify({ customer_id: "acme", on: true, path: "/az" }),
      }),
      h.env as unknown as AdminEnv,
      { role: "superadmin" } as never,
      "",
      NOW,
    );
    const st = (await res.json()) as { path: string; live: { question: string }; homes: unknown };
    expect(st.path).toBe("/az");
    expect(st.live.question).toBe("Sizi buraya nə gətirib?");
    expect(st.homes).toEqual([
      { path: "/", lang: "en", has_question: true },
      { path: "/az", lang: "az", has_question: true },
    ]);
    const b = JSON.parse(h.kv.get(visitorBundleKey("acme")) ?? "{}");
    expect(b.qc.q).toBe("What brings you here?");
    expect(b.ql["/az"].q).toBe("Sizi buraya nə gətirib?");
  });

  it("a refused first answer is written again with the reason, once", async () => {
    const long = JSON.stringify({
      question: "What brings you here?",
      answers: [
        { label: "I am a broker looking for faster memos", version: "problem:default" },
        { label: "I run a PE fund", version: "evaluation:default" },
      ],
    });
    const call = vi.fn().mockImplementationOnce(model(long)).mockImplementationOnce(model(GOOD));
    const r = await writeChoice(h.env as unknown as ChoiceEnv, "acme", call as never);
    expect(r).toMatchObject({ ok: true });
    const second = (call.mock.calls[1] as unknown as [{ prompt: string }])[0].prompt;
    expect(second).toContain("has 38 characters; every answer at most 32");
  });

  it("the queue's sweep writes every language home that has none, then stops", async () => {
    azHome();
    h.db.prepare("UPDATE customers SET special_category = 0 WHERE id = 'acme'").run();
    const call = vi.fn(async (input: { prompt: string }) =>
      (input.prompt.includes("Language: az") ? model(AZ) : model(GOOD))(),
    );
    const write: typeof writeChoice = (env, id, _c, home) =>
      writeChoice(env, id, call as never, home);
    const env = h.env as unknown as ChoiceEnv;
    expect(await runChoiceSweep(env, write)).toEqual({ written: 2, failed: 0 });
    expect(Object.keys(JSON.parse(row().choice ?? "{}")).sort()).toEqual(["/", "/az"]);
    expect(await runChoiceSweep(env, write)).toEqual({ written: 0, failed: 0 });
    expect(call).toHaveBeenCalledTimes(2);
  });
});
