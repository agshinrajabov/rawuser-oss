/**
 * A refused row is not paid for on every pass (J5 of
 * docs/specs/pilot-gaps.md; docs/specs/refused-versions.md).
 *
 * An error never moves `generated_at`, so once six hours had passed since a
 * row's last ready write, a row that still failed was tried on every
 * five-minute pass. Production on 2026-10-12: the pilot's `problem:community`
 * and `brand:community`, last ready at 02:50 UTC, refused on the rewrite.
 * The last failed try now has its own time, in KV, and the queue reads it.
 *
 * SQLite with every migration and the queue's own options, so the queue's
 * real statement and the real marker decide which rows are tried.
 */
import type { Manifest } from "@rawuser/shared";
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

// One served intent: six rows (its default and the five sources).
vi.mock("../src/site-map/served-load.ts", () => ({
  loadServedIntents: vi.fn(async () => ["problem"]),
}));

const { orchestrate, regenerateOne } = await import("../src/orchestrator.ts");
const { QUEUE_ERROR_RETRY_MS, lockKey, runRegenQueue } = await import("../src/cron/regen-queue.ts");
const { QUEUE_PASS_MS, TRIED_TTL_S, nextTryAt, triedKey, triedPrefix, triedWithin } = await import(
  "../src/lib/tried-marker.ts"
);
const { handleVariantRegenerate, handleVariantsList, handleVariantsStaleAll } = await import(
  "../src/admin/handlers.ts"
);
const { KV_GROUPS } = await import("../src/admin/customer-data.ts");
const { resetPageLinks } = await import("../src/page-links.ts");
const { resetReads } = await import("../src/inline-shape-backfill.ts");

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

const version = (prompt: string, headline: string, body: string) =>
  JSON.stringify({
    customer_id: "acme",
    profile_key: `intent:${/"intent:(\w+)"/.exec(prompt)?.[1] ?? "problem"}`,
    sections: { hero: { kind: "hero", headline, body } },
    generated_at: 1,
    prompt_hash: "",
  });

const LONG_HEAD = "Plan the whole week of your whole team in one calm and quiet place";
const LONG_BODY =
  "Tasks, notes and deadlines of the whole team on a single board that everybody opens every morning.";
/** Both parts far over their caps on every call: the copy checks refuse the row. */
function modelRefused() {
  let last = "";
  answerFor = (input) => {
    if (input.prompt.includes("It cannot go on the page as it is")) {
      return JSON.stringify({ text: input.prompt.includes("headline") ? LONG_HEAD : LONG_BODY });
    }
    if (input.prompt.includes("Revise the JSON object")) return last;
    if (!input.prompt.includes("profile_key")) return "{}";
    last = version(input.prompt, LONG_HEAD, LONG_BODY);
    return last;
  };
}
function modelGood() {
  let last = "";
  answerFor = (input) => {
    if (input.prompt.includes("Revise the JSON object")) return last;
    if (!input.prompt.includes("profile_key")) return "{}";
    last = version(
      input.prompt,
      "See the whole week in one place",
      "The tasks, notes and deadlines of your team sit on one board.",
    );
    return last;
  };
}
function modelDown() {
  answerFor = () => {
    throw new Error("Timeout after 45000ms");
  };
}

/** The first calls of a pass: one per row the pass tried. */
const tried = () => inputs.filter((i) => i.prompt.includes("profile_key:")).length;

