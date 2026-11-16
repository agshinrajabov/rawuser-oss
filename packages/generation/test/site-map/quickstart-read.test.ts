/**
 * The quickstart reads the site's own links from the capture it already
 * holds (docs/specs/site-shaped-intents.md §4.1), beside the preview; "Add
 * this page" reads its page's links too. Real SQL on SQLite; the model and
 * the element detection are stubbed.
 */
import { describe, expect, it, vi } from "vitest";

const PAGE = `<html lang="en"><head><title>Acme</title></head><body>
<nav><a href="/pricing">Pricing</a><a href="/customers">Customers</a><a href="/login">Log in</a>
<a href="/u/jane-doe">Jane Doe</a></nav><h1>Ship faster</h1><p>Acme builds.</p></body></html>`;

vi.mock("../../src/detect-elements.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/detect-elements.ts")>()),
  fetchPageHtml: vi.fn(async () => PAGE),
  detectElements: vi.fn(async () => ({
    manifest: { "hero.headline": { css: ["h1"], text: ["Ship faster"], structural: "h1" } },
    cost_usd: 0,
    source_html_bytes: 100,
  })),
}));
vi.mock("../../src/dna-suggest.ts", () => ({
  suggestDnaFromHtml: vi.fn(async () => ({
    url: "https://acme.test/",
    generated_at: 1,
    language: "en",
    product: "Deploy tool",
    icp: "Developers",
    target_market: "",
    brand_voice: "",
    value_props: [{ text: "Fast", evidence: "Fast" }],
    differentiators: [],
    proof_points: [],
  })),
}));
vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(),
  regenerateOne: vi.fn(async () => ({ ok: false, error: "stub", cost_usd: 0 })),
}));
const modelCalls: string[] = [];
vi.mock("../../src/call-model.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/call-model.ts")>()),
  callModel: vi.fn(async (input: { prompt: string }) => {
    modelCalls.push(input.prompt);
    return {
      ok: true,
      value: { text: '{"kinds":{"/u/jane-doe":"none"}}', model: "model-a", costUsd: 0.0001 },
    };
  }),
}));

import { handleQuickstart } from "../../src/admin/quickstart.ts";
import { makeKv, makeSqliteD1 } from "../admin/sqlite-d1.ts";
import { MODEL_ENV } from "../model-env.ts";

const USER = { id: "u", email: "a@b.c", role: "superadmin", customer_id: null };

describe("the quickstart's link read", () => {
  it("stores the capture's rule-named links, drops the account link, sends and keeps nothing of jane-doe", async () => {
    const { d1, db } = makeSqliteD1();
    db.prepare(
      "INSERT INTO customers (id, slug, domain, status, created_at) VALUES ('acme', 'acme', 'acme.test', 'active', 1)",
    ).run();
    const kv = makeKv();
    await kv.put("capture:acme:/", PAGE);
    const env = {
      DB: d1,
      VARIANTS: kv,
      ...MODEL_ENV,
      ENVIRONMENT: "test",
      ALLOWED_ORIGINS: "https://app.test",
    } as never;
    const res = await handleQuickstart(
      new Request("https://gen.test/admin/onboard/quickstart", {
        method: "POST",
        body: JSON.stringify({ customer_id: "acme", page_path: "/" }),
      }),
      env,
      USER,
    );
    expect(res.status).toBe(200);
    const rows = db
      .prepare("SELECT path, kind, confidence, label FROM site_paths ORDER BY path")
      .all();
    expect(rows).toEqual([
      { path: "/customers", kind: "proof", confidence: "high", label: "Customers" },
      { path: "/pricing", kind: "price", confidence: "high", label: "Pricing" },
    ]);
    // A capture sends nothing to the model (privacy review re-review, §13.2
    // point 2): the rules named both kept links, the rest waits for a
    // cookie-less read.
    expect(modelCalls).toHaveLength(0);
    expect(JSON.stringify(rows)).not.toContain("jane");
    const c = db.prepare("SELECT served_intents, served_reasons FROM customers").get() as {
      served_intents: string;
      served_reasons: string;
    };
    expect(JSON.parse(c.served_intents)).toEqual([
      "evaluation",
      "feature",
      "problem",
      "brand",
      "pricing",
    ]);
    expect(JSON.parse(c.served_reasons)).toMatchObject({
      pricing: "page /pricing",
      competitor: "none",
    });
    expect(JSON.parse(kv.store.get("v1:vm:acme") ?? "{}").pm).toEqual({
      "/customers": ["proof", 1],
      "/pricing": ["price", 1],
    });
  });
});
