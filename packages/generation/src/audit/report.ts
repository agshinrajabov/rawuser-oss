/**
 * The audit report, built once and frozen (docs/specs/ai-traffic-audit.md
 * §4, §5, §12). Offline: the hourly check calls it at the window's end, the
 * superadmin may rebuild it before the release. Never in the visitor path.
 *
 * One visit, one group (§4.1): a visit's source is the source of its
 * earliest row with `found_by`; with none it has no source to read (or sits
 * in "Pages in a language we did not write"). Visits, not rows: every count
 * is over COALESCE(visit, id), so a row without a marker is its own visit.
 *
 * Privacy (privacy review condition 4 and the rule line of §17.6): the snapshot
 * holds counts over the floors (names and pages 5 visits, any count 1 to 4
 * as "<5"), masked paths, the customer's own copy (the sample version's
 * words from version_bodies and the page's own hero) and the test state.
 * Never a row, a marker, a contact name or an email. The marker is read
 * here only as COALESCE(visit, id) inside one customer, counts only.
 */

import {
  type AuditAnswers,
  type AuditCheck,
  type AuditCount,
  type AuditGroup,
  type AuditGroupKey,
  type AuditLandingList,
  type AuditName,
  type AuditReport,
  type AuditReview,
  type AuditSample,
  type AuditSamplePart,
  type AuditShare,
  type AuditTestLine,
  type Manifest,
  SOURCE_NAME_LABELS,
  type SourceName,
  type VariantBody,
  classify,
  extractSignals,
  isSourceName,
  maskPath,
  selectVariantKey,
  variantKeyForPath,
} from "@rawuser/shared";
import { parse } from "node-html-parser";
import { previewHero } from "../admin/quickstart.ts";
import { dayOf } from "../cron/exposure-rollup.ts";
import { markEmphasis } from "../inline-shape-html.ts";
import { type InstallEnv, fetcherUserAgent } from "../install-config.ts";
import { isOffButton } from "../lib/button-rewrite.ts";
import { sampleSizeTotal, wilsonCI } from "../lib/lift.ts";
import {
  DEFAULT_RATE,
  buildLiftReport,
  loadOutcomes,
  loadReportInput,
} from "../lib/proof-report.ts";
import { homepageFetcher } from "../site-map/weekly.ts";
import {
  AUDIT_FLOOR,
  AUDIT_MIN_SAMPLE,
  AUDIT_MIN_VISITS,
  AUDIT_PAGES_PER_GROUP,
  DAY,
} from "./constants.ts";

/** The event types that mean "a page of a visit was seen" (the aggregator's four). */
const VISIT_EVENTS = `'variant_shown', 'select', 'no_signal_passthrough', 'personalization_skipped'`;

/** The window's rows, one CTE shared by the reads below. */
const WINDOW_CTE = `e AS MATERIALIZED (
  SELECT COALESCE(visit, id) AS v, ts, id, event_type,
         COALESCE(cohort, 'personalized') AS cohort,
         source_dim, source_name, found_by, page_path, body_id,
         COALESCE(dark_social, 0) AS dark_social,
         COALESCE(language_mismatch, 0) AS language_mismatch
  FROM events
  WHERE customer_id = ?1 AND ts >= ?2 AND ts < ?3
    AND event_type IN (${VISIT_EVENTS})
),
srcs AS (
  SELECT v, source_dim, source_name, found_by FROM (
    SELECT v, source_dim, source_name, found_by,
           ROW_NUMBER() OVER (PARTITION BY v ORDER BY ts, id) AS rn
    FROM e WHERE found_by IS NOT NULL
  ) WHERE rn = 1
)`;

/**
 * Visits by (source, name, found_by, landing page, first-row flags, saw a
 * version): the partition's input, grouped so its size is bounded by the
 * site's pages, never by its visits.
 *
 * "Saw a version" means a version was written on one of its pages. A page
 * painted before our script ran stays as built (docs/specs/late-tag.md), so
 * such a load counts here only if a later page was written; the meaning is
 * unchanged and the late tag's bit is not read here.
 */
