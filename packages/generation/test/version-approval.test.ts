/**
 * A changed version waits for the customer's OK (docs/specs/versions-approval.md).
 *
 * The real write path (orchestrate, regenerateOne, the five-minute queue,
 * the brief save, Rewrite everything) on node:sqlite with every migration,
 * the model stubbed, and the endpoints through the worker as a customer's
 * session. What visitors get is what the KV key holds: a waiting body never
 * reaches it until approved, and approval goes through publishVersion, so
 * the proof engine's body_id stays right.
 */
import { type Manifest, variantKeyForPath } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeKv, makeSqliteD1 } from "./admin/sqlite-d1.ts";
import { MODEL_ENV } from "./model-env.ts";

interface ModelInput {
  prompt: string;
}
let inputs: ModelInput[] = [];
let answerFor: (input: ModelInput) => string = () => "{}";
vi.mock("../src/generateVariant.ts", () => ({
  generateVariant: vi.fn(async (input: ModelInput) => {
    inputs.push(input);
    return {
      text: answerFor(input),
      model: "model-a",
      costUsd: 0.0002,
      promptHash: "h",
      cacheHit: false,
      cacheReadTokens: 0,
    };
  }),
}));

const PAGE_HTML = `<html lang="en"><body><main><section class="hero"><h1>Plan the week in one calm place</h1>
<p class="lead">Tasks, notes and deadlines of the whole team on a single board.</p></section></main></body></html>`;
vi.mock("../src/detect-elements.ts", async (actual) => ({
  ...(await actual<typeof import("../src/detect-elements.ts")>()),
  fetchPageHtml: vi.fn(async () => PAGE_HTML),
}));

// One served intent: six cells a page (its default and the five sources).
vi.mock("../src/site-map/served-load.ts", () => ({
  loadServedIntents: vi.fn(async () => ["problem"]),
}));

type User = { id: string; email: string; role: string; customer_id: string | null };
const ACME: User = { id: "u2", email: "c@acme.test", role: "customer", customer_id: "acme" };
const SUPERADMIN: User = {
  id: "u1",
  email: "f@example.com",
  role: "superadmin",
  customer_id: null,
};
let sessionUser: User = ACME;
vi.mock("../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionUser),
}));

const { orchestrate, regenerateOne } = await import("../src/orchestrator.ts");
const { runRegenQueue } = await import("../src/cron/regen-queue.ts");
const { upsertBusinessDna } = await import("../src/admin/handlers.ts");
const { resetPageLinks } = await import("../src/page-links.ts");
const { resetReads } = await import("../src/inline-shape-backfill.ts");
const { FIRST_SET_DAYS, recordFirstSet, parseFirstSet, routeFor } = await import(
  "../src/lib/version-approval.ts"
);
const { partsBeside } = await import("../src/admin/version-approval.ts");
const { default: worker } = await import("../src/index.ts");

const HEADLINE = "Plan the week in one calm place";
const BODY = "Tasks, notes and deadlines of the whole team on a single board.";
const PLAIN = { icons: "none", emphasis: 0, split: false, animated_text: false } as const;
const MANIFEST: Manifest = {
  "hero.headline": {
    css: ["section.hero h1"],
    text: [HEADLINE],
    structural: "h1",
    original_char_length: HEADLINE.length,
    original_word_count: 7,
    inline: { ...PLAIN },
  },
  "hero.body": {
    css: ["section.hero p.lead"],
    text: [BODY.slice(0, 40)],
    structural: "p",
    original_char_length: BODY.length,
    original_word_count: 12,
    inline: { ...PLAIN },
  },
};

/** Three sets of words a model may write; each is a different body id. */
const WORDS = {
  a: [
    "See the whole week in one place",
    "The tasks, notes and deadlines of your team sit on one board.",
  ],
  b: [
    "Your whole week, in one calm view",
    "Every task, note and deadline of the team lives on one board.",
  ],
  c: [
    "The week of your team, all in one",
    "All the tasks, notes and dates of your team sit on a board.",
  ],
} as const;

