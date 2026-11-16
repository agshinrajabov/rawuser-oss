/**
 * A test harness for the proof engine: node:sqlite with every migration, an
 * in-memory KV, a Telegram stub that records alert lines, and helpers to
 * write events and customers. Real SQL, no text matching.
 */
import { vi } from "vitest";
import { makeSqliteD1 } from "./admin/sqlite-d1.ts";

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export interface Harness {
  db: ReturnType<typeof makeSqliteD1>["db"];
  d1: D1Database;
  kv: Map<string, string>;
  env: {
    DB: D1Database;
    VARIANTS: KVNamespace;
    ENVIRONMENT: string;
    DASHBOARD_ORIGIN: string;
    ALERT_WEBHOOK_URL: string;
  };
  alerts: string[];
  /**
   * A customer with the special-category question answered No (migration
   * 0044; readiness-check.md): before go live an unanswered question
   * withholds the tag and the capture, pick and count links. Pass
   * `special_category: null` for one that has not answered, 1 for a yes.
   */
  customer: (
    id: string,
    extra?: { plan?: string; holdout_percent?: number | null; special_category?: 0 | 1 | null },
  ) => void;
  ev: (e: EventFixture) => void;
}

export interface EventFixture {
  customer?: string;
  ts: number;
  type:
    | "variant_shown"
    | "personalization_skipped"
    | "no_signal_passthrough"
    | "conversion"
    | "personalization_partial";
  visit?: string | null;
  arm?: "treat" | "holdout" | null;
  page?: string;
  intent?: string | null;
  source?: string | null;
  body?: string | null;
  label?: string;
  cohort?: string | null;
  /** events.properties as the edge stores it: an object is written as its JSON, a string as it is. */
  props?: Record<string, unknown> | string | null;
  /** events.country (ADR 0036); NULL when absent. */
  country?: string | null;
  /** events.source_name (N1); NULL when absent. */
  name?: string | null;
  /** events.device_class (ADR 0038); NULL when absent. */
  device?: string | null;
  /** events.web_view (ADR 0038); NULL when absent. */
  webView?: 0 | 1 | null;
  /** events.carried (session carry, or a remembered reason). */
  carried?: 0 | 1;
}

let seq = 0;

export function harness(): Harness {
  const { d1, db } = makeSqliteD1();
  const kv = new Map<string, string>();
  const alerts: string[] = [];
  const kvNs = {
    get: async (k: string, t?: unknown) => {
      const v = kv.get(k) ?? null;
      return v !== null && (t === "json" || (t as { type?: string } | undefined)?.type === "json")
        ? JSON.parse(v)
        : v;
    },
    put: async (k: string, v: string) => {
      kv.set(k, v);
    },
    delete: async (k: string) => {
      kv.delete(k);
    },
  } as unknown as KVNamespace;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "api.telegram.org") {
        alerts.push(url.searchParams.get("text") ?? "");
        return Response.json({ ok: true });
      }
      return new Response("ok");
    }),
  );
  return {
    db,
    d1,
    kv,
    alerts,
    env: {
      DB: d1,
      VARIANTS: kvNs,
      ENVIRONMENT: "test",
      DASHBOARD_ORIGIN: "https://app.example.com",
      ALERT_WEBHOOK_URL: "https://api.telegram.org/botTEST/sendMessage?chat_id=1",
    },
    customer(id, extra = {}) {
      const answer = extra.special_category === undefined ? 0 : extra.special_category;
      db.prepare(
        "INSERT INTO customers (id, slug, domain, status, plan, created_at, holdout_percent, special_category, special_category_at) VALUES (?, ?, ?, 'active', ?, 1, ?, ?, ?)",
      ).run(
        id,
        id,
        `${id}.test`,
        extra.plan ?? "pilot",
        extra.holdout_percent ?? null,
        answer,
        answer === null ? null : 1,
      );
    },
    ev(e) {
      db.prepare(
        `INSERT INTO events (id, customer_id, ts, event_type, page_path, intent_dim, source_dim,
           conversion_label, cohort, visit, arm, body_id, properties, country, source_name,
           device_class, web_view, carried)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `evt_${++seq}`,
        e.customer ?? "acme",
        e.ts,
        e.type,
        e.page ?? "/",
        e.intent === undefined ? (e.type === "no_signal_passthrough" ? null : "problem") : e.intent,
        e.source === undefined ? (e.type === "no_signal_passthrough" ? null : "ai") : e.source,
        e.type === "conversion" ? (e.label ?? "trial_start") : null,
        e.cohort ?? null,
        e.visit === undefined ? null : e.visit,
        e.arm ?? null,
        e.body === undefined
          ? e.type === "no_signal_passthrough"
            ? null
            : "0123456789abcdef"
          : e.body,
        e.props == null ? null : typeof e.props === "string" ? e.props : JSON.stringify(e.props),
        e.country ?? null,
        e.name ?? null,
        e.device ?? null,
        e.webView ?? null,
        e.carried ?? 0,
      );
    },
  };
}

/** A 32-hex marker from a number. */
export function vid(i: number): string {
  return i.toString(16).padStart(32, "0");
}

/** Strip the customer id and the dashboard link; what is left must hold no digit. */
export function digitsBesideIdAndLink(line: string, customerId: string): string[] {
  const rest = line
    .replace(/https?:\/\/\S+/g, "")
    .split(customerId)
    .join("");
  return rest.match(/\d/g) ?? [];
}
