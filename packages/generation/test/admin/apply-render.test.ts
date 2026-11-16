/**
 * The apply read and submit on a page built in the browser
 * (docs/specs/install-friction.md A; Tests, "Apply"): a shell is rendered
 * with Browser Run and still counts one read; a failed render gives the
 * read back and answers 422; bot protection has its own code; a redirect
 * to a private address inside the render is refused with 400 (a move to
 * another host with 422 off_host); a rendered
 * page that carries our tag never reaches the edge. Browser Run is a fake
 * (test/lib/fake-browser.ts) behind the @cloudflare/puppeteer module.
 */

import type { DnaSuggestions } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSTALL_ENV } from "../install-env.ts";
import { type FakeLog, type FakeSite, fakeLauncher, newLog } from "../lib/fake-browser.ts";
import { MODEL_ENV } from "../model-env.ts";
import { makeKv, makeSqliteD1 } from "./sqlite-d1.ts";

let site: FakeSite;
let browserLog: FakeLog;

vi.mock("@cloudflare/puppeteer", () => ({
  default: { launch: (binding: unknown) => fakeLauncher(site, browserLog)(binding as never) },
}));

const SUPERADMIN = {
  id: "u1",
  email: "founder@example.com",
  role: "superadmin",
  customer_id: null,
};
vi.mock("../../src/admin/auth.ts", () => ({ getSessionUser: vi.fn(async () => SUPERADMIN) }));

const suggestMock = vi.fn<(html: string, url: string) => Promise<DnaSuggestions>>();
vi.mock("../../src/dna-suggest.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/dna-suggest.ts")>();
  return { ...actual, suggestDnaFromHtml: (html: string, url: string) => suggestMock(html, url) };
});

const { default: worker } = await import("../../src/index.ts");

const SHELL = `<!doctype html><html lang="en"><head><title>MyBetaSoft</title><script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>`;
const RENDERED = `<html><head><title>MyBetaSoft</title></head><body><h1>MyBetaSoft</h1><p>${"Biznes idarəetmə həlləri, kiçik komandalar üçün. ".repeat(5)}</p></body></html>`;

const DNS: Record<string, string[]> = {
  "spa.example.com": ["93.184.216.37"],
  "guarded.example.com": ["93.184.216.38"],
  "metadata.example.com": ["169.254.169.254"],
  "www.spa.example.com": ["169.254.169.254"],
};

let siteResponses: Record<string, () => Response>;

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
  if (url.hostname === "cloudflare-dns.com") {
    const entry = DNS[url.searchParams.get("name") ?? ""];
    if (!entry) return Response.json({ Status: 3 });
    const type = url.searchParams.get("type");
    return Response.json({
      Status: 0,
      Answer: type === "A" ? entry.map((data) => ({ type: 1, data })) : [],
    });
  }
  if (url.hostname === "api.telegram.org") return Response.json({ ok: true });
  const make = siteResponses[url.hostname];
  if (!make) throw new Error(`unexpected fetch ${url.hostname}`);
  return make();
}

let env: Record<string, unknown>;
let sql: ReturnType<typeof makeSqliteD1>["db"];
let pending: Promise<unknown>[];

