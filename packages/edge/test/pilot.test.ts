/**
 * /pilot-request (privacy review, 2026-10-25, ruling 3 on
 * docs/sales/site-privacy.md):
 * - the ops line carries no form data: no email, site, domain or note;
 * - the per-client rate-limit counter is named by an HMAC of the IP under a
 *   random key drawn per UTC day, so neither the IP nor its plain hash is
 *   ever stored;
 * - the insert stamps status_at for the 12-month retention.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RATE_KEY_TTL_S,
  handlePilotRequest,
  leadAlertText,
  pilotOrigins,
  pilotPreflight,
  rateKeyName,
  rateLimited,
  resetRateKeyCache,
} from "../src/pilot.ts";

const IP = "203.0.113.42";
/** The install's dashboard and the origins its form posts from. */
const APP = "https://app.example.com";
const FORM_ORIGINS = "https://example.com,https://www.example.com";

function memKv() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, o?: { expirationTtl?: number }) => {
      store.set(k, v);
      ttls.set(k, o?.expirationTtl);
    },
  } as unknown as KVNamespace;
  return { kv, store, ttls };
}

function clientCounters(store: Map<string, string>): string[] {
  return [...store.keys()].filter(
    (k) => k.startsWith("ratelimit:pilot:") && !k.startsWith("ratelimit:pilot:global:"),
  );
}

beforeEach(() => resetRateKeyCache());

describe("leadAlertText", () => {
  it("says a request arrived and how many are open, nothing from the form", () => {
    expect(leadAlertText(3, APP)).toBe(
      "[rawuser] New pilot request (3 open) · app.example.com/pilots",
    );
  });

  it("drops the count when it could not be read", () => {
    for (const open of [null, 0, Number.NaN, 1.5]) {
      expect(leadAlertText(open, APP)).toBe("[rawuser] New pilot request · app.example.com/pilots");
    }
  });

  it("names the dashboard without its scheme, whatever the scheme or a trailing slash", () => {
    expect(leadAlertText(1, "http://localhost:3000/")).toBe(
      "[rawuser] New pilot request (1 open) · localhost:3000/pilots",
    );
  });

  it("with no dashboard configured the line ends at its own words", () => {
    for (const app of [undefined, null, "", "  "]) {
      expect(leadAlertText(3, app)).toBe("[rawuser] New pilot request (3 open)");
      expect(leadAlertText(null, app)).toBe("[rawuser] New pilot request");
    }
  });
});

describe("rateLimited", () => {
  it("draws a random 32-byte key per UTC day, stored for 48 hours", async () => {
    const { kv, store, ttls } = memKv();
    await rateLimited(kv, IP, new Date("2026-10-25T10:15:00Z"));
    const key = store.get(rateKeyName("2026-10-25"));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(ttls.get(rateKeyName("2026-10-25"))).toBe(RATE_KEY_TTL_S);
    expect(RATE_KEY_TTL_S).toBe(172_800);
  });

  it("maps the same IP to the same counter within a day, across isolates", async () => {
    const { kv, store } = memKv();
    await rateLimited(kv, IP, new Date("2026-10-25T10:00:00Z"));
    resetRateKeyCache(); // another isolate: reads the stored key
    await rateLimited(kv, IP, new Date("2026-10-25T10:40:00Z"));
    const counters = clientCounters(store);
    expect(counters).toHaveLength(1);
    expect(store.get(counters[0] as string)).toBe("2");
  });

  it("names the counter differently on another day", async () => {
    const { kv, store } = memKv();
    await rateLimited(kv, IP, new Date("2026-10-25T23:30:00Z"));
    await rateLimited(kv, IP, new Date("2026-10-26T00:30:00Z"));
    expect(store.get(rateKeyName("2026-10-25"))).not.toBe(store.get(rateKeyName("2026-10-26")));
    const tags = clientCounters(store).map((k) => k.split(":")[2]);
    expect(tags).toHaveLength(2);
    expect(tags[0]).not.toBe(tags[1]);
  });

  it("gives two IPs two counters", async () => {
    const { kv, store } = memKv();
    const now = new Date("2026-10-25T10:00:00Z");
    await rateLimited(kv, IP, now);
    await rateLimited(kv, "198.51.100.7", now);
    expect(clientCounters(store)).toHaveLength(2);
  });

  it("keeps the hourly limit: five per client, the sixth refused", async () => {
    const { kv } = memKv();
    const now = new Date("2026-10-25T10:00:00Z");
    const out: boolean[] = [];
    for (let i = 0; i < 6; i++) out.push(await rateLimited(kv, IP, now));
    expect(out).toEqual([false, false, false, false, false, true]);
    // A new hour, a new window.
    expect(await rateLimited(kv, IP, new Date("2026-10-25T11:00:00Z"))).toBe(false);
  });

  it("keeps the global limit at 60 an hour", async () => {
    const { kv } = memKv();
    const now = new Date("2026-10-25T10:00:00Z");
    let refused = 0;
    for (let i = 0; i < 61; i++) {
      if (await rateLimited(kv, `10.0.${Math.floor(i / 250)}.${i % 250}`, now)) refused++;
    }
    expect(refused).toBe(1);
  });

  it("never stores the IP or its plain SHA-256, in a key or a value", async () => {
    const { kv, store } = memKv();
    await rateLimited(kv, IP, new Date("2026-10-25T10:00:00Z"));
    const sha = createHash("sha256").update(IP).digest("hex");
    const all = [...store.entries()].flat().join("\n");
    expect(all).not.toContain(IP);
    expect(all).not.toContain(sha.slice(0, 16)); // the old 64-bit key
    expect(all).not.toContain(sha);
  });

  it("fails open when KV throws", async () => {
    const kv = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    } as unknown as KVNamespace;
    expect(await rateLimited(kv, IP, new Date())).toBe(false);
  });
});

