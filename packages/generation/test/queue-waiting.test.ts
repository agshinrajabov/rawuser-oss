/**
 * A customer whose rows are all waiting is not picked and not read (J7 of
 * docs/specs/pilot-gaps.md).
 *
 * The five-minute queue picked every customer with a row that was not ready.
 * A refused row waits six hours for its next try (lib/tried-marker.ts), and
 * for those six hours its customer was picked on every pass: the pass read
 * every confirmed page from our server again (the live read that refreshes
 * lengths and records `manifest_health`) and then wrote nothing.
 *
 * SQLite with every migration, the queue's own pick and the real pass. The
 * page read and the model are the only stubs, and both count their calls.
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

/** Every page our server read from the customer's site. */
let pageReads: string[] = [];
const PAGE_HTML = `<html lang="en"><body><main><section class="hero"><h1>Plan the week in one calm place</h1>
<p class="lead">Tasks, notes and deadlines of the whole team on a single board.</p></section></main></body></html>`;
vi.mock("../src/detect-elements.ts", async (actual) => ({
  ...(await actual<typeof import("../src/detect-elements.ts")>()),
  fetchPageHtml: vi.fn(async (url: string) => {
    pageReads.push(url);
    return PAGE_HTML;
  }),
}));

// One served intent: six rows (its default and the five sources). The pick
// and the pass read the served set through this one function.
vi.mock("../src/site-map/served-load.ts", () => ({
  loadServedIntents: vi.fn(async () => ["problem"]),
}));

const { orchestrate } = await import("../src/orchestrator.ts");
const { queueCustomers, runRegenQueue, QUEUE_ERROR_RETRY_MS } = await import(
  "../src/cron/regen-queue.ts"
);
const { hasDueWork, writtenPages } = await import("../src/lib/queue-due.ts");
const { triedKey } = await import("../src/lib/tried-marker.ts");
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

/** The first calls of a pass: one per row the pass tried. */
const tried = () => inputs.filter((i) => i.prompt.includes("profile_key:")).length;

const T0 = Date.UTC(2026, 9, 12, 2, 50, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY = (cell: string) => `v1:variant:acme:problem:${cell}`;
/**
 * What one pass that runs the customer reads from its site: the live read of
 * each confirmed page (inline-shape-backfill.ts) and the home page once more
 * for the style samples (page-samples.ts, which keeps no memory between
 * passes).
 */
const PASS_READS = ["https://acme.test/", "https://acme.test"];

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
  const env = { ...MODEL_ENV, DB: d1, VARIANTS: kv, ADMIN_ORIGIN: "*" };
  /**
   * One pass of the five-minute queue as the cron runs it, in an isolate
   * that has read nothing yet (a cron invocation rarely meets a warm one, and
   * a warm one reads again after ten minutes).
   */
  const pass = async () => {
    inputs = [];
    pageReads = [];
    resetReads();
    return runRegenQueue(env as never, (id, e, o) => orchestrate(id, e, o));
  };
  const pick = () => queueCustomers(d1, kv);
  const statuses = () =>
    (
      db.prepare("SELECT status FROM variants ORDER BY kv_key").all() as Array<{ status: string }>
    ).map((r) => r.status);
  const markers = () => [...kv.store.keys()].filter((k) => k.startsWith("gen:tried:"));
  const healthAt = () =>
    (
      db.prepare("SELECT checked_at FROM manifest_health WHERE customer_id = 'acme'").get() as
        | { checked_at: number }
        | undefined
    )?.checked_at ?? null;
  return { env, d1, db, kv, pass, pick, statuses, markers, healthAt };
}

/** Six ready rows written at T0, then a rewrite at `at` that the checks refuse. */
async function refusedAt(s: ReturnType<typeof setup>, at: number) {
  modelGood();
  await orchestrate("acme", s.env as never, {});
  expect(s.statuses()).toEqual(Array(6).fill("ready"));
  vi.setSystemTime(at);
  s.db.prepare("UPDATE variants SET status = 'stale'").run();
  modelRefused();
  const r = await s.pass();
  expect(r.ran).toEqual(["acme"]);
  expect(s.statuses()).toEqual(Array(6).fill("error"));
  expect(s.markers()).toHaveLength(6);
}

