/**
 * Market versions in generation (docs/specs/direct-visitors.md §5): the
 * cells (`brand`, `mk-{cc}`), the MARKET block, the hard lint, the approval
 * rule (a market cell always waits for the customer's OK), the 6-hour market
 * sweep and the switches endpoint.
 */
import { visitorBundleKey } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knownCell } from "../src/admin/customer-versions.ts";
import { handleDirectSwitches } from "../src/admin/direct-switches.ts";
import type { AdminEnv } from "../src/admin/handlers.ts";
import { MARKET_COUNTS_SQL, runMarketSweep } from "../src/cron/direct-answers.ts";
import { loadMarkets } from "../src/lib/markets.ts";
import { hasDueWork } from "../src/lib/queue-due.ts";
import { buildTuples } from "../src/lib/variant-rows.ts";
import { routeFor } from "../src/lib/version-approval.ts";
import { lintVariant } from "../src/lint/index.ts";
import { marketAddressed } from "../src/lint/market-addressed.ts";
import { buildMarketModifier, countryName } from "../src/prompts/market.ts";
import { DAY, type Harness, harness, vid } from "./proof-harness.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
let h: Harness;
beforeEach(() => {
  h = harness();
  h.customer("acme");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const set = (sql: string, ...p: unknown[]) => h.db.prepare(sql).run(...p);

function visits(country: string, n: number) {
  for (let i = 0; i < n; i++) {
    h.ev({
      ts: NOW - DAY,
      type: "no_signal_passthrough",
      visit: vid(Math.random() * 1e12),
      country,
    });
  }
}

describe("the cells and the prompt", () => {
  it("one brand cell per market after the served intents", () => {
    const t = buildTuples(null, ["GB", "DE"]);
    expect(t.slice(-2)).toEqual([
      { intent_dim: "brand", source_dim: "mk-gb" },
      { intent_dim: "brand", source_dim: "mk-de" },
    ]);
    expect(buildTuples(null)).toHaveLength(36);
  });

  it("the MARKET block names the market, never the reader, never a price", () => {
    const m = buildMarketModifier("GB");
    expect(countryName("GB")).toBe("United Kingdom");
    expect(m).toContain("United Kingdom (GB)");
    expect(m).toMatch(/Never say or imply where the reader lives/);
    expect(m).toMatch(/Never change a price, a currency, an offer/);
    expect(m).not.toMatch(/[–—]/);
  });

  it("knownCell takes a market cell of brand only", () => {
    expect(knownCell("brand", "mk-gb")).toBe(true);
    expect(knownCell("pricing", "mk-gb")).toBe(false);
    expect(knownCell("brand", "mk-xx")).toBe(false);
    expect(knownCell("brand", "social")).toBe(true);
  });
});

describe("market-addressed, hard on a market version only", () => {
  it("reads the reader's place in four languages", () => {
    expect(marketAddressed("Built for teams in your country")).toBe("your country");
    expect(marketAddressed("Visitors from Germany love it")).toBe("Visitors from G");
    expect(marketAddressed("Ölkənizdə ən sürətli xidmət")).toBeTruthy();
    expect(marketAddressed("Лучший сервис в вашей стране")).toBeTruthy();
    expect(marketAddressed("Ülkenizde en hızlı hizmet")).toBeTruthy();
    expect(marketAddressed("Built for UK teams, with UK support")).toBeNull();
  });

  it("the lint flags it only with a market", () => {
    const body = {
      customer_id: "acme",
      profile_key: "x",
      generated_at: 0,
      prompt_hash: "p",
      sections: { hero: { kind: "hero", headline: "The best tool where you live" } },
    };
    const withMarket = lintVariant(body as never, { language: "en", market: "GB" });
    expect(withMarket.hard.map((f) => f.rule)).toContain("market-addressed");
    const without = lintVariant(body as never, { language: "en" });
    expect(without.hard.map((f) => f.rule)).not.toContain("market-addressed");
  });
});

describe("approval: a market cell always waits", () => {
  it("waits even inside the first set's seven days; live with auto_approve", async () => {
    set(
      "UPDATE customers SET live_at = ?, first_set = ? WHERE id = 'acme'",
      NOW - DAY,
      JSON.stringify({ at: NOW - DAY, pages: ["/"], intents: null }),
    );
    const cell = {
      customerId: "acme",
      pagePath: "/",
      intentDim: "brand" as const,
      sourceDim: "mk-gb" as const,
    };
    expect(await routeFor(h.env as never, cell, "k", NOW, false)).toBe("waiting");
    const plain = { ...cell, sourceDim: "default" as const };
    expect(await routeFor(h.env as never, plain, "k2", NOW, false)).toBe("live");
    set("UPDATE customers SET auto_approve = 1 WHERE id = 'acme'");
    expect(await routeFor(h.env as never, cell, "k", NOW, false)).toBe("live");
  });
});

describe("the market sweep", () => {
  beforeEach(() => set("UPDATE customers SET live_at = 1 WHERE id = 'acme'"));

  it("stores the markets, writes mk into the bundle, and the queue sees the cells", async () => {
    visits("AZ", 100);
    visits("TR", 40);
    visits("GB", 35);
    visits("DE", 5);
    const r = await runMarketSweep(h.env, NOW);
    expect(r).toMatchObject({ changed: 1, errors: 0 });
    const row = h.db.prepare("SELECT markets FROM customers WHERE id = 'acme'").get() as {
      markets: string;
    };
    expect(JSON.parse(row.markets)).toEqual(["TR", "GB"]);
    expect(JSON.parse(h.kv.get(visitorBundleKey("acme")) ?? "{}").mk).toEqual(["TR", "GB"]);
    expect(await loadMarkets("acme", h.d1)).toEqual(["TR", "GB"]);
    // A second run changes nothing.
    expect((await runMarketSweep(h.env, NOW)).changed).toBe(0);
    // The queue now has the market cells to write.
    expect(await hasDueWork("acme", h.d1, undefined, 6 * 3600_000)).toBe(true);
  });

  it("none for the switch off, country off, sensitive, an unanswered or audit customer", async () => {
    visits("TR", 40);
    visits("GB", 40);
    visits("AZ", 40);
    for (const sql of [
      "UPDATE customers SET market_versions_off = 1",
      "UPDATE customers SET country_off = 1",
      "UPDATE customers SET sensitive = 1",
      "UPDATE customers SET special_category = NULL",
      "UPDATE customers SET plan = 'audit'",
    ]) {
      set(
        "UPDATE customers SET market_versions_off = 0, country_off = 0, sensitive = 0, special_category = 0, plan = 'pilot', markets = NULL",
      );
      set(`${sql} WHERE id = 'acme'`);
      await runMarketSweep(h.env, NOW);
      const row = h.db.prepare("SELECT markets FROM customers WHERE id = 'acme'").get() as {
        markets: string | null;
      };
      expect(row.markets, sql).toBeNull();
    }
  });

  it("counts only the customer's own visits, by country, never across customers", () => {
    expect(MARKET_COUNTS_SQL).toContain("customer_id = ?");
    expect(MARKET_COUNTS_SQL).not.toMatch(/JOIN/i);
  });
});

describe("the switches endpoint", () => {
  const superadmin = { id: "u", email: "a@rawuser.example", role: "superadmin", customer_id: null };
  const env = () => ({ ...h.env, DASHBOARD_ORIGIN: "*" }) as unknown as AdminEnv;
  const call = async (method: "GET" | "POST", body?: unknown, user: unknown = superadmin) => {
    const req =
      method === "GET"
        ? new Request("https://api.test/admin/customers/direct-switches?customer_id=acme")
        : new Request("https://api.test/admin/customers/direct-switches", {
            method,
            body: JSON.stringify(body),
          });
    const res = await handleDirectSwitches(req, env(), user as never);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("reads and turns each switch, rewriting the bundle", async () => {
    set("UPDATE customers SET markets = '[\"GB\"]' WHERE id = 'acme'");
    expect((await call("GET")).json).toEqual({
      customer_id: "acme",
      page_one: true,
      learned_default: true,
      market_versions: true,
      remember: true,
      remember_allowed: true,
      markets: ["GB"],
      allowed: true,
    });
    const off = await call("POST", {
      customer_id: "acme",
      market_versions: false,
      page_one: false,
      remember: false,
    });
    expect(off.json).toMatchObject({
      page_one: false,
      market_versions: false,
      learned_default: true,
      remember: false,
    });
    const b = JSON.parse(h.kv.get(visitorBundleKey("acme")) ?? "{}");
    expect(b).not.toHaveProperty("mk");
    expect(b).not.toHaveProperty("dp");
    expect(b).not.toHaveProperty("rm");
    await call("POST", { customer_id: "acme", remember: true });
    expect(JSON.parse(h.kv.get(visitorBundleKey("acme")) ?? "{}").rm).toBe(1);
  });

  it("refuses a non-boolean and another customer's scope", async () => {
    expect((await call("POST", { customer_id: "acme", page_one: "yes" })).status).toBe(400);
    const other = { id: "c", email: "c@x.test", role: "customer", customer_id: "other" };
    expect((await call("GET", undefined, other)).status).toBe(403);
  });
});