export const AUDIT_VISITS_SQL = `/* audit_visits */
WITH ${WINDOW_CTE},
firsts AS (
  SELECT v, page_path, dark_social, language_mismatch FROM (
    SELECT v, page_path, dark_social, language_mismatch,
           ROW_NUMBER() OVER (PARTITION BY v ORDER BY ts, id) AS rn
    FROM e
  ) WHERE rn = 1
),
saw AS (
  SELECT DISTINCT v FROM e WHERE event_type = 'variant_shown' AND cohort = 'personalized'
)
SELECT s.source_dim AS source_dim, s.source_name AS source_name, s.found_by AS found_by,
       f.page_path AS landing, f.dark_social AS dark_social,
       f.language_mismatch AS language_mismatch,
       CASE WHEN saw.v IS NULL THEN 0 ELSE 1 END AS saw,
       COUNT(*) AS visits
FROM firsts f
LEFT JOIN srcs s ON s.v = f.v
LEFT JOIN saw ON saw.v = f.v
GROUP BY 1, 2, 3, 4, 5, 6, 7`;

/** Served bodies by the visit's source and the page (§5.2). */
export const AUDIT_SERVED_SQL = `/* audit_served */
WITH ${WINDOW_CTE}
SELECT s.source_dim AS source_dim, s.source_name AS source_name,
       e.page_path AS page_path, e.body_id AS body_id,
       COUNT(DISTINCT e.v) AS visits
FROM e LEFT JOIN srcs s ON s.v = e.v
WHERE e.event_type = 'variant_shown' AND e.cohort = 'personalized' AND e.body_id IS NOT NULL
GROUP BY 1, 2, 3, 4`;

/** Rows in the window, and how many carry no marker (the superadmin's review). */
export const AUDIT_ROWS_SQL = `/* audit_rows */
SELECT COUNT(*) AS rows,
       COUNT(*) FILTER (WHERE visit IS NULL) AS no_marker,
       COUNT(DISTINCT COALESCE(visit, id)) AS visits
FROM events
WHERE customer_id = ?1 AND ts >= ?2 AND ts < ?3
  AND event_type IN (${VISIT_EVENTS})`;

export interface VisitGroupRow {
  source_dim: string | null;
  source_name: string | null;
  found_by: string | null;
  landing: string | null;
  dark_social: number;
  language_mismatch: number;
  saw: number;
  visits: number;
}

export interface ServedRow {
  source_dim: string | null;
  source_name: string | null;
  page_path: string;
  body_id: string;
  visits: number;
}

// ---------------------------------------------------------------------------
// The partition (§4), pure
// ---------------------------------------------------------------------------

export const GROUP_ORDER: readonly AuditGroupKey[] = [
  "ai",
  "social",
  "community",
  "search",
  "ads",
  "other",
  "none",
  "language",
];

/** A visit's group from its source row and first-row flags (§4.1, §4.3). */
export function groupOf(
  r: Pick<VisitGroupRow, "source_dim" | "found_by" | "language_mismatch">,
): AuditGroupKey {
  if (r.found_by !== null && r.source_dim) {
    switch (r.source_dim) {
      case "ai":
        return "ai";
      case "social":
        return "social";
      case "community":
        return "community";
      case "organic":
        return "search";
      case "paid":
        return "ads";
      default:
        return "other";
    }
  }
  if (Number(r.language_mismatch) === 1) return "language";
  return r.found_by !== null ? "other" : "none";
}

/** 0, 5 or more, or "<5". */
export function floorCount(n: number): AuditCount {
  return n === 0 ? 0 : n < AUDIT_FLOOR ? "<5" : n;
}

/** A share in whole percents with its Wilson range rounded outward; null under the floor. */
export function shareOf(n: number, total: number): AuditShare | null {
  if (n < AUDIT_FLOOR || total <= 0) return null;
  const p = (n / total) * 100;
  const [lo, hi] = wilsonCI(n, total);
  const under = p < 1;
  return {
    pct: under ? 0 : Math.round(p),
    under_one: under,
    low: Math.max(0, Math.floor(lo * 100)),
    high: Math.min(100, Math.ceil(hi * 100)),
  };
}

