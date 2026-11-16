/**
 * Script-first onboarding endpoints (docs/specs/script-first-onboarding.md).
 *
 *   /admin/onboard/quickstart: needs a capture (409 without), reads it once
 *   and deletes it, stores the manifest unconfirmed, writes the brief as a
 *   draft, the language to KV, one preview under a preview key (never a
 *   live key), keeps the record 24h, stamps preview_seen_at.
 *   /admin/onboard/go-live: confirms the manifest with edits, writes the
 *   brief with draft = 0, promotes the preview to the live key with a row,
 *   stamps live_at.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "../model-env.ts";

vi.mock("../../src/detect-elements.ts", () => ({
  fetchPageHtml: vi.fn(
    async () =>
      '<html lang="az"><head><title>Lumera</title></head><body><h1>AI-əsaslı tətbiqlər yaradırıq.</h1><p>400+ dizayner, Nümunə Bank</p></body></html>',
  ),
  cleanHtml: vi.fn((html: string) => html),
  detectElements: vi.fn(async () => ({
    manifest: {
      "hero.headline": { css: ["h1"], text: ["Dizaynı sıfırdan öyrən"], structural: "first h1" },
      "hero.cta.label": { css: [".nope"], text: ["Qeydiyyat"], structural: "hero button" },
    },
    cost_usd: 0.03,
    source_html_bytes: 400,
  })),
}));

vi.mock("../../src/dna-suggest.ts", () => ({
  suggestDnaFromHtml: vi.fn(async () => ({
    url: "https://lumera.test/",
    generated_at: 1,
    language: "az",
    product: "Dizayn məktəbi",
    icp: "Dizayna yeni başlayanlar",
    target_market: "Yerli bazar",
    brand_voice: "warm, direct",
    value_props: [{ text: "400+ məzun", evidence: "400+ məzun" }],
    differentiators: [],
    proof_points: [{ text: "Nümunə Bank", evidence: "Nümunə Bank" }],
  })),
}));

vi.mock("../../src/selector-health.ts", () => ({
  validateSelectors: vi.fn(() => ({
    "hero.headline": [{ selector: "h1", status: "ok", count: 1 }],
    "hero.cta.label": [{ selector: ".nope", status: "none", count: 0 }],
  })),
}));

const regenerateOne = vi.fn(
  async (
    _c: string,
    intent: string,
    source: string,
    _e: unknown,
    _p: string,
    opts: { preview?: { kvKey: string } },
  ) => ({
    customer_id: "c1",
    intent_dim: intent,
    source_dim: source,
    kv_key: opts.preview?.kvKey ?? "",
    cost_usd: 0.001,
    ok: true,
    body: {
      customer_id: "c1",
      profile_key: intent,
      sections: {
        hero: {
          kind: "hero",
          headline: "Müqayisə edənlər üçün",
          body: "b",
          cta: { label: "Başla" },
        },
      },
      generated_at: 1,
      prompt_hash: "h",
    },
    provenance: { model: "model-a", prompt_hash: "h", cost_usd: 0.001, lint_flags: [] },
  }),
);
vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(),
  regenerateOne: (...args: unknown[]) =>
    regenerateOne(...(args as Parameters<typeof regenerateOne>)),
}));
// The one way to go live (docs/specs/proof-engine.md, C), its own tests in
// test/lib/publish-version.test.ts; here it writes the live key only.
const publishVersion = vi.fn(
  async (
    env: { VARIANTS: KVNamespace },
    cell: { customerId: string; intentDim: string; sourceDim: string },
    body: unknown,
  ) => {
    const key = `v1:variant:${cell.customerId}:${cell.intentDim}:${cell.sourceDim}`;
    await env.VARIANTS.put(key, JSON.stringify(body));
    return { body_id: "0123456789abcdef", kv_key: key, body };
  },
);
vi.mock("../../src/lib/publish-version.ts", () => ({
  publishVersion: (...args: unknown[]) =>
    publishVersion(...(args as Parameters<typeof publishVersion>)),
}));

vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async (request: Request) => {
    const header = request.headers.get("X-Rawuser-Admin");
    if (!header) return null;
    return { id: "user-1", email: "admin@example.com", role: "superadmin" };
  }),
}));

const { default: worker } = await import("../../src/index.ts");

let kv: Map<string, { value: string; ttl?: number }>;
let runs: { sql: string; params: unknown[] }[];
let manifestRow: { manifest: string; confirmed_at: number | null } | null;
let customerLanguages: string | null;
let dnaLanguage: string | null;
/** A finished brief the extra-page guard reads (docs/specs/first-run.md §6). */
let finishedBrief: Record<string, string> | null;

