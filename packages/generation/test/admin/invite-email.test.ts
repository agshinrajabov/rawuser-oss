/**
 * The pilot invite email (docs/specs/invite-email.md): the optional `email`
 * on POST /admin/applications/invite, the superadmin test send, the 20 a day
 * limit, the message itself, and the proof that the address is stored
 * nowhere (D1, KV, logs, alerts, the answer).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSTALL_ENV } from "../install-env.ts";
import { makeKv, makeSqliteD1 } from "./sqlite-d1.ts";

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

const { default: worker } = await import("../../src/index.ts");
const {
  EMAIL_DAILY_LIMIT,
  emailErrorFor,
  formatExpiry,
  inviteEmail,
  normalizeEmail,
  sendInviteEmail,
} = await import("../../src/lib/invite-email.ts");
type InviteMailMessage = import("../../src/lib/invite-email.ts").InviteMailMessage;

const ADDRESS = "ada.lovelace+pilot@northwind-app.test";

let env: Record<string, unknown>;
let sql: ReturnType<typeof makeSqliteD1>["db"];
let kv: ReturnType<typeof makeKv>;
let sent: InviteMailMessage[];
let sendImpl: (m: InviteMailMessage) => Promise<{ messageId: string }>;
let logged: string[];
let fetched: string[];

beforeEach(() => {
  const made = makeSqliteD1();
  sql = made.db;
  kv = makeKv();
  sent = [];
  sendImpl = async () => ({ messageId: "m1" });
  env = {
    DB: made.d1,
    VARIANTS: kv,
    ENVIRONMENT: "test",
    DASHBOARD_ORIGIN: "https://app.example.com",
    ALERT_WEBHOOK_URL: "https://api.telegram.org/botTEST/sendMessage?chat_id=1",
    ...INSTALL_ENV,
    EMAIL: {
      send: async (m: InviteMailMessage) => {
        sent.push(m);
        return sendImpl(m);
      },
    },
  };
  sessionUser = SUPERADMIN;
  logged = [];
  fetched = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(`${String(input)} ${String(init?.body ?? "")}`);
      return Response.json({ ok: true });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function call(
  path: string,
  body: unknown,
): Promise<{ status: number; raw: string; json: Record<string, unknown> }> {
  const pending: Promise<unknown>[] = [];
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
  const raw = await res.text();
  return { status: res.status, raw, json: JSON.parse(raw) as Record<string, unknown> };
}

/** Every value in every table of the database, as text. */
function everyDbValue(): string[] {
  const tables = sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  const out: string[] = [];
  for (const { name } of tables) {
    for (const row of sql.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]) {
      for (const v of Object.values(row)) out.push(String(v));
    }
  }
  return out;
}

function addressAnywhereStored(address: string): string[] {
  const needle = address.toLowerCase();
  const hits: string[] = [];
  for (const v of everyDbValue()) if (v.toLowerCase().includes(needle)) hits.push(`d1: ${v}`);
  for (const [k, v] of kv.store) {
    if (k.toLowerCase().includes(needle) || v.toLowerCase().includes(needle)) hits.push(`kv: ${k}`);
  }
  for (const line of logged) if (line.toLowerCase().includes(needle)) hits.push(`log: ${line}`);
  for (const f of fetched) if (f.toLowerCase().includes(needle)) hits.push(`fetch: ${f}`);
  return hits;
}

