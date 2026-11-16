/**
 * The two-part tag's pasted style (docs/specs/faster-tag.md step 6) against
 * the real SQL: node:sqlite with every migration applied.
 *
 *   - the probe finds `<style data-rawuser-pre>` and stores one state word
 *     (`none`, `current`, `stale`), the found paste's hash and a policy word;
 *   - privacy review condition 2: no HTML and no pasted text is stored,
 *     in snippet_status or any other table;
 *   - the policy word and the exact lines (rebuilt, never stored);
 *   - GET /admin/install/pre and POST /admin/install/pre/check: the paste
 *     from the confirmed manifests, its hash, stale against the current
 *     paste, the customer scope, the cases it is not offered.
 */

import { preHideHash, preHideStyle } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/admin/auth.ts";
import type { AdminEnv } from "../../src/admin/handlers.ts";
import {
  type PreAnswer,
  buildPreAnswer,
  handleInstallPreCheck,
  handleInstallPreGet,
} from "../../src/admin/install-pre.ts";
import { handleSnippetStatusProbe } from "../../src/admin/snippet-status.ts";
import { probeSingleCustomer } from "../../src/cron/snippet-probe.ts";
import { prePolicy } from "../../src/lib/csp.ts";
import { currentPaste, findPrePaste, preStateOf, storedPreFacts } from "../../src/lib/pre-paste.ts";
import { makeSqliteD1 } from "../admin/sqlite-d1.ts";
import { EDGE, INSTALL_ENV } from "../install-env.ts";

const MANIFEST = {
  "hero.headline": { css: ["section.hero h1", "h1.title"], text: ["Ship faster"], structural: [] },
  "hero.body": { css: ["section.hero p"], text: ["We help"], structural: [] },
};
const PRICING = {
  "hero.headline": { css: ["main h1.price-title"], text: ["Plans"], structural: [] },
};

const SYNC_TAG = `<script data-cfasync="false" src="https://edge.example.com/s/acme.js"></script>`;
const ASYNC_TAG = `<script async data-cfasync="false" src="https://edge.example.com/s/acme.js"></script>`;

let made: ReturnType<typeof makeSqliteD1>;
let site: { status: number; html: string; headers: Record<string, string> };

function page(head: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">${head}<title>Acme</title></head><body><section class="hero"><h1 class="title">Ship faster</h1><p>We help</p></section></body></html>`;
}

function insertManifest(path: string, manifest: object): void {
  made.db
    .prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('acme', ?, ?, 'https://acme.example.com/', 1, 1, 'en')",
    )
    .run(path, JSON.stringify(manifest));
}

async function pasteNow() {
  const p = await currentPaste(made.d1, "acme", EDGE);
  if (!p) throw new Error("no paste");
  return p;
}

