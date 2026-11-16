/**
 * The audit's token handling (lib/audit-api.ts; privacy review,
 * condition 3): the invite, report and setup tokens go only in a POST body,
 * never in a URL, a query string or a header; the fragment is dropped from
 * the address bar once read; nothing is written to storage. The worker is a
 * stubbed fetch, the tab a stubbed window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[];
const writes: string[] = [];

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      writes.push(`${k}=${v}`);
      m.set(k, String(v));
    },
  };
}

let win: {
  location: { hash: string; pathname: string; search: string; href: string };
  history: { state: unknown; replaceState: (s: unknown, t: string, url: string) => void };
  sessionStorage: Storage;
  localStorage: Storage;
};

function answer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function worker(...answers: Response[]) {
  const queue = [...answers];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = queue.shift();
      if (!next) throw new TypeError("network down");
      return next;
    }),
  );
}

const T = "q7Hv2LmX9cRw4TbNq7Hv2LmX9cRw4TbN";
const SETUP = "setup-Zp4kW8sJ2nVb6yQeZp4kW8sJ2nVb";

/** No token anywhere but the body: not in the URL, not in a header. */
function clean(c: Call, token: string) {
  expect(c.method).toBe("POST");
  expect(c.url).not.toContain(token);
  expect(c.url).not.toContain("?");
  expect(c.url).not.toContain("#");
  expect(JSON.stringify(c.headers)).not.toContain(token);
}

beforeEach(() => {
  vi.resetModules();
  calls = [];
  writes.length = 0;
  win = {
    location: { hash: `#t=${T}`, pathname: "/audit/", search: "", href: "" },
    history: {
      state: null,
      replaceState: (_s, _t, url) => {
        win.location.hash = url.includes("#") ? url.slice(url.indexOf("#")) : "";
        win.location.href = url;
      },
    },
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
  };
  vi.stubGlobal("window", win);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the fragment", () => {
  it("reads t and drops the fragment from the address bar, keeping the path", async () => {
    const { takeHashToken } = await import("../../src/lib/audit-api");
    expect(takeHashToken()).toBe(T);
    expect(win.location.hash).toBe("");
    expect(win.location.href).toBe("/audit/");
    expect(writes).toEqual([]);
  });
  it("keeps a query and gives nothing without a fragment", async () => {
    win.location.hash = "";
    win.location.search = "?customer_id=x";
    const { takeHashToken } = await import("../../src/lib/audit-api");
    expect(takeHashToken()).toBe("");
  });
});

describe("public calls carry the token in the POST body only", () => {
  it("open", async () => {
    worker(answer(200, { ok: true, status: "invited", privacy_line: "x" }));
    const { openAuditInvite } = await import("../../src/lib/audit-api");
    const r = await openAuditInvite(T);
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    const c = calls[0] as Call;
    expect(c.url).toMatch(/\/admin\/audit\/open$/);
    clean(c, T);
    expect(c.body).toEqual({ t: T });
  });
  it("submit", async () => {
    worker(answer(201, { ok: true, customer_id: "q", setup_token: SETUP }));
    const { submitAudit } = await import("../../src/lib/audit-api");
    await submitAudit(T, {
      url: "https://quoteloom.example/",
      name: "Rina Holt",
      email: "rina@quoteloom.example",
      banner: false,
      terms: true,
    });
    const c = calls[0] as Call;
    expect(c.url).toMatch(/\/admin\/audit\/submit$/);
    clean(c, T);
    expect(c.body).toMatchObject({ t: T, terms: true, banner: false });
  });
  it("set your password posts the setup token once", async () => {
    worker(
      answer(200, {
        token: "session",
        user: { id: "u", email: "e", role: "customer", customer_id: "q" },
      }),
    );
    const { setAuditPassword } = await import("../../src/lib/audit-api");
    await setAuditPassword(SETUP, "correct horse");
    const c = calls[0] as Call;
    expect(c.url).toMatch(/\/admin\/customer-users\/setup$/);
    clean(c, SETUP);
    expect(c.body).toEqual({ token: SETUP, password: "correct horse" });
    expect(writes.join()).not.toContain(SETUP);
  });
  it("the public report", async () => {
    worker(answer(404, { ok: false, error: "Not found" }));
    const { readPublicReport } = await import("../../src/lib/audit-api");
    const r = await readPublicReport(T);
    expect(r.status).toBe(404);
    const c = calls[0] as Call;
    expect(c.url).toMatch(/\/admin\/audit\/report\/public$/);
    clean(c, T);
    expect(c.body).toEqual({ t: T });
  });
  it("sends no session header on a public call", async () => {
    win.sessionStorage.setItem("rawuser_admin_token", "session-token");
    worker(answer(200, { ok: true, status: "used" }));
    const { openAuditInvite } = await import("../../src/lib/audit-api");
    await openAuditInvite(T);
    expect(JSON.stringify((calls[0] as Call).headers)).not.toContain("session-token");
  });
});

describe("signed-in calls name the customer, never a token", () => {
  it("status, report, share link, review and the actions", async () => {
    win.sessionStorage.setItem("rawuser_admin_token", "session-token");
    worker(
      answer(200, {}),
      answer(200, {}),
      answer(200, { link: `https://app/audit/report/#t=${T}`, expires_at: 1, ends_at: 2 }),
      answer(200, {}),
      answer(200, {}),
      answer(200, {}),
      answer(200, {}),
      answer(200, {}),
      answer(200, {}),
      answer(200, {}),
    );
    const api = await import("../../src/lib/audit-api");
    await api.getAuditStatus("quoteloom-example");
    await api.getAuditReport("quoteloom-example");
    const link = await api.makeShareLink("quoteloom-example");
    await api.getAuditReview("quoteloom-example");
    await api.releaseReport("quoteloom-example");
    await api.revokeReport("quoteloom-example");
    await api.endAuditNow("quoteloom-example");
    await api.recordPilotTerms("quoteloom-example", 5);
    await api.makePilot("quoteloom-example");
    await api.makeAuditInvite({ name: "Rina" });
    expect(calls.map((c) => `${c.method} ${c.url.replace(/^https?:\/\/[^/]+/, "")}`)).toEqual([
      "GET /admin/audit?customer_id=quoteloom-example",
      "GET /admin/audit/report?customer_id=quoteloom-example",
      "POST /admin/audit/share-link",
      "GET /admin/audit/review?customer_id=quoteloom-example",
      "POST /admin/audit/release",
      "POST /admin/audit/revoke",
      "POST /admin/audit/end",
      "POST /admin/audit/pilot-terms",
      "POST /admin/audit/make-pilot",
      "POST /admin/applications/invite",
    ]);
    // The minted link comes back in the answer and is never requested.
    expect(link.link).toContain(T);
    for (const c of calls) expect(c.url).not.toContain(T);
    expect(calls[9]?.body).toEqual({ name: "Rina", kind: "audit" });
    expect(calls[7]?.body).toEqual({ customer_id: "quoteloom-example", signed_at: 5 });
  });
});
