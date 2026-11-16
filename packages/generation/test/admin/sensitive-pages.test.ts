/**
 * Pages with versions for a sensitive customer (docs/specs/sensitive-customers.md,
 * privacy review condition 2): adding, picking, confirming or going live
 * with a page that is neither `/` nor a kept section answers 409 with one
 * sentence, on every endpoint that can do it, and writes nothing. A kept
 * section and `/` pass; a customer that is not sensitive is not asked.
 * Real SQL on node:sqlite; the model and the page fetch are stubbed.
 */
import {
  type PickStore,
  captureKey,
  pickCountKey,
  pickKey,
  receivePick,
  visitorBundleKey,
} from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness } from "../proof-harness.ts";

vi.mock("../../src/detect-elements.ts", () => ({
  fetchPageHtml: vi.fn(async () => "<html><body><h1>Test</h1></body></html>"),
  detectElements: vi.fn(async () => ({
    manifest: { "hero.headline": { css: ["h1"], text: ["Test"], structural: "first h1" } },
    cost_usd: 0.01,
    source_html_bytes: 42,
  })),
  cleanHtml: vi.fn((html: string) => html),
}));

const regenerateOne = vi.fn(async () => ({
  customer_id: "medora",
  intent_dim: "problem",
  source_dim: "ai",
  kv_key: "k",
  cost_usd: 0,
  ok: true,
}));
vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(),
  regenerateOne: (...args: unknown[]) => regenerateOne(...(args as [])),
}));

type User = { id: string; email: string; role: string; customer_id: string | null };
const MEDORA: User = { id: "u2", email: "c@medora.test", role: "customer", customer_id: "medora" };
const SUPERADMIN: User = {
  id: "u1",
  email: "f@example.com",
  role: "superadmin",
  customer_id: null,
};
let sessionUser: User = MEDORA;
vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionUser),
}));

const { default: worker } = await import("../../src/index.ts");
const { detectElements, fetchPageHtml } = await import("../../src/detect-elements.ts");
const { SENSITIVE_PAGE_LINE } = await import("../../src/lib/sensitive-guard.ts");
const { storeUnconfirmedManifest } = await import("../../src/admin/onboard.ts");

