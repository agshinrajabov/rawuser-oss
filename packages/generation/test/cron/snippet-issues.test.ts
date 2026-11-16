/**
 * Snippet issues, the generation side (docs/specs/snippet-issues.md): the
 * share math, the hourly alert (5% and 20 loads, one line per customer and
 * code per day, a path only when confirmed, never n), the superadmin read
 * endpoint (aggregates only, hours capped and validated) and the 31-day
 * deletion through scheduled(). Real SQL on node:sqlite with every
 * migration applied.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSqliteD1 } from "../admin/sqlite-d1.ts";

type User = { id: string; email: string; role: string; customer_id: string | null };
const SUPERADMIN: User = {
  id: "u1",
  email: "f@example.com",
  role: "superadmin",
  customer_id: null,
};
let sessionUser: User | null = SUPERADMIN;

vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionUser),
}));

const { default: worker } = await import("../../src/index.ts");
const { runOpsHeartbeat } = await import("../../src/cron/ops-heartbeat.ts");
const {
  aggregateCustomerIssues,
  dueIssues,
  issueAlertDue,
  issueAlertLine,
  issueLineDecision,
  isSmallSite,
  issueShare,
  parseIssueHours,
  readIssueMarker,
  ISSUE_MARKER_TTL_S,
} = await import("../../src/lib/snippet-issues.ts");
const { lateTagWeeklyLine, runLateTagWeekly } = await import("../../src/cron/late-tag-weekly.ts");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let sql: ReturnType<typeof makeSqliteD1>["db"];
let d1: D1Database;
let kvStore: Map<string, string>;
let kvPuts: Array<{ key: string; ttl: number | undefined }>;
let env: Record<string, unknown>;
let alerts: string[];
let seq = 0;

beforeEach(() => {
  const made = makeSqliteD1();
  sql = made.db;
  d1 = made.d1;
  kvStore = new Map();
  kvPuts = [];
  alerts = [];
  sessionUser = SUPERADMIN;
  const kv = {
    get: async (k: string) => kvStore.get(k) ?? null,
    put: async (k: string, v: string, o?: { expirationTtl?: number }) => {
      kvStore.set(k, v);
      kvPuts.push({ key: k, ttl: o?.expirationTtl });
    },
    delete: async (k: string) => {
      kvStore.delete(k);
    },
  } as unknown as KVNamespace;
  env = {
    DB: d1,
    VARIANTS: kv,
    ENVIRONMENT: "test",
    DASHBOARD_ORIGIN: "https://app.example.com",
    ALERT_WEBHOOK_URL: "https://api.telegram.org/botTEST/sendMessage?chat_id=1",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "api.telegram.org") {
        alerts.push(url.searchParams.get("text") ?? "");
        return Response.json({ ok: true });
      }
      // Edge /health: healthy, so only snippet issue alerts are sent.
      return new Response("{}", { status: 200 });
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function customer(id: string): void {
  sql
    .prepare(
      "INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES (?, ?, ?, 'pilot', 'active', 1)",
    )
    .run(id, id, `${id}.example`);
}

function confirm(id: string, path: string): void {
  sql
    .prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at) VALUES (?, ?, '{}', 'https://x.example/', 1, 2)",
    )
    .run(id, path);
}

function events(
  id: string,
  type: string,
  path: string,
  count: number,
  opts: { props?: unknown; ago?: number } = {},
): void {
  const stmt = sql.prepare(
    "INSERT INTO events (id, customer_id, ts, event_type, page_path, properties) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const ts = Date.now() - (opts.ago ?? 2 * HOUR);
  const props =
    opts.props === undefined
      ? null
      : typeof opts.props === "string"
        ? opts.props
        : JSON.stringify(opts.props);
  for (let i = 0; i < count; i++) stmt.run(`e${++seq}`, id, ts, type, path, props);
}

const issue = (...items: Array<{ c: string; s?: string; n?: number }>) => ({ issues: items });

/**
 * A pilot site over the last 24 h:
 *   /az      400 exposures; 25 loads lines_changed on hero.headline (n 2),
 *            5 of them also on hero.body; 3 more on "/az/" (the same route).
 *   /pricing 100 exposures; 10 loads whose /select failed (no exposure).
 * Total loads 510; lines_changed on 28 (5.5%).
 */
function seedLumera(): void {
  customer("lumera");
  events("lumera", "variant_shown", "/az", 300);
  events("lumera", "no_signal_passthrough", "/az", 60);
  events("lumera", "personalization_skipped", "/az", 40);
  events("lumera", "variant_shown", "/pricing", 100);
  events("lumera", "snippet_issue", "/az", 20, {
    props: issue({ c: "lines_changed", s: "hero.headline", n: 2 }),
  });
  events("lumera", "snippet_issue", "/az", 5, {
    props: issue(
      { c: "lines_changed", s: "hero.headline", n: 2 },
      { c: "lines_changed", s: "hero.body", n: -1 },
    ),
  });
  events("lumera", "snippet_issue", "/az/", 3, {
    props: issue({ c: "lines_changed", s: "hero.headline", n: 1 }),
  });
  events("lumera", "snippet_issue", "/pricing", 10, { props: issue({ c: "select_failed", n: 1 }) });
  // Not counted: older than the window, an unknown code, a malformed row,
  // another event type, another customer.
  events("lumera", "snippet_issue", "/az", 50, {
    props: issue({ c: "lines_changed", s: "hero.headline", n: 2 }),
    ago: 25 * HOUR,
  });
  events("lumera", "snippet_issue", "/az", 2, { props: issue({ c: "made_up", s: "hero.body" }) });
  events("lumera", "snippet_issue", "/az", 2, { props: "{not json" });
  events("lumera", "conversion", "/az", 30);
  customer("other");
  events("other", "variant_shown", "/az", 300);
  events("other", "snippet_issue", "/az", 10, {
    props: issue({ c: "lines_changed", s: "hero.headline", n: 2 }),
  });
}

// ---------------------------------------------------------------------------
// The share math and the threshold
// ---------------------------------------------------------------------------

