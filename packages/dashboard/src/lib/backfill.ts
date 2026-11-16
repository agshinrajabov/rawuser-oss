/**
 * The superadmin's version-history backfill (docs/specs/proof-engine.md,
 * section G and Rollout step 0.5), the copy and the logic behind
 * components/analytics/BackfillControl.tsx.
 *
 * The endpoint, as built in packages/generation/src/admin/proof.ts:
 *
 *   POST /admin/proof/backfill  { customer_id, what: "bodies" | "outcomes" }
 *   200 bodies    { ok: true, scanned, written, skipped }
 *   200 outcomes  { ok: true, days, rebuilt }
 *   400 bad JSON, no customer_id, or another `what`; 403 for a customer
 *   role; 404 for an unknown customer.
 *
 * Both runs are idempotent. The endpoint does not refuse while a rewrite
 * runs, and the spec says to run it "not while a rewrite runs for that
 * customer", so the dashboard checks the customer's versions first: any row
 * still `stale` is waiting for the write queue (Rewrite everything and
 * Regenerate all mark every row stale before writing), and the run is not
 * sent. A 409 from a later endpoint that guards this itself reads the same.
 */

import { ApiError, apiFetch } from "./api";

export type BackfillWhat = "bodies" | "outcomes";

export interface BodiesResult {
  ok: true;
  scanned: number;
  written: number;
  skipped: number;
}

export interface OutcomesResult {
  ok: true;
  days: number;
  rebuilt: number;
}

export type BackfillResult = BodiesResult | OutcomesResult;

export type BackfillOutcome =
  | { kind: "done"; what: "bodies"; result: BodiesResult }
  | { kind: "done"; what: "outcomes"; result: OutcomesResult }
  | { kind: "busy"; waiting: number | null }
  | { kind: "failed"; message: string };

export type QueueState =
  | { kind: "quiet" }
  | { kind: "busy"; waiting: number }
  | { kind: "unknown" };

/** The fetch the run uses; the tests hand in their own. */
export type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

export const BACKFILL_PATH = "/admin/proof/backfill";

export function backfillBody(customerId: string, what: BackfillWhat): string {
  return JSON.stringify({ customer_id: customerId, what });
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** Rows still waiting for the write queue; an errored row waits six hours and does not count. */
export async function readQueue(customerId: string, api: Api = apiFetch): Promise<QueueState> {
  try {
    const rows = await api<{ status: string }[]>(
      `/admin/variants/list?customer_id=${encodeURIComponent(customerId)}`,
    );
    const waiting = rows.filter((r) => r.status === "stale").length;
    return waiting > 0 ? { kind: "busy", waiting } : { kind: "quiet" };
  } catch {
    return { kind: "unknown" };
  }
}

function errorText(e: unknown): { status: number | null; detail: string } {
  if (e instanceof ApiError) {
    const raw = e.message.replace(/^API error \d+: ?/, "");
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error;
    } catch {
      // not JSON, keep the text
    }
    return { status: e.status, detail };
  }
  return { status: null, detail: "" };
}

/** An answer the endpoint might give in words when it guards the queue itself. */
function soundsBusy(detail: string): boolean {
  return /rewrit|queue|busy|in progress|locked/i.test(detail);
}

export function failureMessage(e: unknown, customerId: string): BackfillOutcome {
  const { status, detail } = errorText(e);
  if (status === 409 || (status !== null && soundsBusy(detail))) {
    return { kind: "busy", waiting: null };
  }
  if (status === 403) {
    return {
      kind: "failed",
      message: "This needs a superadmin session. Sign in again as a superadmin.",
    };
  }
  if (status === 404) {
    return { kind: "failed", message: `Rawuser has no customer with the id ${customerId}.` };
  }
  if (status === 400) {
    return {
      kind: "failed",
      message: detail
        ? `The server refused the request. It said: ${detail}.`
        : "The server refused the request.",
    };
  }
  if (status !== null) {
    return {
      kind: "failed",
      message: `The server failed while running it (${status}). Running it again is safe. It skips what is already done.`,
    };
  }
  return {
    kind: "failed",
    message:
      "No answer from the server. It may have finished anyway. Running it again is safe. It skips what is already done.",
  };
}

/**
 * Check the write queue, then run. A busy queue, or a queue that cannot be
 * read, sends nothing.
 */
export async function runBackfill(
  customerId: string,
  what: BackfillWhat,
  api: Api = apiFetch,
): Promise<BackfillOutcome> {
  const queue = await readQueue(customerId, api);
  if (queue.kind === "busy") return { kind: "busy", waiting: queue.waiting };
  if (queue.kind === "unknown") {
    return {
      kind: "failed",
      message: "The write queue could not be checked, so nothing was sent. Try again in a minute.",
    };
  }
  try {
    const res = await api<BackfillResult & { ok?: boolean; error?: string }>(BACKFILL_PATH, {
      method: "POST",
      body: backfillBody(customerId, what),
    });
    if (res.ok !== true) {
      const detail = typeof res.error === "string" ? res.error : "";
      if (soundsBusy(detail)) return { kind: "busy", waiting: null };
      return {
        kind: "failed",
        message: detail
          ? `The server did not run it. It said: ${detail}.`
          : "The server did not run it.",
      };
    }
    return what === "bodies"
      ? { kind: "done", what, result: res as BodiesResult }
      : { kind: "done", what, result: res as OutcomesResult };
  } catch (e) {
    return failureMessage(e, customerId);
  }
}

