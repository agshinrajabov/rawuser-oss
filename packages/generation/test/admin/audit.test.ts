/**
 * The free AI-traffic audit end to end through the worker on real SQL
 * (docs/specs/ai-traffic-audit.md §14; privacy review conditions 3, 4, 5, 8):
 * the invite behind its switch, the sign-up, the window, the extension, the
 * cap, the build, release and the share link, revoke, the end, Make this a
 * pilot, the 60-day delete, the caps, the crons that skip an ended audit,
 * and the marker purge of found_by.
 */

import { visitorBundleKey } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_LINES } from "../../src/audit/constants.ts";
import { runAuditCheck, sweepAuditDeletes } from "../../src/audit/lifecycle.ts";
import { hashPassword, hashSessionToken } from "../../src/auth/password.ts";
import { aggregateWindowAt } from "../../src/cron/analytics-aggregator.ts";
import { queueCustomers } from "../../src/cron/regen-queue.ts";
import { orchestrate } from "../../src/orchestrator.ts";
import { INSTALL_ENV } from "../install-env.ts";
import { MODEL_ENV } from "../model-env.ts";
import { makeKv, makeSqliteD1 } from "./sqlite-d1.ts";

const { default: worker } = await import("../../src/index.ts");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 6, 9, 30);
const PASSWORD = "correct horse battery";
const PROFILE = "vec_03bad3a7eb2e08ec39ec";
const INTENTS = ["problem", "evaluation", "competitor", "pricing", "feature", "brand"];
const SOURCES = ["default", "ai", "social", "community", "organic", "paid"];

let sqlite: ReturnType<typeof makeSqliteD1>;
let kv: ReturnType<typeof makeKv>;
let env: Record<string, unknown>;
let waits: Promise<unknown>[];
let alerts: string[];
let admin: string;
let n = 0;

function ctx(): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
  const res = await worker.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { "X-Rawuser-Admin": token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env as never,
    ctx(),
  );
  await Promise.all(waits.splice(0));
  const text = await res.clone().text();
  return { status: res.status, json: text ? JSON.parse(text) : {}, res };
}

const one = <T>(sql: string, ...p: Array<string | number>) => sqlite.db.prepare(sql).get(...p) as T;
const count = (sql: string, ...p: Array<string | number>) =>
  Number(one<{ n: number }>(sql, ...p).n);
