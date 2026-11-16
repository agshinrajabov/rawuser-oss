/**
 * Pilot apply (docs/specs/pilot-apply.md, 2026-10-01): the invite token,
 * the guarded site read, the submit that creates the customer and its
 * draft brief, the superadmin list and archive, and the routing. Runs the
 * handlers' real SQL against node:sqlite with every migration applied.
 */

import { createHash } from "node:crypto";
import type { DnaSuggestions } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSTALL_ENV } from "../install-env.ts";
import { MODEL_ENV } from "../model-env.ts";
import { makeKv, makeSqliteD1 } from "./sqlite-d1.ts";

// ---------------------------------------------------------------------------
// Mocks before the worker import
// ---------------------------------------------------------------------------

type User = { id: string; email: string; role: string; customer_id: string | null };
const SUPERADMIN: User = {
  id: "u1",
  email: "founder@example.com",
  role: "superadmin",
  customer_id: null,
};
let sessionUser: User | null = SUPERADMIN;

vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionUser),
}));

const suggestMock = vi.fn<(html: string, url: string) => Promise<DnaSuggestions>>();
vi.mock("../../src/dna-suggest.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/dna-suggest.ts")>();
  return {
    ...actual,
    suggestDnaFromHtml: (html: string, url: string) => suggestMock(html, url),
  };
});

const { default: worker } = await import("../../src/index.ts");
const { slugFromDomain, briefFromAnswers } = await import("../../src/admin/apply-brief.ts");
const { mergeApplicationBrief } = await import("../../src/admin/apply.ts");
const { parseIPv6, isPublicIPv6, publicUrlProblem, normalizeSiteUrl, OFF_HOST_LINE } = await import(
  "../../src/lib/public-url.ts"
);

// ---------------------------------------------------------------------------
// Network: DNS-over-HTTPS, the customer's site, Telegram
// ---------------------------------------------------------------------------

const DNS: Record<string, string[] | "nx" | "down"> = {
  "northwind-app.test": ["93.184.216.34"],
  "bounce.example.com": ["93.184.216.35"],
  // Same site as bounce.example.com (www and the apex are one), private address.
  "www.bounce.example.com": ["169.254.169.254"],
  "hop.example.com": ["93.184.216.38"],
  "www.hop.example.com": ["93.184.216.38"],
  "down.example.com": ["93.184.216.36"],
  "sneaky.example.com": ["10.0.0.5"],
  "nowhere.example.com": "nx",
  "dnsdown.example.com": "down",
  "spa.example.com": ["93.184.216.37"],
};
/** A page built in the browser: the server sends an empty shell (a prospect's site, 2026-10-02). */
const SHELL = `<!doctype html><html lang="en"><head><title>MyBetaSoft - Biznes</title><script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>`;
const PAGE = `<html><body><h1>Northwind</h1><p>${"Northwind keeps your team's notes in one place. ".repeat(4)}</p></body></html>`;
const alerts: string[] = [];
let siteFetches = 0;

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
  if (url.hostname === "cloudflare-dns.com") {
    const name = url.searchParams.get("name") ?? "";
    const type = url.searchParams.get("type");
    const entry = DNS[name];
    if (entry === "down") return new Response("unavailable", { status: 503 });
    if (entry === "nx" || entry === undefined) return Response.json({ Status: 3 });
    const Answer = type === "A" ? entry.map((data) => ({ type: 1, data })) : [];
    return Response.json({ Status: 0, Answer });
  }
  if (url.hostname === "api.telegram.org") {
    alerts.push(url.searchParams.get("text") ?? "");
    return Response.json({ ok: true });
  }
  siteFetches++;
  expect(init?.redirect).toBe("manual");
  if (url.hostname === "northwind-app.test") return new Response(PAGE, { status: 200 });
  if (url.hostname === "bounce.example.com") {
    return new Response(null, {
      status: 302,
      headers: { location: "http://www.bounce.example.com/latest/meta-data/" },
    });
  }
  // A redirect to another host (never followed) and one to its own www (followed).
  if (url.hostname === "hop.example.com" && url.pathname === "/") {
    return new Response(null, {
      status: 301,
      headers: { location: "https://elsewhere.example.net/" },
    });
  }
  if (url.hostname === "hop.example.com" && url.pathname === "/www") {
    return new Response(null, {
      status: 301,
      headers: { location: "https://www.hop.example.com/" },
    });
  }
  if (url.hostname === "www.hop.example.com") return new Response(PAGE, { status: 200 });
  if (url.hostname === "down.example.com") return new Response("err", { status: 500 });
  if (url.hostname === "spa.example.com") return new Response(SHELL, { status: 200 });
  throw new Error(`unexpected fetch ${url.hostname}`);
}