function makeDb(): D1Database {
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...params: unknown[]) {
        bound = params;
        return this;
      },
      async first<T>() {
        if (sql.includes("SELECT languages FROM customers")) {
          return { languages: customerLanguages } as T;
        }
        if (sql.includes("FROM business_dna WHERE customer_id = ? AND draft = 0")) {
          return finishedBrief as T | null;
        }
        if (sql.includes("SELECT target_language FROM business_dna")) {
          return (dnaLanguage ? { target_language: dnaLanguage } : null) as T | null;
        }
        if (sql.includes("FROM customers WHERE id = ?")) {
          return (bound[0] === "c1" ? { id: "c1", domain: "lumera.test" } : null) as T | null;
        }
        if (sql.includes("SELECT confirmed_at FROM element_manifests")) {
          return (manifestRow ? { confirmed_at: manifestRow.confirmed_at } : null) as T | null;
        }
        return null;
      },
      async run() {
        runs.push({ sql, params: bound });
        if (sql.includes("UPDATE customers SET languages")) customerLanguages = bound[0] as string;
        if (sql.includes("INSERT INTO business_dna\n")) dnaLanguage = bound[8] as string;
        if (sql.includes("INSERT INTO element_manifests")) {
          manifestRow = { manifest: bound[2] as string, confirmed_at: null };
        }
        if (sql.includes("UPDATE element_manifests SET manifest = ?") && manifestRow) {
          manifestRow.manifest = bound[0] as string;
        }
        if (sql.includes("UPDATE element_manifests SET confirmed_at = ?") && manifestRow) {
          manifestRow.confirmed_at = bound[0] as number;
        }
        return { success: true, meta: {} } as D1Result;
      },
      async all<T>() {
        return { results: [] as T[], success: true, meta: {} } as D1Result<T>;
      },
    };
    return stmt as unknown as D1PreparedStatement;
  };
  return { prepare } as unknown as D1Database;
}

function makeEnv() {
  return {
    DB: makeDb(),
    VARIANTS: {
      async get(key: string) {
        return kv.get(key)?.value ?? null;
      },
      async put(key: string, value: string, o?: { expirationTtl?: number }) {
        kv.set(key, { value, ttl: o?.expirationTtl });
      },
      async delete(key: string) {
        kv.delete(key);
      },
    } as unknown as KVNamespace,
    ...MODEL_ENV,
    ADMIN_TOKEN: "test-admin",
    DASHBOARD_ORIGIN: "*",
    ENVIRONMENT: "development",
  };
}

function authed(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), "X-Rawuser-Admin": "test-admin" } };
}

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

beforeEach(() => {
  kv = new Map();
  runs = [];
  manifestRow = null;
  customerLanguages = null;
  dnaLanguage = null;
  finishedBrief = null;
  regenerateOne.mockClear();
  publishVersion.mockClear();
});

async function runQuickstart() {
  kv.set("capture:c1:/", {
    value:
      '<html lang="az-Latn"><head><title>Lumera</title><link rel="alternate" hreflang="az" href="https://lumera.test/"/><link rel="alternate" hreflang="en" href="https://lumera.test/en"/></head><body><h1>Dizaynı sıfırdan öyrən</h1><p>400+ məzun, Nümunə Bank</p></body></html>',
  });
  const res = await worker.fetch(
    new Request(
      "http://localhost/admin/onboard/quickstart",
      authed({ method: "POST", body: JSON.stringify({ customer_id: "c1", page_path: "/" }) }),
    ),
    makeEnv(),
    ctx,
  );
  return res;
}