const T0 = Date.UTC(2026, 9, 12, 2, 50, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

function setup() {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    `INSERT INTO customers (id, slug, domain, plan, status, created_at, auto_approve, live_at, site_map_off)
     VALUES ('acme', 'acme', 'acme.test', 'pilot', 'active', 1, 1, 2, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO business_dna (customer_id, product, icp, brand_voice, updated_at, value_props, differentiators, proof_points, target_market, target_language, per_intent_hints)
     VALUES ('acme', 'A planning board for small teams', 'Team leads', 'calm', 1, '["One board"]', '["Calm"]', '["Teams use it"]', 'Global', 'en', '{}')`,
  ).run();
  db.prepare(
    "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('acme', '/', ?, 'https://acme.test/', 1, 1, 'en')",
  ).run(JSON.stringify(MANIFEST));
  const kv = makeKv();
  /** Every put with its options, to read the marker's lifetime. */
  const puts: Array<{ key: string; ttl: number | undefined }> = [];
  const put = kv.put.bind(kv);
  (kv as { put: unknown }).put = async (
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ) => {
    puts.push({ key, ttl: opts?.expirationTtl });
    return put(key, value);
  };
  const env = { ...MODEL_ENV, DB: d1, VARIANTS: kv, ADMIN_ORIGIN: "*" };
  /** One pass of the five-minute queue, as the cron runs it. */
  const pass = async () => {
    inputs = [];
    return runRegenQueue(env as never, (id, e, o) => orchestrate(id, e, o));
  };
  const statuses = () =>
    (db.prepare("SELECT status FROM variants").all() as Array<{ status: string }>).map(
      (r) => r.status,
    );
  const markers = () => [...kv.store.keys()].filter((k) => k.startsWith("gen:tried:"));
  return { env, db, kv, puts, pass, statuses, markers };
}

/** Six ready rows written at T0, as after a go live that went well. */
async function allReadyAtT0(s: ReturnType<typeof setup>) {
  modelGood();
  await orchestrate("acme", s.env as never, {});
  expect(s.statuses()).toEqual(Array(6).fill("ready"));
  expect(s.markers()).toEqual([]);
}

beforeEach(() => {
  inputs = [];
  resetPageLinks();
  resetReads();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a row that still fails past its six hours", () => {
  it("as production stood on 2026-10-12: tried once at 6 h 01, then not again for six hours", async () => {
    const s = setup();
    await allReadyAtT0(s);
    // The rewrite an hour later is refused. The code of that morning kept no
    // time of the try: the rows are errors with nothing in KV.
    vi.setSystemTime(T0 + HOUR);
    s.db.prepare("UPDATE variants SET status = 'stale'").run();
    modelRefused();
    await s.pass();
    expect(s.statuses()).toEqual(Array(6).fill("error"));
    for (const k of s.markers()) s.kv.store.delete(k);

    // Inside six hours of the last ready write the old rule holds them.
    vi.setSystemTime(T0 + 6 * HOUR - MIN);
    await s.pass();
    expect(tried()).toBe(0);

    // 6 h 01: tried, and refused again.
    vi.setSystemTime(T0 + 6 * HOUR + MIN);
    await s.pass();
    expect(tried()).toBe(6);
    expect(s.markers()).toHaveLength(6);

    // Every pass of the next six hours leaves them alone. Before: six
    // versions paid for on each of these.
    for (const after of [5 * MIN, 10 * MIN, HOUR, 3 * HOUR, 6 * HOUR - 5 * MIN]) {
      vi.setSystemTime(T0 + 6 * HOUR + MIN + after);
      await s.pass();
      expect(tried()).toBe(0);
    }

    // Six hours after that try: once more, then quiet again.
    vi.setSystemTime(T0 + 12 * HOUR + 2 * MIN);
    await s.pass();
    expect(tried()).toBe(6);
    vi.setSystemTime(T0 + 12 * HOUR + 7 * MIN);
    await s.pass();
    expect(tried()).toBe(0);
  });

  it("a rewrite refused more than six hours after the last ready write waits from its first failure", async () => {
    const s = setup();
    await allReadyAtT0(s);
    vi.setSystemTime(T0 + 7 * HOUR);
    s.db.prepare("UPDATE variants SET status = 'stale'").run();
    modelRefused();
    await s.pass();
    expect(tried()).toBe(6);
    // Before: every pass from here on.
    vi.setSystemTime(T0 + 7 * HOUR + 5 * MIN);
    await s.pass();
    expect(tried()).toBe(0);
    vi.setSystemTime(T0 + 13 * HOUR - MIN);
    await s.pass();
    expect(tried()).toBe(0);
    vi.setSystemTime(T0 + 13 * HOUR);
    await s.pass();
    expect(tried()).toBe(6);
  });

  it("is written when the model lands it on that one try, and the row is ready", async () => {
    const s = setup();
    await allReadyAtT0(s);
    vi.setSystemTime(T0 + 7 * HOUR);
    s.db.prepare("UPDATE variants SET status = 'stale'").run();
    modelRefused();
    await s.pass();
    vi.setSystemTime(T0 + 13 * HOUR);
    modelGood();
    await s.pass();
    expect(tried()).toBe(6);
    expect(s.statuses()).toEqual(Array(6).fill("ready"));
  });

  it("a provider that does not answer is one try in six hours too", async () => {
    const s = setup();
    await allReadyAtT0(s);
    vi.setSystemTime(T0 + 7 * HOUR);
    s.db.prepare("UPDATE variants SET status = 'stale'").run();
    modelDown();
    await s.pass();
    expect(tried()).toBe(6);
    expect(s.statuses()).toEqual(Array(6).fill("error"));
    vi.setSystemTime(T0 + 7 * HOUR + 5 * MIN);
    modelGood();
    await s.pass();
    expect(tried()).toBe(0);
    vi.setSystemTime(T0 + 13 * HOUR);
    await s.pass();
    expect(tried()).toBe(6);
    expect(s.statuses()).toEqual(Array(6).fill("ready"));
  });
});