function namesOf(counts: Map<string, number>): { names: AuditName[]; named: number } {
  const names: AuditName[] = [];
  let named = 0;
  for (const [name, visits] of counts) {
    if (!isSourceName(name) || visits < AUDIT_FLOOR) continue;
    names.push({ name, label: SOURCE_NAME_LABELS[name as SourceName], visits });
    named += visits;
  }
  names.sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name));
  return { names, named };
}

function landingOf(byPath: Map<string, number>, total: number): AuditLandingList {
  const pages = [...byPath.entries()]
    .filter(([, n]) => n >= AUDIT_FLOOR)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, AUDIT_PAGES_PER_GROUP)
    .map(([path, visits]) => ({ path, visits }));
  const listed = pages.reduce((s, p) => s + p.visits, 0);
  return { visits: floorCount(total), pages, other: floorCount(total - listed) };
}

export interface Partition {
  total: number;
  state: AuditReport["state"];
  groups: AuditGroup[];
  answers: AuditAnswers | null;
  landing: AuditReport["landing"];
  saw: number;
  /** Raw visits per group (never in the snapshot): the review's add-up check. */
  raw: Record<AuditGroupKey, number>;
  /** Raw visits per (group, name), for the sample's choice. */
  nameVisits: Array<{ group: AuditGroupKey; name: string; visits: number }>;
}

export function partition(rows: readonly VisitGroupRow[]): Partition {
  const raw = Object.fromEntries(GROUP_ORDER.map((g) => [g, 0])) as Record<AuditGroupKey, number>;
  const names = new Map<AuditGroupKey, Map<string, number>>();
  const landing = {
    ai: new Map<string, number>(),
    no_referrer: new Map<string, number>(),
    all: new Map<string, number>(),
  };
  let total = 0;
  let saw = 0;
  let probably = 0;
  let inAppNamed = 0;
  let noReferrer = 0;
  const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

  for (const r of rows) {
    const n = Number(r.visits) || 0;
    if (n <= 0) continue;
    total += n;
    const g = groupOf(r);
    raw[g] += n;
    if (Number(r.saw) === 1) saw += n;
    if (r.source_name && g !== "none" && g !== "language") {
      if (!names.has(g)) names.set(g, new Map());
      add(names.get(g) as Map<string, number>, r.source_name, n);
    }
    if (g === "none" && Number(r.dark_social) === 1) probably += n;
    if (g === "social" && (r.found_by === "app_marker" || r.found_by === "app_package")) {
      inAppNamed += n;
    }
    const path = maskPath(r.landing ?? "/");
    add(landing.all, path, n);
    if (g === "ai") add(landing.ai, path, n);
    if (r.found_by === "app_marker") {
      noReferrer += n;
      add(landing.no_referrer, path, n);
    }
  }

  const state: AuditReport["state"] =
    total >= AUDIT_MIN_VISITS ? "full" : total >= AUDIT_MIN_SAMPLE ? "counts" : "too_few";
  const share = (n: number) => (state === "full" ? shareOf(n, total) : null);
  const nameVisits: Partition["nameVisits"] = [];
  for (const [group, m] of names) {
    for (const [name, visits] of m) nameVisits.push({ group, name, visits });
  }

  const groupEntry = (key: AuditGroupKey): AuditGroup => {
    const { names: listed, named } = namesOf(names.get(key) ?? new Map());
    return {
      key,
      visits: floorCount(raw[key]),
      share: share(raw[key]),
      names: listed,
      other: listed.length > 0 ? floorCount(raw[key] - named) : null,
      ...(key === "none" ? { probably: floorCount(probably) } : {}),
    };
  };

  if (state === "too_few") {
    return { total, state, groups: [], answers: null, landing: null, saw, raw, nameVisits };
  }
  const groups = GROUP_ORDER.filter((g) => g !== "language" || raw.language > 0).map(groupEntry);
  const ai = groupEntry("ai");
  const inApp = inAppNamed + probably;
  return {
    total,
    state,
    groups,
    answers: {
      ai: { visits: ai.visits, share: ai.share, names: ai.names, other: ai.other },
      in_app: {
        visits: floorCount(inApp),
        share: share(inApp),
        named: floorCount(inAppNamed),
        probably: floorCount(probably),
      },
      no_referrer: { visits: floorCount(noReferrer), share: share(noReferrer) },
    },
    landing: {
      ai: landingOf(landing.ai, raw.ai),
      no_referrer: landingOf(landing.no_referrer, noReferrer),
      all: landingOf(landing.all, total),
    },
    saw,
    raw,
    nameVisits,
  };
}

