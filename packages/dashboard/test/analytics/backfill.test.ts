/**
 * The superadmin's version-history backfill on /analytics
 * (docs/specs/proof-engine.md, section G and Rollout step 0.5): only a
 * superadmin sees it, it sends exactly { customer_id, what }, it sends
 * nothing while the write queue has versions waiting, and it shows the
 * endpoint's counts or the failure in plain words.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackfillControl, BackfillResult } from "../../src/components/analytics/BackfillControl";
import { ApiError } from "../../src/lib/api";
import {
  type Api,
  BACKFILL_PATH,
  type BackfillOutcome,
  backfillCopy,
  busyMessage,
  queueLine,
  resultView,
  runBackfill,
} from "../../src/lib/backfill";

const ID = "lumera";
const DOMAIN = "lumera.test";

interface Call {
  path: string;
  init?: RequestInit;
}

/** A fake API: the variant list, then the backfill answer (or a throw). */
function fakeApi(statuses: string[] | Error, answer: unknown | Error): { api: Api; calls: Call[] } {
  const calls: Call[] = [];
  const api = (async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path.startsWith("/admin/variants/list")) {
      if (statuses instanceof Error) throw statuses;
      return statuses.map((status) => ({ status }));
    }
    if (answer instanceof Error) throw answer;
    return answer;
  }) as Api;
  return { api, calls };
}

const posts = (calls: Call[]) => calls.filter((c) => c.path === BACKFILL_PATH);

describe("role gating", () => {
  it("renders nothing for a customer", () => {
    const html = renderToStaticMarkup(
      createElement(BackfillControl, { customerId: ID, domain: DOMAIN, superadmin: false }),
    );
    expect(html).toBe("");
  });

  it("renders both rebuilds, in plain words, for a superadmin", () => {
    const html = renderToStaticMarkup(
      createElement(BackfillControl, { customerId: ID, domain: DOMAIN, superadmin: true }),
    );
    expect(html).toContain("Rebuild version history");
    expect(html).toContain("Rebuild daily counts");
    expect(html).toContain("history first");
    expect(html).not.toContain("Backfill");
  });
});

describe("the request", () => {
  it("posts exactly { customer_id, what } for bodies", async () => {
    const { api, calls } = fakeApi(["ready", "ready", "error"], {
      ok: true,
      scanned: 3,
      written: 2,
      skipped: 0,
    });
    const out = await runBackfill(ID, "bodies", api);
    expect(out.kind).toBe("done");
    const sent = posts(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({ customer_id: ID, what: "bodies" });
    // the queue is checked first, for this customer
    expect(calls[0]?.path).toBe(`/admin/variants/list?customer_id=${ID}`);
  });

  it("posts what: outcomes", async () => {
    const { api, calls } = fakeApi([], { ok: true, days: 31, rebuilt: 30 });
    await runBackfill(ID, "outcomes", api);
    expect(JSON.parse(String(posts(calls)[0]?.init?.body))).toEqual({
      customer_id: ID,
      what: "outcomes",
    });
  });

  it("sends nothing while versions wait for the write queue", async () => {
    const { api, calls } = fakeApi(["ready", "stale", "stale"], { ok: true });
    const out = await runBackfill(ID, "bodies", api);
    expect(out).toEqual({ kind: "busy", waiting: 2 });
    expect(posts(calls)).toHaveLength(0);
  });

  it("sends nothing when the queue cannot be read", async () => {
    const { api, calls } = fakeApi(new Error("offline"), { ok: true });
    const out = await runBackfill(ID, "outcomes", api);
    expect(out.kind).toBe("failed");
    expect(posts(calls)).toHaveLength(0);
  });

  it("reads a 409 from the endpoint as busy", async () => {
    const { api } = fakeApi(
      [],
      new ApiError(409, 'API error 409: {"error":"A rewrite is in progress"}'),
    );
    expect(await runBackfill(ID, "bodies", api)).toEqual({ kind: "busy", waiting: null });
  });

  it("names the error in plain words", async () => {
    const cases: [Error, RegExp][] = [
      [new ApiError(403, 'API error 403: {"error":"Forbidden"}'), /superadmin session/],
      [
        new ApiError(404, 'API error 404: {"error":"Customer not found"}'),
        /no customer with the id lumera/,
      ],
      [
        new ApiError(400, 'API error 400: {"error":"customer_id is required"}'),
        /It said: customer_id is required\./,
      ],
      [
        new ApiError(500, "API error 500: "),
        /failed while running it \(500\)\. Running it again is safe/,
      ],
      [new TypeError("Failed to fetch"), /No answer from the server/],
    ];
    for (const [err, re] of cases) {
      const { api } = fakeApi([], err);
      const out = await runBackfill(ID, "bodies", api);
      expect(out.kind).toBe("failed");
      if (out.kind === "failed") expect(out.message).toMatch(re);
    }
  });
});

describe("the result", () => {
  const render = (outcome: BackfillOutcome) =>
    renderToStaticMarkup(createElement(BackfillResult, { outcome, domain: DOMAIN }));

  it("bodies: the counts, with the already-done ones derived", () => {
    const html = render({
      kind: "done",
      what: "bodies",
      result: { ok: true, scanned: 90, written: 85, skipped: 2 },
    });
    expect(html).toContain("Done. 85 versions given an id.");
    expect(html).toContain("Checked");
    expect(html).toContain(">90<");
    expect(html).toContain("Already had one");
    expect(html).toContain(">3<");
    expect(html).toContain("rewritten while this ran");
  });

  it("bodies: a second run says nothing changed", () => {
    const v = resultView(
      { kind: "done", what: "bodies", result: { ok: true, scanned: 90, written: 0, skipped: 0 } },
      DOMAIN,
    );
    expect(v.headline).toBe("Done. All 90 live versions already had their id. Nothing changed.");
    expect(v.note).toBeNull();
  });

  it("outcomes: days counted and the oldest left alone", () => {
    const html = render({
      kind: "done",
      what: "outcomes",
      result: { ok: true, days: 31, rebuilt: 30 },
    });
    expect(html).toContain("Done. 30 closed days counted again.");
    expect(html).toContain("The oldest day was left as it was.");
  });

  it("busy and failed render as words, never as a count", () => {
    expect(render({ kind: "busy", waiting: 14 })).toContain(
      "The write queue has 14 versions of lumera.test waiting. Nothing was sent.",
    );
    expect(render({ kind: "failed", message: "No answer from the server." })).toContain(
      'role="alert"',
    );
  });
});

describe("copy", () => {
  it("both dialogs say they write to production; no em or en dash anywhere", () => {
    const strings: string[] = [];
    for (const what of ["bodies", "outcomes"] as const) {
      const c = backfillCopy(what, DOMAIN);
      expect(c.rows.find((r) => r.dt === "Writes to")?.dd).toMatch(/^Production\./);
      strings.push(c.title, c.lead, c.confirm, c.running, ...c.rows.flatMap((r) => [r.dt, r.dd]));
    }
    strings.push(
      queueLine(null, DOMAIN),
      queueLine({ kind: "quiet" }, DOMAIN),
      queueLine({ kind: "busy", waiting: 1 }, DOMAIN),
      queueLine({ kind: "unknown" }, DOMAIN),
      busyMessage(null, DOMAIN),
      busyMessage(3, DOMAIN),
    );
    for (const s of strings) expect(s).not.toMatch(/[–—]/);
    expect(queueLine({ kind: "busy", waiting: 1 }, DOMAIN)).toBe(
      "1 version of lumera.test waiting to be written. Run this once it is done.",
    );
  });
});