describe("share and threshold", () => {
  it("share is count over loads, 0 without loads, never over 1", () => {
    expect(issueShare(7, 100)).toBeCloseTo(0.07, 10);
    expect(issueShare(5, 0)).toBe(0);
    expect(issueShare(0, 40)).toBe(0);
    expect(issueShare(12, 10)).toBe(1);
  });

  it("alerts at 5% and 20 loads, not below either", () => {
    expect(issueAlertDue(20, 0.05)).toBe(true);
    expect(issueAlertDue(400, 0.5)).toBe(true);
    expect(issueAlertDue(19, 0.9)).toBe(false);
    expect(issueAlertDue(1000, 0.0499)).toBe(false);
  });

  it("aggregates per page and code: distinct loads, folded paths, exposures plus failed selects", async () => {
    seedLumera();
    const agg = await aggregateCustomerIssues(d1, "lumera", Date.now() - DAY);
    expect(agg.loads).toBe(510);
    expect(agg.pages).toEqual([
      {
        page_path: "/az",
        loads: 400,
        issues: [{ code: "lines_changed", count: 28, share: 28 / 400, slot: "hero.headline" }],
      },
      {
        page_path: "/pricing",
        loads: 110,
        issues: [{ code: "select_failed", count: 10, share: 10 / 110, slot: null }],
      },
    ]);
    expect(agg.totals.map((t) => [t.code, t.count, t.loads, t.page_path, t.slot])).toEqual([
      ["lines_changed", 28, 510, "/az", "hero.headline"],
      ["select_failed", 10, 510, "/pricing", null],
    ]);
    expect(agg.totals[0]?.share).toBeCloseTo(28 / 510, 10);
  });

  it("pages stored before the edge masked come back as :id, one page (event-paths.md)", async () => {
    customer("lumera");
    const a = "/admin/students/550e8400-e29b-41d4-a716-446655440000";
    const b = "/admin/students/6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    events("lumera", "no_signal_passthrough", a, 20);
    events("lumera", "no_signal_passthrough", b, 20);
    events("lumera", "snippet_issue", a, 3, { props: issue({ c: "apply_error" }) });
    events("lumera", "snippet_issue", b, 2, { props: issue({ c: "apply_error" }) });
    const agg = await aggregateCustomerIssues(d1, "lumera", Date.now() - DAY);
    expect(agg.pages).toEqual([
      {
        page_path: "/admin/students/:id",
        loads: 40,
        issues: [{ code: "apply_error", count: 5, share: 5 / 40, slot: null }],
      },
    ]);
    expect(agg.totals.map((t) => t.page_path)).toEqual(["/admin/students/:id"]);
  });

  it("the indexed plan: every query searches idx_events_customer_type_ts", () => {
    const of = `json_each(CASE WHEN json_valid(e.properties) THEN e.properties ELSE '{}' END, '$.issues')`;
    const plans = [
      `SELECT e.page_path, COUNT(DISTINCT e.id) FROM events e, ${of} j WHERE e.customer_id = 'x' AND e.event_type = 'snippet_issue' AND e.ts >= 0 GROUP BY e.page_path`,
      "SELECT page_path, COUNT(*) FROM events WHERE customer_id = 'x' AND event_type IN ('variant_shown', 'no_signal_passthrough', 'personalization_skipped') AND ts >= 0 GROUP BY page_path",
      "DELETE FROM events WHERE customer_id IN (SELECT id FROM customers) AND event_type = 'snippet_issue' AND ts < 0",
    ].map((q) =>
      (sql.prepare(`EXPLAIN QUERY PLAN ${q}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(" | "),
    );
    for (const p of plans) expect(p).toContain("INDEX idx_events_customer_type_ts");
  });
});

// ---------------------------------------------------------------------------
// The hourly alert
// ---------------------------------------------------------------------------

describe("hourly alert", () => {
  it("one line naming the confirmed page and the slot, never n; once a day per customer and code", async () => {
    seedLumera();
    confirm("lumera", "/az");
    const first = await runOpsHeartbeat(env as never);
    expect(first.alerted).toEqual(["snippet-issue:lumera:lines_changed"]);
    // Only /az has versions: its 400 loads are the alert's loads, and the
    // 10 failed selects on /pricing (no versions) are not in the line.
    expect(alerts).toEqual([
      "[rawuser ops] snippet-issue · lumera · lines_changed on 7% of loads, 28 of 400 (hero.headline, /az) · 24 h",
    ]);
    expect(kvPuts).toEqual([
      { key: "ops:alert:snippet-issue:lumera:lines_changed", ttl: ISSUE_MARKER_TTL_S },
    ]);
    const marker = JSON.parse(kvStore.get("ops:alert:snippet-issue:lumera:lines_changed") ?? "");
    expect(marker.share).toBeCloseTo(28 / 400, 6);
    expect(marker.first).toBe(marker.last);

    const second = await runOpsHeartbeat(env as never);
    expect(second.alerted).toEqual([]);
    expect(second.deduped).toEqual(["snippet-issue:lumera:lines_changed"]);
    expect(alerts).toHaveLength(1);
  });

  it("a page without versions is not in the alert; the page with them is", async () => {
    seedLumera();
    confirm("lumera", "/pricing"); // confirmed, but not where lines_changed is
    await runOpsHeartbeat(env as never);
    // /az has no versions: its 28 lines_changed loads are not in the line.
    // /pricing alone is 110 loads a day, a small site: 10 failed selects of
    // 110 over 72 h.
    expect(alerts).toEqual([
      "[rawuser ops] snippet-issue · lumera · select_failed on 9% of loads, 10 of 110 (/pricing) · 72 h",
    ]);
    // n (2, 1, -1 in the rows) is never in the line.
    expect(alerts[0]).not.toMatch(/\bn\b|-1|\b2 lines?\b/);
  });

  // The pilot, 2026-10-18: "select_failed on 5% of loads, 17 of 320 (another
  // page)" where the home page, the one page with versions, had 3 in 121.
  it("failures on pages without versions raise no line; a customer with no confirmed page keeps every page", async () => {
    customer("medora");
    confirm("medora", "/");
    events("medora", "variant_shown", "/", 120);
    events("medora", "snippet_issue", "/", 3, { props: issue({ c: "select_failed", n: 2 }) });
    events("medora", "personalization_skipped", "/products/:item", 300, {
      props: { kind: "missing" },
    });
    events("medora", "snippet_issue", "/products/:item", 30, {
      props: issue({ c: "select_failed", n: 2 }),
    });
    const due = await dueIssues(d1, "medora", Date.now());
    expect(due).toEqual([]);
    // The read for the dashboard still counts every page.
    const all = await aggregateCustomerIssues(d1, "medora", Date.now() - DAY);
    expect(all.totals[0]).toMatchObject({ code: "select_failed", count: 33, loads: 453 });

    customer("handtagged");
    events("handtagged", "variant_shown", "/", 120);
    events("handtagged", "snippet_issue", "/products/x", 30, {
      props: issue({ c: "select_failed", n: 2 }),
    });
    expect((await dueIssues(d1, "handtagged", Date.now())).map((d) => d.total.code)).toEqual([
      "select_failed",
    ]);
  });

  it("a code without a slot names only the page; customers and codes are separate", async () => {
    customer("lab");
    confirm("lab", "/");
    events("lab", "variant_shown", "/", 180);
    events("lab", "snippet_issue", "/", 20, { props: issue({ c: "select_failed", n: 3 }) });
    events("lab", "snippet_issue", "/", 22, { props: issue({ c: "reveal_cap", n: 1 }) });
    seedLumera();
    confirm("lumera", "/az");
    const r = await runOpsHeartbeat(env as never);
    expect(r.alerted.sort()).toEqual([
      "snippet-issue:lab:reveal_cap",
      "snippet-issue:lab:select_failed",
      "snippet-issue:lumera:lines_changed",
    ]);
    // Loads on /: 180 exposures plus 20 failed selects.
    expect(alerts).toContain(
      "[rawuser ops] snippet-issue · lab · reveal_cap on 11% of loads, 22 of 200 (/) · 24 h",
    );
    expect(alerts).toContain(
      "[rawuser ops] snippet-issue · lab · select_failed on 10% of loads, 20 of 200 (/) · 24 h",
    );
  });

  // 2026-10-02: the lab's forced failures must not bury a pilot's alert.
  it("a customer on plan test never raises a snippet-issue alert", async () => {
    customer("lab");
    sql.prepare("UPDATE customers SET plan = 'test' WHERE id = 'lab'").run();
    confirm("lab", "/");
    events("lab", "variant_shown", "/", 30);
    events("lab", "snippet_issue", "/", 27, { props: issue({ c: "select_failed", n: 2 }) });
    seedLumera();
    confirm("lumera", "/az");
    const r = await runOpsHeartbeat(env as never);
    expect(r.alerted).toEqual(["snippet-issue:lumera:lines_changed"]);
    expect(alerts.some((a) => a.includes(" lab "))).toBe(false);
  });

  it("a site of 200 loads a day or more: under 20 loads or under 5% stays quiet", async () => {
    // 19 loads of one code among 300 today: 6%, and one short of 20.
    customer("nineteen");
    events("nineteen", "variant_shown", "/", 300);
    events("nineteen", "snippet_issue", "/", 19, {
      props: issue({ c: "apply_error", s: "hero.headline" }),
    });
    customer("big");
    events("big", "variant_shown", "/", 1000);
    events("big", "snippet_issue", "/", 49, { props: issue({ c: "swap_shift", n: 2 }) });
    const r = await runOpsHeartbeat(env as never);
    expect(r.alerted).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("the line builder: a path only when confirmed, no slot when none", () => {
    const t = {
      code: "reverted" as const,
      count: 30,
      loads: 300,
      share: 0.1,
      slot: "features.body",
      page_path: "/secret-campaign",
    };
    expect(issueAlertLine("acme", t, new Set(["/"]))).toBe(
      "snippet-issue · acme · reverted on 10% of loads, 30 of 300 (features.body, another page) · 24 h",
    );
    expect(issueAlertLine("acme", { ...t, slot: null }, new Set(["/secret-campaign"]))).toBe(
      "snippet-issue · acme · reverted on 10% of loads, 30 of 300 (/secret-campaign) · 24 h",
    );
  });
});

// ---------------------------------------------------------------------------
// A line is sent again only when it is news (2026-10-13)
// ---------------------------------------------------------------------------

describe("when a line is sent again", () => {
  const T0 = Date.UTC(2026, 9, 12, 9, 0, 0);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** `failed` of 400 loads on `/` today for `acme`, written at the clock's now. */
  function day(failed: number, loads = 400): void {
    events("acme", "variant_shown", "/", loads - failed);
    events("acme", "snippet_issue", "/", failed, { props: issue({ c: "select_failed", n: 2 }) });
  }
  const lines = () => alerts.filter((a) => a.includes("select_failed"));

  it("the same share the next day is not sent again; a share up by half is", async () => {
    customer("acme");
    confirm("acme", "/");
    day(24); // 6%
    expect((await runOpsHeartbeat(env as never)).alerted).toEqual([
      "snippet-issue:acme:select_failed",
    ]);
    // Day 2, the same share: quiet, the marker only notes the code is still over the line.
    vi.setSystemTime(T0 + DAY);
    day(24);
    const second = await runOpsHeartbeat(env as never);
    expect(second.alerted).toEqual([]);
    expect(second.deduped).toEqual(["snippet-issue:acme:select_failed"]);
    expect(lines()).toHaveLength(1);
    // Day 3, 9% (24 of 400 was 6%; 9 is 6 and a half): news.
    vi.setSystemTime(T0 + 2 * DAY);
    day(36);
    expect((await runOpsHeartbeat(env as never)).alerted).toEqual([
      "snippet-issue:acme:select_failed",
    ]);
    expect(lines()).toEqual([
      "[rawuser ops] snippet-issue · acme · select_failed on 6% of loads, 24 of 400 (/) · 24 h",
      "[rawuser ops] snippet-issue · acme · select_failed on 9% of loads, 36 of 400 (/) · 24 h",
    ]);
    // Day 4, 8%: under one and a half times the 9% last sent, quiet.
    vi.setSystemTime(T0 + 3 * DAY);
    day(32);
    expect((await runOpsHeartbeat(env as never)).alerted).toEqual([]);
    expect(lines()).toHaveLength(2);
  });

  it("after seven days the line is sent again and says so at its end", async () => {
    customer("acme");
    confirm("acme", "/");
    for (let d = 0; d < 8; d++) {
      vi.setSystemTime(T0 + d * DAY);
      day(24);
      const r = await runOpsHeartbeat(env as never);
      expect(r.alerted).toEqual(d === 0 || d === 7 ? ["snippet-issue:acme:select_failed"] : []);
    }
    expect(lines()).toEqual([
      "[rawuser ops] snippet-issue · acme · select_failed on 6% of loads, 24 of 400 (/) · 24 h",
      "[rawuser ops] snippet-issue · acme · select_failed on 6% of loads, 24 of 400 (/) · 24 h · still, day 8",
    ]);
    // The marker keeps the day the run began.
    const m = readIssueMarker(kvStore.get("ops:alert:snippet-issue:acme:select_failed") ?? null);
    expect(m?.first).toBe(T0);
    expect(m?.last).toBe(T0 + 7 * DAY);
  });

  it("a day under the threshold: one quiet line, the marker goes, and a return is news again", async () => {
    customer("acme");
    confirm("acme", "/");
    day(24);
    await runOpsHeartbeat(env as never);
    // Day 2: under the line (2 of 400). Not yet a day quiet: nothing.
    vi.setSystemTime(T0 + DAY);
    day(2);
    const r2 = await runOpsHeartbeat(env as never);
    expect(r2.alerted).toEqual([]);
    expect(kvStore.has("ops:alert:snippet-issue:acme:select_failed")).toBe(true);
    // A day under the line: the quiet line, once, and the marker is gone.
    vi.setSystemTime(T0 + 2 * DAY + HOUR);
    day(2);
    const r3 = await runOpsHeartbeat(env as never);
    expect(r3.alerted).toEqual(["snippet-issue:acme:select_failed:recovered"]);
    expect(alerts.at(-1)).toBe(
      "[rawuser ops] snippet-issue · acme · select_failed back under the threshold",
    );
    expect(kvStore.has("ops:alert:snippet-issue:acme:select_failed")).toBe(false);
    expect((await runOpsHeartbeat(env as never)).alerted).toEqual([]);
    // Back over the line: a new run, sent with no "still".
    vi.setSystemTime(T0 + 3 * DAY);
    day(24);
    expect((await runOpsHeartbeat(env as never)).alerted).toEqual([
      "snippet-issue:acme:select_failed",
    ]);
    expect(alerts.at(-1)).toBe(
      "[rawuser ops] snippet-issue · acme · select_failed on 6% of loads, 24 of 400 (/) · 24 h",
    );
    expect(alerts.filter((a) => a.includes("still"))).toEqual([]);
  });

  it("the decision alone: a marker from before the shares were kept, and the rise needs a share", () => {
    const now = T0 + 2 * HOUR;
    const old = readIssueMarker(String(T0));
    expect(old).toEqual({ first: T0, last: T0, share: null, seen: T0 });
    // No share to compare: not news on a rise, news after seven days.
    expect(issueLineDecision(old, 0.5, now).send).toBe(false);
    const week = T0 + 7 * DAY;
    const legacy = { first: T0, last: T0, share: null, seen: week - HOUR };
    expect(issueLineDecision(legacy, 0.5, week)).toMatchObject({
      send: true,
      still: 8,
    });
    expect(readIssueMarker("{not json")).toBeNull();
    expect(readIssueMarker(JSON.stringify({ first: 1 }))).toBeNull();
    const m = { first: T0, last: T0, share: 0.06, seen: now - HOUR };
    expect(issueLineDecision(m, 0.089, now).send).toBe(false);
    expect(issueLineDecision(m, 0.09, now)).toMatchObject({ send: true, still: null });
    expect(issueLineDecision(m, 0.06, now).marker).toEqual({ ...m, seen: now });
  });

  it("late_tag never gets a daily line; the Monday message carries it once a week", async () => {
    customer("acme");
    confirm("acme", "/");
    // 340 visits on the confirmed page in 7 days, 17 painted before the tag (5%).
    events("acme", "variant_shown", "/", 323);
    events("acme", "personalization_skipped", "/", 17, { props: { kind: "late", lp: 1 } });
    events("acme", "snippet_issue", "/", 17, { props: issue({ c: "late_tag" }) });
    const r = await runOpsHeartbeat(env as never);
    expect(r.alerted).toEqual([]);
    expect(alerts).toEqual([]);

    const monday = await runLateTagWeekly(env as never);
    expect(monday.sent).toEqual(["acme"]);
    expect(alerts).toEqual([
      "[rawuser ops] late-tag · acme · tag low in the page: 5% of visits, 17 of 340 · 7 d",
    ]);
    // Once a week: a second run of the same Monday sends nothing.
    expect((await runLateTagWeekly(env as never)).sent).toEqual([]);
    expect(alerts).toHaveLength(1);
  });

  it("the Monday line needs the Pages card's gate: 30 visits and 5%; a test customer never", async () => {
    customer("few");
    confirm("few", "/");
    events("few", "variant_shown", "/", 10);
    events("few", "personalization_skipped", "/", 10, { props: { kind: "late", lp: 1 } });
    customer("low");
    confirm("low", "/");
    events("low", "variant_shown", "/", 97);
    events("low", "personalization_skipped", "/", 3, { props: { kind: "late", lp: 1 } });
    customer("lab");
    sql.prepare("UPDATE customers SET plan = 'test' WHERE id = 'lab'").run();
    confirm("lab", "/");
    events("lab", "variant_shown", "/", 20);
    events("lab", "personalization_skipped", "/", 20, { props: { kind: "late", lp: 1 } });
    expect((await runLateTagWeekly(env as never)).sent).toEqual([]);
    expect(alerts).toEqual([]);
    expect(
      lateTagWeeklyLine("x", { exposures: 40, late_exposures: 16, share: 0.4, enough: true }),
    ).toBe("[rawuser ops] late-tag · x · tag low in the page: 40% of visits, 16 of 40 · 7 d");
  });
});

// ---------------------------------------------------------------------------
// The floor follows the customer's traffic (pilot-gaps.md, F4.1)
// ---------------------------------------------------------------------------

describe("the alert on a small site", () => {
  /** `perDay` exposures on each of the last three days, on `/`. */
  function traffic(id: string, perDay: number): void {
    for (const ago of [2 * HOUR, 30 * HOUR, 54 * HOUR]) {
      events(id, "variant_shown", "/", perDay, { ago });
    }
  }
  /** `perDay[i]` loads whose /select failed, today, yesterday and the day before. */
  function failed(id: string, perDay: [number, number, number]): void {
    [2 * HOUR, 30 * HOUR, 54 * HOUR].forEach((ago, i) => {
      events(id, "snippet_issue", "/", perDay[i] as number, {
        props: issue({ c: "select_failed", n: 2 }),
        ago,
      });
    });
  }

  it("Medora's numbers: 70 loads a day, 8 failed selects a day, alerts over 72 h", async () => {
    customer("medora");
    confirm("medora", "/");
    traffic("medora", 70);
    failed("medora", [8, 8, 8]);
    // Under the 24 h rule alone: 8 loads of the code, never 20.
    const day = await aggregateCustomerIssues(d1, "medora", Date.now() - DAY);
    expect(day.totals[0]).toMatchObject({ code: "select_failed", count: 8, loads: 78 });
    expect(issueAlertDue(8, 8 / 78)).toBe(false);

    const first = await runOpsHeartbeat(env as never);
    expect(first.alerted).toEqual(["snippet-issue:medora:select_failed"]);
    // 210 exposures and 24 failed selects in 72 h.
    expect(alerts).toEqual([
      "[rawuser ops] snippet-issue · medora · select_failed on 10% of loads, 24 of 234 (/) · 72 h",
    ]);
    // One marker per customer and code; the next pass is quiet.
    expect(kvPuts).toEqual([
      { key: "ops:alert:snippet-issue:medora:select_failed", ttl: ISSUE_MARKER_TTL_S },
    ]);
    const second = await runOpsHeartbeat(env as never);
    expect(second.alerted).toEqual([]);
    expect(second.deduped).toEqual(["snippet-issue:medora:select_failed"]);
    expect(alerts).toHaveLength(1);
  });

  it("both sides of the line: 180 loads a day alerts over 72 h, 220 a day keeps the 24 h rule", async () => {
    // Under the line: 10 failed a day is never 20 in a day, and is 30 of 570 (5%) in three.
    customer("under");
    traffic("under", 180);
    failed("under", [10, 10, 10]);
    // Over the line: 14 failed a day is 42 of 702 (6%) in three days, and
    // still under 20 in the day: quiet, as it always was.
    customer("over");
    traffic("over", 220);
    failed("over", [14, 14, 14]);
    const r = await runOpsHeartbeat(env as never);
    expect(r.alerted).toEqual(["snippet-issue:under:select_failed"]);
    expect(alerts).toEqual([
      "[rawuser ops] snippet-issue · under · select_failed on 5% of loads, 30 of 570 (another page) · 72 h",
    ]);
  });

  it("over the line the usual rule still alerts, with its 24 h", async () => {
    customer("over");
    traffic("over", 220);
    failed("over", [20, 0, 0]);
    const r = await runOpsHeartbeat(env as never);
    expect(r.alerted).toEqual(["snippet-issue:over:select_failed"]);
    expect(alerts[0]).toContain("select_failed on 8% of loads, 20 of 240 (another page) · 24 h");
  });

  it("a site live since yesterday with 300 loads is not small", async () => {
    customer("new");
    events("new", "variant_shown", "/", 300);
    events("new", "snippet_issue", "/", 16, { props: issue({ c: "reveal_cap", n: 1 }) });
    const r = await runOpsHeartbeat(env as never);
    expect(r.alerted).toEqual([]);
  });

  it("a quiet small site raises nothing", async () => {
    // Two failed loads in three days.
    customer("calm");
    traffic("calm", 70);
    failed("calm", [1, 0, 1]);
    // Seven in three days: one under the floor.
    customer("seven");
    traffic("seven", 70);
    failed("seven", [3, 2, 2]);
    // Nine in three days among 579 loads: over the floor, under 2% of loads.
    customer("rare");
    traffic("rare", 190);
    failed("rare", [3, 3, 3]);
    // A burst that stopped: twelve the day before yesterday, none since.
    customer("stopped");
    traffic("stopped", 70);
    failed("stopped", [0, 0, 12]);
    // No issue row at all.
    customer("clean");
    traffic("clean", 70);
    const r = await runOpsHeartbeat(env as never);
    expect(r.alerted).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("a small site still needs the code in the last 24 h, and each code is judged alone", async () => {
    customer("mixed");
    traffic("mixed", 60);
    failed("mixed", [2, 5, 5]);
    // reveal_cap: fifteen yesterday (8% of the three days' loads), none today.
    events("mixed", "snippet_issue", "/", 15, {
      props: issue({ c: "reveal_cap", n: 1 }),
      ago: 30 * HOUR,
    });
    const r = await runOpsHeartbeat(env as never);
    expect(r.alerted).toEqual(["snippet-issue:mixed:select_failed"]);
    expect(alerts[0]).toContain("select_failed on 6% of loads, 12 of 192");
  });

  it("the line between small and not: under 200 today and under 200 a day over three days", () => {
    expect(isSmallSite(70, 210)).toBe(true);
    expect(isSmallSite(199, 597)).toBe(true);
    expect(isSmallSite(200, 300)).toBe(false);
    expect(isSmallSite(150, 600)).toBe(false);
    expect(issueAlertDue(8, 0.05, 8)).toBe(true);
    expect(issueAlertDue(7, 0.5, 8)).toBe(false);
    expect(issueAlertDue(8, 0.049, 8)).toBe(false);
    // Without a floor given, the usual 20.
    expect(issueAlertDue(19, 0.5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/health/issues
// ---------------------------------------------------------------------------

async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`https://api.example.com${path}`, {
      headers: { "x-rawuser-admin": "session" },
    }),
    env as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("GET /admin/health/issues", () => {
  it("answers aggregates per page and code, nothing else", async () => {
    seedLumera();
    const r = await get("/admin/health/issues?customer_id=lumera");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual([
      "customer_id",
      "hours",
      "late",
      "loads",
      "pages",
      "since",
      "site",
    ]);
    // The site-wide install line (install-friction.md, UI item 5): closed
    // enums and timestamps only, never a host or policy text.
    expect(Object.keys(r.json.site as object).sort()).toEqual([
      "csp_blocks",
      "csp_blocks_since",
      "csp_degrades",
      "csp_report_only_blocks",
      "platform",
      "probed_at",
      "tag_flags",
      "tag_position",
    ]);
    expect(r.json.hours).toBe(24);
    expect(r.json.loads).toBe(510);
    expect(r.json.pages).toEqual([
      {
        page_path: "/az",
        loads: 400,
        issues: [{ code: "lines_changed", count: 28, share: 0.07, slot: "hero.headline" }],
      },
      {
        page_path: "/pricing",
        loads: 110,
        issues: [{ code: "select_failed", count: 10, share: 0.0909, slot: null }],
      },
    ]);
    // Never a row, an id or n.
    const text = JSON.stringify(r.json);
    expect(text).not.toMatch(/"n"|"id"|"ts"|"properties"|"e\d+"/);
  });

  it("late: the Pages card's share of visits painted first, over 7 days whatever `hours` says", async () => {
    customer("lab");
    confirm("lab", "/");
    // Two hours ago: 24 written, 12 kept as built because the page was painted first.
    events("lab", "variant_shown", "/", 24);
    events("lab", "personalization_skipped", "/", 12, { props: { kind: "late", lp: 1 } });
    // Three days ago, outside `hours=1` and inside the 7 days.
    events("lab", "variant_shown", "/", 4, { ago: 3 * DAY, props: { lp: 1 } });
    // Eight days ago: outside.
    events("lab", "personalization_skipped", "/", 9, {
      ago: 8 * DAY,
      props: { kind: "late", lp: 1 },
    });
    // A passthrough is no exposure to a version.
    events("lab", "no_signal_passthrough", "/", 50);
    const want = { exposures: 40, late_exposures: 16, share: 0.4, enough: true };
    expect((await get("/admin/health/issues?customer_id=lab")).json.late).toEqual(want);
    expect((await get("/admin/health/issues?customer_id=lab&hours=1")).json.late).toEqual(want);
    // Counts only: never a row, a marker or the bit's own name.
    expect(JSON.stringify((await get("/admin/health/issues?customer_id=lab")).json)).not.toMatch(
      /"lp"|"visit"|"properties"/,
    );
  });

  it("late: under 30 visits the card is told there is not enough", async () => {
    customer("lab");
    confirm("lab", "/");
    events("lab", "variant_shown", "/", 20);
    events("lab", "personalization_skipped", "/", 9, { props: { kind: "late", lp: 1 } });
    expect((await get("/admin/health/issues?customer_id=lab")).json.late).toEqual({
      exposures: 29,
      late_exposures: 9,
      share: 0.3103,
      enough: false,
    });
    customer("empty");
    expect((await get("/admin/health/issues?customer_id=empty")).json.late).toEqual({
      exposures: 0,
      late_exposures: 0,
      share: null,
      enough: false,
    });
  });

  it("late: only exposures on a confirmed page count, in both numbers", async () => {
    customer("lab");
    confirm("lab", "/");
    // The home page has versions: 30 written, 10 kept as built, painted first.
    events("lab", "variant_shown", "/", 30);
    events("lab", "personalization_skipped", "/", 10, { props: { kind: "late", lp: 1 } });
    // Product pages have none of their own: the skip is `missing`, the
    // holdout exposure has no bit, and rows from before the rule carry one.
    events("lab", "personalization_skipped", "/products/chair", 60, {
      props: { kind: "missing" },
    });
    events("lab", "variant_shown", "/products/chair", 15);
    events("lab", "personalization_skipped", "/products/desk", 25, {
      props: { kind: "late", lp: 1 },
    });
    // 10 of 40, not 10 of 140 and not 35 of 140.
    expect((await get("/admin/health/issues?customer_id=lab")).json.late).toEqual({
      exposures: 40,
      late_exposures: 10,
      share: 0.25,
      enough: true,
    });
    // A page confirmed later joins both counts: "confirmed" is read now.
    confirm("lab", "/products/desk");
    expect((await get("/admin/health/issues?customer_id=lab")).json.late).toEqual({
      exposures: 65,
      late_exposures: 35,
      share: 0.5385,
      enough: true,
    });
  });

  it("late: a page without versions gets no late line, and keeps its other lines", async () => {
    customer("lab");
    confirm("lab", "/");
    events("lab", "variant_shown", "/", 40);
    events("lab", "variant_shown", "/products/chair", 40);
    events("lab", "variant_shown", "/products/desk", 40);
    events("lab", "snippet_issue", "/", 8, { props: issue({ c: "late_tag" }) });
    events("lab", "snippet_issue", "/products/chair", 12, { props: issue({ c: "late_tag" }) });
    events("lab", "snippet_issue", "/products/chair", 4, {
      props: issue({ c: "select_failed", n: 2 }),
    });
    events("lab", "snippet_issue", "/products/desk", 6, { props: issue({ c: "late_tag" }) });
    const r = await get("/admin/health/issues?customer_id=lab");
    expect(r.json.pages).toEqual([
      {
        page_path: "/products/chair",
        loads: 44,
        issues: [{ code: "select_failed", count: 4, share: 0.0909, slot: null }],
      },
      {
        page_path: "/",
        loads: 40,
        issues: [{ code: "late_tag", count: 8, share: 0.2, slot: null }],
      },
    ]);
    // The customer's totals, and so the hourly alert, are what they were.
    const agg = await aggregateCustomerIssues(d1, "lab", Date.now() - DAY);
    expect(agg.totals.find((t) => t.code === "late_tag")?.count).toBe(26);
  });

  it("hours: a smaller window, capped at 744, anything not a positive integer is 400", async () => {
    seedLumera();
    const one = await get("/admin/health/issues?customer_id=lumera&hours=1");
    expect(one.json.hours).toBe(1);
    // Every seeded row is two hours old, so a one-hour window has none.
    expect(one.json.pages).toEqual([]);

    const wide = await get("/admin/health/issues?customer_id=lumera&hours=48");
    expect(wide.json.hours).toBe(48);
    // The 25-hour-old rows now count: 78 loads with lines_changed on /az.
    const az = (
      wide.json.pages as Array<{ page_path: string; issues: Array<{ count: number }> }>
    )[0];
    expect(az?.page_path).toBe("/az");
    expect(az?.issues[0]?.count).toBe(78);

    for (const h of ["745", "100000", "9999999"]) {
      const capped = await get(`/admin/health/issues?customer_id=lumera&hours=${h}`);
      expect(capped.status).toBe(200);
      expect(capped.json.hours).toBe(744);
    }
    for (const h of ["0", "-3", "1.5", "abc", "1e3", " 24", "24h", ""]) {
      const bad = await get(
        `/admin/health/issues?customer_id=lumera&hours=${encodeURIComponent(h)}`,
      );
      expect(bad.status, h).toBe(400);
    }
    expect(parseIssueHours(null)).toBe(24);
  });

  it("a customer reads only its own pages; customer_id required; unknown customer is 404", async () => {
    seedLumera();
    sessionUser = { id: "u2", email: "c@example.com", role: "customer", customer_id: "lumera" };
    expect((await get("/admin/health/issues?customer_id=lumera")).status).toBe(200);
    expect((await get("/admin/health/issues?customer_id=other")).status).toBe(403);
    expect((await get("/admin/health/issues")).status).toBe(403);
    sessionUser = null;
    expect((await get("/admin/health/issues?customer_id=lumera")).status).toBe(401);
    sessionUser = SUPERADMIN;
    expect((await get("/admin/health/issues")).status).toBe(400);
    expect((await get("/admin/health/issues?customer_id=nobody")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// select_failed 4: the page was left while we asked (F1, privacy review Q5)
// ---------------------------------------------------------------------------

describe("select_failed 4 is an exit, not a failure", () => {
  const EXIT = issue({ c: "select_failed", n: 4 });

  it("is in no count, no share and no denominator; the other codes of its row still count", async () => {
    customer("lab");
    // The late line is for a page with versions of its own.
    confirm("lab", "/");
    events("lab", "variant_shown", "/", 100);
    // Real failures, one of each kind, and one from before n existed.
    events("lab", "snippet_issue", "/", 3, { props: issue({ c: "select_failed", n: 1 }) });
    events("lab", "snippet_issue", "/", 2, { props: issue({ c: "select_failed", n: 2 }) });
    events("lab", "snippet_issue", "/", 2, { props: issue({ c: "select_failed", n: 3 }) });
    events("lab", "snippet_issue", "/", 1, { props: issue({ c: "select_failed" }) });
    // Exits: alone, and behind another code of the same load.
    events("lab", "snippet_issue", "/", 30, { props: EXIT });
    events("lab", "snippet_issue", "/", 4, {
      props: issue({ c: "reveal_cap", n: 1 }, { c: "select_failed", n: 4 }),
    });
    events("lab", "snippet_issue", "/", 5, {
      props: issue({ c: "late_tag" }, { c: "select_failed", n: 4 }),
    });
    // A page whose only rows are exits.
    events("lab", "variant_shown", "/pricing", 40);
    events("lab", "snippet_issue", "/pricing", 12, { props: EXIT });

    const agg = await aggregateCustomerIssues(d1, "lab", Date.now() - DAY);
    // 140 exposures and 8 failed selects; none of the 51 exits.
    expect(agg.loads).toBe(148);
    expect(agg.pages).toEqual([
      {
        page_path: "/",
        loads: 108,
        issues: [
          { code: "select_failed", count: 8, share: 8 / 108, slot: null },
          { code: "late_tag", count: 5, share: 5 / 108, slot: null },
          { code: "reveal_cap", count: 4, share: 4 / 108, slot: null },
        ],
      },
    ]);
    expect(agg.totals.map((t) => [t.code, t.count, t.loads])).toEqual([
      ["select_failed", 8, 148],
      ["late_tag", 5, 148],
      ["reveal_cap", 4, 148],
    ]);
  });

  it("a customer whose only rows are exits has nothing at all", async () => {
    customer("lab");
    events("lab", "variant_shown", "/", 100);
    events("lab", "snippet_issue", "/", 60, { props: EXIT });
    expect(await aggregateCustomerIssues(d1, "lab", Date.now() - DAY)).toEqual({
      loads: 0,
      pages: [],
      totals: [],
    });
  });

  it("a slot on an exit is not read either", async () => {
    customer("lab");
    events("lab", "variant_shown", "/", 100);
    events("lab", "snippet_issue", "/", 9, {
      props: issue({ c: "select_failed", n: 4, s: "hero.headline" }),
    });
    events("lab", "snippet_issue", "/", 3, { props: issue({ c: "select_failed", n: 2 }) });
    const agg = await aggregateCustomerIssues(d1, "lab", Date.now() - DAY);
    expect(agg.pages[0]?.issues).toEqual([
      { code: "select_failed", count: 3, share: 3 / 103, slot: null },
    ]);
  });

  it("raises no alert: 40 exits among 400 loads are quiet, 40 failures are not", async () => {
    customer("left");
    confirm("left", "/");
    events("left", "variant_shown", "/", 400);
    events("left", "snippet_issue", "/", 40, { props: EXIT });
    customer("failed");
    confirm("failed", "/");
    events("failed", "variant_shown", "/", 400);
    events("failed", "snippet_issue", "/", 40, { props: issue({ c: "select_failed", n: 2 }) });

    const r = await runOpsHeartbeat(env as never);
    expect(r.alerted).toEqual(["snippet-issue:failed:select_failed"]);
    expect(alerts).toEqual([
      "[rawuser ops] snippet-issue · failed · select_failed on 9% of loads, 40 of 440 (/) · 24 h",
    ]);
  });

  it("does not hide the failures beside it: the alert counts them alone", async () => {
    customer("mixed");
    confirm("mixed", "/");
    events("mixed", "variant_shown", "/", 400);
    events("mixed", "snippet_issue", "/", 25, { props: issue({ c: "select_failed", n: 1 }) });
    events("mixed", "snippet_issue", "/", 300, { props: EXIT });
    await runOpsHeartbeat(env as never);
    // 25 of 425: the 300 exits are in neither number.
    expect(alerts).toEqual([
      "[rawuser ops] snippet-issue · mixed · select_failed on 6% of loads, 25 of 425 (/) · 24 h",
    ]);
  });

  it("a small site: exits today do not bring back yesterday's failures, nor count over 72 h", async () => {
    // 70 loads a day; 9 failed selects yesterday and the day before, none
    // today. Today: exits only. The 72 h rule needs the code in the last
    // 24 h, and an exit is not the code.
    customer("small");
    confirm("small", "/");
    for (const ago of [2 * HOUR, 30 * HOUR, 54 * HOUR]) {
      events("small", "variant_shown", "/", 70, { ago });
    }
    for (const ago of [30 * HOUR, 54 * HOUR]) {
      events("small", "snippet_issue", "/", 9, {
        props: issue({ c: "select_failed", n: 2 }),
        ago,
      });
    }
    events("small", "snippet_issue", "/", 15, { props: EXIT });
    const quiet = await runOpsHeartbeat(env as never);
    expect(quiet.alerted).toEqual([]);

    // One real failure today: the alert, with 19 of 229, never the 15 exits.
    events("small", "snippet_issue", "/", 1, { props: issue({ c: "select_failed", n: 3 }) });
    await runOpsHeartbeat(env as never);
    expect(alerts).toEqual([
      "[rawuser ops] snippet-issue · small · select_failed on 8% of loads, 19 of 229 (/) · 72 h",
    ]);
  });

  it("the read endpoint: no line, no count and no new field for an exit, for a superadmin or a customer", async () => {
    customer("lab");
    confirm("lab", "/");
    confirm("lab", "/pricing");
    events("lab", "variant_shown", "/", 50);
    events("lab", "snippet_issue", "/", 3, { props: issue({ c: "select_failed", n: 2 }) });
    events("lab", "snippet_issue", "/", 17, { props: EXIT });
    events("lab", "variant_shown", "/pricing", 20);
    events("lab", "snippet_issue", "/pricing", 6, { props: EXIT });

    const expected = [
      {
        page_path: "/",
        loads: 53,
        issues: [{ code: "select_failed", count: 3, share: 0.0566, slot: null }],
      },
    ];
    for (const who of [
      SUPERADMIN,
      { id: "u2", email: "c@example.com", role: "customer", customer_id: "lab" },
    ]) {
      sessionUser = who;
      const r = await get("/admin/health/issues?customer_id=lab");
      expect(r.status).toBe(200);
      // No key for the exits (condition 4: not shown). `late` is the late
      // tag's share of exposures (docs/specs/late-tag.md) and counts no exit:
      // 70 visits met a version here, whatever was left while asking.
      expect(Object.keys(r.json).sort()).toEqual([
        "customer_id",
        "hours",
        "late",
        "loads",
        "pages",
        "since",
        "site",
      ]);
      expect(r.json.late).toEqual({ exposures: 70, late_exposures: 0, share: 0, enough: true });
      // 70 exposures on the two pages and 3 failed selects.
      expect(r.json.loads).toBe(73);
      expect(r.json.pages).toEqual(expected);
      // 17, 6 and 23 are the exits: nowhere in the answer.
      const text = JSON.stringify({ loads: r.json.loads, pages: r.json.pages });
      expect(text).not.toMatch(/\b(17|6|23)\b|exit|left|"n"/);
    }
  });
});

// ---------------------------------------------------------------------------
// A row is not a load (F7): the list a second after the reveal, `reverted` after
// ---------------------------------------------------------------------------

describe("a load that sends two rows", () => {
  /** One load: its list a second after the reveal, then `reverted` alone. */
  function twoRowLoads(id: string, path: string, count: number): void {
    events(id, "snippet_issue", path, count, {
      props: issue({ c: "lines_changed", s: "hero.headline", n: 1 }, { c: "swap_shift", n: 1 }),
    });
    events(id, "snippet_issue", path, count, {
      props: issue({ c: "reverted", s: "hero.body", n: 5 }),
    });
  }

  it("counts each code once per load and adds nothing to the loads", async () => {
    customer("lab");
    events("lab", "variant_shown", "/", 50);
    twoRowLoads("lab", "/", 10);
    const rows = sql
      .prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'snippet_issue'")
      .get() as { n: number };
    expect(rows.n).toBe(20);

    const agg = await aggregateCustomerIssues(d1, "lab", Date.now() - DAY);
    // 50 loads, 10 of them with an issue: never 20, never 70.
    expect(agg.loads).toBe(50);
    expect(agg.pages).toEqual([
      {
        page_path: "/",
        loads: 50,
        issues: [
          { code: "lines_changed", count: 10, share: 0.2, slot: "hero.headline" },
          { code: "reverted", count: 10, share: 0.2, slot: "hero.body" },
          { code: "swap_shift", count: 10, share: 0.2, slot: null },
        ],
      },
    ]);
  });

  it("the alert's numbers are loads: 20 two-row loads of 400 are 5%, not 10%", async () => {
    customer("lab");
    sql.prepare("UPDATE customers SET plan = 'pilot' WHERE id = 'lab'").run();
    confirm("lab", "/");
    events("lab", "variant_shown", "/", 400);
    twoRowLoads("lab", "/", 20);
    await runOpsHeartbeat(env as never);
    expect([...alerts].sort()).toEqual([
      "[rawuser ops] snippet-issue · lab · lines_changed on 5% of loads, 20 of 400 (hero.headline, /) · 24 h",
      "[rawuser ops] snippet-issue · lab · reverted on 5% of loads, 20 of 400 (hero.body, /) · 24 h",
      "[rawuser ops] snippet-issue · lab · swap_shift on 5% of loads, 20 of 400 (/) · 24 h",
    ]);
  });

  it("the customers list: a fault report is not a visit, an exit neither", async () => {
    customer("lab");
    events("lab", "variant_shown", "/", 7);
    events("lab", "conversion", "/", 1);
    twoRowLoads("lab", "/", 3);
    events("lab", "snippet_issue", "/", 5, { props: issue({ c: "select_failed", n: 4 }) });
    // Three days back: in the seven days, not in the 24 hours.
    events("lab", "no_signal_passthrough", "/", 4, { ago: 3 * DAY });
    events("lab", "snippet_issue", "/", 9, {
      props: issue({ c: "select_failed", n: 4 }),
      ago: 3 * DAY,
    });
    const res = await worker.fetch(
      new Request("https://api.example.com/admin/customers/list", {
        headers: { "x-rawuser-admin": "session" },
      }),
      env as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    const lab = list.find((c) => c.id === "lab");
    // 8 and 12: the 11 and 20 issue rows are in neither.
    expect(lab?.events_24h).toBe(8);
    expect(lab?.events_7d).toBe(12);
    // Whether the tag runs still takes any row.
    expect(lab?.onboarding_stage).toBe("live");
  });

  it("a customer with fault reports only shows no visits and is still live", async () => {
    customer("lab");
    events("lab", "snippet_issue", "/", 6, { props: issue({ c: "select_failed", n: 2 }) });
    const res = await worker.fetch(
      new Request("https://api.example.com/admin/customers/list", {
        headers: { "x-rawuser-admin": "session" },
      }),
      env as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    const lab = ((await res.json()) as Array<Record<string, unknown>>).find((c) => c.id === "lab");
    expect(lab?.events_24h).toBe(0);
    expect(lab?.events_7d).toBe(0);
    expect(lab?.onboarding_stage).toBe("live");
    expect(typeof lab?.last_event_at).toBe("number");
  });

  it("both counts of the list stay on an index", () => {
    const plans = [
      "SELECT COUNT(*) FROM events e WHERE e.customer_id = 'x' AND e.ts > 0",
      "SELECT COUNT(*) FROM events e WHERE e.customer_id = 'x' AND e.event_type = 'snippet_issue' AND e.ts > 0",
    ].map((q) =>
      (sql.prepare(`EXPLAIN QUERY PLAN ${q}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(" | "),
    );
    for (const p of plans) expect(p).toContain("COVERING INDEX");
  });
});

// ---------------------------------------------------------------------------
// Retention through scheduled()
// ---------------------------------------------------------------------------

describe("retention", () => {
  // ADR 0037 (2026-11-02): event data is kept for the life of the account.
  // The 6-hour cron deletes no snippet_issue row and NULLs nothing on any
  // row, however old; only the per-customer delete removes them.
  it("the 6-hour cron keeps every event row and every column of it, however old", async () => {
    customer("lumera");
    const OLD = 400 * 24 * HOUR;
    const props = { props: issue({ c: "reveal_cap", n: 1 }) };
    events("lumera", "snippet_issue", "/", 3, { ...props, ago: OLD });
    events("lumera", "snippet_issue", "/", 2, { ...props, ago: 2 * HOUR });
    sql
      .prepare(
        `INSERT INTO events (id, customer_id, ts, event_type, page_path, cohort, source_dim,
           visit, source_name, tagged, found_by, properties)
         VALUES ('old-exp', 'lumera', ?, 'personalization_skipped', '/', 'skipped', 'ai',
           '0123456789abcdef0123456789abcdef', 'chatgpt', 1, 'path', '{"kind":"late","lp":1}')`,
      )
      .run(Date.now() - OLD);

    const pending: Promise<unknown>[] = [];
    await worker.scheduled(
      { cron: "0 */6 * * *", scheduledTime: Date.now() } as ScheduledController,
      env as never,
      { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext,
    );
    await Promise.allSettled(pending);

    const count = (type: string) =>
      (
        sql.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = ?").get(type) as {
          n: number;
        }
      ).n;
    expect(count("snippet_issue")).toBe(5);
    expect(
      sql
        .prepare(
          "SELECT visit, source_name, tagged, found_by, properties FROM events WHERE id = 'old-exp'",
        )
        .get(),
    ).toEqual({
      visit: "0123456789abcdef0123456789abcdef",
      source_name: "chatgpt",
      tagged: 1,
      found_by: "path",
      properties: '{"kind":"late","lp":1}',
    });
  });
});