// ---------------------------------------------------------------------------
// The sample (§5.2; the founder's call 1: the biggest AI name first)
// ---------------------------------------------------------------------------

export type SampleChoice =
  | { kind: "name"; name: string; page_path: string; body_id: string }
  | { kind: "group"; group: AuditGroupKey; page_path: string; body_id: string }
  | { kind: "would_see" };

/** The most visited page of the matching served rows, and its most served body. */
function mostServed(rows: readonly ServedRow[]): { page_path: string; body_id: string } | null {
  if (rows.length === 0) return null;
  const byPage = new Map<string, number>();
  for (const r of rows) byPage.set(r.page_path, (byPage.get(r.page_path) ?? 0) + Number(r.visits));
  const page = [...byPage.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]?.[0];
  const best = rows
    .filter((r) => r.page_path === page)
    .sort((a, b) => Number(b.visits) - Number(a.visits) || a.body_id.localeCompare(b.body_id))[0];
  return best ? { page_path: best.page_path, body_id: best.body_id } : null;
}

/**
 * Which source and which body: the biggest AI name over the floor with a
 * served version; else the biggest name over the floor (an AI name wins a
 * tie); else the biggest group with a served version; else "would see".
 */
export function chooseSample(p: Partition, served: readonly ServedRow[]): SampleChoice {
  const servedGroup = (r: ServedRow) =>
    groupOf({
      source_dim: r.source_dim,
      found_by: r.source_dim ? "x" : null,
      language_mismatch: 0,
    });
  const names = p.nameVisits
    .filter((n) => isSourceName(n.name) && n.visits >= AUDIT_FLOOR)
    .sort(
      (a, b) =>
        b.visits - a.visits ||
        Number(b.group === "ai") - Number(a.group === "ai") ||
        a.name.localeCompare(b.name),
    );
  const ordered = [
    ...names.filter((n) => n.group === "ai"),
    ...names.filter((n) => n.group !== "ai"),
  ];
  for (const n of ordered) {
    const hit = mostServed(
      served.filter((r) => r.source_name === n.name && servedGroup(r) === n.group),
    );
    if (hit) return { kind: "name", name: n.name, ...hit };
  }
  const groups = GROUP_ORDER.filter((g) => g !== "none" && g !== "language").sort(
    (a, b) => p.raw[b] - p.raw[a] || GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b),
  );
  for (const g of groups) {
    if (p.raw[g] === 0) continue;
    const hit = mostServed(served.filter((r) => r.source_dim !== null && servedGroup(r) === g));
    if (hit) return { kind: "group", group: g, ...hit };
  }
  return { kind: "would_see" };
}

/** The page's own hero from its HTML by the confirmed CSS selectors; null parts when not found. */
export function heroFromHtml(
  html: string,
  manifest: Manifest,
): { headline: string | null; body: string | null; cta: string | null } {
  let root: ReturnType<typeof parse> | null = null;
  try {
    root = parse(html);
  } catch {
    root = null;
  }
  const read = (slot: string): string | null => {
    const entry = manifest[slot];
    if (!root || !entry) return null;
    for (const css of entry.css ?? []) {
      try {
        const el = root.querySelector(css);
        const text = el?.textContent?.replace(/\s+/g, " ").trim();
        if (text) return markEmphasis(text, entry.inline?.emphasis_phrase);
      } catch {
        // a selector the parser cannot read: the next one
      }
    }
    return null;
  };
  return { headline: read("hero.headline"), body: read("hero.body"), cta: read("hero.cta.label") };
}

/** The manifest's text signature, with "..." where it is cut. */
export function signatureOf(manifest: Manifest, slot: string): string | null {
  const entry = manifest[slot];
  const sig = entry?.text?.[0];
  if (!sig) return null;
  const marked = markEmphasis(sig, entry?.inline?.emphasis_phrase) ?? sig;
  const full = entry?.original_char_length;
  return typeof full === "number" && full > sig.length + 1 ? `${marked}...` : marked;
}