let h: Harness;
beforeEach(() => {
  h = harness();
  h.customer("medora");
  h.customer("acme");
  h.db
    .prepare(
      "UPDATE customers SET sensitive = 1, kept_sections = '[\"/about\",\"/products\"]' WHERE id = 'medora'",
    )
    .run();
  sessionUser = MEDORA;
  regenerateOne.mockClear();
  vi.mocked(detectElements).mockClear();
  vi.mocked(fetchPageHtml).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`https://api.example.com${path}`, {
      method,
      headers: { "x-rawuser-admin": "session", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    h.env as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** The one 409 body, for the page as it would have been stored. */
const refused = (page: string) => ({
  status: 409,
  json: { error: SENSITIVE_PAGE_LINE, code: "sensitive_page", page_path: page },
});

const MANIFEST = JSON.stringify({
  "hero.headline": { css: ["h1"], text: ["Old"], structural: "first h1" },
});

function page(customer: string, path: string, confirmed: boolean) {
  h.db
    .prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at) VALUES (?, ?, ?, 'https://x.test/', 1, ?)",
    )
    .run(customer, path, MANIFEST, confirmed ? 5 : null);
}

const manifests = () =>
  h.db
    .prepare("SELECT customer_id, page_path, confirmed_at FROM element_manifests ORDER BY 1, 2")
    .all();
const targets = () =>
  h.db
    .prepare("SELECT customer_id, section_path, enabled FROM conversion_targets ORDER BY 1, 2")
    .all();
const store = () => h.env.VARIANTS as unknown as PickStore;
const DNA = { product: "p", icp: "i", value_props: ["v"], target_language: "az" };
const BUTTON = { css: ["a.order"], text: ["Order"], structural: "first a in main" };

const FOREIGN = "/products/ginseng";

describe("the sentence", () => {
  it("is one plain sentence with no dash", () => {
    expect(SENSITIVE_PAGE_LINE).toMatch(/^[^.]+\.$/);
    expect(SENSITIVE_PAGE_LINE).not.toMatch(/[–—]/);
  });
});

describe("add a page", () => {
  it("POST /admin/onboard/capture-token: no link for a page outside the list", async () => {
    const r = await call("POST", "/admin/onboard/capture-token", {
      customer_id: "medora",
      source_url: `https://medora.test${FOREIGN}`,
    });
    expect(r).toEqual(refused(FOREIGN));
    expect([...h.kv.keys()]).toEqual([]);
  });

  it("POST /admin/onboard/capture-token: / and a kept section pass", async () => {
    for (const path of ["/", "/products", "/About/"]) {
      const r = await call("POST", "/admin/onboard/capture-token", {
        customer_id: "medora",
        source_url: `https://medora.test${path}`,
      });
      expect(r.status).toBe(200);
    }
  });

  it("POST /admin/onboard/detect: by page_path and by the URL's own path, nothing fetched or stored", async () => {
    const byPath = await call("POST", "/admin/onboard/detect", {
      customer_id: "medora",
      source_url: "https://medora.test/",
      page_path: FOREIGN,
    });
    expect(byPath).toEqual(refused(FOREIGN));
    const byUrl = await call("POST", "/admin/onboard/detect", {
      customer_id: "medora",
      source_url: "https://medora.test/Ginseng/",
    });
    expect(byUrl).toEqual(refused("/ginseng"));
    expect(vi.mocked(fetchPageHtml)).not.toHaveBeenCalled();
    expect(vi.mocked(detectElements)).not.toHaveBeenCalled();
    expect(manifests()).toEqual([]);
  });

  it("POST /admin/onboard/detect: a kept section is read and stored unconfirmed", async () => {
    const r = await call("POST", "/admin/onboard/detect", {
      customer_id: "medora",
      source_url: "https://medora.test/products",
    });
    expect(r.status).toBe(200);
    expect(manifests()).toEqual([
      { customer_id: "medora", page_path: "/products", confirmed_at: null },
    ]);
  });

  it("POST /admin/onboard/quickstart: refused before the capture is read or anything is spent", async () => {
    h.kv.set(captureKey("medora", FOREIGN), "<html><body><h1>Ginseng</h1></body></html>");
    const r = await call("POST", "/admin/onboard/quickstart", {
      customer_id: "medora",
      page_path: FOREIGN,
      allow_fetch: true,
    });
    expect(r).toEqual(refused(FOREIGN));
    expect(h.kv.has(captureKey("medora", FOREIGN))).toBe(true);
    expect(vi.mocked(detectElements)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchPageHtml)).not.toHaveBeenCalled();
    expect(manifests()).toEqual([]);
  });

  it("POST /admin/onboard/quickstart: a kept section goes on to its own steps", async () => {
    const r = await call("POST", "/admin/onboard/quickstart", {
      customer_id: "medora",
      page_path: "/products",
    });
    expect(r).toEqual({ status: 409, json: { error: "no_capture" } });
  });

  it("the store itself refuses the page, should a new caller forget", async () => {
    await expect(
      storeUnconfirmedManifest(h.d1, {
        customer_id: "medora",
        page_path: FOREIGN,
        manifest: JSON.parse(MANIFEST),
        source_url: "https://medora.test/products/ginseng",
        cost_usd: 0,
      }),
    ).rejects.toThrow("page is outside the kept sections");
    expect(manifests()).toEqual([]);
  });
});

describe("the rewrite pick", () => {
  it("POST /admin/onboard/pick-token: no link for a page outside the list", async () => {
    const r = await call("POST", "/admin/onboard/pick-token", {
      customer_id: "medora",
      page_path: FOREIGN,
    });
    expect(r).toEqual(refused(FOREIGN));
    expect([...h.kv.keys()]).toEqual([]);
    const ok = await call("POST", "/admin/onboard/pick-token", {
      customer_id: "medora",
      page_path: "/about",
    });
    expect(ok.status).toBe(200);
  });

  it("GET /admin/onboard/pick-status: a pick from before the mark is dropped unread", async () => {
    h.kv.set(pickKey("medora", FOREIGN), MANIFEST);
    const r = await call(
      "GET",
      `/admin/onboard/pick-status?customer_id=medora&page_path=${FOREIGN}`,
    );
    expect(r).toEqual(refused(FOREIGN));
    expect(h.kv.has(pickKey("medora", FOREIGN))).toBe(false);
    expect(manifests()).toEqual([]);
  });

  it("GET /admin/onboard/pick-status: a pick on a kept section lands unconfirmed", async () => {
    h.kv.set(pickKey("medora", "/products"), MANIFEST);
    const r = await call(
      "GET",
      "/admin/onboard/pick-status?customer_id=medora&page_path=/products",
    );
    expect(r.status).toBe(200);
    expect(r.json.landed).toBe(true);
    expect(manifests()).toEqual([
      { customer_id: "medora", page_path: "/products", confirmed_at: null },
    ]);
  });
});

describe("confirm and go live", () => {
  it("POST /admin/onboard/confirm: a page outside the list stays unconfirmed, the bundle is not written", async () => {
    page("medora", FOREIGN, false);
    const r = await call("POST", "/admin/onboard/confirm", {
      customer_id: "medora",
      page_path: FOREIGN,
    });
    expect(r).toEqual(refused(FOREIGN));
    expect(manifests()).toEqual([
      { customer_id: "medora", page_path: FOREIGN, confirmed_at: null },
    ]);
    expect(h.kv.has(visitorBundleKey("medora"))).toBe(false);
  });

  it("POST /admin/onboard/confirm: / and a kept section are confirmed, the bundle carries s and sk", async () => {
    page("medora", "/", false);
    page("medora", "/products", false);
    for (const path of ["/", "/products"]) {
      const r = await call("POST", "/admin/onboard/confirm", {
        customer_id: "medora",
        page_path: path,
      });
      expect(r.status).toBe(200);
    }
    const bundle = JSON.parse(h.kv.get(visitorBundleKey("medora")) ?? "{}");
    expect(Object.keys(bundle.pages).sort()).toEqual(["/", "/products"]);
    expect(bundle).toMatchObject({ s: 1, sk: ["/about", "/products"] });
  });

  it("POST /admin/onboard/go-live: a page outside the list is refused before anything is written", async () => {
    page("medora", FOREIGN, false);
    const r = await call("POST", "/admin/onboard/go-live", {
      customer_id: "medora",
      page_path: FOREIGN,
      dna: DNA,
    });
    expect(r).toEqual(refused(FOREIGN));
    expect(manifests()).toEqual([
      { customer_id: "medora", page_path: FOREIGN, confirmed_at: null },
    ]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM business_dna").get()).toEqual({ n: 0 });
    expect(h.db.prepare("SELECT live_at FROM customers WHERE id = 'medora'").get()).toEqual({
      live_at: null,
    });
  });

  it("POST /admin/onboard/go-live: a button picked on a page outside the list is refused as the count", async () => {
    page("medora", "/", false);
    const r = await call("POST", "/admin/onboard/go-live", {
      customer_id: "medora",
      page_path: "/",
      dna: DNA,
      count: { section_path: `count:${FOREIGN}` },
    });
    expect(r).toEqual(refused(FOREIGN));
    expect(manifests()).toEqual([{ customer_id: "medora", page_path: "/", confirmed_at: null }]);
  });

  it("POST /admin/onboard/go-live: a language's page outside the list stays off and is named; a kept one is confirmed", async () => {
    page("medora", "/", false);
    page("medora", "/en", false);
    page("medora", "/about", false);
    const languages = [
      { lang: "az", path: "/", source: "html-lang", status: "primary", parts: 1 },
      { lang: "en", path: "/en", source: "hreflang", status: "ready", parts: 1 },
      { lang: "ru", path: "/about", source: "hreflang", status: "ready", parts: 1 },
    ].map((l) => ({ ...l, brief_drafted: true, enabled: true }));
    h.db
      .prepare("UPDATE customers SET languages = ? WHERE id = 'medora'")
      .run(JSON.stringify(languages));
    const r = await call("POST", "/admin/onboard/go-live", {
      customer_id: "medora",
      page_path: "/",
      dna: DNA,
    });
    expect(r.status).toBe(200);
    expect(r.json.languages).toEqual([
      { lang: "az", path: "/" },
      { lang: "ru", path: "/about" },
    ]);
    expect(r.json.languages_refused).toEqual([{ lang: "en", path: "/en" }]);
    const rows = manifests() as Array<{ page_path: string; confirmed_at: number | null }>;
    expect(rows.find((m) => m.page_path === "/en")?.confirmed_at).toBeNull();
    expect(rows.find((m) => m.page_path === "/about")?.confirmed_at).not.toBeNull();
    expect(rows.find((m) => m.page_path === "/")?.confirmed_at).not.toBeNull();
    const bundle = JSON.parse(h.kv.get(visitorBundleKey("medora")) ?? "{}");
    expect(Object.keys(bundle.pages).sort()).toEqual(["/", "/about"]);
  });
});

describe("the count pick and the counted buttons", () => {
  it("POST /admin/conversions/pick-token: no link for a page outside the list", async () => {
    const r = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "medora",
      page_path: FOREIGN,
    });
    expect(r).toEqual(refused(FOREIGN));
    expect([...h.kv.keys()]).toEqual([]);
    const ok = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "medora",
      page_path: "/products",
    });
    expect(ok.status).toBe(200);
  });

  it("GET /admin/conversions/pick-status: a pick from before the mark is dropped, no target written", async () => {
    h.db.prepare("UPDATE customers SET sensitive = 0 WHERE id = 'medora'").run();
    const mint = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "medora",
      page_path: FOREIGN,
    });
    expect(mint.status).toBe(200);
    const posted = await receivePick(
      { token: mint.json.token, button: BUTTON, page_path: FOREIGN },
      store(),
    );
    expect(posted.status).toBe(200);
    h.db.prepare("UPDATE customers SET sensitive = 1 WHERE id = 'medora'").run();
    const r = await call(
      "GET",
      `/admin/conversions/pick-status?customer_id=medora&page_path=${FOREIGN}`,
    );
    expect(r).toEqual(refused(FOREIGN));
    expect(h.kv.has(pickCountKey("medora", FOREIGN))).toBe(false);
    expect(targets()).toEqual([]);
  });

  it("GET /admin/conversions/pick-status: a pick on a kept section becomes the counted button", async () => {
    const mint = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "medora",
      page_path: "/products",
    });
    await receivePick({ token: mint.json.token, button: BUTTON, page_path: "/products" }, store());
    const r = await call(
      "GET",
      "/admin/conversions/pick-status?customer_id=medora&page_path=/products",
    );
    expect(r.status).toBe(200);
    expect(targets()).toEqual([
      { customer_id: "medora", section_path: "count:/products", enabled: 1 },
    ]);
  });

  it("POST /admin/conversions/upsert: a picked-button target for a page outside the list is refused; a slot passes", async () => {
    const r = await call("POST", "/admin/conversions/upsert", {
      customer_id: "medora",
      section_path: `count:${FOREIGN}`,
      label: "Order",
      css_selectors: ["a.order"],
      structural_selector: "a.order",
    });
    expect(r).toEqual(refused(FOREIGN));
    expect(targets()).toEqual([]);
    const slot = await call("POST", "/admin/conversions/upsert", {
      customer_id: "medora",
      section_path: "hero.cta.label",
      label: "Order",
      css_selectors: ["a.order"],
      structural_selector: "a.order",
    });
    expect(slot.status).toBe(200);
  });

  it("POST /admin/conversions/count: a button picked before the mark is never switched on", async () => {
    h.db
      .prepare(
        `INSERT INTO conversion_targets (id, customer_id, section_path, label, conversion_label, enabled,
           css_selectors, text_selectors, structural_selector, created_at, updated_at)
         VALUES ('t_old', 'medora', ?, 'Order', 'other', 0, '["a.order"]', '["Order"]', 'a.order', 1, 1)`,
      )
      .run(`count:${FOREIGN}`);
    const r = await call("POST", "/admin/conversions/count", {
      customer_id: "medora",
      id: "t_old",
    });
    expect(r).toEqual(refused(FOREIGN));
    expect(targets()).toEqual([
      { customer_id: "medora", section_path: `count:${FOREIGN}`, enabled: 0 },
    ]);
  });
});

