/**
 * The readiness check before go live (docs/specs/readiness-check.md, "The
 * API" and "As approved"):
 *
 *   GET /admin/onboard/readiness?customer_id=   customer-scoped
 *
 * The facts come from what the product already holds: the customers row,
 * the tag probe, the counted buttons, the manifests, the brief, the
 * quickstart record, the audit report, the outcomes and the versions. No
 * model call, no KV write. The health guess (shared special-category/words.ts)
 * runs here on the page text in hand and leaves as a yes or no: never
 * stored, never logged, never in the answer (privacy review condition 3).
 *
 * Also here: the tag-withheld 409 the endpoints that hand out the tag or a
 * capture link answer (privacy review condition 2), and go live's blocking line.
 */

import {
  type ReadinessAnswer,
  SPECIAL_CATEGORY_CODE,
  TAG_WITHHELD_CODE,
  isButtonLabelPath,
  isGoes,
  readsLikeHealth,
} from "@rawuser/shared";
import { DAY_MS, dayOf } from "../cron/exposure-rollup.ts";
import { supportAddress } from "../install-config.ts";
import { validateTagFlags, validateTagPosition } from "../lib/install-facts.ts";
import {
  DEFAULT_RATE,
  estimateFor,
  loadOutcomes,
  loadReportInput,
  testStartOf,
} from "../lib/proof-report.ts";
import {
  type CountedRow,
  type ReadinessFacts,
  afterDayThree,
  blockingLine,
  categoryCheck,
  readinessChecks,
  tagWithheld,
} from "../lib/readiness.ts";
import { buildTuples } from "../lib/variant-rows.ts";
import { loadServedIntents } from "../site-map/served-load.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import { BASELINE_MIN_DAYS, goLiveBaseline } from "./go-live-measure.ts";
import type { AdminEnv } from "./handlers.ts";
import { requireCustomerScope } from "./scope.ts";

/** The record the quickstart wrote for the homepage (quickstart.ts quickstartKey; read only here). */
const quickstartRecordKey = (customerId: string) => `v1:quickstart:${customerId}:/`;

/** The lines of the 409 on a withheld tag (the mock, A7 and A9). */
export const TAG_WITHHELD_LINES = {
  unanswered: "Answer the special-category question first.",
  yes: "We need to set this site up for a sensitive topic first. We have been told and will write to you.",
} as const;

interface CustomerRow {
  plan: string | null;
  live_at: number | null;
  languages: string | null;
  sensitive: number | null;
  special_category: number | null;
  pilot_terms_at: number | null;
}

const CUSTOMER_SQL =
  "SELECT plan, live_at, languages, sensitive, special_category, pilot_terms_at FROM customers WHERE id = ?";

/** The answer as a boolean or null, from the column. */
function answerOf(v: number | null | undefined): boolean | null {
  if (v === null || v === undefined) return null;
  return Number(v) === 1;
}

/**
 * The tag-withheld refusal for a customer, or null: `{ error, code }` for
 * the 409 of capture-token, pick-token and the count pick-token. No row:
 * nothing withheld (the endpoint answers its own 404).
 */
export async function tagWithheldRefusal(
  db: D1Database,
  customerId: string,
): Promise<{ error: string; code: typeof TAG_WITHHELD_CODE } | null> {
  const state = await withheldState(db, customerId);
  if (!state?.held) return null;
  return {
    error: state.answer === true ? TAG_WITHHELD_LINES.yes : TAG_WITHHELD_LINES.unanswered,
    code: TAG_WITHHELD_CODE,
  };
}

/** True while the customer's tag is withheld; false for a customer that is not there. */
export async function tagWithheldFor(db: D1Database, customerId: string): Promise<boolean> {
  return (await withheldState(db, customerId))?.held ?? false;
}

async function withheldState(
  db: D1Database,
  customerId: string,
): Promise<{ held: boolean; answer: boolean | null } | null> {
  const row = await db
    .prepare("SELECT live_at, sensitive, special_category FROM customers WHERE id = ?")
    .bind(customerId)
    .first<Pick<CustomerRow, "live_at" | "sensitive" | "special_category">>();
  if (!row) return null;
  const answer = answerOf(row.special_category);
  return {
    held: tagWithheld({
      liveAt: row.live_at ?? null,
      sensitive: Number(row.sensitive) === 1,
      specialCategory: answer,
    }),
    answer,
  };
}

/**
 * Go live's stop (the spec, "What blocks go live"): the special-category
 * line when it blocks, as `{ error, code }` for the 409. The same check the
 * list runs, on the row alone.
 */
export async function goLiveRefusal(
  db: D1Database,
  customerId: string,
): Promise<{ error: string; code: typeof SPECIAL_CATEGORY_CODE } | null> {
  const row = await db
    .prepare("SELECT sensitive, special_category FROM customers WHERE id = ?")
    .bind(customerId)
    .first<Pick<CustomerRow, "sensitive" | "special_category">>();
  if (!row) return null;
  const line = blockingLine([
    categoryCheck({
      sensitive: Number(row.sensitive) === 1,
      specialCategory: answerOf(row.special_category),
      healthHit: false,
      superadmin: false,
    }),
  ]);
  return line === null ? null : { error: line, code: SPECIAL_CATEGORY_CODE };
}