export type HtmlFetch = (url: string, host: string) => Promise<string>;

export interface ReportDeps {
  /** The page fetch under the site-map rules (own host, documented UA, no cookies). */
  fetchHtml?: HtmlFetch;
}

async function loadManifest(
  db: D1Database,
  customerId: string,
  path: string,
): Promise<Manifest | null> {
  const row = await db
    .prepare(
      "SELECT manifest FROM element_manifests WHERE customer_id = ? AND page_path = ? AND confirmed_at IS NOT NULL",
    )
    .bind(customerId, path)
    .first<{ manifest: string }>();
  try {
    return row ? (JSON.parse(row.manifest) as Manifest) : null;
  } catch {
    return null;
  }
}

/** The version a ChatGPT link to the homepage gets now: the edge's selection, read from KV. */
async function wouldSeeBody(
  env: { VARIANTS: KVNamespace; DB: D1Database },
  customerId: string,
  domain: string,
  now: number,
): Promise<VariantBody | null> {
  const signals = extractSignals({
    url: new URL(
      `https://edge.invalid/select?cid=${encodeURIComponent(customerId)}&path=/&utm_source=chatgpt.com`,
    ),
    headers: new Headers({ "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15" }),
    selfHost: domain,
  });
  const sel = selectVariantKey(classify(signals, now, null));
  for (const source of [sel.source_dim, "default"]) {
    const raw = await env.VARIANTS.get(variantKeyForPath(customerId, "/", sel.intent_dim, source));
    if (!raw) continue;
    try {
      return JSON.parse(raw) as VariantBody;
    } catch {
      // the next key
    }
  }
  return null;
}

async function bodyOf(
  db: D1Database,
  customerId: string,
  bodyId: string,
): Promise<VariantBody | null> {
  const row = await db
    .prepare("SELECT body_json FROM version_bodies WHERE customer_id = ? AND body_id = ?")
    .bind(customerId, bodyId)
    .first<{ body_json: string }>();
  try {
    return row ? (JSON.parse(row.body_json) as VariantBody) : null;
  } catch {
    return null;
  }
}

export async function buildSample(
  env: BuildEnv,
  customerId: string,
  domain: string,
  choice: SampleChoice,
  now: number,
  deps: ReportDeps,
): Promise<AuditSample | null> {
  const pagePath = choice.kind === "would_see" ? "/" : choice.page_path;
  const body =
    choice.kind === "would_see"
      ? await wouldSeeBody(env, customerId, domain, now)
      : await bodyOf(env.DB, customerId, choice.body_id);
  if (!body) return null;
  const manifest = (await loadManifest(env.DB, customerId, pagePath)) ?? {};

  // The page's own hero: one cookie-less fetch of that page, then the
  // signatures for what it lacks. A masked path is never fetched.
  let fromPage: ReturnType<typeof heroFromHtml> = { headline: null, body: null, cta: null };
  if (!pagePath.includes(":")) {
    try {
      const fetchHtml = deps.fetchHtml ?? homepageFetcher(fetcherUserAgent(env), env.SITE_RESOLVER);
      const html = await fetchHtml(`https://${domain}${pagePath}`, domain);
      fromPage = heroFromHtml(html, manifest);
    } catch {
      console.error("[audit] the page's hero could not be read; signatures used (non-critical)");
    }
  }
  const versionWords = previewHero(body);
  const versionsTotal = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM variants WHERE customer_id = ? AND status IN ('ready', 'stale')",
  )
    .bind(customerId)
    .first<{ n: number }>();
  const part = (slot: string, page: string | null, version: string | null): AuditSamplePart => {
    const template = manifest[slot]?.inline?.template;
    return {
      page: page ?? signatureOf(manifest, slot),
      version,
      ...(typeof template === "string" && template ? { template } : {}),
    };
  };
  return {
    form: choice.kind === "would_see" ? "would_see" : "saw",
    source:
      choice.kind === "name"
        ? {
            kind: "name",
            name: choice.name,
            label: SOURCE_NAME_LABELS[choice.name as SourceName] ?? choice.name,
          }
        : choice.kind === "group"
          ? { kind: "group", group: choice.group }
          : { kind: "name", name: "chatgpt", label: SOURCE_NAME_LABELS.chatgpt },
    page_path: pagePath,
    body_id: choice.kind === "would_see" ? (body.body_id ?? null) : choice.body_id,
    page_from: fromPage.headline ? "page" : "signature",
    versions_total: Number(versionsTotal?.n ?? 0),
    headline: part("hero.headline", fromPage.headline, versionWords.headline),
    body: part("hero.body", fromPage.body, versionWords.body),
    // A button that stays as built shows the page's own words, also where a
    // body from before the switch still carries a label (lib/button-rewrite.ts).
    cta: part(
      "hero.cta.label",
      fromPage.cta,
      isOffButton("hero.cta.label", manifest["hero.cta.label"]) && "hero.cta.label" in manifest
        ? null
        : versionWords.cta,
    ),
  };
}