function suggestions(url = "https://northwind-app.test/"): DnaSuggestions {
  const s = (text: string) => ({ text, evidence: text });
  return {
    url,
    generated_at: 1,
    language: "en",
    product: "Notes for teams",
    icp: "Small product teams",
    target_market: "Remote teams",
    brand_voice: "calm, direct",
    value_props: [s("One place for every note")],
    differentiators: [s("Works offline"), s("Faster than the rest")],
    proof_points: [s("Used by 40 teams")],
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let env: Record<string, unknown>;
let sql: ReturnType<typeof makeSqliteD1>["db"];
let kv: ReturnType<typeof makeKv>;
let pending: Promise<unknown>[];

beforeEach(() => {
  const made = makeSqliteD1();
  sql = made.db;
  kv = makeKv();
  env = {
    DB: made.d1,
    VARIANTS: kv,
    ENVIRONMENT: "test",
    DASHBOARD_ORIGIN: "https://app.example.com",
    ...INSTALL_ENV,
    ...MODEL_ENV,
    ALERT_WEBHOOK_URL: "https://api.telegram.org/botTEST/sendMessage?chat_id=1",
  };
  sessionUser = SUPERADMIN;
  alerts.length = 0;
  siteFetches = 0;
  pending = [];
  suggestMock.mockReset();
  suggestMock.mockImplementation(async (_html, url) => suggestions(url));
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function call(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> & unknown[] }> {
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const res = await worker.fetch(
    new Request(`https://api.example.com${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", "x-rawuser-admin": "session" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env as never,
    ctx,
  );
  await Promise.all(pending);
  return { status: res.status, json: (await res.json()) as never };
}

async function invite(body: { name?: string; site?: string } = {}) {
  const r = await call("/admin/applications/invite", { body });
  expect(r.status).toBe(200);
  const link = r.json.link as string;
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("t") as string;
  return { id: r.json.id as string, link, token, expires_at: r.json.expires_at as number };
}

const ANSWERS = {
  url: "northwind-app.test",
  product: "Shared notes for small product teams",
  icp: "Product leads at 5 to 20 person startups",
  differentiator: "Notes link to the tickets they came from",
  numbers: "$12/mo per seat\n\n 300 teams \n",
  sources: ["hacker_news", "LinkedIn", "ai"],
  name: "Ada Founder",
  email: "ada@northwind-app.test",
};

function row<T>(q: string, ...args: (string | number)[]): T {
  return sql.prepare(q).get(...args) as T;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

describe("invite token", () => {
  it("stores only the SHA-256 of a 32-byte base64url token, 14 days, link on the dashboard", async () => {
    const before = Date.now();
    const inv = await invite({ name: "Northwind", site: "northwind-app.test" });
    expect(inv.id).toMatch(/^app_[0-9a-f-]{36}$/);
    expect(inv.link).toBe(`https://app.example.com/apply/#t=${inv.token}`);
    expect(inv.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = row<Record<string, unknown>>(
      "SELECT * FROM pilot_applications WHERE id = ?",
      inv.id,
    );
    expect(stored.token_hash).toBe(createHash("sha256").update(inv.token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(inv.token);
    expect(stored.status).toBe("invited");
    expect(stored.reads).toBe(0);
    expect(inv.expires_at - (stored.created_at as number)).toBe(14 * 24 * 60 * 60 * 1000);
    expect(stored.created_at as number).toBeGreaterThanOrEqual(before);
  });

  it("reports invited, then applied with the customer, and 404 for an unknown token", async () => {
    const inv = await invite({ name: "Northwind" });
    const first = await call("/admin/apply/invite", { body: { t: inv.token } });
    expect(first.json).toMatchObject({ ok: true, status: "invited", invited_name: "Northwind" });

    await call("/admin/apply/submit", { body: { t: inv.token, ...ANSWERS } });
    const after = await call("/admin/apply/invite", { body: { t: inv.token } });
    expect(after.json).toMatchObject({ status: "applied", customer_id: "northwind-app" });

    expect((await call("/admin/apply/invite", { body: { t: "nope" } })).status).toBe(404);
    // The token never rides in a query string: the GET form is gone.
    const viaGet = await call(`/admin/apply/invite?t=${inv.token}`);
    expect(viaGet.status).toBe(404);
    expect(viaGet.json).toEqual({ error: "Not found" });
  });

  it("is single use: a second submit gets 409 and makes no second customer", async () => {
    const inv = await invite();
    const ok = await call("/admin/apply/submit", { body: { t: inv.token, ...ANSWERS } });
    expect(ok.status).toBe(200);
    const again = await call("/admin/apply/submit", { body: { t: inv.token, ...ANSWERS } });
    expect(again.status).toBe(409);
    expect(row<{ n: number }>("SELECT COUNT(*) AS n FROM customers").n).toBe(1);
    expect(
      (await call("/admin/apply/read", { body: { t: inv.token, url: ANSWERS.url } })).status,
    ).toBe(409);
  });

  it("expires: status expired, read and submit get 410", async () => {
    const inv = await invite();
    sql
      .prepare("UPDATE pilot_applications SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 1, inv.id);
    expect((await call("/admin/apply/invite", { body: { t: inv.token } })).json.status).toBe(
      "expired",
    );
    expect(
      (await call("/admin/apply/read", { body: { t: inv.token, url: ANSWERS.url } })).status,
    ).toBe(410);
    expect((await call("/admin/apply/submit", { body: { t: inv.token, ...ANSWERS } })).status).toBe(
      410,
    );
    expect(row<{ n: number }>("SELECT COUNT(*) AS n FROM customers").n).toBe(0);
  });

  it("an archived invite reads as expired and cannot be used", async () => {
    const inv = await invite();
    await call("/admin/applications/archive", { body: { id: inv.id } });
    expect((await call("/admin/apply/invite", { body: { t: inv.token } })).json.status).toBe(
      "expired",
    );
    expect((await call("/admin/apply/submit", { body: { t: inv.token, ...ANSWERS } })).status).toBe(
      410,
    );
  });
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

describe("read my site", () => {
  it("answers trimmed suggestions, and the fourth read gets 429", async () => {
    const inv = await invite();
    for (let i = 0; i < 3; i++) {
      const r = await call("/admin/apply/read", { body: { t: inv.token, url: ANSWERS.url } });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({
        ok: true,
        source: "server",
        suggestions: {
          product: "Notes for teams",
          icp: "Small product teams",
          differentiators: ["Works offline", "Faster than the rest"],
          proof_points: ["Used by 40 teams"],
          value_props: ["One place for every note"],
          language: "en",
        },
      });
    }
    const fourth = await call("/admin/apply/read", { body: { t: inv.token, url: ANSWERS.url } });
    expect(fourth.status).toBe(429);
    expect(siteFetches).toBe(3);
    expect(
      row<{ reads: number }>("SELECT reads FROM pilot_applications WHERE id = ?", inv.id).reads,
    ).toBe(3);
  });

  it.each([
    "http://127.0.0.1/",
    "127.0.0.1",
    "http://2130706433/",
    "http://10.1.2.3/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "localhost:3000",
    "http://localhost/",
    "http://app.localhost/",
    "http://printer.local/",
    "http://metadata.google.internal/",
    "http://169.254.169.254/latest/meta-data/",
    "ftp://northwind-app.test/",
    "file:///etc/passwd",
    "http://user:pass@northwind-app.test/",
    "http://northwind-app.test:8080/",
    "intranet",
    "",
  ])("refuses %s with 400 and spends no read", async (url) => {
    const inv = await invite();
    const r = await call("/admin/apply/read", { body: { t: inv.token, url } });
    expect(r.status).toBe(400);
    expect(siteFetches).toBe(0);
    expect(
      row<{ reads: number }>("SELECT reads FROM pilot_applications WHERE id = ?", inv.id).reads,
    ).toBe(0);
  });

  it("refuses a name that resolves to a private address, one that does not resolve, and a redirect to metadata", async () => {
    const inv = await invite();
    for (const url of ["sneaky.example.com", "nowhere.example.com", "bounce.example.com"]) {
      const r = await call("/admin/apply/read", { body: { t: inv.token, url } });
      expect(r.status).toBe(400);
    }
    // Only the bounce reached a site; the metadata hop was refused before any fetch.
    expect(siteFetches).toBe(1);
  });

  it("a redirect to another host is not followed: off_host, the read given back", async () => {
    const inv = await invite();
    const r = await call("/admin/apply/read", { body: { t: inv.token, url: "hop.example.com" } });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("off_host");
    expect(r.json.reason).toBe(OFF_HOST_LINE);
    // One fetch, the typed host; elsewhere.example.net never reached.
    expect(siteFetches).toBe(1);
    expect(
      row<{ reads: number }>("SELECT reads FROM pilot_applications WHERE id = ?", inv.id).reads,
    ).toBe(0);
  });

  it("a redirect from the typed host to its own www is followed", async () => {
    const inv = await invite();
    const r = await call("/admin/apply/read", {
      body: { t: inv.token, url: "https://hop.example.com/www" },
    });
    expect(r.status).toBe(200);
    expect(siteFetches).toBe(2);
  });

  it("fails closed when the DNS-over-HTTPS resolver cannot answer", async () => {
    const inv = await invite();
    const r = await call("/admin/apply/read", {
      body: { t: inv.token, url: "dnsdown.example.com" },
    });
    expect(r.status).toBe(400);
    expect(siteFetches).toBe(0);
  });

  it("gives 502 when the site cannot be read", async () => {
    const inv = await invite();
    const r = await call("/admin/apply/read", { body: { t: inv.token, url: "down.example.com" } });
    expect(r.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

describe("submit", () => {
  it("creates the customer, a draft brief from answers then suggestions, marks applied, sends the alert", async () => {
    const inv = await invite({ name: "Northwind" });
    await call("/admin/apply/read", { body: { t: inv.token, url: ANSWERS.url } });
    const r = await call("/admin/apply/submit", { body: { t: inv.token, ...ANSWERS } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      customer_id: "northwind-app",
      // Every tag we hand out carries data-cfasync (founder's call 2026-10-04).
      tag: '<script data-cfasync="false" src="https://edge.example.com/s/northwind-app.js"></script>',
      install: { platform: "other", tag_position: "not_found", csp: { blocks: false, lines: [] } },
    });
    // The read's suggestions were reused, not fetched again.
    expect(suggestMock).toHaveBeenCalledTimes(1);

    const customer = row<Record<string, unknown>>(
      "SELECT * FROM customers WHERE id = ?",
      "northwind-app",
    );
    expect(customer).toMatchObject({
      slug: "northwind-app",
      domain: "northwind-app.test",
      plan: "pilot",
      status: "active",
      contact_name: "Ada Founder",
      contact_email: "ada@northwind-app.test",
    });

    const dna = row<Record<string, string | number>>(
      "SELECT * FROM business_dna WHERE customer_id = ?",
      "northwind-app",
    );
    expect(dna.draft).toBe(1);
    expect(dna.product).toBe(ANSWERS.product);
    expect(dna.icp).toBe(ANSWERS.icp);
    expect(JSON.parse(dna.differentiators as string)).toEqual([
      ANSWERS.differentiator,
      "Works offline",
      "Faster than the rest",
    ]);
    expect(JSON.parse(dna.proof_points as string)).toEqual([
      "$12/mo per seat",
      "300 teams",
      "Used by 40 teams",
    ]);
    expect(JSON.parse(dna.value_props as string)).toEqual(["One place for every note"]);
    expect(dna.target_market).toBe("Remote teams");
    expect(dna.brand_voice).toBe("calm, direct");
    expect(dna.target_language).toBe("en");

    const app = row<Record<string, unknown>>(
      "SELECT * FROM pilot_applications WHERE id = ?",
      inv.id,
    );
    expect(app).toMatchObject({
      status: "applied",
      customer_id: "northwind-app",
      contact_name: "Ada Founder",
      contact_email: "ada@northwind-app.test",
      site_url: "https://northwind-app.test/",
    });
    expect(app.submitted_at).toEqual(expect.any(Number));
    expect(JSON.parse(app.answers as string)).toEqual({
      product: ANSWERS.product,
      icp: ANSWERS.icp,
      differentiator: ANSWERS.differentiator,
      numbers: ANSWERS.numbers.trim(),
      sources: ["hacker_news", "linkedin", "ai"],
    });

    expect(alerts).toEqual([
      "New pilot application: northwind-app.test · app.example.com/applications",
    ]);
    expect(alerts[0]).not.toContain("Northwind,");
    expect(alerts[0]).not.toContain("@");
    expect(kv.store.has(`apply-suggest:${inv.id}`)).toBe(false);
  });

  it("the special-category question: No is stored, the tag not withheld, one alert", async () => {
    const inv = await invite({ name: "Northwind" });
    const r = await call("/admin/apply/submit", {
      body: { t: inv.token, ...ANSWERS, special_category: false },
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, tag_withheld: false });
    expect(typeof r.json.tag).toBe("string");
    expect(
      row<Record<string, unknown>>(
        "SELECT special_category, special_category_at FROM customers WHERE id = ?",
        "northwind-app",
      ),
    ).toEqual({ special_category: 0, special_category_at: expect.any(Number) });
    expect(alerts).toEqual([
      "New pilot application: northwind-app.test · app.example.com/applications",
    ]);
    const after = await call("/admin/apply/invite", { body: { t: inv.token } });
    expect(after.json).toMatchObject({ status: "applied", tag_withheld: false });
  });

  it("a Yes is stored, the tag withheld on the submit and the invite answers, and the ops line carries the domain and the two words only", async () => {
    const inv = await invite({ name: "Northwind" });
    const r = await call("/admin/apply/submit", {
      body: { t: inv.token, ...ANSWERS, special_category: true },
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, customer_id: "northwind-app", tag_withheld: true });
    expect(
      row<Record<string, unknown>>(
        "SELECT special_category FROM customers WHERE id = ?",
        "northwind-app",
      ),
    ).toEqual({ special_category: 1 });
    expect(alerts).toEqual([
      "New pilot application: northwind-app.test · app.example.com/applications",
      "Special category: northwind-app.test",
    ]);
    expect(alerts[1]).not.toMatch(/@|Ada|health|religion|sexual|politic|union/i);
    const after = await call("/admin/apply/invite", { body: { t: inv.token } });
    expect(after.json).toMatchObject({ status: "applied", tag_withheld: true });
    // Marked by a superadmin: nothing withheld any more.
    sql.prepare("UPDATE customers SET sensitive = 1 WHERE id = 'northwind-app'").run();
    const marked = await call("/admin/apply/invite", { body: { t: inv.token } });
    expect(marked.json).toMatchObject({ status: "applied", tag_withheld: false });
  });

  it("without the field (an older form) the answer stays NULL and the submit works; a non-boolean is refused", async () => {
    const inv = await invite({ name: "Northwind" });
    const bad = await call("/admin/apply/submit", {
      body: { t: inv.token, ...ANSWERS, special_category: "yes" },
    });
    expect(bad).toMatchObject({
      status: 400,
      json: { error: "special_category must be true or false", field: "special_category" },
    });
    const r = await call("/admin/apply/submit", { body: { t: inv.token, ...ANSWERS } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, tag_withheld: true });
    expect(typeof r.json.tag).toBe("string");
    expect(
      row<Record<string, unknown>>(
        "SELECT special_category, special_category_at FROM customers WHERE id = ?",
        "northwind-app",
      ),
    ).toEqual({ special_category: null, special_category_at: null });
    expect(alerts).toHaveLength(1);
    const after = await call("/admin/apply/invite", { body: { t: inv.token } });
    expect(after.json).toMatchObject({ status: "applied", tag_withheld: true });
  });

  it("without a read it reads once; when that fails the brief uses the answers and value_props falls back to the product", async () => {
    suggestMock.mockRejectedValue(new Error("model down"));
    const inv = await invite();
    const r = await call("/admin/apply/submit", {
      body: { t: inv.token, ...ANSWERS, numbers: "", differentiator: "" },
    });
    expect(r.status).toBe(200);
    expect(suggestMock).toHaveBeenCalledTimes(1);
    const dna = row<Record<string, string>>(
      "SELECT * FROM business_dna WHERE customer_id = ?",
      "northwind-app",
    );
    expect(JSON.parse(dna.value_props)).toEqual([ANSWERS.product]);
    expect(JSON.parse(dna.differentiators)).toEqual([]);
    expect(JSON.parse(dna.proof_points)).toEqual([]);
    expect(dna.target_language).toBe("en");
    expect(alerts).toEqual([
      "New pilot application: northwind-app.test · app.example.com/applications",
    ]);
  });

  it("gives the slug a numeric suffix on a clash", async () => {
    sql
      .prepare(
        "INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES (?, ?, ?, 'pilot', 'active', 1)",
      )
      .run("northwind-app", "northwind-app", "old.example.com");
    const a = await invite();
    const b = await invite();
    const first = await call("/admin/apply/submit", { body: { t: a.token, ...ANSWERS } });
    const second = await call("/admin/apply/submit", { body: { t: b.token, ...ANSWERS } });
    expect(first.json.customer_id).toBe("northwind-app-2");
    expect(second.json.customer_id).toBe("northwind-app-3");
    expect(second.json.tag).toContain("/s/northwind-app-3.js");
  });

  it.each([
    ["product missing", { product: "" }],
    ["icp missing", { icp: "  " }],
    ["name missing", { name: undefined }],
    ["email missing", { email: "" }],
    ["url missing", { url: "" }],
    ["bad email", { email: "ada@nowhere" }],
    ["product too long", { product: "x".repeat(301) }],
    ["icp too long", { icp: "x".repeat(301) }],
    ["differentiator too long", { differentiator: "x".repeat(301) }],
    ["numbers too long", { numbers: "1".repeat(501) }],
    ["name too long", { name: "x".repeat(101) }],
    ["unknown source", { sources: ["tiktok"] }],
    ["too many sources", { sources: Array(11).fill("google") }],
    ["private url", { url: "http://10.0.0.1/" }],
  ])("400 on %s, and the invite stays usable", async (_label, patch) => {
    const inv = await invite();
    const r = await call("/admin/apply/submit", { body: { t: inv.token, ...ANSWERS, ...patch } });
    expect(r.status).toBe(400);
    expect(
      row<{ status: string }>("SELECT status FROM pilot_applications WHERE id = ?", inv.id).status,
    ).toBe("invited");
    expect(row<{ n: number }>("SELECT COUNT(*) AS n FROM customers").n).toBe(0);
  });

  it("accepts the limits exactly", async () => {
    const inv = await invite();
    const r = await call("/admin/apply/submit", {
      body: {
        t: inv.token,
        ...ANSWERS,
        product: "p".repeat(300),
        icp: "i".repeat(300),
        differentiator: "d".repeat(300),
        numbers: "1".repeat(500),
        name: "n".repeat(100),
        sources: [
          "google",
          "x",
          "reddit",
          "newsletter",
          "ads",
          "other",
          "Hacker News",
          "ChatGPT and AI tools",
          "linkedin",
          "ai",
        ],
      },
    });
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Superadmin list and archive
// ---------------------------------------------------------------------------

describe("applications list and archive", () => {
  it("joins the customer's funnel stamps, newest first, archived hidden unless all=1", async () => {
    const applied = await invite({ name: "Northwind" });
    await call("/admin/apply/submit", { body: { t: applied.token, ...ANSWERS } });
    sql
      .prepare("UPDATE customers SET tag_seen_at = 111, live_at = 222 WHERE id = 'northwind-app'")
      .run();
    const archived = await invite({ name: "Gone" });
    const fresh = await invite({ name: "Fresh", site: "fresh.io" });
    sql.prepare("UPDATE pilot_applications SET created_at = 1 WHERE id = ?").run(applied.id);
    sql.prepare("UPDATE pilot_applications SET created_at = 2 WHERE id = ?").run(archived.id);
    sql.prepare("UPDATE pilot_applications SET created_at = 3 WHERE id = ?").run(fresh.id);
    expect((await call("/admin/applications/archive", { body: { id: archived.id } })).json).toEqual(
      {
        ok: true,
        id: archived.id,
        status: "archived",
      },
    );

    const list = await call("/admin/applications/list");
    expect(list.status).toBe(200);
    const items = list.json as unknown as Record<string, unknown>[];
    expect(items.map((i) => i.id)).toEqual([fresh.id, applied.id]);
    expect(items[0]).toMatchObject({
      status: "invited",
      invited_name: "Fresh",
      invited_site: "fresh.io",
      customer_id: null,
      answers: null,
      tag_seen_at: null,
      live_at: null,
    });
    expect(items[1]).toMatchObject({
      status: "applied",
      customer_id: "northwind-app",
      contact_email: "ada@northwind-app.test",
      tag_seen_at: 111,
      live_at: 222,
    });
    expect((items[1]?.answers as Record<string, unknown>).sources).toEqual([
      "hacker_news",
      "linkedin",
      "ai",
    ]);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(
      [
        "id",
        "status",
        "invited_name",
        "invited_site",
        "created_at",
        "expires_at",
        "submitted_at",
        "contact_name",
        "contact_email",
        "site_url",
        "customer_id",
        "answers",
        "tag_seen_at",
        "live_at",
        // The free audit (ai-traffic-audit.md §17.4): the invite's kind, and
        // an audit row's state (null for a pilot).
        "kind",
        "audit",
      ].sort(),
    );
    expect(items[0]).toMatchObject({ kind: "pilot", audit: null });

    const all = await call("/admin/applications/list?all=1");
    expect((all.json as unknown as { id: string }[]).map((i) => i.id)).toEqual([
      fresh.id,
      archived.id,
      applied.id,
    ]);
  });

  it("archive answers 400 on a bad id and 404 on an unknown one", async () => {
    expect((await call("/admin/applications/archive", { body: { id: "plt_1" } })).status).toBe(400);
    expect(
      (await call("/admin/applications/archive", { body: { id: "app_missing" } })).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Deletion and retention (privacy review conditional pass, 2026-10-01)
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PERSONAL = "contact_name, contact_email, answers, site_url, invited_name";

describe("deletion and retention", () => {
  it("archive stamps archived_at once", async () => {
    const inv = await invite();
    await call("/admin/applications/archive", { body: { id: inv.id } });
    const first = row<{ archived_at: number }>(
      "SELECT archived_at FROM pilot_applications WHERE id = ?",
      inv.id,
    ).archived_at;
    expect(first).toEqual(expect.any(Number));
    sql.prepare("UPDATE pilot_applications SET archived_at = 5 WHERE id = ?").run(inv.id);
    await call("/admin/applications/archive", { body: { id: inv.id } });
    expect(
      row<{ archived_at: number }>(
        "SELECT archived_at FROM pilot_applications WHERE id = ?",
        inv.id,
      ).archived_at,
    ).toBe(5);
  });

  it("delete forgets the person on the application, its site read and the customers row", async () => {
    const inv = await invite({ name: "Northwind" });
    await call("/admin/apply/read", { body: { t: inv.token, url: ANSWERS.url } });
    // A read cached on an application that is then deleted before submit.
    const other = await invite({ name: "Other" });
    await call("/admin/apply/read", { body: { t: other.token, url: ANSWERS.url } });
    await call("/admin/apply/submit", { body: { t: inv.token, ...ANSWERS } });

    const r = await call("/admin/applications/delete", { body: { id: inv.id } });
    expect(r).toEqual({ status: 200, json: { ok: true, id: inv.id } });
    expect(row(`SELECT ${PERSONAL} FROM pilot_applications WHERE id = ?`, inv.id)).toEqual({
      contact_name: null,
      contact_email: null,
      answers: null,
      site_url: null,
      invited_name: null,
    });
    expect(
      row("SELECT contact_name, contact_email FROM customers WHERE id = ?", "northwind-app"),
    ).toEqual({ contact_name: null, contact_email: null });
    // The row and the customer stay; the funnel still counts.
    expect(row("SELECT status, customer_id FROM pilot_applications WHERE id = ?", inv.id)).toEqual({
      status: "applied",
      customer_id: "northwind-app",
    });

    expect(kv.store.has(`apply-suggest:${other.id}`)).toBe(true);
    await call("/admin/applications/delete", { body: { id: other.id } });
    expect(kv.store.has(`apply-suggest:${other.id}`)).toBe(false);
  });

  it("delete answers 400 on a bad id and 404 on an unknown one, and needs a superadmin", async () => {
    expect((await call("/admin/applications/delete", { body: { id: "x" } })).status).toBe(400);
    expect((await call("/admin/applications/delete", { body: { id: "app_none" } })).status).toBe(
      404,
    );
    sessionUser = { id: "u2", email: "c@x.example", role: "customer", customer_id: "acme" };
    expect((await call("/admin/applications/delete", { body: { id: "app_none" } })).status).toBe(
      403,
    );
    sessionUser = null;
    expect((await call("/admin/applications/delete", { body: { id: "app_none" } })).status).toBe(
      401,
    );
  });

  it("the 6-hour cron deletes unused invites 30 days past expiry and forgets archives after 90 days", async () => {
    const now = Date.now();
    const oldUnused = await invite();
    const recentUnused = await invite();
    sql
      .prepare("UPDATE pilot_applications SET expires_at = ? WHERE id = ?")
      .run(now - 31 * DAY, oldUnused.id);
    sql
      .prepare("UPDATE pilot_applications SET expires_at = ? WHERE id = ?")
      .run(now - 29 * DAY, recentUnused.id);
    kv.store.set(`apply-suggest:${oldUnused.id}`, "{}");

    const oldArchive = await invite({ name: "Old" });
    await call("/admin/apply/submit", { body: { t: oldArchive.token, ...ANSWERS } });
    const recentArchive = await invite({ name: "Recent" });
    await call("/admin/apply/submit", {
      body: { t: recentArchive.token, ...ANSWERS, email: "bo@northwind-app.test" },
    });
    await call("/admin/applications/archive", { body: { id: oldArchive.id } });
    await call("/admin/applications/archive", { body: { id: recentArchive.id } });
    sql
      .prepare("UPDATE pilot_applications SET archived_at = ? WHERE id = ?")
      .run(now - 91 * DAY, oldArchive.id);
    sql
      .prepare("UPDATE pilot_applications SET archived_at = ? WHERE id = ?")
      .run(now - 89 * DAY, recentArchive.id);
    // An applied, not archived, application is never touched by age.
    const applied = await invite();
    await call("/admin/apply/submit", { body: { t: applied.token, ...ANSWERS } });

    await worker.scheduled(
      { cron: "0 */6 * * *", scheduledTime: now } as ScheduledController,
      env as never,
      { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext,
    );
    await Promise.allSettled(pending);

    const ids = (sql.prepare("SELECT id FROM pilot_applications").all() as { id: string }[]).map(
      (r) => r.id,
    );
    expect(ids).not.toContain(oldUnused.id);
    expect(ids).toContain(recentUnused.id);
    expect(kv.store.has(`apply-suggest:${oldUnused.id}`)).toBe(false);

    expect(row(`SELECT ${PERSONAL} FROM pilot_applications WHERE id = ?`, oldArchive.id)).toEqual({
      contact_name: null,
      contact_email: null,
      answers: null,
      site_url: null,
      invited_name: null,
    });
    expect(
      row<{ contact_email: string | null }>(
        "SELECT contact_email FROM customers WHERE id = ?",
        "northwind-app",
      ).contact_email,
    ).toBeNull();

    expect(
      row<{ contact_email: string }>(
        "SELECT contact_email FROM pilot_applications WHERE id = ?",
        recentArchive.id,
      ).contact_email,
    ).toBe("bo@northwind-app.test");
    expect(
      row<{ contact_email: string }>(
        "SELECT contact_email FROM customers WHERE id = ?",
        "northwind-app-2",
      ).contact_email,
    ).toBe("bo@northwind-app.test");
    expect(
      row<{ contact_email: string }>(
        "SELECT contact_email FROM pilot_applications WHERE id = ?",
        applied.id,
      ).contact_email,
    ).toBe(ANSWERS.email);
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("routing", () => {
  it("the apply routes need no session", async () => {
    const inv = await invite();
    sessionUser = null;
    expect((await call("/admin/apply/invite", { body: { t: inv.token } })).status).toBe(200);
    expect(
      (await call("/admin/apply/read", { body: { t: inv.token, url: ANSWERS.url } })).status,
    ).toBe(200);
    expect((await call("/admin/apply/submit", { body: { t: inv.token, ...ANSWERS } })).status).toBe(
      200,
    );
  });

  it("the applications routes need a superadmin session", async () => {
    sessionUser = null;
    expect((await call("/admin/applications/list")).status).toBe(401);
    expect((await call("/admin/applications/invite", { body: {} })).status).toBe(401);
    sessionUser = { id: "u2", email: "c@x.example", role: "customer", customer_id: "acme" };
    expect((await call("/admin/applications/list")).status).toBe(403);
    expect((await call("/admin/applications/invite", { body: {} })).status).toBe(403);
    expect((await call("/admin/applications/archive", { body: { id: "app_x" } })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

describe("pure pieces", () => {
  it.each([
    ["northwind-app.test", "northwind-app"],
    ["www.northwind-app.test", "northwind-app"],
    ["foo.co.uk", "foo"],
    ["app.bar.io", "app-bar"],
    ["Lumera.TEST", "lumera"],
    ["xn--bcher-kva.de", "xn-bcher-kva"],
    ["localhost", "localhost"],
  ])("slugFromDomain(%s) = %s", (host, slug) => {
    expect(slugFromDomain(host)).toBe(slug);
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it("classifies IPv6 literals", () => {
    const pub = (s: string) => isPublicIPv6(parseIPv6(s) as number[]);
    expect(pub("2606:4700::1111")).toBe(true);
    expect(pub("::1")).toBe(false);
    expect(pub("::")).toBe(false);
    expect(pub("::ffff:10.0.0.1")).toBe(false);
    expect(pub("::ffff:8.8.8.8")).toBe(true);
    expect(pub("64:ff9b::a9fe:a9fe")).toBe(false);
    expect(pub("2001:db8::1")).toBe(false);
    expect(parseIPv6("1::2::3")).toBeNull();
  });

  it("accepts a public site by syntax", () => {
    expect(publicUrlProblem(normalizeSiteUrl("northwind-app.test/pricing") as URL)).toBeNull();
    expect(publicUrlProblem(normalizeSiteUrl("https://8.8.8.8/") as URL)).toBeNull();
  });

  it("the first run keeps the applicant's answers and fills only the empty fields", () => {
    const applied = briefFromAnswers(
      "c1",
      { product: "Mine", icp: "My people", differentiator: "Mine too", numbers: "", sources: [] },
      null,
      1,
    );
    const drafted = {
      ...applied,
      product: "Page product",
      icp: "Page icp",
      value_props: ["From the page"],
      differentiators: ["Page diff"],
      proof_points: ["Page proof"],
      brand_voice: "page voice",
      target_language: "az",
    };
    const merged = mergeApplicationBrief(drafted, ["icp", "value_props"], applied);
    expect(merged.brief).toMatchObject({
      product: "Mine",
      icp: "My people",
      value_props: ["Mine"],
      differentiators: ["Mine too"],
      proof_points: ["Page proof"],
      brand_voice: "page voice",
      target_language: "az",
    });
    expect(merged.gaps).toEqual([]);
  });
});

// 2026-10-02: a prospect's site burned three reads on an empty shell, then the
// applicant could not tell which answer the submit refused.
describe("a page built in the browser, and refusals that name the field", () => {
  it("an empty shell answers 422 client_rendered, gives the read back and never calls the model", async () => {
    const inv = await invite();
    for (let i = 0; i < 4; i++) {
      const r = await call("/admin/apply/read", { body: { t: inv.token, url: "spa.example.com" } });
      expect(r.status).toBe(422);
      expect(r.json.error).toBe("client_rendered");
    }
    const app = row<{ reads: number }>("SELECT reads FROM pilot_applications WHERE id = ?", inv.id);
    expect(app.reads).toBe(0);
    expect(suggestMock).not.toHaveBeenCalled();
  });

  it("the submit still works on such a site, from the answers alone", async () => {
    const inv = await invite();
    const r = await call("/admin/apply/submit", {
      body: { t: inv.token, ...ANSWERS, url: "https://spa.example.com/" },
    });
    expect(r.status).toBe(200);
    expect(r.json.customer_id).toBe("spa-example");
  });

  it("a refused submit names the field", async () => {
    const inv = await invite();
    const long = await call("/admin/apply/submit", {
      body: { t: inv.token, ...ANSWERS, icp: "x".repeat(301) },
    });
    expect(long.status).toBe(400);
    expect(long.json.field).toBe("icp");
    const mail = await call("/admin/apply/submit", {
      body: { t: inv.token, ...ANSWERS, email: "not-an-email" },
    });
    expect(mail.json.field).toBe("email");
  });
});
