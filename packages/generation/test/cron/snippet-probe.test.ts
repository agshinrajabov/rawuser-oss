/**
 * Unit tests for packages/generation/src/cron/snippet-probe.ts
 *
 * Coverage:
 *   - Probe finds snippet tag → status = active (with recent event)
 *   - Probe finds snippet tag → status = never (no events ever)
 *   - Probe finds snippet tag → status = stale (event older than 24h)
 *   - Probe doesn't find snippet tag → status = removed
 *   - Probe fetch fails (timeout) → status = unknown, previous row preserved
 *   - Rhythm: 6 h while the tag was found in the last 7 days, weekly otherwise
 *     (runSnippetProbe, probeInterval), on the real schema
 *   - Host rule: a redirect to another host is never followed
 *   - Privacy assertion: console.log/error/warn never interpolates a URL or HTML body
 *
 * All external I/O is mocked (global fetch, D1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROBE_INTERVAL_MS,
  type ProbeEnv,
  WEEKLY_INTERVAL_MS,
  probeInterval,
  probeSingleCustomer,
  runSnippetProbe,
} from "../../src/cron/snippet-probe.ts";
import { OFF_HOST_LINE } from "../../src/lib/public-url.ts";
import { makeSqliteD1 } from "../admin/sqlite-d1.ts";
import { EDGE_ORIGINS, INSTALL_ENV } from "../install-env.ts";

// ---------------------------------------------------------------------------
// Spy on console to assert no URL/body leakage in logs
// ---------------------------------------------------------------------------

const consoleSpy = {
  log: vi.spyOn(console, "log").mockImplementation(() => {}),
  error: vi.spyOn(console, "error").mockImplementation(() => {}),
  warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
};

afterEach(() => {
  vi.restoreAllMocks();
  consoleSpy.log.mockClear();
  consoleSpy.error.mockClear();
  consoleSpy.warn.mockClear();
});

// ---------------------------------------------------------------------------
// The snippet marker we expect to be searched for
// ---------------------------------------------------------------------------

const SNIPPET_MARKER = "rawuser-edge-production.some-account.workers.dev/snippet.js";
const DOMAIN = "school.lumera.test";
const CUSTOMER_ID = "lumera-school";

// ---------------------------------------------------------------------------
// D1 mock factory
// ---------------------------------------------------------------------------

interface SnippetStatusRow {
  customer_id: string;
  last_probed_at: number | null;
  snippet_in_html: number;
  last_event_at: number | null;
  status: string;
  status_reason: string | null;
}

interface DbState {
  lastEventAt: number | null;
  snippetStatusRow: SnippetStatusRow | null;
  activeCustomers: Array<{
    id: string;
    domain: string;
    last_probed_at: number | null;
    tag_found_at?: number | null;
    created_at?: number | null;
  }>;
  upserted: SnippetStatusRow | null;
}

function makeDb(state: DbState): D1Database {
  const prepare = vi.fn((sql: string) => {
    const stmt = {
      _binds: [] as unknown[],
      bind(...args: unknown[]) {
        this._binds = args;
        return this;
      },
      async first<T = unknown>(): Promise<T | null> {
        if (sql.includes("MAX(ts)") && sql.includes("events")) {
          return { last_event_at: state.lastEventAt } as T;
        }
        if (sql.includes("FROM customers") && sql.includes("id = ?")) {
          // probeSingleCustomer: look up single customer
          return { id: CUSTOMER_ID, domain: DOMAIN } as T;
        }
        return null as T;
      },
      async all<T = unknown>() {
        if (sql.includes("FROM customers") && sql.includes("LEFT JOIN snippet_status")) {
          return { results: state.activeCustomers as T[], success: true };
        }
        return { results: [] as T[], success: true };
      },
      async run() {
        // Capture the upserted row from the bind args for assertions.
        if (sql.includes("INSERT INTO snippet_status")) {
          const [cid, probed_at, in_html, last_evt, status, reason] = stmt._binds;
          state.upserted = {
            customer_id: cid as string,
            last_probed_at: probed_at as number,
            snippet_in_html: in_html as number,
            last_event_at: last_evt as number | null,
            status: status as string,
            status_reason: reason as string | null,
          };
        }
        return { success: true, meta: {} };
      },
    };
    return stmt;
  });

  return { prepare } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchOk(html: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const encoder = new TextEncoder();
      const encoded = encoder.encode(html);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      });
      return { ok: true, status: 200, body: stream } as unknown as Response;
    }),
  );
}

function mockFetchTimeout() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const err = new Error("The operation was aborted.");
      err.name = "TimeoutError";
      throw err;
    }),
  );
}

function mockFetchHttpError(status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      return { ok: false, status, body: null } as unknown as Response;
    }),
  );
}

// ---------------------------------------------------------------------------
// probeSingleCustomer tests
// ---------------------------------------------------------------------------

describe("probeSingleCustomer — snippet found, recent event → active", () => {
  it("returns status=active and upserts the row", async () => {
    const now = Date.now();
    const recentEvent = now - 30 * 60 * 1000; // 30 min ago

    const state: DbState = {
      lastEventAt: recentEvent,
      snippetStatusRow: null,
      activeCustomers: [],
      upserted: null,
    };
    const env: ProbeEnv = { DB: makeDb(state), ...INSTALL_ENV };

    // HTML contains the snippet marker
    mockFetchOk(
      `<html><head><script src="https://${SNIPPET_MARKER}" data-customer-id="${CUSTOMER_ID}"></script></head></html>`,
    );

    const result = await probeSingleCustomer({ id: CUSTOMER_ID, domain: DOMAIN }, env);

    expect(result.status).toBe("active");
    expect(state.upserted).not.toBeNull();
    expect(state.upserted?.status).toBe("active");
    expect(state.upserted?.snippet_in_html).toBe(1);
    expect(state.upserted?.last_event_at).toBe(recentEvent);
  });
});

describe("probeSingleCustomer — snippet found, no events → never", () => {
  it("returns status=never", async () => {
    const state: DbState = {
      lastEventAt: null,
      snippetStatusRow: null,
      activeCustomers: [],
      upserted: null,
    };
    const env: ProbeEnv = { DB: makeDb(state), ...INSTALL_ENV };
    mockFetchOk(
      `<html><script src="https://${SNIPPET_MARKER}" data-customer-id="${CUSTOMER_ID}"></script></html>`,
    );

    const result = await probeSingleCustomer({ id: CUSTOMER_ID, domain: DOMAIN }, env);

    expect(result.status).toBe("never");
    expect(state.upserted?.snippet_in_html).toBe(1);
    expect(state.upserted?.last_event_at).toBeNull();
  });
});

describe("probeSingleCustomer — snippet found, event older than 24h → stale", () => {
  it("returns status=stale", async () => {
    const now = Date.now();
    const oldEvent = now - 36 * 60 * 60 * 1000; // 36h ago

    const state: DbState = {
      lastEventAt: oldEvent,
      snippetStatusRow: null,
      activeCustomers: [],
      upserted: null,
    };
    const env: ProbeEnv = { DB: makeDb(state), ...INSTALL_ENV };
    mockFetchOk(
      `<html><script src="https://${SNIPPET_MARKER}" data-customer-id="${CUSTOMER_ID}"></script></html>`,
    );

    const result = await probeSingleCustomer({ id: CUSTOMER_ID, domain: DOMAIN }, env);

    expect(result.status).toBe("stale");
    expect(state.upserted?.snippet_in_html).toBe(1);
  });
});

describe("probeSingleCustomer — snippet NOT found → removed", () => {
  it("returns status=removed", async () => {
    const state: DbState = {
      lastEventAt: Date.now() - 60_000,
      snippetStatusRow: null,
      activeCustomers: [],
      upserted: null,
    };
    const env: ProbeEnv = { DB: makeDb(state), ...INSTALL_ENV };
    // HTML does NOT contain the snippet marker
    mockFetchOk(
      "<html><head><script src='https://cdn.example.com/other.js'></script></head></html>",
    );

    const result = await probeSingleCustomer({ id: CUSTOMER_ID, domain: DOMAIN }, env);

    expect(result.status).toBe("removed");
    expect(state.upserted?.snippet_in_html).toBe(0);
  });
});

describe("probeSingleCustomer — fetch times out → status=unknown", () => {
  it("returns status=unknown and upserts unknown row", async () => {
    const state: DbState = {
      lastEventAt: Date.now() - 60_000,
      snippetStatusRow: null,
      activeCustomers: [],
      upserted: null,
    };
    const env: ProbeEnv = { DB: makeDb(state), ...INSTALL_ENV };
    mockFetchTimeout();

    const result = await probeSingleCustomer({ id: CUSTOMER_ID, domain: DOMAIN }, env);

    expect(result.status).toBe("unknown");
    expect(state.upserted?.status).toBe("unknown");
    // snippet_in_html stays 0 on timeout
    expect(state.upserted?.snippet_in_html).toBe(0);
  });
});

describe("probeSingleCustomer — HTTP error → status=unknown", () => {
  it("returns status=unknown on HTTP 404", async () => {
    const state: DbState = {
      lastEventAt: null,
      snippetStatusRow: null,
      activeCustomers: [],
      upserted: null,
    };
    const env: ProbeEnv = { DB: makeDb(state), ...INSTALL_ENV };
    mockFetchHttpError(404);

    const result = await probeSingleCustomer({ id: CUSTOMER_ID, domain: DOMAIN }, env);

    expect(result.status).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// runSnippetProbe — rate-limit guard
// ---------------------------------------------------------------------------

describe("runSnippetProbe — rate-limit guard", () => {
  it("skips customers probed within the last 6h", async () => {
    const now = Date.now();
    const recentProbe = now - 60 * 60 * 1000; // 1h ago (within 24h window)

    const state: DbState = {
      lastEventAt: null,
      snippetStatusRow: null,
      activeCustomers: [
        {
          id: "recently-probed",
          domain: "example.com",
          last_probed_at: recentProbe,
          tag_found_at: recentProbe,
        },
        { id: "never-probed", domain: "never.example.com", last_probed_at: null },
      ],
      upserted: null,
    };

    const fetchMock = vi.fn(async () => {
      const encoder = new TextEncoder();
      const html = `<html><script src="https://${SNIPPET_MARKER}" data-customer-id="${CUSTOMER_ID}"></script></html>`;
      const encoded = encoder.encode(html);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      });
      return { ok: true, status: 200, body: stream } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const env: ProbeEnv = { DB: makeDb(state), ...INSTALL_ENV };
    const result = await runSnippetProbe(env);

    // Only "never-probed" customer should be probed
    expect(result.probed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    // fetch called once (for never-probed only)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("probes customers whose last probe was > 6h ago and whose tag was found lately", async () => {
    const now = Date.now();
    const oldProbe = now - 7 * 60 * 60 * 1000; // 7h ago

    const state: DbState = {
      lastEventAt: null,
      snippetStatusRow: null,
      activeCustomers: [
        {
          id: "old-probe",
          domain: "old.example.com",
          last_probed_at: oldProbe,
          tag_found_at: oldProbe,
        } as DbState["activeCustomers"][number],
      ],
      upserted: null,
    };

    mockFetchOk(
      `<html><script src="https://${SNIPPET_MARKER}" data-customer-id="${CUSTOMER_ID}"></script></html>`,
    );

    const env: ProbeEnv = { DB: makeDb(state), ...INSTALL_ENV };
    const result = await runSnippetProbe(env);

    expect(result.probed).toBe(1);
    expect(result.skipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Privacy assertion: no URL or HTML body in log output
// ---------------------------------------------------------------------------

describe("Privacy: no URL or HTML body in console output", () => {
  beforeEach(() => {
    consoleSpy.log.mockClear();
    consoleSpy.error.mockClear();
    consoleSpy.warn.mockClear();
  });

  it("on timeout: log message does not contain the customer URL", async () => {
    const state: DbState = {
      lastEventAt: null,
      snippetStatusRow: null,
      activeCustomers: [],
      upserted: null,
    };
    const env: ProbeEnv = { DB: makeDb(state), ...INSTALL_ENV };
    mockFetchTimeout();

    await probeSingleCustomer({ id: CUSTOMER_ID, domain: DOMAIN }, env);

    // All console.error calls should not contain the actual domain
    for (const call of consoleSpy.error.mock.calls) {
      const msg = call.join(" ");
      expect(msg).not.toContain(DOMAIN);
      expect(msg).not.toContain("https://");
    }
    for (const call of consoleSpy.log.mock.calls) {
      const msg = call.join(" ");
      expect(msg).not.toContain(DOMAIN);
    }
  });

  it("on HTTP error: log message does not contain the customer URL", async () => {
    const state: DbState = {
      lastEventAt: null,
      snippetStatusRow: null,
      activeCustomers: [],
      upserted: null,
    };
    const env: ProbeEnv = { DB: makeDb(state), ...INSTALL_ENV };
    mockFetchHttpError(500);

    await probeSingleCustomer({ id: CUSTOMER_ID, domain: DOMAIN }, env);

    for (const call of consoleSpy.error.mock.calls) {
      const msg = call.join(" ");
      expect(msg).not.toContain(DOMAIN);
      expect(msg).not.toContain("https://");
    }
  });

  it("on success: no customer URL or HTML body is logged", async () => {
    const state: DbState = {
      lastEventAt: Date.now() - 10_000,
      snippetStatusRow: null,
      activeCustomers: [],
      upserted: null,
    };
    const env: ProbeEnv = { DB: makeDb(state), ...INSTALL_ENV };
    mockFetchOk(
      `<html><script src="https://${SNIPPET_MARKER}" data-customer-id="${CUSTOMER_ID}"></script></html>`,
    );

    await probeSingleCustomer({ id: CUSTOMER_ID, domain: DOMAIN }, env);

    // Success path should not log anything at all
    for (const call of [
      ...consoleSpy.log.mock.calls,
      ...consoleSpy.error.mock.calls,
      ...consoleSpy.warn.mock.calls,
    ]) {
      const msg = call.join(" ");
      expect(msg).not.toContain(DOMAIN);
      expect(msg).not.toContain("<html>");
      expect(msg).not.toContain("https://school");
    }
  });
});

describe("checkTag", () => {
  it("accepts the custom edge domain and the workers.dev origin with this customer's id", async () => {
    const probe = await import("../../src/cron/snippet-probe.ts");
    const checkTag = (html: string, id: string) => probe.checkTag(html, id, EDGE_ORIGINS);
    expect(
      checkTag(
        '<head><script async src="https://edge.example.com/snippet.js" data-customer-id="lumera" data-edge-origin="https://edge.example.com"></script></head>',
        "lumera",
      ),
    ).toBe("found");
    expect(
      checkTag(
        `<script src="https://${SNIPPET_MARKER}" data-customer-id="lumera"></script>`,
        "lumera",
      ),
    ).toBe("found");
    // The edge-old.example.com domain the same worker still serves (the
    // a Lovable test site Lovable page from 2026-08 carried this exact tag).
    expect(
      checkTag(
        '<script async="" src="https://edge-old.example.com/snippet.js" data-customer-id="taskboard-test" data-edge-origin="https://edge-old.example.com"></script>',
        "taskboard-test",
      ),
    ).toBe("found");
  });

  it("treats a tag with another customer id, or an edited id, as not installed", async () => {
    const probe = await import("../../src/cron/snippet-probe.ts");
    const checkTag = (html: string, id: string) => probe.checkTag(html, id, EDGE_ORIGINS);
    const html =
      '<script src="https://edge.example.com/snippet.js" data-customer-id="lumera-school"></script>';
    expect(checkTag(html, "lumera")).toBe("other-customer");
    expect(checkTag("<html><head></head></html>", "lumera")).toBe("missing");
    expect(
      checkTag(
        '<script src="https://cdn.example.com/snippet.js" data-customer-id="lumera"></script>',
        "lumera",
      ),
    ).toBe("missing");
  });
});

describe("checkTag: the customer's own script", () => {
  it("counts /s/{id}.js as installed for that id only", async () => {
    const probe = await import("../../src/cron/snippet-probe.ts");
    const checkTag = (html: string, id: string) => probe.checkTag(html, id, EDGE_ORIGINS);
    expect(checkTag('<script src="https://edge.example.com/s/lumera.js"></script>', "lumera")).toBe(
      "found",
    );
    expect(
      checkTag('<script src="https://edge.example.com/s/lumera.js"></script>', "lumera-school"),
    ).toBe("other-customer");
  });
});

describe("checkTagWithForm", () => {
  it("names the form: the per-customer script, the older generic tag, or none", async () => {
    const probe = await import("../../src/cron/snippet-probe.ts");
    const checkTagWithForm = (html: string, id: string) =>
      probe.checkTagWithForm(html, id, EDGE_ORIGINS);
    expect(
      checkTagWithForm('<script src="https://edge.example.com/s/lumera.js"></script>', "lumera"),
    ).toEqual({ check: "found", form: "script" });
    expect(
      checkTagWithForm(
        '<script async src="https://edge-old.example.com/snippet.js" data-customer-id="lumera" data-edge-origin="https://edge-old.example.com"></script>',
        "lumera",
      ),
    ).toEqual({ check: "found", form: "generic" });
    expect(checkTagWithForm("<html></html>", "lumera")).toEqual({ check: "missing", form: null });
    expect(
      checkTagWithForm('<script src="https://edge.example.com/s/other.js"></script>', "lumera"),
    ).toEqual({ check: "other-customer", form: null });
  });
});

// ---------------------------------------------------------------------------
// The host rule: the probe never follows a redirect to another host
// ---------------------------------------------------------------------------

describe("probeSingleCustomer: the recorded host only", () => {
  function redirectingFetch(location: string, html: string) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        calls.push(u);
        expect(init?.redirect).toBe("manual");
        if (calls.length === 1) {
          return new Response(null, { status: 301, headers: { location } });
        }
        return new Response(html, { status: 200 });
      }),
    );
    return calls;
  }
  const TAG = `<script src="https://${SNIPPET_MARKER}" data-customer-id="${CUSTOMER_ID}"></script>`;

  it("a redirect to another host is not followed and is reported as off_host", async () => {
    const state: DbState = {
      lastEventAt: null,
      snippetStatusRow: null,
      activeCustomers: [],
      upserted: null,
    };
    const calls = redirectingFetch("https://other.example.net/", TAG);
    const r = await probeSingleCustomer(
      { id: CUSTOMER_ID, domain: DOMAIN },
      { DB: makeDb(state), ...INSTALL_ENV },
    );
    expect(calls).toEqual([`https://${DOMAIN}/`]);
    expect(r.read).toBe("off_host");
    expect(r.status).toBe("unknown");
    expect(r.reason).toBe(OFF_HOST_LINE);
    expect(state.upserted?.status_reason).toBe(OFF_HOST_LINE);
    for (const call of consoleSpy.error.mock.calls) {
      expect(call.join(" ")).not.toContain("other.example.net");
    }
  });

  it("www and the apex are one site: that redirect is followed", async () => {
    const state: DbState = {
      lastEventAt: null,
      snippetStatusRow: null,
      activeCustomers: [],
      upserted: null,
    };
    const calls = redirectingFetch(`https://www.${DOMAIN}/`, TAG);
    const r = await probeSingleCustomer(
      { id: CUSTOMER_ID, domain: DOMAIN },
      { DB: makeDb(state), ...INSTALL_ENV },
    );
    expect(calls).toEqual([`https://${DOMAIN}/`, `https://www.${DOMAIN}/`]);
    expect(r.read).toBe("ok");
    expect(r.status).toBe("never");
  });
});

// ---------------------------------------------------------------------------
// The rhythm: 6 h while the tag is found, weekly after 7 days without it
// ---------------------------------------------------------------------------

describe("probeInterval", () => {
  const NOW = Date.UTC(2026, 9, 5, 12);
  const DAY = 24 * 60 * 60 * 1000;

  it("6 hours while the tag was found in the last 7 days", () => {
    expect(probeInterval({ tag_found_at: NOW - 6 * DAY, created_at: NOW - 90 * DAY }, NOW)).toBe(
      PROBE_INTERVAL_MS,
    );
  });

  it("weekly once the tag has been missing 7 days in a row", () => {
    expect(probeInterval({ tag_found_at: NOW - 7 * DAY, created_at: NOW - 90 * DAY }, NOW)).toBe(
      WEEKLY_INTERVAL_MS,
    );
  });

  it("never found: 6 hours for a customer added this week, weekly after", () => {
    expect(probeInterval({ tag_found_at: null, created_at: NOW - 2 * DAY }, NOW)).toBe(
      PROBE_INTERVAL_MS,
    );
    expect(probeInterval({ tag_found_at: null, created_at: NOW - 8 * DAY }, NOW)).toBe(
      WEEKLY_INTERVAL_MS,
    );
    expect(probeInterval({ tag_found_at: null, created_at: null }, NOW)).toBe(WEEKLY_INTERVAL_MS);
  });

  it("the weekly gap is under a week, so the hourly cron reads within 7 days", () => {
    expect(WEEKLY_INTERVAL_MS).toBeLessThan(7 * DAY);
    expect(WEEKLY_INTERVAL_MS + 60 * 60 * 1000).toBeLessThanOrEqual(7 * DAY);
  });
});

describe("runSnippetProbe: the rhythm on the real schema", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  function setup(now: number) {
    const { d1, db } = makeSqliteD1();
    const add = (
      id: string,
      createdAt: number,
      status?: { probed: number; found: number | null; inHtml: number },
    ) => {
      db.prepare(
        "INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES (?, ?, ?, 'pilot', 'active', ?)",
      ).run(id, id, `${id}.example.com`, createdAt);
      if (status) {
        db.prepare(
          "INSERT INTO snippet_status (customer_id, last_probed_at, snippet_in_html, status, tag_found_at) VALUES (?, ?, ?, 'removed', ?)",
        ).run(id, status.probed, status.inHtml, status.found);
      }
    };
    const pages = new Map<string, string>();
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const host = new URL(String(input)).hostname;
        fetched.push(host);
        return new Response(pages.get(host) ?? "<html></html>", { status: 200 });
      }),
    );
    return { env: { DB: d1, ...INSTALL_ENV } as ProbeEnv, db, add, pages, fetched, now };
  }

  const tagFor = (id: string) =>
    `<html><script src="https://edge.example.com/s/${id}.js"></script></html>`;

  it("reads a found tag every 6 h, a tag missing 7 days weekly, a never-installed old customer weekly", async () => {
    const now = Date.now();
    const { env, add, fetched } = setup(now);
    // Found 1 day ago, last read 7 h ago: due.
    add("found", now - 90 * DAY, { probed: now - 7 * HOUR, found: now - DAY, inHtml: 1 });
    // Missing since 8 days, last read 7 h ago: not due (weekly).
    add("gone", now - 90 * DAY, { probed: now - 7 * HOUR, found: now - 8 * DAY, inHtml: 0 });
    // Missing since 8 days, last read 7 days ago: due.
    add("gone-due", now - 90 * DAY, { probed: now - 7 * DAY, found: now - 8 * DAY, inHtml: 0 });
    // Never installed, added 30 days ago, last read 2 days ago: not due.
    add("never-old", now - 30 * DAY, { probed: now - 2 * DAY, found: null, inHtml: 0 });
    // Never installed, added 2 days ago, last read 7 h ago: due.
    add("never-new", now - 2 * DAY, { probed: now - 7 * HOUR, found: null, inHtml: 0 });
    // Never read at all: due.
    add("fresh", now - HOUR);

    const r = await runSnippetProbe(env, now);
    expect(fetched.sort()).toEqual(
      ["found", "gone-due", "never-new", "fresh"].map((id) => `${id}.example.com`).sort(),
    );
    expect(r).toEqual({ probed: 4, skipped: 2, errors: 0 });
  });

  it("a find records tag_found_at; a miss keeps the last find, so 7 days in a row count", async () => {
    const now = Date.now();
    const { env, db, add, pages } = setup(now);
    const found = now - 3 * DAY;
    add("cust", now - 90 * DAY, { probed: now - 7 * HOUR, found, inHtml: 1 });

    // The tag is gone: the miss keeps the last find.
    await runSnippetProbe(env, now);
    const afterMiss = db
      .prepare(
        "SELECT tag_found_at, snippet_in_html FROM snippet_status WHERE customer_id = 'cust'",
      )
      .get() as { tag_found_at: number; snippet_in_html: number };
    expect(afterMiss.snippet_in_html).toBe(0);
    expect(afterMiss.tag_found_at).toBe(found);

    // Reinstalled: the next read records the find.
    pages.set("cust.example.com", tagFor("cust"));
    db.prepare("UPDATE snippet_status SET last_probed_at = ? WHERE customer_id = 'cust'").run(
      now - 7 * HOUR,
    );
    await runSnippetProbe(env, now);
    const afterFind = db
      .prepare(
        "SELECT tag_found_at, snippet_in_html FROM snippet_status WHERE customer_id = 'cust'",
      )
      .get() as { tag_found_at: number; snippet_in_html: number };
    expect(afterFind.snippet_in_html).toBe(1);
    expect(afterFind.tag_found_at).toBeGreaterThanOrEqual(now);
  });

  it("a reinstall on a weekly customer is read within a week", async () => {
    const now = Date.now();
    const { env, add, pages, fetched } = setup(now);
    add("back", now - 90 * DAY, { probed: now - 7 * DAY, found: now - 30 * DAY, inHtml: 0 });
    pages.set("back.example.com", tagFor("back"));
    const r = await runSnippetProbe(env, now);
    expect(fetched).toEqual(["back.example.com"]);
    expect(r.probed).toBe(1);
  });
});