describe("the first write's early retry (J2) is as it was", () => {
  it("first failure, the next pass, then six hours, then one try and six hours again", async () => {
    const s = setup();
    modelRefused();
    inputs = [];
    await orchestrate("acme", s.env as never, {});
    expect(s.statuses()).toEqual(Array(6).fill("error"));
    // The first failure left its time too, and the early retry is not held by it.
    expect(s.markers()).toHaveLength(6);

    vi.setSystemTime(T0 + 5 * MIN);
    await s.pass();
    expect(tried()).toBe(6);
    vi.setSystemTime(T0 + 10 * MIN);
    await s.pass();
    expect(tried()).toBe(0);
    vi.setSystemTime(T0 + 6 * HOUR);
    await s.pass();
    expect(tried()).toBe(0);

    // Six hours after the early retry: one try.
    vi.setSystemTime(T0 + 6 * HOUR + 5 * MIN);
    await s.pass();
    expect(tried()).toBe(6);
    // Before: again here, and on every pass after.
    vi.setSystemTime(T0 + 6 * HOUR + 10 * MIN);
    await s.pass();
    expect(tried()).toBe(0);
    vi.setSystemTime(T0 + 9 * HOUR);
    await s.pass();
    expect(tried()).toBe(0);
  });
});

describe("what the operator asks for by hand", () => {
  it("a regenerate of one version ignores the marker, and a failure renews it", async () => {
    const s = setup();
    await allReadyAtT0(s);
    vi.setSystemTime(T0 + 7 * HOUR);
    s.db.prepare("UPDATE variants SET status = 'stale'").run();
    modelRefused();
    await s.pass();
    const key = "v1:variant:acme:problem:ai";
    expect(await triedWithin(s.kv, key, QUEUE_ERROR_RETRY_MS)).toBe(true);

    // Two hours on the operator presses Regenerate on that version.
    vi.setSystemTime(T0 + 9 * HOUR);
    inputs = [];
    const failed = await regenerateOne("acme", "problem", "ai", s.env as never, "/");
    expect(tried()).toBe(1);
    expect(failed.ok).toBe(false);
    expect(s.kv.store.get(triedKey(key))).toBe(String(T0 + 9 * HOUR));

    // The queue counts its six hours from that try: the other five at 13 h, this one at 15 h.
    vi.setSystemTime(T0 + 13 * HOUR);
    await s.pass();
    expect(tried()).toBe(5);
    vi.setSystemTime(T0 + 15 * HOUR);
    modelGood();
    await s.pass();
    expect(tried()).toBe(1);
  });

  it("a regenerate that succeeds writes the row whatever the marker says", async () => {
    const s = setup();
    await allReadyAtT0(s);
    vi.setSystemTime(T0 + 7 * HOUR);
    s.db.prepare("UPDATE variants SET status = 'stale'").run();
    modelRefused();
    await s.pass();
    vi.setSystemTime(T0 + 7 * HOUR + 10 * MIN);
    modelGood();
    inputs = [];
    const ok = await regenerateOne("acme", "problem", "ai", s.env as never, "/");
    expect(ok.ok).toBe(true);
    const row = s.db
      .prepare("SELECT status FROM variants WHERE kv_key = 'v1:variant:acme:problem:ai'")
      .get() as { status: string };
    expect(row.status).toBe("ready");
  });

  it("Rewrite everything forgets the markers, so the next pass tries the refused rows", async () => {
    const s = setup();
    await allReadyAtT0(s);
    vi.setSystemTime(T0 + 7 * HOUR);
    s.db.prepare("UPDATE variants SET status = 'stale'").run();
    modelRefused();
    await s.pass();
    expect(s.markers()).toHaveLength(6);

    vi.setSystemTime(T0 + 8 * HOUR);
    const res = await handleVariantsStaleAll(
      new Request("https://api.test/admin/variants/stale-all", {
        method: "POST",
        body: JSON.stringify({ customer_id: "acme" }),
      }),
      s.env as never,
      { role: "superadmin", customer_id: null } as never,
    );
    expect(res.status).toBe(200);
    expect(s.markers()).toEqual([]);
    modelGood();
    await s.pass();
    expect(tried()).toBe(6);
    expect(s.statuses()).toEqual(Array(6).fill("ready"));
  });
});