beforeEach(() => {
  const made = makeSqliteD1();
  sql = made.db;
  env = {
    DB: made.d1,
    VARIANTS: makeKv(),
    ENVIRONMENT: "test",
    DASHBOARD_ORIGIN: "https://app.example.com",
    ...INSTALL_ENV,
    ...MODEL_ENV,
    BROWSER: { fetch: async () => new Response("") },
  };
  pending = [];
  site = { hops: ["https://spa.example.com/"], html: RENDERED };
  browserLog = newLog();
  siteResponses = {
    "spa.example.com": () => new Response(SHELL, { status: 200 }),
    "guarded.example.com": () =>
      new Response("<title>Vercel Security Checkpoint</title>", { status: 403 }),
  };
  suggestMock.mockReset();
  suggestMock.mockImplementation(async (_html, url) => ({
    url,
    generated_at: 1,
    language: "az",
    product: "Biznes idarəetmə",
    icp: "Kiçik komandalar",
    target_market: "",
    brand_voice: "",
    value_props: [],
    differentiators: [],
    proof_points: [],
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function call(path: string, body: unknown) {
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const res = await worker.fetch(
    new Request(`https://api.example.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rawuser-admin": "session" },
      body: JSON.stringify(body),
    }),
    env as never,
    ctx,
  );
  await Promise.all(pending);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function invite() {
  const r = await call("/admin/applications/invite", {});
  const token = new URLSearchParams(new URL(r.json.link as string).hash.slice(1)).get(
    "t",
  ) as string;
  return { id: r.json.id as string, token };
}

const reads = (id: string) =>
  (sql.prepare("SELECT reads FROM pilot_applications WHERE id = ?").get(id) as { reads: number })
    .reads;

describe("apply read on a page built in the browser", () => {
  it("renders the shell, reads the rendered text, and counts one read", async () => {
    const inv = await invite();
    const r = await call("/admin/apply/read", { t: inv.token, url: "spa.example.com" });
    expect(r.status).toBe(200);
    expect(r.json.source).toBe("render");
    expect(suggestMock).toHaveBeenCalledOnce();
    expect(suggestMock.mock.calls[0]?.[0]).toContain("<h1>MyBetaSoft</h1>");
    expect(reads(inv.id)).toBe(1);
    expect(browserLog.launched).toBe(1);
    expect(browserLog.closed).toBe(1);
  });

  it("a render that reads nothing gives the read back: 422 render_failed", async () => {
    site.html = "<html><body><div id=root></div></body></html>";
    const inv = await invite();
    const r = await call("/admin/apply/read", { t: inv.token, url: "spa.example.com" });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("render_failed");
    expect(reads(inv.id)).toBe(0);
    expect(suggestMock).not.toHaveBeenCalled();
  });

  it("a rendered bot check: 422 bot_protection, read given back", async () => {
    site.title = "Just a moment...";
    const inv = await invite();
    const r = await call("/admin/apply/read", { t: inv.token, url: "spa.example.com" });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("bot_protection");
    expect(reads(inv.id)).toBe(0);
  });

  it("the server read turned away by bot protection: 422 bot_protection, read given back, no render", async () => {
    const inv = await invite();
    const r = await call("/admin/apply/read", { t: inv.token, url: "guarded.example.com" });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("bot_protection");
    expect(reads(inv.id)).toBe(0);
    expect(browserLog.launched).toBe(0);
  });

  it("a redirect to a private address inside the render: 400, as the server read", async () => {
    // The same site (www and the apex are one), resolving private.
    site.hops = ["https://spa.example.com/", "https://www.spa.example.com/latest/meta-data/"];
    const inv = await invite();
    const r = await call("/admin/apply/read", { t: inv.token, url: "spa.example.com" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("Enter your site's public address");
    expect(browserLog.decisions.find((d) => d.url.includes("meta-data"))?.outcome).toBe("abort");
    expect(browserLog.closed).toBe(1);
  });

  it("a move to another host inside the render: off_host, never loaded, the read given back", async () => {
    site.hops = ["https://spa.example.com/", "https://metadata.example.com/latest/meta-data/"];
    const inv = await invite();
    const r = await call("/admin/apply/read", { t: inv.token, url: "spa.example.com" });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("off_host");
    expect(reads(inv.id)).toBe(0);
    expect(browserLog.decisions.find((d) => d.url.includes("metadata"))?.outcome).toBe("abort");
    expect(browserLog.closed).toBe(1);
  });

  it("a rendered page that carries our tag never reaches the edge", async () => {
    site.subresources = [
      { url: "https://edge.example.com/s/mybetasoft.js", type: "script" },
      { url: "https://edge.example.com/select?cid=mybetasoft", type: "fetch" },
      { url: "https://edge.example.com/event", type: "fetch" },
    ];
    const inv = await invite();
    const r = await call("/admin/apply/read", { t: inv.token, url: "spa.example.com" });
    expect(r.status).toBe(200);
    const toEdge = browserLog.decisions.filter((d) => d.url.includes("edge.example.com"));
    expect(toEdge).toHaveLength(3);
    expect(toEdge.every((d) => d.outcome === "abort")).toBe(true);
  });

  it("with BROWSER_RUN=off the old answer stands: 422 client_rendered", async () => {
    env.BROWSER_RUN = "off";
    const inv = await invite();
    const r = await call("/admin/apply/read", { t: inv.token, url: "spa.example.com" });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("client_rendered");
    expect(browserLog.launched).toBe(0);
  });
});

describe("apply submit on a page built in the browser", () => {
  it("renders the shell for the brief when the read cache is cold, and returns the install facts", async () => {
    const inv = await invite();
    const r = await call("/admin/apply/submit", {
      t: inv.token,
      url: "https://spa.example.com/",
      product: "Biznes idarəetmə",
      icp: "Kiçik komandalar",
      differentiator: "",
      numbers: "",
      sources: [],
      name: "Ada",
      email: "ada@spa.example.com",
    });
    expect(r.status).toBe(200);
    expect(browserLog.launched).toBe(1);
    expect(suggestMock).toHaveBeenCalledOnce();
    expect(r.json.tag).toBe(
      '<script data-cfasync="false" src="https://edge.example.com/s/spa-example.js"></script>',
    );
    expect(r.json.install).toMatchObject({ platform: "other", tag_position: "not_found" });
  });
});
