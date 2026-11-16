/**
 * A first write tries again at once (docs/specs/refused-versions.md, J2 of
 * docs/specs/pilot-gaps.md).
 *
 * the pilot at go live: 5 of 20 versions were refused on their first write, and
 * the last of the 20 was written 6 hours and 9 minutes after the first. A
 * refused first write has no version at all, so the queue tries it once
 * more on its next pass, five minutes on, before the six-hour wait. The
 * second failure marks the row; a provider failure and a refused rewrite
 * wait as before.
 *
 * SQLite with every migration and the queue's own options, so the queue's
 * real statement decides which rows are tried.
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

// One served intent, so the customer has six rows (its default and the five
// sources) and a pass reaches all of them inside its call budget.
vi.mock("../src/site-map/served-load.ts", () => ({
  loadServedIntents: vi.fn(async () => ["problem"]),
}));

const { orchestrate } = await import("../src/orchestrator.ts");
const { QUEUE_ERROR_RETRY_MS, QUEUE_TUPLES_PER_RUN, runRegenQueue } = await import(
  "../src/cron/regen-queue.ts"
);
const { FIRST_WRITE_RETRIED, firstWriteRetryDueSql, writeErrorRow } = await import(
  "../src/lib/variant-rows.ts"
);
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

/** Both parts far over their caps, on every pass and every call: the copy checks refuse the row. */
const LONG_HEAD = "Plan the whole week of your whole team in one calm and quiet place";
const LONG_BODY =
  "Tasks, notes and deadlines of the whole team on a single board that everybody opens every morning.";
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
  const env = { ...MODEL_ENV, DB: d1, VARIANTS: kv };
  /** One pass of the five-minute queue, as the cron runs it. */
  const pass = async () => {
    inputs = [];
    return runRegenQueue(env as never, (id, e, o) => orchestrate(id, e, o));
  };
  const rows = () =>
    db
      .prepare("SELECT kv_key, status, error_reason, lint_flags, generated_at FROM variants")
      .all() as Array<{
      kv_key: string;
      status: string;
      error_reason: string | null;
      lint_flags: string | null;
      generated_at: number;
    }>;
  return { env, db, kv, pass, rows };
}

const T0 = Date.UTC(2026, 9, 12, 6, 0, 0);
const FIVE_MIN = 5 * 60_000;

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

describe("a first write the copy checks refused", () => {
  it("is tried once more on the next pass, then waits six hours", async () => {
    const { pass, rows, env } = setup();
    // The first write, by the Live screen's loop or the queue: all six refused.
    modelRefused();
    inputs = [];
    const first = await orchestrate("acme", env, {});
    expect(first.errors).toBe(6);
    expect(rows().every((r) => r.status === "error" && r.lint_flags === null)).toBe(true);
    expect(rows().every((r) => r.error_reason?.startsWith("lint:"))).toBe(true);

    // Five minutes on: every one of them is tried again.
    vi.setSystemTime(T0 + FIVE_MIN);
    await pass();
    expect(tried()).toBe(6);
    expect(rows().every((r) => r.status === "error")).toBe(true);
    expect(rows().every((r) => r.lint_flags === JSON.stringify([FIRST_WRITE_RETRIED]))).toBe(true);
    // An error never moves generated_at; the six hours count from the last
    // failed try, kept in KV (test/tried-marker.test.ts).
    expect(rows().every((r) => r.generated_at === T0)).toBe(true);

    // The second failure waits: the next passes try nothing.
    vi.setSystemTime(T0 + 2 * FIVE_MIN);
    await pass();
    expect(tried()).toBe(0);
    vi.setSystemTime(T0 + QUEUE_ERROR_RETRY_MS - FIVE_MIN);
    await pass();
    expect(tried()).toBe(0);

    // Six hours after that retry it is tried again, once.
    vi.setSystemTime(T0 + QUEUE_ERROR_RETRY_MS + FIVE_MIN);
    await pass();
    expect(tried()).toBe(6);
    vi.setSystemTime(T0 + QUEUE_ERROR_RETRY_MS + 2 * FIVE_MIN);
    await pass();
    expect(tried()).toBe(0);
  });

  it("is written by that early retry when the model lands it the second time", async () => {
    const { pass, rows, env, kv } = setup();
    modelRefused();
    await orchestrate("acme", env, {});
    expect([...kv.store.keys()].filter((k) => k.startsWith("v1:variant:"))).toEqual([]);

    vi.setSystemTime(T0 + FIVE_MIN);
    modelGood();
    await pass();
    expect(tried()).toBe(6);
    expect(rows().every((r) => r.status === "ready" && r.error_reason === null)).toBe(true);
    // A ready write puts the version's own flags there: the mark is gone.
    expect(rows().some((r) => (r.lint_flags ?? "").includes(FIRST_WRITE_RETRIED))).toBe(false);
    expect([...kv.store.keys()].filter((k) => k.startsWith("v1:variant:"))).toHaveLength(6);
  });

  it("the early retry is one per row, also when a pass is capped", async () => {
    const { rows, env } = setup();
    modelRefused();
    await orchestrate("acme", env, {});
    // A pass that reaches two rows only: those two are marked, four still wait their turn.
    vi.setSystemTime(T0 + FIVE_MIN);
    inputs = [];
    await orchestrate("acme", env, {
      onlyMissing: true,
      maxTuples: 2,
      skipErrorsYoungerThanMs: QUEUE_ERROR_RETRY_MS,
    });
    expect(tried()).toBe(2);
    expect(rows().filter((r) => r.lint_flags !== null)).toHaveLength(2);
    vi.setSystemTime(T0 + 2 * FIVE_MIN);
    inputs = [];
    await orchestrate("acme", env, {
      onlyMissing: true,
      maxTuples: QUEUE_TUPLES_PER_RUN,
      skipErrorsYoungerThanMs: QUEUE_ERROR_RETRY_MS,
    });
    expect(tried()).toBe(4);
    expect(rows().filter((r) => r.lint_flags !== null)).toHaveLength(6);
  });
});