// ---------------------------------------------------------------------------
// The facts
// ---------------------------------------------------------------------------

interface StoredLanguageLite {
  lang?: unknown;
  status?: unknown;
  path?: unknown;
}

/** The primary language and the same-address languages from customers.languages. */
function languagesOf(raw: string | null): { primary: string | null; sameAddress: string[] } {
  let list: StoredLanguageLite[] = [];
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) list = parsed as StoredLanguageLite[];
  } catch {
    list = [];
  }
  const primary = list.find((l) => l.status === "primary" && typeof l.lang === "string");
  const same = list.filter(
    (l) => (l.status === "same_address" || l.path === null) && typeof l.lang === "string",
  );
  return {
    primary: primary ? String(primary.lang) : null,
    sameAddress: [...new Set(same.map((l) => String(l.lang)))],
  };
}

/** The text arrays of a manifest, joined; the page's own words only. */
function manifestText(manifest: string): string {
  try {
    const parsed = JSON.parse(manifest) as Record<string, { text?: unknown }>;
    return Object.values(parsed)
      .flatMap((e) => (Array.isArray(e?.text) ? e.text : []))
      .filter((t): t is string => typeof t === "string")
      .join(" ");
  } catch {
    return "";
  }
}

/** Every string under a brief or record field, joined (lists and objects walked). */
function textOf(v: unknown, depth = 0): string {
  if (typeof v === "string") return v;
  if (depth > 3 || v === null || typeof v !== "object") return "";
  return Object.values(v as Record<string, unknown>)
    .map((x) => textOf(x, depth + 1))
    .join(" ");
}

interface QuickstartLite {
  current?: unknown;
  brief?: unknown;
  preview?: unknown;
  measure_contact_link?: unknown;
}

