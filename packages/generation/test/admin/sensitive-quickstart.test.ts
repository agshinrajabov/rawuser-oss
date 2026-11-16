/**
 * The quickstart chain for a sensitive customer (docs/specs/sensitive-customers.md,
 * condition 2): the homepage is read as for anyone, but a language's page
 * that is not a kept section is not read, listed or stored, so nothing
 * outside `/` and the list can be ticked at go live. A kept one is read as
 * before, and a customer that is not sensitive sees no change.
 * Real SQL on node:sqlite; the model, the page fetch and the preview are
 * stubbed.
 */
import { captureKey } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "../model-env.ts";
import { type Harness, harness } from "../proof-harness.ts";

vi.mock("../../src/detect-elements.ts", () => ({
  fetchPageHtml: vi.fn(
    async () =>
      '<html lang="en"><head><title>Medora</title></head><body><h1>Made to order</h1></body></html>',
  ),
  cleanHtml: vi.fn((html: string) => html),
  detectElements: vi.fn(async () => ({
    manifest: { "hero.headline": { css: ["h1"], text: ["Sifarişlə istehsal"], structural: "h1" } },
    cost_usd: 0.01,
    source_html_bytes: 100,
  })),
}));
vi.mock("../../src/dna-suggest.ts", () => ({
  suggestDnaFromHtml: vi.fn(async () => ({
    url: "https://medora.test/",
    generated_at: 1,
    language: "az",
    product: "Qida əlavələri",
    icp: "Brendlər",
    target_market: "Yerli bazar",
    brand_voice: "calm",
    value_props: [{ text: "İstehsal", evidence: "İstehsal" }],
    differentiators: [],
    proof_points: [],
  })),
}));
vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(),
  regenerateOne: vi.fn(async () => ({
    customer_id: "medora",
    intent_dim: "evaluation",
    source_dim: "default",
    kv_key: "k",
    cost_usd: 0,
    ok: false,
    error: "stubbed",
  })),
}));
vi.mock("../../src/site-map/run.ts", () => ({
  runSiteRead: vi.fn(async () => ({ cost_usd: 0 })),
  siteRereadHook: vi.fn(() => undefined),
}));
vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => ({
    id: "u1",
    email: "f@example.com",
    role: "superadmin",
    customer_id: null,
  })),
}));

const { default: worker } = await import("../../src/index.ts");
const { fetchPageHtml } = await import("../../src/detect-elements.ts");

const HOME = (host: string) =>
  `<html lang="az"><head><title>Medora</title><link rel="alternate" hreflang="az" href="https://${host}/"/><link rel="alternate" hreflang="en" href="https://${host}/en"/></head><body><h1>Sifarişlə istehsal</h1></body></html>`;

let h: Harness;
beforeEach(() => {
  h = harness();
  h.customer("medora");
  h.customer("acme");
  vi.mocked(fetchPageHtml).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function quickstart(customer: string) {
  h.kv.set(captureKey(customer, "/"), HOME(`${customer}.test`));
  const res = await worker.fetch(
    new Request("https://api.example.com/admin/onboard/quickstart", {
      method: "POST",
      headers: { "x-rawuser-admin": "session", "content-type": "application/json" },
      body: JSON.stringify({ customer_id: customer, page_path: "/" }),
    }),
    { ...h.env, ...MODEL_ENV } as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
  return {
    status: res.status,
    json: (await res.json()) as { languages?: Array<{ lang: string; path: string }> },
  };
}

const stored = (customer: string) =>
  (
    h.db
      .prepare("SELECT page_path FROM element_manifests WHERE customer_id = ? ORDER BY page_path")
      .all(customer) as Array<{ page_path: string }>
  ).map((r) => r.page_path);

function mark(kept: string[]) {
  h.db
    .prepare("UPDATE customers SET sensitive = 1, kept_sections = ? WHERE id = 'medora'")
    .run(kept.length > 0 ? JSON.stringify(kept) : null);
}

describe("the quickstart's other languages", () => {
  it("a customer that is not sensitive: the other language's page is read and stored, as before", async () => {
    const r = await quickstart("acme");
    expect(r.status).toBe(200);
    expect(r.json.languages?.map((l) => [l.lang, l.path])).toEqual([
      ["az", "/"],
      ["en", "/en"],
    ]);
    expect(stored("acme")).toEqual(["/", "/en"]);
    expect(vi.mocked(fetchPageHtml)).toHaveBeenCalledTimes(1);
  });

  it("a sensitive customer: a language's page outside the list is not read, listed or stored", async () => {
    mark(["/products"]);
    const r = await quickstart("medora");
    expect(r.status).toBe(200);
    expect(r.json.languages?.map((l) => [l.lang, l.path])).toEqual([["az", "/"]]);
    expect(stored("medora")).toEqual(["/"]);
    expect(vi.mocked(fetchPageHtml)).not.toHaveBeenCalled();
    const row = h.db.prepare("SELECT languages FROM customers WHERE id = 'medora'").get() as {
      languages: string;
    };
    expect(row.languages).not.toContain("/en");
  });

  it("a sensitive customer: a language's page that is a kept section is read as before", async () => {
    mark(["/en"]);
    const r = await quickstart("medora");
    expect(r.status).toBe(200);
    expect(r.json.languages?.map((l) => [l.lang, l.path])).toEqual([
      ["az", "/"],
      ["en", "/en"],
    ]);
    expect(stored("medora")).toEqual(["/", "/en"]);
  });
});