let network = 0;
beforeEach(() => {
  inputs = [];
  pageReads = [];
  network = 0;
  resetPageLinks();
  resetReads();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      network++;
      return new Response("", { status: 404 });
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("every row that is not ready is waiting", () => {
  it("marked tried: not picked, no page read, no model call, on every pass of the six hours", async () => {
    const s = setup();
    await refusedAt(s, T0 + 7 * HOUR);
    const health = s.healthAt();
    expect(health).toBe(T0 + 7 * HOUR);

    // Before: picked on each of these, and the home page read twice each time.
    for (const after of [5 * MIN, 10 * MIN, 15 * MIN, HOUR, 3 * HOUR, 6 * HOUR - 5 * MIN]) {
      vi.setSystemTime(T0 + 7 * HOUR + after);
      expect(await s.pick()).toEqual([]);
      const r = await s.pass();
      expect(r).toEqual({ ran: [], locked: [], capped: [] });
      expect(pageReads).toEqual([]);
      expect(network).toBe(0);
      expect(inputs).toEqual([]);
    }
    // Nothing read, so nothing recorded about the page either.
    expect(s.healthAt()).toBe(health);
    expect(s.statuses()).toEqual(Array(6).fill("error"));

    // Six hours after the try: due, picked, read, tried.
    vi.setSystemTime(T0 + 13 * HOUR);
    expect(await s.pick()).toEqual(["acme"]);
    const r = await s.pass();
    expect(r.ran).toEqual(["acme"]);
    expect(pageReads).toEqual(PASS_READS);
    expect(tried()).toBe(6);
    expect(s.healthAt()).toBe(T0 + 13 * HOUR);
  });

  it("inside six hours of the last ready write, with no marker: not picked, not read", async () => {
    const s = setup();
    await refusedAt(s, T0 + HOUR);
    // KV lost the markers: the rows' own clock still holds them.
    for (const k of s.markers()) s.kv.store.delete(k);
    vi.setSystemTime(T0 + HOUR + 5 * MIN);
    expect(await s.pick()).toEqual([]);
    await s.pass();
    expect(pageReads).toEqual([]);
    expect(inputs).toEqual([]);

    vi.setSystemTime(T0 + 6 * HOUR + MIN);
    expect(await s.pick()).toEqual(["acme"]);
  });

  it("a first write the checks refused: picked for its one early retry, then left alone", async () => {
    const s = setup();
    modelRefused();
    await orchestrate("acme", s.env as never, {});
    expect(s.statuses()).toEqual(Array(6).fill("error"));

    vi.setSystemTime(T0 + 5 * MIN);
    expect(await s.pick()).toEqual(["acme"]);
    await s.pass();
    expect(tried()).toBe(6);

    for (const after of [10 * MIN, 15 * MIN, 2 * HOUR]) {
      vi.setSystemTime(T0 + after);
      expect(await s.pick()).toEqual([]);
      await s.pass();
      expect(pageReads).toEqual([]);
      expect(inputs).toEqual([]);
    }
  });

  it("a waiting customer does not hold up one with work", async () => {
    const s = setup();
    await refusedAt(s, T0 + 7 * HOUR);
    s.db
      .prepare(
        "INSERT INTO customers (id, slug, domain, plan, status, created_at, auto_approve, live_at, site_map_off) VALUES ('busy', 'busy', 'busy.test', 'pilot', 'active', 1, 1, 2, 1)",
      )
      .run();
    s.db
      .prepare(
        `INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status)
         SELECT 'busy-1', 'busy', profile_id, 'v1:variant:busy:problem:ai', model, prompt_hash, generated_at, cost_usd, 'stale'
         FROM variants LIMIT 1`,
      )
      .run();
    vi.setSystemTime(T0 + 7 * HOUR + 5 * MIN);
    expect(await s.pick()).toEqual(["busy"]);
  });
});

// 2026-10-18: a try the provider never answered cost nothing, so it waits
// fifteen minutes, not six hours.
describe("a row whose model did not answer", () => {
  it("is left alone for fifteen minutes from its try, then tried again and written", async () => {
    const s = setup();
    modelGood();
    await orchestrate("acme", s.env as never, {});
    vi.setSystemTime(T0 + HOUR);
    s.db.prepare("UPDATE variants SET status = 'stale'").run();
    answerFor = () => {
      throw new Error("Model request failed: HTTP 503");
    };
    await s.pass();
    expect(s.statuses()).toEqual(Array(6).fill("error"));
    const reasons = (
      s.db.prepare("SELECT error_reason FROM variants").all() as Array<{ error_reason: string }>
    ).map((r) => r.error_reason);
    expect(reasons.every((r) => r.includes("HTTP 503"))).toBe(true);

    for (const after of [5 * MIN, 10 * MIN, 14 * MIN]) {
      vi.setSystemTime(T0 + HOUR + after);
      expect(await s.pick()).toEqual([]);
    }
    // Inside six hours of the last ready write, yet due: the provider is back.
    vi.setSystemTime(T0 + HOUR + 16 * MIN);
    expect(await s.pick()).toEqual(["acme"]);
    modelGood();
    await s.pass();
    expect(s.statuses()).toEqual(Array(6).fill("ready"));
  });

  it("a refusal by the checks keeps its six hours beside it", async () => {
    const s = setup();
    await refusedAt(s, T0 + 7 * HOUR);
    vi.setSystemTime(T0 + 7 * HOUR + 16 * MIN);
    expect(await s.pick()).toEqual([]);
  });
});

describe("one row due", () => {
  it("an error past its wait among waiting rows: picked, and that one row tried", async () => {
    const s = setup();
    await refusedAt(s, T0 + 7 * HOUR);
    // Its last ready write is seven hours old and its try left no time.
    s.kv.store.delete(triedKey(KEY("ai")));
    vi.setSystemTime(T0 + 7 * HOUR + 5 * MIN);
    expect(await s.pick()).toEqual(["acme"]);
    modelGood();
    const r = await s.pass();
    expect(r.ran).toEqual(["acme"]);
    expect(pageReads).toEqual(PASS_READS);
    expect(tried()).toBe(1);
    expect(s.statuses().filter((x) => x === "ready")).toHaveLength(1);

    // And the customer goes quiet again with its five waiting rows.
    vi.setSystemTime(T0 + 7 * HOUR + 10 * MIN);
    expect(await s.pick()).toEqual([]);
    await s.pass();
    expect(pageReads).toEqual([]);
  });

  it("a stale row among waiting rows: picked, and that one row written", async () => {
    const s = setup();
    await refusedAt(s, T0 + 7 * HOUR);
    s.db.prepare("UPDATE variants SET status = 'stale' WHERE kv_key = ?").run(KEY("social"));
    vi.setSystemTime(T0 + 7 * HOUR + 5 * MIN);
    expect(await s.pick()).toEqual(["acme"]);
    modelGood();
    await s.pass();
    expect(tried()).toBe(1);
    const row = s.db.prepare("SELECT status FROM variants WHERE kv_key = ?").get(KEY("social")) as {
      status: string;
    };
    expect(row.status).toBe("ready");
  });

  it("a stale row alone: picked, as always", async () => {
    const s = setup();
    modelGood();
    await orchestrate("acme", s.env as never, {});
    expect(await s.pick()).toEqual([]);
    s.db.prepare("UPDATE variants SET status = 'stale' WHERE kv_key = ?").run(KEY("default"));
    expect(await s.pick()).toEqual(["acme"]);
  });

  it("a version with no row beside waiting rows is work, as before", async () => {
    const s = setup();
    await refusedAt(s, T0 + 7 * HOUR);
    s.db.prepare("DELETE FROM variants WHERE kv_key = ?").run(KEY("organic"));
    vi.setSystemTime(T0 + 7 * HOUR + 5 * MIN);
    expect(await s.pick()).toEqual(["acme"]);
    modelGood();
    await s.pass();
    expect(tried()).toBe(1);
    expect(s.statuses()).toHaveLength(6);
  });
});

describe("a page added after the first go live (2026-11-10)", () => {
  it("its versions have no rows, and the queue writes them anyway", async () => {
    const s = setup();
    modelGood();
    await orchestrate("acme", s.env as never, {});
    expect(s.statuses()).toEqual(Array(6).fill("ready"));
    expect(await s.pick()).toEqual([]);

    // The operator adds a page and closes the tab before its versions are
    // written: the new cells have no rows at all, and every older row is
    // ready, so no row can name this customer.
    s.db
      .prepare(
        "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('acme', '/pricing', ?, 'https://acme.test/pricing', 1, 1, 'en')",
      )
      .run(JSON.stringify(MANIFEST));
    expect(
      s.db
        .prepare(
          "SELECT COUNT(*) AS n FROM variants WHERE status NOT IN ('ready','pending','discarded')",
        )
        .get(),
    ).toEqual({ n: 0 });

    vi.setSystemTime(T0 + 5 * MIN);
    expect(await s.pick()).toEqual(["acme"]);
    await s.pass();
    expect(s.statuses()).toHaveLength(12);
    expect(s.statuses()).toEqual(Array(12).fill("ready"));
    // And once the page is written the customer goes quiet again.
    expect(await s.pick()).toEqual([]);
  });

  it("a live customer with everything written is not picked and reads nothing", async () => {
    const s = setup();
    modelGood();
    await orchestrate("acme", s.env as never, {});
    vi.setSystemTime(T0 + HOUR);
    expect(await s.pick()).toEqual([]);
    await s.pass();
    expect(pageReads).toEqual([]);
    expect(tried()).toBe(0);
  });
});

describe("what is not work", () => {
  it("a row that is not ready on a page no longer confirmed: no pass writes it, so no pick", async () => {
    const s = setup();
    modelGood();
    await orchestrate("acme", s.env as never, {});
    s.db
      .prepare(
        `INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status)
         SELECT 'gone', customer_id, profile_id, 'v1:variant:acme:p:%2Fold:problem:ai', model, prompt_hash, generated_at, cost_usd, 'stale'
         FROM variants LIMIT 1`,
      )
      .run();
    vi.setSystemTime(T0 + HOUR);
    // Before: picked on every pass for good, each one reading the home page.
    expect(await s.pick()).toEqual([]);
    await s.pass();
    expect(pageReads).toEqual([]);
  });

  it("the pages a pass writes: confirmed, with a part to write; `/` when none is confirmed", async () => {
    const s = setup();
    expect(await writtenPages("acme", s.d1)).toEqual(["/"]);
    const add = s.db.prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('acme', ?, ?, 'https://acme.test/', 1, ?, 'en')",
    );
    add.run("/pricing", JSON.stringify(MANIFEST), 1);
    // Not confirmed, not readable, and a page of one button left as built.
    add.run("/draft", JSON.stringify(MANIFEST), null);
    add.run("/broken", "{not json", 1);
    add.run(
      "/buttons",
      JSON.stringify({ "hero.cta.label": { css: ["a.cta"], text: ["Start"], structural: "a" } }),
      1,
    );
    expect((await writtenPages("acme", s.d1)).sort()).toEqual(["/", "/pricing"]);
    s.db.prepare("DELETE FROM element_manifests").run();
    expect(await writtenPages("acme", s.d1)).toEqual(["/"]);
  });
});

describe("when the check cannot be made", () => {
  it("KV does not answer: the rows' own clock decides, so a row past it is tried, as before", async () => {
    const s = setup();
    await refusedAt(s, T0 + 7 * HOUR);
    vi.setSystemTime(T0 + 7 * HOUR + 5 * MIN);
    const deaf = {
      ...s.kv,
      get: async () => {
        throw new Error("kv down");
      },
    } as unknown as KVNamespace;
    expect(await hasDueWork("acme", s.d1, deaf, QUEUE_ERROR_RETRY_MS)).toBe(true);
    expect(await queueCustomers(s.d1, deaf)).toEqual(["acme"]);
    // Without KV at all the same clock: seven hours since the ready write.
    expect(await queueCustomers(s.d1)).toEqual(["acme"]);
  });

  it("D1 fails on the check: the customer is picked and the pass decides", async () => {
    const s = setup();
    await refusedAt(s, T0 + 7 * HOUR);
    vi.setSystemTime(T0 + 7 * HOUR + 5 * MIN);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = new Proxy(s.d1, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sqlText: string) => {
          if (sqlText.includes("FROM element_manifests")) throw new Error("d1 down");
          return target.prepare(sqlText);
        };
      },
    });
    // Both reads of the pages fail: the live-customer read, which then names
    // nobody, and the due check, which picks its customer. The queue is left
    // exactly as it was before the live read existed, and each says so.
    expect(await queueCustomers(broken, s.kv)).toEqual(["acme"]);
    expect(errors).toHaveBeenCalledTimes(2);
    // The id and the reason, nothing of a row.
    expect(errors.mock.calls).toEqual([
      ["[regen-queue] live customers read failed:", "d1 down"],
      ["[regen-queue] due check for acme failed:", "d1 down"],
    ]);
  });
});