export interface LedgerLine {
  dt: string;
  dd: string;
}

export interface BackfillCopy {
  title: string;
  lead: string;
  rows: LedgerLine[];
  confirm: string;
  running: string;
}

export function backfillCopy(what: BackfillWhat, domain: string): BackfillCopy {
  if (what === "bodies") {
    return {
      title: `Rebuild the version history of ${domain}?`,
      lead: "Gives every live version its id and keeps a copy of its words in the database, so the test can tell which version a visit saw.",
      rows: [
        {
          dt: "Writes to",
          dd: "Production. One row per live version in D1, and the id added to each live version in KV.",
        },
        { dt: "Visitors", dd: "See the same words. Nothing on the page changes." },
        {
          dt: "Older versions",
          dd: "A version rewritten before this run is gone, so its visits stay without an id.",
        },
        { dt: "Run again", dd: "Safe. A version that already has its id is left alone." },
      ],
      confirm: "Rebuild version history",
      running: "Writing ids",
    };
  }
  return {
    title: `Rebuild the daily counts of ${domain}?`,
    lead: "Counts visits and clicks per version for each closed day of the last 30, from the visit markers, and stores the daily totals the test reads.",
    rows: [
      {
        dt: "Writes to",
        dd: "Production. The daily totals in D1. Each day's totals are deleted and counted again.",
      },
      { dt: "Visitors", dd: "Nothing changes for them." },
      {
        dt: "Older days",
        dd: "A day past 30 is left as it is. Its visit markers may already be deleted.",
      },
      { dt: "Run again", dd: "Safe. The same day gives the same totals." },
    ],
    confirm: "Rebuild daily counts",
    running: "Counting days",
  };
}

export function queueLine(queue: QueueState | null, domain: string): string {
  if (queue === null) return "Checking the write queue\u2026";
  if (queue.kind === "quiet") return "Empty. Nothing is waiting to be written.";
  if (queue.kind === "busy") {
    const them = queue.waiting === 1 ? "it is" : "they are";
    return `${plural(queue.waiting, "version", "versions")} of ${domain} waiting to be written. Run this once ${them} done.`;
  }
  return "Could not be read just now. The run checks it again before it sends anything.";
}

export function busyMessage(waiting: number | null, domain: string): string {
  if (waiting === null) {
    return `Rawuser is rewriting versions of ${domain} right now. Nothing was changed. Run this once the rewrite is done.`;
  }
  const them = waiting === 1 ? "it is" : "they are";
  return `The write queue has ${plural(waiting, "version", "versions")} of ${domain} waiting. Nothing was sent. Run this once ${them} written.`;
}

export interface ResultView {
  headline: string;
  stats: { k: string; v: string }[];
  note: string | null;
}

export function resultView(
  outcome: Extract<BackfillOutcome, { kind: "done" }>,
  domain: string,
): ResultView {
  if (outcome.what === "bodies") {
    const { scanned, written, skipped } = outcome.result;
    const already = Math.max(0, scanned - written - skipped);
    if (scanned === 0) {
      return {
        headline: `Done. ${domain} has no live versions yet, so nothing was written.`,
        stats: [],
        note: null,
      };
    }
    return {
      headline:
        written === 0 && skipped === 0
          ? `Done. All ${plural(scanned, "live version", "live versions")} already had their id. Nothing changed.`
          : `Done. ${plural(written, "version", "versions")} given an id.`,
      stats: [
        { k: "Checked", v: String(scanned) },
        { k: "Given an id", v: String(written) },
        { k: "Already had one", v: String(already) },
        { k: "Skipped", v: String(skipped) },
      ],
      note:
        skipped > 0
          ? "A skipped version had no readable live text, or was rewritten while this ran. A rewrite gives it an id by itself."
          : null,
    };
  }
  const { days, rebuilt } = outcome.result;
  const left = Math.max(0, days - rebuilt);
  return {
    headline: `Done. ${plural(rebuilt, "closed day", "closed days")} counted again.`,
    stats: [
      { k: "Days read", v: String(days) },
      { k: "Counted", v: String(rebuilt) },
      { k: "Left as is", v: String(left) },
    ],
    note:
      left > 0
        ? left === 1
          ? "The oldest day was left as it was. Its visit markers may already be deleted."
          : `The ${left} oldest days were left as they were. Their visit markers may already be deleted.`
        : null,
  };
}