describe("handlePilotRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends a line with no form data, logs nothing from the form, stamps status_at", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        sent.push(new URL(String(input)).searchParams.get("text") ?? "");
        return Response.json({ ok: true });
      }),
    );
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => logs.push(a.join(" ")));

    const inserts: { sql: string; args: unknown[] }[] = [];
    const { kv } = memKv();
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            run: async () => {
              inserts.push({ sql, args });
              return { success: true };
            },
          }),
          first: async () => ({ n: 2 }),
        }),
      } as unknown as D1Database,
      VARIANTS: kv,
      ALERT_WEBHOOK_URL: "https://api.telegram.org/botX/sendMessage?chat_id=1",
      PILOT_FORM_ORIGINS: FORM_ORIGINS,
      APP_ORIGIN: APP,
    };
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    } as unknown as ExecutionContext;

    const res = await handlePilotRequest(
      new Request("https://edge.example.com/pilot-request", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://example.com",
          "cf-connecting-ip": IP,
        },
        body: JSON.stringify({
          email: "ada@northwind-app.test",
          site_url: "https://www.northwind-app.test/pricing",
          note: "secret plan",
        }),
      }),
      env,
      ctx,
    );
    await Promise.all(pending);

    expect(res.status).toBe(201);
    expect(sent).toEqual(["[rawuser] New pilot request (2 open) · app.example.com/pilots"]);
    for (const line of [...sent, ...logs]) {
      expect(line).not.toContain("ada");
      expect(line).not.toContain("northwind");
      expect(line).not.toContain("secret");
    }
    expect(inserts).toHaveLength(1);
    const insert = inserts[0] as { sql: string; args: unknown[] };
    expect(insert.sql).toContain("status_at");
    // created_at and status_at are the same moment.
    expect(insert.args[4]).toBe(insert.args[5]);
  });
});

describe("the form's origins (PILOT_FORM_ORIGINS)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** An env whose database and KV fail the test when touched. */
  function untouched(vars: { PILOT_FORM_ORIGINS?: string; ALERT_WEBHOOK_URL?: string }) {
    const never = () => {
      throw new Error("the route must not reach storage");
    };
    return {
      DB: { prepare: never } as unknown as D1Database,
      VARIANTS: { get: never, put: never } as unknown as KVNamespace,
      ...vars,
    };
  }
  const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext;
  const post = (origin: string) =>
    new Request("https://edge.example.com/pilot-request", {
      method: "POST",
      headers: { "content-type": "application/json", origin, "cf-connecting-ip": IP },
      // The honeypot: a fake 201 before any storage.
      body: JSON.stringify({ email: "a@example.com", website: "x" }),
    });
  const preflight = (origin: string) =>
    new Request("https://edge.example.com/pilot-request", {
      method: "OPTIONS",
      headers: { origin },
    });

  it.each([{}, { PILOT_FORM_ORIGINS: "" }, { PILOT_FORM_ORIGINS: " , " }])(
    "unset (%j): 404 like any unknown path, no CORS header for anyone, nothing stored or sent",
    async (vars) => {
      const fetched = vi.fn();
      vi.stubGlobal("fetch", fetched);
      const env = untouched({ ...vars, ALERT_WEBHOOK_URL: "https://hooks.example.com/x" });
      for (const origin of ["https://example.com", "https://elsewhere.example.org", ""]) {
        for (const res of [
          await handlePilotRequest(post(origin), env, ctx),
          pilotPreflight(preflight(origin), env),
        ]) {
          expect(res.status).toBe(404);
          expect(await res.text()).toBe("not found");
          expect(res.headers.get("access-control-allow-origin")).toBeNull();
          expect(res.headers.get("access-control-allow-methods")).toBeNull();
        }
      }
      expect(fetched).not.toHaveBeenCalled();
    },
  );

  it("a listed origin is named back; any other caller is told the first one", async () => {
    const env = untouched({ PILOT_FORM_ORIGINS: FORM_ORIGINS });
    expect(pilotOrigins(env)).toEqual(["https://example.com", "https://www.example.com"]);
    for (const [origin, allowed] of [
      ["https://example.com", "https://example.com"],
      ["https://www.example.com", "https://www.example.com"],
      ["https://elsewhere.example.org", "https://example.com"],
      ["", "https://example.com"],
    ] as const) {
      const res = await handlePilotRequest(post(origin), env, ctx);
      expect(res.status).toBe(201);
      expect(res.headers.get("access-control-allow-origin")).toBe(allowed);
      const pre = pilotPreflight(preflight(origin), env);
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe(allowed);
      expect(pre.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    }
  });

  it("reads the list with spaces and trailing slashes", () => {
    expect(
      pilotOrigins({ PILOT_FORM_ORIGINS: " https://example.com/ ,http://localhost:4001 " }),
    ).toEqual(["https://example.com", "http://localhost:4001"]);
    expect(pilotOrigins({})).toEqual([]);
  });
});