describe("the marker itself", () => {
  it("is one KV value per row under the queue's own prefix, gone by itself after six hours", async () => {
    const s = setup();
    modelRefused();
    await orchestrate("acme", s.env as never, {});
    const written = s.puts.filter((p) => p.key.startsWith("gen:tried:"));
    expect(written).toHaveLength(6);
    expect(written.every((p) => p.ttl === TRIED_TTL_S)).toBe(true);
    expect(TRIED_TTL_S * 1000).toBe(QUEUE_ERROR_RETRY_MS);
    expect(s.markers().sort()).toEqual(
      ["ai", "community", "default", "organic", "paid", "social"].map(
        (src) => `gen:tried:v1:variant:acme:problem:${src}`,
      ),
    );
    // The value is the time of the try and nothing else.
    expect(new Set(s.markers().map((k) => s.kv.store.get(k)))).toEqual(new Set([String(T0)]));
  });

  it("is under no key the edge reads, and goes with the customer", () => {
    const key = triedKey("v1:variant:acme:p:%2Fpricing:problem:ai");
    expect(key.startsWith("v1:")).toBe(false);
    expect(key.startsWith(lockKey("acme"))).toBe(false);
    expect(key.startsWith(triedPrefix("acme"))).toBe(true);
    expect(triedKey("v1:variant:acme-two:problem:ai").startsWith(triedPrefix("acme"))).toBe(false);
    const group = KV_GROUPS.find((g) => g.group === "write_tried");
    expect(group?.exact).toBe(false);
    expect(group?.key("acme")).toBe(triedPrefix("acme"));
  });

  it("a ready write and a preview leave none", async () => {
    const s = setup();
    await allReadyAtT0(s);
    modelRefused();
    const preview = await regenerateOne("acme", "problem", "ai", s.env as never, "/", {
      preview: { manifest: MANIFEST, kvKey: "v1:preview:acme:x", ttlSeconds: 60 },
    });
    expect(preview.ok).toBe(false);
    expect(s.markers()).toEqual([]);
  });

  it("KV that does not answer costs nothing but the old behaviour", async () => {
    const s = setup();
    await allReadyAtT0(s);
    const down = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    } as unknown as KVNamespace;
    expect(await triedWithin(down, "v1:variant:acme:problem:ai", QUEUE_ERROR_RETRY_MS)).toBe(false);
    // A value that is not a time says nothing.
    s.kv.store.set(triedKey("v1:variant:acme:problem:ai"), "soon");
    expect(await triedWithin(s.kv, "v1:variant:acme:problem:ai", QUEUE_ERROR_RETRY_MS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// J9: the Live screen's own loop honours the marker. J8: the read says when.
// ---------------------------------------------------------------------------

const SUPER = { role: "superadmin", customer_id: null } as never;

/** The endpoint as the dashboard calls it: `auto` only from the Live screen's loop. */
async function regenerate(
  env: unknown,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handleVariantRegenerate(
    new Request("https://api.test/admin/variant/regenerate", {
      method: "POST",
      body: JSON.stringify({ customer_id: "acme", source_dim: "ai", ...body }),
    }),
    env as never,
    SUPER,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

interface RefusedRowJson {
  intent_dim: string;
  source_dim: string;
  next_try?: number;
}

async function refusedRows(env: unknown): Promise<RefusedRowJson[]> {
  const res = await handleVariantsList(
    new Request("https://api.test/admin/variants/list?customer_id=acme&summary=1"),
    env as never,
    SUPER,
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { summary: { refused_rows: RefusedRowJson[] } };
  return json.summary.refused_rows;
}

/** The refused rows of a rewrite at T0 + 7 h, every marker at that time. */
async function refusedRewriteAt7h(s: ReturnType<typeof setup>) {
  await allReadyAtT0(s);
  vi.setSystemTime(T0 + 7 * HOUR);
  s.db.prepare("UPDATE variants SET status = 'stale'").run();
  modelRefused();
  await s.pass();
  expect(s.statuses()).toEqual(Array(6).fill("error"));
}

describe("the Live screen's own loop (J9)", () => {
  it("an automatic call for a row with a fresh marker makes no model call and says when the queue tries next", async () => {
    const s = setup();
    await refusedRewriteAt7h(s);
    const key = "v1:variant:acme:problem:ai";

    // The operator opens the Live screen two hours later; its loop asks for
    // every version that is not ready, as on every page load.
    vi.setSystemTime(T0 + 9 * HOUR);
    inputs = [];
    const { status, json } = await regenerate(s.env, { intent_dim: "problem", auto: true });
    expect(status).toBe(200);
    expect(tried()).toBe(0);
    expect(inputs).toEqual([]);
    expect(json).toMatchObject({
      customer_id: "acme",
      intent_dim: "problem",
      source_dim: "ai",
      kv_key: key,
      ok: false,
      error: "waiting",
      cost_usd: 0,
    });
    // Six hours from the failed try at 09:50 UTC: the pass at 15:50.
    expect(json.next_try).toBe(T0 + 13 * HOUR);
    // The marker is as the queue wrote it; the answer did not renew it.
    expect(s.kv.store.get(triedKey(key))).toBe(String(T0 + 7 * HOUR));
    expect(s.statuses()).toEqual(Array(6).fill("error"));
  });

  it("the same automatic call with no marker writes", async () => {
    const s = setup();
    await refusedRewriteAt7h(s);
    const key = "v1:variant:acme:problem:ai";
    s.kv.store.delete(triedKey(key));
    vi.setSystemTime(T0 + 9 * HOUR);
    modelGood();
    inputs = [];
    const { status, json } = await regenerate(s.env, { intent_dim: "problem", auto: true });
    expect(status).toBe(200);
    expect(tried()).toBe(1);
    expect(json.ok).toBe(true);
    const row = s.db.prepare("SELECT status FROM variants WHERE kv_key = ?").get(key) as {
      status: string;
    };
    expect(row.status).toBe("ready");
  });

  it("a marker older than six hours does not hold an automatic call", async () => {
    const s = setup();
    await refusedRewriteAt7h(s);
    vi.setSystemTime(T0 + 13 * HOUR + MIN);
    modelGood();
    inputs = [];
    const { json } = await regenerate(s.env, { intent_dim: "problem", auto: true });
    expect(tried()).toBe(1);
    expect(json.ok).toBe(true);
  });

  it("an explicit call (no auto, every caller from before) ignores the marker and writes at once", async () => {
    const s = setup();
    await refusedRewriteAt7h(s);
    vi.setSystemTime(T0 + 9 * HOUR);
    modelGood();
    inputs = [];
    const plain = await regenerate(s.env, { intent_dim: "problem" });
    expect(tried()).toBe(1);
    expect(plain.json.ok).toBe(true);

    // `auto: false` is the same as leaving it out.
    inputs = [];
    const off = await regenerate(s.env, {
      intent_dim: "problem",
      source_dim: "social",
      auto: false,
    });
    expect(tried()).toBe(1);
    expect(off.json.ok).toBe(true);
  });

  it("a first write the queue will retry at once answers the next pass as its time", async () => {
    const s = setup();
    modelRefused();
    inputs = [];
    await orchestrate("acme", s.env as never, {});
    expect(s.statuses()).toEqual(Array(6).fill("error"));
    // One minute after the first failure the Live screen loads again.
    vi.setSystemTime(T0 + MIN);
    inputs = [];
    const { json } = await regenerate(s.env, { intent_dim: "problem", auto: true });
    expect(tried()).toBe(0);
    expect(json.error).toBe("waiting");
    expect(json.next_try).toBe(T0 + 5 * MIN);
  });
});

describe("the read says when a refused row is tried next (J8)", () => {
  it("carries next_try only on a refused row with a marker, from the marker and the six-hour rule", async () => {
    const s = setup();
    await refusedRewriteAt7h(s);
    // One row's marker is gone (older than six hours, or never written).
    s.kv.store.delete(triedKey("v1:variant:acme:problem:social"));
    vi.setSystemTime(T0 + 9 * HOUR);
    const rows = await refusedRows(s.env);
    expect(rows).toHaveLength(6);
    const byCell = Object.fromEntries(rows.map((r) => [`${r.intent_dim}:${r.source_dim}`, r]));
    expect(byCell["problem:ai"]?.next_try).toBe(T0 + 13 * HOUR);
    expect(byCell["problem:default"]?.next_try).toBe(T0 + 13 * HOUR);
    expect("next_try" in (byCell["problem:social"] ?? {})).toBe(false);
  });

  it("a first write not yet retried says the next pass; after its early retry, six hours from it", async () => {
    const s = setup();
    modelRefused();
    inputs = [];
    await orchestrate("acme", s.env as never, {});
    vi.setSystemTime(T0 + 2 * MIN);
    let rows = await refusedRows(s.env);
    expect(rows.map((r) => r.next_try)).toEqual(Array(6).fill(T0 + 5 * MIN));

    // The early retry at 02:55 fails too: the row is marked, and waits.
    vi.setSystemTime(T0 + 5 * MIN);
    await s.pass();
    expect(tried()).toBe(6);
    vi.setSystemTime(T0 + 6 * MIN);
    rows = await refusedRows(s.env);
    expect(rows.map((r) => r.next_try)).toEqual(Array(6).fill(T0 + 6 * HOUR + 5 * MIN));
  });

  it("a provider failure is not a refused row and carries nothing new", async () => {
    const s = setup();
    await allReadyAtT0(s);
    vi.setSystemTime(T0 + 7 * HOUR);
    s.db.prepare("UPDATE variants SET status = 'stale'").run();
    modelDown();
    await s.pass();
    expect(await refusedRows(s.env)).toEqual([]);
  });

  it("nextTryAt: the queue's rule in one function", () => {
    const at = (h: number, m: number) => Date.UTC(2026, 9, 12, h, m);
    const SIX = 6 * HOUR;
    // Six hours from the later clock, on the first pass at or after it.
    expect(
      nextTryAt({ generatedAt: at(2, 50), triedAt: at(9, 50), firstWriteDue: false }, at(11, 50)),
    ).toBe(at(15, 50));
    expect(
      nextTryAt({ generatedAt: at(2, 50), triedAt: at(9, 52), firstWriteDue: false }, at(11, 50)),
    ).toBe(at(15, 55));
    expect(
      nextTryAt({ generatedAt: at(9, 51), triedAt: at(9, 50), firstWriteDue: false }, at(11, 50)),
    ).toBe(at(15, 55));
    // The wait has passed: the next pass.
    expect(
      nextTryAt(
        { generatedAt: at(2, 50), triedAt: at(2, 50), firstWriteDue: false },
        at(2, 50) + SIX + 2 * MIN,
      ),
    ).toBe(at(8, 55));
    expect(
      nextTryAt({ generatedAt: at(2, 50), triedAt: null, firstWriteDue: false }, at(2, 50) + SIX),
    ).toBe(at(8, 55));
    // The first write's early retry: the next pass, whatever the clocks.
    expect(
      nextTryAt({ generatedAt: at(2, 50), triedAt: at(2, 50), firstWriteDue: true }, at(2, 50)),
    ).toBe(at(2, 55));
    expect(
      nextTryAt({ generatedAt: at(2, 50), triedAt: at(2, 50), firstWriteDue: true }, at(2, 51)),
    ).toBe(at(2, 55));
    expect(QUEUE_PASS_MS).toBe(5 * MIN);
  });
});