const env2 = () =>
  env as unknown as { DB: D1Database; VARIANTS: KVNamespace; ALERT_WEBHOOK_URL: string };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  sqlite = makeSqliteD1();
  kv = makeKv();
  waits = [];
  alerts = [];
  n = 0;
  env = {
    DB: sqlite.d1,
    VARIANTS: kv,
    ENVIRONMENT: "test",
    DASHBOARD_ORIGIN: "https://app.test",
    ...MODEL_ENV,
    ...INSTALL_ENV,
    ALERT_WEBHOOK_URL: "https://alerts.test/hook",
    MFA_REQUIRED_ROLES: "",
    AUDIT_INVITES: "on",
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.startsWith("https://alerts.test/")) {
      alerts.push(String(JSON.parse(String(init?.body)).text));
      return new Response("ok");
    }
    if (url.startsWith("https://quoteloom.example")) {
      return new Response("<html><body><h1>Quotes</h1></body></html>", {
        headers: { "content-type": "text/html" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  sqlite.db
    .prepare(
      "INSERT INTO superadmin_users (id, email, password_hash, role, customer_id, created_at) VALUES ('u-admin', 'founder@example.com', ?, 'superadmin', NULL, 0)",
    )
    .run(await hashPassword(PASSWORD));
  admin = String(
    (await call("POST", "/admin/login", { email: "founder@example.com", password: PASSWORD })).json
      .token,
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function invite(): Promise<string> {
  const r = await call(
    "POST",
    "/admin/applications/invite",
    { kind: "audit", name: "Rina", site: "quoteloom.example" },
    admin,
  );
  expect(r.status).toBe(200);
  return String(r.json.link).split("#t=")[1] as string;
}

async function signUp(site = "https://www.quoteloom.example/", email = "rina@quoteloom.example") {
  const t = await invite();
  return call("POST", "/admin/audit/submit", {
    t,
    url: site,
    name: "Rina Holt",
    email,
    banner: true,
    terms: true,
  });
}

function goLive(id: string, liveAt: number, written = 36): void {
  sqlite.db.prepare("UPDATE customers SET live_at = ? WHERE id = ?").run(liveAt, id);
  sqlite.db
    .prepare(
      `INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at)
       VALUES (?, '/', ?, 'https://quoteloom.example/', ?, ?)`,
    )
    .run(
      id,
      JSON.stringify({ "hero.headline": { css: ["h1"], text: ["Quotes"], structural: "h1" } }),
      liveAt,
      liveAt,
    );
  let k = 0;
  for (const i of INTENTS) {
    for (const s of SOURCES) {
      if (k++ >= written) return;
      sqlite.db
        .prepare(
          `INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status)
           VALUES (?, ?, ?, ?, 'model-a', 'h', ?, 0.001, 'ready')`,
        )
        .run(`var-${id}-${i}-${s}`, id, PROFILE, `v1:variant:${id}:${i}:${s}`, liveAt);
    }
  }
}

function visitRows(
  id: string,
  k: number,
  at: number,
  extra: Record<string, string | number | null> = {},
): void {
  for (let i = 0; i < k; i++) {
    sqlite.db
      .prepare(
        `INSERT INTO events (id, customer_id, ts, event_type, cohort, visit, source_dim, source_name, found_by, page_path)
         VALUES (?, ?, ?, 'variant_shown', 'personalized', ?, ?, ?, ?, '/')`,
      )
      .run(
        `ev${++n}`,
        id,
        at + i,
        `m${n}`,
        extra.source_dim ?? "ai",
        extra.source_name ?? "chatgpt",
        extra.found_by ?? "auto_tag",
      );
  }
}

/** Move the clock and sign in again (sessions end after 12 idle hours, 7 days of age). */
async function at(t: number): Promise<void> {
  vi.setSystemTime(t);
  admin = String(
    (await call("POST", "/admin/login", { email: "founder@example.com", password: PASSWORD })).json
      .token,
  );
}

const bundle = async (id: string) => JSON.parse(String(await kv.get(visitorBundleKey(id))));

// ---------------------------------------------------------------------------

describe("the invite (§3.1, privacy review condition 8)", () => {
  it("is refused while AUDIT_INVITES is not on, whatever else", async () => {
    env.AUDIT_INVITES = "off";
    const r = await call("POST", "/admin/applications/invite", { kind: "audit" }, admin);
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: "audit_invites_off", message: AUDIT_LINES.invites_off });
    env.AUDIT_INVITES = undefined;
    expect(
      (await call("POST", "/admin/applications/invite", { kind: "audit" }, admin)).status,
    ).toBe(403);
    // A pilot invite is untouched by the switch.
    const pilot = await call("POST", "/admin/applications/invite", {}, admin);
    expect(pilot.status).toBe(200);
    expect(String(pilot.json.link)).toMatch(/\/apply\/#t=/);
    expect((await call("GET", "/admin/audit/summary", undefined, admin)).json).toEqual({
      open: 0,
      max: 10,
      invites_on: false,
    });
  });

  it("mints an /audit/ link, stores only the hash, and refuses the eleventh open audit", async () => {
    const r = await call("POST", "/admin/applications/invite", { kind: "audit" }, admin);
    expect(r.json).toMatchObject({ kind: "audit" });
    const token = String(r.json.link).split("/audit/#t=")[1] as string;
    const row = one<{ token_hash: string; kind: string }>(
      "SELECT token_hash, kind FROM pilot_applications",
    );
    expect(row).toEqual({ token_hash: await hashSessionToken(token), kind: "audit" });
    expect(
      JSON.stringify(sqlite.db.prepare("SELECT * FROM pilot_applications").all()),
    ).not.toContain(token);
    for (let i = 0; i < 10; i++) {
      sqlite.db
        .prepare(
          "INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES (?, ?, ?, 'audit', 'active', 0)",
        )
        .run(`a${i}`, `a${i}`, `a${i}.example`);
    }
    const full = await call("POST", "/admin/applications/invite", { kind: "audit" }, admin);
    expect(full.status).toBe(409);
    expect(full.json.message).toBe("Ten audits are open. One must end first.");
  });

  it("a pilot token never opens the audit page, nor an audit token the apply page", async () => {
    const t = await invite();
    const pilot = String(
      (await call("POST", "/admin/applications/invite", {}, admin)).json.link,
    ).split("#t=")[1];
    expect((await call("POST", "/admin/audit/open", { t: pilot })).status).toBe(404);
    expect((await call("POST", "/admin/apply/invite", { t })).status).toBe(404);
    const open = await call("POST", "/admin/audit/open", { t });
    expect(open.json).toMatchObject({ ok: true, status: "invited", invited_name: "Rina" });
    expect(open.res.headers.get("cache-control")).toBe("no-store");
    expect(open.json.privacy_line).toMatch(/^We use your name and email to run your audit/);
  });
});

describe("the sign-up (§3.2)", () => {
  it("creates the audit customer, its user and its bundle; the setup token only in the answer", async () => {
    const r = await signUp();
    expect(r.status).toBe(201);
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.json).toMatchObject({
      ok: true,
      customer_id: "quoteloom",
      domain: "www.quoteloom.example",
    });
    const c = one<Record<string, unknown>>(
      "SELECT plan, status, audit_terms_at, audit_consent_banner FROM customers WHERE id = 'quoteloom'",
    );
    expect(c).toEqual({
      plan: "audit",
      status: "active",
      audit_terms_at: T0,
      audit_consent_banner: 1,
    });
    // The setup token: only its hash stored; it sets the password once.
    const setup = String(r.json.setup_token);
    expect(
      one<{ token_hash: string }>("SELECT token_hash FROM customer_setup_tokens").token_hash,
    ).toBe(await hashSessionToken(setup));
    const s = await call("POST", "/admin/customer-users/setup", {
      token: setup,
      password: "a long password",
    });
    expect(s.json.token).toEqual(expect.any(String));
    // The bundle is in KV before the tag goes on (a, ad; no ae yet).
    expect(await bundle("quoteloom")).toMatchObject({ a: 1, ad: "quoteloom.example" });
    expect((await bundle("quoteloom")).ae).toBeUndefined();
    // The founder gets the domain, never the name or the email.
    expect(alerts.some((a) => a.includes("quoteloom.example"))).toBe(true);
    expect(alerts.join(" ")).not.toMatch(/Rina|rina@/);
    // The invite opens nothing after Send (condition 3).
    expect((await call("POST", "/admin/audit/open", { t: "x".repeat(43) })).status).toBe(404);
  });

  it("refuses: a used link, a taken domain (www and the apex as one), no terms, ten open", async () => {
    const t = await invite();
    const body = {
      t,
      url: "quoteloom.example",
      name: "R",
      email: "r@quoteloom.example",
      terms: true,
    };
    expect(
      (await call("POST", "/admin/audit/submit", { ...body, terms: false })).json,
    ).toMatchObject({
      field: "terms",
      error: AUDIT_LINES.terms,
    });
    expect((await call("POST", "/admin/audit/submit", body)).status).toBe(201);
    expect((await call("POST", "/admin/audit/submit", body)).json).toMatchObject({ error: "used" });
    expect((await call("POST", "/admin/audit/open", { t })).json).toEqual({
      ok: true,
      status: "used",
    });
    const again = await signUp("https://www.quoteloom.example", "other@x.example");
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("domain_taken");
    const open = (i: number) =>
      sqlite.db
        .prepare(
          "INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES (?, ?, ?, 'audit', 'active', 0)",
        )
        .run(`a${i}`, `a${i}`, `a${i}.example`);
    for (let i = 0; i < 8; i++) open(i);
    // The invite is minted at nine open; the submit meets ten.
    const t2 = await invite();
    open(8);
    expect(
      (
        await call("POST", "/admin/audit/submit", {
          ...body,
          t: t2,
          url: "fresh.example",
          email: "f@fresh.example",
        })
      ).json,
    ).toMatchObject({ error: "audits_full", message: AUDIT_LINES.audits_full_signup("Sam") });
  });
});

describe("the window, the report and the end (§3.5, §3.8, §6)", () => {
  it("runs the whole audit: start after the versions, extend once, build, release, share, end", async () => {
    const id = String((await signUp()).json.customer_id);
    // Before go live: the Audit page says so, with the lapse date; no number by source.
    const before = await call("GET", `/admin/audit?customer_id=${id}`, undefined, admin);
    expect(before.json).toMatchObject({ stage: "before_go_live", lapse_at: T0 + 14 * DAY });

    // Live, versions still writing: the window waits.
    goLive(id, T0 + HOUR, 12);
    let r = await runAuditCheck(env2(), T0 + 2 * HOUR);
    expect(r.started).toEqual([]);
    expect(
      (await call("GET", `/admin/audit?customer_id=${id}`, undefined, admin)).json,
    ).toMatchObject({
      stage: "writing",
      written: 12,
      total: 36,
    });
    // All 36 written: the window starts at the next full hour; ae is the 28-day ceiling.
    sqlite.db.exec("DELETE FROM variants");
    goLiveVariantsOnly(id);
    const t1 = T0 + 3 * HOUR + 1;
    r = await runAuditCheck(env2(), t1);
    expect(r.started).toEqual([id]);
    const from = Math.ceil(t1 / HOUR) * HOUR;
    expect(
      one("SELECT audit_from, audit_to, audit_ends_at FROM customers WHERE id = ?", id),
    ).toEqual({
      audit_from: from,
      audit_to: from + 7 * DAY,
      audit_ends_at: from + 28 * DAY,
    });
    expect((await bundle(id)).ae).toBe(from + 28 * DAY);

    // Counting: the day and the visits, nothing by source.
    visitRows(id, 40, from + HOUR);
    const counting = await call("GET", `/admin/audit?customer_id=${id}`, undefined, admin);
    await at(from + 2 * DAY + HOUR);
    const day3 = (await call("GET", `/admin/audit?customer_id=${id}`, undefined, admin)).json;
    expect(day3).toMatchObject({ stage: "counting", day: 3, of_days: 7, visits_counted: 40 });
    expect(JSON.stringify(counting.json)).not.toMatch(/chatgpt|ai_|"groups"|"names"/i);

    // Day 7 with 40 visits: one week more, once.
    r = await runAuditCheck(env2(), from + 7 * DAY + 1);
    expect(r.extended).toEqual([id]);
    expect(
      Number(one<{ audit_to: number }>("SELECT audit_to FROM customers WHERE id = ?", id).audit_to),
    ).toBe(from + 14 * DAY);
    // Day 14: built with what there is, counts only; one ops line without numbers.
    r = await runAuditCheck(env2(), from + 14 * DAY + 1);
    expect(r.built).toEqual([id]);
    expect(count("SELECT COUNT(*) AS n FROM audit_reports WHERE customer_id = ?", id)).toBe(1);
    expect(alerts.find((a) => a.includes("audit-report"))).toBe(
      `[rawuser ops] audit-report: ${id} is ready to review · app.test/applications`,
    );
    await at(from + 14 * DAY + HOUR);
    expect((await call("GET", `/admin/audit?customer_id=${id}`, undefined, admin)).json.stage).toBe(
      "checking",
    );

    // Not released: no public read, no share link.
    expect((await call("POST", "/admin/audit/share-link", { customer_id: id }, admin)).status).toBe(
      409,
    );

    // Release: the link once, the end date at release plus 7.
    const relAt = from + 14 * DAY + 2 * HOUR;
    await at(relAt);
    const rel = await call("POST", "/admin/audit/release", { customer_id: id }, admin);
    expect(rel.res.headers.get("cache-control")).toBe("no-store");
    expect(rel.json).toMatchObject({ expires_at: relAt + 90 * DAY, ends_at: relAt + 7 * DAY });
    const token = String(rel.json.link).split("/audit/report/#t=")[1] as string;
    expect((await bundle(id)).ae).toBe(relAt + 7 * DAY);
    const pub = await call("POST", "/admin/audit/report/public", { t: token });
    expect(pub.status).toBe(200);
    expect(pub.res.headers.get("cache-control")).toBe("no-store");
    expect(pub.json.report).toMatchObject({
      state: "counts",
      visits: 40,
      domain: "www.quoteloom.example",
    });
    expect(pub.json.review).toBeUndefined();
    // The token's hash only.
    expect(one<{ token_hash: string }>("SELECT token_hash FROM audit_reports").token_hash).toBe(
      await hashSessionToken(token),
    );

    // The prospect's "Copy a share link": a new link, the old one dead.
    sqlite.db
      .prepare("UPDATE superadmin_users SET password_hash = ? WHERE customer_id = ?")
      .run(await hashPassword(PASSWORD), id);
    const cust = String(
      (await call("POST", "/admin/login", { email: "rina@quoteloom.example", password: PASSWORD }))
        .json.token,
    );
    const own = await call("GET", `/admin/audit/report?customer_id=${id}`, undefined, cust);
    expect(own.json.report).toMatchObject({ visits: 40 });
    const share = await call("POST", "/admin/audit/share-link", { customer_id: id }, cust);
    const token2 = String(share.json.link).split("#t=")[1] as string;
    expect((await call("POST", "/admin/audit/report/public", { t: token })).status).toBe(404);
    expect((await call("POST", "/admin/audit/report/public", { t: token2 })).status).toBe(200);
    // A customer never reaches the superadmin actions.
    expect((await call("POST", "/admin/audit/end", { customer_id: id }, cust)).status).toBe(403);

    // Revoke: 404 for the link and for the customer; expiry likewise.
    expect((await call("POST", "/admin/audit/revoke", { customer_id: id }, admin)).json).toEqual({
      ok: true,
    });
    expect((await call("POST", "/admin/audit/report/public", { t: token2 })).status).toBe(404);
    expect(
      (await call("GET", `/admin/audit/report?customer_id=${id}`, undefined, cust)).status,
    ).toBe(404);

    // A running test ends with the audit.
    sqlite.db
      .prepare(
        "INSERT INTO holdout_tests (id, customer_id, percent, started_at, created_at, started_by) VALUES ('ht1', ?, 20, ?, ?, 'go_live')",
      )
      .run(id, from, from);
    sqlite.db.prepare("UPDATE customers SET holdout_percent = 20 WHERE id = ?").run(id);
    await kv.put(`v1:hide:${id}`, JSON.stringify({ "/": ["h1"] }));

    // The end date: status ended, the test ended audit_end, no hide rules, ae in the bundle.
    r = await runAuditCheck(env2(), relAt + 7 * DAY);
    await at(relAt + 7 * DAY + HOUR);
    expect(r.ended).toEqual([id]);
    const ended = one<Record<string, number | string>>(
      "SELECT status, audit_ended_at, audit_delete_at FROM customers WHERE id = ?",
      id,
    );
    expect(ended).toEqual({
      status: "ended",
      audit_ended_at: relAt + 7 * DAY,
      audit_delete_at: relAt + 60 * DAY,
    });
    expect(one("SELECT end_reason, ended_actor FROM holdout_tests WHERE id = 'ht1'")).toEqual({
      end_reason: "audit_end",
      ended_actor: "system",
    });
    expect(JSON.parse(String(await kv.get(`v1:hide:${id}`)))).toEqual({});
    expect((await bundle(id)).ae).toBe(relAt + 7 * DAY);
    expect(
      (await call("GET", `/admin/audit?customer_id=${id}`, undefined, admin)).json,
    ).toMatchObject({
      stage: "ended",
      delete_at: relAt + 60 * DAY,
    });

    // Ended: nothing is written again, by any road.
    expect((await orchestrate(id, env as never)).abort_reason).toBe("audit_ended");
    sqlite.db.exec(`UPDATE variants SET status = 'stale' WHERE customer_id = '${id}'`);
    expect(await queueCustomers(sqlite.d1)).not.toContain(id);
    expect(
      (await call("POST", "/admin/variants/stale-all", { customer_id: id }, admin)).json.error,
    ).toBe("audit_ended");

    // Make this a pilot: refused until the pilot terms; then plan pilot, active, a gone.
    const refused = await call("POST", "/admin/audit/make-pilot", { customer_id: id }, admin);
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({
      error: "pilot_terms_missing",
      message: "Needs signed pilot terms.",
    });
    expect(
      (await call("POST", "/admin/audit/pilot-terms", { customer_id: id }, admin)).json,
    ).toMatchObject({ ok: true });
    const up = await call("POST", "/admin/audit/make-pilot", { customer_id: id }, admin);
    expect(up.json).toMatchObject({ ok: true, plan: "pilot", status: "active", was_ended: true });
    const b = await bundle(id);
    expect(b.a).toBeUndefined();
    expect(b.ae).toBeUndefined();
    expect(
      one("SELECT plan, status, audit_delete_at, audit_from FROM customers WHERE id = ?", id),
    ).toEqual({
      plan: "pilot",
      status: "active",
      audit_delete_at: null,
      audit_from: from,
    });
    expect((await call("GET", `/admin/audit?customer_id=${id}`, undefined, admin)).json.stage).toBe(
      "pilot",
    );
  });

  it("the end date never passes 28 days after the start, whenever the release", async () => {
    const id = String((await signUp()).json.customer_id);
    goLive(id, T0);
    await runAuditCheck(env2(), T0 + HOUR);
    const from = Number(
      one<{ audit_from: number }>("SELECT audit_from FROM customers WHERE id = ?", id).audit_from,
    );
    visitRows(id, 310, from + HOUR);
    expect((await runAuditCheck(env2(), from + 7 * DAY)).built).toEqual([id]);
    await at(from + 25 * DAY);
    const rel = await call("POST", "/admin/audit/release", { customer_id: id }, admin);
    expect(rel.json.ends_at).toBe(from + 28 * DAY);
  });

  it("100,000 rows close the window at this hour and build", async () => {
    const id = String((await signUp()).json.customer_id);
    goLive(id, T0);
    await runAuditCheck(env2(), T0 + HOUR);
    const from = Number(
      one<{ audit_from: number }>("SELECT audit_from FROM customers WHERE id = ?", id).audit_from,
    );
    sqlite.db.exec(`WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 100000)
      INSERT INTO events (id, customer_id, ts, event_type, cohort, visit, page_path)
      SELECT 'bulk' || i, '${id}', ${from + HOUR} + i, 'no_signal_passthrough', 'no_signal', 'v' || (i % 5000), '/' FROM s`);
    const at = from + 2 * DAY + 30 * 60_000;
    const r = await runAuditCheck(env2(), at);
    expect(r.built).toEqual([id]);
    expect(
      Number(one<{ audit_to: number }>("SELECT audit_to FROM customers WHERE id = ?", id).audit_to),
    ).toBe(Math.floor(at / HOUR) * HOUR);
  });

  it("no go live within 14 days: the audit lapses, deleted 60 days after sign-up", async () => {
    const id = String((await signUp()).json.customer_id);
    expect((await runAuditCheck(env2(), T0 + 13 * DAY)).lapsed).toEqual([]);
    expect((await runAuditCheck(env2(), T0 + 14 * DAY)).lapsed).toEqual([id]);
    await at(T0 + 14 * DAY + HOUR);
    expect(one("SELECT status, audit_delete_at FROM customers WHERE id = ?", id)).toEqual({
      status: "ended",
      audit_delete_at: T0 + 60 * DAY,
    });
    expect((await call("GET", `/admin/audit?customer_id=${id}`, undefined, admin)).json.stage).toBe(
      "lapsed",
    );
    expect((await bundle(id)).ae).toBe(T0 + 14 * DAY);
  });

  it("a delete cut off inside KV is found again by the next sweep and finished (pre-deploy fix 1)", async () => {
    const id = String((await signUp()).json.customer_id);
    await at(T0 + HOUR); // signed up an hour later, so due an hour later
    const other = String(
      (await signUp("https://other.example", "o@other.example")).json.customer_id,
    );
    visitRows(id, 3, T0);
    for (let i = 0; i < 120; i++) await kv.put(`v1:variant:${id}:problem:k${i}`, "{}");
    await runAuditCheck(env2(), T0 + 14 * DAY + HOUR);
    expect(count("SELECT COUNT(*) AS n FROM customers WHERE status = 'ended'")).toBe(2);
    // One due audit per run; the smallest budget stops this one in KV.
    let d = await sweepAuditDeletes(env2(), T0 + 61 * DAY, { budget: 1 });
    expect(d).toEqual({ deleted: [], pending: [id] });
    expect(count("SELECT COUNT(*) AS n FROM events WHERE customer_id = ?", id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM customers WHERE id = ?", id)).toBe(1);
    const left = [...kv.store.keys()].filter((k) => k.startsWith(`v1:variant:${id}:`)).length;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(120);
    expect(await kv.get(`v1:closed:${id}`)).toBe("1");
    expect(count("SELECT COUNT(*) AS n FROM customers WHERE id = ?", other)).toBe(1);
    // The next sweep finds it again and finishes; the one after takes the other.
    d = await sweepAuditDeletes(env2(), T0 + 61 * DAY);
    expect(d).toEqual({ deleted: [id], pending: [] });
    expect(
      [...kv.store.keys()].filter(
        (k) =>
          (k.includes(`:${id}:`) || k.endsWith(`:${id}`)) &&
          k !== `v1:closed:${id}` &&
          // The done line's own dedupe marker, written after the delete (30 days).
          k !== `ops:alert:audit-deleted:${id}`,
      ),
    ).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM customers WHERE id = ?", id)).toBe(0);
    expect(await kv.get(`v1:closed:${id}`)).toBe("1");
    expect((await sweepAuditDeletes(env2(), T0 + 61 * DAY)).deleted).toEqual([other]);
  });

  it("rows written after End now are deleted by the next hourly run (pre-deploy fix 2)", async () => {
    const id = String((await signUp()).json.customer_id);
    goLive(id, T0);
    await runAuditCheck(env2(), T0 + HOUR);
    const endAt = T0 + 2 * DAY;
    await at(endAt);
    expect((await call("POST", "/admin/audit/end", { customer_id: id }, admin)).json).toMatchObject(
      {
        ok: true,
        ended_at: endAt,
      },
    );
    // The edge's 300 s bundle cache and /event's memo let a late row in.
    visitRows(id, 1, endAt - 60_000);
    visitRows(id, 1, endAt + 3 * 60_000);
    const r = await runAuditCheck(env2(), endAt + HOUR);
    expect(r.cleaned).toEqual([id]);
    expect(
      (
        sqlite.db.prepare("SELECT ts FROM events WHERE customer_id = ?").all(id) as Array<{
          ts: number;
        }>
      ).map((x) => x.ts),
    ).toEqual([endAt - 60_000]);
    // A pilot's rows are never touched; nothing to clean the next hour.
    expect((await runAuditCheck(env2(), endAt + 2 * HOUR)).cleaned).toEqual([]);
  });

  it("a forced start after 48 hours records the versions written, and the report says so", async () => {
    const id = String((await signUp()).json.customer_id);
    goLive(id, T0, 12);
    expect((await runAuditCheck(env2(), T0 + 47 * HOUR)).started).toEqual([]);
    expect((await runAuditCheck(env2(), T0 + 48 * HOUR)).started).toEqual([id]);
    expect(
      one(
        "SELECT audit_start_written AS w, audit_start_total AS t FROM customers WHERE id = ?",
        id,
      ),
    ).toEqual({
      w: 12,
      t: 36,
    });
    const from = Number(
      one<{ audit_from: number }>("SELECT audit_from FROM customers WHERE id = ?", id).audit_from,
    );
    visitRows(id, 310, from + HOUR);
    await runAuditCheck(env2(), from + 7 * DAY);
    const snap = JSON.parse(
      String(one<{ report: string }>("SELECT report FROM audit_reports").report),
    );
    expect(snap.report.versions_at_start).toEqual({ written: 12, total: 36 });
  });

  it("the 60-day delete: everything of the customer, the tombstone, one ops line with counts", async () => {
    const id = String((await signUp()).json.customer_id);
    sqlite.db.exec(
      "INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES ('keep', 'keep', 'keep.example', 'pilot', 'active', 0)",
    );
    visitRows(id, 3, T0);
    visitRows("keep", 2, T0);
    await runAuditCheck(env2(), T0 + 14 * DAY);
    expect((await sweepAuditDeletes(env2(), T0 + 59 * DAY)).deleted).toEqual([]);
    const d = await sweepAuditDeletes(env2(), T0 + 60 * DAY);
    expect(d.deleted).toEqual([id]);
    for (const t of [
      "customers WHERE id",
      "events WHERE customer_id",
      "superadmin_users WHERE customer_id",
      "pilot_applications WHERE customer_id",
    ]) {
      expect(count(`SELECT COUNT(*) AS n FROM ${t} = ?`, id)).toBe(0);
    }
    expect(count("SELECT COUNT(*) AS n FROM events WHERE customer_id = 'keep'")).toBe(2);
    expect(await kv.get(`v1:closed:${id}`)).toBe("1");
    expect(await kv.get(visitorBundleKey(id))).toBeNull();
    const line = alerts.find((a) => a.includes("audit-deleted")) ?? "";
    expect(line).toMatch(
      new RegExp(`audit-deleted: ${id}, 60 days after the report; \\d+ rows and \\d+ keys`),
    );
    expect(line).not.toMatch(/rina|Rina/);
  });
});

/** The 36 ready rows of `/`, without touching the manifest. */
function goLiveVariantsOnly(id: string): void {
  for (const i of INTENTS) {
    for (const s of SOURCES) {
      sqlite.db
        .prepare(
          `INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status)
           VALUES (?, ?, ?, ?, 'model-a', 'h', 0, 0.001, 'ready')`,
        )
        .run(`var-${id}-${i}-${s}`, id, PROFILE, `v1:variant:${id}:${i}:${s}`);
    }
  }
}

describe("the caps (§9): an audit is refused, a pilot never", () => {
  async function customer(id: string, plan: string): Promise<string> {
    sqlite.db
      .prepare(
        "INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES (?, ?, ?, ?, 'active', 0)",
      )
      .run(id, id, `${id}.example`, plan);
    for (const p of ["/", "/pricing", "/vs"]) {
      sqlite.db
        .prepare(
          `INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at)
           VALUES (?, ?, '{}', 'x', 0, 1)`,
        )
        .run(id, p);
    }
    return id;
  }

  it("a fourth page: quickstart and go live refused for an audit only", async () => {
    await customer("aud", "audit");
    await customer("pil", "pilot");
    const q = await call(
      "POST",
      "/admin/onboard/quickstart",
      { customer_id: "aud", page_path: "/blog" },
      admin,
    );
    expect(q.status).toBe(409);
    expect(q.json).toEqual({ error: "audit_pages_full", message: AUDIT_LINES.pages_full });
    // A page already in the audit reads again.
    expect(
      (
        await call(
          "POST",
          "/admin/onboard/quickstart",
          { customer_id: "aud", page_path: "/pricing" },
          admin,
        )
      ).json.error,
    ).toBe("no_capture");
    expect(
      (
        await call(
          "POST",
          "/admin/onboard/quickstart",
          { customer_id: "pil", page_path: "/blog" },
          admin,
        )
      ).json.error,
    ).toBe("no_capture");
    const g = await call(
      "POST",
      "/admin/onboard/go-live",
      {
        customer_id: "aud",
        page_path: "/blog",
        dna: { product: "p", icp: "i", value_props: ["v"] },
      },
      admin,
    );
    expect(g.json.error).toBe("audit_pages_full");
  });

  it("Rewrite everything once per audit, as often as wanted for a pilot", async () => {
    await customer("aud", "audit");
    await customer("pil", "pilot");
    expect(
      (await call("POST", "/admin/variants/stale-all", { customer_id: "aud" }, admin)).json.ok,
    ).toBe(true);
    const second = await call("POST", "/admin/variants/stale-all", { customer_id: "aud" }, admin);
    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: "audit_rewrite_used", message: AUDIT_LINES.rewrite_used });
    for (let i = 0; i < 3; i++) {
      expect(
        (await call("POST", "/admin/variants/stale-all", { customer_id: "pil" }, admin)).json.ok,
      ).toBe(true);
    }
  });

  it("past $1.00 the audit writes nothing: regenerate, quickstart, the queue, the orchestrator", async () => {
    await customer("aud", "audit");
    await customer("pil", "pilot");
    sqlite.db.exec("UPDATE customers SET audit_spend_usd = 1.0 WHERE id IN ('aud', 'pil')");
    const r = await call(
      "POST",
      "/admin/variant/regenerate",
      { customer_id: "aud", intent_dim: "problem", source_dim: "ai" },
      admin,
    );
    expect(r.json).toEqual({ error: "audit_spend", message: AUDIT_LINES.spend });
    expect(
      (
        await call(
          "POST",
          "/admin/onboard/quickstart",
          { customer_id: "aud", page_path: "/" },
          admin,
        )
      ).json.error,
    ).toBe("audit_spend");
    expect((await orchestrate("aud", env as never)).abort_reason).toBe("audit_spend");
    for (const id of ["aud", "pil"]) {
      sqlite.db
        .prepare(
          `INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status)
           VALUES (?, ?, ?, ?, 'm', 'h', 0, 0, 'stale')`,
        )
        .run(`s-${id}`, id, PROFILE, `v1:variant:${id}:problem:ai`);
    }
    const queue = await queueCustomers(sqlite.d1);
    expect(queue).toContain("pil");
    expect(queue).not.toContain("aud");
  });

  it("spend adds up on an audit only and alerts once at the cap", async () => {
    const { addAuditSpend } = await import("../../src/audit/caps.ts");
    await customer("aud", "audit");
    await customer("pil", "pilot");
    await addAuditSpend(env2(), "aud", 0.6);
    await addAuditSpend(env2(), "pil", 0.6);
    expect(alerts.filter((a) => a.includes("audit-spend"))).toHaveLength(0);
    await addAuditSpend(env2(), "aud", 0.5);
    await addAuditSpend(env2(), "aud", 0.1);
    expect(
      Number(one<{ s: number }>("SELECT audit_spend_usd AS s FROM customers WHERE id = 'aud'").s),
    ).toBeCloseTo(1.2);
    expect(
      Number(one<{ s: number }>("SELECT audit_spend_usd AS s FROM customers WHERE id = 'pil'").s),
    ).toBe(0);
    expect(alerts.filter((a) => a.includes("audit-spend"))).toHaveLength(1);
    const st = (await call("GET", "/admin/audit?customer_id=aud", undefined, admin)).json;
    expect(st.caps).toMatchObject({
      spend_used_up: true,
      pages_full: true,
      pages_used: 3,
      spend_max: 1,
    });
  });
});

describe("Make this a pilot during the audit (§3.9)", () => {
  it("keeps a running test running and the versions served; go live refused once ended", async () => {
    const id = String((await signUp()).json.customer_id);
    goLive(id, T0);
    await runAuditCheck(env2(), T0 + HOUR);
    sqlite.db
      .prepare(
        "INSERT INTO holdout_tests (id, customer_id, percent, started_at, created_at, started_by) VALUES ('ht2', ?, 20, ?, ?, 'go_live')",
      )
      .run(id, T0, T0);
    await call("POST", "/admin/audit/pilot-terms", { customer_id: id, signed_at: T0 }, admin);
    expect(
      (await call("POST", "/admin/audit/make-pilot", { customer_id: id }, admin)).json,
    ).toMatchObject({
      ok: true,
      was_ended: false,
    });
    expect(one("SELECT ended_at, end_reason FROM holdout_tests WHERE id = 'ht2'")).toEqual({
      ended_at: null,
      end_reason: null,
    });
    // A pilot is never ended by the audit check.
    expect((await runAuditCheck(env2(), T0 + 40 * DAY)).ended).toEqual([]);
    // An ended audit cannot go live again.
    const other = String(
      (await signUp("https://other.example", "o@other.example")).json.customer_id,
    );
    await call("POST", "/admin/audit/end", { customer_id: other }, admin);
    const g = await call(
      "POST",
      "/admin/onboard/go-live",
      { customer_id: other, dna: { product: "p", icp: "i", value_props: ["v"] } },
      admin,
    );
    expect(g.json.error).toBe("audit_ended");
    expect((await call("POST", "/admin/audit/end", { customer_id: other }, admin)).status).toBe(
      409,
    );
  });
});

describe("found_by is kept with the row (ADR 0037), and the aggregator (§4.2, §14)", () => {
  it("an audit customer's rows aggregate exactly as a pilot's (no new visit type)", async () => {
    for (const [id, plan] of [
      ["aud", "audit"],
      ["pil", "pilot"],
    ]) {
      sqlite.db
        .prepare(
          "INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES (?, ?, ?, ?, 'active', 0)",
        )
        .run(id, id, `${id}.example`, plan);
      let k = 0;
      for (const [type, cohort, src] of [
        ["variant_shown", "personalized", "ai"],
        ["variant_shown", "holdout", "social"],
        ["personalization_skipped", "skipped", "organic"],
        ["no_signal_passthrough", "no_signal", null],
        ["conversion", "personalized", "ai"],
      ] as const) {
        sqlite.db
          .prepare(
            `INSERT INTO events (id, customer_id, ts, event_type, cohort, visit, source_dim, intent_dim, found_by, page_path)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '/')`,
          )
          .run(
            `${id}-${k}`,
            id,
            T0 - HOUR + k,
            type,
            cohort,
            `${id}-v${k % 4}`,
            src,
            src ? "problem" : null,
            id === "aud" && src ? "referrer" : null,
          );
        k++;
      }
    }
    const ws = Math.floor((T0 - DAY) / DAY) * DAY;
    await aggregateWindowAt("aud", "24h", DAY, ws, env2());
    await aggregateWindowAt("pil", "24h", DAY, ws, env2());
    const rows = sqlite.db
      .prepare("SELECT * FROM analytics_aggregates WHERE window = '24h' ORDER BY customer_id")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    const strip = (r: Record<string, unknown>) => {
      const { customer_id: _c, id: _i, computed_at: _t, ...rest } = r;
      return rest;
    };
    expect(strip(rows[0] as Record<string, unknown>)).toEqual(
      strip(rows[1] as Record<string, unknown>),
    );
  });
});

describe("the words (§14 Copy)", () => {
  it("no em or en dash, no 'proven' or 'significant', in any audit line", async () => {
    const { auditPrivacyLine } = await import("../../src/admin/audit.ts");
    const all = [
      auditPrivacyLine("privacy@example.com"),
      auditPrivacyLine(null),
      AUDIT_LINES.audits_full_signup(null),
      ...Object.values(AUDIT_LINES).map((v) => (typeof v === "function" ? v("x.example") : v)),
    ].join(" ");
    expect(all).not.toMatch(/[–—]|proven|significant/i);
  });

  it("the lines read whole with or without the install's address and name", async () => {
    const { auditPrivacyLine } = await import("../../src/admin/audit.ts");
    expect(auditPrivacyLine("privacy@example.com")).toMatch(
      /unless you start a pilot\. Questions: privacy@example\.com\.$/,
    );
    expect(auditPrivacyLine(null)).toMatch(/unless you start a pilot\.$/);
    expect(auditPrivacyLine(null)).not.toContain("Questions");
    expect(AUDIT_LINES.audits_full_signup("Sam")).toBe(
      "Audits are full this week. Reply to Sam and he will write when one opens.",
    );
    expect(AUDIT_LINES.audits_full_signup(null)).toBe(
      "Audits are full this week. We will write when one opens.",
    );
  });
});