describe("what the early retry is not for", () => {
  it("a provider failure on a first write waits the six hours, as before", async () => {
    const { pass, rows, env } = setup();
    modelDown();
    const first = await orchestrate("acme", env, {});
    expect(first.errors).toBe(6);
    expect(
      rows().every(
        (r) => r.error_reason?.includes("Timeout after") && !r.error_reason.startsWith("lint:"),
      ),
    ).toBe(true);

    vi.setSystemTime(T0 + FIVE_MIN);
    modelGood();
    await pass();
    expect(tried()).toBe(0);
    expect(rows().every((r) => r.status === "error" && r.lint_flags === null)).toBe(true);

    vi.setSystemTime(T0 + QUEUE_ERROR_RETRY_MS + FIVE_MIN);
    await pass();
    expect(tried()).toBe(6);
    expect(rows().every((r) => r.status === "ready")).toBe(true);
  });

  it("a rewrite the copy checks refused: its older body serves, and it waits as before", async () => {
    const { pass, rows, env, db, kv } = setup();
    modelGood();
    await orchestrate("acme", env, {});
    expect(rows().every((r) => r.status === "ready")).toBe(true);
    const before = new Map(kv.store);

    // Rewrite everything an hour later; this time the model overshoots.
    vi.setSystemTime(T0 + 60 * 60_000);
    db.prepare("UPDATE variants SET status = 'stale'").run();
    modelRefused();
    await pass();
    expect(tried()).toBe(6);
    expect(rows().every((r) => r.status === "error")).toBe(true);
    // Not marked: this was never a first write, and the mark is not for it.
    expect(rows().some((r) => (r.lint_flags ?? "").includes(FIRST_WRITE_RETRIED))).toBe(false);
    for (const [key, value] of before) expect(kv.store.get(key)).toBe(value);

    vi.setSystemTime(T0 + 60 * 60_000 + FIVE_MIN);
    await pass();
    expect(tried()).toBe(0);
  });
});

describe("the mark on the row", () => {
  it("is set by the second failure of a row that never was ready, whatever that failure is", async () => {
    const { d1, db } = makeSqliteD1();
    db.prepare(
      "INSERT INTO customers (id, slug, domain, status, created_at) VALUES ('acme', 'acme', 'acme.test', 'active', 1)",
    ).run();
    const tuple = { intent_dim: "problem", source_dim: "ai" } as const;
    const key = "v1:variant:acme:problem:ai";
    const due = () =>
      db.prepare(`SELECT ${firstWriteRetryDueSql()} AS due, lint_flags FROM variants`).get() as {
        due: number;
        lint_flags: string | null;
      };
    await writeErrorRow("acme", tuple, key, "lint: hero.body length-drift (x)", d1, "/", "model-a");
    expect(due()).toEqual({ due: 1, lint_flags: null });
    // The early retry met an outage: still one retry, not a loop.
    await writeErrorRow("acme", tuple, key, "Timeout after 45000ms", d1, "/", "model-a");
    expect(due()).toEqual({ due: 0, lint_flags: JSON.stringify([FIRST_WRITE_RETRIED]) });
    await writeErrorRow("acme", tuple, key, "lint: hero.body length-drift (x)", d1, "/", "model-a");
    expect(due().due).toBe(0);
  });

  it("a first failure that is an outage is not due", async () => {
    const { d1, db } = makeSqliteD1();
    db.prepare(
      "INSERT INTO customers (id, slug, domain, status, created_at) VALUES ('acme', 'acme', 'acme.test', 'active', 1)",
    ).run();
    await writeErrorRow(
      "acme",
      { intent_dim: "problem", source_dim: "ai" },
      "v1:variant:acme:problem:ai",
      "Timeout after 45000ms",
      d1,
      "/",
      "model-a",
    );
    const row = db.prepare(`SELECT ${firstWriteRetryDueSql()} AS due FROM variants`).get() as {
      due: number;
    };
    expect(row.due).toBe(0);
  });
});