function modelWriting(which: keyof typeof WORDS) {
  let last = "";
  answerFor = (input) => {
    if (input.prompt.includes("Revise the JSON object")) return last;
    if (!input.prompt.includes("profile_key")) return "{}";
    last = JSON.stringify({
      customer_id: "acme",
      profile_key: `intent:${/"intent:(\w+)"/.exec(input.prompt)?.[1] ?? "problem"}`,
      sections: { hero: { kind: "hero", headline: WORDS[which][0], body: WORDS[which][1] } },
      generated_at: 1,
      prompt_hash: "",
    });
    return last;
  };
}
function modelDown() {
  answerFor = () => {
    throw new Error("Timeout after 45000ms");
  };
}

/** First calls of a write: one per version tried. */
const tried = () => inputs.filter((i) => i.prompt.includes("profile_key:")).length;

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const KEY = (page: string, source = "ai") => variantKeyForPath("acme", page, "problem", source);

function setup(
  opts: {
    live?: boolean;
    autoApprove?: boolean;
    firstSet?: { at: number; pages: string[]; intents: string[] | null } | null;
    pages?: string[];
  } = {},
) {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    `INSERT INTO customers (id, slug, domain, plan, status, created_at, auto_approve, live_at, site_map_off, first_set)
     VALUES ('acme', 'acme', 'acme.test', 'pilot', 'active', 1, ?, ?, 1, ?)`,
  ).run(
    opts.autoApprove ? 1 : 0,
    opts.live === false ? null : T0,
    opts.firstSet === null
      ? null
      : JSON.stringify(opts.firstSet ?? { at: T0, pages: ["/"], intents: ["problem"] }),
  );
  db.prepare(
    "INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES ('beta', 'beta', 'beta.test', 'pilot', 'active', 1)",
  ).run();
  db.prepare(
    `INSERT INTO business_dna (customer_id, product, icp, brand_voice, updated_at, value_props, differentiators, proof_points, target_market, target_language, per_intent_hints)
     VALUES ('acme', 'A planning board for small teams', 'Team leads', 'calm', 1, '["One board"]', '["Calm"]', '["Teams use it"]', 'Global', 'en', '{}')`,
  ).run();
  for (const page of opts.pages ?? ["/"]) {
    db.prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('acme', ?, ?, ?, 1, 1, 'en')",
    ).run(page, JSON.stringify(MANIFEST), `https://acme.test${page}`);
  }
  const kv = makeKv();
  const env = {
    ...MODEL_ENV,
    DB: d1,
    VARIANTS: kv,
    ENVIRONMENT: "test",
    DASHBOARD_ORIGIN: "https://app.example.com",
  };
  const pass = async () => {
    inputs = [];
    return runRegenQueue(env as never, (id, e, o) => orchestrate(id, e, o));
  };
  const row = (key: string) =>
    db
      .prepare(
        "SELECT status, body_id, pending_body_id, pending_at, error_reason FROM variants WHERE kv_key = ?",
      )
      .get(key) as
      | {
          status: string;
          body_id: string | null;
          pending_body_id: string | null;
          pending_at: number | null;
          error_reason: string | null;
        }
      | undefined;
  const body = (id: string) =>
    db.prepare("SELECT * FROM version_bodies WHERE body_id = ?").get(id) as
      | {
          live_from: number;
          retired_at: number | null;
          discarded_at: number | null;
          body_json: string;
        }
      | undefined;
  const served = (key: string) => {
    const raw = kv.store.get(key);
    return raw
      ? (JSON.parse(raw) as { body_id?: string; sections: { hero: { headline: string } } })
      : null;
  };
  const call = async (method: "GET" | "POST", path: string, payload?: unknown) => {
    const res = await worker.fetch(
      new Request(`https://api.example.com${path}`, {
        method,
        headers: { "x-rawuser-admin": "session", "content-type": "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      }),
      env as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { env, db, kv, pass, row, body, served, call };
}

type Setup = ReturnType<typeof setup>;

/** The first set written: every "/" cell live with words `a`; a page added later waits. */
async function liveFirstSet(s: Setup) {
  modelWriting("a");
  const run = await orchestrate("acme", s.env as never, {});
  expect(run.generated - (run.waiting ?? 0)).toBe(6);
}

beforeEach(() => {
  inputs = [];
  sessionUser = ACME;
  resetPageLinks();
  resetReads();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 + HOUR);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("what publishes at once", () => {
  it("a customer that has not gone live: as before", async () => {
    const s = setup({ live: false, firstSet: null });
    modelWriting("a");
    const r = await regenerateOne("acme", "problem", "ai", s.env as never);
    expect(r.ok).toBe(true);
    expect(r.pending).toBeUndefined();
    expect(s.served(KEY("/"))?.sections.hero.headline).toBe(WORDS.a[0]);
    expect(s.row(KEY("/"))?.pending_body_id).toBeNull();
  });

  it("the first set: each cell of the go-live pages and intents, its first body, for seven days", async () => {
    const s = setup();
    await liveFirstSet(s);
    for (const source of ["default", "ai", "social", "community", "organic", "paid"]) {
      const v = s.served(KEY("/", source));
      expect(v?.sections.hero.headline).toBe(WORDS.a[0]);
      expect(s.row(KEY("/", source))).toMatchObject({ status: "ready", body_id: v?.body_id });
    }
  });

  it("a first-set cell written after the seven days waits", async () => {
    const s = setup();
    vi.setSystemTime(T0 + FIRST_SET_DAYS * DAY + HOUR);
    modelWriting("a");
    const r = await regenerateOne("acme", "problem", "ai", s.env as never);
    expect(r.pending).toBe(true);
    expect(s.served(KEY("/"))).toBeNull();
    expect(s.row(KEY("/"))?.status).toBe("pending");
  });

  it("an intent the first set did not have waits (a new intent)", async () => {
    const s = setup({ firstSet: { at: T0, pages: ["/"], intents: ["feature"] } });
    modelWriting("a");
    const run = await orchestrate("acme", s.env as never, {});
    expect(run.waiting).toBe(6);
    expect(s.served(KEY("/"))).toBeNull();
  });

  it("a customer live before the rule (no first set): every new body waits", async () => {
    const s = setup({ firstSet: null });
    const route = await routeFor(
      s.env as never,
      { customerId: "acme", pagePath: "/", intentDim: "problem", sourceDim: "ai" },
      KEY("/"),
    );
    expect(route).toBe("waiting");
  });

  it("auto_approve on: every write publishes, as before the rule", async () => {
    const s = setup();
    await liveFirstSet(s);
    const on = await s.call("POST", "/admin/customers/auto-approve", {
      customer_id: "acme",
      on: true,
    });
    expect(on).toMatchObject({ status: 200, json: { auto_approve: true, pending: 0 } });
    expect((await s.call("GET", "/admin/customers/auto-approve?customer_id=acme")).json).toEqual({
      customer_id: "acme",
      auto_approve: true,
      pending: 0,
    });
    modelWriting("b");
    const r = await regenerateOne("acme", "problem", "ai", s.env as never);
    expect(r.pending).toBeUndefined();
    expect(s.served(KEY("/"))?.sections.hero.headline).toBe(WORDS.b[0]);
    expect(s.row(KEY("/"))?.pending_body_id).toBeNull();
    // Off again: the next rewrite waits.
    await s.call("POST", "/admin/customers/auto-approve", { customer_id: "acme", on: false });
    modelWriting("c");
    expect((await regenerateOne("acme", "problem", "ai", s.env as never)).pending).toBe(true);
    expect(s.served(KEY("/"))?.sections.hero.headline).toBe(WORDS.b[0]);
  });

  it("the same words as the live body do not wait", async () => {
    const s = setup();
    await liveFirstSet(s);
    modelWriting("a");
    const r = await regenerateOne("acme", "problem", "ai", s.env as never);
    expect(r.pending).toBeUndefined();
    expect(s.row(KEY("/"))?.pending_body_id).toBeNull();
  });

  it("the first set is recorded once and parsed back; a later go live never moves it", async () => {
    const s = setup({ firstSet: null });
    await recordFirstSet(s.env.DB as never, "acme", { at: 5, pages: ["/az/"], intents: null });
    await recordFirstSet(s.env.DB as never, "acme", { at: 9, pages: ["/x"], intents: ["brand"] });
    const raw = (
      s.db.prepare("SELECT first_set FROM customers WHERE id = 'acme'").get() as {
        first_set: string;
      }
    ).first_set;
    expect(parseFirstSet(raw)).toEqual({ at: 5, pages: ["/az"], intents: null });
  });
});

describe("a new body of a live cell waits", () => {
  it("the customer's Rewrite: stored, not published; the list, the summary and the Overview say so", async () => {
    const s = setup();
    await liveFirstSet(s);
    const liveId = s.served(KEY("/"))?.body_id as string;
    modelWriting("b");
    const r = await regenerateOne("acme", "problem", "ai", s.env as never);
    expect(r).toMatchObject({ ok: true, pending: true });
    // Visitors keep the live body: the KV value is untouched.
    expect(s.served(KEY("/"))).toMatchObject({ body_id: liveId });
    expect(s.served(KEY("/"))?.sections.hero.headline).toBe(WORDS.a[0]);
    const row = s.row(KEY("/"));
    expect(row).toMatchObject({ status: "ready", body_id: liveId });
    expect(row?.pending_body_id).toMatch(/^[0-9a-f]{16}$/);
    expect(row?.pending_at).toBe(T0 + HOUR);
    // The immutable body is kept, never live yet.
    expect(s.body(row?.pending_body_id as string)).toMatchObject({
      live_from: 0,
      retired_at: null,
    });

    const list = await s.call("GET", "/admin/variants/list?customer_id=acme&summary=1");
    const items = list.json.items as Array<Record<string, unknown>>;
    const mine = items.find((i) => i.kv_key === KEY("/"));
    expect(mine).toMatchObject({
      status: "ready",
      pending: true,
      pending_since: T0 + HOUR,
      approval: "waiting",
      waiting_since: T0 + HOUR,
    });
    expect(items.filter((i) => i.pending === true)).toHaveLength(1);
    expect(list.json.summary).toMatchObject({ written: 6, pending: 1 });
    expect(JSON.stringify(list.json)).not.toContain("body_id");

    const ov = await s.call("GET", "/admin/analytics/overview?customer_id=acme&window=30d");
    expect(ov.json.pending_versions).toBe(1);

    const pending = await s.call("GET", "/admin/variants/pending?customer_id=acme");
    expect(pending.json.count).toBe(1);
    const item = (pending.json.items as Array<Record<string, unknown>>)[0];
    expect(item).toMatchObject({
      page_path: "/",
      intent_dim: "problem",
      source_dim: "ai",
      has_live: true,
      pending_since: T0 + HOUR,
      parts: [
        { path: "hero.headline", live: WORDS.a[0], new: WORDS.b[0] },
        { path: "hero.body", live: WORDS.a[1], new: WORDS.b[1] },
      ],
    });
    // A customer's answer: its own words, no ids or provenance.
    expect(JSON.stringify(pending.json)).not.toMatch(/body_id|prompt_hash|profile_key/);
    sessionUser = SUPERADMIN;
    const admin = await s.call("GET", "/admin/variants/pending?customer_id=acme");
    expect((admin.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      pending_body_id: row?.pending_body_id,
      live_body_id: liveId,
    });
  });

  it("the queue's retry: a failed rewrite written later by the queue waits, and the queue leaves it", async () => {
    const s = setup();
    await liveFirstSet(s);
    const liveId = s.served(KEY("/"))?.body_id;
    modelDown();
    const failed = await regenerateOne("acme", "problem", "ai", s.env as never);
    expect(failed.ok).toBe(false);
    expect(s.row(KEY("/"))?.status).toBe("error");
    // Past the queue's waits, the model back.
    vi.setSystemTime(T0 + 8 * HOUR);
    modelWriting("b");
    await s.pass();
    expect(tried()).toBe(1);
    expect(s.row(KEY("/"))).toMatchObject({ status: "ready", body_id: liveId });
    expect(s.row(KEY("/"))?.pending_body_id).not.toBeNull();
    expect(s.served(KEY("/"))?.body_id).toBe(liveId);
    // Settled: the next pass writes nothing.
    vi.setSystemTime(T0 + 8 * HOUR + 5 * 60_000);
    await s.pass();
    expect(tried()).toBe(0);
  });

  it("Rewrite everything: the queue writes every cell again, all of them wait", async () => {
    const s = setup();
    await liveFirstSet(s);
    const before = s.served(KEY("/"))?.body_id;
    const r = await s.call("POST", "/admin/variants/stale-all", { customer_id: "acme" });
    expect(r).toMatchObject({ status: 200, json: { ok: true, count: 6 } });
    modelWriting("b");
    await s.pass();
    expect(tried()).toBe(6);
    expect(s.served(KEY("/"))?.body_id).toBe(before);
    const waiting = s.db
      .prepare(
        "SELECT COUNT(*) AS n FROM variants WHERE pending_body_id IS NOT NULL AND status = 'ready'",
      )
      .get() as { n: number };
    expect(waiting.n).toBe(6);
  });

  it("a brief save drops what waits (written from the old brief); the queue writes a new one that waits", async () => {
    const s = setup({ pages: ["/", "/pricing"] });
    await liveFirstSet(s);
    modelWriting("b");
    await regenerateOne("acme", "problem", "ai", s.env as never);
    // A never-live cell of a page added later, waiting too.
    await regenerateOne("acme", "problem", "ai", s.env as never, "/pricing");
    const oldWaiting = s.row(KEY("/"))?.pending_body_id as string;
    expect(s.row(KEY("/pricing"))?.status).toBe("pending");

    vi.setSystemTime(T0 + 2 * HOUR);
    await upsertBusinessDna(
      s.env as never,
      {
        customer_id: "acme",
        product: "A planning board for small teams",
        icp: "Team leads of five to twenty",
        value_props: ["One board"],
      } as never,
      { draft: false },
    );
    expect(s.body(oldWaiting)?.discarded_at).toBe(T0 + 2 * HOUR);
    expect(s.row(KEY("/"))).toMatchObject({ status: "stale", pending_body_id: null });
    // The never-live cell is a cell never written again.
    expect(s.row(KEY("/pricing"))).toBeUndefined();

    modelWriting("c");
    vi.setSystemTime(T0 + 3 * HOUR);
    await s.pass();
    await s.pass();
    const now = s.row(KEY("/"));
    expect(now?.status).toBe("ready");
    expect(now?.pending_body_id).not.toBe(oldWaiting);
    expect(
      JSON.parse(s.body(now?.pending_body_id as string)?.body_json ?? "{}").sections.hero.headline,
    ).toBe(WORDS.c[0]);
    expect(s.row(KEY("/pricing"))?.status).toBe("pending");
    expect(s.served(KEY("/"))?.sections.hero.headline).toBe(WORDS.a[0]);
  });

  it("a page added later: its first bodies wait, nothing reaches KV, the loop and the queue leave them", async () => {
    const s = setup({ pages: ["/", "/pricing"] });
    modelWriting("a");
    const run = await orchestrate("acme", s.env as never, {});
    expect(run.generated).toBe(12);
    expect(run.waiting).toBe(6);
    expect(s.served(KEY("/"))).not.toBeNull();
    expect(s.served(KEY("/pricing"))).toBeNull();
    expect(s.row(KEY("/pricing"))).toMatchObject({ status: "pending", body_id: null });

    // The list shows the page's cells as waiting; the summary does not count them written.
    const list = await s.call("GET", "/admin/variants/list?customer_id=acme&summary=1");
    const pricing = (list.json.items as Array<Record<string, unknown>>).filter(
      (i) => i.page_path === "/pricing",
    );
    expect(pricing).toHaveLength(6);
    expect(pricing.every((i) => i.status === "pending" && i.approval === "waiting")).toBe(true);
    expect(list.json.summary).toMatchObject({ written: 6, pending: 6 });

    // The Live screen's own loop: nothing written, nothing spent.
    inputs = [];
    const auto = await s.call("POST", "/admin/variant/regenerate", {
      customer_id: "acme",
      page_path: "/pricing",
      intent_dim: "problem",
      source_dim: "ai",
      auto: true,
    });
    expect(auto.json).toMatchObject({ ok: false, error: "waiting", approval: "waiting" });
    expect(tried()).toBe(0);
    // The queue: nothing due.
    vi.setSystemTime(T0 + 2 * HOUR);
    await s.pass();
    expect(tried()).toBe(0);

    // The pending list: no live body beside the new one.
    const pending = await s.call(
      "GET",
      "/admin/variants/pending?customer_id=acme&page_path=/pricing",
    );
    expect(pending.json.count).toBe(6);
    expect((pending.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      has_live: false,
      live: null,
    });
  });
});

describe("approve and discard", () => {
  it("approve goes through publishVersion: the KV value and variants carry the new body_id, the old body retires", async () => {
    const s = setup();
    await liveFirstSet(s);
    const oldId = s.served(KEY("/"))?.body_id as string;
    modelWriting("b");
    await regenerateOne("acme", "problem", "ai", s.env as never);
    const newId = s.row(KEY("/"))?.pending_body_id as string;

    vi.setSystemTime(T0 + 5 * HOUR);
    const r = await s.call("POST", "/admin/variant/approve", {
      customer_id: "acme",
      intent_dim: "problem",
      source_dim: "ai",
    });
    expect(r).toMatchObject({
      status: 200,
      json: { ok: true, page_path: "/", intent_dim: "problem", source_dim: "ai", pending_left: 0 },
    });
    expect(JSON.stringify(r.json)).not.toContain("body_id");
    // What an exposure reports from now on resolves to the approved words.
    const live = s.served(KEY("/"));
    expect(live?.body_id).toBe(newId);
    expect(live?.sections.hero.headline).toBe(WORDS.b[0]);
    expect(s.row(KEY("/"))).toMatchObject({
      status: "ready",
      body_id: newId,
      pending_body_id: null,
    });
    expect(s.body(newId)).toMatchObject({
      live_from: T0 + 5 * HOUR,
      retired_at: null,
      discarded_at: null,
    });
    expect(s.body(oldId)).toMatchObject({ retired_at: T0 + 5 * HOUR });
    // Nothing left to approve.
    const again = await s.call("POST", "/admin/variant/approve", {
      customer_id: "acme",
      intent_dim: "problem",
      source_dim: "ai",
    });
    expect(again).toMatchObject({ status: 404, json: { error: "nothing_waiting" } });
    // A superadmin is told the id.
    sessionUser = SUPERADMIN;
    modelWriting("c");
    await regenerateOne("acme", "problem", "ai", s.env as never);
    const admin = await s.call("POST", "/admin/variant/approve", {
      customer_id: "acme",
      intent_dim: "problem",
      source_dim: "ai",
    });
    expect(admin.json.body_id).toBe(s.served(KEY("/"))?.body_id);
  });

  it("approve a cell that never had a body: it goes live", async () => {
    const s = setup({ pages: ["/", "/pricing"] });
    modelWriting("a");
    await orchestrate("acme", s.env as never, {});
    const waiting = s.row(KEY("/pricing"))?.pending_body_id;
    const r = await s.call("POST", "/admin/variant/approve", {
      customer_id: "acme",
      page_path: "/pricing",
      intent_dim: "problem",
      source_dim: "ai",
    });
    expect(r.status).toBe(200);
    expect(s.served(KEY("/pricing"))?.body_id).toBe(waiting);
    expect(s.row(KEY("/pricing"))).toMatchObject({ status: "ready", body_id: waiting });
  });

  it("approve-all for a page approves that page only", async () => {
    const s = setup({ pages: ["/", "/pricing"] });
    await liveFirstSet(s);
    modelWriting("b");
    await regenerateOne("acme", "problem", "ai", s.env as never);
    await regenerateOne("acme", "problem", "social", s.env as never);
    for (const src of ["default", "ai", "social"]) {
      await regenerateOne("acme", "problem", src, s.env as never, "/pricing");
    }
    const r = await s.call("POST", "/admin/variants/approve-all", {
      customer_id: "acme",
      page_path: "/pricing",
    });
    expect(r).toMatchObject({
      status: 200,
      json: { ok: true, page_path: "/pricing", approved: 6, failed: 0, pending_left: 2 },
    });
    expect(s.served(KEY("/pricing", "social"))?.sections.hero.headline).toBe(WORDS.b[0]);
    expect(s.served(KEY("/", "social"))?.sections.hero.headline).toBe(WORDS.a[0]);
    // Every page when none is named.
    const all = await s.call("POST", "/admin/variants/approve-all", { customer_id: "acme" });
    expect(all.json).toMatchObject({ approved: 2, pending_left: 0 });
    expect(s.served(KEY("/", "social"))?.sections.hero.headline).toBe(WORDS.b[0]);
  });

  it("discard keeps the live body; the queue does not write it again", async () => {
    const s = setup();
    await liveFirstSet(s);
    const liveId = s.served(KEY("/"))?.body_id;
    modelWriting("b");
    await regenerateOne("acme", "problem", "ai", s.env as never);
    const waiting = s.row(KEY("/"))?.pending_body_id as string;
    vi.setSystemTime(T0 + 4 * HOUR);
    const r = await s.call("POST", "/admin/variant/discard", {
      customer_id: "acme",
      intent_dim: "problem",
      source_dim: "ai",
    });
    expect(r).toMatchObject({ status: 200, json: { ok: true, pending_left: 0 } });
    expect(s.served(KEY("/"))?.body_id).toBe(liveId);
    expect(s.row(KEY("/"))).toMatchObject({
      status: "ready",
      body_id: liveId,
      pending_body_id: null,
    });
    expect(s.body(waiting)?.discarded_at).toBe(T0 + 4 * HOUR);
    await s.pass();
    expect(tried()).toBe(0);
    // Discarded words that come back wait again.
    await regenerateOne("acme", "problem", "ai", s.env as never);
    expect(s.row(KEY("/"))?.pending_body_id).toBe(waiting);
    expect(s.body(waiting)?.discarded_at).toBeNull();
  });

  it("discard on a cell that never had a body: neither the loop nor the queue writes it; a rewrite by hand does", async () => {
    const s = setup({ pages: ["/", "/pricing"] });
    modelWriting("a");
    await orchestrate("acme", s.env as never, {});
    await s.call("POST", "/admin/variant/discard", {
      customer_id: "acme",
      page_path: "/pricing",
      intent_dim: "problem",
      source_dim: "ai",
    });
    expect(s.row(KEY("/pricing"))).toMatchObject({ status: "discarded", pending_body_id: null });
    expect(s.served(KEY("/pricing"))).toBeNull();
    inputs = [];
    const auto = await s.call("POST", "/admin/variant/regenerate", {
      customer_id: "acme",
      page_path: "/pricing",
      intent_dim: "problem",
      source_dim: "ai",
      auto: true,
    });
    expect(auto.json).toMatchObject({ ok: false, error: "waiting", approval: "discarded" });
    await s.pass();
    expect(tried()).toBe(0);
    // The customer's own Rewrite: a model call, one of the day's, and it waits.
    modelWriting("b");
    const by = await s.call("POST", "/admin/variant/regenerate", {
      customer_id: "acme",
      page_path: "/pricing",
      intent_dim: "problem",
      source_dim: "ai",
    });
    expect(by.json).toMatchObject({ ok: true, pending: true, rewrites_left: 9 });
    expect(s.row(KEY("/pricing"))?.status).toBe("pending");
  });

  it("refusals: nothing waiting, another customer's cell, unknown names", async () => {
    const s = setup();
    await liveFirstSet(s);
    const none = await s.call("POST", "/admin/variant/discard", {
      customer_id: "acme",
      intent_dim: "problem",
      source_dim: "ai",
    });
    expect(none).toMatchObject({ status: 404, json: { error: "nothing_waiting" } });
    const other = await s.call("POST", "/admin/variant/approve", {
      customer_id: "beta",
      intent_dim: "problem",
      source_dim: "ai",
    });
    expect(other.status).toBe(403);
    expect((await s.call("GET", "/admin/variants/pending?customer_id=beta")).status).toBe(403);
    expect(
      (await s.call("POST", "/admin/customers/auto-approve", { customer_id: "beta", on: true }))
        .status,
    ).toBe(403);
    const bad = await s.call("POST", "/admin/variant/approve", {
      customer_id: "acme",
      intent_dim: "pricing; drop",
      source_dim: "ai",
    });
    expect(bad.status).toBe(400);
    const notBool = await s.call("POST", "/admin/customers/auto-approve", {
      customer_id: "acme",
      on: "yes",
    });
    expect(notBool.status).toBe(400);
  });
});

describe("partsBeside", () => {
  it("pairs each part's primary words, leaving kind, links and the other lengths out", () => {
    const live = {
      sections: { hero: { kind: "hero", headline: "Old", headline_alt: "Older", body: "B" } },
    };
    const next = {
      sections: { hero: { kind: "hero", headline: "New", body_alt2: "x" }, cta: { label: "Go" } },
    };
    expect(partsBeside(live as never, next as never)).toEqual([
      { path: "hero.headline", live: "Old", new: "New" },
      { path: "cta.label", live: null, new: "Go" },
      { path: "hero.body", live: "B", new: null },
    ]);
  });
});