// ---------------------------------------------------------------------------
// What the versions did (§5.3), through the lift report's code
// ---------------------------------------------------------------------------

export async function auditTestLine(
  db: D1Database,
  customerId: string,
  window: { start: number; end: number },
  now: number,
): Promise<{ line: AuditTestLine; running: boolean }> {
  const input = await loadReportInput(db, customerId, now, false);
  const report = buildLiftReport(input);
  const test = report.test;
  const running = test !== null && test.ended_at === null;
  if (!test) {
    return {
      line: input.countedButtons === 0 ? { state: "no_button" } : { state: "off" },
      running,
    };
  }
  if (test.end_reason === "low_traffic") return { line: { state: "low_traffic" }, running };
  if (report.state === "held_back") return { line: { state: "checking" }, running };
  if (
    (report.state === "result" || report.state === "ended") &&
    report.lift !== null &&
    report.verdict !== null &&
    report.verdict !== "inconclusive"
  ) {
    return {
      line: {
        state: "result",
        sentence: report.sentence,
        lift: { value: report.lift.value, low: report.lift.low, high: report.lift.high },
        labels: report.metric.labels,
      },
      running,
    };
  }
  // A test that stopped without a result (a stop, a new period): none ran.
  if (!running) return { line: { state: "off" }, running };
  // Too early: the sample the first honest read needs, at the window's own
  // click rate across both arms, and the weeks at the window's traffic.
  const fromDay = dayOf(window.start);
  const toDay = dayOf(window.end - 1);
  const rows = (await loadOutcomes(db, customerId, fromDay, toDay)).filter(
    (r) => r.arm === "treat" || r.arm === "holdout",
  );
  const visits = rows.reduce((s, r) => s + r.visits, 0);
  const converting = rows.reduce((s, r) => s + r.converting_visits, 0);
  const rate = visits > 0 && converting > 0 ? converting / visits : DEFAULT_RATE;
  const n = sampleSizeTotal(rate, test.percent / 100);
  const days = Math.max(1, (window.end - window.start) / DAY);
  const perWeek = (visits / days) * 7;
  return {
    line: {
      state: "too_early",
      visits_needed: n === null ? null : Math.ceil(n / 100) * 100,
      weeks: n === null || perWeek <= 0 ? null : Math.ceil(n / perWeek),
    },
    running,
  };
}

// ---------------------------------------------------------------------------
// Build and freeze
// ---------------------------------------------------------------------------

export interface BuildEnv extends Pick<InstallEnv, "BOT_INFO_URL" | "SITE_RESOLVER"> {
  DB: D1Database;
  VARIANTS: KVNamespace;
}

export interface BuiltReport {
  report: AuditReport;
  review: AuditReview;
}

export class ReportReleasedError extends Error {
  constructor() {
    super("The report is released; a released report is never rebuilt.");
  }
}

/**
 * Build the report of [start, end) and freeze it in audit_reports. Built
 * twice before the release, one row with the same JSON (an upsert on the
 * customer and the window start); a released row is never touched.
 */