describe("POST /admin/applications/invite with email", () => {
  it("sends one plain message to the address and returns the link and emailed: true", async () => {
    const r = await call("/admin/applications/invite", {
      name: "Northwind",
      site: "northwind-app.test",
      email: `  ${ADDRESS} `,
    });
    expect(r.status).toBe(200);
    expect(r.json.emailed).toBe(true);
    expect(r.json.email_error).toBeUndefined();
    const link = r.json.link as string;
    expect(link).toMatch(/^https:\/\/app\.example\.com\/apply\/#t=/);

    expect(sent).toHaveLength(1);
    const m = sent[0] as InviteMailMessage;
    expect(m.to).toBe(ADDRESS);
    expect(m.from).toEqual({ email: "pilots@example.com", name: "Rawuser" });
    expect(m.replyTo).toBe("hello@example.com");
    expect(m.subject).toBe("Your Rawuser pilot");
    expect(m.text.split(link)).toHaveLength(2);
    expect(m.html.match(/<a href=/g)).toHaveLength(2); // the link, and mailto: privacy
    expect(m.html).toContain(`<a href="${link}">`);
    expect(m.text).toContain(`works until ${formatExpiry(r.json.expires_at as number)}`);
    expect(m.text).toContain("for northwind-app.test");
  });

  it("stores the address nowhere: no D1 value, no KV key or value, no log, no alert, not in the answer", async () => {
    const r = await call("/admin/applications/invite", { name: "Northwind", email: ADDRESS });
    expect(r.json.emailed).toBe(true);
    expect(r.raw.toLowerCase()).not.toContain(ADDRESS.toLowerCase());
    expect(addressAnywhereStored(ADDRESS)).toEqual([]);
    // The invite row exists, without the address.
    const row = sql.prepare("SELECT * FROM pilot_applications").get() as Record<string, unknown>;
    expect(row.invited_name).toBe("Northwind");
    expect(row.email ?? null).toBeNull();
    // The only email key in KV is the day's count for the account.
    const emailKeys = [...kv.store.keys()].filter((k) => k.startsWith("email-sends:"));
    expect(emailKeys).toEqual([`email-sends:u1:${new Date().toISOString().slice(0, 10)}`]);
    expect(kv.store.get(emailKeys[0] as string)).toBe("1");
  });

  it("stores the address nowhere when the provider fails and quotes it in its message", async () => {
    sendImpl = async () => {
      throw Object.assign(new Error(`recipient ${ADDRESS} is suppressed`), {
        code: "E_RECIPIENT_SUPPRESSED",
      });
    };
    const r = await call("/admin/applications/invite", { email: ADDRESS });
    expect(r.status).toBe(200);
    expect(r.json.emailed).toBe(false);
    expect(r.json.email_error).toBe("recipient");
    expect(typeof r.json.link).toBe("string");
    expect(r.raw.toLowerCase()).not.toContain(ADDRESS.toLowerCase());
    expect(addressAnywhereStored(ADDRESS)).toEqual([]);
    expect(logged.some((l) => l.includes("E_RECIPIENT_SUPPRESSED"))).toBe(true);
  });

  it("without email: no send, emailed false, no email_error", async () => {
    for (const body of [{}, { email: "" }, { email: null }]) {
      const r = await call("/admin/applications/invite", body);
      expect(r.status).toBe(200);
      expect(r.json.emailed).toBe(false);
      expect(r.json.email_error).toBeUndefined();
    }
    expect(sent).toHaveLength(0);
  });

  it("an invalid address is a 400 and makes no invite", async () => {
    for (const email of [
      "not-an-address",
      "a@b.example, c@d.example",
      "Ada <ada@b.example>",
      "ada@b.example\r\nBcc: x@y.example",
      42,
      `${"a".repeat(250)}@b.co`,
    ]) {
      const r = await call("/admin/applications/invite", { email });
      expect(r.status).toBe(400);
    }
    expect(sent).toHaveLength(0);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM pilot_applications").get()).toEqual({ n: 0 });
  });

  it("email on an audit invite is refused", async () => {
    env.AUDIT_INVITES = "on";
    const r = await call("/admin/applications/invite", { kind: "audit", email: ADDRESS });
    expect(r.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("no binding (outside production): emailed false, unavailable, the link still returned", async () => {
    env.EMAIL = undefined;
    const r = await call("/admin/applications/invite", { email: ADDRESS });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ emailed: false, email_error: "unavailable" });
    expect(typeof r.json.link).toBe("string");
  });

  it("20 sends a day per account, the test send included; another account has its own 20", async () => {
    for (let i = 0; i < EMAIL_DAILY_LIMIT - 1; i++) {
      expect((await call("/admin/applications/invite", { email: ADDRESS })).json.emailed).toBe(
        true,
      );
    }
    expect((await call("/admin/email/test", { email: ADDRESS })).json.emailed).toBe(true);
    const over = await call("/admin/applications/invite", { email: ADDRESS });
    expect(over.status).toBe(200);
    expect(over.json).toMatchObject({ emailed: false, email_error: "limit" });
    expect(typeof over.json.link).toBe("string");
    expect((await call("/admin/email/test", { email: ADDRESS })).json.email_error).toBe("limit");
    expect(sent).toHaveLength(EMAIL_DAILY_LIMIT);

    sessionUser = { ...SUPERADMIN, id: "u9" };
    expect((await call("/admin/applications/invite", { email: ADDRESS })).json.emailed).toBe(true);
  });

  it("customer roles cannot send; no session is 401", async () => {
    sessionUser = { id: "u2", email: "c@x.example", role: "customer", customer_id: "acme" };
    expect((await call("/admin/applications/invite", { email: ADDRESS })).status).toBe(403);
    expect((await call("/admin/email/test", { email: ADDRESS })).status).toBe(403);
    sessionUser = null;
    expect((await call("/admin/applications/invite", { email: ADDRESS })).status).toBe(401);
    expect((await call("/admin/email/test", { email: ADDRESS })).status).toBe(401);
    expect(sent).toHaveLength(0);
  });
});

describe("POST /admin/email/test", () => {
  it("sends the same message with a dummy link, stores nothing but the count", async () => {
    const r = await call("/admin/email/test", { email: ADDRESS });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ emailed: true });
    expect(sent).toHaveLength(1);
    const m = sent[0] as InviteMailMessage;
    expect(m.to).toBe(ADDRESS);
    expect(m.subject).toBe("Your Rawuser pilot");
    expect(m.text).toContain("https://app.example.com/apply/#t=test-link-not-valid");
    expect(sql.prepare("SELECT COUNT(*) AS n FROM pilot_applications").get()).toEqual({ n: 0 });
    expect(addressAnywhereStored(ADDRESS)).toEqual([]);
  });

  it("refuses a missing or invalid address", async () => {
    expect((await call("/admin/email/test", {})).status).toBe(400);
    expect((await call("/admin/email/test", { email: "x" })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe("the message", () => {
  const msg = inviteEmail({
    link: "https://app.example.com/apply/#t=abc",
    expiresAt: Date.UTC(2026, 10, 9, 12),
    site: 'evil.com"><script>',
    privacyAddress: "privacy@example.com",
  });

  it("is plain: no image, no pixel, no script, no tracked link, no dashes", () => {
    for (const body of [msg.text, msg.html, msg.subject]) {
      expect(body).not.toMatch(/[–—]/);
    }
    expect(msg.html).not.toMatch(/<img|<script|<iframe|url\(|background-image/i);
    const hrefs = [...msg.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["https://app.example.com/apply/#t=abc", "mailto:privacy@example.com"]);
  });

  it("says the expiry date, and the footer names Rawuser and privacy@", () => {
    expect(msg.text).toContain("9 November 2026");
    expect(msg.html).toContain("9 November 2026");
    expect(msg.text).toContain("Sent by Rawuser. Privacy: privacy@example.com");
  });

  it("never prints a site that does not read as a host", () => {
    expect(msg.text).not.toContain("evil.com");
    expect(msg.html).not.toContain("<script>");
  });
});

describe("pieces", () => {
  it("normalizeEmail keeps one plain address", () => {
    expect(normalizeEmail(" a@b.example ")).toBe("a@b.example");
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail("a@b.example;c@d.example")).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });

  it("emailErrorFor maps Cloudflare's codes to the closed words", () => {
    expect(emailErrorFor("E_SENDER_NOT_VERIFIED")).toBe("sender");
    expect(emailErrorFor("E_DAILY_LIMIT_EXCEEDED")).toBe("quota");
    expect(emailErrorFor("E_DELIVERY_FAILED")).toBe("recipient");
    expect(emailErrorFor("E_INTERNAL_SERVER_ERROR")).toBe("failed");
    expect(emailErrorFor(undefined)).toBe("failed");
  });

  it("the count is per UTC day", async () => {
    const day1 = Date.UTC(2026, 9, 26, 23, 59);
    const day2 = Date.UTC(2026, 9, 27, 0, 1);
    const e = env as never;
    for (let i = 0; i < EMAIL_DAILY_LIMIT; i++) {
      await sendInviteEmail(e, "u1", ADDRESS, { link: "https://x.y/", expiresAt: day1 }, day1);
    }
    expect(
      await sendInviteEmail(e, "u1", ADDRESS, { link: "https://x.y/", expiresAt: day1 }, day1),
    ).toEqual({
      emailed: false,
      email_error: "limit",
    });
    expect(
      await sendInviteEmail(e, "u1", ADDRESS, { link: "https://x.y/", expiresAt: day2 }, day2),
    ).toEqual({
      emailed: true,
    });
  });
});
