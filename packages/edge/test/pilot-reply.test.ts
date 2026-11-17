/**
 * The pilot form's confirmation (docs/specs/pilot-auto-reply.md; privacy
 * review 2026-11-17, CONDITIONAL PASS, conditions 1 to 4):
 * - sent only after a request is stored, never for a honeypot, a 400 or a 429;
 * - once per address in 30 days (its own row does not count), 20 a UTC day;
 * - fixed text: no link, nothing typed but the address it goes to;
 * - a strict single address only;
 * - the address is in no log, no KV key or value, no outgoing fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAILY_LIMIT,
  ONCE_IN_MS,
  type ReplyMessage,
  counterKey,
  replyMessage,
  sendPilotReply,
} from "../src/pilot-reply.ts";
import { handlePilotRequest, resetRateKeyCache } from "../src/pilot.ts";

const NOW = new Date(Date.UTC(2026, 10, 17, 12));
const ADDRESS = "Founder@Example.com";
const ON = {
  PILOT_AUTO_REPLY: "on",
  PILOT_REPLY_FROM: "pilots@example.org",
  PILOT_REPLY_NAME: "Acme",
  PILOT_REPLY_TO: "hello@example.org",
  PILOT_REPLY_SIGNATURE: "Sam|Acme",
};

interface Row {
  id: string;
  email: string;
  site_url: string | null;
  note: string | null;
  created_at: number;
}

/** A pilot_requests table that understands the three statements the edge runs. */
function memDb(rows: Row[] = []) {
  const db = {
    prepare: (sql: string) => {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => {
          args = a;
          return stmt;
        },
        run: async () => {
          if (/^\s*INSERT INTO pilot_requests/i.test(sql)) {
            const [id, email, site_url, note, created_at] = args as [
              string,
              string,
              string | null,
              string | null,
              number,
            ];
            rows.push({ id, email, site_url, note, created_at });
          }
          return { meta: { changes: 1 } };
        },
        first: async () => {
          if (/lower\(trim\(email\)\) = lower\(\?\)/.test(sql)) {
            const [to, id, since] = args as [string, string, number];
            const hit = rows.find(
              (r) =>
                r.email.trim().toLowerCase() === to.toLowerCase() &&
                r.id !== id &&
                r.created_at >= since,
            );
            return hit ? { hit: 1 } : null;
          }
          if (/COUNT\(\*\)/i.test(sql)) return { n: rows.length };
          return null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, rows };
}

function memKv() {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

function mailer(fail = false) {
  const sent: ReplyMessage[] = [];
  return {
    sent,
    EMAIL: {
      send: async (m: ReplyMessage) => {
        if (fail) throw new Error(`refused ${m.to}: mailbox full`);
        sent.push(m);
        return { messageId: "m1" };
      },
    },
  };
}

describe("the message", () => {
  it("is fixed text with no link, signed as the install says", () => {
    const m = replyMessage(ON);
    expect(m.subject).toBe("Your Acme pilot request");
    expect(m.text).toContain("write back within a day");
    expect(m.text).toContain('reply "not me" and we will delete the request');
    expect(m.text).toContain("Sam\nAcme");
    expect(m.text + m.html).not.toMatch(/https?:\/\//);
    expect(m.text).not.toMatch(/Nothing more will come/);
  });

  it("names no one when the install names no one", () => {
    const m = replyMessage({});
    expect(m.subject).toBe("Your Rawuser pilot request");
    expect(m.text.trim().endsWith("Rawuser")).toBe(true);
  });
});

describe("sendPilotReply", () => {
  it("is off unless switched on with a binding and a sender", async () => {
    const { db } = memDb();
    const { kv } = memKv();
    const { EMAIL, sent } = mailer();
    for (const env of [
      { DB: db, VARIANTS: kv, EMAIL },
      { DB: db, VARIANTS: kv, ...ON },
      { DB: db, VARIANTS: kv, EMAIL, ...ON, PILOT_REPLY_FROM: "" },
      { DB: db, VARIANTS: kv, EMAIL, ...ON, PILOT_AUTO_REPLY: "yes" },
    ])
      expect(await sendPilotReply(env, ADDRESS, "plt_1", NOW)).toBe("off");
    expect(sent).toEqual([]);
  });

  it("sends one plain message to the address, from the one sender", async () => {
    const { db } = memDb([
      { id: "plt_1", email: ADDRESS, site_url: null, note: null, created_at: NOW.getTime() },
    ]);
    const { kv, store } = memKv();
    const { EMAIL, sent } = mailer();
    expect(
      await sendPilotReply({ DB: db, VARIANTS: kv, EMAIL, ...ON }, ADDRESS, "plt_1", NOW),
    ).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(ADDRESS);
    expect(sent[0]?.from).toEqual({ email: "pilots@example.org", name: "Acme" });
    expect(sent[0]?.replyTo).toBe("hello@example.org");
    expect(store.get(counterKey(NOW))).toBe("1");
  });

  it("refuses anything but one plain address", async () => {
    const { db } = memDb();
    const { kv } = memKv();
    const { EMAIL, sent } = mailer();
    for (const bad of [
      '"x"<a@b.example>',
      "a@b.example, c@d.example",
      "a@b.example\nBcc: c@d.example",
      "a@b",
      "a b@c.example",
    ])
      expect(await sendPilotReply({ DB: db, VARIANTS: kv, EMAIL, ...ON }, bad, "plt_1", NOW)).toBe(
        "address",
      );
    expect(sent).toEqual([]);
  });

  it("sends once per address in 30 days, whatever the case or spaces", async () => {
    const earlier = NOW.getTime() - ONCE_IN_MS + 60_000;
    const { db } = memDb([
      {
        id: "plt_0",
        email: " founder@example.com ",
        site_url: null,
        note: null,
        created_at: earlier,
      },
    ]);
    const { kv } = memKv();
    const { EMAIL, sent } = mailer();
    const env = { DB: db, VARIANTS: kv, EMAIL, ...ON };
    expect(await sendPilotReply(env, ADDRESS, "plt_1", NOW)).toBe("recent");
    const later = new Date(earlier + ONCE_IN_MS + 1);
    expect(await sendPilotReply(env, ADDRESS, "plt_2", later)).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("stops at the day's limit, counted without the address", async () => {
    const { db } = memDb();
    const { kv, store } = memKv();
    store.set(counterKey(NOW), String(DAILY_LIMIT));
    const { EMAIL, sent } = mailer();
    expect(
      await sendPilotReply({ DB: db, VARIANTS: kv, EMAIL, ...ON }, ADDRESS, "plt_1", NOW),
    ).toBe("limit");
    expect(sent).toEqual([]);
    expect(counterKey(NOW)).toBe("pilot:reply:count:2026-11-17");
  });

  it("a failed send says one word and nothing of the provider's", async () => {
    const { db } = memDb();
    const { kv } = memKv();
    const { EMAIL } = mailer(true);
    expect(
      await sendPilotReply({ DB: db, VARIANTS: kv, EMAIL, ...ON }, ADDRESS, "plt_1", NOW),
    ).toBe("failed");
  });
});

describe("through the form", () => {
  const ORIGIN = "https://example.com";
  const post = (body: unknown, ip = "203.0.113.9") =>
    new Request("https://edge.example.com/pilot-request", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    });
  const logs: string[] = [];
  const fetches: string[] = [];

  beforeEach(() => {
    resetRateKeyCache();
    logs.length = 0;
    fetches.length = 0;
    for (const level of ["log", "error", "warn", "info"] as const)
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
      });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      fetches.push(`${String(input)} ${String(init?.body ?? "")}`);
      return new Response("{}");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function run(body: unknown, fail = false) {
    const { db, rows } = memDb();
    const { kv, store } = memKv();
    const { EMAIL, sent } = mailer(fail);
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    } as unknown as ExecutionContext;
    const env = {
      DB: db,
      VARIANTS: kv,
      EMAIL,
      PILOT_FORM_ORIGINS: ORIGIN,
      ALERT_WEBHOOK_URL: "https://hooks.example.com/x",
      ...ON,
    };
    const res = await handlePilotRequest(post(body), env, ctx);
    await Promise.all(waits);
    return { res, rows, store, sent };
  }

  it("a stored request gets one confirmation with nothing else it typed", async () => {
    const { res, sent, rows } = await run({
      email: ADDRESS,
      site_url: "https://victim-chosen.example/buy-now",
      note: "click http://spam.example now",
    });
    expect(res.status).toBe(201);
    expect(rows).toHaveLength(1);
    expect(sent).toHaveLength(1);
    const all = `${sent[0]?.subject}${sent[0]?.text}${sent[0]?.html}`;
    expect(all).not.toContain("victim-chosen");
    expect(all).not.toContain("spam.example");
  });

  it("a honeypot, a bad field and a rate limit send nothing", async () => {
    expect((await run({ email: ADDRESS, website: "bot" })).sent).toEqual([]);
    expect((await run({ email: "not-an-address" })).sent).toEqual([]);
    const { db } = memDb();
    const { kv, store } = memKv();
    store.set(`ratelimit:pilot:global:${new Date().toISOString().slice(0, 13)}`, "999");
    const { EMAIL, sent } = mailer();
    const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
    const res = await handlePilotRequest(
      post({ email: ADDRESS }),
      { DB: db, VARIANTS: kv, EMAIL, PILOT_FORM_ORIGINS: ORIGIN, ...ON },
      ctx,
    );
    expect(res.status).toBe(429);
    expect(sent).toEqual([]);
  });

  it("the address is in no log, KV entry or outgoing request, sent or failed", async () => {
    for (const fail of [false, true]) {
      const { store } = await run({ email: ADDRESS }, fail);
      const kvText = [...store.entries()].flat().join("\n").toLowerCase();
      expect(kvText).not.toContain("founder@example.com");
      expect(logs.join("\n").toLowerCase()).not.toContain("founder@example.com");
      expect(fetches.join("\n").toLowerCase()).not.toContain("founder@example.com");
    }
    expect(logs.join("\n")).toContain("[rawuser/edge] pilot reply: failed");
  });
});