export async function buildAuditReport(
  env: BuildEnv,
  customerId: string,
  window: { start: number; end: number },
  now: number,
  deps: ReportDeps = {},
): Promise<BuiltReport> {
  const existing = await env.DB.prepare(
    "SELECT released_at FROM audit_reports WHERE customer_id = ? AND window_start = ?",
  )
    .bind(customerId, window.start)
    .first<{ released_at: number | null }>();
  if (existing?.released_at) throw new ReportReleasedError();

  const customer = await env.DB.prepare(
    "SELECT domain, audit_consent_banner, audit_start_written, audit_start_total FROM customers WHERE id = ?",
  )
    .bind(customerId)
    .first<{
      domain: string;
      audit_consent_banner: number | null;
      audit_start_written: number | null;
      audit_start_total: number | null;
    }>();
  if (!customer) throw new Error("Customer not found");
  const domain = customer.domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");

  const [visitRows, servedRows, rowCounts] = await Promise.all([
    env.DB.prepare(AUDIT_VISITS_SQL)
      .bind(customerId, window.start, window.end)
      .all<VisitGroupRow>(),
    env.DB.prepare(AUDIT_SERVED_SQL).bind(customerId, window.start, window.end).all<ServedRow>(),
    env.DB.prepare(AUDIT_ROWS_SQL)
      .bind(customerId, window.start, window.end)
      .first<{ rows: number; no_marker: number; visits: number }>(),
  ]);
  const p = partition(visitRows.results ?? []);
  const choice = chooseSample(p, servedRows.results ?? []);
  const sample = await buildSample(env, customerId, domain, choice, now, deps);
  const test = await auditTestLine(env.DB, customerId, window, now);

  const report: AuditReport = {
    v: 1,
    domain,
    window: { start: window.start, end: window.end },
    built_at: now,
    state: p.state,
    visits: p.total,
    answers: p.answers,
    groups: p.groups,
    landing: p.landing,
    sample,
    versions_did: test.line,
    saw_version: floorCount(p.saw),
    test_running: test.running,
    consent_banner: Number(customer.audit_consent_banner) === 1,
    versions_at_start:
      customer.audit_start_total === null || customer.audit_start_total === undefined
        ? null
        : {
            written: Number(customer.audit_start_written ?? 0),
            total: Number(customer.audit_start_total),
          },
  };

  const sum = Object.values(p.raw).reduce((s, n) => s + n, 0);
  const fmt = (n: number) => n.toLocaleString("en-US");
  const checks: AuditCheck[] = [
    {
      id: "adds_up",
      ok: sum === p.total,
      line:
        sum === p.total
          ? `Groups add up to ${fmt(p.total)}.`
          : `Groups add up to ${fmt(sum)}, not ${fmt(p.total)}.`,
    },
    { id: "floors", ok: true, line: "Every name and page has 5 visits or more." },
    {
      id: "sample",
      ok: sample !== null,
      line:
        sample === null
          ? "No version to show."
          : sample.form === "saw"
            ? "The sample's words are the version served most."
            : "Nothing was served; the sample is the version a ChatGPT link would get.",
    },
    {
      id: "page_read",
      ok: sample?.page_from === "page",
      line:
        sample?.page_from === "page"
          ? "The page's own hero was read from the page."
          : "The page's own hero is from the text signatures.",
    },
    {
      id: "no_lift",
      ok: true,
      line:
        test.line.state === "result"
          ? "The test result is shown with Results' gates."
          : "No lift shown; the test is too early or not running.",
    },
  ];
  const review: AuditReview = {
    no_marker_rows: Number(rowCounts?.no_marker ?? 0),
    rows: Number(rowCounts?.rows ?? 0),
    checks,
  };

  await env.DB.prepare(
    `INSERT INTO audit_reports (customer_id, window_start, window_end, state, report, built_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (customer_id, window_start) DO UPDATE SET
       window_end = excluded.window_end, state = excluded.state,
       report = excluded.report, built_at = excluded.built_at
     WHERE audit_reports.released_at IS NULL`,
  )
    .bind(
      customerId,
      window.start,
      window.end,
      report.state,
      JSON.stringify({ report, review }),
      now,
    )
    .run();
  return { report, review };
}

/** The stored snapshot's two halves; the public read takes `report` only. */
export function parseSnapshot(json: string): BuiltReport | null {
  try {
    const v = JSON.parse(json) as BuiltReport;
    return v && typeof v === "object" && v.report ? v : null;
  } catch {
    return null;
  }
}