beforeEach(() => {
  made = makeSqliteD1();
  made.db
    .prepare(
      `INSERT INTO customers (id, slug, domain, plan, status, created_at, live_at) VALUES ('acme', 'acme', 'acme.example.com', 'pilot', 'active', 1, 2)`,
    )
    .run();
  made.db
    .prepare(
      `INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES ('other', 'other', 'other.example.com', 'pilot', 'active', 1)`,
    )
    .run();
  insertManifest("/", MANIFEST);
  site = { status: 200, html: page(SYNC_TAG), headers: {} };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(site.html, { status: site.status, headers: site.headers })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const env = () => ({ DB: made.d1, ...INSTALL_ENV });
/** An answer with the paste offered (the tests read csp only where it is). */
type Body = PreAnswer & { csp: NonNullable<PreAnswer["csp"]> };
const adminEnv = () =>
  ({ DB: made.d1, ENVIRONMENT: "test", ...INSTALL_ENV }) as unknown as AdminEnv;
const customerUser: SessionUser = {
  id: "u1",
  email: "owner@acme.test",
  role: "customer",
  customer_id: "acme",
} as SessionUser;
const superadmin: SessionUser = {
  id: "u0",
  email: "founder@rawuser.test",
  role: "superadmin",
  customer_id: null,
} as SessionUser;

function statusRow(): Record<string, unknown> {
  return made.db.prepare("SELECT * FROM snippet_status WHERE customer_id = 'acme'").get() as Record<
    string,
    unknown
  >;
}

/** Every value of every table but one, as one string. */
function wholeDatabase(except: string): string {
  const tables = (
    made.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).filter((t) => t.name !== except);
  return tables
    .map((t) => JSON.stringify(made.db.prepare(`SELECT * FROM "${t.name}"`).all()))
    .join("\n");
}

async function get(user: SessionUser, customer = "acme") {
  const res = await handleInstallPreGet(
    new Request(`https://api.test/admin/install/pre?customer_id=${customer}`),
    adminEnv(),
    user,
  );
  return { status: res.status, body: (await res.json()) as Body };
}

async function check(user: SessionUser, customer = "acme") {
  const res = await handleInstallPreCheck(
    new Request("https://api.test/admin/install/pre/check", {
      method: "POST",
      body: JSON.stringify({ customer_id: customer }),
    }),
    adminEnv(),
    user,
  );
  return { status: res.status, body: (await res.json()) as Body };
}

describe("the paste", () => {
  it("is built from the confirmed manifests by the hide-rule rules, with its hash", async () => {
    insertManifest("/pricing", PRICING);
    const p = await pasteNow();
    expect(p.css).toBe(
      preHideStyle({
        "/": ["section.hero h1", "h1.title", "section.hero p"],
        "/pricing": ["main h1.price-title"],
      }),
    );
    expect(p.style).toBe(`<style data-rawuser-pre>${p.css}</style>`);
    expect(p.script).toBe(ASYNC_TAG);
    expect(p.html).toBe(`${p.style}\n${p.script}`);
    expect(p.hash).toBe(await preHideHash(p.css));
    expect(p.selectors).toBe(4);
  });

  it("an unconfirmed manifest and a button left as built are not in it", async () => {
    made.db
      .prepare(
        "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('acme', '/draft', ?, 'x', 1, NULL, 'en')",
      )
      .run(JSON.stringify(PRICING));
    const p = await pasteNow();
    expect(p.css).not.toContain("price-title");
  });

  it("no confirmed part: no paste", async () => {
    made.db.prepare("DELETE FROM element_manifests").run();
    expect(await currentPaste(made.d1, "acme", EDGE)).toBeNull();
  });
});

describe("finding the paste on a page", () => {
  it("hashes each pasted text exactly and keeps nothing else", async () => {
    const css = "@keyframes __rwp{from{visibility:hidden}to{visibility:visible}}x{y:z}";
    const found = await findPrePaste(
      `<style>body{}</style><style data-rawuser-pre="">${css}</style><style data-rawuser-pre nonce="abc">a</style>`,
    );
    expect(found.hashes).toEqual([await preHideHash(css), await preHideHash("a")]);
    expect(found.nonce).toBe(true);
    expect(JSON.stringify(found)).not.toContain("visibility");
    expect((await findPrePaste("<style data-rawuser>x</style>")).hashes).toEqual([]);
  });

  it("the state word: none, current, stale", () => {
    expect(preStateOf({ hashes: [], nonce: false }, "'h'")).toEqual({ state: "none", hash: null });
    expect(preStateOf({ hashes: ["'a'", "'h'"], nonce: false }, "'h'")).toEqual({
      state: "current",
      hash: "'h'",
    });
    expect(preStateOf({ hashes: ["'a'"], nonce: false }, "'h'")).toEqual({
      state: "stale",
      hash: "'a'",
    });
  });

  it("the stored form takes only a closed word and a hash of the exact shape", () => {
    const h = "'sha256-IOyuj+jb8S10OZYiHeLA7kLVjjEAds2/42n0U2jsUlY='";
    expect(storedPreFacts({ state: "current", hash: h, policy: "none" })).toEqual({
      pre_state: "current",
      pre_hash: h,
      pre_policy: "none",
    });
    expect(storedPreFacts({ state: "current", hash: "<style>x</style>", policy: "x" })).toEqual({
      pre_state: null,
      pre_hash: null,
      pre_policy: null,
    });
    expect(storedPreFacts({ state: "none", hash: h }).pre_hash).toBeNull();
  });
});

describe("the probe", () => {
  it("privacy review condition 2: no HTML and no pasted text is stored, anywhere", async () => {
    const p = await pasteNow();
    site.html = page(`${p.style}\n${ASYNC_TAG}`);
    const before = wholeDatabase("snippet_status");
    const r = await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(r.pre?.state).toBe("current");

    // Every other table is exactly as it was: the probe writes one row.
    expect(wholeDatabase("snippet_status")).toBe(before);

    const row = statusRow();
    expect(row.pre_state).toBe("current");
    expect(row.pre_hash).toBe(p.hash);
    expect(row.pre_policy).toBe("none");
    const rowText = JSON.stringify(row);
    for (const needle of [
      p.css,
      "data-rawuser-pre",
      "__rwp",
      "visibility",
      "section.hero",
      "h1.title",
      "Ship faster",
      "<",
    ]) {
      expect(rowText).not.toContain(needle);
    }
    // The stored columns are the closed words and one hash, nothing else.
    expect(Object.keys(row).filter((k) => k.startsWith("pre_"))).toEqual([
      "pre_state",
      "pre_hash",
      "pre_policy",
    ]);
  });

  it("no paste: none, no hash", async () => {
    await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(statusRow().pre_state).toBe("none");
    expect(statusRow().pre_hash).toBeNull();
  });

  it("an older paste: stale, with the hash of the text found", async () => {
    const old = preHideStyle({ "/": ["h1.title"] });
    site.html = page(`<style data-rawuser-pre>${old}</style>${ASYNC_TAG}`);
    const r = await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(r.pre?.state).toBe("stale");
    expect(statusRow().pre_hash).toBe(await preHideHash(old));
  });

  it("a failed read keeps the last known paste facts", async () => {
    const p = await pasteNow();
    site.html = page(`${p.style}${ASYNC_TAG}`);
    await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    site.status = 500;
    const r = await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(r.pre).toBeNull();
    expect(statusRow().pre_state).toBe("current");
    expect(statusRow().pre_hash).toBe(p.hash);
  });

  it("a strict style policy: needs_hash with the exact line, the line not stored", async () => {
    const p = await pasteNow();
    site.headers["content-security-policy"] =
      "default-src 'self'; style-src 'self' https://fonts.example";
    const r = await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(r.pre?.policy).toBe("needs_hash");
    expect(r.pre?.lines).toEqual([`style-src 'self' https://fonts.example ${p.hash}`]);
    const rowText = JSON.stringify(statusRow());
    expect(statusRow().pre_policy).toBe("needs_hash");
    expect(rowText).not.toContain("fonts.example");
    expect(rowText).not.toContain("style-src");
  });
});

describe("the policy word", () => {
  const h = "'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='";
  const cur = "'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='";
  const run = (csp: string | null, found: string | null, nonce = false) =>
    prePolicy({
      headers: new Headers(csp ? { "content-security-policy": csp } : {}),
      html: "",
      foundHash: found,
      foundNonce: nonce,
      currentHash: cur,
    });

  it("none, inline, nonce, listed, needs_hash", () => {
    expect(run(null, null)).toEqual({ policy: "none", lines: [] });
    expect(run("script-src 'self'", null).policy).toBe("none");
    expect(run("style-src 'self' 'unsafe-inline'", null)).toEqual({ policy: "inline", lines: [] });
    expect(run("style-src 'self' 'nonce-xyz'", h, true)).toEqual({ policy: "nonce", lines: [] });
    // Listed for the paste found; the current paste changed, so a line for the new hash.
    expect(run(`style-src 'self' ${h}`, h)).toEqual({
      policy: "listed",
      lines: [`style-src 'self' ${h} ${cur}`],
    });
    expect(run(`style-src 'self' ${cur}`, cur)).toEqual({ policy: "listed", lines: [] });
    // default-src becomes its own style-src line; the site's sources are kept.
    expect(run("default-src 'self'", null)).toEqual({
      policy: "needs_hash",
      lines: [`style-src 'self' ${cur}`],
    });
  });
});

describe("GET /admin/install/pre", () => {
  it("a live customer: the paste, the hash, the state and the platforms", async () => {
    const p = await pasteNow();
    const { status, body } = await get(customerUser);
    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.blocked).toBeNull();
    expect(body.paste).toEqual({ css: p.css, style: p.style, script: p.script, html: p.html });
    expect(body.csp).toEqual({
      hash: p.hash,
      needed: null,
      policy: null,
      refused: false,
      lines: [],
      lines_read: false,
    });
    expect(body.state).toBeNull();
    expect(body.stale).toBe(false);
    expect(
      body.platforms.map((x: { id: string; status: string }) => `${x.id}:${x.status}`),
    ).toEqual(["html:ready", "webflow:ready", "framer:ready", "lovable:not_yet", "nextjs:not_yet"]);
  });

  it("stale at once when the set of parts changes after the read", async () => {
    const p = await pasteNow();
    site.html = page(`${p.style}${ASYNC_TAG}`);
    await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect((await get(customerUser)).body.state).toBe("current");
    insertManifest("/pricing", PRICING);
    const { body } = await get(customerUser);
    expect(body.state).toBe("stale");
    expect(body.stale).toBe(true);
    expect(body.csp.hash).not.toBe(p.hash);
  });

  it("a strict policy refusing the paste on the page: needed and refused", async () => {
    const old = preHideStyle({ "/": ["h1.title"] });
    site.html = page(`<style data-rawuser-pre>${old}</style>${ASYNC_TAG}`);
    site.headers["content-security-policy"] = "style-src 'self'";
    await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    const { body } = await get(customerUser);
    expect(body.csp.needed).toBe(true);
    expect(body.csp.refused).toBe(true);
    expect(body.csp.lines).toEqual([]);
  });

  it("customer-scoped; a superadmin may view any customer", async () => {
    expect((await get(customerUser, "other")).status).toBe(403);
    const sa = await get(superadmin, "other");
    expect(sa.status).toBe(200);
    expect(sa.body.available).toBe(false);
    expect(sa.body.blocked).toBe("not_live");
    expect(sa.body.paste).toBeNull();
    expect((await get(superadmin, "nobody")).status).toBe(404);
  });

  it("never for an audit, an inactive customer or a site without parts", () => {
    const row = null;
    const c = { id: "acme", domain: "d", plan: "pilot", status: "active", live_at: 1 };
    expect(buildPreAnswer({ ...c, plan: "audit" }, null, row, null).blocked).toBe("audit");
    expect(buildPreAnswer({ ...c, status: "ended" }, null, row, null).blocked).toBe("inactive");
    expect(buildPreAnswer(c, null, row, null).blocked).toBe("no_parts");
  });

  it("the detected platform's form", async () => {
    made.db
      .prepare(
        "INSERT INTO snippet_status (customer_id, last_probed_at, snippet_in_html, status, platform) VALUES ('acme', 1, 1, 'active', 'webflow')",
      )
      .run();
    expect((await get(customerUser)).body.platform).toEqual({
      detected: "webflow",
      form: "webflow",
      ready: true,
    });
    made.db.prepare("UPDATE snippet_status SET platform = 'lovable'").run();
    expect((await get(customerUser)).body.platform).toEqual({
      detected: "lovable",
      form: null,
      ready: false,
    });
  });
});

describe("POST /admin/install/pre/check", () => {
  it("reads the page now and gives the exact lines", async () => {
    const p = await pasteNow();
    site.html = page(`${p.style}${ASYNC_TAG}`);
    site.headers["content-security-policy"] = "style-src 'self' 'nonce-r4nd0m'";
    const { status, body } = await check(customerUser);
    expect(status).toBe(200);
    expect(body.state).toBe("current");
    expect(body.csp.policy).toBe("needs_hash");
    expect(body.csp.needed).toBe(true);
    expect(body.csp.refused).toBe(true);
    expect(body.csp.lines_read).toBe(true);
    expect(body.csp.lines).toEqual([`style-src 'self' 'nonce-r4nd0m' ${p.hash}`]);
    expect(JSON.stringify(statusRow())).not.toContain("nonce-r4nd0m");
  });

  it("customer-scoped", async () => {
    expect((await check(customerUser, "other")).status).toBe(403);
  });

  it("never reads the page of an inactive customer, a customer before go live or an audit", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    made.db.prepare("UPDATE customers SET status = 'ended' WHERE id = 'acme'").run();
    const ended = await check(customerUser);
    expect(ended.status).toBe(200);
    expect(ended.body.blocked).toBe("inactive");
    made.db
      .prepare("UPDATE customers SET status = 'active', plan = 'audit' WHERE id = 'acme'")
      .run();
    expect((await check(customerUser)).body.blocked).toBe("audit");
    expect((await check(superadmin, "other")).body.blocked).toBe("not_live");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusRow()).toBeUndefined();
  });
});

describe("POST /admin/snippet-status/probe", () => {
  it("returns the paste's state, policy and lines beside install", async () => {
    const p = await pasteNow();
    site.html = page(`${p.style}${ASYNC_TAG}`);
    const res = await handleSnippetStatusProbe(
      new Request("https://api.test/admin/snippet-status/probe", {
        method: "POST",
        body: JSON.stringify({ customer_id: "acme" }),
      }),
      adminEnv(),
      customerUser,
    );
    const body = (await res.json()) as { pre: unknown };
    expect(body.pre).toEqual({ state: "current", policy: "none", lines: [] });
  });
});
