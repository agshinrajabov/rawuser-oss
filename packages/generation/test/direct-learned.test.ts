/**
 * The learned default's offline sweep (docs/specs/direct-visitors.md §3):
 * arms from live base versions of confirmed pages, counts by row with no
 * visit marker, a prior pooled across eligible customers, a set stored with
 * its counts and the bundle's `dl` rewritten only when the weights moved.
 */
import { variantKeyForPath, visitorBundleKey } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEARNED_COUNTS_ND_SQL,
  LEARNED_COUNTS_SQL,
  learnedArms,
  learnedCounts,
  runLearnedSweep,
} from "../src/cron/direct-answers.ts";
import { DAY, type Harness, harness } from "./proof-harness.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
let h: Harness;
let seed = 7;
const rng = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
beforeEach(() => {
  h = harness();
  h.customer("acme");
  h.customer("other");
  h.db.prepare("UPDATE customers SET live_at = 1").run();
  for (const id of ["acme", "other"]) {
    h.db
      .prepare(
        "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at) VALUES (?, '/', '{}', 1, 'https://x.test/', 1)",
      )
      .run(id);
    for (const intent of ["feature", "problem"])
      cell(id, "/", intent, "default", "0123456789abcdef");
  }
  cell("acme", "/", "evaluation", "default", null); // waiting, never live: not an arm
  cell("acme", "/", "feature", "ai", "1111111111111111"); // not a base version
  cell("acme", "/unconfirmed", "brand", "default", "2222222222222222");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function cell(customer: string, page: string, intent: string, source: string, body: string | null) {
  const key = variantKeyForPath(customer, page, intent, source);
  h.db
    .prepare(
      `INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status, body_id)
       VALUES (?, ?, (SELECT id FROM intent_profiles LIMIT 1), ?, 'm', 'p', 1, 0, 'ready', ?)`,
    )
    .run(`v_${key}`, customer, key, body);
}

function shown(customer: string, intent: string | null, n: number, clicks: number, props?: object) {
  const type = intent ? "variant_shown" : "no_signal_passthrough";
  for (let i = 0; i < n; i++) {
    h.ev({
      customer,
      ts: NOW - DAY,
      type,
      intent,
      source: intent ? "direct" : null,
      cohort: intent ? "personalized" : "no_signal",
      props: props ?? null,
    });
  }
  for (let i = 0; i < clicks; i++) {
    h.ev({
      customer,
      ts: NOW - DAY,
      type: "conversion",
      intent,
      source: intent ? "direct" : null,
      cohort: intent ? "personalized" : "no_signal",
      props: props ?? null,
    });
  }
}

describe("arms and counts", () => {
  it("arms: none and the live base versions of confirmed pages", async () => {
    const arms = await learnedArms(h.d1, "acme");
    expect([...arms.entries()]).toEqual([["/", ["none", "feature", "problem"]]]);
  });

  it("counts by row, a tagged or carried or sourced view left out", async () => {
    shown("acme", null, 50, 1);
    shown("acme", "feature", 40, 4);
    h.ev({
      customer: "acme",
      ts: NOW - DAY,
      type: "variant_shown",
      intent: "feature",
      source: "ai",
      cohort: "personalized",
    });
    const c = await learnedCounts(h.d1, "acme", NOW);
    expect(c.get("/")?.get("none")).toEqual({ n: 50, k: 1 });
    expect(c.get("/")?.get("feature")).toEqual({ n: 40, k: 4 });
  });

  it("once rows hold nd, only those count", async () => {
    shown("acme", null, 50, 1);
    shown("acme", "feature", 10, 3, { nd: "l:k3x9:600" });
    const c = await learnedCounts(h.d1, "acme", NOW);
    expect(c.get("/")?.get("feature")).toEqual({ n: 10, k: 3 });
    expect(c.get("/")?.has("none")).toBe(false);
  });

  it("no visit marker in either count", () => {
    for (const sql of [LEARNED_COUNTS_SQL, LEARNED_COUNTS_ND_SQL]) {
      expect(sql).not.toMatch(/\bvisit\b/);
      expect(sql).toContain("customer_id = ?1");
    }
  });
});

describe("the sweep", () => {
  it("stores a set with its counts and writes dl; a second run with the same counts moves nothing", async () => {
    shown("acme", null, 400, 4);
    shown("acme", "feature", 400, 40);
    shown("other", null, 300, 3);
    const r = await runLearnedSweep(h.env, NOW, rng);
    expect(r.errors).toBe(0);
    expect(r.changed).toBe(2);
    const rows = h.db
      .prepare("SELECT page_path, weights, counts FROM learned_weights WHERE customer_id = 'acme'")
      .all() as Array<{ page_path: string; weights: string; counts: string }>;
    expect(rows).toHaveLength(1);
    const w = JSON.parse(rows[0]?.weights ?? "[]") as Array<[string, number]>;
    expect(w.map(([a]) => a)).toEqual(["none", "feature", "problem"]);
    expect(w.reduce((s, [, x]) => s + x, 0)).toBe(1000);
    // feature clicked 10% against 1%: it takes most of the weight.
    expect(w.find(([a]) => a === "feature")?.[1]).toBeGreaterThan(800);
    expect(JSON.parse(rows[0]?.counts ?? "[]")).toEqual([
      ["none", 400, 4],
      ["feature", 400, 40],
      ["problem", 0, 0],
    ]);
    const b = JSON.parse(h.kv.get(visitorBundleKey("acme")) ?? "{}");
    expect(b.dl.w["/"]).toEqual(w);
    const again = await runLearnedSweep(h.env, NOW + 6 * 3600_000, rng);
    expect(again.changed).toBe(0);
  });

  it("no weights for the switch off, sensitive, an audit or an unanswered customer", async () => {
    for (const sql of [
      "UPDATE customers SET learned_default_off = 1",
      "UPDATE customers SET sensitive = 1",
      "UPDATE customers SET plan = 'audit'",
      "UPDATE customers SET special_category = NULL",
    ]) {
      h.db.prepare("DELETE FROM learned_weights").run();
      h.db
        .prepare(
          "UPDATE customers SET learned_default_off = 0, sensitive = 0, plan = 'pilot', special_category = 0",
        )
        .run();
      h.db.prepare(`${sql} WHERE id = 'acme'`).run();
      await runLearnedSweep(h.env, NOW, rng);
      const n = h.db
        .prepare("SELECT COUNT(*) AS n FROM learned_weights WHERE customer_id = 'acme'")
        .get() as {
        n: number;
      };
      expect(n.n, sql).toBe(0);
    }
  });
});