describe("a version", () => {
  it("POST /admin/variant/regenerate: none is written for a page outside the list", async () => {
    const r = await call("POST", "/admin/variant/regenerate", {
      customer_id: "medora",
      intent_dim: "problem",
      source_dim: "ai",
      page_path: FOREIGN,
    });
    expect(r).toEqual(refused(FOREIGN));
    expect(regenerateOne).not.toHaveBeenCalled();
    const kept = await call("POST", "/admin/variant/regenerate", {
      customer_id: "medora",
      intent_dim: "problem",
      source_dim: "ai",
      page_path: "/products",
    });
    expect(kept.status).toBe(200);
    expect(regenerateOne).toHaveBeenCalledTimes(1);
  });
});

describe("with an empty list", () => {
  it("only / passes", async () => {
    h.db.prepare("UPDATE customers SET kept_sections = NULL WHERE id = 'medora'").run();
    const about = await call("POST", "/admin/onboard/pick-token", {
      customer_id: "medora",
      page_path: "/about",
    });
    expect(about).toEqual(refused("/about"));
    const home = await call("POST", "/admin/onboard/pick-token", { customer_id: "medora" });
    expect(home.status).toBe(200);
  });
});

describe("a customer that is not sensitive", () => {
  it("adds, picks, confirms and counts any page as before", async () => {
    sessionUser = SUPERADMIN;
    const mint = await call("POST", "/admin/onboard/capture-token", {
      customer_id: "acme",
      source_url: `https://acme.test${FOREIGN}`,
    });
    expect(mint.status).toBe(200);
    const pick = await call("POST", "/admin/onboard/pick-token", {
      customer_id: "acme",
      page_path: FOREIGN,
    });
    expect(pick.status).toBe(200);
    page("acme", FOREIGN, false);
    const confirm = await call("POST", "/admin/onboard/confirm", {
      customer_id: "acme",
      page_path: FOREIGN,
    });
    expect(confirm.status).toBe(200);
    const count = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      page_path: FOREIGN,
    });
    expect(count.status).toBe(200);
    const live = await call("POST", "/admin/onboard/go-live", {
      customer_id: "acme",
      page_path: FOREIGN,
      dna: DNA,
    });
    expect(live.status).toBe(200);
    expect(live.json).not.toHaveProperty("languages_refused");
    const bundle = JSON.parse(h.kv.get(visitorBundleKey("acme")) ?? "{}");
    expect(Object.keys(bundle.pages)).toEqual([FOREIGN]);
    expect(bundle).not.toHaveProperty("s");
    expect(bundle).not.toHaveProperty("sk");
  });
});