describe("POST /admin/onboard/quickstart", () => {
  it("returns 409 when no capture exists", async () => {
    const res = await worker.fetch(
      new Request(
        "http://localhost/admin/onboard/quickstart",
        authed({ method: "POST", body: JSON.stringify({ customer_id: "c1" }) }),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("no_capture");
  });

  it("reads the page from its URL when asked and no capture is waiting", async () => {
    const res = await worker.fetch(
      new Request(
        "http://localhost/admin/onboard/quickstart",
        authed({
          method: "POST",
          body: JSON.stringify({ customer_id: "c1", page_path: "/", allow_fetch: true }),
        }),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { html_source: string };
    expect(body.html_source).toBe("fetch");
  });

  it("a model that wrote nothing: the operator is told which fault, a customer only that it failed", async () => {
    const { detectElements } = await import("../../src/detect-elements.ts");
    const { getSessionUser } = await import("../../src/admin/auth.ts");
    const post = () =>
      worker.fetch(
        new Request(
          "http://localhost/admin/onboard/quickstart",
          authed({
            method: "POST",
            body: JSON.stringify({ customer_id: "c1", page_path: "/", allow_fetch: true }),
          }),
        ),
        // As deployed: the development env also sends the log line as `detail`.
        { ...makeEnv(), ENVIRONMENT: "production" },
        ctx,
      );
    const fault = new Error("Model output truncated at max_tokens=4096 (content 0 chars)");

    vi.mocked(detectElements).mockRejectedValueOnce(fault);
    const forOperator = await post();
    expect(forOperator.status).toBe(500);
    const told = (await forOperator.json()) as Record<string, unknown>;
    expect(told).toEqual({ error: "Element detection failed", reason: "model_empty" });
    // Never the model layer's own sentence.
    expect(JSON.stringify(told)).not.toContain("max_tokens");

    vi.mocked(detectElements).mockRejectedValueOnce(fault);
    vi.mocked(getSessionUser).mockResolvedValueOnce({
      id: "user-2",
      email: "owner@example.com",
      role: "customer",
      customer_id: "c1",
    } as never);
    const forCustomer = await post();
    expect(forCustomer.status).toBe(500);
    expect(await forCustomer.json()).toEqual({ error: "Element detection failed" });
  });

  it("reads only the customer's recorded host, the secondary pages too", async () => {
    const { fetchPageHtml } = await import("../../src/detect-elements.ts");
    vi.mocked(fetchPageHtml).mockClear();
    await worker.fetch(
      new Request(
        "http://localhost/admin/onboard/quickstart",
        authed({
          method: "POST",
          body: JSON.stringify({ customer_id: "c1", page_path: "/", allow_fetch: true }),
        }),
      ),
      makeEnv(),
      ctx,
    );
    const calls = vi.mocked(fetchPageHtml).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(new URL(call[0] as string).hostname).toBe("lumera.test");
      expect(call[1]).toEqual({ sameHostAs: "lumera.test", userAgent: "Rawuser/1.0" });
    }
  });

  it("a redirect to another host is not followed and comes back as off_host", async () => {
    const { fetchPageHtml } = await import("../../src/detect-elements.ts");
    const { OffHostRedirectError, OFF_HOST_LINE } = await import("../../src/lib/public-url.ts");
    vi.mocked(fetchPageHtml).mockRejectedValueOnce(new OffHostRedirectError());
    const res = await worker.fetch(
      new Request(
        "http://localhost/admin/onboard/quickstart",
        authed({
          method: "POST",
          body: JSON.stringify({ customer_id: "c1", page_path: "/", allow_fetch: true }),
        }),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "off_host", reason: OFF_HOST_LINE });
  });

  it("passes the page's declared language to the brief draft", async () => {
    const { suggestDnaFromHtml } = await import("../../src/dna-suggest.ts");
    await runQuickstart();
    // First call is the primary page (az); the secondary page (en) follows.
    const calls = (suggestDnaFromHtml as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.at(-2)?.[3]).toBe("az");
    expect(calls.at(-1)?.[3]).toBe("en");
  });

  it("runs the chain once over the capture and deletes it", async () => {
    const res = await runQuickstart();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      language: string;
      language_source: string;
      current: { headline: string | null };
      preview: { headline: string | null } | null;
      brief: { product: string; target_language: string; proof_points: string[] };
      brief_gaps: string[];
      uncertain_paths: string[];
      cost_usd: number;
    };

    // Capture read once, gone after.
    expect(kv.has("capture:c1:/")).toBe(false);
    // Language from <html lang>, written for the edge gate.
    expect(body.language).toBe("az");
    expect(body.language_source).toBe("html-lang");
    // The edge reads a path → language map now (per-language).
    expect(JSON.parse(kv.get("v1:customer:c1:lang")?.value ?? "{}")["/"]).toBe("az");
    // Manifest stored unconfirmed.
    expect(manifestRow?.confirmed_at).toBeNull();
    expect(JSON.parse(manifestRow?.manifest ?? "{}")).toHaveProperty("hero.headline");
    // Brief drafted from the page, draft = 1.
    const dnaInsert = runs.find((r) => r.sql.includes("INSERT INTO business_dna"));
    expect(dnaInsert).toBeDefined();
    expect(dnaInsert?.params[dnaInsert.params.length - 1]).toBe(1);
    expect(body.brief.product).toBe("Dizayn məktəbi");
    expect(body.brief.proof_points).toEqual(["Nümunə Bank"]);
    expect(body.brief_gaps).toEqual([]);
    // Before/after.
    expect(body.current.headline).toBe("Dizaynı sıfırdan öyrən");
    expect(body.preview?.headline).toBe("Müqayisə edənlər üçün");
    // Preview went under a preview key, never a live one.
    const previewCall = regenerateOne.mock.calls[0];
    expect(previewCall?.[5]?.preview?.kvKey).toBe("v1:preview:c1:/:evaluation:default");
    expect(previewCall?.[1]).toBe("evaluation");
    // Uncertain selector surfaced.
    expect(body.uncertain_paths).toEqual(["hero.cta.label"]);
    // Record kept for the confirm screen; funnel stamp set.
    expect(kv.get("v1:quickstart:c1:/")?.ttl).toBe(24 * 60 * 60);
    expect(runs.some((r) => r.sql.includes("preview_seen_at = COALESCE(preview_seen_at, ?)"))).toBe(
      true,
    );
    // Primary detect + secondary detect + one preview.
    expect(body.cost_usd).toBeCloseTo(0.061, 3);
  });

  it("GET returns the stored record and 404 without one", async () => {
    await runQuickstart();
    const ok = await worker.fetch(
      new Request("http://localhost/admin/onboard/quickstart?customer_id=c1&page_path=/", authed()),
      makeEnv(),
      ctx,
    );
    expect(ok.status).toBe(200);
    kv.delete("v1:quickstart:c1:/");
    const missing = await worker.fetch(
      new Request("http://localhost/admin/onboard/quickstart?customer_id=c1&page_path=/", authed()),
      makeEnv(),
      ctx,
    );
    expect(missing.status).toBe(404);
  });
});

describe("POST /admin/onboard/go-live", () => {
  it("confirms the edited manifest, writes the brief as final, promotes the preview, stamps live_at", async () => {
    await runQuickstart();
    kv.set("v1:preview:c1:/:evaluation:default", { value: '{"sections":{}}' });
    const res = await worker.fetch(
      new Request(
        "http://localhost/admin/onboard/go-live",
        authed({
          method: "POST",
          body: JSON.stringify({
            customer_id: "c1",
            page_path: "/",
            dna: {
              product: "Dizayn məktəbi",
              icp: "Yeni başlayanlar",
              value_props: ["400+ məzun"],
              target_language: "az",
            },
            manifest: {
              "hero.headline": {
                css: ["h1"],
                text: ["Dizaynı sıfırdan öyrən"],
                structural: "first h1",
              },
              "hero.cta.label": {
                css: [".hero a.btn"],
                text: ["Qeydiyyat"],
                structural: "hero button",
              },
            },
          }),
        }),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; promoted: boolean };
    expect(body.ok).toBe(true);
    expect(body.promoted).toBe(true);

    expect(manifestRow?.confirmed_at).not.toBeNull();
    expect(JSON.parse(manifestRow?.manifest ?? "{}")["hero.cta.label"].css[0]).toBe(".hero a.btn");
    const dnaWrites = runs.filter((r) => r.sql.includes("INSERT INTO business_dna"));
    expect(dnaWrites.at(-1)?.params.at(-1)).toBe(0);
    expect(kv.get("v1:variant:c1:evaluation:default")?.value).toBe('{"sections":{}}');
    expect(kv.has("v1:preview:c1:/:evaluation:default")).toBe(false);
    expect(kv.has("v1:quickstart:c1:/")).toBe(false);
    expect(publishVersion).toHaveBeenCalledTimes(1);
    expect(publishVersion.mock.calls[0]?.[1]).toMatchObject({
      customerId: "c1",
      pagePath: "/",
      intentDim: "evaluation",
      sourceDim: "default",
    });
    expect(runs.some((r) => r.sql.includes("live_at = COALESCE(live_at, ?)"))).toBe(true);
  });

  it("rejects an empty brief", async () => {
    const res = await worker.fetch(
      new Request(
        "http://localhost/admin/onboard/go-live",
        authed({
          method: "POST",
          body: JSON.stringify({ customer_id: "c1", dna: { product: "" } }),
        }),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe("per-language (docs/specs/per-language.md)", () => {
  it("discovers the site's languages, reads each secondary page, drafts its brief, records consent flags", async () => {
    const res = await runQuickstart();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      languages: {
        lang: string;
        path: string;
        status: string;
        parts: number;
        brief_drafted: boolean;
        enabled: boolean;
      }[];
    };
    expect(body.languages.map((l) => [l.lang, l.path, l.status])).toEqual([
      ["az", "/", "primary"],
      ["en", "/en", "ready"],
    ]);
    expect(body.languages[1]?.brief_drafted).toBe(true);
    expect(body.languages[1]?.enabled).toBe(true);
    // The secondary page's manifest carries its language; its brief went to the i18n table.
    const stores = runs.filter((r) => r.sql.includes("INSERT INTO element_manifests"));
    expect(stores.map((r) => [r.params[1], r.params[6]])).toEqual([
      ["/", "az"],
      ["/en", "en"],
    ]);
    const i18n = runs.find((r) => r.sql.includes("INSERT INTO business_dna_i18n"));
    expect(i18n?.params[1]).toBe("en");
    expect(i18n?.params[9]).toBe(1);
    expect(runs.some((r) => r.sql.includes("UPDATE customers SET languages"))).toBe(true);
  });

  it("go-live confirms only the languages the customer ticked and writes the path→language map", async () => {
    await runQuickstart();
    kv.set("v1:preview:c1:/:evaluation:default", { value: '{"sections":{}}' });
    const res = await worker.fetch(
      new Request(
        "http://localhost/admin/onboard/go-live",
        authed({
          method: "POST",
          body: JSON.stringify({
            customer_id: "c1",
            page_path: "/",
            dna: { product: "p", icp: "i", value_props: ["v"], target_language: "az" },
            languages: ["en"],
          }),
        }),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { languages: { lang: string; path: string }[] };
    expect(body.languages).toEqual([
      { lang: "az", path: "/" },
      { lang: "en", path: "/en" },
    ]);
    const confirms = runs.filter((r) => r.sql.includes("SET confirmed_at = ?"));
    expect(confirms.map((r) => r.params[2])).toEqual(expect.arrayContaining(["/", "/en"]));
    expect(runs.some((r) => r.sql.includes("UPDATE business_dna_i18n SET draft = 0"))).toBe(true);
    expect(kv.has("v1:customer:c1:lang")).toBe(true);
  });
});

describe("a language on the same address (per-language.md; the Medora pilot, I1)", () => {
  /** A page whose switch sets the session and keeps the address: no hreflang, no /en path. */
  const SWITCH_PAGE =
    '<html lang="az"><head><title>Medora</title></head><body><nav><a class="dropdown-item" href="https://lumera.test/language/az"> Azərbaycan </a><a class="dropdown-item" href="https://lumera.test/language/en"> English </a></nav><h1>Dizaynı sıfırdan öyrən</h1><p>400+ məzun, Nümunə Bank</p></body></html>';
  const SAME_ADDRESS = {
    lang: "en",
    path: null,
    source: "switch",
    status: "same_address",
    parts: 0,
    brief_drafted: false,
    enabled: false,
  };

  async function quickstartOn(html: string) {
    kv.set("capture:c1:/", { value: html });
    return worker.fetch(
      new Request(
        "http://localhost/admin/onboard/quickstart",
        authed({ method: "POST", body: JSON.stringify({ customer_id: "c1", page_path: "/" }) }),
      ),
      makeEnv(),
      ctx,
    );
  }

  it("the quickstart says it, beside the languages that have a page, and reads nothing for it", async () => {
    const { fetchPageHtml, detectElements } = await import("../../src/detect-elements.ts");
    vi.mocked(fetchPageHtml).mockClear();
    vi.mocked(detectElements).mockClear();
    const res = await quickstartOn(SWITCH_PAGE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { languages: unknown[]; same_address: unknown[] };
    // The languages with a page: one, as before. The Look screen counts these.
    expect(body.languages).toEqual([
      {
        lang: "az",
        path: "/",
        source: "html-lang",
        status: "primary",
        parts: 2,
        brief_drafted: true,
        enabled: true,
      },
    ]);
    expect(body.same_address).toEqual([SAME_ADDRESS]);
    // The customer's row holds both kinds.
    expect(JSON.parse(customerLanguages ?? "[]")).toEqual([body.languages[0], SAME_ADDRESS]);
    // Nothing was fetched or detected for English: only the page in hand was read.
    expect(vi.mocked(fetchPageHtml)).not.toHaveBeenCalled();
    expect(vi.mocked(detectElements)).toHaveBeenCalledTimes(1);
    const stores = runs.filter((r) => r.sql.includes("INSERT INTO element_manifests"));
    expect(stores.map((r) => [r.params[1], r.params[6]])).toEqual([["/", "az"]]);
    expect(runs.some((r) => r.sql.includes("business_dna_i18n"))).toBe(false);

    // The GET answers the same record.
    const get = await worker.fetch(
      new Request("http://localhost/admin/onboard/quickstart?customer_id=c1", authed()),
      makeEnv(),
      ctx,
    );
    expect(((await get.json()) as { same_address: unknown[] }).same_address).toEqual([
      SAME_ADDRESS,
    ]);
  });

  it("a site with one language and no switch has none", async () => {
    const res = await quickstartOn(
      '<html lang="az"><body><h1>Dizaynı sıfırdan öyrən</h1><a href="/language/learning">Dil öyrən</a></body></html>',
    );
    const body = (await res.json()) as { languages: unknown[]; same_address: unknown[] };
    expect(body.languages).toHaveLength(1);
    expect(body.same_address).toEqual([]);
    expect(JSON.parse(customerLanguages ?? "[]")).toHaveLength(1);
  });

  it("a language with a page of its own is not also a same-address one", async () => {
    const res = await quickstartOn(
      '<html lang="az"><head><link rel="alternate" hreflang="en" href="https://lumera.test/en"/></head><body><a href="/language/az">AZ</a><a href="/language/en">EN</a><h1>Dizaynı sıfırdan öyrən</h1></body></html>',
    );
    const body = (await res.json()) as {
      languages: Array<{ lang: string; path: string }>;
      same_address: unknown[];
    };
    expect(body.languages.map((l) => [l.lang, l.path])).toEqual([
      ["az", "/"],
      ["en", "/en"],
    ]);
    expect(body.same_address).toEqual([]);
  });

  it("go live never enables it, confirms no page for it and maps no path to it, whatever is ticked", async () => {
    await quickstartOn(SWITCH_PAGE);
    kv.set("v1:preview:c1:/:evaluation:default", { value: '{"sections":{}}' });
    runs = [];
    const res = await worker.fetch(
      new Request(
        "http://localhost/admin/onboard/go-live",
        authed({
          method: "POST",
          body: JSON.stringify({
            customer_id: "c1",
            page_path: "/",
            dna: { product: "p", icp: "i", value_props: ["v"], target_language: "az" },
            // A client that ticked English anyway.
            languages: ["az", "en"],
          }),
        }),
      ),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { languages: unknown[] };
    expect(body.languages).toEqual([{ lang: "az", path: "/" }]);
    // The only page confirmed is the home page; no statement carries a null path.
    const confirms = runs.filter((r) => r.sql.includes("SET confirmed_at = ?"));
    expect(confirms.map((r) => r.params[2])).toEqual(["/"]);
    expect(runs.some((r) => r.params.includes(null) && r.sql.includes("element_manifests"))).toBe(
      false,
    );
    expect(runs.some((r) => r.sql.includes("business_dna_i18n"))).toBe(false);
    // The row keeps the entry, still off.
    const stored = JSON.parse(customerLanguages ?? "[]") as Array<Record<string, unknown>>;
    expect(stored.map((l) => [l.lang, l.path, l.status, l.enabled])).toEqual([
      ["az", "/", "primary", true],
      ["en", null, "same_address", false],
    ]);
    // The edge's path to language map: the home page in Azerbaijani, nothing else.
    expect(JSON.parse(kv.get("v1:customer:c1:lang")?.value ?? "{}")).toEqual({ "/": "az" });
  });
});

describe("an extra page after go-live (first-run.md §6)", () => {
  it("reads the page's elements and one preview, reuses the finished brief, touches nothing else", async () => {
    finishedBrief = {
      customer_id: "c1",
      product: "AI-native product studio",
      icp: "Fintech teams",
      brand_voice: "plain",
      value_props: '["Working result first"]',
      differentiators: "[]",
      proof_points: '["Nümunə Bank"]',
      target_market: "AZ",
      target_language: "en",
      per_intent_hints: "{}",
    };
    kv.set("capture:c1:/pricing", {
      value:
        '<html lang="en"><head><title>Pricing</title></head><body><h1>Fixed price. Two weeks.</h1><p>A go or no-go in two weeks.</p></body></html>',
    });
    const res = await worker.fetch(
      new Request("http://localhost/admin/onboard/quickstart", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Rawuser-Admin": "tok" },
        body: JSON.stringify({ customer_id: "c1", page_path: "/pricing" }),
      }),
      makeEnv(),
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      page_path: string;
      language: string;
      brief: { product: string };
      brief_gaps: string[];
      languages: unknown[];
    };
    expect(body.page_path).toBe("/pricing");
    expect(body.language).toBe("en");
    expect(body.brief.product).toBe("AI-native product studio");
    expect(body.brief_gaps).toEqual([]);
    expect(body.languages).toEqual([]);
    const sqls = runs.map((r) => r.sql);
    expect(sqls.some((s) => s.includes("INSERT INTO business_dna"))).toBe(false);
    expect(sqls.some((s) => s.includes("UPDATE customers SET languages"))).toBe(false);
    expect(sqls.some((s) => s.includes("preview_seen_at"))).toBe(false);
    expect(sqls.some((s) => s.includes("INSERT INTO element_manifests"))).toBe(true);
    expect(kv.has("capture:c1:/pricing")).toBe(false);
  });
});

describe("go-live for an extra page (first-run.md §6)", () => {
  it("confirms the page and promotes its preview without writing the brief again or touching languages", async () => {
    finishedBrief = {
      customer_id: "c1",
      product: "AI-native product studio",
      icp: "Fintech teams",
      brand_voice: "plain",
      value_props: '["Working result first"]',
      differentiators: "[]",
      proof_points: "[]",
      target_market: "AZ",
      target_language: "en",
      per_intent_hints: "{}",
    };
    manifestRow = {
      manifest: JSON.stringify({
        "hero.headline": { css: ["h1"], text: ["Fixed"], structural: "first h1" },
      }),
      confirmed_at: null,
    };
    customerLanguages = JSON.stringify([
      {
        lang: "en",
        path: "/",
        source: "html-lang",
        status: "primary",
        parts: 6,
        brief_drafted: true,
        enabled: true,
      },
      {
        lang: "az",
        path: "/az",
        source: "hreflang",
        status: "ready",
        parts: 6,
        brief_drafted: true,
        enabled: false,
      },
    ]);
    const res = await worker.fetch(
      new Request("http://localhost/admin/onboard/go-live", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Rawuser-Admin": "tok" },
        body: JSON.stringify({
          customer_id: "c1",
          page_path: "/approach",
          dna: {
            product: "AI-native product studio",
            icp: "Fintech teams",
            value_props: ["Working result first"],
          },
        }),
      }),
      makeEnv(),
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const sqls = runs.map((r) => r.sql);
    expect(sqls.some((s) => s.includes("INSERT INTO business_dna"))).toBe(false);
    expect(sqls.some((s) => s.includes("SET status = 'stale'"))).toBe(false);
    expect(sqls.some((s) => s.includes("UPDATE customers SET languages"))).toBe(false);
    expect(manifestRow?.confirmed_at).not.toBeNull();
  });
});

describe("an address that names one account (event-paths.md §8, condition 3)", () => {
  const post = (path: string, body: unknown) =>
    worker.fetch(
      new Request(
        `http://localhost${path}`,
        authed({ method: "POST", body: JSON.stringify(body) }),
      ),
      makeEnv(),
      ctx,
    );

  it("quickstart refuses it with the count pick's line", async () => {
    const res = await post("/admin/onboard/quickstart", {
      customer_id: "c1",
      page_path: "/agreement/48213377",
      allow_fetch: true,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "This address belongs to one account. Pick the button on a page every visitor sees.",
    );
  });

  it("go-live refuses it", async () => {
    const res = await post("/admin/onboard/go-live", {
      customer_id: "c1",
      page_path: "/orders/91234",
      dna: { product: "p", icp: "i", value_props: ["v"] },
    });
    expect(res.status).toBe(400);
  });
});