/** The record the quickstart left in KV for the homepage, or null. A read, never a write. */
async function quickstartLite(kv: KVNamespace, customerId: string): Promise<QuickstartLite | null> {
  try {
    const raw = await kv.get(quickstartRecordKey(customerId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as QuickstartLite) : null;
  } catch {
    return null;
  }
}

/** The 20% estimate from an audit report's visits over its window, or null. */
function auditWeeksOf(
  row: { report: string; window_start: number; window_end: number } | null,
): number | null {
  if (!row) return null;
  let visits = 0;
  try {
    const r = JSON.parse(row.report) as { visits?: unknown };
    visits = typeof r.visits === "number" ? r.visits : 0;
  } catch {
    return null;
  }
  const days = Math.max(
    1,
    Math.round((Number(row.window_end) - Number(row.window_start)) / DAY_MS),
  );
  if (visits <= 0) return null;
  return estimateFor(
    { eligible_visits: visits, days, rate: DEFAULT_RATE, rate_source: "default" },
    20,
  ).weeks;
}

/**
 * Everything the checks read, loaded once. The health guess runs on the
 * brief, the manifests' own words and the quickstart record's hero texts
 * (the same page text the brief draft read), and only its yes or no is
 * kept.
 */
export async function loadReadinessFacts(
  env: Pick<AdminEnv, "DB" | "VARIANTS" | "SUPPORT_ADDRESS">,
  customerId: string,
  user: { role: string },
  now = Date.now(),
): Promise<ReadinessFacts | null> {
  const db = env.DB;
  const customer = await db.prepare(CUSTOMER_SQL).bind(customerId).first<CustomerRow>();
  if (!customer) return null;
  const liveAt = customer.live_at ?? null;
  const superadmin = user.role === "superadmin";

  const [status, countedRows, manifests, dna, record, audit, served, variants] = await Promise.all([
    db
      .prepare("SELECT tag_position, tag_flags, tag_form FROM snippet_status WHERE customer_id = ?")
      .bind(customerId)
      .first<{ tag_position: string | null; tag_flags: string | null; tag_form: string | null }>(),
    db
      .prepare(
        "SELECT section_path, conversion_label, goes FROM conversion_targets WHERE customer_id = ? AND enabled = 1 ORDER BY created_at ASC",
      )
      .bind(customerId)
      .all<{ section_path: string; conversion_label: string; goes: string | null }>(),
    db
      .prepare("SELECT manifest FROM element_manifests WHERE customer_id = ?")
      .bind(customerId)
      .all<{ manifest: string }>(),
    db
      .prepare(
        "SELECT product, icp, value_props, differentiators, proof_points, target_market FROM business_dna WHERE customer_id = ?",
      )
      .bind(customerId)
      .first<Record<string, unknown>>(),
    quickstartLite(env.VARIANTS, customerId),
    db
      .prepare(
        "SELECT report, window_start, window_end FROM audit_reports WHERE customer_id = ? ORDER BY window_start DESC LIMIT 1",
      )
      .bind(customerId)
      .first<{ report: string; window_start: number; window_end: number }>(),
    loadServedIntents(customerId, db),
    db
      .prepare("SELECT status, error_reason FROM variants WHERE customer_id = ?")
      .bind(customerId)
      .all<{ status: string; error_reason: string | null }>(),
  ]);

  // The tag, as the probe stored it (install-facts.ts validates the columns).
  let flags: string[] = [];
  try {
    flags = validateTagFlags(status?.tag_flags ? JSON.parse(status.tag_flags) : []) ?? [];
  } catch {
    flags = [];
  }
  const tag = status
    ? {
        position: validateTagPosition(status.tag_position),
        flags,
        form: status.tag_form ?? null,
      }
    : null;

  const counted: CountedRow[] = (countedRows.results ?? []).map((r) => ({
    section_path: r.section_path,
    conversion_label: r.conversion_label,
    goes: isGoes(r.goes) ? r.goes : null,
  }));

  const manifestRows = manifests.results ?? [];
  const buttonSlots = manifestRows.some((m) => {
    try {
      return Object.keys(JSON.parse(m.manifest) as Record<string, unknown>).some(isButtonLabelPath);
    } catch {
      return false;
    }
  });

  // The guess: a count over text already in hand, kept as a yes or no.
  const healthHit = readsLikeHealth(
    [
      textOf(dna),
      ...manifestRows.map((m) => manifestText(m.manifest)),
      textOf(record?.current),
      textOf(record?.brief),
    ].join(" "),
  );

  const languages = languagesOf(customer.languages);

  // Traffic: the estimate before day 3, the lift report's from it.
  const dayThree = afterDayThree(liveAt, now);
  const baseline = dayThree
    ? { baseline_days: BASELINE_MIN_DAYS, estimate_weeks: null }
    : await goLiveBaseline(db, customerId, now);
  const report = dayThree ? await loadReportInput(db, customerId, now, superadmin) : null;
  const start = report ? testStartOf(report) : null;
  const today = Date.parse(`${dayOf(now)}T00:00:00Z`);
  const late = dayThree
    ? (await loadOutcomes(db, customerId, dayOf(today - 7 * DAY_MS), dayOf(today - DAY_MS))).reduce(
        (acc, r) => ({
          visits: acc.visits + r.visits,
          lp_visits: acc.lp_visits + (r.lp_visits ?? 0),
        }),
        { visits: 0, lp_visits: 0 },
      )
    : null;

  const rows = variants.results ?? [];
  const refused = rows.filter(
    (r) => r.status === "error" && (r.error_reason ?? "").startsWith("lint:"),
  ).length;

  return {
    now,
    superadmin,
    supportAddress: supportAddress(env),
    plan: customer.plan ?? null,
    liveAt,
    sensitive: Number(customer.sensitive) === 1,
    specialCategory: answerOf(customer.special_category),
    pilotTermsAt: customer.pilot_terms_at ?? null,
    tag,
    late,
    counted,
    contactLinkOnPage:
      typeof record?.measure_contact_link === "boolean" ? record.measure_contact_link : null,
    healthHit,
    baseline: { baseline_days: baseline.baseline_days, estimate_weeks: baseline.estimate_weeks },
    auditWeeks: dayThree ? null : auditWeeksOf(audit),
    dayThree: start
      ? {
          per_day: Math.round(start.estimate.eligible_per_month / 30),
          weeks: start.estimate.weeks,
        }
      : null,
    testRunning: report ? report.tests.some((t) => t.ended_at === null) : false,
    primaryLanguage: languages.primary,
    sameAddress: languages.sameAddress,
    buttonSlots,
    preview: {
      written: record?.preview !== null && record?.preview !== undefined,
      total: buildTuples(served).length,
    },
    versions: { total: rows.length, refused },
  };
}

/** The whole answer for a customer, or null when it does not exist. */
export async function readinessOf(
  env: Pick<AdminEnv, "DB" | "VARIANTS" | "SUPPORT_ADDRESS">,
  customerId: string,
  user: { role: string },
  now = Date.now(),
): Promise<ReadinessAnswer | null> {
  const facts = await loadReadinessFacts(env, customerId, user, now);
  if (!facts) return null;
  const checks = readinessChecks(facts);
  return {
    ok: true,
    customer_id: customerId,
    blocks_go_live: blockingLine(checks) !== null,
    checks,
    special_category: facts.specialCategory,
    tag_withheld: tagWithheld(facts),
  };
}

export async function handleReadiness(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
): Promise<Response> {
  const customerId = new URL(request.url).searchParams.get("customer_id");
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const answer = await readinessOf(env, customerId, user);
  if (!answer) return jsonWithCors({ error: "Customer not found" }, env, 404);
  return jsonWithCors(answer, env, 200);
}
